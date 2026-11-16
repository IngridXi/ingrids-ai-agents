# 海归海后台 Agent 借鉴 + 工作台落地设计

> 本文记录：从「海归海数字经营平台」后台 Agent 体系里提炼出、可复用到
> Ingrid's AI Agents 工作台的设计模式，以及本次已落地实现的内容。

## 一、海归海后台 Agent 体系（盘点结论）

海归海平台（`~/WorkBuddy/2026-10-28-21-44-19/haiguihai-platform`）的后台有一整套
「Agent 自主运营 + 管理」机制，核心是**控制面（Control Plane）Agent 组**，不面向业务人员、
只面向管理员，构成一条完整闭环：

```
需求分析师 ──→ IT 工程师 ──→ IT 副手 ──→ 质量门禁 ──→ 经验沉淀官
(spec 先行)   (诊断)        (执行 patch)  (独立审查)   (沉淀复用)
```

| 后台 Agent | 角色 | 职责 |
|---|---|---|
| 需求分析师 | 入口 | 一句话需求 → EARS 记法 spec，待审批 |
| IT 工程师 | 诊断者 | finding → 根因诊断 + 修复方案（待审批） |
| IT 副手 | 执行者 | 执行已批准的 patch |
| 质量门禁 | 审查者 | 独立审查执行结果 |
| 审批预审官 | 预审 | auto_approve / skip / 转人工 三态分流 |
| **经验沉淀官** | **沉淀者** | 复盘已解决项 → 经验提案 → 分层入库 → 检索复用 |
| Agent 治理官 | 治理 | 只读盘点：职责 / 重叠 / 空壳孤儿对账 |
| 数据治理官 | 治理 | 源文件覆盖对账 + 口径审计 |
| 安全巡检官 | 巡检 | 安全风险扫描 |
| 决策顾问 | 顾问 | DeepSeek 云端「说人话」给审批建议 |

## 二、四个最值得借鉴的设计

### 1. 经验沉淀官（experience_settler）—— 知识沉淀 Agent

**最核心的可借鉴点**。融合四套开源范式（有机结合，非照搬）：

| 范式 | 出处 | 落地 |
|---|---|---|
| Voyager 技能库 | MineDojo/Voyager | 方法论沉淀成 skill，新问题先 `suggest_for` 检索复用 |
| Reflexion 反思 | noahshinn/reflexion | 问题 resolved 后触发「复盘 → 提炼」闭环 |
| SKILL.md 标准 | anthropics/skills | 方法论用 skill 格式承载（待 skill 化） |
| MemGPT 分层记忆 | cpacker/MemGPT | 短期 trace → 蒸馏 → 长期（方法论库 / 结论库） |

**三条人工在环铁律**（不可绕过）：
1. 只提案、不自动写库：`run_once` 只产出 `pending_approval`，`approve()` 才入库。
2. 分类以人工为准：启发式预标注可覆盖。
3. **「经验」≠「规律」**：一次性结论（批次/日期/金额/门店）不得当通用方法论，
   方法论与结论**分库**存放，避免把巧合当规律、把表面补丁当方法论。

**关键细节**：
- 方法论信号词（归一化/去重/幂等/断点续传…）vs 结论信号词（batch/日期/金额/条数…）。
- `verification` 字段：方法论强制建议附「怎么验证这条经验仍适用」的检验步骤。
- 检索复用是「提示」不是「代劳」——命中经验只加速定位，不跳过根因追查。
- `_SKIP_RULES` 显式过滤纯运维动作提醒（如「改完没重启」），避免污染经验库。

### 2. Agent 治理官（agent_governance）—— 自主运营的「体检」

回答「平台上有哪些 agent、各干什么、边界是否清晰、有没有重叠或空壳孤儿」。
纯只读扫描、零 LLM 消耗，三个检查器 + 一个编排：

| 检查器 | 职责 |
|---|---|
| 职责盘点 | 扫三来源（前端页 / 后端包 / 门户 launcher）合并成单一清单，按职责域归类 |
| 重叠检测 | 职责域关键词共现，找出边界模糊的 agent 对 |
| 对账 | 前端↔后端映射、孤儿前端 / 孤儿后端 / 空壳检出 |

