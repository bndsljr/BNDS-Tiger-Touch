# BNDS Tiger Touch

> 北京十一学校剧场所用的 Avolites **Tiger Touch V16** 控台配套工具链。
> 目标：把「在控台面板上手工点」变成「在电脑上描述 → 批量生成 → 联机微调」。

## 这是什么

一套围绕 Avolites Titan 官方 WebAPI（HTTP 4430）构建的编光 / 分析 / 演出 / 灌入工具链，
用于学校剧场的日常演出准备与运行。

要实现的五项需求：

| # | 需求 | 说明 |
|---|---|---|
| R1 | 电脑端快捷编光 | 用文本描述生成调色板、编组、场景，批量编程 |
| R2 | Agent 分析已有程序 | 读出现有 show 结构与元数据，做体检、生成提示本 |
| R3 | 剧场快捷变光系统 | 基于 Set List 的走 cue 表，GO = `NextTrack()` |
| R4 | 音乐灯光卡点 | 音乐时间轴 ↔ cue，含「排练即录制」工作流 |
| R5 | 预编程 → 批量灌入 | 离线编好，连上控台一键生成 |

## 当前状态

**阶段：需求与可行性调研完成，等待评审拍板。**

尚未开始编码。先读文档：

- **[`docs/00-需求大纲.md`](docs/00-需求大纲.md)** —— 需求大纲（**从这里开始**）
- [`docs/01-API调研笔记.md`](docs/01-API调研笔记.md) —— API 能力与限制的核实记录

### 调研的三个关键结论

✅ **好消息**：Titan 有原生的剧场走 cue 模型（`SetList`，GO 就是 `NextTrack()`），
批量编光、调色板、编组、甚至整个灯具配接表都可远程编程；
还有一个「排练即录制」流程能用**零硬件**实现精确音乐卡点。

🔴 **必须知道的限制**：
1. **cue 内的属性数值读不出来** —— 只能读元数据。所以 R2 的「内容级」分析
   必须改走离线解析 show 文件或外部 DMX 抓包。
2. **控台没有文件上传/下载通道**，而且**连"加载一个 show 文件"都没有 API**。
3. **WebAPI 无法注入时码或节拍** —— 帧级卡点必须引入 API 之外的硬件或 MIDI 通道。

详见 `docs/00-需求大纲.md` 的 §0 与 §9。

## 仓库结构

```
.
├── docs/
│   ├── 00-需求大纲.md          需求拆解、架构、路线图、风险
│   └── 01-API调研笔记.md       API 能力与限制（已验证事实）
├── tools/
│   └── fetch_titan_api_docs.py 抓取全量 Titan API 文档为本地语料库
├── .cache/                     本地缓存（不入库）
└── LICENSE
```

## 常用命令

抓取 Titan API 全量文档为本地可检索语料库（约 3705 个方法页）：

```bash
python3 tools/fetch_titan_api_docs.py --version 16.0 --out .cache/api-docs
```

产出 `.cache/api-docs/ALL.txt`（全文，可 grep）、`pages.txt`、`summary.md`。

原理：docfx 站点在 `index.json` 的 `keywords` 字段里包含每个 API 页面的**完整正文**
（描述 + 签名 + HTTP 示例 + 全部参数），因此一次请求即可获得全站内容。

检索示例：

```bash
# 列出某 provider 的所有方法
grep -o '@@@ api/SetList\.[^ ]*' .cache/api-docs/ALL.txt

# 读某个方法的完整文档
python3 - <<'PY'
import re
s = open('.cache/api-docs/ALL.txt').read()
secs = dict(re.findall(r'@@@ (\S+)\n(.*?)(?=\n@@@ |\Z)', s, re.S))
print(secs['api/Playbacks.StoreCue.html'])
PY
```

## 免责与安全

- 本工具通过官方 WebAPI 控制控台。**API 在局域网上无鉴权**，
  任何能访问 4430 端口的人都能完全控制演出输出 → 演出网络必须隔离。
- 演出期间不要把本工具无人值守地暴露在网络中。
- 所有批量写操作都应在撤销事务（`History.CreateThreadToken`）保护下执行。

## 许可

见 [LICENSE](LICENSE)。
