/**
 * 句柄寻址 —— Titan WebAPI 最容易出错的一环。
 *
 * 已核实的陷阱（见 docs/01-API调研笔记.md §2.3 / §8.2 / §8.3）：
 *
 * 1. `handle_location` 在全语料 3706 页里**只出现过 `playback_2_1` 一个值**，
 *    是文档生成器硬编码的示例，被复制到 419 处（甚至泄漏成 `palette_location=playback_2_1`
 *    这种不可能成立的形式）。语法从未写明 → 本项目**默认不使用它**。
 *
 * 2. 缺省的 `handle=` 会被当作 **userNumber**，且遇到 location 直接抛
 *    `Error: Failed to parse value to AcwUserNumber`。
 *    → 本项目**永远显式写后缀**。
 *
 * 3. 分组名有两套命名空间，**不要混淆**：
 *    - 对外 API 用的规范名：`Playbacks` / `Colours` / `Fixtures` …
 *    - 错误信息里的内部名：`playbackHandle` / `cueHandle` …（camelCase，另一套）
 */

/** 社区整理的权威句柄分组 id 清单（18 项，见调研笔记 §8.2）。 */
export const HANDLE_GROUPS = {
  Workspaces: 'Workspaces',
  Fixtures: 'Fixtures',
  Groups: 'Groups',
  Playbacks: 'Playbacks',
  /** Tiger Touch：滚轮奇数页 */
  RollerA: 'RollerA',
  /** Tiger Touch：滚轮偶数页 */
  RollerB: 'RollerB',
  /** Tiger Touch：右上角推子；第二行 = 静态句柄 11–20 */
  StaticPlaybacks: 'StaticPlaybacks',
  MobileWingAPlaybacks: 'MobileWingAPlaybacks',
  MobileWingAExecutor: 'MobileWingAExecutor',
  Presets: 'Presets',
  PresetFlashes: 'PresetFlashes',
  PlaybackWindow: 'PlaybackWindow',
  /** 宏窗口，以及 Tiger Touch 上 10 个专用宏/执行键（硬链到当前页 1–10） */
  Macros: 'Macros',
  Colours: 'Colours',
  Positions: 'Positions',
  /** Gobos & Beams 窗口 */
  Beams: 'Beams',
  Media: 'Media',
  /** Shapes & Effects 窗口 */
  Effects: 'Effects',
} as const;

export type HandleGroup = (typeof HANDLE_GROUPS)[keyof typeof HANDLE_GROUPS];

/** 可能是分组名但未经证实者，单独列出以免误用。 */
export const UNVERIFIED_HANDLE_GROUPS = ['Unassigned', 'Layouts'] as const;

/** 句柄引用。三种形式**必须显式择一**，绝不依赖控制台推断。 */
export type HandleRef =
  /** 系统唯一 id。**不可跨 show 持久化** —— 换 show 或升级版本都会变。 */
  | { titanId: number }
  /** 用户编号。仅在**同一句柄类型内**唯一（fixture / palette / playback 可以重号）。 */
  | { userNumber: number }
  /**
   * 位置字符串 `<group>_<page>_<index>`。
   * ⚠️ 唯一有文档的示例是 `playback_2_1`，语法与 page/index 从 0 还是 1 开始**均未文档化**。
   * 仅在实测校准后使用；否则请用 titanId / userNumber。
   */
  | { location: LocationRef };

export interface LocationRef {
  group: string;
  page: number;
  index: number;
}

/**
 * 把句柄引用编码成查询串键值对。
 *
 * 前缀来自调用方，例如 `handle` / `handles` / `shadowedHandle` / `playback`。
 * 后缀规则已核实：所有变体后缀均为 camelCase
 * （`_titanId` 596 次、`_userNumber` 511 次、`_location` 419 次、`_handleList` 132 次、
 *   `_userNumberList` 128 次、`_level` 49 次）。
 */
export function encodeHandle(prefix: string, ref: HandleRef): Record<string, string> {
  if ('titanId' in ref) {
    assertFiniteInt(ref.titanId, 'titanId');
    return { [`${prefix}_titanId`]: String(ref.titanId) };
  }
  if ('userNumber' in ref) {
    assertFiniteInt(ref.userNumber, 'userNumber');
    return { [`${prefix}_userNumber`]: String(ref.userNumber) };
  }
  const loc = ref.location;
  if (!loc.group) throw new TitanAddressError('location.group 不能为空');
  assertFiniteInt(loc.page, 'location.page');
  assertFiniteInt(loc.index, 'location.index');
  return { [`${prefix}_location`]: `${loc.group}_${loc.page}_${loc.index}` };
}

/**
 * 句柄**列表**。已核实：
 * - `_handleList` / `_userNumberList` 均为**逗号分隔**
 * - **不存在 location 列表**（逗号会与 location 语法冲突）
 */
export type HandleIdRef = { titanId: number } | { userNumber: number };

export function encodeHandleList(
  prefix: string,
  refs: readonly HandleIdRef[],
): Record<string, string> {
  const titanIds: number[] = [];
  const userNumbers: number[] = [];
  for (const r of refs) {
    if ('titanId' in r) titanIds.push(r.titanId);
    else userNumbers.push(r.userNumber);
  }
  if (titanIds.length && userNumbers.length) {
    throw new TitanAddressError(
      '同一句柄列表不能混用 titanId 与 userNumber —— ' +
        'API 只提供 handles_handleList 与 handles_userNumberList 两个独立键',
    );
  }
  if (titanIds.length) {
    titanIds.forEach((v) => assertFiniteInt(v, 'titanId'));
    return { [`${prefix}_handleList`]: titanIds.join(',') };
  }
  userNumbers.forEach((v) => assertFiniteInt(v, 'userNumber'));
  return { [`${prefix}_userNumberList`]: userNumbers.join(',') };
}

/** 泛型 `Handles.*` 场景下，userNumber 有歧义（不同类型的句柄可以重号）。 */
export function encodeAmbiguousHandleUserNumber(
  ref: { userNumber: number },
  kind: 'cue' | 'chase' | 'cuelist' | 'playback' | 'workspace',
): string {
  assertFiniteInt(ref.userNumber, 'userNumber');
  return `${kind}HandleUN=${ref.userNumber}`;
}

function assertFiniteInt(v: number, label: string): void {
  if (!Number.isFinite(v) || !Number.isInteger(v)) {
    throw new TitanAddressError(`${label} 必须是整数，收到 ${String(v)}`);
  }
}

export class TitanAddressError extends Error {
  override readonly name = 'TitanAddressError';
}
