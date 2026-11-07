/**
 * ============================================================
 *  supervisor-core.js — 监督者 Agent（零依赖）
 *  ============================================================
 *
 *  借鉴「Steering Agent」（NUS / USTC / Alibaba Qwen，arXiv:2610.22316）
 *  的双路径思路，解决 LLM 长程任务里的「目标漂移」(goal drift)：
 *
 *    快路径 fast path（便宜）：每轮只做轻量判断「是否偏离核心需求」——
 *      空输出 / 报错 / 目标关键词命中率低 → 给 alert / warn 信号。
 *    慢路径 slow path（昂贵）：确认为偏离后，才生成一句明确的「纠偏指令」，
 *      挂回下一次委派，把跑偏的 Agent 拉回正轨。旁路监督，不改动执行 Agent。
 *
 *  另含「先对话确认」：用户给一句模糊需求 → 监督者抛 3 个澄清问题 →
 *  根据回答拼出结构化「核心需求确认」→ 用户确认后写进 GoalStore。
 *
 *  核心对象：
 *    GoalStore   核心需求（可随时增删改、加权、停用）
 *    Supervisor  澄清对话 + 快慢路径监督 + 纠偏
 *
 *  零依赖。浏览器 <script src>；Node require() 后取 globalThis.SupervisorCore。
 * ============================================================
 */
