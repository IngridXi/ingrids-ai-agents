/**
 * ============================================================
 *  agent-ops-governor.js —— 运营治理三合一（CFO / 模型调控官 / Agent 总管）
 *  ============================================================
 *
 *  定位：把原「调度中枢」里散落的 API 成本 / 模型选择 / 团队健康，拆成三个治理 agent，
 *        共用一个纯函数引擎（本文件），面板分三个 tab（CFO 成本 / 模型调控 / Agent 总管）。
 *
 *  借鉴的开源范式（GitHub 调研结论）：
 *    - RouteLLM / Route42 / UncommonRoute：复杂度评分 → 本地小模型优先（零成本）→ 云端兜底；
 *    - Louter：按「内容分类」路由（code / math / translation / general），对应本文件的
 *      「分析不同 agent 该用什么模型」；
 *    - LiteLLM / llm-manager：降级链 + 超时/429/5xx 故障转移 + 成本账单；
 *    - 手动强制指定模型绕过自动判断 → 对应本文件的「锁定」机制。
 *
 *  三个治理 agent：
 *    1) CFO 成本官   analyzeCost()：实时聚合用量/费用（按 agent、按引擎、按天），预算状态，
 *                    recommendEngine()：分析每个 agent 该用什么模型（任务分类 + 成本加权）。
 *    2) 模型调控官  resolveModel()：本地优先（零成本）→ 本地占满/离线自动切 API；
 *                    lockModel/unlockModel/modelState：手动「锁定」模型才固定，否则自动分配。
 *    3) Agent 总管  auditWorkforce()：实时监控工作量 + 职责重叠检测 + 增/分割/合并建议。
 *
 *  铁律边界（人工在环）：
 *    - 默认自动分配模型/类型，不打扰人；
 *    - 手动「锁定」某 agent 的模型后，该 agent 不再被自动分配，直到解锁；
 *    - 本地模型可用且不占满时，优先本地（零边际成本）；本地占满/离线才切 API；
 *    - 变更 append-only 记入 ops-changes.jsonl，报告写 ops-governor.json。
 *
 *  用法（Node 侧）：
 *    const ops = require('./agent-ops-governor.js');
 *    const report = ops.run({ repoRoot, dataDir, localStatus });
 *    const pick = ops.resolveModel(agent, { localStatus, locks, defaultApi });
 *    ops.lockModel(dataDir, '研究助手', 'deepseek-v4-pro');
 *    ops.unlockModel(dataDir, '研究助手');
 *    const st = ops.modelState(dataDir);
 * ============================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* ============================================================
 * 1. 价格表（每百万 token 美元单价，与 main.js PRICES 对齐）
 * ============================================================ */
const PRICES = {
  'claude-code': { in: 3, out: 15 },
  codex: { in: 2, out: 10 },
  grok: { in: 2, out: 6 },
  dsh: { in: 0.28, out: 0.42 },
  deepseek: { in: 0.15, out: 0.60 },
  'deepseek-flash': { in: 0.15, out: 0.60 },
  'deepseek-v4-pro': { in: 0.66, out: 1.98 },
  gpt: { in: 2, out: 10 },
  qwen: { in: 0.4, out: 1.2 },
  'local-llm': { in: 0, out: 0 },
  funasr: { in: 0, out: 0 },
  // 本地 Ollama（走 127.0.0.1:11434，零边际 API 成本）
  ollama: { in: 0, out: 0 },
  'ollama-review': { in: 0, out: 0 },
  'ollama-vision': { in: 0, out: 0 },
};

/* ============================================================
 * 2. 引擎归类：本地（零边际成本）/ API（云端按量计费）/ CLI（会员订阅）
 * ============================================================ */
const ENGINE_CLASS = {
  'local-llm': 'local', funasr: 'local',
  ollama: 'local', 'ollama-review': 'local', 'ollama-vision': 'local',
  deepseek: 'api', 'deepseek-flash': 'api', 'deepseek-v4-pro': 'api',
  gpt: 'api', qwen: 'api', dsh: 'api',
  'claude-code': 'cli', codex: 'cli', grok: 'cli',
};
const ENGINE_LABEL = {
  'local-llm': '本地大模型', funasr: 'FunASR 语音',
  ollama: '本地 Ollama', 'ollama-review': '本地审稿模型', 'ollama-vision': '本地视觉模型',
  deepseek: 'DeepSeek', 'deepseek-flash': 'DeepSeek Flash', 'deepseek-v4-pro': 'DeepSeek V4 Pro',
  gpt: 'GPT', qwen: 'Qwen / 通义万相', dsh: 'DeepSeek Harness',
  'claude-code': 'Claude Code', codex: 'Codex', grok: 'Grok',
};

