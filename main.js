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
const { spawn, execFile } = require('child_process');
const os = require('os');
const net = require('net');
const http = require('http');
require('./skills-core.js');
const SkillsCore = globalThis.SkillsCore;
const { KbEngine } = require('./kb-engine.js');
const syncEngine = require('./sync-engine.js');

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
  // 迁移：旧版 research 板块的青绿标识色统一为柔和高级紫（用户已弃用绿色系）
  let boardsDirty = false;
  boards.forEach((b) => {
    if (b.color === '#2a746c') { b.color = '#7c6fd6'; boardsDirty = true; }
  });
  if (boardsDirty) writeBoards(boards);
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
  if (href.includes('meeting-audio')) ensureMeetingAudioBackend();
  const win = new BrowserWindow({
    width: 1200, height: 820, minWidth: 720, minHeight: 520,
    title: "Ingrid's AI Agents", backgroundColor: '#f7f6f9',
    webPreferences: Object.assign({ preload: path.join(__dirname, 'preload.js') }, WEB_PREFS),
  });
  win.loadFile(path.join(__dirname, href));
}

/* ---------------- 会议纪要后端自动拉起 ---------------- */
const MEETING_AUDIO_PORT = 8950;

function meetingAudioBackendCmd() {
  const dir = path.join(__dirname, 'extensions', 'meeting_audio');
  return { dir, py: path.join(dir, '.venv', 'bin', 'python'), main: path.join(dir, 'server.py') };
}

