/**
 * 连接诊断与音频库的测试。
 *
 * 诊断最重要的性质是**无副作用** —— 它会在演出前甚至演出中运行，
 * 绝不能改动 show 或输出。这里用"探测前后对比模拟器全量状态"来断言这一点。
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TitanSim } from '../src/titan-sim/server.ts';
import { TitanClient, diagnose } from '../src/titan/index.ts';
import { AppServer } from '../src/server/app.ts';

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

// ─────────────────────────────────────────────────────────────────────────

describe('连接诊断', () => {
  it('识别 Titan 16 并给出通过结论', async () => {
    const r = await diagnose(client);
    const v = r.checks.find((c) => c.name === 'Titan 版本');
    assert.equal(v?.status, 'ok');
    assert.match(v?.detail ?? '', /16/);
  });

  it('★ 实测出 levelDelta 的正确拼写', async () => {
    const r = await diagnose(client);
    // 模拟器刻意复现"小写 d 抛 LevelAdjust 错误"的真实行为，
    // 因此诊断应当判定为大写 D。
    assert.equal(r.levelDeltaSpelling, 'camel');
    const c = r.checks.find((x) => x.name.includes('levelDelta'));
    assert.match(c?.detail ?? '', /大写 D/);
  });

  it('发现批量句柄端点并枚举出分组名', async () => {
    const r = await diagnose(client);
    assert.ok(r.observedGroups.length > 0, '应观察到分组名');
    assert.ok(r.observedGroups.includes('Playbacks'));
    assert.ok(r.observedGroups.includes('Fixtures'));
  });

  it('★ 全程无副作用（诊断前后控台状态完全一致）', async () => {
    const fingerprint = (): string =>
      JSON.stringify({
        playbacks: [...sim.state.show.playbacks.values()]
          .map((p) => ({ id: p.titanId, active: p.active, level: p.level, legend: p.legend }))
          .sort((a, b) => a.id - b.id),
        palettes: [...sim.state.show.palettes.values()]
          .map((p) => ({ id: p.titanId, legend: p.legend }))
          .sort((a, b) => a.id - b.id),
        programmer: sim.state.show.programmer,
        showName: sim.state.show.showName,
        loadState: sim.state.show.loadState,
      });

    const before = fingerprint();
    const eventsBefore = sim.state.show.events.length;
    await diagnose(client);
    const after = fingerprint();

    assert.equal(after, before, '诊断不应改动任何 audio/输出/名称状态');
    // 允许有事件（读操作也会被记录），但不应有写类事件
    const newEvents = sim.state.show.events.slice(eventsBefore).map((e) => e.kind);
    const writes = newEvents.filter((k) => ['fire', 'kill', 'level', 'store', 'legend', 'create', 'page', 'set', 'latch', 'release'].includes(k));
    assert.deepEqual(writes, [], `诊断产生了写操作：${writes.join(', ')}`);
  });

  it('诊断报告结构完整', async () => {
    const r = await diagnose(client);
    assert.ok(r.checks.length >= 5);
    assert.equal(r.counts.ok + r.counts.warn + r.counts.fail + r.counts.skip, r.checks.length);
    assert.equal(r.baseUrl, client.baseUrl);
    for (const c of r.checks) {
      assert.ok(c.name.trim() !== '');
      assert.ok(c.detail.trim() !== '');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('音频库', () => {
  let app: AppServer;
  let base: string;
  let dataRoot: string;

  before(async () => {
    dataRoot = await mkdtemp(join(tmpdir(), 'bnds-audio-'));
    const webRoot = await mkdtemp(join(tmpdir(), 'bnds-web2-'));
    app = new AppServer({ port: 0, webRoot, dataRoot });
    base = (await app.listen()).url;
  });

  after(async () => {
    await app.close();
    await rm(dataRoot, { recursive: true, force: true });
  });

  it('空目录返回空列表（而不是报错）', async () => {
    const res = await fetch(`${base}/api/audio`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), []);
  });

  it('上传后出现在列表里', async () => {
    const data = Buffer.from('RIFFfake-audio-payload');
    const res = await fetch(`${base}/api/audio?filename=${encodeURIComponent('序曲.mp3')}`, {
      method: 'POST',
      body: data,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; filename: string; bytes: number };
    assert.equal(body.filename, '序曲.mp3');
    assert.equal(body.bytes, data.byteLength);

    const list = (await (await fetch(`${base}/api/audio`)).json()) as Array<{ filename: string }>;
    assert.deepEqual(list.map((f) => f.filename), ['序曲.mp3']);
  });

  it('上传后能经 /audio/ 播放（中文名 URL 编码往返）', async () => {
    const res = await fetch(`${base}/audio/${encodeURIComponent('序曲.mp3')}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /audio\/mpeg/);
    assert.match(await res.text(), /fake-audio-payload/);
  });

  it('拒绝非音频扩展名', async () => {
    const res = await fetch(`${base}/api/audio?filename=${encodeURIComponent('恶意.exe')}`, {
      method: 'POST',
      body: Buffer.from('x'),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /不是支持的音频格式/);
  });

  it('★ 上传文件名不能带路径（防写到 data/ 之外）', async () => {
    const res = await fetch(
      `${base}/api/audio?filename=${encodeURIComponent('../../evil.mp3')}`,
      { method: 'POST', body: Buffer.from('x') },
    );
    assert.equal(res.status, 200, '应成功，但只取基名');
    const body = (await res.json()) as { filename: string };
    assert.equal(body.filename, 'evil.mp3', '路径成分必须被剥离');
    // 确认文件落在了 dataRoot 内
    const list = (await (await fetch(`${base}/api/audio`)).json()) as Array<{ filename: string }>;
    assert.ok(list.some((f) => f.filename === 'evil.mp3'));
  });

  it('缺 filename 时报错', async () => {
    const res = await fetch(`${base}/api/audio`, { method: 'POST', body: Buffer.from('x') });
    assert.equal(res.status, 400);
  });

  it('空请求体被拒绝', async () => {
    const res = await fetch(`${base}/api/audio?filename=${encodeURIComponent('空.mp3')}`, {
      method: 'POST',
      body: Buffer.alloc(0),
    });
    assert.equal(res.status, 400);
  });

  it('可删除', async () => {
    const res = await fetch(`${base}/api/audio?filename=${encodeURIComponent('evil.mp3')}`, {
      method: 'DELETE',
    });
    assert.equal(res.status, 200);
    const list = (await (await fetch(`${base}/api/audio`)).json()) as Array<{ filename: string }>;
    assert.ok(!list.some((f) => f.filename === 'evil.mp3'));
  });
});
