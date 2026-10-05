/**
 * 连接诊断 —— 连上控台后一次性落实所有"文档没说、只能实测"的事项。
 *
 * ## 设计约束：所有探测必须**无副作用**
 *
 * 这是硬要求 —— 诊断会在演出前、甚至演出中运行，绝不能改动 show 或输出。
 * 因此：
 * - 只读属性探测（版本、show 名、加载状态、时码源）
 * - 写类探测一律**指向不存在的句柄**，让控台在参数绑定/句柄解析阶段就报错，
 *   从而"只暴露语法是否被接受"，不产生任何实际改动
 *
 * ## 最有价值的一项：实测 `levelDelta` 拼写
 *
 * 官方 16.0 语料**只发小写 d** 的 `leveldelta`（41 次），大写 `levelDelta` 零命中；
 * 但社区在真机上实测**小写 d 会抛 LevelAdjust 类型转换错误**。
 * 我方独立佐证（所有其他变体后缀都是 camelCase）支持"大写 D 才对"，
 * 但这是推理，不是实测。
 *
 * 本模块用一条**无害请求**把它问清楚：
 * 对不存在的句柄发 `level_levelDelta=0.001` ——
 * - 若报"找不到句柄" → 说明**大写 D 被接受**（语法过了，才轮到解析句柄）
 * - 若报 LevelAdjust 类型转换错误 → 说明大写 D 不被接受
 * 同理再试小写。两边一对比，答案就确定了，且全程没有任何副作用。
 */

import type { TitanClient } from './client.ts';
import type { RawHandle } from './providers/showreader.ts';
import { Handles } from './providers/handles.ts';

export interface DiagnosticCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  /** 人话结论 */
  detail: string;
  /** 原始观测值（便于人工核对） */
  raw?: string;
}

export interface DiagnosticReport {
  ranAt: number;
  baseUrl: string;
  checks: DiagnosticCheck[];
  /** 从批量句柄端点观察到的分组名（若该端点可用） */
  observedGroups: string[];
  /** 实测结论：哪种 levelDelta 拼写被控台接受 */
  levelDeltaSpelling: 'camel' | 'lower' | 'unknown';
  counts: { ok: number; warn: number; fail: number; skip: number };
}

/** 一个几乎不可能存在的 titanId —— 用于"无副作用地"探测参数语法。 */
const PROBE_TITAN_ID = 2_147_483_646;

