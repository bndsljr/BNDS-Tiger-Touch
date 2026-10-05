/**
 * 已有程序的**结构体检**。
 *
 * ## 能力边界（必须如实反映在输出里）
 *
 * 本项目已确认：**无法读出 cue 内的属性数值**（见 docs/01-API调研笔记.md §0.1）。
 * 因此这里只做**结构与元数据**层面的检查：
 * 命名、编号、时间设置、备注、模型混用。
 *
 * **不做**：色温/亮度是否合理、look 是否重复、场景间跳变 —— 那些需要
 * 离线解析 show XML 或外部抓 DMX，不在这条路径上。
 *
 * ## 设计原则：宁可少报，不可误报
 *
 * 每条 finding 都必须能**指向具体位置**并**给出可执行建议**。
 * 无法从元数据可靠判定的，一律不检查（在 `limitations` 里说明），
 * 而不是给一个看起来聪明但会误导人的猜测。
 */

import type { CueInfo, PlaybackInfo, ShowInventory } from '../titan/providers/showreader.ts';

export type Severity = 'high' | 'medium' | 'low';

export interface Finding {
  id: string;
  severity: Severity;
  category: string;
  /** 一句话结论 */
  title: string;
  /** 依据（引用了哪些可读到的元数据） */
  detail: string;
  /** 可执行的下一步 */
  suggestion: string;
  /** 精确定位，便于人工核对 */
  where: string;
}

export interface AnalysisReport {
  generatedAt: number;
  summary: {
    fixtures: number;
    groups: number;
    palettes: number;
    playbacks: number;
    memories: number;
    cuelists: number;
    totalCues: number;
  };
  requestsUsed: number;
  discovery: ShowInventory['discovery'];
  discoveryNote: string;
  findings: Finding[];
  countsBySeverity: Record<Severity, number>;
  /** 本次分析**做不到**什么 —— 明确写出来，避免被误读为"已全面检查" */
  limitations: string[];
  warnings: string[];
}

/** 渐变时间超过此值即视为可疑（剧场里极少需要 30 秒以上的单次渐变）。 */
const LONG_FADE_MS = 30_000;

