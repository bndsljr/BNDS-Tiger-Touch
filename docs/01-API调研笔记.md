# Titan 16 WebAPI 调研笔记

> 配套 `docs/00-需求大纲.md`。本文只记录**经过文档原文核对**的结论。
> 标注 ✅ = 已核对签名；⚠ = 存在不确定性；❓ = 需连真控台实测。

---

## 0. 🔴 三条硬约束（先读这个，其余都是细节）

### 0.1 无法从 cue 中读出属性/DMX 数值 ✅（已穷举确认）
可以读到 cue 的**元数据**，但**读不到存进 cue 的实际数值**。
- ❌ 不存在 `GetValue` / `GetAttribute` / `GetControlValue` / `GetDmx` /
  `GetFixtureAttribute` / `GetLiveValue` 之类的 cue 取值方法
- ❌ 没有 `Playbacks.GetCueValues`、`Cue.GetContents`、`GetAttributeValue(fixtureId, controlId)`
- ❌ **`TrackingData.FetchItems(TrackingDataItemsInView)` 返回 `Void`** ——
  它把数据**推**进一个客户端对象，没有 HTTP 形态的接收方式。
  Titan 中信息最丰富的 Tracking View **对外部程序不可达**。
  这是本约束的关键点。
- ❌ `Dmx.*`（38 页）只管模块设置与输出，不提供可按 cue 查询的数值表

**能读到的**：cue ID/句柄、cue 是否存在、live/next cue 号、
以及逐 cue 的 legend / 时间 / link / tracking **模式**
（`Playbacks.GetCueControlTrackingMode(cueId, fixtureId, controlId, calculatedMode)`
→ `AcwTrackingType`）。

**结论（必须如实告知）**：agent 分析现有程序时，只能枚举**结构** ——
有哪些 playback、几个 cue、cue 号、legend、时间、link、tracking 模式、
涉及哪些灯具；**读不出** cue 里的亮度/颜色/位置数值。
任何针对**内容**的 AI 分析只能：
(a) 降级为结构/元数据分析；
(b) 由操作者口述数值；
(c) **离线解析 show 文件**（`Show.LoadShow.ForceLoadXML` 证明 show 是 XML 支撑的，
    这是真正的取值路线，但属**文件级**而非 API 级能力，且 XML schema 未文档化）；
(d) 演出运行时用外部 DMX/sACN 抓包旁路采集。

### 0.2 无文件上传/下载通道 ✅
控台侧所有批量数据能力都吃**控台本地文件路径**
（`ShowImport.*` 的 `AcwPathDeviceKey`、`Timelines.ImportMarkers` 的 `csvFilePath`、
`Reports.SelectDevice(devicePath)`），而**没有任何文件上传/下载 endpoint**。
→ 详见 §3.6.1。

### 0.3 分组名与多个枚举词汇未文档化 ✅
`group` 字面量、`handle_location` 语法、`SetRecordType` 取值、`masterType` 取值、
`ExportType` 格式串、`LockStates`、`HandleOperations`、`MenuEventTypes` 全部不在文档中。
→ 对策：运行时自省（`Handles.GetGroup`、`Playbacks.IsAllowedGroup`、
`Reports.GetReportElementMenuList`），绝不硬编码猜测。详见 §2.3。

---

## 1. 语料库与可复现性

全量文档已抓取为本地可 grep 语料库：

```bash
python3 tools/fetch_titan_api_docs.py --version 16.0 --out .cache/api-docs
```

产出：
| 文件 | 内容 |
|---|---|
| `.cache/api-docs/index.json` | docfx 原始搜索索引 |
| `.cache/api-docs/ALL.txt` | 3706 页全文，块以 `@@@ <page>` 分隔 |
| `.cache/api-docs/pages.txt` | 页面路径清单 |
| `.cache/api-docs/summary.md` | 统计信息 |

**原理**：`https://api.avolites.com/16.0/index.json` 是 docfx 生成的搜索索引，
其 `keywords` 字段包含**每个 API 页面的完整正文**（描述、命名空间、C#/MACRO 签名、
HTTP URL 模板、全部参数说明）。因此一次请求即可获得全站内容，
无需逐页抓取 3706 次。

```bash
# 典型检索方式
python3 - <<'PY'
import re
s=open('.cache/api-docs/ALL.txt').read()
secs=dict(re.findall(r'@@@ (\S+)\n(.*?)(?=\n@@@ |\Z)',s,re.S))
print(secs['api/Playbacks.StoreCue.html'])
PY
```

## 2. 传输层协议 ✅

| 项 | 值 |
|---|---|
| 协议 | HTTP |
| 端口 | 4430 |
| 基路径 | `/titan/` |
| 读属性 | `GET /titan/get/2/<Provider>/<Property>`（无查询串，目标全在路径里） |
| 写属性 | `POST /titan/set/2/<Provider>/<Property>`（值在请求体） |
| 调方法 | `GET /titan/script/2/<Provider>/<Method>?<params>` |
| 错误契约 | 无效请求返回错误消息；`void` 方法**返回空 body，不是 JSON** |

> 🔴 **重要：官方 Introduction 页是过时的 Titan 14 材料，不可作为协议依据。**
> 它的示例**不带 `/2/`**、用**按类型命名的参数键**
> （`?string=playback&int=1&level=0.5&float=1.0&bool=false`），
> 且自证过时：示例里控台返回 `"14.0"`、show 名为 `"V10 Demo Show"`、标注 Copyright 2021。
>
> **同一个方法在两处形状不兼容**：
> | | 形式 |
> |---|---|
> | Introduction（旧） | `Playbacks/FirePlaybackAtLevel?titanId=1684&level=1.0&bool=false` |
> | 16.0 参考页（权威） | `Playbacks/FirePlaybackAtLevel?handle_titanId=1895&level_level=1&alwaysRefire=true` |
>
> → **一律以版本化的 `/16.0/api/` 参考页为准。**

### 2.1 版本前缀 `/2/` 是强制的 ✅
对全量页面统计（无例外）：

