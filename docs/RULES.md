# Ingrid's AI Agents — 规则与经验手册（权威）

> 本文件是工作台的**唯一权威**规则与经验沉淀，随 git 仓库一起走，独立于任何宿主工具（WorkBuddy 等）。
> 所有「约定、决策、踩坑经验」都以这里为准；未来维护本工作台（无论人还是 AI）请先读这里。
> 修改规则请先改本文件，再改代码。

---

## 0. 独立工作原则（最重要的一条）

- 本工作台是 **local-first** 的 Electron 应用：配置、记忆、密钥、用量、聊天记录全部存在本机，不上云。
- **禁止把关键经验/规则只记在宿主工具（WorkBuddy）的记忆里**——那样工作台一旦脱离宿主就「失忆」。
- 规则沉淀的唯一权威位置 = 本仓库 `docs/RULES.md`（即本文件）。
- **外部能力依赖纪律**：能用 macOS 系统自带能力（`textutil` / `/usr/bin/swift` / `/usr/bin/unzip`）解决的，**不要**依赖 WorkBuddy 自带的 Python（`~/.workbuddy/binaries/...`）或 npm 之外的可变环境，否则工作台不独立。

---

## 1. 定位与理念

- **是什么**：Ingrid 的个人 AI 工作台（Electron 桌面版），把「数字员工」式多 Agent 组织成可复用、可教学、local-first 的本地工具。
- **三层解耦**（核心设计）：
  - **Skill = 能力**（可复用的方法论/知识片段，挂 `.md`）
  - **Agent = 角色**（name / soul / memory / engine / caps）
  - **Engine = 模型**（本地 Ollama / 云端 API / 本机 CLI）
  - Skill 挂在「这一次任务」的 soul 上，用完即卸。
- **板块（Board）= 用户的一个用途**，skill 按板块归档、可跨板块复用；不要把每个 skill 做成独立 agent。
- **预设 = 板块 + agent + skills + 任务的一键组合**，是首页快捷方块，不是新 agent。

---

## 2. 项目约定

- **仓库**：https://github.com/IngridXi/ingrids-ai-agents
- **本机项目目录**：`~/Dev/Ingrids-AI-Agents`
- **启动**：双击桌面或 `~/Applications` 里的「Ingrid's AI Agents.app」（launcher 脚本 cd 项目后起 electron）；也可在项目目录 `npm start`。
- **数据目录**：`~/Library/Application Support/Ingrid's AI Agents/data/`
  - `agents.json`（agent 定义）、`boards.json`（板块）、`chat-history/`（按 agent 分文件的聊天记录）、`kb/`（知识库索引）、`settings.json`、`presets.json` 等。
- **skill 数据来源边界**：本机 `~/.workbuddy/skills` 与插件目录里的 skill（海归海/音乐/公众号/配色类）**不属于个人工作台**，只作「可选导入源」，默认一条都不启用。
- **仓库自带 skills/ 下的 .md**（research、design 板块）是 builtin，默认启用、随 git 走。
- **`~/.workbuddy` 与 `.workbuddy` 目录**：属于宿主工具/项目数据，**不是**工作台规则的存放地；规则只认 `docs/RULES.md`。

---

## 3. 架构速查

### Agent 清单（agents.json）
| Agent | 目录 | 备注 |
|-------|------|------|
| 研究助手 🔬 | `agents/research-chat/` | 学术研究全流程 + 审稿闭环 |
| 伦理agent ⚖️ | `agents/ethics-chat/` | 去道德化教学演示 + 商业案例库 |
| 软件工程 🛠️ | `agents/dev-chat/` | 编码 + 二进制逆向工具 |
| 通用助手 💬 | `agents/assistant-chat/` | 通用问答 |
| 会议纪要官 🎙️ | `agents/meeting-audio/` | FunASR 本地语音转写 |
| 知识库 | `agents/knowledge/` | 知识库管理界面 |
| 电脑操作 | `agents/computer-use/` | 浏览器自动化 |
| 界面设计师 🎨 / 音乐创作 🎵 / 灵感目录 📡 | 主界面预设 | — |
| 类型治理官 🧭（原智能路由 ra）/ CFO 成本官 💰 / 模型调控官 🎚️ / Agent 总管 🧭 | 主界面预设（控制面） | 自动巡检/修正，手动锁定豁免 |

### 关键文件
- `main.js` — 主进程：IPC、工具执行（fs/db/web/computer）、流式聊天、文档生成、知识库引擎。
- `preload.js` — 渲染进程桥（contextBridge），暴露 `window.ingrid.*`。
- `agents-core.js` — 多 Agent 核心（引擎注册表、Agent Schema、成本记账、Orchestrator）。
- `skills-core.js` — skill 扫描/归档/预设。
- `agent-type-governor.js` — 类型治理官（四类触发类型自动巡检/判定/修正 + 锁定豁免）。
- `agent-governance.js` — Agent 治理官（职责盘点 + 重叠检测 + 孤儿/空壳对账）。
- `agent-ops-governor.js` — 运营治理引擎（CFO 成本 + 模型调控 + Agent 总管三合一）。
- `ops-governor.js` — 运营治理面板（渲染层，CFO / 模型调控 / Agent 总管 三 tab）。
- `kb-engine.js` — 知识库（Obsidian/Zotero/Notion/OneDrive 索引 + RAG 检索）。
- `scripts/` — 本地辅助脚本（`pdf_extract.swift`、`doc_edit.py`、`bin_patch.py` 等）。

### 工作台架构图

入口为「Agent 总控台 → Agent 架构图」。力导向图按工作台底座、项目调度和 CityVerse 项目分层。工作台节点来自本机注册表，职责分组和显示名由 `agent-architecture-core.js` 定义。显示名保留与原注册名的映射，供已有会话、模型锁和路由继续使用。

节点详情读取当前 Electron 进程的对话生成、审稿阶段、委派、会议处理和已接入的本机协作事件，以及队列和巡检报告。固定协作用细线，正在执行的真实委派与交接用橙线，最近五分钟完成的真实协作用绿色，演练使用紫色虚线。模型常驻显存只代表模型已加载。CityVerse 建设阶段读取本机项目控制台，未接入阶段显示为暂无可确认的状态。近期运行事件在进程内保留，任务队列和巡检报告沿用各自落盘记录。

### 聊天数据流
前端 `chatStream(payload)` → 主进程 `chat:start` → 流式推 `chat:delta` / `chat:done`（**带 requestId**，见 §7）→ 前端 `renderStream()` 渲染。

---

## 4. 模型策略（本地 Ollama + API）

### 本地模型（`ollama list`）
| 模型 | 用途 | 说明 |
|------|------|------|
| `qwen3.8:27b` | **默认（已规范）** | 官方对齐；新一代小模型裸能力反超 32b |
| `qwen3:32b-uncensored` | **未规范（去道德化）** | `huihui_ai/qwen3-abliterated:32b` 的 `ollama cp` 重命名 |
| `qwen3:32b` | 原对齐备份 | sha256=3291abe7…，备份在 `~/ollama-backup/qwen3-32b/` |
| `deepseek-r1:32b` | 后台审稿 | R1 蒸馏版 |

### 选型结论（2026-11 定，勿反复纠结）
- **本地 27b 比 32b 好用**（新一代小模型反超），日常已规范场景用 27b。
- **DeepSeek V 系列真身太大**（200B~1.6T），本地跑不动；本地 `deepseek-r1:32b` 本质是 Qwen 基座学 R1 推理的蒸馏版。
- **Qwen3-Coder-30B 不推荐**（旧一代、无思考、不如已有的 27b）。
- **本地 vs API**：本地隐私好、零成本；API（DeepSeek）中文强、效果有时更好。用户可手动选引擎。