export function analyze(inventory: ShowInventory): AnalysisReport {
  const findings: Finding[] = [];

  const memories = inventory.playbacks.filter((p) => p.cueCount <= 1);
  const cuelists = inventory.playbacks.filter((p) => p.cueCount > 1);
  const totalCues = inventory.playbacks.reduce((a, p) => a + p.cueCount, 0);

  // ── 1. 空名称 ──────────────────────────────────────────────────────────
  for (const pb of inventory.playbacks) {
    if (needsLegend(pb.legend)) {
      findings.push({
        id: `empty-playback-legend-${pb.titanId}`,
        severity: 'medium',
        category: '命名',
        title: `回放没有名称（${describePlayback(pb)}）`,
        detail: `句柄 titanId=${pb.titanId}，落位 ${pb.group} 第 ${pb.page} 页第 ${pb.index} 个，legend 为空。`,
        suggestion: '给句柄写一个能看懂的 legend，否则演出中无法快速辨认。',
        where: `${pb.group} P${pb.page}/${pb.index}`,
      });
    }
  }
  for (const p of inventory.palettes) {
    if (needsLegend(p.legend)) {
      findings.push({
        id: `empty-palette-legend-${p.titanId}`,
        severity: 'medium',
        category: '命名',
        title: `${p.group} 调色板没有名称`,
        detail: `句柄 titanId=${p.titanId}，userNumber=${p.userNumber ?? '—'}，legend 为空。`,
        suggestion: '补一个名称，否则编光时无法检索。',
        where: `${p.group} #${p.userNumber ?? p.titanId}`,
      });
    }
  }
  for (const g of inventory.groups) {
    if (needsLegend(g.legend)) {
      findings.push({
        id: `empty-group-legend-${g.titanId}`,
        severity: 'low',
        category: '命名',
        title: '编组没有名称',
        detail: `句柄 titanId=${g.titanId}，userNumber=${g.userNumber ?? '—'}。`,
        suggestion: '补名称。',
        where: `Groups #${g.userNumber ?? g.titanId}`,
      });
    }
  }

  // ── 2. 重复名称 ────────────────────────────────────────────────────────
  findings.push(...duplicateLegends('回放', inventory.playbacks));
  findings.push(...duplicateLegends('调色板', inventory.palettes));
  findings.push(...duplicateLegends('编组', inventory.groups));

  // ── 3. cue 编号断档 ────────────────────────────────────────────────────
  for (const pb of inventory.playbacks) {
    if (pb.cueCount <= 1 || pb.cues.length === 0) continue;
    const numbers = pb.cues.map((c) => c.cueNumber).sort((a, b) => a - b);
    const first = numbers[0];
    const last = numbers[numbers.length - 1];
    if (first === undefined || last === undefined) continue;
    const expected = last - first + 1;
    const missing: number[] = [];
    const present = new Set(numbers);
    for (let n = first; n <= last; n++) if (!present.has(n)) missing.push(n);
    if (missing.length > 0 && missing.length <= 20) {
      findings.push({
        id: `cue-gap-${pb.titanId}`,
        severity: 'medium',
        category: '编号',
        title: `「${pb.legend || describePlayback(pb)}」cue 编号断档`,
        detail: `现有编号 ${numbers.join(', ')}；缺少 ${missing.join(', ')}（区间 ${first}–${last}，共缺 ${missing.length} 个）。`,
        suggestion:
          '断档本身不致命，但会让 GO/BACK 的手感与口头对数（"下一跳到 cue 3"）出现歧义。建议补齐或重排编号。',
        where: `${pb.group} P${pb.page}/${pb.index}「${pb.legend}」`,
      });
    } else if (missing.length > 20) {
      findings.push({
        id: `cue-gap-${pb.titanId}`,
        severity: 'low',
        category: '编号',
        title: `「${pb.legend || describePlayback(pb)}」cue 编号稀疏`,
        detail: `区间 ${first}–${last} 内仅 ${numbers.length} 个 cue，缺 ${missing.length} 个编号。`,
        suggestion: '确认是有意留号还是历史遗留；若为后者，考虑重排。',
        where: `${pb.group} P${pb.page}/${pb.index}「${pb.legend}」`,
      });
    }
  }

  // ── 3b. cue list 内部重复名称 ──────────────────────────────────────────
  for (const pb of inventory.playbacks) {
    if (pb.cues.length < 2) continue;
    const byLegend = new Map<string, number[]>();
    for (const cue of pb.cues) {
      const key = cue.legend.trim();
      if (key === '') continue;
      const list = byLegend.get(key) ?? [];
      list.push(cue.cueNumber);
      byLegend.set(key, list);
    }
    for (const [legend, nums] of byLegend) {
      if (nums.length < 2) continue;
      findings.push({
        id: `dup-cue-legend-${pb.titanId}-${legend}`,
        severity: 'medium',
        category: '命名',
        title: `「${pb.legend || describePlayback(pb)}」里 cue ${nums.join('、')} 同名「${legend}」`,
        detail: `同一条 cue list 内有 ${nums.length} 个 cue 叫「${legend}」。`,
        suggestion:
          '口头对数（"走到转场"）会指代不明。建议按内容区分（例如「转场-暗」「转场-亮」）。',
        where: `${pb.group} P${pb.page}/${pb.index}「${pb.legend}」`,
      });
    }
  }

  // ── 4. cue 缺名称 ──────────────────────────────────────────────────────
  for (const pb of inventory.playbacks) {
    for (const cue of pb.cues) {
      if (needsLegend(cue.legend)) {
        findings.push({
          id: `empty-cue-legend-${pb.titanId}-${cue.cueNumber}`,
          severity: 'medium',
          category: '命名',
          title: `cue ${cue.cueNumber} 没有名称`,
          detail: `回放「${pb.legend}」的 cue ${cue.cueNumber} legend 为空${cue.notes ? `（但有备注："${cue.notes}"）` : ''}。`,
          suggestion: '补 cue 名称 —— cue sheet 与演练对数都依赖它。',
          where: `${pb.group} P${pb.page}/${pb.index}「${pb.legend}」cue ${cue.cueNumber}`,
        });
      }
    }
  }

  // ── 5. 命名风格不统一 ──────────────────────────────────────────────────
  findings.push(...mixedNamingStyle(inventory));

  // ── 6. 时间设置异常 ────────────────────────────────────────────────────
  for (const pb of inventory.playbacks) {
    for (const cue of pb.cues) {
      const label = `「${pb.legend}」cue ${cue.cueNumber}`;
      const where = `${pb.group} P${pb.page}/${pb.index}「${pb.legend}」cue ${cue.cueNumber}`;

      if (cue.fadeInMs === 0 && cue.fadeOutMs === 0 && cue.delayInMs === 0) {
        findings.push({
          id: `hard-cut-${pb.titanId}-${cue.cueNumber}`,
          severity: 'low',
          category: '时间',
          title: `${label} 是硬切（渐变时间为 0）`,
          detail: 'fadeIn / fadeOut / delay 全为 0。',
          suggestion: '若是有意的硬切（如闪电、枪声）可忽略；若是忘了设时间，会显得很生硬。',
          where,
        });
      }
      const longest = Math.max(cue.fadeInMs ?? 0, cue.fadeOutMs ?? 0);
      if (longest > LONG_FADE_MS) {
        findings.push({
          id: `long-fade-${pb.titanId}-${cue.cueNumber}`,
          severity: 'medium',
          category: '时间',
          title: `${label} 渐变时间异常长（${(longest / 1000).toFixed(1)} 秒）`,
          detail: `fadeIn=${fmt(cue.fadeInMs)} fadeOut=${fmt(cue.fadeOutMs)}，超过 ${LONG_FADE_MS / 1000} 秒阈值。`,
          suggestion: '确认是有意的慢渐变；过长的时间常是误输入（例如把 3.0 打成 30）。',
          where,
        });
      }
    }
  }

  // ── 7. 多步 cue list 完全没有备注 ──────────────────────────────────────
  for (const pb of cuelists) {
    if (pb.cues.length === 0) continue;
    const withNotes = pb.cues.filter((c) => c.notes.trim() !== '').length;
    if (withNotes === 0) {
      findings.push({
        id: `cuelist-no-notes-${pb.titanId}`,
        severity: 'low',
        category: '备注',
        title: `「${pb.legend || describePlayback(pb)}」整条 cue list 都没有备注`,
        detail: `${pb.cues.length} 个 cue 全部 notes 为空。`,
        suggestion:
          '剧场演出建议至少给关键 cue 写备注（走位、演员提示、道具）。' +
          '本项目可以据此自动生成中文提示本。',
        where: `${pb.group} P${pb.page}/${pb.index}「${pb.legend}」`,
      });
    }
  }

  // ── 8. 空回放 ──────────────────────────────────────────────────────────
  for (const pb of inventory.playbacks) {
    if (pb.cueCount === 0) {
      findings.push({
        id: `empty-playback-${pb.titanId}`,
        severity: 'medium',
        category: '结构',
        title: `回放「${pb.legend || describePlayback(pb)}」是空的`,
        detail: `落位 ${pb.group} P${pb.page}/${pb.index}，不含任何 cue。`,
        suggestion: '占用了一个句柄却没有内容。闲置会让演出中误推空句柄，建议清理或填充。',
        where: `${pb.group} P${pb.page}/${pb.index}`,
      });
    }
  }

  // ── 9. 模型混用（信息性，为迁移到散 cue 做准备） ───────────────────────
  if (memories.length > 0 && cuelists.length > 0) {
    findings.push({
      id: 'mixed-model',
      severity: 'low',
      category: '结构',
      title: `show 里同时存在散 cue（${memories.length} 个）与多步 cue list（${cuelists.length} 条）`,
      detail:
        `散 cue 是单 cue 回放（本项目的主用法，人可以实时单独推）；` +
        `多步 cue list 需要按顺序 GO。两种模型的演出操作方式完全不同。`,
      suggestion:
        '确认这是有意的分工。若希望统一到"散 cue + 系统推"的模型，' +
        '可以用本项目把 cue list 拆成独立的散 cue（当前需人工确认拆分方式）。',
      where: '整个 show',
    });
  }

  // ── 汇总 ────────────────────────────────────────────────────────────────
  const countsBySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) countsBySeverity[f.severity] += 1;

  return {
    generatedAt: Date.now(),
    summary: {
      fixtures: inventory.fixtures.length,
      groups: inventory.groups.length,
      palettes: inventory.palettes.length,
      playbacks: inventory.playbacks.length,
      memories: memories.length,
      cuelists: cuelists.length,
      totalCues,
    },
    requestsUsed: inventory.requestsUsed,
    discovery: inventory.discovery,
    discoveryNote: inventory.discoveryNote,
    findings: sortFindings(findings),
    countsBySeverity,
    limitations: [
      '**读不到 cue 内的属性数值**（亮度/颜色/位置）。这是 Titan WebAPI 的硬限制，' +
        '因此本体检**不包含**"灯光内容是否合理"这类判断。',
      '不做"哪些素材没被使用"的判断 —— 回放与调色板的引用关系无法从可读元数据推导。',
      '不检查编组的成员灯具 —— 句柄列表不含编组成员信息。',
      'cue 编号只探测**整数**；Titan 允许小数编号（如 2.5），本工具暂不覆盖。',
      '时间属性的**单位（秒/毫秒）文档未说明**，本工具按启发式处理，需在真控台上实测确认。',
      '逐 cue 读元数据会**改动控台操作员的时间编辑器选中项**，请在非演出时段运行。',
    ],
    warnings: inventory.warnings,
  };
}

