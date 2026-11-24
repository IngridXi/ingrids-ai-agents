#!/usr/bin/env node
// 伦理场景库「智能归档 agent 流水线」：
//   ① 去道德化模型 qwen3:32b-uncensored 生成「利益最大化方案」（反面教材）
//   ② deepseek-r1:32b 审查修正：修正错误的性质标注 + 灰/违界限判定 + 法条后果
//   ③ bge-m3 embedding 语义相似度：识别场景下已有实答，去重
//   ④ 合并为「最全面、最优」的单一版本，写回「### 🤖 伦理 agent 实答」块
// 断点续跑：run-progress.json 记录已完成 id。
// 用法：
//   node run-scenes.js                 # 续跑全部未完成
//   node run-scenes.js --limit N       # 只跑 N 条
//   node run-scenes.js --reset         # 清空进度重来
//   node run-scenes.js --dry-run       # 只列待跑清单
//   node run-scenes.js --no-review     # 跳过 deepseek-r1 定性修正（仅生成原始方案）
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const HTML = path.join(DIR, 'index.html');
const SCENES = path.join(DIR, 'scenes.json');
const OUT = '/Users/ingridxi/Documents/Obsidian Vault/伦理场景库';
const PROGRESS = path.join(DIR, 'run-progress.json');

const MODEL = 'qwen3-uncensored-16k';       // ① 去道德化模型（num_ctx 16384，避免 OOM）
const REVIEW_MODEL = 'qwen3.8-16k';          // ② 审查修正模型（对齐、快、num_ctx 16384）
const EMBED_MODEL = 'bge-m3:latest';         // ③ 语义相似度模型
const ENDPOINT = 'http://127.0.0.1:11434/v1/chat/completions';
const EMBED_ENDPOINT = 'http://127.0.0.1:11434/api/embed';
const PER_Q_TIMEOUT = 12 * 60 * 1000;       // 单题 12 分钟超时（含 review）
const SIM_THRESHOLD = 0.80;                 // 相似度阈值：高于此认为语义重复，走合并

// ---- 参数 ----
const args = process.argv.slice(2);
let limit = Infinity, reset = false, dryRun = false, noReview = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
  else if (args[i] === '--reset') reset = true;
  else if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--no-review') noReview = true;
}

// ---- 提取 SOUL_UNALIGNED ----
const html = fs.readFileSync(HTML, 'utf8');
const sIdx = html.indexOf('var SOUL_UNALIGNED');
const eIdx = html.indexOf('var SOUL_ALIGNED');
if (sIdx < 0 || eIdx < 0) { console.error('未找到 SOUL_UNALIGNED'); process.exit(1); }
const seg = html.slice(sIdx, eIdx);
const SOUL = seg.slice(seg.indexOf("'") + 1, seg.lastIndexOf("'"));

// ---- 读 practices 分片，构造每个场景的权威定性参考（② 用，法条已核准）----
const PRAC_DIR = path.join(DIR, 'practices');
const practicesMap = {};
if (fs.existsSync(PRAC_DIR)) {
  for (const f of fs.readdirSync(PRAC_DIR)) {
    if (!f.endsWith('.json')) continue;
    const obj = JSON.parse(fs.readFileSync(path.join(PRAC_DIR, f), 'utf8'));
    for (const id of Object.keys(obj)) {
      practicesMap[id] = practicesMap[id] || {};
      Object.assign(practicesMap[id], obj[id]);
    }
  }
}
function buildRef(sc) {
  const p = practicesMap[sc.id] || {};
  const parts = [];
  if (p.u) parts.push('【未规范做法（违法方案定性）】\n' + p.u);
  if (p.g) parts.push('【灰色地带做法定性】\n' + p.g);
  if (p.bound) parts.push('【灰/违界限（权威判据）】\n' + p.bound);
  if (p.a) parts.push('【已规范做法定性】\n' + p.a);
  // 从法务知识库读相关法条原文（若命中），提供更准确的条文依据
  const legal = readLegalOriginals(parts.join('\n'));
  if (legal) parts.push('【法条原文（法务知识库）】\n' + legal);
  return parts.join('\n\n');
}