| 项 | 数量 |
|---|---|
| 总页数 | 3706 |
| `titan/get/` URL 总数 | 1203 |
| 其中**含** `/2/` 的 | **1203（全部）** |
| `titan/set/` URL 总数 | 1203 |
| 其中**含** `/2/` 的 | **1203（全部）** |
| `titan/script/2` 出现次数 | 4349（**不存在**其他 script 版本） |
| 完全没有 HTTP URL 的页 | **28** |

那 28 页是 **27 个 `Avolites.*` 枚举页 + `api/index.html`**，
全是类型定义，不是可调用方法。

> **结论：`/2/` 是 get/set/script 的统一且强制形式；
> 不存在"仅宏可用"的方法 —— 每个可调用方法与属性都有 HTTP URL。**
> 文档里的 `Namespace:` / `Syntax MACRO` 行只是 C#/ActionScript 签名，**总是**伴随 HTTP 形式。

### 2.1.1 🔴 真正的阻塞类：URL 存在但**参数构造不出来**
`{...}={}` 里的空花括号表示**渲染器对该参数类型没有查询串编码方式**。

| 指标 | 数量 |
|---|---|
| script URL 含裸对象占位 `={}` 的页 | **466** |
| 其中同时给出可用长写形式（`handle_*` / `…_handleList` / `…_userNumberList`）的 | 39 |
| **仍然只有对象形式 —— 按文档无法调用** | **427** |

覆盖类型包括 `IMenu`、`MenuItem`、`HandleReferenceList`、`IEnumerable<FixtureHandle>`、
`AcwRecordMask`、`Size`、`LayoutElementInformation`、`ShapeStateInfo`、
`KeyValuePair<String,Object>`、`Timecode`、`MenuItemTag` 等。

**通用解法：找该方法的"有类型兄弟"**。已找到的具体替换：

| 被阻塞 | 改用 |
|---|---|
| `Programmer.Editor.Fixtures.SetControlValue?control={}` | `SetControlValueById?controlId=` 或 `SetControlValueByName?controlName=` |
| `Group.CreateAutoGroup?handles={}` | **`Group.QuickCreateGroup(handle, userNumber, legend, iconId)`** |
| `Group.SetGroupFixtureOrder?orders={}` | `Group.SetFixtureOrder(groupId, fixtureId, x, y, angle)` —— 每个灯具一次调用 |
| `Palette.CreatePresetPalettes?fixtures={}&option={}` | **`Palette.QuickCreatePalette(...)`** —— 每个调色板一次 |
| `Editor.Shapes.BlockShape?menuItem={}` | `Playbacks.SetCueBlockedShape?playbackId=&cueId=&shapeId=&blocked=` |
| `Editor.KeyFrames.*?shapeHandle={}` | `Int32` id 版孪生方法（`shapeId={titanId}`） |

### 2.2 参数编码模型 ✅
统计全语料 `HTTP Example:` 行得到的变体后缀：

```
596  _titanId         511  _userNumber        419  _location     ← Handle 寻址
132  _handleList      128  _userNumberList                   ← IEnumerable<Handle>
 49  _level            22  _leveldelta                       ← LevelAdjust
```

**规则 1：复合/联合类型展开为 `<参数名>_<变体>` 键。**
- `LevelAdjust`（"替换 vs 增量"联合）→ `value_level=1`（绝对值）或 `value_leveldelta=0.5`（增量）
- `Handle` → `handle_userNumber` / `handle_location` / `handle_titanId`
- `IEnumerable<Handle>` → `handles_handleList` / `handles_userNumberList`

**规则 2：普通标量保留自己的名字作为键** —— `alwaysRefire=true`、`updateOnly=false`。
16.0 参考中**不存在**按类型命名的形式。

> ⚠️ **两个占位符陷阱**：
> 1. `{titanId}` **只是任何 `Int32` 的渲染形式**，不代表该值是 ID。
>    例：`Group.SetGroupSize?groupId={titanId}&width={titanId}&height={titanId}` —— `width` 显然不是 ID。
>    **不要从占位符名字推断语义。**
> 2. `{userNumber}`（`AcwUserNumber` 类型）**从未有过字面量示例** —— 43 处全部保留占位符。
>    而它落在关键路径上：`Group.StoreGroup`、`Group.QuickCreateGroup`、
>    `Palette.QuickCreatePalette`、`Handles.GetHandleFromUserNumber` 等约 15 个方法都吃它。
>    唯一证据是**过时 Introduction** 里的 `?userNumber=20`。
>    → 按普通整数处理，**置信度中等，须尽早实测**。

### 2.2 特殊参数类型 ✅
| 类型 | 形式 | 含义 |
|---|---|---|
| `Level` | `level=0.5` | 覆盖式设定 |
| `LevelDelta` | `levelDelta=0.5` | 增量设定 |
| `TitanId` | `titanId=1723` | 系统唯一 ID |
| `User Number` | `userNumber=100` | 用户编号 |
| `Handle` | `handle_titanId=` / `handle_userNumber=` / `handle_location=` | 句柄三种寻址 |
| `HandleList` | `handleList_handleList=1895,1896` / `handleList_userNumberList=6,8,10` | 句柄列表 |

### 2.3 🔴 分组名字符串未文档化 —— 最大的未文档化风险
**全语料中不存在任何 `group=` 的字面量取值** ✅（对 3706 页穷举正则确认：`"Playbacks"`、
`"Fixtures"`、`"Cue Lists"`、带引号的 `group=`/`groupName=` 全部零命中）。
所有文档块一律写占位符 `{string}`。

可见的有**三套不同词汇**，且它们**不是同一批字符串**：

**(a) `HandleOptions.<Group>.*` 的页面路径段** ✅ —— 这是句柄分组词汇的最佳证据，
逐字提取如下：
```
Chases   CueLists   Groups   Handles   LayoutElements   Layouts   Masters
Memories   Palettes   PlaybackGroups   PlaybackShapes   Playbacks
SteppedPlaybacks   Timelines
```
另有形似子分组的命名空间：`Masters.AB.*`、`Masters.Bpm.*`、`Masters.Scaleable.*`、
`PlaybackGroups.Selection.*`。
示例 URL：`GET /titan/get/2/HandleOptions/Playbacks/ContextHandle`

