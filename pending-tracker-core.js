/**
 * ============================================================
 *  pending-tracker-core.js —— 待办捕获官（未完成工作追踪）核心
 * ============================================================
 *
 *  背景：研究助手等 agent 在对话里会「如实交代未完成/未开始/未查到」的工作，
 *        但这些信息散落在聊天历史里，无人消费——几次对话后用户就忘了。
 *        本模块是「后台自动捕获官」的大脑：把 agent 对话里的未完成工作，
 *        提炼成结构化待做项，维护一张实时更新的清单。
 *
 *  职责边界（与知识沉淀官区分）：
 *    - 知识沉淀官（knowledge-settler-core）：捕获「已解决」→ 复盘成可复用经验
 *    - 本模块（pending-tracker-core）：捕获「未完成/失败」→ 整理成待做清单
 *
 *  设计要点：
 *    1. 零依赖、local-first，UMD 风格（与 session-log-core.js 一致）
 *    2. 纯规则捕获（无 LLM 成本）：从 agent 汇报文本里提取
 *       「表格行 + 状态词（未完成/未开始/未查到/需补/…）」与「已完成」收敛信号
 *    3. 去重靠「标题指纹」；状态自动合并（open↔done），7 天缓冲防「手动完成后又被扫回」
 *    4. 存储可插拔：宿主注入 { load(), save(state) }（Electron 用 JSON 文件，浏览器用 localStorage）
 *
 *  零依赖。浏览器 <script src>；Node require() 后取 module.exports。
 * ============================================================
 */
