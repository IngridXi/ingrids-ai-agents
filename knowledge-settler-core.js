/**
 * ============================================================
 *  knowledge-settler-core.js —— 知识沉淀官（经验沉淀 Agent）核心
 *  ============================================================
 *
 *  设计来源：海归海平台「经验沉淀官 experience_settler」
 *    （本仓库 docs/agent-ops-design.md 记录了完整的借鉴对照）
 *
 *  定位：工作台第三个「常驻后台」Agent，与调度中枢 / 监督者并列，
 *        构成「发现 → 诊断 → 沉淀 → 复用」闭环的最后一环。
 *    - 发现者 / 诊断者：工作台的调度中枢（orchestrator）+ 各 chat agent
 *    - 沉淀者（本模块）：把「已解决」的问题复盘提炼成可复用经验
 *
 *  融合四套开源范式（有机结合，非照搬代码）：
 *    1. Voyager 技能库  —— 方法论沉淀成 skill，新问题先 suggest_for 检索复用
 *    2. Reflexion 反思   —— 问题 resolved 后触发「复盘 → 提炼」闭环
 *    3. SKILL.md 标准    —— 方法论用 WorkBuddy skill 格式承载（待 skill 化）
 *    4. MemGPT 分层记忆  —— 短期 trace → 蒸馏 → 长期（方法论库 / 结论库）
 *
 *  人工在环铁律（最高优先级，不可绕过）：
 *    1. 只提案、不自动写库：runOnce/submit 只产出 pending_approval 提案，
 *       只有 approve() 被人工调用后才写入经验库。
 *    2. 分类以人工为准：_classify 是启发式预标注，最终 category 人工可覆盖。
 *    3. 「经验」≠「规律」：一次性结论（批次/日期/金额/门店）不得当通用方法论，
 *       方法论与结论分库，避免把巧合当规律、把表面补丁当方法论。
 *
 *  零依赖。浏览器：<script src="knowledge-settler-core.js">；Node：require() 取 module.exports。
 *  存储 local-first：{ proposals: [], library: [] }，由宿主注入 storage（localStorage / JSON 文件）。
 * ============================================================
 */
