/**
 * Titan WebAPI 模拟器 —— 一个真实控台的替身。
 *
 * 目标不是"实现整个 Titan"，而是**忠实复现我们依赖的那部分行为**，
 * 包括反直觉之处（错误契约、大小写陷阱、无推送）。
 *
 * 任何未实现的方法都返回明确的 `Error:` —— 而不是静默成功，
 * 这样开发期就能立刻发现"我们用了模拟器没覆盖的方法"。
 *
 * 已刻意复现的真实行为：
 * - `/2/` 路径段是强制的（不带 `/2/` 一律 400）
 * - `void` 方法返回**空 body**，不是 JSON
 * - 错误是**纯文本** `Error: <消息>`，HTTP 状态仍是 200
 * - 小写 `leveldelta` **抛类型转换错误**（用于验证客户端的修正是否生效）
 * - `handle=` 缺省被当作 **userNumber**，遇 location 抛 `AcwUserNumber` 解析错误
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { HANDLE_GROUPS } from '../titan/handles.ts';
import {
  SimState,
  makeSimCue,
  makeSimPlayback,
  type SimOptions,
  type SimPlayback,
} from './state.ts';

export interface SimServerOptions extends SimOptions {
  port?: number;
  host?: string;
  /** 打印每个请求 —— 开发期用来对照客户端实际发出的 URL。 */
  logRequests?: boolean;
}

interface Route {
  kind: 'get' | 'set' | 'script';
  /** `get:2` 之后的完整成员路径，如 `Playbacks/FirePlaybackAtLevel` */
  member: string;
  query: URLSearchParams;
}

export class TitanSim {
  readonly state: SimState;
  private server: Server | null = null;
  private readonly logRequests: boolean;
  private readonly options: SimServerOptions;
  private requestLog: string[] = [];

  constructor(options: SimServerOptions = {}) {
    this.options = options;
    this.state = new SimState(options);
    this.logRequests = options.logRequests ?? false;
  }

  get recentRequests(): readonly string[] {
    return this.requestLog;
  }

