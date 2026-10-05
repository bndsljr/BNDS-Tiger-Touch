/**
 * 应用 HTTP 服务 —— 给 WebUI 提供 JSON API 与 SSE 事件流。
 *
 * 设计取舍：
 * - **零依赖**，用手写路由。理由：演出工具对启动速度与可控性敏感，
 *   且我们只需要很小的一层。Node 24 原生跑 TS，不需要构建步骤。
 * - **SSE 而不是 WebSocket**：我们只需要服务端→浏览器的单向推送（时钟、命中、状态），
 *   SSE 更简单、自带重连、且能穿过大多数代理。
 *   ⚠️ 注意这与控台无关 —— 控台侧**没有任何推送通道**（全语料零命中），
 *   对控台只能轮询廉价标量；SSE 是我们自己加的。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { AppState } from './appstate.ts';
import { emptySong, type CueMark, type Song } from '../model/song.ts';
import { defaultTimes, makeCueId, nextFreePlacement, type ScatteredCue } from '../model/cuebank.ts';
import type { ExecuteOptions } from '../engine/injector.ts';

export interface AppServerOptions {
  port?: number;
  host?: string;
  /** 静态资源目录（WebUI） */
  webRoot: string;
  /** 音频与工程数据目录 */
  dataRoot: string;
  /** 首次启动时自动连接的控台地址（可选） */
  autoConnect?: string | undefined;
}

interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  body: () => Promise<unknown>;
}

export class AppServer {
  readonly state = new AppState();
  private server: Server | null = null;
  private readonly sseClients = new Set<ServerResponse>();
  private readonly options: AppServerOptions;

  constructor(options: AppServerOptions) {
    this.options = options;
    this.state.subscribe((event, data) => this.broadcast(event, data));
  }

  private broadcast(event: string, data: unknown): void {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(payload);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  async listen(): Promise<{ port: number; url: string }> {
    const port = this.options.port ?? 8091;
    const host = this.options.host ?? '127.0.0.1';
    this.server = createServer((req, res) => {
      void this.route(req, res);
    });
    await new Promise<void>((r) => this.server!.listen(port, host, r));
    const addr = this.server.address();
    const actual = typeof addr === 'object' && addr ? addr.port : port;

    if (this.options.autoConnect) {
      void this.state.connect(this.options.autoConnect, { allowVersionMismatch: true });
    }
    return { port: actual, url: `http://${host}:${actual}` };
  }

  async close(): Promise<void> {
    for (const c of this.sseClients) c.end();
    this.sseClients.clear();
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    await new Promise<void>((r, j) => srv.close((e) => (e ? j(e) : r())));
  }

  // ── 路由 ────────────────────────────────────────────────────────────────

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;

    const ctx: Ctx = {
      req,
      res,
      url,
      body: async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const text = Buffer.concat(chunks).toString('utf8');
        if (text === '') return {};
        try {
          return JSON.parse(text);
        } catch {
          throw new HttpError(400, '请求体不是合法 JSON');
        }
      },
    };

