#!/usr/bin/env node
// 法务知识库「涉及场景」反向映射：
//   把每条法条 → 关联到伦理场景库中引用该法条/相关关键词的场景，
//   写入法条 md 的「## 涉及场景」章节（替换原有的空白/待补充）。
// 用法：
//   node legal-map-scenes.js --dry-run   # 只打印映射，不写入
//   node legal-map-scenes.js             # 实际写入
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const OUT = '/Users/ingridxi/Documents/Obsidian Vault/法务知识库';
const SCENES_OUT = '/Users/ingridxi/Documents/Obsidian Vault/伦理场景库';
const dryRun = process.argv.includes('--dry-run');

// ---- 读数据 ----
const idx = JSON.parse(fs.readFileSync(path.join(DIR, 'legal-index.json'), 'utf8'));
const scenes = JSON.parse(fs.readFileSync(path.join(DIR, 'scenes.json'), 'utf8'));

const practicesMap = {};
for (const f of fs.readdirSync(path.join(DIR, 'practices'))) {
  if (!f.endsWith('.json')) continue;
  const o = JSON.parse(fs.readFileSync(path.join(DIR, 'practices', f), 'utf8'));
  for (const id of Object.keys(o)) { practicesMap[id] = practicesMap[id] || {}; Object.assign(practicesMap[id], o[id]); }
}

// ---- 场景 → 文件名/标题映射（与 build-scenes.js 一致）----
const TAG_EMOJI = { '灰': '🟡', '违法': '🔴' };
function titleOf(name) { return name.replace(/^[^\u4e00-\u9fa5a-zA-Z]+/, '').trim(); }
function sanitize(name) { return name.replace(/[\/\\:*?"<>|]/g, '-'); }
const catFname = {};
for (const sc of scenes) {
  if (!catFname[sc.catNo]) catFname[sc.catNo] = `${String(sc.catNo).padStart(2, '0')}-${sanitize(titleOf(sc.cat))}.md`;
}

// ---- 归一化：小写 + 去标点/空白（保留中英文与数字）----
function norm(s) {
  return (s || '').toLowerCase().replace(/[《》「」『』（）()\[\]【】\s·、，,。；;：:""''\/\\\-—_—…]+/g, '');
}

function scenarioText(sc) {
  const p = practicesMap[sc.id] || {};
  return [sc.t, sc.q, p.u, p.g, p.bound, p.a].filter(Boolean).join(' ');
}

// ---- 每条法条的匹配键 ----
function matchKeys(item) {
  const s = new Set();
  s.add(item.name);
  for (const part of item.name.split('/')) {
    const p = part.trim();
    s.add(p);
    // 去掉法律文书后缀，取核心词（如「逃税罪」→「逃税」）
    const core = p.replace(/^中华人民共和国/, '').replace(/(罪|法|条例|办法|规定|协定|公约)$/, '');
    if (core && core.length >= 2) s.add(core);
  }
  for (const t of item.tags) s.add(t);
  // 过滤：长度>=2 且 不能是纯数字（避免「P2P」等被误归一化后的噪声）
  return [...s].filter(k => k && k.length >= 2 && !/^\d+$/.test(k)).map(norm).filter(Boolean);
}

// ---- 为每条法条找关联场景 ----
function findScenes(item) {
  const keys = matchKeys(item);
  const hits = [];
  for (const sc of scenes) {
    const txt = norm(scenarioText(sc));
    if (!txt) continue;
    const matched = keys.filter(k => k.length >= 2 && txt.includes(k));
    if (matched.length > 0) hits.push({ sc, matched });
  }
  // 排序：命中键数量降序 → 场景 id 升序
  hits.sort((a, b) => (b.matched.length - a.matched.length) || (a.sc.id < b.sc.id ? -1 : 1));
  return hits;
}

function sanitizeFile(name) { return name.replace(/[\/\\:*?"<>|]/g, '-').trim(); }

// ---- 生成「涉及场景」章节内容 ----
function renderSection(item, hits) {
  const L = ['## 涉及场景'];
  L.push('');
  if (hits.length === 0) {
    L.push('（暂无直接关联场景）');
  } else {
    for (const { sc } of hits) {
      const fname = catFname[sc.catNo] || (String(sc.catNo).padStart(2, '0') + '.md');
      const link = '[[' + fname.replace(/\.md$/, '') + ']]';
      const emoji = TAG_EMOJI[sc.tag] || '';
      L.push(`- ${link} · ${sc.t} ${emoji}`);
    }
  }
  L.push('');
  return L.join('\n');
}

// ---- 写入某个法条文件的「涉及场景」章节 ----
function writeSection(item, hits) {
  const catDir = path.join(OUT, item._cat);
  const fname = sanitizeFile(item.name) + '.md';
  const full = path.join(catDir, fname);
  if (!fs.existsSync(full)) return { file: fname, ok: false, err: '文件不存在' };
  const lines = fs.readFileSync(full, 'utf8').split('\n');
  const si = lines.findIndex(l => l.trim() === '## 涉及场景');
  if (si < 0) return { file: fname, ok: false, err: '未找到「## 涉及场景」' };
  // 找下一个 ## 标题作为结束
  let ei = lines.length;
  for (let i = si + 1; i < lines.length; i++) { if (/^##\s/.test(lines[i])) { ei = i; break; } }
  const newSec = renderSection(item, hits).split('\n');
  const out = [...lines.slice(0, si), ...newSec, ...lines.slice(ei)];
  fs.writeFileSync(full, out.join('\n'), 'utf8');
  return { file: fname, ok: true, n: hits.length };
}

// ---- 主流程 ----
const results = [];
for (const c of idx) {
  for (const item of c.items) {
    item._cat = c.cat;
    const hits = findScenes(item);
    results.push({ item, hits });
    if (dryRun) {
      console.log(`\n【${c.cat}】${item.name}  → ${hits.length} 个场景`);
      for (const { sc, matched } of hits.slice(0, 8)) {
        console.log(`   ${sc.id} ${sc.t} [${sc.tag}] 命中:${matched.slice(0, 3).join('、')}`);
      }
      if (hits.length > 8) console.log(`   ... 等 ${hits.length - 8} 个`);
    } else {
      const r = writeSection(item, hits);
      if (r.ok) console.log(`✅ ${item._cat}/${item.name} → ${r.n} 个场景`);
      else console.log(`❌ ${item._cat}/${item.name}: ${r.err}`);
    }
  }
}

const totalLinks = results.reduce((s, r) => s + r.hits.length, 0);
console.log(`\n${dryRun ? '[DRY-RUN] ' : ''}完成：${results.length} 条法条，共 ${totalLinks} 条场景关联`);
