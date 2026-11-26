/**
 * ============================================================
 *  agent-type-governor.js —— Agent 类型治理官（自动巡检 + 自动修正）
 *  ============================================================
 *
 *  定位：把原「调度中枢」的手动委派面板升级成「治理型 agent」。
 *  它不再等人来派活，而是主动巡检工作台上每一个 agent（老的、新加入的），
 *  按「四类触发类型」判定它该是哪种，并默认自动修正写回；只有被人工锁定的
 *  agent 才豁免自动修改。每次发生变动，产出报告 + 变更历史，供上层发系统通知。
 *
 *  四类触发类型（权威定案，见 CityVerse docs/41 2.4）：
 *    🔶 主动型   active   时间驱动，无上游依赖，新鲜度优先 —— 每天定时
 *    ⬜ 链路驱动 pipeline 被动接续，被上游输出触发 —— 上游产出后自动串联
 *    🔴 缺口驱动 gap     事件触发，差什么才做什么 —— 上游判出缺口才触发
 *    🟢 人工驱动 human   人触发 —— 人点 / 审批 / 对话
 *
 *  铁律边界：
 *    - 默认自动修正（写回 registry 的 triggerType），无需人工逐条确认；
 *    - 人工锁定（lock）后，该 agent 的类型不再被自动改动，直到解锁；
 *    - 无规则命中（既不在种子表、也匹配不到关键词）的新 agent → 保守判「人工驱动」，
 *      并标记 needs_review=true，绝不臆断成主动/缺口这类会「自动跑」的类型；
 *    - 变更 append-only 记入 agent-type-changes.jsonl，报告写 agent-types.json。
 *
 *  用法（Node 侧）：
 *    const gov = require('./agent-type-governor.js');
 *    const report = gov.run({ repoRoot, dataDir, cityverseRoot });
 *    gov.lock('研究助手', 'human');   // 人工锁定
 *    gov.unlock('研究助手');
 *    const snapshot = gov.state(dataDir);
 * ============================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ---------- 1. 四类触发类型定义（单一真相源） ---------- */
const TRIGGER_TYPES = {
  active: {
    key: 'active', label: '主动型', badge: '主动', emoji: '🔶', color: '#f59e0b',
    desc: '时间驱动 · 每天定时（有新鲜度）',
    meaning: '无上游依赖，新鲜度优先，每天定时跑',
  },
  pipeline: {
    key: 'pipeline', label: '链路驱动', badge: '链路', emoji: '⬜', color: '#0ea5e9',
    desc: '被动接续上游',
    meaning: '被上游输出触发，上游产出后自动串联',
  },
  gap: {
    key: 'gap', label: '缺口驱动', badge: '缺口', emoji: '🔴', color: '#dc2626',
    desc: '事件触发 · 差什么才做什么',
    meaning: '上游判出缺口才触发，幂等，绝不每天定时',
  },
  human: {
    key: 'human', label: '人工驱动', badge: '人工', emoji: '🟢', color: '#16a34a',
    desc: '人等点 / 审批 / 对话',
    meaning: '人触发，不自动跑',
  },
};
const TYPE_KEYS = Object.keys(TRIGGER_TYPES);

/* ---------- 2. 种子类型表（权威定案固化：命中即用，不推断） ---------- */
/**
 * key：agent 名称（已归一化：trim + 去空格 + 小写）
 * value：四类之一。既覆盖 CityVerse 两套体系的 agent（主动 3 / 缺口 1 / 链路 / 人工），
 *       也覆盖工作台全部 agent（含面板型：秘书 / 监事 / 监督者 / 知识沉淀官）。
 */