    try {
      if (path.startsWith('/api/')) return await this.api(ctx, path);
      return await this.static(ctx, path);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof Error ? e.message : String(e);
      sendJson(res, status, { error: message });
    }
  }

  private async api(ctx: Ctx, path: string): Promise<void> {
    const { res, req } = ctx;
    const method = req.method ?? 'GET';

    if (path === '/api/events' && method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
      res.write(`event: state\ndata: ${JSON.stringify(this.state.snapshot())}\n\n`);
      this.sseClients.add(res);
      req.on('close', () => this.sseClients.delete(res));
      return;
    }

    if (path === '/api/state' && method === 'GET') {
      return sendJson(res, 200, { ...this.state.snapshot(), analysis: this.state.report });
    }

    // ── 连接 ────────────────────────────────────────────────────────────
    if (path === '/api/connect' && method === 'POST') {
      const b = (await ctx.body()) as { baseUrl?: string; allowVersionMismatch?: boolean };
      if (!b.baseUrl) throw new HttpError(400, '缺少 baseUrl');
      const status = await this.state.connect(b.baseUrl, {
        allowVersionMismatch: b.allowVersionMismatch ?? false,
      });
      return sendJson(res, 200, status);
    }
    if (path === '/api/disconnect' && method === 'POST') {
      this.state.disconnect();
      return sendJson(res, 200, this.state.status);
    }
    if (path === '/api/resolve-handles' && method === 'POST') {
      return sendJson(res, 200, await this.state.resolveHandles());
    }

    // ── 散 cue 库 ───────────────────────────────────────────────────────
    if (path === '/api/cuebank' && method === 'GET') {
      return sendJson(res, 200, this.state.bank);
    }
    if (path === '/api/cuebank/cue' && method === 'POST') {
      const b = (await ctx.body()) as Partial<ScatteredCue> & { page?: number };
      const bank = this.state.bank;
      const page = b.page ?? b.placement?.page ?? 1;
      if (!bank.pages.some((p) => p.page === page)) {
        bank.pages.push({ page, name: `第 ${page} 页`, cues: [] });
        bank.pages.sort((x, y) => x.page - y.page);
      }
      const targetPage = bank.pages.find((p) => p.page === page)!;

      if (b.id) {
        const existing = targetPage.cues.find((c) => c.id === b.id);
        if (!existing) throw new HttpError(404, `散 cue '${b.id}' 不存在`);
        Object.assign(existing, {
          name: b.name ?? existing.name,
          placement: b.placement ?? existing.placement,
          times: b.times ?? existing.times,
          defaultLevel: b.defaultLevel ?? existing.defaultLevel,
          tags: b.tags ?? existing.tags,
          note: b.note ?? existing.note,
        });
        this.state.setBank(bank);
        return sendJson(res, 200, existing);
      }

      const created: ScatteredCue = {
        id: makeCueId(b.name ?? 'cue'),
        name: b.name ?? '新散 cue',
        placement: b.placement ?? nextFreePlacement(bank, page),
        times: b.times ?? defaultTimes(),
        defaultLevel: b.defaultLevel ?? 1,
        tags: b.tags ?? [],
        ...(b.note !== undefined ? { note: b.note } : {}),
        ...(b.look !== undefined ? { look: b.look } : {}),
      };
      targetPage.cues.push(created);
      this.state.setBank(bank);
      return sendJson(res, 200, created);
    }
    if (path === '/api/cuebank/cue' && method === 'DELETE') {
      const id = ctx.url.searchParams.get('id');
      if (!id) throw new HttpError(400, '缺少 id');
      const bank = this.state.bank;
      for (const p of bank.pages) p.cues = p.cues.filter((c) => c.id !== id);
      this.state.setBank(bank);
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/api/cuebank/fire' && method === 'POST') {
      const b = (await ctx.body()) as { id?: string; level?: number };
      if (!b.id) throw new HttpError(400, '缺少 id');
      // 推失败属于操作问题（落位不对/未连接），不是服务端故障 → 4xx
      try {
        await this.state.fireManual(b.id, b.level);
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/api/cuebank/kill' && method === 'POST') {
      const b = (await ctx.body()) as { id?: string };
      if (!b.id) throw new HttpError(400, '缺少 id');
      try {
        await this.state.killCue(b.id);
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/api/cuebank/killall' && method === 'POST') {
      await this.state.killAll();
      return sendJson(res, 200, { ok: true });
    }

    // ── 曲目 ────────────────────────────────────────────────────────────
    if (path === '/api/songs' && method === 'GET') {
      return sendJson(res, 200, this.state.songList);
    }
    if (path === '/api/songs' && method === 'POST') {
      const b = (await ctx.body()) as Partial<Song>;
      const song: Song = {
        ...emptySong(b.name ?? '新曲目', b.audioPath ?? ''),
        ...b,
        id: b.id ?? emptySong().id,
        marks: b.marks ?? [],
      };
      return sendJson(res, 200, this.state.upsertSong(song));
    }
    if (path === '/api/songs' && method === 'DELETE') {
      const id = ctx.url.searchParams.get('id');
      if (!id) throw new HttpError(400, '缺少 id');
      this.state.deleteSong(id);
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/api/songs/load' && method === 'POST') {
      const b = (await ctx.body()) as { id?: string };
      if (!b.id) throw new HttpError(400, '缺少 id');
      return sendJson(res, 200, this.state.loadSong(b.id));
    }

    // ── 演出控制 ────────────────────────────────────────────────────────
    if (path === '/api/show/play' && method === 'POST') {
      const b = (await ctx.body()) as { fromMs?: number };
      this.state.play(b.fromMs);
      return sendJson(res, 200, this.state.snapshot().transport);
    }
    if (path === '/api/show/pause' && method === 'POST') {
      this.state.pause();
      return sendJson(res, 200, this.state.snapshot().transport);
    }
    if (path === '/api/show/stop' && method === 'POST') {
      this.state.stop();
      return sendJson(res, 200, this.state.snapshot().transport);
    }
    if (path === '/api/show/seek' && method === 'POST') {
      const b = (await ctx.body()) as { toMs?: number };
      if (typeof b.toMs !== 'number') throw new HttpError(400, '缺少 toMs');
      this.state.seek(b.toMs);
      return sendJson(res, 200, this.state.snapshot().transport);
    }
    if (path === '/api/show/sync' && method === 'POST') {
      const b = (await ctx.body()) as { positionMs?: number };
      if (typeof b.positionMs !== 'number') throw new HttpError(400, '缺少 positionMs');
      this.state.syncAudioPosition(b.positionMs);
      return sendJson(res, 200, { ok: true });
    }
    if (path === '/api/show/mark' && method === 'POST') {
      const b = (await ctx.body()) as { cueIds?: string[]; note?: string; level?: number };
      if (!b.cueIds || b.cueIds.length === 0) throw new HttpError(400, '缺少 cueIds');
      const mark: CueMark = this.state.markAtCurrentTime(b.cueIds, {
        ...(b.note !== undefined ? { note: b.note } : {}),
        ...(b.level !== undefined ? { level: b.level } : {}),
      });
      return sendJson(res, 200, mark);
    }
    if (path === '/api/show/offset' && method === 'POST') {
      const b = (await ctx.body()) as { id?: string; offsetMs?: number };
      if (!b.id || typeof b.offsetMs !== 'number') throw new HttpError(400, '缺少 id 或 offsetMs');
      this.state.setSongOffset(b.id, b.offsetMs);
      return sendJson(res, 200, { ok: true });
    }
    // ── 批量灌入（R5） ──────────────────────────────────────────────────
    if (path === '/api/inject/plan' && method === 'POST') {
      try {
        return sendJson(res, 200, await this.state.planInject());
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
    }
    if (path === '/api/inject/execute' && method === 'POST') {
      const b = (await ctx.body()) as { plan?: unknown } & ExecuteOptions;
      if (!b.plan) throw new HttpError(400, '缺少 plan（请先调用 /api/inject/plan）');
      try {
        const result = await this.state.runInject(
          b.plan as Parameters<typeof this.state.runInject>[0],
          {
            ...(b.withContent !== undefined ? { withContent: b.withContent } : {}),
            ...(b.overwriteConflicts !== undefined
              ? { overwriteConflicts: b.overwriteConflicts }
              : {}),
            ...(b.rollbackOnFailure !== undefined
              ? { rollbackOnFailure: b.rollbackOnFailure }
              : {}),
            ...(b.dryRun !== undefined ? { dryRun: b.dryRun } : {}),
          },
        );
        return sendJson(res, 200, result);
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
    }

    // ── 分析（R2 结构体检） ─────────────────────────────────────────────
    if (path === '/api/analyze' && method === 'POST') {
      const b = (await ctx.body()) as { maxCuesPerPlayback?: number };
      try {
        const report = await this.state.analyzeShow(
          b.maxCuesPerPlayback !== undefined ? { maxCuesPerPlayback: b.maxCuesPerPlayback } : {},
        );
        return sendJson(res, 200, report);
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
    }
    if (path === '/api/analyze/cuesheet' && method === 'GET') {
      try {
        const md = this.state.cueSheetMarkdown(ctx.url.searchParams.get('title') ?? undefined);
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': 'attachment; filename="cue-sheet.md"',
          'Cache-Control': 'no-store',
        });
        res.end(md);
        return;
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
    }
    if (path === '/api/analyze/inventory' && method === 'GET') {
      if (!this.state.inventory) throw new HttpError(404, '还没有读取过 show');
      return sendJson(res, 200, this.state.inventory);
    }

    if (path === '/api/show/marks' && method === 'DELETE') {
      const song = this.state.currentSong;
      if (!song) throw new HttpError(404, '尚未选择曲目');
      const id = ctx.url.searchParams.get('id');
      song.marks = id ? song.marks.filter((m) => m.id !== id) : [];
      this.state.upsertSong(song);
      return sendJson(res, 200, song.marks);
    }

    throw new HttpError(404, `未知接口 ${path}`);
  }

  // ── 静态资源 ────────────────────────────────────────────────────────────

  private async static(ctx: Ctx, path: string): Promise<void> {
    const { res } = ctx;
    const roots: Array<[string, string]> = [
      ['/audio/', this.options.dataRoot],
      ['/', this.options.webRoot],
    ];

    for (const [prefix, root] of roots) {
      if (!path.startsWith(prefix)) continue;

      // ⚠️ 必须解码：`url.pathname` 仍是百分号编码的。
      // 不解码的话，任何非 ASCII 文件名（例如全部中文的演出音频）
      // 都会找不到文件而回退到 index.html —— 表现为"播放器拿到一坨 HTML"。
      let rel: string;
      try {
        rel = decodeURIComponent(path.slice(prefix.length));
      } catch {
        continue; // 非法编码
      }
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';

      // 防目录穿越：规范化后必须仍在 root 之内。
      // 解码可能引入 `..` 或 `/`，因此这一步必须放在解码**之后**。
      const safe = normalize(rel).replace(/^(\.\.[/\\])+/, '');
      if (safe.includes('..')) continue;
      const full = resolve(join(root, safe));
      if (full !== resolve(root) && !full.startsWith(resolve(root) + '/')) continue;
      try {
        const info = await stat(full);
        if (!info.isFile()) continue;
        const data = await readFile(full);
        res.writeHead(200, {
          'Content-Type': contentType(full),
          'Content-Length': data.byteLength,
          // 演出期不希望浏览器缓存旧 UI
          'Cache-Control': 'no-store',
        });
        res.end(data);
        return;
      } catch {
        continue;
      }
    }
    // 单页应用回退：未匹配的非 API 路径交给 index.html
    try {
      const data = await readFile(join(this.options.webRoot, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('未找到资源');
    }
  }
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
};

function contentType(file: string): string {
  return MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
}
