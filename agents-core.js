/**
 * ============================================================
 *  agents-core.js  —— 从 OpenMausBot 提炼的可复用「多 Agent」核心
 *  ============================================================
 *
 *  设计来源：github.com/milind-soni/OpenMausBot（Apache 2.0）
 *  核心思想（OpenMausBot 的「每个 bot 是一个真实 agent」）：
 *    1. 每个 Agent 是独立的「数字员工」，有自己的：
 *         name / soul / memory / skills / routines / engine /
 *         approvalMode（权限） / computer / tools / visibility
 *    2. bring-your-own-agent：复用本机已登录 CLI，或接 LLM API。
 *    3. local-first：配置、记忆、密钥、用量账本全存本机，不上云。
 *
 *  v2 新增（学 OpenMausBot 的两个真实行为）：
 *    A. 限额自动切换：某个引擎撞到用量上限 → 自动换降级链里下一个可用引擎
 *    B. 成本记账：每次 turn 记 { bot / engine / token / cost / costSource }，
 *       按月汇总、可设预算上限、可导出 CSV
 *    C. AgentOrchestrator：一个 Agent 指挥其他 Agent 干活
 *       （委派 / 并行 / 流水线 / 审批钩子 / 权限校验 / 事件总线）
 *
 *  零依赖。浏览器：<script src="agents-core.js">；Node：require() 后取 globalThis.AgentsCore
 * ============================================================
 */