**(b) `handle_location` 记号 —— 实际上不可用** 🔴
`playback_2_1` 是**全语料 3706 页中唯一出现过的 location 字符串** ——
它是文档生成器**硬编码的单个示例**，被复制到**每个** location 类参数名下（共 419 处）：

```
316  handle_location=playback_2_1
 13  shadowedHandle_location=playback_2_1
  7  playbackGroupHandle_location=playback_2_1
```

更糟的是，生成器把这个示例泄漏到了**它不可能成立**的地方 ——
`Palettes.Editor.SelectPalette` 的**调色板**参数也写作 `palette_location=playback_2_1`。

**对策**：`handle_location` 应视为**不支持**，除非已连真控台实测出语法。
一律用有真实字面量示例的 `handle_userNumber`（示例 `=6`）
或 `handle_titanId`（示例 `=1895`）。

**(c) `Handles.GetHandle(group, ...)` / `Playbacks.ReleasePlaybacksByGroup`** ✅ ——
后者文档称 `groupNames` 是 *"a semicolon separated list of group names"*，
分号分隔的复数形式强烈暗示 `"Playbacks"`（即 (a) 形式）是合法分组名。

**对策 —— 不要硬编码，运行时自省** ⚠️：
```
GET /titan/script/2/Handles/GetGroup?handle_userNumber=6   → 返回真实分组名字符串
GET /titan/script/2/Handles/GetPath?handle_userNumber=6    → 返回路径
GET /titan/script/2/Handles/GetTitanIdFromHandle?handle_titanId=<ID>
GET /titan/script/2/Playbacks/IsAllowedGroup?groupName=<候选>   → 录制前校验候选名
```
- `Handles.GetGroup(handle)` ✅ 文档：*"group of a handle or "Null" if the handle is null"*
  —— **这是唯一有文档的"回读分组名"方法，也是 `group={string}` 参数的官方 bootstrap**
- `Playbacks.IsAllowedGroup(String groupName)` ✅ 文档：
  *"Determines whether playbacks are allowed to be recorded in the group supplied."*
  → 可在真正录制前**校验**候选分组名

**做法**：先用确定无误的寻址方式（`handle_titanId` / `handle_userNumber`）拿到句柄，
再回读它的分组名字符串，此后一律使用该字面量。

> ⚠️ **关于 `GET /titan/handles`**：这个端点（以及介绍页的 JSON 响应示例、
> `{"handleLocation":{"group":"Fixtures",...}}`）**只出现在过时的 Introduction 里**，
> 在 16.0 参考页中**出现次数为 0**，属**未验证**能力。
> 它很可能仍然存在（正好能干净地解决分组名发现问题），
> **值得连真控台时优先探测**，但**不能作为设计前提**。
> 注意其示例用的是 `Colours` 而非 `Colour` —— 暗示分组名
> **大小写敏感且可随控台配置变化**（介绍页原文："capital letters in the group name
> must match what is set on the console"）。

> 补充：`AcwRecordMask` 文档列出属性组 `I P C G B E S FX Time`；
> `AttributeBankNames` 为 IPCGBES。调色板分组名（Colours/Positions/Gobos）
> 属于合理推测，但**字面量不在文档中**。

## 3. 需求相关的关键 API

### 3.1 批量编程 ✅
| 方法 | 签名 | 说明 |
|---|---|---|
| `Playbacks.StoreCue` | `(String group, Int32 index, Boolean updateOnly)` | 用 programmer 内容 + 当前录制模式录一个 cue |
| `Playbacks.CueList.CreateCueList` | `(String group, Int32 index)` | 在指定句柄建 cue list 并进入编辑 |
| `Playbacks.CreateChase` | `(String group, Int32 index)` | 建 chase |
| `Playbacks.PlaybackEdit.CurrentStep` | 属性 | **当前录制步骤指针** |
| `Playbacks.GetNextStepHint(Handle)` | `→ Single` | 下一个步骤号 |
| `Playbacks.AppendCue` / `AppendOrInsertPlaybackStep` / `InsertStepAfter` | — | 追加/插入步骤 |
| `Playbacks.SetCueLegend` | `(Handle handle, Single cueNumber, String newLegend)` | **显式寻址、无上下文依赖，最安全的批量 legend 写入方式** |
| `Playbacks.QuickBuildRange` | `(String group, IEnumerable<Int32> indexList, Handle destHand)` | 批量聚合 |
| `Playbacks.AddQuickBuildCue` | `(IEnumerable<Handle> handles)` | 把多个 cue 加入 quick build |
| `Playbacks.Editor.CopyCues.CopyMovePlaybackCues(...)` | — | 批量复制/移动 cue |

> ⚠️ **`Playbacks.AppendChaseStep` 并不存在** —— 尽管 `CreateChase` 的文档正文里
> 提到了这个名字。文档与实际 API 不符，属于文档错误。
>
> **正确的录制循环** ✅：
> `CueList.CreateCueList(group,index)`（或 `CreateChase`）
> → 用 `PlaybackEdit.CurrentStep` 或 `GetNextStepHint(handle)` 确定步骤号
> → 设置 programmer 内容
> → `StoreCue(group, index, false)`
> → `SetCueLegend(handle, cueNumber, legend)`
> → 循环

### 3.2 素材生成 ✅
| 方法 | 说明 |
|---|---|
| `Palette.StoreCurrentPalette` / `StoreCurrentPaletteReplace` | 存调色板 |
| `Palette.CreatePresetPalettes` | 批量建预设调色板 |
| `Palette.StorePaletteMode` / `RecordMode` / `RecordPaletteReferences` | 存储模式控制 |
| `Group.StoreGroup` / `StoreGroupReplace` / `CreateAutoGroup` | 建编组 |

### 3.3 展开 / 对齐 ✅
`Programmer.Editor.Fixtures.Fan.*`：`ActiveFanCurve`、`AvailableCurveDefinitions`、
`GetCurveDefinitions`、`SelectCurve`、`SegmentCount`、`MidPointFixtureHandle`、
`MidPointOptions`、`GroupOptions`、`ToggleFan`、`FanModeEnabled`
`AlignSelection.*`、`GroupOrderSelection.*`、`ShapeFixtureOrder.*`