// ── 检查辅助 ──────────────────────────────────────────────────────────────

function needsLegend(legend: string): boolean {
  const t = legend.trim();
  if (t === '') return true;
  // Titan 的自动命名，等于没命名
  return /^(palette|group|playback|cuelist|cue|handle)\s*\d*$/i.test(t);
}

function describePlayback(pb: PlaybackInfo): string {
  return `${pb.group} P${pb.page}/${pb.index}`;
}

function duplicateLegends(
  kind: string,
  items: Array<{ titanId: number; legend: string; userNumber: number | null }>,
): Finding[] {
  const byLegend = new Map<string, Array<{ titanId: number; userNumber: number | null }>>();
  for (const it of items) {
    const key = it.legend.trim();
    if (key === '') continue; // 空名称由另一条检查负责
    const list = byLegend.get(key) ?? [];
    list.push({ titanId: it.titanId, userNumber: it.userNumber });
    byLegend.set(key, list);
  }
  const out: Finding[] = [];
  for (const [legend, list] of byLegend) {
    if (list.length < 2) continue;
    out.push({
      id: `dup-legend-${kind}-${legend}`,
      severity: 'medium',
      category: '命名',
      title: `${kind}里有 ${list.length} 个同名「${legend}」`,
      detail: `涉及 titanId ${list.map((x) => x.titanId).join(', ')}。`,
      suggestion: '重名会让演出中无法通过名字确认推的是哪一个，建议改名区分（例如加位置或用途后缀）。',
      where: `${kind}「${legend}」`,
    });
  }
  return out;
}

