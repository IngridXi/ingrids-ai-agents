/**
 * 知识库引擎 · 无头 CLI
 *
 * 复用 kb-engine.js，供定时自动化/终端在 Electron 未打开时也能增量索引。
 * 与桌面版共用同一份索引（Electron userData/data/kb），保证两边一致。
 *
 * 用法：
 *   node kb-cli.js scan                     # 增量扫描 + 嵌入 + 落盘
 *   node kb-cli.js search "查询语句"         # 语义检索 top-k
 *   node kb-cli.js status                   # 打印知识库状态
 *
 * 环境变量：
 *   KB_DATA_DIR   覆盖数据目录（默认 Electron userData/data）
 *   OLLAMA_URL    覆盖 Ollama 地址（默认 http://127.0.0.1:11434）
 */
'use strict';

const path = require('path');
const os = require('os');
const { KbEngine } = require('./kb-engine.js');

function resolveDataDir() {
  if (process.env.KB_DATA_DIR) return process.env.KB_DATA_DIR;
  const home = os.homedir();
  const base = process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', "Ingrid's AI Agents", 'data')
    : path.join(home, '.ingrid-ai-agents', 'data');
  return path.join(base, 'kb');
}

async function main() {
  const cmd = process.argv[2] || 'status';
  const arg = process.argv[3];
  const engine = new KbEngine({ dataDir: resolveDataDir(), ollamaUrl: process.env.OLLAMA_URL });

  if (cmd === 'scan') {
    const r = await engine.scan();
    console.log('scanned=' + r.files + ' changed=' + r.changed + ' deleted=' + r.deleted +
      ' chunks=' + r.chunks + ' embedded=' + r.embedded + ' embedReady=' + r.embedReady);
  } else if (cmd === 'search') {
    if (!arg) { console.error('usage: node kb-cli.js search "query"'); process.exit(1); }
    const hits = await engine.search(arg, 5);
    for (const h of hits) {
      console.log('--- [' + h.score + '] ' + h.title + '  (' + h.source + '/' + h.relPath + ')');
      console.log(h.content.slice(0, 300).replace(/\n+/g, ' '));
    }
    if (!hits.length) console.log('(无命中)');
  } else {
    const s = engine.status();
    console.log(JSON.stringify(s, null, 2));
  }
}

main().catch((e) => { console.error('kb-cli error:', e && e.message); process.exit(1); });