**分级策略**：空壳/孤儿前端 = 阻塞级（CI exit 1）；重叠/自含 = 提示级（待人工）。
铁律：只读 + 不自动造/合并/下线任何 agent，去留由人拍板。

### 3. Agent 总控台（agents-console）—— 实时监控界面

单页「Agent 工作台 · 后台总控」，包含：
- **概览 KPI**：后台 Agent 数 / 事件总量 / 待人工审批 / 模型路由。
- **流水线图**：把「需求→诊断→执行→审查→沉淀」可视化。
- **待我审批**：三类待办（修复方案 / 经验提案 / 需求 spec）分栏，配「决策顾问」侧栏。
- **Agent 实时状态**：每个 Agent 一个状态点（正常/警告/错误）。
- **动作时间线**：按 Agent / 状态 / 日期过滤。
- **14 天活动热力图**：Agent × 日期 的活跃度矩阵。
- **成本 / 耗时**：LLM 调用成本 + job 调度耗时 + 月度预算阈值（超限标红）。

### 4. 独立 scheduler 进程 + 跨日触发

多 worker 部署下，定时任务只跑单实例（`scheduler_entry.py`），避免重复执行。
Agent 治理 / 数据治理包装成「跨日触发一次」的 job，报告落库、控制台读最新报告，
替代「靠人记得手动跑 CLI」。

## 三、工作台落地对照表

| 海归海能力 | 工作台现状（本次前） | 本次落地 |
|---|---|---|
| 经验沉淀官 | ❌ 无 | ✅ `knowledge-settler-core.js`（知识沉淀官核心） |
| Agent 治理官 | ⚠️ 有监督者/秘书，无职责盘点 | ✅ `agent-governance.js`（职责盘点+重叠+对账） |
| Agent 总控台 | ⚠️ 有 dashboard 数据仪表盘，非 agent 监控 | ✅ `agents/agent-console/index.html`（总控台） |
| 调度器 | ✅ 已有 taskScheduler + Watchdog | 复用（治理巡检接到手动触发 + 落盘） |
| 审批预审官 | ⚠️ orchestrator 有审批钩子 | 复用（经验提案审批即人工在环） |
| 决策顾问 | ❌ 无 | 暂未做（可后续接 chat agent 给审批建议） |

## 四、本次实现清单

| 文件 | 说明 |
|---|---|
| `knowledge-settler-core.js` | 知识沉淀官核心（纯 JS 零依赖 IIFE，浏览器/Node 双端）。提案状态机（pending/approved/ignored）、方法论/结论分层库、启发式分类、`suggest_for` 检索复用、`verification` 验证清单 |
| `agent-governance.js` | Agent 治理官（Node 侧 CommonJS）。扫 `agents/<slug>/index.html` + `index.html` SEED_AGENTS + `agents.json`，职责盘点 + 重叠检测 + 孤儿/空壳对账，报告落盘 `data/agent-governance.json` |
| `agents/agent-console/index.html` | Agent 总控台页面（借鉴 agents-console）。概览 KPI、流水线、待审批（批准入库/忽略 + 验证步骤）、手动沉淀、经验库分层浏览、治理巡检 + 触发、检索复用演示 |
| `main.js` | 加知识沉淀官单例（文件落盘 `data/experience-library.json`）+ 治理官，新增 9 个 IPC（settler:report/proposals/library/approve/ignore/submit/suggest/run-once + governance:report/run） |
| `preload.js` | 暴露 `settler*` + `governance*` 白名单 API |
| `index.html` | SEED_AGENTS 新增「Agent 总控台」入口卡片（emoji 🖥️，badge 后台） |

## 五、设计边界（与海归海一致）

- **知识沉淀官**：只提案、分类预标注、待审批，`approve()` 才分层入库；绝不自动生成 skill
  （方法论登记后标注「待 skill 化」，正式 skill 由主 agent 用 skill-creator 生成）。
- **Agent 治理官**：纯只读扫描，不注册/合并/下线任何 agent。
- **存储 local-first**：经验库落 `data/experience-library.json`，治理报告落 `data/agent-governance.json`，
  不上云、不依赖外部服务。
- **复用既有调度**：治理巡检的「跨日自动触发」可挂到工作台已有 `startTaskScheduler()`；
  当前先提供手动触发 + 落盘，避免引入新的定时循环复杂度。
