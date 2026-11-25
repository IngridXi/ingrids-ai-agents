#!/usr/bin/env node
// 内容监护 agent（guard）：对已归档的「### 🤖 伦理 agent 实答」块做只读体检，
// 报告结构完整性 + 违规项，**绝不删除、绝不改写**任何内容（监护原则：只补充、只报告）。
//
// 用法：
//   node guard.js                 # 只读体检，打印报告 + 落盘 data/ethics-guard-report.json
//   node guard.js --md            # 额外输出 Markdown 报告到 Obsidian 库「伦理场景库/监护报告.md」
//   node guard.js --cat 01        # 只体检某个分类（如 01-税务）
const fs = require('fs');
const path = require('path');

const OUT = '/Users/ingridxi/Documents/Obsidian Vault/伦理场景库';
const DATA = path.join(__dirname, '..', '..', 'data');
const args = process.argv.slice(2);
const wantMd = args.includes('--md');
const onlyCat = (() => { const i = args.indexOf('--cat'); return i >= 0 ? args[i + 1] : null; })();

// 违规检测规则（与 archive-rules.md 对齐）
const RULES = {
  hasConclusion: { re: /###\s*结论\/方案/, label: '缺少「结论/方案」小节' },
  hasConsequence: { re: /###\s*性质与后果/, label: '缺少「性质与后果」小节' },
  hasBoundary: { re: /###\s*灰\/违界限/, label: '缺少「灰/违界限」小节' },
  hasGrey: { re: /🟡/, label: '缺少 🟡 灰色档' },
  hasRed: { re: /🔴/, label: '缺少 🔴 违法档' },
  noCompliance: { re: /✅\s*合规|合规档|合规线/, label: '含 ✅ 合规档（应只讲灰/违）', bad: true },
  noTable: { re: /^\s*\|.*\|\s*$/m, label: '含 markdown 表格', bad: true },
  noOriginalWording: { re: /原方案|原文|原先|原来[^\n]*(有误|应为|应改为|调整为|错标成|更正为)|表述有误/, label: '含「原方案…有误」类修正措辞', bad: true },
};

function analyzeAnswer(text) {
  const issues = [];
  const missing = [];
  for (const key of Object.keys(RULES)) {
    const r = RULES[key];
    const hit = r.re.test(text);
    if (r.bad && hit) issues.push(r.label);
    if (!r.bad && !hit) missing.push(r.label);
  }
  return { issues, missing };
}

function main() {
  if (!fs.existsSync(OUT)) { console.error('场景库目录不存在：' + OUT); process.exit(1); }
  const files = fs.readdirSync(OUT).filter(f => f.endsWith('.md') && !f.startsWith('00-') && (!onlyCat || f.startsWith(String(onlyCat).padStart(2, '0') + '-')));
  const rows = [];
  let totalBlocks = 0, okBlocks = 0;

  for (const f of files) {
    const lines = fs.readFileSync(path.join(OUT, f), 'utf8').split('\n');
    // 逐场景定位
    let curScene = null;
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s/.test(lines[i])) curScene = lines[i].trim();
      if (/^### 🤖 伦理 agent 实答/.test(lines[i])) {
        // 收集到下一个 ## 为止的答文
        let j = i + 1, buf = [];
        while (j < lines.length && !/^##\s/.test(lines[j])) { buf.push(lines[j]); j++; }
        const block = buf.join('\n');
        const qm = block.match(/\*\*问\*\*：([\s\S]*?)(?=\n\*\*答\*\*：)/);
        const am = block.match(/\*\*答\*\*：([\s\S]*)$/);
        const answer = am ? am[1] : '';
        totalBlocks++;
        const { issues, missing } = analyzeAnswer(answer);
        if (!issues.length && !missing.length) okBlocks++;
        rows.push({ file: f, scene: curScene || '?', q: (qm ? qm[1].trim() : '').slice(0, 40), chars: answer.trim().length, issues, missing });
      }
    }
  }

  const badRows = rows.filter(r => r.issues.length || r.missing.length);
  console.log('=== 内容监护体检报告 ===');
  console.log(`文件 ${files.length} 个，实答块 ${totalBlocks} 个，完整合规 ${okBlocks} 个，需补充/修正 ${badRows.length} 个`);
  console.log('');
  for (const r of badRows) {
    console.log(`[${r.file}] ${r.scene}`);
    console.log(`  问题：${r.q || '(无)'}`);
    if (r.missing.length) console.log(`  缺：${r.missing.join('、')}`);
    if (r.issues.length) console.log(`  违规：${r.issues.join('、')}`);
    console.log('');
  }
  if (!badRows.length) console.log('（无问题，全部实答块结构完整、无违规）');

  // 落盘 JSON 报告
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, 'ethics-guard-report.json'), JSON.stringify({ at: new Date().toISOString(), totalBlocks, okBlocks, bad: badRows.length, rows }, null, 2));
    console.log('报告已落盘 → data/ethics-guard-report.json');
  } catch (e) {}

  // 可选 Markdown 报告
  if (wantMd) {
    const L = [];
    L.push('---');
    L.push('tags:');
    L.push('  - 伦理场景库');
    L.push('  - 监护报告');
    L.push('---');
    L.push('');
    L.push('# 内容监护报告 · ' + new Date().toISOString().slice(0, 10));
    L.push('');
    L.push(`> 实答块 ${totalBlocks} 个，完整合规 ${okBlocks} 个，需补充/修正 ${badRows.length} 个`);
    L.push('> 监护原则：只报告、只补充，绝不删除正确内容。');
    L.push('');
    for (const r of badRows) {
      L.push('## ' + r.scene);
      L.push('');
      if (r.missing.length) L.push('- 缺：' + r.missing.join('、'));
      if (r.issues.length) L.push('- 违规：' + r.issues.join('、'));
      L.push('');
    }
    const report = path.join(OUT, '监护报告.md');
    fs.writeFileSync(report, L.join('\n'));
    console.log('Markdown 报告 → ' + report);
  }
}

main();