function engineClass(id) { return ENGINE_CLASS[id] || 'api'; }
function isLocal(id) { return engineClass(id) === 'local'; }
function isApi(id) { return engineClass(id) === 'api'; }
// 「本地占满/离线」只针对 Ollama 管理的 GPU 模型（显存争抢）。
// funasr 是独立的本地语音服务（CPU / 独立端口），不参与 Ollama 显存调度，永不因 Ollama 状态被切走。
function isOllamaManaged(id) {
  return ['ollama', 'ollama-review', 'ollama-vision', 'local-llm'].indexOf(id) >= 0;
}

/* ============================================================
 * 3. 任务分类 → 推荐模型（借鉴 Louter 内容分类路由 + Route42 成本加权）
 * ============================================================ */
// 每个任务类型一个「推荐链」：排前面的优先（本地零成本在前，云端按性价比排）。
// 链里只写后台执行器里真实可用的引擎，避免推荐出「创建即报未知引擎」的坑。
const TASK_MODEL_PREF = {
  coding: {
    label: '编码 / 工程', re: /开发|逆向|编译|补丁|反编译|代码|工程|二进制|软件工程|debug|dev|code|shell/i,
    chain: ['deepseek', 'local-llm', 'codex'],
    note: '代码生成与工程任务：DeepSeek 性价比高；本地模型兜底隐私敏感代码；Codex CLI 会员额度可用则用。',
  },
  reasoning: {
    label: '深度推理 / 合规', re: /伦理|合规|法律|监管|违法|深度|推理|分析|研判/i,
    chain: ['deepseek-v4-pro', 'ollama-review', 'deepseek'],
    note: '深度推理与合规研判：V4 Pro 推理最强；本地审稿模型（deepseek-r1:32b）零成本可降级；DeepSeek 兜底。',
  },
  research: {
    label: '研究 / 学术', re: /研究|论文|文献|综述|审稿|读博|调研|zotero|research/i,
    chain: ['deepseek', 'deepseek-v4-pro', 'local-llm'],
    note: '研究学术：DeepSeek 常规；深度论证用 V4 Pro；本地模型处理长文摘要零成本。',
  },
  writing: {
    label: '写作 / 总结', re: /写作|总结|改写|润色|文档|纪要|文案|通用|写作助手/i,
    chain: ['deepseek-flash', 'local-llm', 'deepseek'],
    note: '写作总结：DeepSeek Flash 最便宜且够用；本地模型可胜任简单改写，零成本。',
  },
  translation: {
    label: '翻译', re: /翻译|translat/i,
    chain: ['qwen', 'deepseek-flash', 'local-llm'],
    note: '翻译：Qwen 多语能力强；本地模型兜底。',
  },
  vision: {
    label: '视觉 / 识图', re: /识图|视觉|图片|截图|图像|vision/i,
    chain: ['ollama-vision', 'qwen'],
    note: '识图：本地视觉模型（qwen2.5vl:7b）零成本优先；云端用 Qwen 多模态兜底。',
  },
  audio: {
    label: '语音 / 音频', re: /语音|转写|录音|会议|朗读|声纹|tts|asr|音乐|作曲|写词/i,
    chain: ['funasr', 'deepseek'],
    note: '语音转写：FunASR 本机转写零成本；DeepSeek 兜底。',
  },
  general: {
    label: '通用', re: /./,
    chain: ['deepseek-flash', 'local-llm', 'deepseek'],
    note: '通用问答：DeepSeek Flash 最省；本地模型隐私优先。',
  },
};
const TASK_TYPE_ORDER = ['coding', 'reasoning', 'research', 'writing', 'translation', 'vision', 'audio', 'general'];

/** 给 agent 归类任务类型（按名称 + 描述 + 角色） */
function classifyTask(agent) {
  const hay = String((agent && agent.name) || '') + ' ' + String((agent && agent.description) || '') + ' ' + String((agent && agent.role) || '');
  for (let i = 0; i < TASK_TYPE_ORDER.length; i++) {
    const t = TASK_MODEL_PREF[TASK_TYPE_ORDER[i]];
    if (t.re.test(hay)) return { type: TASK_TYPE_ORDER[i], label: t.label };
  }
  return { type: 'general', label: '通用' };
}

