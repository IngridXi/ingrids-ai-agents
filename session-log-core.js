/**
 * ============================================================
 *  session-log-core.js —— 会话回放：append-only 事件日志（零依赖）
 *  ============================================================
 *
 *  借鉴 DSH 的「可回放会话（Replayable Sessions）」设计：
 *    · 每次会话是一条 append-only 事件流，事件只增不改、按 seq 单调递增；
 *    · 同一事件流可 续跑（resume）/ 分叉（fork）/ 回放（replay）/ 搜索。
 *
 *  事件类型（type）约定：
 *    session_created  会话创建（data.title / data.agent / data.engine）
 *    user             用户消息 / 任务（data.text / data.agent / data.skills）
 *    system           注入上下文（soul / skill 说明书 / 监事纠偏，data.text）
 *    agent_started    一轮执行开始（data.task / data.engine / data.dryRun）
 *    tool_call        工具调用（data.name / data.args / data.result）
 *    agent_output     模型 / Agent 输出（data.text / data.engine）
 *    correction       监事纠偏指令（data.text）
 *    turn_end         一轮结束（data.status / data.error / data.cost）
 *    session_end      会话结束（data.reason）
 *
 *  storage 可插拔（与 UsageLedger 同思路）：
 *    { append(sessionId, ev), list(sessionId), listSessions(),
 *      fork(fromId, toId) }
 *  浏览器默认 localStorage；Electron 桌面版注入「按会话 jsonl 文件」后端。
 *
 *  零依赖。浏览器 <script src>；Node require() 后取 globalThis.SessionLogCore。
 * ============================================================
 */
(function (global) {
  'use strict';

  function uid(prefix) {
    return (prefix || 's') + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------- 默认 storage（浏览器 localStorage；无则退化内存） ---------- */
  function defaultStorage() {
    var KEY = 'ingrid.sessions';
    var store = {};
    try {
      var raw = global.localStorage.getItem(KEY);
      if (raw) store = JSON.parse(raw);
    } catch (e) { store = {}; }
    if (typeof store !== 'object' || store === null) store = {};
    function save() {
      try { global.localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {}
    }
    return {
      append: function (sessionId, ev) {
        (store[sessionId] = store[sessionId] || []).push(ev);
        save();
      },
      list: function (sessionId) { return store[sessionId] || []; },
      listSessions: function () {
        return Object.keys(store).map(function (id) {
          var evs = store[id] || [];
          var first = evs[0] || {}, last = evs[evs.length - 1] || {};
          var title = (first.data && first.data.title) || (first.data && first.data.text) ||
            (last.data && last.data.title) || id;
          return { id: id, count: evs.length, firstAt: first.at || 0, lastAt: last.at || 0, title: String(title).slice(0, 80) };
        }).sort(function (a, b) { return (b.lastAt || 0) - (a.lastAt || 0); });
      },
      fork: function (fromId, toId) {
        store[toId] = (store[fromId] || []).slice();
        save();
      },
    };
  }

  /* ---------- SessionLog ---------- */
  function SessionLog(storage) {
    this.storage = storage || defaultStorage();
    this._seq = {};   // sessionId -> 下一个 seq
  }

  // 从已有事件流推算下一个 seq（避免 storage 重载后重复）
  SessionLog.prototype._nextSeq = function (sessionId) {
    var evs = this.storage.list(sessionId) || [];
    var n = this._seq[sessionId] || 0;
    if (evs.length) {
      var last = evs[evs.length - 1];
      n = Math.max(n, (last.seq || 0) + 1);
    }
    this._seq[sessionId] = n + 1;
    return n;
  };

  /** 追加一条事件（append-only，永不修改既有事件）。返回该事件。 */
  SessionLog.prototype.record = function (sessionId, type, data) {
    var ev = {
      seq: this._nextSeq(sessionId),
      sessionId: String(sessionId || ''),
      type: type || 'event',
      at: Date.now(),
      data: data || {},
    };
    this.storage.append(sessionId, ev);
    return ev;
  };

  /** 回放：按 seq 升序返回整个会话的事件流 */
  SessionLog.prototype.replay = function (sessionId) {
    return (this.storage.list(sessionId) || []).slice()
      .sort(function (a, b) { return a.seq - b.seq; });
  };

  SessionLog.prototype.listSessions = function () { return this.storage.listSessions(); };

  /** 分叉：复制源会话的事件流到新会话，返回新 sessionId */
  SessionLog.prototype.fork = function (fromId) {
    var newId = uid('s');
    this.storage.fork(fromId, newId);
    this._seq[newId] = (this.storage.list(newId) || []).length;
    return newId;
  };

  /**
   * 续跑上下文：把事件流折叠成可再次注入的对话。
   * opts: { maxEvents } 默认取最近 50 条事件。
   * 返回 { sessionId, system, messages, eventCount }
   */
  SessionLog.prototype.resumeContext = function (sessionId, opts) {
    var o = opts || {};
    var maxEvents = Number(o.maxEvents) || 50;
    var evs = this.replay(sessionId).slice(-maxEvents);
    var systemParts = [], messages = [];
    evs.forEach(function (ev) {
      var d = ev.data || {};
      if (ev.type === 'system') systemParts.push(d.text || '');
      else if (ev.type === 'user') messages.push({ role: 'user', content: d.text || d.task || '' });
      else if (ev.type === 'agent_started') messages.push({ role: 'user', content: d.task || d.text || '' });
      else if (ev.type === 'agent_output' && d.text) messages.push({ role: 'assistant', content: d.text });
      else if (ev.type === 'correction' && d.text) messages.push({ role: 'user', content: '【纠偏】' + d.text });
    });
    return { sessionId: sessionId, system: systemParts.join('\n'), messages: messages, eventCount: evs.length };
  };

  /* ---------- 导出 ---------- */
  var api = {
    SessionLog: SessionLog,
    uid: uid,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.SessionLogCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
