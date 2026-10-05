/**
 * Titan 控台模拟器的状态模型。
 *
 * 这是本项目的**开发基础设施**，不是玩具：
 * - 本机是 macOS，Avolites 官方 Simulator 仅 Windows 且需付费 AvoKey，
 *   并会输出随机 DMX 干扰 → **本机无法使用官方方案**（见调研笔记 §9.3）。
 * - 它同时承担：日常开发环境、CI 基础、以及**演示给他人看**的载体。
 *
 * 因此它必须**忠实复现已核实的真实行为**，包括那些反直觉之处：
 * - `void` 方法返回**空 body**，不是 JSON
 * - 错误返回**纯文本** `Error: ...`（且真实控台会跟随 UI 语言 → 本模拟器提供中英开关）
 * - `handle=` 缺省被当作 **userNumber**，遇 location 抛 `AcwUserNumber` 解析错误
 * - 小写 `leveldelta` **抛类型转换错误**（复现真实控台行为，用于验证客户端的修正）
 * - 无任何推送通道
 */

import { HANDLE_GROUPS } from '../titan/handles.ts';

let nextTitanId = 1000;
/** 回放用户编号的连续计数器（真实控台上用户编号是小编号且连续）。 */
let playbackUserNumberSeq = 0;

export interface SimFixture {
  titanId: number;
  userNumber: number;
  name: string;
  manufacturer: string;
  mode: string;
  universe: number;
  address: number;
}

export interface SimCue {
  cueId: number;
  cueNumber: number;
  legend: string;
  fadeInMs: number;
  fadeOutMs: number;
  delayMs: number;
  delayOutMs: number;
  /** 链接到下一个 cue（Titan 的 cue link） */
  link: boolean;
  linkOffsetMs: number;
  moveInDark: boolean;
  /** 对应 AcwTrackingType */
  tracking: string;
  notes: string;
  /** 该 cue 记录的属性值。
   * ⚠️ 真实 API **读不出这些数值**（已确认硬约束），
   * 这里保留仅供模拟器内部一致性，分析器不应当依赖它们。 */
  values: Record<string, number>;
}

export type SimPlaybackKind = 'memory' | 'cuelist' | 'chase';

export interface SimPlayback {
  titanId: number;
  userNumber: number;
  group: string;
  page: number;
  index: number;
  legend: string;
  /** memory = 散 cue（单 cue）；cuelist/chase = 多步 */
  kind: SimPlaybackKind;
  cues: SimCue[];
  /** 当前输出电平 0…1；-1 表示未激活 */
  level: number;
  /** 是否处于激活状态（被推起） */
  active: boolean;
  /** 是否被 pause */
  paused: boolean;
  fadeOutMs: number;
  fixtureOverlap: number;
  releaseTimeMs: number;
  /** 该 playback 是否被某处引用（供"未使用素材"检查） */
  referencedBy: string[];
}

export interface SimPalette {
  titanId: number;
  userNumber: number;
  group: string;
  page: number;
  index: number;
  legend: string;
  kind: string;
  values: Record<string, number>;
}

export interface SimGroup {
  titanId: number;
  userNumber: number;
  legend: string;
  fixtures: number[];
}

export interface SimProgrammer {
  selectedFixtures: number[];
  values: Record<string, number>;
  blind: boolean;
  blindActive: boolean;
}

export interface SimShow {
  showName: string;
  loadState: string;
  fixtures: Map<number, SimFixture>;
  groups: Map<number, SimGroup>;
  palettes: Map<number, SimPalette>;
  playbacks: Map<number, SimPlayback>;
  programmer: SimProgrammer;
  /** 记录所有已发生的事件，供 UI 与测试断言 */
  events: SimEvent[];
}

export interface SimEvent {
  at: number;
  kind: string;
  detail: string;
}

export interface SimOptions {
  version?: string;
  showName?: string;
  /** 错误信息语言：真实控台跟随 UI 语言，故这里可配。 */
  errorLanguage?: 'zh' | 'en';
  /** 预置一些散 cue，便于开箱即可演示。 */
  seedDemoContent?: boolean;
}

