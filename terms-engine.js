/* ============================================================
 * terms-engine.js — 术语提取与知识图谱引擎（local-first）
 *
 * 职责：从 Zotero 文献（标题 + 摘要）用本地 LLM 批量提取核心术语，
 *       计算术语共现关系（在同一篇文献共同出现 → 边），
 *       把结果写进 Obsidian 库（每个术语一个 .md + [[双链]] + 总览 Mermaid 图），
 *       让 Obsidian 的 Graph View 自动形成「术语网状图」。
 *
 * LLM 由 main.js 注入（复用 completeChatStream，走本地 Ollama）。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function safeName(name) {
  return String(name || '未命名').replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '').trim() || '未命名';
}

/* ---------------- 提取 prompt ---------------- */
function extractPrompt(batch) {
  const lines = batch.map(function (d, i) {
    return '文献[' + (i + 1) + '] 标题：' + (d.title || '（无标题）') +
      '\n摘要：' + String(d.abstract || '').slice(0, 900);
  }).join('\n\n');
  return [
    {
      role: 'system',
      content: '你是学术文献的术语提取助手。从给定文献的标题和摘要中，提取值得学习的核心术语：学术概念、理论、方法、模型、商业/行业词汇。为每个术语写一句通俗易懂的中文解释，并归类。只输出 JSON，不要任何多余文字、解释或 markdown 代码块。',
    },
    {
      role: 'user',
      content: '请从下面文献中提取术语，并对每个术语标注它出现在哪些文献（用文献编号数组）。\n\n' +
        lines + '\n\n' +
        '输出格式（严格 JSON，不要代码块包裹）：\n' +
        '{"terms":[{"term":"术语原文","zh":"通俗中文解释","category":"理论|方法|概念|商业词汇|工具","docs":[1,3]}]}\n' +
        '若没有值得提取的术语，输出 {"terms":[]}',
    },
  ];
}