/* ============================================================
 * 4. 工具函数
 * ============================================================ */
function readText(p) { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } }
function norm(name) { return String(name == null ? '' : name).replace(/\s+/g, '').toLowerCase(); }

function cleanName(raw) {
  let s = String(raw || '').trim();
  ["· Ingrid's AI Agents", '· Ingrid AI Agents', '· 工作台', '· CityVerse', '· 海归海独立智能助手']
    .forEach(function (suf) { while (s.indexOf(suf) >= 0) s = s.replace(suf, ''); });
  return s.trim();
}

function costOf(engine, tin, tout, model) {
  const p = PRICES[model] || PRICES[engine] || { in: 0, out: 0 };
  return ((Number(tin) || 0) * p.in + (Number(tout) || 0) * p.out) / 1e6;
}

/* ============================================================
 * 5. CFO 成本官：实时用量/费用聚合 + 预算状态
 * ============================================================ */
/**
 * analyzeCost({ agents, usageRows, budgetUsd })
 *  - usageRows: 用量记录数组（字段对齐 UsageLedger.record）
 *  - 返回：总额 / 按 agent / 按引擎 / 按天 / 预算状态 / 节省潜力
 */
function analyzeCost(opts) {
  const o = opts || {};
  const rows = Array.isArray(o.usageRows) ? o.usageRows : [];
  const budgetUsd = Number(o.budgetUsd) || 0;
  const agents = Array.isArray(o.agents) ? o.agents : [];

  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);

  const byAgent = {}, byEngine = {}, byDay = {}, byClass = { local: 0, api: 0, cli: 0 };
  let totalCost = 0, monthCost = 0, totalIn = 0, totalOut = 0, apiCalls = 0, localCalls = 0, cliCalls = 0;

  rows.forEach(function (r) {
    const eng = String(r.engine || 'other');
    const tin = Number(r.tokensIn) || 0;
    const tout = Number(r.tokensOut) || 0;
    const cost = Number(r.cost) || 0;
    const day = String(r.day || (r.at ? new Date(r.at).toISOString().slice(0, 10) : ''));
    const agentName = String(r.agentName || r.agentId || '未命名');
    const cls = engineClass(eng);

    // 按 agent
    if (!byAgent[agentName]) byAgent[agentName] = { agent: agentName, calls: 0, tokensIn: 0, tokensOut: 0, cost: 0, monthCost: 0 };
    byAgent[agentName].calls += 1; byAgent[agentName].tokensIn += tin; byAgent[agentName].tokensOut += tout; byAgent[agentName].cost += cost;
    if ((r.month || '') === thisMonth) byAgent[agentName].monthCost += cost;

    // 按引擎
    if (!byEngine[eng]) byEngine[eng] = { engine: eng, label: ENGINE_LABEL[eng] || eng, cls: cls, calls: 0, tokensIn: 0, tokensOut: 0, cost: 0, monthCost: 0 };
    byEngine[eng].calls += 1; byEngine[eng].tokensIn += tin; byEngine[eng].tokensOut += tout; byEngine[eng].cost += cost;
    if ((r.month || '') === thisMonth) byEngine[eng].monthCost += cost;

    // 按天
    if (day) byDay[day] = (byDay[day] || 0) + cost;

    // 汇总
    totalCost += cost; totalIn += tin; totalOut += tout;
    if ((r.month || '') === thisMonth) monthCost += cost;
    byClass[cls] += cost;
    if (cls === 'api') apiCalls += 1;
    else if (cls === 'local') localCalls += 1;
    else cliCalls += 1;
  });

  // 预算状态
  const budget = {
    budget: budgetUsd,
    monthCost: monthCost,
    remaining: budgetUsd > 0 ? Math.max(0, budgetUsd - monthCost) : Infinity,
    exceeded: budgetUsd > 0 && monthCost >= budgetUsd,
    ratio: budgetUsd > 0 ? monthCost / budgetUsd : 0,
  };

  // 节省潜力：按引擎聚合里，把「api 类成本」视为可被本地替代的潜在节省（上限）
  const apiCost = byClass.api || 0;
  const localRatio = totalCost > 0 ? (byClass.local || 0) / totalCost : 0;

  function sortObj(obj) {
    return Object.keys(obj).map(function (k) { return obj[k]; })
      .sort(function (a, b) { return b.cost - a.cost; });
  }

  return {
    agent: 'CFO 成本官',
    mode: '实时用量/费用聚合 · 预算监控 · 模型建议',
    generated_at: now.toISOString(),
    thisMonth: thisMonth,
    totals: {
      totalCost: totalCost, monthCost: monthCost,
      tokensIn: totalIn, tokensOut: totalOut,
      calls: rows.length, apiCalls: apiCalls, localCalls: localCalls, cliCalls: cliCalls,
      byClass: byClass, apiCost: apiCost, localRatio: localRatio,
    },
    budget: budget,
    byAgent: sortObj(byAgent),
    byEngine: sortObj(byEngine),
    byDay: byDay,
    // 建议：若 API 成本占比过高，提示本地优先
    hints: buildCostHints({ apiCost: apiCost, totalCost: totalCost, localRatio: localRatio, budget: budget, apiCalls: apiCalls, localCalls: localCalls }),
    agentCount: agents.length,
  };
}

