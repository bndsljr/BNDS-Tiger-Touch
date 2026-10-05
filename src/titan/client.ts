/**
 * Titan WebAPI 客户端。
 *
 * 传输层事实（见 docs/01-API调研笔记.md §2）：
 * - HTTP，端口 4430，基路径 `/titan/`
 * - 读属性 `GET  /titan/get/2/<Provider>/<Property>`
 * - 写属性 `POST /titan/set/2/<Provider>/<Property>`
 * - 调方法 `GET  /titan/script/2/<Provider>/<Method>?<params>`
 * - **`/2/` 是强制的**（1203/1203 get、1203/1203 set，零例外）
 *
 * ⚠️ 官方 Introduction 页是**过时的 Titan 14 材料**：它不带 `/2/`、
 * 用按类型命名的参数键（`?string=&int=&bool=`）。那是 API 第一代约定，
 * 与 `/2/` 第二代**不兼容**。本客户端只实现 `/2/` 形式。
 *
 * ⚠️ 无认证、无 TLS、无限速 —— 控台网络必须隔离。
 * ⚠️ 无任何推送通道（WebSocket/SSE/长轮询全语料零命中）→ 只能轮询，
 *    且应只轮询廉价标量，句柄全量拉取仅首次。
 */

import {
  TitanConsoleError,
  TitanHttpError,
  TitanTimeoutError,
  TitanUnreachableError,
  TitanVersionMismatchError,
  detectConsoleError,
} from './errors.ts';
import { encodeParams, type EncodingOptions, type ParamValue } from './params.ts';

export interface TitanClientOptions {
  /** 控台地址，例如 `http://10.0.0.1:4430`，或 `http://127.0.0.1:4500`（模拟器）。 */
  baseUrl: string;
  timeoutMs?: number;
  /** 参数编码微调（主要是 `levelDelta` 拼写）。 */
  encoding?: EncodingOptions;
  /**
   * `POST /titan/set/...` 的请求体编码。
   *
   * 文档只给了一个裸字面量示例（body = `False`），**从未规定 Content-Type**。
   * 'bare' 是文档所示形式；'json' 为备选，需实测。
   */
  setBodyEncoding?: 'bare' | 'json';
}

export interface TitanResponse {
  status: number;
  body: string;
  url: string;
}

const DEFAULTS = {
  timeoutMs: 10_000,
  setBodyEncoding: 'bare' as const,
};

export class TitanClient {
  readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly encoding: EncodingOptions;
  private readonly setBodyEncoding: 'bare' | 'json';

  /** 记录实测生效的 `levelDelta` 拼写，供 UI 展示与诊断。 */
  private resolvedLevelDeltaSpelling: 'camel' | 'lower' | null = null;

  constructor(options: TitanClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
    this.encoding = options.encoding ?? {};
    this.setBodyEncoding = options.setBodyEncoding ?? DEFAULTS.setBodyEncoding;
  }

  get detectedLevelDeltaSpelling(): 'camel' | 'lower' | null {
    return this.resolvedLevelDeltaSpelling;
  }

  // ── 传输原语 ────────────────────────────────────────────────────────────

  private url(path: string, query?: Record<string, string>): string {
    const u = new URL(`${this.baseUrl}/titan/${path}`);
    if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
    return u.toString();
  }

