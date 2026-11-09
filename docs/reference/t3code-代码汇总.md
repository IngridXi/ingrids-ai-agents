# T3 Code（pingdotgg/t3code）代码汇总

> 仓库：https://github.com/pingdotgg/t3code · 官网 https://t3.codes · 作者 Theo（t3.chat / pingdotgg）
> 语言：TypeScript · 协议：MIT · 规模：monorepo（apps + packages + docs + evals + native）
> 本地克隆：`~/Dev/_reference/t3code`

## 一句话定位

T3 Code 自称 **"agent harness control surface"（Agent 挂架控制面）**——它**不自己实现 agent**，而是给你本机已经装好并登录的那些 AI 编程 agent（Claude Code、Codex、Cursor、Grok Build、OpenCode、Antigravity、fx）套一个统一图形外壳，通过 Web / 桌面 / 移动端远程控制它们。

README 原话：*"a minimal web GUI for coding agents (currently Codex and Claude, more coming soon)"*。

## 结论先行：对你的价值

**高。这是你「Ingrid's AI Agents」方向上的成熟版参考答案。** 你做的事（Electron 外壳 + 控制本地多个 agent + 工具调用循环 + 审批流）它都做了，而且做得更工程化。最值得你抄的不是它的 UI，而是下面 5 个**架构决策**——它们恰好回答了你这一路踩过的坑：怎么让"换引擎/加 agent"不散架、怎么写权限、怎么让审批和副作用不污染核心逻辑。

## monorepo 结构

```
apps/
  desktop/    Electron 桌面端（内嵌 server）
  web/        Web 端
  mobile/     iOS / Android（React Native）
  server/     后端（真正跑 agent 进程的地方）
  marketing/  官网
packages/
  contracts/          数据契约（effect/Schema），前后端 RPC 的边界
  provider-core/      定义 ProviderAdapterV2 接口 + 共享 server 逻辑
  provider-<name>/    每个 agent 一个包：codex/claude/cursor/grok/opencode/pi/muse/fx/antigravity/acp
  effect-acp/         ACP（Agent Client Protocol）实现
  source-control-*/   git forge 集成（github/gitlab/bitbucket/azure/...）
  secret-provider-*/  密钥（onepassword 等）
  client-runtime/     客户端共享的连接/域状态
  shared/             通用工具（DrainableWorker 等）
docs/
  internals/    架构说明（overview / providers / adding-a-provider / terminal-runtime ...）
  user/         用户文档
  orchestration-v2/   v2 编排设计文档
evals/  native/  scripts/  ...
```

## 五大核心设计（都值得你借鉴）

### 1. 所有权边界（Ownership boundary）—— 谁拥有什么

> `docs/internals/overview.md`

**Provider 进程、终端、Git、项目文件属于 server；客户端（web/desktop/mobile）只通过带认证的 RPC 控制，绝不用自己的文件系统/凭据去替代 server 的。** 桌面端的 renderer 也遵守同一条边界。

```
# overview.md 原话
T3 Code keeps execution in the environment that owns the workspace. Web, desktop, and mobile
clients control it over authenticated RPC. A remote client must never substitute its own filesystem,
provider credentials, or machine state for the environment's.
```

→ **对应你项目**：你的 `main.js`（主进程）就是那个"拥有 workspace 的 environment"，renderer 只该发指令。你现在的 `isSafeWritePath`、`tool:fs:*` 已经在往这个方向走，但可以再明确"所有 agent 进程/文件 IO 都收在 main 进程，renderer 零文件权限"。

### 2. Provider = 可插拔内核 + 声明式 capabilities

> `docs/internals/providers.md` + `packages/provider-core/src/server/ProviderAdapter.ts`

核心接口是 `ProviderAdapterV2`，**每个 agent 在自己的 `packages/provider-<name>` 包实现 adapter**。区分两个概念：

- **driver kind**：标识一种集成（"Claude"、"Codex"）
- **instance**：标识一个配置 + 账号生命周期（"我登录的 Codex 账号 A"）

按 instance 路由，两个账号用同一 driver 也互不串 session/catalog。

**Capabilities 只声明 agent 真实会做的**（`OrchestrationV2ProviderCapabilities`）：fork / rollback / steering / subagent 哪个不支持就关掉，orchestration 自动降级（例如不支持 rollback 就改用 portable context handoff）。

```
# adding-a-provider.md 原话
Capabilities. Set every flag ... to what the provider really does.
Turn off fork, rollback, steering, or subagent support it lacks; orchestration then falls back.
A capability left on that fails at runtime is a bug.
```

→ **对应你项目**：你现在"每个 Agent 开 `tools`/`computer` 开关"就是 capability 的雏形，但可以升级成**结构化 capability 对象**（`{fs, db, web, computer, fork, rollback}`），让编排层根据 capability 自动降级，而不是在 UI 里散落 if 判断。你的 `agents.json` + `DEFAULT_AGENT` 已经留了字段，差一步建模。

### 3. 事件溯源式编排（durable intent 与 side effect 分离）

> `docs/internals/overview.md` + `apps/server/src/orchestration-v2/{Orchestrator,EventSink,EffectWorker}.ts`