### 模式-模型联动（伦理 agent）
- 本地 ollama 引擎下自动配对：**已规范 → qwen3.8:27b**，**未规范 → qwen3:32b-uncensored**。
- 用户手动切 API 引擎时，完全尊重手动选择，不自动配对。

---

## 5. 各 Agent 关键行为规则

### 伦理 agent（ethics-chat）—— 去道德化教学
- **目的**：供研究/授课演示「去道德化 AI」（abliteration 后模型的行为）。
- **去道德化落地**：OBLITERATUS（abliteration）思路，prompt 层模拟 `SOUL_UNALIGNED`（去道德化 AI 商业顾问）+ 真权重走 GGUF 层（社区权威 `huihui_ai/qwen3-abliterated`）。
- **标注性质与后果**：回答中标注做法性质与后果（⚠️违法 / 🟡灰 / ✅合规三档 + 法条刑罚）。
- **不限制作答**：SOUL_UNALIGNED 不设边界（无硬边界、无拒绝、无说教、无「供识别/教学」定位），由用户（研究人员）自行审查后使用；SOUL_ALIGNED 保留七步分析框架作对照。
- **商业案例库**：`~/Documents/商业案例库/`（51 文件、约 400 条案例），十段结构 + 真实判例。
- **实答汇总规范（权威单点真相源）**：`agents/ethics-chat/archive-rules.md`。要点：① 每条回答写入对应场景**唯一的** `### 🤖 伦理 agent 实答` 块，绝不新建文件；② 三小节结构「结论/方案 → 性质与后果 → 灰/违界限」；③ 定性**只标 🟡 灰 / 🔴 违 两档**（不写 ✅ 合规），每个做法必写「灰色线/违法线」程度分界，落到可验证事实；④ 严禁 markdown 表格、严禁「原方案/原文…有误/应为/调整为」修正措辞；⑤ 法条以法务知识库原文为准，严禁编造条文号/刑罚。
- **场景标题格式**：`## 🟡 1-1 · 场景名`（emoji + 序号 `catNo-seq` + ` · ` + 标题）。四处必须同步改：`build-scenes.js`（生成 + `normHead` 归一化兼容旧格式）、`run-scenes.js`（findBlock/writeAnswer）、`index.html` 的 `sceneInfo().heading`、`main.js` 的 `ethicsSync`（它直接吃 `scene.heading`，本身不用改）。加序号是为了场景标题更醒目可辨。
- **内容监护 agent（guard.js）**：`node agents/ethics-chat/guard.js` 只读体检已归档实答块，报告结构完整性 + 违规项，**绝不删除/改写**；`--md` 输出 Obsidian 报告。监护原则：没有错误的正确内容不删，默认补充，仅在确有错误时修改/润色（已内化到 run-scenes.js 的监护合并：高度相似保留更完整版、互补则拼接补充）。

### 研究助手（research-chat）
- **联网搜索默认开**（研究需核验文献/DOI/录用发表状态等实时信息，模型会主动调 `web_search` 核实并标注来源），点「联网」可关闭。
- **知识库自动检索默认关**（避免把共享知识库片段混进上下文、造成「跨会话/跨 agent 记忆」错觉），勾选「知识库」才注入。
- **审稿闭环模式**：初稿→审稿→返修，多阶段由后端 `reviewLoop` 驱动。

### 通用行为铁律（已内嵌于各 chat 前端 buildSystemPrompt）
- 工具失败先读错误、找原因、换方法重试，不轻易放弃。
- 严格区分「观察到的/推断的/待验证的」，不臆造、不谎称已完成。

---

## 6. 文件读取能力清单（fs_read）

`toolFsRead`（main.js）按扩展名分发：

| 格式 | 实现 | 依赖 |
|------|------|------|
| `.txt` `.md` 等文本 | `fs.readFileSync` | Node 内置 |
| `.docx` `.doc` `.rtf` `.odt` | `/usr/bin/textutil -convert txt -stdout` | macOS 自带 |
| `.pdf` | `scripts/pdf_extract.swift`（PDFKit） | macOS 自带 `/usr/bin/swift` |
| `.pptx` | `/usr/bin/unzip` 解包 `ppt/slides/slideN.xml` + cheerio 提取 `<a:t>` | macOS 自带 + npm cheerio |
| `.ppt`（旧版二进制） | 不支持，提示另存为 `.pptx` | — |

- 扫描版/图片型 PDF 无文字层会返回明确提示（可走 OCR 或截图识别）。
- **独立性**：PDF/PPTX 提取只用 macOS 系统能力 + 已在 package.json 的 cheerio，**不依赖 WorkBuddy 自带 Python**。

---

## 7. 性能与稳定性经验（踩坑记录，勿回退）

