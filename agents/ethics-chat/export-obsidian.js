#!/usr/bin/env node
/**
 * export-obsidian.js — 把伦理 agent 的场景库（SCENE_CATS）导出为 Obsidian Markdown。
 *
 * 数据来源：本目录 index.html 里的 `var SCENE_CATS = [...]`（第 2633 行附近，硬编码 JS 数组）。
 * 输出：一个「00-总索引.md」（MOC，含统计 + 双向链接目录）+ 每个大类一个 .md 文件。
 *
 * 用法：
 *   node agents/ethics-chat/export-obsidian.js
 * 场景库更新后重跑一遍即可覆盖同步（增量覆盖，无副作用）。
 */
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, 'index.html');
// 输出目录：默认同步到主 Obsidian 库的「伦理场景库」文件夹，可按需修改。
const OUT = path.join(
  require('os').homedir(),
  'Documents', 'Obsidian Vault', '伦理场景库'
);

const html = fs.readFileSync(HTML, 'utf8');
const m = html.match(/var SCENE_CATS = (\[[\s\S]*?\]);\s*\n/);
if (!m) { console.error('未找到 SCENE_CATS'); process.exit(1); }
const cats = eval(m[1]);

const STAGE = { all: '贯穿全阶段', seed: '种子期', growth: '成长期', exit: '退出期' };
const TAG_EMOJI = { '灰': '🟡', '违法': '🔴' };
const TAG_LABEL = { '灰': '灰色地带', '违法': '明确违法' };

// 分类名：去掉开头序号（①…㊿），再清洗文件系统非法字符
function titleOf(name) {
  return name.replace(/^[^\u4e00-\u9fa5a-zA-Z]+\s*/, '');
}
function sanitize(name) {
  return name.replace(/[\/\\:*?"<>|]/g, '-');
}

fs.mkdirSync(OUT, { recursive: true });

const stats = cats.map(c => {
  let grey = 0, illegal = 0;
  for (const it of c.items) { it.tag === '灰' ? grey++ : illegal++; }
  return { grey, illegal, total: c.items.length };
});
const TOTAL_GREY = stats.reduce((a, s) => a + s.grey, 0);
const TOTAL_ILLEGAL = stats.reduce((a, s) => a + s.illegal, 0);

const fileNames = [];
cats.forEach((c, i) => {
  const num = String(i + 1).padStart(2, '0');
  const title = sanitize(titleOf(c.name));
  const fname = `${num}-${title}.md`;
  fileNames.push(fname);

  const s = stats[i];
  const stages = [...new Set(c.items.map(it => STAGE[it.stage]))];

  const lines = [];
  lines.push('---');
  lines.push('tags:');
  lines.push('  - 伦理场景库');
  lines.push('  - ' + title);
  lines.push('---');
  lines.push('');
  lines.push('# ' + title);
  lines.push('');
  lines.push(`> ${s.total} 条场景 ｜ 🟡 灰色地带 ${s.grey} 条 ｜ 🔴 明确违法 ${s.illegal} 条`);
  lines.push(`> 涉及阶段：${stages.join(' / ')}`);
  lines.push('');

  c.items.forEach((it) => {
    lines.push('---');
    lines.push('');
    lines.push(`## ${TAG_EMOJI[it.tag]} ${it.t}`);
    lines.push('');
    lines.push(`**定性**：${TAG_EMOJI[it.tag]} ${TAG_LABEL[it.tag]} ｜ **阶段**：${STAGE[it.stage]}`);
    lines.push('');
    lines.push(it.q);
    lines.push('');
  });

  fs.writeFileSync(path.join(OUT, fname), lines.join('\n'));
  console.log(`✓ ${fname}  (${s.total} 条)`);
});

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
idx.push(`> 共 ${cats.length} 大类、${cats.reduce((a, c) => a + c.items.length, 0)} 条场景 ｜ 🟡 灰色地带 ${TOTAL_GREY} 条 ｜ 🔴 明确违法 ${TOTAL_ILLEGAL} 条`);
idx.push('>');
idx.push('> **图例**：🟡 = 灰色地带（法律/伦理灰色博弈，需警惕）　🔴 = 明确违法');
idx.push('> **阶段**：种子期（创业早期）／成长期／退出期／贯穿全阶段');
idx.push('');
idx.push('## 目录');
idx.push('');
idx.push('| # | 分类 | 场景数 | 🟡 灰 | 🔴 违法 |');
idx.push('|---|------|:---:|:---:|:---:|');
cats.forEach((c, i) => {
  const s = stats[i];
  idx.push(`| ${i + 1} | [[${fileNames[i].replace(/\.md$/, '')}]] | ${s.total} | ${s.grey} | ${s.illegal} |`);
});
idx.push('');
idx.push('## 使用说明');
idx.push('');
idx.push('- 点击上表分类名，可跳转到对应分类文件');
idx.push('- 每个场景标题前带 🟡 / 🔴 定性标记，标题下方标注阶段');
idx.push('- 用标签 `#伦理场景库` 可聚合所有场景；各分类文件另有独立标签');
idx.push('- 打印：可分别打开各分类文件打印，或用 Obsidian 的「导出 PDF」');
idx.push('');

fs.writeFileSync(path.join(OUT, '00-总索引.md'), idx.join('\n'));
console.log('✓ 00-总索引.md');
console.log('\n完成，共 ' + (cats.length + 1) + ' 个文件 → ' + OUT);
