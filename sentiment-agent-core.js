/**
 * ============================================================
 *  sentiment-agent-core.js —— 情绪 / 偏好 Agent 核心
 *  ============================================================
 *
 *  定位：工作台第 N 个「常驻后台」Agent，与知识沉淀官 / Agent 治理官并列。
 *  职责：不断「听」用户对各个 agent 的评价与情绪，从中学习用户偏好，
 *        沉淀成「该多做（do）/ 该避免（avoid）」的偏好规则，并：
 *        ① 注入各 chat agent 的系统提示词，指导以后的操作；
 *        ② 通过 settlerSubmit 回调，把偏好经验提交给「经验沉淀官」沉淀
 *           （仍停 pending_approval，保持经验沉淀官的人工在环铁律）。
 *
 *  闭环：
 *    用户在聊天里点赞/点踩 / 说「很好」「太啰嗦了」……
 *      → observe() 侦测并记录信号
 *      → distill() 把同场景同方向的信号聚合、超过阈值提炼成偏好规则
 *      → 偏好规则写进本库（自动）+ 提交经验沉淀官（待审批）
 *      → guidance(agent) 生成「该做/该避免」指导，注入后续 system prompt
 *
 *  设计原则（与知识沉淀官一致）：
 *    1. 本地启发式（关键词 + 强度），不调 LLM、不引入延迟，保证零依赖、离线可用。
 *    2. 情绪/偏好是「用户明确表达」的信号，可信度高，因此本库可自动沉淀；
 *       但「提交给经验沉淀官」仍走其人工在环流程（只提案，approve 才入库）。
 *    3. 同场景同方向多次重复才升级为偏好（去噪：一次抱怨不等于永久偏好）。
 *
 *  零依赖。浏览器：<script src="sentiment-agent-core.js">；Node：require() 取 module.exports。
 *  存储 local-first：{ signals: [], preferences: [] }，由宿主注入 storage（JSON 文件 / localStorage）。
 * ============================================================
 */
