/**
 * 分析器（M7 / R2 结构体检）的测试。
 *
 * 测试用一个**刻意埋了问题**的模拟 show 作为输入 ——
 * 空 show 或完美 show 都无法验证分析器真的在工作。
 * 埋入的问题清单见 `src/titan-sim/state.ts` 的 `seedDemo` 注释。
 *
 * 同样重要的是**反向断言**：分析器必须明确声明它做不到什么，
 * 不允许让使用者误以为"已经全面检查过灯光内容"。
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { TitanSim } from '../src/titan-sim/server.ts';
import { ShowReader, TitanClient, secondsToMs } from '../src/titan/index.ts';
import { analyze, renderCueSheet } from '../src/engine/analyst.ts';
import type { AnalysisReport } from '../src/engine/analyst.ts';
import type { ShowInventory } from '../src/titan/providers/showreader.ts';

let sim: TitanSim;
let client: TitanClient;
let inventory: ShowInventory;
let report: AnalysisReport;

before(async () => {
  sim = new TitanSim({ port: 0 });
  const { url } = await sim.listen();
  client = new TitanClient({ baseUrl: url });
  inventory = await new ShowReader(client).readInventory();
  report = analyze(inventory);
});

after(async () => {
  await sim.close();
});

const titles = (): string => report.findings.map((f) => f.title).join('\n');
const has = (needle: string): boolean => titles().includes(needle);

// ─────────────────────────────────────────────────────────────────────────

describe('ShowReader · 读取现有 show', () => {
  it('通过批量句柄端点发现结构', () => {
    assert.equal(inventory.discovery, 'bulk');
    assert.match(inventory.discoveryNote, /titan\/handles/);
  });

  it('能分出灯具 / 编组 / 调色板 / 回放', () => {
    assert.equal(inventory.fixtures.length, 16);
    assert.equal(inventory.groups.length, 6);
    assert.ok(inventory.palettes.length >= 16, `调色板应被发现，实得 ${inventory.palettes.length}`);
    assert.equal(inventory.playbacks.length, 11);
  });

  it('区分散 cue（单 cue 回放）与多步回放', () => {
    const memories = inventory.playbacks.filter((p) => p.cueCount <= 1);
    const multi = inventory.playbacks.filter((p) => p.cueCount > 1);
    assert.equal(memories.length, 8);
    assert.equal(multi.length, 3);
  });

  it('逐 cue 读出元数据（cue 号 / 名称 / 时间 / 备注）', () => {
    const act1 = inventory.playbacks.find((p) => p.legend === '第一幕');
    assert.ok(act1, '应能读到「第一幕」');
    assert.equal(act1.cueCount, 5);
    assert.deepEqual(
      act1.cues.map((c) => c.cueNumber),
      [1, 2, 5, 6, 7],
      '应看到编号断档 1,2,5,6,7',
    );
    const cue6 = act1.cues.find((c) => c.cueNumber === 6);
    assert.equal(cue6?.legend, '', 'cue 6 的 legend 应为空');
    assert.equal(cue6?.notes, '这里操作员忘了写名称');
    assert.equal(cue6?.fadeInMs, 3000, '3.0 秒应被解析为 3000ms');
  });

  it('交代读取代价（HTTP 往返次数）', () => {
    assert.ok(inventory.requestsUsed > 0, '应统计实际往返次数');
    // 逐 cue 读元数据是 O(cues)，代价必须可见而非隐藏
    assert.ok(
      inventory.requestsUsed > inventory.playbacks.length,
      `往返次数应显著大于回放数，实得 ${inventory.requestsUsed}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('Analyst · 结构体检', () => {
  it('汇总 show 规模', () => {
    assert.equal(report.summary.fixtures, 16);
    assert.equal(report.summary.playbacks, 11);
    assert.equal(report.summary.memories, 8);
    assert.equal(report.summary.cuelists, 3);
    // 8 个散 cue（各含 1 个 cue）+ 多步 5 + 4 + 2
    assert.equal(report.summary.totalCues, 8 + 5 + 4 + 2);
    assert.equal(report.summary.totalCues, 19);
  });

  it('抓出 cue 编号断档', () => {
    assert.ok(has('cue 编号断档'), titles());
    const f = report.findings.find((x) => x.id.startsWith('cue-gap-'));
    assert.match(f?.detail ?? '', /缺少 3, 4/);
  });

  it('抓出重复命名（回放 / 调色板 / cue list 内部）', () => {
    assert.ok(has('同名「暖白」'), '应发现调色板重名');
    assert.ok(has('同名「转场」'), '应发现同一条 cue list 内的重名');
  });

  it('抓出空名称（回放 / 调色板 / cue）', () => {
    assert.ok(has('回放没有名称'));
    assert.ok(has('调色板没有名称'));
    assert.ok(has('cue 6 没有名称'));
  });

  it('抓出时间设置异常', () => {
    assert.ok(has('渐变时间异常长'), '60 秒渐变应被标出');
    assert.ok(has('是硬切'), '全 0 硬切应被标出');
  });

  it('抓出整条 cue list 缺备注', () => {
    assert.ok(has('整条 cue list 都没有备注'));
  });

  it('抓出命名风格混用', () => {
    assert.ok(has('命名中英文混用'), titles());
  });

  it('指出散 cue 与多步 cue list 混用', () => {
    const f = report.findings.find((x) => x.id === 'mixed-model');
    assert.ok(f, '应报告模型混用');
    assert.match(f.detail, /散 cue/);
  });

  it('不做无法可靠判定的检查（宁可少报，不可误报）', () => {
    // 引用关系读不到 → 不应报"未使用的素材"（否则是猜测）
    assert.ok(!has('未使用'), '不应凭空判断素材未被使用');
    // 读不到属性数值 → 不应报任何内容层问题
    assert.ok(!has('颜色'), '不应判断颜色正确性');
    assert.ok(!has('亮度'), '不应判断亮度正确性');
  });

  it('按严重度排序并统计', () => {
    const sevs = report.findings.map((f) => f.severity);
    const order = { high: 0, medium: 1, low: 2 };
    for (let i = 1; i < sevs.length; i++) {
      assert.ok(
        order[sevs[i - 1]!] <= order[sevs[i]!],
        `应严重度升序排列：${sevs.join(',')}`,
      );
    }
    const total =
      report.countsBySeverity.high +
      report.countsBySeverity.medium +
      report.countsBySeverity.low;
    assert.equal(total, report.findings.length);
  });

  it('每条问题都能定位到具体位置并给出建议', () => {
    for (const f of report.findings) {
      assert.ok(f.where.trim() !== '', `${f.id} 缺少 where`);
      assert.ok(f.suggestion.trim() !== '', `${f.id} 缺少 suggestion`);
      assert.ok(f.detail.trim() !== '', `${f.id} 缺少 detail`);
    }
  });

  it('★ 明确声明能力边界（避免被误读为已全面检查）', () => {
    assert.ok(report.limitations.length >= 5, '应列出做不到的事项');
    const joined = report.limitations.join('\n');
    assert.match(joined, /读不到 cue 内的属性数值/);
    assert.match(joined, /单位（秒\/毫秒）|单位.*未说明/);
    assert.match(joined, /改动控台操作员的|时间编辑器/);
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('时间单位启发式', () => {
  it('小数值视为秒', () => {
    assert.equal(secondsToMs('3.0'), 3000);
    assert.equal(secondsToMs('1.5'), 1500);
    assert.equal(secondsToMs('0.25'), 250);
  });

  it('≥1000 的整数视为毫秒（避免把 1.5 秒误判成 1.5ms）', () => {
    assert.equal(secondsToMs('3000'), 3000);
  });

  it('0 与空值', () => {
    assert.equal(secondsToMs('0'), 0);
    assert.equal(secondsToMs(''), null);
    assert.equal(secondsToMs('abc'), null);
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('提示本生成', () => {
  it('生成 Markdown 且含元数据表', () => {
    const md = renderCueSheet(inventory, { title: '测试提示本' });
    assert.match(md, /^# 测试提示本/);
    assert.match(md, /## 多步 cue list/);
    assert.match(md, /## 散 cue（单 cue 回放）/);
    assert.match(md, /\| cue \| 名称 \| 渐入 \|/);
    assert.match(md, /起幕/);
  });

  it('★ 在文件开头声明内容缺失（不假装有灯光描述）', () => {
    const md = renderCueSheet(inventory);
    const head = md.split('\n').slice(0, 8).join('\n');
    assert.match(head, /无法读出 cue 内的属性数值/);
  });

  it('素材清单按类型分组', () => {
    const md = renderCueSheet(inventory);
    assert.match(md, /\*\*Colours\*\*/);
    assert.match(md, /\*\*Positions\*\*/);
  });
});