// 打开会议纪要官窗口前调用：若本机 8950 服务未在跑，就独立拉起后端（模型懒加载，启动即监听）。
function ensureMeetingAudioBackend() {
  const probe = net.connect({ host: '127.0.0.1', port: MEETING_AUDIO_PORT, timeout: 400 });
  probe.once('connect', () => { probe.end(); });  // 已在运行，复用
  probe.once('error', () => {
    const { dir, py, main } = meetingAudioBackendCmd();
    if (!fs.existsSync(py) || !fs.existsSync(main)) return;  // 后端未安装，前端会提示
    const log = fs.openSync(path.join(dir, 'server.log'), 'a');
    // 注入已配的云端 API Key（总结引擎切 deepseek/gpt/qwen 时用），Key 只进子进程环境、不落盘不打印
    const env = Object.assign({}, process.env);
    let apiSettings;
    try { apiSettings = decryptSettings(readSettingsRaw()); } catch { apiSettings = {}; }
    for (const id of ['deepseek', 'gpt', 'qwen']) {
      if (apiSettings[id]) env['MEETING_AUDIO_KEY_' + id] = String(apiSettings[id]);
    }
    const child = spawn(py, [main], { cwd: dir, stdio: ['ignore', log, log], detached: true, env });
    child.unref();
  });
  probe.once('timeout', () => { probe.destroy(); });
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

// 聊天流式端点（研究助手聊天用）：OpenAI 兼容 API + 本地 Ollama（Ollama 走 /v1 兼容端点，无需 Key）
const CHAT_ENDPOINTS = {
  deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat', keyField: 'deepseek' },
  gpt:      { url: 'https://api.openai.com/v1/chat/completions',    model: 'gpt-4o-mini',    keyField: 'gpt' },
  qwen:     { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus', keyField: 'qwen' },
  ollama:   { url: 'http://127.0.0.1:11434/v1/chat/completions',    model: 'qwen3:32b',      keyField: null },
  'ollama-review': { url: 'http://127.0.0.1:11434/v1/chat/completions', model: 'deepseek-r1:32b', keyField: null },  // 审稿专用（本地深度推理模型，跨模型对抗）
  'ollama-vision': { url: 'http://127.0.0.1:11434/v1/chat/completions', model: 'qwen2.5vl:7b', keyField: null },   // 识图专用（本地视觉模型，支持图片输入）
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

/* ---------------- 同步账户（日历/邮箱）凭据加密存储 ---------------- */
function readSyncAccountsRaw() { return readJson('sync-accounts.json', { accounts: [] }); }

function encryptSecret(v) {
  if (!v) return '';
  return safeStorage.isEncryptionAvailable()
    ? 'enc:' + safeStorage.encryptString(String(v)).toString('base64')
    : String(v);
}
function decryptSecret(v) {
  if (typeof v === 'string' && v.startsWith('enc:')) {
    try { return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')); }
    catch { return ''; }
  }
  return String(v || '');
}

/** 账户列表（对渲染层脱敏：密码不返回，只给 hasPassword） */
function listSyncAccounts() {
  return (readSyncAccountsRaw().accounts || []).map(function (a) {
    return {
      id: String(a.id || ''),
      name: String(a.name || ''),
      type: String(a.type || 'caldav'),
      serverUrl: String(a.serverUrl || ''),
      username: String(a.username || ''),
      authMethod: String(a.authMethod || 'basic'),
      active: a.active !== false,
      hasPassword: !!a.password,
      oauthClientId: String(a.oauthClientId || ''),
      createdAt: Number(a.createdAt) || Date.now(),
    };
  });
}

function saveSyncAccount(acct) {
  if (!acct || !acct.id || !acct.name) throw new Error('账户信息不完整');
  const raw = readSyncAccountsRaw();
  const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
  const clean = {
    id: String(acct.id),
    name: String(acct.name),
    type: String(acct.type || 'caldav'),
    serverUrl: String(acct.serverUrl || ''),
    username: String(acct.username || ''),
    authMethod: String(acct.authMethod || 'basic'),
    active: acct.active !== false,
    createdAt: Number(acct.createdAt) || Date.now(),
  };
  if (acct.password) clean.password = encryptSecret(acct.password);  // 密码只在传入时更新
  // OAuth 账户（google / microsoft）
  if (acct.oauthClientId) clean.oauthClientId = String(acct.oauthClientId);
  if (acct.oauthClientSecret) clean.oauthClientSecret = encryptSecret(acct.oauthClientSecret);
  if (acct.oauthRefreshToken) clean.oauthRefreshToken = encryptSecret(acct.oauthRefreshToken);
  const idx = accounts.findIndex(function (a) { return a.id === clean.id; });
  if (idx >= 0) {
    const old = accounts[idx];
    accounts[idx] = Object.assign({}, old, clean);
    if (!acct.password && old.password) accounts[idx].password = old.password;
    if (!acct.oauthClientSecret && old.oauthClientSecret) accounts[idx].oauthClientSecret = old.oauthClientSecret;
    if (!acct.oauthRefreshToken && old.oauthRefreshToken) accounts[idx].oauthRefreshToken = old.oauthRefreshToken;
  } else {
    accounts.push(clean);
  }
  writeJson('sync-accounts.json', { accounts: accounts });
  return listSyncAccounts();
}

function removeSyncAccount(id) {
  const raw = readSyncAccountsRaw();
  const accounts = Array.isArray(raw.accounts) ? raw.accounts.filter(function (a) { return a.id !== String(id); }) : [];
  writeJson('sync-accounts.json', { accounts: accounts });
  return listSyncAccounts();
}

/** 解密出可用于同步的账户（含明文密码/令牌，仅主进程内部使用） */
function decryptSyncAccounts() {
  return (readSyncAccountsRaw().accounts || []).filter(function (a) { return a.active !== false; }).map(function (a) {
    return {
      id: String(a.id),
      name: String(a.name || ''),
      type: String(a.type || 'caldav'),
      serverUrl: String(a.serverUrl || ''),
      username: String(a.username || ''),
      password: decryptSecret(a.password),
      authMethod: String(a.authMethod || 'basic'),
      oauthClientId: String(a.oauthClientId || ''),
      oauthClientSecret: decryptSecret(a.oauthClientSecret),
      oauthRefreshToken: decryptSecret(a.oauthRefreshToken),
    };
  });
}

/** 向所有窗口广播事件（日历面板 / 秘书面板接收） */
function broadcast(channel, data) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { if (!w.isDestroyed()) w.webContents.send(channel, data); } catch { /* 忽略 */ }
  }
}

/** 触发日历同步：拉取所有账户（CalDAV / Google / Microsoft）事件，合并进秘书日程 */
async function runCalendarSync() {
  const accounts = decryptSyncAccounts().filter(function (a) {
    return a.type === 'caldav' || a.type === 'google' || a.type === 'microsoft';
  });
  const results = [];
  let allEvents = [];
  for (const acct of accounts) {
    let r;
    try {
      if (acct.type === 'google' || acct.type === 'microsoft') {
        // OAuth：先刷新 access_token，再拉取
        if (!acct.oauthRefreshToken || !acct.oauthClientId) {
          r = { ok: false, events: [], error: '该账户尚未完成 OAuth 授权（缺 refresh_token 或 client_id）' };
        } else {
          let tok = null;
          try { tok = await syncEngine.refreshOAuthToken(acct.type, acct.oauthClientId, acct.oauthClientSecret, acct.oauthRefreshToken); } catch (e) { /* 继续，报错在下面 */ }
          if (!tok || !tok.access_token) { r = { ok: false, events: [], error: '刷新访问令牌失败（可能授权已过期，请重新授权）' }; }
          else if (acct.type === 'google') r = await syncEngine.syncGoogleCalendar(tok.access_token, { lookbackDays: 14, lookaheadDays: 180 });
          else r = await syncEngine.syncMicrosoftCalendar(tok.access_token, { lookbackDays: 14, lookaheadDays: 180 });
        }
      } else {
        r = await syncEngine.syncCalendarAccount(acct, { lookbackDays: 14, lookaheadDays: 180 });
      }
    } catch (e) {
      r = { ok: false, events: [], error: String(e && e.message || e) };
    }
    results.push({ id: acct.id, name: acct.name, type: acct.type, ok: r.ok, count: (r.events || []).length, error: r.error || '' });
    if (r.ok && r.events) allEvents = allEvents.concat(r.events);
  }
  // 合并进 secretary.json：移除旧的同步事件（id 以 cal- 开头），写入新事件，保留手动事件
  const state = readJson('secretary.json', { events: [], emails: [], thoughts: [] });
  const manual = (Array.isArray(state.events) ? state.events : []).filter(function (e) { return !String(e.id).startsWith('cal-'); });
  const synced = allEvents.map(function (e) {
    return {
      id: e.id, title: e.title, at: e.at, end: e.end || '',
      location: e.location || '', source: e.source || '', note: e.note || '',
      reminderMin: e.allDay ? 0 : 30, reminded: false, done: false, createdAt: Date.now(),
    };
  });
  const merged = manual.concat(synced);
  merged.sort(function (a, b) { return String(a.at || '').localeCompare(String(b.at || '')); });
  writeJson('secretary.json', { events: merged, emails: state.emails || [], thoughts: state.thoughts || [] });
  const summary = { results: results, total: synced.length, syncedAt: Date.now() };
  broadcast('calendar:synced', summary);
  return summary;
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

/* ---------------- IPC：电脑操作员（computer use） ---------------- */
let computerUseProc = null;

ipcMain.handle('computer:start', (e, payload) => {
  const p = payload || {};
  const task = String(p.task || '').trim();
  const maxSteps = Math.min(Math.max(parseInt(p.maxSteps, 10) || 15, 1), 30);
  const dryRun = !!p.dryRun;
  const send = (data) => { if (!e.sender.isDestroyed()) e.sender.send('computer:event', data); };

  if (!task) { send({ type: 'error', message: '请先填写任务内容' }); return false; }
  if (computerUseProc) { send({ type: 'error', message: '已有任务在执行，请先停止' }); return false; }

  const args = [path.join(__dirname, 'computer-use.py'), '--task', task, '--max-steps', String(maxSteps)];
  if (dryRun) args.push('--dry-run');

  let proc;
  try {
    proc = spawn(pyBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    send({ type: 'error', message: '启动失败：' + String(err && err.message || err) });
    return false;
  }
  computerUseProc = proc;

  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { send(JSON.parse(line)); } catch { /* 忽略坏行 */ }
    }
  });
  proc.on('close', (code) => {
    if (computerUseProc === proc) computerUseProc = null;
    send({ type: 'closed', code: code });
  });
  proc.on('error', (err) => {
    if (computerUseProc === proc) computerUseProc = null;
    send({ type: 'error', message: String(err && err.message || err) });
  });

  return true;
});

ipcMain.handle('computer:stop', () => {
  if (computerUseProc) {
    try { computerUseProc.kill(); } catch { /* 忽略 */ }
    computerUseProc = null;
  }
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

/* ---------------- IPC：研究助手聊天（流式） ---------------- */
// 渲染进程 invoke('chat:start', {engine, messages}) 后，主进程把结果以
// 'chat:delta'（逐块正文）和 'chat:done'（结束/错误）事件推回，Key 不经过渲染层。
ipcMain.handle('chat:start', (e, payload) => {
  const p = payload || {};
  const engine = String(p.engine || 'ollama');
  const messages = Array.isArray(p.messages) ? p.messages : [];
  const cfg = CHAT_ENDPOINTS[engine];
  if (!cfg) { e.sender.send('chat:done', { ok: false, error: '未知引擎：' + engine }); return true; }
  if (messages.length === 0) { e.sender.send('chat:done', { ok: false, error: '消息为空' }); return true; }

  const settings = decryptSettings(readSettingsRaw());
  const key = cfg.keyField ? settings[cfg.keyField] : '';
  if (cfg.keyField && !key) {
    e.sender.send('chat:done', { ok: false, error: '尚未在「引擎设置」配置 ' + engine + ' 的 API Key' });
    return true;
  }

  (async () => {
    const send = (ch, data) => { if (!e.sender.isDestroyed()) e.sender.send(ch, data); };
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers.Authorization = 'Bearer ' + key;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000);
      const resp = await fetch(cfg.url, {
        method: 'POST', headers, signal: ctrl.signal,
        body: JSON.stringify({ model: cfg.model, messages: messages, stream: true, temperature: 0.7, max_tokens: 4000 }),
      });
      if (!resp.ok) {
        clearTimeout(timer);
        let msg = 'HTTP ' + resp.status;
        try { const j = await resp.json(); msg = j && j.error && j.error.message ? j.error.message : msg; } catch { /* 非 JSON */ }
        send('chat:done', { ok: false, error: msg });
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
          if (!line || line.indexOf('data:') !== 0) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const delta = j.choices && j.choices[0] && j.choices[0].delta;
            if (!delta) continue;
            // 思考型模型（如 qwen3）先流 reasoning 再流 content，两者都要透传
            const text = delta.content || '';
            const thinking = delta.reasoning || delta.reasoning_content || '';
            if (thinking) send('chat:delta', { thinking: thinking });
            if (text) send('chat:delta', { text: text });
          } catch { /* 忽略坏块 */ }
        }
      }
      clearTimeout(timer);
      send('chat:done', { ok: true });
    } catch (err) {
      send('chat:done', { ok: false, error: '请求失败：' + String(err && err.message || err) });
    }
  })();
  return true;
});

