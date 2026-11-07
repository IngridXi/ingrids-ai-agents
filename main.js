/**
 * Ingrid's AI Agents — Electron 桌面版 · 主进程
 *
 * 架构参考 milind-soni/OpenMausBot（Apache 2.0）的桌面端，提炼四样精华：
 *   1. contextIsolation 开启、nodeIntegration 关闭 → 渲染进程只接触 window.ingrid
 *   2. local-first：agents / settings / usage 全部落盘到 userData/data
 *   3. bring-your-own-agent：复用本机已登录的 CLI（claude / codex / grok）
 *   4. API key 用 Electron safeStorage（系统钥匙串）加密后落盘
 *
 * v2：用量账本（按月 jsonl）、月度预算、agent:run 真实执行器（默认演练）。
 */
'use strict';

const { app, BrowserWindow, ipcMain, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/* ---------------- 数据目录（local-first） ---------------- */
app.setName("Ingrid's AI Agents");

function dataDir() {
  const dir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function usageDir() {
  const dir = path.join(dataDir(), 'usage');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), name), 'utf8')); }
  catch { return fallback; }
}
function writeJson(name, data) {
  fs.writeFileSync(path.join(dataDir(), name), JSON.stringify(data, null, 2), 'utf8');
}

/* ---------------- 窗口 ---------------- */
const WEB_PREFS = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
};

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600,
    title: "Ingrid's AI Agents", backgroundColor: '#f6f8f7', show: false,
    webPreferences: Object.assign({ preload: path.join(__dirname, 'preload.js') }, WEB_PREFS),
  });
  win.loadFile('index.html');
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function openAgentWindow(href) {
  if (typeof href !== 'string' || !href || href.includes('..')) return;
  const win = new BrowserWindow({
    width: 1200, height: 820, minWidth: 720, minHeight: 520,
    title: "Ingrid's AI Agents", backgroundColor: '#f6f8f7',
    webPreferences: Object.assign({ preload: path.join(__dirname, 'preload.js') }, WEB_PREFS),
  });
  win.loadFile(path.join(__dirname, href));
}

/* ---------------- 本机 CLI（bring-your-own-agent） ---------------- */
const CLI_CMDS = { 'claude-code': 'claude', codex: 'codex', grok: 'grok' };

// 每种 CLI 的非交互调用方式。只用数组参数 spawn，绝不拼 shell 字符串。
const CLI_ADAPTERS = {
  'claude-code': { cmd: 'claude', args: (p) => ['-p', p], timeout: 90000 },
  codex:         { cmd: 'codex', args: (p) => ['exec', p], timeout: 90000 },
  grok:          { cmd: 'grok',  args: (p) => ['-p', p], timeout: 90000 },
};

// OpenAI 兼容端点（用户填 Key 后可真实调用）
const API_ENDPOINTS = {
  deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
  gpt:      { url: 'https://api.openai.com/v1/chat/completions',    model: 'gpt-4o-mini' },
  qwen:     { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
};

function which(cmd) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = path.join(dir, cmd);
    try { fs.accessSync(full, fs.constants.X_OK); return full; }
    catch { /* 继续找 */ }
  }
  return null;
}

function launchCli(cmd) {
  if (process.platform === 'darwin') {
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

/* ---------------- 设置（API Key 加密） ---------------- */
function readSettingsRaw() { return readJson('settings.json', {}); }

function decryptSettings(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (typeof v === 'string' && v.startsWith('enc:')) {
      try { out[k] = safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); }
      catch { out[k] = ''; }
    } else if (k === 'allowRealRuns') {
      out[k] = v === true || v === 'true';
    } else {
      out[k] = typeof v === 'string' ? v : '';
    }
  }
  return out;
}

function writeSettings(patch) {
  // 合并式保存：只覆盖传入的键，不丢掉已有的 Key / 开关
  const merged = Object.assign(decryptSettings(readSettingsRaw()), patch || {});
  const enc = {};
  for (const [k, v] of Object.entries(merged)) {
    if (k === 'allowRealRuns') { enc[k] = !!v; continue; }
    if (!v) continue;
    enc[k] = safeStorage.isEncryptionAvailable()
      ? 'enc:' + safeStorage.encryptString(String(v)).toString('base64')
      : String(v);
  }
  writeJson('settings.json', enc);
  return true;
}