function buildCostHints(ctx) {
  const hints = [];
  if (ctx.budget.exceeded) hints.push({ level: 'danger', text: '本月预算 $' + ctx.budget.budget.toFixed(2) + ' 已用尽，建议立即锁定成本或切换本地模型。' });
  else if (ctx.budget.budget > 0 && ctx.budget.ratio >= 0.8) hints.push({ level: 'warn', text: '预算已用 ' + Math.round(ctx.budget.ratio * 100) + '%（$' + ctx.budget.monthCost.toFixed(2) + ' / $' + ctx.budget.budget.toFixed(2) + '）。' });
  if (ctx.totalCost > 0 && ctx.localRatio < 0.3) hints.push({ level: 'info', text: '本地零成本调用仅占 ' + Math.round(ctx.localRatio * 100) + '%，API 成本 $' + ctx.apiCost.toFixed(2) + ' 偏高，建议把简单任务交给本地模型。' });
  if (ctx.totalCost === 0) hints.push({ level: 'info', text: '暂无真实 API 用量记录（演练/本地调用不计费）。' });
  return hints;
}

/* ============================================================
 * 6. CFO 成本官：分析「不同 agent 该用什么模型」
 * ============================================================ */
/**
 * recommendEngine(agent, { usageRows, localStatus })
 *  - 返回该 agent 的推荐模型（含理由 + 节省估算 + 候选链）
 */
function recommendEngine(agent, opts) {
  const o = opts || {};
  const a = agent || {};
  const name = cleanName(a.name || a.title || '');
  const usageRows = Array.isArray(o.usageRows) ? o.usageRows : [];
  const localStatus = o.localStatus || { online: false, busy: false };
  const current = a.engine || 'local-llm';

  const cls = classifyTask(a);
  const pref = TASK_MODEL_PREF[cls.type];

  // 该 agent 历史用量（按 engine 聚合 token）
  const hist = { in: 0, out: 0, calls: 0, cost: 0 };
  usageRows.forEach(function (r) {
    if (String(r.agentName || r.agentId) === name || String(r.agentName) === a.name) {
      hist.in += Number(r.tokensIn) || 0;
      hist.out += Number(r.tokensOut) || 0;
      hist.calls += 1;
      hist.cost += Number(r.cost) || 0;
    }
  });

  // 在推荐链里挑「首个可用」：本地引擎要求在线；api 引擎总是可用（有 key 与否由执行层判断）
  const candidates = pref.chain.map(function (eng) {
    const local = isLocal(eng);
    const usable = local ? (localStatus.online && !localStatus.busy) : true;
    return {
      engine: eng, label: ENGINE_LABEL[eng] || eng, cls: engineClass(eng),
      local: local, usable: usable,
      // 按历史 token 量估算切换后成本
      estMonthCost: costOf(eng, hist.in, hist.out),
    };
  });

  const top = candidates.find(function (c) { return c.usable; }) || candidates[0];
  const curLocal = isLocal(current);
  const savings = (hist.cost || 0) - (top.estMonthCost || 0);

  return {
    agent: name,
    taskType: cls.type,
    taskLabel: cls.label,
    currentEngine: current,
    currentClass: engineClass(current),
    recommendation: top.engine,
    recommendationLabel: top.label,
    recommendedClass: top.cls,
    reason: pref.note,
    why: curLocal ? '当前已是本地（零成本）' : (top.local ? '本地模型可胜任该任务，零边际成本' : '该任务需云端模型（' + top.label + ' 性价比最优）'),
    candidates: candidates,
    history: { calls: hist.calls, tokensIn: hist.in, tokensOut: hist.out, cost: hist.cost },
    estMonthCost: top.estMonthCost,
    estSavings: Math.max(0, savings),
    shouldSwitch: !curLocal && top.engine !== current && top.estMonthCost < (hist.cost || 0),
  };
}

