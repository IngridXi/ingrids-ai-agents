/**
 * ============================================================
 *  agent-governance.js —— Agent 治理官（职责盘点 + 重叠检测 + 对账）
 *  ============================================================
 *
 *  设计来源：海归海平台「agent_governance 后台 Agent 组」
 *    （extensions/agent_governance：inventory.py + overlap.py + reconciler.py）
 *
 *  定位：工作台后台「控制面」——回答「工作台上有哪些 agent、各干什么、边界是否
 *        清晰、有没有重叠或空壳孤儿」。纯只读扫描，零依赖，不消耗 LLM 额度，
 *        不新增/合并/下线任何 agent（去留由人工拍板）。
 *
 *  三来源对账（工作台版）：
 *    1. agents/<slug>/index.html    —— 前端页面（独立 Agent 页）
 *    2. index.html 的 SEED_AGENTS    —— 首页门户注册（含面板型 Agent，无 href）
 *    3. dataDir/agents.json          —— AgentRegistry 持久化（增删改后的实际状态）
 *
 *  铁律边界（与海归海一致）：
 *    - 只读：不改任何 agent 文件，不注册/合并/下线，只产出清单与建议。
 *    - 分级：空壳 / 孤儿前端 = 阻塞级；职责重叠 / 前端自含 = 提示级（待人工）。
 *
 *  用法（Node 侧）：
 *    const gov = require('./agent-governance.js');
 *    const report = gov.run('/path/to/Ingrids-AI-Agents', '/path/to/dataDir');
 * ============================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ---------- 1. 职责域关键词词典（给每个 agent 归类，并作重叠检测判据） ---------- */
// 刻意避开「助手/工具/自动」等泛词，避免跨域污染导致误报重叠。
const DOMAIN_KEYWORDS = {
  '研究学术': ['研究', '论文', '文献', '发表', '审稿', '读博', 'Zotero', '综述', '实验'],
  '软件工程': ['开发', '逆向', '编译', '补丁', '反编译', '代码', '工程', '二进制', 'Shell'],
  '商业伦理': ['伦理', '合规', '案例', '商业', '法律', '监管', '违法'],
  '通用写作': ['通用', '写作', '文档', '总结', '改写'],
  '电脑操作': ['电脑', '鼠标', '键盘', '截图', '控制', '操作员', 'cliclick'],
  '知识管理': ['知识', 'RAG', '检索', '笔记', 'Obsidian', '术语', '知识库', '沉淀'],
  '会议音频': ['会议', '转写', '纪要', '声纹', '录音', '朗读', 'TTS'],
  '音乐创作': ['音乐', '作曲', '写词', '歌曲', 'MV', '翻唱', 'Suno'],
  '调度治理': ['调度', '路由', '指挥', '编排', '治理', '监督', '巡检', '沉淀官'],
  '秘书日程': ['日程', '日历', '邮件', '秘书', '提醒', '同步'],
};

// 面板型 Agent（在首页渲染、无独立 agents/<slug>/index.html），属正常设计，不算孤儿前端。
const CONTROL_PLANE_HINTS = ['调度中枢', '智能路由', '界面设计师', '秘书', '监事', '监督者', '知识沉淀官', 'Agent 总控'];

/* ---------- 2. 工具函数 ---------- */
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}

function extractTitleH1(html) {
  let title = '', h1 = '';
  const t = html.match(/<title>([^<]*)<\/title>/);
  const h = html.match(/<h1[^>]*>([^<]*)<\/h1>/);
  if (t) title = t[1].trim();
  if (h) h1 = h[1].trim();
  return { title, h1 };
}

function cleanName(raw) {
  let s = String(raw || '').trim();
  // 去掉常见后缀（先长后短，避免「Agent」把「Agents」截成「s」）
  ["· Ingrid's AI Agents", '· Ingrid AI Agents', '· 海归海独立智能助手', '· 工作台', ' · Ingrid AI Agents']
    .forEach(function (suf) {
      while (s.indexOf(suf) >= 0) s = s.replace(suf, '');
    });
  return s.trim();
}

function matchDomains(text) {
  const scored = [];
  Object.keys(DOMAIN_KEYWORDS).forEach(function (domain) {
    let n = 0;
    DOMAIN_KEYWORDS[domain].forEach(function (kw) { if (text.indexOf(kw) >= 0) n++; });
    if (n) scored.push([n, domain]);
  });
  scored.sort(function (a, b) { return b[0] - a[0]; });
  return scored.map(function (x) { return x[1]; });
}

