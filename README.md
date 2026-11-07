# Ingrid's AI Agents

个人 AI 工作台 —— 横屏方形按钮网格启动器,把常用的 AI Agent 集中到一个桌面应用里。除了「点开某个 Agent」,还能**让一个 Agent 指挥其他 Agent 干活**,并在派活时按板块临时挂载常用 Skill。

以开源项目 [OpenMausBot](https://github.com/milind-soni/OpenMausBot)(Apache 2.0)为架构底座构建:每个 Agent 是一个独立的"数字员工",有自己的名字、人设(soul)、记忆、技能、定时任务,以及各自绑定的模型引擎。

## 设计理念(继承自 OpenMausBot)

- **每个 Agent 绑定自己的引擎**:不靠一个全局大模型硬扛,而是「转写 → FunASR」「写作 → Claude Code」「代码 → Codex」各司其职。
- **local-first(本机优先)**:Agent 配置、记忆、API Key、用量账本全部存在本机,不上云。API Key 经系统钥匙串(`safeStorage`)加密后落盘。
- **bring-your-own-agent**:复用本机已登录的 CLI(`claude` / `codex` / `grok`),不用重新接一堆裸 API。
- **安全桥接**:`contextIsolation` 常开,渲染进程只接触 `window.ingrid` 一个白名单对象,拿不到 Node / `ipcRenderer`。
- **限额自动切换 / 成本记账**:学 OpenMausBot 的两个真实行为 —— 引擎撞到用量上限自动换降级模型;每次调用记一笔账,可设预算、导出 CSV。

## 运行

```bash
npm install
npm start
```

## 目录结构

```
.
├── package.json            # Electron 应用入口
├── main.js                 # 主进程:窗口 / IPC / 文件持久化 / CLI+API 执行器 / 用量账本
├── preload.js              # 安全桥接(contextBridge → window.ingrid)
├── index.html              # 工作台界面(横屏方形按钮网格 + 引擎设置)
├── agents-core.js          # 零依赖多 Agent 核心(引擎 / 注册表 / 路由 / 账本 / 编排器)
├── skills-core.js          # 零依赖技能核心(板块 / 注册表 / 推荐 / 渐进式载入 / 预设)
├── task-router.js          # 零依赖任务类型路由(ra 判断「派谁 + 挂哪些 skill」)
├── supervisor-core.js      # 零依赖监督者核心(核心需求 / 漂移检测 / 纠偏)
├── orchestrator.js         # 调度中枢面板(渲染层:委派 + 技能挂载 + 预设 + ra 路由)
├── supervisor.js           # 监督者悬浮面板(渲染层:可拖拽浮层)
├── secretary-core.js       # 零依赖秘书核心(日程 / 邮件分类 / 想法 / 事件提取 / 简报)
├── secretary.js            # 秘书悬浮面板(渲染层:左侧浮层,与监督者并排)
├── skills/
│   ├── boards.json         # 板块模板(首次运行复制到用户数据目录)
│   └── research/           # Research 板块的 17 个内置 Skill
│       ├── research-question.md           # 研究问题提炼
│       ├── paper-deconstruction.md        # 论文拆解
│       ├── research-design.md             # 研究设计
│       ├── literature-review.md           # 文献综述
│       ├── sota-search.md                 # SOTA 搜索(前沿追踪)
│       ├── data-analysis.md               # 数据分析
│       ├── citation-audit.md              # 引用审计
│       ├── reviewer.md                    # 审稿人
│       ├── reproducibility-review.md      # 可重复性评审
│       ├── academic-writing.md            # 写作
│       ├── deai.md                        # 去 AI 味
│       ├── anti-defensive-writing.md      # 防御性写作
│       ├── survey-writing.md              # 综述写作(Survey/Review 论文)
│       ├── research-proposal.md           # 研究提案(开题/基金申请)
│       ├── academic-presentation.md       # 学术表达(一分钟讲清研究)
│       ├── research-project-management.md # 科研项目管理
│       └── research-mentor.md             # 研究导师
├── agents/
│   └── meeting-audio/      # 第一个 Agent:会议纪要官(实时转写 → 声纹认人 → 纪要 → PPT)
├── LICENSE / NOTICE        # Apache 2.0 全文 + OpenMausBot 归属声明
```

## 技能板块(v3):Skill 不做成 Agent,而是挂在这次任务上

三层解耦:**Skill = 能力(一份说明书) / Agent = 角色(谁来做) / Engine = 脑子(哪家模型)**。

把每个 Skill 做成独立 Agent 会让按钮数量爆炸、换模型要重配、多个技能协作要手动倒腾上下文。所以这里采用:**一个板块列表 + 派活时勾选或自动推荐挂载**,挂载的说明书只在本次请求的 `soul` 里生效,用完即卸,不写回 Agent。

### 板块是一级组织

板块 = 你的一个用途。工作台**默认只带 `Research` 一个板块、17 个内置 Skill**,覆盖科研全流程:研究问题提炼 → 论文拆解 → 研究设计 → 文献综述 → SOTA 搜索 → 数据分析 → 引用审计 → 审稿 → 可重复性评审 → 写作 → 去 AI 味 → 防御性写作 → 综述写作 → 研究提案 → 学术表达 → 项目管理 → 研究导师。写法沿用了 `IngridXi/phd-ra-agent` 的研究助手风格(只依据给定证据、结构化输出、不臆造文献与数据)。

这 17 个 Skill 来自两类借鉴:一是 **GitHub 高星学术 skill 榜**(`academic-research-skills` 55k★、`scientific-agent-skills` 47k★ 等)里的**引用审计 / 可重复性评审 / 防御性写作 / 多源检索 / SOTA 搜索 / 研究提案 / 综述写作**;二是博主总结的**科研能力「三层六能力」框架**——思维层(好奇·提炼问题 / 科学推理·拆解建构)、执行层(研究设计 / 数据分析)、独立层(项目管理 / 学术表达)。其中**项目管理**被公认是最薄弱环节,所以单独做了 `科研项目管理` skill,专门治"不知道做到什么程度就该停手推进"。

本机 WorkBuddy 目录里的 skill 只是**可选导入源**:主进程会扫描 `~/.workbuddy/skills` 与 `~/.workbuddy/plugins/cache`,但默认**一条都不启用**(本机实测扫描 230 条,只启用 5 条)。这样别的平台(海归海 / 音乐 / 公众号 / 配色)的能力不会混进个人工作台。想加哪条,在面板里点「从本机导入」挑进当前板块即可;一条 skill 可属于多个板块。

### 渐进式披露与成本护栏

全部 SKILL.md 正文合起来约 38 万 token,全塞进一次请求既装不下也烧钱。所以:

1. 索引只留 `name` + 一句话 `description`,前端常驻几千 token;
2. 输入任务时按关键词 + 描述重合度**自动推荐** 1–3 个,点一下即采纳;
3. 只有选中的才经 `skills:read` 读正文,拼进本次请求的 `soul`;
4. 单份上限 12000 字符、总量上限 24000 字符,超了自动截断;
5. 注入量记进账本的 `skillTokens`,并计入 `tokensIn`(演练模式也算),CSV 多了 `skills` / `skillTokens` 两列。

### 内置 Skill 可以直接改

`skills/<板块>/*.md` 用标准 frontmatter:

```markdown
---
name: 审稿人
description: 以期刊同行评审标准审查论文...
category: research
boards: research
source: phd-ra-agent / reviewer_agent
---

正文就是会注入给模型的说明书。
```

改完在面板点「重新扫描」即可生效。带 `scripts/` 或 `allowed-tools` 的本机 skill 会标「需授权」——目前**只注入说明书、不执行脚本**,避免桌面应用悄悄获得文件 / 浏览器权限。

### 预设 = 一键组合

常用的「板块 + Agent + 若干 Skill + 任务」可以点「存当前为预设」,首页立刻多一个方形按钮。点它会自动填好调度中枢的指挥官、目标、任务、模式与技能勾选。预设只是快捷方式,不是新 Agent。

## 调度中枢:一个 Agent 指挥其他 Agent

点击顶部「🎛️ 调度中枢」按钮,或直接点「智能路由 ra」那个方块。

| 能力 | 说明 |
|---|---|
| 委派 | 选一个指挥官、勾选目标 Agent、填任务,一键派活 |
| 三种执行方式 | `parallel` 并行 / `sequential` 串行 / `chain` 流水线(上一步结果传给下一步) |
| 权限校验 | 只有 `role: 'orchestrator'` 或 `canControl: true` 的 Agent 能派活,普通 Agent 被拒 |
| 审批卡片 | 目标 `approvalMode: 'ask'` 时逐个弹卡确认,可一键「自动批准」 |
| 限额自动切换 | 主引擎报错含 `429 / rate limit / quota` → 自动标记 5 小时限额,换降级链里下一个可用引擎,并在事件日志里写明「谁 → 谁」 |
| 成本记账 | 每次调用记 `{ agentName, engine, tokensIn/Out, cost, costSource, dryRun, ... }`,按 Agent / 引擎 / 日汇总 |
| 月度预算 | 设置上限后,真实调用超预算直接阻塞;演练不占预算 |
| CSV 导出 | 一键导出账本,便于自己对账 |

### 演练模式(默认,不花钱)

默认不调用真实模型:**委派、审批、限额切换、记账全流程照跑**,但返回占位结果、不产生任何 API 费用。账本里这类记录标 `costSource: 'simulated'`,界面把「实际花费」和「演练估算」分开显示。

这样可以在没装任何 CLI、没填任何 Key 的情况下,先把多 Agent 编排跑通、看清每次调用会花多少钱,再决定要不要接真模型。

### 开启真实调用

1. 在「⚙️ 引擎设置」里填 API Key(`deepseek` / `gpt` / `qwen`),或在本机安装并登录 `claude` / `codex` / `grok` CLI。
2. 在调度中枢勾选「真实调用模型」(会写入 `settings.json` 的 `allowRealRuns`)。
3. 执行委派时不要勾选演练(即保持真实模式)。

安全约束:

- 默认 `allowRealRuns = false`,主进程二次拦截;即使界面传错也不会偷偷调用。
- CLI 用 `spawn(数组参数)` 调用,**不拼 shell 字符串**,带 90 秒超时与输出截断。
- API 走 OpenAI 兼容端点,60 秒超时;Key 只存系统钥匙串,不写进日志。
- 引擎白名单校验,未知引擎直接回退到演练。

### 账本落盘

```
~/Library/Application Support/Ingrid's AI Agents/data/
├── agents.json             # Agent 注册表
├── boards.json             # 板块 + 每个板块启用的 skill id
├── presets.json            # 常用组合(首页预设方块)
├── settings.json           # 加密后的 API Key + allowRealRuns
├── budget.json             # 月度预算
└── usage/
    └── YYYY-MM.jsonl       # 一行一次调用,含 skills / skillTokens,不含消息正文
```

浏览器预览模式自动回退到 `localStorage`,界面功能一致,但不能真实调用模型。

## Agent 数据模型

每个 Agent 拥有(对应 OpenMausBot 的 `newBotDefaults`):

| 字段 | 说明 |
|---|---|
| `name` / `emoji` / `tag` | 卡片显示 |
| `soul` | 人设 / 系统指令 |
| `engine` / `fallbacks` | 主引擎 + 降级链 |
| `memory` / `skills` / `routines` | 私有记忆 / 技能 / 定时任务 |
| `approvalMode` / `computer` | 权限模式 / 是否操控本机 |
| `role` / `canControl` | 是否为调度者(能指挥其他 Agent) |
| `status` / `href` / `detail` | 可用性 / 入口页 / 详情 |

## 引擎表(agents-core.js)

| 引擎 | 类型 | 单价(USD / 百万 token,输入/输出) | 说明 |
|---|---|---|---|
| `claude-code` | 本机 CLI | 3 / 15 | 复用已登录会话 |
| `codex` | 本机 CLI | 2 / 10 | 复用已登录会话 |
| `grok` | 本机 CLI | 2 / 6 | 输出便宜 |
| `deepseek` | 云端 API | 0.28 / 0.42 | 需在「引擎设置」配 Key |
| `gpt` | 云端 API | 2 / 10 | 需配 Key |
| `qwen` | 云端 API | 0.4 / 1.2 | 需配 Key |
| `local-llm` / `funasr` | 本地推理 | 0 / 0 | 不上云,不计 API 费用 |

价格是 2026-11 的近似值,写在 `ENGINES[id].price` 与 `main.js` 的 `PRICES` 里,可自行改。`costSource` 区分 `metered`(厂商实际计费)/ `estimated`(按单价估算)/ `simulated`(演练)。

## 核心 API(可在控制台玩)

```js
const C = window.AgentsCore;
window.__reg          // AgentRegistry:list() / create() / update() / remove()
window.__orchestrator // AgentOrchestrator:delegate() / broadcast() / chain()
window.__ledger       // UsageLedger:summary() / budgetStatus() / exportCsv()
window.__skills       // { boards, skills, presets, scan }
                      //   boards : BoardRegistry:list() / create() / addSkill()
                      //   skills : SkillRegistry:inBoard() / recommend() / buildContext()
                      //   presets: PresetStore:create() / list() / remove()
window.__taskRouter   // TaskRouter:classifyTask() / route()（ra 任务类型路由）
window.__supervisor   // Supervisor:reminder() / supervise()（监督者）
window.__supGoals     // GoalStore:add() / update() / remove() / setActive()

// 例:在 Research 板块里按任务推荐技能
const S = window.SkillsCore;
__skills.skills.recommend('帮我审一下这段论证', { boardId: 'research', limit: 3 })
  .map(x => x.skill.name);

// 例:让 ra 把任务派给两个 Agent
await __orchestrator.delegate({
  commanderId: __reg.list().find(a => a.role === 'orchestrator').id,
  targetIds: [__reg.list()[0].id, __reg.list()[1].id],
  task: '整理本周要点', mode: 'parallel', autoApprove: true, dryRun: true,
});
```

## ra 任务类型路由:自己判断派谁 + 挂哪些 skill

在调度中枢的任务框下点 **「🧭 让 ra 自动判断」**,不用再手动勾目标、挑技能。`task-router.js` 会:

1. **归类任务类型**:审稿 / 去 AI 味 / 文献综述 / 研究指导 / 写作 / 编码 / 转写纪要 / 总结 / 翻译 / 音乐 / 数据 / 通用(关键词命中越多越像);
2. **挑 Agent**:用任务类型的关键词给每个 Agent 的「名字 / 一句话简介 / soul / 描述」打分,选分数最高的 1–3 个,排除「敬请期待」和指挥官本人;
3. **挂 Skill**:复用 `SkillsCore.recommend`,按任务文字自动推荐本板块 1–3 个技能;
4. **选引擎**:每个任务类型带默认引擎(`review`→claude-code、`litreview`→deepseek、`coding`→codex、`transcribe`→funasr……),自动落到调度中枢。

整个过程只依据给定的 Agent / Skill / 任务文字,**不臆造**,每一步都给出可解释的 reasons,你可以手动微调后再「开始委派」。注意:路由靠 Agent 的名字/简介关键词,建议给自己每个用途配一个名字贴切的 Agent,ra 才能派得准。

## 监督者 Agent:防止 LLM 跑偏(借鉴 Steering Agent)

借鉴 NUS / USTC / 阿里 Qwen 的 **Steering Agent**(arXiv:2610.22316)的「双路径」思路,解决长程任务里的目标漂移(goal drift)。右上角有一个**可拖拽的悬浮卡片 👁️ 监督者**,你可以:

- **随时增减「核心需求」**:每一条都可以停用/删除/加权;
- **先「对话确认」**:写一句模糊需求 → 监督者抛 3 个澄清问题(要什么结果 / 边界红线 / 成功标准)→ 拼出结构化确认稿 → 你确认后写进核心需求;
- **开始监督**:打开开关后,每一轮委派的结果都会做**快路径**漂移检测(便宜、同步:空输出/报错/半数以上需求零命中即报警);确认偏离后走**慢路径**生成一句纠偏指令(真实模式调用模型,演练模式用模板);
- **自动纠偏**:下一轮委派时,核心需求 + 纠偏指令会自动挂到任务最前面(「📣 提醒当前工作」也可手动注入)。

监督者**旁路监督、不改动执行 Agent**,日常轻量,只在真正偏离时才深度介入。`supervisor-core.js` 的 `GoalStore`/`Supervisor` 与 `fastDriftCheck`/`buildReminder` 零依赖,可在控制台直接玩。

## 秘书 Agent:日程提醒 · 邮件分类 · 记想法分配

左侧有一个**可拖拽的悬浮卡片 🕊️ 秘书**,与右侧监督者并排。它做三件事:

- **随时对话 / 记想法**:写一句想法,点「记住」存进 `ThoughtStore`;点「🧭 记住并分配给合适的 Agent」会用 `TaskRouter` 判断该派给谁、挂哪些 skill,并自动把调度中枢填好。
- **日程 + 提醒**:本地日程列表,支持添加、提前提醒(15 分钟 / 1 小时 / 1 天 / 3 天),到点发系统通知(主进程 `Notification`)。
- **邮件分类 + 重要告知**:导入邮件(粘贴发件人/主题/正文),`classifyEmail` 按关键词自动分级(🔴重要紧急 / 📅会议邀请 / ✍️需回复 / ✅待办 / 💰账单 / 🔐账号安全 / ℹ️仅参考 / 📣营销),重要邮件立即发通知。
- **从邮件截图加日历**:点「📷 从邮件截图添加」选图 → 可粘贴邮件文字让 `extractEventHint` 自动提取标题/时间/链接,或手填 → 存成日程(带提醒 + 原邮件链接)。

设计借鉴(均为 Apache 2.0 / 可借鉴模式):`kylem148/secretary-agent`(日历规则、截图、动作前确认)、`lucasantoro97/postino`(IMAP 读信→分类归档→日历事件→晨间简报)、`Harrydi2006/mail-analyzer`(邮件提取事件、三级重要度、3 天/1 天/1 小时提醒)、`daddia/my-assistant`(收件箱分类 VIP/需回复/仅参考/营销)。

**边界说明**:日程与邮件目前是**本机本地存储**——邮件靠导入/粘贴,IMAP / Gmail 实时同步、系统日历(Apple Calendar / Google)双向同步、以及「截图 → 自动 OCR 识别」需要接入邮箱凭据或视觉模型,是下一步要做的事(见待办)。秘书所有动作都会先给你确认、不擅自发送或写入外部系统。

## 待办

- 会议纪要官真正转写需本机 FunASR 后端(127.0.0.1:8950 / 8951)。
- 按自己的用途继续加板块(Writing / 教学 / 投资等),并往板块里导入或新建 Skill。
- 带脚本的可执行型 Skill 目前只注入说明书;若要运行脚本,需先做逐项授权与沙箱。
- 更多 Agent(音乐创作、数据分析、翻译)与更多任务类型的自动路由。
- 让 Agent 操作本机文件 / 屏幕(需逐项授权,当前 `computer: 'off'`)。
- 监督者的「慢路径纠偏」与 ra 路由在真实模式下可改用模型做语义判断(当前为关键词启发式,免费、可解释)。
- 秘书的 IMAP / Gmail 实时同步、Apple Calendar / Google 双向同步(需邮箱/日历凭据与授权)。
- 秘书「截图 → 自动 OCR 识别」接入视觉模型(当前为手动确认 + 文字启发式提取)。

## 许可证

本项目为个人工作台。`agents-core.js` 的多 Agent 数据模型与桌面骨架提炼自 OpenMausBot(Apache License 2.0),相关代码保留其许可声明,详见 `LICENSE` 与 `NOTICE`。
