/**
 * myos-core.js —— 个人运营底座（My-OS）：全局台账 + 惯例收件箱
 *
 * 借鉴小红书「个人 Harness / My-OS」的轻量机制，落到工作台的工程化底座：
 *   1. 台账 ledger.md —— 全局项目进度地图（只记位置，文件留原处）
 *   2. 收件箱 inbox.md —— 惯例/规则变更收件箱（AI 只提议，人逐条点头才进手册/记忆）
 *
 * 设计铁律（与 RULES §1 / 08 篇一致）：
 *   - AI 只提案、不自动写手册：inboxAdd 只记「待确认」，accept 才落笔（由宿主 main.js 执行写 memory / RULES）。
 *   - 纯文本 markdown，放 docs/ 随 git 走，人可读可 diff。
 *   - 零依赖（Node 内置 fs/path），挂 globalThis.MyOS + module.exports。
 *
 * 与既有机制的分工（避免重复造轮子）：
 *   - ≠ 知识沉淀官：沉淀官复盘「已解决问题→方法论/结论」，收件箱管「收工规则/惯例变更→手册/记忆」。
 *   - ≠ memory:refine：refine 是收工直接追加记忆，收件箱补上「待确认」环节。
 *   - ≠ chief board：chief 的 board 只覆盖 cityverse 单项目，台账是「全局所有项目」的人读地图。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const LEDGER = 'ledger.md';
const INBOX = 'inbox.md';

function docPath(root, name) {
  return path.join(String(root || ''), 'docs', name);
}

function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

/** 清洗字段：去换行、把 | 换成全角｜（避免破坏分隔）、trim */
function clean(s) {
  return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').replace(/\|/g, '｜').trim();
}

function uniqId() {
  return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
}

/* ==================== 台账 ledger.md ==================== */

const LEDGER_HEADER = [
  '# 全局项目台账',
  '',
  '> 只记位置，文件留原处。AI 只记现状，改动需人点头。',
  '',
  '<!-- 格式：- 名称 | 位置 | 状态 | 下一步 | 更新时间 -->',
  '',
].join('\n');

function isLedgerEntryLine(l) {
  const t = l.trim();
  return t.startsWith('- ') && !t.startsWith('- <!--');
}

/** 解析台账项目行：- 名称 | 位置 | 状态 | 下一步 | 更新时间 */
function parseLedger(text) {
  const projects = [];
  String(text || '').split('\n').forEach((line) => {
    const t = line.trim();
    if (!isLedgerEntryLine(t)) return;
    const parts = t.slice(2).split('|').map((x) => x.trim());
    if (parts.length < 5) return;
    projects.push({ name: parts[0], location: parts[1], status: parts[2], next: parts[3], updated: parts[4] });
  });
  return projects;
}

function readLedger(root) {
  const p = docPath(root, LEDGER);
  if (!fs.existsSync(p)) return { ok: true, projects: [], text: '' };
  const text = fs.readFileSync(p, 'utf8');
  return { ok: true, projects: parseLedger(text), text: text };
}

/** 新增或更新一条项目记录（只记位置/状态/下一步，不动真实文件） */
function ledgerNote(root, item) {
  const p = docPath(root, LEDGER);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const name = clean(item && item.name);
  if (!name) return { ok: false, error: '需要项目名 name' };
  const location = clean(item && item.location) || '—';
  const status = clean(item && item.status) || '进行中';
  const next = clean(item && item.next) || '—';
  const updated = clean(item && item.updated) || today();

  let projects = [];
  let header = LEDGER_HEADER;
  if (fs.existsSync(p)) {
    const text = fs.readFileSync(p, 'utf8');
    projects = parseLedger(text);
    header = text.split('\n').filter((l) => !isLedgerEntryLine(l)).join('\n').replace(/\n+$/, '\n');
  }
  const existing = projects.find((x) => x.name === name);
  if (existing) {
    existing.location = location; existing.status = status; existing.next = next; existing.updated = updated;
  } else {
    projects.push({ name, location, status, next, updated });
  }
  const body = projects.map((x) => '- ' + [x.name, x.location, x.status, x.next, x.updated].join(' | ')).join('\n');
  fs.writeFileSync(p, header + '\n' + body + '\n', 'utf8');
  return { ok: true, name: name, changed: existing ? 'updated' : 'created', count: projects.length };
}

/* ==================== 惯例收件箱 inbox.md ==================== */

const INBOX_HEADER = [
  '# 惯例收件箱',
  '',
  '> AI 收工把「提议的惯例/规则变更」记这里，人逐条点头（accept）才进手册/记忆。',
].join('\n');

/** 解析收件箱三个区：待确认 / 已采纳 / 已拒绝 */
function parseInbox(text) {
  const out = { pending: [], accepted: [], rejected: [] };
  let cur = null;
  String(text || '').split('\n').forEach((line) => {
    const t = line.trim();
    if (t.startsWith('## 待确认')) { cur = 'pending'; return; }
    if (t.startsWith('## 已采纳')) { cur = 'accepted'; return; }
    if (t.startsWith('## 已拒绝')) { cur = 'rejected'; return; }
    if (!cur) return;
    if (t.startsWith('- <!--')) return;
    if (!t.startsWith('- [ ]') && !t.startsWith('- [x]')) return;
    const parts = t.slice(2).replace(/^\[[ x]\]\s*/, '').split('|').map((x) => x.trim());
    if (parts.length < 5) return;
    const entry = { id: parts[0], date: parts[1], kind: parts[2], content: parts[3], agent: parts[4] };
    if (cur === 'accepted') entry.landedTo = parts[5] || '';
    if (cur === 'rejected') entry.reason = parts[5] || '';
    out[cur].push(entry);
  });
  return out;
}