/* ---------- 3. 来源 1：扫描前端页面（agents/<slug>/index.html） ---------- */
function scanFrontend(agentsDir) {
  const out = [];
  if (!agentsDir || !fs.existsSync(agentsDir)) return out;
  fs.readdirSync(agentsDir).sort().forEach(function (name) {
    const dir = path.join(agentsDir, name);
    if (!fs.statSync(dir).isDirectory()) return;
    const idx = path.join(dir, 'index.html');
    if (!fs.existsSync(idx)) return;
    const html = readText(idx);
    const { title, h1 } = extractTitleH1(html);
    // 自含检测：有独立 JS 文件，或内嵌 <script> 不含 src（有实质逻辑）
    const hasExternalJs = fs.existsSync(path.join(dir, 'app.js')) ||
      fs.readdirSync(dir).some(function (f) { return /\.js$/.test(f); });
    const inlineScripts = (html.match(/<script(?![^>]*src)/g) || []).length;
    out.push({
      slug: name,
      name: cleanName(h1 || title || name),
      frontend: true,
      selfContained: hasExternalJs || inlineScripts > 0,
    });
  });
  return out;
}

/* ---------- 4. 来源 2：解析 index.html 的 SEED_AGENTS（首页注册） ---------- */
function parseSeeds(indexHtml) {
  const seeds = [];
  // 逐块匹配：name: 'X' ... href: 'Y'（href 可选）
  const re = /name:\s*'([^']+)'[\s\S]{0,400}?href:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(indexHtml)) !== null) {
    seeds.push({ name: cleanName(m[1]), href: m[2] });
  }
  // 面板型（有 name 但无 href）单独抓：name 后面紧跟 status/role 而非 href
  const re2 = /name:\s*'([^']+)'[^}]{0,200}?(?:role:\s*'orchestrator'|status:\s*'active'|badge:\s*'[^']*')/g;
  while ((m = re2.exec(indexHtml)) !== null) {
    const nm = cleanName(m[1]);
    if (!seeds.some(function (s) { return s.name === nm; })) {
      seeds.push({ name: nm, href: '' });
    }
  }
  return seeds;
}

/* ---------- 5. 来源 3：读 dataDir/agents.json（AgentRegistry 持久化） ---------- */
function scanRegistry(dataDir) {
  if (!dataDir) return [];
  const p = path.join(dataDir, 'agents.json');
  if (!fs.existsSync(p)) return [];
  try {
    const list = JSON.parse(readText(p));
    if (!Array.isArray(list)) return [];
    return list.map(function (a) {
      return {
        id: a.id || '',
        name: cleanName(a.name || a.title || ''),
        role: a.role || 'worker',
        soul: a.soul || '',
        engine: a.engine || '',
        caps: a.caps || {},
        tools: Array.isArray(a.tools) ? a.tools : [],
        computer: a.computer || 'off',
        memory: a.memory || {},
        approvalMode: a.approvalMode || 'ask',
        href: a.href || '',
        canControl: !!a.canControl,
      };
    });
  } catch (e) { return []; }
}

/* ---------- 6. 重叠检测：职责域共现 ---------- */
function detectOverlaps(records) {
  const pairs = [];
  const named = records.filter(function (r) { return r.domains && r.domains.length; });
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const a = named[i], b = named[j];
      const shared = a.domains.filter(function (d) { return b.domains.indexOf(d) >= 0; });
      if (shared.length) {
        pairs.push({ a: a.name || a.slug, b: b.name || b.slug, shared: shared });
      }
    }
  }
  return pairs;
}

/* ---------- 6.5 四大支柱体检：大脑/手脚/记忆/边界（对齐 Agent 建设准则） ---------- */
// 依据 docs/RULES.md §1「Agent 建设准则」：每个 agent 应当四柱俱全。
// 只产出「提示级」缺失，不阻塞、不改动（去留仍由人拍板）。
function _hasCaps(a) {
  if (a.caps && typeof a.caps === 'object') {
    for (var k in a.caps) if (a.caps[k]) return true;
  }
  if (a.tools && a.tools.length) return true;
  if (a.computer === 'on' || a.computer === true) return true;
  return false;
}

// 危险等级：'high'（电脑操作）> 'write'（文件/DB 写）> 'none'
function _capDanger(a) {
  var caps = a.caps || {};
  if (caps.computer) return 'high';
  if (caps.fs || caps.db || caps.rollback || a.computer === 'on') return 'write';
  return 'none';
}

