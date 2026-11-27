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

const { app, BrowserWindow, BrowserView, ipcMain, safeStorage, shell, Notification, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFile, execFileSync } = require('child_process');
const os = require('os');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const Architecture = require('./agent-architecture-core.js');
const activity = require('./agent-activity.js').createActivity();

function activityTitle(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
}

function activitySender(sender) {
  const file = sender.getURL();
  return /^file:.*\/agents\/(assistant-chat|dev-chat|research-chat|ethics-chat)\/index\.html$/.exec(file)?.[1];
}
require('./skills-core.js');
const SkillsCore = globalThis.SkillsCore;
const { KbEngine, detectObsidianVaults, detectZoteroDir, isWorkspaceVault } = require('./kb-engine.js');
const syncEngine = require('./sync-engine.js');
require('./secretary-core.js');
const SecretaryCore = globalThis.SecretaryCore;
const NotionEngine = require('./notion-engine.js');
const TermsEngine = require('./terms-engine.js');
const TaskQueue = require('./task-queue.js');
require('./task-router.js');
const TaskRouter = globalThis.TaskRouter;
require('./session-log-core.js');
const SessionLogCore = globalThis.SessionLogCore;
require('./eco-radar.js');
const EcoRadar = globalThis.EcoRadar;
require('./permission-core.js');
const PermissionCore = globalThis.PermissionCore;
const KnowledgeSettlerCore = require('./knowledge-settler-core.js');
const agentGovernance = require('./agent-governance.js');
const agentTypeGovernor = require('./agent-type-governor.js');
const agentOpsGovernor = require('./agent-ops-governor.js');
const SentimentAgentCore = require('./sentiment-agent-core.js');
require('./myos-core.js');
const MyOS = globalThis.MyOS;

/* ---------------- 应用名（决定 userData 目录，须在单实例锁之前设定，确保锁与数据同目录） ---------------- */
app.setName("Ingrid's AI Agents");

/* ---------------- 清理上次异常退出残留的坏单例锁 ----------------
 * 根因：应用崩溃 / 被强杀 / 系统重启后，Chromium 的 SingletonLock 会残留。
 * 若残留锁损坏（非 symlink、symlink 目标损坏）或指向的进程已死，
 * requestSingleInstanceLock() 会因「File exists + 无法解析 pid」直接返回 false，
 * 主进程随即 app.quit()，表现为「双击图标打不开、窗口一闪而过」。
 * 修复：加锁前先探测 SingletonLock，只有确认「锁指向的进程确实还活着」才保留，
 * 否则删除坏锁，让 requestSingleInstanceLock() 能正常重建。
 */
function clearStaleSingletonLock() {
  try {
    const lockPath = path.join(app.getPath('userData'), 'SingletonLock');
    const st = fs.lstatSync(lockPath);
    let alive = false;
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(lockPath);
      const m = /(\d+)$/.exec(target || '');
      if (m) {
        const pid = Number(m[1]);
        try { process.kill(pid, 0); alive = true; } catch (e) { alive = false; }
      }
    }
    if (!alive) fs.unlinkSync(lockPath);
  } catch (e) { /* 锁不存在或无法访问，无需清理 */ }
}
clearStaleSingletonLock();

/* ---------------- 单实例锁：避免重复启动产生多个主窗口（Dock 出现多个相同图标） ---------------- */
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 用户再次双击应用：聚焦已有主窗口，而不是再开一个新的
    const wins = BrowserWindow.getAllWindows();
    const win = wins[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
    } else {
      createMainWindow();
    }
  });
}

/* ---------------- 数据目录（local-first） ---------------- */

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

/* ---------------- 会话回放：append-only 事件日志（借鉴 DSH Replayable Sessions） ---------------- */
function sessionsDir() {
  const dir = path.join(dataDir(), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function sessionFileFor(id) {
  const safe = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return path.join(sessionsDir(), safe + '.jsonl');
}
const sessionLogStorage = {
  append: (sessionId, ev) => {
    fs.appendFileSync(sessionFileFor(sessionId), JSON.stringify(ev) + '\n', 'utf8');
  },
  list: (sessionId) => {
    try {
      return fs.readFileSync(sessionFileFor(sessionId), 'utf8').split('\n')
        .filter((l) => l.trim())
        .map((l) => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
    } catch { return []; }
  },
  listSessions: () => {
    try {
      return fs.readdirSync(sessionsDir()).filter((f) => f.endsWith('.jsonl')).map((f) => {
        const id = f.replace(/\.jsonl$/, '');
        const evs = sessionLogStorage.list(id);
        const first = evs[0] || {}, last = evs[evs.length - 1] || {};
        const title = (first.data && (first.data.title || first.data.text)) || (last.data && last.data.title) || id;
        return { id: id, count: evs.length, firstAt: first.at || 0, lastAt: last.at || 0, title: String(title).slice(0, 80) };
      }).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    } catch { return []; }
  },
  fork: (fromId, toId) => {
    try { fs.copyFileSync(sessionFileFor(fromId), sessionFileFor(toId)); } catch { /* 源不存在则忽略 */ }
  },
};
const sessionLog = new SessionLogCore.SessionLog(sessionLogStorage);

/* ---------------- 授权门：有副作用操作前的显式授权 + 审计（借鉴 DSH permission policy） ---------------- */
const permissionGateStorage = {
  load: () => readJson('permissions.json', []),
  save: (grants) => writeJson('permissions.json', Array.isArray(grants) ? grants : []),
  appendAudit: (entry) => {
    try { fs.appendFileSync(path.join(dataDir(), 'permissions-audit.jsonl'), JSON.stringify(entry) + '\n', 'utf8'); } catch { /* 忽略 */ }
  },
  listAudit: () => {
    try {
      return fs.readFileSync(path.join(dataDir(), 'permissions-audit.jsonl'), 'utf8').split('\n')
        .filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  },
};
const permissionGate = new PermissionCore.PermissionGate(permissionGateStorage);

/* ---------------- 后台任务队列（吸收 dsh Ticket 思想） ---------------- */
let taskQueue = null;
function getTaskQueue() {
  if (!taskQueue) taskQueue = new TaskQueue(dataDir(), { maxConcurrent: 2 });
  return taskQueue;
}
// 任务状态变化时广播给渲染进程（任务中心面板实时刷新）；复用下方 broadcast() 投递
function broadcastTasks() {
  try {
    const q = getTaskQueue();
    broadcast('task:changed', { tickets: q.list(), counts: q.counts() });
  } catch { /* 忽略广播失败 */ }
  scheduleApprovalsRefresh();
}

/* ---------------- 统一「待办中心」：三类待审批聚合 ----------------
 * 把散落在三处、都「需要用户拍板」的活收拢成一个总数：
 *   1. 后台任务队列 waiting（需决策）
 *   2. 知识沉淀官 pending_approval（经验提案）
 *   3. CityVerse 控制台 pending_approval（建设规划）
 * 用途：首页任务中心红色数字徽章 + 系统通知提醒 + 任务中心面板统一展示。
 */
function settlerPendingList() {
  try {
    return getKnowledgeSettler().proposals('pending_approval').map((p) => ({
      id: p.id, kind: 'experience', title: p.title || p.rule || '经验提案',
      category: p.category, createdAt: p.created,
    }));
  } catch { return []; }
}
async function approvalsSummary() {
  const q = getTaskQueue();
  const waiting = q.list('waiting').map((t) => ({
    id: t.id, kind: 'task', title: t.title || '未命名任务', question: t.question || '', createdAt: t.updatedAt,
  }));
  const experience = settlerPendingList();
  let cityverse = [];
  try {
    const cv = await cityversePendingPlans();
    if (cv && cv.online && Array.isArray(cv.plans)) {
      cityverse = cv.plans.map((p) => ({
        id: p.id, kind: 'cityverse', title: p.title || ('规划 #' + p.id),
        human_report: p.human_report || '', createdAt: p.created_at || '',
      }));
    }
  } catch { /* CityVerse 控制台未启动/不可用，忽略 */ }
  return {
    total: waiting.length + experience.length + cityverse.length,
    waiting: waiting, experience: experience, cityverse: cityverse,
  };
}
let approvalsRefreshTimer = null;
function scheduleApprovalsRefresh() {
  if (approvalsRefreshTimer) return;
  approvalsRefreshTimer = setTimeout(() => { approvalsRefreshTimer = null; refreshApprovals(); }, 400);
}
let lastApprovalFingerprint = '';
async function refreshApprovals() {
  let s;
  try { s = await approvalsSummary(); } catch { return; }
  broadcast('approvals:changed', s);
  // 只有「待办指纹」变化（有新增/减少）才发系统通知，避免每轮轮询都轰炸
  const fp = s.waiting.length + '/' + s.experience.length + '/' + s.cityverse.length;
  if (s.total === 0) { lastApprovalFingerprint = fp; return; }
  if (fp === lastApprovalFingerprint) return;
  lastApprovalFingerprint = fp;
  // 待办提醒由「秘书」agent 承担：以秘书身份发通知，而非裸系统弹窗。
  notifyTodosAsSecretary(s);
}

/** 秘书 agent：汇总工作台待办后，以秘书身份发系统通知（提醒归口到秘书，不再是裸弹窗） */
function notifyTodosAsSecretary(s) {
  const parts = [];
  if (s.waiting.length) parts.push(s.waiting.length + ' 个任务需决策');
  if (s.experience.length) parts.push(s.experience.length + ' 条经验提案待审批');
  if (s.cityverse.length) parts.push(s.cityverse.length + ' 条 CityVerse 规划待审批');
  try {
    if (Notification.isSupported()) {
      new Notification({ title: '📋 秘书 · 你有 ' + s.total + ' 件待办需要处理', body: parts.join(' · ') || '打开工作台查看详情' }).show();
    }
  } catch { /* 通知失败不阻断 */ }
}
ipcMain.handle('approvals:summary', () => approvalsSummary());
function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir(), name), 'utf8')); }
  catch { return fallback; }
}
function writeJson(name, data) {
  fs.writeFileSync(path.join(dataDir(), name), JSON.stringify(data, null, 2), 'utf8');
}

/* ---------------- 知识沉淀官（借鉴海归海 experience_settler）----------------
 * 常驻后台「经验沉淀官」：把「已解决」的问题复盘成可复用经验。
 * 人工在环：只提案（pending_approval）、分类预标注，approve() 才分层入库
 * （方法论 / 结论分库），suggest_for() 供新问题检索复用。
 * local-first：落盘 data/experience-library.json。
 */
let knowledgeSettler = null;
function getKnowledgeSettler() {
  if (!knowledgeSettler) {
    knowledgeSettler = new KnowledgeSettlerCore.KnowledgeSettler({
      load: () => readJson('experience-library.json', KnowledgeSettlerCore.emptyState()),
      save: (state) => writeJson('experience-library.json', state),
    });
  }
  return knowledgeSettler;
}

/* ---------------- 情绪/偏好 Agent（借鉴海归海经验沉淀官 + 用户偏好学习）----------------
 * 常驻后台「情绪/偏好 Agent」：侦测用户对各 agent 的评价与情绪，学习「该多做 / 该避免」
 * 的偏好，沉淀成偏好规则并：① 注入 chat agent 的 system prompt 指导后续操作；
 * ② 通过 settlerSubmit 把新提炼的偏好提交给「经验沉淀官」（仍停待审批，人工在环不变）。
 * local-first：落盘 data/sentiment-library.json。
 */
let sentimentAgent = null;
function getSentimentAgent() {
  if (!sentimentAgent) {
    sentimentAgent = new SentimentAgentCore.SentimentAgent({
      load: () => readJson('sentiment-library.json', SentimentAgentCore.emptyState()),
      save: (state) => writeJson('sentiment-library.json', state),
    }, function (item) {
      // 联动：把新提炼的用户偏好作为一条经验提交给经验沉淀官（去重 + 待审批）
      const result = getKnowledgeSettler().submit(item);
      if (result?.id) {
        const run = activity.start({
          agent: 'settler', from: 'sentiment', source: '偏好提案', title: '提交用户偏好供人工审核',
        });
        activity.finish(run);
      }
      return result;
    });
    // 注入 LLM「做法提炼器」：把「被评价回复 + 用户评价」提炼成一句可执行做法
    sentimentAgent.setDistiller(distillActionWithLLM);
  }
  return sentimentAgent;
}

/* ---------------- LLM 做法提炼（方案 B：情绪仅作索引，真正沉淀的是「做法」）----------------
 * 借鉴 PAHF 的 Detect-Summarize-Integrate 三段 + opensearch ml-commons 的
 * 「偏好提取输出自然语言单句」经验。distill 时把待处理的 bucket 批量交给 LLM，
 * 提炼出「具体可执行的做法」；LLM 不可用则返回 null，由核心模块降级启发式。
 */
function buildDistillPrompt(buckets) {
  const lines = [];
  lines.push('你是「用户偏好提炼器」。下面是用户对我方 AI Agent 输出的若干条评价记录，每条含：场景、方向（保持=用户认可，避免=用户不满）、用户评价原文、被评价的 Agent 回复内容。');
  lines.push('请为每一条提炼出一句「具体、可执行的做法」——不是复述情绪，而是说清「Agent 应该怎么做 / 不该怎么做」。');
  lines.push('');
  lines.push('严格输出一个 JSON 数组，不要输出任何其他文字、不要用 markdown 代码块、不要加解释。数组每项格式：');
  lines.push('{"k":序号,"action":"一句可执行做法","reason":"用户依据摘要"}');
  lines.push('');
  lines.push('规则：');
  lines.push('1. action 必须是动宾结构、具体到能被另一个 Agent 照着做（如「总结时先给结论再分点并标注出处」），禁止「要更好」「要专业」「用户觉得好」这类空话。');
  lines.push('2. 若回复里看不出具体做法（只是「谢谢」「OK」），action 填「（无明确做法）」。');
  lines.push('3. 用自然语言，不要嵌套引号、不要换行。');
  lines.push('');
  lines.push('待提炼列表：');
  buckets.forEach(function (b, i) {
    const ctx = String(b.signals[0].context || '').replace(/\s+/g, ' ').slice(0, 500);
    const txt = String(b.signals[0].text || '').replace(/\s+/g, ' ').slice(0, 150);
    lines.push((i + 1) + '. [k=' + (i + 1) + '] 场景:' + b.scenario + ' | 方向:' + (b.direction === 'do' ? '保持' : '避免') + ' | 用户评价:' + txt + ' | 被评价回复:' + ctx);
  });
  return lines.join('\n');
}

function parseDistillResult(text, buckets) {
  const arr = [];
  const seen = {};
  const push = function (key, action, reason) {
    if (!key || seen[key]) return;
    seen[key] = true;
    arr.push({ key: key, action: action, reason: reason });
  };
  const extract = function (items) {
    if (!Array.isArray(items)) return false;
    items.forEach(function (item) {
      const k = parseInt(item && item.k, 10);
      if (isNaN(k) || k < 1 || k > buckets.length) return;
      const b = buckets[k - 1];
      if (!b) return;
      push(b.key, String(item.action || '').trim(), String(item.reason || '').trim());
    });
    return arr.length > 0;
  };
  const t = String(text || '').trim();
  if (!t) return null;
  // 1) 整段是 JSON 数组
  try { if (extract(JSON.parse(t))) return arr; } catch (e) {}
  // 2) 提取首个 [...] 数组
  try {
    const m = t.match(/\[[\s\S]*\]/);
    if (m && extract(JSON.parse(m[0]))) return arr;
  } catch (e) {}
  // 3) 逐段提取 {...} 对象
  try {
    const re = /\{[\s\S]*?\}/g; let m; const items = [];
    while ((m = re.exec(t)) !== null) { try { items.push(JSON.parse(m[0])); } catch (e) {} }
    if (items.length && extract(items)) return arr;
  } catch (e) {}
  // 4) 兜底：单 bucket 时把整段文字当作该条 action
  if (buckets.length === 1 && t.length < 300) {
    push(buckets[0].key, t, '');
    return arr;
  }
  return arr.length ? arr : null;
}

async function distillActionWithLLM(buckets) {
  const prompt = buildDistillPrompt(buckets);
  // 云优先（质量稳、快），本地 Ollama 兜底（免费、离线）；都失败则返回 null 降级启发式
  const engines = ['deepseek', 'ollama'];
  for (const eng of engines) {
    try {
      const r = await callBgChat(eng, '', [{ role: 'user', content: prompt }]);
      if (r && r.ok && r.text) {
        const parsed = parseDistillResult(r.text, buckets);
        if (parsed) return parsed;
      }
    } catch (e) { /* 换下一个引擎 */ }
  }
  return null;
}

/* ---------------- Agent 跨会话记忆（memory）----------------
 * 对齐 WorkBuddy 的 .workbuddy/memory 思路：每个 agent 一份 markdown 记忆文件，
 * 只存「低频、长期、跨会话有用」的约定 / 决策 / 踩坑 / 进度。
 * 闭环：会话开始 load 注入 system prompt；会话结束 refine 用 LLM 提炼关键条目追加。
 * 记忆文件放 git 仓库 docs/agent-memory/{dir}.md（随 git 走，推 GitHub）。
 */
function agentDirByName(name) {
  // 从 agents.json 反查 agent 的目录名（href 形如 agents/{dir}/index.html）
  const agents = readJson('agents.json', []);
  if (!Array.isArray(agents)) return null;
  const a = agents.find((x) => x && x.name === name);
  if (!a || !a.href) return null;
  const m = String(a.href).match(/agents\/([^/]+)\/index\.html/);
  return m ? m[1] : null;
}

function memoryPath(dir) {
  return path.join(__dirname, 'docs', 'agent-memory', dir + '.md');
}

function readMemory(name) {
  const dir = agentDirByName(name);
  if (!dir) return { ok: false, text: '', reason: 'unknown_agent' };
  try {
    const p = memoryPath(dir);
    if (!fs.existsSync(p)) return { ok: true, dir: dir, text: '' };
    return { ok: true, dir: dir, text: fs.readFileSync(p, 'utf8').slice(0, 6000) };
  } catch (e) {
    return { ok: false, text: '', reason: String(e && e.message || e) };
  }
}

function appendMemory(name, entries) {
  const dir = agentDirByName(name);
  if (!dir || !Array.isArray(entries) || !entries.length) return { ok: false, added: 0 };
  const p = memoryPath(dir);
  try {
    const d = new Date();
    const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const lines = entries.map((e) => '- [' + stamp + '] 【' + (e.kind || '备忘') + '】' + (e.content || ''));
    let body = '';
    if (!fs.existsSync(p)) {
      body = '# ' + name + ' · 跨会话记忆\n\n## 记忆条目\n\n';
    }
    body += lines.join('\n') + '\n';
    fs.appendFileSync(p, body, 'utf8');
    return { ok: true, dir: dir, added: entries.length };
  } catch (e) {
    return { ok: false, added: 0, reason: String(e && e.message || e) };
  }
}

function buildMemoryRefinePrompt(name, userText, assistantText) {
  const lines = [];
  lines.push('你是「Agent 记忆提炼器」。下面是一轮对话：用户在「' + name + '」Agent 里说的话，和 Agent 的回复。');
  lines.push('请判断这轮对话里有没有「值得跨会话记住」的关键信息，有则提炼、无则返回空数组。');
  lines.push('值得记的只有四类：');
  lines.push('①【约定】用户定的长期规矩 / 偏好 / 命名 / 路径 / 格式等约束；');
  lines.push('②【决策】用户拍板的技术 / 方案 / 方向决定；');
  lines.push('③【踩坑】遇到的问题和解决办法；');
  lines.push('④【进度】项目 / 任务推进到哪一步、下一步做什么。');
  lines.push('普通问答、寒暄、一次性请求都【不】值得记。宁缺毋滥：拿不准就不记。');
  lines.push('');
  lines.push('严格输出一个 JSON 数组（没有可记的则输出 []），不要其他文字、不要 markdown 代码块。每项格式：');
  lines.push('{"kind":"约定|决策|踩坑|进度","content":"一句话，具体可执行、自包含（不依赖本轮上下文也能看懂）"}');
  lines.push('');
  lines.push('用户说：' + String(userText || '').replace(/\s+/g, ' ').slice(0, 800));
  lines.push('Agent 回复：' + String(assistantText || '').replace(/\s+/g, ' ').slice(0, 1500));
  return lines.join('\n');
}

function parseMemoryRefineResult(text) {
  const t = String(text || '').trim();
  if (!t) return [];
  let arr = null;
  try { arr = JSON.parse(t); } catch (e) { /* 继续 */ }
  if (!Array.isArray(arr)) {
    try { const m = t.match(/\[[\s\S]*\]/); if (m) arr = JSON.parse(m[0]); } catch (e) { /* 继续 */ }
  }
  if (!Array.isArray(arr)) return [];
  return arr.filter((x) => x && x.content && String(x.content).trim()).map((x) => ({
    kind: ['约定', '决策', '踩坑', '进度'].indexOf(x.kind) >= 0 ? x.kind : '备忘',
    content: String(x.content).trim().slice(0, 300),
  }));
}

async function refineMemoryWithLLM(name, userText, assistantText) {
  const prompt = buildMemoryRefinePrompt(name, userText, assistantText);
  const engines = ['deepseek', 'ollama'];   // 云优先，本地 Ollama 兜底
  for (const eng of engines) {
    try {
      const r = await callBgChat(eng, '', [{ role: 'user', content: prompt }]);
      if (r && r.ok && r.text) return parseMemoryRefineResult(r.text);
    } catch (e) { /* 换下一个引擎 */ }
  }
  return [];
}

/* ---------------- 秘书状态串行化写入 ----------------
 * 根因：runCalendarSync / runIcsSync / runMailSync / runReminderCheck / saveSecretary 等多个
 * async 任务并发「读 secretary.json → 改 → 写」，read-modify-write 非原子，后写者用旧快照
 * 覆盖先写者，导致日历事件 / 邮件 / 手动日程互相覆盖丢失（症状：日历突然没任务）。
 * 修复：用 promise 队列串行化所有对 secretary.json 的读-改-写，杜绝并发覆盖。
 */
let secretaryQueue = Promise.resolve();
function updateSecretary(mutator) {
  const run = secretaryQueue.then(function () {
    const state = readJson('secretary.json', { events: [], emails: [], thoughts: [] });
    const next = mutator(state) || state;
    writeJson('secretary.json', next);
    return next;
  });
  secretaryQueue = run.then(function () {}, function () {});
  return run;
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

let mainWindow = null;   // 主窗口引用（供内嵌 agent 的 BrowserView 挂载）
// 每个 agent 一个 BrowserView，按 href 缓存：切换 agent 只显示/隐藏、不销毁不重载，
// 这样「研究助手在跑 → 切到软件工程 agent」时研究助手的流式请求仍在后台继续，不被 loadFile 打断。
const agentViews = new Map();   // href -> BrowserView
let activeAgentHref = null;     // 当前显示的 agent href（null = 回到工作台首页）
const AGENT_BAR_H = 46;  // 返回条高度，须与 index.html 的 .agent-shell-bar height 一致

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600,
    title: "Ingrid's AI Agents", backgroundColor: '#f7f6f9', show: false,
    webPreferences: Object.assign({ preload: path.join(__dirname, 'preload.js') }, WEB_PREFS),
  });
  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 窗口尺寸变化时重排内嵌 agent 的 BrowserView 边界
  mainWindow.on('resize', () => layoutAgentView());
  mainWindow.on('closed', () => {
    for (const v of agentViews.values()) { try { if (!v.webContents.isDestroyed()) v.webContents.destroy(); } catch { /* 忽略 */ } }
    agentViews.clear();
    activeAgentHref = null;
    mainWindow = null;
  });
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
const CLI_CMDS = { 'claude-code': 'claude', codex: 'codex', grok: 'grok', dsh: 'dsh' };

// 每种 CLI 的非交互调用方式。只用数组参数 spawn，绝不拼 shell 字符串。
const CLI_ADAPTERS = {
  'claude-code': { cmd: 'claude', args: (p) => ['-p', p], timeout: 90000 },
  codex:         { cmd: 'codex', args: (p) => ['exec', p], timeout: 90000 },
  grok:          { cmd: 'grok',  args: (p) => ['-p', p], timeout: 90000 },
  dsh:           { cmd: 'dsh',   args: (p) => ['--profile', 'headless', p], timeout: 300000 },
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
  ollama:   { url: 'http://127.0.0.1:11434/v1/chat/completions',    model: 'qwen3.8:27b',      keyField: null },
  'ollama-review': { url: 'http://127.0.0.1:11434/v1/chat/completions', model: 'deepseek-r1:32b', keyField: null },  // 审稿专用（本地深度推理模型，跨模型对抗）
  'ollama-vision': { url: 'http://127.0.0.1:11434/v1/chat/completions', model: 'qwen2.5vl:7b', keyField: null },   // 识图专用（本地视觉模型，支持图片输入）
};

// 把各家 API 的原始英文报错翻译成可读中文，并附上可执行的下一步（余额不足/Key 无效/限流/超时等）
function friendlyApiError(msg, engine) {
  const m = String(msg || '');
  const e = String(engine || '');
  if (/insufficient\s*balance|balance\s*is?\s*(not\s*enough|insufficient)|402/i.test(m)) {
    return (e === 'deepseek' ? 'DeepSeek' : (e === 'qwen' ? '通义千问/DashScope' : (e === 'gpt' ? 'OpenAI' : '该引擎')))
      + ' 账户余额不足（Insufficient Balance）。请到对应开放平台充值后重试；'
      + (e === 'deepseek' ? '充值地址 https://platform.deepseek.com/usage ；' : '')
      + '如已开本地 Ollama，也可在引擎里切到「本地视觉模型」识图，不花 API 钱。';
  }
  if (/invalid.*(api)?\s*key|authentication|unauthorized|401/i.test(m)) {
    return 'API Key 无效或已失效，请到「引擎设置」重新填写 ' + (e || '对应引擎') + ' 的 Key。';
  }
  if (/rate\s*limit|too\s*many\s*requests|429/i.test(m)) return '请求频率超限（Rate Limit），请稍等片刻再试。';
  return m;
}

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
  // 内嵌 agent 的 BrowserView 也收广播（如研究助手监听 calendar:reminder）——发给所有已打开的 agent
  for (const view of agentViews.values()) {
    try { if (view && !view.webContents.isDestroyed()) view.webContents.send(channel, data); } catch { /* 忽略 */ }
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
  // 合并进 secretary.json：移除旧的同步事件（id 以 cal- 开头），写入新事件，保留手动事件。
  // 用串行化队列写入，避免与 ICS/邮件同步并发覆盖（根因修复：日历突然没任务的元凶）
  await updateSecretary(function (state) {
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
    return { events: merged, emails: state.emails || [], thoughts: state.thoughts || [] };
  });
  const summary = { results: results, total: allEvents.length, syncedAt: Date.now() };
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
  // 顺带清掉该订阅同步进来的日程（串行化写入，避免并发覆盖）
  updateSecretary(function (state) {
    const others = (Array.isArray(state.events) ? state.events : []).filter(function (e) { return !String(e.id).startsWith('ics-' + id + '-'); });
    return { events: others, emails: state.emails || [], thoughts: state.thoughts || [] };
  });
  return listIcsFeeds();
}

/** 简单字符串 hash（djb2）→ 短 hex，用于构造稳定的 ICS 事件 id */
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
  return (h >>> 0).toString(36);
}

/**
 * 同 UID 的多个 VEVENT 折叠（借鉴 calendiff/ics 的思路：Events sharing a UID are
 * folded into a single Event）。Outlook/Exchange 在会议被改期（reschedule）后，其 ICS
 * 快照里常残留「旧时间」与「新时间」两条同 UID、无 RECURRENCE-ID 的 VEVENT，若不去重
 * 就会在日历里出现一模一样的重复日程。规则：
 *   · 无 RECURRENCE-ID 的多条 = 同一事件的多个版本 → 按 SEQUENCE 取最新（默认 0，越大越新）；
 *     同 SEQUENCE 再比 DTSTAMP / LAST-MODIFIED，再兜底取靠后的。
 *   · 有 RECURRENCE-ID 的 = 重复系列的实例级覆盖（每个对应不同实例）→ 保留。
 */
function dedupeEventsByUid(events) {
  const byUid = new Map();
  const noUid = [];
  events.forEach(function (ev) {
    const uid = String(ev.uid || '').trim();
    if (!uid) { noUid.push(ev); return; }
    if (!byUid.has(uid)) byUid.set(uid, []);
    byUid.get(uid).push(ev);
  });
  const out = [];
  byUid.forEach(function (list) {
    const overrides = list.filter(function (e) { return e.recurrenceId; });
    let masters = list.filter(function (e) { return !e.recurrenceId; });
    if (masters.length > 1) {
      // 记录原始相对顺序：SEQUENCE / DTSTAMP 都区分不了时，取靠后的（新版本通常在 feed 末尾）
      masters.forEach(function (e, i) { e._i = i; });
      masters.sort(function (a, b) {
        if ((b.sequence || 0) !== (a.sequence || 0)) return (b.sequence || 0) - (a.sequence || 0);
        const dt = String(b.dtstamp || b.lastModified || '').localeCompare(String(a.dtstamp || a.lastModified || ''));
        if (dt !== 0) return dt;
        return (b._i || 0) - (a._i || 0);
      });
      masters = masters.slice(0, 1);
    }
    out.push.apply(out, masters);
    out.push.apply(out, overrides);
  });
  return out.concat(noUid);
}

/** 归一化标题用于匹配：去 Re:/Fwd:/回复:/转发: 前缀、压空白、转小写 */
function normSubjectForMatch(s) {
  return String(s || '')
    .replace(/^(re|fw|fwd|回复|转发|答复)\s*[:：]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** 检测「会议改期」：RECURRENCE-ID 例外且非取消 = 时间被改，写入 meeting-changes.json */
function detectMeetingChanges(allEvents) {
  const changes = [];
  (Array.isArray(allEvents) ? allEvents : []).forEach(function (ev) {
    if (!ev.recurrenceId) return;
    const st = String(ev.status || '').toUpperCase();
    if (st === 'CANCELLED' || /^cancell?ed\b/i.test(String(ev.title || ''))) return;
    if (!ev.at || ev.recurrenceId === ev.at) return;
    changes.push({
      uid: ev.uid || '',
      title: ev.title || '',
      oldTime: ev.recurrenceId,
      newTime: ev.at,
      source: ev._feedName || 'ICS 订阅',
      detectedAt: Date.now(),
    });
  });
  if (changes.length) writeJson('meeting-changes.json', { changes: changes });
  return changes;
}

/** 检查「会议改期」是否已回复；未回复则发秘书提醒（去重，避免重复打扰） */
function runMeetingChangeCheck() {
  const changes = readJson('meeting-changes.json', { changes: [] }).changes || [];
  if (!changes.length) return { reminded: 0 };
  const state = readJson('secretary.json', { emails: [] });
  const emails = Array.isArray(state.emails) ? state.emails : [];
  const sent = emails.filter(function (m) { return m.dir === 'sent'; });
  const reminded = readJson('meeting-reminded.json', { keys: [] }).keys || [];
  const toNotify = [];

  changes.forEach(function (ch) {
    const key = hashStr(String(ch.uid || '') + '|' + String(ch.newTime || '') + '|' + String(ch.oldTime || ''));
    if (reminded.indexOf(key) >= 0) return;   // 已提醒过，不再打扰
    const nt = normSubjectForMatch(ch.title);
    if (!nt) return;
    // 发件箱里最近 30 天有「同主题」的回复 = 已回复，跳过
    const replied = sent.some(function (m) {
      const ms = normSubjectForMatch(m.subject);
      if (!ms) return false;
      if (ms.indexOf(nt) < 0 && nt.indexOf(ms) < 0) return false;
      const mt = new Date(m.at).getTime();
      return isFinite(mt) && mt >= Date.now() - 30 * 86400000;
    });
    if (replied) { reminded.push(key); return; }   // 已回复，记录并跳过
    toNotify.push(ch);
    reminded.push(key);
  });

  writeJson('meeting-reminded.json', { keys: reminded });
  toNotify.forEach(function (ch) {
    const body = '「' + (ch.title || '会议') + '」时间由 ' + fmtDateTime(ch.oldTime) + ' 改为 ' + fmtDateTime(ch.newTime) + '，你似乎还没回复，记得确认。';
    try { if (Notification.isSupported()) new Notification({ title: '📅 会议改期待确认', body: body }).show(); } catch (e) { /* 通知失败不阻断 */ }
  });
  if (toNotify.length) broadcast('meeting-change:remind', toNotify);
  return { reminded: toNotify.length };
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
  // 同 UID 折叠：改期残留的「旧时间 + 新时间」两条 VEVENT 只留最新版本，避免重复日程
  allEvents = dedupeEventsByUid(allEvents);

  // 检测「会议改期」（RECURRENCE-ID 例外），供秘书判断是否已回复并提醒
  detectMeetingChanges(allEvents);

  // 展开重复事件：母事件 + RRULE 实例；跳过已取消（Canceled）的实例
  const canceledKeys = new Set();
  allEvents.forEach(function (ev) {
    const st = String(ev.status || '').toUpperCase();
    const t = String(ev.title || '').trim();
    if (st === 'CANCELLED' || /^cancell?ed\b/i.test(t)) {
      canceledKeys.add((ev.uid || '') + '|' + String(ev.at || ''));
    }
  });
  // 收集「例外实例」覆盖的旧实例：RECURRENCE-ID 指向被改期/取消的原始实例时间，
  // 展开母事件 RRULE 时须跳过这些旧实例、只保留例外本身的新时间（修复改期后日历重复）
  const overrideKeys = new Set();
  allEvents.forEach(function (ev) {
    if (ev.recurrenceId) overrideKeys.add((ev.uid || '') + '|' + String(ev.recurrenceId));
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
        if (canceledKeys.has((ev.uid || '') + '|' + atIso)) return;    // 被取消的实例跳过
        if (overrideKeys.has((ev.uid || '') + '|' + atIso)) return;    // 被改期例外覆盖的旧实例跳过
        const endIso = dur > 0 ? new Date(inst.getTime() + dur).toISOString() : '';
        expanded.push(Object.assign({}, ev, { at: atIso, end: endIso }));
      });
    }
  });

  // 合并：移除旧的 ics- 订阅事件，写入新事件；保留 cal-/手动/导入事件；继承 reminded/done 防重复提醒。
  // 用串行化队列写入，避免与账户日历同步并发覆盖（根因修复）
  let syncedCount = 0;
  await updateSecretary(function (state) {
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
    syncedCount = synced.length;
    const merged = others.concat(synced);
    merged.sort(function (a, b) { return String(a.at || '').localeCompare(String(b.at || '')); });
    return { events: merged, emails: state.emails || [], thoughts: state.thoughts || [] };
  });
  const summary = { results: results, total: syncedCount, syncedAt: Date.now() };
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
    await updateSecretary(function (state) {
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
      return { events: list, emails: state.emails || [], thoughts: state.thoughts || [] };
    });
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
  const fired = [];
  // 用串行化队列读-改-写，避免与日历/邮件同步并发覆盖（根因修复）
  updateSecretary(function (state) {
    const events = Array.isArray(state.events) ? state.events : [];
    const now = Date.now();
    for (const ev of events) {
      if (ev.done || ev.reminded || !ev.at) continue;
      const lead = Number(ev.reminderMin) || 0;
      const at = new Date(ev.at).getTime();
      if (!isFinite(at)) continue;
      // 到点：now >= at - lead（lead=0 表示到了当天/当时才提醒）
      if (now < at - lead * 60000) continue;
      ev.reminded = true;
      fired.push(ev);
    }
    return state;  // 已原地标记 reminded
  }).then(function () {
    // 通知展示放队列外，避免阻塞后续写入
    fired.forEach(function (ev) {
      const c = categoryOf(ev.category);
      const lead = Number(ev.reminderMin) || 0;
      const at = new Date(ev.at).getTime();
      const title = c.emoji + ' ' + (ev.title || '研究日程提醒');
      const body = fmtDateTime(at) + ' · ' + c.label + (lead > 0 ? '（' + fmtLead(lead) + '提醒）' : '') +
        (ev.location ? ' · 📍 ' + ev.location : '');
      try { if (Notification.isSupported()) new Notification({ title: title, body: body }).show(); } catch (e) { /* 通知失败不阻断 */ }
    });
    if (fired.length) broadcast('calendar:reminder', fired);
  }).catch(function () {});
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
    .filter(function (e) { var t = new Date(e.at).getTime(); return isFinite(t) && t >= Date.now() && t <= horizon; })
    .sort(function (a, b) { return String(a.at).localeCompare(String(b.at)); });
}

