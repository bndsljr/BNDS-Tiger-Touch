/**
 * 现有 show 的**读取模型**。
 *
 * ## 为什么这个模块必须把限制写在最前面
 *
 * 调研已**穷举确认**：无法从 cue 中读出属性/DMX 数值。
 * - 不存在 `GetValue` / `GetAttribute` / `GetDmx` / `GetCueValues` / `Cue.GetContents`
 * - `TrackingData.FetchItems(TrackingDataItemsInView)` 返回 `Void` —— 它把数据推进
 *   客户端对象，**没有 HTTP 形态的接收方式**，即 Titan 信息最丰富的
 *   Tracking View **对外部程序完全不可达**
 *
 * 因此本模块只能读出**结构与元数据**：
 * cue 号、legend、渐变/延时时间、link、move-in-dark、tracking **模式**、备注。
 *
 * ⚠️ **不要在本模块之外承诺"AI 能看出灯光对不对"。** 那需要离线解析 show XML
 * 或外部抓 DMX，不在这条路径上。
 *
 * ## 读取代价（必须让使用者知道）
 *
 * 逐 cue 读时间/legend 需要循环：设 `TimesEdit/CueNumber` → `FillTimes` → 读属性。
 * 复杂度 **O(cues) × 每次 8 个 HTTP 往返**，且**会改动控台操作员的 UI 状态**
 * （移动其时间编辑器选中项）。因此：
 * - 分析应在**非演出时段**进行
 * - `maxCuesPerPlayback` 用于给大 show 设上限，避免把控台拖死
 */

import type { TitanClient } from '../client.ts';
import { Handles } from './handles.ts';
import { Playbacks } from './playbacks.ts';

/** `/titan/handles` 返回的单条句柄（形状来自官方 Introduction 页）。 */
export interface RawHandle {
  handleLocation?: { group?: string; index?: number; page?: number };
  titanId?: number;
  type?: string;
  Active?: boolean;
  Legend?: string;
  userNumber?: number;
  properties?: Array<{ Key?: string; Value?: string }>;
}

export interface FixtureInfo {
  titanId: number;
  userNumber: number | null;
  legend: string;
  group: string;
}

export interface GroupInfo {
  titanId: number;
  userNumber: number | null;
  legend: string;
}

export interface PaletteInfo {
  titanId: number;
  userNumber: number | null;
  legend: string;
  /** 句柄分组，如 Colours / Positions / Beams */
  group: string;
}

export interface CueInfo {
  cueId: number | null;
  cueNumber: number;
  legend: string;
  fadeInMs: number | null;
  fadeOutMs: number | null;
  delayInMs: number | null;
  delayOutMs: number | null;
  link: boolean;
  linkOffsetMs: number | null;
  moveInDark: boolean;
  /** `AcwTrackingType` 的字面名 */
  tracking: string;
  notes: string;
}

export interface PlaybackInfo {
  titanId: number;
  userNumber: number | null;
  legend: string;
  group: string;
  page: number;
  index: number;
  /** memory = 单 cue（散 cue）；多 cue 说明是 cue list 或 chase */
  kind: 'memory' | 'cuelist' | 'multi';
  cueCount: number;
  cues: CueInfo[];
  /** cue 元数据是否完整读出（受上限或错误影响） */
  cuesReadComplete: boolean;
}

export interface ShowInventory {
  /** 发现方式 —— 决定我们对"完整性"的信心 */
  discovery: 'bulk' | 'none';
  discoveryNote: string;
  fixtures: FixtureInfo[];
  groups: GroupInfo[];
  palettes: PaletteInfo[];
  playbacks: PlaybackInfo[];
  /** 本次读取消耗的 HTTP 往返次数 —— 用于向使用者交代代价 */
  requestsUsed: number;
  /** 读取过程中遇到的非致命问题 */
  warnings: string[];
}

export interface ReadInventoryOptions {
  /** 每个回放最多读多少个 cue 的元数据（默认 60）。用于防止大 show 拖死控台。 */
  maxCuesPerPlayback?: number;
  /** 每个回放最多读多少个 cue 的**编号**（默认 500） */
  maxCueNumbersPerPlayback?: number;
}

const PALETTE_GROUPS = new Set(['Colours', 'Positions', 'Beams', 'Effects', 'Media']);

export class ShowReader {
  private readonly client: TitanClient;
  private readonly handles: Handles;
  private readonly playbacks: Playbacks;
  private requests = 0;

  constructor(client: TitanClient) {
    this.client = client;
    this.handles = new Handles(client);
    this.playbacks = new Playbacks(client);
  }

  /** 计数包装 —— 让"这次分析花了多少次往返"可量化。 */
  private async counted<T>(fn: () => Promise<T>): Promise<T> {
    this.requests += 1;
    return fn();
  }

