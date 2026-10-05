/**
 * Titan WebAPI 错误。
 *
 * ## 已核实的错误契约（见调研笔记 §8.6）
 *
 * - 错误体是**纯文本** `Error: <原始 .NET 异常>`，**不是 JSON**
 * - 且**语言跟随控台 UI 语言** —— 中文控台会返回中文错误信息
 * - HTTP 畸形请求返回 `400 Bad Request`
 * - **空 body = 成功**（`void` 方法不返回 JSON）
 * - 语料中**零个** HTTP 状态码被文档化
 *
 * 因此解析策略：能识别 `Error:` 前缀就提取；否则原文保留。
 * **不要把错误信息当作机器可读的枚举** —— 它受控台语言影响。
 */

export class TitanHttpError extends Error {
  override readonly name = 'TitanHttpError';
  readonly status: number;
  readonly url: string;
  readonly body: string;

  constructor(status: number, url: string, body: string) {
    super(`Titan 请求失败 HTTP ${status}：${body.slice(0, 300) || '(空响应)'}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

/** 控台返回了 `Error: …` 文本。`raw` 保留原文（可能是中文）。 */
export class TitanConsoleError extends Error {
  override readonly name = 'TitanConsoleError';
  readonly url: string;
  readonly raw: string;

  constructor(url: string, raw: string) {
    super(`控台报错：${raw}`);
    this.url = url;
    this.raw = raw;
  }
}

export class TitanTimeoutError extends Error {
  override readonly name = 'TitanTimeoutError';
  readonly url: string;
  readonly timeoutMs: number;
  constructor(url: string, timeoutMs: number) {
    super(`Titan 请求超时（${timeoutMs}ms）：${url}`);
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

export class TitanUnreachableError extends Error {
  override readonly name = 'TitanUnreachableError';
  readonly url: string;
  override readonly cause: unknown;
  constructor(url: string, cause: unknown) {
    super(`无法连接控台：${url} —— ${cause instanceof Error ? cause.message : String(cause)}`);
    this.url = url;
    this.cause = cause;
  }
}

/**
 * 版本不匹配。**这是本项目最重要的早期检查之一。**
 *
 * 厂方文档：*"version 16 and above will not work on the Pearl Expert,
 * original Tiger Touch, Tiger Touch Pro or the first version of the Tiger Touch II"*。
 * 受影响机型（含 Tiger Touch II 序列 2001–3065）**最高只能到 V15.1**，
 * 而 15.0 与 16.0 的 API 有 **187 页差异**。
 *
 * → 本项目按 16.0 面编写；连到其他版本时**必须明确报错**，
 *   而不是发出一堆看起来像拼写错误的 400。
 */
export class TitanVersionMismatchError extends Error {
  override readonly name = 'TitanVersionMismatchError';
  readonly actual: string;
  readonly expectedMajor: number;
  constructor(actual: string, expectedMajor: number) {
    super(
      `控台 Titan 版本为 ${actual}，本项目按 ${expectedMajor}.x 编写。\n` +
        `若控台是原版 Tiger Touch / Tiger Touch Pro / Tiger Touch II 序列 2001–3065，` +
        `则最高只能到 15.1，需改用 15.x 的 API 面（约 187 页差异）。\n` +
        `请核对控台序列号与 System/SoftwareVersion。`,
    );
    this.actual = actual;
    this.expectedMajor = expectedMajor;
  }
}
/** 从响应体识别控台错误。返回 null 表示不是错误（含空 body = 成功）。 */
export function detectConsoleError(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed === '') return null;
  // 控台错误的稳定特征只有 `Error:` 前缀；其后的文本受控台语言影响。
  if (/^Error\s*:/i.test(trimmed)) return trimmed;
  return null;
}