/* ---------------- 容错解析 LLM 返回的 JSON ---------------- */
function parseTermsJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/```(?:json)?/gi, '');
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  try {
    const j = JSON.parse(t);
    if (j && Array.isArray(j.terms)) return j.terms;
  } catch (err) { /* fallthrough */ }
  const s2 = t.indexOf('[');
  const e2 = t.lastIndexOf(']');
  if (s2 >= 0 && e2 > s2) {
    try { const a = JSON.parse(t.slice(s2, e2 + 1)); if (Array.isArray(a)) return a; } catch (err2) { /* ignore */ }
  }
  return [];
}

/* ---------------- 类别归一化 ---------------- */
function normCategory(c) {
  const m = String(c || '').trim();
  if (/理论|学派|主义/.test(m)) return '理论';
  if (/方法|模型|框架|范式/.test(m)) return '方法';
  if (/商业|商务|行业|管理|营销|金融|经济|供应链|运营/.test(m)) return '商业词汇';
  if (/工具|软件|技术|平台|协议|标准/.test(m)) return '工具';
  return '概念';
}

/* ---------------- 共现边（所有术语之间共享文献即相连，保证网状图完整无孤点） ---------------- */
function buildEdges(termMap, termList) {
  const names = termList.map(function (t) { return t.term; });
  const edges = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = termMap.get(names[i]);
      const b = termMap.get(names[j]);
      if (!a || !b) continue;
      let w = 0;
      a.docs.forEach(function (k) { if (b.docs.has(k)) w++; });
      if (w > 0) edges.push({ a: names[i], b: names[j], w: w });
    }
  }
  return edges;
}

/* ---------------- 笔记渲染 ---------------- */
function renderTermNote(term, info, relatedTerms) {
  const rel = relatedTerms.map(function (r) { return '- [[' + r + ']]'; }).join('\n');
  const refs = (info.titles || []).map(function (t) { return '- ' + t; }).join('\n');
  const tags = ['术语库', '术语', info.category];
  return '---\ntype: term\nterm: ' + JSON.stringify(term) + '\ncategory: ' + info.category +
    '\ntags:\n  - ' + tags.join('\n  - ') + '\nsource: Zotero\n---\n\n' +
    '# ' + term + '\n\n' +
    '> ' + info.category + '\n\n' +
    '## 通俗解释\n' + (info.zh || term) + '\n\n' +
    (refs ? '## 出处文献\n' + refs + '\n\n' : '') +
    (rel ? '## 相关术语\n' + rel + '\n' : '');
}

function mermaidGraph(terms, edges) {
  const id = {};
  terms.forEach(function (t, i) { id[t.term] = 'T' + i; });
  const lines = ['graph TD'];
  terms.forEach(function (t) { lines.push('  ' + id[t.term] + '["' + t.term.replace(/"/g, "'") + '"]'); });
  (edges || []).forEach(function (e) {
    if (id[e.a] && id[e.b]) lines.push('  ' + id[e.a] + ' --- ' + id[e.b]);
  });
  return lines.join('\n');
}

function renderOverview(terms, edges, meta) {
  const byCat = {};
  terms.forEach(function (t) {
    const c = t.category || '概念';
    (byCat[c] = byCat[c] || []).push(t.term);
  });
  const cats = Object.keys(byCat);
  const catMd = cats.map(function (c) {
    return '### ' + c + '\n' + byCat[c].map(function (t) { return '- [[' + t + ']]'; }).join('\n');
  }).join('\n\n');

  return '# 术语总览\n\n' +
    '> 由 Ingrid\'s AI Agents 从 Zotero 自动提取，共 ' + (meta.total || terms.length) + ' 个术语。' +
    '每个术语是一个笔记，用双链互相关联；在 Obsidian 打开「图谱视图（Graph View）」即可看到网状图。\n\n' +
    '> **只想看术语网状图？** 在 Obsidian 图谱视图左上角的过滤框输入 `path:术语库`，' +
    '就能只显示术语笔记、隐藏掉「文献综述 / 概念笔记」等其他笔记。\n\n' +
    '## 按类别\n\n' + catMd + '\n\n' +
    '## 关系图\n\n```mermaid\n' + mermaidGraph(terms, edges) + '\n```\n';
}

/* ---------------- 主流程 ---------------- */
/**
 * opts: {
 *   items: [{key,title,abstract,authors,year,venue,dateAdded}...]   // Zotero 文献（已按需排序）
 *   llm: (messages) => Promise<string>                              // 返回完整文本
 *   vaultPath: string|null                                          // Obsidian 库路径
 *   batchSize, maxItems, topK
 *   onProgress: (phase, done, total) => void
 * }
 * 返回：{ ok, terms, allTermCount, edges, noteCount, overviewPath, vaultPath, error }
 */
async function buildTermsGraph(opts) {
  opts = opts || {};
  const items = (opts.items || []).filter(function (d) { return d && (d.title || d.abstract); });
  const llm = opts.llm;
  const vaultPath = opts.vaultPath || null;
  const batchSize = opts.batchSize || 10;
  const maxItems = opts.maxItems || 200;
  const topK = opts.topK || 80;
  const onProgress = opts.onProgress || function () {};
  const prevState = (opts.prevState && typeof opts.prevState === 'object') ? opts.prevState : null;

  if (!items.length) return { ok: false, error: 'Zotero 里没有可提取的文献（请先在 Zotero 添加文献）' };
  if (typeof llm !== 'function') return { ok: false, error: '未提供 LLM 调用（需本地 Ollama 运行）' };

  const selected = items.slice(0, maxItems);

  // 1) 从上次状态恢复 termMap（增量：已构建的术语不重新跑 LLM）
  const termMap = new Map();
  if (prevState && prevState.terms) {
    Object.keys(prevState.terms).forEach(function (term) {
      const t = prevState.terms[term] || {};
      termMap.set(term, {
        term: term,
        zh: t.zh || '',
        category: t.category || '概念',
        docs: new Set(Array.isArray(t.docs) ? t.docs : []),
        titles: Array.isArray(t.titles) ? t.titles : [],
      });
    });
  }

  // 2) 过滤已处理文献，只对新文献跑 LLM（自动跳过已构建完成的）
  const processedKeys = new Set(prevState && prevState.docs ? Object.keys(prevState.docs) : []);
  const todo = selected.filter(function (d) { return !processedKeys.has(d.key); });
  const skippedCount = selected.length - todo.length;
  let llmOk = false;

  for (let i = 0; i < todo.length; i += batchSize) {
    const batch = todo.slice(i, i + batchSize);
    onProgress('extract', Math.min(i + batchSize, todo.length), todo.length);

    let text;
    try {
      text = await llm(extractPrompt(batch));
      llmOk = true;
    } catch (e) {
      if (!llmOk) {
        return { ok: false, error: '本地大模型（Ollama）调用失败，请先启动 Ollama：' + String(e && e.message || e) };
      }
      break; // 后续批次失败则停止，保留已提取结果
    }

    const rawTerms = parseTermsJson(text);
    rawTerms.forEach(function (rt) {
      const term = String((rt && rt.term) || '').trim();
      if (!term || term.length > 60) return;
      const info = termMap.get(term) || { term: term, zh: '', category: '概念', docs: new Set(), titles: [] };
      if (rt.zh) info.zh = String(rt.zh).trim();
      info.category = normCategory((rt && rt.category) || info.category);
      const docs = Array.isArray(rt && rt.docs) ? rt.docs : [];
      docs.forEach(function (di) {
        const idx = parseInt(di, 10) - 1;
        if (idx >= 0 && idx < batch.length) {
          const d = batch[idx];
          if (d && d.key) info.docs.add(d.key);
          if (d && d.title && info.titles.indexOf(d.title) < 0) info.titles.push(d.title);
        }
      });
      termMap.set(term, info);
    });
  }
  onProgress('extract', todo.length, todo.length);

  if (!termMap.size) return { ok: false, error: '未提取到术语（文献可能缺少标题/摘要，或模型未就绪）' };

  // 3) 计算 terms / topK / 共现边（合并旧术语 + 新术语）
  const terms = Array.from(termMap.values()).map(function (info) {
    return { term: info.term, zh: info.zh, category: info.category, freq: info.docs.size, titles: info.titles };
  }).sort(function (a, b) { return b.freq - a.freq; });

  const topTerms = terms.slice(0, topK);
  // 共现边在所有术语之间计算（而非仅 topK 内），保证每个术语笔记都有「相关术语」双链，
  // Obsidian 网状图不再出现孤点；topK 只影响总览图里「列出」多少个术语。
  const edges = buildEdges(termMap, terms);

  // 4) 构建新状态（已处理文献标记 + 术语全量），供 main.js 持久化
  const newDocs = {};
  if (prevState && prevState.docs) Object.keys(prevState.docs).forEach(function (k) { newDocs[k] = prevState.docs[k]; });
  todo.forEach(function (d) { newDocs[d.key] = d.title || ''; });
  const newTermsState = {};
  termMap.forEach(function (info, term) {
    newTermsState[term] = { zh: info.zh, category: info.category, docs: Array.from(info.docs), titles: info.titles };
  });
  const newState = { v: 1, docs: newDocs, terms: newTermsState };

  // 5) 写 Obsidian（只要给出库路径就重写全部术语笔记，保证「相关术语」双链与 #术语库 标签始终最新）
  let noteCount = 0;
  let overviewPath = '';
  if (vaultPath) {
    try {
      const dir = path.join(vaultPath, '术语库');
      fs.mkdirSync(dir, { recursive: true });
      for (const t of terms) {
        const related = edges
          .filter(function (e) { return e.a === t.term || e.b === t.term; })
          .map(function (e) { return e.a === t.term ? e.b : e.a; });
        const uniqRel = Array.from(new Set(related)).slice(0, 12);
        const content = renderTermNote(t.term, { zh: t.zh, category: t.category, titles: t.titles }, uniqRel);
        fs.writeFileSync(path.join(dir, safeName(t.term) + '.md'), content, 'utf8');
        noteCount++;
      }
      overviewPath = path.join(dir, '术语总览.md');
      fs.writeFileSync(overviewPath, renderOverview(topTerms, edges, { total: terms.length }), 'utf8');
    } catch (e) {
      return { ok: false, error: '写入 Obsidian 失败：' + String(e && e.message || e) };
    }
  }

  return {
    ok: true,
    terms: topTerms,
    allTermCount: terms.length,
    edges: edges.slice(0, 200),
    noteCount: noteCount,
    overviewPath: overviewPath,
    vaultPath: vaultPath,
    skippedCount: skippedCount,
    processedCount: todo.length,
    state: newState,
  };
}

module.exports = { buildTermsGraph, parseTermsJson, safeName, extractPrompt };