/* ---------------- IPC：研究助手「审稿闭环」（跨模型对抗式） ---------------- */
// 借鉴 ARIS（Auto-Research-In-Sleep）的 cross-model adversarial review：
// 一个引擎干活、另一个引擎当审稿人挑毛病，避免「自己给自己打分」的盲点。
// 事件：review:phase {phase,round} → review:delta {text,thinking} → review:done {ok,finalText,passed,rounds,error}
const REVIEWER_SYSTEM = '你是严谨的同行评审审稿人，专为研究内容挑毛病。只依据给定材料判断，不臆造文献与数据。逐项审查：①研究问题是否聚焦、论证有无循环或跳跃；②每条主张是否有证据支撑、能否回到材料溯源（缺来源必须标出）；③方法/数据/统计有无漏洞；④表达有无套话、空话、防御性措辞。输出：按严重程度排序的问题清单 + 一句话最关键修改指令。若确实挑不出实质问题，明确回复「通过」（不要为了挑毛病而硬挑）。';

// 通用流式调用：向 CHAT_ENDPOINTS 引擎发请求，累积完整文本，逐块回调 onChunk(text, thinking)
async function completeChatStream(engine, messages, onChunk, opts) {
  const cfg = CHAT_ENDPOINTS[engine];
  if (!cfg) throw new Error('未知引擎：' + engine);
  const settings = decryptSettings(readSettingsRaw());
  const key = cfg.keyField ? settings[cfg.keyField] : '';
  if (cfg.keyField && !key) throw new Error('尚未在「引擎设置」配置 ' + engine + ' 的 API Key');

  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  const o = opts || {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  const resp = await fetch(cfg.url, {
    method: 'POST', headers, signal: ctrl.signal,
    body: JSON.stringify({
      model: cfg.model, messages: messages, stream: true,
      temperature: o.temperature != null ? o.temperature : 0.7,
      max_tokens: o.maxTokens || 4000,
    }),
  });
  if (!resp.ok) {
    clearTimeout(timer);
    let msg = 'HTTP ' + resp.status;
    try { const j = await resp.json(); msg = j && j.error && j.error.message ? j.error.message : msg; } catch { /* 非 JSON */ }
    throw new Error(msg);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', text = '', thinking = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line || line.indexOf('data:') !== 0) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices && j.choices[0] && j.choices[0].delta;
        if (!delta) continue;
        const t = delta.content || '';
        const th = delta.reasoning || delta.reasoning_content || '';
        if (th) { thinking += th; if (onChunk) onChunk('', th); }
        if (t) { text += t; if (onChunk) onChunk(t, ''); }
      } catch { /* 忽略坏块 */ }
    }
  }
  clearTimeout(timer);
  return { text: text, thinking: thinking };
}

