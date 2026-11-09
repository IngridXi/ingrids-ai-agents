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

const { app, BrowserWindow, ipcMain, safeStorage, shell, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const os = require('os');
const net = require('net');
const http = require('http');
require('./skills-core.js');
const SkillsCore = globalThis.SkillsCore;
const { KbEngine, detectObsidianVaults, detectZoteroDir } = require('./kb-engine.js');
const syncEngine = require('./sync-engine.js');
require('./secretary-core.js');
const SecretaryCore = globalThis.SecretaryCore;
const NotionEngine = require('./notion-engine.js');
const TermsEngine = require('./terms-engine.js');

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
  deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-flash' },
  gpt:      { url: 'https://api.openai.com/v1/chat/completions',    model: 'gpt-4o-mini' },
  qwen:     { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', model: 'qwen-plus' },
};

// 聊天流式端点（研究助手聊天用）：OpenAI 兼容 API + 本地 Ollama（Ollama 走 /v1 兼容端点，无需 Key）
const CHAT_ENDPOINTS = {
  deepseek: { url: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-flash', keyField: 'deepseek' },
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
  const all = Array.isArray(state.events) ? state.events : [];
  const oldCal = all.filter(function (e) { return String(e.id).startsWith('cal-'); });
  const oldMap = {};
  oldCal.forEach(function (e) { oldMap[e.id] = e; });
  const manual = all.filter(function (e) { return !String(e.id).startsWith('cal-'); });
  const synced = allEvents.map(function (e) {
    const old = oldMap[e.id];
    return {
      id: e.id, title: e.title, at: e.at, end: e.end || '',
      location: e.location || '', source: e.source || '', note: e.note || '',
      reminderMin: e.allDay ? 0 : 30,
      reminded: old ? !!old.reminded : false, done: old ? !!old.done : false,
      createdAt: old ? old.createdAt : Date.now(),
      category: SecretaryCore.classifyEvent(e.title, e.source),
    };
  });
  const merged = manual.concat(synced);
  merged.sort(function (a, b) { return String(a.at || '').localeCompare(String(b.at || '')); });
  writeJson('secretary.json', { events: merged, emails: state.emails || [], thoughts: state.thoughts || [] });
  const summary = { results: results, total: synced.length, syncedAt: Date.now() };
  broadcast('calendar:synced', summary);
  return summary;
}

/* ---------------- ICS 订阅：只读自动同步外部日历（Teams/Outlook 等发布的 .ics 链接） ---------------- */
function readIcsFeedsRaw() { return readJson('ics-feeds.json', { feeds: [] }); }

function listIcsFeeds() {
  return (readIcsFeedsRaw().feeds || []).map(function (f) {
    return { id: String(f.id || ''), name: String(f.name || ''), url: String(f.url || ''), createdAt: Number(f.createdAt) || Date.now() };
  });
}

function addIcsFeed(name, url) {
  const cleanUrl = String(url || '').trim();
  const cleanName = String(name || '').trim() || '外部日历';
  if (!/^https?:\/\//i.test(cleanUrl)) return { ok: false, error: '链接必须以 http:// 或 https:// 开头' };
  const raw = readIcsFeedsRaw();
  const feeds = Array.isArray(raw.feeds) ? raw.feeds : [];
  const feed = { id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: cleanName, url: cleanUrl, createdAt: Date.now() };
  feeds.push(feed);
  writeJson('ics-feeds.json', { feeds: feeds });
  return { ok: true, feed: feed };
}

function removeIcsFeed(id) {
  const raw = readIcsFeedsRaw();
  const feeds = Array.isArray(raw.feeds) ? raw.feeds.filter(function (f) { return String(f.id) !== String(id); }) : [];
  writeJson('ics-feeds.json', { feeds: feeds });
  // 顺带清掉该订阅同步进来的日程
  const state = readJson('secretary.json', { events: [], emails: [], thoughts: [] });
  const others = (Array.isArray(state.events) ? state.events : []).filter(function (e) { return !String(e.id).startsWith('ics-' + id + '-'); });
  writeJson('secretary.json', { events: others, emails: state.emails || [], thoughts: state.thoughts || [] });
  return listIcsFeeds();
}

/** 简单字符串 hash（djb2）→ 短 hex，用于构造稳定的 ICS 事件 id */
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(36);
}

/** 拉取所有 ICS 订阅并合并进秘书日程（只读；每 30 分钟自动调用） */
async function runIcsSync() {
  const feeds = listIcsFeeds();
  const results = [];
  let allEvents = [];
  for (const feed of feeds) {
    let r;
    try {
      const resp = await fetch(feed.url, { headers: { 'User-Agent': 'Ingrid-AI-Agents/1.0', 'Accept': 'text/calendar' }, redirect: 'follow' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const text = await resp.text();
      const events = syncEngine.parseICalendar(text);
      if (!events.length) throw new Error('未解析到日程（链接可能已失效或不是 ICS 格式）');
      events.forEach(function (ev) { ev._feedId = feed.id; ev._feedName = feed.name; });
      allEvents = allEvents.concat(events);
      r = { ok: true, count: events.length };
    } catch (e) {
      r = { ok: false, count: 0, error: String(e && e.message || e) };
    }
    results.push({ id: feed.id, name: feed.name, ok: r.ok, count: r.count, error: r.error || '' });
  }
  // 展开重复事件：母事件 + RRULE 实例；跳过已取消（Canceled）的实例
  const canceledKeys = new Set();
  allEvents.forEach(function (ev) {
    const st = String(ev.status || '').toUpperCase();
    const t = String(ev.title || '').trim();
    if (st === 'CANCELLED' || /^cancell?ed\b/i.test(t)) {
      canceledKeys.add((ev.uid || '') + '|' + String(ev.at || ''));
    }
  });
  const expanded = [];
  allEvents.forEach(function (ev) {
    const key = (ev.uid || '') + '|' + String(ev.at || '');
    if (!canceledKeys.has(key)) expanded.push(ev);
    if (ev.rrule) {
      const dur = ev.end ? (new Date(ev.end).getTime() - new Date(ev.at).getTime()) : 0;
      const instances = syncEngine.expandRrule(ev.at, ev.rrule, 365);
      instances.forEach(function (inst) {
        const atIso = inst.toISOString();
        if (canceledKeys.has((ev.uid || '') + '|' + atIso)) return; // 被取消的实例跳过
        const endIso = dur > 0 ? new Date(inst.getTime() + dur).toISOString() : '';
        expanded.push(Object.assign({}, ev, { at: atIso, end: endIso }));
      });
    }
  });

  // 合并：移除旧的 ics- 订阅事件，写入新事件；保留 cal-/手动/导入事件；继承 reminded/done 防重复提醒
  const state = readJson('secretary.json', { events: [], emails: [], thoughts: [] });
  const oldIcs = (Array.isArray(state.events) ? state.events : []).filter(function (e) { return String(e.id).startsWith('ics-'); });
  const oldMap = {};
  oldIcs.forEach(function (e) { oldMap[e.id] = e; });
  const others = (Array.isArray(state.events) ? state.events : []).filter(function (e) { return !String(e.id).startsWith('ics-'); });
  const synced = [];
  const seenIds = new Set();
  expanded.forEach(function (ev, i) {
    var uidKey = ev.uid ? hashStr(String(ev.uid)) : ('n' + i);
    var atKey = String(ev.at || '').replace(/[^0-9]/g, '');
    var id = 'ics-' + ev._feedId + '-' + uidKey + '-' + atKey;
    if (seenIds.has(id)) return;  // 同 uid 同时刻的去重（重复系列的「例外实例」与展开实例重叠）
    seenIds.add(id);
    var old = oldMap[id];
    synced.push({
      id: id, title: ev.title, at: ev.at, end: ev.end || '',
      location: ev.location || '', source: ev._feedName || 'ICS 订阅', note: ev.description || '',
      reminderMin: ev.allDay ? 0 : 30,
      reminded: old ? !!old.reminded : false, done: old ? !!old.done : false,
      createdAt: old ? old.createdAt : Date.now(),
      category: SecretaryCore.classifyEvent(ev.title, ev._feedName),
    });
  });
  const merged = others.concat(synced);
  merged.sort(function (a, b) { return String(a.at || '').localeCompare(String(b.at || '')); });
  writeJson('secretary.json', { events: merged, emails: state.emails || [], thoughts: state.thoughts || [] });
  const summary = { results: results, total: synced.length, syncedAt: Date.now() };
  broadcast('calendar:synced', summary);
  return summary;
}

/** 导入一次性 .ics 文件（手动兜底，无需订阅链接） */
async function importIcsFile() {
  const r = await dialog.showOpenDialog({ title: '导入 .ics 日历文件', properties: ['openFile'], filters: [{ name: 'iCalendar', extensions: ['ics'] }] });
  if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
  try {
    const text = fs.readFileSync(r.filePaths[0], 'utf8');
    const events = syncEngine.parseICalendar(text);
    if (!events.length) return { ok: false, error: '该文件里没有解析到日程' };
    const state = readJson('secretary.json', { events: [], emails: [], thoughts: [] });
    const list = Array.isArray(state.events) ? state.events.slice() : [];
    const stamp = Date.now().toString(36);
    events.forEach(function (ev, i) {
      list.push({
        id: 'icsimp-' + stamp + '-' + i, title: ev.title, at: ev.at, end: ev.end || '',
        location: ev.location || '', source: '导入 · ' + path.basename(r.filePaths[0]), note: ev.description || '',
        reminderMin: ev.allDay ? 0 : 30, reminded: false, done: false, createdAt: Date.now(),
        category: SecretaryCore.classifyEvent(ev.title),
      });
    });
    list.sort(function (a, b) { return String(a.at || '').localeCompare(String(b.at || '')); });
    writeJson('secretary.json', { events: list, emails: state.emails || [], thoughts: state.thoughts || [] });
    broadcast('calendar:synced', { total: events.length, syncedAt: Date.now() });
    return { ok: true, count: events.length };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

/* ---------------- 研究日历：分类 + 到期自动提醒 ---------------- */
function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function fmtDateTime(ts) {
  var d = new Date(ts);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function fmtLead(min) {
  if (min >= 1440) return (min / 1440) + ' 天前';
  if (min >= 60) return (min / 60) + ' 小时前';
  if (min > 0) return min + ' 分钟前';
  return '此刻';
}
function categoryOf(cat) { return (SecretaryCore && SecretaryCore.categoryOf) ? SecretaryCore.categoryOf(cat) : { id: 'other', label: '其他', emoji: '📌', color: '#8a8f98' }; }

/** 扫描秘书日程，对「到点且未提醒」的事件发系统通知并标记已提醒 */
function runReminderCheck() {
  let state;
  try { state = readJson('secretary.json', { events: [], emails: [], thoughts: [] }); }
  catch (e) { return []; }
  const events = Array.isArray(state.events) ? state.events : [];
  const now = Date.now();
  const fired = [];
  let changed = false;
  for (const ev of events) {
    if (ev.done || ev.reminded || !ev.at) continue;
    const lead = Number(ev.reminderMin) || 0;
    const at = new Date(ev.at).getTime();
    if (!isFinite(at)) continue;
    // 到点：now >= at - lead（lead=0 表示到了当天/当时才提醒）
    if (now < at - lead * 60000) continue;
    ev.reminded = true; changed = true;
    fired.push(ev);
    const c = categoryOf(ev.category);
    const title = c.emoji + ' ' + (ev.title || '研究日程提醒');
    const body = fmtDateTime(at) + ' · ' + c.label + (lead > 0 ? '（' + fmtLead(lead) + '提醒）' : '') +
      (ev.location ? ' · 📍 ' + ev.location : '');
    try { if (Notification.isSupported()) new Notification({ title: title, body: body }).show(); } catch (e) { /* 通知失败不阻断 */ }
  }
  if (changed) { try { writeJson('secretary.json', state); } catch (e) {} }
  if (fired.length) broadcast('calendar:reminder', fired);
  return fired;
}

/** 即将到来的研究日程（供研究助手注入上下文） */
function upcomingDeadlines(days) {
  let state;
  try { state = readJson('secretary.json', { events: [], emails: [], thoughts: [] }); }
  catch (e) { return []; }
  const horizon = Date.now() + (Number(days) || 7) * 86400000;
  return (Array.isArray(state.events) ? state.events : [])
    .filter(function (e) { return !e.done && e.at; })
    .map(function (e) {
      var c = categoryOf(e.category);
      return { id: e.id, title: e.title, at: e.at, category: c.id, categoryLabel: c.label, emoji: c.emoji, location: e.location, done: !!e.done };
    })
    .filter(function (e) { var t = new Date(e.at).getTime(); return isFinite(t) && t <= horizon; })
    .sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
}

/* ---------------- 邮箱同步：Outlook（Microsoft Graph） ---------------- */
async function runMailSync() {
  const accounts = decryptSyncAccounts().filter(function (a) { return a.type === 'microsoft'; });
  if (!accounts.length) return { ok: true, skipped: true, total: 0, results: [] };
  const results = [];
  let allEmails = [];
  for (const acct of accounts) {
    let r;
    try {
      if (!acct.oauthRefreshToken || !acct.oauthClientId) {
        r = { ok: false, emails: [], error: '该账户尚未完成 OAuth 授权' };
      } else {
        let tok = null;
        try { tok = await syncEngine.refreshOAuthToken('microsoft', acct.oauthClientId, acct.oauthClientSecret, acct.oauthRefreshToken); } catch (e) { /* 报错在下面 */ }
        if (!tok || !tok.access_token) r = { ok: false, emails: [], error: '刷新访问令牌失败（可能授权过期，请重新授权）' };
        else r = await syncEngine.syncMicrosoftMail(tok.access_token, { top: 50 });
      }
    } catch (e) {
      r = { ok: false, emails: [], error: String(e && e.message || e) };
    }
    results.push({ id: acct.id, name: acct.name, ok: r.ok, count: (r.emails || []).length, error: r.error || '' });
    if (r.ok && r.emails) allEmails = allEmails.concat(r.emails);
  }
  // 合并进 secretary.json：移除旧的同步邮件（id 以 msmail- 开头），写入新邮件（自动分类），保留手动导入
  const state = readJson('secretary.json', { events: [], emails: [], thoughts: [] });
  const manual = (Array.isArray(state.emails) ? state.emails : []).filter(function (m) { return !String(m.id).startsWith('msmail-'); });
  const classified = allEmails.map(function (m) {
    const c = (SecretaryCore && SecretaryCore.classifyEmail) ? SecretaryCore.classifyEmail(m) : { category: 'general', importance: 1, important: false };
    return Object.assign({}, m, { category: c.category, importance: c.importance, important: c.important });
  });
  const merged = manual.concat(classified);
  merged.sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });
  writeJson('secretary.json', { events: state.events || [], emails: merged, thoughts: state.thoughts || [] });
  const summary = { results: results, total: classified.length, syncedAt: Date.now() };
  broadcast('mail:synced', summary);
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

/* ---------------- 聊天记忆持久化（local-first，按 Agent 隔离） ---------------- */
// 每个 Agent 一个 json 文件，落在 userData/data/chat-history/<名字>.json，关窗不丢、下次自动恢复。
function chatHistoryFile(name) {
  const dir = path.join(dataDir(), 'chat-history');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(name || 'default').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_').slice(0, 80);
  return path.join(dir, safe + '.json');
}
ipcMain.handle('chat:history:load', (_e, name) => {
  try { return JSON.parse(fs.readFileSync(chatHistoryFile(name), 'utf8')); }
  catch { return []; }
});
ipcMain.handle('chat:history:save', (_e, name, data) => {
  try {
    // 支持多会话结构 { v, sessions, activeId }，也兼容旧的扁平数组
    fs.writeFileSync(chatHistoryFile(name), JSON.stringify(data == null ? [] : data, null, 2), 'utf8');
    return true;
  } catch { return false; }
});
ipcMain.handle('chat:history:clear', (_e, name) => {
  try { fs.unlinkSync(chatHistoryFile(name)); } catch { /* 不存在则忽略 */ }
  return true;
});
// 一键备份：把 chat-history 目录下所有 agent 会话导出为一个 JSON 文件
ipcMain.handle('chat:backup', () => {
  try {
    const dir = path.join(dataDir(), 'chat-history');
    if (!fs.existsSync(dir)) return { ok: false, error: '还没有聊天记录' };
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (!files.length) return { ok: false, error: '还没有聊天记录' };
    const payload = { exportedAt: new Date().toISOString(), files: {} };
    files.forEach(function (f) {
      try { payload.files[f] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch { payload.files[f] = null; }
    });
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const out = path.join(exportDir(), 'Ingrid-AI-Agents-聊天备份-' + stamp + '.json');
    fs.writeFileSync(out, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, path: out, name: path.basename(out), count: files.length };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

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
  const model = String(p.model || cfg.model);   // 前端可指定模型（如 deepseek-flash / deepseek-v4-pro）

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
        body: JSON.stringify({ model: model, messages: messages, stream: true, temperature: 0.7, max_tokens: 4000 }),
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
  const model = String(o.model || cfg.model);   // 允许调用方覆盖模型
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 180000);
  const resp = await fetch(cfg.url, {
    method: 'POST', headers, signal: ctrl.signal,
    body: JSON.stringify({
      model: model, messages: messages, stream: true,
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
  const model = String(p.model || '');   // 前端可选模型（仅作用于「干活」引擎，审稿引擎保持其自身默认）
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
      const d = await completeChatStream(engine, messages, (t, th) => send('review:delta', { text: t, thinking: th }), { model: model });
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
        const rv2 = await completeChatStream(engine, reviseMsgs, (t, th) => send('review:delta', { text: t, thinking: th }), { model: model });
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
    } else if (type === 'md') {
      fs.writeFileSync(file, String(p.content || ''), 'utf8');
    } else {
      return { ok: false, error: '不支持的文档类型：' + type + '（支持 docx / pptx / xlsx / md）' };
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

/** 即将到来的研究日程（研究助手注入上下文用） */
ipcMain.handle('calendar:upcoming', (_e, days) => upcomingDeadlines(days));

/* ---------------- ICS 订阅 / 导入 ---------------- */
ipcMain.handle('calendar:ics:list', () => listIcsFeeds());
ipcMain.handle('calendar:ics:add', async (_e, name, url) => {
  const r = addIcsFeed(name, url);
  if (!r.ok) return r;
  await runIcsSync().catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  return { ok: true, feed: r.feed };
});
ipcMain.handle('calendar:ics:remove', (_e, id) => removeIcsFeed(id));
ipcMain.handle('calendar:ics:run', () => runIcsSync());
ipcMain.handle('calendar:ics:import', () => importIcsFile());

/** 同步 Outlook 邮箱（Microsoft Graph Mail） */
ipcMain.handle('sync:mail:run', () => runMailSync());

/* ---------------- Notion 接入 ---------------- */
function notionToken() { return decryptSettings(readSettingsRaw()).notionToken || ''; }
ipcMain.handle('notion:configure', (_e, token) => { writeSettings({ notionToken: String(token || '') }); return true; });
ipcMain.handle('notion:status', () => ({ configured: !!notionToken() }));
ipcMain.handle('notion:search', async (_e, query) => {
  const t = notionToken();
  if (!t) return { ok: false, error: '尚未配置 Notion token（在秘书面板「Notion」里粘贴 Internal Integration Token）' };
  try { return { ok: true, results: await NotionEngine.search(t, query) }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});
ipcMain.handle('notion:read', async (_e, id) => {
  const t = notionToken();
  if (!t) return { ok: false, error: '尚未配置 Notion token' };
  try { return { ok: true, page: await NotionEngine.readPage(t, id) }; }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
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

/* 打开知识库来源（Notion 网页 / Zotero / Obsidian 应用与本地目录） */
ipcMain.handle('kb:open', async (_e, kind) => {
  kind = String(kind || '');
  try {
    if (kind === 'notion') { await shell.openExternal('https://www.notion.so'); return { ok: true }; }
    if (kind === 'zotero') {
      if (!detectZoteroDir()) return { ok: false, error: '未检测到 Zotero 数据目录（~/Zotero）' };
      try { await execFileP('open', ['-a', 'Zotero']); }
      catch { const z = detectZoteroDir(); if (z) await shell.openPath(z); }
      return { ok: true };
    }
    if (kind === 'zotero-folder') {
      const z = detectZoteroDir();
      if (!z) return { ok: false, error: '未检测到 Zotero 数据目录（~/Zotero）' };
      await shell.openPath(z); return { ok: true };
    }
    if (kind === 'obsidian') {
      const vaults = detectObsidianVaults();
      if (!vaults.length) return { ok: false, error: '未检测到 Obsidian 库（请先安装 Obsidian 并创建 vault）' };
      try { await execFileP('open', ['-a', 'Obsidian']); }
      catch { await shell.openPath(vaults[0]); }
      return { ok: true };
    }
    if (kind === 'obsidian-folder') {
      const vaults = detectObsidianVaults();
      if (!vaults.length) return { ok: false, error: '未检测到 Obsidian 库' };
      await shell.openPath(vaults[0]); return { ok: true };
    }
    return { ok: false, error: '未知来源：' + kind };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

/* 术语图谱：从 Zotero 提取术语 → 写 Obsidian 术语库 → 返回图数据 */
ipcMain.handle('kb:terms:build', async (e, opts) => {
  opts = opts || {};
  const send = function (data) { if (!e.sender.isDestroyed()) e.sender.send('kb:terms:progress', data); };

  // 自动启动本地 Ollama（无需用户手动打开）
  const ollamaReady = await ensureOllama(function (msg) { send({ phase: 'ollama', msg: msg }); });
  if (!ollamaReady) {
    return { ok: false, error: '本地 Ollama 未能启动。请确认已安装 Ollama（https://ollama.com），或手动运行 `ollama serve` 后重试。' };
  }

  let items = [];
  try {
    const stdout = await execFileP('python3', [path.join(__dirname, 'kb-zotero.py'), '--meta-only']);
    if (stdout) items = JSON.parse(stdout);
  } catch (err) { return { ok: false, error: '读取 Zotero 数据失败：' + String(err && err.message || err) }; }
  if (!Array.isArray(items) || !items.length) return { ok: false, error: 'Zotero 里没有文献（请先在 Zotero 添加文献）' };

  items = items.slice().sort(function (a, b) { return String(b.dateAdded || '').localeCompare(String(a.dateAdded || '')); });

  // 参数归一化：文献数填了正整数就按填的来；没填/非法则默认处理全部（最多 200）
  const totalItems = items.length;
  let maxItems = parseInt(opts.maxItems, 10);
  if (!(maxItems > 0)) maxItems = Math.min(totalItems, 200);
  maxItems = Math.min(maxItems, totalItems);
  let topK = parseInt(opts.topK, 10);
  if (!(topK > 0)) topK = 80;

  const llm = function (messages) {
    return completeChatStream('ollama', messages, null, { temperature: 0.2, maxTokens: 6000 })
      .then(function (r) { return r.text; });
  };

  // 增量：读上次构建状态，已处理文献自动跳过（不重跑 LLM）
  const prevState = readJson('terms-state.json', null);

  const result = await TermsEngine.buildTermsGraph({
    items: items,
    llm: llm,
    vaultPath: vaultPath(),
    batchSize: 10,
    maxItems: maxItems,
    topK: topK,
    prevState: prevState,
    onProgress: function (phase, done, total) { send({ phase: phase, done: done, total: total }); },
  });

  if (result && result.ok && result.state) {
    try { writeJson('terms-state.json', result.state); } catch (e2) { /* 状态写失败不影响返回 */ }
  }
  if (result && typeof result === 'object') {
    result.totalItems = totalItems;
    result.maxItems = maxItems;
  }
  return result;
});

/* ---------------- 工具能力（文件 / 数据库 / 电脑操作） ----------------
 * 只读、安全白名单：list / search / read / db query。
 * 写 / 删除 / 移动本版不提供（不可逆操作，需独立审批流后再开放）。
 * computer 复用上面的 computer:start（截图 + 视觉模型 + 鼠标键盘），默认演练。
 */
function execFileP(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 12000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

/* ---------------- Ollama 本地服务：检测 + 自动启动 ----------------
 * 术语图谱等本地大模型任务依赖 Ollama（127.0.0.1:11434）。
 * 未运行时自动拉起（优先 open -a Ollama，兜底 CLI `ollama serve`），
 * 然后轮询等待就绪，无需用户手动打开。
 */
function isPortOpen(port) {
  return new Promise(function (resolve) {
    const sock = net.connect({ host: '127.0.0.1', port: port, timeout: 800 });
    sock.on('connect', function () { sock.destroy(); resolve(true); });
    sock.on('error', function () { sock.destroy(); resolve(false); });
    sock.on('timeout', function () { sock.destroy(); resolve(false); });
  });
}
function sleepMs(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function ensureOllama(onStatus) {
  const report = onStatus || function () {};
  if (await isPortOpen(11434)) return true;

  report('未检测到 Ollama，正在自动启动…');
  // 1) 优先启动 Ollama 桌面应用（open -a 会拉起 ollama serve）
  try { await execFileP('open', ['-a', 'Ollama']); } catch (e) { /* 忽略 */ }
  // 2) 兜底：CLI 方式后台起 ollama serve（若装了 CLI 但没有 App）
  try {
    const which = await execFileP('which', ['ollama']);
    const bin = String(which || '').trim();
    if (bin) spawn(bin, ['serve'], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) { /* 忽略 */ }

  // 3) 轮询等待就绪（最多 90 秒，覆盖模型首次加载）
  for (let i = 0; i < 90; i++) {
    await sleepMs(1000);
    if (await isPortOpen(11434)) return true;
  }
  return false;
}

function toolFsList(payload) {
  const target = String((payload && payload.dir) || '').trim() || app.getPath('home');
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) return { ok: false, error: '目录不存在：' + target };
  let st; try { st = fs.statSync(abs); } catch { return { ok: false, error: '无法访问：' + target }; }
  if (!st.isDirectory()) return { ok: false, error: '不是目录：' + target };
  const entries = [];
  for (const name of fs.readdirSync(abs)) {
    if (name.startsWith('.')) continue; // 隐藏文件不列，减少噪音
    const full = path.join(abs, name);
    let s = null; try { s = fs.statSync(full); } catch {}
    entries.push({ name, dir: !!(s && s.isDirectory()), size: s ? s.size : 0 });
  }
  entries.sort((x, y) => (y.dir - x.dir) || x.name.localeCompare(y.name));
  return { ok: true, dir: abs, count: entries.length, entries: entries.slice(0, 200) };
}

async function toolFsSearch(payload) {
  const q = String((payload && payload.query) || '').trim();
  const base = path.resolve(String((payload && payload.root) || '').trim() || app.getPath('home'));
  if (!q) return { ok: false, error: '搜索词为空' };
  const results = [];
  const mdf = await execFileP('mdfind', ['-name', q]);
  if (mdf) {
    for (const line of mdf.split('\n')) {
      if (!line.trim()) continue;
      const p = path.resolve(line.trim());
      if (p.startsWith(base)) { results.push(p); if (results.length >= 50) break; }
    }
  }
  if (!results.length) {
    const fd = await execFileP('find', [base, '-maxdepth', '6', '-iname', '*' + q + '*',
      '-not', '-path', '*/.git/*', '-not', '-path', '*/node_modules/*']);
    for (const line of fd.split('\n')) { if (line.trim()) { results.push(line.trim()); if (results.length >= 50) break; } }
  }
  return { ok: true, query: q, count: results.length, results: results.slice(0, 50) };
}

function toolFsRead(payload) {
  const target = path.resolve(String((payload && payload.path) || ''));
  if (!target || !fs.existsSync(target)) return { ok: false, error: '文件不存在：' + String((payload && payload.path) || '') };
  let st; try { st = fs.statSync(target); } catch { return { ok: false, error: '无法访问：' + String((payload && payload.path) || '') }; }
  if (st.isDirectory()) return { ok: false, error: '是目录，请用 list 查看' };
  if (st.size > 200 * 1024) return { ok: false, error: '文件过大（>200KB），暂不支持读取' };
  try {
    const buf = fs.readFileSync(target);
    if (buf.includes(0)) return { ok: false, error: '疑似二进制文件，暂不支持读取' };
    return { ok: true, path: target, size: st.size, content: buf.toString('utf8') };
  } catch (e) { return { ok: false, error: '读取失败：' + String(e && e.message || e) }; }
}

/* ---------------- 写工具（需审批；安全边界：仅主目录、拒系统/隐藏/Library，覆盖前备份，删除走废纸篓） ---------------- */
function isSafeWritePath(p) {
  const abs = path.resolve(String(p || ''));
  const home = app.getPath('home');
  if (!abs.startsWith(home + path.sep)) return false;                 // 只允许主目录内
  const rel = path.relative(home, abs);
  const first = rel.split(path.sep)[0];
  if (first === 'Library' || first.startsWith('.')) return false;    // 拒 Library 与隐藏目录
  return true;
}
function backupFile(p) {
  try {
    if (fs.existsSync(p)) {
      const bak = p + '.cu-bak-' + Date.now();
      fs.copyFileSync(p, bak);
      return bak;
    }
  } catch {}
  return null;
}
function toolFsWrite(payload) {
  const target = path.resolve(String((payload && payload.path) || ''));
  const content = String((payload && payload.content) == null ? '' : payload.content);
  if (!target) return { ok: false, error: '路径为空' };
  if (!isSafeWritePath(target)) return { ok: false, error: '拒绝写入该位置（仅允许主目录内的普通文件/目录，系统目录、Library、隐藏目录受保护）' };
  try {
    const bak = backupFile(target);
    fs.writeFileSync(target, content, 'utf8');
    return { ok: true, path: target, wrote: content.length, backup: bak };
  } catch (e) { return { ok: false, error: '写入失败：' + String(e && e.message || e) }; }
}
function toolFsAppend(payload) {
  const target = path.resolve(String((payload && payload.path) || ''));
  const content = String((payload && payload.content) == null ? '' : payload.content);
  if (!target) return { ok: false, error: '路径为空' };
  if (!isSafeWritePath(target)) return { ok: false, error: '拒绝写入该位置（仅允许主目录内的普通文件/目录）' };
  try {
    fs.appendFileSync(target, content, 'utf8');
    return { ok: true, path: target, appended: content.length };
  } catch (e) { return { ok: false, error: '追加失败：' + String(e && e.message || e) }; }
}
function toolFsEdit(payload) {
  const target = path.resolve(String((payload && payload.path) || ''));
  const oldStr = String((payload && payload.old) == null ? '' : payload.old);
  const newStr = String((payload && payload.new) == null ? '' : payload.new);
  if (!target) return { ok: false, error: '路径为空' };
  if (!isSafeWritePath(target)) return { ok: false, error: '拒绝修改该位置（仅允许主目录内的普通文件/目录）' };
  if (!oldStr) return { ok: false, error: '要替换的原文（old）不能为空' };
  try {
    if (!fs.existsSync(target)) return { ok: false, error: '文件不存在：' + target };
    const orig = fs.readFileSync(target, 'utf8');
    let cnt = orig.split(oldStr).length - 1;
    if (cnt === 0) return { ok: false, error: '未找到要替换的内容，已取消（请确认原文精确一致）' };
    if (cnt > 1) return { ok: false, error: '要替换的内容出现 ' + cnt + ' 次，请给出更长的唯一上下文' };
    const bak = backupFile(target);
    fs.writeFileSync(target, orig.replace(oldStr, newStr), 'utf8');
    return { ok: true, path: target, replaced: 1, backup: bak };
  } catch (e) { return { ok: false, error: '修改失败：' + String(e && e.message || e) }; }
}
function toolFsMove(payload) {
  const from = path.resolve(String((payload && payload.from) || ''));
  const to = path.resolve(String((payload && payload.to) || ''));
  if (!from || !to) return { ok: false, error: '来源或目标为空' };
  if (!isSafeWritePath(from) || !isSafeWritePath(to)) return { ok: false, error: '拒绝移动（来源或目标超出主目录安全范围）' };
  try {
    if (!fs.existsSync(from)) return { ok: false, error: '来源不存在：' + from };
    fs.renameSync(from, to);
    return { ok: true, from: from, to: to };
  } catch (e) { return { ok: false, error: '移动失败：' + String(e && e.message || e) }; }
}
async function toolFsDelete(payload) {
  const target = path.resolve(String((payload && payload.path) || ''));
  if (!target) return { ok: false, error: '路径为空' };
  if (!isSafeWritePath(target)) return { ok: false, error: '拒绝删除（仅允许主目录内的普通文件/目录）' };
  try {
    if (!fs.existsSync(target)) return { ok: false, error: '文件不存在：' + target };
    // 删除到废纸篓：直接 rename 到 ~/.Trash（macOS 废纸篓真实位置，无需额外权限，可从废纸篓恢复）
    const trash = path.join(app.getPath('home'), '.Trash');
    let dest = path.join(trash, path.basename(target));
    if (fs.existsSync(dest)) dest = path.join(trash, path.basename(target) + '.cu-' + Date.now());
    fs.renameSync(target, dest);
    return { ok: true, path: target, trashed: true, trashPath: dest };
  } catch (e) { return { ok: false, error: '删除失败：' + String(e && e.message || e) }; }
}

ipcMain.handle('tool:fs:list', (_e, p) => toolFsList(p));
ipcMain.handle('tool:fs:search', (_e, p) => toolFsSearch(p));
ipcMain.handle('tool:fs:read', (_e, p) => toolFsRead(p));
ipcMain.handle('tool:fs:write', (_e, p) => toolFsWrite(p));
ipcMain.handle('tool:fs:append', (_e, p) => toolFsAppend(p));
ipcMain.handle('tool:fs:edit', (_e, p) => toolFsEdit(p));
ipcMain.handle('tool:fs:move', (_e, p) => toolFsMove(p));
ipcMain.handle('tool:fs:delete', (_e, p) => toolFsDelete(p));
ipcMain.handle('tool:db:query', async (_e, p) => {
  const q = String((p && p.query) || '').trim();
  const k = Math.min(Math.max(parseInt((p && p.k), 10) || 5, 1), 10);
  if (!q) return { ok: false, error: '查询词为空' };
  const hits = await kbEngine.search(q, k);
  const out = { ok: true, query: q, hits: hits };
  // Notion（可选，未配 token 时静默跳过；检索失败不阻断本地结果）
  try {
    const t = notionToken();
    if (t) {
      const nr = await NotionEngine.search(t, q);
      out.notion = (nr || []).slice(0, k).map(function (it) {
        return { title: it.title, object: it.object, id: it.id, source: 'Notion' };
      });
    }
  } catch (e) { /* ignore */ }
  return out;
});

/* ---------------- 整理数据库工具（Obsidian 写 / Zotero 只读报告） ---------------- */
function vaultPath() {
  const vaults = detectObsidianVaults();
  return (vaults && vaults.length) ? vaults[0] : null;
}
function parseFrontmatter(content) {
  const m = String(content || '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { has: false, header: '', body: String(content || ''), tags: [] };
  const fm = m[1];
  const tags = [];
  const inline = fm.match(/^tags\s*:\s*\[(.*?)\]\s*$/m);
  if (inline) {
    inline[1].split(',').forEach((t) => { const x = t.trim().replace(/^['"]|['"]$/g, ''); if (x) tags.push(x); });
  } else {
    const list = fm.match(/^tags\s*:\s*\r?\n((?:\s*-\s*.*\r?\n?)+)/m);
    if (list) {
      list[1].split(/\r?\n/).forEach((line) => {
        const x = line.trim().replace(/^-\s*/, '').replace(/^['"]|['"]$/g, '');
        if (x) tags.push(x);
      });
    }
  }
  return { has: true, header: m[0], body: String(content || '').slice(m[0].length), tags: tags };
}
function buildFrontmatter(title, tags, content) {
  const t = Array.isArray(tags) ? tags.map((x) => String(x).trim()).filter(Boolean) : [];
  const lines = ['---'];
  if (title) lines.push('title: ' + JSON.stringify(String(title)));
  lines.push('tags:');
  if (t.length) t.forEach((x) => lines.push('  - ' + JSON.stringify(x)));
  else lines.push('  - 未分类');
  lines.push('---');
  return lines.join('\n') + '\n\n' + String(content || '').trim() + '\n';
}
function resolveInVault(relPath) {
  const vp = vaultPath();
  if (!vp) return null;
  const p = String(relPath || '').trim();
  if (!p) return vp;
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(vp, p);
  return abs.startsWith(vp + path.sep) ? abs : null;
}
function safeFileName(name) {
  return String(name || '未命名').replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '').trim() || '未命名';
}

function toolDbObsidianWrite(payload) {
  const vp = vaultPath();
  if (!vp) return { ok: false, error: '未检测到 Obsidian 库（请先安装 Obsidian 并创建 vault）' };
  const title = String((payload && payload.title) || '').trim();
  const content = String((payload && payload.content) || '');
  const tags = Array.isArray(payload && payload.tags) ? payload.tags : [];
  const folder = String((payload && payload.folder) || '_AI整理').trim();
  if (!title) return { ok: false, error: '缺少标题' };
  const dir = resolveInVault(folder);
  if (!dir) return { ok: false, error: '目录超出 Obsidian 库范围：' + folder };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const base = safeFileName(title);
    let full = path.join(dir, base + '.md');
    if (fs.existsSync(full)) full = path.join(dir, base + '-' + Date.now().toString(36).slice(-4) + '.md');
    const body = buildFrontmatter(title, tags, content);
    fs.writeFileSync(full, body, 'utf8');
    return { ok: true, path: full, title: title, tags: tags, chars: body.length };
  } catch (e) { return { ok: false, error: '写入失败：' + String(e && e.message || e) }; }
}
function toolDbObsidianTag(payload) {
  const vp = vaultPath();
  if (!vp) return { ok: false, error: '未检测到 Obsidian 库' };
  const target = resolveInVault((payload && payload.path) || '');
  if (!target) return { ok: false, error: '路径超出 Obsidian 库范围' };
  if (!fs.existsSync(target)) return { ok: false, error: '笔记不存在：' + String((payload && payload.path) || '') };
  const tags = Array.isArray(payload && payload.tags) ? payload.tags.map((x) => String(x).trim()).filter(Boolean) : [];
  const tagBlock = 'tags:\n' + (tags.length ? tags.map((t) => '  - ' + JSON.stringify(t)).join('\n') : '  - 未分类');
  try {
    const orig = fs.readFileSync(target, 'utf8');
    const fm = parseFrontmatter(orig);
    const bak = backupFile(target);
    let body;
    if (fm.has) {
      const inner = fm.header.replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n?$/, '');
      let cleaned = inner
        .replace(/^tags\s*:\s*\r?\n(?:\s+-\s+.*\r?\n?)+/m, '')
        .replace(/^tags\s*:.*$/m, '')
        .replace(/\n{2,}/g, '\n').trim();
      const newInner = cleaned ? cleaned + '\n' + tagBlock : tagBlock;
      body = '---\n' + newInner + '\n---\n' + fm.body;
    } else {
      body = '---\n' + tagBlock + '\n---\n\n' + orig;
    }
    fs.writeFileSync(target, body, 'utf8');
    return { ok: true, path: target, tags: tags, backup: bak };
  } catch (e) { return { ok: false, error: '打标签失败：' + String(e && e.message || e) }; }
}
function toolDbObsidianMove(payload) {
  const vp = vaultPath();
  if (!vp) return { ok: false, error: '未检测到 Obsidian 库' };
  const from = resolveInVault((payload && payload.from) || '');
  const to = resolveInVault((payload && payload.to) || '');
  if (!from || !to) return { ok: false, error: '来源或目标超出 Obsidian 库范围' };
  try {
    if (!fs.existsSync(from)) return { ok: false, error: '来源不存在：' + String((payload && payload.from) || '') };
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return { ok: true, from: from, to: to };
  } catch (e) { return { ok: false, error: '移动失败：' + String(e && e.message || e) }; }
}
function toolDbObsidianReport() {
  const vp = vaultPath();
  if (!vp) return { ok: false, error: '未检测到 Obsidian 库' };
  const skip = new Set(['.obsidian', '.trash', '.git', 'node_modules']);
  const st = { total: 0, withFm: 0, withoutFm: 0, withTags: 0, withoutTags: [], dirs: {} };
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.isDirectory()) { if (!skip.has(ent.name)) walk(path.join(dir, ent.name)); continue; }
      if (!/\.md$/i.test(ent.name)) continue;
      const full = path.join(dir, ent.name);
      let content; try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
      st.total++;
      const fm = parseFrontmatter(content);
      const rel = path.relative(vp, full).split(path.sep).join('/');
      if (fm.has) st.withFm++; else st.withoutFm++;
      if (fm.tags.length) st.withTags++;
      else if (st.withoutTags.length < 50) st.withoutTags.push(rel);
      const d = path.dirname(rel) || '(根目录)';
      st.dirs[d] = (st.dirs[d] || 0) + 1;
    }
  }
  walk(vp);
  return { ok: true, vault: vp, total: st.total, withFm: st.withFm, withoutFm: st.withoutFm, withTags: st.withTags, withoutTags: st.withoutTags, dirs: st.dirs };
}
async function toolDbZoteroReport() {
  const zdir = detectZoteroDir();
  if (!zdir) return { ok: false, error: '未检测到 Zotero 数据目录（~/Zotero 不存在）' };
  const stdout = await execFileP('python3', [path.join(__dirname, 'kb-zotero.py'), '--meta-only']);
  if (!stdout) return { ok: false, error: '读取 Zotero 数据失败（请确认 ~/Zotero/zotero.sqlite 可访问）' };
  let items; try { items = JSON.parse(stdout); } catch { return { ok: false, error: '解析 Zotero 数据失败' }; }
  const noTags = items.filter((i) => !(i.tags && i.tags.length));
  const recent = items.slice().sort((a, b) => String(b.dateAdded || '').localeCompare(String(a.dateAdded || ''))).slice(0, 10)
    .map((i) => ({ title: i.title, year: i.year, type: i.type, tags: i.tags || [] }));
  return {
    ok: true, total: items.length, withTags: items.length - noTags.length, withoutTags: noTags.length,
    noTagsSample: noTags.slice(0, 20).map((i) => ({ title: i.title, year: i.year })),
    recent: recent,
  };
}

/* ---------------- Zotero 本地 API（写入：改标签 / 归档） ---------------- */
// Zotero 10+ 本地 API（127.0.0.1:23119）：读无需鉴权；写需先 POST /local/authorize
// 触发 Zotero 弹框，用户选「始终允许(Always Allow)」后拿到持久 key（存 userData，按 server-id 分区）。
const ZOTERO_LOCAL_BASE = 'http://127.0.0.1:23119/api';

function zoteroKeyPath() { return path.join(dataDir(), 'zotero-local-key.json'); }
function zoteroReadKeyFile() { try { return JSON.parse(fs.readFileSync(zoteroKeyPath(), 'utf8')); } catch { return {}; } }
function zoteroWriteKeyFile(obj) { try { fs.writeFileSync(zoteroKeyPath(), JSON.stringify(obj, null, 2), { mode: 0o600 }); } catch {} }

function zoteroRequest(method, apiPath, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const headers = { 'Content-Type': 'application/json' };
    if (opts.serverId) headers['Zotero-Server-ID'] = opts.serverId;
    if (opts.key) headers['Zotero-API-Key'] = opts.key;
    if (opts.version !== undefined && opts.version !== null) headers['If-Unmodified-Since-Version'] = String(opts.version);
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : null;
    if (bodyStr !== null) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const req = http.request({
      hostname: '127.0.0.1', port: 23119, path: '/api' + apiPath,
      method: method, headers: headers, timeout: opts.timeout || 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => done({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('timeout', () => { req.destroy(); done({ status: 0, headers: {}, text: '请求超时' }); });
    req.on('error', (e) => done({ status: 0, headers: {}, text: String((e && e.message) || e) }));
    if (bodyStr !== null) req.write(bodyStr);
    req.end();
  });
}

async function zoteroServerId() {
  const f = zoteroReadKeyFile();
  if (f.serverId) return f.serverId;
  const r = await zoteroRequest('GET', '/');
  const id = r.headers && r.headers['zotero-server-id'];
  if (id) { zoteroWriteKeyFile(Object.assign({}, f, { serverId: id })); return id; }
  return 'tCLKRQVq4NWD'; // 兜底（本机已探测到的实例 ID）
}

async function zoteroEnsureKey(serverId) {
  const f = zoteroReadKeyFile();
  if (f.serverId === serverId && f.key && f.remember !== false) return { key: f.key };
  // 触发 Zotero 弹框（等待用户在 Zotero 里点「始终允许」，最长 3 分钟）
  const r = await zoteroRequest('POST', '/local/authorize', { serverId: serverId, body: { appName: "Ingrid's AI Agents" }, timeout: 180000 });
  if (r.status === 403) return { error: '用户已在 Zotero 弹框中拒绝授权' };
  if (r.status === 429) return { error: '授权请求过于频繁（每分钟最多 5 次），请稍后再试' };
  if (r.status !== 200) return { error: '授权失败（HTTP ' + r.status + '），请确认 Zotero 正在运行且已开启本地 API' };
  let j; try { j = JSON.parse(r.text); } catch { return { error: '授权响应解析失败' }; }
  if (!j.key) return { error: '未获得授权 key' };
  zoteroWriteKeyFile({ serverId: serverId, key: j.key, remember: !!j.remember });
  return { key: j.key };
}

async function toolDbZoteroTag(payload) {
  const itemKey = String((payload && payload.itemKey) || '').trim();
  const tags = ((payload && payload.tags) || []).map((t) => String(t).trim()).filter(Boolean);
  if (!itemKey) return { ok: false, error: '缺少 itemKey（文献条目 key）' };
  if (!tags.length) return { ok: false, error: '缺少 tags（要打的标签）' };
  const serverId = await zoteroServerId();
  const auth = await zoteroEnsureKey(serverId);
  if (auth.error) return { ok: false, error: auth.error };
  const cur = await zoteroRequest('GET', '/users/0/items/' + itemKey, { serverId: serverId });
  if (cur.status !== 200) return { ok: false, error: '读取文献失败（HTTP ' + cur.status + '），itemKey 可能不对：' + itemKey };
  let item; try { item = JSON.parse(cur.text); } catch { return { ok: false, error: '文献数据解析失败' }; }
  const existing = ((item.data && item.data.tags) || []).map((t) => t.tag);
  const merged = Array.from(new Set(existing.concat(tags)));
  const r = await zoteroRequest('PATCH', '/users/0/items/' + itemKey, {
    serverId: serverId, key: auth.key,
    version: (item && item.version) || (item.data && item.data.version),
    body: { tags: merged.map((t) => ({ tag: t })) },
  });
  if (r.status === 401) { zoteroWriteKeyFile({ serverId: serverId }); return { ok: false, error: '授权 key 失效，请重试（会重新弹 Zotero 授权框）' }; }
  if (r.status !== 200 && r.status !== 204) return { ok: false, error: '写入失败（HTTP ' + r.status + '）：' + String(r.text || '').slice(0, 200) };
  return { ok: true, itemKey: itemKey, title: (item.data && item.data.title) || '', tags: merged, added: tags };
}

async function toolDbZoteroCollection(payload) {
  const itemKeys = Array.isArray(payload && payload.itemKeys) ? payload.itemKeys
    : ((payload && payload.itemKey) ? [payload.itemKey] : []);
  const collectionKey = String((payload && payload.collectionKey) || '').trim();
  const collectionName = String((payload && payload.collectionName) || '').trim();
  if (!itemKeys.length) return { ok: false, error: '缺少 itemKey(s)（要归档的文献）' };
  if (!collectionKey && !collectionName) return { ok: false, error: '缺少 collectionName 或 collectionKey（归档目标集合）' };
  const serverId = await zoteroServerId();
  const auth = await zoteroEnsureKey(serverId);
  if (auth.error) return { ok: false, error: auth.error };
  let targetKey = collectionKey;
  if (!targetKey) {
    const list = await zoteroRequest('GET', '/users/0/collections?limit=100', { serverId: serverId });
    const libVer = list.headers && list.headers['last-modified-version'];
    let found = null;
    if (list.status === 200) {
      try { found = JSON.parse(list.text).find((c) => c.data && c.data.name === collectionName); } catch {}
    }
    if (found) targetKey = found.key;
    else {
      const c = await zoteroRequest('POST', '/users/0/collections', { serverId: serverId, key: auth.key, version: libVer, body: [{ name: collectionName, parentCollection: false }] });
      if (c.status !== 200) return { ok: false, error: '创建集合失败（HTTP ' + c.status + '）：' + String(c.text || '').slice(0, 120) };
      try { targetKey = JSON.parse(c.text).successful['0'].key; } catch { return { ok: false, error: '解析集合创建结果失败' }; }
    }
  }
  let moved = 0; const failed = [];
  for (const ik of itemKeys) {
    const cur = await zoteroRequest('GET', '/users/0/items/' + ik, { serverId: serverId });
    if (cur.status !== 200) { failed.push(ik); continue; }
    let item; try { item = JSON.parse(cur.text); } catch { failed.push(ik); continue; }
    const cols = Array.from(new Set(((item.data && item.data.collections) || []).concat([targetKey])));
    const r = await zoteroRequest('PATCH', '/users/0/items/' + ik, {
      serverId: serverId, key: auth.key,
      version: (item && item.version) || (item.data && item.data.version),
      body: { collections: cols },
    });
    if (r.status === 200 || r.status === 204) moved++; else failed.push(ik);
  }
  return { ok: true, collectionKey: targetKey, collectionName: collectionName || targetKey, moved: moved, failed: failed };
}

ipcMain.handle('tool:db:obsidian:write', (_e, p) => toolDbObsidianWrite(p));
ipcMain.handle('tool:db:obsidian:tag', (_e, p) => toolDbObsidianTag(p));
ipcMain.handle('tool:db:obsidian:move', (_e, p) => toolDbObsidianMove(p));
ipcMain.handle('tool:db:obsidian:report', () => toolDbObsidianReport());
ipcMain.handle('tool:db:zotero:report', () => toolDbZoteroReport());
ipcMain.handle('tool:db:zotero:tag', (_e, p) => toolDbZoteroTag(p));
ipcMain.handle('tool:db:zotero:collection', (_e, p) => toolDbZoteroCollection(p));

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
  // ICS 订阅（Teams/Outlook 等发布的外部日历）：启动即拉取 + 每 30 分钟自动刷新
  runIcsSync().catch(() => {});
  setInterval(() => { runIcsSync().catch(() => {}); }, 30 * 60 * 1000);
  // 邮箱自动同步：Outlook 邮箱同样每 30 分钟拉取一次
  runMailSync().catch(() => {});
  setInterval(() => { runMailSync().catch(() => {}); }, 30 * 60 * 1000);
  // 研究日历到期自动提醒：启动即查一次 + 每 60 秒轮询（发系统通知 + 广播给面板）
  runReminderCheck();
  setInterval(() => { runReminderCheck(); }, 60 * 1000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