/** 同一类素材里中英文命名风格混用 —— 检索时会很别扭。 */
function mixedNamingStyle(inventory: ShowInventory): Finding[] {
  const out: Finding[] = [];
  const check = (
    kind: string,
    legends: string[],
  ): void => {
    const named = legends.map((l) => l.trim()).filter((l) => l !== '');
    if (named.length < 4) return;
    const cjk = named.filter((l) => /[\u4e00-\u9fff]/.test(l)).length;
    const asciiOnly = named.filter((l) => !/[\u4e00-\u9fff]/.test(l)).length;
    const minority = Math.min(cjk, asciiOnly);
    if (minority === 0) return;

    // 阈值随规模调整：
    // - 小集合（≤30 个）：单个异类也值得提醒 —— 例如 10 个中文名里混进一个「Color 9」，
    //   正是操作者想知道的情况。
    // - 大集合：需要少数派占比 ≥15% 才算"成风格"，避免几百个名字里一个特例就报警。
    const ratio = minority / named.length;
    if (!(named.length <= 30 || ratio >= 0.15)) return;
    out.push({
      id: `mixed-naming-${kind}`,
      severity: 'low',
      category: '命名',
      title: `${kind}的命名中英文混用`,
      detail: `${named.length} 个名称里，中文 ${cjk} 个、纯英文 ${asciiOnly} 个。`,
      suggestion: '统一成一种风格，检索和口头沟通都会更顺。',
      where: kind,
    });
  };

  check('调色板', inventory.palettes.map((p) => p.legend));
  check('回放', inventory.playbacks.map((p) => p.legend));
  check('编组', inventory.groups.map((g) => g.legend));
  return out;
}

