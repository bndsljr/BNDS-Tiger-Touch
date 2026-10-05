/**
 * 批量灌入器（M6 / R5）的测试。
 *
 * 重点验证三件在生产环境里最要命的事：
 * 1. **预演无副作用** —— 生成计划不能碰控台
 * 2. **失败要回滚** —— 不能留下半成品状态
 * 3. **翻页语义** —— `StoreCue` 没有 page 参数，不先翻页就会录错页
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { TitanSim } from '../src/titan-sim/server.ts';
import { ShowReader, TitanClient } from '../src/titan/index.ts';
import { executeInjection, planInjection } from '../src/engine/injector.ts';
import { emptyCueBank, makeCueId, type CueBank, type ScatteredCue } from '../src/model/cuebank.ts';
import type { InjectPlan } from '../src/engine/injector.ts';
import type { ShowInventory } from '../src/titan/providers/showreader.ts';

let sim: TitanSim;
let client: TitanClient;

before(async () => {
  sim = new TitanSim({ port: 0 });
  const { url } = await sim.listen();
  client = new TitanClient({ baseUrl: url });
});

after(async () => {
  await sim.close();
});

/** 每个用例前把模拟器恢复成初始 show（重新建一个 sim 太慢，这里直接重置状态）。 */
beforeEach(() => {
  for (const pb of [...sim.state.show.playbacks.values()]) {
    if (pb.page >= 3) sim.state.show.playbacks.delete(pb.titanId);
  }
  sim.state.setPage('Playbacks', 1);
});

function cue(name: string, page: number, index: number): ScatteredCue {
  return {
    id: makeCueId(name),
    name,
    placement: { group: 'Playbacks', page, index },
    times: { fadeInMs: 3000, fadeOutMs: 3000, delayMs: 0 },
    defaultLevel: 1,
    tags: [],
  };
}

function bankOf(cues: ScatteredCue[]): CueBank {
  return { group: 'Playbacks', pages: [{ page: 3, name: '第三页', cues }] };
}

async function inventory(): Promise<ShowInventory> {
  return new ShowReader(client).readInventory({ maxCuesPerPlayback: 1 });
}

// ─────────────────────────────────────────────────────────────────────────