/* ---------------- 邮箱同步：Outlook（Microsoft Graph） ---------------- */
async function runMailSync() {
  const accounts = decryptSyncAccounts().filter(function (a) { return a.type === 'microsoft'; });
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
  // 通道 2：Apple Mail（macOS「邮件」App 里的剑桥邮箱，读收件箱 + 发件箱，用于判断改期邮件是否已回复）
  if (process.platform === 'darwin') {
    let am = null;
    try { am = await readAppleMail(); } catch (e) { am = { ok: false, error: String(e && e.message || e) }; }
    if (am && am.ok && Array.isArray(am.mails) && am.mails.length) {
      am.mails.forEach(function (m, i) {
        allEmails.push({
          id: 'msmail-apple-' + hashStr(String(m.at || '') + '|' + String(m.subject || '') + '|' + String(m.from || '') + '|' + i),
          from: m.from || '',
          fromName: '',
          subject: m.subject || '（无主题）',
          body: String(m.body || '').slice(0, 500),
          at: m.at || '',
          read: true,
          link: '',
          source: 'Apple 邮件',
          dir: m.dir === 'sent' ? 'sent' : 'inbox',
        });
      });
      results.push({ id: 'apple-mail', name: 'Apple 邮件', ok: true, count: am.mails.length, error: '' });
    } else {
      results.push({ id: 'apple-mail', name: 'Apple 邮件', ok: false, count: 0, error: (am && am.error) || '未读到剑桥邮箱邮件' });
    }
  }
  // 所有通道都没读到邮件 → 跳过合并，避免清空已有数据
  if (!allEmails.length) {
    const summary = { results: results, total: 0, skipped: true, syncedAt: Date.now() };
    broadcast('mail:synced', summary);
    return summary;
  }
  // 合并进 secretary.json：移除旧的同步邮件（id 以 msmail- 开头），写入新邮件（自动分类），保留手动导入。
  // 用串行化队列写入，避免与日历同步并发覆盖（根因修复）
  const totalEmails = allEmails.length;
  await updateSecretary(function (state) {
    const manual = (Array.isArray(state.emails) ? state.emails : []).filter(function (m) { return !String(m.id).startsWith('msmail-'); });
    const classified = allEmails.map(function (m) {
      const c = (SecretaryCore && SecretaryCore.classifyEmail) ? SecretaryCore.classifyEmail(m) : { category: 'general', importance: 1, important: false };
      return Object.assign({}, m, { category: c.category, importance: c.importance, important: c.important });
    });
    const merged = manual.concat(classified);
    merged.sort(function (a, b) { return String(b.at || '').localeCompare(String(a.at || '')); });
    return { events: state.events || [], emails: merged, thoughts: state.thoughts || [] };
  });
  const summary = { results: results, total: totalEmails, syncedAt: Date.now() };
  broadcast('mail:synced', summary);
  // 邮件同步完 → 检查会议改期是否已回复，未回复则发秘书提醒（幂等 + 去重）
  try { runMeetingChangeCheck(); } catch (e) { /* 检查失败不阻断邮件同步 */ }
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
  dsh: { in: 0.28, out: 0.42 },
  deepseek: { in: 0.15, out: 0.60 },          // deepseek-flash off-peak（默认、最便宜的 Agent 模型）
  'deepseek-flash': { in: 0.15, out: 0.60 },
  'deepseek-v4-pro': { in: 0.66, out: 1.98 },  // v4-pro off-peak（深度推理专用，输出价是 flash 的 3.3 倍）
  gpt: { in: 2, out: 10 }, qwen: { in: 0.4, out: 1.2 },
  'local-llm': { in: 0, out: 0 }, funasr: { in: 0, out: 0 },
};
function costOf(engine, tin, tout, model) {
  const p = PRICES[model] || PRICES[engine] || { in: 0, out: 0 };
  return ((tin * p.in) + (tout * p.out)) / 1e6;
}
function approxTokens(s) { return Math.ceil(String(s || '').length / 4); }

/* ---------------- API 余额监控（余额查询 + 用量汇总 + 低余额提醒） ----------------
 * 参考开源范式：
 *   - DeepSeek 官方余额接口 GET /user/balance（api-docs.deepseek.com/api/get-user-balance）
 *   - river291/display-api-balance：低余额阈值变红（默认 ¥20）
 *   - Rannist/balance-dsh：用「充值额 - 余额」反推总消费，再减工作台用量得「其他用量」
 *   - dsh-cost-meter / TokenBar：多供应商余额 + 预算提醒
 * 说明：仅 DeepSeek 有简单公开余额接口（auto）；GPT(OpenAI)/Qwen(DashScope) 无公开余额
 *       接口，余额需手动填写（manual），「其他用量」仅 DeepSeek 可自动反推。
 */
const BALANCE_FILE = 'api-balance.json';
const USD_TO_CNY = 7.2;   // 工作台成本按 USD 记账（PRICES），展示按 ¥ 近似换算

const BILLING_META = {
  deepseek: { name: 'DeepSeek', currency: 'CNY', symbol: '¥', auto: true,  defaultThreshold: 20 },
  gpt:      { name: 'GPT / OpenAI', currency: 'USD', symbol: '$', auto: true,  defaultThreshold: 5 },
  qwen:     { name: 'Qwen / 通义万相', currency: 'CNY', symbol: '¥', auto: true, defaultThreshold: 20 },
};

function readBalanceState() {
  const s = readJson(BALANCE_FILE, { balances: {}, thresholds: {}, lastAlert: {}, errors: {} });
  if (!s.balances) s.balances = {};
  if (!s.thresholds) s.thresholds = {};
  if (!s.lastAlert) s.lastAlert = {};
  if (!s.errors) s.errors = {};
  return s;
}
function writeBalanceState(s) { writeJson(BALANCE_FILE, s); }

function balanceThreshold(engine) {
  const s = readBalanceState();
  const t = s.thresholds[engine];
  return (t != null && t !== '') ? Number(t) : (BILLING_META[engine] || {}).defaultThreshold;
}

async function queryDeepSeekBalance() {
  const settings = decryptSettings(readSettingsRaw());
  const key = settings.deepseek;
  if (!key) return { ok: false, error: '未配置 DeepSeek API Key' };
  const resp = await fetch('https://api.deepseek.com/user/balance', {
    headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' },
  });
  if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
  const j = await resp.json();
  const infos = Array.isArray(j.balance_infos) ? j.balance_infos : [];
  const cny = infos.find((b) => b.currency === 'CNY') || infos[0] || {};
  return {
    ok: true,
    isAvailable: !!j.is_available,
    currency: String(cny.currency || 'CNY'),
    totalBalance: Number(cny.total_balance) || 0,
    grantedBalance: Number(cny.granted_balance) || 0,
    toppedUpBalance: Number(cny.topped_up_balance) || 0,
  };
}

/* OpenAI 余额：官方没有公开余额接口。未公开端点 /v1/dashboard/billing/credit_grants
 * 返回 total_granted / total_used / total_available；部分账号/组织用普通 API Key 仍可读，
 * 部分已被收紧为「必须浏览器会话 key（sess-…，数天过期）」。据此做 best-effort 查询，
 * 失败则明确降级到手动填写。 */
async function queryOpenAiBalance() {
  const settings = decryptSettings(readSettingsRaw());
  const key = settings.gpt;
  if (!key) return { ok: false, error: '未配置 OpenAI API Key' };
  try {
    const resp = await fetch('https://api.openai.com/v1/dashboard/billing/credit_grants', {
      headers: { 'Authorization': 'Bearer ' + key, 'Accept': 'application/json' },
    });
    if (!resp.ok) {
      let txt = '';
      try { txt = await resp.text(); } catch { /* 忽略 */ }
      const needSession = /session key|session key required/i.test(txt);
      return {
        ok: false,
        error: needSession
          ? 'OpenAI 已禁止用 API Key 查余额（需浏览器会话 key，数天过期）'
          : 'OpenAI 未开放余额接口（HTTP ' + resp.status + '）',
      };
    }
    const j = await resp.json();
    const available = Number(j.total_available);
    if (!isFinite(available)) return { ok: false, error: '余额响应格式异常' };
    return {
      ok: true, currency: 'USD', totalBalance: available,
      totalGranted: Number(j.total_granted) || 0, totalUsed: Number(j.total_used) || 0,
    };
  } catch (e) {
    return { ok: false, error: '查询 OpenAI 余额失败：' + String((e && e.message) || e) };
  }
}

/* Qwen / 通义·百炼 余额：
 *   - 官方百炼/DashScope 的 sk- key 没有任何余额接口（真金白银在阿里云账户里）。
 *   - 有阿里云 AccessKey（AK/SK）→ 走 BSS QueryAccountBalance 拿真实可用余额（¥）。
 *   - 仅 sk- key（Token Plan 套餐 sk-sp-…）→ 尝试 token-plan/balance 读 Credits 余额。
 *   - 都没有 → 引导手动填写 / 补 AccessKey。 */
async function queryQwenBalance() {
  const settings = decryptSettings(readSettingsRaw());
  const ak = settings.qwenAk;
  const aksk = settings.qwenSk;
  if (ak && aksk) {
    return queryAliyunBalance(ak, aksk);
  }
  const sk = settings.qwen;
  if (sk) {
    try {
      const resp = await fetch('https://dashscope.aliyuncs.com/api/v1/token-plan/balance', {
        headers: { 'Authorization': 'Bearer ' + sk, 'Accept': 'application/json' },
      });
      if (resp.ok) {
        const j = await resp.json();
        const d = (j && j.data && typeof j.data === 'object') ? j.data : (j || {});
        const bal = Number(d.available != null ? d.available : (d.balance != null ? d.balance : (d.credits != null ? d.credits : d.remaining)));
        if (isFinite(bal)) return { ok: true, currency: 'CNY', totalBalance: bal, via: 'token-plan' };
      }
      return { ok: false, error: '百炼 sk- key 无余额接口（Token Plan 套餐除外）' };
    } catch (e) {
      return { ok: false, error: '查询通义余额失败：' + String((e && e.message) || e) };
    }
  }
  return { ok: false, error: '未配置通义 API Key / 阿里云 AccessKey' };
}

/* 阿里云 BSS QueryAccountBalance（真实账户余额），用 ACS3-HMAC-SHA256（SigV3）签名。
 * 参考 ragflow PR #15567：sk- key 不能当 AccessKey，BSS 需 AccessKey ID/Secret 单独签名。 */
function aliyunPctEnc(s) {
  return encodeURIComponent(String(s)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}
async function queryAliyunBalance(ak, aksk) {
  const host = 'business.aliyuncs.com';
  const action = 'QueryAccountBalance';
  const version = '2017-12-14';
  const query = { Action: action, Version: version, Format: 'JSON', RegionId: 'cn-hangzhou' };
  const qs = Object.keys(query).sort()
    .map((k) => aliyunPctEnc(k) + '=' + aliyunPctEnc(query[k]))
    .join('&');
  const now = new Date();
  const xAcsDate = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const nonce = crypto.randomBytes(16).toString('hex');
  const body = '';
  const contentSha = crypto.createHash('sha256').update(body).digest('hex');

  const headers = {
    'host': host,
    'x-acs-action': action,
    'x-acs-version': version,
    'x-acs-date': xAcsDate,
    'x-acs-signature-nonce': nonce,
    'x-acs-content-sha256': contentSha,
  };
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((n) => n + ':' + String(headers[n]).trim() + '\n').join('');
  const signedHeaders = signedNames.join(';');
  const canonicalRequest = 'GET\n' + '/\n' + qs + '\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + contentSha;
  const hashedCanonical = crypto.createHash('sha256').update(canonicalRequest, 'utf8').digest('hex');
  const stringToSign = 'ACS3-HMAC-SHA256\n' + hashedCanonical;
  const signature = crypto.createHmac('sha256', aksk).update(stringToSign, 'utf8').digest('hex');
  const authorization = 'ACS3-HMAC-SHA256 Credential=' + ak + ',SignedHeaders=' + signedHeaders + ',Signature=' + signature;

  const url = 'https://' + host + '/?' + qs;
  try {
    const resp = await fetch(url, { headers: Object.assign({}, headers, { Authorization: authorization }) });
    if (!resp.ok) return { ok: false, error: '阿里云 BSS HTTP ' + resp.status };
    const j = await resp.json();
    if (j && j.Success === false) return { ok: false, error: '阿里云 BSS 错误：' + (j.Message || j.Code || '未知') };
    const d = (j && j.Data) || {};
    const bal = Number(d.AvailableAmount != null ? d.AvailableAmount : d.AvailableCashAmount);
    if (!isFinite(bal)) return { ok: false, error: '阿里云余额响应格式异常' };
    return { ok: true, currency: String(d.Currency || 'CNY'), totalBalance: bal, via: 'bss' };
  } catch (e) {
    return { ok: false, error: '查询阿里云余额失败：' + String((e && e.message) || e) };
  }
}

// 用量汇总：按 engine 聚合（本月 / 累计）+ 近 30 天按天成本
function usageSummary() {
  const rows = listUsage();
  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  const perEngine = {};
  const days = {};
  const dayLabels = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000);
    const key = d.toISOString().slice(0, 10);
    dayLabels.push(key);
    days[key] = 0;
  }
  let totalCost = 0, totalIn = 0, totalOut = 0;
  rows.forEach(function (r) {
    const eng = String(r.engine || 'other');
    if (!perEngine[eng]) perEngine[eng] = { engine: eng, monthIn: 0, monthOut: 0, monthCost: 0, allIn: 0, allOut: 0, allCost: 0, calls: 0 };
    const e = perEngine[eng];
    const tin = Number(r.tokensIn) || 0, tout = Number(r.tokensOut) || 0, cost = Number(r.cost) || 0;
    e.allIn += tin; e.allOut += tout; e.allCost += cost; e.calls += 1;
    if ((r.month || '') === thisMonth) { e.monthIn += tin; e.monthOut += tout; e.monthCost += cost; }
    if (days[r.day] != null) days[r.day] += cost;
    totalCost += cost; totalIn += tin; totalOut += tout;
  });
  return { perEngine, days, dayLabels, thisMonth, totalCost, totalIn, totalOut, calls: rows.length };
}

// 组装仪表盘完整数据（各家余额 + 用量 + 阈值 + 低余额标记）
async function buildBillingDashboard() {
  const state = readBalanceState();
  const summary = usageSummary();
  const settings = decryptSettings(readSettingsRaw());
  const engines = {};
  for (const id of Object.keys(BILLING_META)) {
    const meta = BILLING_META[id];
    const bal = state.balances[id] || {};
    const usage = summary.perEngine[id] || { monthCost: 0, allCost: 0, monthIn: 0, monthOut: 0, calls: 0 };
    const threshold = balanceThreshold(id);
    let other = null;   // 其他用量（仅 DeepSeek 可自动反推）
    if (id === 'deepseek' && typeof bal.totalBalance === 'number' && typeof bal.grantedBalance === 'number' && typeof bal.toppedUpBalance === 'number') {
      const totalConsumedCny = bal.grantedBalance + bal.toppedUpBalance - bal.totalBalance;
      const workbenchCny = usage.allCost * USD_TO_CNY;
      other = Math.max(0, totalConsumedCny - workbenchCny);
    }
    engines[id] = {
      engine: id, name: meta.name, symbol: meta.symbol, currency: meta.currency,
      auto: meta.auto,
      hasKey: id === 'qwen'
        ? !!(settings[id] || (settings.qwenAk && settings.qwenSk))
        : !!settings[id],
      threshold: threshold,
      balance: (typeof bal.balance === 'number') ? bal.balance : null,
      totalBalance: bal.totalBalance, grantedBalance: bal.grantedBalance, toppedUpBalance: bal.toppedUpBalance,
      manual: !!bal.manual, updatedAt: bal.updatedAt || 0,
      low: (typeof bal.balance === 'number') && threshold > 0 && bal.balance <= threshold,
      otherUsageCny: other,
      via: bal.via || null,
      error: (state.errors && state.errors[id] && state.errors[id].message) || null,
      monthCostUsd: usage.monthCost, allCostUsd: usage.allCost,
      monthIn: usage.monthIn, monthOut: usage.monthOut, calls: usage.calls,
    };
  }
  return { engines, summary, updatedAt: Date.now() };
}

// 拉取各家余额 + 低余额检查（供 IPC 刷新与定时器共用）
async function refreshBalanceAndAlert() {
  const state = readBalanceState();
  const settings = decryptSettings(readSettingsRaw());
  const queries = {
    deepseek: { run: queryDeepSeekBalance, hasCred: () => !!settings.deepseek },
    gpt:      { run: queryOpenAiBalance,   hasCred: () => !!settings.gpt },
    qwen:     { run: queryQwenBalance,     hasCred: () => !!(settings.qwen || (settings.qwenAk && settings.qwenSk)) },
  };
  const results = {};
  for (const id of Object.keys(queries)) {
    if (!queries[id].hasCred()) {
      results[id] = { ok: false, error: '未配置 ' + (BILLING_META[id] || {}).name + ' 凭据' };
      continue;
    }
    let r;
    try { r = await queries[id].run(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    results[id] = r;
    if (r.ok) {
      const b = {
        balance: r.totalBalance, currency: r.currency,
        totalBalance: r.totalBalance, grantedBalance: r.grantedBalance,
        toppedUpBalance: r.toppedUpBalance, updatedAt: Date.now(), auto: true,
      };
      if (r.via) b.via = r.via;
      state.balances[id] = b;
      state.errors[id] = null;
    } else {
      state.errors[id] = { message: r.error, at: Date.now() };
    }
  }
  writeBalanceState(state);
  const alerts = checkLowBalance();
  return { results: results, alerts: alerts };
}

// 低余额检查 + 系统通知（去重：仅在「跌破阈值」或「余额继续下降」时提醒，且 24h 内不重复）
function checkLowBalance() {
  const state = readBalanceState();
  const alerts = [];
  for (const id of Object.keys(BILLING_META)) {
    const meta = BILLING_META[id];
    const threshold = balanceThreshold(id);
    if (!threshold || threshold <= 0) continue;
    const b = state.balances[id] || {};
    if (typeof b.balance !== 'number') continue;
    if (b.balance > threshold) continue;   // 未低于阈值
    const last = state.lastAlert[id] || {};
    if (typeof last.balance === 'number' && b.balance >= last.balance && (Date.now() - (last.at || 0)) < 24 * 3600 * 1000) continue;
    alerts.push({ engine: id, name: meta.name, symbol: meta.symbol, balance: b.balance, threshold: threshold });
    state.lastAlert[id] = { balance: b.balance, at: Date.now() };
  }
  if (alerts.length) {
    writeBalanceState(state);
    for (const a of alerts) {
      try {
        if (Notification.isSupported()) {
          new Notification({
            title: '⚠️ API 余额不足提醒',
            body: a.name + ' 余额仅剩 ' + a.symbol + a.balance.toFixed(2) + '（阈值 ' + a.symbol + a.threshold + '），请及时充值。',
          }).show();
        }
      } catch (e) { /* 通知失败不阻断 */ }
    }
  }
  return alerts;
}

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
      body: JSON.stringify(Object.assign(
        { model: cfg.model, messages, max_tokens: maxTokensForModel(cfg.model, false) },
        thinkingControl(cfg.model, {})   // 单轮 agent 执行默认关闭思考，省 token
      )),
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
      cost: costOf(engine, tin, tout, cfg.model), costSource: 'estimated', status: 'ok', dryRun: false, error: '' };
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

/* ---------------- IPC：知识沉淀官（经验沉淀）---------------- */
ipcMain.handle('settler:report', () => getKnowledgeSettler().report());
ipcMain.handle('settler:proposals', (_e, status) => getKnowledgeSettler().proposals(status));
ipcMain.handle('settler:library', () => getKnowledgeSettler().state.library);
ipcMain.handle('settler:approve', (_e, id, opts) => {
  const settler = getKnowledgeSettler();
  const p = settler.proposals().find((x) => x.id === id || x.fingerprint === id);
  const res = settler.approve(id, opts);
  // 桥：methodology 入库后同步写 Obsidian 主库「经验沉淀/」（approve 即人工在环，符合铁律）
  if (p && res && !res.error) {
    const cat = (opts && opts.category) || p.category;
    if (cat === 'methodology' || cat === 'both') {
      res.obsidian = syncLessonToObsidian(p);
    }
  }
  scheduleApprovalsRefresh();
  return res;
});
ipcMain.handle('settler:ignore', (_e, id) => { const r = getKnowledgeSettler().ignore(id); scheduleApprovalsRefresh(); return r; });
ipcMain.handle('settler:submit', (_e, item) => { const r = getKnowledgeSettler().submit(item); scheduleApprovalsRefresh(); return r; });
ipcMain.handle('settler:suggest', (_e, q) => getKnowledgeSettler().suggestFor(q));
/* ---------------- 知识沉淀官 · 自动发现（sleep-time 巡逻 + 重要性打分）----------------
 * 把 runOnce 从「被动等人喂」升级为「定时自扫任务队列已解决项 → 启发式重要性打分 →
 * 低于阈值跳过（防噪音）→ 带证据锚生成提案（仍停在 pending_approval，人工在环不变）。
 * 打分零 LLM 成本：结果充实度 + 目标可追溯 + 多轮 + 方法论信号词命中。 */
const METHOD_SIGNALS = ['根因', '修复', '诊断', '兜底', '降级', '对齐', '幂等', '重试', '超时', '缓存', '竞态', '校准', '错位', '偏移', '断点'];
// 内容型/调研型任务（灵感目录、生态雷达、日报周报、采集舆情等）产出的是「资讯」而非「问题→根因→修复」教训，
// 自动发现一律跳过，避免把日报/调研报告误当经验提案污染待审批队列（「诊断」这类词会出现在插件简介里，靠信号词拦不住）。
const NON_LESSON_RE = /灵感目录|生态雷达|eco-?radar|每日调研|生态调研|日报|周报|采集|舆情|盘点|巡检/;
function extractRootCause(text) {
  const s = String(text || '');
  const m = s.match(/(?:根因|根本原因|原因|root\s*cause)\s*[:：]\s*([^\n。]{4,120})/i);
  return m ? m[1].trim() : '';
}
function collectDiscoveryItems() {
  const done = getTaskQueue().list('done');
  const items = [];
  let scanned = 0, scored = 0;
  done.forEach((t) => {
    scanned++;
    // 内容型/调研型任务跳过：不是教训，沉淀只会污染经验库
    if (NON_LESSON_RE.test((t.agent || '') + ' ' + (t.category || '') + ' ' + (t.title || ''))) return;
    const result = String(t.result || '').trim();
    const goal = String(t.goal || '').trim();
    let score = 0;
    if (result.length >= 20) score += 2; else if (result.length > 0) score += 1;
    if (goal.length >= 10) score += 1;
    if ((t.round || 0) >= 2) score += 1;
    const text = (t.title + ' ' + result + ' ' + (t.category || '')).toLowerCase();
    const hits = METHOD_SIGNALS.filter((w) => text.indexOf(w) >= 0).length;
    score += Math.min(hits, 2);
    if (score < 4) return; // 低于阈值：当作噪音，不沉淀
    scored++;
    items.push({
      source: 'auto-discovery',
      rule: t.category || t.agent || t.title || '',
      title: t.title || '已完成任务',
      evidence: 'task:' + (t.id || '') + ' @ ' + (t.updatedAt || t.createdAt || '') + (goal ? ' · ' + goal : ''),
      rootCause: extractRootCause(result),
      fixApproach: result,
      _score: score,
    });
  });
  return { items, scanned, scored };
}
// 自愈：把历史上被自动发现误抓为「经验提案」的内容型/调研型任务提案标记为忽略，清出待审批队列。
function purgeNonLessonProposals() {
  try {
    const settler = getKnowledgeSettler();
    settler.proposals('pending_approval').forEach((p) => {
      if (p.source === 'auto-discovery' && NON_LESSON_RE.test((p.rule || '') + ' ' + (p.title || ''))) {
        settler.ignore(p.id);
      }
    });
  } catch { /* 忽略 */ }
}
function runSettlerDiscovery() {
  try {
    purgeNonLessonProposals();
    const { items, scanned, scored } = collectDiscoveryItems();
    const r = getKnowledgeSettler().runOnce(items);
    const report = { scanned, scored, consumed: r.consumed, created: r.created, pending_approval: r.pending_approval, generated_at: new Date().toISOString() };
    writeJson('settler-discovery-report.json', report);
    if (r.created > 0) {
      try {
        if (Notification.isSupported()) new Notification({ title: '知识沉淀官 · 自动发现 ' + r.created + ' 条新经验', body: '已生成待审批提案，去经验沉淀面板审阅' }).show();
      } catch (e) { /* 通知失败不阻断 */ }
      broadcast('settler:discovered', report);
    }
    scheduleApprovalsRefresh();
    return report;
  } catch (e) {
    const err = { error: String(e && e.message || e), generated_at: new Date().toISOString() };
    writeJson('settler-discovery-report.json', err);
    return err;
  }
}
// 手动触发（面板按钮）与定时巡逻共用同一入口，保持打分/证据锚规则一致
ipcMain.handle('settler:run-once', () => runSettlerDiscovery());
ipcMain.handle('settler:discover', () => runSettlerDiscovery());
ipcMain.handle('settler:discovery-report', () => readJson('settler-discovery-report.json', null));

/* ---------------- IPC：情绪/偏好 Agent（侦测评价情绪 → 提炼偏好 → 联动经验沉淀）---------------- */
ipcMain.handle('sentiment:report', () => getSentimentAgent().report());
ipcMain.handle('sentiment:signals', (_e, limit, valence) => getSentimentAgent().signals(limit, valence));
ipcMain.handle('sentiment:preferences', (_e, agent) => getSentimentAgent().preferences(agent));
ipcMain.handle('sentiment:guidance', (_e, agent) => getSentimentAgent().guidance(agent));
// 侦测 + 记录一条情绪/评价信号（valence 可省，省略则走词典侦测，中性不记录）
ipcMain.handle('sentiment:observe', (_e, raw) => getSentimentAgent().observe(raw));
// 手动/自动提炼：把信号聚合成偏好规则，新偏好自动提交经验沉淀官（待审批）
ipcMain.handle('sentiment:distill', () => getSentimentAgent().distill());
// 手动编辑偏好规则（可视化面板里改方向/场景/Agent/做法文案/信心度）
ipcMain.handle('sentiment:update-preference', (_e, id, patch) => getSentimentAgent().updatePreference(id, patch));
// 手动删除偏好规则（默认级联删除该 key 的残留信号，避免蒸馏复活）
ipcMain.handle('sentiment:remove-preference', (_e, id, opts) => getSentimentAgent().removePreference(id, opts));

/* ---------------- IPC：Agent 跨会话记忆（load 注入 / refine 自动沉淀）---------------- */
ipcMain.handle('memory:load', (_e, name) => readMemory(String(name || '')));
ipcMain.handle('memory:refine', async (_e, name, payload) => {
  const p = payload || {};
  const userText = String(p.user || '');
  const assistantText = String(p.assistant || '');
  if (!userText && !assistantText) return { ok: false, added: 0, reason: 'empty' };
  const entries = await refineMemoryWithLLM(String(name || ''), userText, assistantText);
  if (!entries.length) return { ok: true, added: 0, reason: 'nothing_worth_remembering' };
  return appendMemory(String(name || ''), entries);
});

/* ---------------- IPC：Agent 治理官（只读盘点 + 重叠检测 + 对账）---------------- */
ipcMain.handle('governance:report', () => readJson('agent-governance.json', null));
ipcMain.handle('governance:run', () => {
  const report = agentGovernance.run(__dirname, dataDir());
  writeJson('agent-governance.json', report);
  return report;
});

/* ---------------- IPC：Agent 类型治理官（自动巡检 + 自动判定/修正 + 人工锁定 + 变更报告）----------------
 * 把「调度中枢」升级成治理型 agent：默认自动修正各 agent 的触发类型（主动/链路/缺口/人工），
 * 除非用户人工锁定某个 agent。变更 append-only 落盘 + 系统通知 + 广播给面板。
 */
function runAgentTypeGovernance() {
  try {
    const report = agentTypeGovernor.run({ repoRoot: __dirname, dataDir: dataDir(), includeCityverse: true });
    writeJson('agent-types-report.json', report);
    if (report.hasChanges) {
      const s = report.summary || {};
      const title = 'Agent 类型治理官 · ' + report.changes.length + ' 处变动';
      const body = report.changes.slice(0, 4).map(function (c) {
        return c.name + ' → ' + (agentTypeGovernor.TRIGGER_TYPES[c.to] ? agentTypeGovernor.TRIGGER_TYPES[c.to].label : c.to);
      }).join('、') + (report.changes.length > 4 ? ' 等' : '');
      try {
        if (Notification.isSupported()) new Notification({ title: title, body: body }).show();
      } catch (e) { /* 通知失败不阻断 */ }
      broadcast('agent-types:changed', report);
    }
    return report;
  } catch (e) {
    const err = { error: String(e && e.message || e), generated_at: new Date().toISOString() };
    writeJson('agent-types-report.json', err);
    return err;
  }
}
ipcMain.handle('agent-types:run', () => runAgentTypeGovernance());
ipcMain.handle('agent-types:report', () => readJson('agent-types-report.json', null));
ipcMain.handle('agent-types:state', () => agentTypeGovernor.state(dataDir()));
// 人工锁定 / 解锁：锁定后立即重跑一次，让报告与快照立即反映锁定结果
ipcMain.handle('agent-types:lock', (_e, name, type) => {
  agentTypeGovernor.lock(dataDir(), name, type);
  return runAgentTypeGovernance();
});
ipcMain.handle('agent-types:unlock', (_e, name) => {
  agentTypeGovernor.unlock(dataDir(), name);
  return runAgentTypeGovernance();
});

/* ---------------- IPC：运营治理官（CFO 成本 + 模型调控 + Agent 总管）----------------
 * 把「API 成本 / 模型选择 / 团队健康」从调度中枢拆出，交给三个治理 agent 统一处理：
 *   CFO 成本官 —— 实时用量/费用聚合 + 预算 + 每个 agent 该用什么模型；
 *   模型调控官 —— 本地优先（零成本）→ 本地占满/离线自动切 API；手动「锁定」才固定；
 *   Agent 总管 —— 实时工作量 + 职责重叠 + 增/分割/合并建议。
 */
async function localModelStatus() {
  const out = { now: Date.now(), online: false, busy: false, activeCount: 0, activeModels: [], vramBytes: 0 };
  out.online = await isPortOpen(11434);
  if (out.online) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000);
      const r = await fetch('http://127.0.0.1:11434/api/ps', { signal: ctrl.signal });
      clearTimeout(t);
      if (r.ok) {
        const j = await r.json();
        out.activeModels = (j.models || []).map(function (m) {
          return { name: String(m.name || m.model || ''), size: Number(m.size || 0), vram: Number(m.size_vram || 0), expiresAt: m.expires_at || null };
        });
      }
    } catch (e) { out.activeModels = []; }
  }
  out.activeCount = out.activeModels.length;
  out.vramBytes = out.activeModels.reduce(function (n, m) { return n + (m.vram || 0); }, 0);
  // 「占满」判定：显存里已加载 >= 3 个模型（不同任务模型争抢显存），或显存占用 > 16GB（接近常见单卡上限）。
  // 这是保守启发式：宁可早切 API 保证可用，也不让本地并发把机器拖垮。
  out.busy = out.activeCount >= 3 || out.vramBytes > 16 * 1024 * 1024 * 1024;
  return out;
}

function runOpsGovernance() {
  return localModelStatus().then(function (localStatus) {
    let report;
    try {
      report = agentOpsGovernor.run({ repoRoot: __dirname, dataDir: dataDir(), localStatus: localStatus });
      writeJson('ops-governor.json', report);
    } catch (e) {
      report = { error: String(e && e.message || e), generated_at: new Date().toISOString() };
      writeJson('ops-governor.json', report);
      return report;
    }

    // 有意义的变动：模型被自动切换（本地占满/离线 → API），或预算超标
    const plan = report.modelPlan || [];
    const switched = plan.filter(function (m) { return m.switched && !m.locked; });
    const budget = report.cfo && report.cfo.budget;
    const overBudget = !!(budget && budget.exceeded);

    if (switched.length || overBudget) {
      const parts = [];
      if (switched.length) parts.push(switched.length + ' 个 agent 自动切换模型');
      if (overBudget) parts.push('本月预算已用尽');
      const title = '运营治理官 · ' + parts.join('、');
      const body = (switched.slice(0, 4).map(function (m) {
        return m.agent + ' → ' + (m.resolvedLabel || m.resolved);
      }).join('、')) + (switched.length > 4 ? ' 等' : '') + (overBudget ? '；预算 $' + budget.budget.toFixed(2) + ' 已用尽' : '');
      try {
        if (Notification.isSupported()) new Notification({ title: title, body: body }).show();
      } catch (e) { /* 通知失败不阻断 */ }
    }
    broadcast('ops:changed', report);
    return report;
  });
}
ipcMain.handle('ops:run', () => runOpsGovernance());
ipcMain.handle('ops:report', () => readJson('ops-governor.json', null));
ipcMain.handle('ops:model-state', () => agentOpsGovernor.modelState(dataDir()));
ipcMain.handle('ops:local-status', () => localModelStatus());
// 人工锁定 / 解锁模型：锁定后立即重跑一次，让报告与快照立即反映锁定结果
ipcMain.handle('ops:lock-model', (_e, name, engine) => {
  agentOpsGovernor.lockModel(dataDir(), name, engine);
  return runOpsGovernance();
});
ipcMain.handle('ops:unlock-model', (_e, name) => {
  agentOpsGovernor.unlockModel(dataDir(), name);
  return runOpsGovernance();
});

/* ---------------- IPC：打开 agent（单窗口，用 BrowserView 内嵌，不新开窗口） ---------------- */
function layoutAgentView() {
  if (!mainWindow) return;
  const view = activeAgentHref ? agentViews.get(activeAgentHref) : null;
  if (!view) return;
  const [w, h] = mainWindow.getContentSize();
  view.setBounds({ x: 0, y: AGENT_BAR_H, width: w, height: Math.max(0, h - AGENT_BAR_H) });
}
function openAgentInMainView(href) {
  if (typeof href !== 'string' || !href || href.includes('..')) return false;
  if (href.includes('meeting-audio')) ensureMeetingAudioBackend();
  if (!mainWindow) return false;
  let view = agentViews.get(href);
  if (!view) {
    view = new BrowserView({
      webPreferences: Object.assign({ preload: path.join(__dirname, 'preload.js') }, WEB_PREFS),
    });
    // BrowserView 内 agent 的 window.open（如会议纪要 PPT 下载）交给系统浏览器
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    agentViews.set(href, view);
  }
  // 检测页面文件是否更新：若磁盘上的 mtime 比上次加载更新，则重新 loadFile 拿到最新界面；
  // 否则复用缓存（保住流式/后台任务的现场）。解决「改了 agent 页面，切回时还是旧版」的问题。
  const filePath = path.join(__dirname, href);
  let mtime = 0;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch (e) { /* 文件可能不存在，保持原逻辑 */ }
  if (!view.__loadedMtime || mtime > view.__loadedMtime) {
    view.webContents.loadFile(filePath);
    view.__loadedMtime = mtime;
  }
  activeAgentHref = href;
  mainWindow.setBrowserView(view);
  layoutAgentView();
  return true;
}
function closeAgentInMainView() {
  if (!mainWindow) return;
  // 只隐藏、不销毁：agent 后台任务（流式生成 / 审稿闭环）继续跑，下次点开同一个 agent 直接恢复现场
  mainWindow.setBrowserView(null);
  activeAgentHref = null;
}
ipcMain.handle('open-agent', (_e, href) => openAgentInMainView(href));
ipcMain.handle('close-agent', () => { closeAgentInMainView(); return true; });