export function createSimShow(options: SimOptions = {}): SimShow {
  const show: SimShow = {
    showName: options.showName ?? 'Sim Demo Show',
    loadState: 'Loaded',
    fixtures: new Map(),
    groups: new Map(),
    palettes: new Map(),
    playbacks: new Map(),
    programmer: { selectedFixtures: [], values: {}, blind: false, blindActive: false },
    events: [],
  };
  if (options.seedDemoContent !== false) seedDemo(show);
  return show;
}

/**
 * 预置一套**贴近真实学校剧场**的 show。
 *
 * 刻意埋入常见问题，理由：分析器（M7）的价值在于"发现问题"，
 * 而空 show 或完美 show 都无法验证它真的在工作。
 * 埋入的问题清单见文件末尾 `SEEDED_ISSUES` 注释。
 */
function seedDemo(show: SimShow): void {
  // ── 16 台灯具：摇头灯 + 染色灯 + 天幕排灯 ──────────────────────────────
  const fixtureDefs: Array<[string, string, string, number]> = [
    ['Robe', 'LEDBeam 150', 'Mode 1', 8],
    ['Chauvet', 'Rogue R2 Wash', 'Mode 1', 6],
    ['Generic', 'LED Strip', 'RGB', 2],
  ];
  let addr = 1;
  let userNumber = 1;
  for (const [manufacturer, name, mode, count] of fixtureDefs) {
    for (let i = 0; i < count; i++) {
      const id = nextTitanId++;
      show.fixtures.set(id, {
        titanId: id,
        userNumber: userNumber++,
        name: `${name} ${i + 1}`,
        manufacturer,
        mode,
        universe: 1,
        address: addr,
      });
      addr += 16;
    }
  }
  const fx = [...show.fixtures.keys()];
  const beams = fx.slice(0, 8);
  const washes = fx.slice(8, 14);
  const strips = fx.slice(14);

  const group = (legend: string, fixtures: number[]): void => {
    const id = nextTitanId++;
    show.groups.set(id, { titanId: id, userNumber: show.groups.size + 1, legend, fixtures });
  };
  group('侧光左', beams.slice(0, 4));
  group('侧光右', beams.slice(4));
  group('面光', washes.slice(0, 4));
  group('天幕', strips);
  group('逆光', washes.slice(4));
  // 埋入问题：无人使用的编组
  group('临时-测试用', []);

  // ── 调色板：颜色 / 位置 ────────────────────────────────────────────────
  const colours = ['暖白', '冷白', '深蓝', '天蓝', '琥珀', '品红', '翠绿', '大红'];
  colours.forEach((legend) => {
    const id = nextTitanId++;
    show.palettes.set(id, {
      titanId: id,
      userNumber: show.palettes.size + 1,
      group: HANDLE_GROUPS.Colours,
      page: 1,
      index: show.palettes.size + 1,
      legend,
      kind: 'colour',
      values: {},
    });
  });
  // 埋入问题：重复名称（与上面的"暖白"重名）
  {
    const id = nextTitanId++;
    show.palettes.set(id, {
      titanId: id,
      userNumber: show.palettes.size + 1,
      group: HANDLE_GROUPS.Colours,
      page: 1,
      index: show.palettes.size + 1,
      legend: '暖白',
      kind: 'colour',
      values: {},
    });
  }
  // 埋入问题：leagend 为空（操作者忘了命名）
  {
    const id = nextTitanId++;
    show.palettes.set(id, {
      titanId: id,
      userNumber: show.palettes.size + 1,
      group: HANDLE_GROUPS.Colours,
      page: 1,
      index: show.palettes.size + 1,
      legend: '',
      kind: 'colour',
      values: {},
    });
  }
  // 埋入问题：命名风格不统一（中英混用）
  {
    const id = nextTitanId++;
    show.palettes.set(id, {
      titanId: id,
      userNumber: show.palettes.size + 1,
      group: HANDLE_GROUPS.Colours,
      page: 1,
      index: show.palettes.size + 1,
      legend: 'Color 9',
      kind: 'colour',
      values: {},
    });
  }

  const positions = ['左前', '右前', '中间', '台口', '后区'];
  positions.forEach((legend) => {
    const id = nextTitanId++;
    show.palettes.set(id, {
      titanId: id,
      userNumber: show.palettes.size + 1,
      group: HANDLE_GROUPS.Positions,
      page: 1,
      index: show.palettes.size + 1,
      legend,
      kind: 'position',
      values: {},
    });
  });

  // ── 回放：混合「散 cue」（memory）与旧的多步 cue list ──────────────────
  const mkCue = (
    cueNumber: number,
    legend: string,
    opts: Partial<SimCue> = {},
  ): SimCue => ({
    cueId: nextTitanId++,
    cueNumber,
    legend,
    fadeInMs: 3000,
    fadeOutMs: 3000,
    delayMs: 0,
    delayOutMs: 0,
    link: false,
    linkOffsetMs: 0,
    moveInDark: false,
    tracking: 'Global',
    notes: '',
    values: {},
    ...opts,
  });

  const mkPlayback = (
    page: number,
    index: number,
    legend: string,
    kind: SimPlaybackKind,
    cues: SimCue[],
    opts: Partial<SimPlayback> = {},
  ): void => {
    const pb = makeSimPlayback({ group: HANDLE_GROUPS.Playbacks, page, index }, legend, {
      kind,
      cues,
      ...opts,
    });
    show.playbacks.set(pb.titanId, pb);
  };

  // 第 1 页：散的 cue（本项目的主用法）
  mkPlayback(1, 1, '开场全台', 'memory', [mkCue(1, '开场全台')]);
  mkPlayback(1, 2, '独白面光', 'memory', [mkCue(1, '独白面光')]);
  mkPlayback(1, 3, '转场暗场', 'memory', [mkCue(1, '转场暗场')]);
  mkPlayback(1, 4, '天幕蓝', 'memory', [mkCue(1, '天幕蓝')]);
  // 埋入问题：渐变时间为 0（硬切，剧场里通常是失误）
  mkPlayback(1, 5, '硬切-黑场', 'memory', [
    mkCue(1, '硬切-黑场', { fadeInMs: 0, fadeOutMs: 0 }),
  ]);
  // 埋入问题：渐变时间异常长（60 秒）
  mkPlayback(1, 6, '慢慢亮起来', 'memory', [
    mkCue(1, '慢慢亮起来', { fadeInMs: 60_000, fadeOutMs: 60_000 }),
  ]);

  // 第 2 页：旧的多步 cue list（学校控台上真实存在的东西）
  mkPlayback(
    2,
    1,
    '第一幕',
    'cuelist',
    [
      mkCue(1, '起幕'),
      mkCue(2, '演员上场'),
      // 埋入问题：cue 编号断档（缺 3）
      mkCue(5, '独白'),
      mkCue(6, '', { notes: '这里操作员忘了写名称' }),
      mkCue(7, '转场'),
    ],
    { referencedBy: ['SetList 第一幕'] },
  );

  // 埋入问题：cue list 里重复的 legend
  mkPlayback(
    2,
    2,
    '第二幕',
    'cuelist',
    [mkCue(1, '起幕'), mkCue(2, '转场'), mkCue(3, '转场'), mkCue(4, '谢幕')],
    { referencedBy: ['SetList 第二幕'] },
  );

  // 埋入问题：整条 cue list 都没有备注（剧场提示本该有备注）
  mkPlayback(2, 3, '第三幕', 'cuelist', [
    mkCue(1, 'A', { fadeInMs: 1500 }),
    mkCue(2, 'B', { fadeInMs: 1500 }),
  ]);

  // 埋入问题：完全未被任何地方引用（孤儿回放）
  mkPlayback(2, 4, '去年晚会用', 'cuelist', [mkCue(1, '旧的开场')]);

  // 埋入问题：legend 为空
  mkPlayback(2, 5, '', 'memory', [mkCue(1, '')]);
}

