# BNDS Tiger Touch

> 北京十一学校剧场所用的 Avolites **Tiger Touch** 控台配套工具链。
> 把「在控台面板上手工点」变成「在电脑上描述 → 批量生成 → 联机运行」。

## 这是什么

一套围绕 Avolites Titan 官方 WebAPI（HTTP 4430）构建的**编光 / 变光 / 演出 / 分析**一体化系统，
通过浏览器里的 WebUI 完成全部操作。

**核心场景**：在 WebUI 里点「播放」——系统播放音乐，并由**同一个时钟**
按卡点时刻把「散的 cue」推到控台上。

### 变光模型：散的 cue（不是 cue list）

每个变光状态 = **一个独立的 playback**（Titan 的单 cue Memory）。

这样设计是因为：人可以随时单独推/收任意一个，系统也能在卡点时刻推，
**两者互不干扰** —— 不需要「走 cue 表」那种顺序状态机。

## 当前状态

| 里程碑 | 状态 |
|---|---|
| M0 调研定稿 | ✅ 需求大纲 v0.2 已定 |
| **M1 通路**（titan-client + titan-sim） | ✅ **完成，52 项测试全绿** |
| **M2/M3 演出引擎与 WebUI** | ✅ **可运行** —— 已跑通「点播放 → 散 cue 按时推送到控台」 |
| M4 变光台编辑器 | 🚧 基础可用（增删改、试推） |
| M6 现场联机 | ⬜ 等控台接入 |
| M7 分析 / M8 MIDI 时码 | ⬜ 未开始 |

**控台尚未接入。** 在此之前全部以自建模拟器开发与验证 —— 接上后只需换目标地址。

## 快速开始

```bash
pnpm install

# 启动 WebUI + 内置 Titan 模拟器（推荐先这样试）
node src/main.ts --sim

# 打开 http://127.0.0.1:8091
```

其它用法：

```bash
node src/main.ts --sim --sim-port 4500 --port 8091   # 指定端口
node src/main.ts --console 192.168.1.50              # 连真实控台
node src/titan-sim/standalone.ts --verbose           # 只跑模拟器
```

开发：

```bash
pnpm test        # 52 项测试
pnpm typecheck   # tsc --noEmit
```

## WebUI 的三个域

按「准备 → 演出 → 复盘」划分，**不混页**。演出域刻意不放任何会改动数据的按钮。

| 域 | 内容 |
|---|---|
| **准备** | 连接控台 · 散 cue 库编辑（增删改/落位/时间/标签/试推）· 卡点表编辑 |
| **演出** | 大按钮散 cue 触发面板 · 播放控制 · 时钟与下一卡点预告 · 卡点标尺 · 快速标记 |
| **复盘** | 卡点偏差统计（±20ms / ±50ms 命中率）· 完整触发记录 |

**演出操作**：单击散 cue = 推起，Shift+单击 = 熄灭，长按 = 选中用于标记，空格 = 播放/暂停。

## 项目结构

```
src/
├── titan/               Titan 16 WebAPI 客户端 —— 把已核实的陷阱编码进类型
│   ├── params.ts        参数编码；levelDelta 大小写修正就在这
│   ├── handles.ts       句柄寻址；18 个权威分组名
│   ├── timecode.ts      HH:MM:SS:FF 线格式
│   ├── substitutions.ts 427 个"参数构造不出来"的方法 → 替代映射
│   └── providers/       Playbacks / Handles 封装
├── titan-sim/           自建控台模拟器（忠实复现真实行为与陷阱）
├── model/               cuebank（散 cue 库）· song（曲目与卡点）
├── engine/              showclock（演出时钟）· scheduler（卡点调度）
├── server/              appstate（应用状态）· app（HTTP + SSE）
└── web/                 WebUI（零构建，原生前端）
docs/
├── 00-需求大纲.md        需求拆解、架构、路线图、风险（**从这里开始读**）
└── 01-API调研笔记.md     API 能力与限制（逐条核实，含依据）
tools/
└── fetch_titan_api_docs.py  抓取全量 API 文档为本地可检索语料库
```

## 为什么没有构建步骤

Node 24 原生支持运行 TypeScript（strip-only 模式），因此服务端直接 `node src/main.ts` 即可，
启动在百毫秒级 —— 对演出工具很重要。代价是全项目**禁用 TS 参数属性等非可擦除语法**
（`tsconfig.json` 里的 `erasableSyntaxOnly` 会强制这一点）。

## 已核实的 API 陷阱（都已封进代码）

这些都是逐页核对 3706 页官方文档 + 社区实测后确认的，**不是猜测**：

1. **`levelDelta` 大小写**：官方语料只发小写 `leveldelta`（41 次），但实测小写会抛
   `LevelAdjust` 类型转换错误。所有其他变体后缀都是 camelCase（`_titanId`/`_userNumber`/`_handleList`），
   唯独它是异类 → 判定为文档生成器 bug。客户端默认发**大写 D**。
2. **`handle_location` 不可用**：全语料唯一示例是 `playback_2_1`，是生成器硬编码、
   被复制到 419 处（甚至泄漏成 `palette_location=playback_2_1`）。一律用 `titanId`。
3. **缺省 `handle=` 是陷阱**：被当作 userNumber，遇 location 直接报 `AcwUserNumber` 解析错误。
   客户端**永远显式写后缀**。
4. **`TimecodeTime` = `HH:MM:SS:FF`**：文档把它渲染成 `time={}`，掩盖了完全明确的格式。
5. **427 个方法参数构造不出来**（`={}` 空花括号），需改用「有类型兄弟」
   （如 `CreatePresetPalettes` → `QuickCreatePalette`）。
6. **`Attribute` provider 不是属性元数据**，全部 207 页都是 `Attribute.Mask.*`。
7. **控台无任何推送通道** → 只能轮询廉价标量，句柄全量仅首次拉取。
8. **官方 Introduction 页是过时的 Titan 14 材料**（不带 `/2/`、用按类型命名的参数键），
   不可作为协议依据。

详见 `docs/01-API调研笔记.md`。

## ⚠️ 接入真控台前必读

**厂方文档明确：v16 无法安装在原版 Tiger Touch / Tiger Touch Pro /
Tiger Touch II（序列 2001–3065）上**，这些机型最高只能到 **V15.1**，
而 15.0 与 16.0 的 API 有 **187 页差异**。

接入前请先确认控台**序列号**与 `System/SoftwareVersion`
（客户端会在版本不匹配时明确报错，而不是发出一堆看起来像拼写错误的 400）。

另：社区观测指出 WebAPI 在 Titan 里是「**另一个用户**」，有它自己的 programmer，
因此**擅长操作/回放，不擅长编程**。本项目的架构据此把「推 cue」作为可靠核心先做，
「编光」类能力按待验证处理 —— 详见大纲 §0 与 §9。

## 安全

- API 在局域网上**无鉴权、无 TLS、无限速**。任何能访问 4430 端口的人都能完全控制演出输出。
- **演出网络必须隔离**；本系统不要在演出期间暴露到不可信网络。
- 所有批量写操作都应在撤销事务（`History.CreateThreadToken`）保护下执行。

## 许可

见 [LICENSE](LICENSE)。