const SEED_TYPES = {
  // —— 🔶 主动型（时间驱动，仅这 3 个）——
  '采集': 'active', '采集agent': 'active', '舆情采集': 'active', 'communityintel': 'active',
  'research': 'active', 'researchagent': 'active', '路线资讯': 'active',
  'selfcheck': 'active', '自检': 'active', '自我检测': 'active',
  // —— ⬜ 链路驱动（被动接续上游）——
  '洞察': 'pipeline', 'insight': 'pipeline', 'insightagent': 'pipeline',
  '玩法库': 'pipeline', 'playbook': 'pipeline', '玩法': 'pipeline',
  '规划': 'pipeline', 'planner': 'pipeline', 'itagent': 'pipeline', '建设规划': 'pipeline',
  '执行': 'pipeline', 'executor': 'pipeline',
  '门禁': 'pipeline', 'gate': 'pipeline', '质量门禁': 'pipeline',
  '竞品对标': 'pipeline', 'competitor': 'pipeline', '对标': 'pipeline',
  '差距分析': 'pipeline', 'analyze': 'pipeline',
  '转建设任务': 'pipeline', 'feed': 'pipeline',
  // —— 🔴 缺口驱动（事件触发，仅这 1 个）——
  'assetagent': 'gap', 'asset agent': 'gap', 'asset_agent': 'gap', '素材下载': 'gap', '素材采购': 'gap',
  // —— 🟢 人工驱动（人等点 / 审批 / 对话）——
  '人工审批': 'human', '审批': 'human', '落地': 'human', 'apply': 'human',
  'ops': 'human', '运营': 'human',

  /* ===== 工作台（Ingrid's AI Agents）===== */
  // 聊天 agent（人等点 / 对话）
  '会议纪要官': 'human', '音乐创作': 'human', '研究助手': 'human',
  '通用助手': 'human', '软件工程': 'human', '伦理agent': 'human',
  '界面设计师': 'human', 'agent总控台': 'human',
  // 主动型（时间驱动）
  '灵感目录': 'active', 'eco-radar': 'active', 'ecoradar': 'active',
  '秘书': 'active',
  // 链路驱动（被动接续上游产出）
  '监事': 'pipeline', '监督者': 'pipeline', '知识沉淀官': 'pipeline',
  // 治理官自己：主动型（每天定时巡检）
  '智能路由ra': 'active', '调度中枢': 'active',
};

/* ---------- 3a. 前端目录里「不是 agent」的页面（排除，不参与类型治理） ---------- */
// 这些是工具页 / 能力窗口 / 看板，不是可治理的 agent：
//   agent-architecture —— 架构图看板；knowledge —— 知识库页；computer-use —— 已能力化（电脑操作员已删除）
const EXCLUDE_SLUGS = ['agent-architecture', 'knowledge', 'computer-use'];

/* ---------- 3b. 面板型 agent（不落 registry，但仍是「老 agent」，须审查到） ---------- */
const PANEL_AGENTS = ['秘书', '监事', '监督者', '知识沉淀官'];

/* ---------- 4. 关键词推断规则（仅用于种子表未命中的「新」agent） ---------- */
// 顺序敏感：先匹配主动/缺口（会「自动跑」的高危类型），再匹配链路，最后默认人工。
const INFERENCE_RULES = [
  { type: 'active',   re: /采集|舆情|research|selfcheck|自检|巡检|每日|定时|日报|灵感|雷达|eco-?radar|周报/i },
  { type: 'gap',      re: /asset|素材|采购|资产|缺什么/i },
  { type: 'pipeline', re: /洞察|规划|执行|门禁|对标|差距|沉淀|复盘|监督|监事|质检|玩法|转建设|编排|路由|gate|executor|planner|competitor|analyze/i },
  // 「审批 / 落地 / apply / ops / 秘书聊天」明确归人工，放在链路之后更精确
  { type: 'human',    re: /审批|落地|apply|ops|运营|对话|聊天|问答|助手|agent|秘书|助手/i },
];

/* ---------- 4. 工具函数 ---------- */
function readText(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; }
}

/** 归一化：trim + 去空白 + 小写（与种子表 key 对齐） */
function norm(name) {
  return String(name == null ? '' : name).replace(/\s+/g, '').toLowerCase();
}

function cleanName(raw) {
  let s = String(raw || '').trim();
  ["· Ingrid's AI Agents", '· Ingrid AI Agents', '· 工作台', '· CityVerse', '· 海归海独立智能助手']
    .forEach(function (suf) { while (s.indexOf(suf) >= 0) s = s.replace(suf, ''); });
  return s.trim();
}

function typeMeta(key) { return TRIGGER_TYPES[key] || TRIGGER_TYPES.human; }

/* ---------- 5. 判定：种子表命中 → 关键词推断 → 默认人工 ---------- */
function determineType(name, extraText) {
  const n = norm(name);
  // 1) 种子表精确命中（去歧义：带「agent」连写也查）
  if (SEED_TYPES.hasOwnProperty(n)) return { type: SEED_TYPES[n], source: 'seed' };
  if (SEED_TYPES.hasOwnProperty(n + 'agent')) return { type: SEED_TYPES[n + 'agent'], source: 'seed' };
  // 2) 关键词推断（名称 + 附加文本）
  const hay = (name || '') + ' ' + (extraText || '');
  for (let i = 0; i < INFERENCE_RULES.length; i++) {
    if (INFERENCE_RULES[i].re.test(hay)) {
      return { type: INFERENCE_RULES[i].type, source: 'rule' };
    }
  }
  // 3) 保守默认：人工驱动（绝不臆断成会自动跑的类型）
  return { type: 'human', source: 'default', needsReview: true };
}