function checkFourPillars(registry, frontends) {
  // 有独立页面的 chat agent = 能力在页面里声明、有 session-log + agent-memory 记忆机制（平台级兜底）。
  // 判据用 href 而非 name 匹配（name 带 emoji/空格会失配）。
  var issues = [];
  (registry || []).forEach(function (a) {
    if (!a || !a.name) return;
    var isOrchestrator = a.role === 'orchestrator';
    var hasFrontend = /agents\/[a-z0-9-]+\/index\.html/.test(a.href || '');
    var missing = [];
    // 大脑：worker（chat agent）必须有 soul 角色定义；控制面用规则引擎，豁免
    if (!isOrchestrator && !a.soul) missing.push('大脑(无 soul 角色定义)');
    // 手脚：无独立页且没声明能力 = 只会说不会做（能力在页面里则不算缺失）
    if (!isOrchestrator && !hasFrontend && !_hasCaps(a)) missing.push('手脚(无 caps/tools 能力声明)');
    // 记忆：无独立页且无 memory 持久化 = 无状态
    if (!isOrchestrator && !hasFrontend && (!a.memory || Object.keys(a.memory).length === 0)) {
      missing.push('记忆(无持久化机制)');
    }
    // 边界：全自动(approvalMode=full) 且带高危险能力 = 违反最小代理权（对所有 agent 都查）
    if (a.approvalMode === 'full' && _capDanger(a) !== 'none') {
      missing.push('边界(全自动 + 高危险能力，缺人工确认)');
    }
    if (missing.length) issues.push({ name: a.name, role: a.role, missing: missing });
  });
  return issues;
}

/* ---------- 7. 编排：三来源对账 + 报告 ---------- */
function run(repoRoot, dataDir) {
  const repo = path.resolve(repoRoot || __dirname);
  const agentsDir = path.join(repo, 'agents');
  const indexHtml = readText(path.join(repo, 'index.html'));

  const frontends = scanFrontend(agentsDir);
  const seeds = parseSeeds(indexHtml);
  const registry = scanRegistry(dataDir);

  // 首页注册的前端 href → slug
  const portalSlugs = new Set();
  const portalNames = [];
  seeds.forEach(function (s) {
    portalNames.push(s.name);
    if (s.href) {
      const m = s.href.match(/agents\/([a-z0-9-]+)\/index\.html/);
      if (m) portalSlugs.add(m[1]);
    }
  });

  // 合并成单一清单
  const records = frontends.map(function (f) {
    const inPortal = portalSlugs.has(f.slug);
    const domains = matchDomains(f.name);
    let status = inPortal ? '已上线' : '前端未注册';
    if (!inPortal) status = '前端未注册';
    return {
      slug: f.slug, name: f.name, status: status,
      frontend: true, selfContained: f.selfContained, domains: domains,
    };
  });

  // 面板型 agent（首页注册但无前端页面）
  seeds.forEach(function (s) {
    const slug = s.href ? (s.href.match(/agents\/([a-z0-9-]+)\/index\.html/) || [])[1] : '';
    const hasFrontend = slug && frontends.some(function (f) { return f.slug === slug; });
    if (!hasFrontend) {
      records.push({
        slug: slug || ('panel-' + s.name), name: s.name, status: '面板型（无独立页）',
        frontend: false, selfContained: false, domains: matchDomains(s.name),
      });
    }
  });

  // 孤儿前端（有前端页面但首页未注册）
  const orphans = frontends.filter(function (f) { return !portalSlugs.has(f.slug); })
    .map(function (f) { return f.name || f.slug; });

  // 空壳（首页注册了 href 但前端页面不存在）
  const shells = [];
  portalSlugs.forEach(function (slug) {
    if (!frontends.some(function (f) { return f.slug === slug; })) shells.push(slug);
  });

  const overlaps = detectOverlaps(records);
  const controlPlane = records.filter(function (r) {
    return CONTROL_PLANE_HINTS.some(function (h) { return r.name.indexOf(h) >= 0; });
  });

  // 四大支柱体检（对齐 docs/RULES.md §1 Agent 建设准则）
  const pillarIssues = checkFourPillars(registry, frontends);

  return {
    agent: 'Agent 治理官',
    mode: '只读盘点 · 职责归类 · 重叠检测 · 前后端对账 · 四大支柱体检',
    generated_at: new Date().toISOString(),
    summary: {
      frontend_count: frontends.length,
      portal_count: seeds.length,
      registry_count: registry.length,
      overlap_count: overlaps.length,
      orphan_count: orphans.length,
      shell_count: shells.length,
      control_plane_count: controlPlane.length,
      pillar_issue_count: pillarIssues.length,
    },
    records: records,
    overlaps: overlaps,
    orphans: orphans,
    shells: shells,
    pillar_issues: pillarIssues,
    registry: registry,
    strict_issues: (shells.length + orphans.length) > 0,
  };
}

module.exports = { run: run, DOMAIN_KEYWORDS: DOMAIN_KEYWORDS };

if (require.main === module) {
  console.log(JSON.stringify(run(process.argv[2] || __dirname, process.argv[3]), null, 2));
}
