/**
 * 卡点调度器 —— 演出时按时刻推动散 cue。
 *
 * ## 设计要点
 *
 * 1. **单向触发，不做状态纠偏。**
 *    每次到点只发一次 `FirePlaybackAtLevel`，然后**不去轮询/覆盖控台状态**。
 *    这是需求 R4.5「人工干预不打架」的实现方式：
 *    人在控台上推/收任何 cue，系统都不会反向把它改回来。
 *
 * 2. **按时刻精确触发，并记录偏差。**
 *    每次触发的实际时刻与计划时刻之差会记录下来，供复盘域统计 ——
 *    这是把"卡点准不准"从感觉变成数据的唯一办法。
 *
 * 3. **跳转后重新武装。**
 *    `seek()` 之后，已过时刻的卡点不会补触（避免"追发"造成灯光乱闪），
 *    但会重新从新位置的下一拍开始。
 */

import type { ShowClock } from './showclock.ts';
import { effectiveTimeMs, sortedMarks, type CueMark, type Song } from '../model/song.ts';

export interface FireRequest {
  markId: string;
  cueId: string;
  level: number;
  fadeMs?: number;
}

/** 实际发生的一次触发记录 —— 复盘域用。 */
export interface CueHit {
  markId: string;
  cueId: string;
  /** 计划时刻（毫秒，含整曲偏移） */
  scheduledMs: number;
  /** 实际触发时的演出位置（毫秒） */
  actualMs: number;
  /** 实际 - 计划。正值 = 晚了 */
  latenessMs: number;
  /** 是否由人工触发而非调度器 */
  manual: boolean;
  note?: string;
  at: number;
}

export interface SchedulerOptions {
  clock: ShowClock;
  /** 执行一次触发。由上层解析 cueId → 控台句柄并下发。 */
  fire: (req: FireRequest) => Promise<void>;
  /** 触发完成后的回调，用于记录/推送。 */
  onHit?: (hit: CueHit) => void;
  onError?: (err: unknown, req: FireRequest) => void;
}

export class Scheduler {
  private readonly clock: ShowClock;
  private readonly fire: SchedulerOptions['fire'];
  private readonly onHit: SchedulerOptions['onHit'];
  private readonly onError: SchedulerOptions['onError'];

  private song: Song | null = null;
  private marks: CueMark[] = [];
  /** 下一个待触发卡点的下标 */
  private cursor = 0;
  private hits: CueHit[] = [];
  private ticking = false;
  private firedMarkIds = new Set<string>();

  constructor(options: SchedulerOptions) {
    this.clock = options.clock;
    this.fire = options.fire;
    this.onHit = options.onHit;
    this.onError = options.onError;
  }

  load(song: Song): void {
    this.song = song;
    this.marks = sortedMarks(song);
    this.cursor = 0;
    this.firedMarkIds.clear();
  }

  get currentSong(): Song | null {
    return this.song;
  }

  get hitLog(): readonly CueHit[] {
    return this.hits;
  }

  clearLog(): void {
    this.hits = [];
  }

  /** 下一个待触发的卡点（供 UI 预告）。 */
  peekNext(): CueMark | null {
    return this.marks[this.cursor] ?? null;
  }

  /**
   * 跳转。已过时刻的卡点标记为"已触发"以避免补触，
   * 但**不写命中记录** —— 它们并没有真的被推。
   */
  seek(toMs: number): void {
    if (!this.song) return;
    this.cursor = 0;
    this.firedMarkIds.clear();
    while (this.cursor < this.marks.length) {
      const mark = this.marks[this.cursor]!;
      if (effectiveTimeMs(this.song, mark) < toMs) {
        this.firedMarkIds.add(mark.id);
        this.cursor += 1;
      } else {
        break;
      }
    }
  }

  /** 回到开头。 */
  reset(): void {
    this.cursor = 0;
    this.firedMarkIds.clear();
  }