export async function diagnose(client: TitanClient): Promise<DiagnosticReport> {
  const checks: DiagnosticCheck[] = [];
  const add = (c: DiagnosticCheck): void => void checks.push(c);

  // ── 1. 版本 ─────────────────────────────────────────────────────────────
  let version = '';
  try {
    version = await client.softwareVersion();
    const major = Number.parseInt(version, 10);
    if (major === 16) {
      add({
        name: 'Titan 版本',
        status: 'ok',
        detail: `Titan ${version} —— 与本项目依据的 16.0 API 面一致。`,
        raw: version,
      });
    } else if (Number.isFinite(major)) {
      add({
        name: 'Titan 版本',
        status: 'fail',
        detail:
          `控台是 Titan ${version}，而本项目按 16.x 编写。` +
          `厂方文档明确：v16 无法安装在原版 Tiger Touch / Tiger Touch Pro / ` +
          `Tiger Touch II（序列 02001–03065）上，这些机型最高只到 V15.1，` +
          `两版 API 有约 187 页差异。需要改用 15.x 的方法面。`,
        raw: version,
      });
    } else {
      add({ name: 'Titan 版本', status: 'warn', detail: `无法解析版本字符串「${version}」。`, raw: version });
    }
  } catch (e) {
    add({
      name: 'Titan 版本',
      status: 'fail',
      detail: `读取失败：${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // ── 2. Show 状态 ────────────────────────────────────────────────────────
  try {
    const [showName, loadState] = await Promise.all([
      client.get('Show', 'ShowName').catch(() => ''),
      client.get('Show', 'LoadState').catch(() => ''),
    ]);
    add({
      name: 'Show 状态',
      status: showName ? 'ok' : 'warn',
      detail: showName
        ? `当前 show「${showName}」，加载状态：${loadState || '未知'}。`
        : `控台未报告 show 名（加载状态：${loadState || '未知'}）。灌入前请确认已加载正确的 show。`,
      raw: `${showName} / ${loadState}`,
    });
  } catch (e) {
    add({
      name: 'Show 状态',
      status: 'warn',
      detail: `读取失败：${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // ── 3. 批量句柄端点（分组名发现的关键） ─────────────────────────────────
  const handles = new Handles(client);
  const observedGroups: string[] = [];
  try {
    const probe = await handles.probeBulkEndpoint();
    if (probe.available) {
      const raw = (await handles.fetchAll()) as RawHandle[];
      const set = new Set<string>();
      for (const h of raw) {
        const g = h.handleLocation?.group;
        if (g) set.add(g);
      }
      observedGroups.push(...[...set].sort());
      add({
        name: '批量句柄端点 /titan/handles',
        status: 'ok',
        detail:
          `可用，返回 ${raw.length} 个句柄，观察到 ${observedGroups.length} 个分组：` +
          `${observedGroups.join('、')}。` +
          `（该端点在 16.0 参考文档中零命中，仅见于过时 Introduction 页 —— ` +
          `现在确认它确实存在。）`,
        raw: JSON.stringify({ handles: raw.length, groups: observedGroups }),
      });
      // 顺带看看句柄对象里有没有序列号之类的设备信息
      const anyId = raw.find((h) => typeof h.titanId === 'number');
      if (anyId) {
        add({
          name: '句柄对象结构',
          status: 'ok',
          detail: `示例字段：${Object.keys(anyId).join('、')}。`,
          raw: JSON.stringify(anyId).slice(0, 400),
        });
      }
    } else {
      add({
        name: '批量句柄端点 /titan/handles',
        status: 'warn',
        detail:
          `不可用（${probe.error ?? '未知原因'}）。` +
          `影响：无法一次性枚举句柄来发现合法分组名，也无法做"读取现有 show"的结构体检。` +
          `需退化为按落位逐个探测。`,
      });
    }
  } catch (e) {
    add({
      name: '批量句柄端点 /titan/handles',
      status: 'warn',
      detail: `探测失败：${e instanceof Error ? e.message : String(e)}`,
    });
  }

  // ── 4. ★ 实测 levelDelta 拼写（无副作用） ──────────────────────────────
  const camel = await probeDeltaSpelling(client, 'camel');
  const lower = camel.accepted ? null : await probeDeltaSpelling(client, 'lower');

  let spelling: DiagnosticReport['levelDeltaSpelling'] = 'unknown';
  if (camel.accepted && lower && !lower.accepted) spelling = 'camel';
  else if (!camel.accepted && lower?.accepted) spelling = 'lower';
  else if (camel.accepted && lower === null) spelling = 'camel';
  else if (camel.accepted && lower?.accepted) spelling = 'camel'; // 两者都行，用文档一致的默认

  add({
    name: 'levelDelta 拼写（大小写地雷）',
    status: spelling === 'unknown' ? 'warn' : 'ok',
    detail:
      spelling === 'camel'
        ? `实测：**大写 D 的 levelDelta 被接受**。官方语料只发小写 d，属文档缺陷 —— 客户端的默认值正确。`
        : spelling === 'lower'
          ? `实测：**只有小写 d 的 leveldelta 被接受**。这与本项目默认不同，` +
            `需要把 TitanClient 的 encoding.levelDeltaSpelling 设为 'lower'。`
          : `未能确定。大写 D：${camel.detail}；小写 d：${lower?.detail ?? '（未测）'}`,
    raw: JSON.stringify({ camel, lower }),
  });

  // ── 5. 时码源（决定卡点路线） ───────────────────────────────────────────
  try {
    const enabled = await client.get('Timecode', 'Enabled');
    add({
      name: '时码可用性',
      status: 'ok',
      detail:
        `Timecode/Enabled = ${enabled}。` +
        `⚠️ 还需在控台界面上确认是否已授权 Timecode/Timeline 功能（API 读不到授权状态）。`,
      raw: enabled,
    });
  } catch {
    add({
      name: '时码可用性',
      status: 'skip',
      detail: 'Timecode/Enabled 读取失败 —— 可能该功能未授权，或属性名不同。',
    });
  }

  // ── 6. 解析式探测：POST set 的可用性 ───────────────────────────────────
  try {
    // 读一个无害属性确认 get 通道
    await client.get('System', 'SoftwareVersion');
    add({ name: 'GET 属性通道', status: 'ok', detail: '读属性通道正常（GET /titan/get/2/…）。' });
  } catch (e) {
    add({
      name: 'GET 属性通道',
      status: 'fail',
      detail: `异常：${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const counts = { ok: 0, warn: 0, fail: 0, skip: 0 };
  for (const c of checks) counts[c.status] += 1;

  return {
    ranAt: Date.now(),
    baseUrl: client.baseUrl,
    checks,
    observedGroups,
    levelDeltaSpelling: spelling,
    counts,
  };
}

/**
 * 无副作用地探测某种 `levelDelta` 拼写是否被接受。
 *
 * 做法：对一个**几乎不可能存在的句柄**发一条电平设置请求。
 * 控台会先绑定参数再解析句柄（与本项目模拟器一致），因此：
 * - 报"找不到句柄" → 参数语法**通过了**
 * - 报 LevelAdjust / 类型转换 → 参数语法**没通过**
 * 无论哪种，show 与输出都没有被改动。
 */
async function probeDeltaSpelling(
  client: TitanClient,
  spelling: 'camel' | 'lower',
): Promise<{ accepted: boolean; detail: string }> {
  const key = spelling === 'camel' ? 'level_levelDelta' : 'level_leveldelta';
  const url =
    `${client.baseUrl}/titan/script/2/Playbacks/SetPlaybackLevel` +
    `?srcHandle_titanId=${PROBE_TITAN_ID}&${key}=0.001`;

  try {
    const res = await fetch(url);
    const body = (await res.text()).trim();

    if (!/^Error/i.test(body)) {
      // 没有报错很奇怪（句柄本不该存在）—— 保守判为"语法通过但行为异常"
      return { accepted: false, detail: `未按预期报错，响应：${body.slice(0, 120) || '(空)'}` };
    }

    const isTypeError = /LevelAdjust|Boolean|konvertiert|convert|Datentyp|类型/i.test(body);
    const isHandleError = /handle|index|find|句柄/i.test(body);

    if (isTypeError && !isHandleError) {
      return { accepted: false, detail: `参数类型被拒：${body.slice(0, 160)}` };
    }
    if (isHandleError) {
      return { accepted: true, detail: `参数被接受（随后因句柄不存在而报错）：${body.slice(0, 160)}` };
    }
    return { accepted: false, detail: `无法判定，响应：${body.slice(0, 160)}` };
  } catch (e) {
    return { accepted: false, detail: `请求失败：${e instanceof Error ? e.message : String(e)}` };
  }
}
