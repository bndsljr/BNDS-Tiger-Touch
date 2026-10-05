/**
 * 散 cue 库 —— 本项目的变光模型核心。
 *
 * ## 为什么是「散的 cue」而不是 cue list
 *
 * 用户明确要求：*"我不想让你做成一个 quelist，我就想让你做成散的 que。
 * 因为我们也需要人手来实时把它推起来。"*
 *
 * 因此每个变光状态 = **一个独立的 playback**（Titan 里就是单 cue 的 Memory）：
 * - 人可以随时单独推/收任意一个，互不干扰
 * - 系统也可以在卡点时刻单独推任意一个
 * - 两者共存，不需要「走 cue 表」那种顺序状态机
 *
 * 这与 Titan 的实现天然吻合：`HandleOptions.Memories.*` 与 `HandleOptions.CueLists.*`
 * 是并列的两套配置面，印证散 cue 与 cue list 是两条独立路径。
 *
 * ## TitanId 为什么不在持久化数据里
 *
 * 社区实测：*"there is no practical way to find the TitanId of a specific item,
 * and it might be different in the next show"*，且 ID 会随版本变化。
 * → 持久化只存**落位**（group/page/index）与 userNumber，
 *   titanId 在连接控台时**运行时解析并缓存**。
 */

import { HANDLE_GROUPS } from '../titan/handles.ts';

/** 落位：句柄在控台上的位置。这是可持久化、可人工核对的标识。 */
export interface CuePlacement {
  /** 句柄分组。优先用权威大写规范名。 */
  group: string;
  page: number;
  index: number;
}

export interface CueTimes {
  fadeInMs: number;
  fadeOutMs: number;
  delayMs: number;
}

/** 一个「look」的抽象描述 —— 用于生成 programmer 内容。 */
export interface LookSpec {
  /** 参加此 look 的编组名（对应本项目的 Group 定义） */
  groups?: string[];
  /** 直接指定灯具 userNumber */
  fixtures?: number[];
  /** 属性名 → 值（0–1 归一化，或按属性语义取值） */
  attributes?: Record<string, number | string>;
}

export interface ScatteredCue {
  /** 本系统内的稳定 id，与控台无关 */
  id: string;
  name: string;
  placement: CuePlacement;
  times: CueTimes;
  /** 默认触发电平 */
  defaultLevel: number;
  tags: string[];
  look?: LookSpec;
  note?: string;
  /**
   * 运行时解析出的 titanId 缓存。
   * **不持久化** —— 换 show 或升级版本都会变。
   */
  resolvedTitanId?: number;
}

export interface CueBankPage {
  page: number;
  name: string;
  cues: ScatteredCue[];
}

export interface CueBank {
  /** 控台上用于承载散 cue 的分组。Tiger Touch 上 StaticPlaybacks 是右上角推子。 */
  group: string;
  pages: CueBankPage[];
}

export function emptyCueBank(group: string = HANDLE_GROUPS.Playbacks): CueBank {
  return { group, pages: [] };
}

export function allCues(bank: CueBank): ScatteredCue[] {
  return bank.pages.flatMap((p) => p.cues);
}

export function findCue(bank: CueBank, id: string): ScatteredCue | undefined {
  for (const page of bank.pages) {
    const hit = page.cues.find((c) => c.id === id);
    if (hit) return hit;
  }
  return undefined;
}

export function findPageOf(bank: CueBank, cueId: string): CueBankPage | undefined {
  return bank.pages.find((p) => p.cues.some((c) => c.id === cueId));
}

/** 落位是否冲突 —— 两个 cue 不能占同一个句柄。 */
export function findPlacementConflicts(bank: CueBank): Array<{ a: ScatteredCue; b: ScatteredCue }> {
  const conflicts: Array<{ a: ScatteredCue; b: ScatteredCue }> = [];
  const seen = new Map<string, ScatteredCue>();
  for (const cue of allCues(bank)) {
    const key = `${cue.placement.group}/${cue.placement.page}/${cue.placement.index}`;
    const prev = seen.get(key);
    if (prev) conflicts.push({ a: prev, b: cue });
    else seen.set(key, cue);
  }
  return conflicts;
}

/**
 * 为新增的散 cue 找下一个空闲落位。
 * 从 index=1 开始，与 Titan 的 1-based 观感一致。
 */
export function nextFreePlacement(bank: CueBank, page: number, group = bank.group): CuePlacement {
  const used = new Set(
    allCues(bank)
      .filter((c) => c.placement.group === group && c.placement.page === page)
      .map((c) => c.placement.index),
  );
  let index = 1;
  while (used.has(index)) index += 1;
  return { group, page, index };
}

/** 生成一个与控台无关的本地 id。 */
export function makeCueId(seed?: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const base = (seed ?? 'cue').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32);
  return `${base}-${Date.now().toString(36)}-${rand}`;
}

export function defaultTimes(): CueTimes {
  // 剧场常见默认：3 秒渐亮渐暗
  return { fadeInMs: 3000, fadeOutMs: 3000, delayMs: 0 };
}

/** 序列化：去掉运行时解析出的 titanId。 */
export function serializeCueBank(bank: CueBank): CueBank {
  return {
    group: bank.group,
    pages: bank.pages.map((p) => ({
      page: p.page,
      name: p.name,
      cues: p.cues.map(({ resolvedTitanId: _drop, ...rest }) => rest),
    })),
  };
}
