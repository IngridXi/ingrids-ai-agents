/**
 * second-brain-core.js — 本地第二大脑（借鉴 NicholasSpisak/second-brain 的 LLM Wiki 模式）
 *
 * 把一个目录（默认 Obsidian 库）组织成「收件箱 → 结构化 wiki → 双向链接」的第二大脑：
 *
 *   <vault>/
 *   ├── raw/             收件箱：丢原始材料（文章、笔记、转录、网页抓取）
 *   │   └── archive/     ingest 后自动归档
 *   └── wiki/            结构化知识（LLM 维护）
 *       ├── sources/     每个来源一篇总结
 *       ├── entities/    人物·组织·产品·工具
 *       ├── concepts/    概念·框架·理论
 *       ├── synthesis/   对比·分析·主题
 *       ├── index.md     总目录
 *       └── log.md       操作记录
 *
 * 核心能力：
 *   - ingest(vault, {llm})   收件箱 → 提炼 → 写 wiki 页面 → 更新 index/log → 归档
 *   - lint(vault)            健康检查：坏 [[wikilink]]、index 与页面清单不一致
 *   - rebuildIndex(vault)    重建 index.md
 *
 * LLM 可选：opts.llm 是 async (content, filename) => {title, category, markdown}；
 *   没传或返回 null/抛错时自动降级为「直接归档」——原始内容包一层 frontmatter 落到 sources/。
 *
 * 零依赖（Node 内置 fs/path），挂 globalThis.SecondBrain + module.exports。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CATEGORIES = ['sources', 'entities', 'concepts', 'synthesis'];
const CATEGORY_LABEL = { sources: '来源', entities: '实体', concepts: '概念', synthesis: '综合' };

function slugTitle(t) {
  const s = String(t || '').trim()
    .replace(/[\\/:*?"<>|#\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, 60) || '未命名';
}

function extractLinks(md) {
  const links = new Set();
  const re = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let m;
  while ((m = re.exec(md))) links.add(m[1].trim());
  return Array.from(links);
}

function buildFrontmatter(title, category, tags, source) {
  const lines = ['---', 'title: ' + JSON.stringify(title), 'category: ' + category];
  if (source) lines.push('source: ' + JSON.stringify(source));
  lines.push('tags:');
  (tags || []).forEach((t) => lines.push('  - ' + JSON.stringify(String(t))));
  lines.push('---', '');
  return lines.join('\n');
}

function normCategory(c) {
  const s = String(c || 'sources').toLowerCase();
  return CATEGORIES.indexOf(s) >= 0 ? s : 'sources';
}

function wikiDirs(vault) {
  const wiki = path.join(vault, 'wiki');
  const out = { wiki, raw: path.join(vault, 'raw'), archive: path.join(vault, 'raw', 'archive') };
  CATEGORIES.forEach((c) => { out[c] = path.join(wiki, c); });
  out.index = path.join(wiki, 'index.md');
  out.log = path.join(wiki, 'log.md');
  return out;
}

function ensureDirs(vault) {
  const d = wikiDirs(vault);
  fs.mkdirSync(d.wiki, { recursive: true });
  fs.mkdirSync(d.raw, { recursive: true });
  fs.mkdirSync(d.archive, { recursive: true });
  CATEGORIES.forEach((c) => fs.mkdirSync(d[c], { recursive: true }));
  return d;
}

// 降级：无 LLM 时，原始内容包一层 frontmatter 落到 sources/
function fallbackPage(content, filename) {
  const title = slugTitle(filename.replace(/\.md$/i, ''));
  const tags = extractLinks(content).slice(0, 10);
  const markdown = buildFrontmatter(title, 'sources', tags, 'raw/' + filename) + content.trim();
  return { title, category: 'sources', markdown };
}

/** 扫描 wiki/ 下所有页面：{ title(文件名), relPath, links[], category } */
function scanWiki(vault) {
  const d = wikiDirs(vault);
  const pages = [];
  if (!fs.existsSync(d.wiki)) return pages;
  function walk(dir, cat) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(full, cat); continue; }
      if (!/\.md$/i.test(ent.name)) continue;
      if (ent.name === 'index.md' || ent.name === 'log.md') continue;
      let content = '';
      try { content = fs.readFileSync(full, 'utf8'); } catch { /* 忽略 */ }
      const rel = path.relative(d.wiki, full).split(path.sep).join('/');
      pages.push({ title: ent.name.replace(/\.md$/i, ''), relPath: rel, category: cat, links: extractLinks(content) });
    }
  }
  CATEGORIES.forEach((c) => walk(d[c], c));
  return pages;
}