(function (global) {
  'use strict';

  /* ---------- 1. GoalStore：核心需求（增删改） ---------- */
  function defaultGoalStorage() {
    var KEY = 'ingrid.supervisor';
    return {
      load: function () {
        try { var r = global.localStorage.getItem(KEY); return r ? JSON.parse(r) : { goals: [], active: false, lastCorrection: '' }; }
        catch (e) { return { goals: [], active: false, lastCorrection: '' }; }
      },
      save: function (state) {
        try { global.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
      },
    };
  }
  function normalizeGoal(g) {
    return {
      id: String(g.id || ''),
      text: String(g.text || ''),
      weight: Math.max(1, Math.min(3, Number(g.weight) || 1)),
      active: g.active !== false,
      createdAt: g.createdAt || Date.now(),
    };
  }
  function GoalStore(storage) {
    this.storage = storage || defaultGoalStorage();
    var raw = this.storage.load() || {};
    this.goals = (Array.isArray(raw.goals) ? raw.goals : []).map(normalizeGoal);
    this.active = raw.active !== false;
    this.lastCorrection = String(raw.lastCorrection || '');
    this._save();
  }
  GoalStore.prototype._save = function () {
    var self = this;
    try {
      this.storage.save({
        goals: this.goals, active: this.active, lastCorrection: this.lastCorrection,
      });
    } catch (e) {}
    return this;
  };
  GoalStore.prototype._id = function () {
    return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  };
  GoalStore.prototype.list = function () { return this.goals.slice(); };
  GoalStore.prototype.add = function (text, weight) {
    var g = normalizeGoal({ id: this._id(), text: text, weight: weight || 1, active: true });
    this.goals.push(g); this._save(); return g;
  };
  GoalStore.prototype.update = function (id, patch) {
    var g = null;
    for (var i = 0; i < this.goals.length; i++) if (this.goals[i].id === id) { g = this.goals[i]; break; }
    if (!g) return null;
    Object.assign(g, patch || {}); this._save(); return g;
  };
  GoalStore.prototype.remove = function (id) {
    this.goals = this.goals.filter(function (g) { return g.id !== id; });
    this._save(); return this;
  };
  GoalStore.prototype.toggle = function (id) {
    var g = this.update(id, {}); if (!g) return null;
    g.active = !g.active; this._save(); return g;
  };
  GoalStore.prototype.setActive = function (on) { this.active = !!on; this._save(); return this; };
  GoalStore.prototype.setCorrection = function (text) { this.lastCorrection = String(text || ''); this._save(); return this; };

  /* ---------- 2. 快路径：漂移检测（便宜、同步、无需模型） ---------- */
  // 中文用「二元组」重叠判断（与 skills-core 的 recommend 同一思路），
  // 避免按词切分后「证据充分」匹配不上「证据」这类措辞差异。
  function bigrams(s) {
    var t = String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
    var out = {};
    for (var i = 0; i < t.length - 1; i++) out[t.slice(i, i + 2)] = 1;
    return out;
  }
  /**
   * text  工作 Agent 本轮产出（或计划）
   * goals 核心需求列表
   * 返回 { level: 'none'|'warn'|'alert', score, reasons, note }
   * 快路径刻意「保守」：只有明显偏离才报警（空输出/报错/半数以上需求零命中），
   * 避免中文措辞差异导致的误报；精细判断留给慢路径模型。
   */
  function fastDriftCheck(text, goals) {
    var t = String(text || '').trim();
    var active = (goals || []).filter(function (g) { return g.active !== false; });
    if (!active.length) return { level: 'none', score: 1, reasons: [], note: '尚未设定核心需求' };
    if (!t) return { level: 'alert', score: 1, reasons: ['目标 Agent 没有产出任何内容'], note: '' };
    if (/\[演练\]/.test(t)) return { level: 'none', score: 0, reasons: [], note: '演练输出，无法判断偏离（真实模式可判断）' };
    if (/失败|错误|blocked|skipped|未获批准|已用尽|请求失败|启动失败/.test(t)) {
      return { level: 'alert', score: 1, reasons: ['执行失败或未完成'], note: '' };
    }
    var matched = 0, missed = [];
    active.forEach(function (g) {
      var gb = bigrams(g.text);
      var keys = Object.keys(gb);
      var hit = keys.some(function (k) { return t.indexOf(k) >= 0; });
      if (hit) matched++;
      else missed.push(g.text.slice(0, 26));
    });
    var ratio = matched / active.length;
    if (ratio >= 0.5) return { level: 'none', score: ratio, reasons: [], note: '基本贴合核心需求' };
    if (matched > 0) return { level: 'warn', score: ratio, reasons: missed, note: '部分核心需求未体现' };
    return { level: 'warn', score: 0, reasons: missed.slice(0, 3), note: '产出与核心需求几乎无关，疑似偏离' };
  }

  /* ---------- 3. 提醒 / 纠偏文本 ---------- */
  function buildReminder(goals, correction) {
    var active = (goals || []).filter(function (g) { return g.active !== false; });
    var parts = [];
    if (active.length) {
      parts.push('【监督者 · 核心需求】本次工作必须始终对齐以下需求，不要偏离：\n' +
        active.map(function (g, i) { return (i + 1) + '. ' + g.text; }).join('\n'));
    }
    if (correction) parts.push('【监督者 · 纠偏提醒】上一轮发现偏离，务必先纠正：\n' + correction);
    return parts.join('\n\n');
  }

  /* ---------- 4. 澄清对话（先确认意图） ---------- */
  var CLARIFY_QUESTIONS = [
    { key: 'outcome', q: '你最终想要得到什么？越具体越好（一个能交付的东西、一篇文章、一个决定……）' },
    { key: 'bounds', q: '这件事「绝对不能怎么做 / 不要包含什么」？（边界与红线）' },
    { key: 'done', q: '怎么算「做对了」？你判断它成功与否的标准是什么？' },
  ];
  function clarifyQuestions() { return CLARIFY_QUESTIONS.map(function (c) { return c.q; }); }

  /**
   * 根据「原始需求 + 用户对澄清问题的回答」拼出结构化确认稿。
   * 返回 { summary: string, goals: [text...] }
   */
  function composeGoalSummary(instruction, answers) {
    var a = answers || [];
    var labels = ['最终要达成的结果', '边界（不能做的事）', '成功标准'];
    var lines = [];
    lines.push('我想做的事：' + String(instruction || '').trim());
    CLARIFY_QUESTIONS.forEach(function (c, i) {
      var v = String(a[i] || '').trim();
      if (v) lines.push(labels[i] + '：' + v);
    });
    var summary = lines.join('\n');
    var goals = [];
    if (String(instruction || '').trim()) goals.push({ text: '核心目标：' + String(instruction).trim(), weight: 3 });
    CLARIFY_QUESTIONS.forEach(function (c, i) {
      var v = String(a[i] || '').trim();
      if (v) goals.push({ text: labels[i] + '：' + v, weight: i === 1 ? 2 : 1 });
    });
    return { summary: summary, goals: goals };
  }

  /* ---------- 5. Supervisor ----------
   * opts:
   *   goals     GoalStore
   *   executor  async (agent, task, ctx) => { text, ... }  （慢路径纠偏用；不传则用模板）
   *   realMode  boolean（true 才调用模型做纠偏）
   *   judgeAgent { name, soul, engine, fallbacks }（监督者自己的人设）
   *   onLog     (entry) => void
   */
  function Supervisor(opts) {
    var o = opts || {};
    this.goals = o.goals || new GoalStore();
    this.executor = o.executor || null;
    this.realMode = !!o.realMode;
    this.judgeAgent = o.judgeAgent || { name: '监督者', soul: '', engine: 'deepseek', fallbacks: ['gpt'] };
    this.log = [];
    this.onLog = o.onLog || function () {};
    this._listeners = {};
    this.goals.setActive(this.goals.active);   // 确保落盘
  }
  Supervisor.prototype.on = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
    return this;
  };
  Supervisor.prototype.emit = function (type, payload) {
    var p = Object.assign({ type: type, at: Date.now() }, payload || {});
    (this._listeners[type] || []).forEach(function (f) { try { f(p); } catch (e) {} });
    return p;
  };
  Supervisor.prototype.addLog = function (level, text) {
    var e = { at: Date.now(), level: level, text: text };
    this.log.unshift(e);
    if (this.log.length > 50) this.log.pop();
    try { this.onLog(e); } catch (err) {}
    this.emit('log', e);
    return e;
  };
  Supervisor.prototype.isActive = function () { return this.goals.active; };
  Supervisor.prototype.setActive = function (on) { this.goals.setActive(on); return this; };
  Supervisor.prototype.reminder = function () {
    return this.isActive() ? buildReminder(this.goals.list(), this.goals.lastCorrection) : '';
  };

  /**
   * 监督某一轮的产出。快路径判断；命中 alert/warn 时走慢路径生成纠偏指令。
   * 返回 DriftSignal。
   */
  Supervisor.prototype.supervise = function (result, task) {
    var self = this;
    var text = (result && result.text) || '';
    var name = (result && result.agentName) || '工作 Agent';
    var sig = fastDriftCheck(text, this.goals.list());

    if (!this.isActive()) {
      this.addLog('info', '监督已暂停，跳过「' + name + '」');
      return sig;
    }
    if (sig.level === 'alert' || sig.level === 'warn') {
      var why = sig.reasons.length ? sig.reasons.join('；') : sig.note;
      this.addLog(sig.level, (sig.level === 'alert' ? '🚨 偏离' : '⚠ 注意') + '：' + name + ' —— ' + why);
      this._correct(name, task, text, sig);
    } else {
      this.addLog('ok', '✓ ' + name + ' ' + (sig.note || '贴合核心需求'));
    }
    return sig;
  };

  Supervisor.prototype._correct = function (name, task, text, sig) {
    var self = this;
    var template = '请回到核心需求，纠正以下偏离：' + (sig.reasons.join('；') || '上一轮输出偏离了目标') +
      '。重做这一部分，并逐条对齐监督者列出的每一条核心需求。';
    if (!this.executor || !this.realMode) {
      this.goals.setCorrection(template);
      this.addLog('correct', '↩ 纠偏（模板）：' + template);
      this.emit('corrected', { text: template, from: 'template' });
      return;
    }
    // 慢路径：让监督者用模型写一条更精准的纠偏指令
    var activeGoals = this.goals.list().filter(function (g) { return g.active !== false; });
    var prompt = '你是监督者。以下是用户的核心需求：\n' +
      activeGoals.map(function (g, i) { return (i + 1) + '. ' + g.text; }).join('\n') +
      '\n\n工作 Agent「' + name + '」在任务「' + String(task || '').slice(0, 500) + '」中产出了：\n' +
      String(text || '').slice(0, 3000) +
      '\n\n请判断它是否偏离核心需求。若偏离，用一句话给出明确的纠偏指令（告诉它现在该做什么、回到哪个需求上）；若没偏离，只回复 OK。';
    var agent = Object.assign({}, this.judgeAgent);
    var ctx = { engine: agent.engine, soul: agent.soul || '你是监督者：只判断是否偏离核心需求，并给一句可执行的纠偏指令。', dryRun: false };
    this.executor(agent, prompt, ctx).then(function (res) {
      var reply = String((res && res.text) || '').trim();
      if (reply && !/^ok\b/i.test(reply)) {
        self.goals.setCorrection(reply);
        self.addLog('correct', '↩ 纠偏（模型）：' + reply);
        self.emit('corrected', { text: reply, from: 'model' });
      } else {
        self.addLog('ok', '✓ 监督者复核：' + name + ' 未偏离（模型判定）');
      }
    }).catch(function (e) {
      self.goals.setCorrection(template);
      self.addLog('correct', '↩ 纠偏（模板，模型调用失败）：' + template);
    });
  };

  /* ---------- 导出 ---------- */
  global.SupervisorCore = {
    GoalStore: GoalStore,
    Supervisor: Supervisor,
    fastDriftCheck: fastDriftCheck,
    buildReminder: buildReminder,
    clarifyQuestions: clarifyQuestions,
    composeGoalSummary: composeGoalSummary,
    CLARIFY_QUESTIONS: CLARIFY_QUESTIONS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