/* ============================================================
 * 7. 模型调控官：本地优先 / 占满切 API / 锁定
 * ============================================================ */
/**
 * resolveModel(agent, ctx)
 *  ctx: { localStatus: { online, busy, activeCount }, locks: {agentKey:engine}, defaultApi }
 *  返回 { engine, switched, from, reason, locked }
 */
function resolveModel(agent, ctx) {
  const a = agent || {};
  const c = ctx || {};
  const key = norm(a.name || a.title || '');
  const locks = c.locks || {};
  const lockedEngine = locks[key];

  const primary = a.engine || 'local-llm';
  const fallbacks = Array.isArray(a.fallbacks) ? a.fallbacks : [];
  const localStatus = c.localStatus || { online: false, busy: false, activeCount: 0 };

  // 1) 人工锁定 → 固定用锁定的引擎，绝不自动改
  if (lockedEngine) {
    return { engine: lockedEngine, locked: true, switched: lockedEngine !== primary, from: primary, reason: '人工锁定为 ' + (ENGINE_LABEL[lockedEngine] || lockedEngine) };
  }

  // 2) 主引擎是 Ollama 管理的本地模型 → 本地优先，占满/离线才切 API
  //    （funasr 等独立本地服务不在此列，永不因 Ollama 状态被切走）
  if (isOllamaManaged(primary)) {
    if (!localStatus.online) {
      const api = pickApiFallback(fallbacks, c.defaultApi);
      return { engine: api, switched: true, from: primary, reason: '本地模型不在线（Ollama 未启动），自动切换 ' + (ENGINE_LABEL[api] || api) };
    }
    if (localStatus.busy) {
      const api = pickApiFallback(fallbacks, c.defaultApi);
      return { engine: api, switched: true, from: primary, reason: '本地模型已占满（显存中 ' + (localStatus.activeCount || 0) + ' 个模型 / 忙），自动切换 ' + (ENGINE_LABEL[api] || api) };
    }
    return { engine: primary, switched: false, from: primary, reason: '本地模型可用，零边际成本优先' };
  }

  // 3) 主引擎是 API → 默认维持；仅「明确简单」且本地空闲时降级到本地省钱
  if (c.allowLocalDowngrade !== false && localStatus.online && !localStatus.busy) {
    const hay = (a.name || '') + ' ' + (a.description || '');
    const simple = /总结|改写|润色|闲聊|翻译|纪要/.test(hay);
    if (simple) {
      return { engine: 'local-llm', switched: true, from: primary, reason: '简单任务本地零成本可胜任，自动降级本地' };
    }
  }

  // 4) 维持当前
  return { engine: primary, switched: false, from: primary, reason: '维持当前模型' };
}

/** 在降级链里挑第一个 API 引擎；没有则用 defaultApi / deepseek */
function pickApiFallback(fallbacks, defaultApi) {
  const chain = (Array.isArray(fallbacks) ? fallbacks : []).concat([defaultApi, 'deepseek']);
  for (let i = 0; i < chain.length; i++) {
    const id = chain[i];
    if (id && isApi(id)) return id;
  }
  return 'deepseek';
}

/* ---------- 模型锁定持久化：model-locks.json ---------- */
function locksFile(dataDir) { return path.join(dataDir || '', 'model-locks.json'); }
function changesFile(dataDir) { return path.join(dataDir || '', 'ops-changes.jsonl'); }

function loadLocks(dataDir) {
  const p = locksFile(dataDir);
  if (!p || !fs.existsSync(p)) return { locks: {} };
  try { const s = JSON.parse(readText(p)); return s && s.locks ? s : { locks: {} }; } catch (e) { return { locks: {} }; }
}
function saveLocks(dataDir, locks) {
  const st = { updatedAt: new Date().toISOString(), locks: locks };
  try { fs.writeFileSync(locksFile(dataDir), JSON.stringify(st, null, 2), 'utf8'); } catch (e) { /* 忽略 */ }
  return st;
}
function appendChange(dataDir, entry) {
  try { fs.appendFileSync(changesFile(dataDir), JSON.stringify(entry) + '\n', 'utf8'); } catch (e) { /* 忽略 */ }
}