/* ---------------- IPC：用系统浏览器打开外链（BrowserView 内 agent 的 window.open / 下载链接） ---------------- */
ipcMain.handle('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) { shell.openExternal(url); return true; }
  return false;
});

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

  // 授权门：真实操作电脑（非演练）前，必须有显式授权（deny by default）
  if (!dryRun && permissionGate) {
    const auth = permissionGate.check('computer:use', { detail: task.slice(0, 80) });
    if (!auth.allowed) {
      send({ type: 'error', message: '电脑操作未授权：' + auth.reason + '。请先在工作台授权（一次性或永久）后再试。' });
      return false;
    }
  }

  const args = [path.join(__dirname, 'computer-use.py'), '--task', task, '--max-steps', String(maxSteps)];
  if (dryRun) args.push('--dry-run');

  let proc;
  try {
    proc = spawn(pyBin(), args, { stdio: ['ignore', 'pipe', 'pipe'], env: pyEnv() });
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

/* ---------------- IPC：授权门（有副作用操作前显式授权 + 审计） ---------------- */
ipcMain.handle('permission:list', () => permissionGate.list());
ipcMain.handle('permission:grant', (_e, action, opts) => permissionGate.grant(action, opts));
ipcMain.handle('permission:revoke', (_e, idOrAction) => permissionGate.revoke(idOrAction));
ipcMain.handle('permission:check', (_e, action, opts) => permissionGate.check(action, opts));
ipcMain.handle('permission:audit', () => permissionGate.audit());

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

/* ---------------- IPC：API 余额监控 ---------------- */
ipcMain.handle('balance:get', async () => buildBillingDashboard());
ipcMain.handle('balance:refresh', async () => { const r = await refreshBalanceAndAlert(); return Object.assign(r, { dashboard: await buildBillingDashboard() }); });
ipcMain.handle('balance:set-threshold', (_e, engine, threshold) => {
  const id = String(engine || '');
  const state = readBalanceState();
  state.thresholds[id] = Number(threshold) || 0;
  writeBalanceState(state);
  return balanceThreshold(id);
});
ipcMain.handle('balance:set-manual', (_e, engine, balance) => {
  const id = String(engine || '');
  if (!BILLING_META[id]) return { ok: false, error: '未知引擎：' + id };
  const state = readBalanceState();
  state.balances[id] = { balance: Number(balance) || 0, currency: BILLING_META[id].currency, manual: true, updatedAt: Date.now() };
  state.errors[id] = null;
  writeBalanceState(state);
  checkLowBalance();
  return { ok: true };
});

/* ---------------- IPC：会话回放（append-only 事件日志） ---------------- */
ipcMain.handle('session:log:list', () => sessionLog ? sessionLog.listSessions() : []);
ipcMain.handle('session:log:replay', (_e, id) => sessionLog ? sessionLog.replay(id) : []);
ipcMain.handle('session:log:fork', (_e, id) => sessionLog ? sessionLog.fork(id) : '');
ipcMain.handle('session:log:resume', (_e, id, opts) => sessionLog ? sessionLog.resumeContext(id, opts) : null);

/* ---------------- IPC：执行一个 Agent ---------------- */
/* 模型调控官：执行前动态解析引擎。
 * 规则：人工锁定 → 固定用锁定引擎；本地引擎占满/离线 → 自动切 API（deepseek 兜底）；
 *       API/CLI 引擎未锁定 → 维持原引擎（不在执行路径做 API→本地降级，避免意外）。
 */
async function resolveEngineForRun(engine, agentName, fallbacks) {
  const locks = agentOpsGovernor.modelState(dataDir()).locks || {};
  const normName = String(agentName || '').replace(/\s+/g, '').toLowerCase();
  const isLocalOllama = agentOpsGovernor.isOllamaManaged(engine);
  // 未锁定且主引擎非 Ollama 本地模型 → 维持原引擎，不查本地状态（省一次 Ollama 探测）
  if (!isLocalOllama && !locks[normName]) {
    return { engine: engine, switched: false, locked: false, reason: '' };
  }
  const localStatus = await localModelStatus();
  return agentOpsGovernor.resolveModel(
    { name: agentName || '', engine: engine, fallbacks: fallbacks || [] },
    { localStatus: localStatus, locks: locks, allowLocalDowngrade: false }
  );
}

ipcMain.handle('agent:run', async (_e, payload) => {
  const p = payload || {};
  const prompt = String(p.prompt || '').slice(0, 20000);
  const requestedEngine = String(p.engine || 'local-llm');
  const soul = String(p.soul || '');
  const sessionId = String(p.sessionId || '').trim() || SessionLogCore.uid('s');

  // 模型调控官：本地优先 / 占满切 API / 锁定豁免
  const pick = await resolveEngineForRun(requestedEngine, p.agentName, p.fallbacks);
  const engine = pick.engine || requestedEngine;

  // 会话回放：先把「用户消息 + 注入上下文 + 启动」写进 append-only 事件流
  if (sessionLog && sessionId) {
    sessionLog.record(sessionId, 'user', { text: prompt, agent: String(p.agentName || ''), skills: p.skillIds || [] });
    if (soul) sessionLog.record(sessionId, 'system', { text: soul.slice(0, 4000) });
    sessionLog.record(sessionId, 'agent_started', { task: prompt.slice(0, 200), engine: engine, dryRun: !!p.dryRun, switched: pick.switched, switchReason: pick.reason });
  }

  let result;
  if (!prompt.trim()) result = dryRunResult(engine, prompt, '任务内容为空', soul);
  else if (!PRICES[engine]) result = dryRunResult(engine, prompt, '未知引擎：' + engine, soul);
  else {
    const settings = decryptSettings(readSettingsRaw());
    if (p.dryRun === true) result = dryRunResult(engine, prompt, '本次为演练模式', soul);
    else if (!settings.allowRealRuns) result = dryRunResult(engine, prompt, '真实执行未开启（引擎设置里可打开；需先装 CLI 或填 API Key）', soul);
    else if (CLI_ADAPTERS[engine]) result = await runCliAgent(engine, prompt, soul);
    else if (API_ENDPOINTS[engine]) result = await runApiAgent(engine, prompt, soul, settings[engine]);
    else result = dryRunResult(engine, prompt, '本地引擎需自行接入推理服务（如 ollama / FunASR）', soul);
  }

  if (sessionLog && sessionId) {
    sessionLog.record(sessionId, 'agent_output', { text: String((result && result.text) || '').slice(0, 20000), engine: (result && result.engine) || engine });
    sessionLog.record(sessionId, 'turn_end', { status: result && result.status, error: result && result.error, cost: result && result.cost });
  }
  return Object.assign({}, result, {
    sessionId: sessionId,
    engine: (result && result.engine) || engine,
    switched: !!pick.switched,
    switchedFrom: pick.switched ? requestedEngine : '',
    switchReason: pick.reason || '',
    locked: !!pick.locked,
  });
});

/* ---------------- IPC：研究助手聊天（流式） ---------------- */
// 渲染进程 invoke('chat:start', {engine, messages}) 后，主进程把结果以
// 'chat:delta'（逐块正文）和 'chat:done'（结束/错误）事件推回，Key 不经过渲染层。
const activeChatAborts = new Map();   // sessionId -> Set<AbortController>：按会话精确 abort（多会话并发时「停止」只停当前会话）
ipcMain.on('chat:stop', (_e, sessionId) => {
  const abortSet = (set) => { if (set) for (const ctrl of set) { try { ctrl.abort(); } catch { /* 忽略 */ } } };
  if (sessionId) { abortSet(activeChatAborts.get(String(sessionId))); }
  else { for (const set of activeChatAborts.values()) abortSet(set); }
});
ipcMain.handle('chat:start', (e, payload) => {
  const p = payload || {};
  const requestId = String(p.requestId || '');   // 请求级标识：前端据此只认自己的 delta/done，避免并发串线
  const sessionId = String(p.sessionId || '');   // 会话级标识：供「停止生成」按会话 abort
  const engine = String(p.engine || 'ollama');
  const messages = Array.isArray(p.messages) ? p.messages : [];
  const cfg = CHAT_ENDPOINTS[engine];
  if (!cfg) { e.sender.send('chat:done', { ok: false, error: '未知引擎：' + engine, requestId }); return true; }
  if (messages.length === 0) { e.sender.send('chat:done', { ok: false, error: '消息为空', requestId }); return true; }
  const model = String(p.model || cfg.model);   // 前端可指定模型（如 deepseek-flash / deepseek-v4-pro）
  const tools = Array.isArray(p.tools) && p.tools.length ? p.tools : null;   // 原生工具调用（OpenAI tools 参数）

  const settings = decryptSettings(readSettingsRaw());
  const key = cfg.keyField ? settings[cfg.keyField] : '';
  if (cfg.keyField && !key) {
    e.sender.send('chat:done', { ok: false, error: '尚未在「引擎设置」配置 ' + engine + ' 的 API Key', requestId });
    return true;
  }

  (async () => {
    const send = (ch, data) => { if (!e.sender.isDestroyed()) e.sender.send(ch, data); };
    let ctrl = null;
    const agent = p.activityTask === true && activitySender(e.sender);
    const userMessage = agent && messages.findLast(m => m?.role === 'user');
    const run = agent && activity.start({
      agent, source: '对话', title: activityTitle(userMessage?.content) || '处理对话请求',
      phase: '模型生成', engine: model,
    });
    let outcome = 'failed';
    try {
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers.Authorization = 'Bearer ' + key;
      // 空闲超时：只要持续有数据流入就不中断，仅当 120 秒无任何数据才 abort。
      // 不设总时长上限——长时间任务（深度推理 / 超长输出 / 多轮研究）可持续工作，
      // 只有真正卡死（连续无数据）才会中断。
      const STALL_MS = 120000;
      ctrl = new AbortController();
      let set = activeChatAborts.get(sessionId);
      if (!set) { set = new Set(); activeChatAborts.set(sessionId, set); }
      set.add(ctrl);   // 供「停止生成」按钮按会话 abort
      let stallTimer = setTimeout(() => ctrl.abort(), STALL_MS);
      const resetStall = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => ctrl.abort(), STALL_MS); };
      const thinkingOn = p.thinking === true;   // 默认关闭思考（省 token）；仅显式请求才开启深度推理
      const resp = await fetch(cfg.url, {
        method: 'POST', headers, signal: ctrl.signal,
        body: JSON.stringify(Object.assign(
          { model: model, messages: messages, stream: true, temperature: 0.7, max_tokens: maxTokensForModel(model, thinkingOn) },
          samplingForModel(model),
          thinkingControl(model, { thinking: thinkingOn }),
          tools ? { tools: tools, tool_choice: 'auto' } : {}
        )),
      });
      if (!resp.ok) {
        clearTimeout(stallTimer);
        let msg = 'HTTP ' + resp.status;
        try { const j = await resp.json(); msg = j && j.error && j.error.message ? j.error.message : msg; } catch { /* 非 JSON */ }
        send('chat:done', { ok: false, error: friendlyApiError(msg, engine), requestId });
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '', truncated = false, outChars = 0, reasoning = '';
      const toolCalls = {};   // index -> { id, name, arguments } 原生工具调用分片累积
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        resetStall();   // 有数据流入就续期，不再被固定超时打断
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
          if (!line || line.indexOf('data:') !== 0) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const j = JSON.parse(data);
            const choice = j.choices && j.choices[0];
            if (choice && choice.finish_reason === 'length') truncated = true;  // 被 max_tokens 截断
            const delta = choice && choice.delta;
            if (!delta) continue;
            // 思考型模型（如 qwen3）先流 reasoning 再流 content，两者都要透传
            const text = delta.content || '';
            const thinking = delta.reasoning || delta.reasoning_content || '';
            if (thinking) { reasoning += thinking; send('chat:delta', { thinking: thinking, requestId }); }
            if (text) { send('chat:delta', { text: text, requestId }); outChars += text.length; }
            // 原生工具调用（OpenAI 兼容流式）：按 index 累积分片（name/arguments 可能分多块到达）
            if (Array.isArray(delta.tool_calls)) {
              for (const tc of delta.tool_calls) {
                const ti = tc.index != null ? tc.index : 0;
                if (!toolCalls[ti]) toolCalls[ti] = { id: '', name: '', arguments: '' };
                if (tc.id) toolCalls[ti].id = tc.id;
                if (tc.function && tc.function.name) toolCalls[ti].name = tc.function.name;
                if (tc.function && tc.function.arguments) toolCalls[ti].arguments += tc.function.arguments;
              }
            }
          } catch { /* 忽略坏块 */ }
        }
      }
      clearTimeout(stallTimer);
      const assembledCalls = Object.keys(toolCalls).map(function (k) { return toolCalls[k]; }).filter(function (t) { return t.name; });
      // 聊天自动记账：估算输入/输出 token 并写入用量账本。
      // 思考链 reasoning 也计入输出——它才是思考型模型烧钱的大头（此前只算正文，严重低估真实费用）
      try {
        // 注意：outChars 是数字（逐块累加的字符数），reasoning 是字符串。不能直接 outChars + reasoning
        // （number+string 会把数字转成十进制字符串再拼，如 1500 → "1500"，token 数被算成 1，导致 tokensOut 恒为 0/1）。
        // 这里按真实字符数估算：正文字符数 + 思考链字符数。
        const tin = approxTokens(JSON.stringify(messages)), tout = Math.ceil((outChars + reasoning.length) / 4);
        appendUsage({
          at: Date.now(), engine: engine, model: model,
          agentId: '', agentName: '聊天', taskType: 'chat', source: 'chat',
          tokensIn: tin, tokensOut: tout, cost: costOf(engine, tin, tout, model),
          costSource: 'estimated', status: 'ok', dryRun: false,
        });
      } catch (e) { /* 记账失败不阻断聊天 */ }
      outcome = 'done';
      send('chat:done', { ok: true, truncated: truncated, tool_calls: assembledCalls, reasoning: reasoning, requestId });
    } catch (err) {
      send('chat:done', { ok: false, error: '请求失败：' + String(err && err.message || err), requestId });
    } finally {
      if (run) activity.finish(run, { status: ctrl?.signal.aborted ? 'stopped' : outcome });
      const s2 = activeChatAborts.get(sessionId);
      if (s2) { s2.delete(ctrl); if (!s2.size) activeChatAborts.delete(sessionId); }
    }
  })();
  return true;
});

/* ---------------- 后台任务队列：执行器与 IPC（吸收 dsh Ticket 思想） ---------------- */
// 后台任务 = 一件「丢进队列、独立会话、后台自主跑完、完成或需决策才打扰用户」的活。
// 复用了本工作台已有的工具函数（toolFs*/kbEngine/web 抓取），无需前端窗口参与。

const BG_TOOLS = [
  { type: 'function', function: { name: 'fs_list', description: '列出目录内容（文件名、是否目录、大小）', parameters: { type: 'object', properties: { dir: { type: 'string', description: '目录绝对路径，默认主目录' } } } } },
  { type: 'function', function: { name: 'fs_read', description: '读取文件内容（原文）：txt/md 等文本直接读；docx/doc/rtf/odt 自动提取正文；pdf 自动提取全文；pptx 自动提取每页幻灯片文本；旧版 .ppt 二进制需先转 .pptx。长文件可用 offset/limit 分段读取，避免一次读全文撑爆上下文。', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径' }, offset: { type: 'integer', description: '可选，起始字符位置（从 0 起），用于分段读取长文件后续部分' }, limit: { type: 'integer', description: '可选，最多读取的字符数' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'fs_search', description: '按文件名搜索文件', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索关键词' }, root: { type: 'string', description: '搜索根目录，默认主目录' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'fs_write', description: '写入文本文件（覆盖前自动备份，仅主目录内）', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'fs_edit', description: '替换文件中的一段文字（原文须唯一）。Word .docx/.doc 也能直接改（自动用 python-docx 精确替换并备份）', parameters: { type: 'object', properties: { path: { type: 'string', description: '文件绝对路径' }, old: { type: 'string', description: '要替换的原文' }, new: { type: 'string', description: '替换成的新文' } }, required: ['path', 'old', 'new'] } } },
  { type: 'function', function: { name: 'web_search', description: '联网搜索', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'web_fetch', description: '抓取网页正文', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'fs_download', description: '下载网页/图片/zip/pdf 等二进制文件到本地磁盘（目标路径缺省时存到下载目录，仅允许主目录内）', parameters: { type: 'object', properties: { url: { type: 'string', description: '文件直链（http/https）' }, path: { type: 'string', description: '可选，保存的绝对路径；缺省用 URL 文件名存到下载目录' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'kb_search', description: '在本地知识库（Obsidian/Notion 索引）里检索', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
];

function buildBgSystemPrompt(ticket) {
  return [
    '你是 Ingrid 工作台的后台任务执行员，正在独立完成一个用户丢到后台的任务（用户可能不在旁边盯着）。',
    '',
    '自主工作准则（必须遵守）：',
    '1. 持续自主推进：把能查、能读、能写、能核对的步骤全部自己做完，少打扰、多交付。',
    '2. 只在三种情况停下：任务完成 / 确实需要用户提供信息或做决定 / 反复尝试后确实无法继续。',
    '3. 工具失败要读错误信息、换方法重试，绝不停在「我失败了」；同一招失败两次就换思路。',
    '4. 完成前核对结果；没做完就继续做。',
    '',
    '输出要求：最终交付用 Markdown，结构清晰、结论明确。',
    '',
    '本次任务目标：' + String(ticket.goal || ticket.title || ''),
  ].join('\n');
}

function stripBgToolMarkers(s) {
  return String(s || '').replace(/<tool\b[^>]*>[\s\S]*?<\/tool\b[^>]*>/g, '').trim();
}

function extractBgToolCalls(s) {
  const out = [];
  const re = /<\s*tool\b([^>]*)>([\s\S]*?)<\s*\/\s*tool\b[^>]*>/g;
  let m;
  const str = String(s || '');
  while ((m = re.exec(str)) !== null) {
    const nm = m[1].match(/\bname\s*=\s*"([^"]+)"/i);
    if (!nm) continue;
    const inner = (m[2] || '').trim();
    let args = {};
    if (inner) { try { args = JSON.parse(inner); } catch (e) { args = { raw: inner }; } }
    out.push({ id: 'bg' + out.length, name: nm[1].trim(), arguments: JSON.stringify(args) });
  }
  return out;
}

async function executeBgTool(name, argsStr) {
  let args = {};
  try { args = JSON.parse(argsStr || '{}'); } catch (e) { args = {}; }
  try {
    switch (name) {
      case 'fs_list': return toolFsList(args);
      case 'fs_read': return toolFsRead(args);
      case 'fs_search': return await toolFsSearch(args);
      case 'fs_write': return toolFsWrite(args);
      case 'fs_edit': return toolFsEdit(args);
      case 'fs_download': return await toolFsDownload(args);
      case 'kb_search': return kbEngine.search(String(args.query || ''), 5);
      case 'web_search': return await bgWebSearch(String(args.query || ''));
      case 'web_fetch': return await bgWebFetch(String(args.url || ''));
      default: return { ok: false, error: '未知工具：' + name };
    }
  } catch (e) {
    return { ok: false, error: '工具执行异常：' + String((e && e.message) || e) };
  }
}

/* ---- 轻量 HTML 处理（替代 cheerio，避免打包副本依赖被精简导致 require 失败） ---- */
function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, function (_m, h) { try { return String.fromCodePoint(parseInt(h, 16)); } catch (e) { return ' '; } })
    .replace(/&#(\d+);/g, function (_m, d) { try { return String.fromCodePoint(parseInt(d, 10)); } catch (e) { return ' '; } })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/[ \t\r]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

// 解析 DuckDuckGo html 端点的搜索结果（零第三方依赖）
function parseDuckDuckGo(html, n) {
  const out = [];
  const aTagRe = /<a\b[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let am;
  while ((am = aTagRe.exec(html)) !== null && out.length < n) {
    const hrefM = /href="([^"]*)"/i.exec(am[0]);
    let link = hrefM ? hrefM[1] : '';
    const uddg = link.match(/uddg=([^&]+)/);
    if (uddg) { try { link = decodeURIComponent(uddg[1]); } catch (e) {} }
    const title = htmlToText(am[1]);
    if (title && link) out.push({ title: title, link: link, snippet: '' });
  }
  const sRe = /<a\b[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  let sm; let i = 0;
  while ((sm = sRe.exec(html)) !== null && i < out.length) { out[i].snippet = htmlToText(sm[1]); i++; }
  return out;
}

// 提取网页正文（去除脚本/样式/导航等噪声）
function htmlBodyText(html) {
  const cleaned = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ');
  return htmlToText(cleaned);
}

const WEB_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

async function bgWebSearch(query) {
  if (!query) return { ok: false, error: '搜索词为空' };
  try {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': WEB_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, error: '搜索失败：HTTP ' + res.status };
    const results = parseDuckDuckGo(await res.text(), 6);
    if (!results.length) return { ok: false, error: '未取到搜索结果（可能被限流）' };
    return { ok: true, query: query, results: results };
  } catch (err) { return { ok: false, error: '搜索失败：' + String((err && err.message) || err) }; }
}

async function bgWebFetch(url) {
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '仅支持 http/https 链接' };
  try {
    const res = await fetch(url, { headers: { 'User-Agent': WEB_UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { ok: false, error: '抓取失败：HTTP ' + res.status };
    let text = htmlBodyText(await res.text());
    if (text.length > 16000) text = text.slice(0, 16000) + '\n…（内容过长已截断）';
    if (!text) return { ok: false, error: '未能提取到正文' };
    return { ok: true, url: url, content: text };
  } catch (err) { return { ok: false, error: '抓取失败：' + String((err && err.message) || err) }; }
}

// 带 tools 参数的流式调用（后台任务专用，返回完整文本 + 原生 tool_calls）
async function callBgChat(engine, model, messages, tools) {
  const cfg = CHAT_ENDPOINTS[engine];
  if (!cfg) return { ok: false, error: '未知引擎：' + engine };
  const settings = decryptSettings(readSettingsRaw());
  const key = cfg.keyField ? settings[cfg.keyField] : '';
  if (cfg.keyField && !key) return { ok: false, error: '尚未配置 ' + engine + ' 的 API Key' };
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = 'Bearer ' + key;
  try {
    const STALL_MS = 120000;
    const ctrl = new AbortController();
    let stallTimer = setTimeout(() => ctrl.abort(), STALL_MS);
    const resetStall = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => ctrl.abort(), STALL_MS); };
    const body = Object.assign(
      { model: model || cfg.model, messages: messages, stream: true, temperature: 0.7, max_tokens: maxTokensForModel(model || cfg.model, false) },
      samplingForModel(model || cfg.model),
      thinkingControl(model || cfg.model, {})   // 后台任务带 tools，关闭思考（思考+工具=烧钱死循环）
    );
    if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
    const resp = await fetch(cfg.url, { method: 'POST', headers, signal: ctrl.signal, body: JSON.stringify(body) });
    if (!resp.ok) {
      clearTimeout(stallTimer);
      let msg = 'HTTP ' + resp.status;
      try { const j = await resp.json(); msg = j && j.error && j.error.message ? j.error.message : msg; } catch { /* 非 JSON */ }
      return { ok: false, error: friendlyApiError(msg, engine) };
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '', text = '', truncated = false, reasoning = '';
    const toolCalls = {};
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetStall();
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line || line.indexOf('data:') !== 0) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const choice = j.choices && j.choices[0];
          if (choice && choice.finish_reason === 'length') truncated = true;
          const delta = choice && choice.delta;
          if (!delta) continue;
          if (delta.content) text += delta.content;
          if (delta.reasoning || delta.reasoning_content) reasoning += (delta.reasoning || delta.reasoning_content);
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const ti = tc.index != null ? tc.index : 0;
              if (!toolCalls[ti]) toolCalls[ti] = { id: '', name: '', arguments: '' };
              if (tc.id) toolCalls[ti].id = tc.id;
              if (tc.function && tc.function.name) toolCalls[ti].name = tc.function.name;
              if (tc.function && tc.function.arguments) toolCalls[ti].arguments += tc.function.arguments;
            }
          }
        } catch { /* 忽略坏块 */ }
      }
    }
    clearTimeout(stallTimer);
    const assembled = Object.keys(toolCalls).map((k) => toolCalls[k]).filter((t) => t.name);
    return { ok: true, text: text, tool_calls: assembled, truncated: truncated, reasoning: reasoning };
  } catch (err) {
    return { ok: false, error: '请求失败：' + String((err && err.message) || err) };
  }
}

// 后台任务主循环：单任务独立会话，最多 10 轮工具，完成/失败/需决策时落库并通知
async function runBackgroundTask(ticket) {
  const q = getTaskQueue();
  const engine = String(ticket.engine || 'deepseek');
  const model = String(ticket.model || '');
  const cfg = CHAT_ENDPOINTS[engine];
  if (!cfg) {
    // 说清楚「为什么不行、该去哪」，别只丢一句「未知引擎」。CLI 引擎（codex /
    // claude-code / grok / dsh）只有 CLI_ADAPTERS 通道，后台任务循环调不到；
    // 要跑 CLI 就回工作台对话，或者投 CityVerse 总控的 kind=codex。
    const cliHint = CLI_ADAPTERS[engine] ? '（它是本机 CLI 引擎，后台任务调不到；请回工作台对话，或投总控的 kind=codex）' : '';
    const msg = '未知引擎：' + engine + cliHint;
    q.fail(ticket.id, msg); broadcastTasks(); return { ok: false, error: msg };
  }

  q.start(ticket.id);
  broadcastTasks();

  let msgs = [{ role: 'system', content: buildBgSystemPrompt(ticket) }];
  if (Array.isArray(ticket.messages) && ticket.messages.length) {
    msgs = msgs.concat(ticket.messages);
  } else {
    msgs.push({ role: 'user', content: String(ticket.goal || ticket.title || '') });
  }

  const MAX_ROUNDS = 10;
  let failStreak = 0;
  let emptyStreak = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    q.heartbeat(ticket.id);   // 每轮心跳：让 Watchdog 知道还在推进，避免误判卡死
    const r = await callBgChat(engine, model, msgs, BG_TOOLS);
    if (!r.ok) {
      failStreak++;
      if (failStreak >= 3) { q.fail(ticket.id, r.error); broadcastTasks(); return r; }
      msgs.push({ role: 'user', content: '【系统提示】上一轮调用失败：' + r.error + '。请重试或换一种方式继续。' });
      continue;
    }
    const raw = r.text || '';

    // 原生工具调用（优先）
    if (r.tool_calls && r.tool_calls.length) {
      failStreak = 0; emptyStreak = 0;
      const results = [];
      for (const tc of r.tool_calls) {
        const res = await executeBgTool(tc.name, tc.arguments);
        results.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(res) });
      }
      msgs.push({
        role: 'assistant', content: raw,
        tool_calls: r.tool_calls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })),
      });
      if (r.reasoning) msgs[msgs.length - 1].reasoning_content = r.reasoning;
      msgs = msgs.concat(results);
      continue;
    }

    // 文本 <tool> 标签兜底（本地 Ollama 等）
    const textCalls = extractBgToolCalls(raw);
    if (textCalls.length) {
      failStreak = 0; emptyStreak = 0;
      const results = [];
      for (const tc of textCalls) {
        const res = await executeBgTool(tc.name, tc.arguments);
        results.push('【工具 ' + tc.name + ' 结果】\n' + JSON.stringify(res));
      }
      msgs.push({ role: 'assistant', content: raw });
      msgs.push({ role: 'user', content: results.join('\n\n') });
      continue;
    }

    // 无工具调用：检查空回复
    const stripped = stripBgToolMarkers(raw).replace(/^\s+|\s+$/g, '');
    if (!stripped) {
      emptyStreak++;
      if (emptyStreak >= 4) { q.fail(ticket.id, '连续多次空回复，模型可能暂时异常'); broadcastTasks(); return { ok: false, error: '空回复' }; }
      msgs.push({ role: 'assistant', content: raw });
      msgs.push({ role: 'user', content: '你上一条只有思考没有正文，请直接输出完整回答（需要就调用工具继续推进），不要只写思考过程。' });
      continue;
    }

    // 有正文：完成
    failStreak = 0;
    q.complete(ticket.id, stripBgToolMarkers(raw));
    broadcastTasks();
    return { ok: true, result: q.get(ticket.id).result };
  }

  q.fail(ticket.id, '超过 ' + MAX_ROUNDS + ' 轮仍未完成，请人工介入');
  broadcastTasks();
  return { ok: false, error: '超过最大轮次' };
}

/* ---------------- 后台任务 Watchdog：定时巡检卡死任务（吸收 dsh 自愈思想） ---------------- */
let taskWatchdogTimer = null;
function startTaskWatchdog() {
  if (taskWatchdogTimer) return;
  // 每 60 秒巡检一次：运行中但超过 15 分钟无心跳的任务判定为卡死，自动停止并标记失败
  taskWatchdogTimer = setInterval(() => {
    try {
      const q = getTaskQueue();
      const stale = q.listStale(15 * 60 * 1000);
      if (stale.length) {
        stale.forEach((t) => q.fail(t.id, '任务长时间无进展（超过 15 分钟无心跳），已自动停止。请检查后重试或换模型。'));
        broadcastTasks();
      }
    } catch { /* 忽略巡检异常 */ }
  }, 60 * 1000);
}

/* ---------------- 灵感目录：每日调研 DSH 插件生态（eco-radar） ---------------- */
function runEcoRadar() {
  const prev = readJson('eco-radar.json', { seen: [], lastRun: 0, entries: [] });
  const seen = Array.isArray(prev.seen) ? prev.seen : [];
  const run = activity.start({ agent: 'radar', source: '生态资讯', title: '扫描生态更新并整理资讯' });
  let status = 'failed';
  return EcoRadar.runEcoRadar({ seen: seen }).then((result) => {
    if (!result.ok) return { ok: false, error: result.error };
    const entry = { at: Date.now(), newCount: result.newCount, newPlugins: result.newPlugins, report: result.report };
    const entries = (Array.isArray(prev.entries) ? prev.entries : []).concat([entry]).slice(-30);
    const allSeen = Array.from(new Set(seen.concat(result.newPlugins.map((p) => p.full_name)))).slice(-5000);
    writeJson('eco-radar.json', { seen: allSeen, lastRun: Date.now(), entries: entries });
    const matchedBoards = Object.keys(result.matches || {}).filter((k) => (result.matches[k] || []).length);
    const summary = result.newCount
      ? '灵感目录 · 发现 ' + result.newCount + ' 个新 DSH 插件' + (matchedBoards.length ? '，' + matchedBoards.length + ' 个板块有匹配' : '')
      : '灵感目录 · 今日无新增 DSH 插件';
    const body = matchedBoards.length
      ? '匹配板块：' + matchedBoards.map((k) => (EcoRadar.boardMeta(k) || {}).label || k).join('、')
      : '打开工作台查看调研详情';
    try { if (Notification.isSupported()) new Notification({ title: summary, body: body }).show(); } catch { /* 通知失败不阻断 */ }
    broadcast('eco-radar:updated', { entry: entry, summary: summary });
    status = 'done';
    return { ok: true, newCount: result.newCount, summary: summary, report: result.report };
  }).finally(() => activity.finish(run, { status }));
}

// 首次启动：确保「灵感目录」Agent 与每日调研计划存在（幂等）
function ensureEcoRadar() {
  let agents = readJson('agents.json', []);
  if (!Array.isArray(agents)) agents = [];
  const has = agents.some((a) => a.id === 'eco-radar' || a.tag === '生态雷达');
  if (!has) {
    agents.push({
      id: 'eco-radar', name: '灵感目录', title: '生态雷达 · 每日调研 DSH 插件', emoji: '📡',
      tag: '生态雷达',
      soul: '你是「灵感目录」生态雷达：每天调研 DeepSeek Harness（DSH）插件生态，从 GitHub 的 dsh-plugin 话题里找新插件，并按用户的用途板块（学术研究 / 设计配色 / 写作 / 文档 / 浏览器 / 图像 / 代码 / 音乐）筛选出可能适合用户的功能，产出可解释的简报并推送。只依据真实抓到的仓库信息，不臆造插件名。',
      description: '每日调研 DSH 插件生态，按用途板块筛选新功能并推送简报。',
      engine: 'local-llm', fallbacks: [], memory: { file: 'data/eco-radar.json' }, skills: [], routines: [],
      tools: [], approvalMode: 'ask', computer: 'off', caps: { web: true }, visibility: 'private',
      role: 'worker', canControl: false, status: 'active', href: '', engineLabel: '调研引擎 · GitHub API',
      detail: '无需 API Key，直接读 GitHub dsh-plugin 话题，本地关键词匹配，免费可解释。',
    });
    writeJson('agents.json', agents);
  }
  // 回填能力声明：老记录 caps/memory 为空时补齐（联网调研 + eco-radar.json 持久化），不覆盖已有
  const radar = agents.find((a) => a.id === 'eco-radar' || a.tag === '生态雷达');
  if (radar) {
    let changed = false;
    if (!radar.caps || (typeof radar.caps === 'object' && Object.keys(radar.caps).length === 0)) { radar.caps = { web: true }; changed = true; }
    if (!radar.memory || Object.keys(radar.memory).length === 0) { radar.memory = { file: 'data/eco-radar.json' }; changed = true; }
    if (changed) writeJson('agents.json', agents);
  }
  const q = getTaskQueue();
  const hasTask = q.list().some((t) => t.agent === 'eco-radar' && t.schedule);
  if (!hasTask) {
    q.enqueue({
      title: '灵感目录 · 每日 DSH 生态调研',
      goal: '调研 DeepSeek Harness（DSH）插件生态，找到新插件并按用途板块分类推荐',
      agent: 'eco-radar', engine: 'deepseek', model: '',
      schedule: '09:00',
    });
    broadcastTasks();
  }
}

// 首次启动：确保「法务知识库每周更新」后台任务存在（幂等）。
// 每周一 09:00 走 deepseek + web_search/fs 工具，联网核对 66 条法条的最新动态并增量更新
// Obsidian 法务知识库。原 WorkBuddy 自动化「法务知识库每周自动更新」已迁移到此（local-first，零 WorkBuddy 依赖）。
function ensureLegalUpdateTask() {
  const q = getTaskQueue();
  const has = q.list().some((t) => (t.title || '').indexOf('法务知识库') >= 0);
  if (has) return;
  q.enqueue({
    title: '法务知识库 · 每周更新',
    goal: [
      '更新「法务知识库」：这是 AI 伦理教学系统配套的权威法条库。',
      '法条库目录：~/Documents/Obsidian Vault/法务知识库（按领域分子目录，每条法条一个 md，含「法条原文/构成要件/司法解释/典型案例/涉及场景/更新记录」结构）。',
      '法条清单索引：~/Dev/Ingrids-AI-Agents/agents/ethics-chat/legal-index.json。',
      '',
      '任务步骤：',
      '1. 先用 fs_read 读 legal-index.json 拿到法条清单，再用 fs_list 浏览法务知识库目录结构，确认对应 md 文件位置。',
      '2. 用 web_search 逐条搜索这些法条的最新动态（法条修订、新司法解释、新判例、立案追诉标准变化），重点核对：法条号是否变动、数额标准/刑期是否调整、是否有新典型案例。',
      '3. 发现更新的，用 fs_edit 增量更新对应 md 文件：保留原有全部结构，只在「更新记录」追加本次更新日期和变更要点，绝不删除原有内容；没有更新的保持不动。',
      '4. 法条原文必须用 web_fetch 从权威来源核实（国家法律法规数据库 flk.npc.gov.cn、中国政府网 gov.cn、中国人大网、最高法/最高检、各部委官网），严禁凭记忆编造法条号、条文、数额、刑期。',
      '5. 全部完成后，运行 `node legal-build.js --check`（工作目录 ~/Dev/Ingrids-AI-Agents/agents/ethics-chat/）校验法条文件完整无缺失。',
      '',
      '最终交付：简要汇报本次更新了哪几条法条、每条更新了什么（一句话即可），以及校验是否通过。',
    ].join('\n'),
    agent: '伦理agent', engine: 'deepseek', model: '',
    schedule: '09:00', weekdays: [1],
  });
  broadcastTasks();
}

// 启动清理：删除历史遗留的「CityVerse 情报」每日简报任务。
// 该任务已被 CityVerse 战略参谋 research agent（intel/strategy/research.py）取代——
// 情报检索统一由 research agent 负责（launchd 每日 08:00 常驻，Google News RSS 结构化抓取，
// 写 intel/daily + strategy_reports，供 analyze/feed 闭环），工作台不再重复跑，
// 避免两边每天重复收集竞品/技术情报、重复写 intel/daily，且工作台这条还反复 10 轮死循环失败。
function cleanupLegacyCityverseIntel() {
  try {
    const q = getTaskQueue();
    const legacy = q.list().filter((t) => t.agent === 'dev-agent-001' && (t.title || '').indexOf('CityVerse 情报') >= 0);
    if (legacy.length) {
      legacy.forEach((t) => q.remove(t.id));
      broadcastTasks();
    }
  } catch (e) { /* 静默失败，不影响启动 */ }
}

// 每次启动：把工作台已配置的 DeepSeek API Key 同步到 CityVerse（建设流水线走 DeepSeek 官方 API，摆脱本地 Ollama 内存争抢导致的执行卡死）。
function syncCityverseDeepseekKey() {
  try {
    const key = decryptSettings(readSettingsRaw()).deepseek || '';
    const dir = path.join(os.homedir(), 'Dev', 'cityverse-ar', 'intel');
    if (!key || !fs.existsSync(dir)) return;
    const envPath = path.join(dir, '.deepseek.env');
    const content = '# 由 Ingrid AI Agents 工作台启动时自动同步，请勿手改\nCITYVERSE_DEEPSEEK_KEY=' + key + '\nCITYVERSE_DEEPSEEK_MODEL=deepseek-flash\n';
    fs.writeFileSync(envPath, content, { mode: 0o600 });
  } catch (e) { /* 静默失败，不影响启动 */ }
}

/* ---------------- 定时任务调度器：按计划自动触发后台任务（吸收 dsh 主动找活思想） ---------------- */
let taskSchedulerTimer = null;

/* 自然语言定时解析：把「明天下午3点 / 每天9点 / 下周一上午10点」等转成 schedule 字符串。
   schedule 语义：'HH:MM' = 每天到点；'YYYY-MM-DD HH:MM' = 一次性到点（触发后自动清除）。 */
function parseNaturalSchedule(text) {
  const s = String(text || '').trim();
  if (!s) return { ok: false, error: '空输入' };
  // 1) 纯 HH:MM → 每天
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) {
    return { ok: true, schedule: s, type: 'daily', label: '每天 ' + s };
  }
  // 2) 'YYYY-MM-DD HH:MM' → 一次性
  const dm = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+([01]?\d|2[0-3]):([0-5]\d)$/);
  if (dm) {
    const y = dm[1], mo = ('0' + dm[2]).slice(-2), d = ('0' + dm[3]).slice(-2), h = ('0' + dm[4]).slice(-2), mi = dm[5];
    const sch = y + '-' + mo + '-' + d + ' ' + h + ':' + mi;
    return { ok: true, schedule: sch, type: 'once', label: sch };
  }
  // 3) 自然语言
  const t = s.replace(/\s+/g, '');
  let type = 'once';

  let hour = null, min = 0;
  const ampm = t.match(/(\d{1,2})\s*(am|pm)/i);
  const cn = t.match(/(早上|早晨|上午|中午|下午|晚上|傍晚|凌晨)?(\d{1,2})[点:：](半|(\d{1,2})分?)?/);
  if (ampm) {
    hour = parseInt(ampm[1], 10) % 12;
    if (/pm/i.test(ampm[2])) hour += 12;
    else if (hour === 12) hour = 0;
  } else if (cn) {
    hour = parseInt(cn[2], 10);
    const p = cn[1] || '';
    if ((p === '下午' || p === '晚上' || p === '傍晚' || p === '中午') && hour < 12) hour += 12;
    if (p === '凌晨' && hour === 12) hour = 0;
    if (cn[3] === '半') min = 30;
    else if (cn[4]) min = parseInt(cn[4], 10);
  }
  if (hour == null) return { ok: false, error: '没解析出时间，试试「9点」「下午3点」「3pm」或「09:00」' };
  if (hour < 0 || hour > 23 || min < 0 || min > 59) return { ok: false, error: '时间超出范围' };
  const hhmm = ('0' + hour).slice(-2) + ':' + ('0' + min).slice(-2);

  const now = new Date();
  let dayOffset = null;
  if (/每天|每日|天天|工作日/.test(t)) type = 'daily';
  else if (/明天|明日/.test(t)) dayOffset = 1;
  else if (/后天/.test(t)) dayOffset = 2;
  else if (/大后天/.test(t)) dayOffset = 3;
  else if (/今天|今日/.test(t)) dayOffset = 0;
  else {
    const nd = t.match(/(\d+)\s*天[后之]?/);
    if (nd) dayOffset = parseInt(nd[1], 10);
    else {
      const wk = t.match(/(下|本|这)?(周|星期|礼拜)([一二三四五六日天])/);
      if (wk) {
        const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
        const target = map[wk[3]];
        const diff = (target - now.getDay() + 7) % 7;
        dayOffset = (wk[1] === '下') ? 7 + diff : diff;
      }
    }
  }

  if (type === 'daily') return { ok: true, schedule: hhmm, type: 'daily', label: '每天 ' + hhmm };
  if (dayOffset == null) dayOffset = 0;
  const dd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset);
  const dateStr = dd.getFullYear() + '-' + ('0' + (dd.getMonth() + 1)).slice(-2) + '-' + ('0' + dd.getDate()).slice(-2);
  const schedule = dateStr + ' ' + hhmm;
  return { ok: true, schedule: schedule, type: 'once', label: schedule };
}
ipcMain.handle('schedule:parse', (_e, text) => parseNaturalSchedule(text));