### 3.4 盲编与事务 ✅
| 方法 | 说明 |
|---|---|
| `Programmer.SetBlind` / `SetBlindMode` / `BlindActive` | 盲编（不影响输出） |
| `Programmer.SaveRestorePoint` / `LoadLastRestorePoint` | 编程器还原点 |
| `History.CreateThreadToken(description)` | **把一批操作合成一个撤销事务** |
| `History.Undo` / `Redo` / `GotoTransaction(guid)` / `CreateRestorePoint(type)` | 撤销/重做/跳转 |

> `CreateThreadToken` 对批量灌入至关重要：500 次调用 = 1 步可撤销操作。

### 3.5 ★ SetList —— 剧场走 cue 模型 ✅
Titan 剧场模型：**Set List → Tracks（每场/每曲一个）→ 每个 track 绑页面 + 宏 + 备注**，
GO 即 `NextTrack()`。

创建与聚合：
- `SetList.NewSetList(name)` / `CreateSetList(name)`
- `SetList.AddTrack(setList, page, trackName)`
- **`SetList.CreateSetListFromPages(groupName)`** —— 从某句柄分组的全部「已占用页」自动聚合成走 cue 表
- `SetList.SuggestTrackLegend(setList)`、`UpdateName(trackId, trackName)`

演出控制：
- `SetList.FireTrack(trackHandle)`
- **`SetList.NextTrack()` / `PreviousTrack()`** —— GO / BACK
- `ActiveSetList` / `ActiveTrack` / `ContextSetList` / `ContextTrack`（读写属性）
- `SelectSetList` / `SelectTrack` / `SelectTracks` / `EnsureSetListSelected`
- `BindPagesToSetList`（把 playback 页绑定到走 cue 表）

剧场专属：
- `AddNote(tracks, note)` / `UpdateNotes` / `RemoveNotes` / `CurrentNote` —— **cue 备注可编程**
- `AddMacroToSetList(macroId)` / `AddMacroHandleToSetList` / `AddMacroLibraryToSetList` / `AddLinkFromId`
- `RecordSnapshot(tracks, pageId, recordWorkspace, recordPage)` —— 把工作区布局+页辊录进 track
- `RecordWorkspace(handle, createWorkspace)` / `ConfirmWorkspaceRecord`
- `ParkTracks` / `UnparkTracks` / `IsTrackParked` —— 停用某场
- `CopyMoveTracks` / `CopyTrackProperties` / `MoveTrackProperties`

### 3.6 ★★ ShowImport —— 批量灌入的原生落点 ✅
> ⚠️ **重要澄清（避免误读）**：`ShowImport` 是 **show → show** 的传输引擎
> （把另一个 **Titan show 文件**的内容并入当前 show），
> **不是** CSV/XML/配接表的通用导入器。
> 全命名空间内**没有任何** CSV/XML/配接表导入方法。
> 若 PC 侧工具产出 CSV/JSON，API 里**没有任何东西能直接吃下它** ——
> 必须由本工具自己转换成 API 调用或 Titan 宏 XML。

| 方法 | 签名 | 说明 |
|---|---|---|
| `Show.CurrentFiles` / `Show.CurrentPath` | 属性 | 浏览存储设备上的 show 文件（路径含 deviceId） |
| `Show.CurrentlySelectedShow` | 属性 | 选中目标 show 文件路径 |
| `ShowImport.ImportShowInfo(AcwPathDeviceKey path)` | `?path={}` | 索引指定 show 以供导入 |
| **`ShowImport.QuickImport(List<Handle> handles)`** | `?handles={}` | "Imports selected items to **next free handles** in relevant groups" |
| **`ShowImport.TransferHandles(String group, Int32 index)`** | `?group=&index=` | 把被导入 show 中的句柄搬运到当前 show |
| `ShowImport.MoveSelection(group, index)` / `ClearSelection()` | — | 选择管理 |
| `ShowImport.SelectedShow` / `SelectedShowName` / `SelectedItemLegend` | 属性 | 选择状态 |
| `ShowImport.DeleteImportedShow(AcwShowImportInformation)` / `DeleteFlag` / `DeleteValid` | — | 删除管理 |
| `ShowImport.ImportProfile()` / `ImportUser(Boolean asNew)` / `ImportProfilesWithUser` | — | 导入 profile / user |
| `ShowLibrary.UpdateFixturesAsync()` / `ClearMapping()` / `SetClearMappingMode(Boolean)` | — | 暗示库可在 show 间**重映射灯具**（语义未文档化） |

### 3.6.1 🔴 Show 的加载/另存 —— 全项目最弱的一环 ✅
**不存在** `Show.OpenShow`、`Show.LoadShow(name)`、`Show.SaveShow`、`Show.Export*`
（穷举确认）。WebAPI **没有**「加载某个 show 文件」或「立刻保存 show」的一次性调用。

实际可用的原语：
- **新建**：`Show.NewShow(showName)`、`Show.ResetNewShow()`（清空并出厂复位）
- **保存**：只有 `Show.SaveAutoSave()`（触发自动保存）；
  真正落盘走 `Show.UpdateShowSection()`；`Show.SaveShowName` 只是设一个**拟定**名字
- **加载**：设 `Show.CurrentlySelectedShow`（路径）+ 三个 `Show.LoadShow.*` 偏好开关，
  然后**需要通过菜单/UI 层触发加载** —— ⚠️ 具体需要哪个 `Menu.SelectMenuItemById` id，
  甚至加载是否可通过 HTTP 触达，**文档均未说明**。
  `Show.RetryLoadShow()` 只能重试**上一次**加载

> **设计后果**：无法用有文档的调用「把预编好的 show 文件推到控台并加载」。
> 加载预编 show 是整个方案最薄弱的一环，**必须尽早连真控台验证**。
> 现实替代路径是**带外文件拷贝**（网络共享 / U 盘）到控台的 show 目录，
> 再由人工或用菜单触发加载；或走 Titan 主从同步 `Titan.SyncNow()`。

