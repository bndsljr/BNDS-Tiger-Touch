/**
 * `Handles` provider —— 句柄自省。
 *
 * ## 为什么需要它
 *
 * 句柄分组名字符串**完全未文档化**：全语料 3706 页中不存在任何 `group=` 的字面量取值。
 * 唯一有文档的"回读分组名"方法是 `Handles.GetGroup`，
 * 因此它是 `group={string}` 参数的**官方 bootstrap**。
 *
 * 用法：先用确定无误的寻址（`handle_titanId` / `handle_userNumber`）拿到句柄，
 * 回读它的分组名字符串，此后一律使用该字面量。
 */

import type { TitanClient } from '../client.ts';
import { handle, type ParamValue } from '../params.ts';
import type { HandleRef } from '../handles.ts';

export interface HandleInfo {
  titanId: number;
  group: string;
  path: string;
}

export class Handles {
  private readonly client: TitanClient;
  constructor(client: TitanClient) {
    this.client = client;
  }

  /** 回读句柄的分组名字符串。null 句柄返回字符串 `"Null"`。 */
  async getGroup(ref: HandleRef): Promise<string> {
    return (await this.client.script('Handles', 'GetGroup', { handle: handle(ref) })).trim();
  }

  async getPath(ref: HandleRef): Promise<string> {
    return (await this.client.script('Handles', 'GetPath', { handle: handle(ref) })).trim();
  }

  async getTitanIdFromHandle(ref: HandleRef): Promise<number | null> {
    const raw = await this.client.script('Handles', 'GetTitanIdFromHandle', { handle: handle(ref) });
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  async info(ref: HandleRef): Promise<HandleInfo | null> {
    const titanId = await this.getTitanIdFromHandle(ref);
    if (titanId === null) return null;
    const [group, path] = await Promise.all([
      this.getGroup(ref).catch(() => ''),
      this.getPath(ref).catch(() => ''),
    ]);
    return { titanId, group, path };
  }

  /**
   * 批量拉取全部句柄。
   *
   * ⚠️ **只在首次连接时调用一次并缓存。**
   * 实测约 **177 B/句柄** → 2000 句柄 ≈ 350 KiB，5000 句柄 ≈ 1 MiB，
   * 而控台是与 DMX 引擎共享时间的嵌入式 CPU。
   * 心跳请改用廉价标量（`Show/ShowName`、`Show/LoadState`、`Timecode/Context/LiveTime`）。
   *
   * ⚠️ 该端点在 16.0 参考文档中**零命中**，只出现在过时的 Introduction 页 →
   * **不能作为设计前提**，需要探测其是否存在。
   */
  async fetchAll(): Promise<unknown[]> {
    const url = `${this.client.baseUrl}/titan/handles`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`/titan/handles 返回 HTTP ${res.status}`);
    const parsed: unknown = await res.json();
    return Array.isArray(parsed) ? parsed : [];
  }

  /** 探测 `/titan/handles` 是否可用 —— 列入 M6 现场验证清单。 */
  async probeBulkEndpoint(): Promise<{ available: boolean; count: number; error?: string }> {
    try {
      const all = await this.fetchAll();
      return { available: true, count: all.length };
    } catch (e) {
      return { available: false, count: 0, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ── 便捷封装 ───────────────────────────────────────────────────────────

  async setLegend(ref: HandleRef, legend: string): Promise<void> {
    await this.client.call('Handles', 'SetLegend', { handle: handle(ref), legend });
  }

  async setUserNumber(ref: HandleRef, userNumber: number): Promise<void> {
    await this.client.call('Handles', 'SetUserNumber', { handle: handle(ref), userNumber });
  }

  async setNotes(ref: HandleRef, notes: string): Promise<void> {
    await this.client.call('Handles', 'SetNotes', { handle: handle(ref), notes });
  }

  /** 翻页。散 cue 库的分页组织会用到。 */
  async changeRollerPage(page: number): Promise<void> {
    await this.client.call('Handles', 'ChangeRollerPage', { page });
  }

  async setGroupPage(group: string, page: number): Promise<void> {
    await this.client.call('Handles', 'SetGroupPage', { group, page });
  }

  /** 分组级别的选择集读取，例如 `HandleOptions/Groups/GetSelection` 的等价物。 */
  async getGroupSelection(group: string): Promise<unknown> {
    const params: Record<string, ParamValue> = { group };
    return this.client.scriptJson('Handles', 'GetSelection', params);
  }
}