(function (global) {
  'use strict';

  /* ---------- 1. 引擎 / 模型注册表（bring-your-own-agent） ---------- */
  // kind: 'cli' 复用本机已登录 CLI ｜ 'api' 走云端 API ｜ 'local' 本地推理
  // price: 每百万 token 的美元单价（输入 / 输出）。2026-11 的近似值，可在设置里改。
  var ENGINES = {
    'claude-code': { name: 'Claude Code', kind: 'cli',   tag: '本机 CLI · 编码强',     status: 'ready',   price: { in: 3,    out: 15   } },
    'codex':       { name: 'Codex',       kind: 'cli',   tag: '本机 CLI · 编码强',     status: 'ready',   price: { in: 2,    out: 10   } },
    'grok':        { name: 'Grok',        kind: 'cli',   tag: '本机 CLI · 输出便宜',   status: 'ready',   price: { in: 2,    out: 6    } },
    'deepseek':    { name: 'DeepSeek',    kind: 'api',   tag: '中文强 · 高性价比',     status: 'pending', price: { in: 0.28, out: 0.42 } },
    'gpt':         { name: 'GPT',         kind: 'api',   tag: '综合 · 推理',           status: 'pending', price: { in: 2,    out: 10   } },
    'qwen':        { name: 'Qwen',        kind: 'api',   tag: '中文 · 可本地部署',     status: 'pending', price: { in: 0.4,  out: 1.2  } },
    'local-llm':   { name: '本地大模型',  kind: 'local', tag: '不上云 · 隐私优先',     status: 'ready',   price: { in: 0,    out: 0    } },
    'funasr':      { name: 'FunASR',      kind: 'local', tag: '语音转写（本机）',      status: 'ready',   price: { in: 0,    out: 0    } },
  };

  // 估算一次调用的费用（美元）。引擎没标价格时返回 0。
  function estimateCost(engineId, tokensIn, tokensOut, engines) {
    var e = (engines || ENGINES)[engineId];
    if (!e || !e.price) return 0;
    return ((tokensIn || 0) * e.price.in + (tokensOut || 0) * e.price.out) / 1e6;
  }

  /* ---------- 2. Agent Schema（对应 OpenMausBot 的 newBotDefaults） ---------- */
  var DEFAULT_AGENT = {
    id: '',
    name: '',
    title: '',
    emoji: '🤖',
    soul: '',
    description: '',
    engine: 'local-llm',
    fallbacks: [],
    memory: {},
    skills: [],
    routines: [],
    tools: [],
    approvalMode: 'ask',  // 'ask' 每次确认 | 'full' 全自动 | 'custom'
    computer: 'off',
    visibility: 'private',
    role: 'worker',       // v2：'orchestrator' 才有资格指挥其他 Agent
    canControl: false,    // v2：显式授权也能指挥
  };

  /* ---------- 3. AgentRegistry：增删改查 + local-first 持久化 ---------- */
  function defaultStorage(storageKey) {
    return {
      load: function () {
        try { var raw = global.localStorage.getItem(storageKey); return raw ? JSON.parse(raw) : []; }
        catch (e) { return []; }
      },
      save: function (agents) {
        try { global.localStorage.setItem(storageKey, JSON.stringify(agents)); } catch (e) {}
      },
    };
  }

  function AgentRegistry(storageKey, storage) {
    this.storageKey = storageKey || 'ingrid.agents';
    this.storage = storage || defaultStorage(this.storageKey);
    this.agents = this._load();
  }
  AgentRegistry.prototype._load = function () {
    try { var raw = this.storage.load(); return Array.isArray(raw) ? raw : []; }
    catch (e) { return []; }
  };
  AgentRegistry.prototype._save = function () {
    try { this.storage.save(this.agents); } catch (e) {}
    return this;
  };
  AgentRegistry.prototype._id = function () {
    return 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  };
  AgentRegistry.prototype.list = function (filter) {
    if (!filter) return this.agents.slice();
    return this.agents.filter(function (a) { return a[filter.key] === filter.value; });
  };
  AgentRegistry.prototype.create = function (overrides, useDefaults) {
    var base = useDefaults === false ? { id: this._id() } : Object.assign({}, DEFAULT_AGENT, { id: this._id() });
    var agent = Object.assign(base, overrides || {});
    if (!agent.name) agent.name = '未命名 Agent ' + (this.agents.length + 1);
    this.agents.push(agent); this._save(); return agent;
  };
  AgentRegistry.prototype.get = function (id) {
    for (var i = 0; i < this.agents.length; i++) if (this.agents[i].id === id) return this.agents[i];
    return null;
  };
  AgentRegistry.prototype.update = function (id, patch) {
    var a = this.get(id); if (!a) return null;
    Object.assign(a, patch); this._save(); return a;
  };
  AgentRegistry.prototype.remove = function (id) {
    var before = this.agents.length;
    this.agents = this.agents.filter(function (a) { return a.id !== id; });
    this._save(); return this.agents.length < before;
  };
  AgentRegistry.prototype.export = function () { return JSON.stringify(this.agents, null, 2); };
  AgentRegistry.prototype.import = function (json) {
    var arr = JSON.parse(json); if (!Array.isArray(arr)) throw new Error('格式错误');
    this.agents = arr; this._save(); return this.agents.length;
  };

  /* ---------- 4. ModelRouter：任务路由 + 限额感知自动降级 ---------- */
  var TASK_DEFAULTS = {
    transcribe: 'funasr', summarize: 'deepseek', writing: 'claude-code',
    coding: 'codex', translate: 'qwen', general: 'local-llm',
  };

  var LIMIT_PATTERNS = /rate.?limit|quota|usage limit|limit reached|exceeded|insufficient.?credit|402|429|overloaded|capacity/i;

  function ModelRouter(options) {
    var o = options || {};
    this.engines = o.engines || ENGINES;
    this.limited = {};       // engineId -> { until: timestamp, reason: string }
    this.defaultLimitMs = o.defaultLimitMs || 5 * 60 * 60 * 1000; // 默认 5 小时（对齐订阅的滚动窗口）
  }

  // 从错误信息判断是否「撞到限额」
  ModelRouter.prototype.detectLimit = function (text) {
    return LIMIT_PATTERNS.test(String(text || ''));
  };

  ModelRouter.prototype.markLimited = function (engineId, until, reason) {
    this.limited[engineId] = {
      until: until || (Date.now() + this.defaultLimitMs),
      reason: reason || '用量达到上限',
    };
    return this.limited[engineId];
  };
  ModelRouter.prototype.clearLimit = function (engineId) {
    if (engineId) delete this.limited[engineId];
    else this.limited = {};
    return this;
  };
  ModelRouter.prototype.limits = function () {
    var now = Date.now(), self = this, out = {};
    Object.keys(this.limited).forEach(function (k) {
      if (self.limited[k].until > now) out[k] = self.limited[k];
    });
    this.limited = out; // 顺手清掉过期的
    return out;
  };

  /**
   * 解析某 Agent 实际该用的引擎。
   * 返回 { engine, meta, switched, from, reason, chain }
   * switched=true 表示因为限额/禁用从主引擎切到了降级引擎。
   */
  ModelRouter.prototype.resolve = function (agent, registry) {
    var engs = registry || this.engines;
    var chain = [agent && agent.engine].concat((agent && agent.fallbacks) || []).filter(Boolean);
    if (!chain.length) chain = ['local-llm'];
    var limits = this.limits();
    var skipped = [];
    for (var i = 0; i < chain.length; i++) {
      var id = chain[i], e = engs[id];
      if (!e || e.status === 'disabled') { skipped.push(id + '(未启用)'); continue; }
      if (limits[id]) { skipped.push(id + '(限额至 ' + new Date(limits[id].until).toLocaleTimeString() + ')'); continue; }
      return {
        engine: id, meta: e,
        switched: i > 0, from: chain[0],
        reason: skipped.length ? '跳过 ' + skipped.join('、') : '',
        chain: chain,
      };
    }
    // 全被限额/禁用：返回主引擎并明确标注不可用，由调用方决定等待还是报错
    return {
      engine: chain[0], meta: engs[chain[0]] || null,
      switched: false, from: chain[0],
      reason: '降级链全部不可用：' + skipped.join('、'),
      exhausted: true, chain: chain,
    };
  };

  ModelRouter.prototype.defaultFor = function (taskType) {
    return TASK_DEFAULTS[taskType] || TASK_DEFAULTS.general;
  };

  /* ---------- 5. UsageLedger：每一次调用都记账（local-first） ---------- */
  /**
   * storage 可插拔：{ load():Array, append(rec):void, clear():void,
   *                   getBudget():number, setBudget(n):void }
   * 浏览器默认 localStorage；Electron 桌面版注入「按月 jsonl 文件」后端。
   */
  function defaultLedgerStorage() {
    var KEY = 'ingrid.usage', BKEY = 'ingrid.budget';
    return {
      load: function () {
        try { var r = global.localStorage.getItem(KEY); return r ? JSON.parse(r) : []; }
        catch (e) { return []; }
      },
      append: function (rec) {
        try {
          var arr = this.load(); arr.push(rec);
          global.localStorage.setItem(KEY, JSON.stringify(arr.slice(-5000)));
        } catch (e) {}
      },
      clear: function () { try { global.localStorage.removeItem(KEY); } catch (e) {} },
      getBudget: function () { try { return Number(global.localStorage.getItem(BKEY)) || 0; } catch (e) { return 0; } },
      setBudget: function (n) { try { global.localStorage.setItem(BKEY, String(n)); } catch (e) {} },
    };
  }

  function UsageLedger(storage) {
    this.storage = storage || defaultLedgerStorage();
    this.records = this._load();
  }
  UsageLedger.prototype._load = function () {
    try { var r = this.storage.load(); return Array.isArray(r) ? r : []; }
    catch (e) { return []; }
  };

  /**
   * 记一次调用。
   * entry: { agentId, agentName, engine, model, taskType, source,
   *          tokensIn, tokensOut, cost, costSource, status, error, dryRun, at }
   * cost 不传则按 ENGINES 单价自动估算；costSource 标 'metered' / 'estimated' / 'simulated'
   */
  UsageLedger.prototype.record = function (entry) {
    var e = Object.assign({
      at: Date.now(), agentId: '', agentName: '', engine: '', model: '',
      taskType: 'general', source: 'manual', tokensIn: 0, tokensOut: 0,
      status: 'ok', error: '', dryRun: false, costSource: 'estimated',
      skills: [], skillTokens: 0,
    }, entry || {});
    if (typeof e.cost !== 'number') {
      e.cost = estimateCost(e.engine, e.tokensIn, e.tokensOut);
      e.costSource = e.dryRun ? 'simulated' : 'estimated';
    }
    e.month = new Date(e.at).toISOString().slice(0, 7);
    e.day = new Date(e.at).toISOString().slice(0, 10);
    this.records.push(e);
    try { this.storage.append(e); } catch (err) {}
    return e;
  };

  UsageLedger.prototype.list = function (filter) {
    var f = filter || {};
    return this.records.filter(function (r) {
      if (f.month && r.month !== f.month) return false;
      if (f.agentId && r.agentId !== f.agentId) return false;
      if (f.engine && r.engine !== f.engine) return false;
      if (f.realOnly && r.dryRun) return false;
      return true;
    });
  };

  /** 汇总：{ spent, simulated, count, tokensIn, tokensOut, byAgent, byEngine, byDay } */
  UsageLedger.prototype.summary = function (filter) {
    var rows = this.list(filter), out = {
      spent: 0, simulated: 0, count: rows.length, tokensIn: 0, tokensOut: 0,
      byAgent: {}, byEngine: {}, byDay: {},
    };
    rows.forEach(function (r) {
      var bucket = r.dryRun ? 'simulated' : 'spent';
      out[bucket] += r.cost || 0;
      out.tokensIn += r.tokensIn || 0;
      out.tokensOut += r.tokensOut || 0;
      var k;
      k = r.agentName || '未命名'; out.byAgent[k] = (out.byAgent[k] || 0) + (r.cost || 0);
      k = r.engine || '未指定';   out.byEngine[k] = (out.byEngine[k] || 0) + (r.cost || 0);
      k = r.day || '未知';        out.byDay[k] = (out.byDay[k] || 0) + (r.cost || 0);
    });
    return out;
  };

  UsageLedger.prototype.currentMonth = function () { return new Date().toISOString().slice(0, 7); };
  UsageLedger.prototype.getBudget = function () {
    try { return Number(this.storage.getBudget()) || 0; } catch (e) { return 0; }
  };
  UsageLedger.prototype.setBudget = function (usd) {
    try { this.storage.setBudget(Number(usd) || 0); } catch (e) {}
    return this.getBudget();
  };
  /** 预算状态：{ budget, spent, remaining, exceeded, ratio }；budget<=0 表示不限 */
  UsageLedger.prototype.budgetStatus = function () {
    var budget = this.getBudget();
    var spent = this.summary({ month: this.currentMonth(), realOnly: true }).spent;
    return {
      budget: budget, spent: spent,
      remaining: budget > 0 ? Math.max(0, budget - spent) : Infinity,
      exceeded: budget > 0 && spent >= budget,
      ratio: budget > 0 ? spent / budget : 0,
    };
  };
  UsageLedger.prototype.exportCsv = function () {
    var head = 'at,month,agentName,engine,taskType,source,tokensIn,tokensOut,skillTokens,skills,cost,costSource,status,dryRun,error';
    var esc = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    var lines = this.records.map(function (r) {
      return [new Date(r.at).toISOString(), r.month, r.agentName, r.engine, r.taskType, r.source,
        r.tokensIn, r.tokensOut, r.skillTokens || 0, (r.skills || []).join('|'),
        (r.cost || 0).toFixed(6), r.costSource, r.status, r.dryRun, r.error]
        .map(esc).join(',');
    });
    return head + '\n' + lines.join('\n');
  };
  UsageLedger.prototype.clear = function () {
    this.records = [];
    try { this.storage.clear(); } catch (e) {}
  };

  /* ---------- 6. AgentOrchestrator：一个 Agent 指挥其他 Agent ---------- */
  /**
   * opts:
   *   registry    AgentRegistry（必需）
   *   router      ModelRouter
   *   ledger      UsageLedger
   *   executor    async (agent, task, ctx) => { text, tokensIn, tokensOut, cost, costSource, status, error, limited, dryRun }
   *               不传则用「演练执行器」——流程全真跑，但不调用真实模型、不花钱
   *   onEvent     (type, payload) => void
   *   onApproval  async ({ commander, target, task, engine }) => boolean
   *   canControl  (commander) => boolean
   */
  function defaultExecutor(agent, task, ctx) {
    return Promise.resolve({
      text: '[演练] ' + agent.name + ' 已接下任务并给出占位结果。\n任务：' + task +
        '\n（未调用真实模型：' + (ctx && ctx.reason || '尚未配置可用的 CLI / API Key') + '）',
      tokensIn: Math.ceil((String(task).length + String((ctx && ctx.soul) || agent.soul || '').length) / 4),
      tokensOut: 120,
      status: 'ok', dryRun: true, error: '',
    });
  }

  function defaultCanControl(commander) {
    if (!commander) return false;
    return commander.role === 'orchestrator' ||
      commander.canControl === true ||
      /路由|调度|orchestrat|\bra\b/i.test(commander.name || '');
  }

  function AgentOrchestrator(opts) {
    var o = opts || {};
    if (!o.registry) throw new Error('AgentOrchestrator 需要 registry');
    this.registry = o.registry;
    this.router = o.router || new ModelRouter();
    this.ledger = o.ledger || new UsageLedger();
    this.executor = o.executor || defaultExecutor;
    this.onEvent = o.onEvent || function () {};
    this.onApproval = o.onApproval || function () { return Promise.resolve(true); };
    this.canControl = o.canControl || defaultCanControl;
    this._listeners = {};
  }

  AgentOrchestrator.prototype.on = function (type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
    return this;
  };
  AgentOrchestrator.prototype.emit = function (type, payload) {
    var p = Object.assign({ type: type, at: Date.now() }, payload || {});
    (this._listeners[type] || []).forEach(function (f) { try { f(p); } catch (e) {} });
    (this._listeners['*'] || []).forEach(function (f) { try { f(p); } catch (e) {} });
    try { this.onEvent(type, p); } catch (e) {}
    return p;
  };

  /** 单个 Agent 执行一轮（含审批、限额切换、记账） */
  AgentOrchestrator.prototype._runOne = function (target, task, opts, commander) {
    var self = this;
    var budget = this.ledger.budgetStatus();
    if (budget.exceeded && !opts.dryRun) {
      return Promise.resolve({ agentId: target.id, agentName: target.name, status: 'blocked',
        error: '本月预算 $' + budget.budget.toFixed(2) + ' 已用尽', cost: 0 });
    }

    return Promise.resolve()
      .then(function () {
        if (target.approvalMode === 'ask' && opts.autoApprove !== true) {
          self.emit('approval', { commander: commander.name, target: target.name, task: task });
          return self.onApproval({ commander: commander, target: target, task: task });
        }
        return true;
      })
      .then(function (approved) {
        if (!approved) {
          self.emit('skipped', { target: target.name, reason: '未获批准' });
          return { agentId: target.id, agentName: target.name, status: 'skipped',
            error: '未获批准', cost: 0, engine: '' };
        }

        var pick = self.router.resolve(target);
        self.emit('started', { target: target.name, engine: pick.engine, switched: pick.switched, reason: pick.reason });
        if (pick.exhausted) {
          self.emit('failed', { target: target.name, reason: pick.reason });
          return { agentId: target.id, agentName: target.name, status: 'blocked',
            error: pick.reason, engine: pick.engine, cost: 0 };
        }

        // v3：技能说明书只挂在「这一次任务」的 soul 上，用完即卸，不写回 Agent
        var skillContext = String(opts.skillContext || '');
        var ctx = { engine: pick.engine, meta: pick.meta, reason: pick.reason,
          switched: pick.switched, from: pick.from, commander: commander.name,
          dryRun: !!opts.dryRun, skills: opts.skillIds || [], skillTokens: opts.skillTokens || 0,
          soul: (target.soul || '') + (skillContext ? '\n\n' + skillContext : '') };

        function call(engineId, attempt) {
          return Promise.resolve(self.executor(target, task, Object.assign({}, ctx, { engine: engineId })))
            .then(function (res) {
              res = res || {};
              // 撞到限额 → 标记该引擎，自动切到降级链下一个
              var hitLimit = res.limited || (res.error && self.router.detectLimit(res.error));
              if (hitLimit && attempt === 0) {
                self.router.markLimited(engineId, null, res.error || '用量达到上限');
                var next = self.router.resolve(target);
                if (!next.exhausted && next.engine !== engineId) {
                  self.emit('switched', { target: target.name, from: engineId, to: next.engine,
                    reason: '撞到用量上限，自动切换' });
                  return call(next.engine, 1).then(function (r2) {
                    r2.switchedFrom = engineId; return r2;
                  });
                }
                self.emit('failed', { target: target.name, reason: '降级链也全部到限额' });
              }
              return res;
            });
        }

        return call(pick.engine, 0).then(function (res) {
          var entry = {
            agentId: target.id, agentName: target.name,
            engine: res.engine || pick.engine, model: res.model || '',
            taskType: opts.taskType || 'general',
            source: 'delegate:' + (commander.name || 'workbench'),
            tokensIn: res.tokensIn || 0, tokensOut: res.tokensOut || 0,
            skills: opts.skillIds || [], skillTokens: opts.skillTokens || 0,
            cost: res.cost, costSource: res.costSource,
            status: res.status || (res.error ? 'error' : 'ok'),
            error: res.error || '', dryRun: !!res.dryRun,
          };
          // record() 返回补齐后的记录（含自动估算的 cost），要以它为准
          var saved = self.ledger.record(entry);
          var out = {
            agentId: target.id, agentName: target.name, status: saved.status,
            text: res.text || '', engine: saved.engine, cost: saved.cost,
            costSource: saved.costSource,
            switched: pick.switched || !!res.switchedFrom,
            switchedFrom: res.switchedFrom || (pick.switched ? pick.from : ''),
            dryRun: saved.dryRun, error: saved.error,
            skills: saved.skills || [], skillTokens: saved.skillTokens || 0,
          };
          self.emit(out.status === 'ok' ? 'finished' : 'failed', out);
          return out;
        });
      })
      .catch(function (err) {
        self.emit('failed', { target: target.name, reason: String(err && err.message || err) });
        return { agentId: target.id, agentName: target.name, status: 'error',
          error: String(err && err.message || err), cost: 0, engine: '' };
      });
  };

  /**
   * 委派任务。
   * spec: { commanderId, targetIds, task, mode:'parallel'|'sequential'|'chain',
   *         autoApprove, dryRun, taskType,
   *         skillIds, skillContext, skillTokens }  // v3：技能说明书挂在本次任务上
   * 返回 Promise<{ results, totalCost, spent, simulated, succeeded, failed, switched, events }>
   */
  AgentOrchestrator.prototype.delegate = function (spec) {
    var self = this, s = spec || {};
    var commander = this.registry.get(s.commanderId);
    var events = [];
    var collect = this.on('*', function (p) { events.push(p); });

    if (!commander) return Promise.reject(new Error('找不到指挥官 Agent'));
    if (!this.canControl(commander)) {
      return Promise.reject(new Error('「' + commander.name + '」没有指挥其他 Agent 的权限（需 role=orchestrator 或 canControl=true）'));
    }
    var ids = s.targetIds || [];
    var targets = ids.map(function (id) { return self.registry.get(id); }).filter(Boolean);
    if (!targets.length) return Promise.reject(new Error('请至少选择一个目标 Agent'));
    if (!s.task || !String(s.task).trim()) return Promise.reject(new Error('任务内容不能为空'));

    this.emit('delegated', { commander: commander.name, targets: targets.map(function (t) { return t.name; }),
      task: s.task, mode: s.mode || 'parallel', dryRun: !!s.dryRun,
      skills: s.skillIds || [], skillTokens: s.skillTokens || 0 });

    var finish = function (results) {
      var out = {
        results: results,
        totalCost: results.reduce(function (n, r) { return n + (r.cost || 0); }, 0),
        spent: results.filter(function (r) { return !r.dryRun; }).reduce(function (n, r) { return n + (r.cost || 0); }, 0),
        simulated: results.filter(function (r) { return r.dryRun; }).reduce(function (n, r) { return n + (r.cost || 0); }, 0),
        succeeded: results.filter(function (r) { return r.status === 'ok'; }).length,
        failed: results.filter(function (r) { return r.status !== 'ok'; }).length,
        switched: results.filter(function (r) { return r.switched; }).length,
        skills: s.skillIds || [], skillTokens: s.skillTokens || 0,
        events: events,
      };
      self.emit('completed', out);
      return out;
    };

    var mode = s.mode || 'parallel';
    if (mode === 'parallel') {
      return Promise.all(targets.map(function (t) { return self._runOne(t, s.task, s, commander); })).then(finish);
    }
    // sequential / chain：一个接一个；chain 会把上一个的结果拼进下一个的任务
    var results = [], chain = Promise.resolve();
    targets.forEach(function (t) {
      chain = chain.then(function () {
        var task = mode === 'chain' && results.length && results[results.length - 1].text
          ? s.task + '\n\n【上一位 Agent 的结果】\n' + results[results.length - 1].text
          : s.task;
        return self._runOne(t, task, s, commander).then(function (r) { results.push(r); });
      });
    });
    return chain.then(function () { return finish(results); });
  };

  AgentOrchestrator.prototype.broadcast = function (spec) {
    var s = Object.assign({}, spec, {
      targetIds: this.registry.list().map(function (a) { return a.id; })
        .filter(function (id) { return id !== spec.commanderId; }),
      mode: 'parallel',
    });
    return this.delegate(s);
  };
  AgentOrchestrator.prototype.chain = function (spec) {
    return this.delegate(Object.assign({}, spec, { mode: 'chain' }));
  };

  /* ---------- 导出 ---------- */
  global.AgentsCore = {
    ENGINES: ENGINES,
    DEFAULT_AGENT: DEFAULT_AGENT,
    TASK_DEFAULTS: TASK_DEFAULTS,
    AgentRegistry: AgentRegistry,
    ModelRouter: ModelRouter,
    UsageLedger: UsageLedger,
    AgentOrchestrator: AgentOrchestrator,
    estimateCost: estimateCost,
    detectLimit: function (t) { return LIMIT_PATTERNS.test(String(t || '')); },
    createAgent: function (overrides) { return Object.assign({}, DEFAULT_AGENT, overrides); },
  };
})(typeof window !== 'undefined' ? window : globalThis);