**三条批量生成路线**：

| 路线 | 机制 | 优点 | 代价 |
|---|---|---|---|
| A | `ShowImport` / `QuickImport` / `TransferHandles` | 原生批量、快 | 需先把文件放上控台（USB/网络），非纯 HTTP |
| B | 纯 API 重放（`PatchFixtures` + `StoreGroup` + `StoreCurrentPalette` + `StoreCue` + `CreateCueList`） | 全远程、可校验、可回滚 | 调用量大、顺序敏感 |
| C | 整体替换 show（`NewShow` / 加载） | 最简单 | 会覆盖学校控台现有 show，通常不可接受 |

### 3.7 配接（灯具配置）✅
完整链路可脚本化：
1. `Patch.FixtureManufacturers()` → 厂商列表
2. `Patch.SelectManufacturer` / `Patch.SetCurrentFixture` → 选定灯具
3. `Patch.FixtureNames()` → 该厂商型号
4. `Patch.FixtureModes()` → 该型号模式
5. `Patch.SetCurrentDmxAssignment(address)` → DMX 地址
6. `Fixtures.PatchFixtures(group, handleList, fixtureManufacturer, fixtureName, fixtureMode, currentFixtureQuantity, currentDmxSpacing, patchedHandles)` → 执行配接

辅助：`Patch.ValidateCurrentDmxAddress`、`Patch.CurrentDmxAddressValid`、
`Patch.ConflictingDmxAssignment`、`Fixtures.PatchFixturesToVacantHandles`、
`Patch.Repatch.RepatchSelectedFixtures`、`Fixtures.ExchangeFixtures`（换灯+通道映射）、
`Fixtures.RescanFixtureLibrary`、`Patch.UpdateAllPersonalities`、
`Patch.AvailablePersonalityUpdates`、`Fixtures.Macros.FireMacro`（灯泡复位）、
`Patch.CurrentFixtureThumbnail`

### 3.8 音乐卡点 ✅
**Timecode**：
- `Timecode.SetCueTimecode(Handle handle, Int32 cueId, TimecodeTime time)` —— 给某 cue 绑时码
- `Timecode.SetCueTimecodeWithCueNumber(...)`
- `Timecode.Record` / `Play` / `Pause` / `Restart` / `Reset` / `SetEnabled`
- `Timecode.SetTimecodeSource` / `SetTimecodePort` / `AssignTimecode` / `AvailableSources`
- `Timecode.MakeTimecodeTime` / `MakeTimecodeTimeFromTimeSpan` / `ParseFrameRate` /
  `GetTimecodeTimePart` / `KillOutOfRangePlaybacks`
- 每路源独立对象：`Timecode.Context`、`TimecodeOne`…`TimecodeFour`
  （含 `AddLiveTimeListener` / `RemoveLiveTimeListener` / `LiveTime` / `Paused` / `Play` / `Pause`）
- `Timecode.Midi.{EnableGlitchDetect,GlitchTimeout,GlitchTolerance}`

**Timelines**：
- `CreateTimelineTrack`、`CreateTrigger`、`CreateTriggerAtTime`、`CreateTriggerAtLiveTime`
- `CreatePlaybackTriggerReference`、`RecordPlaybackTrigger`、`StoreTimeline`
- `PlayTimeline` / `PlayTimelineFromTime` / `PlayTimelineFromCursor` / `PauseTimeline` /
  `StopTimeline` / `ReleaseTimeline`（均有 `...ById` 变体）
- `EnterTimelineLiveRecord` / `ExitTimelineLiveRecord` / `IsLiveRecording` —— **实时实录**
- `SetTargetCueFromItem` / `TargetCue` / `CuelistGoMode` / `PreloadMode` / `FlashMode` / `Level`
- `TimelineTracks.DeleteTrack`、`TimelineTriggers.*`、`TimelineViewControl.*`

**标记导入**（DAW → 控台）：
```
Timelines.ImportMarkers(Int32 timelineId, XmlNode importMappingVersion,
                        String csvFilePath, AcwFrameRate frameRate)
Timelines.ImportMarkersFromString(Int32 timelineId, String importMappingVersion,
                                  String csvFilePath, AcwFrameRate frameRate)
```
- 标记来自**控台本地 CSV 文件路径**，不是 HTTP body
- `importMappingVersion` 选择用哪套 DAW 映射/版本
- **运行时可自省支持的 DAW**：`Timelines.MarkerMappingList()` 返回映射项，
  `MarkerMappingVersionList(mapping)` 返回该映射的版本列表，
  `PopulateMarkerMappingList(bool)` 填充列表
- ⚠ 参数命名存疑：`ImportMarkersFromString` 第二参数名为 `importMappingVersion` 但类型是
  `String`，且两方法都保留 `csvFilePath`，疑为文档参数错位，需实测

**Triggers**：
`AddAudioTrigger`、`AddBPMTrigger`、`AddDmxTrigger`、`AddMidiTrigger`、`AddSAcnTrigger`、
`AddGPIOTrigger`、`AddMapping`、`EnableMapping` / `ToggleMappingEnable` /
`ToggleMappingEnabledByHandle`、`SetPendingTargetAction` / `SetPendingTargetHandle` /
`SetPendingTargetHardware`、`Fire`、`DecodeAudioStimulus` / `DecodeMidiStimulus` /
`DecodeDmxStimulus` / `DecodeGPIOStimulus` / `DecodeSAcnStimulus`、`GetTargetActionType`

相关：`PioneerDJ.*`（DJ 集成，含 `DjTapDeckNames`）、`Audio.*`、`Media.*`、
`Programmer.RateSettings.*`（`TapTempo`、`Speed`、`SpeedSource`、`SetSpeedSource`、`EffectMultiplier`）、
`UserSettings.TempoUnits`、`UserSettings.UseTemporaryChaseSpeed`