(function (global) {
  'use strict';

  /* ---------- 1. 常量 ---------- */
  var ST_OPEN = 'open';
  var ST_DONE = 'done';

  // 未完成信号（强「该做没做」信号；描述性/评估性词如「尚未/未核实/待核」不在此列，避免把状态检查表当待办）
  var OPEN_WORDS = [
    '未完成', '未开始', '未查到', '需补引', '需补', '未做', '未覆盖',
    '待办', '待做', '待下载', '未执行', '未列', '未读', '未抓',
  ];
  // 已完成信号
  var DONE_WORDS = [
    '已完成', '已做', '已补', '已核实', '已核', '已办', '办完', '已执行',
    '已落地', '已列', '已换', '已抓', '已读', '已下载',
  ];

  // 表头行（要跳过，别把「任务/状态」表头当成待做项）
  var HEADER_RE = /(任务|task)\s*[|｜\t]\s*(状态|status)/i;

  // 已解决缓冲期：手动完成 / 自动收敛后，多久内不再因「又提到未完成」回弹（毫秒）
  var RESOLVE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

  /* ---------- 2. 纯函数：提取与指纹 ---------- */

  // 状态单元格长度上限（超长 = 说明列，跳过，避免「尚未证实/未核实」等说明文字被误当状态）
  var STATUS_CELL_MAX = 10;

  // 判断一个单元格是 open / done / null
  function classifyCell(cell) {
    var s = String(cell || '');
    if (!s) return null;
    // 去掉加粗/代码/竖线标记与空白，得到「纯状态文本」
    var clean = s.replace(/[*_`#|｜]/g, '').replace(/\s+/g, '').trim();
    if (!clean || clean.length > STATUS_CELL_MAX) return null;
    for (var i = 0; i < OPEN_WORDS.length; i++) if (clean.indexOf(OPEN_WORDS[i]) >= 0) return ST_OPEN;
    for (var j = 0; j < DONE_WORDS.length; j++) if (clean.indexOf(DONE_WORDS[j]) >= 0) return ST_DONE;
    return null;
  }

  // 是否为「序号」单元格（#、1、2、① 等）
  function isSeqCell(cell) {
    var s = String(cell || '').trim();
    if (!s) return true;
    return /^#?\s*\d+\s*$/.test(s) || /^[①②③④⑤⑥⑦⑧⑨⑩]$/.test(s);
  }

  // 取「状态单元格」之前最近的一个「非序号」单元格作为任务名（顺带清理 markdown 标记）
  function pickTitle(cells, statusIdx) {
    for (var j = statusIdx - 1; j >= 0; j--) {
      if (!isSeqCell(cells[j])) return String(cells[j]).replace(/[*_`#|｜]/g, '').trim();
    }
    return '';
  }

  // 标题归一化：去前导序号、去 emoji/加粗/标点/分隔符、压缩空白、转小写
  function normalize(title) {
    return String(title || '')
      .replace(/^#?\s*\d+[.、\)]\s*/, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F✅❌✗✓⚠️→↓↑·•]/gu, '')
      .replace(/[*_`#|｜「」『』"'/\\()（）【】\[\]：:；;，,。.!！？?·•、～~]/g, '')
      .replace(/\s+/g, '')
      .toLowerCase();
  }

  // 指纹：fnv-1a 风格哈希（长度后缀增强区分度）
  function fingerprint(title) {
    var n = normalize(title);
    if (!n) return '';
    var h = 0x811c9dc5;
    for (var i = 0; i < n.length; i++) {
      h ^= n.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return 'p' + h.toString(36) + n.length.toString(36);
  }

  // 编辑距离（Levenshtein），用于「同义措辞」去重
  function editDistance(a, b) {
    if (a === b) return 0;
    var m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    var prev = [], curr = [];
    for (var i = 0; i <= n; i++) prev[i] = i;
    for (var i = 1; i <= m; i++) {
      curr[0] = i;
      for (var j = 1; j <= n; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = curr.slice();
    }
    return prev[n];
  }

  // 字符 bigram 集合（中文友好的相似度基础）
  function bigrams(s) {
    var set = {};
    for (var i = 0; i < s.length - 1; i++) set[s.substr(i, 2)] = true;
    return set;
  }
  // bigram Jaccard 相似度：衡量「部分重合」程度（如「…名单」vs「…名单核验」）
  function jaccard(a, b) {
    var sa = bigrams(a), sb = bigrams(b);
    var inter = 0, union = 0, k;
    var keys = {};
    for (k in sa) keys[k] = 1;
    for (k in sb) keys[k] = 1;
    for (k in keys) { if (sa[k] && sb[k]) inter++; union++; }
    return union ? inter / union : 0;
  }

  // 最长公共子序列长度（容忍「具体/逐条核验」这类中间差异）
  function lcsLength(a, b) {
    var m = a.length, n = b.length;
    if (!m || !n) return 0;
    var prev = new Array(n + 1).fill(0), curr;
    for (var i = 1; i <= m; i++) {
      curr = new Array(n + 1).fill(0);
      for (var j = 1; j <= n; j++) {
        curr[j] = a.charAt(i - 1) === b.charAt(j - 1) ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
      }
      prev = curr;
    }
    return prev[n];
  }

  // 相似度去重：归一化后，满足任一即视为同一任务
  // ① 完全相等 ② 子串包含 ③ 编辑距离很小 ④ 长标题 bigram Jaccard 高 ⑤ 长标题 LCS 占比高
  function similarEnough(a, b) {
    var na = normalize(a), nb = normalize(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.length > 3 && nb.length > 3 && (na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0)) return true;
    var d = editDistance(na, nb);
    if (d <= 2) return true;
    var L = Math.max(na.length, nb.length);
    if (L >= 6) {
      if (jaccard(na, nb) >= 0.6) return true;
      if (lcsLength(na, nb) / L >= 0.66) return true;
    }
    return false;
  }

  // 从一段文本提取待做项：[{ title, status, evidence }]
  function extractItems(text) {
    var out = [];
    var s = String(text || '');
    if (!s) return out;

    var lines = s.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (HEADER_RE.test(line)) continue;

      // —— Checklist 行：- [ ] 未完成 / - [x] 已完成（研究助手显式清单）——
      var cm = line.match(/^\s*[-*+]\s*\[([ xX])\]\s*(.+)$/);
      if (cm) {
        var ctitle = cm[2].replace(/[*_`#|｜]/g, '').trim();
        if (ctitle) {
          var cstatus = (cm[1] === 'x' || cm[1] === 'X') ? ST_DONE : ST_OPEN;
          // 「任务（说明）」：末尾括号说明拆下，标题保留主干，便于与正则建议项去重
          var titlePart = ctitle;
          var pm = ctitle.match(/^(.*?)[（(]([^（）()]*)[）)]\s*$/);
          if (pm && pm[1].trim()) titlePart = pm[1].trim();
          out.push({ title: titlePart, status: cstatus, evidence: line.slice(0, 200) });
        }
        continue;
      }

      // —— Markdown 表格行：| c1 | c2 | c3 | … ——
      if (line.indexOf('|') >= 0) {
        var cells = line.split('|').map(function (c) { return c.trim(); }).filter(function (c) { return c !== ''; });
        if (cells.length < 2) continue;
        var hit = -1, status = null;
        for (var k = 0; k < cells.length; k++) {
          var st = classifyCell(cells[k]);
          if (st) { hit = k; status = st; break; }
        }
        if (hit < 0) continue;
        var title = pickTitle(cells, hit);
        if (title) out.push({ title: title, status: status, evidence: line.slice(0, 200) });
        continue;
      }

      // —— Tab 分隔表：任务\t状态\t原因 ——
      if (line.indexOf('\t') >= 0) {
        var parts = line.split('\t').map(function (c) { return c.trim(); }).filter(function (c) { return c !== ''; });
        if (parts.length < 2) continue;
        var st2 = classifyCell(parts[1]);
        if (st2) {
          out.push({ title: isSeqCell(parts[0]) ? '' : parts[0], status: st2, evidence: line.slice(0, 200) });
        }
        continue;
      }
    }

    // 去掉空标题项
    return out.filter(function (x) { return x.title && x.title.length > 0; });
  }

  /* ---------- 3. 状态类 ---------- */
  function PendingTracker(storage) {
    this.storage = storage || defaultStorage();
    this.state = this.storage.load() || { version: 1, items: [] };
    if (!Array.isArray(this.state.items)) this.state.items = [];
  }

  PendingTracker.prototype._save = function () {
    try { this.storage.save(this.state); } catch (e) { /* 存储失败不阻断 */ }
  };

  // 全部项：未完成在前（按「首次提出」createdAt 升序 = 时间线正序），已完成沉底（按 doneAt 降序）。
  // 可选 agent 过滤（各助手独立记忆）。
  PendingTracker.prototype.all = function (agent) {
    var items = this.state.items.filter(function (x) { return !agent || x.agent === agent; });
    var open = items.filter(function (x) { return x.status === ST_OPEN; })
      .sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
    var done = items.filter(function (x) { return x.status === ST_DONE; })
      .sort(function (a, b) { return (b.doneAt || 0) - (a.doneAt || 0); });
    return open.concat(done);
  };

  // 未完成项（清单主展示，标红）
  PendingTracker.prototype.open = function (agent) {
    return this.all(agent).filter(function (x) { return x.status === ST_OPEN; });
  };

  // 已完成项（打勾保留，不删除）
  PendingTracker.prototype.done = function (agent) {
    return this.all(agent).filter(function (x) { return x.status === ST_DONE; });
  };

  // 有记录的 agent 列表（供「哪些助手有待办」）
  PendingTracker.prototype.agents = function () {
    var set = {};
    this.state.items.forEach(function (x) { if (x.agent) set[x.agent] = true; });
    return Object.keys(set);
  };

  // 汇总（供红点/角标）；可选 agent
  PendingTracker.prototype.summary = function (agent) {
    return { open: this.open(agent).length, done: this.done(agent).length, total: this.all(agent).length };
  };

  // 喂入一段文本（某 agent 的一次输出），合并到清单。
  // meta.time = 消息时间戳（毫秒）。用它锚定 createdAt/updatedAt/doneAt，而非扫描时刻 Date.now()，
  // 这样「整条对话全量重扫」时时间戳稳定（幂等），且能按对话真实先后排序、跨轮次正确去重。
  PendingTracker.prototype.ingest = function (agent, text, meta) {
    var found = extractItems(text);
    if (!found.length) return { added: 0, reopened: 0, resolved: 0 };
    var now = Date.now();                                   // 「现在」仅用于缓冲期判断
    var t = (meta && meta.time) ? Number(meta.time) : now;  // 任务时间锚点 = 消息时间（缺省回落当前）
    var explicit = (meta && meta.source) === 'explicit';    // 显式（研究助手写清单）可信度 > 建议（正则扫历史）
    var self = this;
    var added = 0, reopened = 0, resolved = 0;

    found.forEach(function (f) {
      var fp = fingerprint(f.title);
      if (!fp) return;
      var existing = null;
      for (var i = 0; i < self.state.items.length; i++) {
        if (self.state.items[i].id === fp) { existing = self.state.items[i]; break; }
      }
      // 精确指纹未命中 → 模糊去重（编辑距离）：同义措辞（漏/多一两个字）合并为同一条，限定同 agent
      if (!existing) {
        for (var k = 0; k < self.state.items.length; k++) {
          var it = self.state.items[k];
          if (it.agent === (agent || '未知') && similarEnough(it.title, f.title)) { existing = it; break; }
        }
      }
      // 显式来源优先：研究助手显式写的可信度高于正则扫历史的建议，同款任务升级为「显式」
      if (existing && explicit && existing.source !== 'explicit') {
        existing.source = 'explicit';
      }

      if (f.status === ST_OPEN) {
        if (existing) {
          if (existing.status === ST_DONE) {
            // 已完成后又提到「未完成」：缓冲期内不回弹，超过缓冲期才重新打开
            if ((now - (existing.doneAt || 0)) > RESOLVE_GRACE_MS) {
              existing.status = ST_OPEN; existing.doneAt = null; reopened++;
              if (t > (existing.updatedAt || 0)) existing.updatedAt = t;
            }
          } else {
            // 仍 open：更新时间到「最新提及」的消息时间（max 语义，防乱序回拨；重扫幂等）
            if (t > (existing.updatedAt || 0)) existing.updatedAt = t;
          }
          // 保留最新证据；不覆盖 createdAt（「按时间顺序」锚定在首次提出时刻）
          if (f.evidence) existing.evidence = f.evidence;
        } else {
          self.state.items.push({
            id: fp, title: String(f.title).trim(), agent: agent || '未知',
            status: ST_OPEN, source: explicit ? 'explicit' : 'suggested',
            evidence: f.evidence || '', createdAt: t, updatedAt: t, doneAt: null,
            running: false, lastError: '',
          });
          added++;
        }
      } else { // done：自动收敛（在对话里被交代「已完成」）
        if (existing) {
          if (existing.status === ST_OPEN) {
            existing.status = ST_DONE; existing.doneAt = t; existing.updatedAt = t; resolved++;
          }
        } else if (explicit) {
          // 显式清单里的「已完成」项：新任务也入库为 done（保留打勾、不删）
          self.state.items.push({
            id: fp, title: String(f.title).trim(), agent: agent || '未知',
            status: ST_DONE, source: 'explicit',
            evidence: f.evidence || '', createdAt: t, updatedAt: t, doneAt: t,
          });
          added++;
        }
        // 建议来源的「已完成」新任务不主动入库（避免历史噪声填满）
      }
    });

    this._save();
    return { added: added, reopened: reopened, resolved: resolved };
  };

  // 手动完成
  PendingTracker.prototype.complete = function (id) {
    var it = this._find(id);
    if (!it) return false;
    it.status = ST_DONE; it.doneAt = Date.now(); it.updatedAt = Date.now();
    it.running = false; it.lastError = '';
    this._save();
    return true;
  };

  // 恢复为未完成
  PendingTracker.prototype.reopen = function (id) {
    var it = this._find(id);
    if (!it) return false;
    it.status = ST_OPEN; it.doneAt = null; it.updatedAt = Date.now();
    it.running = false;
    this._save();
    return true;
  };

  // 公开查找（派发执行前定位待办）
  PendingTracker.prototype.find = function (id) {
    return this._find(id);
  };

  // 标记「执行中」：点击派发后置 running=true，面板据此禁用重复派发
  PendingTracker.prototype.markRunning = function (id) {
    var it = this._find(id);
    if (!it) return false;
    it.running = true;
    it.updatedAt = Date.now();
    this._save();
    return true;
  };

  // 任务派发执行后的收尾：verdict = 'done' | 'blocked' | 'partial'
  // done → 自动打勾完成；blocked/partial → 保留 open，记录卡住原因（lastError），下轮可见
  PendingTracker.prototype.settle = function (id, verdict, reason) {
    var it = this._find(id);
    if (!it) return false;
    it.running = false;
    it.updatedAt = Date.now();
    if (verdict === 'done') {
      it.status = ST_DONE; it.doneAt = Date.now(); it.lastError = '';
    } else {
      it.status = ST_OPEN; it.doneAt = null;
      it.lastError = String(reason || '未完成（未说明原因）');
    }
    this._save();
    return true;
  };

  // —— 相关问题清单（发散式发掘）——
  // 加入/更新一个「相关问题」条目（去重靠标题指纹 + 模糊相似，限定同 agent）。
  // q = { title, value, anchor, agent, source }；已存在则刷新价值/锚点/来源，不回退状态。
  PendingTracker.prototype.addQuestion = function (q) {
    q = q || {};
    var title = String(q.title || '').trim();
    if (!title) return { ok: false, reason: 'empty', added: false };
    var fp = fingerprint(title);
    if (!fp) return { ok: false, reason: 'empty', added: false };
    var self = this;
    var existing = null;
    for (var i = 0; i < this.state.items.length; i++) {
      if (this.state.items[i].id === fp) { existing = this.state.items[i]; break; }
    }
    if (!existing) {
      for (var k = 0; k < this.state.items.length; k++) {
        var it = this.state.items[k];
        if (it.agent === (q.agent || '未知') && similarEnough(it.title, title)) { existing = it; break; }
      }
    }
    var now = Date.now();
    if (existing) {
      if (q.value) existing.value = String(q.value);
      if (q.anchor) existing.anchor = String(q.anchor);
      if (q.source) existing.source = String(q.source);
      if (existing.type !== 'question') existing.type = 'question';
      if (now > (existing.updatedAt || 0)) existing.updatedAt = now;
      this._save();
      return { ok: true, added: false, item: existing };
    }
    var item = {
      id: fp, type: 'question', title: title, agent: q.agent || '未知',
      status: ST_OPEN, source: q.source || 'discovered',
      value: String(q.value || ''), anchor: String(q.anchor || ''),
      evidence: '', createdAt: now, updatedAt: now, doneAt: null,
      running: false, lastError: '', answer: '', answerAt: null,
    };
    this.state.items.push(item);
    this._save();
    return { ok: true, added: true, item: item };
  };

  // 回答问题：记录答案并打勾完成（done）
  PendingTracker.prototype.answer = function (id, text) {
    var it = this._find(id);
    if (!it) return false;
    it.status = ST_DONE; it.doneAt = Date.now(); it.updatedAt = Date.now();
    it.answer = String(text || '').slice(0, 8000);
    it.answerAt = Date.now();
    it.running = false; it.lastError = '';
    this._save();
    return true;
  };

  // —— 详细步骤清单（路线图拆解，第三个清单）——
  // 加入/更新一条「步骤」条目（去重靠标题指纹 + 模糊相似，限定同 agent）。
  // s = { title, detail, order, agent, roadmap, roadmapId, source }；已存在则刷新详情/顺序/路线图，不回退状态。
  // createdAt = now + order，保证 open 步骤按「order 升序」展示（复用 all() 的 createdAt 排序）。
  PendingTracker.prototype.addStep = function (s) {
    s = s || {};
    var title = String(s.title || '').trim();
    if (!title) return { ok: false, reason: 'empty', added: false };
    var fp = fingerprint(title);
    if (!fp) return { ok: false, reason: 'empty', added: false };
    var self = this;
    var existing = null;
    for (var i = 0; i < this.state.items.length; i++) {
      if (this.state.items[i].id === fp) { existing = this.state.items[i]; break; }
    }
    if (!existing) {
      for (var k = 0; k < this.state.items.length; k++) {
        var it = this.state.items[k];
        if (it.agent === (s.agent || '未知') && similarEnough(it.title, title)) { existing = it; break; }
      }
    }
    var now = Date.now();
    if (existing) {
      if (s.detail) existing.detail = String(s.detail);
      if (s.roadmap) existing.roadmap = String(s.roadmap);
      if (s.roadmapId) existing.roadmapId = String(s.roadmapId);
      if (s.order != null) existing.order = Number(s.order);
      if (s.source) existing.source = String(s.source);
      if (existing.type !== 'step') existing.type = 'step';
      if (now > (existing.updatedAt || 0)) existing.updatedAt = now;
      this._save();
      return { ok: true, added: false, item: existing };
    }
    var order = Number(s.order || 0);
    var item = {
      id: fp, type: 'step', title: title, agent: s.agent || '未知',
      status: ST_OPEN, source: s.source || 'roadmap',
      detail: String(s.detail || ''), order: order,
      roadmap: String(s.roadmap || ''), roadmapId: String(s.roadmapId || ''),
      evidence: '', createdAt: now + order, updatedAt: now + order, doneAt: null,
      running: false, lastError: '', result: '',
    };
    this.state.items.push(item);
    this._save();
    return { ok: true, added: true, item: item };
  };

  // 确认「建议项」→ 转正式（source: suggested → explicit）
  PendingTracker.prototype.confirm = function (id) {
    var it = this._find(id);
    if (!it) return false;
    it.source = 'explicit'; it.updatedAt = Date.now();
    this._save();
    return true;
  };

  // 删除（彻底移除，允许再次捕获）
  PendingTracker.prototype.remove = function (id) {
    var before = this.state.items.length;
    this.state.items = this.state.items.filter(function (x) { return x.id !== id; });
    if (this.state.items.length === before) return false;
    this._save();
    return true;
  };

  // 清空已完成项
  PendingTracker.prototype.clearDone = function () {
    this.state.items = this.state.items.filter(function (x) { return x.status !== ST_DONE; });
    this._save();
  };

  PendingTracker.prototype._find = function (id) {
    for (var i = 0; i < this.state.items.length; i++) if (this.state.items[i].id === id) return this.state.items[i];
    return null;
  };

  /* ---------- 4. 默认存储（浏览器 localStorage；无则内存） ---------- */
  function defaultStorage() {
    var KEY = 'ingrid.pending-work';
    var store = { version: 1, items: [] };
    try {
      var raw = global.localStorage && global.localStorage.getItem(KEY);
      if (raw) store = JSON.parse(raw);
    } catch (e) { store = { version: 1, items: [] }; }
    return {
      load: function () { return store; },
      save: function (state) {
        store = state;
        try { if (global.localStorage) global.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
      },
    };
  }

  /* ---------- 5. 导出 ---------- */
  var api = {
    PendingTracker: PendingTracker,
    extractItems: extractItems,
    fingerprint: fingerprint,
    normalize: normalize,
    editDistance: editDistance,
    similarEnough: similarEnough,
    jaccard: jaccard,
    OPEN_WORDS: OPEN_WORDS,
    DONE_WORDS: DONE_WORDS,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.PendingTrackerCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