function startTaskScheduler() {
  if (taskSchedulerTimer) return;
  // 每 60 秒检查一次：带 schedule 的任务到点触发（复制成一次性任务入队并后台跑）
  taskSchedulerTimer = setInterval(() => {
    try {
      const q = getTaskQueue();
      const now = new Date();
      const hhmm = ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2);
      const today = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + ('0' + now.getDate()).slice(-2);
      q.listScheduled().forEach((t) => {
        const sch = String(t.schedule || '');
        const isOnce = sch.indexOf(' ') >= 0; // 'YYYY-MM-DD HH:MM' 一次性
        // 周约束：任务声明了 weekdays 时，只在指定星期触发（0=周日..6=周六）；一次性任务不受此限
        if (Array.isArray(t.weekdays) && t.weekdays.length && !isOnce && t.weekdays.indexOf(now.getDay()) < 0) return;
        const due = isOnce ? (sch === today + ' ' + hhmm) : (sch === hhmm && t.lastRunDate !== today);
        if (!due) return;
        if (isOnce) q.clearSchedule(t.id);
        else q.markScheduledRun(t.id, today);
        const copy = q.enqueue({ title: t.title, goal: t.goal, agent: t.agent, engine: t.engine, model: t.model });
        broadcastTasks();
        if (t.agent === 'eco-radar') {
          // 灵感目录走专用调研引擎（GitHub API，免费、可解释），不走 LLM
          runEcoRadar().then((r) => {
            if (r && r.ok) q.complete(copy.id, r.report || r.summary || '');
            else q.fail(copy.id, (r && r.error) || '调研失败');
            broadcastTasks();
          }).catch((e) => {
            getTaskQueue().fail(copy.id, String((e && e.message) || e));
            broadcastTasks();
          });
          return;
        }
        runBackgroundTask(copy).catch((e) => {
          getTaskQueue().fail(copy.id, String((e && e.message) || e));
          broadcastTasks();
        });
      });
    } catch { /* 忽略调度异常 */ }
  }, 60 * 1000);
}

/* ---------------- 主进程定时命令：把「固定脚本型」定时任务从外部（WorkBuddy）内聚到桌面应用自身 ---------------- */
/* 统一管理多个「跑固定命令」的定时任务。每个任务直跑本地脚本，不经过 LLM。
   rule 两种形态：
     - { intervalMinutes: N }：每 N 分钟跑一次（应用重启后立即补跑一次）
     - { weekdays?: number[] (0=周日..6=周六，缺省=每天), hhmm: 'HH:MM' }：到点且当天未跑过则触发 */
const APP_DIR = path.join(os.homedir(), 'Dev', 'Ingrids-AI-Agents');
const CITYVERSE_INTEL_DIR = path.join(os.homedir(), 'Dev', 'cityverse-ar', 'intel');
const ZOTERO_INGEST_SCRIPT = path.join(APP_DIR, 'scripts', 'zotero', 'auto_ingest.py');
const SCHEDULED_COMMANDS = [
  {
    key: 'kb-scan',
    label: '研究助手知识库每日增量索引',
    bin: 'node', args: [path.join(APP_DIR, 'kb-cli.js'), 'scan'], cwd: APP_DIR,
    rule: { hhmm: '09:00' }, timeoutMs: 30 * 60 * 1000,
  },
  {
    key: 'kb-digest',
    label: '研究助手智能整理·每周文献综述',
    bin: 'node', args: [path.join(APP_DIR, 'kb-digest.js'), 'review', '15'], cwd: APP_DIR,
    rule: { weekdays: [1], hhmm: '09:30' }, timeoutMs: 60 * 60 * 1000,
  },
  {
    key: 'zotero-ingest',
    label: 'Zotero 文献自动入库与整理（每 2 小时，Zotero 未开则静默跳过）',
    bin: 'python3', args: [ZOTERO_INGEST_SCRIPT], cwd: os.homedir(),
    rule: { intervalMinutes: 120 }, timeoutMs: 5 * 60 * 1000,
  },
  {
    key: 'zotero-weekly',
    label: 'Zotero 文献管理周报',
    bin: 'python3', args: [ZOTERO_INGEST_SCRIPT, '--report', 'weekly'], cwd: os.homedir(),
    rule: { weekdays: [1], hhmm: '09:45' }, timeoutMs: 5 * 60 * 1000,
  },
  {
    key: 'cityverse-intel',
    label: 'CityVerse 社区情报采集与建设规划',
    cwd: CITYVERSE_INTEL_DIR,
    rule: { hhmm: '07:30' }, timeoutMs: 20 * 60 * 1000,
    // 多步顺序执行：抓取→分析→玩法库→建设规划；各脚本自带幂等/降级，某步失败即中止后续（不擅自落地代码）。
    steps: [
      { bin: 'python3', args: ['community_intel.py', 'daily'] },
      { bin: 'python3', args: ['insight_agent.py', 'analyze'] },
      { bin: 'python3', args: ['playbook_agent.py', 'seed'] },
      { bin: 'python3', args: ['playbook_agent.py', 'mine'] },
      { bin: 'python3', args: ['playbook_agent.py', 'enrich'] },
      { bin: 'python3', args: ['build_pipeline.py', 'plan'] },
      { bin: 'python3', args: ['build_pipeline.py', 'status'] },
    ],
  },
];
let scheduledCmdTimer = null;
const scheduledCmdLastRun = {}; // key -> 'YYYY-MM-DD'，防同一天重复触发

function execOne(step, cwd, timeoutMs) {
  return new Promise((resolve) => {
    execFile(step.bin, step.args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, cwd: cwd, env: pyEnv() }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: String((err && err.message) || err), output: String(stderr || '') + '\n' + String(stdout || '') });
      else resolve({ ok: true, output: String(stdout || '') });
    });
  });
}

function runScheduledCommand(t) {
  // 直跑本地脚本；脚本/命令自身负责幂等与降级，此处只记录结果到主进程日志。
  // 支持两种形态：单命令（bin+args）或多步顺序（steps 数组，某步失败即中止）。
  const agent = t.key === 'cityverse-intel' ? 'cityverse' : 'knowledge';
  const run = activity.start({ agent, source: '工作台定时任务', title: t.label });
  let status = 'failed';
  let p;
  if (Array.isArray(t.steps) && t.steps.length) {
    p = t.steps.reduce((chain, step) => {
      return chain.then((prev) => {
        if (prev && prev.ok === false) return prev; // 前一步失败，不再继续
        return execOne(step, t.cwd, t.timeoutMs);
      });
    }, Promise.resolve({ ok: true, output: '' }));
  } else {
    p = execOne(t, t.cwd, t.timeoutMs);
  }
  return p.then((r) => {
    try {
      if (r && r.ok) console.log('[' + t.key + '] 完成\n' + String(r.output || ''));
      else console.log('[' + t.key + '] ' + String((r && r.error) || '执行失败') + (r && r.output ? '\n' + String(r.output) : ''));
    } catch {}
    status = r?.ok ? 'done' : 'failed';
    return r;
  }).finally(() => activity.finish(run, { status }));
}

function startScheduledCommands() {
  if (scheduledCmdTimer) return;
  // 每 60 秒检查一次：到点（含该分钟）且当天尚未跑过，则触发一次。
  scheduledCmdTimer = setInterval(() => {
    try {
      const now = new Date();
      const hh = ('0' + now.getHours()).slice(-2);
      const mm = ('0' + now.getMinutes()).slice(-2);
      const hhmm = hh + ':' + mm;
      const weekday = now.getDay();
      const today = now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + ('0' + now.getDate()).slice(-2);
      SCHEDULED_COMMANDS.forEach((t) => {
        const rule = t.rule || {};
        // interval 模式：每 N 分钟跑一次，用时间戳记上次运行
        if (rule.intervalMinutes) {
          const last = scheduledCmdLastRun[t.key];
          if (typeof last === 'number' && (now.getTime() - last) < rule.intervalMinutes * 60 * 1000) return;
          scheduledCmdLastRun[t.key] = now.getTime();
          runScheduledCommand(t).catch(() => {});
          return;
        }
        // hhmm 模式：到点且当天未跑过则触发
        if (Array.isArray(rule.weekdays) && rule.weekdays.indexOf(weekday) < 0) return;
        if (hhmm < rule.hhmm) return;
        if (scheduledCmdLastRun[t.key] === today) return;
        scheduledCmdLastRun[t.key] = today;
        runScheduledCommand(t).catch(() => {});
      });
    } catch { /* 忽略调度异常 */ }
  }, 60 * 1000);
}

ipcMain.handle('task:list', () => {
  const q = getTaskQueue();
  return { tickets: q.list(), counts: q.counts() };
});
// 自动分拣：用 task-router 的规则分类器判断任务类型 + 默认引擎（零 AI 调用，即时返回）
ipcMain.handle('task:classify', (_e, text) => {
  try {
    const c = TaskRouter.classifyTask(text);
    const tt = TaskRouter.typeById(c.type);
    // 兜底：路由表里写的引擎必须真的在后台执行器里存在，否则任务一创建就注定失败。
    // 2026-11-26 就是 coding → codex，而 codex 只有 CLI 通道，凡是编码类任务全部
    // 当场报「未知引擎」，用户以为在烧 codex 额度，实际一行都没跑。这条分支保证
    // 「表写错」最多退化成「用了次优引擎」，而不是「用户的任务白跑」。
    let engine = tt.engine;
    let downgradedFrom = '';
    if (!CHAT_ENDPOINTS[engine]) { downgradedFrom = engine; engine = 'deepseek'; }
    return {
      type: c.type, label: c.label, score: c.score,
      engine: engine, downgradedFrom: downgradedFrom,
      boardHint: tt.boardHint,
      noBackground: !!tt.noBackground, note: tt.note || '',
    };
  } catch (e) {
    return { type: 'general', label: '通用', score: 0, engine: 'deepseek', downgradedFrom: '', boardHint: '', noBackground: false, note: '' };
  }
});
ipcMain.handle('task:create', (_e, t) => {
  const ticket = getTaskQueue().enqueue(t || {});
  broadcastTasks();
  return ticket;
});
ipcMain.handle('task:update', (_e, id, patch) => {
  const q = getTaskQueue();
  if (!q.get(id)) return null;
  if (patch && patch.status === 'cancelled') q.cancel(id);
  else if (patch && patch.status === 'queued') q.setStatus(id, 'queued');
  broadcastTasks();
  return q.get(id);
});
ipcMain.handle('task:remove', (_e, id) => { getTaskQueue().remove(id); broadcastTasks(); return true; });
ipcMain.handle('task:clear', () => {
  const q = getTaskQueue();
  ['done', 'failed', 'cancelled'].forEach((s) => q.list(s).forEach((t) => q.remove(t.id)));
  broadcastTasks();
  return true;
});
ipcMain.handle('task:run', async (_e, id) => {
  const t = getTaskQueue().get(id);
  if (!t) return { ok: false, error: '任务不存在' };
  if (t.status === 'running') return { ok: false, error: '任务已在运行' };
  // 后台执行，不阻塞 IPC；完成后由 broadcastTasks 通知面板
  runBackgroundTask(t).catch((e) => {
    getTaskQueue().fail(t.id, String((e && e.message) || e));
    broadcastTasks();
  });
  return { ok: true, id: t.id };
});
ipcMain.handle('task:retry', async (_e, id) => {
  const q = getTaskQueue();
  const t = q.get(id);
  if (!t) return { ok: false, error: '任务不存在' };
  if (t.status === 'running') return { ok: false, error: '任务已在运行' };
  // 重置失败态：清空错误、结果与对话历史，从头重跑（保留任务定义/引擎/定时）
  q.setStatus(id, 'queued', { error: '', result: '', messages: [], question: '', needsUser: false, round: 0 });
  broadcastTasks();
  runBackgroundTask(t).catch((e) => {
    q.fail(t.id, String((e && e.message) || e));
    broadcastTasks();
  });
  return { ok: true, id: t.id };
});
ipcMain.handle('task:stop', (_e, id) => {
  const q = getTaskQueue();
  const t = q.get(id);
  if (t && (t.status === 'running' || t.status === 'queued')) q.cancel(id);
  broadcastTasks();
  return true;
});

/* ---------------- IPC：灵感目录（生态雷达） ---------------- */
ipcMain.handle('eco:radar:run', async () => {
  try { return await runEcoRadar(); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('eco:radar:status', () => readJson('eco-radar.json', { seen: [], lastRun: 0, entries: [] }));

/* ---------------- 数据仪表盘：聚合本地多源数据（笔记 / 聊天 / 任务 / 日历 / 术语） ---------------- */
function localDateStr(d) {
  const x = d || new Date();
  return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2);
}

function buildDashboard() {
  const out = {
    ok: true,
    generatedAt: new Date().toISOString(),
    notes: { total: 0, withFm: 0, withTags: 0, totalChars: 0, dirs: {} },
    chat: { agents: [], totalSessions: 0, totalMessages: 0, totalChars: 0 },
    tasks: { counts: { queued: 0, running: 0, waiting: 0, done: 0, failed: 0, cancelled: 0 }, scheduled: 0 },
    calendar: { total: 0, upcoming7: 0, upcoming30: 0, categories: {} },
    terms: { total: 0 },
    heat: {},
  };
  const bump = (ts) => {
    if (!ts) return;
    const d = new Date(ts);
    if (isNaN(d.getTime())) return;
    const k = localDateStr(d);
    out.heat[k] = (out.heat[k] || 0) + 1;
  };

  // 1) Obsidian 笔记（walk vault：数量 / frontmatter / 标签 / 字数 / 目录分布 / mtime 热力）
  const vp = vaultPath();
  if (vp) {
    const skip = new Set(['.obsidian', '.trash', '.git', 'node_modules']);
    const walk = (dir) => {
      let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of es) {
        if (ent.isDirectory()) { if (!skip.has(ent.name)) walk(path.join(dir, ent.name)); continue; }
        if (!/\.md$/i.test(ent.name)) continue;
        const full = path.join(dir, ent.name);
        let content, st;
        try { content = fs.readFileSync(full, 'utf8'); st = fs.statSync(full); } catch { continue; }
        out.notes.total++;
        const fm = parseFrontmatter(content);
        if (fm.has) out.notes.withFm++;
        if (fm.tags.length) out.notes.withTags++;
        out.notes.totalChars += (fm.body || content).length;
        const rel = path.relative(vp, full).split(path.sep).join('/');
        const d0 = path.dirname(rel) || '(根目录)';
        out.notes.dirs[d0] = (out.notes.dirs[d0] || 0) + 1;
        bump(st.mtime);
      }
    };
    walk(vp);
  }

  // 2) 聊天历史（chat-history/*.json，按 Agent 聚合会话 / 消息 / 字数 / 最近活跃）
  const chatDir = path.join(dataDir(), 'chat-history');
  try {
    for (const f of fs.readdirSync(chatDir)) {
      if (!f.endsWith('.json')) continue;
      let d; try { d = JSON.parse(fs.readFileSync(path.join(chatDir, f), 'utf8')); } catch { continue; }
      const sessions = Array.isArray(d) ? d : (d && d.sessions) || [];
      let msgs = 0, chars = 0, last = 0;
      for (const s of sessions) {
        const mm = (s && s.messages) || [];
        msgs += mm.length;
        for (const m of mm) chars += String((m && m.content) || '').length;
        if (s.updatedAt) last = Math.max(last, Number(s.updatedAt) || 0);
        bump(s.createdAt);
        bump(s.updatedAt);
      }
      out.chat.agents.push({ name: f.replace(/\.json$/, ''), sessions: sessions.length, messages: msgs, chars: chars, lastActive: last || null });
      out.chat.totalSessions += sessions.length;
      out.chat.totalMessages += msgs;
      out.chat.totalChars += chars;
    }
  } catch { /* chat-history 目录不存在 */ }

  // 3) 后台任务队列（状态计数 + 定时任务数 + 创建时间热力）
  try {
    const q = getTaskQueue();
    out.tasks.counts = q.counts();
    out.tasks.scheduled = q.listScheduled().length;
    q.list().forEach((t) => bump(t.createdAt));
  } catch { /* ignore */ }

  // 4) 日历事件（secretary.json：总数 / 未来 7·30 天 / 分类分布）
  const sec = readJson('secretary.json', { events: [] });
  const now = Date.now();
  for (const ev of (sec.events || [])) {
    out.calendar.total++;
    const c = ev.category || 'other';
    out.calendar.categories[c] = (out.calendar.categories[c] || 0) + 1;
    const t = new Date(ev.at || ev.end || '').getTime();
    if (!isNaN(t)) {
      const diff = t - now;
      if (diff >= 0 && diff <= 7 * 864e5) out.calendar.upcoming7++;
      if (diff >= 0 && diff <= 30 * 864e5) out.calendar.upcoming30++;
      bump(ev.at);
    }
  }

  // 5) 术语库条目数
  const terms = readJson('terms-state.json', { terms: {} });
  out.terms.total = Object.keys(terms.terms || {}).length;

  // 6) 热力图：近 84 天连续序列（GitHub 式），按天计数
  const days = [];
  for (let i = 83; i >= 0; i--) {
    const k = localDateStr(new Date(now - i * 864e5));
    days.push({ date: k, count: out.heat[k] || 0 });
  }
  out.heatmap = days;

  return out;
}
ipcMain.handle('dashboard:get', () => {
  try { return buildDashboard(); }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

/* ---------------- IPC：研究助手「审稿闭环」（跨模型对抗式） ---------------- */
// 借鉴 ARIS（Auto-Research-In-Sleep）的 cross-model adversarial review：
// 一个引擎干活、另一个引擎当审稿人挑毛病，避免「自己给自己打分」的盲点。
// 事件：review:phase {phase,round} → review:delta {text,thinking} → review:done {ok,finalText,passed,rounds,error}
const REVIEWER_SYSTEM = '你是严谨的同行评审审稿人，专为研究内容挑毛病。只依据给定材料判断，不臆造文献与数据。逐项审查：①研究问题是否聚焦、论证有无循环或跳跃；②每条主张是否有证据支撑、能否回到材料溯源（缺来源必须标出）；③方法/数据/统计有无漏洞；④表达有无套话、空话、防御性措辞。输出：按严重程度排序的问题清单 + 一句话最关键修改指令。若确实挑不出实质问题，明确回复「通过」（不要为了挑毛病而硬挑）。';

/* ---------------- 审稿闭环 checkpoint（阶段级落盘，支持中断后续跑） ---------------- */
// 每个完整阶段（初稿 / 每轮审稿 / 每轮返修）完成后把完整状态写入磁盘；
// 中断后重启可从最近一个已完成阶段的边界续跑，只重跑中断的那一个阶段（SSE 流式无法精确续传 token）。
function reviewCheckpointFile(agent) {
  const dir = path.join(dataDir(), 'review-checkpoint');
  fs.mkdirSync(dir, { recursive: true });
  const safe = String(agent || 'default').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_').slice(0, 80);
  return path.join(dir, safe + '.json');
}
function saveReviewCheckpoint(agent, data) {
  try { fs.writeFileSync(reviewCheckpointFile(agent), JSON.stringify(data, null, 2), 'utf8'); return true; } catch { return false; }
}
function loadReviewCheckpoint(agent) {
  try { return JSON.parse(fs.readFileSync(reviewCheckpointFile(agent), 'utf8')); } catch { return null; }
}
function clearReviewCheckpoint(agent) {
  try { fs.unlinkSync(reviewCheckpointFile(agent)); } catch { /* 不存在则忽略 */ }
}
ipcMain.handle('review:checkpoint:load', (_e, agent) => loadReviewCheckpoint(agent));
ipcMain.handle('review:checkpoint:clear', (_e, agent) => { clearReviewCheckpoint(agent); return true; });

// 去道德化（abliteration）模型会顺带削弱「简洁 / 聚焦 / 知道何时停笔」能力，
// 这里不换模型、不重训，只靠采样参数强约束补回：抑制重复 + 限制长度 + 适度降温。
// 仅在命中 uncensored/abliterat 模型时生效（本地 Ollama），其余引擎不受影响。
// 思考型模型是否默认开启思考链（DeepSeek V4 系列、本地 r1 推理模型等）
function isThinkingModel(model) {
  const m = String(model || '');
  return /deepseek|v4|reasoner|\br1\b|o1|o3|thinking/i.test(m);
}

// 是否 DeepSeek V4 系模型（支持 thinking 开关参数）
function isDeepSeekModel(model) {
  return /deepseek/.test(String(model || ''));
}

// 思考模式控制：DeepSeek V4 默认「思考开启」，思考链按输出价计费、极耗 token。
// 官方建议：chat / routing / extraction / tool-use 应关闭思考；只有深度推理（多步编码/数学）才值得开。
// 实测教训（2026-11-16）：v4-pro 思考模式 + 工具循环 = 烧钱死循环——73 次调用 158 万输入 token、
// 正文仅 12 token、82% 调用零正文，纯烧钱没产出。故规则如下：
//   - 默认关闭思考（普通对话 / Agent / 后台任务一律非思考模式）
//   - 带 tools（工具循环）时同样关闭——思考 + 工具调用是烧钱死循环的根源
//   - 仅当显式 opts.thinking === true 才开启思考（保留深度推理入口）
function thinkingControl(model, opts) {
  const o = opts || {};
  if (!isDeepSeekModel(model)) return {};   // 其他引擎不支持该参数，跳过
  if (o.thinking === true) return { thinking: { type: 'enabled' } };
  return { thinking: { type: 'disabled' } };
}

// 输出 token 上限：思考模式要同时容纳「思考链 + 正文」，放宽到 32000；非思考模式 8000 足够。
function maxTokensForModel(model, thinking) {
  if (thinking) return 32000;
  return 8000;
}

function samplingForModel(model) {
  const m = String(model || '');
  if (/uncensored|abliterat/i.test(m)) {
    return {
      temperature: 0.6,           // 适度降温：减少发散，收敛到主线
      max_tokens: 3600,           // 去道德化模型易啰嗦，压到 3600（约 2000 字）杜绝没完没了
      frequency_penalty: 0.6,     // 惩罚重复 token，抑制「车轱辘话」
      presence_penalty: 0.5,      // 惩罚已出现内容，鼓励推进而非原地打转
    };
  }
  return {};
}

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
  const sessionId = String(o.sessionId || '');   // 会话级标识：审稿闭环绑定会话，支持按会话停止
  // 空闲超时：有数据持续流入就不中断，120 秒无数据才 abort；不设总时长上限，长时间任务可持续工作
  const STALL_MS = 120000;
  const ctrl = new AbortController();
  let set = activeChatAborts.get(sessionId);
  if (!set) { set = new Set(); activeChatAborts.set(sessionId, set); }
  set.add(ctrl);   // 注册，供「停止生成」abort（审稿闭环同样生效）
  let stallTimer = setTimeout(() => ctrl.abort(), STALL_MS);
  const resetStall = () => { clearTimeout(stallTimer); stallTimer = setTimeout(() => ctrl.abort(), STALL_MS); };
  const thinkingOn = o.thinking === true;   // 默认关闭思考；显式 opts.thinking 才开启深度推理
  const resp = await fetch(cfg.url, {
    method: 'POST', headers, signal: ctrl.signal,
    body: JSON.stringify(Object.assign({
      model: model, messages: messages, stream: true,
      temperature: o.temperature != null ? o.temperature : 0.7,
    }, samplingForModel(model), {
      max_tokens: o.maxTokens || maxTokensForModel(model, thinkingOn),
    }, thinkingControl(model, o))),
  });
  if (!resp.ok) {
    clearTimeout(stallTimer);
    let msg = 'HTTP ' + resp.status;
    try { const j = await resp.json(); msg = j && j.error && j.error.message ? j.error.message : msg; } catch { /* 非 JSON */ }
    throw new Error(friendlyApiError(msg, engine));
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', text = '', thinking = '', truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    resetStall();
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line || line.indexOf('data:') !== 0) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const choice = j.choices && j.choices[0];
        if (choice && choice.finish_reason === 'length') truncated = true;
        const delta = choice && choice.delta;
        if (!delta) continue;
        const t = delta.content || '';
        const th = delta.reasoning || delta.reasoning_content || '';
        if (th) { thinking += th; if (onChunk) onChunk('', th); }
        if (t) { text += t; if (onChunk) onChunk(t, ''); }
      } catch { /* 忽略坏块 */ }
    }
  }
  clearTimeout(stallTimer);
  const s2 = activeChatAborts.get(sessionId);
  if (s2) { s2.delete(ctrl); if (!s2.size) activeChatAborts.delete(sessionId); }
  return { text: text, thinking: thinking, truncated: truncated };
}

// 审稿闭环状态机：stage 表示「下一个要执行的阶段」—— 'draft' | 'review' | 'revise'；'done' 表示完成。
// 每个阶段完成后 saveReviewCheckpoint 落盘；中断后从 checkpoint 的 stage 边界续跑，只重跑中断的那个阶段。
async function runReviewLoop(st, send) {
  const { engine, model, reviewerEngine, rounds, messages, question } = st;
  const systemMsg = messages.find((m) => m.role === 'system') || { role: 'system', content: '' };

  while (st.stage !== 'done') {
    if (st.stage === 'draft') {
      send('review:phase', { phase: 'draft', round: 0, engine: engine, reviewer: reviewerEngine });
      const d = await completeChatStream(engine, messages, (t, th) => send('review:delta', { text: t, thinking: th }), { model: model, sessionId: st.sessionId });
      st.finalText = d.text;
      st.draft = d.text;
      st.stage = 'review'; st.round = 1;
      saveReviewCheckpoint(st.agent, st);
    } else if (st.stage === 'review') {
      const r = st.round;
      send('review:phase', { phase: 'review', round: r, engine: engine, reviewer: reviewerEngine });
      const reviewMsgs = [
        { role: 'system', content: REVIEWER_SYSTEM },
        { role: 'user', content: '【原始任务】\n' + question + '\n\n【待审稿的内容】\n' + st.finalText },
      ];
      const rv = await completeChatStream(reviewerEngine, reviewMsgs, (t, th) => send('review:delta', { text: t, thinking: th }), { temperature: 0.4, sessionId: st.sessionId });
      const review = String(rv.text || '').trim();
      st.reviews.push({ round: r, text: review });

      if (/^\s*通过/.test(review) || review.length < 8) {
        clearReviewCheckpoint(st.agent);
        send('review:done', { ok: true, finalText: st.finalText, passed: true, rounds: r, engine: engine, reviewer: reviewerEngine });
        return;
      }
      st.stage = 'revise';
      saveReviewCheckpoint(st.agent, st);
    } else if (st.stage === 'revise') {
      const r = st.round;
      const review = st.reviews[st.reviews.length - 1].text;
      send('review:phase', { phase: 'revise', round: r, engine: engine, reviewer: reviewerEngine });
      const reviseMsgs = [
        systemMsg,
        { role: 'user', content: '【原始任务】\n' + question },
        { role: 'assistant', content: st.finalText },
        { role: 'user', content: '【审稿人意见】\n' + review + '\n\n请据此返修：只修正审稿人指出的问题，保留原有优点，输出完整修订版（只输出修订后的正文，不要输出审稿意见）。' },
      ];
      const rv2 = await completeChatStream(engine, reviseMsgs, (t, th) => send('review:delta', { text: t, thinking: th }), { model: model, sessionId: st.sessionId });
      st.finalText = rv2.text;
      st.revises.push(rv2.text);

      if (r < rounds) {
        st.stage = 'review'; st.round = r + 1;
        saveReviewCheckpoint(st.agent, st);
      } else {
        clearReviewCheckpoint(st.agent);
        send('review:done', { ok: true, finalText: st.finalText, passed: false, rounds: rounds, engine: engine, reviewer: reviewerEngine });
        return;
      }
    }
  }
}

ipcMain.handle('chat:review-loop', (e, payload) => {
  const p = payload || {};
  const send = (ch, data) => { if (!e.sender.isDestroyed()) e.sender.send(ch, data); };

  (async () => {
    let st = null;
    let run;
    let outcome = 'failed';
    try {
      if (p.resume) {
        // 续跑：从磁盘 checkpoint 恢复状态，从断点阶段继续
        st = loadReviewCheckpoint(p.agent);
        if (!st) { send('review:done', { ok: false, error: '没有可续跑的审稿闭环任务（checkpoint 不存在）' }); return; }
        send('review:phase', { phase: 'resume', round: st.round || 0, engine: st.engine, reviewer: st.reviewerEngine });
      } else {
        const engine = String(p.engine || 'ollama');
        const model = String(p.model || '');   // 前端可选模型（仅作用于「干活」引擎，审稿引擎保持其自身默认）
        const messages = Array.isArray(p.messages) ? p.messages : [];
        const rounds = Math.min(Math.max(parseInt(p.rounds, 10) || 2, 1), 4);

        // 审稿引擎：跨模型对抗——干活是本地 ollama(qwen3.8:27b) 时默认用本地 deepseek-r1:32b 审稿；否则选已配 Key 的不同 API 引擎
        const settings = decryptSettings(readSettingsRaw());
        let reviewerEngine = String(p.reviewer || '');
        if (!reviewerEngine) {
          if (engine === 'ollama') reviewerEngine = 'ollama-review';
          else reviewerEngine = ['deepseek', 'qwen', 'gpt'].find((id) => id !== engine && settings[id]) || 'ollama';
        }

        const lastUser = [...messages].reverse().find((m) => m.role === 'user');
        const question = lastUser ? lastUser.content : '';
        st = {
          agent: String(p.agent || '研究助手'),
          sessionId: String(p.sessionId || ''),
          engine: engine, model: model, reviewerEngine: reviewerEngine,
          rounds: rounds, messages: messages, question: question,
          stage: 'draft', round: 0, finalText: '', draft: '', reviews: [], revises: [],
        };
        saveReviewCheckpoint(st.agent, st);
      }
      const agent = activitySender(e.sender);
      if (agent) run = activity.start({ agent, source: '审稿闭环', title: activityTitle(st.question) || '审稿闭环' });
      await runReviewLoop(st, (channel, event) => {
        if (channel === 'review:phase' && run) {
          const phase = { draft: '撰写初稿', review: '独立审稿', revise: '按意见返修' }[event.phase];
          activity.update(run, {
            phase: phase + (event.round ? ' · 第 ' + event.round + ' 轮' : ''),
            engine: event.phase === 'review' ? event.reviewer : event.engine,
          });
        }
        send(channel, event);
      });
      outcome = 'done';
    } catch (err) {
      send('review:done', { ok: false, error: String(err && err.message || err), finalText: st ? st.finalText : '', engine: st && st.engine, reviewer: st && st.reviewerEngine });
    } finally {
      if (run) activity.finish(run, { status: outcome });
    }
  })();
  return true;
});