/* ---------- 6. 扫描来源 ---------- */
// 来源 1：dataDir/agents.json（AgentRegistry 持久化，实际状态）
function scanRegistry(dataDir) {
  if (!dataDir) return [];
  const p = path.join(dataDir, 'agents.json');
  if (!fs.existsSync(p)) return [];
  try {
    const list = JSON.parse(readText(p));
    if (!Array.isArray(list)) return [];
    return list.map(function (a) {
      const href = a.href || '';
      const sm = href.match(/agents\/([a-z0-9-]+)\/index\.html/);
      return {
        key: norm(a.name || a.title || ''),
        id: a.id || '',
        name: cleanName(a.name || a.title || ''),
        role: a.role || 'worker',
        source: 'registry',
        href: href,
        slug: sm ? sm[1] : '',
        emoji: a.emoji || '',
        currentType: a.triggerType || '',
      };
    });
  } catch (e) { return []; }
}

// 来源 2：index.html 的 SEED_AGENTS（首页门户注册）
function scanSeeds(repoRoot) {
  const html = readText(path.join(repoRoot || '', 'index.html'));
  if (!html) return [];
  const out = [];
  // 只取 SEED_AGENTS 数组这一段，避免误抓 index.html 里其它 `name: '...'`（如导航 openAgentInView）
  const m0 = html.match(/const\s+SEED_AGENTS\s*=\s*\[([\s\S]*?)\n\];/);
  const block = m0 ? m0[1] : html;
  const re = /name:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    out.push({
      key: norm(m[1]), id: '', name: cleanName(m[1]), role: 'worker',
      source: 'seed', href: '', emoji: '', currentType: '',
    });
  }
  return out;
}

// 来源 3：agents/<slug>/index.html（独立前端页，用于发现「未注册的新 agent」）
function scanFrontend(repoRoot) {
  const agentsDir = path.join(repoRoot || '', 'agents');
  const out = [];
  if (!agentsDir || !fs.existsSync(agentsDir)) return out;
  fs.readdirSync(agentsDir).sort().forEach(function (slug) {
    if (EXCLUDE_SLUGS.indexOf(slug) >= 0) return;
    const dir = path.join(agentsDir, slug);
    if (!fs.statSync(dir).isDirectory()) return;
    const idx = path.join(dir, 'index.html');
    if (!fs.existsSync(idx)) return;
    const html = readText(idx);
    const t = html.match(/<title>([^<]*)<\/title>/);
    const h = html.match(/<h1[^>]*>([^<]*)<\/h1>/);
    const display = cleanName((h && h[1]) || (t && t[1]) || slug);
    out.push({
      slug: slug, key: norm(display), id: '', name: display, role: 'worker',
      source: 'frontend', href: 'agents/' + slug + '/index.html', emoji: '', currentType: '',
    });
  });
  return out;
}

// 来源 4（可选，只读参考）：CityVerse 的 agent（四类定案的发源地）
function scanCityverse(cityverseRoot) {
  const root = cityverseRoot || path.join(path.dirname(__dirname), 'cityverse-ar');
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  // CityVerse 的 agent 名已固化进种子表；这里只做「发现」：从 docs/41 与 intel 目录抓名字
  const doc = readText(path.join(root, 'docs', '41-agent-orchestration.md'));
  const known = ['采集', '洞察', '玩法库', '规划', '执行', '门禁', '落地',
    'selfcheck', '竞品对标', 'research', '差距分析', 'asset_agent', '转建设任务', '人工审批', 'ops'];
  known.forEach(function (nm) {
    if (doc.indexOf(nm) >= 0) {
      out.push({ key: nm, id: '', name: nm, role: 'worker', source: 'cityverse', href: '', emoji: '', currentType: '' });
    }
  });
  return out;
}

/* ---------- 7. 持久化：agent-types.json（治理快照） + 变更历史 ---------- */
function stateFile(dataDir) { return path.join(dataDir, 'agent-types.json'); }
function changesFile(dataDir) { return path.join(dataDir, 'agent-type-changes.jsonl'); }

function loadState(dataDir) {
  const p = stateFile(dataDir);
  if (!fs.existsSync(p)) return { records: {} };
  try { const s = JSON.parse(readText(p)); return s && s.records ? s : { records: {} }; } catch (e) { return { records: {} }; }
}

