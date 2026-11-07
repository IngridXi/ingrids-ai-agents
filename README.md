# Ingrid's AI Agents

个人 AI 工作台 —— 横屏方形按钮网格启动器,把常用的 AI Agent 集中到一个桌面应用里。

以开源项目 [OpenMausBot](https://github.com/milind-soni/OpenMausBot)(Apache 2.0)为架构底座构建:每个 Agent 是一个独立的"数字员工",有自己的名字、人设(soul)、记忆、技能、定时任务,以及各自绑定的模型引擎。

## 设计理念(继承自 OpenMausBot)

- **每个 Agent 绑定自己的引擎**:不靠一个全局大模型硬扛,而是「转写 → FunASR」「写作 → Claude Code」「代码 → Codex」各司其职。
- **local-first(本机优先)**:Agent 配置、记忆、API Key 全部存在本机,不上云。API Key 经系统钥匙串(`safeStorage`)加密后落盘。
- **bring-your-own-agent**:复用本机已登录的 CLI(`claude` / `codex` / `grok`),不用重新接一堆裸 API。
- **安全桥接**:`contextIsolation` 常开,渲染进程只接触 `window.ingrid` 一个白名单对象,拿不到 Node / `ipcRenderer`。

## 运行

```bash
npm install
npm start
```

## 目录结构

```
.
├── package.json            # Electron 应用入口
├── main.js                 # 主进程:窗口 + IPC + 文件持久化 + CLI 启动
├── preload.js              # 安全桥接(contextBridge → window.ingrid)
├── index.html              # 工作台界面(横屏方形按钮网格)
├── agents-core.js          # 可复用多 Agent 核心(ENGINES / AgentRegistry / ModelRouter)
└── agents/
    └── meeting-audio/      # 第一个 Agent:会议纪要官(实时转写 → 声纹认人 → 纪要 → PPT)
```

## Agent 数据模型

每个 Agent 拥有(对应 OpenMausBot 的 `newBotDefaults`):

| 字段 | 说明 |
|---|---|
| `name` / `emoji` / `tag` | 卡片显示 |
| `soul` | 人设 / 系统指令 |
| `engine` / `fallbacks` | 主引擎 + 降级链 |
| `memory` / `skills` / `routines` | 私有记忆 / 技能 / 定时任务 |
| `approvalMode` / `computer` | 权限模式 / 是否操控本机 |
| `status` / `href` / `detail` | 可用性 / 入口页 / 详情 |

数据持久化:桌面版写 `app.getPath('userData')/data/agents.json`;纯浏览器预览回退到 `localStorage`。

## 引擎表(agents-core.js)

| 引擎 | 类型 | 说明 |
|---|---|---|
| `claude-code` / `codex` / `grok` | 本机 CLI | 复用已登录会话 |
| `deepseek` / `gpt` / `qwen` | 云端 API | 需在「引擎设置」配 Key |
| `local-llm` / `funasr` | 本地推理 | 不上云,隐私优先 |

## 许可证

本项目为个人工作台。`agents-core.js` 的多 Agent 数据模型提炼自 OpenMausBot(Apache License 2.0),相关代码保留其许可声明。
