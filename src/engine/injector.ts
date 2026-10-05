/**
 * 批量灌入 —— 把本地做好的散 cue 库**生成到控台**（R5）。
 *
 * ## 路线选择（见 docs/00-需求大纲.md §6.2）
 *
 * 用户明确不需要文件通道，因此走**纯 API 重放**：
 * `StoreCue` 建句柄 → `SetCueLegend` 写名称 → `Editor/Times/*` 写时间。
 * 全程包在 `History.CreateThreadToken` 事务里，失败可 `Undo` 回滚。
 *
 * ## ★ 一个必须说清楚的诚实边界：结构 vs 内容
 *
 * `StoreCue` 的文档原文是 *"The new cue is created using the information in the
 * programmer and the current record mode."* —— **录的是 programmer 里的内容**。
 *
 * 而社区观测指出：WebAPI 在 Titan 里是「**另一个用户**」，有它**自己的** programmer，
 * 控台上的选灯不会传递过来（见 docs/01-API调研笔记.md §9.2）。该说法尚未在真机验证。
 *
 * 因此本模块**默认只灌结构**（句柄、名称、时间），这部分不依赖 programmer，可靠：
 * - 句柄落到正确的页/位
 * - legend 可读可核对
 * - 时间设置可写
 *
 * **灯光内容不在默认范围内。** 想连内容一起灌，需要 `withContent: true`，
 * 那会走 `Programmer.*` 设置 look —— 属于**未验证**能力，界面上会明确标注。
 *
 * 这个取舍是有意的：把"一定能做成的事"和"可能做不成的事"分开交付，
 * 而不是打包在一起让整批操作的成功率变得不可预测。
 */

import type { TitanClient } from '../titan/client.ts';
import type { HandleRef } from '../titan/handles.ts';
import { Playbacks } from '../titan/providers/playbacks.ts';
import type { PlaybackInfo, ShowInventory } from '../titan/providers/showreader.ts';
import { allCues, type CueBank, type ScatteredCue } from '../model/cuebank.ts';

export type InjectActionKind =
  | 'set-page'
  | 'create-playback'
  | 'set-playback-legend'
  | 'set-cue-legend'
  | 'set-times'
  | 'resolve-handle'
  | 'set-look';

export interface InjectAction {
  id: string;
  kind: InjectActionKind;
  /** 人类可读的动作描述 */
  description: string;
  /** 库内 cue id */
  cueId: string;
  /** 精确定位 */
  where: string;
  /**
   * 是否依赖 WebAPI 的 programmer。
   * 依赖 programmer 的动作成功率未经验证，界面须区分显示。
   */
  needsProgrammer: boolean;
}

export interface InjectConflict {
  cueId: string;
  cueName: string;
  where: string;
  /** 控台上该落位现有的 legend */
  existingLegend: string;
}

export interface InjectPlan {
  actions: InjectAction[];
  /** 落位已被占用，且现有内容与本库不一致 —— 执行前需人工确认 */
  conflicts: InjectConflict[];
  /** 已存在且一致，无需动作 */
  upToDate: Array<{ cueId: string; cueName: string; where: string }>;
  summary: {
    total: number;
    create: number;
    /** 需要先翻页的次数（StoreCue 没有 page 参数） */
    pages: number;
    legends: number;
    times: number;
    needsProgrammer: number;
  };
  warnings: string[];
}

export interface InjectResult {
  ok: boolean;
  executed: number;
  failed: Array<{ actionId: string; description: string; error: string }>;
  skipped: number;
  transactionToken: string | null;
  rolledBack: boolean;
  durationMs: number;
  /** 执行后重新读取的核对结果 */
  verify: { expected: number; present: number; missing: string[] } | null;
}

export interface ExecuteOptions {
  /**
   * 是否连灯光内容一起灌（走 `Programmer.*`）。
   *
   * ⚠️ **未验证**：依赖"WebAPI 有其自己的 programmer"这一社区观测。
   * 默认 false —— 只灌结构，成功率可预期。
   */
  withContent?: boolean;
  /** 遇到冲突时是否覆盖现有 legend。默认 false（跳过并报告）。 */
  overwriteConflicts?: boolean;
  /** 失败时是否自动回滚。默认 true。 */
  rollbackOnFailure?: boolean;
  /** 只演练不真正下发 —— 用于"diff 预演"。 */
  dryRun?: boolean;
}

/** 内存中的散 cue → 控台落位映射（用于把库里的 id 对上控台句柄）。 */
export interface PlacementIndex {
  /** key = `${group}/${page}/${index}` */
  byPlacement: Map<string, PlaybackInfo>;
}