function sortFindings(findings: Finding[]): Finding[] {
  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return [...findings].sort(
    (a, b) => order[a.severity] - order[b.severity] || a.category.localeCompare(b.category, 'zh'),
  );
}

function fmt(ms: number | null): string {
  return ms === null ? '—' : `${(ms / 1000).toFixed(2)}s`;
}

// ── 提示本生成（R2.3） ────────────────────────────────────────────────────

/**
 * 从读到的元数据生成中文 cue sheet / 提示本（Markdown）。
 *
 * ⚠️ 只包含**可读到的元数据**：cue 号、名称、渐变/延时、link、备注。
 * **不含**灯光内容描述 —— 那是读不到的，只能由人补。
 */
export function renderCueSheet(inventory: ShowInventory, opts: { title?: string } = {}): string {
  const lines: string[] = [];
  lines.push(`# ${opts.title ?? '演出提示本（cue sheet）'}`);
  lines.push('');
  lines.push(`> 由 BNDS 剧场灯光控制系统自动生成 · ${new Date().toLocaleString('zh-CN')}`);
  lines.push('>');
  lines.push(
    '> ⚠️ 本文件只包含**可读到的元数据**。Titan WebAPI 无法读出 cue 内的属性数值，',
  );
  lines.push('> 因此"灯光内容"一列需要人工补充。');
  lines.push('');

  const multi = inventory.playbacks.filter((p) => p.cueCount > 1);
  const single = inventory.playbacks.filter((p) => p.cueCount <= 1);

  if (multi.length > 0) {
    lines.push('## 多步 cue list');
    lines.push('');
    for (const pb of multi) {
      lines.push(`### ${pb.legend || describePlayback(pb)}`);
      lines.push('');
      lines.push(
        `落位：\`${pb.group}\` 第 ${pb.page} 页第 ${pb.index} 个 · userNumber ${
          pb.userNumber ?? '—'
        } · titanId ${pb.titanId} · 共 ${pb.cueCount} 个 cue` +
          (pb.cuesReadComplete ? '' : '（**元数据未完整读出**）'),
      );
      lines.push('');
      lines.push('| cue | 名称 | 渐入 | 渐出 | 延时 | link | 备注 |');
      lines.push('|---|---|---|---|---|---|---|');
      for (const cue of pb.cues) {
        lines.push(
          `| ${cue.cueNumber} | ${esc(cue.legend)} | ${fmt(cue.fadeInMs)} | ${fmt(cue.fadeOutMs)} | ` +
            `${fmt(cue.delayInMs)} | ${cue.link ? '是' : ''} | ${esc(cue.notes)} |`,
        );
      }
      lines.push('');
    }
  }

  if (single.length > 0) {
    lines.push('## 散 cue（单 cue 回放）');
    lines.push('');
    lines.push('| 落位 | 名称 | 渐入 | 渐出 | 备注 |');
    lines.push('|---|---|---|---|---|');
    for (const pb of single) {
      const cue: CueInfo | undefined = pb.cues[0];
      lines.push(
        `| \`${pb.group}\` P${pb.page}/${pb.index} | ${esc(pb.legend)} | ` +
          `${fmt(cue?.fadeInMs ?? null)} | ${fmt(cue?.fadeOutMs ?? null)} | ${esc(cue?.notes ?? '')} |`,
      );
    }
    lines.push('');
  }

  if (inventory.palettes.length > 0) {
    lines.push('## 素材清单');
    lines.push('');
    const byGroup = new Map<string, typeof inventory.palettes>();
    for (const p of inventory.palettes) {
      const list = byGroup.get(p.group) ?? [];
      list.push(p);
      byGroup.set(p.group, list);
    }
    for (const [group, list] of byGroup) {
      lines.push(`- **${group}**（${list.length} 个）：${list.map((p) => p.legend || '(无名)').join('、')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
