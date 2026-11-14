/**
 * ============================================================
 *  eco-radar.js —— 「灵感目录」生态雷达：每日调研 DSH 插件生态
 *  ============================================================
 *
 *  职责：从 DeepSeek Harness（DSH）的插件生态里，找到「新出现」的插件，
 *  并按用户自己的用途板块（研究 / 设计 / 写作 / 文档 / 浏览器 / 图像 /
 *  代码 / 音乐）做本地关键词匹配，产出可解释的调研简报。
 *
 *  设计取舍（对齐工作台「关键词启发式，免费、可解释」的风格）：
 *    · 数据源：GitHub topic `dsh-plugin`（官方插件发现信号），按 star 降序；
 *    · 匹配：纯本地关键词，不调 LLM、不花钱、每步可解释；
 *    · 增量：对比上次调研的「已见清单」，只报新增，避免重复推送。
 *
 *  fetch 可注入（Node 全局 fetch；测试可传 mock），零第三方依赖。
 * ============================================================
 */
(function (global) {
  'use strict';

  /* ---------- 1. 板块匹配规则（关键词 → 用户用途板块） ---------- */
  var BOARD_RULES = [
    { id: 'research', label: '学术研究', emoji: '🔬', words: ['research', 'paper', 'citation', 'review', 'literature', 'academic', 'sota', 'thesis', '论文', '文献', '引用', '审稿', '学术', '研究', '检索'] },
    { id: 'design',   label: '设计与配色', emoji: '🎨', words: ['design', 'ui', 'ux', 'color', 'theme', 'visual', 'layout', 'typography', '配色', '设计', '界面', '视觉', '主题', '字体'] },
    { id: 'writing',  label: '写作与内容', emoji: '✍️', words: ['writing', 'content', 'blog', 'article', 'copy', '写作', '文案', '内容', '公众号', '文章', '润色'] },
    { id: 'office',   label: '文档与表格', emoji: '📄', words: ['doc', 'word', 'excel', 'ppt', 'pdf', 'sheet', 'slide', '文档', '表格', '幻灯片', '导出'] },
    { id: 'browser',  label: '浏览器与抓取', emoji: '🌐', words: ['browser', 'scrape', 'crawl', 'fetch', 'search', 'web', '浏览器', '爬虫', '抓取', '网页', '搜索'] },
    { id: 'media',    label: '图像与视频', emoji: '🎬', words: ['image', 'video', 'picture', 'photo', 'vision', '图片', '图像', '视频', '视觉', '识别', 'ocr'] },
    { id: 'code',     label: '代码与工程', emoji: '💻', words: ['code', 'git', 'terminal', 'shell', 'repo', 'dev', 'refactor', '代码', '编程', '终端', '仓库', '重构', '部署'] },
    { id: 'music',    label: '音乐创作', emoji: '🎵', words: ['music', 'audio', 'voice', 'sound', 'song', '音乐', '音频', '语音', '歌曲', '配乐'] },
  ];

  function boardMeta(id) {
    for (var i = 0; i < BOARD_RULES.length; i++) if (BOARD_RULES[i].id === id) return BOARD_RULES[i];
    return null;
  }

  /** 把一个仓库归到它命中的板块（可命中多个，按命中数排序） */
  function classifyPlugin(repo) {
    var blob = String((repo.name || '') + ' ' + (repo.description || '') + ' ' +
      ((repo.topics || []).join(' '))).toLowerCase();
    var hits = [];
    BOARD_RULES.forEach(function (r) {
      var n = 0;
      r.words.forEach(function (w) { if (w && blob.indexOf(w.toLowerCase()) >= 0) n++; });
      if (n > 0) hits.push({ board: r.id, label: r.label, emoji: r.emoji, score: n });
    });
    hits.sort(function (a, b) { return b.score - a.score; });
    return hits;
  }

  /** 把仓库数据规整成插件卡片（去掉不稳定的字段） */
  function normalizeRepo(repo) {
    var full = String(repo.full_name || repo.name || '');
    var hits = classifyPlugin(repo);
    return {
      full_name: full,
      name: String(repo.name || full),
      description: String(repo.description || '').slice(0, 200),
      stars: Number(repo.stargazers_count) || 0,
      url: String(repo.html_url || ''),
      topics: Array.isArray(repo.topics) ? repo.topics : [],
      pushed_at: String(repo.pushed_at || repo.updated_at || ''),
      boards: hits.map(function (h) { return h.board; }),
      boardLabels: hits.map(function (h) { return h.emoji + ' ' + h.label; }),
      hits: hits,
    };
  }

  /** 把调研结果拼成 markdown 简报 */
  function buildReport(result) {
    var lines = [];
    var d = new Date(result.fetchedAt || Date.now());
    var dateStr = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    lines.push('# 📡 灵感目录 · DSH 生态调研（' + dateStr + '）');
    lines.push('');
    if (!result.newCount) {
      lines.push('今日无新增插件。生态一切照旧，保持关注即可。');
      lines.push('');
      lines.push('（已累计追踪 ' + (result.seenCount || 0) + ' 个插件）');
      return lines.join('\n');
    }
    lines.push('本次发现 **' + result.newCount + '** 个新插件。');
    lines.push('');

    var matchedBoards = Object.keys(result.matches || {}).filter(function (k) {
      return result.matches[k].length > 0;
    });
    if (matchedBoards.length) {
      lines.push('## 按你的用途板块匹配');
      matchedBoards.forEach(function (bid) {
        var meta = boardMeta(bid) || { emoji: '📌', label: bid };
        lines.push('### ' + meta.emoji + ' ' + meta.label);
        result.matches[bid].forEach(function (p) {
          lines.push('- [' + p.name + '](' + p.url + ') ⭐' + p.stars + (p.description ? ' — ' + p.description : ''));
        });
        lines.push('');
      });
    }

    lines.push('## 全部新插件');
    result.newPlugins.forEach(function (p) {
      lines.push('- [' + p.name + '](' + p.url + ') ⭐' + p.stars + (p.description ? ' — ' + p.description : ''));
    });
    lines.push('');
    return lines.join('\n');
  }

  /**
   * 执行一次调研。
   * opts: { fetch, seen: [], perPage, source }
   * 返回 { ok, totalCount, newCount, newPlugins, matches, report, fetchedAt, seenCount }
   */
  async function runEcoRadar(opts) {
    var o = opts || {};
    var fetchFn = o.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!fetchFn) return { ok: false, error: '无可用 fetch（Node 需 >=18 或注入 fetch）' };
    var seen = Array.isArray(o.seen) ? o.seen : [];
    var perPage = Number(o.perPage) || 30;
    var url = o.source ||
      'https://api.github.com/search/repositories?q=topic:dsh-plugin&sort=stars&order=desc&per_page=' + perPage;

    var resp;
    try {
      resp = await fetchFn(url, {
        headers: {
          'User-Agent': 'Ingrid-AI-Agents-eco-radar',
          'Accept': 'application/vnd.github+json',
        },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined,
      });
    } catch (e) {
      return { ok: false, error: '请求 GitHub 失败：' + String((e && e.message) || e) };
    }
    if (!resp || !resp.ok) {
      var msg = 'HTTP ' + (resp ? resp.status : '?');
      try { var j = await resp.json(); if (j && j.message) msg = msg + ' · ' + j.message; } catch { /* 非 JSON */ }
      return { ok: false, error: 'GitHub API 返回 ' + msg };
    }
    var data;
    try { data = await resp.json(); } catch (e) { return { ok: false, error: '解析 GitHub 返回失败' }; }
    var items = (data && data.items) || [];

    var seenSet = {};
    seen.forEach(function (s) { seenSet[s] = true; });

    var newPlugins = [];
    items.forEach(function (repo) {
      var p = normalizeRepo(repo);
      if (seenSet[p.full_name]) return;
      newPlugins.push(p);
    });

    var matches = {};
    BOARD_RULES.forEach(function (r) { matches[r.id] = []; });
    newPlugins.forEach(function (p) {
      p.boards.forEach(function (bid) { matches[bid].push(p); });
    });
    // 每个板块只留前 5 个，避免简报过长
    Object.keys(matches).forEach(function (k) { matches[k] = matches[k].slice(0, 5); });

    var result = {
      ok: true,
      totalCount: Number(data.total_count) || items.length,
      newCount: newPlugins.length,
      newPlugins: newPlugins.slice(0, 30),
      matches: matches,
      fetchedAt: Date.now(),
      seenCount: seen.length + newPlugins.length,
    };
    result.report = buildReport(result);
    return result;
  }

  /* ---------- 导出 ---------- */
  var api = {
    BOARD_RULES: BOARD_RULES,
    boardMeta: boardMeta,
    classifyPlugin: classifyPlugin,
    normalizeRepo: normalizeRepo,
    buildReport: buildReport,
    runEcoRadar: runEcoRadar,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.EcoRadar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
