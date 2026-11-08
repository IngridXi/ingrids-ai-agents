'use strict';
const { contextBridge, ipcRenderer } = require('electron');

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

  // 打开 agent
  openAgent: (href) => ipcRenderer.invoke('open-agent', href),

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

  // 真正跑一个 Agent（主进程 spawn CLI / 调 API；默认演练不花钱）
  runAgent: (payload) => ipcRenderer.invoke('agent:run', payload),

  // 研究助手聊天（流式）：invoke 开始后，主进程推 chat:delta / chat:done 事件
  chatStream: (payload, handlers) => {
    const h = handlers || {};
    const onDelta = (_e, d) => { if (h.onDelta) h.onDelta(d || {}); };
    const onDone = (_e, d) => {
      ipcRenderer.removeListener('chat:delta', onDelta);
      ipcRenderer.removeListener('chat:done', onDone);
      if (h.onDone) h.onDone(d || {});
    };
    ipcRenderer.on('chat:delta', onDelta);
    ipcRenderer.on('chat:done', onDone);
    return ipcRenderer.invoke('chat:start', payload);
  },

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

  // 知识库（本地 RAG：扫描 / 检索 / 状态 / 配置）
  kbScan: () => ipcRenderer.invoke('kb:scan'),
  kbSearch: (query, k) => ipcRenderer.invoke('kb:search', query, k),
  kbStatus: () => ipcRenderer.invoke('kb:status'),
  kbConfigure: (patch) => ipcRenderer.invoke('kb:configure', patch),

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

  // 工具能力（文件 / 数据库，只读安全白名单）
  toolFsList: (payload) => ipcRenderer.invoke('tool:fs:list', payload),
  toolFsSearch: (payload) => ipcRenderer.invoke('tool:fs:search', payload),
  toolFsRead: (payload) => ipcRenderer.invoke('tool:fs:read', payload),
  toolDbQuery: (payload) => ipcRenderer.invoke('tool:db:query', payload),

  // 聊天记忆持久化（按 Agent 名隔离）
  chatHistoryLoad: (name) => ipcRenderer.invoke('chat:history:load', name),
  chatHistorySave: (name, history) => ipcRenderer.invoke('chat:history:save', name, history),
  chatHistoryClear: (name) => ipcRenderer.invoke('chat:history:clear', name),
});
