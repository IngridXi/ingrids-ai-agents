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
├── orchestrator.js         # 调度中枢面板(渲染层:委派 + 技能挂载 + 预设)
├── skills/
│   ├── boards.json         # 板块模板(首次运行复制到用户数据目录)
│   └── research/           # Research 板块的 5 个内置 Skill
│       ├── reviewer.md             # 审稿人
│       ├── deai.md                 # 去 AI 味
│       ├── academic-writing.md     # 写作
│       ├── literature-review.md    # 文献综述
│       └── research-mentor.md      # 研究导师
├── agents/
│   └── meeting-audio/      # 第一个 Agent:会议纪要官(实时转写 → 声纹认人 → 纪要 → PPT)
├── LICENSE / NOTICE        # Apache 2.0 全文 + OpenMausBot 归属声明
```

## 技能板块(v3):Skill 不做成 Agent,而是挂在这次任务上

三层解耦:**Skill = 能力(一份说明书) / Agent = 角色(谁来做) / Engine = 脑子(哪家模型)**。

把每个 Skill 做成独立 Agent 会让按钮数量爆炸、换模型要重配、多个技能协作要手动倒腾上下文。所以这里采用:**一个板块列表 + 派活时勾选或自动推荐挂载**,挂载的说明书只在本次请求的 `soul` 里生效,用完即卸,不写回 Agent。

### 板块是一级组织

板块 = 你的一个用途。工作台**默认只带 `Research` 一个板块、5 个内置 Skill**:审稿人、去 AI 味、写作、文献综述、研究导师。这 5 个的写法沿用了 `IngridXi/phd-ra-agent` 的研究助手风格(只依据给定证据、结构化输出、不臆造文献与数据)。

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

## 待办

- 会议纪要官真正转写需本机 FunASR 后端(127.0.0.1:8950 / 8951)。
- 按自己的用途继续加板块(Writing / 教学 / 投资等),并往板块里导入或新建 Skill。
- 带脚本的可执行型 Skill 目前只注入说明书;若要运行脚本,需先做逐项授权与沙箱。
- 更多 Agent(音乐创作、数据分析、翻译)与 `phd-ra-agent` 的任务类型自动路由。
- 让 Agent 操作本机文件 / 屏幕(需逐项授权,当前 `computer: 'off'`)。

## 许可证

本项目为个人工作台。`agents-core.js` 的多 Agent 数据模型与桌面骨架提炼自 OpenMausBot(Apache License 2.0),相关代码保留其许可声明,详见 `LICENSE` 与 `NOTICE`。