/* ---------------- 用量账本：按月 jsonl ---------------- */
function usageFileFor(rec) {
  const month = (rec && rec.month) || new Date().toISOString().slice(0, 7);
  return path.join(usageDir(), month + '.jsonl');
}
function appendUsage(rec) {
  if (!rec || typeof rec !== 'object') throw new Error('usage 记录格式错误');
  fs.appendFileSync(usageFileFor(rec), JSON.stringify(rec) + '\n', 'utf8');
  return true;
}
function listUsage() {
  let files = [];
  try { files = fs.readdirSync(usageDir()).filter((f) => f.endsWith('.jsonl')); }
  catch { return []; }
  const rows = [];
  for (const f of files) {
    try {
      const lines = fs.readFileSync(path.join(usageDir(), f), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { /* 跳过坏行 */ }
      }
    } catch { /* 跳过坏文件 */ }
  }
  return rows;
}
function clearUsage() {
  try {
    for (const f of fs.readdirSync(usageDir())) {
      if (f.endsWith('.jsonl')) fs.unlinkSync(path.join(usageDir(), f));
    }
  } catch { /* 目录不存在即视为已清空 */ }
  return true;
}
function getBudget() { return Number(readJson('budget.json', { usd: 0 }).usd) || 0; }
function setBudget(usd) {
  const n = Math.max(0, Number(usd) || 0);
  writeJson('budget.json', { usd: n });
  return n;
}

/* ---------------- 价格表（与 agents-core.js ENGINES 对齐） ---------------- */
const PRICES = {
  'claude-code': { in: 3, out: 15 }, codex: { in: 2, out: 10 }, grok: { in: 2, out: 6 },
  deepseek: { in: 0.28, out: 0.42 }, gpt: { in: 2, out: 10 }, qwen: { in: 0.4, out: 1.2 },
  'local-llm': { in: 0, out: 0 }, funasr: { in: 0, out: 0 },
};
function costOf(engine, tin, tout) {
  const p = PRICES[engine] || { in: 0, out: 0 };
  return ((tin * p.in) + (tout * p.out)) / 1e6;
}
function approxTokens(s) { return Math.ceil(String(s || '').length / 4); }

function dryRunResult(engine, prompt, reason) {
  const tin = approxTokens(prompt), tout = 120;
  return {
    text: '[演练] 已收到任务，但未调用真实模型。\n原因：' + reason,
    engine, tokensIn: tin, tokensOut: tout, cost: costOf(engine, tin, tout),
    costSource: 'simulated', status: 'ok', dryRun: true, error: '', reason,
  };
}

/* ---------------- 真实执行：本机 CLI ---------------- */
function runCliAgent(engine, prompt, soul) {
  const ad = CLI_ADAPTERS[engine];
  const bin = which(ad.cmd);
  if (!bin) return Promise.resolve(dryRunResult(engine, prompt, '本机未安装 ' + ad.cmd + ' CLI'));
  const fullPrompt = (soul ? String(soul).trim() + '\n\n' : '') + prompt;
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const child = spawn(bin, ad.args(fullPrompt), {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: ad.timeout,
    });
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => finish(Object.assign(dryRunResult(engine, prompt, 'CLI 启动失败：' + e.message), { status: 'error', error: e.message })));
    child.on('close', (code) => {
      const text = out.trim().slice(0, 20000);
      const tin = approxTokens(fullPrompt), tout = approxTokens(text);
      if (code !== 0 && !text) {
        const msg = (err || 'CLI 退出码 ' + code).slice(0, 400);
        return finish({
          text: '', engine, tokensIn: tin, tokensOut: 0, cost: costOf(engine, tin, 0),
          costSource: 'estimated', status: 'error', dryRun: false, error: msg,
          limited: /rate.?limit|quota|usage limit|429|402/i.test(msg),
        });
      }
      finish({ text, engine, tokensIn: tin, tokensOut: tout, cost: costOf(engine, tin, tout),
        costSource: 'estimated', status: 'ok', dryRun: false, error: '' });
    });
  });
}