function saveState(dataDir, records) {
  const state = { generated_at: new Date().toISOString(), records: records };
  fs.writeFileSync(stateFile(dataDir), JSON.stringify(state, null, 2), 'utf8');
  return state;
}

function appendChange(dataDir, entry) {
  try { fs.appendFileSync(changesFile(dataDir), JSON.stringify(entry) + '\n', 'utf8'); } catch (e) { /* 忽略 */ }
}

/* ---------- 8. 核心：巡检 + 判定 + 修正 + 报告 ---------- */
function run(opts) {
  const o = opts || {};
  const repoRoot = path.resolve(o.repoRoot || __dirname);
  const dataDir = o.dataDir || path.join(repoRoot, 'data');

  // 1) 扫描来源：registry（权威）→ seed / frontend（补漏新 agent）→ panel（面板型老 agent）
  const registry = scanRegistry(dataDir);
  const seeds = scanSeeds(repoRoot);
  const frontends = scanFrontend(repoRoot);
  const cityverse = o.includeCityverse === false ? [] : scanCityverse(o.cityverseRoot);

  // 2) 合并去重：registry 优先；seed/frontend 只补 registry 没有的「新 agent」。
  //    前端页先按 slug 对齐 registry（同一 href 视为同一 agent，避免命名不一致重复）。
  const byKey = new Map();
  const slugToKey = new Map();
  registry.forEach(function (rec) {
    byKey.set(rec.key, rec);
    if (rec.slug) slugToKey.set(rec.slug, rec.key);
  });
  function absorb(rec) {
    if (!rec.key) return;
    // 前端页：若 slug 已对应某个 registry agent，则跳过（registry 已有权威记录）
    if (rec.slug && slugToKey.has(rec.slug)) return;
    if (!byKey.has(rec.key)) { byKey.set(rec.key, rec); }
  }
  seeds.forEach(absorb);
  frontends.forEach(absorb);
  // 面板型老 agent（秘书 / 监事 / 监督者 / 知识沉淀官）—— 不在 registry，但须审查到
  PANEL_AGENTS.forEach(function (nm) {
    const k = norm(nm);
    if (!byKey.has(k)) {
      byKey.set(k, { key: k, id: '', name: nm, role: 'worker', source: 'panel', href: '', emoji: '', currentType: '' });
    }
  });

  // 3) 读上次快照（判断 added / changed）+ 锁定状态
  const prev = loadState(dataDir).records || {};
  const registryByName = {};
  registry.forEach(function (r) { registryByName[r.name] = r; });

  // 4) 逐条判定
  const records = [];
  const changes = [];
  const counts = { active: 0, pipeline: 0, gap: 0, human: 0 };

  byKey.forEach(function (rec) {
    const det = determineType(rec.name, rec.source + ' ' + (rec.role || ''));
    const prevRec = prev[rec.key];
    const locked = !!(prevRec && prevRec.locked);
    // 锁定 → 用人工锁定的类型，不改
    const type = locked && prevRec.type ? prevRec.type : det.type;
    const meta = typeMeta(type);

    const outRec = {
      key: rec.key,
      id: rec.id || '',
      name: rec.name,
      role: rec.role || 'worker',
      source: rec.source,
      href: rec.href || '',
      emoji: rec.emoji || '',
      type: type,
      typeLabel: meta.label,
      badge: meta.badge,
      emojiType: meta.emoji,
      color: meta.color,
      locked: locked,
      manual: !!(prevRec && prevRec.manual),
      needsReview: !locked && det.needsReview === true,
      determinedBy: det.source,
    };
    counts[type] = (counts[type] || 0) + 1;
    records.push(outRec);

    // 变更判定
    if (!prevRec) {
      // 新出现的 agent
      changes.push({ name: rec.name, key: rec.key, from: '', to: type, kind: 'added', reason: '新 agent 首次归类：' + meta.label + '（' + det.source + '）', at: Date.now() });
    } else if (prevRec.type && prevRec.type !== type && !locked) {
      changes.push({ name: rec.name, key: rec.key, from: prevRec.type, to: type, kind: 'changed', reason: '类型由 ' + typeMeta(prevRec.type).label + ' 修正为 ' + meta.label + '（' + det.source + '）', at: Date.now() });
    } else if (prevRec.type && prevRec.type !== type && locked) {
      // 被锁定：类型与实际判定不一致 → 只提示，不改
      changes.push({ name: rec.name, key: rec.key, from: type, to: prevRec.type, kind: 'locked', reason: '已人工锁定为 ' + typeMeta(prevRec.type).label + '，本次不改', at: Date.now() });
    }
  });

  // CityVerse：只读参考，不写入 agent-types.json 的主 records，单独一节
  const cityverseRecords = cityverse.map(function (r) {
    const det = determineType(r.name, 'cityverse');
    const meta = typeMeta(det.type);
    return {
      key: r.key, name: r.name, type: det.type, typeLabel: meta.label,
      badge: meta.badge, emoji: meta.emoji, color: meta.color, source: 'cityverse（只读参考）',
      determinedBy: det.source,
    };
  });

  // 5) 写回 registry（agents.json 的 triggerType 字段）—— 默认自动修正
  //    只改「未被锁定」且「类型发生变化 / 尚未标注」的 registry agent
  let autoApplied = 0;
  if (dataDir && fs.existsSync(path.join(dataDir, 'agents.json'))) {
    try {
      const list = JSON.parse(readText(path.join(dataDir, 'agents.json')));
      if (Array.isArray(list)) {
        let dirty = false;
        list.forEach(function (a) {
          const nm = cleanName(a.name || '');
          const rec = byKey.get(nm);
          if (!rec) return;
          const det = determineType(rec.name, rec.source + ' ' + (rec.role || ''));
          const prevRec = prev[nm];
          const locked = !!(prevRec && prevRec.locked);
          const target = locked && prevRec.type ? prevRec.type : det.type;
          if (a.triggerType !== target) { a.triggerType = target; dirty = true; autoApplied++; }
        });
        if (dirty) fs.writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify(list, null, 2), 'utf8');
      }
    } catch (e) { /* 写回失败不阻断巡检 */ }
  }

  // 6) 持久化快照 + 变更历史（append-only）
  const snapshot = {};
  records.forEach(function (r) { snapshot[r.key] = r; });
  saveState(dataDir, snapshot);
  changes.forEach(function (c) { appendChange(dataDir, c); });

  const meaningful = changes.filter(function (c) { return c.kind === 'added' || c.kind === 'changed'; });

  return {
    agent: 'Agent 类型治理官',
    mode: '自动巡检 · 自动判定/修正 · 人工锁定豁免 · 变更报告',
    generated_at: new Date().toISOString(),
    summary: {
      scanned: records.length,
      active: counts.active || 0,
      pipeline: counts.pipeline || 0,
      gap: counts.gap || 0,
      human: counts.human || 0,
      added: changes.filter(function (c) { return c.kind === 'added'; }).length,
      changed: changes.filter(function (c) { return c.kind === 'changed'; }).length,
      locked: records.filter(function (r) { return r.locked; }).length,
      needsReview: records.filter(function (r) { return r.needsReview; }).length,
      autoApplied: autoApplied,
      cityverse_count: cityverseRecords.length,
    },
    hasChanges: meaningful.length > 0,
    changes: meaningful,
    lockedChanges: changes.filter(function (c) { return c.kind === 'locked'; }),
    records: records,
    cityverse: cityverseRecords,
  };
}