(function (global) {
  'use strict';

  /* ---------- 1. 常量 ---------- */
  var VAL_POSITIVE = 'positive';
  var VAL_NEGATIVE = 'negative';
  var VAL_NEUTRAL = 'neutral';

  var DIR_DO = 'do';       // 该保持/多做
  var DIR_AVOID = 'avoid'; // 该避免/少做

  // 成为偏好规则所需的最小同方向信号数（去噪：一次抱怨不升级为永久偏好）
  var MIN_COUNT = 2;

  /* ---------- 2. 情绪/评价词典（启发式，保守） ---------- */
  // 积极评价：认可某种做法。含强度（strong 强 / normal 普通）。
  var POSITIVE_WORDS = [
    ['太好了', 'strong'], ['太棒', 'strong'], ['非常棒', 'strong'], ['非常好', 'strong'],
    ['很专业', 'strong'], ['很满意', 'strong'], ['非常满意', 'strong'], ['完美', 'strong'],
    ['正是我想要的', 'strong'], ['好多了', 'strong'], ['比之前好', 'strong'], ['靠谱', 'strong'],
    ['给力', 'strong'], ['厉害', 'strong'], ['出色', 'strong'], ['高效', 'strong'], ['清晰', 'strong'],
    ['👍', 'strong'], ['😊', 'strong'], ['👏', 'strong'],
    ['很好', 'normal'], ['不错', 'normal'], ['满意', 'normal'], ['喜欢', 'normal'],
    ['赞', 'normal'], ['优秀', 'normal'], ['专业', 'normal'], ['简洁', 'normal'],
    ['准确', 'normal'], ['到位', 'normal'], ['感谢', 'normal'], ['谢谢', 'normal'],
    ['多谢', 'normal'], ['辛苦', 'normal'], ['有用', 'normal'], ['有帮助', 'normal'],
    ['正是这样', 'normal'], ['对', 'normal'], ['nice', 'normal'], ['great', 'normal'],
    ['perfect', 'normal'], ['good', 'normal'], ['thanks', 'normal'],
  ];
  // 消极评价：不满意某种做法。
  var NEGATIVE_WORDS = [
    ['太啰嗦', 'strong'], ['太啰嗦了', 'strong'], ['废话太多', 'strong'], ['太慢', 'strong'],
    ['太差', 'strong'], ['太差了', 'strong'], ['垃圾', 'strong'], ['气死', 'strong'],
    ['很失望', 'strong'], ['非常失望', 'strong'], ['看不懂', 'strong'], ['完全没用', 'strong'],
    ['👎', 'strong'], ['😡', 'strong'], ['😞', 'strong'], ['很敷衍', 'strong'], ['太敷衍', 'strong'],
    ['很不满意', 'strong'],
    ['不好', 'normal'], ['很差', 'normal'], ['失望', 'normal'], ['不满意', 'normal'],
    ['不喜欢', 'normal'], ['错了', 'normal'], ['不对', 'normal'], ['错误', 'normal'],
    ['啰嗦', 'normal'], ['废话', 'normal'], ['太长', 'normal'], ['太短', 'normal'],
    ['没用', 'normal'], ['没帮助', 'normal'], ['混乱', 'normal'], ['敷衍', 'normal'],
    ['应付', 'normal'], ['讨厌', 'normal'], ['糟糕', 'normal'], ['没用', 'normal'],
    ['烦', 'normal'], ['无语', 'normal'], ['生气', 'normal'], ['bad', 'normal'],
    ['wrong', 'normal'], ['useless', 'normal'],
  ];

  // 场景/动作类型词：从「评价文本 + 上下文」里抽取，用来给偏好规则归类。
  var SCENARIO_WORDS = [
    '总结', '摘要', '缩写', '扩写', '改写', '润色', '翻译', '搜索', '检索', '联网',
    '排版', '格式', 'PPT', '幻灯片', '文档', '写代码', '代码', 'debug', '调试',
    '审稿', '批注', '评价', '规划', '拆解', '分析', '对比', '写作', '文献', '综述',
    '引用', '标注', '核对', '核实', '下载', '整理', '归档', '提醒', '日程', '邮件',
    '笔记', '表格', '图表', 'mermaid', '流程图', '大纲', '框架', '标题', '语气',
    '回复速度', '篇幅', '详细程度', '举例', '结构', '结论',
  ];

  /* ---------- 3. 状态工厂 + 默认存储 ---------- */
  function emptyState() {
    return { signals: [], preferences: [] };
  }

  function defaultStorage() {
    var key = 'ingrid.sentiment-agent';
    return {
      load: function () {
        try {
          var raw = global.localStorage.getItem(key);
          var d = raw ? JSON.parse(raw) : emptyState();
          return (d && d.signals && d.preferences) ? d : emptyState();
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

  function uid(prefix) {
    return (prefix || 's') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function cleanText(v) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  }

  /* ---------- 4. 情绪 / 评价侦测 ---------- */
  /**
   * detect(text) -> { valence, intensity, matched: [words], score }
   * 消极优先（负面评价更需关注）；都命中则按强度与数量加权。
   */
  function detect(text) {
    var t = cleanText(text);
    var pos = [], neg = [];
    var i, w;
    for (i = 0; i < POSITIVE_WORDS.length; i++) {
      w = POSITIVE_WORDS[i];
      if (t.indexOf(w[0]) >= 0) pos.push(w);
    }
    for (i = 0; i < NEGATIVE_WORDS.length; i++) {
      w = NEGATIVE_WORDS[i];
      if (t.indexOf(w[0]) >= 0) neg.push(w);
    }
    var scorePos = 0, scoreNeg = 0;
    pos.forEach(function (w) { scorePos += (w[1] === 'strong' ? 3 : 1); });
    neg.forEach(function (w) { scoreNeg += (w[1] === 'strong' ? 3 : 1); });

    var valence = VAL_NEUTRAL, matched = [], intensity = 'normal';
    if (scoreNeg > scorePos) {
      valence = VAL_NEGATIVE;
      matched = neg.map(function (w) { return w[0]; });
      intensity = neg.some(function (w) { return w[1] === 'strong'; }) ? 'strong' : 'normal';
    } else if (scorePos > 0 && scorePos >= scoreNeg) {
      valence = VAL_POSITIVE;
      matched = pos.map(function (w) { return w[0]; });
      intensity = pos.some(function (w) { return w[1] === 'strong'; }) ? 'strong' : 'normal';
    }
    return { valence: valence, intensity: intensity, matched: matched, score: scorePos - scoreNeg };
  }

  /* ---------- 5. 场景提取 ---------- */
  function extractScenario(text, context) {
    var t = cleanText(text) + ' ' + cleanText(context);
    var hit = null;
    for (var i = 0; i < SCENARIO_WORDS.length; i++) {
      if (t.indexOf(SCENARIO_WORDS[i]) >= 0) { hit = SCENARIO_WORDS[i]; break; }
    }
    return hit || '';
  }

  /* ---------- 6. 情绪 / 偏好 Agent ---------- */
  /**
   * storage: { load() -> state, save(state) }。
   * settlerSubmit: 可选回调 function(item) -> result，用于把提炼出的偏好经验
   *                提交给「经验沉淀官」（item 结构同 KnowledgeSettler.submit 入参）。
   */
  function SentimentAgent(storage, settlerSubmit) {
    this.storage = storage || defaultStorage();
    this.settlerSubmit = typeof settlerSubmit === 'function' ? settlerSubmit : null;
    this.state = this.storage.load();
    this._normalize();
  }

  SentimentAgent.prototype._normalize = function () {
    if (!this.state || typeof this.state !== 'object') this.state = emptyState();
    if (!Array.isArray(this.state.signals)) this.state.signals = [];
    if (!Array.isArray(this.state.preferences)) this.state.preferences = [];
  };

  SentimentAgent.prototype._save = function () {
    try { this.storage.save(this.state); } catch (e) {}
  };

  SentimentAgent.prototype.setSettlerSubmit = function (fn) {
    this.settlerSubmit = typeof fn === 'function' ? fn : null;
  };

  /* ---------------- 记录一条信号（已明确 valence） ---------------- */
  SentimentAgent.prototype.record = function (raw) {
    raw = raw || {};
    var valence = [VAL_POSITIVE, VAL_NEGATIVE, VAL_NEUTRAL].indexOf(raw.valence) >= 0
      ? raw.valence : VAL_NEUTRAL;
    if (valence === VAL_NEUTRAL) return { recorded: false, reason: 'neutral' };
    var sig = {
      id: uid('sig'),
      valence: valence,
      intensity: raw.intensity || 'normal',
      agent: cleanText(raw.agent) || '通用',
      sessionId: raw.sessionId || '',
      source: raw.source || 'feedback',   // feedback 点赞点踩 / auto 自动侦测 / manual 手动
      text: cleanText(raw.text).slice(0, 500),
      context: cleanText(raw.context).slice(0, 800),
      scenario: raw.scenario || extractScenario(raw.text, raw.context),
      matched: Array.isArray(raw.matched) ? raw.matched : [],
      created: nowIso(),
    };
    this.state.signals.unshift(sig);
    // 只保留最近 500 条信号，避免无限膨胀
    if (this.state.signals.length > 500) this.state.signals.length = 500;
    this._save();
    return { recorded: true, id: sig.id, valence: valence };
  };

  /* ---------------- 侦测 + 记录（自动侦测入口） ---------------- */
  /**
   * observe({ text, valence?, agent, sessionId, source?, context? })
   * 未传 valence 则走词典侦测；中性不记录。返回侦测 + 记录结果。
   */
  SentimentAgent.prototype.observe = function (raw) {
    raw = raw || {};
    var valence = raw.valence;
    var det = null;
    if ([VAL_POSITIVE, VAL_NEGATIVE].indexOf(valence) >= 0) {
      det = { valence: valence, intensity: raw.intensity || 'normal', matched: raw.matched || [] };
    } else {
      det = detect(raw.text || '');
    }
    var out = {
      valence: det.valence,
      intensity: det.intensity,
      matched: det.matched,
      recorded: false,
    };
    if (det.valence === VAL_NEUTRAL) return out;
    var r = this.record({
      valence: det.valence,
      intensity: det.intensity,
      agent: raw.agent,
      sessionId: raw.sessionId,
      source: raw.source || 'auto',
      text: raw.text,
      context: raw.context,
      matched: det.matched,
    });
    out.recorded = r.recorded;
    out.id = r.id;
    return out;
  };

  /* ---------------- 偏好规则键：同 agent + 场景 + 方向 归并 ---------------- */
  SentimentAgent.prototype._prefKey = function (agent, scenario, direction) {
    return [cleanText(agent) || '通用', cleanText(scenario) || '其他', direction].join('||');
  };

  /* ---------------- 提炼：把信号聚合成偏好规则（do/avoid） ---------------- */
  /**
   * distill() 扫描全部信号，按 (agent + scenario + direction) 聚合；
   * 同方向累计 >= MIN_COUNT 即生成/更新偏好规则，并把「新提炼」的偏好
   * 通过 settlerSubmit 提交给经验沉淀官（去重：只对新出现/升级的提交）。
   * 返回 { created, updated, submitted, skipped }。
   */
  SentimentAgent.prototype.distill = function () {
    var self = this;
    // 聚合
    var buckets = {};
    this.state.signals.forEach(function (s) {
      var dir = s.valence === VAL_POSITIVE ? DIR_DO : DIR_AVOID;
      var key = self._prefKey(s.agent, s.scenario, dir);
      if (!buckets[key]) {
        buckets[key] = { agent: s.agent || '通用', scenario: s.scenario || '其他', direction: dir, signals: [] };
      }
      buckets[key].signals.push(s);
    });

    var created = 0, updated = 0, submitted = 0;
    Object.keys(buckets).forEach(function (key) {
      var b = buckets[key];
      if (b.signals.length < MIN_COUNT) return;
      var existing = self.state.preferences.filter(function (p) { return p.key === key; })[0];
      var latest = b.signals[0];  // 信号按时间倒序，最新在前
      var newestText = latest.text;
      // 做法总结：正 → 用户认可的做法；负 → 用户不满意的做法
      var action = b.direction === DIR_DO
        ? ('用户认可「' + b.scenario + '」场景下的这种做法，应继续保持：' + newestText)
        : ('用户不满意「' + b.scenario + '」场景下的这种做法，应避免：' + newestText);
      if (existing) {
        var grew = existing.count !== b.signals.length;
        existing.count = b.signals.length;
        existing.action = action;
        existing.reason = newestText;
        existing.lastSeen = latest.created;
        existing.confidence = Math.min(1, 0.5 + b.signals.length * 0.15);
        if (grew) updated++;
        self._save();
        return;
      }
      var pref = {
        id: uid('pref'),
        key: key,
        direction: b.direction,
        agent: b.agent,
        scenario: b.scenario,
        action: action,
        reason: newestText,
        confidence: Math.min(1, 0.5 + b.signals.length * 0.15),
        count: b.signals.length,
        firstSeen: b.signals[b.signals.length - 1].created,
        lastSeen: latest.created,
      };
      self.state.preferences.unshift(pref);
      created++;
      // 提交给经验沉淀官（新提炼的偏好，作为一条经验提案，仍待人工审批）
      if (self.settlerSubmit) {
        try {
          self.settlerSubmit({
            source: 'sentiment',
            rule: 'user-preference',
            title: '【用户偏好】' + (b.direction === DIR_DO ? '保持' : '避免') + '：' + b.scenario,
            evidence: '用户对「' + b.agent + '」在「' + b.scenario + '」场景的反馈（累计 ' + b.signals.length + ' 次）：' + newestText,
            rootCause: b.direction === DIR_DO ? '用户认可这种做法' : '用户不满意这种做法',
            fixApproach: action,
          });
          submitted++;
        } catch (e) { /* 经验沉淀官不可用时静默降级 */ }
      }
    });
    this._save();
    return { created: created, updated: updated, submitted: submitted, skipped: Object.keys(buckets).length - created - updated };
  };

  /* ---------------- 偏好规则列表 ---------------- */
  SentimentAgent.prototype.preferences = function (agent) {
    var list = this.state.preferences;
    if (agent) list = list.filter(function (p) { return p.agent === agent; });
    return list.slice();
  };

  /* ---------------- 手动编辑偏好规则 ---------------- */
  /**
   * updatePreference(id, patch) -> { ok, pref }
   * patch 可含：direction('do'|'avoid')、scenario、agent、action、reason、confidence(0~1)、count。
   * 编辑后重算 key（agent||scenario||direction），保持与 distill 去重键一致，避免下次蒸馏重复生成。
   */
  SentimentAgent.prototype.updatePreference = function (id, patch) {
    patch = patch || {};
    var p = null;
    for (var i = 0; i < this.state.preferences.length; i++) {
      if (this.state.preferences[i].id === id) { p = this.state.preferences[i]; break; }
    }
    if (!p) return { ok: false, reason: 'not_found' };
    var oldKey = p.key;
    if (patch.direction !== undefined && [DIR_DO, DIR_AVOID].indexOf(patch.direction) >= 0) p.direction = patch.direction;
    if (patch.scenario !== undefined) p.scenario = cleanText(patch.scenario) || '其他';
    if (patch.agent !== undefined) p.agent = cleanText(patch.agent) || '通用';
    if (patch.action !== undefined) p.action = cleanText(patch.action);
    if (patch.reason !== undefined) p.reason = cleanText(patch.reason);
    if (patch.confidence !== undefined) {
      var c = Number(patch.confidence);
      if (!isNaN(c)) p.confidence = Math.max(0, Math.min(1, c));
    }
    if (patch.count !== undefined) {
      var n = parseInt(patch.count, 10);
      if (!isNaN(n) && n >= 0) p.count = n;
    }
    var newKey = this._prefKey(p.agent, p.scenario, p.direction);
    // 关键：改了 agent/scenario/direction（key 变化）时，级联同步关联信号，
    // 否则信号仍留在旧 key，删除偏好会漏清信号、distill 又会复活一条旧偏好。
    if (newKey !== oldKey) {
      this.state.signals.forEach(function (s) {
        var dir = s.valence === VAL_POSITIVE ? DIR_DO : DIR_AVOID;
        if (this._prefKey(s.agent, s.scenario, dir) === oldKey) {
          s.agent = p.agent;
          s.scenario = p.scenario;
          s.valence = p.direction === DIR_DO ? VAL_POSITIVE : VAL_NEGATIVE;
        }
      }.bind(this));
    }
    p.key = newKey;
    this._save();
    return { ok: true, pref: p };
  };

  /* ---------------- 手动删除偏好规则 ---------------- */
  /**
   * removePreference(id, opts) -> { ok, removed, removedSignals }
   * opts.cascadeSignals 默认 true：删除偏好时连同该 key 的残留信号一起删，
   * 避免下次 distill() 又从信号里「复活」同一条偏好。
   */
  SentimentAgent.prototype.removePreference = function (id, opts) {
    opts = opts || {};
    var cascade = opts.cascadeSignals !== false;
    var p = null;
    for (var i = 0; i < this.state.preferences.length; i++) {
      if (this.state.preferences[i].id === id) { p = this.state.preferences[i]; break; }
    }
    if (!p) return { ok: false, removed: 0 };
    var key = p.key;
    this.state.preferences = this.state.preferences.filter(function (x) { return x.id !== id; });
    var removedSignals = 0;
    if (cascade && key) {
      var before = this.state.signals.length;
      this.state.signals = this.state.signals.filter(function (s) {
        var dir = s.valence === VAL_POSITIVE ? DIR_DO : DIR_AVOID;
        return this._prefKey(s.agent, s.scenario, dir) !== key;
      }.bind(this));
      removedSignals = before - this.state.signals.length;
    }
    this._save();
    return { ok: true, removed: 1, removedSignals: removedSignals };
  };

  /* ---------------- 信号列表 ---------------- */
  SentimentAgent.prototype.signals = function (limit, valence) {
    var list = this.state.signals;
    if (valence) list = list.filter(function (s) { return s.valence === valence; });
    return list.slice(0, limit || 100);
  };

  /* ---------------- 生成给某 agent 的偏好指导文本 ---------------- */
  /**
   * guidance(agent) -> string（可注入 system prompt 的「该做/该避免」清单）
   */
  SentimentAgent.prototype.guidance = function (agent) {
    agent = cleanText(agent);
    var prefs = agent ? this.state.preferences.filter(function (p) { return p.agent === agent; })
                      : this.state.preferences.slice();
    if (!prefs.length) return '';
    // 按方向分组，信心度高的排前面
    var dos = prefs.filter(function (p) { return p.direction === DIR_DO; })
      .sort(function (a, b) { return (b.confidence || 0) - (a.confidence || 0); });
    var avoids = prefs.filter(function (p) { return p.direction === DIR_AVOID; })
      .sort(function (a, b) { return (b.confidence || 0) - (a.confidence || 0); });
    var lines = [];
    lines.push('以下是情绪/偏好 Agent 长期沉淀的「用户偏好」，请在实际操作中始终遵守：');
    if (dos.length) {
      lines.push('【应该保持 / 多做】');
      dos.forEach(function (p) {
        lines.push('- ' + p.scenario + '：' + p.action + '（用户已多次认可，信心 ' + Math.round((p.confidence || 0) * 100) + '%）');
      });
    }
    if (avoids.length) {
      lines.push('【应该避免 / 少做】');
      avoids.forEach(function (p) {
        lines.push('- ' + p.scenario + '：' + p.action + '（用户已多次不满，信心 ' + Math.round((p.confidence || 0) * 100) + '%）');
      });
    }
    return lines.join('\n');
  };

  /* ---------------- 统计报告 ---------------- */
  SentimentAgent.prototype.report = function () {
    var s = this.state.signals, p = this.state.preferences;
    return {
      agent: '情绪/偏好 Agent',
      mode: '常驻后台 · 侦测评价与情绪 · 提炼偏好规则（do/avoid）· 联动经验沉淀',
      home_visible: false,
      read_only: false,
      signal_count: s.length,
      positive_count: s.filter(function (x) { return x.valence === VAL_POSITIVE; }).length,
      negative_count: s.filter(function (x) { return x.valence === VAL_NEGATIVE; }).length,
      preference_do: p.filter(function (x) { return x.direction === DIR_DO; }).length,
      preference_avoid: p.filter(function (x) { return x.direction === DIR_AVOID; }).length,
      pending_settle: '联动知识沉淀官：新偏好自动提交为待审批经验提案',
    };
  };

  /* ---------- 7. 导出 ---------- */
  var api = {
    SentimentAgent: SentimentAgent,
    VALENCE: { POSITIVE: VAL_POSITIVE, NEGATIVE: VAL_NEGATIVE, NEUTRAL: VAL_NEUTRAL },
    DIRECTION: { DO: DIR_DO, AVOID: DIR_AVOID },
    detect: detect,
    extractScenario: extractScenario,
    emptyState: emptyState,
    VALENCE_LABEL: { positive: '积极', negative: '消极', neutral: '中性' },
    DIRECTION_LABEL: { do: '保持 / 多做', avoid: '避免 / 少做' },
  };

  global.SentimentAgent = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
