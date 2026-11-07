/**
 * ============================================================
 *  skills-core.js — 板块 / Skill 注册表 / 推荐 / 渐进式载入 / 预设
 *  ============================================================
 *
 *  设计原则（回答「skill 该做成 agent，还是做成列表」）：
 *    Skill = 能力（一份说明书），Agent = 角色（谁来做），Engine = 脑子（哪家模型）。
 *    三者解耦：skill 挂在「这一次任务」上，随用随挂、用完即卸；
 *    不绑模型（换模型不用重配）、不升格成 agent（按钮数量不涨）。
 *
 *  v3：Board（板块）升为一级组织
 *    板块 = 用户的一个用途（research / writing / …），只放亲自挑进来的 skill。
 *    本机 WorkBuddy 的 200+ 个 skill 只是「可选导入源」，默认一个都不启用，
 *    避免把别的平台（海归海 / 音乐 / 公众号）的能力塞进个人工作台。
 *    一条 skill 可属于多个板块；预设 = 板块 + agent + 若干 skill。
 *
 *  渐进式披露：索引只留 name + 一句话 description；只有选中的 1–3 个才读正文。
 *
 *  零依赖。浏览器 <script src>，Node require() 后取 globalThis.SkillsCore
 * ============================================================
 */
(function (global) {
  'use strict';

  /* ---------- 1. frontmatter 解析（够用即可，不引 YAML 库） ---------- */
  function parseFrontmatter(text) {
    var src = String(text || '');
    var meta = {};
    var m = src.match(/^\uFEFF?---\s*\r?\n([\s\S]*?)\r?\n---/);
    if (!m) return { meta: meta, body: src };

    var lines = m[1].split(/\r?\n/);
    var key = null, buf = [];
    function flush() {
      if (!key) return;
      var v = buf.join(' ').trim().replace(/^["']|["']$/g, '');
      if (v) meta[key] = v;
      key = null; buf = [];
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var km = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
      if (km) {
        flush();
        key = km[1];
        var v = km[2].trim();
        // >- / > / | / |- 是 YAML 的折叠或字面块，后面跟缩进行
        buf = /^(>-|>|\||\|-)\s*$/.test(v) ? [] : [v];
      } else if (key && /^\s+\S/.test(line)) {
        buf.push(line.trim());
      } else if (key && !line.trim()) {
        buf.push('');
      }
    }
    flush();
    return { meta: meta, body: src.slice(m[0].length).replace(/^\s*\r?\n/, '') };
  }

  /* ---------- 2. 分类规则 + 关键词（用于自动推荐） ---------- */
  var CATEGORY_RULES = [
    { id: 'research', label: '学术研究', words: ['审稿', '论文', '文献', '综述', '研究', '学术', '引用', '证据', '导师', '去ai', 'ai味', '润色', '理论', '方法', 'thesis', 'review', 'citation', '实验', '设计', '假设', '变量', '样本', '拆解', '建构', '提炼', '投稿', '开题', '研究方案', '论证', '审计', '可重复性', '复现', 'sota', '前沿', '检索', '搜索', '基准', '数据', '统计', '分析', '效应量', '显著性', '提案', '计划书', '基金', '申请', 'proposal', 'grant', 'survey', '汇报', '演讲', '答辩', '海报', 'presentation', '讲清'] },
    { id: 'writing', label: '写作与内容', words: ['写作', '文案', '公众号', '推文', '文章', '报告', '文档', '排版', '新闻', '博客', 'markdown'] },
    { id: 'music', label: '音乐创作', words: ['写歌', '歌词', '作词', '作曲', '编曲', '音乐', '歌曲', '翻唱', '配乐', '旋律', '调性', '和弦', 'bgm', 'suno', 'ace-step'] },
    { id: 'design', label: '设计与配色', words: ['配色', '色板', '主色', '色阶', '深色模式', '界面', 'ui', '视觉', '品牌色', '设计', '排版', '字体', '布局', '动效', '交互', '视觉方向', '品味', '间距', '栅格', '字号', '字重', '留白', '对齐', '溢出', '空态', '加载态', '响应式'] },
    { id: 'office', label: '文档与表格', words: ['pdf', 'word', 'excel', 'ppt', '表格', '幻灯片', 'docx', 'xlsx', 'pptx', '图表'] },
    { id: 'browser', label: '浏览器与抓取', words: ['浏览器', '爬虫', '抓取', '网页', '截图', '自动化', 'cdp', 'chrome', '数据采集'] },
    { id: 'media', label: '图像与视频', words: ['图片', '图像', '视频', '3d', '模型', '动画', '生成图', '抠图', '修复', '水印'] },
    { id: 'code', label: '代码与工程', words: ['代码', '编程', '重构', '调试', '部署', '仓库', 'api', '函数', '测试', '框架'] },
    { id: 'general', label: '其他', words: [] },
  ];

  function classify(text) {
    var t = String(text || '').toLowerCase();
    var best = 'general', hit = 0;
    for (var i = 0; i < CATEGORY_RULES.length; i++) {
      var r = CATEGORY_RULES[i], n = 0;
      for (var j = 0; j < r.words.length; j++) if (t.indexOf(r.words[j]) >= 0) n++;
      if (n > hit) { hit = n; best = r.id; }
    }
    return { category: best, hits: hit };
  }
  function categoryLabel(id) {
    for (var i = 0; i < CATEGORY_RULES.length; i++) if (CATEGORY_RULES[i].id === id) return CATEGORY_RULES[i].label;
    return '其他';
  }
  function taskCategories(task) {
    var t = String(task || '').toLowerCase(), out = {};
    CATEGORY_RULES.forEach(function (r) {
      var n = 0;
      r.words.forEach(function (w) { if (t.indexOf(w) >= 0) n++; });
      if (n) out[r.id] = n;
    });
    return out;
  }
  // 中英文混合二元组，算 description 与任务的重合度（无需分词库）
  function grams(s) {
    var t = String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '');
    var out = {};
    for (var i = 0; i < t.length - 1; i++) out[t.slice(i, i + 2)] = 1;
    return out;
  }
  function overlap(a, b) {
    var ga = grams(a), gb = grams(b), n = 0;
    for (var k in ga) if (gb[k]) n++;
    return n;
  }
  function estTokens(s) { return Math.ceil(String(s || '').length / 4); }

  /* ---------- 3. BoardRegistry：板块（一级组织） ---------- */
  function defaultBoardStorage() {
    var KEY = 'ingrid.boards';
    return {
      load: function () {
        try { var r = global.localStorage.getItem(KEY); return r ? JSON.parse(r) : []; }
        catch (e) { return []; }
      },
      save: function (b) {
        try { global.localStorage.setItem(KEY, JSON.stringify(b)); } catch (e) {}
      },
    };
  }
  function normalizeBoard(b) {
    return {
      id: String(b.id || ''),
      name: String(b.name || '未命名板块'),
      emoji: b.emoji || '📁',
      desc: String(b.desc || ''),
      skillIds: Array.isArray(b.skillIds) ? b.skillIds.slice() : [],
      defaultEngine: b.defaultEngine || '',
      color: b.color || '#7c6fd6',
    };
  }
  function BoardRegistry(boards, storage) {
    this.storage = storage || defaultBoardStorage();
    var initial = Array.isArray(boards) && boards.length ? boards : [];
    if (!initial.length) {
      try { initial = this.storage.load() || []; } catch (e) { initial = []; }
    }
    this.boards = (initial || []).map(normalizeBoard);
    this._save();
  }
  BoardRegistry.prototype._save = function () {
    try { this.storage.save(this.boards); } catch (e) {}
    return this;
  };
  BoardRegistry.prototype.list = function () { return this.boards.slice(); };
  BoardRegistry.prototype.get = function (id) {
    for (var i = 0; i < this.boards.length; i++) if (this.boards[i].id === id) return this.boards[i];
    return null;
  };
  BoardRegistry.prototype.create = function (b) {
    var board = normalizeBoard(Object.assign({
      id: 'b' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
    }, b || {}));
    this.boards.push(board); this._save(); return board;
  };
  BoardRegistry.prototype.update = function (id, patch) {
    var b = this.get(id); if (!b) return null;
    Object.assign(b, patch); this._save(); return b;
  };
  BoardRegistry.prototype.remove = function (id) {
    this.boards = this.boards.filter(function (b) { return b.id !== id; });
    this._save(); return this;
  };
  BoardRegistry.prototype.addSkill = function (id, skillId) {
    var b = this.get(id); if (!b) return null;
    if (b.skillIds.indexOf(skillId) < 0) b.skillIds.push(skillId);
    this._save(); return b;
  };
  BoardRegistry.prototype.removeSkill = function (id, skillId) {
    var b = this.get(id); if (!b) return null;
    b.skillIds = b.skillIds.filter(function (s) { return s !== skillId; });
    this._save(); return b;
  };
  BoardRegistry.prototype.skillIds = function (id) {
    var b = this.get(id); return b ? b.skillIds.slice() : [];
  };

  /* ---------- 4. SkillRegistry ---------- */
  function normalize(r) {
    var boardIds = Array.isArray(r.boardIds) ? r.boardIds.slice()
      : String(r.boards || '').split(/[,，\s]+/).filter(Boolean);
    return {
      id: String(r.id || ''),
      name: String(r.name || r.id || '未命名技能'),
      description: String(r.description || ''),
      category: r.category || 'general',
      scope: r.scope || 'builtin',              // builtin | local | custom
      source: String(r.source || ''),
      rel: String(r.rel || ''),
      bytes: Number(r.bytes) || 0,
      estTokens: Number(r.estTokens) || Math.ceil((Number(r.bytes) || 0) / 4),
      executable: !!r.executable,               // 带脚本 / allowed-tools，需单独授权
      allowedTools: r.allowedTools || '',
      model: String(r.model || ''),
      boardIds: boardIds,
      enabled: r.enabled !== false,             // 本机扫描到的默认不启用
      favorite: !!r.favorite,
    };
  }

  /**
   * opts.maxSkills     一次最多挂载几个（默认 3，UI 可放宽到 5）
   * opts.maxTotalChars 注入正文总上限（默认 24000 字符 ≈ 6–8k token）
   * opts.maxEachChars  单份正文上限（默认 12000）
   */
  function SkillRegistry(records, opts) {
    var o = opts || {};
    this.maxSkills = o.maxSkills || 3;
    this.maxTotalChars = o.maxTotalChars || 24000;
    this.maxEachChars = o.maxEachChars || 12000;
    this.records = (records || []).map(normalize);
    this._map = {};
    var self = this;
    this.records.forEach(function (r) { self._map[r.id] = r; });
  }
  SkillRegistry.prototype.all = function () { return this.records.slice(); };
  SkillRegistry.prototype.size = function () { return this.records.length; };
  SkillRegistry.prototype.byId = function (id) { return this._map[id] || null; };
  SkillRegistry.prototype.enabled = function () {
    return this.records.filter(function (r) { return r.enabled; });
  };
  SkillRegistry.prototype.stats = function () {
    var s = { total: this.records.length, enabled: 0, executable: 0, bytes: 0, estTokens: 0, byScope: {} };
    this.records.forEach(function (r) {
      if (r.enabled) s.enabled++;
      if (r.executable) s.executable++;
      s.bytes += r.bytes; s.estTokens += r.estTokens;
      s.byScope[r.scope] = (s.byScope[r.scope] || 0) + 1;
    });
    return s;
  };
  SkillRegistry.prototype.inBoard = function (boardId) {
    return this.records.filter(function (r) {
      return r.enabled && (!boardId || r.boardIds.indexOf(boardId) >= 0);
    });
  };
  // 供 search 复用：停用 / 未启用的技能不出现在工作台
  SkillRegistry.prototype._visible = function (r, opts) {
    var o = opts || {};
    if (o.enabledOnly !== false && !r.enabled) return false;
    if (o.boardId && r.boardIds.indexOf(o.boardId) < 0) return false;
    if (o.includeLocal === false && r.scope === 'local') return false;
    return true;
  };
  SkillRegistry.prototype.groups = function (boardId) {
    var out = {};
    this.inBoard(boardId).forEach(function (r) { (out[r.category] = out[r.category] || []).push(r); });
    return out;
  };
  /** opts: { boardId, enabledOnly, includeLocal } */
  SkillRegistry.prototype.search = function (q, limit, opts) {
    var o = opts || {}, term = String(q || '').trim().toLowerCase(), self = this;
    var rows = this.records.filter(function (r) { return self._visible(r, o); });
    if (term) {
      rows = rows.filter(function (r) {
        return (r.name + ' ' + r.description + ' ' + r.rel + ' ' + r.allowedTools).toLowerCase().indexOf(term) >= 0;
      });
    }
    rows = rows.slice().sort(function (a, b) { return (b.favorite - a.favorite) || (a.estTokens - b.estTokens); });
    return limit ? rows.slice(0, limit) : rows;
  };
  /** 按任务文字推荐；opts: { boardId, limit } —— 只在本板块已启用的 skill 里挑 */
  SkillRegistry.prototype.recommend = function (task, opts) {
    var o = opts || {}, cats = taskCategories(task), t = String(task || '').toLowerCase();
    var pool = this.search('', 0, { boardId: o.boardId, enabledOnly: true });
    var scored = [];
    pool.forEach(function (r) {
      var score = 0, reasons = [];
      if (cats[r.category]) { score += 3 + Math.min(3, cats[r.category]); reasons.push(categoryLabel(r.category)); }
      var nameWords = r.name.toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5]+/).filter(function (w) { return w.length >= 2; });
      nameWords.forEach(function (w) { if (t.indexOf(w) >= 0) { score += 4; reasons.push('名称匹配'); } });
      var ov = overlap(task, r.description);
      if (ov) { score += Math.min(4, ov * 0.5); reasons.push('描述相关'); }
      if (r.favorite) { score += 2; reasons.push('常用'); }
      if (r.executable) score -= 0.5;   // 第一版只注入说明书，可执行型略降权
      if (score > 0 || r.favorite) scored.push({ skill: r, score: score, reasons: reasons.slice(0, 2) });
    });
    scored.sort(function (a, b) { return b.score - a.score || a.skill.estTokens - b.skill.estTokens; });
    if (!scored.length) {
      return pool.slice(0, o.limit || this.maxSkills).map(function (r) {
        return { skill: r, score: 0, reasons: ['本板块默认'] };
      });
    }
    return scored.slice(0, o.limit || this.maxSkills);
  };
  /** 估算挂载成本：{ count, bytes, tokens, perEngine } */
  SkillRegistry.prototype.estimate = function (ids, engines) {
    var self = this, out = { count: 0, bytes: 0, tokens: 0, perEngine: {} };
    var list = (ids || []).map(function (id) { return self.byId(id); }).filter(Boolean);
    out.count = list.length;
    list.forEach(function (r) {
      out.bytes += r.bytes;
      // estTokens 由扫描端按「字符数」算好，中文不会被 UTF-8 字节数放大 3 倍
      out.tokens += Math.min(r.estTokens, Math.ceil(self.maxEachChars / 4));
    });
    out.tokens = Math.min(out.tokens, Math.ceil(self.maxTotalChars / 4));
    var e = engines || {};
    for (var k in e) {
      var p = e[k] && e[k].price;
      out.perEngine[k] = p ? (out.tokens * p.in / 1e6) : 0;
    }
    return out;
  };
  /**
   * 把选中技能正文拼成可注入 soul 的字符串。
   * entries: [{ id, name, body }] → { text, tokens, ids, truncated }
   */
  SkillRegistry.prototype.buildContext = function (entries) {
    var self = this, parts = [], total = 0, truncated = false, ids = [];
    (entries || []).forEach(function (e, i) {
      if (total >= self.maxTotalChars) { truncated = true; return; }
      var body = String(e.body || '');
      if (body.length > self.maxEachChars) { body = body.slice(0, self.maxEachChars); truncated = true; }
      if (total + body.length > self.maxTotalChars) {
        body = body.slice(0, Math.max(0, self.maxTotalChars - total)); truncated = true;
      }
      if (!body.trim()) return;
      total += body.length; ids.push(e.id);
      parts.push('【已挂载技能 ' + (i + 1) + '/' + (entries || []).length + '：' + (e.name || e.id) + '】\n' +
        body.trim() + (truncated ? '\n（本技能正文过长，已截断）' : ''));
    });
    var text = parts.length
      ? '以下是本次任务临时挂载的技能说明书，请严格依照其中的方法与规范完成任务。任务结束后无需记住它们。\n\n' + parts.join('\n\n')
      : '';
    return { text: text, tokens: estTokens(text), ids: ids, truncated: truncated };
  };
  SkillRegistry.prototype.toggleFavorite = function (id) {
    var r = this.byId(id); if (!r) return null;
    r.favorite = !r.favorite; return r.favorite;
  };
  SkillRegistry.prototype.setEnabled = function (id, on) {
    var r = this.byId(id); if (!r) return null;
    r.enabled = !!on; return r;
  };

  /* ---------- 5. PresetStore：常用组合（板块 + agent + skills + 任务） ---------- */
  function defaultPresetStorage() {
    var KEY = 'ingrid.presets';
    return {
      load: function () {
        try { var r = global.localStorage.getItem(KEY); return r ? JSON.parse(r) : []; }
        catch (e) { return []; }
      },
      save: function (list) { try { global.localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {} },
    };
  }
  function PresetStore(storage) {
    this.storage = storage || defaultPresetStorage();
    try { var r = this.storage.load(); this.presets = Array.isArray(r) ? r : []; }
    catch (e) { this.presets = []; }
  }
  PresetStore.prototype._save = function () {
    try { this.storage.save(this.presets); } catch (e) {}
    return this;
  };
  PresetStore.prototype.list = function (boardId) {
    return boardId ? this.presets.filter(function (p) { return p.boardId === boardId; }) : this.presets.slice();
  };
  PresetStore.prototype.get = function (id) {
    for (var i = 0; i < this.presets.length; i++) if (this.presets[i].id === id) return this.presets[i];
    return null;
  };
  PresetStore.prototype.create = function (p) {
    var preset = Object.assign({
      id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: '未命名预设', emoji: '⚡', tag: '', boardId: '', agentIds: [], skillIds: [],
      task: '', mode: 'parallel', createdAt: Date.now(),
    }, p || {});
    this.presets.push(preset); this._save(); return preset;
  };
  PresetStore.prototype.remove = function (id) {
    this.presets = this.presets.filter(function (p) { return p.id !== id; });
    this._save(); return this;
  };

  /* ---------- 导出 ---------- */
  global.SkillsCore = {
    parseFrontmatter: parseFrontmatter,
    classify: classify,
    categoryLabel: categoryLabel,
    taskCategories: taskCategories,
    estTokens: estTokens,
    CATEGORY_RULES: CATEGORY_RULES,
    BoardRegistry: BoardRegistry,
    SkillRegistry: SkillRegistry,
    PresetStore: PresetStore,
  };
})(typeof window !== 'undefined' ? window : globalThis);
