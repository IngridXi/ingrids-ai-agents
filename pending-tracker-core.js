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

  // 未完成信号（按优先级先匹配；「未完成」须在「已完成」之前判断，故分开两张表）
  var OPEN_WORDS = [
    '未完成', '未开始', '未查到', '需补引', '需补', '未做', '仍未', '未覆盖',
    '待办', '待做', '待下载', '尚未', '还没', '未核实', '未证实', '欠着',
    '搁置', '未核', '未执行', '未列', '未上', '未换', '未抓', '未读',
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

  // 判断一个单元格是 open / done / null
  function classifyCell(cell) {
    var s = String(cell || '');
    for (var i = 0; i < OPEN_WORDS.length; i++) if (s.indexOf(OPEN_WORDS[i]) >= 0) return ST_OPEN;
    for (var j = 0; j < DONE_WORDS.length; j++) if (s.indexOf(DONE_WORDS[j]) >= 0) return ST_DONE;
    return null;
  }

  // 是否为「序号」单元格（#、1、2、① 等）
  function isSeqCell(cell) {
    var s = String(cell || '').trim();
    if (!s) return true;
    return /^#?\s*\d+\s*$/.test(s) || /^[①②③④⑤⑥⑦⑧⑨⑩]$/.test(s);
  }

  // 取「状态单元格」之前最近的一个「非序号」单元格作为任务名
  function pickTitle(cells, statusIdx) {
    for (var j = statusIdx - 1; j >= 0; j--) {
      if (!isSeqCell(cells[j])) return String(cells[j]).trim();
    }
    return '';
  }

  // 标题归一化：去前导序号、去 emoji/加粗/标点、压缩空白、转小写
  function normalize(title) {
    return String(title || '')
      .replace(/^#?\s*\d+[.、\)]\s*/, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\uFE0F✅❌✗✓⚠️→↓↑·•]/gu, '')
      .replace(/[*_`#|｜「」『』"']/g, '')
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

  // 从一段文本提取待做项：[{ title, status, evidence }]
  function extractItems(text) {
    var out = [];
    var s = String(text || '');
    if (!s) return out;

    var lines = s.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (HEADER_RE.test(line)) continue;

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
          var t2 = isSeqCell(parts[0]) ? (parts[1] || '') : parts[0];
          // 若第一列是序号，任务名其实在第二列（但第二列是状态），退回用第一列
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

  // 全部项（含 done，按 updatedAt 降序）；可选 agent 过滤（各助手独立记忆）
  PendingTracker.prototype.all = function (agent) {
    return this.state.items
      .filter(function (x) { return !agent || x.agent === agent; })
      .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
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

  // 喂入一段文本（某 agent 的一次输出），合并到清单
  PendingTracker.prototype.ingest = function (agent, text, meta) {
    var found = extractItems(text);
    if (!found.length) return { added: 0, reopened: 0, resolved: 0 };
    var now = Date.now();
    var self = this;
    var added = 0, reopened = 0, resolved = 0;

    found.forEach(function (f) {
      var fp = fingerprint(f.title);
      if (!fp) return;
      var existing = null;
      for (var i = 0; i < self.state.items.length; i++) {
        if (self.state.items[i].id === fp) { existing = self.state.items[i]; break; }
      }

      if (f.status === ST_OPEN) {
        if (existing) {
          if (existing.status === ST_DONE) {
            // 已完成后又提到「未完成」：缓冲期内不回弹，超过缓冲期才重新打开
            if ((now - (existing.doneAt || 0)) > RESOLVE_GRACE_MS) {
              existing.status = ST_OPEN; existing.doneAt = null; reopened++;
              existing.updatedAt = now;
            }
          }
          // 状态未变：只更新 evidence，不刷新 updatedAt（保证全量重扫幂等、排序稳定）
          if (f.evidence) existing.evidence = f.evidence;
        } else {
          self.state.items.push({
            id: fp, title: String(f.title).trim(), agent: agent || '未知',
            status: ST_OPEN, source: (meta && meta.source) || 'chat',
            evidence: f.evidence || '', createdAt: now, updatedAt: now, doneAt: null,
          });
          added++;
        }
      } else { // done：自动收敛
        if (existing && existing.status === ST_OPEN) {
          existing.status = ST_DONE; existing.doneAt = now; existing.updatedAt = now; resolved++;
        }
        // 已完成的「新」任务不主动入库（避免清单被历史噪声填满）
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
    this._save();
    return true;
  };

  // 恢复为未完成
  PendingTracker.prototype.reopen = function (id) {
    var it = this._find(id);
    if (!it) return false;
    it.status = ST_OPEN; it.doneAt = null; it.updatedAt = Date.now();
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
    OPEN_WORDS: OPEN_WORDS,
    DONE_WORDS: DONE_WORDS,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.PendingTrackerCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