  async listen(): Promise<{ port: number; url: string }> {
    const port = this.options.port ?? 4500;
    const host = this.options.host ?? '127.0.0.1';
    this.server = createServer((req, res) => {
      void this.handle(req, res);
    });
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve));
    const addr = this.server.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    return { port: actualPort, url: `http://${host}:${actualPort}` };
  }

  async close(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve, reject) => srv.close((err) => (err ? reject(err) : resolve())));
  }

  // ── HTTP 层 ─────────────────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const logLine = `${req.method} ${url.pathname}${url.search}`;
    if (this.logRequests) {
      this.requestLog.push(logLine);
      if (this.requestLog.length > 500) this.requestLog.shift();
    }

    // `/titan/handles` —— 仅见于过时 Introduction 页，16.0 参考中零命中。
    // 实现它以便探测"是否仍存在"，但客户端不应依赖。
    if (pathname === '/titan/handles' || pathname.startsWith('/titan/handles/')) {
      return json(res, this.state.allHandles());
    }

    const route = matchRoute(pathname, url.searchParams);
    if (!route) {
      return badRequest(res, `Unrecognised request path '${pathname}'`);
    }

    try {
      let out: unknown;
      if (route.kind === 'get') out = this.doGet(route.member);
      else if (route.kind === 'set') out = this.doSet(route.member, await readBody(req));
      else out = this.doScript(route);
      return emit(res, out);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.state.log('error', `${logLine} -> ${msg}`);
      // 忠实复现真实控台：**请求形状合法但业务/类型报错时 HTTP 仍是 200**，
      // 错误以纯文本 `Error: …` 放在响应体里。
      // 只有 HTTP 层面畸形（路径不匹配 API 形状）才 400 —— 见 matchRoute 分支。
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`Error: ${msg}`);
      return;
    }
  }

  // ── GET 属性 ────────────────────────────────────────────────────────────

  private doGet(member: string): unknown {
    const s = this.state;
    switch (member) {
      case 'System/SoftwareVersion':
        return s.version;
      case 'Show/ShowName':
        return s.show.showName;
      case 'Show/LoadState':
        return s.show.loadState;
      case 'Show/FileExists':
        return 'False';
      case 'Programmer/BlindActive':
        return s.show.programmer.blindActive ? 'True' : 'False';
      case 'Programmer/InABMode':
        return 'False';
      case 'Timecode/Context/LiveTime':
        return '00:00:00:00';
      case 'Timecode/Context/Source':
        return 'Internal';
      case 'Timecode/Context/FrameRate':
        return '25';
      case 'Timecode/Context/Paused':
        return 'True';
      case 'Timecode/Enabled':
        return 'False';
      case 'Masters/GrandMasterOutputLevel':
        return '1';
      case 'Masters/IsDeskBlackedOut':
        return 'False';
      case 'Titan/StartState':
        return 'Running';
      case 'Titan/ActiveSessionId':
        return '1';
      case 'Playbacks/RecordMode':
        return 'RecordByFixture';
      case 'Playbacks/PlaybackRecordType':
        return 'Memory';
      case 'SetList/ActiveTrack':
        return '0';
      case 'Playbacks/TimesEdit/PlaybackName':
        return '';
      // ── `Playbacks/Editor/Times/*` ────────────────────────────────────
      //
      // 这些是读取 cue 元数据的**唯一**路径。全部是单例作用域：
      // 读到的是"当前上下文 cue"（由 TimesEdit/CueNumber + FillTimes 设定）。
      //
      // ⚠️ 单位存疑：真实控台返回的 fade/delay 是**秒**还是**毫秒**，文档未说明。
      // 本模拟器返回**秒**（如 "3.0"），与 Titan 界面观感一致；
      // 客户端按"能解析成小数即视为秒"处理，并把原始字符串保留在诊断信息里。
      // 连真控台时须实测（列入 §10.1 验证清单）。
      case 'Playbacks/Editor/Times/CueLegend':
        return this.timesProp((c) => c.legend) ?? '';
      case 'Playbacks/Editor/Times/CueFadeInTime':
        return this.timesProp((c) => secs(c.fadeInMs)) ?? '0';
      case 'Playbacks/Editor/Times/CueFadeOutTime':
        return this.timesProp((c) => secs(c.fadeOutMs)) ?? '0';
      case 'Playbacks/Editor/Times/CueDelayInTime':
        return this.timesProp((c) => secs(c.delayMs)) ?? '0';
      case 'Playbacks/Editor/Times/CueDelayOutTime':
        return this.timesProp((c) => secs(c.delayOutMs)) ?? '0';
      case 'Playbacks/Editor/Times/CueLink':
        return this.timesProp((c) => (c.link ? 'True' : 'False')) ?? 'False';
      case 'Playbacks/Editor/Times/CueLinkOffset':
        return this.timesProp((c) => secs(c.linkOffsetMs)) ?? '0';
      case 'Playbacks/Editor/Times/CueLinkOffsetType':
        return 'WaitForGo';
      case 'Playbacks/Editor/Times/CueMoveInDark':
        return this.timesProp((c) => (c.moveInDark ? 'True' : 'False')) ?? 'False';
      case 'Playbacks/Editor/Times/CueTracking':
        return this.timesProp((c) => c.tracking) ?? 'Global';
      case 'Playbacks/Editor/Times/CueNotes':
        return this.timesProp((c) => c.notes) ?? '';
      case 'Playbacks/Editor/Times/CueMode':
        return 'Cue';
      case 'Playbacks/Editor/Times/CuePreload':
        return 'False';
      case 'Playbacks/Editor/Times/CueCurve':
        return 'Line';
      case 'Playbacks/Editor/Times/CueSpeedMultiplier':
        return '1';
      case 'Playbacks/Editor/Times/CueFixtureOverlap':
        return '100';
      case 'Playbacks/Editor/Times/PlaybackReleaseTime': {
        // playback 级属性，不依赖 cue 上下文
        const { playbackTitanId } = this.state.timesEdit;
        const pb = playbackTitanId === null ? null : this.state.show.playbacks.get(playbackTitanId);
        return secs(pb?.releaseTimeMs ?? 0);
      }
      case 'Playbacks/Editor/Times/PlaybackSpeed':
        return '1';
      case 'Playbacks/Editor/Times/Disabled':
        return 'False';
      case 'Playbacks/Editor/Times/ActiveControlTime':
        return 'CueFadeInTime';
      case 'Playbacks/Editor/Times/AttributeList':
        return '';
      case 'Playbacks/Editor/Times/CaptionText':
        return '';
      default:
        throw new Error(
          `Simulator 未实现属性 ${member}。` +
            `若项目需要该能力，请在 src/titan-sim/server.ts 的 doGet 中补充。`,
        );
    }
  }

  // ── SET 属性 ────────────────────────────────────────────────────────────

  private doSet(member: string, rawBody: string): unknown {
    // 真实行为：body 是裸值。Titan 接受 True/False（首字母大写）。
    const value = rawBody.trim().replace(/^"|"$/g, '');
    const asBool = /^(true|1)$/i.test(value);

    switch (member) {
      case 'Programmer/BlindActive':
        this.state.show.programmer.blindActive = asBool;
        this.state.log('set', `BlindActive=${String(asBool)}`);
        return null;
      case 'Show/ShowName':
        this.state.show.showName = value;
        return null;
      case 'Show/SaveShowName':
        // 真实语义：只是"拟定的保存名"，**不落盘**
        this.state.log('set', `SaveShowName -> ${value}（仅拟定，未落盘）`);
        return null;
      case 'Playbacks/TimesEdit/CueNumber': {
        // 时间是"选中哪个 cue"的上下文设置，后续 FillTimes 会补齐 playback
        const n = Number(value);
        if (!Number.isFinite(n)) throw new Error(`Failed to parse value '${value}' to Single`);
        this.state.timesEdit.cueNumber = n;
        return null;
      }
      case 'Timecode/Enabled':
        return null;
      default:
        throw new Error(
          `Simulator 未实现 set ${member}（收到「${value}」）。` +
            `注意：真实 API 的 set **无法写句柄类型的属性**。`,
        );
    }
  }

  // ── SCRIPT 方法 ─────────────────────────────────────────────────────────

  private doScript(route: Route): unknown {
    const { member, query } = route;
    const q = (name: string): string | undefined => query.get(name) ?? undefined;

    switch (member) {
      // ── 句柄自省 ──────────────────────────────────────────────────────
      case 'Handles/GetGroup': {
        const id = this.requireHandleTitanId(query);
        return this.state.groupOfHandle(id);
      }
      case 'Handles/GetPath': {
        const id = this.requireHandleTitanId(query);
        const pb = this.state.findPlaybackByTitanId(id);
        if (pb) return `${pb.group}/${pb.page}/${pb.index}`;
        return this.state.groupOfHandle(id);
      }
      case 'Handles/GetTitanIdFromHandle': {
        const id = this.requireHandleTitanId(query);
        return String(id);
      }
      case 'Handles/IsAllowedGroup':
        return ['Playbacks', 'StaticPlaybacks', 'RollerA', 'RollerB'].includes(q('groupName') ?? '')
          ? 'True'
          : 'False';
      case 'Handles/IsClaimed':
        return 'False';

      // ── 散 cue 的触发 / 熄灭 ─────────────────────────────────────────
      case 'Playbacks/FirePlaybackAtLevel': {
        // 先绑定参数再解析句柄 —— 真实控台在参数类型转换失败时不会进入业务逻辑
        const level = this.readLevel(query, 'level');
        const alwaysRefire = isTrue(q('alwaysRefire'));
        const pb = this.resolvePlayback(query, 'handle');
        if (alwaysRefire && pb.active) {
          pb.active = false;
          pb.level = -1;
        }
        pb.active = true;
        pb.paused = false;
        pb.level = level;
        this.state.log('fire', `${pb.legend} (titanId=${pb.titanId}) @ ${(level * 100).toFixed(0)}%`);
        return null;
      }
      case 'Playbacks/SetPlaybackLevel': {
        const newLevel = this.readLevel(query, 'level');
        const pb = this.resolvePlayback(query, 'srcHandle');
        pb.level = newLevel;
        if (pb.level > 0) pb.active = true;
        this.state.log('level', `${pb.legend} -> ${(pb.level * 100).toFixed(0)}%`);
        return null;
      }
      case 'Playbacks/KillPlayback': {
        const pb = this.resolvePlayback(query, 'handle');
        pb.active = false;
        pb.level = -1;
        this.state.log('kill', `${pb.legend} (titanId=${pb.titanId})`);
        return null;
      }
      case 'Playbacks/ReleasePlayback': {
        const pb = this.resolvePlayback(query, 'handle');
        pb.active = false;
        pb.level = -1;
        this.state.log('release', `${pb.legend}`);
        return null;
      }
      case 'Playbacks/KillAllPlaybacks': {
        for (const pb of this.state.show.playbacks.values()) {
          pb.active = false;
          pb.level = -1;
        }
        this.state.log('kill', 'KillAllPlaybacks');
        return null;
      }
      case 'Playbacks/ReleaseAllPlaybacksByPriority':
        return null;
      case 'Playbacks/ToggleLatchPlayback': {
        const pb = this.resolvePlayback(query, 'handle');
        pb.active = !pb.active;
        pb.level = pb.active ? 1 : -1;
        this.state.log('latch', `${pb.legend} -> ${pb.active ? 'on' : 'off'}`);
        return null;
      }
      case 'Playbacks/FlashPlayback':
      case 'Playbacks/FlashTimedPlayback':
        return null;

      // ── 读取散 cue 结构 ───────────────────────────────────────────────
      case 'Playbacks/GetPlaybackCueIds': {
        const pb = this.resolvePlayback(query, 'playback');
        return pb.cues.map((c) => c.cueId);
      }
      case 'Playbacks/GetPlaybackCueHandles': {
        const pb = this.resolvePlayback(query, 'playback');
        return pb.cues.map((c) => c.cueId);
      }
      case 'Playbacks/DoesCueExist': {
        const pb = this.resolvePlayback(query, 'handle');
        const num = Number(q('cueNumber'));
        return pb.cues.some((c) => c.cueNumber === num) ? 'True' : 'False';
      }
      case 'Playbacks/GetPlaybackCueId': {
        const pb = this.resolvePlayback(query, 'handle');
        const num = Number(q('cueNumber'));
        const cue = pb.cues.find((c) => c.cueNumber === num);
        return String(cue ? cue.cueId : -1);
      }
      case 'Playbacks/GetNextStepHint': {
        const pb = this.resolvePlayback(query, 'playbackHandle');
        return String(pb.cues.length + 1);
      }
      case 'Playbacks/IsCueHandle':
        return 'True';

      // ── 读取 cue 元数据的唯一路径（文档所限） ─────────────────────────
      //
      // ⚠️ 忠实复现真实 API 的两个难用之处：
      //  1. `Playbacks/Editor/Times/*` 是**单例作用域**属性，读的是"当前上下文 cue"。
      //     导出一条完整 cue list 必须循环：设 CueNumber → FillTimes → 读属性。
      //     复杂度 O(cues) 次 HTTP 往返。
      //  2. 这个循环**会改动控台操作员的 UI 状态**（移动其时间编辑器选中项）。
      case 'Playbacks/TimesEdit/FillTimes': {
        const pb = this.resolvePlayback(query, 'handle');
        if (this.state.timesEdit.cueNumber === null && pb.cues.length > 0) {
          this.state.timesEdit.cueNumber = pb.cues[0]!.cueNumber;
        }
        this.state.timesEdit.playbackTitanId = pb.titanId;
        return null;
      }
      case 'Playbacks/Editor/GetLiveCue': {
        const pb = this.resolvePlayback(query, 'handle');
        const live = pb.cues.find((c) => c.cueNumber === 1) ?? pb.cues[0];
        return live ? String(live.cueId) : '0';
      }
      case 'Playbacks/GetPlaybackHandle': {
        const id = Number(q('playbackId'));
        const pb = this.state.show.playbacks.get(id);
        if (!pb) throw new Error(`No playback with id '${id}'`);
        return String(pb.titanId);
      }

      // ── 录制散 cue（依赖 programmer） ─────────────────────────────────
      case 'Playbacks/StoreCue': {
        const group = q('group') ?? '';
        const index = Number(q('index'));
        const updateOnly = isTrue(q('updateOnly'));
        const pb = this.state.findPlaybackByLocation(group, 1, index);
        if (!pb) throw new Error(`No handle in group '${group}' with index '${index}'`);

        const values = { ...this.state.show.programmer.values };
        if (updateOnly) {
          const last = pb.cues.at(-1);
          if (!last) throw new Error('updateOnly 但该 playback 没有任何 cue');
          last.values = { ...last.values, ...values };
          this.state.log('update', `${pb.legend} 更新 cue ${last.cueNumber}`);
          return last.cueId;
        }
        const cueNumber = pb.cues.length + 1;
        const cue = makeSimCue(cueNumber, pb.legend, { values });
        pb.cues.push(cue);
        this.state.log('store', `${pb.legend} 录制 cue ${cueNumber}`);
        return cue.cueId;
      }
      case 'Playbacks/SetCueLegend': {
        const pb = this.resolvePlayback(query, 'handle');
        const num = Number(q('cueNumber'));
        const legend = q('newLegend') ?? '';
        const cue = pb.cues.find((c) => c.cueNumber === num);
        if (!cue) throw new Error(`Cue ${num} does not exist on '${pb.legend}'`);
        cue.legend = legend;
        // 单 cue playback 同步更新句柄 legend，贴近真实观感
        if (pb.cues.length === 1) pb.legend = legend;
        this.state.log('legend', `cue ${num} -> ${legend}`);
        return null;
      }
      case 'Playbacks/SetPlaybackLegend': {
        const pb = this.resolvePlayback(query, 'handle');
        pb.legend = q('legend') ?? pb.legend;
        return null;
      }
      case 'Playbacks/ChangeCueNumber':
        return null;

      // ── 创建句柄 ──────────────────────────────────────────────────────
      case 'Playbacks/CueList/CreateCueList': {
        const group = q('group') ?? '';
        const index = Number(q('index'));
        if (this.state.findPlaybackByLocation(group, 1, index)) {
          throw new Error(`Handle already occupied in group '${group}' index '${index}'`);
        }
        const pb = makeSimPlayback(
          { group, page: 1, index },
          `CueList ${index}`,
          { kind: 'cuelist', userNumber: index },
        );
        this.state.show.playbacks.set(pb.titanId, pb);
        return pb.titanId;
      }
      case 'Group/QuickCreateGroup': {
        const legend = q('legend') ?? `Group ${this.state.show.groups.size + 1}`;
        const id = 70_000 + this.state.show.groups.size + 1;
        this.state.show.groups.set(id, {
          titanId: id,
          userNumber: this.state.show.groups.size + 1,
          legend,
          fixtures: [...this.state.show.programmer.selectedFixtures],
        });
        this.state.log('group', `新建编组 ${legend}`);
        return id;
      }
      case 'Palette/QuickCreatePalette':
      case 'Palette/StoreCurrentPalette': {
        const id = 60_000 + this.state.show.palettes.size + 1;
        const legend = q('legend') ?? `Palette ${this.state.show.palettes.size + 1}`;
        this.state.show.palettes.set(id, {
          titanId: id,
          userNumber: this.state.show.palettes.size + 1,
          group: HANDLE_GROUPS.Colours,
          page: 1,
          index: this.state.show.palettes.size + 1,
          legend,
          kind: 'colour',
          values: { ...this.state.show.programmer.values },
        });
        this.state.log('palette', `新建调色板 ${legend}`);
        return id;
      }
      case 'Palette/SyncProperties':
        return null;

      // ── programmer（用于验证"另一个用户"假设） ────────────────────────
      case 'Programmer/Editor/Selection/SelectFixtures':
      case 'Programmer/Editor/Selection/SelectFixturesWithTitanIds': {
        const ids = (q('fixtures') ?? q('fixtures_handleList') ?? '')
          .split(',')
          .map((x) => Number(x))
          .filter((n) => Number.isFinite(n));
        this.state.show.programmer.selectedFixtures = ids;
        this.state.log('select', `选中 ${ids.length} 台灯具`);
        return null;
      }
      case 'Programmer/Editor/Fixtures/SetAttributeLevel': {
        const name = q('controlName') ?? q('name') ?? 'dimmer';
        const value = Number(q('value_level') ?? q('value') ?? '0');
        for (const f of this.state.show.programmer.selectedFixtures) {
          this.state.show.programmer.values[`${f}.${name}`] = value;
        }
        return null;
      }
      case 'Programmer/Editor/Fixtures/SetDimmerLevel': {
        const value = Number(q('level_level') ?? q('level') ?? '0');
        for (const f of this.state.show.programmer.selectedFixtures) {
          this.state.show.programmer.values[`${f}.dimmer`] = value;
        }
        return null;
      }
      case 'Programmer/Editor/ClearProgrammerAndSelection':
      case 'Programmer/Editor/Clear':
        this.state.show.programmer.selectedFixtures = [];
        this.state.show.programmer.values = {};
        return null;

      // ── 事务 ──────────────────────────────────────────────────────────
      case 'History/CreateThreadToken':
        return `sim-token-${Date.now()}`;
      case 'History/Undo':
      case 'History/Redo':
        this.state.log('history', member);
        return null;
      case 'History/CreateRestorePoint':
        return null;

      // ── 全局 ──────────────────────────────────────────────────────────
      case 'Playbacks/IsAllowedGroup':
        return ['Playbacks', 'StaticPlaybacks', 'RollerA', 'RollerB'].includes(q('groupName') ?? '')
          ? 'True'
          : 'False';
      case 'Show/SaveAutoSave':
        this.state.log('save', '触发自动保存（模拟器不落盘）');
        return null;

      default:
        throw new Error(
          `Simulator 未实现方法 ${member}。` +
            `若项目需要该能力，请在 src/titan-sim/server.ts 的 doScript 中补充。`,
        );
    }
  }

  /** 读取当前上下文 cue 的某个属性。无上下文 cue 时返回 null。 */
  private timesProp<T>(read: (cue: import('./state.ts').SimCue) => T): T | null {
    const ctx = this.state.contextCue();
    if (!ctx) return null;
    return read(ctx.cue);
  }

  // ── 句柄解析（复现真实的寻址陷阱） ───────────────────────────────────────

  /**
   * 复现真实行为：
   * - `handle_titanId` / `handle_userNumber` / `handle_location` 三选一
   * - **缺省 `handle=` 被当作 userNumber**
   * - location 传给缺省 `handle=` 时抛 `AcwUserNumber` 解析错误
   */
  private resolvePlayback(query: URLSearchParams, prefix: string): SimPlayback {
    const titanId = query.get(`${prefix}_titanId`);
    const userNumber = query.get(`${prefix}_userNumber`);
    const location = query.get(`${prefix}_location`);
    const bare = query.get(prefix);

    if (titanId !== null) {
      const n = Number(titanId);
      if (!Number.isFinite(n)) throw new Error(`Failed to parse value '${titanId}' to TitanId`);
      const pb = this.state.findPlaybackByTitanId(n);
      if (!pb) throw new Error(`Unable not find handle in group 'playbackHandle' with index '${n}'.`);
      return pb;
    }

    if (userNumber !== null) {
      const n = Number(userNumber);
      if (!Number.isFinite(n)) {
        throw new Error(`Failed to parse value '${userNumber}' to AcwUserNumber`);
      }
      const pb = this.state.findPlaybackByUserNumber(n);
      if (!pb) throw new Error(`Unable not find handle in group 'playbackHandle' with index '${n}'.`);
      return pb;
    }

    if (location !== null) {
      const m = /^([A-Za-z]+)_(\d+)_(\d+)$/.exec(location);
      if (!m) throw new Error(`Failed to parse location '${location}'`);
      // ⚠️ 权威分组名是大写规范名；这里刻意**区分大小写**以复现真实风险
      const pb = this.state.findPlaybackByLocation(m[1]!, Number(m[2]), Number(m[3]));
      if (!pb) {
        throw new Error(
          `Unable not find handle in group '${m[1]}' with location '${location}'. ` +
            `注意：权威分组名是大写规范名（Playbacks/StaticPlaybacks/…），` +
            `文档示例里的小写 playback 不在权威清单内。`,
        );
      }
      return pb;
    }

    if (bare !== null) {
      // 真实行为：缺省按 userNumber 解析；若给了 location 字符串则报类型转换错误
      if (bare.includes('_')) {
        throw new Error(
          `Failed to parse value to AcwUserNumber（收到 '${bare}'）。` +
            `真实控台行为：handle= 缺省被当作 userNumber，location 必须显式写 handle_location=。`,
        );
      }
      const n = Number(bare);
      const pb = this.state.findPlaybackByUserNumber(n);
      if (!pb) throw new Error(`Unable not find handle in group 'playbackHandle' with index '${n}'.`);
      return pb;
    }

    throw new Error(`Missing required handle parameter for '${prefix}'`);
  }

  private requireHandleTitanId(query: URLSearchParams): number {
    // 与真实控台一致：三种显式后缀任一皆可，但**必须显式**
    for (const suffix of ['titanId', 'userNumber', 'location'] as const) {
      const raw = query.get(`handle_${suffix}`);
      if (raw === null) continue;
      if (suffix === 'titanId') {
        const n = Number(raw);
        if (!Number.isFinite(n)) throw new Error(`Failed to parse value '${raw}' to TitanId`);
        return n;
      }
      if (suffix === 'userNumber') {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          throw new Error(`Failed to parse value '${raw}' to AcwUserNumber`);
        }
        const pb = this.state.findPlaybackByUserNumber(n);
        if (pb) return pb.titanId;
        const g = [...this.state.show.groups.values()].find((x) => x.userNumber === n);
        if (g) return g.titanId;
        const f = [...this.state.show.fixtures.values()].find((x) => x.userNumber === n);
        if (f) return f.titanId;
        throw new Error(`Unable not find handle with user number '${n}'.`);
      }
      const m = /^([A-Za-z]+)_(\d+)_(\d+)$/.exec(raw);
      if (!m) throw new Error(`Failed to parse location '${raw}'`);
      const pb = this.state.findPlaybackByLocation(m[1]!, Number(m[2]), Number(m[3]));
      if (pb) return pb.titanId;
      throw new Error(`Unable not find handle at location '${raw}'.`);
    }

    throw new Error(
      'Missing explicit handle suffix. 本项目约定**永远显式写句柄后缀**' +
        '（handle_titanId / handle_userNumber / handle_location），' +
        '因为缺省 handle= 会被真实控台当作 userNumber，遇到 location 直接报 AcwUserNumber 解析错误。',
    );
  }

  /**
   * 读取电平参数，**刻意复现大小写陷阱**：
   * 小写 `leveldelta` 抛类型转换错误（与社区在真机上的观测一致）。
   */
  private readLevel(query: URLSearchParams, prefix: string): number {
    const abs = query.get(`${prefix}_level`);
    if (abs !== null) return clamp01(Number(abs));

    const camel = query.get(`${prefix}_levelDelta`);
    if (camel !== null) return clamp01(coerceNumber(camel));

    const lower = query.get(`${prefix}_leveldelta`);
    if (lower !== null) {
      throw new Error(
        'Das Objekt mit dem Typ "System.Boolean" kann nicht in den Typ ' +
          '"Avolites.Menus.Maths.LevelAdjust" konvertiert werden. ' +
          '（模拟器复现真实行为：小写 leveldelta 会失败，须用大写 levelDelta）',
      );
    }

    const bare = query.get(prefix);
    if (bare !== null) return clamp01(Number(bare));
    return 1;
  }
}