(function (global) {
  'use strict';

  /* ---------- 1. 常量：状态机 + 分类 ---------- */
  var ST_PENDING = 'pending_approval';   // 待人工审批（自动阶段终点）
  var ST_APPROVED = 'approved';           // 已入库
  var ST_IGNORED = 'ignored';             // 已忽略

  var CAT_METHOD = 'methodology';         // 方法论：可跨案例复用的手法/原则 → 方法论库（待 skill 化）
  var CAT_CONCLUSION = 'conclusion';      // 结论：一次性事实（批次/日期/金额）→ 结论库（事故库）
  var CAT_BOTH = 'both';                  // 两者都有 → 拆两条分别入库
  var CAT_UNCERTAIN = 'uncertain';        // 待人工判定

  /* ---------- 2. 启发式分类信号（保守预标注，人工可覆盖） ---------- */
  // 结论信号：一次性事实，会随数据演进过期，不得当通用规律
  var _CONCLUSION_RE = new RegExp(
    'batch\\s*[=:]?\\s*\\d+|批次\\s*\\d+|batch\\s*\\d+' +
    '|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}-\\d{1,2}\\b' +
    '|\\d+\\s*分|\\d+\\.?\\d*\\s*元|\\d+\\s*条' +
    '|门店|日期|金额|batch'
  );
  // 方法论信号：可跨案例复用的诊断/修复手法
  var _METHOD_RE = new RegExp(
    '重复导入|覆盖缺口|整行丢弃|归一化|维度对齐|逐日反算|交叉比对|' +
    '去重|留痕|告警|校验|口径|对齐|反算|幂等|原子|断点续传|' +
    '根因|诊断|修复|兜底|降级|节流|缓存|串线|竞态|超时|重试|快照|回放'
  );

  // 非「问题→根因→修复」诊断经验的 rule，反复触发属噪音，不作为经验来源。
  // 纯运维动作提醒（如「改完没重启」）已静态写死于 RULES，沉淀只会污染经验库。
  var _SKIP_RULES = ['boot_code_lag', 'restart_required', 'manual_reminder', 'eco-radar'];

  /* ---------- 3. 状态工厂 + 默认存储 ---------- */
  function emptyState() {
    return { proposals: [], library: [] };
  }

  function defaultStorage() {
    var key = 'ingrid.knowledge-settler';
    return {
      load: function () {
        try {
          var raw = global.localStorage.getItem(key);
          var d = raw ? JSON.parse(raw) : emptyState();
          return (d && d.proposals && d.library) ? d : emptyState();
        } catch (e) { return emptyState(); }
      },
      save: function (state) {
        try { global.localStorage.setItem(key, JSON.stringify(state)); } catch (e) {}
      },
    };
  }

  function nowIso() {
    return new Date().toISOString();
  }

  /** 内容指纹：用于提案去重（同 title+rule+rootCause 视为同一件事，不重复提案） */
  function fingerprint(item) {
    var key = [item.rule || '', item.title || '', item.rootCause || ''].join('||');
    var h = 0;
    for (var i = 0; i < key.length; i++) {
      h = ((h << 5) - h + key.charCodeAt(i)) | 0;
    }
    return 'ks-' + (h >>> 0).toString(36) + '-' + key.length.toString(36);
  }

  /* ---------- 4. 知识沉淀官 ---------- */
  /**
   * storage: { load() -> state, save(state) }。默认 localStorage。
   * 宿主（Electron 主进程）可注入文件存储，实现 local-first 落盘。
   */
  function KnowledgeSettler(storage) {
    this.storage = storage || defaultStorage();
    this.state = this.storage.load();
    this._normalize();
  }

  KnowledgeSettler.prototype._normalize = function () {
    if (!this.state || typeof this.state !== 'object') this.state = emptyState();
    if (!Array.isArray(this.state.proposals)) this.state.proposals = [];
    if (!Array.isArray(this.state.library)) this.state.library = [];
  };

  KnowledgeSettler.prototype._save = function () {
    try { this.storage.save(this.state); } catch (e) {}
  };

  /* ---------------- 启发式分类（保守预标注，人工可覆盖） ---------------- */
  KnowledgeSettler.prototype._classify = function (item) {
    var text = [item.title, item.evidence, item.rootCause, item.fixApproach]
      .filter(Boolean).join(' ');
    var hasMethod = _METHOD_RE.test(text);
    var hasConclusion = _CONCLUSION_RE.test(text);
    if (hasMethod && hasConclusion) return CAT_BOTH;
    if (hasMethod) return CAT_METHOD;
    if (hasConclusion) return CAT_CONCLUSION;
    return CAT_UNCERTAIN;
  };

  /* ---------------- 提炼：套模板产出结构化 insight ---------------- */
  KnowledgeSettler.prototype._distill = function (item) {
    return {
      fingerprint: item.fingerprint || fingerprint(item),
      source: item.source || 'manual',
      rule: item.rule || '',
      title: item.title || item.rule || '未命名经验',
      evidence: item.evidence || '',
      rootCause: item.rootCause || '',
      fixApproach: item.fixApproach || '',
      insight: [
        '现象：' + (item.title || ''),
        '根因：' + (item.rootCause || item.evidence || '（无）'),
        '修复：' + (item.fixApproach || '（无）'),
      ].join('｜'),
      category: item.category || this._classify(item),
    };
  };

  /* ---------------- 提案落库（去重 + 不回退人工确认过的） ---------------- */
  KnowledgeSettler.prototype._persistProposal = function (p) {
    var self = this;
    var existing = this.state.proposals.filter(function (x) { return x.fingerprint === p.fingerprint; })[0];
    if (existing) {
      // 已存在：更新 insight/分类，但保留已 approved/ignored 的审批状态（不回退人工确认）
      if (existing.status !== ST_APPROVED && existing.status !== ST_IGNORED) {
        existing.insight = p.insight;
        existing.category = p.category;
        existing.updated = nowIso();
      }
      return existing;
    }
    var rec = {
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      fingerprint: p.fingerprint,
      source: p.source,
      rule: p.rule,
      title: p.title,
      evidence: p.evidence,
      rootCause: p.rootCause,
      fixApproach: p.fixApproach,
      insight: p.insight,
      verification: p.verification || '',
      category: p.category,
      status: ST_PENDING,
      created: nowIso(),
      updated: nowIso(),
    };
    this.state.proposals.unshift(rec);
    return rec;
  };

  /* ---------------- 主循环：复盘「已解决项」→ 提案 ---------------- */
  /**
   * items: [{ source, rule, title, evidence, rootCause, fixApproach }]
   * 返回 { consumed, created, pending_approval }
   */
  KnowledgeSettler.prototype.runOnce = function (items) {
    var list = (items || []).filter(function (it) {
      return it && (_SKIP_RULES.indexOf(it.rule) < 0);
    });
    var created = 0;
    for (var i = 0; i < list.length; i++) {
      var p = this._distill(list[i]);
      var before = this.state.proposals.some(function (x) { return x.fingerprint === p.fingerprint; });
      this._persistProposal(p);
      if (!before) created++;
    }
    this._save();
    return {
      consumed: list.length,
      created: created,
      pending_approval: this.state.proposals.filter(function (x) { return x.status === ST_PENDING; }).length,
    };
  };

  /* ---------------- 人工提交一条经验（现象/根因/修复） ---------------- */
  KnowledgeSettler.prototype.submit = function (item) {
    var p = this._distill(item || {});
    this._persistProposal(p);
    this._save();
    return { id: p.fingerprint, category: p.category, status: ST_PENDING };
  };

  /* ---------------- 提案列表 ---------------- */
  KnowledgeSettler.prototype.proposals = function (status) {
    var list = this.state.proposals;
    if (status) list = list.filter(function (x) { return x.status === status; });
    return list.slice();
  };

  /* ---------------- 检索关键词抽取 ---------------- */
  KnowledgeSettler.prototype._tags = function (title, insight) {
    var words = {};
    var m;
    var re = new RegExp(_METHOD_RE.source, 'g');
    while ((m = re.exec(insight || '')) !== null) words[m[0]] = 1;
    var cn = (title || '').match(/[\u4e00-\u9fff]{2,6}/g) || [];
    cn.forEach(function (w) { words[w] = 1; });
    return Object.keys(words).join(',');
  };

  /* ---------------- 人工在环：确认入库 ---------------- */
  /**
   * approve(id, { category?, verification? })
   * category 可覆盖预标注；methodology/both 强烈建议附 verification（如何验证这条经验仍适用）。
   * 绝不在此自动生成 skill —— 那由主 agent 用 skill-creator 完成，方法论仅登记并标注「待 skill 化」。
   */
  KnowledgeSettler.prototype.approve = function (id, opts) {
    opts = opts || {};
    var self = this;
    var p = this.state.proposals.filter(function (x) { return x.id === id || x.fingerprint === id; })[0];
    if (!p) return { error: 'proposal not found', id: id };
    var cat = opts.category || p.category;
    if ([CAT_METHOD, CAT_CONCLUSION, CAT_BOTH, CAT_UNCERTAIN].indexOf(cat) < 0) {
      return { error: 'invalid category', category: cat };
    }
    var cats = (cat === CAT_BOTH) ? [CAT_METHOD, CAT_CONCLUSION] : [cat];
    var verification = opts.verification || p.verification || '';
    cats.forEach(function (cc) {
      if (cc === CAT_UNCERTAIN) return;   // 待定不入库
      self.state.library.unshift({
        id: 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        category: cc,
        rule: p.rule,
        title: p.title,
        insight: p.insight,
        verification: verification,
        tags: self._tags(p.title, p.insight),
        sourceFingerprint: p.fingerprint,
        skillPath: '',                     // 主 agent 用 skill-creator 生成后回填
        created: nowIso(),
      });
    });
    p.status = ST_APPROVED;
    p.verification = verification;
    p.updated = nowIso();
    this._save();
    return {
      id: p.id, category: cat, verification: verification,
      note: cat === CAT_METHOD || cat === CAT_BOTH
        ? '方法论已登记经验库（待 skill 化）'
        : '结论已登记事故库',
    };
  };

  KnowledgeSettler.prototype.ignore = function (id) {
    var p = this.state.proposals.filter(function (x) { return x.id === id || x.fingerprint === id; })[0];
    if (!p) return { error: 'proposal not found', id: id };
    p.status = ST_IGNORED;
    p.updated = nowIso();
    this._save();
    return { id: p.id, status: ST_IGNORED };
  };

  /* ---------------- 提炼回写：把冗长 fixApproach 替换为简洁总结（仅待审批，不覆盖已确认） ---------------- */
  KnowledgeSettler.prototype.refineFix = function (id, fixApproach, insight) {
    var p = this.state.proposals.filter(function (x) { return x.id === id || x.fingerprint === id; })[0];
    if (!p) return { error: 'proposal not found', id: id };
    if (p.status !== ST_PENDING) return { error: 'not pending', id: id };
    if (fixApproach != null && fixApproach !== '') p.fixApproach = fixApproach;
    if (insight != null && insight !== '') p.insight = insight;
    p.updated = nowIso();
    this._save();
    return { id: p.id, ok: true };
  };

  /* ---------------- 检索复用（Voyager 技能库式） ---------------- */
  /**
   * suggestFor({ rule?, title?, evidence? }, limit?)
   * 给新问题匹配已有方法论经验：优先同 rule，再按手法词命中 tags。
   * 供调度中枢 / chat agent 在生成新任务时调用，提示「可能适用历史经验」。
   */
  KnowledgeSettler.prototype.suggestFor = function (q, limit) {
    q = q || {};
    limit = limit || 5;
    var text = [q.rule || '', q.title || '', q.evidence || ''].join(' ');
    var methods = this.state.library.filter(function (x) { return x.category === CAT_METHOD; });
    var out = [];
    for (var i = 0; i < methods.length && out.length < limit; i++) {
      var e = methods[i];
      if (q.rule && e.rule === q.rule) {
        out.push(this._hit(e, 'rule'));
      }
    }
    for (var j = 0; j < methods.length && out.length < limit; j++) {
      var e2 = methods[j];
      var hit = false;
      var re = new RegExp(_METHOD_RE.source, 'g');
      var m;
      while ((m = re.exec(text)) !== null) {
        if (('' + (e2.tags || '')).indexOf(m[0]) >= 0) { hit = true; break; }
      }
      if (hit && out.filter(function (o) { return o.id === e2.id; }).length === 0) {
        out.push(this._hit(e2, 'keyword'));
      }
    }
    return out;
  };

  KnowledgeSettler.prototype._hit = function (e, match) {
    return {
      id: e.id, category: e.category, rule: e.rule, title: e.title,
      insight: e.insight, verification: e.verification, tags: e.tags,
      match: match,
    };
  };

  /* ---------------- 统计报告 ---------------- */
  KnowledgeSettler.prototype.report = function () {
    var p = this.state.proposals, l = this.state.library;
    return {
      agent: '知识沉淀官 Agent',
      mode: '常驻后台 · 复盘已解决项 · 提案待审批 · 方法论/结论分层入库 · 检索复用',
      home_visible: false,
      read_only: false,
      methodology: 'Voyager 技能库 + Reflexion 反思 + SKILL.md 标准 + MemGPT 分层记忆；人工在环：只提案、分类、待审批，绝不自动写库',
      pending_approval: p.filter(function (x) { return x.status === ST_PENDING; }).length,
      approved: p.filter(function (x) { return x.status === ST_APPROVED; }).length,
      ignored: p.filter(function (x) { return x.status === ST_IGNORED; }).length,
      library_methodology: l.filter(function (x) { return x.category === CAT_METHOD; }).length,
      library_conclusion: l.filter(function (x) { return x.category === CAT_CONCLUSION; }).length,
    };
  };

  /* ---------------- 导出 ---------------- */
  var api = {
    KnowledgeSettler: KnowledgeSettler,
    CATEGORY: { METHOD: CAT_METHOD, CONCLUSION: CAT_CONCLUSION, BOTH: CAT_BOTH, UNCERTAIN: CAT_UNCERTAIN },
    STATUS: { PENDING: ST_PENDING, APPROVED: ST_APPROVED, IGNORED: ST_IGNORED },
    emptyState: emptyState,
    fingerprint: fingerprint,
    CATEGORY_LABEL: { methodology: '方法论', conclusion: '结论', both: '两者', uncertain: '待判定' },
    STATUS_LABEL: { pending_approval: '待审批', approved: '已入库', ignored: '已忽略' },
  };

  global.KnowledgeSettler = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
