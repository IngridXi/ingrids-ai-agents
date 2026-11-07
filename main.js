/**
 * Ingrid's AI Agents — Electron 桌面版 · 主进程
 *
 * 架构参考 milind-soni/OpenMausBot（Apache 2.0）的桌面端，只提炼三样精华：
 *   1. contextIsolation 开启、nodeIntegration 关闭 → 渲染进程只接触 window.ingrid
 *   2. local-first：agents 与 settings 落盘到 app.getPath('userData')/data
 *   3. bring-your-own-agent：复用本机已登录的 CLI（claude / codex / grok）
 *   4. API key 用 Electron safeStorage（系统钥匙串）加密后落盘
 */
'use strict';

const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/* ---------------- 数据目录（local-first） ---------------- */
function dataDir() {
  const dir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  fs.writeFileSync(path.join(dataDir(), name), JSON.stringify(data, null, 2), 'utf8');
}

/* ---------------- 窗口 ---------------- */
function createMainWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Ingrid's AI Agents",
    backgroundColor: '#f6f8f7',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadFile('index.html');
  win.once('ready-to-show', () => win.show());

  // 外链一律交给系统浏览器，不允许在工作台内打开任意站点
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function openAgentWindow(href) {
  // href 只能是相对路径，禁止越界
  if (typeof href !== 'string' || !href || href.includes('..')) return;
  const win = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    title: "Ingrid's AI Agents",
    backgroundColor: '#f6f8f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, href));
}

/* ---------------- 本机 CLI（bring-your-own-agent） ---------------- */
// engineId → 本机可执行命令
const CLI_CMDS = { 'claude-code': 'claude', codex: 'codex', grok: 'grok' };

function which(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, cmd);
    try { fs.accessSync(full, fs.constants.X_OK); return full; } catch { /* 继续 */ }
  }
  return null;
}

function launchCli(cmd) {
  if (process.platform === 'darwin') {
    // macOS：打开终端运行 CLI（复用本机已登录会话）
    const script = `tell app "Terminal" to do script ${JSON.stringify(cmd)}`;
    spawn('/usr/bin/osascript', ['-e', script], { stdio: 'ignore' });
    return true;
  }
  if (process.platform === 'linux') {
    spawn('x-terminal-emulator', ['-e', cmd], { stdio: 'ignore', detached: true }).unref();
    return true;
  }
  return false;
}

/* ---------------- IPC：agents ---------------- */
ipcMain.handle('agents:list', () => readJson('agents.json', []));

ipcMain.handle('agents:save', (_e, agents) => {
  if (!Array.isArray(agents)) throw new Error('agents 必须是数组');
  writeJson('agents.json', agents);
  return true;
});

ipcMain.on('agents:list-sync', (e) => {
  e.returnValue = readJson('agents.json', []);
});

/* ---------------- IPC：打开 agent ---------------- */
ipcMain.handle('open-agent', (_e, href) => {
  openAgentWindow(href);
  return true;
});

/* ---------------- IPC：CLI 检测 / 启动 ---------------- */
ipcMain.handle('cli:detect', (_e, engineId) => {
  const cmd = CLI_CMDS[engineId];
  return cmd ? Boolean(which(cmd)) : false;
});

ipcMain.handle('cli:run', (_e, engineId) => {
  const cmd = CLI_CMDS[engineId];
  return cmd ? launchCli(cmd) : false;
});

/* ---------------- IPC：设置（API key 加密存储） ---------------- */
ipcMain.handle('settings:get', () => {
  const raw = readJson('settings.json', {});
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === 'string' && v.startsWith('enc:')) {
      try { out[k] = safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); }
      catch { out[k] = ''; }
    } else {
      out[k] = typeof v === 'string' ? v : '';
    }
  }
  return out;
});

ipcMain.handle('settings:save', (_e, settings) => {
  const enc = {};
  for (const [k, v] of Object.entries(settings || {})) {
    if (!v) continue;
    const str = String(v);
    enc[k] = safeStorage.isEncryptionAvailable()
      ? 'enc:' + safeStorage.encryptString(str).toString('base64')
      : str;
  }
  writeJson('settings.json', enc);
  return true;
});

/* ---------------- 生命周期 ---------------- */
app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
