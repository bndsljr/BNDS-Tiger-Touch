/**
 * `Playbacks` provider —— **散 cue 的核心操作面**。
 *
 * 本项目的变光模型是「散的 cue」：每个变光状态 = 一个独立 playback（单 cue memory），
 * **不组成 cue list**。因此这里只封装单 cue playback 的操作，
 * 以及读取既有结构的只读方法。
 *
 * 关键事实（见 docs/01-API调研笔记.md §3.1 / §3.2）：
 * - `StoreCue` 的 doc 原文：*"The new cue is created using the information in the
 *   programmer and the current record mode."* → **依赖 programmer**
 * - ⚠️ 社区观测：WebAPI 是"另一个用户"，有**自己的** programmer，
 *   控台上的选灯不会传递过来 → 「编程」类能力需实测，本模块的触发/熄灭部分不受影响
 * - ⚠️ `Playbacks.AppendChaseStep` **不存在**（`CreateChase` 的正文引用了它，属文档错误）
 */

import type { TitanClient } from '../client.ts';
import { handle, level, levelDelta, type ParamValue } from '../params.ts';
import type { HandleRef } from '../handles.ts';

export interface PlaybackSummary {
  titanId: number;
  legend: string;
  cueIds: number[];
  cueCount: number;
  active: boolean;
  level: number;
}

export class Playbacks {
  private readonly client: TitanClient;
  constructor(client: TitanClient) {
    this.client = client;
  }

  // ── 触发 / 熄灭（operate —— 不依赖 programmer，可靠性高） ──────────────

  /**
   * 触发 playback 到指定电平。
   *
   * `alwaysRefire` 为 true 时先熄灭再重新触发 —— 对"同一个散 cue 连续推两次"
   * 这类剧场操作是必需的。
   */
  async fireAtLevel(ref: HandleRef, levelValue: number, alwaysRefire = false): Promise<void> {
    await this.client.call('Playbacks', 'FirePlaybackAtLevel', {
      handle: handle(ref),
      level: level(levelValue),
      alwaysRefire,
    });
  }

  /** 增量调整电平。默认发**大写 D** 的 `levelDelta`（见 params.ts 的地雷说明）。 */
  async adjustLevel(ref: HandleRef, delta: number): Promise<void> {
    await this.client.call('Playbacks', 'SetPlaybackLevel', {
      srcHandle: handle(ref),
      level: levelDelta(delta),
    });
  }

  /** 设定绝对电平。 */
  async setLevel(ref: HandleRef, levelValue: number): Promise<void> {
    await this.client.call('Playbacks', 'SetPlaybackLevel', {
      srcHandle: handle(ref),
      level: level(levelValue),
    });
  }

  async kill(ref: HandleRef): Promise<void> {
    await this.client.call('Playbacks', 'KillPlayback', { handle: handle(ref) });
  }

  async release(ref: HandleRef, fadeTimeSeconds?: number): Promise<void> {
    const params: Record<string, ParamValue> = { handle: handle(ref) };
    if (fadeTimeSeconds !== undefined) {
      params['fadeTime'] = fadeTimeSeconds;
      params['useMasterReleaseTime'] = false;
    }
    await this.client.call('Playbacks', 'ReleasePlayback', params);
  }

  /** 熄灭全部 —— 演出中的紧急操作。 */
  async killAll(): Promise<void> {
    await this.client.call('Playbacks', 'KillAllPlaybacks');
  }

  /** 切换 latch 状态（按钮型 playback 的开关语义）。 */
  async toggleLatch(ref: HandleRef): Promise<void> {
    await this.client.call('Playbacks', 'ToggleLatchPlayback', { handle: handle(ref) });
  }

  // ── 结构与元数据读取（只读，可靠） ─────────────────────────────────────

  /** 枚举一个 playback 上的全部 cue id。 */
  async getCueIds(ref: HandleRef, min = 0, max = 9999): Promise<number[]> {
    const raw = await this.client.script('Playbacks', 'GetPlaybackCueIds', {
      playback: handle(ref),
      minCueNumber: min,
      maxCueNumber: max,
    });
    return parseNumberList(raw);
  }

  async getCueId(ref: HandleRef, cueNumber: number): Promise<number | null> {
    const raw = await this.client.script('Playbacks', 'GetPlaybackCueId', {
      handle: handle(ref),
      cueNumber,
    });
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }

  async doesCueExist(ref: HandleRef, cueNumber: number): Promise<boolean> {
    const raw = await this.client.script('Playbacks', 'DoesCueExist', {
      handle: handle(ref),
      cueNumber,
    });
    return /^(true|1)$/i.test(raw.trim());
  }

  /** cue list 的下一步提示号（也用于单 cue playback 的"下一个 cue 号"）。 */
  async getNextStepHint(ref: HandleRef): Promise<number> {
    const raw = await this.client.script('Playbacks', 'GetNextStepHint', {
      playbackHandle: handle(ref),
    });
    const n = Number(raw);
    return Number.isFinite(n) ? n : 1;
  }

  // ── 录制（**依赖 programmer，需实测**） ────────────────────────────────

  /**
   * 从当前 programmer 内容录一个 cue 到指定句柄。
   *
   * ⚠️ 这是「编程」类能力。社区观测指出 WebAPI 的 programmer 与控台的是**两个**，
   * 控台上的选灯不会带过来 → 首次连真控台时必须优先验证此路径。
   */
  async storeCue(group: string, index: number, updateOnly = false): Promise<number> {
    const raw = await this.client.script('Playbacks', 'StoreCue', {
      group,
      index,
      updateOnly,
    });
    const n = Number(raw);
    return Number.isFinite(n) ? n : -1;
  }

  /**
   * 批量写 cue 名称。
   *
   * ⭐ 选它而不是 `Playbacks.Editor.Times.*`：本方法**显式寻址、无上下文依赖**，
   * 而 `Editor.Times.*` 依赖"当前选中的 cue"，会**改动控台操作员的 UI 状态**。
   */
  async setCueLegend(ref: HandleRef, cueNumber: number, newLegend: string): Promise<void> {
    await this.client.call('Playbacks', 'SetCueLegend', {
      handle: handle(ref),
      cueNumber,
      newLegend,
    });
  }

  async setPlaybackLegend(ref: HandleRef, legend: string): Promise<void> {
    await this.client.call('Playbacks', 'SetPlaybackLegend', {
      handle: handle(ref),
      legend,
    });
  }

  // ── 句柄占用判定 ───────────────────────────────────────────────────────

  /** 记录前校验候选分组名是否允许录制 playback。 */
  async isAllowedGroup(groupName: string): Promise<boolean> {
    const raw = await this.client.script('Playbacks', 'IsAllowedGroup', { groupName });
    return /^(true|1)$/i.test(raw.trim());
  }
}

function parseNumberList(raw: string): number[] {
  const text = raw.trim();
  if (text === '' || text === '[]') return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.map((v) => Number(v)).filter((n) => Number.isFinite(n));
    }
    if (typeof parsed === 'number') return [parsed];
  } catch {
    // 线格式未文档化 —— 回退到宽松解析
  }
  return text
    .split(/[,\s]+/)
    .map((t) => Number(t.replace(/[^\d.-]/g, '')))
    .filter((n) => Number.isFinite(n));
}
