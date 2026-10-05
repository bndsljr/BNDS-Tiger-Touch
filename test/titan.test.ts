/**
 * titan-client 与 titan-sim 的基础测试。
 *
 * 这些测试的首要目的不是覆盖率，而是**锁定已核实的陷阱**：
 * 任何一条被"优化"掉的修正都会立刻让测试变红。
 * 次要目的是给 CI 一个不依赖真控台的基线。
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { TitanSim } from '../src/titan-sim/server.ts';
import {
  Handles,
  Playbacks,
  TitanClient,
  TitanConsoleError,
  encodeParams,
  formatTimecodeTime,
  handleList,
  level,
  levelDelta,
  msToTimecode,
  parseTimecodeTime,
  timecodeToMs,
} from '../src/titan/index.ts';

let sim: TitanSim;
let base: string;

before(async () => {
  sim = new TitanSim({ port: 0, logRequests: true });
  const s = await sim.listen();
  base = s.url;
});

after(async () => {
  await sim.close();
});

const client = (): TitanClient => new TitanClient({ baseUrl: base });

/** 取模拟器中第一个 playback 的真实 titanId —— 避免测试里硬编码 id。 */
const firstPlaybackTitanId = (): number => {
  const first = [...sim.state.show.playbacks.values()][0];
  assert.ok(first, '模拟器应预置至少一个 playback');
  return first.titanId;
};

// ─────────────────────────────────────────────────────────────────────────