/* ---------------- ingest ---------------- */
async function ingest(vault, opts) {
  opts = opts || {};
  const d = ensureDirs(vault);
  let files;
  try { files = fs.readdirSync(d.raw).filter((f) => /\.md$/i.test(f)); }
  catch { return { ok: false, error: '收件箱不可读：' + d.raw }; }
  if (!files.length) return { ok: true, ingested: 0, message: '收件箱为空，没有可 ingest 的材料' };

  const llm = (typeof opts.llm === 'function') ? opts.llm : null;
  const results = [];
  for (const f of files) {
    const src = path.join(d.raw, f);
    let content;
    try { content = fs.readFileSync(src, 'utf8'); } catch (e) { results.push({ file: f, error: '读取失败' }); continue; }
    if (!content.trim()) { results.push({ file: f, error: '空文件，跳过' }); continue; }

    // 1) LLM 提炼（可选），失败降级
    let page = null;
    if (llm) {
      try { page = await llm(content, f); } catch { page = null; }
      // 校验返回
      if (!page || typeof page !== 'object' || !page.markdown) page = null;
    }
    if (!page) page = fallbackPage(content, f);

    const category = normCategory(page.category);
    const title = slugTitle(page.title || f.replace(/\.md$/i, ''));
    const markdown = String(page.markdown || content);

    // 2) 写 wiki 页面
    let target = path.join(d[category], title + '.md');
    if (fs.existsSync(target)) target = path.join(d[category], title + '-' + Date.now().toString(36).slice(-4) + '.md');
    fs.writeFileSync(target, markdown, 'utf8');

    // 3) 归档原始文件
    let arch = path.join(d.archive, f);
    if (fs.existsSync(arch)) arch = path.join(d.archive, Date.now().toString(36).slice(-4) + '-' + f);
    fs.renameSync(src, arch);

    results.push({ file: f, category, title, target: path.relative(vault, target), links: extractLinks(markdown).length });
  }

  // 4) 更新 index + log
  rebuildIndex(vault);
  const logLine = '[' + new Date().toISOString() + '] ingest ' + results.length + ' 篇：' +
    results.map((r) => r.title || r.file).join('、');
  try { fs.appendFileSync(d.log, logLine + '\n', 'utf8'); } catch { /* 忽略 */ }

  const errCount = results.filter((r) => r.error).length;
  return { ok: true, ingested: results.length - errCount, results, index: d.index };
}

/* ---------------- lint ---------------- */
function lint(vault) {
  const d = wikiDirs(vault);
  if (!fs.existsSync(d.wiki)) return { ok: true, pages: 0, brokenLinks: [], index: d.index, message: 'wiki 目录还不存在，先 ingest 一次' };
  const pages = scanWiki(vault);
  const byTitle = {};
  pages.forEach((p) => { byTitle[p.title.toLowerCase()] = p; });

  const broken = [];
  const seen = new Set();
  pages.forEach((p) => {
    p.links.forEach((ln) => {
      const key = ln.split('/').pop().toLowerCase();
      if (!byTitle[key] && !seen.has(key)) {
        seen.add(key);
        broken.push({ link: ln, from: p.relPath });
      }
    });
  });

  // index.md 与页面清单一致性
  let indexMissing = [], indexExtra = [];
  try {
    const indexText = fs.readFileSync(d.index, 'utf8');
    const indexed = new Set(extractLinks(indexText).map((l) => l.split('/').pop().toLowerCase()));
    pages.forEach((p) => { if (!indexed.has(p.title.toLowerCase())) indexMissing.push(p.relPath); });
    // index 里提到但实际不存在的页面
    const have = new Set(pages.map((p) => p.title.toLowerCase()));
    extractLinks(indexText).forEach((l) => { const k = l.split('/').pop().toLowerCase(); if (!have.has(k)) indexExtra.push(l); });
  } catch { /* index 不存在 */ }

  return { ok: true, pages: pages.length, brokenLinks: broken, indexMissing, indexExtra, index: d.index };
}

/* ---------------- rebuildIndex ---------------- */
function rebuildIndex(vault) {
  const d = ensureDirs(vault);
  const pages = scanWiki(vault);
  const byCat = {};
  pages.forEach((p) => { (byCat[p.category] = byCat[p.category] || []).push(p); });

  const lines = ['# 第二大脑 · 索引', '',
    '> 由 ingest 自动维护。共 ' + pages.length + ' 个页面。', ''];
  CATEGORIES.forEach((c) => {
    const list = (byCat[c] || []).sort((a, b) => a.title.localeCompare(b.title));
    lines.push('## ' + CATEGORY_LABEL[c] + '（' + list.length + '）');
    if (!list.length) { lines.push('_（暂无）_', ''); return; }
    list.forEach((p) => lines.push('- [[' + p.relPath.replace(/\.md$/i, '') + '|' + p.title + ']]'));
    lines.push('');
  });
  fs.writeFileSync(d.index, lines.join('\n'), 'utf8');
  return { ok: true, index: d.index, pages: pages.length };
}

const api = { ingest, lint, rebuildIndex, scanWiki, CATEGORIES, CATEGORY_LABEL, buildFrontmatter, extractLinks };
if (typeof globalThis !== 'undefined') globalThis.SecondBrain = api;
module.exports = api;