### 3.9 ★ 报告导出（用于 agent 分析）✅
| 方法 | 签名 |
|---|---|
| `Reports.GenerateReport` | `(String format, RequestInfo reportSections)` |
| `Reports.SelectDevice` | `(String devicePath)` |
| `Reports.ReportElements` | 可读写位掩码属性 |
| `Reports.ToggleReportElement` | `(String element)` |
| `Reports.GetReportElementMenuList()` | 枚举合法元素名 |
| `Reports.ReportPhase` / `ReportProgress` | 轮询进度 |

`RequestInfo` 枚举取值：`None` / `Fixtures` / `PlaybackMemories` / `PlaybackChases` /
**`PlaybackCueLists`** / **`Timelines`** / **`Palettes`** / **`Groups`** / `All`

> 覆盖面正好对应"已有程序"的全部内容。

⚠ **`format` 参数说明为 "Type of report: ExportType Enumeration"，但全语料中
不存在 `ExportType` 枚举页 —— 取值必须实测。**

⚠ **`GenerateReport` 返回 `Void`，报告由 `SelectDevice(devicePath)` 指定的设备路径写出**
→ 报告是**写在控台侧/给控台的文件**，**不是 HTTP 响应体**。
文档没有"把报告作为字符串返回"的调用。
**这是唯一有文档的批量结构导出，而它是文件式的，且格式未文档化。**

### 3.9.1 能读到的结构与元数据 ✅（R2 的实现依据）
```csharp
IEnumerable Playbacks.GetPlaybackCueIds(Handle playback, Single minCueNumber, Single maxCueNumber)
  // "The cue IDs in order from the playback that match the specified range."  ← 枚举整条 cue list
IEnumerable Playbacks.GetPlaybackCueHandles(Handle playback, Single min, Single max)
IEnumerable Playbacks.GetCueHandlesFromTo(Single fromCueNumber, Handle toHandle)
Int32       Playbacks.GetPlaybackCueId(Handle handle, Single cueNumber)   // 无匹配返回 -1
Boolean     Playbacks.DoesCueExist(Handle handle, Single cueNumber)
Single      Playbacks.GetNextStepHint(Handle playbackHandle)
PlaybackCueHandle Playbacks.Editor.GetLiveCue()   // 当前 playback 的 live cue
Boolean     Playbacks.IsCueHandle(Handle) / IsSteppedPlaybackHandle(Handle)
```

**cue 的时间/legend/模式 —— 可读，但一次一个 cue** ⚠️：
```
POST /titan/set/2/Playbacks/TimesEdit/CueNumber         (选中目标 cue)
GET  /titan/script/2/Playbacks/TimesEdit/FillTimes?handle={handle}
GET  /titan/get/2/Playbacks/Editor/Times/CueLegend
GET  /titan/get/2/Playbacks/Editor/Times/CueFadeInTime      .../CueFadeOutTime
GET  /titan/get/2/Playbacks/Editor/Times/CueDelayInTime     .../CueDelayOutTime
GET  /titan/get/2/Playbacks/Editor/Times/CueFixtureOverlap
GET  /titan/get/2/Playbacks/Editor/Times/CueLink / CueLinkOffset / CueLinkOffsetType
GET  /titan/get/2/Playbacks/Editor/Times/CueMode
GET  /titan/get/2/Playbacks/Editor/Times/CueMoveInDark(+Delay/Fade/Inhibit/Trigger)
GET  /titan/get/2/Playbacks/Editor/Times/CueTracking
GET  /titan/get/2/Playbacks/Editor/Times/CuePreload / CueNotes / CueCurve(Name) / CueSpeedMultiplier
GET  /titan/get/2/Playbacks/Editor/Times/PlaybackReleaseTime / PlaybackSpeed
GET  /titan/get/2/Playbacks/Editor/Times/FlashInTime / FlashOutTime / ChaseXFade / ChaseGlobalLink / ChaseBeatCount
GET  /titan/get/2/Playbacks/Editor/Times/Disabled ; /ActiveControlTime ; /AttributeList ; /CaptionText
```
> ⚠️ **两个必须计入成本的特性**：
> 1. 这些都是**单例作用域**的菜单属性，读的是"当前上下文 cue"。
>    导出一条完整 cue list 需要**循环**：每个 cue 号 → 设 `TimesEdit.CueNumber`
>    → `FillTimes(handle)` → 读属性。复杂度 **O(cues) 次 HTTP 往返**。
> 2. 这个过程会**改动控台的 UI 状态**（会移动操作员的时间编辑器选中项）。
>    → 分析必须选在非演出时段做，或先做好恢复。

**"这个 cue 里有哪些灯具" —— 只能算部分可读** ⚠️：
```csharp
Void Playbacks.SetEnabledHandlesToFixturesInCue(PlaybackCueHandle cueHandle)
  // "Sets the enabled handles to the fixtures in a playback cue"
Void Playbacks.SetEnabledHandlesToPlaybacks()
Void Playbacks.Editor.CueSelection.SelectCue / SelectCueByNumber / GetSelectedCues()
```
> ⚠️ `SetEnabledHandlesToFixturesInCue` 是**副作用式**地*设置* enabled handles，
> 要读出来还得再跳一次（`Handles.SourceHandle` 或分组的 `GetSelection`）。
> 文档从未给出干净的"给我 cue N 里的灯具"**取值器**。
> 且它只能告诉你**哪些灯具被碰过**，**永远不含数值**。

**运行时状态（用于现场监控）** ✅：
```csharp
CueLists.LiveCueNumber / NextCueNumber / LiveCueHandle / NextCueHandle / ConnectedHandle / CueListConnected
Chases.LiveCueNumber / NextCueNumber / ConnectedHandle / ChaseConnected
CueLists.Paused / Chases.Paused
Playbacks.Editor.SelectedPlayback / ContextCueNumber / ContextCue / CueToView
Masters.IsDeskBlackedOut / GrandMasterOutputLevel / IsMasterConnected / SelectedMaster
SetList.ActiveSetList / ActiveTrack / ContextTrack / ContextSetList
Titan.ActiveSessionId / StartState / DmxOutputEnabled
```