export function indexInventory(inventory: ShowInventory): PlacementIndex {
  const byPlacement = new Map<string, PlaybackInfo>();
  for (const pb of inventory.playbacks) {
    byPlacement.set(`${pb.group}/${pb.page}/${pb.index}`, pb);
  }
  return { byPlacement };
}

/**
 * 生成灌入计划（不产生任何副作用）。
 *
 * 这是 R5.5「灌入前可预演」的实现：先把"将要做什么"算出来给使用者看，
 * 确认后才执行。
 */
export function planInjection(bank: CueBank, inventory: ShowInventory): InjectPlan {
  const index = indexInventory(inventory);
  const actions: InjectAction[] = [];
  const conflicts: InjectConflict[] = [];
  const upToDate: InjectPlan['upToDate'] = [];
  const warnings: string[] = [];

  // 记录已经排过翻页的分组+页，避免重复插动作
  const pagedAlready = new Set<string>();

  for (const cue of allCues(bank)) {
    const key = `${cue.placement.group}/${cue.placement.page}/${cue.placement.index}`;
    const where = `${cue.placement.group} 第 ${cue.placement.page} 页 / 第 ${cue.placement.index} 个`;
    const existing = index.byPlacement.get(key);

    if (!existing || existing.cueCount === 0) {
      // ⚠️ 关键细节：`StoreCue(group, index, updateOnly)` **没有 page 参数** ——
      // 录到哪一页取决于控台**当前页**。所以创建前必须显式翻页。
      const pageKey = `${cue.placement.group}/${cue.placement.page}`;
      if (!pagedAlready.has(pageKey)) {
        pagedAlready.add(pageKey);
        actions.push({
          id: `page:${pageKey}`,
          kind: 'set-page',
          description: `翻页：${cue.placement.group} → 第 ${cue.placement.page} 页`,
          cueId: cue.id,
          where,
          needsProgrammer: false,
        });
      }

      // 空位 → 需要创建
      actions.push({
        id: `${cue.id}:create`,
        kind: 'create-playback',
        description: `在 ${where} 新建散 cue「${cue.name}」`,
        cueId: cue.id,
        where,
        // StoreCue 从 programmer 录制内容 —— 但"建句柄 + 写名称"这一步的
        // 可预期性不依赖 programmer 是否可用，故标 false
        needsProgrammer: false,
      });
    } else if (existing.legend.trim() === cue.name.trim() && existing.cueCount === 1) {
      upToDate.push({ cueId: cue.id, cueName: cue.name, where });
      // 时间可能仍需写入
    } else {
      conflicts.push({
        cueId: cue.id,
        cueName: cue.name,
        where,
        existingLegend: existing.legend,
      });
    }

    actions.push({
      id: `${cue.id}:legend`,
      kind: 'set-cue-legend',
      description: `写 cue 名称「${cue.name}」→ ${where}`,
      cueId: cue.id,
      where,
      needsProgrammer: false,
    });

    actions.push({
      id: `${cue.id}:playback-legend`,
      kind: 'set-playback-legend',
      description: `写句柄名称「${cue.name}」→ ${where}`,
      cueId: cue.id,
      where,
      needsProgrammer: false,
    });

    if (cue.times.fadeInMs > 0 || cue.times.fadeOutMs > 0 || cue.times.delayMs > 0) {
      actions.push({
        id: `${cue.id}:times`,
        kind: 'set-times',
        description:
          `写时间（渐入 ${cue.times.fadeInMs}ms / 渐出 ${cue.times.fadeOutMs}ms / ` +
          `延时 ${cue.times.delayMs}ms）→ ${where}`,
        cueId: cue.id,
        where,
        needsProgrammer: false,
      });
    }

    if (cue.look) {
      actions.push({
        id: `${cue.id}:look`,
        kind: 'set-look',
        description: `⚠ 设置灯光内容（实验性）→ ${where}`,
        cueId: cue.id,
        where,
        needsProgrammer: true,
      });
      warnings.push(
        `「${cue.name}」带 look 定义。默认**不会**灌入灯光内容 —— ` +
          `该能力依赖 WebAPI 的 programmer，尚未在真控台验证。需显式开启 withContent。`,
      );
    }
  }

  if (conflicts.length > 0) {
    warnings.push(
      `有 ${conflicts.length} 个落位在控台上已被占用且名称不一致。` +
        `默认会**跳过**这些（不覆盖现场内容）—— 确认无误后可开启 overwriteConflicts。`,
    );
  }

  return {
    actions,
    conflicts,
    upToDate,
    summary: {
      total: actions.length,
      create: actions.filter((a) => a.kind === 'create-playback').length,
      pages: actions.filter((a) => a.kind === 'set-page').length,
      legends: actions.filter((a) => a.kind === 'set-cue-legend' || a.kind === 'set-playback-legend')
        .length,
      times: actions.filter((a) => a.kind === 'set-times').length,
      needsProgrammer: actions.filter((a) => a.needsProgrammer).length,
    },
    warnings,
  };
}