  async readInventory(options: ReadInventoryOptions = {}): Promise<ShowInventory> {
    const maxCues = options.maxCuesPerPlayback ?? 60;
    const maxCueNumbers = options.maxCueNumbersPerPlayback ?? 500;
    this.requests = 0;
    const warnings: string[] = [];

    const probe = await this.handles.probeBulkEndpoint();
    if (!probe.available) {
      return {
        discovery: 'none',
        discoveryNote:
          `无法读取 show 结构：批量句柄端点 /titan/handles 不可用（${probe.error ?? '未知原因'}）。` +
          `该端点只出现在过时的 Introduction 页，16.0 参考文档中零命中 —— ` +
          `需在真控台上确认它是否仍然存在；若不存在，只能退化为按落位逐个探测。`,
        fixtures: [],
        groups: [],
        palettes: [],
        playbacks: [],
        requestsUsed: this.requests,
        warnings,
      };
    }

    this.requests += 1; // 全量句柄拉取算一次
    const raw = (await this.handles.fetchAll()) as RawHandle[];

    const fixtures: FixtureInfo[] = [];
    const groups: GroupInfo[] = [];
    const palettes: PaletteInfo[] = [];
    const playbackHandles: RawHandle[] = [];

    for (const h of raw) {
      const group = h.handleLocation?.group ?? '';
      const titanId = h.titanId;
      if (typeof titanId !== 'number') continue;
      const legend = h.Legend ?? '';
      const userNumber = typeof h.userNumber === 'number' ? h.userNumber : null;

      if (group === 'Fixtures') {
        fixtures.push({ titanId, userNumber, legend, group });
      } else if (group === 'Groups') {
        groups.push({ titanId, userNumber, legend });
      } else if (PALETTE_GROUPS.has(group)) {
        palettes.push({ titanId, userNumber, legend, group });
      } else if (
        group === 'Playbacks' ||
        group === 'StaticPlaybacks' ||
        group === 'RollerA' ||
        group === 'RollerB' ||
        group === 'PlaybackWindow'
      ) {
        playbackHandles.push(h);
      }
    }

    const playbacks: PlaybackInfo[] = [];
    for (const h of playbackHandles) {
      const titanId = h.titanId!;
      const handle = { titanId };
      try {
        const cueIds = await this.counted(() =>
          this.playbacks.getCueIds(handle, 0, maxCueNumbers),
        );
        const cueCount = cueIds.length;

        const cues: CueInfo[] = [];
        let complete = true;

        // 先枚举 cue 编号。
        //
        // ⚠️ 这是文档空缺造成的额外成本：`GetPlaybackCueIds` 返回的是 **cue id**，
        // 而读时间属性需要的是 **cue number**，二者的映射没有直接方法。
        // 因此用有文档的 `DoesCueExist` 逐个探测候选编号。
        const numbers = await this.enumerateCueNumbers(handle, cueCount, maxCueNumbers);
        if (numbers.length < cueCount) {
          complete = false;
          warnings.push(
            `「${h.Legend ?? titanId}」报告有 ${cueCount} 个 cue，` +
              `但按编号探测只找到 ${numbers.length} 个（Titan 允许小数编号，` +
              `本工具目前只探测整数编号）。`,
          );
        }

        const toRead = Math.min(numbers.length, maxCues);
        if (numbers.length > maxCues) {
          complete = false;
          warnings.push(
            `「${h.Legend ?? titanId}」有 ${numbers.length} 个 cue，只读了前 ${maxCues} 个` +
              `（受 maxCuesPerPlayback 限制，避免拖慢控台）。`,
          );
        }

        for (const cueNumber of numbers.slice(0, toRead)) {
          try {
            cues.push(await this.readCue(handle, cueNumber));
          } catch (e) {
            complete = false;
            warnings.push(
              `读「${h.Legend ?? titanId}」cue ${cueNumber} 失败：` +
                `${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }

        playbacks.push({
          titanId,
          userNumber: typeof h.userNumber === 'number' ? h.userNumber : null,
          legend: h.Legend ?? '',
          group: h.handleLocation?.group ?? '',
          page: h.handleLocation?.page ?? 0,
          index: h.handleLocation?.index ?? 0,
          kind: cueCount <= 1 ? 'memory' : 'multi',
          cueCount,
          cues,
          cuesReadComplete: complete,
        });
      } catch (e) {
        complete0(warnings, h, e);
      }
    }

    return {
      discovery: 'bulk',
      discoveryNote:
        `/titan/handles 返回 ${raw.length} 个句柄。` +
        `⚠️ 该端点在 16.0 参考文档中零命中，仅见于过时 Introduction 页 —— 完整性未经验证。`,
      fixtures,
      groups,
      palettes,
      playbacks,
      requestsUsed: this.requests,
      warnings,
    };
  }

  /**
   * 枚举一个回放上真实存在的 cue 编号。
   *
   * ⚠️ **这是文档空缺造成的额外成本，不是设计缺陷。**
   * `GetPlaybackCueIds` 返回 cue id，而 `TimesEdit/CueNumber` 要 cue number，
   * 二者之间没有有文档的映射方法。因此只能按候选编号逐个 `DoesCueExist` 探测。
   *
   * 策略：
   * - 先试 `0`（Titan 常用 0 号做前奏/待机 cue）
   * - 再扫 `1..upper`，`upper` 由期望数量决定（`cueCount + 10`，上限 `maxCueNumbers`）
   * - 找满 `cueCount` 个即提前停止，避免无谓往返
   * - ⚠️ **只探测整数编号** —— Titan 允许小数编号（如 `2.5`），本工具目前不覆盖
   */
  private async enumerateCueNumbers(
    handle: { titanId: number },
    cueCount: number,
    maxCueNumbers: number,
  ): Promise<number[]> {
    if (cueCount <= 0) return [];
    const found: number[] = [];
    const upper = Math.min(cueCount + 10, maxCueNumbers);

    const candidates: number[] = [0];
    for (let n = 1; n <= upper; n++) candidates.push(n);

    for (const n of candidates) {
      if (found.length >= cueCount) break;
      const exists = await this.counted(() =>
        this.playbacks.doesCueExist(handle, n).catch(() => false),
      );
      if (exists) found.push(n);
    }
    return found;
  }

  /** 读一个 cue 的元数据。这是 O(cues) 循环的代价所在。 */
  private async readCue(handle: { titanId: number }, cueNumber: number): Promise<CueInfo> {
    // 1. 选中目标 cue
    await this.counted(() => this.client.set('Playbacks', 'TimesEdit/CueNumber', cueNumber));
    // 2. 让控台填充该 cue 的时间属性（并设定当前时间编辑句柄）
    await this.counted(() => this.client.call('Playbacks', 'TimesEdit/FillTimes', { handle }));

    // 3. 读取（8 次往返）
    const [
      legend,
      fadeInRaw,
      fadeOutRaw,
      delayInRaw,
      delayOutRaw,
      linkRaw,
      linkOffsetRaw,
      moveInDarkRaw,
      tracking,
      notes,
    ] = await Promise.all([
      this.get('Playbacks/Editor/Times/CueLegend'),
      this.get('Playbacks/Editor/Times/CueFadeInTime'),
      this.get('Playbacks/Editor/Times/CueFadeOutTime'),
      this.get('Playbacks/Editor/Times/CueDelayInTime'),
      this.get('Playbacks/Editor/Times/CueDelayOutTime'),
      this.get('Playbacks/Editor/Times/CueLink'),
      this.get('Playbacks/Editor/Times/CueLinkOffset'),
      this.get('Playbacks/Editor/Times/CueMoveInDark'),
      this.get('Playbacks/Editor/Times/CueTracking'),
      this.get('Playbacks/Editor/Times/CueNotes'),
    ]);

    return {
      cueId: null,
      cueNumber,
      legend,
      fadeInMs: secondsToMs(fadeInRaw),
      fadeOutMs: secondsToMs(fadeOutRaw),
      delayInMs: secondsToMs(delayInRaw),
      delayOutMs: secondsToMs(delayOutRaw),
      link: /^(true|1)$/i.test(linkRaw),
      linkOffsetMs: secondsToMs(linkOffsetRaw),
      moveInDark: /^(true|1)$/i.test(moveInDarkRaw),
      tracking,
      notes,
    };
  }

  private async get(providerAndProp: string): Promise<string> {
    const idx = providerAndProp.lastIndexOf('/');
    const provider = providerAndProp.slice(0, idx);
    const prop = providerAndProp.slice(idx + 1);
    this.requests += 1;
    return this.client.get(provider, prop).catch(() => '');
  }
}

function complete0(warnings: string[], h: RawHandle, e: unknown): void {
  warnings.push(
    `读取回放「${h.Legend ?? h.titanId}」失败：${e instanceof Error ? e.message : String(e)}`,
  );
}

/**
 * 秒 → 毫秒。
 *
 * ⚠️ **单位存疑**：文档从未说明这些时间属性的单位是秒还是毫秒。
 * 本函数按"数值 + 单位字符串"启发式处理：
 * - `"3.0"` → 视为秒 → 3000ms
 * - `"3000"` → 值 ≥ 1000 视为毫秒（避免把 1.5 秒误判成 1.5ms）
 *
 * 连真控台时必须实测确认（列入 §10.1 验证清单）。
 */
export function secondsToMs(raw: string): number | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0;
  // 大于等于 1000 的裸数值更可能是毫秒；小数值几乎肯定是秒
  if (n >= 1000 && Number.isInteger(n)) return n;
  return Math.round(n * 1000);
}