function lockModel(dataDir, agentName, engine) {
  const st = loadLocks(dataDir);
  st.locks[norm(agentName)] = String(engine || '');
  saveLocks(dataDir, st.locks);
  appendChange(dataDir, { kind: 'model-lock', agent: cleanName(agentName), engine: String(engine || ''), at: Date.now() });
  return { agent: cleanName(agentName), engine: String(engine || ''), locked: true };
}
function unlockModel(dataDir, agentName) {
  const st = loadLocks(dataDir);
  delete st.locks[norm(agentName)];
  saveLocks(dataDir, st.locks);
  appendChange(dataDir, { kind: 'model-unlock', agent: cleanName(agentName), at: Date.now() });
  return { agent: cleanName(agentName), locked: false };
}
function modelState(dataDir) {
  const st = loadLocks(dataDir);
  return { updatedAt: st.updatedAt || '', locks: st.locks };
}

/* ============================================================
 * 8. Agent 总管：工作量监控 + 重叠检测 + 增/分割/合并建议
 * ============================================================ */
// 职责域关键词（精简自 agent-governance.js DOMAIN_KEYWORDS，用于重叠检测）
const DOMAIN_KEYWORDS = {
  '研究学术': ['研究', '论文', '文献', '发表', '审稿', '读博', 'Zotero', '综述', '实验'],
  '软件工程': ['开发', '逆向', '编译', '补丁', '反编译', '代码', '工程', '二进制', 'Shell'],
  '商业伦理': ['伦理', '合规', '案例', '商业', '法律', '监管', '违法'],
  '通用写作': ['通用', '写作', '文档', '总结', '改写'],
  '电脑操作': ['电脑', '鼠标', '键盘', '截图', '控制', '操作员', 'cliclick'],
  '知识管理': ['知识', 'RAG', '检索', '笔记', 'Obsidian', '术语', '知识库', '沉淀'],
  '会议音频': ['会议', '转写', '纪要', '声纹', '录音', '朗读', 'TTS'],
  '音乐创作': ['音乐', '作曲', '写词', '歌曲', 'MV', '翻唱', 'Suno'],
  '调度治理': ['调度', '路由', '指挥', '编排', '治理', '监督', '巡检', '沉淀官', 'CFO', '模型', '总管'],
  '秘书日程': ['日程', '日历', '邮件', '秘书', '提醒', '同步'],
};

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

// 治理面板型 agent（自身是控制面，不参与「增/分/合」建议）
const CONTROL_PLANE = ['调度中枢', '智能路由', '秘书', '监事', '监督者', '知识沉淀官', 'Agent 总控', 'CFO', '模型调控', 'Agent 总管', '类型治理'];

// 面板型老 agent（不在 registry / SEED_AGENTS，但仍提供能力，须计入「已覆盖」职责域）
const PANEL_AGENTS = ['秘书', '监事', '监督者', '知识沉淀官'];

/**
 * auditWorkforce({ agents, usageRows })
 *  - 实时工作量：每 agent 调用次数 / token / 成本
 *  - 职责重叠：两两共现职责域
 *  - 建议：工作量过低→合并；过高→分割；重叠→合并；职责真空→新增
 */
