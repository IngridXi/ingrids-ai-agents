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
 * v3：技能板块（Board）— 内置 skill 随仓库走，本机 WorkBuddy skill 仅作可选导入源；
 *     索引常驻、正文按需读取并注入 soul，注入量计入用量账本。
 */
'use strict';

const { app, BrowserWindow, ipcMain, safeStorage, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const os = require('os');
require('./skills-core.js');
const SkillsCore = globalThis.SkillsCore;

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

/* ---------------- 技能板块（Board）与 Skill 索引 ----------------
 * 只读扫描三类来源：
 *   builtin : 仓库自带 skills/ 下的 .md 文件（随 git 走，默认启用）
 *   local   : ~/.workbuddy/skills、~/.workbuddy/plugins/cache（默认全部不启用）
 *   project : 本项目 .workbuddy/skills
 * 只有被 boards.json 引用（或用户手动启用）的 skill 才进工作台。
 * 渲染进程永远拿不到绝对路径：skills:read 只接受 id，由主进程从内存 Map 查路径。
 */
let SKILL_PATHS = new Map();

function skillRoots() {
  const home = app.getPath('home');
  return [
    { dir: path.join(__dirname, 'skills'), scope: 'builtin', prefix: 'builtin' },
    { dir: path.join(home, '.workbuddy', 'skills'), scope: 'local', prefix: 'local' },
    { dir: path.join(home, '.workbuddy', 'plugins', 'cache'), scope: 'local', prefix: 'plugin' },
    { dir: path.join(__dirname, '.workbuddy', 'skills'), scope: 'local', prefix: 'project' },
  ];
}
function isAllowedSkillPath(file) {
  if (!file || !path.isAbsolute(file) || !/\.md$/i.test(file)) return false;
  return skillRoots().some((r) => {
    const base = path.resolve(r.dir) + path.sep;
    return path.resolve(file).startsWith(base);
  });
}
function hasExecutableSibling(file) {
  const d = path.dirname(file);
  return fs.existsSync(path.join(d, 'scripts')) || fs.existsSync(path.join(d, 'references'));
}
function makeSkillRecord(file, root, rec) {
  const rel = path.relative(root.dir, file).split(path.sep).join('/');
  const id = rec.prefix + ':' + rel.replace(/\.md$/i, '');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return null; }
  // 只解析头部 frontmatter；正文不进索引（渐进式披露）
  const meta = SkillsCore.parseFrontmatter(text.slice(0, 16384)).meta;
  const bytes = Buffer.byteLength(text);
  // 中文按字节估会高估约 3 倍，用字符数估，并与 buildContext 的单份上限对齐
  const estTokens = Math.ceil(Math.min(text.length, 12000) / 4);
  const name = meta.name || meta.display_name || path.basename(file, '.md');
  const desc = meta.description || meta.description_zh || '';
  const validCats = SkillsCore.CATEGORY_RULES.map((c) => c.id);
  const cat = validCats.indexOf(meta.category) >= 0
    ? meta.category : SkillsCore.classify(name + ' ' + desc + ' ' + rel).category;
  SKILL_PATHS.set(id, path.resolve(file));
  return {
    id, name, description: desc, category: cat,
    scope: rec.scope, source: String(meta.source || ''), rel,
    bytes, estTokens: estTokens,
    executable: !!meta['allowed-tools'] || hasExecutableSibling(file),
    allowedTools: String(meta['allowed-tools'] || ''), model: String(meta.model || ''),
    boardIds: String(meta.boards || '').split(/[,，\s]+/).filter(Boolean),
    enabled: false,
  };
}
function collectSkills(root, out) {
  if (!root.dir || !fs.existsSync(root.dir)) return;
  const MAX_DEPTH = 9, MAX_FILES = 500;
  function walk(dir, depth) {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (['.git', 'node_modules', '.venv', '__pycache__'].indexOf(ent.name) >= 0) continue;
        walk(full, depth + 1);
      } else if (ent.isFile() && (
        (root.scope === 'builtin' && /\.md$/i.test(ent.name)) ||
        (root.scope === 'local' && /^SKILL\.md$/i.test(ent.name))
      )) {
        const rec = makeSkillRecord(full, root, root);
        if (rec) out.push(rec);
      }
    }
  }
  walk(root.dir, 0);
}
function defaultBoards() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'skills', 'boards.json'), 'utf8')).boards || []; }
  catch { return []; }
}
function readBoards() {
  const saved = readJson('boards.json', null);
  return Array.isArray(saved) && saved.length ? saved : defaultBoards();
}
function writeBoards(boards) {
  if (!Array.isArray(boards)) throw new Error('boards 必须是数组');
  const clean = boards.map((b) => ({
    id: String(b.id || ''), name: String(b.name || ''), emoji: String(b.emoji || '📁'),
    desc: String(b.desc || ''), skillIds: Array.isArray(b.skillIds) ? b.skillIds : [],
    defaultEngine: String(b.defaultEngine || ''), color: String(b.color || '#7c6fd6'),
  })).filter((b) => b.id && b.name);
  writeJson('boards.json', clean);
  return clean;
}
function scanSkills() {
  SKILL_PATHS = new Map();
  const records = [];
  skillRoots().forEach((r) => collectSkills(r, records));
  const boards = readBoards();
  // 把模板里新增的板块（用户数据里还没有的 id）合并进来，老用户也能拿到新板块
  const savedIds = boards.map((b) => b.id);
  defaultBoards().forEach((b) => {
    if (savedIds.indexOf(b.id) < 0) boards.push(b);
  });
  const enabled = {};
  boards.forEach((b) => (b.skillIds || []).forEach((id) => { enabled[id] = true; }));
  records.forEach((r) => {
    // builtin（仓库自带 skills/ 下）默认启用；local/plugin 仅作「可选导入源」，默认不启用，需手动挑进板块
    r.enabled = r.scope === 'builtin' ? true : !!enabled[r.id];
    // 内置 skill 的 frontmatter 里写了 boards 也自动归入该板块
    boards.forEach((b) => {
      if (r.boardIds.indexOf(b.id) >= 0 && (b.skillIds || []).indexOf(r.id) < 0) b.skillIds.push(r.id);
    });
  });
  const stats = {
    total: records.length, enabled: records.filter((r) => r.enabled).length,
    builtin: records.filter((r) => r.scope === 'builtin').length,
    local: records.filter((r) => r.scope === 'local').length,
    executable: records.filter((r) => r.executable).length,
    bytes: records.reduce((n, r) => n + r.bytes, 0),
  };
  return { boards, records, stats, scannedAt: Date.now() };
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
    title: "Ingrid's AI Agents", backgroundColor: '#f7f6f9', show: false,
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
    title: "Ingrid's AI Agents", backgroundColor: '#f7f6f9',
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

function dryRunResult(engine, prompt, reason, soul) {
  // v3：演练也要把注入的技能正文算进输入 token，否则账单会少算一截
  const tin = approxTokens((soul ? soul + '\n\n' : '') + prompt), tout = 120;
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
  if (!bin) return Promise.resolve(dryRunResult(engine, prompt, '本机未安装 ' + ad.cmd + ' CLI', soul));
  const fullPrompt = (soul ? String(soul).trim() + '\n\n' : '') + prompt;
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const child = spawn(bin, ad.args(fullPrompt), {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: ad.timeout,
    });
    const finish = (result) => { if (!done) { done = true; resolve(result); } };
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => finish(Object.assign(dryRunResult(engine, prompt, 'CLI 启动失败：' + e.message, soul), { status: 'error', error: e.message })));
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
  if (!key) return dryRunResult(engine, prompt, '尚未在「引擎设置」里配置 ' + engine + ' 的 API Key', soul);
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
      return { text: '', engine, tokensIn: approxTokens((soul ? soul + '\n\n' : '') + prompt), tokensOut: 0, cost: 0,
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
// 只读 codex 登录态（不返回 token，仅判断是否已登录 ChatGPT 会员账号）
ipcMain.handle('cli:auth', (_e, engineId) => {
  if (engineId !== 'codex') return { loggedIn: false, mode: '', accountId: '' };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.codex', 'auth.json'), 'utf8'));
    const loggedIn = !!(j.tokens && j.tokens.access_token);
    const mode = j.auth_mode === 'chatgpt' ? 'ChatGPT 账号（会员额度）' : String(j.auth_mode || '');
    const accountId = ((j.tokens && j.tokens.account_id) || '').slice(0, 8);
    return { loggedIn: loggedIn, mode: mode, accountId: accountId };
  } catch (e) {
    return { loggedIn: false, mode: '', accountId: '' };
  }
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
  const soul = String(p.soul || '');
  if (!prompt.trim()) return dryRunResult(engine, prompt, '任务内容为空', soul);
  if (!PRICES[engine]) return dryRunResult(engine, prompt, '未知引擎：' + engine, soul);

  const settings = decryptSettings(readSettingsRaw());
  if (p.dryRun === true) return dryRunResult(engine, prompt, '本次为演练模式', soul);
  if (!settings.allowRealRuns) {
    return dryRunResult(engine, prompt, '真实执行未开启（引擎设置里可打开；需先装 CLI 或填 API Key）', soul);
  }

  if (CLI_ADAPTERS[engine]) return runCliAgent(engine, prompt, soul);
  if (API_ENDPOINTS[engine]) return runApiAgent(engine, prompt, soul, settings[engine]);
  return dryRunResult(engine, prompt, '本地引擎需自行接入推理服务（如 ollama / FunASR）', soul);
});

/* ---------------- IPC：技能板块 / 索引 / 正文 / 预设 ---------------- */
ipcMain.on('skills:scan-sync', (e) => { e.returnValue = scanSkills(); });
ipcMain.handle('skills:scan', () => scanSkills());
ipcMain.handle('skills:read', (_e, id) => {
  const key = String(id || '');
  const file = SKILL_PATHS.get(key);
  if (!file) return { id: key, name: '', body: '', error: '未知技能 id（请先扫描索引）' };
  if (!isAllowedSkillPath(file)) return { id: key, name: '', body: '', error: '路径不在允许范围' };
  try {
    const size = fs.statSync(file).size;
    if (size > 262144) return { id: key, name: '', body: '', error: '技能正文超过 256KB，已跳过' };
    const parsed = SkillsCore.parseFrontmatter(fs.readFileSync(file, 'utf8'));
    return {
      id: key, name: parsed.meta.name || path.basename(file, '.md'),
      body: parsed.body.slice(0, 60000), bytes: size,
    };
  } catch (err) {
    return { id: key, name: '', body: '', error: '读取失败：' + String(err && err.message || err) };
  }
});
ipcMain.on('boards:list-sync', (e) => { e.returnValue = readBoards(); });
ipcMain.handle('boards:save', (_e, boards) => writeBoards(boards));
ipcMain.on('presets:list-sync', (e) => { e.returnValue = readJson('presets.json', []); });
ipcMain.handle('presets:save', (_e, list) => {
  if (!Array.isArray(list)) throw new Error('presets 必须是数组');
  writeJson('presets.json', list);
  return true;
});

/* ---------------- IPC：监事（核心需求 / 开关 / 纠偏） ---------------- */
ipcMain.on('supervisor:list-sync', (e) => {
  e.returnValue = readJson('supervisor.json', { goals: [], active: false, lastCorrection: '' });
});
ipcMain.handle('supervisor:save', (_e, state) => {
  if (!state || typeof state !== 'object') throw new Error('supervisor 状态格式错误');
  const clean = {
    goals: (Array.isArray(state.goals) ? state.goals : []).map((g) => ({
      id: String(g.id || ''), text: String(g.text || ''),
      weight: Math.max(1, Math.min(3, Number(g.weight) || 1)),
      active: g.active !== false, createdAt: Number(g.createdAt) || Date.now(),
    })).filter((g) => g.text),
    active: state.active !== false,
    lastCorrection: String(state.lastCorrection || ''),
  };
  writeJson('supervisor.json', clean);
  return true;
});

/* ---------------- IPC：秘书（日程 / 邮件 / 想法 + 系统通知） ---------------- */
ipcMain.on('secretary:list-sync', (e) => {
  e.returnValue = readJson('secretary.json', { events: [], emails: [], thoughts: [] });
});
ipcMain.handle('secretary:save', (_e, state) => {
  if (!state || typeof state !== 'object') throw new Error('secretary 状态格式错误');
  const clean = {
    events: Array.isArray(state.events) ? state.events : [],
    emails: Array.isArray(state.emails) ? state.emails : [],
    thoughts: Array.isArray(state.thoughts) ? state.thoughts : [],
  };
  writeJson('secretary.json', clean);
  return true;
});
ipcMain.handle('notify', (_e, payload) => {
  const p = payload || {};
  if (!Notification.isSupported()) return false;
  try {
    const n = new Notification({ title: String(p.title || 'Ingrid'), body: String(p.body || ''), silent: !!p.silent });
    n.show();
    return true;
  } catch (e) { return false; }
});

/* ---------------- 生命周期 ---------------- */
app.whenReady().then(() => {
  createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