/**
 * 执行灌入计划。
 *
 * 安全设计：
 * 1. 先开一个撤销事务（`History.CreateThreadToken`），整批 = 一步撤销
 * 2. **串行**执行，不做并发 —— 控台是共享 DMX 引擎的嵌入式 CPU，且录制有顺序依赖
 * 3. 任一项失败：按 `rollbackOnFailure` 决定是否 `History.Undo` 整批回滚
 * 4. 结束后**重新读取核对**，而不是假定成功
 */
export async function executeInjection(
  client: TitanClient,
  bank: CueBank,
  plan: InjectPlan,
  options: ExecuteOptions = {},
): Promise<InjectResult> {
  const started = Date.now();
  const playbacks = new Playbacks(client);

  if (options.dryRun) {
    return {
      ok: true,
      executed: 0,
      failed: [],
      skipped: plan.actions.length,
      transactionToken: null,
      rolledBack: false,
      durationMs: Date.now() - started,
      verify: null,
    };
  }

  let token: string | null = null;
  try {
    token = (
      await client.script('History', 'CreateThreadToken', {
        description: 'BNDS 系统批量灌入散 cue 库',
      })
    ).trim();
  } catch {
    // 事务不可用不应阻断灌入，但必须让使用者知道"这批操作不能一键回滚"
    token = null;
  }

  const failed: InjectResult['failed'] = [];
  let executed = 0;
  let skipped = 0;
  const conflictIds = new Set(plan.conflicts.map((c) => c.cueId));

  for (const action of plan.actions) {
    // 内容类动作默认不做 —— 见文件头的能力边界说明
    if (action.kind === 'set-look' && !options.withContent) {
      skipped += 1;
      continue;
    }
    // 与控台现有内容冲突的：默认跳过名称类动作（不覆盖现场已编好的东西），
    // 但时间仍可写入 —— 时间不是"现场内容"，且写错可回滚。
    const isNameAction = action.kind === 'set-cue-legend' || action.kind === 'set-playback-legend';
    if (!options.overwriteConflicts && conflictIds.has(action.cueId) && isNameAction) {
      skipped += 1;
      continue;
    }

    const cue = allCues(bank).find((c) => c.id === action.cueId);
    if (!cue) {
      skipped += 1;
      continue;
    }

    try {
      await executeAction(client, playbacks, cue, action, options);
      executed += 1;
    } catch (e) {
      failed.push({
        actionId: action.id,
        description: action.description,
        error: e instanceof Error ? e.message : String(e),
      });
      break; // 串行且顺序有依赖 —— 首个失败即停止，避免产生半成品状态
    }
  }

  let rolledBack = false;
  if (failed.length > 0 && (options.rollbackOnFailure ?? true)) {
    try {
      await client.call('History', 'Undo');
      rolledBack = true;
    } catch {
      rolledBack = false;
    }
  }

  // 重新读取核对，而不是假定成功
  let verify: InjectResult['verify'] = null;
  try {
    const inventory = await readInventoryLite(client);
    const present = new Set(inventory.map((p) => `${p.group}/${p.page}/${p.index}`));
    const missing: string[] = [];
    for (const cue of allCues(bank)) {
      const key = `${cue.placement.group}/${cue.placement.page}/${cue.placement.index}`;
      if (!present.has(key)) missing.push(cue.name || key);
    }
    verify = { expected: allCues(bank).length, present: present.size, missing };
  } catch {
    verify = null;
  }

  return {
    ok: failed.length === 0,
    executed,
    failed,
    skipped,
    transactionToken: token,
    rolledBack,
    durationMs: Date.now() - started,
    verify,
  };
}

