/**
 * 查询串参数编码。
 *
 * ## 已核实的编码规则（见 docs/01-API调研笔记.md §2.2 / §8.1）
 *
 * 1. **复合/联合类型展开为 `<参数名>_<变体>` 键。**
 *    - `Handle` → `handle_titanId` / `handle_userNumber` / `handle_location`
 *    - `IEnumerable<Handle>` → `handles_handleList` / `handles_userNumberList`
 *    - `LevelAdjust` → `value_level` / `value_levelDelta`
 *
 * 2. **普通标量保留自己的名字作为键** —— `alwaysRefire=true`、`updateOnly=false`。
 *    16.0 参考中**不存在**按类型命名的形式（那是过时 Introduction 的 v1 约定）。
 *
 * ## 💣 本模块存在的主要理由：`levelDelta` 大小写地雷
 *
 * 官方 16.0 语料**只发小写 d** 的 `leveldelta`（41 次 / 19 页），
 * 大写 `levelDelta` **零命中**。但社区实测**小写 d 会抛类型转换错误**：
 *   `Error: ... kann nicht in den Typ "Avolites.Menus.Maths.LevelAdjust" konvertiert werden.`
 *
 * 我方独立佐证（对全语料统计 `<参数名>_<变体>` 后缀）：
 *   `_titanId`(596)、`_userNumber`(511)、`_location`(419)、`_handleList`(132)、
 *   `_userNumberList`(128)、`_level`(49) —— **清一色 camelCase**；
 *   唯独 `_leveldelta`(22) 全小写，是唯一异类。
 *   C# 联合类型成员名本身也是 `LevelDelta`。
 *   → 几乎可以确定是**文档生成器的大小写 bug**。
 *
 * **因此本客户端默认发大写 D，并可配置回退。**
 * 从语料直接代码生成会 100% 发出错误的电平调用，且**静默失效**。
 */

export interface EncodingOptions {
  /**
   * `LevelAdjust` 增量变体的拼写。
   *
   * - `'camel'`（默认）：`_levelDelta` —— 与所有其他变体后缀的 camelCase 风格一致，
   *   且符合 C# 成员名 `LevelDelta`。
   * - `'lower'`：`_leveldelta` —— 官方语料字面写法，但社区实测会抛错。
   *
   * 首次连接真控台时应实测确定（见 §10.1 验证清单）。
   */
  levelDeltaSpelling?: 'camel' | 'lower';
}

export const DEFAULT_ENCODING: Required<EncodingOptions> = {
  levelDeltaSpelling: 'camel',
};

/** 电平：绝对值（0…1）或增量（-1…+1）。 */
export type LevelAdjust =
  | { kind: 'level'; value: number }
  | { kind: 'levelDelta'; value: number };

export const level = (value: number): LevelAdjust => ({ kind: 'level', value });
export const levelDelta = (value: number): LevelAdjust => ({ kind: 'levelDelta', value });

/** 参数值 —— 只接受可安全编码的类型。 */
export type ParamValue =
  | string
  | number
  | boolean
  | LevelAdjust
  | null
  | undefined
  | readonly (string | number)[]
  | { handle: import('./handles.ts').HandleRef }
  | { toQuery: () => Record<string, string> };

/**
 * 把参数表编码为查询串键值对。
 *
 * @param params  方法参数，键为**参数名**（不是类型名）
 */
export function encodeParams(
  params: Record<string, ParamValue>,
  options: EncodingOptions = {},
): Record<string, string> {
  const spelling = options.levelDeltaSpelling ?? DEFAULT_ENCODING.levelDeltaSpelling;
  const deltaKey = spelling === 'camel' ? 'levelDelta' : 'leveldelta';
  const out: Record<string, string> = {};

  for (const [name, raw] of Object.entries(params)) {
    if (raw === undefined || raw === null) continue;

    // LevelAdjust 联合类型 → 展开为 <name>_level 或 <name>_levelDelta
    if (isLevelAdjust(raw)) {
      if (raw.kind === 'level') {
        out[`${name}_level`] = formatNumber(raw.value);
      } else {
        out[`${name}_${deltaKey}`] = formatNumber(raw.value);
      }
      continue;
    }

    // Handle → 展开为 <name>_titanId / _userNumber / _location
    if (isHandleWrapper(raw)) {
      Object.assign(out, encodeHandleInto(name, raw.handle));
      continue;
    }

    // 自定义编码（例如列表参数）
    if (isQueryable(raw)) {
      Object.assign(out, raw.toQuery());
      continue;
    }

    // 标量：保留自身名字
    if (typeof raw === 'boolean') {
      out[name] = raw ? 'true' : 'false';
      continue;
    }
    if (typeof raw === 'number') {
      out[name] = formatNumber(raw);
      continue;
    }
    if (typeof raw === 'string') {
      out[name] = raw;
      continue;
    }
    if (Array.isArray(raw)) {
      out[name] = raw.map((v) => String(v)).join(',');
      continue;
    }

    throw new TitanParamError(`无法编码参数 ${name}：不支持的类型`);
  }

  return out;
}

function encodeHandleInto(prefix: string, ref: import('./handles.ts').HandleRef): Record<string, string> {
  if ('titanId' in ref) return { [`${prefix}_titanId`]: String(ref.titanId) };
  if ('userNumber' in ref) return { [`${prefix}_userNumber`]: String(ref.userNumber) };
  const { group, page, index } = ref.location;
  return { [`${prefix}_location`]: `${group}_${page}_${index}` };
}

export function handle(ref: import('./handles.ts').HandleRef): ParamValue {
  return { handle: ref };
}

export function handleList(
  refs: readonly ({ titanId: number } | { userNumber: number })[],
): ParamValue {
  return {
    toQuery: () => {
      const t = refs.filter((r): r is { titanId: number } => 'titanId' in r).map((r) => r.titanId);
      const u = refs.filter((r): r is { userNumber: number } => 'userNumber' in r).map((r) => r.userNumber);
      if (t.length && u.length) {
        throw new TitanParamError('句柄列表不能混用 titanId 与 userNumber');
      }
      return t.length ? { handleList_handleList: t.join(',') } : { handleList_userNumberList: u.join(',') };
    },
  };
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) throw new TitanParamError(`数值非法：${String(n)}`);
  // 避免 0.1+0.2 之类产生的长尾，但保留足够精度
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6)));
}

function isLevelAdjust(v: unknown): v is LevelAdjust {
  return (
    typeof v === 'object' &&
    v !== null &&
    'kind' in v &&
    ((v as LevelAdjust).kind === 'level' || (v as LevelAdjust).kind === 'levelDelta')
  );
}

function isHandleWrapper(v: unknown): v is { handle: import('./handles.ts').HandleRef } {
  return typeof v === 'object' && v !== null && 'handle' in v && !('toQuery' in v);
}

function isQueryable(v: unknown): v is { toQuery: () => Record<string, string> } {
  return typeof v === 'object' && v !== null && typeof (v as { toQuery?: unknown }).toQuery === 'function';
}

export class TitanParamError extends Error {
  override readonly name = 'TitanParamError';
}