/** 上面 seedDemo 刻意埋入的问题（供测试与人工核对）：
 *  1. 编组「临时-测试用」无人使用
 *  2. 颜色调色板「暖白」重复命名
 *  3. 一个颜色调色板 legend 为空
 *  4. 命名风格不统一（"Color 9" 与中文混用）
 *  5. 「硬切-黑场」渐变时间为 0
 *  6. 「慢慢亮起来」渐变时间 60 秒
 *  7. 「第一幕」cue 编号断档（1,2,5,6,7）
 *  8. 「独白」之后一个 cue 没有名称
 *  9. 「第二幕」内有重复 legend「转场」
 * 10. 「第三幕」整条都没有备注
 * 11. 「去年晚会用」是孤儿回放，未被引用
 * 12. 第 2 页第 5 个回放 legend 为空
 */

/** 构造一个 cue，未指定的字段取剧场常见默认值。 */
export function makeSimCue(cueNumber: number, legend: string, over: Partial<SimCue> = {}): SimCue {
  return {
    cueId: over.cueId ?? nextTitanId++,
    cueNumber,
    legend,
    fadeInMs: 3000,
    fadeOutMs: 3000,
    delayMs: 0,
    delayOutMs: 0,
    link: false,
    linkOffsetMs: 0,
    moveInDark: false,
    tracking: 'Global',
    notes: '',
    values: {},
    ...over,
  };
}

