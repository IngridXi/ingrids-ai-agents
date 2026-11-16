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
| 界面设计师 🎨 / 音乐创作 🎵 / 灵感目录 📡 / 智能路由 🧭 | 主界面预设 | — |

### 关键文件
- `main.js` — 主进程：IPC、工具执行（fs/db/web/computer）、流式聊天、文档生成、知识库引擎。
- `preload.js` — 渲染进程桥（contextBridge），暴露 `window.ingrid.*`。
- `agents-core.js` — 多 Agent 核心（引擎注册表、Agent Schema、成本记账、Orchestrator）。
- `skills-core.js` — skill 扫描/归档/预设。
- `kb-engine.js` — 知识库（Obsidian/Zotero/Notion/OneDrive 索引 + RAG 检索）。
- `scripts/` — 本地辅助脚本（`pdf_extract.swift`、`doc_edit.py`、`bin_patch.py` 等）。

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

---

## 8. 历次关键修复记录（时间线，供追溯）

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
- **2026-11-15~16**：性能修复（rAF 节流 + 流式轻量转义）；知识库启动懒加载 + OneDrive 手动同步。
- **更早**：伦理 agent 去道德化（SOUL_UNALIGNED + abliteration 落地）、模式-模型联动、主页面图标/排序优化、删除「敬请期待」占位。

---

## 9. 已知风险 / 待办

- 审稿闭环已支持**阶段级 checkpoint 续跑**（2026-11-16 终版）：后端 `runReviewLoop` 显式状态机（draft/review/revise），每个完整阶段完成后 `saveReviewCheckpoint` 落盘到 `data/review-checkpoint/<agent>.json`（含 engine/model/reviewerEngine/rounds/messages/question/draft/reviews/revises/stage/round）；前端 `restoreReviewProgress` 启动时读磁盘 checkpoint（`review:checkpoint:load`），重放已完成阶段后自动 `reviewLoop({resume:true})` 续跑，只重跑中断的那个阶段。SSE 流式无法精确续传 token，故 checkpoint 落在**阶段边界**——中断时最多重跑当前一个阶段，不会从头再来。