ipcMain.handle('chat:review-loop', (e, payload) => {
  const p = payload || {};
  const engine = String(p.engine || 'ollama');
  const messages = Array.isArray(p.messages) ? p.messages : [];
  const rounds = Math.min(Math.max(parseInt(p.rounds, 10) || 2, 1), 4);
  const send = (ch, data) => { if (!e.sender.isDestroyed()) e.sender.send(ch, data); };

  // 审稿引擎：跨模型对抗——干活是本地 ollama(qwen3:32b) 时默认用本地 deepseek-r1:32b 审稿；否则选已配 Key 的不同 API 引擎
  const settings = decryptSettings(readSettingsRaw());
  let reviewerEngine = String(p.reviewer || '');
  if (!reviewerEngine) {
    if (engine === 'ollama') reviewerEngine = 'ollama-review';
    else reviewerEngine = ['deepseek', 'qwen', 'gpt'].find((id) => id !== engine && settings[id]) || 'ollama';
  }

  const systemMsg = messages.find((m) => m.role === 'system') || { role: 'system', content: '' };
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const question = lastUser ? lastUser.content : '';

  (async () => {
    let finalText = '';
    try {
      // 初稿（干活引擎）
      send('review:phase', { phase: 'draft', round: 0, engine: engine, reviewer: reviewerEngine });
      const d = await completeChatStream(engine, messages, (t, th) => send('review:delta', { text: t, thinking: th }));
      finalText = d.text;

      // 对抗循环：审稿 → 返修
      for (let r = 1; r <= rounds; r++) {
        send('review:phase', { phase: 'review', round: r, engine: engine, reviewer: reviewerEngine });
        const reviewMsgs = [
          { role: 'system', content: REVIEWER_SYSTEM },
          { role: 'user', content: '【原始任务】\n' + question + '\n\n【待审稿的内容】\n' + finalText },
        ];
        const rv = await completeChatStream(reviewerEngine, reviewMsgs, (t, th) => send('review:delta', { text: t, thinking: th }), { temperature: 0.4 });
        const review = String(rv.text || '').trim();

        if (/^\s*通过/.test(review) || review.length < 8) {
          send('review:done', { ok: true, finalText: finalText, passed: true, rounds: r, engine: engine, reviewer: reviewerEngine });
          return;
        }

        send('review:phase', { phase: 'revise', round: r, engine: engine, reviewer: reviewerEngine });
        const reviseMsgs = [
          systemMsg,
          { role: 'user', content: '【原始任务】\n' + question },
          { role: 'assistant', content: finalText },
          { role: 'user', content: '【审稿人意见】\n' + review + '\n\n请据此返修：只修正审稿人指出的问题，保留原有优点，输出完整修订版（只输出修订后的正文，不要输出审稿意见）。' },
        ];
        const rv2 = await completeChatStream(engine, reviseMsgs, (t, th) => send('review:delta', { text: t, thinking: th }));
        finalText = rv2.text;
      }
      send('review:done', { ok: true, finalText: finalText, passed: false, rounds: rounds, engine: engine, reviewer: reviewerEngine });
    } catch (err) {
      send('review:done', { ok: false, error: String(err && err.message || err), finalText: finalText, engine: engine, reviewer: reviewerEngine });
    }
  })();
  return true;
});