/** 构造一个 playback。 */
export function makeSimPlayback(
  placement: { group: string; page: number; index: number },
  legend: string,
  over: Partial<SimPlayback> = {},
): SimPlayback {
  const titanId = over.titanId ?? nextTitanId++;
  return {
    titanId,
    // 默认按创建顺序连续编号 —— 贴合真实控台上"用户编号是小编号"的观感
    userNumber: over.userNumber ?? ++playbackUserNumberSeq,
    group: placement.group,
    page: placement.page,
    index: placement.index,
    legend,
    kind: 'memory',
    cues: [],
    level: -1,
    active: false,
    paused: false,
    fadeOutMs: 3000,
    fixtureOverlap: 100,
    releaseTimeMs: 0,
    referencedBy: [],
    ...over,
  };
}

/**
 * 时间编辑器上下文。
 *
 * ⚠️ 忠实复现真实 API 的一个**难用之处**：
 * `Playbacks/Editor/Times/*` 是一组**单例作用域**的菜单属性，
 * 读的是"当前上下文 cue"。要导出一条完整 cue list，
 * 必须循环：设 `TimesEdit/CueNumber` → `FillTimes` → 读属性。
 * 这是 O(cues) 次 HTTP 往返，且**会改动控台操作员的 UI 状态**。
 */
export interface TimesEditContext {
  playbackTitanId: number | null;
  cueNumber: number | null;
}

export class SimState {
  readonly show: SimShow;
  readonly version: string;
  readonly errorLanguage: 'zh' | 'en';
  /** 时间编辑器上下文 —— 见 TimesEditContext 的说明 */
  readonly timesEdit: TimesEditContext = { playbackTitanId: null, cueNumber: null };

  /**
   * 各分组的**当前页**。
   *
   * ⚠️ 这是复现一个真实 API 细节：`Playbacks.StoreCue(group, index, updateOnly)`
   * **没有 page 参数** —— 录到哪一页取决于控台当前页。
   * 因此要录到指定页，必须**先翻页**（`Handles.SetGroupPage` / `Handles.ChangeRollerPage`）。
   */
  readonly currentPage = new Map<string, number>();

  constructor(options: SimOptions = {}) {
    this.show = createSimShow(options);
    this.version = options.version ?? '16.0';
    this.errorLanguage = options.errorLanguage ?? 'en';
  }

