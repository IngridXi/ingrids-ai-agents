/**
 * ============================================================
 *  permission-core.js —— 授权门：有副作用操作前的「显式授权 + 审计」（零依赖）
 *  ============================================================
 *
 *  借鉴 DSH 的「permission policy」思想，落地为本工作台的统一授权门：
 *    · deny by default —— 高危 / 有写副作用的操作默认拒绝；
 *    · 显式授权 —— 用户先 grant 一次，操作才能通过 check；
 *    · 全程审计 —— 每次 check（通过 / 拒绝）与 grant / revoke 都留痕。
 *
 *  覆盖两类操作（与现有 CAPABILITIES 的危险等级对齐）：
 *    skill:exec  执行带脚本 / allowed-tools 的 Skill（当前仅注入说明书，预留执行门）
 *    computer:use 电脑操作（截图 + 鼠标键盘，高危，需系统授权）
 *    fs:write    文件写入（有写副作用）
 *    db:write    知识库 / 文献写入
 *
 *  grant 模型：{ id, action, detail, mode, expiresAt, createdAt, reason }
 *    mode: 'once'  一次性（check 通过后自动撤销）
 *          'always' 永久（可手动 revoke）
 *    expiresAt 可选：到点自动失效。
 *
 *  storage 可插拔：{ load(), save(grants), appendAudit(entry), listAudit() }
 *  浏览器默认 localStorage；Electron 桌面版注入文件后端（grants.json + audit jsonl）。
 *
 *  零依赖。浏览器 <script src>；Node require() 后取 globalThis.PermissionCore。
 * ============================================================
 */
(function (global) {
  'use strict';

  function uid(p) { return (p || 'g') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /* ---------- 危险等级表（与 agents-core CAPABILITIES 对齐） ---------- */
  var ACTION_DANGER = {
    'skill:exec': 'high',     // 执行 Skill 脚本
    'computer:use': 'high',   // 电脑操作（截图 + 键鼠）
    'fs:write': 'write',      // 文件写入
    'db:write': 'write',      // 知识库 / 文献写入
  };

  function dangerOf(action) {
    var key = String(action || '').split(':')[0] + ':' + (String(action || '').split(':')[1] || '');
    if (ACTION_DANGER[action]) return ACTION_DANGER[action];
    // 前缀匹配：skill:exec:<id> 命中 skill:exec
    if (/^skill:exec/.test(action)) return 'high';
    if (/^computer:use/.test(action)) return 'high';
    if (/^fs:write/.test(action)) return 'write';
    if (/^db:write/.test(action)) return 'write';
    return 'none';
  }

  /* ---------- 默认 storage（浏览器 localStorage；无则退化内存） ---------- */
  function defaultStorage() {
    var KEY = 'ingrid.permissions', AKEY = 'ingrid.permissions.audit';
    var grants = [];
    var audit = [];
    try {
      var g0 = global.localStorage.getItem(KEY);
      if (g0) grants = JSON.parse(g0);
      var a0 = global.localStorage.getItem(AKEY);
      if (a0) audit = JSON.parse(a0);
    } catch (e) { /* localStorage 不可用则用内存 */ }
    return {
      load: function () { return grants; },
      save: function (g) {
        grants = Array.isArray(g) ? g : [];
        try { global.localStorage.setItem(KEY, JSON.stringify(grants)); } catch (e) {}
      },
      appendAudit: function (entry) {
        audit.push(entry);
        if (audit.length > 2000) audit = audit.slice(-2000);
        try { global.localStorage.setItem(AKEY, JSON.stringify(audit)); } catch (e) {}
      },
      listAudit: function () { return audit; },
    };
  }

  /* ---------- PermissionGate ---------- */
  function PermissionGate(storage) {
    this.storage = storage || defaultStorage();
  }

  PermissionGate.prototype.list = function () {
    var now = Date.now();
    var out = [];
    try { out = this.storage.load() || []; } catch (e) { out = []; }
    return out.filter(function (g) { return !g.expiresAt || g.expiresAt > now; });
  };

  PermissionGate.prototype._save = function (grants) {
    try { this.storage.save(grants); } catch (e) {}
    return this;
  };

  /**
   * 检查某操作是否已获授权。
   * action: 'computer:use' / 'skill:exec:<id>' / 'fs:write:<path>' / 'db:write'
   * opts: { detail } 附加说明，写进审计。
   * 返回 { allowed, reason, grant }
   */
  PermissionGate.prototype.check = function (action, opts) {
    var o = opts || {};
    var now = Date.now();
    var grants = this.list();
    var match = null;
    for (var i = 0; i < grants.length; i++) {
      var g = grants[i];
      if (g.action === action) { match = g; break; }
    }
    // once 授权：命中即用掉（撤销），一次性生效
    var allowed = !!match;
    var reason = allowed ? '已授权（' + (match.mode === 'once' ? '一次性' : '永久') + '）' : '未授权，需先显式授权';
    if (allowed && match.mode === 'once') {
      this.revoke(match.id);
      match = Object.assign({}, match, { consumed: true });
    }
    this._log({ action: action, decision: allowed ? 'allowed' : 'denied', detail: o.detail || '', grantId: match && match.id || '' });
    return { allowed: allowed, reason: reason, grant: match || null };
  };

  /** 授予权限。opts: { mode:'once'|'always', detail, ttlMs } 返回 grant */
  PermissionGate.prototype.grant = function (action, opts) {
    var o = opts || {};
    var grants = this.list();
    var g = {
      id: uid('g'),
      action: String(action || ''),
      mode: o.mode === 'always' ? 'always' : 'once',
      detail: String(o.detail || ''),
      expiresAt: o.ttlMs ? (Date.now() + o.ttlMs) : 0,
      createdAt: Date.now(),
      reason: String(o.reason || ''),
    };
    grants.push(g);
    this._save(grants);
    this._log({ action: g.action, decision: 'granted', detail: g.detail, grantId: g.id });
    return g;
  };

  /** 撤销某条授权（按 id）；传 action 则撤销该 action 下全部授权 */
  PermissionGate.prototype.revoke = function (idOrAction) {
    var grants = this.list();
    var removed = [];
    var kept = grants.filter(function (g) {
      var hit = (g.id === idOrAction) || (g.action === idOrAction);
      if (hit) removed.push(g);
      return !hit;
    });
    this._save(kept);
    removed.forEach(function (g) { try { this._log({ action: g.action, decision: 'revoked', grantId: g.id }); } catch (e) {} }, this);
    return removed.length;
  };

  /** 撤销全部授权 */
  PermissionGate.prototype.clear = function () {
    this._save([]);
    this._log({ action: '*', decision: 'cleared' });
    return true;
  };

  PermissionGate.prototype._log = function (entry) {
    try {
      this.storage.appendAudit(Object.assign({ at: Date.now() }, entry || {}));
    } catch (e) {}
  };

  /** 审计日志（倒序） */
  PermissionGate.prototype.audit = function () {
    try { return (this.storage.listAudit() || []).slice().reverse(); } catch (e) { return []; }
  };

  /* ---------- 导出 ---------- */
  var api = {
    PermissionGate: PermissionGate,
    ACTION_DANGER: ACTION_DANGER,
    dangerOf: dangerOf,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.PermissionCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