/* ---------------- IPC：浏览器自动化（安全白名单） ---------------- */
// 复用本机 browser-automation-cdp skill 的 CDP 脚本，只做只读操作（打开/截图/提取文本）。
// 合规红线（明确不做）：验证码绕过、2FA/OTP 绕过、账号密码自动登录。
function browserCdpDir() {
  const home = app.getPath('home');
  const candidates = [
    path.join(home, '.workbuddy', 'skills', 'browser-automation-cdp', 'scripts'),
  ];
  for (const d of candidates) if (fs.existsSync(path.join(d, 'cdp.py'))) return d;
  return null;
}
function pyBin() { return process.platform === 'win32' ? 'python' : 'python3'; }
function execPy(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(pyBin(), args, { timeout: timeoutMs || 60000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, output: String(stderr || '') + '\n' + String(stdout || ''), error: String(err.message || err) });
      else resolve({ ok: true, output: String(stdout || '') });
    });
  });
}
ipcMain.handle('browser:automate', async (_e, payload) => {
  const p = payload || {};
  const action = String(p.action || '');
  if (['open', 'text', 'shot'].indexOf(action) < 0) {
    return { ok: false, error: '仅支持只读操作：open / text / shot' };
  }
  const dir = browserCdpDir();
  if (!dir) return { ok: false, error: '未找到浏览器自动化脚本（请先安装 browser-automation-cdp skill）' };
  const cdp = path.join(dir, 'cdp.py');
  const startChrome = path.join(dir, 'start_chrome.py');

  // 先探测 CDP 是否可达
  const st = await execPy([cdp, 'status'], 8000);
  if (!/CDP_OK/.test(st.output || '')) {
    try { spawn(pyBin(), [startChrome], { detached: true, stdio: 'ignore' }).unref(); } catch { /* 忽略 */ }
    await new Promise((res) => setTimeout(res, 3500));
  }

  let args = [cdp];
  if (action === 'open') {
    args.push('open', String(p.url || ''));
    if (p.wait) args.push('--wait', String(p.wait));
  } else if (action === 'text') {
    args.push('text');
    if (p.max) args.push('--max', String(p.max));
  } else if (action === 'shot') {
    const shotOut = String(p.output || path.join(app.getPath('temp'), 'sec-shot-' + Date.now() + '.png'));
    args.push('shot', shotOut);
    if (p.full) args.push('--full');
  }

  const r = await execPy(args, 90000);
  return r.ok ? { ok: true, output: r.output } : { ok: false, error: r.error || r.output || '浏览器自动化失败' };
});

