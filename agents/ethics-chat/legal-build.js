#!/usr/bin/env node
// 法务知识库构建工具：
//   - 读 legal-index.json（法条清单）
//   - 生成 00-法条索引.md（总索引，双向链接）
//   - 建目录结构
//   - 校验每条法条是否已有对应 md（用于检查生成完整性）
// 用法：node legal-build.js [--check]   （--check 只校验不生成）
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const OUT = process.argv.includes('--obsidian-ai') ? '/Users/ingridxi/Documents/Obsidian AI 工位库/法务知识库' : '/Users/ingridxi/Documents/Obsidian Vault/法务知识库';
const INDEX = path.join(DIR, 'legal-index.json');
const checkOnly = process.argv.includes('--check');

const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
function sanitize(name) { return name.replace(/[\/\\:*?"<>|]/g, '-').trim(); }

let total = 0;
const catStats = idx.map(c => {
  const n = c.items.length; total += n;
  return { cat: c.cat, n };
});

if (!checkOnly) {
  fs.mkdirSync(OUT, { recursive: true });
  for (const c of idx) fs.mkdirSync(path.join(OUT, c.cat), { recursive: true });

  // 生成总索引
  const L = [];
  L.push('---');
  L.push('tags:');
  L.push('  - 法务知识库');
  L.push('  - MOC');
  L.push('---');
  L.push('');
  L.push('# 法务知识库 · 总索引');
  L.push('');
  L.push('> 来源：Ingrid\'s AI Agents 工作台「法务 agent」');
  L.push(`> 共 ${idx.length} 个领域、${total} 条法条 ｜ 每条含：法条原文 + 构成要件 + 司法解释 + 典型案例/判例 + 场景映射`);
  L.push('>');
  L.push('> **用途**：为伦理场景库提供准确法条依据；归档 agent 定性修正时引用；每周自动更新法条修订与新判例');
  L.push('');
  L.push('## 目录');
  L.push('');
  L.push('| # | 领域 | 法条数 |');
  L.push('|---|------|:---:|');
  idx.forEach((c, i) => L.push(`| ${i + 1} | [[${c.cat}/${c.cat}]] | ${c.items.length} |`));
  L.push('');
  idx.forEach((c) => {
    L.push(`## ${c.cat}`);
    L.push('');
    L.push('| 法条 | 参考条文 | 关键词 |');
    L.push('|------|------|------|');
    for (const it of c.items) {
      L.push(`| [[${c.cat}/${sanitize(it.name)}]] | ${it.ref} | ${it.tags.join('、')} |`);
    }
    L.push('');
  });
  L.push('## 更新记录');
  L.push('');
  L.push('- 每周自动搜索法条修订、新司法解释、新判例，增量更新');
  L.push('');
  fs.writeFileSync(path.join(OUT, '00-法条索引.md'), L.join('\n'));
  console.log('已生成索引 → ' + path.join(OUT, '00-法条索引.md'));
}

// 校验完整性
let missing = 0, generated = 0;
for (const c of idx) {
  for (const it of c.items) {
    const full = path.join(OUT, c.cat, sanitize(it.name) + '.md');
    if (fs.existsSync(full)) generated++; else { missing++; console.log('  缺失: ' + c.cat + ' / ' + it.name); }
  }
}
console.log(`\n法条总数 ${total} 条，已生成 ${generated} 条，缺失 ${missing} 条`);