/* ---------------- IPC：浏览器自动化（只读白名单） ---------------- */
// 优先用本仓库 scripts/browser-cdp 的 CDP 脚本（彻底独立），回退到 ~/.workbuddy 的 skill。
// 只做只读操作（open 打开 / text 提取文本 / shot 截图）。
function browserCdpDir() {
  const home = app.getPath('home');
  const candidates = [
    path.join(__dirname, 'scripts', 'browser-cdp'),
    path.join(home, '.workbuddy', 'skills', 'browser-automation-cdp', 'scripts'),
  ];
  for (const d of candidates) if (fs.existsSync(path.join(d, 'cdp.py'))) return d;
  return null;
}
// 系统自带 python3（独立于 WorkBuddy 的 ~/.workbuddy/binaries python）。用于「只用标准库」或「已把包装进用户级 site-packages」的脚本（doc_edit.py / kb-zotero.py / bin_patch.py / pyc_decompile.py）。
const SYSTEM_PY3 = process.platform === 'darwin' ? '/usr/bin/python3' : (process.platform === 'win32' ? 'python' : 'python3');
function pyBin() { return SYSTEM_PY3; }   // 统一走系统 python3（PyObjC 已装用户级），彻底不依赖 WorkBuddy 自带 python
// 关键坑（2026-11-16 根治）：App 从 Finder/桌面启动时 HOME 环境变量可能不是真实用户目录，
// 导致 /usr/bin/python3 的「用户级 site-packages」(~/.Library/Python/3.9/lib/python/site-packages，
// 装 python-pptx / python-docx / PyObjC) 无法被 USER_SITE 按 ~ 展开定位 → import 失败，报「缺 python-pptx」。
// 统一用 os.homedir() 覆盖 HOME，所有调 SYSTEM_PY3 的子进程都走 pyEnv()，保证 import 稳定。
function pyEnv() { const e = Object.assign({}, process.env); e.HOME = os.homedir(); return e; }
function execPy(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(pyBin(), args, { timeout: timeoutMs || 60000, maxBuffer: 4 * 1024 * 1024, env: pyEnv() }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, output: String(stderr || '') + '\n' + String(stdout || ''), error: String(err.message || err) });
      else resolve({ ok: true, output: String(stdout || '') });
    });
  });
}
// Mermaid→PPT 导出专用 python：diagram-pptx 要求 Python >= 3.10，系统 python3（3.9）装不上，
// 固定走工作台项目内的 venv_mermaid（Python 3.15，由 homebrew python 创建）。
// 注意：打包成 .app 后 __dirname 指向 Contents/Resources/app，拿不到项目目录里的 venv，
// 故用 os.homedir() 拼绝对路径（项目固定在 ~/Dev/Ingrids-AI-Agents）。优先环境变量 MERMAID2PPT_PY 覆盖。
function mermaidPyBin() {
  const home = os.homedir();
  const cands = [
    process.env.MERMAID2PPT_PY,
    path.join(home, 'Dev', 'Ingrids-AI-Agents', 'venv_mermaid', 'bin', 'python'),
    path.join(home, 'Dev', 'Ingrids-AI-Agents', 'venv_mermaid', 'bin', 'python3'),
    path.join(home, 'Desktop', 'venv_mermaid', 'bin', 'python'),
    path.join(home, 'Desktop', 'venv_mermaid', 'bin', 'python3'),
  ];
  for (const c of cands) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
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
    try { spawn(pyBin(), [startChrome], { detached: true, stdio: 'ignore', env: pyEnv() }).unref(); } catch { /* 忽略 */ }
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
/* ================= 学术级 PPT 渲染器（图表/表格/图片/主题/分栏） =================
 * 用 pptxgenjs 原生 addChart / addTable / addImage，产出可继续编辑的原生图表与版式，
 * 而不是"纯文字 bullet"。默认主题为「剑桥服务联盟（Cambridge Service Alliance）风格」的
 * 学术配色：深海军蓝 + 剑桥蓝/青绿点缀 + 大量留白，适合学术汇报/答辩/会议 talk。
 */
const PPT_THEMES = {
  academic: {
    bg: 'FFFFFF', ink: '1A2233', sub: '5A6472', line: 'E3E8EF',
    primary: '1B3A6B', accent: '1F7A8C', cambridge: 'A3C1AD', soft: 'EEF1F6',
    chartColors: ['1B3A6B', '1F7A8C', 'A3C1AD', 'C98A2B', '7C6FD6', 'B0573C'],
  },
  minimal: {
    bg: 'FFFFFF', ink: '111111', sub: '666666', line: 'E5E5E5',
    primary: '111111', accent: '444444', cambridge: '999999', soft: 'F5F5F5',
    chartColors: ['111111', '555555', '999999', 'BBBBBB', 'DDDDDD', '777777'],
  },
  corporate: {
    bg: 'FFFFFF', ink: '222A35', sub: '5C6672', line: 'E2E7ED',
    primary: '0F3D7A', accent: '00A9E0', cambridge: '8CC63F', soft: 'EEF3FA',
    chartColors: ['0F3D7A', '00A9E0', '8CC63F', 'F0A500', 'D04040', '707070'],
  },
};
function _hex(c) { return String(c == null ? '' : c).replace(/^#/, ''); }
const PPT_FONT = 'PingFang SC';   // 苹方（macOS 系统字体，中英文统一）；原 Arial 无中文，导致中文落到默认宋体/等线、观感差

// 把 bullets（字符串或 {text, sub:[...]}）转成 pptxgenjs 文本 run
function _bulletRuns(bullets, T) {
  const runs = [];
  (Array.isArray(bullets) ? bullets : []).forEach(function (b) {
    if (b && typeof b === 'object') {
      runs.push({ text: String(b.text || b.title || ''), options: { bullet: { code: '2022' }, color: T.ink, fontSize: 14, breakLine: true, paraSpaceAfter: 6 } });
      (b.sub || b.children || []).forEach(function (sub) {
        runs.push({ text: String(sub && typeof sub === 'object' ? (sub.text || '') : sub), options: { bullet: { code: '2013', indent: 18 }, color: T.sub, fontSize: 12.5, breakLine: true, paraSpaceAfter: 3 } });
      });
    } else {
      runs.push({ text: String(b), options: { bullet: { code: '2022' }, color: T.ink, fontSize: 14, breakLine: true, paraSpaceAfter: 6 } });
    }
  });
  return runs;
}

/* ================= 智能图形版式（SmartArt 风格，按「板块」数量自动匹配） =================
 * 用户要的不是「把文字罗列在页面上」，而是「分板块、清晰、有版式设计」——像
 * Cambridge 参考稿那样：标题栏 → 并列卡片 / 流程箭头 / 金字塔 / 左右对比。
 * 做法：slides 每页可选 blocks 板块数组，渲染器按板块数量自动选版式：
 *   2 块左右分栏、3 块三栏、4 块 2×2 矩阵、更多网格；flow 横向流程、pyramid 金字塔。
 */
// 单个板块卡片：圆角白底 + 柔和阴影 + 彩色图标圆 + 标题 + 分隔线 + 项目符号要点
function _addCard(slide, pptx, b, T, x, y, w, h, idx) {
  const title = String((b && (b.title || b.heading || b.name)) || '');
  const pts = (b && Array.isArray(b.points)) ? b.points : (b && Array.isArray(b.bullets)) ? b.bullets : [];
  const icon = String((b && (b.icon || b.emoji)) || '');
  const color = (b && b.accent) ? _hex(b.accent) : T.chartColors[(idx || 0) % T.chartColors.length];
  const r = 0.06;   // 圆角半径（英寸）
  // 卡片底：圆角 + 柔和阴影
  slide.addShape(pptx.ShapeType.roundRect, { x, y, w, h, rectRadius: r, fill: { color: T.bg }, line: { color: T.line, width: 1 }, shadow: { type: 'outer', color: '0A0A0A', opacity: 0.12, blur: 7, angle: 45, offset: 3 } });
  let bodyTop = y + 0.14;
  if (h >= 1.6 && (icon || title)) {
    // 标题行：彩色图标圆 + 标题
    const iconD = 0.42, ix = x + 0.16, iy = y + 0.14;
    if (icon) {
      slide.addShape(pptx.ShapeType.ellipse, { x: ix, y: iy, w: iconD, h: iconD, fill: { color: color }, line: { color: color, width: 0 } });
      slide.addText(icon, { x: ix, y: iy, w: iconD, h: iconD, fontSize: 15, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: PPT_FONT });
    }
    if (title) {
      const tx = icon ? (ix + iconD + 0.1) : (x + 0.16);
      const tw = icon ? (w - 0.32 - iconD - 0.1) : (w - 0.32);
      slide.addText(String(title), { x: tx, y: iy, w: tw, h: iconD, fontSize: 13.5, bold: true, color: T.ink, valign: 'middle', wrap: true, fontFace: PPT_FONT });
    }
    // 分隔线
    const sepY = y + 0.66;
    slide.addShape(pptx.ShapeType.rect, { x: x + 0.16, y: sepY, w: w - 0.32, h: 0.014, fill: { color: T.line }, line: { color: T.line, width: 0 } });
    bodyTop = sepY + 0.1;
  } else if (title) {
    slide.addText(String(title), { x: x + 0.16, y: y + 0.08, w: w - 0.32, h: 0.4, fontSize: 12.5, bold: true, color: T.ink, valign: 'middle', wrap: true, fontFace: PPT_FONT });
    bodyTop = y + 0.52;
  }
  // 要点（项目符号）
  const runs = pts.map(function (p) {
    const t = String(p && typeof p === 'object' ? (p.text || p.title || '') : p);
    return t ? { text: t, options: { bullet: { code: '2022' }, color: T.ink, fontSize: 11, breakLine: true, paraSpaceAfter: 4 } } : null;
  }).filter(Boolean);
  if (runs.length) slide.addText(runs, { x: x + 0.18, y: bodyTop, w: w - 0.36, h: h - (bodyTop - y) - 0.1, valign: 'top', fontFace: PPT_FONT });
}

// 卡片网格：按数量自动分栏（1 全宽 / 2 左右 / 3 三栏 / 4 2×2 / ≤6 三栏 / 更多四栏）
function _addCards(slide, pptx, blocks, T, x, y, w, h) {
  const n = blocks.length;
  let cols = 1, rows = 1;
  if (n === 1) { cols = 1; rows = 1; }
  else if (n === 2) { cols = 2; rows = 1; }
  else if (n === 3) { cols = 3; rows = 1; }
  else if (n === 4) { cols = 2; rows = 2; }
  else if (n <= 6) { cols = 3; rows = Math.ceil(n / 3); }
  else { cols = 4; rows = Math.ceil(n / 4); }
  const gap = 0.16;
  const cw = (w - gap * (cols - 1)) / cols;
  const ch = (h - gap * (rows - 1)) / rows;
  blocks.forEach(function (b, i) {
    const r = Math.floor(i / cols), c = i % cols;
    _addCard(slide, pptx, b, T, x + c * (cw + gap), y + r * (ch + gap), cw, ch, i);
  });
}

// 横向流程：等宽步骤卡片 + 箭头串联
function _addFlow(slide, pptx, blocks, T, x, y, w, h) {
  const n = blocks.length;
  const gap = 0.42;
  const stepW = (w - gap * (n - 1)) / n;
  blocks.forEach(function (b, i) {
    const sx = x + i * (stepW + gap);
    _addCard(slide, pptx, b, T, sx, y, stepW, h, i);
    if (i < n - 1) {
      slide.addShape(pptx.ShapeType.rightArrow, { x: sx + stepW + 0.04, y: y + h / 2 - 0.14, w: gap - 0.08, h: 0.28, fill: { color: T.accent }, line: { color: T.accent, width: 0 } });
    }
  });
}

// 金字塔：自上而下逐层加宽，标题居中白字
function _addPyramid(slide, pptx, blocks, T, x, y, w, h) {
  const n = blocks.length;
  const gap = 0.06;
  const layerH = (h - gap * (n - 1)) / n;
  blocks.forEach(function (b, i) {
    const ratio = (i + 1) / n;
    const lw = w * (0.35 + 0.65 * ratio);
    const lx = x + (w - lw) / 2;
    const ly = y + i * (layerH + gap);
    const color = T.chartColors[i % T.chartColors.length];
    slide.addShape(pptx.ShapeType.rect, { x: lx, y: ly, w: lw, h: layerH, fill: { color: color }, line: { color: color, width: 0 } });
    slide.addText(String((b && (b.title || b.heading || b.name)) || ''), { x: lx, y: ly, w: lw, h: layerH, fontSize: 13, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: PPT_FONT, wrap: true });
  });
}

// 横向时间线：一条轴线 + N 个节点（彩色圆点），节点上方标题、下方要点
function _addTimeline(slide, pptx, blocks, T, x, y, w, h) {
  const n = blocks.length || 1;
  const axisY = y + h * 0.34;
  slide.addShape(pptx.ShapeType.rect, { x: x + 0.25, y: axisY, w: w - 0.5, h: 0.03, fill: { color: T.line }, line: { color: T.line, width: 0 } });
  const usable = w - 0.5;
  const step = n === 1 ? 0 : usable / (n - 1);
  blocks.forEach(function (b, i) {
    const cx = n === 1 ? (x + w / 2) : (x + 0.25 + i * step);
    const color = (b && b.accent) ? _hex(b.accent) : T.chartColors[i % T.chartColors.length];
    slide.addShape(pptx.ShapeType.ellipse, { x: cx - 0.1, y: axisY - 0.1, w: 0.2, h: 0.2, fill: { color: color }, line: { color: 'FFFFFF', width: 1.5 } });
    const tt = String((b && (b.title || b.heading || b.name)) || '');
    if (tt) slide.addText(tt, { x: cx - 1.25, y: axisY - 1.1, w: 2.5, h: 0.95, fontSize: 12.5, bold: true, color: T.primary, align: 'center', valign: 'bottom', wrap: true, fontFace: PPT_FONT });
    const pts = (b && Array.isArray(b.points)) ? b.points : (b && Array.isArray(b.bullets)) ? b.bullets : [];
    const runs = pts.map(function (p) {
      const t = String(p && typeof p === 'object' ? (p.text || p.title || '') : p);
      return t ? { text: t, options: { color: T.sub, fontSize: 10, breakLine: true, paraSpaceAfter: 2 } } : null;
    }).filter(Boolean);
    if (runs.length) slide.addText(runs, { x: cx - 1.25, y: axisY + 0.22, w: 2.5, h: h * 0.62, align: 'center', valign: 'top', fontFace: PPT_FONT });
  });
}

// KPI 大数字看板：每个板块 = 圆角卡片，大数字 + 标签 + 说明（卡片高度自适应、居中）
function _addKpi(slide, pptx, blocks, T, x, y, w, h) {
  const n = blocks.length || 1;
  const cols = Math.min(n, 4);
  const gap = 0.2;
  const cw = (w - gap * (cols - 1)) / cols;
  const kpiH = Math.min(h, 2.1);
  const ky = y + (h - kpiH) / 2;
  blocks.forEach(function (b, i) {
    const bx = x + i * (cw + gap);
    const color = (b && b.accent) ? _hex(b.accent) : T.chartColors[i % T.chartColors.length];
    slide.addShape(pptx.ShapeType.roundRect, { x: bx, y: ky, w: cw, h: kpiH, rectRadius: 0.08, fill: { color: T.soft }, line: { color: T.line, width: 1 }, shadow: { type: 'outer', color: '0A0A0A', opacity: 0.1, blur: 6, angle: 45, offset: 3 } });
    const val = String((b && (b.value || b.number || b.kpi)) || ((b && b.points && b.points[0]) ? b.points[0] : ''));
    const label = String((b && (b.title || b.label || b.name)) || '');
    const sub = String((b && (b.subtitle || b.sub)) || ((b && b.points && b.points[1]) ? b.points[1] : ''));
    if (val) slide.addText(val, { x: bx + 0.1, y: ky + 0.16, w: cw - 0.2, h: 0.7, fontSize: 28, bold: true, color: color, align: 'center', valign: 'middle', fontFace: PPT_FONT });
    if (label) slide.addText(label, { x: bx + 0.12, y: ky + 0.95, w: cw - 0.24, h: 0.4, fontSize: 12.5, bold: true, color: T.ink, align: 'center', wrap: true, fontFace: PPT_FONT });
    if (sub) slide.addText(sub, { x: bx + 0.12, y: ky + 1.36, w: cw - 0.24, h: kpiH - 1.5, fontSize: 10, color: T.sub, align: 'center', wrap: true, fontFace: PPT_FONT });
  });
}

// 左右对比：多组卡片并排，彩色头部 + 彩色边框强调对比；两组时中间加 VS 圆标
function _addCompare(slide, pptx, blocks, T, x, y, w, h) {
  const n = blocks.length || 2;
  const two = n === 2;
  const gap = two ? 0.7 : 0.24;
  const cw = (w - gap * (n - 1)) / n;
  blocks.forEach(function (b, i) {
    const bx = x + i * (cw + gap);
    const color = (b && b.accent) ? _hex(b.accent) : T.chartColors[i % T.chartColors.length];
    slide.addShape(pptx.ShapeType.roundRect, { x: bx, y, w: cw, h, rectRadius: 0.07, fill: { color: T.bg }, line: { color: color, width: 1.75 }, shadow: { type: 'outer', color: '0A0A0A', opacity: 0.12, blur: 7, angle: 45, offset: 3 } });
    // 彩色头部
    slide.addShape(pptx.ShapeType.roundRect, { x: bx, y, w: cw, h: 0.62, rectRadius: 0.07, fill: { color: color }, line: { color: color, width: 0 } });
    const tt = String((b && (b.title || b.heading || b.name)) || '');
    const icon = String((b && (b.icon || b.emoji)) || '');
    const headTxt = icon ? (icon + '  ' + tt) : tt;
    if (headTxt) slide.addText(headTxt, { x: bx + 0.12, y: y + 0.04, w: cw - 0.24, h: 0.54, fontSize: 15, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', wrap: true, fontFace: PPT_FONT });
    // 要点
    const pts = (b && Array.isArray(b.points)) ? b.points : (b && Array.isArray(b.bullets)) ? b.bullets : [];
    const runs = pts.map(function (p) {
      const t = String(p && typeof p === 'object' ? (p.text || p.title || '') : p);
      return t ? { text: t, options: { bullet: { code: '2022' }, color: T.ink, fontSize: 11.5, breakLine: true, paraSpaceAfter: 5 } } : null;
    }).filter(Boolean);
    if (runs.length) slide.addText(runs, { x: bx + 0.16, y: y + 0.74, w: cw - 0.32, h: h - 0.86, valign: 'top', fontFace: PPT_FONT });
  });
  // 两组时中间 VS 圆标
  if (two) {
    const cx = x + cw + gap / 2;
    slide.addShape(pptx.ShapeType.ellipse, { x: cx - 0.24, y: y + h / 2 - 0.24, w: 0.48, h: 0.48, fill: { color: T.ink }, line: { color: T.ink, width: 0 } });
    slide.addText('VS', { x: cx - 0.24, y: y + h / 2 - 0.24, w: 0.48, h: 0.48, fontSize: 11, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle', fontFace: PPT_FONT });
  }
}

function _addChart(slide, pptx, c, T, x, y, w, h) {
  const map = { column: 'bar', bar: 'bar', line: 'line', pie: 'pie', doughnut: 'doughnut', area: 'area', radar: 'radar' };
  const t = map[String((c && c.type) || 'bar').toLowerCase()] || 'bar';
  let data;
  if (c && Array.isArray(c.series) && c.series.length) {
    data = c.series.map(function (sr) { return { name: String(sr.name || '系列'), labels: (Array.isArray(sr.labels) ? sr.labels : (c.labels || [])), values: (Array.isArray(sr.values) ? sr.values : []) }; });
  } else {
    data = [{ name: String((c && c.name) || '数值'), labels: (Array.isArray(c && c.labels) ? c.labels : []), values: (Array.isArray(c && c.values) ? c.values : []) }];
  }
  const opts = {
    x, y, w, h,
    chartColors: T.chartColors,
    showLegend: true, legendPos: 'b', legendColor: T.sub, legendFontSize: 10,
    showValue: false,
    valAxisLabelColor: T.sub, catAxisLabelColor: T.sub, valAxisLabelFontSize: 9, catAxisLabelFontSize: 9,
    dataLabelColor: T.sub, dataLabelFontSize: 10,
    valGridLine: { color: T.line, style: 'solid', size: 1 },
    catGridLine: { style: 'none' },
    title: (c && c.title) ? String(c.title) : '',
    titleColor: T.primary, titleFontSize: 13, titleFontFace: PPT_FONT, titleAlign: 'left',
    showCatAxisTitle: false, showValAxisTitle: false,
    border: { pt: 0, color: T.line },
  };
  if (t === 'bar') opts.barDir = 'col';
  if (t === 'pie' || t === 'doughnut') {
    opts.showPercent = true; opts.dataLabelPosition = 'outEnd';
    opts.showLegend = true; opts.legendPos = 'r';
  }
  slide.addChart(t, data, opts);
}

function _addTable(slide, tb, T, x, y, w, h) {
  const headers = (tb && Array.isArray(tb.headers)) ? tb.headers : [];
  const rows = (tb && Array.isArray(tb.rows)) ? tb.rows : [];
  const cell = function (text, o) { return { text: String(text == null ? '' : text), options: o }; };
  const tableRows = [];
  if (headers.length) {
    tableRows.push(headers.map(function (hh) { return cell(hh, { bold: true, fill: { color: T.primary }, color: 'FFFFFF', fontSize: 11 }); }));
  }
  rows.forEach(function (r, i) {
    const arr = Array.isArray(r) ? r : [r];
    const fill = (i % 2 === 0) ? T.bg : T.soft;
    tableRows.push(arr.map(function (cc) { return cell(cc, { fill: { color: fill }, color: T.ink, fontSize: 10.5 }); }));
  });
  slide.addTable(tableRows, {
    x, y, w, h,
    border: { type: 'solid', color: T.line, pt: 0.5 },
    fill: { color: T.bg },
    margin: 0.06, valign: 'middle', fontFace: PPT_FONT,
  });
}

function _addFooter(slide, pptx, T, idx, total, deckTitle) {
  slide.addShape(pptx.ShapeType.rect, { x: 0.6, y: 7.02, w: 12.13, h: 0.006, fill: { color: T.line } });
  slide.addText(String(deckTitle || ''), { x: 0.6, y: 7.08, w: 9, h: 0.32, fontSize: 9, color: T.sub, fontFace: PPT_FONT });
  slide.addText((idx + 1) + ' / ' + total, { x: 11.3, y: 7.08, w: 1.43, h: 0.32, fontSize: 9, color: T.sub, fontFace: PPT_FONT, align: 'right' });
}

function _addPptxSlide(pptx, s, T, idx, total, p) {
  const slide = pptx.addSlide();
  slide.background = { color: T.bg };
  const layout = String(s.layout || 'content').toLowerCase();
  const hasChart = Array.isArray(s.charts) && s.charts.length;
  const hasTable = s.table && (Array.isArray(s.table.rows) || Array.isArray(s.table.headers));
  const hasImage = !!(s.image && (s.image.path || s.image.src || typeof s.image === 'string'));

  if (layout === 'title') {
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.333, h: 0.26, fill: { color: T.primary } });
    // 装饰：左下淡色大圆 + 右下 accent 小圆
    slide.addShape(pptx.ShapeType.ellipse, { x: -1.2, y: 5.3, w: 3.4, h: 3.4, fill: { color: T.soft }, line: { color: T.soft, width: 0 } });
    slide.addShape(pptx.ShapeType.ellipse, { x: 12.35, y: 6.35, w: 0.75, h: 0.75, fill: { color: T.accent }, line: { color: T.accent, width: 0 } });
    if (s.title) slide.addText(String(s.title), { x: 0.9, y: 2.35, w: 11.53, h: 1.45, fontSize: 36, bold: true, color: T.primary, fontFace: PPT_FONT, align: 'center', valign: 'middle', wrap: true });
    // 标题下装饰短横线
    slide.addShape(pptx.ShapeType.roundRect, { x: 6.06, y: 3.92, w: 1.21, h: 0.07, rectRadius: 0.035, fill: { color: T.accent }, line: { color: T.accent, width: 0 } });
    if (s.subtitle) slide.addText(String(s.subtitle), { x: 0.9, y: 4.12, w: 11.53, h: 0.7, fontSize: 17, color: T.accent, fontFace: PPT_FONT, align: 'center' });
    const byline = [p.author, p.date].filter(Boolean).join(' · ');
    if (byline) slide.addText(byline, { x: 0.9, y: 5.85, w: 11.53, h: 0.5, fontSize: 12, color: T.sub, fontFace: PPT_FONT, align: 'center' });
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 7.26, w: 13.333, h: 0.24, fill: { color: T.cambridge } });
    return;
  }

  if (layout === 'section') {
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.24, h: 7.5, fill: { color: T.primary } });
    // 装饰：右下淡色大圆
    slide.addShape(pptx.ShapeType.ellipse, { x: 10.6, y: 5.4, w: 3.4, h: 3.4, fill: { color: T.soft }, line: { color: T.soft, width: 0 } });
    if (s.title) slide.addText(String(s.title), { x: 1.0, y: 2.6, w: 11.4, h: 1.5, fontSize: 36, bold: true, color: T.primary, fontFace: PPT_FONT, valign: 'middle' });
    // 标题下装饰短横线
    slide.addShape(pptx.ShapeType.roundRect, { x: 1.04, y: 4.16, w: 1.1, h: 0.07, rectRadius: 0.035, fill: { color: T.accent }, line: { color: T.accent, width: 0 } });
    if (s.subtitle) slide.addText(String(s.subtitle), { x: 1.0, y: 4.4, w: 11.4, h: 0.8, fontSize: 15, color: T.sub, fontFace: PPT_FONT });
    return;
  }

  // content / twoCol / blank
  let bodyTop = 0.45;
  if (layout !== 'blank' && s.title) {
    slide.addShape(pptx.ShapeType.rect, { x: 0.6, y: 0.5, w: 0.14, h: 0.62, fill: { color: T.accent } });
    slide.addText(String(s.title), { x: 0.88, y: 0.44, w: 11.85, h: 0.75, fontSize: 24, bold: true, color: T.primary, fontFace: PPT_FONT, valign: 'middle' });
    bodyTop = 1.38;
    if (s.subtitle) {
      slide.addText(String(s.subtitle), { x: 0.88, y: 1.16, w: 11.85, h: 0.42, fontSize: 13, color: T.sub, fontFace: PPT_FONT });
      bodyTop = 1.68;
    }
  }

  const bodyH = 7.02 - bodyTop;
  // 智能图形版式：有「板块 blocks」时，按数量自动匹配卡片网格/流程/金字塔/对比
  if (Array.isArray(s.blocks) && s.blocks.length) {
    const sl = String(s.layout || 'cards').toLowerCase();
    if (sl === 'flow') _addFlow(slide, pptx, s.blocks, T, 0.6, bodyTop, 12.13, bodyH);
    else if (sl === 'pyramid') _addPyramid(slide, pptx, s.blocks, T, 0.6, bodyTop, 12.13, bodyH);
    else if (sl === 'timeline') _addTimeline(slide, pptx, s.blocks, T, 0.6, bodyTop, 12.13, bodyH);
    else if (sl === 'kpi') _addKpi(slide, pptx, s.blocks, T, 0.6, bodyTop, 12.13, bodyH);
    else if (sl === 'compare') _addCompare(slide, pptx, s.blocks, T, 0.6, bodyTop, 12.13, bodyH);
    else _addCards(slide, pptx, s.blocks, T, 0.6, bodyTop, 12.13, bodyH);
    if (s.notes) slide.addNotes(String(s.notes));
    _addFooter(slide, pptx, T, idx, total, p.title);
    return;
  }
  if (layout === 'twoCol' && !hasChart && !hasTable) {
    let cols = Array.isArray(s.columns) ? s.columns : null;
    if (!cols && Array.isArray(s.bullets)) {
      const half = Math.ceil(s.bullets.length / 2);
      cols = [s.bullets.slice(0, half), s.bullets.slice(half)];
    }
    const runsL = _bulletRuns(cols && cols[0], T);
    const runsR = _bulletRuns(cols && cols[1], T);
    if (runsL.length) slide.addText(runsL, { x: 0.7, y: bodyTop, w: 5.9, h: bodyH, valign: 'top', fontFace: PPT_FONT });
    if (runsR.length) slide.addText(runsR, { x: 6.7, y: bodyTop, w: 5.9, h: bodyH, valign: 'top', fontFace: PPT_FONT });
  } else if (hasChart && (Array.isArray(s.bullets) && s.bullets.length)) {
    const runs = _bulletRuns(s.bullets, T);
    slide.addText(runs, { x: 0.7, y: bodyTop, w: 5.4, h: bodyH, valign: 'top', fontFace: PPT_FONT });
    const n = s.charts.length, cw = (n === 1) ? 6.2 : 3.05, cx = 6.35;
    s.charts.forEach(function (c, i) {
      const x = (n === 1) ? cx : cx + i * (cw + 0.1);
      _addChart(slide, pptx, c, T, x, bodyTop, cw, bodyH);
    });
  } else if (hasChart) {
    const n = s.charts.length;
    s.charts.forEach(function (c, i) {
      const cw = (n === 1) ? 12.13 : 6.0;
      const x = (n === 1) ? 0.6 : 0.6 + i * (cw + 0.13);
      _addChart(slide, pptx, c, T, x, bodyTop, cw, bodyH);
    });
  } else if (hasTable) {
    _addTable(slide, s.table, T, 0.6, bodyTop, 12.13, bodyH);
  } else if (hasImage) {
    const src = (typeof s.image === 'string') ? s.image : (s.image.path || s.image.src);
    const bullets = Array.isArray(s.bullets) ? s.bullets : [];
    if (src && bullets.length) {
      // 图文混排：左图右文
      const abs = path.isAbsolute(src) ? src : path.resolve(src);
      const imgW = 5.6, gap = 0.3;
      if (fs.existsSync(abs)) slide.addImage({ path: abs, x: 0.6, y: bodyTop, w: imgW, h: bodyH, sizing: { type: 'contain', w: imgW, h: bodyH } });
      else slide.addText('（图片未找到：' + src + '）', { x: 0.6, y: bodyTop, w: imgW, h: 0.5, color: 'C0392B', fontSize: 13 });
      const runs = _bulletRuns(bullets, T);
      if (runs.length) slide.addText(runs, { x: 0.6 + imgW + gap, y: bodyTop, w: 12.13 - imgW - gap, h: bodyH, valign: 'top', fontFace: PPT_FONT });
    } else if (src) {
      const abs = path.isAbsolute(src) ? src : path.resolve(src);
      if (fs.existsSync(abs)) slide.addImage({ path: abs, x: 0.6, y: bodyTop, w: 12.13, h: bodyH, sizing: { type: 'contain', w: 12.13, h: bodyH } });
      else slide.addText('（图片未找到：' + src + '）', { x: 0.6, y: bodyTop, w: 12.13, h: 0.5, color: 'C0392B', fontSize: 13 });
    }
  } else {
    const runs = _bulletRuns(s.bullets, T);
    if (runs.length) slide.addText(runs, { x: 0.7, y: bodyTop, w: 11.93, h: bodyH, valign: 'top', fontFace: PPT_FONT });
  }

  if (s.notes) slide.addNotes(String(s.notes));
  _addFooter(slide, pptx, T, idx, total, p.title);
}

// 中文字体后处理：pptxgenjs 的 theme 只写 latin 字体、<a:ea>（东亚字体）留空，
// 导致中文落到 PowerPoint 默认东亚字体（宋体/等线）。用 JSZip 打开生成后的 pptx，
// 把 theme1.xml 的 latin/ea/cs 统一改成中文字体，中文 PPT 观感立刻从「土」变「现代」。
async function applyCjkFont(file, font) {
  try {
    const JSZip = require('jszip');
    const data = fs.readFileSync(file);
    const zip = await JSZip.loadAsync(data);
    const themes = Object.keys(zip.files).filter(function (f) { return /^ppt\/theme\/theme\d+\.xml$/.test(f); });
    let changed = false;
    for (const tf of themes) {
      let xml = await zip.file(tf).async('string');
      const before = xml;
      xml = xml.replace(/<a:latin typeface="[^"]*"/g, '<a:latin typeface="' + font + '"');
      xml = xml.replace(/<a:ea typeface="[^"]*"/g, '<a:ea typeface="' + font + '"');
      xml = xml.replace(/<a:cs typeface="[^"]*"/g, '<a:cs typeface="' + font + '"');
      if (xml !== before) { zip.file(tf, xml); changed = true; }
    }
    if (changed) {
      const out = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      fs.writeFileSync(file, out);
    }
  } catch (e) {
    console.warn('[ppt] 中文字体后处理失败（不影响生成，中文可能落默认字体）：', e && e.message);
  }
}

function renderPptx(p, file) {
  return new Promise(function (resolve, reject) {
    try {
      const PptxGenJS = require('pptxgenjs');
      const pptx = new PptxGenJS();
      if (String(p.size) === '4x3') { pptx.defineLayout({ name: 'STD', width: 10, height: 7.5 }); pptx.layout = 'STD'; }
      else { pptx.defineLayout({ name: 'WIDE', width: 13.333, height: 7.5 }); pptx.layout = 'WIDE'; }
      pptx.author = String(p.author || "Ingrid's AI Agents");
      pptx.title = String(p.title || '');
      const base = PPT_THEMES[String(p.theme || 'academic').toLowerCase()] || PPT_THEMES.academic;
      const T = Object.assign({}, base, {
        primary: p.primary ? _hex(p.primary) : base.primary,
        accent: p.accent ? _hex(p.accent) : base.accent,
      });
      const slides = (Array.isArray(p.slides) && p.slides.length)
        ? p.slides
        : [{ title: String(p.title || '未命名'), bullets: [] }];
      slides.forEach(function (s, idx) {
        try { _addPptxSlide(pptx, s, T, idx, slides.length, p); }
        catch (e) {
          const sl = pptx.addSlide();
          sl.addText('（本页渲染失败：' + String(e && e.message || e) + '）', { x: 0.5, y: 0.5, w: 12, h: 1, color: 'C0392B', fontSize: 13 });
        }
      });
      pptx.writeFile({ fileName: file }).then(function () {
        return applyCjkFont(file, String(p.font || PPT_FONT)).then(function () { resolve({ ok: true }); });
      }).catch(reject);
    } catch (err) { reject(err); }
  });
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
      await renderPptx(p, file);
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

/* ---------------- IPC：Mermaid -> PPT 流程图导出（diagram-pptx） ---------------- */
ipcMain.handle('mermaid2ppt:export', async (_e, p) => {
  const py = mermaidPyBin();
  if (!py) return { ok: false, error: '未找到 diagram-pptx 环境（venv_mermaid）。请确认 ~/Dev/Ingrids-AI-Agents/venv_mermaid 存在并已安装 diagram-pptx，或设置环境变量 MERMAID2PPT_PY 指向含 diagram-pptx 的 python' };
  const script = path.join(__dirname, 'scripts', 'mermaid2ppt_export.py');
  if (!fs.existsSync(script)) return { ok: false, error: '缺少导出脚本 scripts/mermaid2ppt_export.py' };
  const source = String((p && p.source) || '').trim();
  if (!source) return { ok: false, error: 'Mermaid 源码为空' };
  const style = String((p && p.style) || 'native');

  const save = await dialog.showSaveDialog({
    title: '导出 PPT',
    defaultPath: path.join(exportDir(), safeFilename('流程图') + '.pptx'),
    filters: [{ name: 'PowerPoint 演示文稿', extensions: ['pptx'] }],
  });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };

  const payload = JSON.stringify({ source, style, out_path: save.filePath });
  return new Promise((resolve) => {
    const child = spawn(py, [script], { env: pyEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
    child.on('close', () => {
      try {
        resolve(JSON.parse(out.trim()));
      } catch (e) {
        resolve({ ok: false, error: '导出脚本无有效输出：' + String((err || out || '').slice(0, 400)) });
      }
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
});

// 保真图片导出：前端把 mermaid.js 渲染的 SVG 转成 PNG（base64），主进程嵌入 16:9 空白 PPT。
// 用于 diagram-pptx 布局质量差的图（sequence/class/state/ER 等），保证与预览一致。
ipcMain.handle('mermaid2ppt:image', async (_e, p) => {
  const py = mermaidPyBin();
  if (!py) return { ok: false, error: '未找到 python 环境（venv_mermaid）。请确认 ~/Dev/Ingrids-AI-Agents/venv_mermaid 存在' };
  const script = path.join(__dirname, 'scripts', 'mermaid2ppt_image.py');
  if (!fs.existsSync(script)) return { ok: false, error: '缺少导出脚本 scripts/mermaid2ppt_image.py' };
  const png = String((p && p.png) || '').trim();
  if (!png) return { ok: false, error: '缺少图片数据' };

  const save = await dialog.showSaveDialog({
    title: '导出 PPT（高清图片）',
    defaultPath: path.join(exportDir(), safeFilename('流程图') + '.pptx'),
    filters: [{ name: 'PowerPoint 演示文稿', extensions: ['pptx'] }],
  });
  if (save.canceled || !save.filePath) return { ok: false, canceled: true };

  const payload = JSON.stringify({ png, out_path: save.filePath });
  return new Promise((resolve) => {
    const child = spawn(py, [script], { env: pyEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
    child.on('close', () => {
      try {
        resolve(JSON.parse(out.trim()));
      } catch (e) {
        resolve({ ok: false, error: '导出脚本无有效输出：' + String((err || out || '').slice(0, 400)) });
      }
    });
    child.stdin.write(payload);
    child.stdin.end();
  });
});

/* ---------------- IPC：打开 / 在文件夹中显示 本地文件 ---------------- */
ipcMain.handle('fs:open', async (_e, p) => {
  const f = String((p && p.path) || p || '').trim();
  if (!f) return { ok: false, error: '路径为空' };
  try { const err = await shell.openPath(f); return { ok: !err, error: err ? String(err) : null }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});
ipcMain.handle('fs:reveal', async (_e, p) => {
  const f = String((p && p.path) || p || '').trim();
  if (!f) return { ok: false, error: '路径为空' };
  try { shell.showItemInFolder(f); return { ok: true }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
});

/* ---------------- IPC：网页抓取（Firecrawl 的免费替代） ---------------- */
ipcMain.handle('web:fetch', async (_e, payload) => {
  const url = String((payload || {}).url || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '仅支持 http/https 链接' };
  try {
    const res = await fetch(url, { headers: { 'User-Agent': WEB_UA }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { ok: false, error: '抓取失败：HTTP ' + res.status };
    const html = await res.text();
    const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
    const title = titleM ? htmlToText(titleM[1]) : url;
    let text = htmlBodyText(html);
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
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': WEB_UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { ok: false, error: '搜索失败：HTTP ' + res.status };
    const results = parseDuckDuckGo(await res.text(), n);
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
  return updateSecretary(function () { return clean; }).then(function () { return true; });
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
ipcMain.handle('notion:test', async () => {
  const t = notionToken();
  if (!t) return { configured: false, ok: false, error: '尚未配置 Notion token' };
  const r = await NotionEngine.diagnose(t);
  return Object.assign({ configured: true }, r);
});

/* ---------------- 系统权限自检（macOS 受保护目录可读性） ---------------- */
ipcMain.handle('fs:perm-check', () => {
  const dirs = [
    { key: 'desktop', label: '桌面', path: app.getPath('desktop') },
    { key: 'documents', label: '文稿', path: app.getPath('documents') },
    { key: 'downloads', label: '下载', path: app.getPath('downloads') },
    { key: 'home', label: '主目录', path: app.getPath('home') },
  ];
  const result = {};
  for (const d of dirs) {
    try { fs.readdirSync(d.path); result[d.key] = { ok: true, path: d.path, label: d.label }; }
    catch (e) { result[d.key] = { ok: false, path: d.path, label: d.label, code: (e && e.code) || '' }; }
  }
  // 授权「完全磁盘访问」时要在系统设置里选择这个 Electron 应用（.app bundle）
  result._electronApp = path.resolve(process.execPath, '..', '..', '..');
  return result;
});

/* ---------------- Notion 自动同步（定时拉取全文 → 增量索引 → 变化通知） ---------------- */
async function runNotionSync() {
  const t = notionToken();
  if (!t) return { skipped: true, reason: 'no-token' };
  const cachePath = path.join(dataDir(), 'kb', 'notion-cache.json');
  let before = [];
  try { const c = JSON.parse(fs.readFileSync(cachePath, 'utf8')); before = Array.isArray(c.docs) ? c.docs : []; } catch {}
  const beforeIds = new Set(before.map((d) => d.id));
  const beforeTitle = {};
  before.forEach((d) => { beforeTitle[d.id] = d.title; });

  await kbEngine.scan({ force: true });

  let after = [];
  try { const c = JSON.parse(fs.readFileSync(cachePath, 'utf8')); after = Array.isArray(c.docs) ? c.docs : []; } catch {}
  const afterIds = new Set(after.map((d) => d.id));
  let added = 0, removed = 0, updated = 0;
  after.forEach((d) => { if (!beforeIds.has(d.id)) added++; else if ((beforeTitle[d.id] || '') !== (d.title || '')) updated++; });
  beforeIds.forEach((id) => { if (!afterIds.has(id)) removed++; });

  const changed = added + removed + updated;
  const summary = { ok: true, total: after.length, added: added, removed: removed, updated: updated, syncedAt: Date.now() };
  if (changed > 0) {
    const parts = [];
    if (added) parts.push('新增 ' + added);
    if (updated) parts.push('更新 ' + updated);
    if (removed) parts.push('移除 ' + removed);
    try { if (Notification.isSupported()) new Notification({ title: 'Notion 已同步', body: '共 ' + after.length + ' 篇（' + parts.join('、') + '）' }).show(); } catch { /* 通知失败不阻断 */ }
  }
  broadcast('notion:synced', summary);
  return summary;
}
ipcMain.handle('notion:sync', () => runNotionSync());

/* ---------------- 研究同步官：本地 latest 目录 → Notion 页面（增量推送） ---------------- */
function researchSyncDir() {
  const s = decryptSettings(readSettingsRaw());
  if (s.researchSyncDir) return s.researchSyncDir;
  return path.join(app.getPath('desktop'), 'PhD', '++Cambridge', '2026', 'New Direction', '中国参访后调整', 'latest');
}
function researchSyncParentId() { return decryptSettings(readSettingsRaw()).researchSyncParentId || ''; }
function researchMapPath() { return path.join(dataDir(), 'research-sync-map.json'); }
function loadResearchMap() { try { return JSON.parse(fs.readFileSync(researchMapPath(), 'utf8')); } catch { return {}; } }
function saveResearchMap(m) { fs.writeFileSync(researchMapPath(), JSON.stringify(m, null, 2), 'utf8'); }

/** 把 latest 目录里的 .md / .docx 推送到 Notion 父页面下（md 直读，docx 用 textutil 提取文本）。
 *  增量：新文件建页；mtime 变化则归档旧页重建；未变化跳过。返回 summary 并广播。 */
async function runResearchSync() {
  const t = notionToken();
  if (!t) return { ok: false, error: '尚未配置 Notion token' };
  const parentId = researchSyncParentId();
  if (!parentId) return { ok: false, error: '尚未配置 Notion 目标页面 ID（在研究同步官面板填写）' };
  const dir = researchSyncDir();
  if (!fs.existsSync(dir)) return { ok: false, error: '同步目录不存在：' + dir };

  const files = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.') || name.startsWith('~$')) continue;      // 跳过隐藏/Word 临时文件
    if (!/\.(md|docx)$/i.test(name)) continue;
    const full = path.join(dir, name);
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    files.push({ name: name, full: full, mtime: st.mtimeMs });
  }

  const map = loadResearchMap();
  let created = 0, updated = 0, unchanged = 0, failed = 0;
  const errors = [];
  for (const f of files) {
    try {
      let text = '';
      if (/\.md$/i.test(f.name)) text = fs.readFileSync(f.full, 'utf8');
      else text = execFileSync('textutil', ['-convert', 'txt', '-stdout', f.full], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
      if (!String(text || '').trim()) { unchanged++; continue; }

      const key = f.name;
      const existing = map[key];
      if (existing && existing.pageId && Math.abs((existing.mtime || 0) - f.mtime) < 1000) { unchanged++; continue; }

      if (existing && existing.pageId) {
        try { await NotionEngine.archivePage(t, existing.pageId); } catch { /* 归档失败不阻断重建 */ }
      }
      const title = f.name.replace(/\.(md|docx)$/i, '');
      const page = await NotionEngine.createPage(t, parentId, title, text);
      map[key] = { pageId: page.id, title: title, mtime: f.mtime, syncedAt: Date.now() };
      if (existing && existing.pageId) updated++; else created++;
    } catch (e) {
      failed++;
      errors.push(f.name + '：' + String((e && e.message) || e));
    }
  }

  saveResearchMap(map);
  const summary = { ok: true, total: files.length, created: created, updated: updated, unchanged: unchanged, failed: failed, errors: errors, syncedAt: Date.now() };
  if (created + updated > 0) {
    try {
      if (Notification.isSupported()) new Notification({ title: '研究同步官', body: '已同步 ' + (created + updated) + ' 篇到 Notion（新增 ' + created + '、更新 ' + updated + '）' }).show();
    } catch { /* 通知失败不阻断 */ }
  }
  broadcast('research:synced', summary);
  return summary;
}
ipcMain.handle('notion:research-sync', () => runResearchSync());
ipcMain.handle('notion:research-config', (_e, cfg) => {
  if (cfg && typeof cfg === 'object') {
    const patch = {};
    if (cfg.parentId !== undefined) patch.researchSyncParentId = String(cfg.parentId || '');
    if (cfg.dir !== undefined) patch.researchSyncDir = String(cfg.dir || '');
    if (Object.keys(patch).length) writeSettings(patch);
  }
  return { parentId: researchSyncParentId(), dir: researchSyncDir() };
});

// 列出 Notion 里所有页面（供研究同步官「选一个作为同步目标」的下拉选择器用，免手动复制 ID）
ipcMain.handle('notion:list-pages', async () => {
  const t = notionToken();
  if (!t) return { ok: false, error: '尚未配置 Notion token' };
  try {
    const objs = await NotionEngine.listAll(t);
    const pages = objs
      .filter((o) => o.object === 'page')
      .map((o) => ({ id: o.id, title: o.title || o.id, url: o.url || '' }));
    return { ok: true, pages };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
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

/* ---------------- IPC：读取本机短信（macOS Messages 数据库，只读） ----------------
 * 读 ~/Library/Messages/chat.db（SMS + iMessage），用系统自带 /usr/bin/sqlite3 查询，
 * 只取最近 N 条「text 非空」的消息（旧版文本短信）；attributedBody 富文本（多数 iMessage）
 * 解析复杂暂不覆盖。需「完全磁盘访问权限」，否则 SQLite 打不开会返回权限错误。
 */
function appleEpochToMs(apple) {
  let v = Number(apple);
  if (!v || !isFinite(v)) return 0;
  if (v > 1e18) v = Math.floor(v / 1e9);            // macOS 10.13+ 的 date 是纳秒
  return Math.round((v + 978307200) * 1000);         // Apple epoch(2001-01-01) → Unix 毫秒
}
function readMacMessages(payload) {
  return new Promise((resolve) => {
    const opts = payload || {};
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 60, 1), 200);
    if (process.platform !== 'darwin') { resolve({ ok: false, error: '仅 macOS 支持读取 iMessage / 短信' }); return; }
    const dbPath = path.join(app.getPath('home'), 'Library', 'Messages', 'chat.db');
    if (!fs.existsSync(dbPath)) { resolve({ ok: false, error: '未找到短信数据库：' + dbPath }); return; }
    const sqlite = '/usr/bin/sqlite3';
    const q = "SELECT m.text, m.date, m.is_from_me, m.service, h.id FROM message m " +
      "LEFT JOIN handle h ON m.handle_id = h.ROWID " +
      "WHERE m.text IS NOT NULL AND trim(m.text) != '' ORDER BY m.date DESC LIMIT " + limit + ';';
    execFile(sqlite, ['-separator', '\u001f', '-nullvalue', '', dbPath, q], { timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        const msg = String((err && err.message) || err);
        if (/unable to open database|authorization|permission|not authorized/i.test(msg)) {
          resolve({ ok: false, error: '无法读取短信数据库（需在「完全磁盘访问」里授权本应用）' });
        } else {
          resolve({ ok: false, error: '读取短信失败：' + msg });
        }
        return;
      }
      const rows = String(stdout || '').split('\n').filter(Boolean);
      const messages = [];
      for (const line of rows) {
        const parts = line.split('\u001f');
        if (parts.length < 4) continue;
        const text = (parts[0] || '').trim();
        if (!text) continue;
        const ms = appleEpochToMs(parts[1]);
        const isFromMe = parts[2] === '1';
        const service = parts[3] || '';
        const handle = parts[4] || '';
        messages.push({
          text: text,
          from: isFromMe ? '我' : handle,
          isFromMe: isFromMe,
          service: service,
          ts: ms,
          dateText: ms ? new Date(ms).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '',
        });
      }
      resolve({ ok: true, messages: messages, count: messages.length });
    });
  });
}
ipcMain.handle('messages:read', (_e, payload) => readMacMessages(payload));

/* ---------------- IPC：读取本机 Outlook 邮件（AppleScript/JXA，只读） ----------------
 * 绕开 Microsoft Graph OAuth（需要 Azure 应用注册，学校租户通常禁止学生注册）。
 * 直接通过系统脚本桥读取「已登录的本机 Microsoft Outlook」收件箱邮件。
 * 需用户在「系统设置 → 隐私与安全性 → 自动化」里允许本应用控制 Microsoft Outlook。
 */
function buildOutlookDiag(obj) {
  const parts = [];
  if (obj && Array.isArray(obj.found) && obj.found.length) parts.push('账号：' + obj.found.map((s) => String(s || '').trim()).filter(Boolean).join('；'));
  if (obj && Array.isArray(obj.folders) && obj.folders.length) parts.push('文件夹：' + obj.folders.map((s) => String(s || '').trim()).filter(Boolean).join('；'));
  if (obj && obj.selectedFolder) parts.push('当前选中：' + String(obj.selectedFolder).trim());
  return parts.join(' | ');
}

function readOutlookMail() {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') { resolve({ ok: false, error: '仅 macOS 支持读取本机 Outlook' }); return; }
    const script = 'function run(){\n' +
      '  var Outlook = Application("Microsoft Outlook");\n' +
      '  var res = { account: "", found: [], folders: [], selectedFolder: "", total: 0, inWindow: 0, mails: [] };\n' +
      '  // 收集具体账号类型（account 是抽象类，新版 Outlook 里不能用 Outlook.accounts 枚举）\n' +
      '  function addAccounts(getter, all) {\n' +
      '    try {\n' +
      '      var arr = getter();\n' +
      '      var ac = arr.length;\n' +
      '      for (var i = 0; i < ac; i++) {\n' +
      '        var addr = ""; var nm = "";\n' +
      '        try { addr = String(arr[i].emailAddress() || ""); } catch (e) {}\n' +
      '        try { nm = String(arr[i].name() || ""); } catch (e) {}\n' +
      '        all.push({ addr: addr, name: nm, ref: arr[i] });\n' +
      '      }\n' +
      '    } catch (e) {}\n' +
      '  }\n' +
      '  var all = [];\n' +
      '  addAccounts(function(){ return Outlook.exchangeAccounts(); }, all);\n' +
      '  addAccounts(function(){ return Outlook.imapAccounts(); }, all);\n' +
      '  addAccounts(function(){ return Outlook.popAccounts(); }, all);\n' +
      '  addAccounts(function(){ return Outlook.easAccounts(); }, all);\n' +
      '  var cam = null;\n' +
      '  for (var a = 0; a < all.length; a++) {\n' +
      '    res.found.push((all[a].addr || "") + " " + (all[a].name || ""));\n' +
      '    if (!cam && /cam\\.ac\\.uk/i.test(all[a].addr)) cam = all[a].ref;\n' +
      '  }\n' +
      '  var msgs = null;\n' +
      '  // 优先：找到剑桥账号 → 直接读它的收件箱\n' +
      '  if (cam) {\n' +
      '    try {\n' +
      '      var addr2 = String(cam.emailAddress() || "");\n' +
      '      msgs = cam.inbox.messages;\n' +
      '      res.account = addr2;\n' +
      '    } catch (e) { cam = null; msgs = null; }\n' +
      '  }\n' +
      '  // 兜底 A：账号枚举失败 → 遍历所有 mail folder，按所属账号反查剑桥收件箱\n' +
      '  if (!msgs) {\n' +
      '    try {\n' +
      '      var folders = Outlook.mailFolders();\n' +
      '      var fn = folders.length;\n' +
      '      for (var f = 0; f < fn; f++) {\n' +
      '        var fname = ""; var facc = ""; var unread = "";\n' +
      '        try { fname = String(folders[f].name() || ""); } catch (e) {}\n' +
      '        try { facc = String(folders[f].account.emailAddress() || ""); } catch (e2) {}\n' +
      '        try { unread = String(folders[f].unreadCount()); } catch (e3) {}\n' +
      '        if (res.folders.length < 60) res.folders.push(fname + " | " + facc + " | 未读=" + unread);\n' +
      '        if (!msgs && /cam\\.ac\\.uk/i.test(facc) && /inbox/i.test(fname)) {\n' +
      '          res.account = facc;\n' +
      '          try { msgs = folders[f].messages; } catch (e4) {}\n' +
      '        }\n' +
      '      }\n' +
      '    } catch (e) {}\n' +
      '  }\n' +
      '  // 兜底 B：读取当前选中的文件夹（用户先在 Outlook 里点选剑桥收件箱，selectedFolder 反映 UI 状态，可穿透 Hx 账号）\n' +
      '  if (!msgs) {\n' +
      '    try {\n' +
      '      var sf = Outlook.selectedFolder();\n' +
      '      if (sf) {\n' +
      '        var sfName = ""; var sfAcc = "";\n' +
      '        try { sfName = String(sf.name() || ""); } catch (e) {}\n' +
      '        try { sfAcc = String(sf.account.emailAddress() || ""); } catch (e2) {}\n' +
      '        res.selectedFolder = sfName + " | " + sfAcc;\n' +
      '        if (/cam\\.ac\\.uk/i.test(sfAcc)) res.account = sfAcc;\n' +
      '        try { var sfm = sf.messages; if (sfm && sfm.length > 0) msgs = sfm; } catch (e3) {}\n' +
      '      }\n' +
      '    } catch (e) {}\n' +
      '  }\n' +
      '  // 兜底 C：当前视图消息（Outlook 正在展示的邮件列表）\n' +
      '  if (!msgs) {\n' +
      '    try {\n' +
      '      var cm = Outlook.currentMessages();\n' +
      '      if (cm && cm.length > 0) msgs = cm;\n' +
      '    } catch (e) {}\n' +
      '  }\n' +
      '  // 兜底 D：默认收件箱\n' +
      '  if (!msgs) {\n' +
      '    try { msgs = Outlook.inbox.messages; } catch (e) {}\n' +
      '  }\n' +
      '  if (!msgs) { return JSON.stringify(res); }\n' +
      '  var n = msgs.length;\n' +
      '  var now = Date.now();\n' +
      '  var weekAgo = now - 7 * 24 * 60 * 60 * 1000;\n' +
      '  var kept = [];\n' +
      '  // 第一遍：只读接收时间（轻量），筛出最近一周的邮件索引；不依赖收件箱排序，扫全部而非只扫前 N 封\n' +
      '  for (var i = 0; i < n; i++) {\n' +
      '    var tm = null;\n' +
      '    try {\n' +
      '      var d = msgs[i].timeReceived();\n' +
      '      if (d) {\n' +
      '        var p = d.getTime ? d.getTime() : new Date(d).getTime();\n' +
      '        if (!isNaN(p)) tm = p;\n' +
      '      }\n' +
      '    } catch (e) {}\n' +
      '    if (tm === null || tm >= weekAgo) kept.push(i);\n' +
      '  }\n' +
      '  // 时间字段全部异常（读不到有效时间）→ 兜底读前 30 封，避免空手而归\n' +
      '  if (kept.length === 0 && n > 0) {\n' +
      '    for (var j = 0; j < Math.min(n, 30); j++) kept.push(j);\n' +
      '  }\n' +
      '  // 第二遍：只对一周内（或兜底前 30 封）的邮件读完整字段，省去旧邮件读正文的开销\n' +
      '  var out = [];\n' +
      '  for (var k = 0; k < kept.length; k++) {\n' +
      '    var m = msgs[kept[k]];\n' +
      '    var subject = "", sender = "", body = "", time = "";\n' +
      '    try { subject = String(m.subject() || ""); } catch (e) {}\n' +
      '    try {\n' +
      '      var s = m.sender();\n' +
      '      if (typeof s === "string") { sender = s; }\n' +
      '      else if (s) {\n' +
      '        try { sender = String(s.name() || ""); } catch (e2) {}\n' +
      '        if (!sender) { try { sender = String(s.address() || ""); } catch (e3) {} }\n' +
      '      }\n' +
      '    } catch (e) {}\n' +
      '    try { var d2 = m.timeReceived(); if (d2) { time = String(d2); } } catch (e) {}\n' +
      '    try { body = String(m.plainTextContent() || ""); } catch (e) { body = ""; }\n' +
      '    if (!body) { try { body = String(m.content() || ""); } catch (e) {} }\n' +
      '    out.push({ subject: subject, sender: sender, body: body, time: time });\n' +
      '  }\n' +
      '  res.total = n;\n' +
      '  res.inWindow = kept.length;\n' +
      '  res.mails = out;\n' +
      '  return JSON.stringify(res);\n' +
      '}';
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = String((err && err.message) || err) + ' ' + String(stderr || '');
        if (/privilege violation|-10004/i.test(msg)) {
          resolve({ ok: false, error: '未获授权读取 Outlook。请到 系统设置 → 隐私与安全性 → 自动化，允许本应用控制「Microsoft Outlook」，然后重试（若已允许仍报错，请在自动化列表里删除本应用后重新触发一次）。' });
        } else if (/not running|cant get|can't get|Can't get/i.test(msg)) {
          resolve({ ok: false, error: '未检测到 Outlook 正在运行，请先打开 Microsoft Outlook 并登录你的剑桥账号。' });
        } else {
          resolve({ ok: false, error: '读取 Outlook 失败：' + msg });
        }
        return;
      }
      try {
        const obj = JSON.parse(String(stdout || '').trim());
        const arr = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.mails) ? obj.mails : null);
        if (!arr) { resolve({ ok: false, error: '解析 Outlook 数据失败' }); return; }
        const mails = arr
          .map((m) => ({
            subject: String((m && m.subject) || '').trim(),
            from: String((m && m.sender) || '').trim(),
            body: String((m && m.body) || '').trim(),
            at: (m && m.time) || '',
          }))
          .filter((m) => m.subject || m.body);
        resolve({
          ok: true, mails: mails, count: mails.length,
          total: (obj && obj.total) || 0,
          inWindow: (obj && obj.inWindow) || 0,
          account: (obj && obj.account) || '',
          diag: buildOutlookDiag(obj),
        });
      } catch (e) {
        resolve({ ok: false, error: '解析 Outlook 数据失败：' + String((e && e.message) || e) });
      }
    });
  });
}
ipcMain.handle('mail:read-outlook', () => readOutlookMail());

// 读取 Apple Mail（邮件 App）里的剑桥邮箱。新版 Outlook 的 AppleScript 读不到云端账号，
// 但 Apple Mail 的脚本接口完整好用，作为可靠的替代通道。
function readAppleMail() {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') { resolve({ ok: false, error: '仅 macOS 支持读取 Apple Mail' }); return; }
    const script = 'function run(){\n' +
      '  var res = { account: "", found: [], total: 0, inbox: 0, sent: 0, mails: [], noAccounts: false };\n' +
      '  var Mail;\n' +
      '  try { Mail = Application("Mail"); } catch (e) { res.fatal = "启动「邮件」App 失败：" + String(e); return JSON.stringify(res); }\n' +
      '  var inboxMsgs = null, sentMsgs = null;\n' +
      '  try {\n' +
      '    var accounts = Mail.accounts();\n' +
      '    var ac = accounts.length;\n' +
      '    if (ac === 0) res.noAccounts = true;\n' +
      '    for (var a = 0; a < ac; a++) {\n' +
      '      var addrs = [];\n' +
      '      try {\n' +
      '        var eas = accounts[a].emailAddresses();\n' +
      '        for (var e = 0; e < eas.length; e++) {\n' +
      '          try { addrs.push(String(eas[e] || "")); } catch (e2) {}\n' +
      '        }\n' +
      '      } catch (e) {}\n' +
      '      var nm = ""; try { nm = String(accounts[a].name() || ""); } catch (e) {}\n' +
      '      res.found.push(nm + " [" + addrs.join(",") + "]");\n' +
      '      if (addrs.join(",").toLowerCase().indexOf("cam.ac.uk") >= 0) {\n' +
      '        res.account = addrs.join(",");\n' +
      '        // account 没有 inbox 属性，只能遍历 mailboxes 找 Inbox / Sent 文件夹\n' +
      '        try {\n' +
      '          var mbs = accounts[a].mailboxes();\n' +
      '          for (var b = 0; b < mbs.length; b++) {\n' +
      '            var bn = ""; try { bn = String(mbs[b].name() || ""); } catch (e) {}\n' +
      '            if (/^inbox$/i.test(bn) || bn.indexOf("收件箱") >= 0) { try { inboxMsgs = mbs[b].messages; } catch (e) {} }\n' +
      '            else if (/^sent/i.test(bn) || bn.indexOf("已发送") >= 0 || bn.indexOf("发件箱") >= 0 || bn.indexOf("Sent") >= 0) { try { sentMsgs = mbs[b].messages; } catch (e) {} }\n' +
      '          }\n' +
      '        } catch (e) {}\n' +
      '      }\n' +
      '    }\n' +
      '  } catch (e) { res.accountsErr = String(e); }\n' +
      '  if (!inboxMsgs) { try { inboxMsgs = Mail.inbox.messages; } catch (e) {} }\n' +
      '  var now = Date.now();\n' +
      '  var weekAgo = now - 7 * 24 * 60 * 60 * 1000;\n' +
      '  function readMsgs(msgs, dir) {\n' +
      '    if (!msgs) return [];\n' +
      '    var n = Math.min(msgs.length, 800);\n' +
      '    var kept = [];\n' +
      '    for (var i = 0; i < n; i++) {\n' +
      '      var tm = null;\n' +
      '      try {\n' +
      '        var d = msgs[i].dateReceived();\n' +
      '        if (!d) { try { d = msgs[i].dateSent(); } catch (e3) {} }\n' +
      '        if (d) { var p = d.getTime ? d.getTime() : new Date(d).getTime(); if (!isNaN(p)) tm = p; }\n' +
      '      } catch (e) {}\n' +
      '      if (tm === null || tm >= weekAgo) kept.push(i);\n' +
      '    }\n' +
      '    if (kept.length === 0 && n > 0) { for (var j = 0; j < Math.min(n, 30); j++) kept.push(j); }\n' +
      '    var out = [];\n' +
      '    for (var k = 0; k < kept.length; k++) {\n' +
      '      var m = msgs[kept[k]];\n' +
      '      var subject = "", sender = "", body = "", time = "";\n' +
      '      try { subject = String(m.subject() || ""); } catch (e) {}\n' +
      '      try { var s = m.sender(); if (typeof s === "string") { sender = s; } else if (s) { try { sender = String(s.address() || ""); } catch (e2) {} } } catch (e) {}\n' +
      '      try { var d2 = m.dateReceived(); if (!d2) { try { d2 = m.dateSent(); } catch (e3) {} } if (d2) { time = String(d2); } } catch (e) {}\n' +
      '      try { body = String(m.content() || ""); } catch (e) { body = ""; }\n' +
      '      if (!body) { try { body = String(m.source() || ""); } catch (e) {} }\n' +
      '      out.push({ subject: subject, sender: sender, body: body, time: time, dir: dir });\n' +
      '    }\n' +
      '    return out;\n' +
      '  }\n' +
      '  var inboxOut = readMsgs(inboxMsgs, "inbox");\n' +
      '  var sentOut = readMsgs(sentMsgs, "sent");\n' +
      '  res.total = inboxOut.length + sentOut.length;\n' +
      '  res.inbox = inboxOut.length;\n' +
      '  res.sent = sentOut.length;\n' +
      '  res.mails = inboxOut.concat(sentOut);\n' +
      '  return JSON.stringify(res);\n' +
      '}';
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // 只取 stderr（真正的错误原因），去掉 execFile 那行超长的 "Command failed: ..." 噪音
        const msg = String(stderr || '').trim() || String((err && err.message) || err);
        if (/privilege violation|-10004|-1743|not authorized|not permitted/i.test(msg)) {
          resolve({ ok: false, error: '未获授权控制「邮件」App。请到 系统设置 → 隐私与安全性 → 自动化，找到本应用并把「邮件」勾选允许（若已勾选仍报错，先在列表里删除本应用，再回来点一次按钮重新授权）。' });
        } else if (/-1728|can.t get object/i.test(msg)) {
          resolve({ ok: false, error: '「邮件」App 里还没有任何邮箱账号（读不到收件箱）。剑桥邮箱其实登录在 Outlook 里——它和「邮件」是两个不同的 App。请打开「邮件」App，在 设置→账户 里点「+」添加 Microsoft Exchange 账号 yx447@cam.ac.uk。' });
        } else {
          resolve({ ok: false, error: '读取 Apple Mail 失败：' + msg + '（请确认已在 系统设置 → 互联网账户 里添加剑桥邮箱，并打开一次「邮件」App）' });
        }
        return;
      }
      try {
        const obj = JSON.parse(String(stdout || '').trim());
        if (obj && obj.fatal) { resolve({ ok: false, error: String(obj.fatal) }); return; }
        if (obj && obj.noAccounts) {
          resolve({ ok: false, error: '「邮件」App 里还没有任何邮箱账号。剑桥邮箱其实登录在 Outlook 里——它和「邮件」是两个不同的 App。请打开「邮件」App，在 设置→账户 里点「+」添加 Microsoft Exchange 账号 yx447@cam.ac.uk。' });
          return;
        }
        const arr = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.mails) ? obj.mails : null);
        if (!arr) { resolve({ ok: false, error: '解析 Apple Mail 数据失败' }); return; }
        const mails = arr
          .map((m) => ({
            subject: String((m && m.subject) || '').trim(),
            from: String((m && m.sender) || '').trim(),
            body: String((m && m.body) || '').trim(),
            at: (m && m.time) || '',
            dir: (m && m.dir) === 'sent' ? 'sent' : 'inbox',
          }))
          .filter((m) => m.subject || m.body);
        resolve({
          ok: true, mails: mails, count: mails.length,
          total: (obj && obj.total) || 0,
          inbox: (obj && obj.inbox) || 0,
          sent: (obj && obj.sent) || 0,
          account: (obj && obj.account) || '',
          diag: buildOutlookDiag(obj),
        });
      } catch (e) {
        resolve({ ok: false, error: '解析 Apple Mail 数据失败：' + String((e && e.message) || e) });
      }
    });
  });
}
ipcMain.handle('mail:read-applemail', () => readAppleMail());

/* ---------------- 知识库引擎（本地 RAG） ---------------- */
const kbEngine = new KbEngine({
  dataDir: path.join(dataDir(), 'kb'),
  // Notion 源注入：token 走主进程解密，正文全量导出交给 notion-engine
  notion: {
    getToken: () => notionToken(),
    exportAll: (token) => NotionEngine.exportAll(token),
  },
});

let kbWatchTimer = null;
let kbWatchers = [];

function startKbWatcher() {
  try {
    const cfg = kbEngine.ensureConfig();
    for (const w of kbWatchers) { try { w.close(); } catch { /* 忽略 */ } }
    kbWatchers = [];
    for (const src of (cfg.sources || []).filter((s) => s.enabled && s.path && (s.type === 'markdown' || s.type === 'reference'))) {
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

ipcMain.handle('kb:scan', (_e, force) => kbEngine.scan({ force: !!force }));
// 手动同步 OneDrive 参考库（pptx/pdf/docx）：默认不自动扫，用户点击才提取更新
ipcMain.handle('kb:scan-reference', () => kbEngine.scan({ manual: true }));
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
// 添加参考库源（共享文件夹里的 pptx/pdf/docx 作为格式/风格参考）
ipcMain.handle('kb:add-source', async (_e, src) => {
  const s = src || {};
  let p = String(s.path || '').trim();
  if (p === '~') p = os.homedir();
  else if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  if (!p) return { ok: false, error: '路径为空' };
  if (!fs.existsSync(p)) return { ok: false, error: '文件夹不存在：' + p };
  if (!fs.statSync(p).isDirectory()) return { ok: false, error: '不是文件夹：' + p };
  const type = String(s.type || 'reference');
  const crypto = require('crypto');
  const id = 'src-' + crypto.createHash('md5').update(type + ':' + p).digest('hex').slice(0, 8);
  const cfg = kbEngine.loadConfig();
  if ((cfg.sources || []).some((x) => x.id === id)) return { ok: false, error: '该文件夹已在参考库中' };
  cfg.sources = (cfg.sources || []).concat([{ id, type, label: String(s.label || '参考库'), path: p, enabled: true }]);
  kbEngine.saveConfig(cfg);
  startKbWatcher();
  try { await kbEngine.scan(); } catch { /* 扫描失败不阻断添加 */ }
  return { ok: true, status: kbEngine.status() };
});
// 移除参考库源（按 id）
ipcMain.handle('kb:remove-source', async (_e, id) => {
  const cfg = kbEngine.loadConfig();
  cfg.sources = (cfg.sources || []).filter((x) => x.id !== id);
  kbEngine.saveConfig(cfg);
  startKbWatcher();
  try { await kbEngine.scan(); } catch { /* 忽略 */ }
  return { ok: true, status: kbEngine.status() };
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
    if (kind.indexOf('ref:') === 0) {
      const id = kind.slice(4);
      const cfg = kbEngine.loadConfig();
      const src = (cfg.sources || []).find((s) => s.id === id);
      if (!src || !src.path) return { ok: false, error: '未找到该参考库' };
      if (!fs.existsSync(src.path)) return { ok: false, error: '参考库文件夹不存在：' + src.path };
      await shell.openPath(src.path); return { ok: true };
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
    const stdout = await execFileP(SYSTEM_PY3, [path.join(__dirname, 'kb-zotero.py'), '--meta-only']);
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
  let names;
  try { names = fs.readdirSync(abs); }
  catch (e) {
    if (e && e.code === 'EPERM') {
      return { ok: false, eperm: true, error: '无权限读取该目录（macOS 隐私保护）。请在「系统设置 → 隐私与安全性 → 完全磁盘访问」中把本应用（Electron）加入并勾选，然后完全退出重启；或把该文件夹移到主目录下非保护目录（如 ~/Dev、~/work）。' };
    }
    return { ok: false, error: '读取失败：' + String((e && e.message) || e) };
  }
  for (const name of names) {
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

// PDF 原文提取：用 macOS 自带 PDFKit（/usr/bin/swift + 系统框架），不依赖任何第三方 Python/npm 包。
function toolPdfRead(target, st) {
  const script = path.join(__dirname, 'scripts', 'pdf_extract.swift');
  if (!fs.existsSync(script)) return { ok: false, error: '缺少 PDF 提取脚本 scripts/pdf_extract.swift' };
  try {
    const out = execFileSync('/usr/bin/swift', [script, target], { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024, timeout: 120000 });
    let r; try { r = JSON.parse(out); } catch (e) { return { ok: false, error: 'PDF 提取返回异常：' + String(out).slice(0, 200) }; }
    if (!r.ok) return r;
    return { ok: true, path: target, size: st.size, format: 'pdf', pages: r.pages, content: r.content };
  } catch (e) {
    if (e && e.code === 'EPERM') return { ok: false, eperm: true, error: '无权限读取该文件（macOS 隐私保护）。请在「系统设置 → 隐私与安全性 → 完全磁盘访问」中把本应用加入并勾选后重启。' };
    return { ok: false, error: 'PDF 提取失败：' + String(e && e.message || e) };
  }
}
// 解码 XML 实体（PPT/XLSX 的 XML 里 &amp; &lt; 等需还原成原文）
function decodeXmlEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-fA-F]+);/g, function (_m, h) { return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (_m, d) { return String.fromCodePoint(parseInt(d, 10)); })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

// PPTX 原文提取：解包 ppt/slides/slideN.xml（macOS 自带 /usr/bin/unzip），正则提取 <a:t> 文本，逐页组织。
// 不依赖 cheerio（打包副本里 cheerio 的 dist 被 electron-builder 精简掉，require 会失败）。
function toolPptxRead(target, st) {
  try {
    const list = execFileSync('/usr/bin/unzip', ['-Z1', target], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    const slides = list.split('\n').map(function (l) { return l.trim(); })
      .filter(function (l) { return /^ppt\/slides\/slide\d+\.xml$/i.test(l); })
      .sort(function (a, b) {
        var na = parseInt((a.match(/slide(\d+)/) || ['', '0'])[1], 10);
        var nb = parseInt((b.match(/slide(\d+)/) || ['', '0'])[1], 10);
        return na - nb;
      });
    if (!slides.length) return { ok: false, error: '未在演示文稿中找到幻灯片内容（可能是空文件或格式异常）' };
    const parts = [];
    slides.forEach(function (s) {
      const xml = execFileSync('/usr/bin/unzip', ['-p', target, s], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
      // 提取所有 <a:t>…</a:t>（PPTX 正文都在此标签内；空自闭合 <a:t/> 不产生文本，正好忽略）
      const texts = [];
      const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g;
      let m;
      while ((m = re.exec(xml)) !== null) { const t = decodeXmlEntities(m[1]).trim(); if (t) texts.push(t); }
      var n = parseInt((s.match(/slide(\d+)/) || ['', '0'])[1], 10);
      parts.push('【第 ' + n + ' 页】' + texts.join(' '));
    });
    const content = parts.join('\n\n');
    if (!content.trim()) return { ok: false, error: 'PPTX 中未提取到文本（可能全部由图片组成）' };
    return { ok: true, path: target, size: st.size, format: 'pptx', slides: slides.length, content: content };
  } catch (e) {
    if (e && e.code === 'EPERM') return { ok: false, eperm: true, error: '无权限读取该文件（macOS 隐私保护）。请在「系统设置 → 隐私与安全性 → 完全磁盘访问」中把本应用加入并勾选后重启。' };
    return { ok: false, error: 'PPTX 提取失败：' + String(e && e.message || e) };
  }
}

// XLSX 原文提取：解包 xl/sharedStrings.xml + xl/worksheets/sheetN.xml，正则还原二维表格。
// 同样不依赖第三方库（exceljs 异步、且打包副本完整性不可靠），纯 unzip + 正则。
function toolXlsxRead(target, st) {
  try {
    const list = execFileSync('/usr/bin/unzip', ['-Z1', target], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    const files = list.split('\n').map(function (l) { return l.trim(); });

    // 1) 共享字符串表（多数文本存在这里）
    const ssFile = files.find(function (f) { return /^xl\/sharedStrings\.xml$/i.test(f); });
    const shared = [];
    if (ssFile) {
      const xml = execFileSync('/usr/bin/unzip', ['-p', target, ssFile], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 });
      const siRe = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
      let m;
      while ((m = siRe.exec(xml)) !== null) {
        const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
        const ts = []; let tm;
        while ((tm = tRe.exec(m[1])) !== null) ts.push(decodeXmlEntities(tm[1]));
        shared.push(ts.join(''));
      }
    }

    // 2) 工作表名称（xl/workbook.xml 的 <sheet name="…">）
    const wbFile = files.find(function (f) { return /^xl\/workbook\.xml$/i.test(f); });
    const sheetNames = [];
    if (wbFile) {
      const xml = execFileSync('/usr/bin/unzip', ['-p', target, wbFile], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
      const sRe = /<sheet[^>]*\bname="([^"]*)"[^>]*>/g;
      let m;
      while ((m = sRe.exec(xml)) !== null) sheetNames.push(decodeXmlEntities(m[1]));
    }

    // 3) 逐 sheet 解析单元格
    const sheetFiles = files.filter(function (f) { return /^xl\/worksheets\/sheet\d+\.xml$/i.test(f); })
      .sort(function (a, b) { return parseInt((a.match(/sheet(\d+)/) || ['', '0'])[1], 10) - parseInt((b.match(/sheet(\d+)/) || ['', '0'])[1], 10); });
    if (!sheetFiles.length) return { ok: false, error: '未在表格中找到工作表（可能为空文件或格式异常）' };

    const out = [];
    sheetFiles.forEach(function (sf, idx) {
      const xml = execFileSync('/usr/bin/unzip', ['-p', target, sf], { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 });
      const name = sheetNames[idx] || ('Sheet' + (idx + 1));
      out.push('【表 ' + (idx + 1) + ' · ' + name + '】');
      // 行：<row r="N" …>…</row>
      const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
      let rm; let rowCount = 0;
      while ((rm = rowRe.exec(xml)) !== null) {
        const rowNum = rm[1]; const rowXml = rm[2];
        // 单元格：先切出每个 <c> 元素（含自闭合 <c …/>），再独立提取 r/t/v/is 属性
        const cRe = /<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g;
        const cells = []; let cm;
        while ((cm = cRe.exec(rowXml)) !== null) {
          const el = cm[0];
          const rM = /\br="([A-Z]+\d+)"/.exec(el);
          if (!rM) continue; // 无单元格引用（如 <c/> 空占位）跳过
          const tM = /\bt="([^"]*)"/.exec(el);
          const t = tM ? tM[1] : '';
          const vM = /<v>([\s\S]*?)<\/v>/.exec(el);
          const isM = /<is>[\s\S]*?<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/.exec(el);
          let val = '';
          if (t === 'inlineStr') { val = isM ? decodeXmlEntities(isM[1]) : ''; }
          else if (t === 's') { if (vM) { const si = parseInt(vM[1], 10); val = shared[si] != null ? shared[si] : ''; } }
          else if (t === 'b') { val = vM ? (vM[1] === '1' ? 'TRUE' : 'FALSE') : ''; }
          else { val = vM ? decodeXmlEntities(vM[1]) : ''; }
          cells.push(val);
        }
        if (cells.length) { out.push('  R' + rowNum + ': ' + cells.join(' | ')); rowCount++; }
      }
      if (!rowCount) out.push('  （本表无数据）');
    });
    const content = out.join('\n');
    if (!content.trim()) return { ok: false, error: 'XLSX 中未提取到文本' };
    return { ok: true, path: target, size: st.size, format: 'xlsx', sheets: sheetFiles.length, content: content };
  } catch (e) {
    if (e && e.code === 'EPERM') return { ok: false, eperm: true, error: '无权限读取该文件（macOS 隐私保护）。请在「系统设置 → 隐私与安全性 → 完全磁盘访问」中把本应用加入并勾选后重启。' };
    return { ok: false, error: 'XLSX 提取失败：' + String(e && e.message || e) };
  }
}

// fs_read 支持可选分段读取：offset=起始字符(从0起)、limit=最多字符数。长文件一次读全会撑爆上下文，
// 模型应先读开头、需要时再用 offset/limit 定向读后续（对应社区 spill/预览+检索路径 的上下文治理范式）。
function toolFsRead(payload) {
  const off = Number((payload && payload.offset) || 0);
  const lim = Number((payload && payload.limit) || 0);
  const r = toolFsReadRaw(payload);
  if (r && r.ok && typeof r.content === 'string') {
    const total = r.content.length;
    r.totalChars = total;
    if (off > 0 || lim > 0) {
      const sliced = (lim > 0) ? r.content.slice(off, off + lim) : r.content.slice(off);
      r.content = sliced;
      r.offset = off; r.limit = lim;
    }
  }
  return r;
}
function toolFsReadRaw(payload) {
  const target = path.resolve(String((payload && payload.path) || ''));
  if (!target || !fs.existsSync(target)) return { ok: false, error: '文件不存在：' + String((payload && payload.path) || '') };
  let st; try { st = fs.statSync(target); } catch { return { ok: false, error: '无法访问：' + String((payload && payload.path) || '') }; }
  if (st.isDirectory()) return { ok: false, error: '是目录，请用 list 查看' };
  const ext = path.extname(target).toLowerCase();
  // Office 文档（docx/doc/rtf/odt）：用 macOS 自带 textutil 提取正文，让研究助手能直接读「原文」
  if (ext === '.docx' || ext === '.doc' || ext === '.rtf' || ext === '.odt') {
    try {
      const text = execFileSync('textutil', ['-convert', 'txt', '-stdout', target], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
      return { ok: true, path: target, size: st.size, format: ext.slice(1), content: text };
    } catch (e) {
      if (e && e.code === 'EPERM') return { ok: false, eperm: true, error: '无权限读取该文件（macOS 隐私保护）。请在「系统设置 → 隐私与安全性 → 完全磁盘访问」中把本应用加入并勾选后重启。' };
      return { ok: false, error: '提取文档正文失败：' + String(e && e.message || e) };
    }
  }
  // PDF：macOS 自带 PDFKit 提取全文（见 toolPdfRead）
  if (ext === '.pdf') return toolPdfRead(target, st);
  // PPTX：解包提取幻灯片文本（见 toolPptxRead）；旧版 .ppt 二进制不支持，提示转换
  if (ext === '.pptx') return toolPptxRead(target, st);
  if (ext === '.ppt') return { ok: false, error: '.ppt 是旧版二进制格式，暂不支持直接读。请用 PowerPoint 另存为 .pptx 后再读。' };
  // 表格：xlsx 解包还原二维表格（见 toolXlsxRead）；旧版 .xls 二进制不支持
  if (ext === '.xlsx') return toolXlsxRead(target, st);
  if (ext === '.xls') return { ok: false, error: '.xls 是旧版二进制格式，暂不支持直接读。请用 Excel 另存为 .xlsx 后再读。' };
  // CSV/TSV 纯文本，研究数据常见，放宽体积上限
  if (ext === '.csv' || ext === '.tsv') {
    if (st.size > 10 * 1024 * 1024) return { ok: false, error: 'CSV/TSV 文件过大（>10MB），请先拆分或转成 xlsx 后再读' };
    try {
      return { ok: true, path: target, size: st.size, format: ext.slice(1), content: fs.readFileSync(target, 'utf8') };
    } catch (e) {
      if (e && e.code === 'EPERM') return { ok: false, eperm: true, error: '无权限读取该文件（macOS 隐私保护）。请在「系统设置 → 隐私与安全性 → 完全磁盘访问」中把本应用加入并勾选后重启。' };
      return { ok: false, error: '读取失败：' + String(e && e.message || e) };
    }
  }
  if (st.size > 200 * 1024) return { ok: false, error: '文件过大（>200KB），暂不支持读取' };
  try {
    const buf = fs.readFileSync(target);
    if (buf.includes(0)) return { ok: false, error: '疑似二进制文件（' + ext + '），暂不支持读取正文。Word 请转成 txt/md 后读取，或直接读同名的 .txt/.md 版本。' };
    return { ok: true, path: target, size: st.size, content: buf.toString('utf8') };
  } catch (e) {
    if (e && e.code === 'EPERM') return { ok: false, eperm: true, error: '无权限读取该文件（macOS 隐私保护）。请在「系统设置 → 隐私与安全性 → 完全磁盘访问」中把本应用加入并勾选后重启。' };
    return { ok: false, error: '读取失败：' + String(e && e.message || e) };
  }
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
// 下载文件（网页/图片/zip/pdf 等二进制）到本地磁盘：补上 agent「无法下载文件」的能力缺口。
// 目标路径缺省时用 URL 的文件名存到下载目录；仅允许主目录内，写新文件不额外审批（复用 fs_write 的免审批语义）。
async function toolFsDownload(payload) {
  const url = String((payload && payload.url) || '').trim();
  let target = path.resolve(String((payload && payload.path) || ''));
  if (!url) return { ok: false, error: '缺少下载链接 url' };
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '仅支持 http/https 链接' };
  if (!target || target === path.resolve(path.sep)) {
    let name = '';
    try {
      const u = new URL(url);
      name = path.basename(decodeURIComponent(u.pathname));
    } catch { /* 忽略，用兜底文件名 */ }
    if (!name || name === '/' || name === '.') name = 'download-' + Date.now();
    target = path.join(app.getPath('downloads'), name);
  }
  if (!isSafeWritePath(target)) return { ok: false, error: '拒绝保存到该位置（仅允许主目录内的普通文件/目录，系统目录、Library、隐藏目录受保护）' };
  try {
    const res = await fetch(url, { headers: { 'User-Agent': WEB_UA }, redirect: 'follow', signal: AbortSignal.timeout(60000) });
    if (!res.ok) return { ok: false, error: '下载失败：HTTP ' + res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buf);
    return { ok: true, url: url, path: target, bytes: buf.length };
  } catch (e) { return { ok: false, error: '下载失败：' + String(e && e.message || e) }; }
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
function docEditFindReplace(target, oldStr, newStr) {
  const script = path.join(__dirname, 'scripts', 'doc_edit.py');
  if (!fs.existsSync(script)) return { ok: false, error: '缺少 docx 编辑脚本 scripts/doc_edit.py' };
  try {
    const out = execFileSync(SYSTEM_PY3, [script, JSON.stringify({ path: target, old: oldStr, new: newStr })], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, env: pyEnv() });
    return JSON.parse(out);
  } catch (e) {
    return { ok: false, error: 'docx 编辑失败：' + String(e && e.message || e) };
  }
}
function toolFsEdit(payload) {
  const target = path.resolve(String((payload && payload.path) || ''));
  const oldStr = String((payload && payload.old) == null ? '' : payload.old);
  const newStr = String((payload && payload.new) == null ? '' : payload.new);
  if (!target) return { ok: false, error: '路径为空' };
  if (!isSafeWritePath(target)) return { ok: false, error: '拒绝修改该位置（仅允许主目录内的普通文件/目录）' };
  if (!oldStr) return { ok: false, error: '要替换的原文（old）不能为空' };
  // Word 文件（.docx/.doc）：二进制，交给 python-docx 做精确查找替换，研究助手即可「直接改 Word」
  const ext = path.extname(target).toLowerCase();
  if (ext === '.docx' || ext === '.doc') return docEditFindReplace(target, oldStr, newStr);
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
/* ---------------- pptx 套模板（打开已有模板→按占位符/形状名填空，保留母版/背景/主题/SmartArt） ---------------- */
function _runPyJson(scriptRel, args, timeoutMs) {
  return new Promise((resolve) => {
    const script = path.join(__dirname, 'scripts', scriptRel);
    if (!fs.existsSync(script)) { resolve({ ok: false, error: '缺少脚本 scripts/' + scriptRel }); return; }
    const env = pyEnv();
    execFile(SYSTEM_PY3, [script, JSON.stringify(args)], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: timeoutMs || 60000, env: env },
      (err, stdout) => {
        // 诊断日志：记录 App 内 python 子进程的真实环境与输出，便于排查「shell 正常、App 内报错」的差异
        try {
          fs.appendFileSync('/tmp/ingrid-py.log',
            JSON.stringify({ at: Date.now(), script: scriptRel, HOME: env.HOME, PYTHONPATH: env.PYTHONPATH || '', PYTHONHOME: env.PYTHONHOME || '', PATH: (env.PATH || '').slice(0, 300), err: err ? String(err.message || err) : null, stdout: String(stdout || '').slice(0, 1500) }) + '\n');
        } catch (e) { /* 忽略 */ }
        if (err) { resolve({ ok: false, error: String(err.message || err) }); return; }
        try { resolve(JSON.parse(String(stdout))); }
        catch { resolve({ ok: false, error: '脚本输出异常：' + String(stdout || '').slice(0, 300) }); }
      });
  });
}
function toolPptxFill(payload) {
  const template = path.resolve(String((payload && payload.template) || ''));
  if (!template) return Promise.resolve({ ok: false, error: '缺少 template（模板 .pptx 绝对路径）' });
  const action = String((payload && payload.action) || 'fill');
  const args = { action, template };
  if (action !== 'inspect') {
    if (payload && payload.output) args.output = String(payload.output);
    if (payload && payload.replacements && typeof payload.replacements === 'object') args.replacements = payload.replacements;
    if (Array.isArray(payload && payload.byName)) args.byName = payload.byName;
  }
  return _runPyJson('pptx_fill_template.py', args, 60000);
}
function toolImageProcess(payload) {
  const action = String((payload && payload.action) || 'info');
  const input = path.resolve(String((payload && payload.input) || ''));
  if (!input) return Promise.resolve({ ok: false, error: '缺少 input（图片绝对路径）' });
  const args = { action, input };
  if (payload && payload.output) args.output = String(payload.output);
  if (payload && payload.width != null) args.width = payload.width;
  if (payload && payload.height != null) args.height = payload.height;
  if (payload && payload.quality != null) args.quality = payload.quality;
  if (payload && payload.alpha_matting != null) args.alpha_matting = payload.alpha_matting;
  // 抠图（rembg 推理）较慢，给足超时；其余动作快
  return _runPyJson('image_tools.py', args, action === 'remove_bg' ? 300000 : 60000);
}
/* ---------------- 文生图（通义万相 · DashScope 异步任务，复用 Qwen 的 DashScope Key） ---------------- */
const WANX_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis';
const WANX_TASK_ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/tasks/';
async function toolImageGenerate(payload) {
  const prompt = String((payload && payload.prompt) || '').trim();
  if (!prompt) return { ok: false, error: '缺少 prompt（画面描述）' };
  const settings = decryptSettings(readSettingsRaw());
  const key = settings.qwen; // 通义万相与 Qwen 共用一个 DashScope Key（引擎设置里的「Qwen · API Key」）
  if (!key) return { ok: false, error: '尚未配置通义万相 Key：请到「引擎设置」填写「Qwen · API Key」（万相与 Qwen 共用同一个 DashScope Key）' };
  const model = String((payload && payload.model) || 'wanx2.1-t2i-turbo');
  const size = String((payload && payload.size) || '1024*1024');
  const n = Math.max(1, Math.min(4, Number((payload && payload.n) || 1)));
  const negative = String((payload && payload.negative_prompt) || '');
  const headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key, 'X-DashScope-Async': 'enable' };
  try {
    // 1) 提交异步任务
    const input = { prompt: prompt };
    if (negative) input.negative_prompt = negative;
    const submit = await fetch(WANX_ENDPOINT, {
      method: 'POST', headers, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ model: model, input: input, parameters: { n: n, size: size } }),
    });
    let sj = {};
    try { sj = await submit.json(); } catch { /* 非 JSON */ }
    if (!submit.ok) return { ok: false, error: '万相提交失败：' + (sj && sj.message ? sj.message : ('HTTP ' + submit.status)) };
    const taskId = sj && sj.output && sj.output.task_id;
    if (!taskId) return { ok: false, error: '万相未返回 task_id：' + String(JSON.stringify(sj)).slice(0, 200) };

    // 2) 轮询任务直到完成（最长约 90s，每次间隔 3s）
    const deadline = Date.now() + 90000;
    let url = '';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const q = await fetch(WANX_TASK_ENDPOINT + taskId, { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(20000) });
      let qj = {};
      try { qj = await q.json(); } catch { /* 非 JSON */ }
      const st = qj && qj.output && qj.output.task_status;
      if (st === 'SUCCEEDED') { const rs = (qj.output.results || []); url = rs[0] && rs[0].url; break; }
      if (st === 'FAILED' || st === 'CANCELED') return { ok: false, error: '万相生成失败：' + ((qj.output && qj.output.message) || st) };
      // PENDING / RUNNING 继续等
    }
    if (!url) return { ok: false, error: '万相生成超时（90s），请重试' };

    // 3) 结果 URL 有有效期，必须落盘到「导出」目录
    const imgResp = await fetch(url, { headers: { 'User-Agent': 'Ingrid-AI-Agents/1.0' }, signal: AbortSignal.timeout(60000) });
    if (!imgResp.ok) return { ok: false, error: '图片下载失败：HTTP ' + imgResp.status };
    const buf = Buffer.from(await imgResp.arrayBuffer());
    const ct = String(imgResp.headers.get('content-type') || '');
    const ext = ct.indexOf('png') >= 0 ? 'png' : 'jpg';
    const file = path.join(exportDir(), safeFilename('万相_' + prompt.slice(0, 24)) + '_' + Date.now() + '.' + ext);
    fs.writeFileSync(file, buf);
    return { ok: true, name: path.basename(file), path: file, size: buf.length };
  } catch (err) {
    return { ok: false, error: '文生图请求失败：' + String((err && err.message) || err) };
  }
}
/* ---------------- 自扩展：agent 把一段 markdown 知识写成新 skill 并热加载 ---------------- */
// 分类 → 默认板块映射（无默认板块的分类，需要调用方显式传 boards）
const CAT2BOARD = { research: 'research', office: 'docs', design: 'design', finance: 'finance', browser: 'automation' };
const VALID_CATS = SkillsCore.CATEGORY_RULES.map((c) => c.id);
// 把一段知识落成 skills/<category>/<slug>.md（builtin scope，默认启用 + 随 git 沉淀），并热加载
function writeSkillFile(name, description, category, boards, markdown) {
  const dir = path.join(__dirname, 'skills', category);
  fs.mkdirSync(dir, { recursive: true });
  const slug = String(name).replace(/[\\/:*?"<>|\r\n\t]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'skill';
  let file = path.join(dir, slug + '.md');
  let i = 2;
  while (fs.existsSync(file)) { file = path.join(dir, slug + '-' + i + '.md'); i++; }
  const fm = '---\n' +
    'name: ' + String(name).replace(/\r?\n/g, ' ').trim() + '\n' +
    'description: ' + String(description).replace(/\r?\n/g, ' ').trim() + '\n' +
    'category: ' + category + '\n' +
    (boards.length ? 'boards: ' + boards.join(', ') + '\n' : '') +
    'source: self-installed（agent 自装）\n' +
    '---\n\n';
  fs.writeFileSync(file, fm + String(markdown).trim() + '\n', 'utf8');
  scanSkills(); // 热加载：重建 SKILL_PATHS 与 records，下一条消息的 buildSystemPrompt 自动纳入
  const rel = path.relative(path.join(__dirname, 'skills'), file).split(path.sep).join('/').replace(/\.md$/i, '');
  return { id: 'builtin:' + rel, path: file };
}
function toolSkillInstall(payload) {
  const name = String((payload && payload.name) || '').trim();
  const description = String((payload && payload.description) || '').trim();
  const markdown = String((payload && payload.markdown) || '').trim();
  if (!name) return { ok: false, error: '缺少 name（skill 名称）' };
  if (!description) return { ok: false, error: '缺少 description（一句话说明）' };
  if (!markdown) return { ok: false, error: '缺少 markdown（skill 正文）' };
  if (markdown.length > 12000) return { ok: false, error: '正文超过 12000 字符上限（当前 ' + markdown.length + '），请精简' };
  let category = String((payload && payload.category) || '').trim();
  if (VALID_CATS.indexOf(category) < 0) category = SkillsCore.classify(name + ' ' + description).category;
  let boards = String((payload && payload.boards) || '').split(/[,，\s]+/).filter(Boolean);
  if (!boards.length && CAT2BOARD[category]) boards = [CAT2BOARD[category]];
  try {
    const r = writeSkillFile(name, description, category, boards, markdown);
    return {
      ok: true, id: r.id, path: r.path, name: name, category: category, boards: boards,
      note: boards.length ? '' : '⚠️ 该分类无默认板块，未挂载到任何板块（不会自动注入任何 agent），请显式指定 boards（如 research/docs/dev/design/finance/automation）',
    };
  } catch (err) { return { ok: false, error: '写 skill 失败：' + String((err && err.message) || err) }; }
}
/* ---------------- installer：从 GitHub 拉纯提示词 .md skill（绝不下载/执行代码） ---------------- */
async function fetchText(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': 'Ingrid-AI-Agents/1.0' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  if (!resp.ok) return null;
  const ct = String(resp.headers.get('content-type') || '');
  if (ct && ct.indexOf('text/html') >= 0 && ct.indexOf('text/markdown') < 0 && ct.indexOf('text/plain') < 0) {
    // GitHub 的 raw 会返回 text/plain；普通网页可能返回 text/html，拒绝以跳过非原始文本
    if (ct.indexOf('text/plain') < 0) return null;
  }
  const t = await resp.text();
  return t;
}
async function toolSkillInstallFromUrl(payload) {
  let url = String((payload && payload.url) || '').trim().replace(/#.*$/, '');
  if (!url) return { ok: false, error: '缺少 url（GitHub 上 skill 的 .md 链接或仓库地址）' };
  const explicitBoards = String((payload && payload.boards) || '').split(/[,，\s]+/).filter(Boolean);
  const explicitCategory = String((payload && payload.category) || '').trim();
  const candidates = [];
  // 1) blob → raw
  const blobM = url.match(/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/blob\/([^\/]+)\/(.+\.md)$/i);
  if (blobM) {
    candidates.push('https://raw.githubusercontent.com/' + blobM[1] + '/' + blobM[2] + '/' + blobM[3] + '/' + blobM[4]);
  }
  // 2) 已是 raw / 直接 .md 链接
  if (/\.md$/i.test(url) && url.indexOf('raw.githubusercontent.com') >= 0) candidates.push(url);
  else if (/\.md$/i.test(url)) candidates.push(url);
  // 3) 仓库主页 → 猜常见 skill 文件路径（main/master 分支 × 常见文件名）
  const repoM = url.match(/^https?:\/\/github\.com\/([^\/]+)\/([^\/]+)\/?$/i);
  if (repoM) {
    ['main', 'master'].forEach(function (br) {
      ['SKILL.md', 'skill.md', 'skills/SKILL.md', 'README.md'].forEach(function (p) {
        candidates.push('https://raw.githubusercontent.com/' + repoM[1] + '/' + repoM[2] + '/' + br + '/' + p);
      });
    });
  }
  if (!candidates.length) return { ok: false, error: '无法识别该 URL：请给 GitHub 上某个 .md 文件的链接（blob 或 raw 均可），或仓库主页地址' };

  let text = null, usedUrl = '';
  for (const c of candidates) {
    const t = await fetchText(c);
    if (t && t.trim()) { text = t; usedUrl = c; break; }
  }
  if (!text) return { ok: false, error: '下载失败或未找到 .md 文件（试了 ' + candidates.length + ' 个路径）。建议直接给 raw .md 链接最可靠' };
  if (text.length > 12000) text = text.slice(0, 12000);

  // 提取 name/description：优先 frontmatter，否则文件名 / 首个 # 标题
  const parsed = SkillsCore.parseFrontmatter(text);
  const meta = parsed.meta || {};
  const body = (parsed.body || text).trim();
  const fromFile = decodeURIComponent(usedUrl.split('/').pop() || '').replace(/\.md$/i, '');
  const name = String((payload && payload.name) || meta.name || meta.display_name || fromFile || 'imported-skill').trim();
  const description = String((payload && payload.description) || meta.description || meta.description_zh || '从 ' + usedUrl + ' 导入').trim();
  let category = explicitCategory;
  if (VALID_CATS.indexOf(category) < 0) category = VALID_CATS.indexOf(String(meta.category || '')) >= 0 ? String(meta.category) : SkillsCore.classify(name + ' ' + description).category;
  let boards = explicitBoards;
  if (!boards.length && CAT2BOARD[category]) boards = [CAT2BOARD[category]];
  if (!body) return { ok: false, error: '下载的内容为空' };
  try {
    const r = writeSkillFile(name, description, category, boards, body);
    return {
      ok: true, id: r.id, path: r.path, name: name, category: category, boards: boards,
      sourceUrl: usedUrl, imported: true,
      note: '已从 GitHub 导入为纯提示词 skill 并热加载' + (boards.length ? '' : '（未挂载板块，请指定 boards）'),
    };
  } catch (err) { return { ok: false, error: '导入失败：' + String((err && err.message) || err) }; }
}
/* ---------------- 第二大脑（second-brain：收件箱→结构化 wiki→双向链接） ---------------- */
function brainVault(payload) {
  const explicit = String((payload && payload.vault) || '').trim();
  if (explicit) return path.resolve(explicit);
  return vaultPath() || workspaceVaultPath();
}
function brainLlmEngine() {
  const settings = decryptSettings(readSettingsRaw());
  if (settings.deepseek) return { engine: 'deepseek', model: CHAT_ENDPOINTS.deepseek.model };
  if (settings.gpt) return { engine: 'gpt', model: CHAT_ENDPOINTS.gpt.model };
  if (settings.qwen) return { engine: 'qwen', model: CHAT_ENDPOINTS.qwen.model };
  return { engine: 'ollama', model: CHAT_ENDPOINTS.ollama.model };
}
function buildBrainIngestPrompt(content, filename) {
  return '你是「第二大脑」知识整理助手。把下面这份原始材料提炼成一个结构化 wiki 页面。\n\n' +
    '只输出一个 JSON 对象（不要 markdown 代码块、不要多余文字），格式：\n' +
    '{"title":"页面标题(≤20字)","category":"sources|entities|concepts|synthesis","markdown":"页面正文"}\n\n' +
    '规则：\n' +
    '1. category 四选一：sources(对来源/文章的整体总结) / entities(核心是一个人物/组织/产品/工具) / concepts(核心是一个概念/框架/理论/方法) / synthesis(多来源对比/分析/主题综合)。\n' +
    '2. markdown 用中文：先写 2-3 句核心要点，再分节展开（可用 ## 小节）。\n' +
    '3. 用 [[双链]] 把文中关键概念/实体链接起来（每篇 2-6 个链接，链接写简短名词，不要带路径）。\n' +
    '4. markdown 里不要放 frontmatter，系统会自动加。\n\n' +
    '原始材料（来源：' + filename + '）：\n---\n' + String(content || '').slice(0, 12000) + '\n---';
}
function parseBrainPage(text, filename) {
  let s = String(text || '').trim();
  // 1) 直接 JSON
  try { const o = JSON.parse(s); if (o && o.markdown) return o; } catch { /* 继续 */ }
  // 2) 剥 ```json ... ``` 包裹
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { const o = JSON.parse(fence[1].trim()); if (o && o.markdown) return o; } catch { /* 继续 */ } }
  // 3) 逐字段正则提取
  const title = (s.match(/"title"\s*:\s*"([^"]+)"/) || [])[1] || filename.replace(/\.md$/i, '');
  const category = (s.match(/"category"\s*:\s*"([^"]+)"/) || [])[1] || 'sources';
  const mm = s.match(/"markdown"\s*:\s*"([\s\S]*)"/);
  if (mm) return { title, category, markdown: mm[1].replace(/\\n/g, '\n') };
  return null;
}
function brainLlm() {
  const { engine, model } = brainLlmEngine();
  return async function (content, filename) {
    try {
      const r = await callBgChat(engine, model, [{ role: 'user', content: buildBrainIngestPrompt(content, filename) }]);
      if (!r || !r.ok || !r.text) return null;
      return parseBrainPage(r.text, filename);
    } catch { return null; }
  };
}
async function toolBrainIngest(payload) {
  const vault = brainVault(payload);
  if (!vault || !fs.existsSync(vault)) return { ok: false, error: '未指定 vault 且未检测到 Obsidian 库（请传 vault 参数或先安装 Obsidian）' };
  const SB = require('./second-brain-core.js');
  return SB.ingest(vault, { llm: brainLlm() });
}
function toolBrainLint(payload) {
  const vault = brainVault(payload);
  if (!vault || !fs.existsSync(vault)) return { ok: false, error: '未指定 vault 且未检测到 Obsidian 库' };
  const SB = require('./second-brain-core.js');
  return SB.lint(vault);
}
function toolBrainIndex(payload) {
  const vault = brainVault(payload);
  if (!vault || !fs.existsSync(vault)) return { ok: false, error: '未指定 vault 且未检测到 Obsidian 库' };
  const SB = require('./second-brain-core.js');
  return SB.rebuildIndex(vault);
}

/* ---------------- 个人运营底座（My-OS）：全局台账 + 惯例收件箱 ----------------
 * 借鉴小红书「个人 Harness / My-OS」的轻量机制：台账只记位置、收件箱 AI 只提议人点头才落笔。
 * 三个窄工具：tool:ledger（读/记台账）、tool:inbox（惯例收件箱）、tool:weekly（周体检）。
 * 落笔铁律：inbox accept 才写 memory / RULES，且 accept 是「人」的动作（通过对话触发）。
 */
function appendInboxToMemory(entry) {
  const agent = String((entry && entry.agent) || '').trim();
  const dir = agent ? (agentDirByName(agent) || '_shared') : '_shared';
  const p = memoryPath(dir);
  try {
    const d = new Date();
    const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const line = '- [' + stamp + '] 【' + (entry.kind || '约定') + '】' + (entry.content || '');
    let body = '';
    if (!fs.existsSync(p)) body = '# ' + (agent || '共享') + ' · 跨会话记忆\n\n## 记忆条目\n\n';
    fs.appendFileSync(p, body + line + '\n', 'utf8');
    return { ok: true, desc: (agent || '共享') + ' 记忆（docs/agent-memory/' + dir + '.md）' };
  } catch (e) {
    return { ok: false, error: '写记忆失败：' + String((e && e.message) || e) };
  }
}
function appendInboxToRules(entry) {
  const p = path.join(__dirname, 'docs', 'RULES.md');
  try {
    const d = new Date();
    const stamp = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const line = '- [' + stamp + '] 【' + (entry.kind || '规则') + '】' + (entry.content || '') + '（惯例收件箱 ' + entry.id + '，' + (entry.agent || '未署名') + ' 提议）';
    let text = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    if (text.indexOf('## 已采纳惯例') < 0) {
      text = text.replace(/\s*$/, '\n\n---\n\n## 已采纳惯例（个人运营底座）\n\n> 由惯例收件箱 accept 后落笔，待人工归位到对应章节。\n\n');
    }
    fs.writeFileSync(p, text + line + '\n', 'utf8');
    return { ok: true, desc: 'RULES.md（已采纳惯例区）' };
  } catch (e) {
    return { ok: false, error: '写 RULES.md 失败：' + String((e && e.message) || e) };
  }
}

function toolLedger(p) {
  const action = String((p && p.action) || '').trim();
  if (action === 'read') return MyOS.readLedger(__dirname);
  if (action === 'note') return MyOS.ledgerNote(__dirname, { name: p.name, location: p.location, status: p.status, next: p.next });
  return { ok: false, error: '未知 action：' + (action || '(空)') + '，可用：read / note' };
}
function toolInbox(p) {
  const action = String((p && p.action) || '').trim();
  const id = String((p && p.id) || '').trim();
  if (action === 'add') return MyOS.inboxAdd(__dirname, { kind: p.kind, content: p.content, agent: p.agent });
  if (action === 'list') return MyOS.readInbox(__dirname);
  if (action === 'accept') {
    if (!id) return { ok: false, error: 'accept 需要条目 id' };
    const box = MyOS.readInbox(__dirname);
    const entry = box.pending.find((e) => e.id === id);
    if (!entry) return { ok: false, error: '找不到待确认条目 id=' + id + '（可能已处理）' };
    const target = String((p && p.target) || 'memory').trim();
    const landed = (target === 'rules') ? appendInboxToRules(entry) : appendInboxToMemory(entry);
    if (!landed.ok) return landed;
    return MyOS.inboxAccept(__dirname, id, { landedTo: landed.desc });
  }
  if (action === 'reject') {
    if (!id) return { ok: false, error: 'reject 需要条目 id' };
    return MyOS.inboxReject(__dirname, id, { reason: p.reason });
  }
  return { ok: false, error: '未知 action：' + (action || '(空)') + '，可用：add / list / accept / reject' };
}
function toolWeekly() {
  return MyOS.weekly(__dirname);
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

/* ---------------- 软件工程 agent 工具：逆向 / 编译 / 补丁 ----------------
 * 只读分析（bin_*）不需审批；run_shell / bin_patch 有副作用，需前端审批。
 * 合规边界（配合前端 soul）：只分析用户指定/授权的文件；拒绝破解他人授权、DRM、许可校验。
 */
const DEV_TIMEOUT = 45000;
const DEV_MAXBUF = 30 * 1024 * 1024;

function execDevTool(bin, args) {
  try {
    const out = execFileSync(bin, args, { encoding: 'utf8', maxBuffer: DEV_MAXBUF, timeout: DEV_TIMEOUT });
    return { ok: true, output: String(out).slice(0, 300000) };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, error: '工具未安装：' + bin };
    return {
      ok: false,
      error: String((e && e.message) || e),
      stdout: e && e.stdout ? String(e.stdout).slice(0, 80000) : '',
      stderr: e && e.stderr ? String(e.stderr).slice(0, 80000) : '',
    };
  }
}
function devPathOf(payload) {
  const f = path.resolve(String((payload && payload.path) || ''));
  if (!f || !fs.existsSync(f)) return { err: '文件不存在：' + String((payload && payload.path) || '') };
  return { file: f };
}

function toolBinInfo(p) {
  const r = devPathOf(p); if (r.err) return { ok: false, error: r.err };
  const fileOut = execDevTool('file', [r.file]);
  const lipoOut = execDevTool('lipo', ['-info', r.file]);
  const signOut = execDevTool('codesign', ['-dv', r.file]);
  return {
    ok: true, path: r.file,
    file: fileOut.ok ? fileOut.output.trim() : '(file 失败)',
    arch: lipoOut.ok ? lipoOut.output.trim() : '(非胖二进制 / lipo 不可用)',
    codesign: signOut.ok ? signOut.output.trim() : '(未签名或 codesign 不可用)',
  };
}
function toolBinStrings(p) {
  const r = devPathOf(p); if (r.err) return { ok: false, error: r.err };
  const min = Math.min(Math.max(Number((p && p.minLen) || 4) || 4, 2), 16);
  return execDevTool('strings', ['-n', String(min), r.file]);
}
function toolBinSymbols(p) {
  const r = devPathOf(p); if (r.err) return { ok: false, error: r.err };
  return execDevTool('nm', [r.file]);
}
function toolBinDisasm(p) {
  const r = devPathOf(p); if (r.err) return { ok: false, error: r.err };
  const o = execDevTool('otool', ['-tvV', r.file]);
  if (o.ok) return o;
  return execDevTool('objdump', ['-d', r.file]);
}
function toolBinDeps(p) {
  const r = devPathOf(p); if (r.err) return { ok: false, error: r.err };
  return execDevTool('otool', ['-L', r.file]);
}
function toolBinHex(p) {
  const r = devPathOf(p); if (r.err) return { ok: false, error: r.err };
  const offset = Math.max(Number((p && p.offset) || 0) || 0, 0);
  const len = Math.min(Math.max(Number((p && p.length) || 256) || 16, 16), 4096);
  return execDevTool('xxd', ['-s', String(offset), '-l', String(len), r.file]);
}

// 编译/运行/分析类命令白名单（execFile 直连，不经 shell，防注入）
const DEV_SHELL_ALLOW = new Set([
  'python3', 'python', 'node', 'npm', 'npx', 'pip3', 'pip',
  'clang', 'clang++', 'gcc', 'g++', 'cc', 'c++', 'swift', 'swiftc',
  'make', 'cmake', 'xcodebuild', 'rustc', 'cargo', 'go', 'javac', 'java',
  'git', 'file', 'strings', 'otool', 'nm', 'objdump', 'lipo', 'codesign', 'plutil', 'xxd', 'hexdump',
]);
function toolRunShell(p) {
  const cmd = String((p && p.cmd) || '').trim();
  if (!DEV_SHELL_ALLOW.has(cmd)) return { ok: false, error: '命令不在白名单：' + cmd + '（仅允许编译 / 运行 / 分析类命令）' };
  const args = Array.isArray(p && p.args) ? p.args.map(String) : [];
  for (const a of args) if (/[`$;&|<>(){}\n]/.test(a)) return { ok: false, error: '参数含非法字符：' + a };
  const home = app.getPath('home');
  let cwd = path.resolve(String((p && p.cwd) || home));
  if (cwd !== home && !cwd.startsWith(home + path.sep)) cwd = home;
  try {
    const out = execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: DEV_MAXBUF, timeout: DEV_TIMEOUT, cwd: cwd });
    return { ok: true, cmd: cmd, output: String(out).slice(0, 300000) };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, error: '命令未安装：' + cmd };
    return { ok: false, error: String((e && e.message) || e), stdout: e && e.stdout ? String(e.stdout).slice(0, 80000) : '', stderr: e && e.stderr ? String(e.stderr).slice(0, 80000) : '' };
  }
}

// 异步版 toolRunShell：不阻塞主进程，支持长任务（如 Zotero 批量入库，需几分钟）。
// 同步版 toolRunShell 用 execFileSync，45s 超时一到就把长任务杀死（spawnSync ETIMEDOUT）；
// 「立即入库」这类批量活必须走这里——给足超时，UI 也不卡。
// p.timeout：毫秒，缺省 DEV_TIMEOUT，上限 30 分钟。
function toolRunShellAsync(p) {
  const cmd = String((p && p.cmd) || '').trim();
  if (!DEV_SHELL_ALLOW.has(cmd)) return Promise.resolve({ ok: false, error: '命令不在白名单：' + cmd + '（仅允许编译 / 运行 / 分析类命令）' });
  const args = Array.isArray(p && p.args) ? p.args.map(String) : [];
  for (const a of args) if (/[`$;&|<>(){}\n]/.test(a)) return Promise.resolve({ ok: false, error: '参数含非法字符：' + a });
  const home = app.getPath('home');
  let cwd = path.resolve(String((p && p.cwd) || home));
  if (cwd !== home && !cwd.startsWith(home + path.sep)) cwd = home;
  const timeoutMs = Math.min(Math.max(Number(p && p.timeout) || DEV_TIMEOUT, 1000), 30 * 60 * 1000);
  return new Promise(function (resolve) {
    try {
      execFile(cmd, args, { encoding: 'utf8', maxBuffer: DEV_MAXBUF, timeout: timeoutMs, cwd: cwd }, function (err, stdout, stderr) {
        if (err) {
          if (err && err.code === 'ENOENT') return resolve({ ok: false, error: '命令未安装：' + cmd });
          if (err && (err.killed || err.signal === 'SIGTERM')) {
            return resolve({ ok: false, error: '执行超时（' + Math.round(timeoutMs / 1000) + ' 秒）被中止。脚本可能仍在后台运行，请稍后重试或查看日志。', stdout: String(stdout || '').slice(0, 80000), stderr: String(stderr || '').slice(0, 80000) });
          }
          return resolve({ ok: false, error: String((err && err.message) || err), stdout: String(stdout || '').slice(0, 80000), stderr: String(stderr || '').slice(0, 80000) });
        }
        resolve({ ok: true, cmd: cmd, output: String(stdout || '').slice(0, 300000) });
      });
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

// ---------- CityVerse 总控（tools/chief.py）----------
// 为什么不直接给通用助手 run_shell：通用助手的职责是「指挥」不是「执行」。
// 这里只暴露总控自己的动作，脚本路径 / 工作目录 / 命令名全部写死，模型只能填参数。
// 即使模型被诱导，最大破坏面也只是「往队列里投一条任务」——而投进去之后
// 能干什么，仍由总控自己的权限模型兜底（kind 白名单、codex 只能在仓库内跑）。
const CHIEF_REPO = process.env.CITYVERSE_REPO || path.join(app.getPath('home'), 'Dev', 'cityverse-ar');
const CHIEF_KINDS = new Set(['codex', 'ingrids', 'intel', 'strategy', 'asset', 'shell']);
const CHIEF_READONLY = new Set(['ls', 'show', 'log', 'doctor', 'board', 'tell_prompt']);

function chiefRun(script, args, input) {
  try {
    const out = execFileSync(SYSTEM_PY3, [path.join(CHIEF_REPO, 'tools', script)].concat(args), {
      cwd: CHIEF_REPO, encoding: 'utf8', env: pyEnv(), input: input == null ? '' : String(input),
      timeout: 180000, maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, output: String(out).slice(0, 60000) };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, error: '解释器或脚本不存在：' + SYSTEM_PY3 };
    return {
      ok: false, error: String((e && e.message) || e),
      stdout: e && e.stdout ? String(e.stdout).slice(0, 20000) : '',
      stderr: e && e.stderr ? String(e.stderr).slice(0, 20000) : '',
    };
  }
}

function toolChief(p) {
  const action = String((p && p.action) || '').trim();
  const out = (r) => Object.assign({ action: action, readonly: CHIEF_READONLY.has(action) }, r);
  if (!fs.existsSync(path.join(CHIEF_REPO, 'tools', 'chief.py'))) {
    return out({ ok: false, error: '找不到仓库：' + CHIEF_REPO + '（可用环境变量 CITYVERSE_REPO 指定）' });
  }
  const id = String((p && p.id) || '').trim();
  if (['show', 'log', 'cancel'].indexOf(action) >= 0 && !/^\d+$/.test(id)) {
    return out({ ok: false, error: 'action=' + action + ' 需要数字 id' });
  }

  if (action === 'ls') {
    const n = String(Math.min(Math.max(Number(p && p.limit) || 15, 1), 50));
    return out(chiefRun('chief.py', ['ls', '-n', n]));
  }
  if (action === 'show') return out(chiefRun('chief.py', ['show', id]));
  if (action === 'log') return out(chiefRun('chief.py', ['log', id]));
  if (action === 'doctor') return out(chiefRun('chief.py', ['doctor']));
  if (action === 'board') return out(chiefRun('ingrids.py', ['board']));
  if (action === 'cancel') return out(chiefRun('chief.py', ['cancel', id]));

  // 把「看板 + 队列 + worker 清单」一次性取出来，供模型自己翻译成任务
  if (action === 'tell_prompt') {
    const words = String((p && p.words) || '').slice(0, 2000);
    if (!words.trim()) return out({ ok: false, error: 'tell_prompt 需要 words（用户原话）' });
    return out(chiefRun('chief.py', ['tell', '--prompt', words]));
  }

  if (action === 'submit') {
    const kind = String((p && p.kind) || '').trim();
    if (!CHIEF_KINDS.has(kind)) return out({ ok: false, error: 'kind 必须是 ' + Array.from(CHIEF_KINDS).join(' / ') });
    const title = String((p && p.title) || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 120);
    if (!title) return out({ ok: false, error: 'submit 需要 title' });
    const spec = String((p && p.spec) || '').slice(0, 20000);
    if (kind === 'codex' && !spec.trim()) return out({ ok: false, error: 'codex 任务必须给 spec，否则 worker 起来就空转' });
    const argv = ['submit', '--kind', kind, '--title', title];
    const args = String((p && p.args) || '').slice(0, 4000);
    if (args) argv.push('--args', args);
    const timeout = Number(p && p.timeout) || 0;
    if (timeout > 0) argv.push('--timeout', String(Math.min(timeout, 14400)));
    const prio = Number(p && p.priority) || 0;
    if (prio) argv.push('--priority', String(Math.min(Math.max(prio, 1), 999)));
    const r = chiefRun('chief.py', argv, spec);
    if (r.ok) r.hint = '已入队。总控每 3–5 秒扫一次队列，等下再 ls 就能看到 running；不要在这里等它跑完。';
    return out(r);
  }

  return out({ ok: false, error: '未知 action：' + (action || '(空)') + '，可用：' + Array.from(CHIEF_READONLY).concat(['submit', 'cancel']).join(' / ') });
}

function toolBinPatch(p) {  const target = path.resolve(String((p && p.path) || ''));
  if (!target || !fs.existsSync(target)) return { ok: false, error: '文件不存在' };
  if (!isSafeWritePath(target)) return { ok: false, error: '拒绝补丁该位置（仅允许主目录内的文件，可先把目标复制到主目录再补）' };
  const script = path.join(__dirname, 'scripts', 'bin_patch.py');
  if (!fs.existsSync(script)) return { ok: false, error: '缺少补丁脚本 scripts/bin_patch.py' };
  try {
    const out = execFileSync(SYSTEM_PY3, [script, JSON.stringify({ path: target, offset: p && p.offset, bytes: p && p.bytes })], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, env: pyEnv() });
    return JSON.parse(out);
  } catch (e) { return { ok: false, error: '补丁失败：' + String((e && e.message) || e) }; }
}
function toolPyDecompile(p) {
  const target = path.resolve(String((p && p.path) || ''));
  if (!target || !fs.existsSync(target)) return { ok: false, error: '文件不存在' };
  const script = path.join(__dirname, 'scripts', 'pyc_decompile.py');
  if (!fs.existsSync(script)) return { ok: false, error: '缺少反编译脚本 scripts/pyc_decompile.py' };
  try {
    const out = execFileSync(SYSTEM_PY3, [script, target], { encoding: 'utf8', maxBuffer: 30 * 1024 * 1024, env: pyEnv() });
    return JSON.parse(out);
  } catch (e) { return { ok: false, error: '反编译失败：' + String((e && e.message) || e) }; }
}

ipcMain.handle('tool:bin:info', (_e, p) => toolBinInfo(p));
ipcMain.handle('tool:bin:strings', (_e, p) => toolBinStrings(p));
ipcMain.handle('tool:bin:symbols', (_e, p) => toolBinSymbols(p));
ipcMain.handle('tool:bin:disasm', (_e, p) => toolBinDisasm(p));
ipcMain.handle('tool:bin:deps', (_e, p) => toolBinDeps(p));
ipcMain.handle('tool:bin:hex', (_e, p) => toolBinHex(p));
ipcMain.handle('tool:run:shell', (_e, p) => toolRunShell(p));
ipcMain.handle('tool:run:shell:async', (_e, p) => toolRunShellAsync(p));
ipcMain.handle('tool:chief', (e, p) => {
  const result = toolChief(p);
  if (result?.ok && activitySender(e.sender) === 'assistant-chat') {
    const run = activity.start({
      agent: 'cv:chief', from: 'assistant-chat', source: 'CityVerse 本机总控',
      title: p.action === 'submit' ? activityTitle(p.title) : '总控操作 · ' + activityTitle(p.action),
    });
    activity.finish(run);
  }
  return result;
});
ipcMain.handle('tool:bin:patch', (_e, p) => toolBinPatch(p));
ipcMain.handle('tool:py:decompile', (_e, p) => toolPyDecompile(p));
ipcMain.handle('tool:ledger', (_e, p) => toolLedger(p));
ipcMain.handle('tool:inbox', (_e, p) => toolInbox(p));
ipcMain.handle('tool:weekly', () => toolWeekly());

ipcMain.handle('tool:fs:list', (_e, p) => toolFsList(p));
ipcMain.handle('tool:fs:search', (_e, p) => toolFsSearch(p));
ipcMain.handle('tool:fs:read', (_e, p) => toolFsRead(p));
ipcMain.handle('tool:fs:write', (_e, p) => toolFsWrite(p));
ipcMain.handle('tool:fs:append', (_e, p) => toolFsAppend(p));
ipcMain.handle('tool:fs:download', (_e, p) => toolFsDownload(p));
ipcMain.handle('tool:fs:edit', (_e, p) => toolFsEdit(p));
ipcMain.handle('tool:fs:move', (_e, p) => toolFsMove(p));
ipcMain.handle('tool:fs:delete', (_e, p) => toolFsDelete(p));
ipcMain.handle('tool:pptx:fill', (_e, p) => toolPptxFill(p));
ipcMain.handle('tool:image:process', (_e, p) => toolImageProcess(p));
ipcMain.handle('tool:image:generate', (_e, p) => toolImageGenerate(p));
ipcMain.handle('tool:skill:install', (_e, p) => toolSkillInstall(p));
ipcMain.handle('tool:skill:install-from-url', (_e, p) => toolSkillInstallFromUrl(p));
ipcMain.handle('tool:brain:ingest', (_e, p) => toolBrainIngest(p));
ipcMain.handle('tool:brain:lint', (_e, p) => toolBrainLint(p));
ipcMain.handle('tool:brain:index', (_e, p) => toolBrainIndex(p));

/* ---- 会议纪要官：朗读纪要（macOS 原生 TTS `say`，零安装、本地合成、不上云） ---- */
// 吸收 VoiceStudio 的「语音合成」能力，但不引入其 10GB+ 依赖：直接复用 macOS 自带 TTS，
// 并自动挑选中文语音（婷婷 / 美佳 / 淑惠 等），会议纪要本地朗读、零隐私风险。
let speakChild = null;
async function speakMinutes(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { ok: false, error: '没有可朗读的内容' };
  if (process.platform !== 'darwin') return { ok: false, error: '朗读功能目前仅支持 macOS' };
  // 优先选中文语音：跑 `say -v '?'` 找 zh_CN / zh_TW / zh_HK，找不到就用系统默认
  let voice = null;
  try {
    const stdout = await execFileP('/usr/bin/say', ['-v', '?']);
    for (const line of String(stdout).split('\n')) {
      // 直接取语言代码（zh_CN/zh_TW/zh_HK）当 -v 参数：say 支持语言代码，
      // 且避开「语音名含空格（如 Eddy (Chinese (China mainland))）」的解析坑
      const m = line.match(/\bzh_(CN|TW|HK)\b/i);
      if (m) { voice = 'zh_' + m[1].toUpperCase(); break; }
    }
  } catch (e) { /* 无中文语音则用系统默认 */ }
  if (speakChild) { try { speakChild.kill(); } catch { /* 忽略 */ } speakChild = null; }
  const args = voice ? ['-v', voice, t] : [t];
  speakChild = spawn('/usr/bin/say', args, { stdio: 'ignore' });
  speakChild.on('exit', () => { speakChild = null; });
  return { ok: true, voice: voice || '系统默认' };
}
ipcMain.handle('meeting:speak', (_e, text) => speakMinutes(text));
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
      const notionItems = [];
      for (const it of (nr || [])) {
        // 数据库：展开其条目（row）——Notion 进度笔记多在数据库行里
        if (it.object === 'database' && Array.isArray(it.rows) && it.rows.length) {
          for (const row of it.rows) {
            notionItems.push({ title: row.title, object: 'database_row', id: row.id, db: it.title, source: 'Notion' });
          }
        } else if (it.object !== 'database') {
          notionItems.push({ title: it.title, object: it.object, id: it.id, source: 'Notion' });
        } else {
          // 数据库本身命中但条目为空：至少告诉模型有这个库
          notionItems.push({ title: it.title, object: 'database', id: it.id, source: 'Notion' });
        }
      }
      out.notion = notionItems.slice(0, k);
    }
  } catch (e) { /* ignore */ }
  return out;
});

/* ---------------- 整理数据库工具（Obsidian 写 / Zotero 只读报告） ---------------- */
// 主库：排除工位库后的第一个 vault（你自己敲的字，AI 只读）
function vaultPath() {
  const vaults = detectObsidianVaults();
  const main = vaults.filter((p) => !isWorkspaceVault(p));
  return (main.length ? main : vaults)[0] || null;
}
// 工位库：AI 专用的凌乱库（AI 只在这里写）
function workspaceVaultPath() {
  const vaults = detectObsidianVaults();
  return vaults.find((p) => isWorkspaceVault(p)) || null;
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
function resolveIn(vp, relPath) {
  if (!vp) return null;
  const p = String(relPath || '').trim();
  if (!p) return vp;
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(vp, p);
  return abs.startsWith(vp + path.sep) ? abs : null;
}
function resolveInVault(relPath) { return resolveIn(vaultPath(), relPath); }
function resolveInWorkspace(relPath) { return resolveIn(workspaceVaultPath(), relPath); }
function safeFileName(name) {
  return String(name || '未命名').replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '').trim() || '未命名';
}

function toolDbObsidianWrite(payload) {
  const ws = workspaceVaultPath();
  const vp = ws || vaultPath();
  if (!vp) return { ok: false, error: '未检测到 Obsidian 库（请先安装 Obsidian 并创建 vault）' };
  const title = String((payload && payload.title) || '').trim();
  const content = String((payload && payload.content) || '');
  const tags = Array.isArray(payload && payload.tags) ? payload.tags.map((x) => String(x).trim()).filter(Boolean) : [];
  // 双库分离：AI 写入的笔记默认标记来源「AI生成」，与用户自己敲的笔记区分；
  // 有工位库时 AI 一律写工位库（整个库都是 AI 的，默认落根目录）；没有工位库才退回主库 _AI整理/。
  if (!tags.includes('AI生成')) tags.push('AI生成');
  const folder = ws
    ? String((payload && payload.folder) || '').trim()
    : String((payload && payload.folder) || '_AI整理').trim();
  if (!title) return { ok: false, error: '缺少标题' };
  const dir = folder ? path.resolve(vp, folder) : vp;
  if (dir !== vp && !dir.startsWith(vp + path.sep)) return { ok: false, error: '目录超出 Obsidian 库范围：' + folder };
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
/* 经验沉淀官 bridge：approve 一条 methodology 后，同步写成 Obsidian 主库「经验沉淀/」下的一篇教训笔记。
 * 体例对齐该目录既有笔记（frontmatter type:lesson + 一句话教训 + 现象/根因/修复 + 沉淀规则）。 */
function syncLessonToObsidian(p) {
  const vp = vaultPath();
  if (!vp) return { ok: false, error: '未检测到 Obsidian 主库（请先安装 Obsidian 并创建 vault）' };
  const title = String((p && p.title) || (p && p.rule) || '未命名经验').trim();
  const short = (title.split(/[：:]/)[0] || '').trim() || title;
  const heading = '经验沉淀：' + short;
  const d = new Date();
  const p2 = (x) => String(x).padStart(2, '0');
  const dateStr = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
  const tags = ['经验沉淀', '教训', (p && p.rule) || '未分类'];
  const body = [
    '## 一句话教训', '',
    '> **' + title + '**', '',
    '## 现象', '',
    String((p && p.evidence) || '（无）').trim(), '',
    '## 根因', '',
    String((p && p.rootCause) || '（无）').trim(), '',
    '## 修复', '',
    String((p && p.fixApproach) || '（无）').trim(), '',
    '## 沉淀的规则 / 验证', '',
    String((p && p.verification) || '（无）').trim(), '',
  ].join('\n');
  const fm = ['---', 'title: ' + JSON.stringify(heading), 'type: lesson', 'date: ' + dateStr, 'tags:'];
  tags.forEach((t) => fm.push('  - ' + JSON.stringify(String(t))));
  fm.push('---', '');
  const content = fm.join('\n') + '\n# ' + heading + '\n\n' + body;
  const dir = path.join(vp, '经验沉淀');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, safeFileName(heading) + '.md');
    if (fs.existsSync(full)) return { ok: true, skipped: true, path: full, reason: '同名经验已存在，跳过（唯一真相源）' };
    fs.writeFileSync(full, content, 'utf8');
    return { ok: true, path: full, title: heading };
  } catch (e) { return { ok: false, error: '写入 Obsidian 失败：' + String(e && e.message || e) }; }
}
/* 伦理 agent 对话自动同步到 Obsidian（未规范模式问答，按会话聚合：一个会话一个 .md，边聊边追加） */
function ethicsSync(payload) {
  const vp = vaultPath();
  if (!vp) return { ok: false, error: '未检测到 Obsidian 主库（请先安装 Obsidian 并创建 vault）' };
  const q = String((payload && payload.qa && payload.qa.q) || '').trim();
  const a = String((payload && payload.qa && payload.qa.a) || '').trim();
  if (!q && !a) return { ok: false, error: '缺少问答内容' };
  const tsn = (payload && payload.qa && payload.qa.ts) ? Number(payload.qa.ts) : Date.now();
  const d = isFinite(tsn) && tsn > 0 ? new Date(tsn) : new Date();
  const p2 = (x) => String(x).padStart(2, '0');
  const stamp = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());

  // 1) 优先归档到「伦理场景库」对应场景的 ## 标题下（scene.fname + scene.heading）
  const scene = payload && payload.scene;
  if (scene && scene.fname && scene.heading) {
    try {
      const fname = safeFileName(String(scene.fname));
      const full = path.resolve(vp, '伦理场景库', fname);
      if (fs.existsSync(full)) {
        const heading = '## ' + String(scene.heading).trim();
        const lines = fs.readFileSync(full, 'utf8').split('\n');
        let start = -1;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim() === heading) { start = i; break; }
        }
        if (start >= 0) {
          // 场景块结束于下一个 ## 或 ---
          let end = lines.length;
          for (let i = start + 1; i < lines.length; i++) {
            if (/^##\s/.test(lines[i]) || /^---\s*$/.test(lines[i])) { end = i; break; }
          }
          const sec = [
            '### 🤖 伦理 agent 实答 · ' + stamp,
            '',
            '**问**：' + q,
            '',
            '**答**：' + a,
            ''
          ];
          lines.splice(end, 0, ...sec);
          fs.writeFileSync(full, lines.join('\n'), 'utf8');
          return { ok: true, path: full, scene: true };
        }
      }
    } catch (e) { /* 落入兜底 */ }
  }

  // 2) 兜底：匹配不到场景 → 「伦理对话·待归档」目录（一段对话一个笔记）
  const title = safeFileName(String((payload && payload.title) || '未命名对话'));
  const dir = path.resolve(vp, '伦理对话·待归档');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const full = path.join(dir, title + '.md');
    const section = '## 未规范 · ' + stamp + '\n\n**问**：' + q + '\n\n**答**：' + a + '\n';
    if (fs.existsSync(full)) {
      fs.appendFileSync(full, '\n---\n\n' + section, 'utf8');
    } else {
      const head = '---\ntags:\n  - 伦理对话\n  - 伦理agent\n  - AI生成\n  - 未规范\n  - 待归档\n---\n\n# ' + title + '\n\n> 来源：伦理 agent「未规范模式」对话记录（未匹配到现有场景，暂存待人工归档）\n\n' + section;
      fs.writeFileSync(full, head, 'utf8');
    }
    return { ok: true, path: full, scene: false };
  } catch (e) { return { ok: false, error: '同步失败：' + String(e && e.message || e) }; }
}

