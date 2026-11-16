'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * 只暴露固定方法（OpenMausBot 同款安全模型）：
 * 渲染进程拿不到 Node / ipcRenderer，只接触 window.ingrid 这个白名单对象。
 */
contextBridge.exposeInMainWorld('ingrid', {
  isDesktop: true,
  platform: process.platform,

  // agents（local-first 文件存储）
  loadAgentsSync: () => ipcRenderer.sendSync('agents:list-sync'),
  saveAgents: (agents) => ipcRenderer.invoke('agents:save', agents),

  // 打开 agent（单窗口：主进程用 BrowserView 内嵌，返回 true/false；不再新开窗口）
  openAgent: (href) => ipcRenderer.invoke('open-agent', href),
  // 关闭内嵌 agent（销毁 BrowserView，返回工作台）
  closeAgent: () => ipcRenderer.invoke('close-agent'),
  // 用系统浏览器打开外链（BrowserView 内 agent 的 window.open / 下载链接）
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  // 本机 CLI（bring-your-own-agent）
  detectCli: (engineId) => ipcRenderer.invoke('cli:detect', engineId),
  runCli: (engineId) => ipcRenderer.invoke('cli:run', engineId),
  authCli: (engineId) => ipcRenderer.invoke('cli:auth', engineId),

  // 设置（API key 加密存储）+ 真实执行开关
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  getRunMode: () => ipcRenderer.invoke('settings:run-mode'),
  setRunMode: (on) => ipcRenderer.invoke('settings:set-run-mode', on),

  // 用量账本（按月 jsonl）+ 月度预算
  loadUsageSync: () => ipcRenderer.sendSync('usage:list-sync'),
  recordUsage: (rec) => ipcRenderer.invoke('usage:record', rec),
  clearUsage: () => ipcRenderer.invoke('usage:clear'),
  getBudgetSync: () => ipcRenderer.sendSync('budget:get-sync'),
  setBudgetSync: (usd) => ipcRenderer.sendSync('budget:set-sync', usd),

  // API 余额监控（各家余额 + 用量汇总 + 低余额提醒）
  getBalance: () => ipcRenderer.invoke('balance:get'),
  refreshBalance: () => ipcRenderer.invoke('balance:refresh'),
  setBalanceThreshold: (engine, threshold) => ipcRenderer.invoke('balance:set-threshold', engine, threshold),
  setManualBalance: (engine, balance) => ipcRenderer.invoke('balance:set-manual', engine, balance),

  // 真正跑一个 Agent（主进程 spawn CLI / 调 API；默认演练不花钱）
  runAgent: (payload) => ipcRenderer.invoke('agent:run', payload),

  // 研究助手聊天（流式）：invoke 开始后，主进程推 chat:delta / chat:done 事件。
  // 关键：每个请求带 requestId，前端只认自己的事件——否则主聊天/自动标题/图片识别并发时，
  // 会互相收到对方的 chat:done 而提前中断（串线 bug）。
  chatStream: (payload, handlers) => {
    const h = handlers || {};
    const reqId = (payload && payload.requestId) || ('req-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8));
    const onDelta = (_e, d) => { if (d && d.requestId && d.requestId !== reqId) return; if (h.onDelta) h.onDelta(d || {}); };
    const onDone = (_e, d) => {
      if (d && d.requestId && d.requestId !== reqId) return;   // 忽略非本请求的完成信号
      ipcRenderer.removeListener('chat:delta', onDelta);
      ipcRenderer.removeListener('chat:done', onDone);
      if (h.onDone) h.onDone(d || {});
    };
    ipcRenderer.on('chat:delta', onDelta);
    ipcRenderer.on('chat:done', onDone);
    return ipcRenderer.invoke('chat:start', Object.assign({}, payload, { requestId: reqId }));
  },

  // 停止流式生成（主进程按 sessionId 精确 abort 该会话的请求；不传则全停）
  stopChat: (sessionId) => ipcRenderer.send('chat:stop', sessionId),

  // 研究助手「审稿闭环」：invoke 开始后，主进程推 review:phase / review:delta / review:done 事件
  reviewLoop: (payload, handlers) => {
    const h = handlers || {};
    const onPhase = (_e, d) => { if (h.onPhase) h.onPhase(d || {}); };
    const onDelta = (_e, d) => { if (h.onDelta) h.onDelta(String((d && d.text) || ''), String((d && d.thinking) || '')); };
    const onDone = (_e, d) => {
      ipcRenderer.removeListener('review:phase', onPhase);
      ipcRenderer.removeListener('review:delta', onDelta);
      ipcRenderer.removeListener('review:done', onDone);
      if (h.onDone) h.onDone(d || {});
    };
    ipcRenderer.on('review:phase', onPhase);
    ipcRenderer.on('review:delta', onDelta);
    ipcRenderer.on('review:done', onDone);
    return ipcRenderer.invoke('chat:review-loop', payload);
  },

  // 审稿闭环 checkpoint：读/清磁盘上的阶段级断点（支持中断后从断点续跑）
  reviewCheckpointLoad: (agent) => ipcRenderer.invoke('review:checkpoint:load', agent),
  reviewCheckpointClear: (agent) => ipcRenderer.invoke('review:checkpoint:clear', agent),

  // 技能板块 / 只读索引 / 按需读正文 / 预设（v3）
  scanSkillsSync: () => ipcRenderer.sendSync('skills:scan-sync'),
  scanSkills: () => ipcRenderer.invoke('skills:scan'),
  readSkill: (id) => ipcRenderer.invoke('skills:read', id),
  loadBoardsSync: () => ipcRenderer.sendSync('boards:list-sync'),
  saveBoards: (boards) => ipcRenderer.invoke('boards:save', boards),
  loadPresetsSync: () => ipcRenderer.sendSync('presets:list-sync'),
  savePresets: (list) => ipcRenderer.invoke('presets:save', list),

  // 监事（核心需求 / 开关 / 纠偏指令，local-first 文件持久化）
  loadSupervisorSync: () => ipcRenderer.sendSync('supervisor:list-sync'),
  saveSupervisor: (state) => ipcRenderer.invoke('supervisor:save', state),

  // 秘书（日程 / 邮件 / 想法 + 系统通知）
  loadSecretarySync: () => ipcRenderer.sendSync('secretary:list-sync'),
  saveSecretary: (state) => ipcRenderer.invoke('secretary:save', state),
  notify: (payload) => ipcRenderer.invoke('notify', payload),

  // 邮箱 / 日历同步（CalDAV 账户 + 触发同步）
  syncAccountsList: () => ipcRenderer.invoke('sync:accounts:list'),
  syncAccountSave: (acct) => ipcRenderer.invoke('sync:accounts:save', acct),
  syncAccountRemove: (id) => ipcRenderer.invoke('sync:accounts:remove', id),
  syncCalendarRun: () => ipcRenderer.invoke('sync:calendar:run'),
  syncCalendarPush: (ev) => ipcRenderer.invoke('sync:calendar:push', ev),
  syncOauthStart: (payload) => ipcRenderer.invoke('sync:oauth:start', payload),
  onCalendarSynced: (cb) => ipcRenderer.on('calendar:synced', (_e, d) => { if (cb) cb(d || {}); }),
  onOauthDone: (cb) => ipcRenderer.on('oauth:done', (_e, d) => { if (cb) cb(d || {}); }),

  // 研究日历：即将到期日程 + 到期提醒事件监听
  calendarUpcoming: (days) => ipcRenderer.invoke('calendar:upcoming', days),
  onCalendarReminder: (cb) => ipcRenderer.on('calendar:reminder', (_e, d) => { if (cb) cb(d || []); }),

  // ICS 订阅 / 导入外部日历（Teams/Outlook 等发布的 .ics）
  calendarIcsList: () => ipcRenderer.invoke('calendar:ics:list'),
  calendarIcsAdd: (name, url) => ipcRenderer.invoke('calendar:ics:add', name, url),
  calendarIcsRemove: (id) => ipcRenderer.invoke('calendar:ics:remove', id),
  calendarIcsRun: () => ipcRenderer.invoke('calendar:ics:run'),
  calendarIcsImport: () => ipcRenderer.invoke('calendar:ics:import'),

  // Outlook 邮箱同步
  syncMailRun: () => ipcRenderer.invoke('sync:mail:run'),
  onMailSynced: (cb) => ipcRenderer.on('mail:synced', (_e, d) => { if (cb) cb(d || {}); }),

  // Notion 接入
  notionConfigure: (token) => ipcRenderer.invoke('notion:configure', token),
  notionStatus: () => ipcRenderer.invoke('notion:status'),
  notionSearch: (query) => ipcRenderer.invoke('notion:search', query),
  notionRead: (id) => ipcRenderer.invoke('notion:read', id),
  notionTest: () => ipcRenderer.invoke('notion:test'),
  notionSync: () => ipcRenderer.invoke('notion:sync'),
  onNotionSynced: (cb) => ipcRenderer.on('notion:synced', (_e, d) => { if (cb) cb(d || {}); }),
  notionResearchSync: () => ipcRenderer.invoke('notion:research-sync'),
  notionResearchConfig: (cfg) => ipcRenderer.invoke('notion:research-config', cfg),
  notionListPages: () => ipcRenderer.invoke('notion:list-pages'),
  onResearchSynced: (cb) => ipcRenderer.on('research:synced', (_e, d) => { if (cb) cb(d || {}); }),
  fsPermCheck: () => ipcRenderer.invoke('fs:perm-check'),

  // 知识库（本地 RAG：扫描 / 检索 / 状态 / 配置）
  kbScan: (force) => ipcRenderer.invoke('kb:scan', !!force),
  kbScanReference: () => ipcRenderer.invoke('kb:scan-reference'),
  kbSearch: (query, k) => ipcRenderer.invoke('kb:search', query, k),
  kbStatus: () => ipcRenderer.invoke('kb:status'),
  kbConfigure: (patch) => ipcRenderer.invoke('kb:configure', patch),
  kbAddSource: (src) => ipcRenderer.invoke('kb:add-source', src),
  kbRemoveSource: (id) => ipcRenderer.invoke('kb:remove-source', id),
  kbOpen: (kind) => ipcRenderer.invoke('kb:open', kind),
  kbTermsBuild: (opts) => ipcRenderer.invoke('kb:terms:build', opts),
  onKbTermsProgress: (cb) => ipcRenderer.on('kb:terms:progress', (_e, d) => { if (cb) cb(d || {}); }),

  // 浏览器自动化（安全白名单：打开 / 截图 / 提取文本）
  browserAutomate: (payload) => ipcRenderer.invoke('browser:automate', payload),

  // 文档生成（内建：Word / PPT / Excel，本地生成不依赖宿主 skill）
  docGenerate: (payload) => ipcRenderer.invoke('doc:generate', payload),

  // 网页抓取 + 联网搜索（Firecrawl / Perplexity 的免费替代）
  webFetch: (payload) => ipcRenderer.invoke('web:fetch', payload),
  webSearch: (payload) => ipcRenderer.invoke('web:search', payload),

  // 电脑操作员（computer use：截图 + 视觉模型 + 鼠标键盘控制）
  computerStart: (payload) => ipcRenderer.invoke('computer:start', payload),
  computerStop: () => ipcRenderer.invoke('computer:stop'),
  onComputerEvent: (cb) => ipcRenderer.on('computer:event', (_e, d) => { if (cb) cb(d || {}); }),

  // 授权门（有副作用操作前显式授权 + 审计：电脑操作 / 可执行 Skill / 文件写入）
  permissionList: () => ipcRenderer.invoke('permission:list'),
  permissionGrant: (action, opts) => ipcRenderer.invoke('permission:grant', action, opts),
  permissionRevoke: (idOrAction) => ipcRenderer.invoke('permission:revoke', idOrAction),
  permissionCheck: (action, opts) => ipcRenderer.invoke('permission:check', action, opts),
  permissionAudit: () => ipcRenderer.invoke('permission:audit'),

  // 会议纪要官：朗读纪要（macOS 原生 TTS，本地合成不上云）
  speak: (text) => ipcRenderer.invoke('meeting:speak', text),

  // 工具能力（文件 / 数据库；读安全白名单，写需审批）
  toolFsList: (payload) => ipcRenderer.invoke('tool:fs:list', payload),
  toolFsSearch: (payload) => ipcRenderer.invoke('tool:fs:search', payload),
  toolFsRead: (payload) => ipcRenderer.invoke('tool:fs:read', payload),
  toolFsWrite: (payload) => ipcRenderer.invoke('tool:fs:write', payload),
  toolFsAppend: (payload) => ipcRenderer.invoke('tool:fs:append', payload),
  toolFsEdit: (payload) => ipcRenderer.invoke('tool:fs:edit', payload),
  toolFsMove: (payload) => ipcRenderer.invoke('tool:fs:move', payload),
  toolFsDelete: (payload) => ipcRenderer.invoke('tool:fs:delete', payload),
  // 拖拽文件 → 取磁盘真实路径（Electron 32+ 用 webUtils.getPathForFile 替代已废弃的 File.path）
  getFilePath: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch { return ''; } },
  toolPptxFill: (payload) => ipcRenderer.invoke('tool:pptx:fill', payload),
  toolImageProcess: (payload) => ipcRenderer.invoke('tool:image:process', payload),
  toolImageGenerate: (payload) => ipcRenderer.invoke('tool:image:generate', payload),
  toolSkillInstall: (payload) => ipcRenderer.invoke('tool:skill:install', payload),
  toolSkillInstallFromUrl: (payload) => ipcRenderer.invoke('tool:skill:install-from-url', payload),
  toolBrainIngest: (payload) => ipcRenderer.invoke('tool:brain:ingest', payload),
  toolBrainLint: (payload) => ipcRenderer.invoke('tool:brain:lint', payload),
  toolBrainIndex: (payload) => ipcRenderer.invoke('tool:brain:index', payload),
  toolDbQuery: (payload) => ipcRenderer.invoke('tool:db:query', payload),
  toolDbObsidianWrite: (payload) => ipcRenderer.invoke('tool:db:obsidian:write', payload),
  toolDbObsidianTag: (payload) => ipcRenderer.invoke('tool:db:obsidian:tag', payload),
  toolDbObsidianMove: (payload) => ipcRenderer.invoke('tool:db:obsidian:move', payload),
  toolDbObsidianPromote: (payload) => ipcRenderer.invoke('tool:db:obsidian:promote', payload),
  toolDbObsidianReport: () => ipcRenderer.invoke('tool:db:obsidian:report'),
  workspaceList: () => ipcRenderer.invoke('workspace:list'),
  toolDbZoteroReport: () => ipcRenderer.invoke('tool:db:zotero:report'),
  toolDbZoteroTag: (payload) => ipcRenderer.invoke('tool:db:zotero:tag', payload),
  toolDbZoteroCollection: (payload) => ipcRenderer.invoke('tool:db:zotero:collection', payload),

  // 软件工程 agent 工具（逆向 / 编译 / 补丁 / 反编译）
  toolBinInfo: (payload) => ipcRenderer.invoke('tool:bin:info', payload),
  toolBinStrings: (payload) => ipcRenderer.invoke('tool:bin:strings', payload),
  toolBinSymbols: (payload) => ipcRenderer.invoke('tool:bin:symbols', payload),
  toolBinDisasm: (payload) => ipcRenderer.invoke('tool:bin:disasm', payload),
  toolBinDeps: (payload) => ipcRenderer.invoke('tool:bin:deps', payload),
  toolBinHex: (payload) => ipcRenderer.invoke('tool:bin:hex', payload),
  toolRunShell: (payload) => ipcRenderer.invoke('tool:run:shell', payload),
  toolBinPatch: (payload) => ipcRenderer.invoke('tool:bin:patch', payload),
  toolPyDecompile: (payload) => ipcRenderer.invoke('tool:py:decompile', payload),

  // 聊天记忆持久化（按 Agent 名隔离）
  chatHistoryLoad: (name) => ipcRenderer.invoke('chat:history:load', name),
  chatHistorySave: (name, history) => ipcRenderer.invoke('chat:history:save', name, history),
  chatHistoryClear: (name) => ipcRenderer.invoke('chat:history:clear', name),
  chatBackup: () => ipcRenderer.invoke('chat:backup'),

  // 会话回放（append-only 事件日志：列表 / 回放 / 分叉 / 续跑上下文）
  sessionLogList: () => ipcRenderer.invoke('session:log:list'),
  sessionLogReplay: (id) => ipcRenderer.invoke('session:log:replay', id),
  sessionLogFork: (id) => ipcRenderer.invoke('session:log:fork', id),
  sessionLogResume: (id, opts) => ipcRenderer.invoke('session:log:resume', id, opts),

  // 后台任务队列（丢任务后台跑、完成/需决策才提醒）
  taskList: () => ipcRenderer.invoke('task:list'),
  taskCreate: (t) => ipcRenderer.invoke('task:create', t),
  taskUpdate: (id, patch) => ipcRenderer.invoke('task:update', id, patch),
  taskRemove: (id) => ipcRenderer.invoke('task:remove', id),
  taskClear: () => ipcRenderer.invoke('task:clear'),
  taskRun: (id) => ipcRenderer.invoke('task:run', id),
  taskStop: (id) => ipcRenderer.invoke('task:stop', id),
  taskClassify: (text) => ipcRenderer.invoke('task:classify', text),
  onTaskChanged: (cb) => ipcRenderer.on('task:changed', (_e, d) => { if (cb) cb(d || {}); }),

  // 自然语言定时解析（「明天下午3点 / 每天9点」→ schedule 字符串）
  scheduleParse: (text) => ipcRenderer.invoke('schedule:parse', text),

  // 数据仪表盘：聚合本地多源数据（笔记 / 聊天 / 任务 / 日历 / 术语）
  dashboardGet: () => ipcRenderer.invoke('dashboard:get'),

  // 知识沉淀官（经验沉淀：提案待审批 → 人工 approve 分层入库 → 检索复用）
  settlerReport: () => ipcRenderer.invoke('settler:report'),
  settlerProposals: (status) => ipcRenderer.invoke('settler:proposals', status),
  settlerLibrary: () => ipcRenderer.invoke('settler:library'),
  settlerApprove: (id, opts) => ipcRenderer.invoke('settler:approve', id, opts),
  settlerIgnore: (id) => ipcRenderer.invoke('settler:ignore', id),
  settlerSubmit: (item) => ipcRenderer.invoke('settler:submit', item),
  settlerSuggest: (q) => ipcRenderer.invoke('settler:suggest', q),
  settlerRunOnce: () => ipcRenderer.invoke('settler:run-once'),

  // Agent 治理官（只读盘点 + 重叠检测 + 对账）
  governanceReport: () => ipcRenderer.invoke('governance:report'),
  governanceRun: () => ipcRenderer.invoke('governance:run'),

  // 情绪/偏好 Agent（侦测评价情绪 → 提炼 do/avoid 偏好 → 联动经验沉淀）
  sentimentReport: () => ipcRenderer.invoke('sentiment:report'),
  sentimentSignals: (limit, valence) => ipcRenderer.invoke('sentiment:signals', limit, valence),
  sentimentPreferences: (agent) => ipcRenderer.invoke('sentiment:preferences', agent),
  sentimentGuidance: (agent) => ipcRenderer.invoke('sentiment:guidance', agent),
  sentimentObserve: (raw) => ipcRenderer.invoke('sentiment:observe', raw),
  sentimentDistill: () => ipcRenderer.invoke('sentiment:distill'),
  sentimentUpdatePreference: (id, patch) => ipcRenderer.invoke('sentiment:update-preference', id, patch),
  sentimentRemovePreference: (id, opts) => ipcRenderer.invoke('sentiment:remove-preference', id, opts),

  // 灵感目录（生态雷达：每日调研 DSH 插件生态）
  ecoRadarRun: () => ipcRenderer.invoke('eco:radar:run'),
  ecoRadarStatus: () => ipcRenderer.invoke('eco:radar:status'),
  onEcoRadarUpdated: (cb) => ipcRenderer.on('eco-radar:updated', (_e, d) => { if (cb) cb(d || {}); }),
});