  /**
   * 推进一步。应在演出期间以高频调用（建议 5–20ms）。
   *
   * 会触发**所有**已到时刻但尚未触发的卡点 ——
   * 这样即使某次 tick 被阻塞，也不会丢拍（只会晚一点点，且会被记录下来）。
   */
  async tick(): Promise<void> {
    if (this.ticking || !this.song || !this.clock.isRunning) return;
    this.ticking = true;
    try {
      const now = this.clock.now();
      while (this.cursor < this.marks.length) {
        const mark = this.marks[this.cursor]!;
        const dueAt = effectiveTimeMs(this.song, mark);
        if (dueAt > now) break;

        this.cursor += 1;
        this.firedMarkIds.add(mark.id);
        await this.dispatch(mark, dueAt, now);
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * 人工触发一个卡点（或任意散 cue）。
   * 记录为 `manual: true`，不计入调度偏差统计 ——
   * 否则人工操作会污染"卡点精度"这个指标。
   */
  async fireManual(cueId: string, level = 1, fadeMs?: number, note?: string): Promise<void> {
    const now = this.clock.now();
    const req: FireRequest = {
      markId: `manual-${Date.now()}`,
      cueId,
      level,
      ...(fadeMs !== undefined ? { fadeMs } : {}),
    };
    // 人工触发**必须把失败抛出去** —— 操作者需要立刻知道"这一下没推上去"。
    // （调度触发则相反：单个失败不应中断演出，见 dispatch。）
    try {
      await this.fire(req);
    } catch (err) {
      this.onError?.(err, req);
      throw err;
    }
    const hit: CueHit = {
      markId: req.markId,
      cueId,
      scheduledMs: now,
      actualMs: now,
      latenessMs: 0,
      manual: true,
      ...(note !== undefined ? { note } : {}),
      at: Date.now(),
    };
    this.hits.push(hit);
    this.onHit?.(hit);
  }

  private async dispatch(mark: CueMark, dueAt: number, now: number): Promise<void> {
    for (const cueId of mark.cueIds) {
      const req: FireRequest = {
        markId: mark.id,
        cueId,
        level: mark.level,
        ...(mark.fadeMs !== undefined ? { fadeMs: mark.fadeMs } : {}),
      };
      // 用**触发那一刻**的时钟读数记录偏差；比用 tick 开始时的 now 更准
      const fireAt = this.clock.now();
      try {
        await this.fire(req);
        const hit: CueHit = {
          markId: mark.id,
          cueId,
          scheduledMs: dueAt,
          actualMs: fireAt,
          latenessMs: fireAt - dueAt,
          manual: false,
          ...(mark.note !== undefined ? { note: mark.note } : {}),
          at: Date.now(),
        };
        this.hits.push(hit);
        this.onHit?.(hit);
      } catch (err) {
        this.onError?.(err, req);
      }
    }
    void now;
  }

  /** 偏差统计 —— 复盘域展示「卡点准不准」。 */
  stats(): {
    count: number;
    manualCount: number;
    meanLatenessMs: number;
    maxLatenessMs: number;
    within20ms: number;
    within50ms: number;
  } {
    const auto = this.hits.filter((h) => !h.manual);
    if (auto.length === 0) {
      return {
        count: 0,
        manualCount: this.hits.length,
        meanLatenessMs: 0,
        maxLatenessMs: 0,
        within20ms: 0,
        within50ms: 0,
      };
    }
    const late = auto.map((h) => h.latenessMs);
    return {
      count: auto.length,
      manualCount: this.hits.length - auto.length,
      meanLatenessMs: late.reduce((a, b) => a + b, 0) / auto.length,
      maxLatenessMs: Math.max(...late),
      within20ms: auto.filter((h) => Math.abs(h.latenessMs) <= 20).length,
      within50ms: auto.filter((h) => Math.abs(h.latenessMs) <= 50).length,
    };
  }
}
