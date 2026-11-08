/**
 * 知识库智能整理（Digest）— local-first，无头 CLI
 *
 * 在「增量索引」之上，用本地 LLM 定期生成文献综述 / 概念笔记，写回 Obsidian 库，
 * 供定时自动化在应用未打开时也能运行。
 *
 * 用法：
 *   node kb-digest.js review [N]        # 生成最近 N 篇（默认 15）Zotero 文献综述
 *   node kb-digest.js concept "主题"     # 生成某主题的概念笔记（检索相关文献）
 *
 * 环境变量：
 *   OLLAMA_URL        覆盖 Ollama 地址（默认 http://127.0.0.1:11434）
 *   KB_DIGEST_MODEL   覆盖生成模型（默认 qwen3:32b）
 *
 * 产物落盘位置：<Obsidian 库>/_AI整理/ 目录
 */
'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { detectObsidianVaults } = require('./kb-engine.js');

const OLLAMA = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const MODEL = process.env.KB_DIGEST_MODEL || 'qwen3:32b';

/* ---------------- Zotero 元数据（快速，--meta-only 跳过 PDF 全文） ---------------- */
function getZoteroItems() {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'kb-zotero.py');
    execFile('python3', [script, '--meta-only'],
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 120000 },
      (err, so) => {
        if (err) return reject(err);
        try { resolve(JSON.parse(so)); } catch (e) { reject(new Error('解析 Zotero 输出失败')); }
      });
  });
}

/* ---------------- 本地 LLM（Ollama /v1/chat/completions，非流式） ---------------- */
async function llm(system, user) {
  const res = await fetch(OLLAMA + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      stream: false,
      temperature: 0.5,
    }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}

/* ---------------- 写回 Obsidian ---------------- */
function writeToVault(filename, content) {
  const vaults = detectObsidianVaults();
  const vault = vaults[0];
  if (!vault) throw new Error('未找到 Obsidian 库，跳过写回');
  const dir = path.join(vault, '_AI整理');
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, filename);
  fs.writeFileSync(fp, content, 'utf8');
  return fp;
}

function fmtDate(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function brief(it, n) {
  const authors = (it.authors || []).slice(0, 3).join(', ');
  const abs = (it.abstract || '').replace(/\s+/g, ' ').trim().slice(0, n || 300);
  return (it.title || '（无标题）') + '\n   作者: ' + (authors || '未知') + '  年份: ' + (it.year || '—') +
    '\n   摘要: ' + (abs || '（无摘要）');
}

const SYSTEM = '你是严谨的研究助手，帮助一位博士生整理文献。只依据提供的文献信息归纳，不臆造、不编造文献、不凭空添加未给出的结论。直接输出 Markdown 正文，不要用 ``` 代码块包裹。';

/* ---------------- 文献综述 ---------------- */
async function cmdReview(n) {
  n = n || 15;
  const items = await getZoteroItems();
  const sorted = items
    .filter((x) => x.title || x.abstract)
    .sort((a, b) => String(b.dateAdded || '').localeCompare(String(a.dateAdded || '')));
  const recent = sorted.slice(0, n);
  if (!recent.length) throw new Error('Zotero 无文献');

  const entries = recent.map((it, i) => '[' + (i + 1) + '] ' + brief(it)).join('\n\n');
  const user = '以下是我最近加入 Zotero 的 ' + recent.length + ' 篇文献（标题+摘要）。请生成一份文献综述：\n' +
    '1. 按研究主题聚类（2-4 个主题）\n' +
    '2. 每个主题概括核心研究问题、方法、主要发现\n' +
    '3. 指出主题间的关联与潜在研究空白\n' +
    '4. 用中文，结构化 Markdown 输出（标题用 ## 级别）\n\n文献列表：\n\n' + entries;

  const out = await llm(SYSTEM, user);
  const content = '# 文献综述（' + fmtDate() + '）\n\n' +
    '> 自动整理：基于最近 ' + recent.length + ' 篇 Zotero 文献，由本地模型 `' + MODEL + '` 生成。\n\n' + out + '\n';
  const fp = writeToVault('文献综述-' + fmtDate() + '.md', content);
  return { fp, count: recent.length };
}

/* ---------------- 概念笔记 ---------------- */
async function cmdConcept(topic) {
  const items = await getZoteroItems();
  const tl = String(topic || '').toLowerCase();
  const hits = items
    .filter((it) => ((it.title || '') + ' ' + (it.abstract || '')).toLowerCase().includes(tl))
    .slice(0, 10);
  if (!hits.length) return null;

  const entries = hits.map((it, i) => '[' + (i + 1) + '] ' + brief(it)).join('\n\n');
  const user = '围绕主题「' + topic + '」，以下是 ' + hits.length + ' 篇相关文献。请生成一份概念笔记：\n' +
    '1. 提炼该主题的 3-5 个关键概念，每个给出简明定义\n' +
    '2. 说明概念之间的关系\n' +
    '3. 归纳不同文献的共识与分歧\n' +
    '4. 指出值得进一步深挖的问题\n' +
    '5. 用中文，结构化 Markdown 输出（标题用 ## 级别）\n\n文献：\n\n' + entries;

  const out = await llm(SYSTEM, user);
  const content = '# 概念笔记：' + topic + '\n\n' +
    '> 自动整理：基于 ' + hits.length + ' 篇相关文献，由本地模型 `' + MODEL + '` 生成。\n\n' + out + '\n';
  const fp = writeToVault('概念笔记-' + topic + '-' + fmtDate() + '.md', content);
  return { fp, count: hits.length };
}

/* ---------------- 主入口 ---------------- */
async function main() {
  const cmd = process.argv[2] || 'review';
  if (cmd === 'concept') {
    const topic = process.argv[3];
    if (!topic) { console.error('usage: node kb-digest.js concept "主题"'); process.exit(1); }
    const r = await cmdConcept(topic);
    if (!r) { console.log('(无匹配文献)'); return; }
    console.log('written=' + r.fp + ' count=' + r.count);
  } else {
    const n = parseInt(process.argv[3], 10) || 15;
    const r = await cmdReview(n);
    console.log('written=' + r.fp + ' count=' + r.count);
  }
}

main().catch((e) => { console.error('kb-digest error:', e && e.message); process.exit(1); });