/* ---------- 9. 锁定 / 解锁 / 读取快照 ---------- */
function _mutateLock(dataDir, name, locked, type) {
  const state = loadState(dataDir);
  const rec = state.records[norm(name)];
  if (!rec) return null;
  rec.locked = locked;
  rec.manual = true;
  if (type && TRIGGER_TYPES[type]) rec.type = type;
  saveState(dataDir, state.records);
  return rec;
}

function lock(dataDir, name, type) {
  return _mutateLock(dataDir, name, true, type || undefined);
}
function unlock(dataDir, name) {
  return _mutateLock(dataDir, name, false, null);
}

/** 读当前治理快照（供面板渲染） */
function state(dataDir) {
  const s = loadState(dataDir);
  return { generated_at: (s.generated_at || ''), records: Object.keys(s.records || {}).map(function (k) { return s.records[k]; }) };
}

module.exports = {
  run: run,
  lock: lock,
  unlock: unlock,
  state: state,
  determineType: determineType,
  TRIGGER_TYPES: TRIGGER_TYPES,
  SEED_TYPES: SEED_TYPES,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const repoRoot = args[0] || __dirname;
  const dataDir = args[1] || path.join(repoRoot, 'data');
  console.log(JSON.stringify(run({ repoRoot: repoRoot, dataDir: dataDir }), null, 2));
}