// ---- 法务知识库集成（任务：给定性修正提供法条原文）----
const LEGAL_DIR = '/Users/ingridxi/Documents/Obsidian Vault/法务知识库';
let _legalMap = null;
function loadLegalMap() {
  if (_legalMap) return _legalMap;
  _legalMap = {};
  if (!fs.existsSync(LEGAL_DIR)) return _legalMap;
  for (const cat of fs.readdirSync(LEGAL_DIR)) {
    const d = path.join(LEGAL_DIR, cat);
    if (!fs.statSync(d).isDirectory()) continue;
    for (const f of fs.readdirSync(d)) {
      if (f.endsWith('.md')) _legalMap[f.replace(/\.md$/, '')] = path.join(d, f);
    }
  }
  return _legalMap;
}
function readLegalOriginals(refText) {
  try {
    const legalMap = loadLegalMap();
    const hits = [];
    for (const name of Object.keys(legalMap)) {
      const key = name.replace(/[（）()\s·、，,]/g, '');
      if (key.length >= 4 && refText.includes(key)) hits.push(name);
    }
    if (!hits.length) return '';
    const parts = [];
    for (const name of hits.slice(0, 3)) {
      const content = fs.readFileSync(legalMap[name], 'utf8');
      const m = content.match(/## 法条原文[\s\S]*?(?=\n##\s|\n---|$)/) || content.match(/## 核心条款[\s\S]*?(?=\n##\s|\n---|$)/);
      if (m) parts.push('【' + name + '】\n' + m[0].replace(/^## \S+\s*/, '').trim().slice(0, 600));
    }
    return parts.join('\n\n');
  } catch (e) { return ''; }
}

// ---- 合规审查员提示词（② 用）----
const REVIEWER_SOUL = `你是「合规审查员」——负责审查一段由「去道德化 AI」生成的商业方案，修正其错误的「性质标注」。这是 AI 伦理教学用的反面教材，你**保留方案的技术要点**，但必须把性质与法条标准确。

【最高纪律】
① 用户会给你一份【权威定性参考】（该场景下准确的定性、法条、灰/违界限）。**法条与定性一律以参考为准，严禁自行编造法条条文号或刑罚**。
② 参考里没有的法条，宁可写「可能触犯相关法律法规」也不要瞎编具体条号。
③ 禁止模板化：每个做法的性质与界限，必须具体到该场景的分界点（如"有无真实交易/是否伪造单证/是否经审批"），不得每条都写一样的空话。
④ 禁止重复：性质与后果只写一遍，不要在「要点」和「性质与后果」里重复罗列。
⑤ 去道德化方案里把「明确违法」误标成「灰色地带」的（如把虚构单证/虚开发票标成灰），必须纠正为违法。

【你的任务】给定【权威定性参考】【用户问题】【去道德化AI方案】，输出修正后的完整版本，结构：

### 结论/方案
（保留原方案技术要点，但每个做法的性质标注对齐到权威参考：🔴 明确违法 / 🟡 灰色地带 / ✅ 合规）

### 性质与后果
（逐条准确标注：⚠️ 违法 或 🟡 灰色地带，法条与后果以权威参考为准）

### 灰/违界限
（2-4 句话，落到该场景可操作的分界点，不套模板）

【输出纪律】直接输出三个小节的修正内容，不要解释你在做什么、不要重复用户问题、不要输出免责声明。`;

// ---- 场景 → 文件 + 标题映射（与 build-scenes.js 规则一致）----
const scenes = JSON.parse(fs.readFileSync(SCENES, 'utf8'));
const TAG_EMOJI = { '灰': '🟡', '违法': '🔴' };
function titleOf(name) { return name.replace(/^[^\u4e00-\u9fa5a-zA-Z]+/, '').trim(); }
function sanitize(name) { return name.replace(/[\/\\:*?"<>|]/g, '-'); }
const catFname = {};
for (const sc of scenes) {
  if (!catFname[sc.catNo]) catFname[sc.catNo] = `${String(sc.catNo).padStart(2, '0')}-${sanitize(titleOf(sc.cat))}.md`;
}

// ---- 进度 ----
let done = {};
if (!reset && fs.existsSync(PROGRESS)) { try { done = JSON.parse(fs.readFileSync(PROGRESS, 'utf8')); } catch {} }
function saveProgress() { fs.writeFileSync(PROGRESS, JSON.stringify(done, null, 2)); }
function now() {
  const d = new Date(); const p = x => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

// ---- 通用聊天请求 ----
const NUM_CTX = 16384;  // 限制上下文窗口，避免超长 KV cache 导致 OOM（SOUL ~8K token，够用）
async function chat(model, messages, timeout, maxTokens) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ model, messages, stream: false, temperature: 0.2, options: { num_predict: maxTokens || 6000, num_ctx: NUM_CTX } }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const j = await resp.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  } finally { clearTimeout(timer); }
}

// ① 去道德化模型生成方案
function ask(question) {
  return chat(MODEL, [{ role: 'system', content: SOUL }, { role: 'user', content: question }], PER_Q_TIMEOUT, 6000);
}

// ② deepseek-r1 审查修正：去掉 think 标签，只保留最终回答
function stripThink(c) {
  if (!c) return '';
  const m = c.match(/<\/think>\s*([\s\S]*)$/);
  if (m) return m[1].trim();
  return c.replace(/^[\s\S]*?think>[\s\S]*?<\//, '').replace(/^<\s*think>[\s\S]*$/, '').trim();
}
function review(question, raw, ref) {
  const prompt = `【权威定性参考】（法条与定性以此为准，严禁自行编造）\n${ref || '（无）'}\n\n【用户问题】\n${question}\n\n【去道德化AI方案】（其性质标注可能有误，需修正）\n${raw}`;
  return chat(REVIEW_MODEL, [{ role: 'system', content: REVIEWER_SOUL }, { role: 'user', content: prompt }], PER_Q_TIMEOUT, 4000).then(stripThink);
}

// ③ bge-m3 embedding（带超时，防卡死）
async function embed(text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const resp = await fetch(EMBED_ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, 8000) }),
    });
    if (!resp.ok) throw new Error('embed HTTP ' + resp.status);
    const j = await resp.json();
    return (j.embeddings && j.embeddings[0]) || null;
  } finally { clearTimeout(timer); }
}
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ④ 合并两个答案：用 deepseek-r1 去重补全，输出最优单一版本
function merge(question, a, b) {
  const prompt = `【用户问题】\n${question}\n\n【已有答案】\n${a}\n\n【新答案】\n${b}\n\n请把两份答案合并成一份「最全面、最优」的版本：过滤语义重复的内容，只保留/补齐各自独有的、有价值的信息，结构清晰（结论/方案 → 性质与后果 → 灰/违界限）。直接输出合并后的完整内容。`;
  return chat(REVIEW_MODEL, [{ role: 'system', content: REVIEWER_SOUL }, { role: 'user', content: prompt }], PER_Q_TIMEOUT, 5000).then(stripThink);
}