function buildInbox(state) {
  const sec = [
    ['## 待确认', '<!-- 格式：- [ ] id | 日期 | 类型 | 内容 | 来源agent -->', state.pending, false],
    ['## 已采纳', '<!-- 格式：- [x] id | 日期 | 类型 | 内容 | 来源agent | 落点 -->', state.accepted, true],
    ['## 已拒绝', '<!-- 格式：- [x] id | 日期 | 类型 | 内容 | 来源agent | 原因 -->', state.rejected, true],
  ];
  const lines = [INBOX_HEADER];
  sec.forEach(([title, comment, list, done]) => {
    lines.push('', title, comment);
    if (!list.length) lines.push('_（暂无）_');
    list.forEach((e) => {
      const cols = [e.id, e.date, e.kind, e.content, e.agent];
      if (done) cols.push(e.landedTo || e.reason || '');
      lines.push('- ' + (done ? '[x]' : '[ ]') + ' ' + cols.join(' | '));
    });
  });
  return lines.join('\n') + '\n';
}

function readInbox(root) {
  const p = docPath(root, INBOX);
  if (!fs.existsSync(p)) return Object.assign({ ok: true }, { pending: [], accepted: [], rejected: [] });
  return Object.assign({ ok: true }, parseInbox(fs.readFileSync(p, 'utf8')));
}

/** 记一条「提议的惯例/规则变更」进待确认区（AI 只提议，不落笔） */
function inboxAdd(root, item) {
  const p = docPath(root, INBOX);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const kind = clean(item && item.kind) || '约定';
  const content = clean(item && item.content);
  if (!content) return { ok: false, error: '需要内容 content' };
  const agent = clean(item && item.agent) || '';
  const state = fs.existsSync(p) ? parseInbox(fs.readFileSync(p, 'utf8')) : { pending: [], accepted: [], rejected: [] };
  const entry = { id: uniqId(), date: today(), kind: kind, content: content, agent: agent };
  state.pending.push(entry);
  fs.writeFileSync(p, buildInbox(state), 'utf8');
  return { ok: true, id: entry.id, entry: entry, pending: state.pending.length };
}

/** 采纳一条：移入「已采纳」区，返回条目供宿主落笔（写 memory / RULES） */
function inboxAccept(root, id, opts) {
  const p = docPath(root, INBOX);
  if (!fs.existsSync(p)) return { ok: false, error: '收件箱不存在' };
  const state = parseInbox(fs.readFileSync(p, 'utf8'));
  const idx = state.pending.findIndex((e) => e.id === id);
  if (idx < 0) return { ok: false, error: '找不到待确认条目 id=' + id };
  const entry = state.pending[idx];
  state.pending.splice(idx, 1);
  entry.landedTo = clean(opts && opts.landedTo) || '已采纳';
  state.accepted.unshift(entry);
  fs.writeFileSync(p, buildInbox(state), 'utf8');
  return { ok: true, id: entry.id, entry: entry };
}

/** 拒绝一条：移入「已拒绝」区 */
function inboxReject(root, id, opts) {
  const p = docPath(root, INBOX);
  if (!fs.existsSync(p)) return { ok: false, error: '收件箱不存在' };
  const state = parseInbox(fs.readFileSync(p, 'utf8'));
  const idx = state.pending.findIndex((e) => e.id === id);
  if (idx < 0) return { ok: false, error: '找不到待确认条目 id=' + id };
  const entry = state.pending[idx];
  state.pending.splice(idx, 1);
  entry.reason = clean(opts && opts.reason) || '拒绝';
  state.rejected.unshift(entry);
  fs.writeFileSync(p, buildInbox(state), 'utf8');
  return { ok: true, id: entry.id };
}

/* ==================== 周体检 weekly ==================== */

/** 生成周体检摘要：项目台账 + 待确认清单（人逐条点头） */
function weekly(root) {
  const ledger = readLedger(root);
  const inbox = readInbox(root);
  const lines = [];
  lines.push('## 周体检 · ' + today());
  lines.push('');
  lines.push('### 项目台账（' + ledger.projects.length + ' 个）');
  if (!ledger.projects.length) lines.push('_（台账为空，可用 ledger note 记一条）_');
  ledger.projects.forEach((p) => lines.push('- ' + p.name + '｜' + p.status + '｜下一步：' + p.next));
  lines.push('');
  lines.push('### 惯例收件箱 · 待确认（' + inbox.pending.length + ' 条）');
  if (!inbox.pending.length) lines.push('_（无待确认条目）_');
  inbox.pending.forEach((e) => lines.push('- [ ] ' + e.id + '【' + e.kind + '】' + e.content + '（' + e.agent + '）'));
  lines.push('');
  lines.push('### 已采纳（最近 10 条）');
  if (!inbox.accepted.length) lines.push('_（暂无）_');
  inbox.accepted.slice(0, 10).forEach((e) => lines.push('- [x] ' + e.id + '【' + e.kind + '】' + e.content + ' → ' + e.landedTo));
  lines.push('');
  lines.push('> 待确认条目用 inbox accept/reject 逐条点头；点头后才写进记忆或手册。');
  return { ok: true, summary: lines.join('\n'), ledger: ledger.projects.length, pending: inbox.pending.length };
}

/* ==================== 导出 ==================== */

const api = {
  readLedger, ledgerNote,
  readInbox, inboxAdd, inboxAccept, inboxReject,
  weekly,
  parseLedger, parseInbox,
  LEDGER, INBOX, docPath,
};
if (typeof globalThis !== 'undefined') globalThis.MyOS = api;
module.exports = api;
