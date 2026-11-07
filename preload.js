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

  // 技能板块 / 只读索引 / 按需读正文 / 预设（v3）
  scanSkillsSync: () => ipcRenderer.sendSync('skills:scan-sync'),
  scanSkills: () => ipcRenderer.invoke('skills:scan'),
  readSkill: (id) => ipcRenderer.invoke('skills:read', id),
  loadBoardsSync: () => ipcRenderer.sendSync('boards:list-sync'),
  saveBoards: (boards) => ipcRenderer.invoke('boards:save', boards),
  loadPresetsSync: () => ipcRenderer.sendSync('presets:list-sync'),
  savePresets: (list) => ipcRenderer.invoke('presets:save', list),
});
