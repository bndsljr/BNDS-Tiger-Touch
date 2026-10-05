/**
 * 应用状态 —— 把 titan-client、散 cue 库、演出时钟、调度器串起来。
 *
 * 这是 WebUI 唯一的状态来源。设计原则：
 * - **连接是可选的**：未连接控台时（`offline`/`sim`）一切照常可编辑、可预演，
 *   只是推 cue 会落到空实现或模拟器。这是大纲 R5.1「完全离线可编」的落点。
 * - **titanId 运行时解析并缓存**，绝不持久化（换 show / 升级版本都会变）。
 * - 人工触发与调度触发**共用同一条 fire 通道**，因此行为一致、可统一记录。
 */

import { TitanClient, Playbacks, Handles, ShowReader } from '../titan/index.ts';
import type { HandleRef } from '../titan/handles.ts';
import {
  allCues,
  findCue,
  serializeCueBank,
  type CueBank,
  type ScatteredCue,
} from '../model/cuebank.ts';
import { emptySong, makeId, type CueMark, type Song } from '../model/song.ts';
import { ShowClock } from '../engine/showclock.ts';
import { Scheduler, type CueHit, type FireRequest } from '../engine/scheduler.ts';
import { analyze, renderCueSheet, type AnalysisReport } from '../engine/analyst.ts';
import type { ShowInventory } from '../titan/providers/showreader.ts';

export type ConnectionMode = 'offline' | 'sim' | 'live';

export interface ConnectionStatus {
  mode: ConnectionMode;
  baseUrl: string | null;
  connected: boolean;
  version: string | null;
  showName: string | null;
  loadState: string | null;
  /** 最近一次错误，供 UI 显示 */
  lastError: string | null;
  /** 实测生效的 levelDelta 拼写 —— 现场验证项之一 */
  levelDeltaSpelling: 'camel' | 'lower' | null;
}

export interface AppSnapshot {
  connection: ConnectionStatus;
  cueBank: CueBank;
  songs: Song[];
  currentSongId: string | null;
  transport: {
    running: boolean;
    positionMs: number;
    durationMs: number;
    nextMark: { id: string; tMs: number; note?: string } | null;
    offsetMs: number;
  };
  stats: ReturnType<Scheduler['stats']>;
  /** 最近若干次触发，供演出页与复盘页展示 */
  recentHits: CueHit[];
  /** 最近一次结构体检结果（若有） */
  analysis: AnalysisReport | null;
}

export class AppState {
  private client: TitanClient | null = null;
  private playbacks: Playbacks | null = null;
  private handles: Handles | null = null;
  private reader: ShowReader | null = null;
  private lastInventory: ShowInventory | null = null;
  private lastReport: AnalysisReport | null = null;

  private connection: ConnectionStatus = {
    mode: 'offline',
    baseUrl: null,
    connected: false,
    version: null,
    showName: null,
    loadState: null,
    lastError: null,
    levelDeltaSpelling: null,
  };

  private cueBank: CueBank = { group: 'Playbacks', pages: [] };
  private songs: Song[] = [];
  private currentSongId: string | null = null;

  /** (group/page/index) → titanId 的运行时缓存 */
  private titanIdCache = new Map<string, number>();

  readonly clock = new ShowClock();
  readonly scheduler: Scheduler;

