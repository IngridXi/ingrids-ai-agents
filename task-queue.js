/**
 * ============================================================
 *  task-queue.js — 后台任务队列（零依赖 Node 模块）
 *  ============================================================
 *
 *  吸收 dsh-superagent 的 Ticket / Assignment 思想，落地到本工作台：
 *
 *    · Ticket = 一件「持续存在的任务」：授权范围(goal) + 执行状态 + 结果
 *    · Session = 跑这个 Ticket 时临时占用的计算资源，可换、可中断
 *    · 状态机：queued → running → (waiting 需人工) → done / failed / cancelled
 *    · 持久化：每次变更落盘到 dataDir/task-queue.json，重启后自动恢复
 *      —— 进程重启时，running 会回退到 queued（重新排队跑），
 *         done/failed/cancelled 保留，waiting 保留（等用户决策）
 *
 *  零依赖。Node require() 后取 globalThis.TaskQueue；浏览器 <script> 也可用。
 *
 *  关键设计取舍（对 dsh 的取舍）：
 *    · dsh 用 SQLite + 事务 + Outbox；本工作台是 local-first 单机，用 JSON 足够，
 *      保持零依赖、易读、易迁移。
 *    · dsh 的 Mandate 是「不可变授权令」；本工作台简化成 goal + agent 字段，
 *      越权边界由聊天循环的 supervisor（监事）负责，不在此模块重复实现。
 * ============================================================
 */
(function (global) {
  'use strict';

  var STATUSES = ['queued', 'running', 'waiting', 'done', 'failed', 'cancelled'];

  function uid() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  /**
   * TaskQueue
   * @param {string} dataDir  持久化目录（存 task-queue.json）
   * @param {object} [opts]   { maxConcurrent: 2 }
   */
  function TaskQueue(dataDir, opts) {
    opts = opts || {};
    this.dataDir = dataDir || '';
    this.maxConcurrent = opts.maxConcurrent || 2;
    this.tickets = {};      // id -> ticket
    this.order = [];        // 插入顺序（面板按此展示）
    if (this.dataDir) this._load();
  }

  TaskQueue.prototype._file = function () {
    return (this.dataDir ? this.dataDir.replace(/\/$/, '') + '/' : '') + 'task-queue.json';
  };

  TaskQueue.prototype._save = function () {
    if (!this.dataDir) return;
    try {
      var fs = require('fs');
      var path = require('path');
      if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
      var payload = { tickets: this.tickets, order: this.order, savedAt: nowIso() };
      var tmp = this._file() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmp, this._file());
    } catch (e) {
      // 持久化失败不阻断任务本身（单机场景极少见），仅吞掉；调用方可查 _lastSaveError
      this._lastSaveError = String((e && e.message) || e);
    }
  };

  TaskQueue.prototype._load = function () {
    try {
      var fs = require('fs');
      var raw = fs.readFileSync(this._file(), 'utf8');
      var data = JSON.parse(raw);
      this.tickets = data.tickets || {};
      this.order = data.order || Object.keys(this.tickets);
      // 恢复语义：进程重启后，running 的没有内存态了，回退到 queued 重新排队；
      // waiting 保留（等用户决策）；done/failed/cancelled 保留。
      var self = this;
      Object.keys(this.tickets).forEach(function (id) {
        var t = self.tickets[id];
        if (t && t.status === 'running') {
          t.status = 'queued';
          t.restored = true;          // 标记「从崩溃恢复」，供 worker 决定是否先自检
          t.updatedAt = nowIso();
        }
      });
    } catch (e) {
      this.tickets = {};
      this.order = [];
    }
  };

  TaskQueue.prototype._touch = function (id) {
    if (this.tickets[id]) this.tickets[id].updatedAt = nowIso();
    this._save();
  };

  /**
   * 创建一个任务单并入队。
   * @param {object} t   { title, goal, agent, engine, model, messages }
   */
  TaskQueue.prototype.enqueue = function (t) {
    var id = uid();
    var now = nowIso();
    this.tickets[id] = {
      id: id,
      title: t.title || '未命名任务',
      goal: t.goal || '',
      agent: t.agent || '',
      engine: t.engine || '',
      model: t.model || '',
      messages: t.messages || [],   // 对话历史（断点续跑的关键）
      status: 'queued',
      round: t.round || 0,
      needsUser: false,             // 需要人工决策时的结构化提问
      question: '',
      result: '',
      error: '',
      createdAt: now,
      updatedAt: now,
    };
    this.order.push(id);
    this._save();
    return this.tickets[id];
  };

  TaskQueue.prototype.get = function (id) {
    return this.tickets[id] || null;
  };

  TaskQueue.prototype.list = function (filter) {
    var self = this;
    var out = this.order.map(function (id) { return self.tickets[id]; })
      .filter(function (t) { return !!t; });
    if (filter) {
      if (typeof filter === 'string') out = out.filter(function (t) { return t.status === filter; });
      else if (Array.isArray(filter)) out = out.filter(function (t) { return filter.indexOf(t.status) >= 0; });
    }
    return out;
  };

  TaskQueue.prototype.setStatus = function (id, status, extra) {
    var t = this.tickets[id];
    if (!t) return null;
    if (STATUSES.indexOf(status) < 0) throw new Error('未知状态：' + status);
    t.status = status;
    if (extra) {
      if (extra.result != null) t.result = extra.result;
      if (extra.error != null) t.error = extra.error;
      if (extra.question != null) t.question = extra.question;
      if (extra.needsUser != null) t.needsUser = extra.needsUser;
      if (extra.round != null) t.round = extra.round;
      if (extra.messages != null) t.messages = extra.messages;
    }
    this._touch(id);
    return t;
  };

  // 语义化便捷方法
  TaskQueue.prototype.start = function (id) { return this.setStatus(id, 'running'); };
  TaskQueue.prototype.awaitUser = function (id, question) {
    return this.setStatus(id, 'waiting', { needsUser: true, question: question || '' });
  };
  TaskQueue.prototype.complete = function (id, result) {
    return this.setStatus(id, 'done', { result: result || '', needsUser: false, question: '' });
  };
  TaskQueue.prototype.fail = function (id, error) {
    return this.setStatus(id, 'failed', { error: error || '', needsUser: false });
  };
  TaskQueue.prototype.cancel = function (id) { return this.setStatus(id, 'cancelled'); };
  TaskQueue.prototype.remove = function (id) {
    delete this.tickets[id];
    var i = this.order.indexOf(id);
    if (i >= 0) this.order.splice(i, 1);
    this._save();
  };

  /** 占用一个并发 slot：返回 true 表示可以开跑，false 表示已达上限 */
  TaskQueue.prototype.acquireSlot = function () {
    var running = this.list('running').length;
    return running < this.maxConcurrent;
  };

  /** 取出下一个待跑任务（queued 且有空闲 slot） */
  TaskQueue.prototype.nextQueued = function () {
    if (!this.acquireSlot()) return null;
    var q = this.list('queued');
    return q.length ? q[0] : null;
  };

  TaskQueue.prototype.counts = function () {
    var c = { queued: 0, running: 0, waiting: 0, done: 0, failed: 0, cancelled: 0 };
    var self = this;
    this.order.forEach(function (id) {
      var t = self.tickets[id];
      if (t && c[t.status] != null) c[t.status]++;
    });
    return c;
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TaskQueue;
  }
  global.TaskQueue = TaskQueue;
})(typeof globalThis !== 'undefined' ? globalThis : this);