function auditWorkforce(opts) {
  const o = opts || {};
  const agents = Array.isArray(o.agents) ? o.agents : [];
  const rows = Array.isArray(o.usageRows) ? o.usageRows : [];

  // 工作量聚合
  const work = {};
  rows.forEach(function (r) {
    const nm = String(r.agentName || r.agentId || '未命名');
    if (!work[nm]) work[nm] = { agent: nm, calls: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
    work[nm].calls += 1;
    work[nm].tokensIn += Number(r.tokensIn) || 0;
    work[nm].tokensOut += Number(r.tokensOut) || 0;
    work[nm].cost += Number(r.cost) || 0;
  });

  // 每 agent 的职责域 + 工作量
  const profile = agents.map(function (a) {
    const name = cleanName(a.name || a.title || '');
    const text = name + ' ' + (a.description || '') + ' ' + (a.role || '');
    const domains = matchDomains(text);
    const w = work[name] || work[a.name] || { calls: 0, tokensIn: 0, tokensOut: 0, cost: 0 };
    return {
      name: name, role: a.role || 'worker', engine: a.engine || '',
      domains: domains, isControlPlane: CONTROL_PLANE.some(function (h) { return name.indexOf(h) >= 0; }),
      workload: { calls: w.calls, tokensIn: w.tokensIn, tokensOut: w.tokensOut, cost: w.cost },
    };
  });

  // 建议生成
  const suggestions = [];
  const workers = profile.filter(function (p) { return !p.isControlPlane; });

  // 重叠检测：只在「干活」的 worker 之间做。控制面 agent（秘书/监事/治理官等）共享
  // 「调度治理」域是设计使然，不算职责重叠——否则会把所有治理官互相判成重叠，健康度归零。
  const overlaps = [];
  const named = workers.filter(function (p) { return p.domains.length; });
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const shared = named[i].domains.filter(function (d) { return named[j].domains.indexOf(d) >= 0; });
      if (shared.length) overlaps.push({ a: named[i].name, b: named[j].name, shared: shared });
    }
  }

  // a) 职责重叠（非控制面）→ 建议合并
  overlaps.forEach(function (ov) {
    const a = workers.find(function (w) { return w.name === ov.a; });
    const b = workers.find(function (w) { return w.name === ov.b; });
    if (a && b) {
      suggestions.push({
        kind: 'merge', level: 'warn', title: '职责重叠：' + ov.a + ' ↔ ' + ov.b,
        detail: '两者都覆盖「' + ov.shared.join('、') + '」，建议合并为一个 agent 或明确分工边界。',
        agents: [ov.a, ov.b],
      });
    }
  });

  // b) 工作量过低 → 建议合并（冷门 agent）
  workers.forEach(function (w) {
    if (w.workload.calls === 0 && w.workload.cost === 0) {
      suggestions.push({
        kind: 'merge', level: 'info', title: '工作量过低：' + w.name,
        detail: '近期零调用、零成本，可能是空壳或已无人使用，建议合并进相近 agent 或下线。',
        agents: [w.name],
      });
    }
  });

  // c) 工作量过高 → 建议分割
  const MAX_CALLS = 500;   // 阈值可调：单 agent 调用过多说明负载过重
  workers.forEach(function (w) {
    if (w.workload.calls >= MAX_CALLS) {
      suggestions.push({
        kind: 'split', level: 'warn', title: '工作量过高：' + w.name,
        detail: '累计 ' + w.workload.calls + ' 次调用，负载偏重，建议按子任务拆分成多个专职 agent。',
        agents: [w.name],
      });
    }
  });

  // d) 职责真空 → 建议新增（常见职责域无 agent 覆盖）。
  //    注意：控制面 agent（秘书/监事/治理官等）同样提供能力，应计入「已覆盖」，
  //    只是不参与「合并/分割」建议——否则会误报「调度治理/知识管理/秘书日程」真空。
  const covered = {};
  profile.forEach(function (w) { (w.domains || []).forEach(function (d) { covered[d] = true; }); });
  Object.keys(DOMAIN_KEYWORDS).forEach(function (d) {
    if (!covered[d]) {
      suggestions.push({
        kind: 'add', level: 'info', title: '职责真空：' + d,
        detail: '「' + d + '」暂无任何 agent 覆盖，如需该能力，建议新增专职 agent。',
        agents: [],
      });
    }
  });

  // 健康度评分（0-100）
  const busyCount = workers.filter(function (w) { return w.workload.calls > 0; }).length;
  const utilization = workers.length ? (busyCount / workers.length) : 0;
  const overlapPenalty = Math.min(30, overlaps.length * 5);
  const health = Math.max(0, Math.min(100, Math.round(utilization * 70 + 30 - overlapPenalty)));

  return {
    agent: 'Agent 总管',
    mode: '实时工作量监控 · 职责重叠检测 · 增/分割/合并建议',
    generated_at: new Date().toISOString(),
    summary: {
      agents: agents.length, workers: workers.length, controlPlane: profile.length - workers.length,
      busyAgents: busyCount, utilization: utilization,
      overlapCount: overlaps.length, suggestionCount: suggestions.length,
      health: health,
    },
    profile: profile,
    overlaps: overlaps,
    suggestions: suggestions,
  };
}

/* ============================================================
 * 9. 扫描来源（供 run() 便捷装配）
 * ============================================================ */
function scanRegistry(dataDir) {
  if (!dataDir) return [];
  const p = path.join(dataDir, 'agents.json');
  if (!fs.existsSync(p)) return [];
  try { const list = JSON.parse(readText(p)); return Array.isArray(list) ? list : []; } catch (e) { return []; }
}