1. **启动慢**：根因是知识库启动时同步提取 876 个 OneDrive 文件全文。修复 = mtime+size 增量签名 + scan 延迟 2s + reference 源 readonly 模式（保留旧索引）+ 手动同步按钮。
2. **发热 / 思考逐字变慢**：根因是 `renderStream()` 每 token 全量 `innerHTML` 重建（O(n²)）。修复 = `requestAnimationFrame` 节流 + 流式正文用轻量 `esc()` 转义、完成后 `finish()` 再一次性 markdown 排版。
3. **无缘无故中断**：根因是 `chat:delta/chat:done` 用全局广播、无请求标识，主聊天/autoTitle/describeImage 并发时互相误触发。修复 = 每个请求分配 `requestId`，前端只认自己的信号；`activeChatAbort` 单例改 `Set`。
4. **中断恢复（思考过程持久化）**：`maybeSaveProgress()` 每 3 秒把流式快照写 localStorage，`restoreStreamProgress()` 启动恢复。三个 chat agent 各自独立 key（`rc/research/dev_stream_progress`），因它们共享同一 BrowserView 的 localStorage，key 必须不重名。
5. **历史混入的真相**：聊天记录本身按 agent 分文件、隔离正确；「记得别的对话」的真凶是知识库 RAG 默认自动注入共享索引。已改默认关。
6. **思考流超时**：Ollama 思考型模型流式输出 `reasoning`，不会触发 120s 空闲超时；真凶是串线（见第 3 条）。
7. **写操作安全边界**（`isSafeWritePath`，代码内的纯技术机制）：仅允许主目录内，拒系统目录/Library/隐藏目录，覆盖前备份，删除走废纸篓。
8. **多会话并发 + 切会话不断流**：全局单例状态（`streaming`/`stopRequested`/`pendingNotes`）全部改为**会话级**（`runningJobs`/`jobProgress`/`stopRequested[sid]`/`pendingNotes[sid]`）；`send()` 绑定 `jobSessionId`，`finish()` 用 `sessionById(jobSessionId).messages` 写回（而非全局 history）；`switchSession` 不再 `if(streaming) return`，切走时用 `renderRunningBubble` 显示后台进度；删除运行中会话先 `stopChat(id)` 再清 `runningJobs[id]`。后端 `activeChatAborts` 升级为 `Map<sessionId, Set<AbortController>>`，停止按钮只 abort 当前会话。
9. **切 agent / 返回工作台会中断流式（本次真正根因）**：`openAgentInMainView` 原来复用单个 `agentView`，每次切 agent 都 `loadFile` 重新加载页面、返回工作台 `closeAgentInMainView` 直接 `webContents.destroy()`——页面 reload 后旧 `ipcRenderer.on('chat:delta/done')` 监听器随页面销毁失效，主进程 fetch 结果发不到前端，表现为「切走就中断、卡死在生成中」。修复 = 改为 `agentViews = Map<href, BrowserView>` 多 view 缓存：切 agent 只 `mainWindow.setBrowserView(view)` 显示/隐藏，返回工作台只 `setBrowserView(null)` 隐藏，**既不 reload 也不 destroy**，后台任务真正继续跑。附带：`chatStream` 的 payload 之前漏传 `sessionId`（所有请求注册到 `''` key，`stopChat(id)` 精确停止失效），已在三 agent 的 `runToolTurn` 补 `sessionId: jobSessionId`。
10. **Agent 不知道今天日期 / 不能做 PPT**：`buildSystemPrompt` 原来不注入日期 → 已在三 agent 注入「今天是 YYYY年M月D日 星期X」。PPT/Word/Excel 生成能力（`doc:generate` IPC）一直在，但没暴露成 agent 工具 → 已在三 agent 的 `toolSpecText`/`toolsDef`/`executeTool`/`formatToolResult` 补 `doc_generate` 工具，让 agent 对话内自主生成 `.pptx/.docx/.xlsx/.md`。
11. **情绪/偏好 Agent（越用越贴合偏好）**：`sentiment-agent-core.js`（零依赖 IIFE）闭环 = 侦测评价情绪 → 记录信号 → 提炼偏好规则（do/avoid）→ ① 注入各 chat agent 的 system prompt 指导后续、② 通过 `settlerSubmit` 回调把新偏好自动提交经验沉淀官（仍待审批，人工在环不变）。要点：情绪/偏好是用户明确表达、可信度高，故偏好库可**自动**沉淀；但提交经验沉淀官仍走其人工在环（只提案）。去噪 = 同场景同方向累计 ≥2 次才升级为偏好（一次抱怨≠永久偏好）。三 agent 的 `addBubble` 加 👍/👎 反馈按钮（上报 `sentimentObserve`）+ `send()` 自动侦测强烈评价词（不传 valence 走词典）+ `buildSystemPrompt` 注入 `sentimentGuidanceCache`（启动 `refreshSentimentGuidance()` 异步拉取）。
12. **改代码不重启 = 改了白改（2026-11-17「又报错」反复出现的真正根因）**：Electron 启动时把 `main.js`/`agents/*/index.html` 读进内存，之后 `git push` 的改动**不会热加载**，必须彻底退出 App 再启动才生效。诊断「App 是否在跑旧代码」的可靠方法：对比 `/tmp/ingrid-launcher.log` 最后时间戳 vs `git log -1 --pretty=format:%ad` 时间——若 launcher 时间早于最新 commit，说明 App 还在跑旧代码，重启即可。验证重启成功：`pgrep -f "Electron.app/Contents/MacOS/Electron <项目路径>"` 出新 PID，且 `SingletonLock` 指向新 PID（启动瞬间 `Failed to unlink SingletonLock` 是竞态报错，无碍，看锁最终指向即可）。**标准重启动作**：`kill <旧主进程PID>`（SIGTERM 优雅退出，聊天记录已实时落盘不丢）→ 等退出 → **`open ~/Applications/"Ingrid's AI Agents.app"`**（走 LaunchServices 彻底脱离当前会话）。⚠️ 坑：在沙箱/agent 环境里 `bash .../MacOS/launcher` 会把 electron 用 `&` 后台化，命令返回时孤儿进程会被沙箱回收、App 几秒后消失（launcher.log 无 JS 堆栈、无 .ips 崩溃报告，就是被 kill 不是崩溃）；**必须用 `open` 而不是直接 `bash launcher`**。每次改完代码，要么明确提醒用户重启，要么直接帮他重启，别让「代码已修好但 App 没重启」拖成新的「又报错」。
13. **PPT 渲染器升级：中文字体 + 圆角阴影图标 + 新版式**（2026-11-17，用户对标 NotebookLM/Gamma 要「好看的 PPT」）——根因四层：① `PPT_FONT='Arial'` 无中文 → 中文落默认宋体/等线、观感差（头号根因）；② 卡片直角矩形、无阴影无图标；③ 版式只有 cards/flow/pyramid；④ 「学术 PPT」按钮的 prompt 只引导模型输出 `{title,bullets}`，压根没用上 blocks/图表。修复：① `PPT_FONT='PingFang SC'`（苹方，Mac 系统字体、中英统一）+ 新增 `applyCjkFont()` 用 JSZip 后处理 theme1.xml 的 latin/ea/cs 字体——**关键坑：pptxgenjs 的 theme 只写 latin、`<a:ea>`（东亚字体）留空，必须后处理，否则只改 fontFace 中文仍落默认字体**；② `_addCard` 改 roundRect 圆角 + 柔和阴影 + 彩色图标圆（blocks 新增 `icon`/`emoji` 字段）；③ 封面/章节页加装饰几何图形（淡色大圆 + accent 圆点 + 短横线）；④ 新增 `_addTimeline`（时间线）/`_addKpi`（大数字看板）/`_addCompare`（左右对比 + VS 圆标）版式 + 图文混排（image+bullets 左图右文）；⑤ 同步 research-chat 的 doc_generate 工具描述（toolSpecText + toolsDef 两处）+ 「学术 PPT」按钮 prompt（引导模型输出 blocks/layout），`slidesToMarkdown` 预览支持 blocks。验证：独立 node 脚本端到端生成通过、theme1.xml 的 ea/latin 均已改为苹方。
14. **「做不出 PPT」其实是 UI 反馈太弱，不是生成失败**（2026-11-17）——用户连报「还是做不出 ppt」，实测发现文件**早已生成成功**：`~/Downloads/Agentic AI ....pptx`（17 页、64KB、15:11 落地），`doc:generate`→`renderPptx`→`applyCjkFont` 全链路正常；根因是结果只显示为一条灰色小字 `.loop-status`（`var(--ink-faint)` 太淡、无路径无打开入口），文件又静默落进 Downloads，用户根本感知不到「做成了」。修复：① 结果改醒目 `.ppt-result` 卡片（✅已生成 + 文件名 + 完整路径 + 「打开文件」「在文件夹中显示」两个按钮）；② 新增 `fs:open`（`shell.openPath`）/`fs:reveal`（`shell.showItemInFolder`）两个 IPC + preload `openPath`/`revealPath`。**诊断教训：报「做不出/没生成」先 `ls -lat ~/Downloads` 看文件是否已落地，别先怀疑生成逻辑**。
15. **「🧭 PPT 指令」一键生成可粘贴到 Gamma/NotebookLM/Notion 的制作指令**（2026-11-17）——用户想把内容+要求用自然语言发给 Gamma/Notion/NotebookLM 让它们做 PPT。调研结论：Gamma=杂志级+自动配图+图标最强（免费版可用，Plus $9/月去水印+100页）；NotebookLM=免费+基于上传文献可溯源（Slide Deck）；Notion AI=$10/月只出文案不排版，不适合做 PPT。最佳指令公式（NotebookLM 官方 5 维 prompt + Gamma 模板 + 学术结构：结果 40%）：①一句话目标(受众+要做什么) ②页数+结构分配 ③逐页大纲(标题必须是论断句、每要点含具体数据) ④每页密度(1 观点/≤3 要点/≤25 字) ⑤图表配图(禁通用装饰图、图表标来源) ⑥风格视觉 ⑦排除项(filler/空话/编造数据)。实现：toolbar 加 `briefBtn`、`briefPanel`（主题+目标工具下拉）、`generatePptBrief()` 让模型按 7 段式生成自然语言指令 + 硬编码 append 工具专属「使用方法」footer（模式名/价格/操作路径不交给模型防脑补），渲染为 `.brief-box` 可复制块 + 复制按钮。