// 法务检索：在法务知识库中按关键词匹配法条，返回准确的法条原文片段。
// 供伦理 agent「法律咨询」时引用真实法条，避免凭记忆编造条文号/刑罚。
function legalSearch(payload) {
  const vp = vaultPath();
  if (!vp) return { ok: false, error: '未检测到 Obsidian 主库' };
  const q = String((payload && payload.query) || '').trim();
  if (!q) return { ok: false, error: '检索词为空' };
  const legalDir = path.join(vp, '法务知识库');
  if (!fs.existsSync(legalDir)) return { ok: false, error: '法务知识库不存在（请先生成法务知识库）' };
  const max = Number(payload && payload.max) || 5;
  const norm = (s) => String(s || '').toLowerCase().replace(/[《》「」『』（）()\[\]【】\s·、，,。；;：:""''\/\\\-—_—…]+/g, '');
  const qn = norm(q);
  const hits = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!f.endsWith('.md') || f.startsWith('00-')) continue;
      let text; try { text = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
      const name = f.replace(/\.md$/, '');
      let score = 0;
      const nn = norm(name);
      if (nn && qn && (nn.includes(qn) || qn.includes(nn))) score += 5;
      for (const w of qn.split(/\s+/).filter(Boolean)) {
        if (w.length >= 2 && text.includes(w)) score += 1;
      }
      if (score <= 0) continue;
      const m = text.match(/## 法条原文[\s\S]*?(?=\n##\s|\n---\n|$)/) || text.match(/## 核心条款[\s\S]*?(?=\n##\s|\n---\n|$)/);
      const refM = text.match(/\*\*参考条文\*\*：([^\n]+)/);
      hits.push({ name, ref: refM ? refM[1].trim() : '', snippet: m ? m[0].replace(/^## \S+\s*/, '').trim().slice(0, 500) : '', score });
    }
  };
  try { walk(legalDir); } catch (e) { return { ok: false, error: '检索失败：' + String(e && e.message || e) }; }
  hits.sort((a, b) => b.score - a.score);
  return { ok: true, query: q, count: hits.length, hits: hits.slice(0, max) };
}
function toolDbObsidianTag(payload) {
  const vp = workspaceVaultPath() || vaultPath();
  if (!vp) return { ok: false, error: '未检测到 Obsidian 库' };
  const target = resolveIn(vp, (payload && payload.path) || '');
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
  const vp = workspaceVaultPath() || vaultPath();
  if (!vp) return { ok: false, error: '未检测到 Obsidian 库' };
  const from = resolveIn(vp, (payload && payload.from) || '');
  const to = resolveIn(vp, (payload && payload.to) || '');
  if (!from || !to) return { ok: false, error: '来源或目标超出 Obsidian 库范围' };
  try {
    if (!fs.existsSync(from)) return { ok: false, error: '来源不存在：' + String((payload && payload.from) || '') };
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    return { ok: true, from: from, to: to };
  } catch (e) { return { ok: false, error: '移动失败：' + String(e && e.message || e) }; }
}
// 晋升：用户确认某篇「值得留」后，从工位库搬到主库，并把「AI生成」标签换成人工标签，
// 标志「判断权已由人收回」——这是双库分离的最后一步，必须人来做，不让 AI 自行晋升。
function toolDbObsidianPromote(payload) {
  const main = vaultPath();
  if (!main) return { ok: false, error: '未检测到 Obsidian 主库' };
  const ws = workspaceVaultPath();
  // from 优先在工位库解析；没有工位库（旧数据）时退回主库解析
  const from = resolveIn(ws || main, (payload && payload.path) || '');
  if (!from) return { ok: false, error: '来源路径超出 Obsidian 库范围' };
  if (!fs.existsSync(from)) return { ok: false, error: '笔记不存在：' + String((payload && payload.path) || '') };
  const toDir = resolveIn(main, String((payload && payload.folder) || '').trim());
  if (!toDir) return { ok: false, error: '目标目录超出主库范围' };
  const target = path.join(toDir, path.basename(from));
  try {
    fs.mkdirSync(toDir, { recursive: true });
    fs.renameSync(from, target);
    const tags = (Array.isArray(payload && payload.tags) && payload.tags.length)
      ? payload.tags.map((x) => String(x).trim()).filter(Boolean)
      : ['已采纳'];
    let content = fs.readFileSync(target, 'utf8');
    const fm = parseFrontmatter(content);
    if (fm.has) {
      const inner = fm.header.replace(/^---\r?\n/, '').replace(/\r?\n---\r?\n?$/, '');
      const cleaned = inner
        .replace(/^tags\s*:\s*\r?\n(?:\s+-\s+.*\r?\n?)+/m, '')
        .replace(/^tags\s*:.*$/m, '')
        .replace(/\n{2,}/g, '\n').trim();
      const tagBlock = 'tags:\n' + tags.map((t) => '  - ' + JSON.stringify(t)).join('\n');
      content = '---\n' + (cleaned ? cleaned + '\n' + tagBlock : tagBlock) + '\n---\n' + fm.body;
      fs.writeFileSync(target, content, 'utf8');
    } else {
      // 旧笔记没有 frontmatter，晋升时补一个（title 用文件名 + 已采纳标签）
      content = buildFrontmatter(path.basename(target).replace(/\.md$/i, ''), tags, content);
      fs.writeFileSync(target, content, 'utf8');
    }
    return { ok: true, from: from, to: target, tags: tags };
  } catch (e) { return { ok: false, error: '晋升失败：' + String(e && e.message || e) }; }
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
// 列出工位库里的全部笔记（供「工位库」面板展示 + 一键晋升按钮）
function toolDbWorkspaceList() {
  const ws = workspaceVaultPath();
  if (!ws) return { ok: true, vault: null, notes: [] };
  const skip = new Set(['.obsidian', '.trash', '.git', 'node_modules']);
  const notes = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.isDirectory()) { if (!skip.has(ent.name)) walk(path.join(dir, ent.name)); continue; }
      if (!/\.md$/i.test(ent.name)) continue;
      const full = path.join(dir, ent.name);
      let st; try { st = fs.statSync(full); } catch { continue; }
      let tags = [], title = ent.name.replace(/\.md$/i, '');
      try {
        const content = fs.readFileSync(full, 'utf8');
        const fm = parseFrontmatter(content);
        tags = fm.tags;
        const tm = fm.header.match(/^title\s*:\s*(.+)$/m);
        if (tm) {
          try { title = JSON.parse(tm[1].trim()); } catch { title = tm[1].trim().replace(/^['"]|['"]$/g, ''); }
        }
      } catch { /* 忽略单篇读取失败 */ }
      notes.push({ path: path.relative(ws, full).split(path.sep).join('/'), name: ent.name, title: title, tags: tags, mtime: st.mtimeMs });
    }
  }
  walk(ws);
  notes.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  return { ok: true, vault: ws, notes: notes };
}
async function toolDbZoteroReport() {
  const zdir = detectZoteroDir();
  if (!zdir) return { ok: false, error: '未检测到 Zotero 数据目录（~/Zotero 不存在）' };
  const stdout = await execFileP(SYSTEM_PY3, [path.join(__dirname, 'kb-zotero.py'), '--meta-only']);
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
ipcMain.handle('tool:db:obsidian:promote', (_e, p) => toolDbObsidianPromote(p));
ipcMain.handle('tool:db:obsidian:report', () => toolDbObsidianReport());
ipcMain.handle('ethics:sync', (_e, p) => ethicsSync(p));
ipcMain.handle('legal:search', (_e, p) => legalSearch(p));

/* ---------------- Agent 架构图：工作台实际执行状态 ---------------- */
const rendererActivity = new WeakMap();
function rendererJobsFor(sender) {
  let jobs = rendererActivity.get(sender);
  if (!jobs) {
    jobs = new Map();
    rendererActivity.set(sender, jobs);
    const stopJobs = () => {
      for (const id of jobs.values()) activity.finish(id, { status: 'stopped' });
      jobs.clear();
    };
    sender.once('destroyed', stopJobs);
    sender.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) stopJobs();
    });
  }
  return jobs;
}

ipcMain.on('arch:meeting', (e, payload) => {
  const sender = e.sender;
  if (e.senderFrame !== sender.mainFrame || !/^file:.*\/agents\/meeting-audio\/index\.html$/.test(sender.getURL())) return;
  const p = payload || {};
  if (typeof p.id !== 'string' || p.id.length > 60) return;
  const jobs = rendererJobsFor(sender);
  const id = jobs.get(p.id);
  if (p.status === 'done' || p.status === 'failed') {
    if (id) activity.finish(id, { status: p.status });
    jobs.delete(p.id);
    return;
  }
  const title = {
    live: '实时会议转写', transcribe: '录音精确转写', summary: '生成会议总结', minutes: '生成会议纪要',
    ppt: '导出会议 PPT', enroll: '登记说话人声纹',
  }[p.stage];
  if (p.status === 'running' && typeof title === 'string' && !id) {
    jobs.set(p.id, activity.start({ agent: 'meeting-audio', source: '会议处理', title }));
  }
});

ipcMain.on('arch:delegation', (e, payload) => {
  const sender = e.sender;
  if (sender !== mainWindow?.webContents || e.senderFrame !== sender.mainFrame) return;
  const p = payload || {};
  if (typeof p.id !== 'string' || p.id.length > 60) return;
  const jobs = rendererJobsFor(sender);
  const id = jobs.get(p.id);
  if (p.stage === 'finish') {
    if (id) {
      activity.finish(id, { status: p.status === 'ok' ? 'done' : p.status === 'skipped' ? 'stopped' : 'failed',
        simulated: p.simulated === true });
      jobs.delete(p.id);
    }
    return;
  }
  if (p.stage !== 'running' && p.stage !== 'waiting') return;
  const nodes = Architecture.inventory(readJson('agents.json', []));
  const key = id => id && nodes.find(node => node.id === id)?.key;
  const agent = key(p.targetId);
  const from = key(p.commanderId);
  if (!agent || !from) return;
  const details = {
    agent, from, handoff: p.stage === 'running' ? key(p.previousId) : undefined,
    source: '工作台委派', title: activityTitle(p.task) || '委派任务',
    status: p.stage, phase: p.stage === 'waiting' ? '等待委派审批' : '执行委派任务',
    engine: activityTitle(p.engine), simulated: p.simulated === true,
  };
  if (id) activity.update(id, details);
  else jobs.set(p.id, activity.start(details));
});

ipcMain.handle('arch:status', (e) => {
  if (e.senderFrame !== e.sender.mainFrame || !/^file:.*\/agents\/(agent-console|agent-architecture)\/index\.html$/.test(e.senderFrame.url)) {
    throw new Error('执行记录仅在工作台架构页显示');
  }
  const registry = readJson('agents.json', []);
  const ops = readJson('ops-governor.json', null);
  const types = readJson('agent-types-report.json', null);
  const radar = readJson('eco-radar.json', null);
  const queue = getTaskQueue().list();
  const tickets = queue.filter(t => t.status === 'running' || t.status === 'waiting' || (t.status === 'queued' && !t.schedule))
    .map(t => ({
      id: t.id, agent: 'task-queue', source: '后台队列', title: activityTitle(t.title),
      phase: activityTitle(t.category), status: t.status, engine: t.model || t.engine,
      startedAt: Date.parse(t.updatedAt || t.createdAt),
    }));
  const readings = [
    ...['cost', 'model', 'workforce'].map(agent => [agent, '运营治理巡检', ops?.generated_at, ops?.error]),
    ['type-governor', '触发类型巡检', types?.generated_at, types?.error],
    ['radar', '生态资讯扫描', radar?.lastRun],
  ].filter(item => item[2]).map(([agent, title, time, error]) => ({
    agent, title, source: '本地报告', status: error ? 'failed' : 'done',
    endedAt: typeof time === 'number' ? time : Date.parse(time),
  }));
  const completed = queue.filter(t => ['done', 'failed', 'cancelled'].includes(t.status))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 20).map(t => ({
      agent: 'task-queue', title: activityTitle(t.title), source: '后台队列',
      status: t.status === 'cancelled' ? 'stopped' : t.status, endedAt: Date.parse(t.updatedAt),
    }));
  const pendingExperience = getKnowledgeSettler().report().pending_approval;
  if (pendingExperience) tickets.push({
    agent: 'settler', status: 'waiting', source: '经验库',
    title: pendingExperience + ' 条经验提案等待人工审核',
  });
  const runs = activity.snapshot();
  const pendingApprovals = {
    tasks: queue.filter(t => t.status === 'waiting').length,
    experience: pendingExperience,
    cityverse: 0, // CityVerse 待审批由 cityverseOverview 单独提供（异步 fetch）
  };
  return {
    now: Date.now(), nodes: Architecture.inventory(registry),
    active: runs.active.concat(tickets),
    recent: runs.recent.concat(readings, completed).sort((a, b) => b.endedAt - a.endedAt),
    pendingApprovals,
  };
});

