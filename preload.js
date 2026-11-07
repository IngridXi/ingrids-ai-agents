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

  // 设置（API key 加密存储）
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
});
