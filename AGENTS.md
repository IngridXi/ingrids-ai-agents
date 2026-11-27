# AGENTS.md — 接手本仓库前必读

## ⚠️ 铁律：改源码 ≠ 工作台生效，改完必须部署

本仓库（`~/Dev/Ingrids-AI-Agents`）是「Ingrid's AI Agents」工作台的**源码**。

用户实际双击运行的是打包好的 `.app`：
`~/Applications/Ingrid's AI Agents.app`（bundleId `com.ingridxi.agents`）。

**这个 `.app` 加载的是包内 `Contents/Resources/app/` 里的独立代码副本，不是本源码目录。**
所以：只改源码 + git commit，工作台界面**不会变**。必须显式部署。

### 正确链路（改完运行相关文件后）

```
bash deploy.sh            # 一键：退出 App → 同步+重签 → 重启 → 验证
```

或分步：

1. `bash sync-to-app.sh` —— rsync 源码 → `.app/Contents/Resources/app`（排除 node_modules/.git/build/dist/data/.workbuddy 等），补齐 node_modules，再 `node build/resign-app.cjs` 重签（自签名证书 `Ingrids AI Agents Signing`，**不能用 adhoc**，否则 cdhash 变 → 钥匙串/TCC 失效 → 反复弹密码）。
2. 完全退出 App（主进程 PID 看 `~/Library/Application Support/Ingrid's AI Agents/SingletonLock` 软链末尾数字；`kill <pid>`）。
3. `open "$HOME/Applications/Ingrid's AI Agents.app"` 重启，`SingletonLock` 重新出现即成功。

### 自动化

- `deploy.sh --sync-only`：只同步+重签，不退出不重启（适合「只要代码进包、不打断用户」）。
- git `post-commit` 钩子已装（`.git/hooks/post-commit`）：提交若改了运行文件（.js/.html/.css/.json 等），自动跑完整 `deploy.sh`。纯文档（docs/*.md）不触发。
- 判断 App 是否在运行：`ls "$HOME/Library/Application Support/Ingrid's AI Agents/"` 看有没有 `SingletonLock`。
- 验证部署生效：`grep -c "某关键字" "$HOME/Applications/Ingrid's AI Agents.app/Contents/Resources/app/main.js"` 与源码对比。

## 关键路径

| 内容 | 路径 |
|---|---|
| 主进程入口 | `main.js`（IPC、agent 治理、知识沉淀官、待办汇总都在这里） |
| 渲染进程 | `index.html`（主页侧边栏）、`tasks.js`（任务中心）、`secretary.js`（秘书） |
| 预加载桥 | `preload.js`（暴露 `window.ingrid.*` API） |
| 知识沉淀官 | `knowledge-settler-core.js`（提案/approve/自动发现） |
| 任务队列 | `task-queue.js` |
| 各 agent | `agents/<name>/index.html`（总控台 `agent-console`、架构图 `agent-architecture` 等） |
| 打包/签名 | `build/build-app.cjs`（打包）、`build/resign-app.cjs`（重签） |
| 同步/部署 | `sync-to-app.sh`、`deploy.sh` |

## 约定

- 打开 agent 视图必须走 `window.openAgentInView({name,href})`（带返回条），**不能**直接 `window.ingrid.openAgent(href)`，否则返回条不显示、全屏顶出、进得去出不来。
- 数据文件在 `~/Library/Application Support/Ingrid's AI Agents/`（`app.setName("Ingrid's AI Agents")` 决定 userData 目录）；应用运行时会重写它，直接改 JSON 会被覆盖，改逻辑要代码级（如 `purgeNonLessonProposals`）。
- 知识沉淀官铁律：**只提案、approve 才入库**（人工在环）；approve methodology 后 `syncLessonToObsidian()` 自动写 Obsidian 主库「经验沉淀/」。
- 待办入口统一在**任务中心**（`#taskDot` 红色数字 = 三类待审批总数）；秘书只发通知，不在面板列清单。