// ── 工具 ──────────────────────────────────────────────────────────────────

function matchRoute(pathname: string, searchParams: URLSearchParams): Route | null {
  // 刻意要求 `/2/` —— 真实 API 中它是强制的（1203/1203，零例外）
  const m = /^\/titan\/(get|set|script)\/2\/(.+)$/.exec(pathname);
  if (!m) return null;
  const kind = m[1] as Route['kind'];
  const member = (m[2] ?? '').replace(/\/+$/, '');
  if (!member.includes('/')) return null;
  return { kind, member, query: searchParams };
}

function emit(res: ServerResponse, out: unknown): void {
  if (out === null || out === undefined) {
    // void 方法：**空 body**
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('');
    return;
  }
  if (typeof out === 'string' || typeof out === 'number' || typeof out === 'boolean') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(out));
    return;
  }
  json(res, out);
}

function json(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function badRequest(res: ServerResponse, message: string): void {
  res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`Error: ${message}`);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** 毫秒 → 秒字符串（Titan 界面用秒）。至少保留一位小数以便区分 0 与极小值。 */
const secs = (ms: number): string => (ms / 1000).toFixed(3).replace(/0+$/, '').replace(/\.$/, '.0');

const isTrue = (v: string | undefined): boolean => v !== undefined && /^(true|1)$/i.test(v);
const clamp01 = (n: number): number => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1);
const coerceNumber = (s: string): number => {
  const n = Number(s);
  if (!Number.isFinite(n)) throw new Error(`Failed to parse value '${s}' to Single`);
  return n;
};