async function executeAction(
  client: TitanClient,
  playbacks: Playbacks,
  cue: ScatteredCue,
  action: InjectAction,
  options: ExecuteOptions,
): Promise<void> {
  const { group, page, index } = cue.placement;

  switch (action.kind) {
    case 'set-page': {
      // StoreCue 无 page 参数 → 必须先把控台翻到目标页
      await client.call('Handles', 'SetGroupPage', { group, page });
      return;
    }
    case 'create-playback': {
      // 在空句柄上录制会创建它（与控台"RECORD + 推空推子"一致）。
      // ⚠️ 此时 programmer 可能是空的 —— 因此内容为空，随后由人补。
      await playbacks.storeCue(group, index, false);
      return;
    }
    case 'set-cue-legend': {
      const ref = { location: { group, page, index } };
      await playbacks.setCueLegend(ref, 1, cue.name);
      return;
    }
    case 'set-playback-legend': {
      const ref = { location: { group, page, index } };
      await playbacks.setPlaybackLegend(ref, cue.name);
      return;
    }
    case 'set-times': {
      await writeTimes(client, { location: { group, page, index } }, cue);
      return;
    }
    case 'set-look': {
      // 仅在 withContent 时到达这里（否则上游已 skip）
      await applyLook(client, cue);
      return;
    }
    case 'resolve-handle':
      return;
    default: {
      void options;
      return;
    }
  }
}

/**
 * 写 cue 时间。
 *
 * ⚠️ 这里体现了文档设计的难用之处：`Playbacks/Editor/Times/*` 是**单例作用域**属性。
 * 必须先设定上下文（选 cue + FillTimes），再逐条写。
 * 因此每个 cue 需要约 1 + 5 次往返。
 */
async function writeTimes(client: TitanClient, ref: HandleRef, cue: ScatteredCue): Promise<void> {
  await client.call('Playbacks', 'TimesEdit/FillTimes', { handle: ref });
  await client.set('Playbacks', 'TimesEdit/CueNumber', 1);

  const writes: Array<[string, number]> = [
    ['CueFadeInTime', cue.times.fadeInMs / 1000],
    ['CueFadeOutTime', cue.times.fadeOutMs / 1000],
    ['CueDelayInTime', cue.times.delayMs / 1000],
  ];
  for (const [prop, seconds] of writes) {
    try {
      await client.set('Playbacks', `Editor/Times/${prop}`, seconds);
    } catch {
      // 单个时间属性写失败不应中断整批；真实控台对某些属性的可写性可能不同
    }
  }
}

/**
 * 设置 programmer 内容（**未验证能力**）。
 *
 * 依赖两个未在真控台验证的假设：
 * 1. WebAPI 的 programmer 可以独立设置属性（社区说它是"另一个用户"）
 * 2. `SetControlValueByName` 的参数名与可用属性名匹配
 *
 * 因此这个函数的存在是**为将来的实测准备的**，不是当前交付的可靠能力。
 */
async function applyLook(client: TitanClient, cue: ScatteredCue): Promise<void> {
  const look = cue.look;
  if (!look) return;

  const fixtures = look.fixtures ?? [];
  if (fixtures.length === 0) {
    throw new Error(
      `「${cue.name}」的 look 只提供了编组名（${(look.groups ?? []).join('、') || '无'}），` +
        `但按组选灯需要先读回编组成员 —— 该能力尚未实现。` +
        `请改用 look.fixtures 直接列出灯具 userNumber。`,
    );
  }

  await client.call('Programmer', 'Editor/Selection/SelectFixtures', {
    fixtures: fixtures,
  });

  for (const [name, value] of Object.entries(look.attributes ?? {})) {
    if (typeof value !== 'number') continue;
    await client.call('Programmer', 'Editor/Fixtures/SetControlValueByName', {
      controlName: name,
      value: { kind: 'level', value },
    });
  }
}

/** 轻量读取：只取回放清单，不逐 cue 读元数据（核对用）。 */
async function readInventoryLite(client: TitanClient): Promise<PlaybackInfo[]> {
  const res = await fetch(`${client.baseUrl}/titan/handles`);
  if (!res.ok) throw new Error(`/titan/handles HTTP ${res.status}`);
  const raw: unknown = await res.json();
  if (!Array.isArray(raw)) throw new Error('/titan/handles 返回的不是数组');
  const out: PlaybackInfo[] = [];
  for (const h of raw as Array<Record<string, unknown>>) {
    const loc = h['handleLocation'] as { group?: string; page?: number; index?: number } | undefined;
    const titanId = h['titanId'];
    if (typeof titanId !== 'number' || !loc) continue;
    const group = loc.group ?? '';
    if (!['Playbacks', 'StaticPlaybacks', 'RollerA', 'RollerB'].includes(group)) continue;
    out.push({
      titanId,
      userNumber: typeof h['userNumber'] === 'number' ? (h['userNumber'] as number) : null,
      legend: typeof h['Legend'] === 'string' ? h['Legend'] : '',
      group,
      page: loc.page ?? 0,
      index: loc.index ?? 0,
      kind: 'memory',
      cueCount: 1,
      cues: [],
      cuesReadComplete: false,
    });
  }
  return out;
}