  private listeners = new Set<(event: string, data: unknown) => void>();
  private tickTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.scheduler = new Scheduler({
      clock: this.clock,
      fire: (req) => this.fireCue(req),
      onHit: (hit) => {
        this.emit('hit', hit);
      },
      onError: (err, req) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.connection.lastError = `触发 ${req.cueId} 失败：${msg}`;
        this.emit('error', { cueId: req.cueId, message: msg });
      },
    });
    this.seedDemoContent();
  }

  // ── 事件推送（我们自己的 SSE 通道，与控台无关） ────────────────────────

  subscribe(fn: (event: string, data: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(event: string, data: unknown): void {
    for (const fn of this.listeners) {
      try {
        fn(event, data);
      } catch {
        /* 单个订阅者出错不应影响其他订阅者 */
      }
    }
  }

  // ── 连接 ────────────────────────────────────────────────────────────────

  async connect(baseUrl: string, opts: { allowVersionMismatch?: boolean } = {}): Promise<ConnectionStatus> {
    this.disconnect();
    const client = new TitanClient({ baseUrl });
    try {
      const version = await client.assertVersion(16, {
        allowMismatch: opts.allowVersionMismatch ?? false,
      });
      const [showName, loadState] = await Promise.all([
        client.get('Show', 'ShowName').catch(() => null),
        client.get('Show', 'LoadState').catch(() => null),
      ]);
      this.client = client;
      this.playbacks = new Playbacks(client);
      this.handles = new Handles(client);
      this.reader = new ShowReader(client);
      this.lastInventory = null;
      this.lastReport = null;
      this.titanIdCache.clear();
      this.connection = {
        mode: baseUrl.includes('127.0.0.1') || baseUrl.includes('localhost') ? 'sim' : 'live',
        baseUrl,
        connected: true,
        version,
        showName,
        loadState,
        lastError: null,
        levelDeltaSpelling: client.detectedLevelDeltaSpelling,
      };
    } catch (e) {
      this.connection = {
        ...this.connection,
        connected: false,
        baseUrl,
        lastError: e instanceof Error ? e.message : String(e),
      };
    }
    this.emit('connection', this.connection);
    return this.connection;
  }

  disconnect(): void {
    this.client = null;
    this.playbacks = null;
    this.handles = null;
    this.reader = null;
    this.lastInventory = null;
    this.lastReport = null;
    this.titanIdCache.clear();
    this.connection = {
      mode: 'offline',
      baseUrl: null,
      connected: false,
      version: null,
      showName: null,
      loadState: null,
      lastError: null,
      levelDeltaSpelling: null,
    };
    this.emit('connection', this.connection);
  }

  get status(): ConnectionStatus {
    return this.connection;
  }

  // ── 散 cue 库 ───────────────────────────────────────────────────────────

  get bank(): CueBank {
    return this.cueBank;
  }

  setBank(bank: CueBank): void {
    this.cueBank = bank;
    this.titanIdCache.clear();
    this.emit('cuebank', serializeCueBank(bank));
  }

  /**
   * 解析散 cue 到控台句柄。
   *
   * 优先用运行时缓存的 titanId；未缓存时回退到 userNumber / location。
   * 这样即使控台换 show 导致 titanId 变化，也能自愈。
   */
  private refFor(cue: ScatteredCue): HandleRef {
    const key = `${cue.placement.group}/${cue.placement.page}/${cue.placement.index}`;
    const cached = this.titanIdCache.get(key);
    if (cached !== undefined) return { titanId: cached };
    if (cue.resolvedTitanId !== undefined) return { titanId: cue.resolvedTitanId };
    return {
      location: {
        group: cue.placement.group,
        page: cue.placement.page,
        index: cue.placement.index,
      },
    };
  }

  /** 触发一个散 cue。人工与调度共用此通道。 */
  private async fireCue(req: FireRequest): Promise<void> {
    const cue = findCue(this.cueBank, req.cueId);
    if (!cue) throw new Error(`散 cue '${req.cueId}' 不在库中`);
    if (!this.playbacks) {
      // 离线模式：不报错，只记录 —— 保证离线也能预演整个流程
      this.emit('fire-offline', { cueId: req.cueId, name: cue.name });
      return;
    }
    try {
      await this.playbacks.fireAtLevel(this.refFor(cue), req.level, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const where = `${cue.placement.group} / 第 ${cue.placement.page} 页 / 第 ${cue.placement.index} 个`;
      throw new Error(
        `「${cue.name}」未能推到控台（落位 ${where}）。` +
          `原因：${msg}。` +
          `请确认该落位上确实有 playback，或在「准备」域点『解析控台句柄』。`,
      );
    }
  }

  async fireManual(cueId: string, level?: number): Promise<void> {
    const cue = findCue(this.cueBank, cueId);
    if (!cue) throw new Error(`散 cue '${cueId}' 不在库中`);
    await this.scheduler.fireManual(cueId, level ?? cue.defaultLevel);
  }

  async killCue(cueId: string): Promise<void> {
    const cue = findCue(this.cueBank, cueId);
    if (!cue) throw new Error(`散 cue '${cueId}' 不在库中`);
    if (!this.playbacks) return;
    await this.playbacks.kill(this.refFor(cue));
  }

  async killAll(): Promise<void> {
    if (!this.playbacks) return;
    await this.playbacks.killAll();
  }

  /**
   * 反向解析：连接控台后，把库中每个散 cue 的落位解析成 titanId 并缓存。
   * 这是 `titanId` 不持久化、只运行时解析的落地方式。
   */
  async resolveHandles(): Promise<{ resolved: number; failed: Array<{ name: string; error: string }> }> {
    if (!this.handles || !this.client) {
      throw new Error('尚未连接控台');
    }
    let resolved = 0;
    const failed: Array<{ name: string; error: string }> = [];
    for (const cue of allCues(this.cueBank)) {
      const key = `${cue.placement.group}/${cue.placement.page}/${cue.placement.index}`;
      try {
        const info = await this.handles.info({
          location: {
            group: cue.placement.group,
            page: cue.placement.page,
            index: cue.placement.index,
          },
        });
        if (info) {
          this.titanIdCache.set(key, info.titanId);
          resolved += 1;
        } else {
          failed.push({ name: cue.name, error: '未找到句柄' });
        }
      } catch (e) {
        failed.push({ name: cue.name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    this.emit('resolved', { resolved, failed });
    return { resolved, failed };
  }

  // ── 曲目与演出 ──────────────────────────────────────────────────────────

  get songList(): Song[] {
    return this.songs;
  }

  get currentSong(): Song | null {
    return this.songs.find((s) => s.id === this.currentSongId) ?? null;
  }

  upsertSong(song: Song): Song {
    const idx = this.songs.findIndex((s) => s.id === song.id);
    if (idx >= 0) this.songs[idx] = song;
    else this.songs.push(song);
    if (this.currentSongId === song.id) this.scheduler.load(song);
    this.emit('songs', this.songs);
    return song;
  }

  deleteSong(id: string): void {
    this.songs = this.songs.filter((s) => s.id !== id);
    if (this.currentSongId === id) {
      this.currentSongId = null;
      this.stopTicking();
    }
    this.emit('songs', this.songs);
  }

  loadSong(id: string): Song {
    const song = this.songs.find((s) => s.id === id);
    if (!song) throw new Error(`曲目 '${id}' 不存在`);
    this.currentSongId = id;
    this.scheduler.load(song);
    this.scheduler.clearLog();
    this.clock.setDuration(song.durationMs);
    this.emit('song-loaded', song);
    return song;
  }

  /** 开始播放 —— 用户的核心操作：「点播放，同时把散的 cue 推起来」。 */
  play(fromMs?: number): void {
    const song = this.currentSong;
    if (!song) throw new Error('尚未选择曲目');
    if (fromMs !== undefined) {
      this.clock.seek(fromMs);
      this.scheduler.seek(fromMs);
    }
    this.clock.start(fromMs ?? this.clock.now());
    this.startTicking();
    this.emit('transport', { running: true, positionMs: this.clock.now() });
  }

  pause(): void {
    this.clock.pause();
    this.stopTicking();
    this.emit('transport', { running: false, positionMs: this.clock.now() });
  }

  stop(): void {
    this.clock.pause();
    this.clock.seek(0);
    this.scheduler.reset();
    this.stopTicking();
    this.emit('transport', { running: false, positionMs: 0 });
  }

  seek(toMs: number): void {
    this.clock.seek(toMs);
    this.scheduler.seek(toMs);
    this.emit('transport', { running: this.clock.isRunning, positionMs: toMs });
  }

  /** 浏览器回报音频位置，用于漂移校正（R4.2 的"同一时钟"）。 */
  syncAudioPosition(reportedMs: number): void {
    const result = this.clock.syncTo(reportedMs);
    if (result.hardResynced) {
      // 硬重同步等同一次跳转，必须重新武装卡点
      this.scheduler.seek(reportedMs);
      this.emit('clock-resync', result);
    }
  }

  /** 「边听边标」：在当前位置记一个卡点。 */
  markAtCurrentTime(cueIds: string[], opts: { note?: string; level?: number } = {}): CueMark {
    const song = this.currentSong;
    if (!song) throw new Error('尚未选择曲目');
    const tMs = Math.max(0, Math.round(this.clock.now() - song.offsetMs));
    const mark: CueMark = {
      id: makeId('mark'),
      tMs,
      cueIds,
      level: opts.level ?? 1,
      ...(opts.note !== undefined ? { note: opts.note } : {}),
    };
    song.marks.push(mark);
    this.scheduler.load(song);
    this.scheduler.seek(this.clock.now());
    this.emit('marks', song.marks);
    return mark;
  }

  setSongOffset(id: string, offsetMs: number): void {
    const song = this.songs.find((s) => s.id === id);
    if (!song) return;
    song.offsetMs = offsetMs;
    if (this.currentSongId === id) {
      this.scheduler.load(song);
      this.scheduler.seek(this.clock.now());
    }
    this.emit('songs', this.songs);
  }

  private startTicking(): void {
    if (this.tickTimer) return;

    // 调度与推送使用**两个不同频率** —— 这是刻意的：
    //
    // - 调度 5ms：与 ±20ms 的精度目标相匹配。（本机实测偏差约 1–6ms）
    // - 推送 50ms（20Hz）：UI 时钟与进度条完全够用。
    //   若按调度频率推送，浏览器每秒要处理 200 个 SSE 事件 ——
    //   在学校的老笔记本上纯属浪费，且可能拖慢演出页。
    let lastBroadcast = 0;
    const BROADCAST_INTERVAL_MS = 50;

    this.tickTimer = setInterval(() => {
      void this.scheduler.tick();

      const now = Date.now();
      if (now - lastBroadcast >= BROADCAST_INTERVAL_MS) {
        lastBroadcast = now;
        this.emit('position', { positionMs: this.clock.now(), running: this.clock.isRunning });
      }
      if (this.clock.isFinished()) {
        this.pause();
      }
    }, 5);
    this.tickTimer.unref?.();
  }

  private stopTicking(): void {
    if (!this.tickTimer) return;
    clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  // ── 分析（R2：结构体检） ────────────────────────────────────────────────

  get report(): AnalysisReport | null {
    return this.lastReport;
  }

  get inventory(): ShowInventory | null {
    return this.lastInventory;
  }

  /**
   * 读取控台现有 show 并做结构体检。
   *
   * ⚠️ 代价与副作用（必须让使用者知道）：
   * - 逐 cue 读元数据是 O(cues) × 每次 8 次 HTTP 往返
   * - 且**会改动控台操作员的时间编辑器选中项**
   * → 应在非演出时段运行；演出域不提供此入口。
   */
  async analyzeShow(opts: { maxCuesPerPlayback?: number } = {}): Promise<AnalysisReport> {
    if (!this.reader) throw new Error('尚未连接控台 —— 分析需要读取控台上的 show。');
    this.emit('analyze-progress', { phase: 'reading', message: '正在读取 show 结构…' });
    const inventory = await this.reader.readInventory(
      opts.maxCuesPerPlayback !== undefined ? { maxCuesPerPlayback: opts.maxCuesPerPlayback } : {},
    );
    this.lastInventory = inventory;
    this.emit('analyze-progress', { phase: 'analyzing', message: '正在分析…' });
    const report = analyze(inventory);
    this.lastReport = report;
    this.emit('analysis', report);
    return report;
  }

  /** 生成中文提示本（Markdown）。 */
  cueSheetMarkdown(title?: string): string {
    if (!this.lastInventory) {
      throw new Error('还没有读取过 show —— 请先点「读取并体检」。');
    }
    return renderCueSheet(this.lastInventory, title !== undefined ? { title } : {});
  }

  // ── 快照 ────────────────────────────────────────────────────────────────

  snapshot(): AppSnapshot {
    const next = this.scheduler.peekNext();
    const song = this.currentSong;
    return {
      connection: this.connection,
      cueBank: serializeCueBank(this.cueBank),
      songs: this.songs,
      currentSongId: this.currentSongId,
      transport: {
        running: this.clock.isRunning,
        positionMs: Math.round(this.clock.now()),
        durationMs: song?.durationMs ?? 0,
        nextMark: next ? { id: next.id, tMs: next.tMs, ...(next.note ? { note: next.note } : {}) } : null,
        offsetMs: song?.offsetMs ?? 0,
      },
      stats: this.scheduler.stats(),
      recentHits: this.scheduler.hitLog.slice(-50),
      analysis: this.lastReport,
    };
  }

  // ── 演示内容（离线也能立刻看到东西） ────────────────────────────────────

  private seedDemoContent(): void {
    this.cueBank = {
      group: 'Playbacks',
      pages: [
        {
          page: 1,
          name: '第一幕',
          cues: [
            mk('开场全台', 'Playbacks', 1, 1, ['第一幕']),
            mk('独白面光', 'Playbacks', 1, 2, ['第一幕']),
            mk('转场暗场', 'Playbacks', 1, 3, ['第一幕']),
            mk('天幕蓝', 'Playbacks', 1, 4, ['第一幕']),
          ],
        },
        {
          page: 2,
          name: '第二幕',
          cues: [
            mk('侧光强化', 'Playbacks', 2, 1, ['第二幕']),
            mk('追光位', 'Playbacks', 2, 2, ['第二幕']),
          ],
        },
      ],
    };

    const song = emptySong('序曲（示例）', '');
    song.durationMs = 180_000;
    const ids = allCues(this.cueBank).map((c) => c.id);
    song.marks = [
      { id: makeId('mark'), tMs: 0, cueIds: [ids[0]!], level: 1, note: '起幕' },
      { id: makeId('mark'), tMs: 12_480, cueIds: [ids[1]!], level: 1, note: '独白开始' },
      { id: makeId('mark'), tMs: 28_000, cueIds: [ids[2]!], level: 1, note: '转场' },
      { id: makeId('mark'), tMs: 45_100, cueIds: [ids[3]!], level: 1, note: '天幕变蓝' },
    ];
    this.songs = [song];
    this.currentSongId = song.id;
    this.scheduler.load(song);
    this.clock.setDuration(song.durationMs);
  }
}

function mk(
  name: string,
  group: string,
  page: number,
  index: number,
  tags: string[],
): ScatteredCue {
  return {
    id: makeId('cue'),
    name,
    placement: { group, page, index },
    times: { fadeInMs: 3000, fadeOutMs: 3000, delayMs: 0 },
    defaultLevel: 1,
    tags,
  };
}