describe('planInjection · 预演', () => {
  it('空位 → 生成创建动作', async () => {
    const bank = bankOf([cue('谢幕', 3, 1)]);
    const plan = planInjection(bank, await inventory());
    assert.equal(plan.summary.create, 1);
    assert.ok(plan.actions.some((a) => a.kind === 'create-playback'));
  });

  it('★ StoreCue 没有 page 参数 → 第 3 页必须先生成翻页动作', async () => {
    const bank = bankOf([cue('谢幕', 3, 1), cue('返场', 3, 2)]);
    const plan = planInjection(bank, await inventory());
    const paging = plan.actions.filter((a) => a.kind === 'set-page');
    assert.equal(paging.length, 1, '同一页只需翻一次');
    assert.match(paging[0]!.description, /第 3 页/);
    // 翻页动作必须排在创建之前
    const pageAt = plan.actions.findIndex((a) => a.kind === 'set-page');
    const createAt = plan.actions.findIndex((a) => a.kind === 'create-playback');
    assert.ok(pageAt < createAt, '翻页必须排在创建之前');
  });

  it('落位已被占用且名称一致 → 归入 upToDate', async () => {
    const bank = bankOf([cue('开场全台', 1, 1)]);
    const plan = planInjection(bank, await inventory());
    assert.equal(plan.summary.create, 0);
    assert.equal(plan.upToDate.length, 1);
    assert.equal(plan.upToDate[0]!.cueName, '开场全台');
  });

  it('落位被占用但名称不同 → 报冲突', async () => {
    const bank = bankOf([cue('我起的名', 1, 1)]);
    const plan = planInjection(bank, await inventory());
    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.conflicts[0]!.existingLegend, '开场全台');
    assert.match(plan.warnings.join('\n'), /已被占用/);
  });

  it('带 look 的 cue 会产生需 programmer 的动作并给出警告', async () => {
    const c = cue('带内容的', 3, 1);
    c.look = { fixtures: [1, 2], attributes: { dimmer: 0.8 } };
    const plan = planInjection(bankOf([c]), await inventory());
    assert.equal(plan.summary.needsProgrammer, 1);
    assert.match(plan.warnings.join('\n'), /尚未在真控台验证/);
  });

  it('★ 计划生成本身不产生任何副作用', async () => {
    const before = sim.state.show.playbacks.size;
    const logBefore = sim.state.show.events.length;
    planInjection(bankOf([cue('不该被创建', 3, 1)]), await inventory());
    assert.equal(sim.state.show.playbacks.size, before, '预演不应新建句柄');
    assert.equal(sim.state.show.events.length, logBefore, '预演不应触发任何控台动作');
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('executeInjection · 执行', () => {
  it('把散 cue 库真正生成到控台上，并核对通过', async () => {
    const bank = bankOf([cue('谢幕', 3, 1), cue('追光位', 3, 2)]);
    const plan = planInjection(bank, await inventory());
    const result = await executeInjection(client, bank, plan);

    assert.equal(result.ok, true, JSON.stringify(result.failed));
    assert.equal(result.rolledBack, false);
    assert.ok(result.transactionToken, '应开撤销事务');
    assert.deepEqual(result.verify?.missing, [], '核对不应有缺失');

    // 直接查控台侧状态确认真的建上去了
    const created = [...sim.state.show.playbacks.values()].filter((p) => p.page === 3);
    assert.equal(created.length, 2);
    assert.deepEqual(created.map((p) => p.legend).sort(), ['追光位', '谢幕'].sort());
  });

  it('dryRun 不产生副作用', async () => {
    const bank = bankOf([cue('只演练', 3, 1)]);
    const plan = planInjection(bank, await inventory());
    const result = await executeInjection(client, bank, plan, { dryRun: true });
    assert.equal(result.executed, 0);
    assert.equal(result.skipped, plan.actions.length);
    assert.equal(
      [...sim.state.show.playbacks.values()].filter((p) => p.page === 3).length,
      0,
    );
  });

  it('默认跳过冲突项的名称写入（不覆盖现场已编好的内容）', async () => {
    const bank = bankOf([cue('我起的名', 1, 1)]);
    const plan = planInjection(bank, await inventory());
    const result = await executeInjection(client, bank, plan);
    assert.equal(result.ok, true);
    assert.ok(result.skipped >= 2, `名称类动作应被跳过，实得 skipped=${result.skipped}`);
    // 控台上原名称应保持不变
    const pb = [...sim.state.show.playbacks.values()].find(
      (p) => p.page === 1 && p.index === 1,
    );
    assert.equal(pb?.legend, '开场全台');
  });

  it('开启 overwriteConflicts 后才覆盖', async () => {
    const bank = bankOf([cue('我起的名', 1, 1)]);
    const plan = planInjection(bank, await inventory());
    await executeInjection(client, bank, plan, { overwriteConflicts: true });
    const pb = [...sim.state.show.playbacks.values()].find(
      (p) => p.page === 1 && p.index === 1,
    );
    assert.equal(pb?.legend, '我起的名');
  });

  it('★ 失败时自动回滚，不留半成品', async () => {
    // 构造必然失败：cue 落在控台**不允许录制 playback** 的分组里。
    // 真实控台会拒绝，这正是 IsAllowedGroup 存在的理由。
    const badCue: ScatteredCue = {
      ...cue('非法分组', 3, 9),
      placement: { group: 'Colours', page: 1, index: 1 },
    };
    const bank: CueBank = {
      group: 'Playbacks',
      pages: [{ page: 1, name: 'x', cues: [badCue] }],
    };
    const plan: InjectPlan = {
      actions: [
        {
          id: `${badCue.id}:create`,
          kind: 'create-playback',
          description: '录到非法分组',
          cueId: badCue.id,
          where: 'Colours P1/1',
          needsProgrammer: false,
        },
      ],
      conflicts: [],
      upToDate: [],
      summary: { total: 1, create: 1, pages: 0, legends: 0, times: 0, needsProgrammer: 0 },
      warnings: [],
    };

    const result = await executeInjection(client, bank, plan);
    assert.equal(result.ok, false, '应报告失败');
    assert.equal(result.rolledBack, true, '失败应触发回滚');
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0]!.error, /not allowed to be recorded/);
  });

  it('回滚可关闭（rollbackOnFailure: false）', async () => {
    const badCue: ScatteredCue = {
      ...cue('非法分组2', 3, 9),
      placement: { group: 'Colours', page: 1, index: 2 },
    };
    const bank: CueBank = { group: 'Playbacks', pages: [{ page: 1, name: 'x', cues: [badCue] }] };
    const plan: InjectPlan = {
      actions: [
        {
          id: `${badCue.id}:create`,
          kind: 'create-playback',
          description: '录到非法分组',
          cueId: badCue.id,
          where: 'Colours P1/2',
          needsProgrammer: false,
        },
      ],
      conflicts: [],
      upToDate: [],
      summary: { total: 1, create: 1, pages: 0, legends: 0, times: 0, needsProgrammer: 0 },
      warnings: [],
    };
    const result = await executeInjection(client, bank, plan, { rollbackOnFailure: false });
    assert.equal(result.ok, false);
    assert.equal(result.rolledBack, false);
  });

  it('set-look 在未开启 withContent 时被跳过', async () => {
    const c = cue('带内容', 3, 1);
    c.look = { fixtures: [1], attributes: { dimmer: 0.5 } };
    const bank = bankOf([c]);
    const plan = planInjection(bank, await inventory());
    const result = await executeInjection(client, bank, plan); // 默认 withContent = false
    assert.ok(
      result.skipped >= 1,
      '未开启 withContent 时不应尝试设置灯光内容',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('幂等性', () => {
  it('执行两次不会重复创建（第二次识别为已占用）', async () => {
    const bank = bankOf([cue('幂等测试', 3, 5)]);
    const inv1 = await inventory();
    const plan1 = planInjection(bank, inv1);
    await executeInjection(client, bank, plan1);

    const inv2 = await new ShowReader(client).readInventory({ maxCuesPerPlayback: 1 });
    const plan2 = planInjection(bank, inv2);
    assert.equal(plan2.summary.create, 0, '第二次不应再创建');
    assert.equal(plan2.upToDate.length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('空库', () => {
  it('空 cue 库生成空计划', async () => {
    const plan = planInjection(emptyCueBank(), await inventory());
    assert.equal(plan.summary.total, 0);
    assert.equal(plan.actions.length, 0);
    assert.equal(plan.warnings.length, 0);
  });
});
