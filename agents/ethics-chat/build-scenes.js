#!/usr/bin/env node
// 从 scenes.json + practices/ 分片生成 Obsidian 场景库 md：
//   - 灰场景：问题 → 🟡未规范做法 → ✅已规范做法
//   - 违法场景：问题 → 🔴未规范做法 → 🟡灰色地带做法 → ✅已规范做法
// 用法：node build-scenes.js [输出目录]
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const OUT = process.argv[2] || '/Users/ingridxi/Documents/Obsidian Vault/伦理场景库';

const scenes = JSON.parse(fs.readFileSync(path.join(DIR, 'scenes.json'), 'utf8'));

// 合并 practices 分片（01~09.json：key=场景id，value 含 u、a；gray-*.json：value 含 g）
const practices = {};
const gray = {};
const pdir = path.join(DIR, 'practices');
if (fs.existsSync(pdir)) {
  for (const f of fs.readdirSync(pdir)) {
    if (!f.endsWith('.json')) continue;
    const obj = JSON.parse(fs.readFileSync(path.join(pdir, f), 'utf8'));
    if (f.startsWith('gray-')) Object.assign(gray, obj);
    else if (f.startsWith('bound-')) { for (const id of Object.keys(obj)) (practices[id] = practices[id] || {}).bound = obj[id].bound; }
    else Object.assign(practices, obj);
  }
}
for (const id of Object.keys(gray)) {
  (practices[id] = practices[id] || {}).g = gray[id].g;
}

// 提取现有 md 中已归档的「### 🤖 伦理 agent 实答」块，重建时保留（不丢失历史实答）。
// 关键：答文正文里可能含有「### 结论/方案」「### 性质与后果」子标题，甚至「---」分隔线，
// 它们都是答案的一部分。真正的块边界只有一个：下一个场景标题（## ）。
function extractExistingAnswers() {
  const map = {};
  if (!fs.existsSync(OUT)) return map;
  for (const f of fs.readdirSync(OUT)) {
    if (!f.endsWith('.md') || f.startsWith('00-')) continue;
    const lines = fs.readFileSync(path.join(OUT, f), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!/^##\s/.test(lines[i])) continue;
      const heading = lines[i].trim();
      // 在当前场景块内（直到下一个 ## 场景标题）找「### 🤖 伦理 agent 实答」
      let j = i + 1;
      while (j < lines.length && !/^##\s/.test(lines[j])) {
        if (/^### 🤖 伦理 agent 实答/.test(lines[j])) {
          const ans = [];
          let k = j;
          while (k < lines.length && !/^##\s/.test(lines[k])) { ans.push(lines[k]); k++; }
          // 去掉末尾的空行与场景分隔线（---），保留正文内部的 --- 与 ### 子标题
          while (ans.length && (/^\s*$/.test(ans[ans.length - 1]) || /^---\s*$/.test(ans[ans.length - 1]))) ans.pop();
          if (ans.length) (map[heading] = map[heading] || []).push(ans.join('\n'));
          break; // 每个场景只有一个实答块
        }
        j++;
      }
    }
  }
  return map;
}
const existingAnswers = extractExistingAnswers();

const STAGE = { all: '贯穿全阶段', seed: '种子期', growth: '成长期', exit: '退出期' };
const TAG_EMOJI = { '灰': '🟡', '违法': '🔴' };
const TAG_LABEL = { '灰': '灰色地带', '违法': '明确违法' };

const byCat = {};
for (const s of scenes) { (byCat[s.catNo] = byCat[s.catNo] || []).push(s); }
const cats = Object.keys(byCat).map(Number).sort((a, b) => a - b).map(no => ({
  no, name: byCat[no][0].cat, items: byCat[no]
}));

function titleOf(name) { return name.replace(/^[^\u4e00-\u9fa5a-zA-Z]+/, '').trim(); }
function sanitize(name) { return name.replace(/[\/\\:*?"<>|]/g, '-'); }

// 校验：每条都必须有 u、a；违法场景还必须有 g
const missing = scenes.filter(s => !practices[s.id] || !(practices[s.id].u || '').trim() || !(practices[s.id].a || '').trim());
const missingGray = scenes.filter(s => s.tag === '违法' && !(practices[s.id] && (practices[s.id].g || '').trim()));
if (missing.length || missingGray.length) {
  if (missing.length) { console.error('缺失做法的场景 (' + missing.length + '):'); console.error(missing.map(m => m.id + ' ' + m.t).join('\n')); }
  if (missingGray.length) { console.error('缺失灰色地带做法的违法场景 (' + missingGray.length + '):'); console.error(missingGray.map(m => m.id + ' ' + m.t).join('\n')); }
  process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });

// 生成「灰/违界限判定标准」总纲（从源模板复制，保证与场景库同步维护）
const JUDGE_SRC = path.join(DIR, 'judgement-standard.md');
if (fs.existsSync(JUDGE_SRC)) {
  fs.copyFileSync(JUDGE_SRC, path.join(OUT, '00-判定标准.md'));
}

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
    if (it.tag === '违法') {
      L.push('### 🟡 灰色地带做法（中间路线 · 踩线）');
      L.push('');
      L.push(p.g);
      L.push('');
    }
    if (p.bound && String(p.bound).trim()) {
      L.push('### 🔍 灰/违界限');
      L.push('');
      L.push(p.bound);
      L.push('');
    }
    L.push('### ✅ 已规范做法（对齐 AI · 正面教材）');
    L.push('');
    L.push(p.a);
    L.push('');
    // 保留历史「🤖 伦理 agent 实答」（若存在）
    const heading = `## ${TAG_EMOJI[it.tag]} ${it.t}`;
    const ans = existingAnswers[heading];
    if (ans && ans.length) {
      for (const a of ans) { L.push(a); L.push(''); }
    }
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
idx.push('> **每条结构**：问题 → 🔴/🟡 未规范做法（去道德化 AI 的反面支招 + 性质/法条后果）→ 🟡 灰色地带做法（仅违法场景，中间路线踩线警示）→ ✅ 已规范做法（对齐 AI 的定性 + 合规替代）');
idx.push('> **图例**：🟡 = 灰色地带（不违法但踩伦理/合规红线）　🔴 = 明确违法');
idx.push('> **判据**：先读 [[00-判定标准]]，掌握「灰 vs 违」的统一界限（一句话界限 / 五个判定维度 / 同领域对照表 / 判定流程）');
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
idx.push('- 点击上表分类名可跳转到对应分类文件；每类文件内按「问题 + 做法」逐条展开');
idx.push('- 未规范做法为「反面教材」，仅用于 AI 伦理教学对照，切勿照做；灰色地带做法标注踩线风险；已规范做法给出可执行合规路径');
idx.push('- 用标签 `#伦理场景库` 可聚合所有场景；打印可用 Obsidian「导出 PDF」或逐类打印');
idx.push('');

fs.writeFileSync(path.join(OUT, '00-总索引.md'), idx.join('\n'));

console.log('完成：' + (cats.length + 1) + ' 个文件 → ' + OUT);
console.log(`场景 ${total.n} 条（🟡 ${total.grey} / 🔴 ${total.illegal}），做法库 ${Object.keys(practices).length} 条（含灰色地带 ${Object.keys(gray).length} 条），全部匹配`);