  /** 当前时间编辑器指向的 cue（`Playbacks/Editor/Times/*` 读取的就是它）。 */
  contextCue(): { playback: SimPlayback; cue: SimCue } | null {
    const { playbackTitanId, cueNumber } = this.timesEdit;
    if (playbackTitanId === null || cueNumber === null) return null;
    const pb = this.show.playbacks.get(playbackTitanId);
    if (!pb) return null;
    const cue = pb.cues.find((c) => c.cueNumber === cueNumber);
    if (!cue) return null;
    return { playback: pb, cue };
  }

  log(kind: string, detail: string): void {
    this.show.events.push({ at: Date.now(), kind, detail });
    if (this.show.events.length > 2000) this.show.events.splice(0, 1000);
  }

  // ── 句柄查找 ────────────────────────────────────────────────────────────

  findPlaybackByTitanId(id: number): SimPlayback | undefined {
    return this.show.playbacks.get(id);
  }

  findPlaybackByUserNumber(n: number, group?: string): SimPlayback | undefined {
    for (const p of this.show.playbacks.values()) {
      if (p.userNumber === n && (!group || p.group === group)) return p;
    }
    return undefined;
  }

  pageOf(group: string): number {
    return this.currentPage.get(group) ?? 1;
  }

  setPage(group: string, page: number): void {
    this.currentPage.set(group, page);
  }

  findPlaybackByLocation(group: string, page: number, index: number): SimPlayback | undefined {
    for (const p of this.show.playbacks.values()) {
      if (p.group === group && p.page === page && p.index === index) return p;
    }
    return undefined;
  }

  /** 回读句柄的分组名 —— 对应真实 API 的 `Handles.GetGroup`。 */
  groupOfHandle(titanId: number): string {
    if (this.show.playbacks.has(titanId)) return this.show.playbacks.get(titanId)!.group;
    if (this.show.palettes.has(titanId)) return this.show.palettes.get(titanId)!.group;
    if (this.show.fixtures.has(titanId)) return HANDLE_GROUPS.Fixtures;
    if (this.show.groups.has(titanId)) return HANDLE_GROUPS.Groups;
    return 'Null';
  }

  allHandles(): Array<{
    handleLocation: { group: string; index: number; page: number };
    titanId: number;
    type: string;
    Active: boolean;
    Legend: string;
    userNumber: number;
    properties: Array<{ Key: string; Value: string }>;
  }> {
    const out: ReturnType<SimState['allHandles']> = [];
    for (const p of this.show.playbacks.values()) {
      out.push({
        handleLocation: { group: p.group, index: p.index, page: p.page },
        titanId: p.titanId,
        type: 'playbackHandle',
        Active: p.active,
        Legend: p.legend,
        userNumber: p.userNumber,
        properties: [{ Key: 'lockState', Value: 'Unlocked' }],
      });
    }
    for (const f of this.show.fixtures.values()) {
      out.push({
        handleLocation: { group: HANDLE_GROUPS.Fixtures, index: f.userNumber - 1, page: 0 },
        titanId: f.titanId,
        type: 'fixtureHandle',
        Active: false,
        Legend: f.name,
        userNumber: f.userNumber,
        properties: [],
      });
    }
    for (const g of this.show.groups.values()) {
      out.push({
        handleLocation: { group: HANDLE_GROUPS.Groups, index: g.userNumber - 1, page: 0 },
        titanId: g.titanId,
        type: 'groupHandle',
        Active: false,
        Legend: g.legend,
        userNumber: g.userNumber,
        properties: [],
      });
    }
    for (const p of this.show.palettes.values()) {
      out.push({
        handleLocation: { group: p.group, index: p.index, page: p.page },
        titanId: p.titanId,
        type: 'paletteHandle',
        Active: false,
        Legend: p.legend,
        userNumber: p.userNumber,
        properties: [{ Key: 'lockState', Value: 'Unlocked' }],
      });
    }
    return out;
  }
}