// CityVerse 后台控制台（intel/dashboard.py，默认 127.0.0.1:8756）实时概览。
// 由主进程 fetch，绕开渲染进程 file:// 的 CORS 限制；控制台未启动时返回 online:false。
async function cityverseOverview() {
  const out = { online: false, error: '', now: Date.now(),
    findings: 0, insights: 0, insightsReady: 0,
    playbook: 0, plans: 0, plansPending: 0, plansApproved: 0, runs: 0, gates: 0,
    active: { tasksRunning: 0, plansExecuting: 0, gatesReviewing: 0, pendingApproval: 0 } };
  if (!(await isPortOpen(8756))) {
    out.error = '控制台未启动（python3 intel/dashboard.py）';
    return out;
  }
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch('http://127.0.0.1:8756/api/overview', { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) { out.error = 'HTTP ' + r.status; return out; }
    const j = await r.json();
    const sum = (m) => Object.values(m || {}).reduce((a, b) => a + Number(b || 0), 0);
    out.online = true;
    out.findings = Number(j.findings || 0);
    out.insights = Number(j.insights || 0);
    out.insightsReady = Number(j.insights_ready || 0);
    out.playbook = sum(j.playbook);
    out.plans = sum(j.plans);
    out.plansPending = Number((j.plans || {})['pending_approval'] || 0);
    out.plansApproved = Number((j.plans || {})['approved'] || 0);
    out.runs = Number(j.executor_runs || 0);
    out.gates = sum(j.gates);
    if (j.active) {
      out.active = {
        tasksRunning: Number(j.active.tasks_running || 0),
        plansExecuting: Number(j.active.plans_executing || 0),
        gatesReviewing: Number(j.active.gates_reviewing || 0),
        pendingApproval: Number(j.active.pending_approval || 0),
        lastRunAt: j.active.last_run_at || '',
        lastGateAt: j.active.last_gate_at || '',
      };
    }
  } catch (e) { out.error = String((e && e.message) || e); }
  return out;
}
ipcMain.handle('arch:cityverse-overview', () => cityverseOverview());