  private async fetchText(url: string, init?: RequestInit): Promise<TitanResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (cause) {
      if (controller.signal.aborted) throw new TitanTimeoutError(url, this.timeoutMs);
      throw new TitanUnreachableError(url, cause);
    } finally {
      clearTimeout(timer);
    }
    const body = await res.text();
    if (res.status >= 400) throw new TitanHttpError(res.status, url, body);
    const err = detectConsoleError(body);
    if (err) throw new TitanConsoleError(url, err);
    return { status: res.status, body, url };
  }

  // ── get / set / script ──────────────────────────────────────────────────

  /** 读属性。注意：**属性读取不带查询串**，目标全在路径里。 */
  async get(provider: string, property: string): Promise<string> {
    const { body } = await this.fetchText(this.url(`get/2/${provider}/${property}`));
    return body.trim();
  }

  /** 读属性并解析为数字；非数字则抛错。 */
  async getNumber(provider: string, property: string): Promise<number> {
    const raw = await this.get(provider, property);
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new TitanConsoleError(this.url(`get/2/${provider}/${property}`), `期望数字，收到「${raw}」`);
    }
    return n;
  }

  /** 读属性并解析布尔。识别 Titan 常见的 `True`/`False` 与 `true`/`false`。 */
  async getBoolean(provider: string, property: string): Promise<boolean> {
    const raw = (await this.get(provider, property)).toLowerCase();
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0' || raw === '') return false;
    throw new TitanConsoleError(this.url(`get/2/${provider}/${property}`), `期望布尔，收到「${raw}」`);
  }

  /**
   * 写属性。
   *
   * ⚠️ 已知限制（厂方确认）：**`set` 无法写句柄类型的属性**。
   */
  async set(provider: string, property: string, value: string | number | boolean): Promise<void> {
    const url = this.url(`set/2/${provider}/${property}`);
    const body =
      typeof value === 'boolean'
        ? value
          ? 'True'
          : 'False'
        : typeof value === 'number'
          ? String(value)
          : value;

    const init: RequestInit =
      this.setBodyEncoding === 'json'
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          }
        : { method: 'POST', body };

    await this.fetchText(url, init);
  }

  /**
   * 调方法。
   *
   * 返回值直接来自响应体 —— 已核实 `script/` 端点**会返回方法返回值**
   * （证据：`UserMacros.ExportXml` 的文档签名即 `String` 返回）。
   * ⚠️ 但响应体的**线格式未文档化**（JSON？裸字符串？带引号？）→
   * 解析请用 `scriptJson` 并在真控台上先行验证。
   */
  async script(
    provider: string,
    method: string,
    params: Record<string, ParamValue> = {},
  ): Promise<string> {
    const query = encodeParams(params, this.encoding);
    const { body } = await this.fetchText(this.url(`script/2/${provider}/${method}`, query));
    return body.trim();
  }

  /** 调方法并解析 JSON。线格式未文档化，失败时抛出含原文的错误以便诊断。 */
  async scriptJson<T = unknown>(
    provider: string,
    method: string,
    params: Record<string, ParamValue> = {},
  ): Promise<T> {
    const raw = await this.script(provider, method, params);
    if (raw === '') return [] as unknown as T; // void 方法返回空 body
    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new TitanConsoleError(
        this.url(`script/2/${provider}/${method}`),
        `期望 JSON 但无法解析（线格式未文档化，需实测）：${raw.slice(0, 300)}`,
      );
    }
  }

  /** 调方法，忽略返回值（`void` 方法返回空 body）。 */
  async call(provider: string, method: string, params: Record<string, ParamValue> = {}): Promise<void> {
    await this.script(provider, method, params);
  }

  // ── 诊断 ────────────────────────────────────────────────────────────────

  /** 读取 Titan 版本字符串，例如 `16.0`。 */
  async softwareVersion(): Promise<string> {
    return this.get('System', 'SoftwareVersion');
  }

  /**
   * 版本门禁。**应当在首次连接时立即调用。**
   *
   * 若控台是原版 Tiger Touch / Touch Pro / 早期 TT II，最高只能到 15.1，
   * 与本项目所依据的 16.0 面有约 187 页差异 —— 必须明确报错而非静默错乱。
   */
  async assertVersion(expectedMajor = 16, opts: { allowMismatch?: boolean } = {}): Promise<string> {
    const actual = await this.softwareVersion();
    const major = Number.parseInt(actual, 10);
    if (!Number.isFinite(major)) {
      throw new TitanConsoleError(this.url('get/2/System/SoftwareVersion'), `无法解析版本「${actual}」`);
    }
    if (!opts.allowMismatch && major !== expectedMajor) {
      throw new TitanVersionMismatchError(actual, expectedMajor);
    }
    return actual;
  }

  /** 探测控台可达性与版本，返回结构化结果（不抛错，适合 UI 的"连接"按钮）。 */
  async probe(): Promise<
    | { ok: true; version: string; showName: string; loadState: string }
    | { ok: false; error: string; kind: 'unreachable' | 'http' | 'console' | 'version' }
  > {
    try {
      const version = await this.softwareVersion();
      const [showName, loadState] = await Promise.all([
        this.get('Show', 'ShowName').catch(() => ''),
        this.get('Show', 'LoadState').catch(() => ''),
      ]);
      return { ok: true, version, showName, loadState };
    } catch (e) {
      if (e instanceof TitanUnreachableError || e instanceof TitanTimeoutError) {
        return { ok: false, error: e.message, kind: 'unreachable' };
      }
      if (e instanceof TitanHttpError) return { ok: false, error: e.message, kind: 'http' };
      if (e instanceof TitanVersionMismatchError) return { ok: false, error: e.message, kind: 'version' };
      return { ok: false, error: e instanceof Error ? e.message : String(e), kind: 'console' };
    }
  }
}