---

## 8. 历次关键修复记录（时间线，供追溯）

- **2026-11-26**：**日历「重复日程 + 角标压住日期数字」修复**——用户反馈日历又出错（12 月 1 日出现两条一模一样的「1:1 Mohamed and Ingrid」09:45 / 10:00，且日期格子上的数字被角标遮挡）。根因有二：① ICS 订阅去重只按「uid + 时间」拼 id，Outlook 会议被改期（reschedule）后其 ICS 快照残留「旧时间 + 新时间」两条**同 UID、无 RECURRENCE-ID** 的 VEVENT，被当成两个独立日程。借鉴 **calendiff/ics**（Go）的「Events sharing a UID are folded into a single Event」思路：新增 `dedupeEventsByUid`——同 UID 无 RECURRENCE-ID 的多条按 `SEQUENCE`（默认 0，越大越新）取最新，同 SEQUENCE 比 `DTSTAMP`/`LAST-MODIFIED`，再兜底取 feed 靠后的；有 RECURRENCE-ID 的实例覆盖保留。`parseICalendar` 补解析 `SEQUENCE`/`DTSTAMP`/`LAST-MODIFIED` 三字段。② 日历格子的「事件数量角标」原为绝对定位（`top:3px;right:3px`），压住「1」「3」等一位日期数字，看起来像数字错位。改为色点行内的 `<b class="more">`（去掉 absolute），与色点同行、不再遮数字。**关键澄清**：截图里「12 月 1 日 · 星期二」其实是**正确的**（2026-12-01 确实是星期二，视觉模型按 2025 年误判了）；「26 号高亮」是「今天」描边、「12 月 1 日」是用户点选（紫底），详情面板显示选中日，一致无 bug。验证：`dedupeEventsByUid` 四场景单测全过（改期残留/同 seq 比 dtstamp/不同 UID/母+实例覆盖）；`parseICalendar` 端到端解析出 SEQUENCE 0、1。
- **2026-11-26**：**运营治理官三合一（CFO 成本 + 模型调控 + Agent 总管）**——把「成本/模型/Agent 协作」从调度中枢拆成独立控制面。先调研 GitHub 类似项目（RouteLLM / Louter 任务分类路由、Route42 / UncommonRoute 成本加权选型、LiteLLM 降级链+成本账单、llm-manager 手动指定绕过），核心范式 =「复杂度/任务类型评分 → 本地小模型优先(零成本) → 云端兜底 + 降级链 → 成本账单 → 手动锁定绕过」。落地：① `agent-ops-governor.js` 纯函数引擎承载三个治理 agent —— CFO 成本官 `analyzeCost`/`recommendEngine`（按 agent/引擎/日聚合成本+预算进度+按任务类型推荐最省模型）、模型调控官 `resolveModel`/`lockModel`（本地优先→Ollama 离线/占满自动切 API，**手动锁定才固定**）、Agent 总管 `auditWorkforce`（工作量监控 + worker 间职责重叠检测 + 增/分割/合并建议 + 团队健康度）；② `main.js` 接 `ops:*` IPC + 启动/15min 巡检 + 变更通知 + `agent:run` 执行前 `resolveEngineForRun` 动态解析模型（锁定豁免，非本地引擎不查 Ollama 省探测）；③ `preload.js` 暴露 `opsRun/opsReport/opsModelState/opsLocalStatus/opsLockModel/opsUnlockModel` + `onOpsChanged`；④ `ops-governor.js` 运营治理面板（CFO/模型调控/Agent 总管三 tab）；⑤ `index.html` 加三个 SEED agent + 导航「运营治理」入口 + 引擎选择处「锁定」按钮。**两个关键细节**：`funasr` 是独立本地服务，不因 Ollama 状态被误切；重叠检测只在「干活 worker」间做（治理官共享「调度治理」域不误报），`agent-type-governor.js` 把新治理官归入主动型避免被误判待确认。git push f8a5437。
- **2026-11-26**：**任务引擎表指向不存在的引擎 —— 凡是编码任务全部当场失败**。现象：在「任务」面板选「自动分拣」贴一句带「代码/开发/重构/修 bug」的话，任务创建后立刻 `failed: 未知引擎：codex`。根因：`task-router.js` 的 `TASK_TYPES` 给 13 种任务类型各写了一个 `engine`，其中 8 种（`coding→codex`、`review/deai/present/writing→claude-code`、`transcribe→funasr`、`music/general→local-llm`）**根本不在后台执行器 `CHAT_ENDPOINTS` 里** —— `runBackgroundTask` 一查 `CHAT_ENDPOINTS[engine]` 就 fail。codex/claude-code 只有 `CLI_ADAPTERS` 通道（agent 对话用），后台循环调不到。用户以为在烧 codex 额度，实际一行 codex 都没跑过，活全白丢。修复：① `TASK_TYPES` 全部改成后台真有的 API 引擎（`coding` 由 `codex` → `deepseek`），`transcribe`/`music` 标 `noBackground: true` + `note` 指回「会议纪要官」「音乐创作 agent」；② `main.js` 的 `task:classify` 加**可用性兜底**：engine 不在 `CHAT_ENDPOINTS` 就降级 deepseek 并回 `downgradedFrom`，保证「表写错」最多退化成「用了次优引擎」而不是「任务白跑」；③ `runBackgroundTask` 的报错补 CLI 指引；④ `tasks.js` 拦下 `noBackground` 的任务并指路，降级的在 category 里留痕；⑤ `agents-core.js` 的 `TASK_DEFAULTS`（`defaultFor()` 零调用的声明表）同步对齐，避免以后有人接线时重蹈覆辙。**分流原则（写进 task-router 表头注释）**：默认 DeepSeek，codex 只在三条同时满足时用 —— 无人值守连续迭代 / 一次要读十几个文件 / 要跑白名单外命令。验证：13 类引擎可用性归零不可用；7 个样本句分拣结果全对（编码→deepseek、翻译→qwen、转写/音乐被拦）；6 个 JS 文件 `node --check` 全过。
- **2026-11-26**：**通用助手接上「本机总控」——工作台第一次能指挥一个 24 小时常驻的外部调度进程**。背景：CityVerse 项目已有一个 launchd 常驻的总控（`tools/chief.py`，持有 PG 队列表 `agent_jobs`，派活给 codex / 流水线 / 素材 agent），但工作台里的 agent 只能读写文件、**没有任何执行入口**，用户要派活只能去终端敲命令 —— 等于「AI 平台」的最后一公里断在 shell 上。做法：不给通用助手 `run_shell`（那是任意命令的钥匙，破坏面太大），而是新增一个**窄工具 `chief`**：① `main.js` 新增 `toolChief()` + `ipcMain.handle('tool:chief')`，脚本路径 / 工作目录 / 命令名全部写死（`cwd=~/Dev/cityverse-ar`，可用 `CITYVERSE_REPO` 覆盖），模型只能填参数；动作白名单 `ls/show/log/doctor/board/tell_prompt/submit/cancel`，`id` 强制数字、`kind` 只能取 6 种、`title`≤120 字、`spec`≤20000 字、`codex` 无 spec 直接拒；② `preload.js` 暴露 `toolChief`；③ `assistant-chat/index.html` 接四环节（`agentCapabilities` 读 `tools` 含 `chief` / `toolSpecText` / `toolsDef` 原生 function calling / `executeTool` 分支），只读动作直接执行、`submit`/`cancel` 走既有的 `requestWriteApproval` 审批卡片；④ `buildSystemPrompt` 注入「总控指挥」角色段（指挥不执行 / spec 永不写提交 push / 不替用户拍板 / 问进度必须调 board+ls 拿真实数据）；⑤ 根 `index.html` 加 v10 迁移幂等给通用助手开 `chief`。为什么不是 `run_shell`：`execFileSync` 白名单只限命令名（`python3` 可跑任意脚本），对「软件工程」这种用户已授权的 agent 合适，对通用助手不合适 —— 窄工具让它的最大破坏面停留在「往队列投一条任务」，而投进去之后能干什么仍由总控自己的权限模型兜底。验证：`node --check` 全过；把 `toolChief` 抽出来单测 6 个分支（未知 action / 缺 id / 非法 kind / codex 缺 spec 全部正确拒绝）；端到端实测 `submit` 投了一条 shell 任务 → 总控 6 秒内接走 → exit=0。
- **2026-11-25**：**Agent 跨会话记忆（memory）上线**——解决 agent「失忆」问题（`memory` 字段此前是空壳 `{}`，全项目无读写）。① 记忆文件 `docs/agent-memory/{agent}.md`（随 git 走），只记低频长期条目（约定/决策/踩坑/进度），高频会话日志仍由 session-log 负责；② 闭环：会话开始 `memory:load` 注入 system prompt、会话结束 `memory:refine` 用 LLM（deepseek→ollama 兜底）提炼关键条目追加，借鉴 sentiment 的 observe→distill→guidance 模式；③ main.js 加 `agentDirByName/readMemory/appendMemory/refineMemoryWithLLM` + `memory:load`/`memory:refine` IPC，preload 暴露 `memoryLoad`/`memoryRefine`；④ 4 个 chat agent（软件工程/研究助手/伦理/通用助手）接入：`refreshMemory()` 启动拉取 + `buildSystemPrompt` 注入 + `finish` 结束后异步提炼；会议纪要官（meeting-audio）非标准 chat agent 未接入。git push ed99cbf..d6af821。
- **2026-11-16**：**DeepSeek V4 思考模式「总中断」根治 + GPT/Qwen 余额自动查**——① 中断根因：DeepSeek V4 系列（`deepseek-flash`/`deepseek-v4-pro`）**思考模式默认开启**，硬编码 `max_tokens:8000` 会被思考链吃掉、正文被挤到 `finish_reason=length` 截断（「说到一半就断」）或空回复。修复：`samplingForModel` 统一返回按模型判定的 `max_tokens`（思考型 32000 / 普通 8000），`runApiAgent`/`callBgChat`/`completeChatStream`/`chat:start` 四处全接上；② 思考+工具 HTTP 400 根因：DeepSeek 要求「用工具时把 `reasoning_content` 原样回传，否则 400」。修复：`chat:start` 流式累积 `reasoning` 并在 `chat:done` 回传，四个 chat agent 的 `assistantMsg` 补 `reasoning_content` 回填，后台任务 `callBgChat`/`runBackgroundTask` 同样补。③ GPT 余额：OpenAI 无公开余额接口，best-effort 走未公开 `GET /v1/dashboard/billing/credit_grants`（读 `total_available`，部分账号可用、部分已收紧为需浏览器会话 key），失败降级手动填。④ Qwen 余额：百炼 sk- key **没有任何余额接口**（真金白银在阿里云账户）——补阿里云 BSS `QueryAccountBalance`（需 AccessKey ID/Secret，ACS3-HMAC-SHA256 SigV3 签名，读 `Data.AvailableAmount`）；仅 sk- key 时尝试 `token-plan/balance`（Token Plan 套餐）；设置面板加「阿里云 AccessKey」两字段（可选，本机加密）。仪表盘三引擎均标「余额自动查」，查不到显示原因并可手动覆盖。
- **2026-11-16**：**API 用量与余额监控仪表盘（低余额红色提醒）**——新增「API 用量」导航面板，监控各家云端 API（DeepSeek/GPT/Qwen·通义万相）的余额、本工作台用量、其他用量，余额低于阈值自动变红 + 系统通知。要点：① 聊天链路此前**从未记账**（`chat:done` 不返回 token，`recordUsage` 只在调度中枢那条路被调用），已补：`chat:start` 流式结束估算 `tokensIn/Out` 写用量账本；② DeepSeek 走官方 `GET /user/balance` 自动查余额，GPT(OpenAI)/Qwen(DashScope) **无公开余额接口**，余额需手动填写；③ 「其他用量」仅 DeepSeek 可反推 =（充值额 granted+toppedUp − 余额）− 工作台累计成本×7.2；④ 低余额去重提醒：`api-balance.json` 记 lastAlert，24h 内余额未续降不重复弹；⑤ 启动延时 3s 检查 + 每 60 分钟自动刷新。参考开源范式：river291/display-api-balance(阈值变红)、Rannist/balance-dsh(反推其他用量)、dsh-cost-meter/TokenBar(多供应商+预算提醒)。端到端实测：DeepSeek 当前余额 ¥18.61（< 阈值 ¥20，已触发提醒，印证此前 Insufficient Balance）。git push 1c7f4a0..2514786。
- **2026-11-16**：**PPT「分板块 + 智能图形版式」设为默认铁律（用户不说也照做）**——根因：工具 schema 里已写了 `blocks` 智能图形，但注入每条消息的「PPT 制作规范」默认规则还是旧版（只讲 bullets/charts，没提 blocks），且 dev/ethics 的系统提示词压根没有这条规范 → 三 agent 的 `buildSystemPrompt` 统一重写/补入「PPT 制作规范 · 默认规则」：内容一律 `blocks` 分板块 + 渲染器按板块数量自动匹配智能图形（2 分栏/3 三栏/4 2×2/更多网格 + flow/pyramid/compare），文字嵌进图形、绝不纯文字罗列；仅单要点才用 bullets 兜底；charts/table 按需。同步改 `skills/docs/document-generation.md` 的 frontmatter description（这条会经 `scanSkillsSync` 注入系统提示词，让默认规则跨板块生效）。验证：三 agent 内联 JS `node --check` 全过、`s += '\n\n【PPT 制作规范` 各 1 处、字面转义正确。
- **2026-11-16**：**通用助手文档处理能力对齐研究助手**——通用助手原来只有 fs/db/computer 工具、无文档生成能力，soul 还写「整理成 Word/PPT/Excel 大纲」（引导模型只给大纲不生成文件）。修复：① `assistant-chat` 补齐文档处理四件套（`doc_generate` 生成 PPT/Word/Excel/Markdown、`pptx_fill_template` 套模板、`image_process` 本地图片处理、`image_generate` 文生图），覆盖 toolSpecText/toolsDef/executeTool/formatToolResult 四环节，与研究助手完全一致（第二大脑 brain_*、自扩展 skill_install、联网 web_search 属知识库/扩展/搜索，不算「文档处理」，未纳入）；② `buildSystemPrompt` 补「PPT 制作规范 · 默认规则」（分板块 + 智能图形）；③ soul 措辞「整理成大纲」→「直接生成文档」，同步 SEED_AGENTS + SOUL_FALLBACK + 本机运行时 `userData/data/agents.json`。git push af130ad..5d46ec3。
- **2026-11-16**：**会话标题自动生成/更新 + 右键重命名菜单**——问题：标题只在「新对话」时截取前 24 字（常截出「未看到新文件」这类 AI 回复片段），`autoTitle` 失败后不再重试、也不随对话更新；且只有双击重命名、无右键。修复（4 个 chat agent 统一）：① 新增 `titleAuto` 标志（用户手动改名后 `titleAuto=false` 不再被自动覆盖，`autoTitle` 成功置 true，serializeSession/load 持久化）；② 截取兜底改 `cleanTitleSeed`（去「帮我/请/请问/你好」等噪声前缀 + 截 16 字）；③ `autoTitle` 综合最近 2 条用户消息 + prompt 明确「提炼主题勿复述原话、勿输出未看到/没有/无法类否定回答」+ onDone 否定标题正则过滤；④ assistant-chat 补 `autoTitle`（此前无引擎生成），finish 后调用；⑤ 会话行加 `contextmenu` 右键菜单（重命名/置顶/删除）+ `.session-menu` CSS + `showSessionMenu`/`findSessionRow` + `data-sid` 标记。验证：4 agent 内联 JS `node --check` 全过、`slice(0,24)` 残留 0。git push 977d132..db2173f。
- **2026-11-16**：研究助手联网搜索**默认开启**（研究需核验文献/DOI/录用发表状态），`webEnabled=true` + 按钮初始 active。
- **2026-11-16**：**彻底独立**——docx 编辑（`doc_edit.py`）改用系统 `/usr/bin/python3`（python-docx 已装到用户级 `~/Library/Python/3.9/site-packages`）；kb-zotero.py / bin_patch.py / pyc_decompile.py 等纯标准库脚本统一改用 `SYSTEM_PY3`（`/usr/bin/python3`），不再依赖 WorkBuddy 自带 python。
- **2026-11-16**：**彻底独立（补完）**——PyObjC（Quartz/AppKit，pyobjc-core 11.1）已装进系统 python3.9 用户级；`pyBin()` 统一返回 `SYSTEM_PY3`，电脑操作（`computer-use.py`）与浏览器自动化（`cdp.py`，纯标准库）均不再依赖 WorkBuddy 自带 python。
- **2026-11-16**：**彻底独立（终）**——浏览器自动化脚本（`cdp.py`/`start_chrome.py`/`setup_chrome.py` 等 6 个）复制进本仓库 `scripts/browser-cdp/`，`browserCdpDir()` 优先读本仓库、回退宿主 skill；伦理 agent 两档 soul 删除「硬边界」「不教可照抄细节」「类型学·供识别」等定位措辞。
- **2026-11-16**：研究/软件/伦理/助手四个 agent 的 `fs_read` 支持 PDF（swift+PDFKit）与 PPTX（unzip+cheerio）原文读取；工具描述同步更新。
- **2026-11-16**：修复流式「无缘无故中断」（requestId 串线）+ `activeChatAbort` 单例覆盖；三 agent 补「中断恢复落盘」。
- **2026-11-16**：审稿闭环（研究/软件 agent）补中断恢复——`sendReviewLoop` 每 3 秒落盘 `{phase,round,text,thinking}` 快照（key `research/dev_review_progress`），启动 `restoreReviewProgress` 恢复中断前初稿/审稿意见/修订版；SOUL_UNALIGNED 删除所有边界、保留「标注性质与后果」。
- **2026-11-16**：研究/软件 agent 补「主动联网搜索 `web_search`」工具 + 提示词声明联网能力；知识库自动检索改默认关。
- **2026-11-16**：审稿闭环升级为**阶段级 checkpoint 续跑**——后端 `runReviewLoop` 显式状态机 + 每阶段落盘 `data/review-checkpoint/<agent>.json`，前端启动时读 checkpoint 重放已完成阶段并自动 `resume` 续跑（只重跑中断阶段，不再从头再来）；替代原「前端 localStorage 快照」方案（保留 legacy 兜底）。
- **2026-11-16**：**多会话并发 + 切会话不断流**——研究/软件/伦理三个 chat agent 把全局单例状态（`streaming`/`stopRequested`/`pendingNotes`）改为会话级（`runningJobs`/`jobProgress`/`stopRequested[sid]`/`pendingNotes[sid]`），结果写回从全局 history 改为 `sessionById(jobSessionId).messages`；后端 `activeChatAborts` 从 `Set` 升级为 `Map<sessionId, Set<AbortController>>` 按会话精确 abort；`stopChat` 前传 `sessionId`。不同对话可同时跑，切会话不再截断后台任务。
- **2026-11-16**：**借鉴海归海后台 Agent 体系，落地「知识沉淀 + 治理 + 总控台」**——从海归海 `experience_settler`（经验沉淀官）/ `agent_governance`（治理官）/ `agents-console`（总控台）三处提炼，用工作台栈重写：① `knowledge-settler-core.js` 知识沉淀官核心（提案 pending/approved/ignored、方法论/结论分层库、启发式分类、`suggest_for` 检索复用、`verification` 验证清单、人工在环只提案不自动写库）；② `agent-governance.js` Agent 治理官（扫 agents 前端 + SEED_AGENTS + agents.json 做职责盘点/重叠检测/孤儿空壳对账，报告落 `data/agent-governance.json`）；③ `agents/agent-console/index.html` 总控台页面（概览 KPI + 流水线 + 待审批 + 手动沉淀 + 经验库 + 治理巡检 + 检索复用）。main.js 加 9 个 IPC、经验库落 `data/experience-library.json`；preload 暴露 `settler*`/`governance*`；首页 SEED_AGENTS 加「Agent 总控台」入口。借鉴对照全文见 `docs/agent-ops-design.md`。
- **2026-11-16**：**修复「切 agent/退出即中断」真正根因 + 补日期 + 补 PPT 工具**——① 切 agent/返回工作台原来 `loadFile` 重载页面 + `webContents.destroy()` 销毁 BrowserView，导致流式中断；改为多 BrowserView 缓存（`agentViews = Map<href, BrowserView>`），切换只 `setBrowserView` 显示/隐藏、不重载不销毁，后台任务真正继续跑；② 三 agent `runToolTurn` 的 `chatStream` 补 `sessionId: jobSessionId`（原来漏传、精确停止失效）；③ 三 agent `buildSystemPrompt` 注入「今天是 YYYY年M月D日 星期X」；④ 三 agent 新增 `doc_generate` 工具（接已有 `doc:generate` IPC），对话内可自主生成 .pptx/.docx/.xlsx/.md。
- **2026-11-16**：**新增情绪/偏好 Agent**——`sentiment-agent-core.js`（零依赖，落盘 `data/sentiment-library.json`）侦测用户对各 agent 的评价与情绪（正/负面词典+强度），学习「该多做/该避免」并沉淀成 do/avoid 偏好规则；闭环：① 注入各 chat agent 的 system prompt（`sentimentGuidanceCache`）指导后续操作；② 通过 `settlerSubmit` 回调把新偏好自动提交经验沉淀官（`source=sentiment`，仍待审批，人工在环不变）。三 agent 的 `addBubble` 加 👍/👎 反馈按钮、`send()` 自动侦测强烈评价、启动 `refreshSentimentGuidance()` 拉取指导；`agent-console` 加「情绪/偏好」面板（偏好规则 do/avoid 分 tab + 信号时间线 + 手动 distill）。main.js 加 6 个 `sentiment:*` IPC；preload 暴露 `sentiment*` API。
- **2026-11-16**：**情绪/偏好可视化 + 手动编辑/删除**——`agent-console` 情绪面板升级：① 顶部 do/avoid 比例堆叠分布条；② 每条偏好卡片可视化（方向徽章 do 绿/avoid 红 + 触发次数 + 信心度进度条）；③ 每条卡片带「编辑/删除」按钮，编辑走内联表单（可改方向/场景/Agent/做法文案/信心度滑块）。核心模块 `sentiment-agent-core.js` 新增 `updatePreference(id, patch)` 与 `removePreference(id, opts)`。**关键坑**：偏好的去重键 `key = agent||scenario||direction`，编辑改了 key 后若不同步信号，删除偏好会因信号仍留旧 key 而漏清、`distill()` 又会复活旧偏好 → 修复：`updatePreference` 改 key 时级联同步关联信号（agent/scenario/valence 跟随），`removePreference` 默认 `cascadeSignals=true` 级联删除同 key 信号。main.js 加 2 个 IPC（`sentiment:update-preference`/`sentiment:remove-preference`）。
- **2026-11-16**：**方案 B：LLM 做法提炼（情绪仅作索引，真正沉淀的是「做法」）**——明确设计原则：`valence` 只是索引（定 do/avoid 方向 + 归场景 + 计数），真正该提炼并注入指导未来的是「具体可执行的做法」（从被评价的 agent 回复里提炼）。核心模块 `sentiment-agent-core.js` 加 `setDistiller(fn)` 钩子（`async function(buckets) -> [{key,action,reason}]`），`distill()` 改 async：聚合后收集待处理 bucket → 若有 distiller 则批量提炼做法（结果覆盖启发式 action）→ 无/失败则降级启发式（保留用户评价原文）；返回加 `distilled`/`mode`（llm/heuristic）字段，**保持核心模块零依赖**（默认无 distiller = 启发式）。main.js 加 `buildDistillPrompt`（借鉴 PAHF Detect-Summarize-Integrate + opensearch「偏好提取输出自然语言单句」经验：action 必须动宾结构可执行、禁空话）、`parseDistillResult`（JSON 数组/markdown 包裹/逐行对象/单 bucket 纯文本兜底 4 级容错解析）、`distillActionWithLLM`（deepseek 云优先 → ollama 本地兜底 → 失败返回 null 降级）；`getSentimentAgent` 里 `setDistiller(distillActionWithLLM)` 注入。`agent-console` 的 runDistill 提示显示「LLM 提炼 N 条 / 启发式降级」+ 防重复点击。调研出处：claude-memory-kit / PAHF / taste-learn / opensearch ml-commons PR#4798。
- **2026-11-15~16**：性能修复（rAF 节流 + 流式轻量转义）；知识库启动懒加载 + OneDrive 手动同步。
- **2026-11-16**：**装配 5 个 builtin skill（3 板块 + GitHub 调研 2 个增强）**——用户要求把 WorkBuddy 可选导入源里用得到的 skill 装配进工作台。关键原则：**WorkBuddy 的 skill 多为「依赖 WorkBuddy 专属工具/云服务」（connect_cloud_service / ImageGen / domain_search / 金融 MCP / library MCP），不能直接复制，须「适配」为工作台已有工具（web_search / doc_generate / computer）**。落地：① `skills/finance/financial-analysis.md`（金融红线+框架+web_search 核实，适配自 workbuddy-finance-skill）；② `skills/docs/document-generation.md`（pptx/docx/xlsx/md，执行用 doc_generate）；③ `skills/automation/browser-automation.md`（执行用 computer）；④ `skills/finance/equity-deep-research.md`（九章深度研究，借鉴 rollingSirius/equity-research-skill）；⑤ `skills/research/academic-writing-zh.md`（控制语言分离，借鉴 FreeFallingSnow/technical-academic-writing-zh）。`boards.json` 新增 finance/docs/automation 三板块；`skills-core.js` CATEGORY_RULES 加 finance 分类。**注意**：`CATEGORY_RULES` 没有的 category 会被 classify 兜底重分类，新 skill 的 category 必须用已有 id（office/browser）或先加规则；板块挂载靠 frontmatter `boards`（boardIds），与 category 是两个维度。
- **2026-11-16**：**根治「DeepSeek 思考模式烧钱没产出」死循环**——用户反馈 v4-pro「什么有效工作都没做、却花了很多 token」。查用量账本实锤：v4-pro 共 73 次调用、输入 158 万 token、**正文仅 12 token、82% 调用零正文**，全是思考链滚雪球。根因：DeepSeek V4 系（deepseek-v4-pro / deepseek-flash）**默认开启思考模式**（官方文档确认），思考链按输出价计费、极耗 token；而「思考 + 工具调用」是死循环——每轮都先思考再决定调下一个工具，思考链随上下文逐轮膨胀，正文迟迟不产出，最后撞 max_tokens 截断/空回复。**修复（官方背书）**：DeepSeek 官方建议 chat/routing/extraction/tool-use **关闭思考**，仅深度推理（多步编码/数学）才开。故：① 主进程加 `thinkingControl(model, opts)`——默认 `thinking:{type:'disabled'}` 关思考，仅显式 `opts.thinking===true` 才开；四个调用点（chat:start 主链路 / runApiAgent 单轮 / callBgChat 后台任务 / completeChatStream 审稿闭环）全部接入，`maxTokensForModel` 改为「思考才 32000、非思考 8000」；② 研究助手顶部加「深度思考」开关（默认关），勾选才 `thinking:true`；③ 记账补 `tout = approxTokens(outChars + reasoning)`（此前只算正文、严重低估，思考链才是大头）+ `costOf(engine,tin,tout,model)` 按模型计价；④ PRICES 修正为官方真实价（flash $0.15/$0.60、v4-pro $0.66/$1.98，原 0.28/0.42 是旧价且 v4-pro 输出价是 flash 3.3 倍）。**实测验证**（Electron 脚本直连）：`thinking:disabled` 思考链 0、completion 42 token、正文正常；`thinking:enabled` reasoning_tokens 44/85（思考占一半）。参数格式 `{thinking:{type:'enabled'|'disabled'}}`，`reasoning_effort:'none'` 等价。**注意**：思考模式不支持 temperature/top_p/penalty（静默无效），`tool_choice:'required'` 会 400。
- **2026-11-16**：**保留思考模式 + 根治「反复读同一文件 / 反复做同样思考」**——用户明确「还是需要思考模式，但别反复调同一文件、反复做同样思考」。查研究助手聊天记录（`chat-history/研究助手.json`，5 会话）实锤：单个 PPT 任务里 `fs_list` 调了 276 次、`fs_read` 154 次，**同一文件被读 22~26 次**（如 `CSA成员研究总结_Bingxin与Helen.md` 22 次）；单条消息 `thinking` 达 12 万字符。根因：思考模式下每轮工具循环都重新「思考该读什么、文件在哪」→ 决定「再读一遍确认」→ 工具结果（fs_read 全文）无缓存无截断地完整注入上下文 → 上下文越长模型越「忘」、越倾向重复读，恶性循环。**修复（研究助手，最小侵入）**：① 新增 `cachedExecuteTool` + `toolCache` 会话级缓存——`toolCacheKey` 对只读工具（fs_read/fs_list/fs_search/web_search/db_query/db_*_report）按参数去重，第二次命中直接返回「已执行过、结果未变」提示，不再重复注入全文；写类工具（fs_write/fs_edit/doc_generate/pptx_fill_template 等）成功后清空 fs 读缓存（避免读到旧内容）；每次 `run()` 新任务重置缓存（同任务内拦截、跨任务重新开始）；② `formatToolResult` 识别 `cached` 标记；③ `buildSystemPrompt` 自主工作准则加 ⑥「只读工具对同一文件/目录/关键词本会话只调一次、记住结果不重复」；④ `toolsDef` 的 fs_read/fs_list/fs_search 描述加「同一文件/目录本会话只读一次」。**注意**：`history.slice(-12)` 只回传 content 不含 thinking（历史思考不重复注入），token 膨胀主因是工具循环内部 `msgs` 累积的 reasoning_content + 工具结果，故缓存命中后不重复注入全文是直接解药。待办：① 其他 3 个 chat agent 未加此缓存，需统一；② 思考模式下工具调用轮的 reasoning_content 仍会累积（DeepSeek 要求有 tool call 必回传），若要进一步压缩可做「工具轮关思考、最终产出轮才开」的混合思考（未做，待用户反馈）。
- **2026-11-16**：**GitHub 调研同模型学术 Agent 的调试/限制范式 + 落地上下文治理三招**——用户要求去 GitHub 找「同模型做学术时怎么调试/限制模型」的可复用提示词与代码。调研结论（可复用清单）：① **DeepSeek 官方 `awesome-deepseek-agent`**（deepseek-ai/awesome-deepseek-agent，含 Deep Code/Reasonix/DSH 等 20+ 集成指南）；② **循环防护范式**（agent-zero issue#1690、synapse-ai）：temp=0 会导致确定性重复循环（根因之一，建议 0.3~0.5）、重复调用检测（hash 工具名+参数、超 MAX_REPEATS 强制 `tool_choice:none` 收尾）、max_steps 硬上限、「progress detector 以新信息而非活动次数定义进度」（比 exact-repeat 去重更强，能抓「换说法但无新信息」的语义漂移）；③ **显式 stop condition + gap justification + 工具预算**（promptdig deep-research 12 块、KResearch 五阶段、promptabcd）：「找到 N 个来源就停」「每次搜索前说清填补什么空白」「累计只读调用 ≤N 次」；④ **工具结果截断/换页**（DSH spill/pruner/snapcompact、literature-review-mcp、gitcode 科研四阶段）：`toolResultMaxChars≈2000~4000`、保留头尾+标注总长+检索路径、章节分级压缩（Abstract/Method 100% 保留、Reference 0%）、KResearch `read_webpage` 截断 15000 字符；⑤ **上下文压缩**（microsoft/acon ICML2026、paper-agent、YerbaPage/Awesome-Context-Compression）：历史压成状态摘要、失败轨迹对比自动学压缩规则。**本次落地（研究助手，三招）**：① `fs_read` 支持 `offset`/`limit` 分段读取（main.js `toolFsRead` 拆 `toolFsReadRaw` + 包装统一 slice、返回 `totalChars`，双份 schema 同步）——对应 spill「预览+检索路径」，长文件可定向续读；② `formatToolResult` 加 `clipText`/`clipFsRead`，对 fs_read(12000)/db_query(5000)/web_search(4000) 结果头尾截断+标注总长+提示用 offset 续读（原为零截断全文塞回，是「反复读文件→上下文滚雪球」的第二个放大器，第一个是重复调用已被 toolCache 堵住）；③ `buildSystemPrompt` 自主工作准则补 ⑦ gap justification + ⑧ 够了就停 + 只读工具预算(≈6 次)。**待办（未做）**：① 其他 3 个 chat agent（assistant/dev/ethics）同样缺「结果截断 + 分段读取」，需统一；② 「progress detector」语义漂移检测（比 toolCache 的 exact-repeat 更强，抓换说法重复）；③ 「混合思考」——工具执行轮关思考、最终合成轮才开（DeepSeek 官方建议的终极省 token 方案，需改工具循环逻辑，复杂未做）。
- **2026-11-16**：**根治「pptx_fill_template 缺 python-pptx」误报 + 落地三个加强**——① **pptx 套模板误报的真实根因（终于挖到底）**：不是环境没装包（`/usr/bin/python3` 实测能 import pptx 1.0.2），而是 **App 从 Finder/桌面启动时 `HOME` 环境变量不是 `/Users/ingridxi`**，导致 `/usr/bin/python3` 无法按 `~` 展开定位「用户级 site-packages」（`~/Library/Python/3.9/lib/python/site-packages`，装 python-pptx / python-docx / PyObjC），`import pptx` 失败 → 脚本走 ImportError 分支返回「缺 python-pptx」。实测证据：`env HOME=/tmp /usr/bin/python3 -c "import pptx"` → `ModuleNotFoundError`。修复（双层）：① main.js 加 `pyEnv()`（`{...process.env, HOME: os.homedir()}`），7 个调 `SYSTEM_PY3` 的 execFile/execFileSync/spawn 点全部加 `env: pyEnv()`（_runPyJson/execPy/doc_edit/bin_patch/pyc_decompile/computer-use/start_chrome）；② `pptx_fill_template.py` 加 `_ensure_user_site()`（`site.getusersitepackages()` + `pwd.getpwuid(os.getuid()).pw_dir` 拿真实 home 显式插 sys.path，**独立于 HOME 兜底**，实测 `env HOME=/tmp` 下也能成功 inspect）；③ 删误导性报错文案（原「当前 Python 缺少 python-pptx（本机其实已装）」自相矛盾 + 劝退式 hint「改用 doc_generate」引导模型放弃套模板），改为清晰可执行 pip 指令。**关键教训**：任何依赖「用户级 site-packages 第三方库」的 python 脚本（pptx/python-docx/PyObjC），在 Electron 里都必须保证子进程 HOME 正确，否则「shell 里测试正常、App 里 import 失败」这类诡异 bug 会反复出现。② **加强1 progress detector（语义漂移检测）**：`trackReadResult` 对只读工具结果做内容指纹（`strHash` djb2 + 长度），跨轮检测「换关键词/换文件但结果内容完全相同」的隐性重复，连续 2 次无新信息即注入强提示强制收尾——比 toolCache 的「同参数 exact-repeat 去重」更强，能抓「换 5 种说法搜同一件事」的语义漂移。③ **加强2 混合思考**：`thinkingForRound(round)` 仅首轮（round=0，用户勾了深度思考时）开思考做规划，工具循环轮（round≥1）关思考，根治思考链随上下文逐轮膨胀滚雪球烧 token（此前 v4-pro 82% 调用零正文的根因）。④ **加强3 其余 3 助手统一**（assistant/dev/ethics，用 Python 批量脚本 S1-S9）：补 clipText/clipFsRead 结果截断 + fs_read offset/limit 分段读取 + toolCache 会话级只读去重 + progress detector + buildSystemPrompt 补 ⑥只读一次 ⑦gap justification ⑧够了就停+工具预算≈6 次。注意：assistant-chat 的 runToolTurn 是 2 参数签名（无 contN）、无 web_search/skill_install 工具、chatStream 无 model/sessionId 参数，批量替换需按文件差异处理（S5 web_search 截断在 assistant/ethics 跳过）。

---

## 9. 已知风险 / 待办

- 审稿闭环已支持**阶段级 checkpoint 续跑**（2026-11-16 终版）：后端 `runReviewLoop` 显式状态机（draft/review/revise），每个完整阶段完成后 `saveReviewCheckpoint` 落盘到 `data/review-checkpoint/<agent>.json`（含 engine/model/reviewerEngine/rounds/messages/question/draft/reviews/revises/stage/round）；前端 `restoreReviewProgress` 启动时读磁盘 checkpoint（`review:checkpoint:load`），重放已完成阶段后自动 `reviewLoop({resume:true})` 续跑，只重跑中断的那个阶段。SSE 流式无法精确续传 token，故 checkpoint 落在**阶段边界**——中断时最多重跑当前一个阶段，不会从头再来。
