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
  /** 该 cue 记录的属性值（模拟器内部用，真实 API 读不出来） */
  values: Record<string, number>;
}

export interface SimPlayback {
  titanId: number;
  userNumber: number;
  group: string;
  page: number;
  index: number;
  legend: string;
  /** 单 cue playback = 散 cue（Memory）；多 cue = cue list */
  cues: SimCue[];
  /** 当前输出电平 0…1；-1 表示未激活 */
  level: number;
  /** 是否处于激活状态（被推起） */
  active: boolean;
  /** 是否被 pause */
  paused: boolean;
  fadeOutMs: number;
  fixtureOverlap: number;
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

function seedDemo(show: SimShow): void {
  // 8 台摇头灯
  const manufacturers = ['Robe', 'Robe', 'Chauvet', 'Martin'];
  for (let i = 1; i <= 8; i++) {
    const id = nextTitanId++;
    show.fixtures.set(id, {
      titanId: id,
      userNumber: i,
      name: `LEDBeam-${i}`,
      manufacturer: manufacturers[i % manufacturers.length] ?? 'Robe',
      mode: 'Mode 1',
      universe: 1,
      address: 1 + (i - 1) * 16,
    });
  }

  const fixtureIds = [...show.fixtures.keys()];

  const gid = nextTitanId++;
  show.groups.set(gid, { titanId: gid, userNumber: 1, legend: '左侧光', fixtures: fixtureIds.slice(0, 4) });
  const gid2 = nextTitanId++;
  show.groups.set(gid2, { titanId: gid2, userNumber: 2, legend: '右侧光', fixtures: fixtureIds.slice(4) });

  // 一页散 cue（Tiger Touch 的 StaticPlaybacks 更像真实用法，但先放 Playbacks 便于对照）
  const demoCues = [
    { legend: '开场全台', level: 1, dimmer: 80 },
    { legend: '独白面光', level: 1, dimmer: 100 },
    { legend: '转场暗场', level: 1, dimmer: 0 },
    { legend: '天幕蓝', level: 1, dimmer: 60 },
  ];
  demoCues.forEach((c, i) => {
    const id = nextTitanId++;
    show.playbacks.set(id, {
      titanId: id,
      userNumber: i + 1,
      group: HANDLE_GROUPS.Playbacks,
      page: 1,
      index: i + 1,
      legend: c.legend,
      cues: [
        {
          cueId: nextTitanId++,
          cueNumber: 1,
          legend: c.legend,
          fadeInMs: 3000,
          fadeOutMs: 3000,
          delayMs: 0,
          values: Object.fromEntries(fixtureIds.map((f) => [`${f}.dimmer`, c.dimmer])),
        },
      ],
      level: -1,
      active: false,
      paused: false,
      fadeOutMs: 3000,
      fixtureOverlap: 100,
    });
  });
}

export class SimState {
  readonly show: SimShow;
  readonly version: string;
  readonly errorLanguage: 'zh' | 'en';

  constructor(options: SimOptions = {}) {
    this.show = createSimShow(options);
    this.version = options.version ?? '16.0';
    this.errorLanguage = options.errorLanguage ?? 'en';
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
    return out;
  }
}
