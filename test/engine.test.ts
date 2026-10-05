/**
 * 演出时钟与卡点调度器的测试。
 *
 * 这里用**注入的假单调时钟**做确定性验证 ——
 * 卡点精度是本项目最核心的指标，不能靠 sleep 去"大概测一下"。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ShowClock } from '../src/engine/showclock.ts';
import { Scheduler, type CueHit, type FireRequest } from '../src/engine/scheduler.ts';
import { effectiveTimeMs, formatTimestamp, parseTimestamp, type Song } from '../src/model/song.ts';

/** 可控的假单调时钟 */
function fakeMono() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (ms: number) => {
      t = ms;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────

describe('ShowClock', () => {
  it('未启动时停在锚点位置', () => {
    const mono = fakeMono();
    const c = new ShowClock({ mono: mono.now });
    assert.equal(c.now(), 0);
    c.start(1000);
    mono.advance(500);
    assert.equal(c.now(), 1500);
  });

  it('暂停后位置冻结，恢复后继续走', () => {
    const mono = fakeMono();
    const c = new ShowClock({ mono: mono.now });
    c.start(0);
    mono.advance(2000);
    c.pause();
    assert.equal(c.now(), 2000);
    mono.advance(5000); // 暂停期间的时间不应计入
    assert.equal(c.now(), 2000);
    c.resume();
    mono.advance(300);
    assert.equal(c.now(), 2300);
  });

  it('seek 立即跳转且不累积误差', () => {
    const mono = fakeMono();
    const c = new ShowClock({ mono: mono.now });
    c.start(0);
    mono.advance(1000);
    c.seek(30_000);
    assert.equal(c.now(), 30_000);
    mono.advance(250);
    assert.equal(c.now(), 30_250);
  });

  it('小偏差以渐进方式吸收，不跳变', () => {
    const mono = fakeMono();
    const c = new ShowClock({ mono: mono.now, hardResyncThresholdMs: 150, slewFactor: 0.15 });
    c.start(0);
    mono.advance(10_000);
    // 报告比预测早 100ms（在阈值内）
    const res = c.syncTo(9_900);
    assert.equal(res.hardResynced, false);
    assert.equal(res.driftMs, -100);
    // 只吸收了 15%，因此位置只微调，不会瞬间跳 100ms
    assert.equal(c.now(), 9_985);
  });

  it('大偏差触发硬重同步 —— 保准确优先', () => {
    const mono = fakeMono();
    const c = new ShowClock({ mono: mono.now, hardResyncThresholdMs: 150 });
    c.start(0);
    mono.advance(10_000);
    const res = c.syncTo(30_000); // 差了 20 秒（真实跳转/卡顿）
    assert.equal(res.hardResynced, true);
    assert.equal(c.now(), 30_000);
  });

  it('isFinished 依据时长判定', () => {
    const mono = fakeMono();
    const c = new ShowClock({ mono: mono.now });
    c.setDuration(5000);
    c.start(0);
    assert.equal(c.isFinished(), false);
    mono.advance(5000);
    assert.equal(c.isFinished(), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────

function makeSong(marks: Array<{ tMs: number; cueIds: string[]; note?: string }>): Song {
  return {
    id: 'song-1',
    name: '测试曲目',
    audioPath: '',
    durationMs: 60_000,
    offsetMs: 0,
    marks: marks.map((m, i) => ({
      id: `m${i + 1}`,
      tMs: m.tMs,
      cueIds: m.cueIds,
      level: 1,
      ...(m.note !== undefined ? { note: m.note } : {}),
    })),
  };
}

describe('Scheduler', () => {
  function setup() {
    const mono = fakeMono();
    const clock = new ShowClock({ mono: mono.now });
    const fired: FireRequest[] = [];
    const hits: CueHit[] = [];
    const scheduler = new Scheduler({
      clock,
      fire: async (req) => {
        fired.push(req);
      },
      onHit: (h) => hits.push(h),
    });
    return { mono, clock, fired, hits, scheduler };
  }

  it('按时刻触发对应散 cue', async () => {
    const { mono, clock, fired, scheduler } = setup();
    scheduler.load(makeSong([{ tMs: 1000, cueIds: ['c1'] }, { tMs: 2000, cueIds: ['c2'] }]));
    clock.start(0);

    await scheduler.tick(); // t=0，无事发生
    assert.equal(fired.length, 0);

    mono.advance(1000);
    await scheduler.tick();
    assert.deepEqual(fired.map((f) => f.cueId), ['c1']);

    mono.advance(1000);
    await scheduler.tick();
    assert.deepEqual(fired.map((f) => f.cueId), ['c1', 'c2']);
  });

  it('一个卡点可同时推多个 cue（散 cue 的灵活性）', async () => {
    const { mono, clock, fired, scheduler } = setup();
    scheduler.load(makeSong([{ tMs: 500, cueIds: ['面光', '侧光'] }]));
    clock.start(0);
    mono.advance(500);
    await scheduler.tick();
    assert.deepEqual(fired.map((f) => f.cueId), ['面光', '侧光']);
  });

  it('一次 tick 补发所有已到时刻的卡点，不丢拍', async () => {
    const { mono, clock, fired, scheduler } = setup();
    scheduler.load(
      makeSong([
        { tMs: 100, cueIds: ['a'] },
        { tMs: 200, cueIds: ['b'] },
        { tMs: 300, cueIds: ['c'] },
      ]),
    );
    clock.start(0);
    // 模拟一次长阻塞：直接跳到 350ms 才 tick
    mono.advance(350);
    await scheduler.tick();
    assert.deepEqual(fired.map((f) => f.cueId), ['a', 'b', 'c']);
  });

  it('记录触发偏差，供复盘统计', async () => {
    const { mono, clock, hits, scheduler } = setup();
    scheduler.load(makeSong([{ tMs: 1000, cueIds: ['c1'] }]));
    clock.start(0);
    mono.advance(1012); // 晚了 12ms
    await scheduler.tick();
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.scheduledMs, 1000);
    assert.equal(hits[0]?.latenessMs, 12);
  });

  it('暂停时不触发', async () => {
    const { mono, clock, fired, scheduler } = setup();
    scheduler.load(makeSong([{ tMs: 500, cueIds: ['c1'] }]));
    clock.start(0);
    clock.pause();
    mono.advance(10_000);
    await scheduler.tick();
    assert.equal(fired.length, 0);
  });

  it('seek 向前不补触已过时刻的卡点（避免灯光乱闪）', async () => {
    const { clock, fired, scheduler } = setup();
    scheduler.load(
      makeSong([
        { tMs: 1000, cueIds: ['a'] },
        { tMs: 5000, cueIds: ['b'] },
      ]),
    );
    clock.start(0);
    scheduler.seek(3000); // 跳过 a
    await scheduler.tick();
    assert.equal(fired.length, 0);

    clock.seek(5000);
    await scheduler.tick();
    assert.deepEqual(fired.map((f) => f.cueId), ['b']);
  });

  it('seek 回退后重新武装', async () => {
    const { mono, clock, fired, scheduler } = setup();
    scheduler.load(makeSong([{ tMs: 1000, cueIds: ['a'] }]));
    clock.start(0);
    mono.advance(1000);
    await scheduler.tick();
    assert.equal(fired.length, 1);

    scheduler.seek(0);
    clock.seek(0);
    mono.advance(1000);
    await scheduler.tick();
    assert.equal(fired.length, 2, '回退后应当能再次触发');
  });

  it('人工触发不计入调度偏差统计（否则会污染"卡点精度"指标）', async () => {
    const { mono, clock, scheduler, fired } = setup();
    scheduler.load(makeSong([{ tMs: 1000, cueIds: ['a'] }]));
    clock.start(0);

    await scheduler.fireManual('临时散射光', 0.8, undefined, '演员临时走位');
    mono.advance(1000);
    await scheduler.tick();

    const stats = scheduler.stats();
    assert.equal(stats.count, 1, '只有自动触发计入精度统计');
    assert.equal(stats.manualCount, 1);
    assert.deepEqual(fired.map((f) => f.cueId), ['临时散射光', 'a']);
  });

  it('统计能算出 ±20ms / ±50ms 命中率', async () => {
    const { mono, clock, scheduler } = setup();
    scheduler.load(
      makeSong([
        { tMs: 100, cueIds: ['a'] },
        { tMs: 200, cueIds: ['b'] },
        { tMs: 300, cueIds: ['c'] },
      ]),
    );
    clock.start(0);
    mono.advance(110);
    await scheduler.tick(); // a: +10ms
    mono.advance(125);
    await scheduler.tick(); // b: 235-200 = +35ms
    mono.advance(105);
    await scheduler.tick(); // c: 340-300 = +40ms

    const stats = scheduler.stats();
    assert.equal(stats.count, 3);
    assert.equal(stats.within20ms, 1);
    assert.equal(stats.within50ms, 3);
    assert.equal(stats.maxLatenessMs, 40);
  });

  it('单个 cue 触发失败不影响后续卡点', async () => {
    const mono = fakeMono();
    const clock = new ShowClock({ mono: mono.now });
    const fired: string[] = [];
    const errors: unknown[] = [];
    const scheduler = new Scheduler({
      clock,
      fire: async (req) => {
        if (req.cueId === 'bad') throw new Error('该句柄不存在');
        fired.push(req.cueId);
      },
      onError: (e) => errors.push(e),
    });
    scheduler.load(makeSong([{ tMs: 100, cueIds: ['bad', 'good'] }]));
    clock.start(0);
    mono.advance(100);
    await scheduler.tick();

    assert.deepEqual(fired, ['good']);
    assert.equal(errors.length, 1);
  });

  it('peekNext 供 UI 预告下一个卡点', () => {
    const { clock, scheduler } = setup();
    scheduler.load(makeSong([{ tMs: 5000, cueIds: ['a'], note: '副歌' }]));
    clock.start(0);
    const next = scheduler.peekNext();
    assert.equal(next?.tMs, 5000);
    assert.equal(next?.note, '副歌');
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe('曲目与时间戳', () => {
  it('整曲偏移作用于有效时刻', () => {
    const song = makeSong([{ tMs: 1000, cueIds: ['a'] }]);
    song.offsetMs = 40;
    assert.equal(effectiveTimeMs(song, song.marks[0]!), 1040);
  });

  it('解析 mm:ss.mmm / hh:mm:ss.mmm / 秒 / 毫秒', () => {
    assert.equal(parseTimestamp('01:23.480'), 83_480);
    assert.equal(parseTimestamp('1:02:03.500'), 3_723_500);
    assert.equal(parseTimestamp('12.5'), 12_500);
    assert.equal(parseTimestamp('2500'), 2500);
  });

  it('解析时间码 HH:MM:SS:FF', () => {
    assert.equal(parseTimestamp('00:00:01:00', 25), 1000);
    assert.equal(parseTimestamp('00:00:01:12', 25), 1480);
  });

  it('格式化为 mm:ss.mmm', () => {
    assert.equal(formatTimestamp(83_480), '01:23.480');
    assert.equal(formatTimestamp(0), '00:00.000');
  });

  it('非法输入返回 null', () => {
    assert.equal(parseTimestamp(''), null);
    assert.equal(parseTimestamp('abc'), null);
  });
});