describe('传输层', () => {
  it('能读取版本与 show 名', async () => {
    const c = client();
    assert.equal(await c.softwareVersion(), '16.0');
    assert.equal(await c.get('Show', 'ShowName'), 'Sim Demo Show');
  });

  it('版本门禁：匹配时通过', async () => {
    assert.equal(await client().assertVersion(16), '16.0');
  });

  it('版本门禁：不匹配时给出可操作的错误', async () => {
    await assert.rejects(
      () => client().assertVersion(15),
      (e: Error) => {
        assert.match(e.message, /最高只能到 15\.1|15\.x/);
        return true;
      },
    );
  });

  it('要求 /2/ 路径段：不带 /2/ 一律 400', async () => {
    const res = await fetch(`${base}/titan/get/System/SoftwareVersion`);
    assert.equal(res.status, 400);
  });

  it('void 方法返回空 body（不是 JSON）', async () => {
    const res = await fetch(`${base}/titan/script/2/Playbacks/KillAllPlaybacks`);
    assert.equal(res.status, 200);
    assert.equal((await res.text()).trim(), '');
  });

  it('业务错误是 HTTP 200 + 纯文本 Error:（忠实复现真实控台）', async () => {
    const res = await fetch(`${base}/titan/script/2/Playbacks/NoSuchMethod`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /^Error: /);
  });

  it('HTTP 层面畸形才返回 400', async () => {
    assert.equal((await fetch(`${base}/titan/get/System/SoftwareVersion`)).status, 400);
    assert.equal((await fetch(`${base}/titan/script/2/Playbacks`)).status, 400);
  });

  it('probe() 结构化返回而不抛错', async () => {
    const ok = await client().probe();
    assert.equal(ok.ok, true);
    const bad = await new TitanClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 500 }).probe();
    assert.equal(bad.ok, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('💣 levelDelta 大小写地雷', () => {
  it('客户端默认发大写 D 的 levelDelta', () => {
    const q = encodeParams({ srcHandle: { handle: { titanId: 1000 } }, level: levelDelta(0.2) });
    assert.equal(q['level_levelDelta'], '0.2');
    assert.equal(q['level_leveldelta'], undefined);
  });

  it('大写 D 在控台侧被接受', async () => {
    const id = firstPlaybackTitanId();
    const res = await fetch(
      `${base}/titan/script/2/Playbacks/SetPlaybackLevel?srcHandle_titanId=${id}&level_levelDelta=0.2`,
    );
    assert.equal(res.status, 200);
    assert.doesNotMatch(await res.text(), /^Error/);
  });

  it('小写 d 会被拒绝（复现真实控台行为）—— 证明这不是无害的拼写差异', async () => {
    const id = firstPlaybackTitanId();
    const res = await fetch(
      `${base}/titan/script/2/Playbacks/SetPlaybackLevel?srcHandle_titanId=${id}&level_leveldelta=0.2`,
    );
    assert.match(await res.text(), /LevelAdjust/);
  });

  it('可显式回退到官方语料字面写法（供真机实测用）', () => {
    const q = encodeParams(
      { level: levelDelta(0.2) },
      { levelDeltaSpelling: 'lower' },
    );
    assert.equal(q['level_leveldelta'], '0.2');
  });

  it('绝对值走 _level 后缀', () => {
    assert.equal(encodeParams({ level: level(0.5) })['level_level'], '0.5');
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('句柄寻址', () => {
  it('三种显式后缀各自编码正确', () => {
    assert.deepEqual(encodeParams({ handle: { handle: { titanId: 1895 } } }), {
      handle_titanId: '1895',
    });
    assert.deepEqual(encodeParams({ handle: { handle: { userNumber: 6 } } }), {
      handle_userNumber: '6',
    });
    assert.deepEqual(
      encodeParams({ handle: { handle: { location: { group: 'Playbacks', page: 2, index: 1 } } } }),
      { handle_location: 'Playbacks_2_1' },
    );
  });

  it('句柄列表不混用 titanId 与 userNumber', () => {
    assert.deepEqual(encodeParams({ handles: handleList([{ titanId: 1 }, { titanId: 2 }]) }), {
      handleList_handleList: '1,2',
    });
    assert.throws(() => encodeParams({ handles: handleList([{ titanId: 1 }, { userNumber: 2 }]) }));
  });

  it('缺省 handle= 遇到 location 会报 AcwUserNumber 解析错误（真实行为）', async () => {
    const res = await fetch(
      `${base}/titan/script/2/Playbacks/KillPlayback?handle=Playbacks_1_1`,
    );
    assert.match(await res.text(), /AcwUserNumber/);
  });

  it('Handles.GetGroup 回读分组名 —— 官方 bootstrap', async () => {
    const h = new Handles(client());
    const group = await h.getGroup({ userNumber: 1 });
    assert.equal(group, 'Playbacks');
  });

  it('裸路径无 `/2/` 或成员不完整时返回 400', async () => {
    assert.equal((await fetch(`${base}/titan/script/Playbacks/KillAllPlaybacks`)).status, 400);
    assert.equal((await fetch(`${base}/titan/script/2/Playbacks`)).status, 400);
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('散 cue 的触发 / 熄灭（operate —— 本项目核心）', () => {
  it('按 userNumber 触发并读到激活状态', async () => {
    const pb = new Playbacks(client());
    await pb.fireAtLevel({ userNumber: 1 }, 1);
    const state = sim.state.findPlaybackByUserNumber(1);
    assert.equal(state?.active, true);
    assert.equal(state?.level, 1);
  });

  it('alwaysRefire 会先熄灭再触发', async () => {
    const pb = new Playbacks(client());
    await pb.fireAtLevel({ userNumber: 2 }, 1);
    await pb.fireAtLevel({ userNumber: 2 }, 0.5, true);
    const state = sim.state.findPlaybackByUserNumber(2);
    assert.equal(state?.level, 0.5);
    assert.equal(state?.active, true);
  });

  it('熄灭后不再激活', async () => {
    const pb = new Playbacks(client());
    await pb.fireAtLevel({ userNumber: 3 }, 1);
    await pb.kill({ userNumber: 3 });
    assert.equal(sim.state.findPlaybackByUserNumber(3)?.active, false);
  });

  it('KillAll 熄灭全部 —— 演出紧急操作', async () => {
    const pb = new Playbacks(client());
    await pb.fireAtLevel({ userNumber: 1 }, 1);
    await pb.fireAtLevel({ userNumber: 4 }, 1);
    await pb.killAll();
    const anyActive = [...sim.state.show.playbacks.values()].some((p) => p.active);
    assert.equal(anyActive, false);
  });

  it('读到 cue 结构（元数据可读，数值不可读）', async () => {
    const pb = new Playbacks(client());
    const ids = await pb.getCueIds({ userNumber: 1 });
    assert.equal(ids.length, 1);
    assert.equal(await pb.doesCueExist({ userNumber: 1 }, 1), true);
    assert.equal(await pb.doesCueExist({ userNumber: 1 }, 99), false);
  });

  it('SetCueLegend 显式寻址，无需上下文', async () => {
    const pb = new Playbacks(client());
    await pb.setCueLegend({ userNumber: 4 }, 1, '谢幕');
    assert.equal(sim.state.findPlaybackByUserNumber(4)?.legend, '谢幕');
  });

  it('可校验候选分组名再录制', async () => {
    const pb = new Playbacks(client());
    assert.equal(await pb.isAllowedGroup('Playbacks'), true);
    assert.equal(await pb.isAllowedGroup('Colours'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('时间码', () => {
  it('线格式是 HH:MM:SS:FF（四段，已核实）', () => {
    assert.equal(
      formatTimecodeTime({ hours: 11, minutes: 22, seconds: 33, frames: 44 }),
      '11:22:33:44',
    );
    assert.deepEqual(parseTimecodeTime('11:22:33:44'), {
      hours: 11,
      minutes: 22,
      seconds: 33,
      frames: 44,
    });
  });

  it('段数不是 4 就报错（对应文档把格式藏成 time={} 的缺陷）', () => {
    assert.throws(() => parseTimecodeTime('00:01:02'));
    assert.throws(() => parseTimecodeTime('1:2:3:4:5'));
  });

  it('毫秒 ↔ 时间码往返（25fps）', () => {
    assert.equal(msToTimecode(0, 25), '00:00:00:00');
    assert.equal(msToTimecode(1000, 25), '00:00:01:00');
    assert.equal(msToTimecode(12_480, 25), '00:00:12:12');
    assert.equal(timecodeToMs('00:00:12:12', 25), 12_480);
  });

  it('分秒越界被拒绝', () => {
    assert.throws(() => formatTimecodeTime({ hours: 0, minutes: 60, seconds: 0, frames: 0 }));
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('错误对象', () => {
  it('控台报错被识别为 TitanConsoleError', async () => {
    await assert.rejects(
      () => client().call('Playbacks', 'NoSuchMethod'),
      (e: unknown) => e instanceof TitanConsoleError,
    );
  });
});