这是它最值钱的一块，把"意图"和"副作用"彻底切开：

```
Orchestrator   →  序列化命令、决定事件（不做任何 provider / 文件 IO）
EventSink      →  在【单个数据库事务】里提交：事件 + 持久化投影 + 命令回执 + outbox 副作用
EffectWorker   →  意图已记录之后，才执行副作用，再把结果喂回编排
```

**命令 ack 只代表"意图已提交"，不代表 provider/副作用已完成。** 外部 IO 绝不进命令决策和 DB 事务。

→ **对应你项目**：你的工具调用循环目前是"同步执行→把结果塞回对话"，可以借鉴这个思路：先把"用户意图 + 待执行工具"落盘（写进 chat-history），再执行，再回填。这样进程崩溃/断电也能恢复，且"审批"这件事天然落在意图层而不是执行层。你已有的 `chat-history` 持久化就是投影层的雏形。

### 4. RPC 契约是版本化边界

> `packages/contracts/src/rpc.ts`

client 与 server 独立版本化，通过 `contracts` 包（effect/Schema）约束。订阅只推 client 需要的 state——"看一个 thread 的 client 不必为所有 thread 的历史买单"。**socket 认证通过 ≠ 该 socket 上所有方法都授权。**

→ **对应你项目**：你现在的 preload.js 是"一股脑暴露所有 IPC"。可以借鉴"按会话/按能力做方法级授权"。

### 5. Checkpoint 用隐藏 Git ref

> `apps/server/src/checkpointing/CheckpointStore.ts`

用**隐藏 git ref** 捕获工作区状态，不往用户分支加 commit。回滚必须协调"工作区状态 + provider 对话"；不能回滚对话的 provider，必须在改文件之前就拒绝该操作。

→ **对应你项目**：你的"文件写前审批 + 删除走废纸篓"是同一思路的简化版；如果要更狠可以加 checkpoint（写完前先快照）。

## 可直接照抄的工程细节

| 你的痛点 | t3code 的解法 | 出处 |
|---|---|---|
| 加一个 agent 要改一堆地方 | 新 provider = 一个新 `packages/provider-<name>` 包，实现 `ProviderAdapterV2`，orchestration/client 只读 capabilities，不读 driver kind | `adding-a-provider.md` |
| 权限模式散乱 | 只提供 provider **原生强制**的权限模式；不模仿它缺失的模式（"T3 的检查弱于 agent 自己的强制"） | `providers.md` / `RuntimePolicy.ts` |
| 审批选项 ID 丢失 | 把 provider 自己的 option ID **原样透传**；显示 label 不一定是合法回复 | `adding-a-provider.md` |
| 状态探测误启动 agent | 状态检查/模型刷新**不得**打开一个会启动 MCP server / 跑 hook / 弹登录的 session | `providers.md` |
| 更新 provider 乱装 | 只通过"能证明拥有该二进制"的 installer 更新（brew/npm/volta/mise 逐一验证），否则留手动 | `providerMaintenanceRunner.ts` |

## 协议陷阱清单（每个都坑过不止一个 adapter）

这几条特别适合你在做"多 agent 接入"时当 checklist：

1. **Settings 在 provider 广告之前就应用** —— 等选项被广告出来再写；stored 选项 session 没提供的按"跳过"处理，不报错。
2. **"default" 是哨兵不是模型** —— 选过命名模型后要切回默认；别把哨兵发给 provider。
3. **Stop 在 turn 开始前就发出** —— 可能被忽略、turn 跑完；找到 provider 自己的"turn-started"信号。
4. **provider 自发启动的后台工作** —— 子代理/goal 可能在 turn settle 之后才结束；提供 continuation，报告 `hasPendingBackgroundWork`，别把 session 释放成 idle。
5. **subagent 比启动它的 run 活得久** —— 按 subagent 路由更新，别按"当前活跃的 run"。
6. **失败/停止的 turn 什么都没留下** —— 收尾 tool calls、subagents、pending approvals/questions；完成/Stop/失败/进程退出各写一条 replay。
7. **Usage limit 不是通用失败** —— 配额/限流归类成 `usage_limit` 带 reset 时间，thread 显示 Limited 可恢复。
8. **路径与环境** —— 测试 symlink 工作区（macOS `/tmp`）；清掉 instance 没配置的继承凭据。

## 给你的落地方案（下一步可做）

t3code 最值得你现在就搬的，是**把 agent 从"硬编码卡片"抽象成 provider 接口**。具体：

1. 在 `agents-core.js` 里定义 `ProviderAdapter` 接口（`start/capabilities/stream/interrupt`）；
2. 每个 agent 一个 adapter 实现，`agents.json` 里存 `driver + instanceId + capabilities`；
3. 编排层（你的 `orchestrator.js`）只读 capabilities 决策，不读具体 agent 名。

这能一次性解决你后续"加 Notion、加电脑操作、加更多 agent"时每次都要改主流程的负担。

---

*汇总时间 2026-11-09，基于 `git clone --depth 1` 的源码与 `docs/internals`、`docs/orchestration-v2` 文档。*