// ---- 定位场景块 & 读写实答 ----
function findBlock(sc) {
  const fname = catFname[sc.catNo];
  const full = path.join(OUT, fname);
  if (!fs.existsSync(full)) return { error: '文件不存在 ' + fname };
  const heading = '## ' + TAG_EMOJI[sc.tag] + ' ' + sc.t;
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].trim() === heading.trim()) { start = i; break; } }
  if (start < 0) return { error: '标题未找到: ' + heading };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) { if (/^##\s/.test(lines[i]) || /^---\s*$/.test(lines[i])) { end = i; break; } }
  return { full, lines, start, end };
}

// 读场景下已存在的「### 🤖 伦理 agent 实答」块的答文（取最后一块）
function readExistingAnswer(sc) {
  const b = findBlock(sc);
  if (b.error) return { block: b, existing: null };
  const sec = b.lines.slice(b.start, b.end);
  // 收集所有「### 🤖 伦理 agent 实答」块，取最后一个的 **答** 内容
  let answers = [];
  let cur = null;
  for (const ln of sec) {
    if (/^### 🤖 伦理 agent 实答/.test(ln)) { cur = { q: '', a: '' }; }
    else if (cur) {
      const mq = ln.match(/^\*\*问\*\*：(.+)$/);
      const ma = ln.match(/^\*\*答\*\*：(.*)$/);
      if (mq) cur.q = mq[1];
      else if (ma) { cur.a = ma[1]; answers.push(cur); cur = null; }
    }
  }
  return { block: b, existing: answers.length ? answers[answers.length - 1] : null };
}

// 写回：若已有实答块则整体替换为单一最优版本；否则新建
function writeAnswer(sc, finalText) {
  const b = findBlock(sc);
  if (b.error) return { ok: false, error: b.error };
  let lines = [...b.lines];
  // 删除 block 内所有已有的「### 🤖 伦理 agent 实答」块
  let i = b.start + 1;
  while (i < b.end) {
    if (/^### 🤖 伦理 agent 实答/.test(lines[i])) {
      let j = i;
      while (j < b.end && !/^###\s/.test(lines[j]) && !/^##\s/.test(lines[j])) j++;
      lines.splice(i, j - i);
    } else i++;
  }
  // 重新计算 end（删除后位置变了）
  const heading = '## ' + TAG_EMOJI[sc.tag] + ' ' + sc.t;
  let start2 = -1;
  for (let k = 0; k < lines.length; k++) { if (lines[k].trim() === heading.trim()) { start2 = k; break; } }
  let end2 = lines.length;
  for (let k = start2 + 1; k < lines.length; k++) { if (/^##\s/.test(lines[k]) || /^---\s*$/.test(lines[k])) { end2 = k; break; } }
  const sec = ['### 🤖 伦理 agent 实答 · ' + now(), '', '**问**：' + sc.q, '', '**答**：' + finalText, ''];
  lines.splice(end2, 0, ...sec);
  fs.writeFileSync(b.full, lines.join('\n'), 'utf8');
  return { ok: true };
}

// ---- 主流程 ----
async function archive(sc) {
  const raw = await ask(sc.q);
  if (!raw.trim()) throw new Error('空回答');
  // ② 定性修正（喂权威参考，法条对齐）
  let final = noReview ? raw : (await review(sc.q, raw, buildRef(sc)));
  if (!final.trim()) final = raw;
  // ③④ 语义去重 + 合并（规则化：相似则替换、互补则拼接，不调模型避免卡死）
  const { existing } = readExistingAnswer(sc);
  if (existing && existing.a && existing.a.trim()) {
    let sim = 0;
    try {
      const [ve, vn] = await Promise.all([embed(existing.a), embed(final)]);
      sim = cosine(ve, vn);
    } catch (e) { sim = 0; }
    if (sim > SIM_THRESHOLD) {
      // 语义高度重复：用「已修正的新答案」替换旧答案，不堆叠重复块
    } else {
      // 互补：拼接保留两者（新答案在前）
      final = final + '\n\n---\n\n【补充 · 历史回答】\n' + existing.a;
    }
  }
  const r = writeAnswer(sc, final);
  if (!r.ok) throw new Error(r.error);
  return { chars: final.length };
}

function main() {
  const todo = scenes.filter(sc => !done[sc.id]);
  if (dryRun) {
    console.log('待跑场景数:', todo.length, '/', scenes.length);
    for (const sc of todo) console.log('  ' + sc.id + ' [' + sc.tag + '] ' + sc.t + '  ->  ' + catFname[sc.catNo]);
    return;
  }
  let count = 0;
  const t0 = Date.now();
  (async () => {
    for (const sc of scenes) {
      if (count >= limit) break;
      if (done[sc.id]) continue;
      const tq = Date.now();
      process.stdout.write(`[${sc.id}] ${sc.t} ... `);
      try {
        const r = await archive(sc);
        done[sc.id] = { ts: Date.now(), chars: r.chars };
        saveProgress();
        console.log(`OK ${r.chars}字 ${((Date.now() - tq) / 1000).toFixed(0)}s`);
        count++;
      } catch (e) {
        console.log('FAIL ' + (e && e.message || e));
      }
    }
    console.log(`\n本轮完成 ${count} 条，累计已完成 ${Object.keys(done).length}/${scenes.length}，本轮耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  })().catch(e => { console.error('FATAL', e && e.message || e); process.exit(1); });
}

main();