/* ---------------- 真实执行：OpenAI 兼容 API ---------------- */
async function runApiAgent(engine, prompt, soul, key) {
  const cfg = API_ENDPOINTS[engine];
  if (!key) return dryRunResult(engine, prompt, '尚未在「引擎设置」里配置 ' + engine + ' 的 API Key');
  const messages = [];
  if (soul) messages.push({ role: 'system', content: String(soul) });
  messages.push({ role: 'user', content: String(prompt) });
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const resp = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: cfg.model, messages, max_tokens: 1200 }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const data = await resp.json();
    if (!resp.ok) {
      const msg = String((data && data.error && data.error.message) || resp.statusText || resp.status);
      return { text: '', engine, tokensIn: approxTokens(prompt), tokensOut: 0, cost: 0,
        costSource: 'metered', status: 'error', dryRun: false, error: msg,
        limited: /rate.?limit|quota|insufficient|429|402/i.test(msg) };
    }
    const text = String((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '');
    const u = data.usage || {};
    const tin = Number(u.prompt_tokens) || approxTokens(prompt);
    const tout = Number(u.completion_tokens) || approxTokens(text);
    return { text: text.slice(0, 20000), engine, model: cfg.model, tokensIn: tin, tokensOut: tout,
      cost: costOf(engine, tin, tout), costSource: 'estimated', status: 'ok', dryRun: false, error: '' };
  } catch (e) {
    return { text: '', engine, tokensIn: approxTokens(prompt), tokensOut: 0, cost: 0,
      costSource: 'metered', status: 'error', dryRun: false,
      error: '请求失败：' + String(e && e.message || e) };
  }
}

/* ---------------- IPC：agents ---------------- */
ipcMain.handle('agents:list', () => readJson('agents.json', []));
ipcMain.handle('agents:save', (_e, agents) => {
  if (!Array.isArray(agents)) throw new Error('agents 必须是数组');
  writeJson('agents.json', agents); return true;
});
ipcMain.on('agents:list-sync', (e) => { e.returnValue = readJson('agents.json', []); });

/* ---------------- IPC：打开 agent ---------------- */
ipcMain.handle('open-agent', (_e, href) => { openAgentWindow(href); return true; });

/* ---------------- IPC：CLI 检测 / 启动 ---------------- */
ipcMain.handle('cli:detect', (_e, engineId) => {
  const cmd = CLI_CMDS[engineId];
  return cmd ? Boolean(which(cmd)) : false;
});
ipcMain.handle('cli:run', (_e, engineId) => {
  const cmd = CLI_CMDS[engineId];
  return cmd ? launchCli(cmd) : false;
});

/* ---------------- IPC：设置 ---------------- */
ipcMain.handle('settings:get', () => decryptSettings(readSettingsRaw()));
ipcMain.handle('settings:save', (_e, patch) => writeSettings(patch));
ipcMain.handle('settings:run-mode', () => !!decryptSettings(readSettingsRaw()).allowRealRuns);
ipcMain.handle('settings:set-run-mode', (_e, enabled) => writeSettings({ allowRealRuns: !!enabled }));

/* ---------------- IPC：用量账本 / 预算 ---------------- */
ipcMain.on('usage:list-sync', (e) => { e.returnValue = listUsage(); });
ipcMain.handle('usage:record', (_e, rec) => appendUsage(rec));
ipcMain.handle('usage:clear', () => clearUsage());
ipcMain.on('budget:get-sync', (e) => { e.returnValue = getBudget(); });
ipcMain.on('budget:set-sync', (e, usd) => { e.returnValue = setBudget(usd); });

/* ---------------- IPC：执行一个 Agent ---------------- */
ipcMain.handle('agent:run', async (_e, payload) => {
  const p = payload || {};
  const prompt = String(p.prompt || '').slice(0, 20000);
  const engine = String(p.engine || 'local-llm');
  if (!prompt.trim()) return dryRunResult(engine, prompt, '任务内容为空');
  if (!PRICES[engine]) return dryRunResult(engine, prompt, '未知引擎：' + engine);

  const settings = decryptSettings(readSettingsRaw());
  if (p.dryRun === true) return dryRunResult(engine, prompt, '本次为演练模式');
  if (!settings.allowRealRuns) {
    return dryRunResult(engine, prompt, '真实执行未开启（引擎设置里可打开；需先装 CLI 或填 API Key）');
  }

  if (CLI_ADAPTERS[engine]) return runCliAgent(engine, prompt, p.soul);
  if (API_ENDPOINTS[engine]) return runApiAgent(engine, prompt, p.soul, settings[engine]);
  return dryRunResult(engine, prompt, '本地引擎需自行接入推理服务（如 ollama / FunASR）');
});

/* ---------------- 生命周期 ---------------- */
app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