### 3.10 ★ 纯 HTTP 双向数据通道 ✅
| 方法 | 签名 | 方向 |
|---|---|---|
| `UserMacros.ExportXml` | `(String macroId) → String` | 控台 → PC（返回 UTF-XML 字符串） |
| `UserMacros.ImportXml` | `(String script)` | PC → 控台 |

> 这是除 `Command.RunCommand` 之外的第二条注入通道。宏格式需参考 Avolites 宏参考手册。

### 3.11 ★ `Command` 通用后门 ✅
```
GET /titan/script/2/Command/RunCommand?command=<Titan 命令行语法>
```
- `Command.RunCommand(String command)` —— 直接执行命令行语句
- `Command.RunGroupCommand(userNumber, command)` / `RunToggleGroupCommand(command)`
- 增量构造：`AppendString(text)`、`AppendStringAndPreview(text)`、`AppendNumeral(value, preview)`、
  `AppendFloat(value)`、`AppendUserNumber(value)`、`AppendHandleUserNumber(handle, handleName)`、
  `AppendMaskAttribute(wheelIndex)`、`AppendMaskFromWheelAlias(letter)`、`AppendMaskAndPreview(bankButtonIndex)`
- 状态：`CommandLineText`（读写）、`AtVisible`（读写）、`SelectionMode`（读写）、
  `LastCueSelection`（读写）、`Backspace()`、`StartNewCommand()`、`RemoveLastCueSelection()`
- `Command.AppendStringAndPreview` 文档注明：若追加后命令非法则会被拒绝

> **意义**：凡未被 API 干净暴露的操作都可用原生命令行语法兜底。
> 应作为编光层的默认实现手段之一，而非最后手段。
> 另有 `Menu.InjectInput` / `Menu.InjectValueChangeInput` / `Menu.InjectPanelInput`
> 等菜单注入方法作为更末位的兜底。

### 3.12 撤销 / 历史 ✅
`History.Undo()`、`Redo()`、`GotoTransaction(Guid id)`、`CreateRestorePoint(String type)`、
`CreateThreadToken(String description)`、`DisableUndoProgrammer`（读写）

## 4. 关键枚举取值 ✅

| 枚举 | 取值 |
|---|---|
| `AcwTimecodeSource` | None / Internal（内部计时）/ UsbExpert / Winamp / System（内部系统时钟）/ **Smpte（SMPTE 时码输入）** |
| `AcwFrameRate` | Fps24 / Fps25 / Fps29DF / Fps30 / Fps44 / Fps60 / Fps100 / Fps1000（毫秒） |
| `TimelineTriggerTypes` | None / Playback / WaitForGo / FadeToLevel / GoToCue / Preload / Flash / Swop / Marker |
| `AcwTimelineCuelistCueGoMode` | None（不加 go 命令）/ All（每个 cue 都加）/ Timecode（按时码时间加） |
| `AcwTrackingType` | Global / Track / Block / Solo / CueOnly / Individual / SoloEffects / BlockEffects / NotSet |
| `RequestInfo` | None / Fixtures / PlaybackMemories / PlaybackChases / PlaybackCueLists / Timelines / Palettes / Groups / All |
| `DjTapDeckNames` | DJ tap 时码流类型（枚举页未展开具体值） |

## 5. 各 Provider 规模（页面数）

| Provider | 页数 | | Provider | 页数 |
|---|---|---|---|---|
| Editor | 373 | | Patch | 86 |
| Playbacks | 364 | | Palettes | 83 |
| Programmer | 321 | | Timelines | 73 |
| Attribute | 207 | | Menu | 64 |
| Handles | 150 | | Masters | 62 |
| HandleOptions | 131 | | UserSettings | 58 |
| Palette | 107 | | SetList | 56 |
| Timecode | 105 | | Profiles | 55 |
| Group | 99 | | Triggers | 55 |
| Selection | 96 | | Fixtures | 53 |

## 6. 尚未确认的事项（需连真控台）

> 说明：以下均为**文档未覆盖、只能实测**的事项。已确认的硬约束见 §0。
> 第 1–3 项原为"未知"，调研后已**降级为已确认的限制**，故不再列为待确认。

| # | 事项 | 影响 | 验证方法 |
|---|---|---|---|
| 1 | `script/` 响应体的**线格式**（JSON？XML？带引号？） | 决定整个客户端解析层 | 调 `UserMacros/ExportXml` 看原始响应 |
| 2 | `Reports.GenerateReport` 的 `format`（`ExportType`）取值 | 决定 R2 报告路线可用性 | 试调，观察返回/报错 |
| 3 | 报告能否取出，还是只落控台本地盘 | 决定 R2 工作量 | 调 `SelectDevice` 后查有无下载端点 |
| 4 | 合法句柄分组名字符串全集 | 寻址正确性 | `Handles/GetGroup?handle_userNumber=6` 回读 |
| 4b | `GET /titan/handles` 端点在 16.0 是否仍存在 | 分组名发现能否走捷径 | 直接请求看是否返回 JSON（介绍页有、参考页零命中） |
| 5 | 非 playback 的 `handle_location` 语法 | 是否只能用 titanId | 交叉比对 `titanId` 与 location |
| 6 | `TimecodeTime` 的 `time={}` **线格式** | 决定能否写时码 | 探测 `Timecode/MakeTimecodeTime`；或读手工 cue 的 `Playbacks/Editor/Timecode/CueTimecode` |
| 7 | MTC 是否可作时码源（文档只列 Smpte） | 决定 R4 路线 A 成本 | `Timecode/AvailableSources`；试 MIDI 输入 |
| 8 | 支持的 DAW 标记映射列表 + CSV 格式 | 决定 R4.3 是否走 CSV | `Timelines/MarkerMappingList()` + `PopulateMarkerMappingList` |
| 9 | 控台是否可挂网络共享 | 决定 R5 高速通道可行性 | `Show.CurrentPath` / `AcwPathDeviceKey` 探测 |
| 10 | 如何通过菜单触发 show 加载（`Menu.*` 的哪个 id） | **决定 R5 最大不确定性** | 观察控台加载时的 `Menu` 调用 |
| 11 | `Titan.SyncNow()` 能否作为绕过文件通道的同步路径 | 备选注入架构 | 主从配置后试调 |
| 12 | 未文档化的枚举：`SetRecordType` / `masterType` / `LockStates` / `HandleOperations` / `MenuEventTypes` | 各功能细节 | 逐项试调 |
| 13 | Tiger Touch 实际 Titan 版本与功能授权 | 决定 timecode/timeline 可用性 | `System/SoftwareVersion`、`Titan/DeviceInfo` |
| 14 | **`POST` set 的请求体编码**（裸值 / JSON / 表单） | **所有写属性操作** | 对一个无害属性各试一种 |
| 15 | **`AcwUserNumber` 是否普通整数** | 约 15 个关键方法 | 试 `Group/StoreGroup?userNumber=99`（43 处占位符零字面量示例） |
| 16 | 盲编是否真的抑制 DMX 输出 | R1.5 行为预期 | 开盲编后观察实际输出 |
| 17 | 427 个对象参数方法的替代映射是否齐全 | 实现工作量 | 按 §2.1.1 对照表逐个验证 |