// 仅查询控制台现有的只读端点，返回架构视图需要的标题和状态。
ipcMain.handle('arch:cityverse-stage', async (_e, stage) => {
  const routes = {
    collect: 'findings', insight: 'insights', playbook: 'playbook', plan: 'plans',
    approval: 'plans', execute: 'runs', gate: 'runs',
  };
  if (!Object.hasOwn(routes, stage)) return { error: '未知项目阶段' };
  try {
    const response = await fetch('http://127.0.0.1:8756/api/' + routes[stage], { signal: AbortSignal.timeout(2500) });
    if (!response.ok) return { error: '阶段接口返回 HTTP ' + response.status };
    const rows = await response.json();
    if (!Array.isArray(rows)) return { error: '控制台未返回阶段列表' };
    const filtered = rows.filter(row => {
      if (stage === 'approval') return row.status === 'pending_approval';
      if (stage === 'gate') return !!row.gate_status;
      return true;
    });
    const items = filtered.slice(0, 8).map(row => {
      const run = stage === 'execute' || stage === 'gate';
      const title = run ? '计划 #' + row.plan_id + ' · 执行 #' + row.id
        : activityTitle(row.title || row.summary) || ((row.id != null) ? '记录 #' + row.id : '采集记录');
      return { title, status: activityTitle(stage === 'gate' ? row.gate_status : row.status) };
    });
    return { items };
  } catch {
    return { error: '暂时无法读取 CityVerse 阶段记录' };
  }
});

// CityVerse 待审批规划列表 + 审批动作（批准/拒绝/执行），供工作台架构图「人工审批」节点就地审批。
async function cityversePendingPlans() {
  if (!(await isPortOpen(8756))) return { online: false, plans: [], error: '控制台未启动（python3 intel/dashboard.py）' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch('http://127.0.0.1:8756/api/plans', { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { online: true, plans: [], error: 'HTTP ' + r.status };
    const plans = await r.json();
    return { online: true, plans: (Array.isArray(plans) ? plans : []).filter(function (p) { return p.status === 'pending_approval'; }) };
  } catch (e) { return { online: true, plans: [], error: String((e && e.message) || e) }; }
}

async function cityversePlanAction(planId, action, reason) {
  const ALLOWED = { approve: 1, reject: 1, execute: 1 };
  if (!ALLOWED[action]) return { ok: false, error: '非法动作：' + action };
  if (!(await isPortOpen(8756))) return { ok: false, error: '控制台未启动（python3 intel/dashboard.py）' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const opts = { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json' } };
    if (reason) opts.body = JSON.stringify({ reason: reason });
    const r = await fetch('http://127.0.0.1:8756/api/plans/' + planId + '/' + action, opts);
    clearTimeout(t);
    const j = await r.json().catch(function () { return {}; });
    if (!r.ok) return { ok: false, error: (j && j.error) || ('HTTP ' + r.status) };
    return { ok: true, result: j };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
ipcMain.handle('arch:cityverse-pending-plans', () => cityversePendingPlans());
ipcMain.handle('arch:cityverse-plan-action', (_e, id, action, reason) => cityversePlanAction(id, action, reason));

ipcMain.handle('workspace:list', () => toolDbWorkspaceList());
ipcMain.handle('tool:db:zotero:report', () => toolDbZoteroReport());
ipcMain.handle('tool:db:zotero:tag', (_e, p) => toolDbZoteroTag(p));
ipcMain.handle('tool:db:zotero:collection', (_e, p) => toolDbZoteroCollection(p));
// 文献管家：手动触发一次「Zotero 自动入库与整理」（复用定时任务同一入口）
ipcMain.handle('zotero:ingest-now', () => {
  const t = SCHEDULED_COMMANDS.find((c) => c.key === 'zotero-ingest');
  if (!t) return Promise.resolve({ ok: false, error: '未找到 zotero-ingest 定时任务' });
  return runScheduledCommand(t);
});

/* ---------------- 生命周期 ---------------- */
if (gotSingleInstanceLock) {
  app.whenReady().then(() => {
    createMainWindow();
    // 知识库：首次运行自动检测源 + 后台增量索引 + 文件监听自动更新
    kbEngine.ensureConfig();
    // 扫描延迟到首屏渲染后再跑，避免启动时同步遍历大目录/提取文件阻塞主进程（窗口秒开，索引后台增量）
    setTimeout(() => { kbEngine.scan().catch(() => {}); }, 2000);
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
    // Notion 自动同步：每 30 分钟重新拉取全文并增量索引（token 未配置则自动跳过）
    setInterval(() => { runNotionSync().catch(() => {}); }, 30 * 60 * 1000);
    // 研究同步官：每 30 分钟检查 latest 目录，把新增/更新的 md+docx 推送到 Notion（未配置则自动跳过）
    setInterval(() => { runResearchSync().catch(() => {}); }, 30 * 60 * 1000);
    // 研究日历到期自动提醒：启动即查一次 + 每 60 秒轮询（发系统通知 + 广播给面板）
    runReminderCheck();
    setInterval(() => { runReminderCheck(); }, 60 * 1000);
    // 后台任务 Watchdog：定时巡检卡死任务（吸收 dsh 自愈思想）
    startTaskWatchdog();
    // 定时任务调度器：按计划自动触发后台任务（吸收 dsh 主动找活思想）
    startTaskScheduler();
    // 主进程定时命令：Zotero 自动入库/周报 + 知识库索引 + 每周文献综述（本地脚本直跑，不依赖 WorkBuddy）
    startScheduledCommands();
    // 灵感目录：确保内置调研 Agent 与每日调研计划存在
    ensureEcoRadar();
    // 法务知识库：确保每周更新的后台任务存在（原 WorkBuddy 自动化已迁移到此）
    ensureLegalUpdateTask();
    // CityVerse 情报：清理已废弃的工作台侧「每日综合简报」任务（统一由 CityVerse research agent 负责）
    cleanupLegacyCityverseIntel();
    // CityVerse 建设流水线：同步 DeepSeek Key（走云端，摆脱本地 Ollama 内存争抢）
    syncCityverseDeepseekKey();
    // API 余额监控：启动延时检查一次 + 每 60 分钟自动刷新余额并低余额提醒（DeepSeek 可自动查，其余手动填）
    setTimeout(() => { refreshBalanceAndAlert().catch(() => {}); }, 3000);
    setInterval(() => { refreshBalanceAndAlert().catch(() => {}); }, 60 * 60 * 1000);
    // Agent 类型治理官：启动自动巡检一次 + 每 24 小时定时巡检（主动型 · 时间驱动）
    // 变更时才发系统通知；锁定 agent 豁免自动修正。首次运行会把全部 agent 归入四类。
    setTimeout(() => { runAgentTypeGovernance(); }, 1200);
    setInterval(() => { runAgentTypeGovernance(); }, 24 * 60 * 60 * 1000);
    // 运营治理官（CFO 成本 + 模型调控 + Agent 总管）：启动自动巡检一次 + 每 15 分钟刷新本地状态与成本，
    // 每 24 小时深度巡检团队健康。本地模型状态（Ollama 显存占用）是动态的，需更频繁地刷新供面板实时展示。
    setTimeout(() => { runOpsGovernance().catch(() => {}); }, 1500);
    setInterval(() => { runOpsGovernance().catch(() => {}); }, 15 * 60 * 1000);
    // 知识沉淀官自动发现：启动延时一次 + 每 6 小时定时复盘任务队列已解决项（启发式打分 → 待审批提案，人工在环不变）
    setTimeout(() => { runSettlerDiscovery(); }, 8000);
    setInterval(() => { runSettlerDiscovery(); }, 6 * 60 * 60 * 1000);
    // 统一待办中心：启动延时汇总一次 + 每 60 秒轮询（兜底捕获 CityVerse 控制台新增待审批，
    // 本地任务/经验提案变化由 broadcastTasks / settler 变更点即时触发）
    setTimeout(() => { refreshApprovals(); }, 5000);
    setInterval(() => { refreshApprovals(); }, 60 * 1000);
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
