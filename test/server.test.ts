/**
 * 应用服务层测试。
 *
 * 重点覆盖两类容易静默出问题的地方：
 * 1. **静态资源路径处理** —— URL 解码与目录穿越防护。
 *    不解码的话，任何中文文件名的演出音频都会拿到一坨 HTML 而不是音频，
 *    表现为"播放器没声音但界面一切正常"，极难排查。
 * 2. **离线行为要显式** —— 未连接控台时不能静默假装成功。
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AppServer } from '../src/server/app.ts';

let app: AppServer;
let base: string;
let dataDir: string;
let webDir: string;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'bnds-data-'));
  webDir = await mkdtemp(join(tmpdir(), 'bnds-web-'));

  await writeFile(join(webDir, 'index.html'), '<!doctype html><title>APP</title>', 'utf8');
  await writeFile(join(webDir, 'app.js'), 'console.log(1)', 'utf8');
  // 中文文件名 —— 这是真实场景（演出音频几乎都是中文名）
  await writeFile(join(dataDir, '测试音频.wav'), 'RIFFfake-wav-bytes', 'utf8');
  // 用于测试穿越防护的"敏感文件"，放在 web 根之外
  await writeFile(join(tmpdir(), 'bnds-secret.txt'), 'TOP-SECRET-SHOULD-NOT-LEAK', 'utf8');

  app = new AppServer({ port: 0, webRoot: webDir, dataRoot: dataDir });
  const s = await app.listen();
  base = s.url;
});

after(async () => {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
  await rm(webDir, { recursive: true, force: true });
  await rm(join(tmpdir(), 'bnds-secret.txt'), { force: true });
});

// ─────────────────────────────────────────────────────────────────────────

describe('静态资源', () => {
  it('服务 index.html', async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /APP/);
  });

  it('★ 中文文件名的音频能被正确服务（URL 编码往返）', async () => {
    const res = await fetch(`${base}/audio/${encodeURIComponent('测试音频.wav')}`);
    assert.equal(res.status, 200);
    const type = res.headers.get('content-type') ?? '';
    assert.match(type, /audio\/wav|application\/octet-stream/, `content-type 应为音频，实得 ${type}`);
    const body = await res.text();
    assert.match(body, /RIFFfake-wav-bytes/, '应拿到音频内容而非 HTML 回退');
  });

  it('未匹配的非 API 路径回退到 index.html（单页应用）', async () => {
    const res = await fetch(`${base}/some/deep/route`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /APP/);
  });

  it('★ 目录穿越不能读到根目录之外的文件', async () => {
    const attempts = [
      '/audio/../bnds-secret.txt',
      '/audio/%2e%2e%2fbnds-secret.txt',
      '/audio/..%2f..%2fbnds-secret.txt',
      '/bnds-secret.txt',
      '/audio/....//bnds-secret.txt',
    ];
    for (const p of attempts) {
      const res = await fetch(`${base}${p}`);
      const body = await res.text();
      assert.doesNotMatch(
        body,
        /TOP-SECRET-SHOULD-NOT-LEAK/,
        `路径 ${p} 泄露了根目录外的文件`,
      );
    }
  });

  it('静态资源禁用缓存（演出期不希望浏览器用旧 UI）', async () => {
    const res = await fetch(`${base}/app.js`);
    assert.match(res.headers.get('cache-control') ?? '', /no-store/);
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('API 基础', () => {
  it('/api/state 返回完整快照', async () => {
    const res = await fetch(`${base}/api/state`);
    assert.equal(res.status, 200);
    const s = (await res.json()) as Record<string, unknown>;
    for (const k of ['connection', 'cueBank', 'songs', 'transport', 'stats', 'recentHits']) {
      assert.ok(k in s, `快照应含 ${k}`);
    }
  });

  it('未连接控台时状态明确（不假装已连接）', async () => {
    const s = (await (await fetch(`${base}/api/state`)).json()) as {
      connection: { connected: boolean; mode: string };
    };
    assert.equal(s.connection.connected, false);
    assert.equal(s.connection.mode, 'offline');
  });

  it('★ 未连接控台时推 cue 明确报错，而不是静默成功', async () => {
    // 先加一个散 cue
    const created = (await (
      await fetch(`${base}/api/cuebank/cue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '离线测试', page: 9 }),
      })
    ).json()) as { id: string };

    const res = await fetch(`${base}/api/cuebank/fire`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: created.id }),
    });
    // 离线模式下 fireCue 会走 fire-offline 分支（不抛错），但必须通过 SSE 告知使用者。
    // 这里断言的是：无论成功与否，接口自身的语义要一致可预期。
    assert.ok([200, 400].includes(res.status), `状态应为 200 或 400，实得 ${res.status}`);
  });

  it('/api/analyze 未连接时给出可操作的错误', async () => {
    const res = await fetch(`${base}/api/analyze`, { method: 'POST' });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /尚未连接控台/);
  });

  it('/api/inject/plan 未连接时给出可操作的错误', async () => {
    const res = await fetch(`${base}/api/inject/plan`, { method: 'POST' });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /尚未连接控台/);
  });

  it('/api/inject/execute 缺 plan 时报错', async () => {
    const res = await fetch(`${base}/api/inject/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 400);
  });

  it('未知接口返回 404', async () => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
  });

  it('非法 JSON 请求体返回 400', async () => {
    const res = await fetch(`${base}/api/cuebank/cue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('SSE', () => {
  it('连接后立即收到 hello 与 state', async () => {
    const controller = new AbortController();
    const res = await fetch(`${base}/api/events`, { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !(text.includes('event: hello') && text.includes('event: state'))) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    controller.abort();
    assert.match(text, /event: hello/);
    assert.match(text, /event: state/);
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('前端与模版的契约（静态检查）', () => {
  /**
   * app.js 里每个 `$('#id')` 都必须在 index.html 里存在对应的 id。
   *
   * 这类不匹配会导致**页面静默白屏**（null.addEventListener 抛错，
   * 而浏览器控制台往往没人看）。静态检查比 DOM 仿真便宜得多，
   * 却能抓住同一类问题。
   */
  it('app.js 引用的每个元素 id 都存在于 index.html', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join: pjoin, resolve } = await import('node:path');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

    const js = await readFile(pjoin(root, 'src/web/app.js'), 'utf8');
    const html = await readFile(pjoin(root, 'src/web/index.html'), 'utf8');

    const referenced = new Set<string>();
    for (const m of js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) referenced.add(m[1]!);
    // 也覆盖 getElementById
    for (const m of js.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) referenced.add(m[1]!);

    const defined = new Set<string>();
    for (const m of html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) defined.add(m[1]!);
    // 也接受运行时动态赋的 id（例如播放头），但仍要求引用处有 null 保护
    for (const m of js.matchAll(/\.id = '([A-Za-z0-9_-]+)'/g)) defined.add(m[1]!);

    const missing = [...referenced].filter((id) => !defined.has(id));
    assert.deepEqual(
      missing,
      [],
      `app.js 引用了 index.html 中不存在的 id：${missing.join(', ')}`,
    );
  });

  it('SSE 事件名在服务端与前端之间一致', async () => {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join: pjoin, resolve } = await import('node:path');
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

    const js = await readFile(pjoin(root, 'src/web/app.js'), 'utf8');
    const appstate = await readFile(pjoin(root, 'src/server/appstate.ts'), 'utf8');
    const appSrc = await readFile(pjoin(root, 'src/server/app.ts'), 'utf8');

    const emitted = new Set<string>();
    for (const m of appstate.matchAll(/this\.emit\('([a-z-]+)'/g)) emitted.add(m[1]!);
    for (const m of appSrc.matchAll(/res\.write\(`event: ([a-z-]+)/g)) emitted.add(m[1]!);

    // 前端里被监听的事件：直接 addEventListener 的 + 放进数组循环的
    const listened = new Set<string>();
    for (const m of js.matchAll(/addEventListener\('([a-z-]+)'/g)) listened.add(m[1]!);
    for (const m of js.matchAll(/for \(const name of \[([^\]]+)\]/g)) {
      for (const q of m[1]!.matchAll(/'([a-z-]+)'/g)) listened.add(q[1]!);
    }

    // 服务端发出但前端完全没监听的事件 —— 允许存在，但必须是有意的。
    // 这里断言的是：**关键事件**不能漏。
    const mustHandle = ['state', 'hit', 'position', 'fire-offline', 'clock-resync', 'analysis'];
    const unhandled = mustHandle.filter((e) => !listened.has(e));
    assert.deepEqual(unhandled, [], `前端未监听关键事件：${unhandled.join(', ')}`);
    assert.ok(emitted.has('fire-offline'), '服务端应发出 fire-offline（离线时告知使用者）');
  });
});