## 6.1 音乐卡点专项结论（已核实）

### 🔴 API 无法注入时码或节拍
`AcwTimecodeSource` = `{None, Internal, UsbExpert, Winamp, System, Smpte}` ——
**没有 LTC / Art-Net / sACN / MTC 成员**。`Smpte` 是唯一外部输入源。
→ 帧级卡点必须引入 API 之外的通道（LTC 编码器 + 音频接口，或 MTC 走 MIDI）。

### 三条可行拓扑
| | 机制 | 精度 | 硬件 |
|---|---|---|---|
| **A（首选，高保真）** | PC 从**同一份音频**生成 LTC/MTC 馈入控台；控台按时码打 cue | 帧级（音频与时码同源同钟，抖动为零） | 需编码器 + SMPTE/MIDI 通路 |
| **B（推荐，零硬件）** | `SetTimecodeSource(id, Internal)` + `Timecode<X>.Play/Pause/Reset` + `SetStartTime`；PC 自己按时发 cue | LAN 上典型 1–5ms，最差数十 ms | 无 |
| **C（仅效果）** | `Masters.SetSpeed(bpmMaster)` / `TapTempo` + `HandleOptions.Playbacks.AssignSpeedSourceFromHandle` | 节奏锁定，**非** cue 锁 | 无 |

### ★ 排练即录制（零硬件实现精确卡点）
```
TimecodeOne/SetSource?source=Internal  →  TimecodeOne/Play  →  Timecode/Record(true)
  每个重音： CueLists/NextStep?handle_location=..  +  Timecode/AssignTimecode?handle_location=..
Timecode/Record(false)
```
`Timecode.Record` + `Timecode.AssignTimecode(handle)` 把**当前实时计时值**盖到 cue list 的**下一步**。
→ 放音乐、跟重音按 GO，排练一遍就得到带真实时码的 cue list。**全程 HTTP。**

### 时码写入的完整链路 ✅
```
Playbacks/CueList/CreateCueList → Playbacks/StoreCue → Playbacks/GetPlaybackCueId
→ Timecode/SetCueTimecode（或 SetCueTimecodeWithCueNumber）
→ 武装：POST /titan/set/2/HandleOptions/CueLists/{ContextHandle, TimecodeConnected, TimecodeSource}
   （注意 Playbacks/Timecode/ToggleEnabled 只是 toggle，不能用来设值）
```
回读只能走 cue 时码编辑器（`Playbacks/Editor/CueSelection/SelectCueByNumber`
+ `Playbacks/Editor/Timecode/RefreshTimecodes` + `GET .../Timecode/CueTimecode`），
**无批量 get** → 客户端必须自己缓存一张表。

### ★ 标记导入：不要猜 CSV 格式
`Timelines.ImportMarkers(timelineId, importMappingVersion, csvFilePath, frameRate)`
需要 CSV 文件 + 显式帧率 + 映射版本，但**接受的标记格式完全未文档化**
（全语料零命中 Reaper/Ableton/Logic/Cubase/Pro Tools）。

**更稳的替代** ✅：`Timelines.CreateOrUpdateMarker(handle, externalId, time, legend)`
—— **幂等 upsert，专为外部生产者设计**。→ DAW 卡点标记应走这条。

### 不要作为主同步的两条
- ❌ **Audio trigger**：`threshold` 与 `useLevelMatching` 参数文档均标注 **"Not Used"**，
  频段未枚举，输入依赖物理 USB 面板；
- ❌ **BPM trigger**：仅由 Pioneer DJ Tap 喂数据
  （不过 `PioneerDJ.BindDeckToMaster(deckId, AcwMaster)`（Master=8, LayerA=6, LayerB=7）
  确实是真实的 CDJ BPM 入站通道）。

### 其他时码能力
- `Timelines.EnterTimelineLiveRecord` / `ExitTimelineLiveRecord` / `IsLiveRecording`
  —— 在 `[start,end]` 窗口内把**已触发的 playback + 电平**捕获成 timeline trigger（与"排练即录制"是两件事）
- `Playbacks/Editor/Timecode/Add` / `Subtract(offset)` 与 `TimecodeOffset`
  —— "整首歌挪 N 帧"的现成 API
- `AcwTimelineCuelistCueGoMode = Timecode` —— 把带时码的 cue 分解到时间线网格上
- `Triggers.AddSAcnTrigger` / `AddMidiTrigger` —— 文档完备的远程节拍注入（走网络）

## 7. 本机环境实测

| 项 | 结果 |
|---|---|
| 工作目录 | `/Users/lijiarui/Documents/BNDS Tiger Touch` |
| 仓库 | `github.com/bndsljr/BNDS-Tiger-Touch`，分支 `main` |
| Node | v24.16.0 |
| npm / pnpm | 11.13.0 / 10.33.0 |
| Python | 3.14.5 |
| Go / Rust / Docker | 均未安装 |
| Avolites 安装 | `/Applications` 中无 |
| 本地控台 | `127.0.0.1:4430` 无响应 |

> 结论：**本机既无控台也无官方模拟器**，`titan-sim` 是本项目必需的开发基础设施。
