#!/usr/bin/env node
// 批量把场景库 304 题通过本地未规范模型(qwen3:32b-uncensored)跑一遍，
// 每条回答归档到 Obsidian 场景库对应场景的 ## 标题下（🤖 伦理 agent 实答）。
// 断点续跑：run-progress.json 记录已完成 id，已完成的自动跳过。
// 用法：
//   node run-scenes.js                 # 续跑全部未完成
//   node run-scenes.js --limit N       # 只跑 N 条
//   node run-scenes.js --reset         # 清空进度重来
//   node run-scenes.js --dry-run       # 只列待跑清单，不真正跑
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const HTML = path.join(DIR, 'index.html');
const SCENES = path.join(DIR, 'scenes.json');
const OUT = '/Users/ingridxi/Documents/Obsidian Vault/伦理场景库';
const PROGRESS = path.join(DIR, 'run-progress.json');

const MODEL = 'qwen3:32b-uncensored';
const ENDPOINT = 'http://127.0.0.1:11434/v1/chat/completions';
const PER_Q_TIMEOUT = 10 * 60 * 1000; // 单题 10 分钟超时

// ---- 参数 ----
const args = process.argv.slice(2);
let limit = Infinity;
let reset = false;
let dryRun = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
  else if (args[i] === '--reset') reset = true;
  else if (args[i] === '--dry-run') dryRun = true;
}

// ---- 提取 SOUL_UNALIGNED ----
const html = fs.readFileSync(HTML, 'utf8');
const sIdx = html.indexOf('var SOUL_UNALIGNED');
const eIdx = html.indexOf('var SOUL_ALIGNED');
if (sIdx < 0 || eIdx < 0) { console.error('未找到 SOUL_UNALIGNED'); process.exit(1); }
const seg = html.slice(sIdx, eIdx);
const SOUL = seg.slice(seg.indexOf("'") + 1, seg.lastIndexOf("'"));

// ---- 场景 → 文件 + 标题映射（与 build-scenes.js 规则一致）----
const scenes = JSON.parse(fs.readFileSync(SCENES, 'utf8'));
const TAG_EMOJI = { '灰': '🟡', '违法': '🔴' };
function titleOf(name) { return name.replace(/^[^\u4e00-\u9fa5a-zA-Z]+/, '').trim(); }
function sanitize(name) { return name.replace(/[\/\\:*?"<>|]/g, '-'); }
const catFname = {};
for (const sc of scenes) {
  if (!catFname[sc.catNo]) {
    catFname[sc.catNo] = `${String(sc.catNo).padStart(2, '0')}-${sanitize(titleOf(sc.cat))}.md`;
  }
}

// ---- 进度 ----
let done = {};
if (!reset && fs.existsSync(PROGRESS)) {
  try { done = JSON.parse(fs.readFileSync(PROGRESS, 'utf8')); } catch {}
}
function saveProgress() { fs.writeFileSync(PROGRESS, JSON.stringify(done, null, 2)); }
function now() {
  const d = new Date();
  const p = x => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function ask(question) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PER_Q_TIMEOUT);
  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'system', content: SOUL }, { role: 'user', content: question }],
        stream: false, temperature: 0.2,
        options: { num_predict: 6000 },
      }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const j = await resp.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  } finally { clearTimeout(timer); }
}

function archive(sc, answer) {
  const fname = catFname[sc.catNo];
  const full = path.join(OUT, fname);
  if (!fs.existsSync(full)) return { ok: false, error: '文件不存在 ' + fname };
  const heading = '## ' + TAG_EMOJI[sc.tag] + ' ' + sc.t;
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].trim() === heading.trim()) { start = i; break; } }
  if (start < 0) return { ok: false, error: '标题未找到: ' + heading };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) || /^---\s*$/.test(lines[i])) { end = i; break; }
  }
  const sec = ['### 🤖 伦理 agent 实答 · ' + now(), '', '**问**：' + sc.q, '', '**答**：' + answer, ''];
  lines.splice(end, 0, ...sec);
  fs.writeFileSync(full, lines.join('\n'), 'utf8');
  return { ok: true };
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
        const answer = await ask(sc.q);
        if (!answer.trim()) throw new Error('空回答');
        const r = archive(sc, answer);
        if (!r.ok) throw new Error(r.error);
        done[sc.id] = { ts: Date.now(), chars: answer.length };
        saveProgress();
        const dt = ((Date.now() - tq) / 1000).toFixed(0);
        console.log(`OK ${answer.length}字 ${dt}s`);
        count++;
      } catch (e) {
        console.log('FAIL ' + (e && e.message || e));
      }
    }
    const total = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`\n本轮完成 ${count} 条，累计已完成 ${Object.keys(done).length}/${scenes.length}，本轮耗时 ${total}s`);
  })().catch(e => { console.error('FATAL', e && e.message || e); process.exit(1); });
}

main();
