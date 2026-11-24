#!/usr/bin/env node
// 从 scenes.json + practices/ 分片生成带「未规范做法 / 已规范做法」双栏对比的 Obsidian 场景库
// 用法：node build-scenes.js [输出目录]
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const OUT = process.argv[2] || '/Users/ingridxi/Documents/Obsidian Vault/伦理场景库';

const scenes = JSON.parse(fs.readFileSync(path.join(DIR, 'scenes.json'), 'utf8'));

// 合并 practices 分片（practices/*.json，key = 场景 id "1-1"）
const practices = {};
const pdir = path.join(DIR, 'practices');
if (fs.existsSync(pdir)) {
  for (const f of fs.readdirSync(pdir)) {
    if (f.endsWith('.json')) {
      Object.assign(practices, JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8')));
    }
  }
}

const STAGE = { all: '贯穿全阶段', seed: '种子期', growth: '成长期', exit: '退出期' };
const TAG_EMOJI = { '灰': '🟡', '违法': '🔴' };
const TAG_LABEL = { '灰': '灰色地带', '违法': '明确违法' };

// 按分类分组
const byCat = {};
for (const s of scenes) { (byCat[s.catNo] = byCat[s.catNo] || []).push(s); }
const cats = Object.keys(byCat).map(Number).sort((a, b) => a - b).map(no => ({
  no, name: byCat[no][0].cat, items: byCat[no]
}));

function titleOf(name) { return name.replace(/^[^\u4e00-\u9fa5a-zA-Z]+/, '').trim(); }
function sanitize(name) { return name.replace(/[\/\\:*?"<>|]/g, '-'); }

// 校验：每条都必须有 u 和 a
const missing = scenes.filter(s => !practices[s.id] || !(practices[s.id].u || '').trim() || !(practices[s.id].a || '').trim());
if (missing.length) {
  console.error('缺失做法的场景 (' + missing.length + '):');
  console.error(missing.map(m => m.id + ' ' + m.t).join('\n'));
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });

const meta = [];
const total = { n: scenes.length, grey: scenes.filter(s => s.tag === '灰').length, illegal: scenes.filter(s => s.tag === '违法').length };

cats.forEach((c) => {
  const title = sanitize(titleOf(c.name));
  const fname = `${String(c.no).padStart(2, '0')}-${title}.md`;
  const grey = c.items.filter(i => i.tag === '灰').length;
  const illegal = c.items.filter(i => i.tag === '违法').length;
  meta.push({ no: c.no, fname, title, total: c.items.length, grey, illegal });

  const stages = [...new Set(c.items.map(i => STAGE[i.stage]))];
  const L = [];
  L.push('---');
  L.push('tags:');
  L.push('  - 伦理场景库');
  L.push('  - ' + title);
  L.push('---');
  L.push('');
  L.push('# ' + title);
  L.push('');
  L.push(`> ${c.items.length} 条场景 ｜ 🟡 灰色地带 ${grey} 条 ｜ 🔴 明确违法 ${illegal} 条`);
  L.push(`> 涉及阶段：${stages.join(' / ')}`);
  L.push('');

  c.items.forEach((it) => {
    const p = practices[it.id];
    L.push('---');
    L.push('');
    L.push(`## ${TAG_EMOJI[it.tag]} ${it.t}`);
    L.push('');
    L.push(`**定性**：${TAG_EMOJI[it.tag]} ${TAG_LABEL[it.tag]} ｜ **阶段**：${STAGE[it.stage]}`);
    L.push('');
    L.push('### 问题');
    L.push('');
    L.push(it.q);
    L.push('');
    L.push(`### ${TAG_EMOJI[it.tag]} 未规范做法（去道德化 AI · 反面教材）`);
    L.push('');
    L.push(p.u);
    L.push('');
    L.push('### ✅ 已规范做法（对齐 AI · 正面教材）');
    L.push('');
    L.push(p.a);
    L.push('');
  });

  fs.writeFileSync(path.join(OUT, fname), L.join('\n'));
});

// 总索引
const idx = [];
idx.push('---');
idx.push('tags:');
idx.push('  - 伦理场景库');
idx.push('  - MOC');
idx.push('---');
idx.push('');
idx.push('# 伦理场景库 · 总索引');
idx.push('');
idx.push('> 来源：Ingrid\'s AI Agents 工作台「伦理 agent」场景库');
idx.push(`> 共 ${cats.length} 大类、${total.n} 条场景 ｜ 🟡 灰色地带 ${total.grey} 条 ｜ 🔴 明确违法 ${total.illegal} 条`);
idx.push('>');
idx.push('> **每条结构**：问题 → 🔴/🟡 未规范做法（去道德化 AI 的反面支招 + 性质/法条后果）→ ✅ 已规范做法（对齐 AI 的定性 + 合规替代）');
idx.push('> **图例**：🟡 = 灰色地带（不违法但踩伦理/合规红线）　🔴 = 明确违法');
idx.push('> **阶段**：种子期（创业早期）／成长期／退出期／贯穿全阶段');
idx.push('');
idx.push('## 目录');
idx.push('');
idx.push('| # | 分类 | 场景数 | 🟡 灰 | 🔴 违法 |');
idx.push('|---|------|:---:|:---:|:---:|');
meta.forEach(m => idx.push(`| ${m.no} | [[${m.fname.replace(/\.md$/, '')}]] | ${m.total} | ${m.grey} | ${m.illegal} |`));
idx.push('');
idx.push('## 使用说明');
idx.push('');
idx.push('- 点击上表分类名可跳转到对应分类文件；每类文件内按「问题 + 双栏做法」逐条展开');
idx.push('- 未规范做法为「反面教材」，仅用于 AI 伦理教学对照，切勿照做；已规范做法给出可执行的合规路径');
idx.push('- 用标签 `#伦理场景库` 可聚合所有场景；打印可用 Obsidian「导出 PDF」或逐类打印');
idx.push('');

fs.writeFileSync(path.join(OUT, '00-总索引.md'), idx.join('\n'));

console.log('完成：' + (cats.length + 1) + ' 个文件 → ' + OUT);
console.log(`场景 ${total.n} 条（🟡 ${total.grey} / 🔴 ${total.illegal}），做法库 ${Object.keys(practices).length} 条，全部匹配`);