function scanSeeds(repoRoot) {
  const html = readText(path.join(repoRoot || '', 'index.html'));
  if (!html) return [];
  const m0 = html.match(/const\s+SEED_AGENTS\s*=\s*\[([\s\S]*?)\n\];/);
  const block = m0 ? m0[1] : html;
  const out = [];
  const re = /name:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(block)) !== null) out.push({ name: cleanName(m[1]), role: 'worker' });
  return out;
}

function scanUsage(dataDir) {
  if (!dataDir) return [];
  const dir = path.join(dataDir, 'usage');
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  try {
    fs.readdirSync(dir).filter(function (f) { return f.endsWith('.jsonl'); }).forEach(function (f) {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
      lines.forEach(function (line) {
        if (!line.trim()) return;
        try { rows.push(JSON.parse(line)); } catch (e) { /* 跳过坏行 */ }
      });
    });
  } catch (e) { /* 忽略 */ }
  return rows;
}

/* ============================================================
 * 10. 编排：run() 产出完整运营治理报告（供定时巡检 + 面板渲染）
 * ============================================================ */
function run(opts) {
  const o = opts || {};
  const repoRoot = path.resolve(o.repoRoot || __dirname);
  const dataDir = o.dataDir || path.join(repoRoot, 'data');
  const localStatus = o.localStatus || { online: false, busy: false, activeCount: 0 };

  // 装配 agents（registry 优先，seed 补漏，面板型老 agent 也计入）
  const registry = scanRegistry(dataDir);
  const seeds = scanSeeds(repoRoot);
  const byKey = new Map();
  registry.forEach(function (a) { byKey.set(norm(a.name || a.title || ''), a); });
  seeds.forEach(function (s) { if (!byKey.has(norm(s.name))) byKey.set(norm(s.name), s); });
  PANEL_AGENTS.forEach(function (nm) { if (!byKey.has(norm(nm))) byKey.set(norm(nm), { name: nm, role: 'orchestrator' }); });
  const agents = Array.from(byKey.values());

  const usageRows = scanUsage(dataDir);
  const budgetUsd = (function () { try { const b = JSON.parse(readText(path.join(dataDir, 'budget.json'))); return Number(b.usd) || 0; } catch (e) { return 0; } })();
  const locks = loadLocks(dataDir).locks || {};

  const cfo = analyzeCost({ agents: agents, usageRows: usageRows, budgetUsd: budgetUsd });

  // 每个 agent 的模型推荐 + 实际解析（锁定优先）
  const modelPlan = agents.map(function (a) {
    const rec = recommendEngine(a, { usageRows: usageRows, localStatus: localStatus });
    const pick = resolveModel(a, { localStatus: localStatus, locks: locks, defaultApi: rec.recommendation });
    return {
      agent: rec.agent,
      taskType: rec.taskType, taskLabel: rec.taskLabel,
      currentEngine: rec.currentEngine,
      recommended: rec.recommendation, recommendedLabel: rec.recommendationLabel,
      resolved: pick.engine, resolvedLabel: ENGINE_LABEL[pick.engine] || pick.engine,
      switched: pick.switched, locked: pick.locked, reason: pick.reason,
      estMonthCost: rec.estMonthCost, estSavings: rec.estSavings, shouldSwitch: rec.shouldSwitch,
    };
  });

  const workforce = auditWorkforce({ agents: agents, usageRows: usageRows });

  return {
    agent: '运营治理官（CFO + 模型调控 + Agent 总管）',
    mode: '本地优先 · 占满切 API · 人工锁定豁免 · 实时成本与团队健康',
    generated_at: new Date().toISOString(),
    localStatus: localStatus,
    cfo: cfo,
    modelPlan: modelPlan,
    workforce: workforce,
    locks: locks,
  };
}

module.exports = {
  run: run,
  analyzeCost: analyzeCost,
  recommendEngine: recommendEngine,
  resolveModel: resolveModel,
  auditWorkforce: auditWorkforce,
  lockModel: lockModel,
  unlockModel: unlockModel,
  modelState: modelState,
  classifyTask: classifyTask,
  PRICES: PRICES,
  ENGINE_CLASS: ENGINE_CLASS,
  ENGINE_LABEL: ENGINE_LABEL,
  isOllamaManaged: isOllamaManaged,
  TASK_MODEL_PREF: TASK_MODEL_PREF,
  DOMAIN_KEYWORDS: DOMAIN_KEYWORDS,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const repoRoot = args[0] || __dirname;
  const dataDir = args[1] || path.join(repoRoot, 'data');
  console.log(JSON.stringify(run({ repoRoot: repoRoot, dataDir: dataDir }), null, 2));
}
