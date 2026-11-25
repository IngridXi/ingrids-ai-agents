#!/usr/bin/env node
// 法务知识库 · 全量生成器：
//   读 legal-index.json，为「尚无 md 文件」的法条生成结构化全文，
//   写入 Obsidian 法务知识库（幂等：已有文件自动跳过）。
//   法条原文由本地对齐模型草拟，不确定处标注【待核验】；
//   每周 automation 会联网核实并更新原文（只认权威来源）。
// 用法：
//   node legal-generate.js                 # 生成全部缺失
//   node legal-generate.js --limit N       # 只生成 N 条
//   node legal-generate.js --dry-run       # 只列缺失清单
//   node legal-generate.js --force 名称    # 强制重写某条
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const OUT = '/Users/ingridxi/Documents/Obsidian Vault/法务知识库';
const INDEX = path.join(DIR, 'legal-index.json');
const MODEL = 'qwen3.8-16k';
const ENDPOINT = 'http://127.0.0.1:11434/v1/chat/completions';
const NUM_CTX = 16384;
const TIMEOUT = 6 * 60 * 1000;

const args = process.argv.slice(2);
let limit = Infinity, dryRun = false, force = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--limit' && args[i + 1]) { limit = parseInt(args[i + 1], 10); i++; }
  else if (args[i] === '--dry-run') dryRun = true;
  else if (args[i] === '--force' && args[i + 1]) { force = args[i + 1]; i++; }
}

const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
function sanitize(name) { return name.replace(/[\/\\:*?"<>|]/g, '-').trim(); }

const SOUL = `你是「法务知识库编纂员」。任务：为一条法律规范生成结构化知识卡片。你的输出会进入企业经营的内部法务知识库，被检索引用，因此**准确性压倒一切**。

【最高纪律 · 法条原文准确】
1. 只写你有把握、能准确引用的法条原文与条文号；拿不准的条文，宁可写「【待核验】请以国家法律法规数据库（flk.npc.gov.cn）原文为准」，**绝不编造、绝不张冠李戴条号**。
2. 涉及具体刑罚（刑期/罚金）、数额门槛（如"数额较大=多少元"）时，若不确定具体数字，一律写【待核验：具体数额标准】。
3. 司法解释、立案追诉标准、典型案例须真实存在；想不起来就写「（待补充：本项待联网核实）」，不要虚构判例。

【输出结构】严格按以下 Markdown 输出：

## 法条原文
（准确引用；拿不准处标【待核验】）

## 构成要件
（主体/主观/客体/客观四要件，落到可验证事实）

## 司法解释
（真实存在的司法解释与要点；不确定标【待核验】）

## 典型案例 / 判例
（真实判例；没有就写「（待补充）」）

## 涉及场景
（暂无直接关联场景）

## 更新记录
- 初稿由本地模型草拟，法条原文待联网核实（每周自动更新）

【输出纪律】只输出上述结构，不要前言、不要免责声明、不要重复标题外的解释。`;

async function chat(messages) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const resp = await fetch(ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      body: JSON.stringify({ model: MODEL, messages, stream: false, temperature: 0.2, options: { num_predict: 5000, num_ctx: NUM_CTX } }),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const j = await resp.json();
    return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  } finally { clearTimeout(timer); }
}

function buildMd(item, cat, body) {
  return [
    '---', 'tags:', '  - 法务知识库', '  - ' + cat, '---', '',
    '# ' + item.name, '',
    '**参考条文**：' + item.ref, '',
    body.trim(), ''
  ].join('\n');
}

function now() {
  const d = new Date(); const p = x => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

async function main() {
  const todo = [];
  for (const c of idx) {
    for (const item of c.items) {
      const full = path.join(OUT, c.cat, sanitize(item.name) + '.md');
      const exists = fs.existsSync(full);
      const isForce = force && item.name.includes(force);
      if (!exists || isForce) todo.push({ c, item, full, exists, isForce });
    }
  }
  console.log(`待生成 ${todo.length} 条（共 ${idx.reduce((s, c) => s + c.items.length, 0)} 条）`);
  if (dryRun) {
    for (const t of todo) console.log('  ' + (t.exists ? '[重写]' : '[新建]') + ' ' + t.c.cat + '/' + t.item.name);
    return;
  }

  let done = 0;
  for (const t of todo) {
    if (done >= limit) break;
    const prompt = `请为以下法律规范生成知识卡片。\n\n【法律规范名称】${t.item.name}\n【参考条文】${t.item.ref}\n【关键词】${t.item.tags.join('、')}`;
    process.stdout.write(`[${t.c.cat}] ${t.item.name} ... `);
    try {
      const body = await chat([{ role: 'system', content: SOUL }, { role: 'user', content: prompt }]);
      if (!body || !body.trim()) throw new Error('空输出');
      fs.mkdirSync(path.join(OUT, t.c.cat), { recursive: true });
      fs.writeFileSync(t.full, buildMd(t.item, t.c.cat, body), 'utf8');
      console.log('OK ' + body.length + '字');
      done++;
    } catch (e) {
      console.log('FAIL ' + (e && e.message || e));
    }
  }
  console.log(`\n本轮生成 ${done} 条`);
}

main();