/* ---------------- IPC：文档生成（内建，脱离 WorkBuddy 官方 skill） ---------------- */
// 用纯 Node 库 docx / pptxgenjs / exceljs 在本地直接生成 Word / PPT / Excel，不依赖任何宿主 skill。
function exportDir() {
  try { return app.getPath('downloads'); } catch { return dataDir(); }
}
function safeFilename(s) {
  return String(s || '未命名').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '未命名';
}
// 简易 Markdown → docx 段落（# 标题、- 列表、普通段落）
function mdToDocxChildren(md, title) {
  const { Paragraph, HeadingLevel } = require('docx');
  const children = [];
  if (title) children.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }));
  String(md || '').split(/\r?\n/).forEach(function (line) {
    const t = line.trim();
    if (!t) return;
    if (/^###\s+/.test(t)) children.push(new Paragraph({ text: t.replace(/^###\s+/, ''), heading: HeadingLevel.HEADING_3 }));
    else if (/^##\s+/.test(t)) children.push(new Paragraph({ text: t.replace(/^##\s+/, ''), heading: HeadingLevel.HEADING_2 }));
    else if (/^#\s+/.test(t)) children.push(new Paragraph({ text: t.replace(/^#\s+/, ''), heading: HeadingLevel.HEADING_1 }));
    else if (/^[-*•]\s+/.test(t)) children.push(new Paragraph({ text: t.replace(/^[-*•]\s+/, ''), bullet: { level: 0 } }));
    else children.push(new Paragraph({ text: t }));
  });
  return children;
}
ipcMain.handle('doc:generate', async (_e, payload) => {
  const p = payload || {};
  const type = String(p.type || 'docx');
  const title = String(p.title || '');
  const file = path.join(exportDir(), safeFilename(title) + '.' + type);
  try {
    if (type === 'docx') {
      const { Document, Packer } = require('docx');
      const doc = new Document({ sections: [{ children: mdToDocxChildren(String(p.content || ''), title) }] });
      const buf = await Packer.toBuffer(doc);
      fs.writeFileSync(file, buf);
    } else if (type === 'pptx') {
      const PptxGenJS = require('pptxgenjs');
      const pptx = new PptxGenJS();
      const slides = (Array.isArray(p.slides) && p.slides.length) ? p.slides : [{ title: title || '未命名', bullets: [] }];
      slides.forEach(function (s) {
        const sl = pptx.addSlide();
        if (s.title) sl.addText(String(s.title), { x: 0.5, y: 0.4, w: 9, h: 0.9, fontSize: 28, bold: true, color: '4A3F8C' });
        if (Array.isArray(s.bullets) && s.bullets.length) {
          sl.addText(s.bullets.map(function (b) { return { text: String(b), options: { bullet: true, breakLine: true, color: '26232E', fontSize: 16 } }; }), { x: 0.7, y: 1.5, w: 8.6, h: 3.8 });
        }
      });
      await pptx.writeFile({ fileName: file });
    } else if (type === 'xlsx') {
      const ExcelJS = require('exceljs');
      const wb = new ExcelJS.Workbook();
      const sheets = (Array.isArray(p.sheets) && p.sheets.length) ? p.sheets : [{ name: title || 'Sheet1', rows: [] }];
      sheets.forEach(function (sh) {
        const ws = wb.addWorksheet(String(sh.name || 'Sheet1'));
        (Array.isArray(sh.rows) ? sh.rows : []).forEach(function (r) { ws.addRow(Array.isArray(r) ? r : [r]); });
      });
      await wb.xlsx.writeFile(file);
    } else {
      return { ok: false, error: '不支持的文档类型：' + type + '（支持 docx / pptx / xlsx）' };
    }
    return { ok: true, path: file, name: path.basename(file) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

/* ---------------- IPC：网页抓取（Firecrawl 的免费替代） ---------------- */
ipcMain.handle('web:fetch', async (_e, payload) => {
  const url = String((payload || {}).url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '仅支持 http/https 链接' };
  try {
    const cheerio = require('cheerio');
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { ok: false, error: '抓取失败：HTTP ' + res.status };
    const html = await res.text();
    const $ = cheerio.load(html);
    $('script,style,nav,footer,header,aside,iframe,noscript').remove();
    const title = ($('title').first().text() || url).trim();
    let text = $('body').text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
    if (text.length > 20000) text = text.slice(0, 20000) + '\n…（内容过长已截断）';
    if (!text) return { ok: false, error: '未能提取到正文（可能是动态渲染页面）' };
    return { ok: true, url: url, title: title, content: text };
  } catch (err) {
    return { ok: false, error: '抓取失败：' + String((err && err.message) || err) };
  }
});

/* ---------------- IPC：联网搜索（Perplexity 的免费替代，零配置） ---------------- */
// 默认走 DuckDuckGo HTML 端点（无需 Key）。被限流时可在设置里换 Brave Search API Key（braveSearchKey）。
ipcMain.handle('web:search', async (_e, payload) => {
  const p = payload || {};
  const query = String(p.query || '').trim();
  const n = Math.min(Math.max(parseInt(p.n, 10) || 5, 1), 10);
  if (!query) return { ok: false, error: '搜索词为空' };
  try {
    const cheerio = require('cheerio');
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, error: '搜索失败：HTTP ' + res.status };
    const html = await res.text();
    const $ = cheerio.load(html);
    const results = [];
    $('.result').each(function () {
      if (results.length >= n) return;
      const a = $(this).find('.result__a').first();
      const title = a.text().trim();
      let link = a.attr('href') || '';
      const m = link.match(/uddg=([^&]+)/);
      if (m) link = decodeURIComponent(m[1]);
      const snippet = $(this).find('.result__snippet').first().text().trim();
      if (title && link) results.push({ title: title, link: link, snippet: snippet });
    });
    if (!results.length) return { ok: false, error: '未取到搜索结果（可能被搜索引擎限流，稍后再试）' };
    return { ok: true, query: query, results: results };
  } catch (err) {
    return { ok: false, error: '搜索失败：' + String((err && err.message) || err) };
  }
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

/* ---------------- IPC：邮箱 / 日历同步 ---------------- */
ipcMain.handle('sync:accounts:list', () => listSyncAccounts());
ipcMain.handle('sync:accounts:save', (_e, acct) => saveSyncAccount(acct));
ipcMain.handle('sync:accounts:remove', (_e, id) => removeSyncAccount(id));
ipcMain.handle('sync:calendar:run', () => runCalendarSync());

/** 把一条本地日程写回默认 CalDAV 账户（手机/苹果日历可查看），返回远端 UID */
ipcMain.handle('sync:calendar:push', async (_e, ev) => {
  const accounts = decryptSyncAccounts().filter((a) => a.type === 'caldav');
  if (!accounts.length) return { ok: false, error: '尚未配置日历账户（先在秘书面板「同步日历」配置 iCloud）' };
  const r = await syncEngine.pushCalendarEvent(accounts[0], ev || {});
  return r;
});

/* ---------------- OAuth 授权（Google / Microsoft 日历） ---------------- */
const OAUTH_PORT = 18888;
const OAUTH_REDIRECT = 'http://localhost:' + OAUTH_PORT;
let oauthServer = null;
const oauthPending = {};   // state -> { provider, clientId, clientSecret, name, id }

function ensureOAuthServer() {
  if (oauthServer) return;
  oauthServer = http.createServer(async (req, res) => {
    const reply = (ok, msg) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><head><meta charset="utf-8"><title>授权</title></head>' +
        '<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:grid;place-items:center;height:100vh;margin:0;color:#333;background:#f7f6f9">' +
        '<div style="text-align:center;background:#fff;padding:40px 48px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.08)">' +
        '<div style="font-size:40px">' + (ok ? '✅' : '⚠️') + '</div>' +
        '<h2 style="margin:14px 0 6px">' + (ok ? '授权成功' : '授权失败') + '</h2>' +
        '<p style="color:#777;margin:0">' + (msg || '') + '</p>' +
        '<p style="color:#aaa;font-size:13px;margin-top:14px">可以关闭本页，回到工作台查看结果。</p>' +
        '</div></body></html>');
    };
    try {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname !== '/') { res.writeHead(404); res.end(); return; }
      const code = u.searchParams.get('code');
      const state = u.searchParams.get('state');
      const pending = oauthPending[state];
      if (!code || !pending) { reply(false, '缺少 code 或会话已过期，请重新发起授权'); return; }
      delete oauthPending[state];
      const tokens = await syncEngine.exchangeOAuthCode(pending.provider, pending.clientId, pending.clientSecret, OAUTH_REDIRECT, code);
      if (!tokens || !tokens.refresh_token) throw new Error('未取得 refresh_token（请确认授权时选择了「允许」，且 OAuth 客户端类型为「Web 应用」）');
      saveSyncAccount({
        id: pending.id, name: pending.name, type: pending.provider,
        serverUrl: '', username: '', authMethod: 'oauth',
        oauthClientId: pending.clientId, oauthClientSecret: pending.clientSecret,
        oauthRefreshToken: tokens.refresh_token, active: true,
      });
      reply(true, pending.name + ' 已成功授权并保存');
      broadcast('oauth:done', { ok: true, provider: pending.provider, name: pending.name });
      runCalendarSync().catch(() => {});
    } catch (e) {
      reply(false, String(e && e.message || e));
      broadcast('oauth:done', { ok: false, error: String(e && e.message || e) });
    }
  });
  oauthServer.on('error', () => {});
  oauthServer.listen(OAUTH_PORT, '127.0.0.1');
}

ipcMain.handle('sync:oauth:start', async (_e, payload) => {
  const p = payload || {};
  const provider = String(p.provider || '');
  const clientId = String(p.clientId || '').trim();
  const clientSecret = String(p.clientSecret || '').trim();
  const name = String(p.name || '').trim();
  if (!syncEngine.OAUTH_PROVIDERS[provider]) return { ok: false, error: '未知提供方' };
  if (!clientId) return { ok: false, error: '请先填写 Client ID' };
  if (!clientSecret) return { ok: false, error: '请先填写 Client Secret' };
  const state = 'st' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  oauthPending[state] = {
    provider, clientId, clientSecret,
    name: name || (syncEngine.OAUTH_PROVIDERS[provider].label + ' 日历'),
    id: 'oauth-' + provider + '-' + Date.now(),
  };
  try {
    ensureOAuthServer();
    const url = syncEngine.buildOAuthUrl(provider, clientId, OAUTH_REDIRECT, state);
    await shell.openExternal(url);
    return { ok: true, url: url };
  } catch (e) {
    delete oauthPending[state];
    return { ok: false, error: String(e && e.message || e) };
  }
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

/* ---------------- 知识库引擎（本地 RAG） ---------------- */
const kbEngine = new KbEngine({ dataDir: path.join(dataDir(), 'kb') });

let kbWatchTimer = null;
let kbWatchers = [];

function startKbWatcher() {
  try {
    const cfg = kbEngine.ensureConfig();
    for (const w of kbWatchers) { try { w.close(); } catch { /* 忽略 */ } }
    kbWatchers = [];
    for (const src of (cfg.sources || []).filter((s) => s.enabled && s.path && s.type === 'markdown')) {
      if (!fs.existsSync(src.path)) continue;
      try {
        const w = fs.watch(src.path, { recursive: true }, () => {
          if (kbWatchTimer) clearTimeout(kbWatchTimer);
          kbWatchTimer = setTimeout(() => { kbEngine.scan().catch(() => {}); }, 3000);
        });
        kbWatchers.push(w);
      } catch { /* 递归 watch 失败则跳过，手动重建索引兜底 */ }
    }
  } catch { /* 忽略 */ }
}

ipcMain.handle('kb:scan', () => kbEngine.scan());
ipcMain.handle('kb:search', (_e, query, k) => kbEngine.search(String(query || ''), k));
ipcMain.handle('kb:status', () => kbEngine.status());
ipcMain.handle('kb:configure', (_e, patch) => {
  const cfg = kbEngine.loadConfig();
  if (patch && typeof patch === 'object') {
    if (Array.isArray(patch.sources)) cfg.sources = patch.sources;
    if (patch.embedModel) cfg.embedModel = String(patch.embedModel);
    if (typeof patch.chunkSize === 'number') cfg.chunkSize = patch.chunkSize;
    if (typeof patch.chunkOverlap === 'number') cfg.chunkOverlap = patch.chunkOverlap;
  }
  kbEngine.saveConfig(cfg);
  startKbWatcher();
  return kbEngine.status();
});

/* ---------------- 生命周期 ---------------- */
app.whenReady().then(() => {
  createMainWindow();
  // 知识库：首次运行自动检测源 + 后台增量索引 + 文件监听自动更新
  kbEngine.ensureConfig();
  kbEngine.scan().catch(() => {});
  startKbWatcher();
  // 日历自动同步：启动即同步一次 + 每 30 分钟定时同步（凭据已加密持久化，一次登录永久生效）
  runCalendarSync().catch(() => {});
  setInterval(() => { runCalendarSync().catch(() => {}); }, 30 * 60 * 1000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
