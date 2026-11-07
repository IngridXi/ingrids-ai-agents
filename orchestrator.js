/**
 * ============================================================
 *  orchestrator.js — 调度中枢面板（渲染层，零依赖）
 *  ============================================================
 *  让一个 Agent（默认「智能路由 ra」）指挥其他 Agent 干活：
 *    · 委派 / 并行 / 串行 / 流水线
 *    · 审批卡片、限额自动切换、每次调用记账、月度预算、CSV 导出
 *    · v3 技能板块：板块切换 → 自动推荐 → 只挂载选中的 1–3 个 skill
 *      → 正文拼进本次任务的 soul → 注入 token 一起记账 → 用完即卸
 *    · v3 预设：板块 + agent + skills + 任务，存成一个首页方块
 *    · 默认「演练模式」：流程全真跑，但不调模型、不花钱
 *
 *  依赖：index.html 暴露的 window.__workbench、skills-core.js、agents-core.js
 * ============================================================
 */
(function () {
  'use strict';
  var wb = window.__workbench;
  var C = window.AgentsCore;
  var S = window.SkillsCore;
  if (!wb || !C || !S) return;

  var DESKTOP = wb.IS_DESKTOP;
  var registry = wb.registry;
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var usd = function (n) { return '$' + Number(n || 0).toFixed(4); };

  /* ---------- 浏览器预览用的最小样例（桌面版会换成真实扫描结果） ---------- */
  var DEMO_BOARDS = [{
    id: 'research', name: 'Research', emoji: '🔬', desc: '学术研究与论文写作',
    skillIds: ['demo:reviewer', 'demo:deai', 'demo:writing', 'demo:lit', 'demo:mentor'],
    defaultEngine: 'claude-code', color: '#2a746c',
  }];
  var DEMO_SKILLS = [
    { id: 'demo:reviewer', name: '审稿人', description: '以期刊同行评审标准审查论文，列出重大问题与证据缺口', category: 'research', boardIds: ['research'], enabled: true, scope: 'builtin', bytes: 3200, body: '你是期刊审稿人。只依据给定文本判断，不臆造文献与数据。按研究问题、论证链、方法、证据、贡献、表达、局限逐项审查，输出重大问题与可执行的修改建议。' },
    { id: 'demo:deai', name: '去 AI 味', description: '清除套话、机械排比、空洞总结，改成有判断的学术中文', category: 'research', boardIds: ['research'], enabled: true, scope: 'builtin', bytes: 2800, body: '只改表达，不改事实。先列出命中的 AI 写作痕迹，再给修订全文。删除套话开头、机械三段式、空洞形容词和万能结尾；每段只留一个主张并放在首句。' },
    { id: 'demo:writing', name: '写作', description: '论点先行、claim–evidence–warrant 结构、引用纪律', category: 'research', boardIds: ['research'], enabled: true, scope: 'builtin', bytes: 3000, body: '每段一个主张：Claim 放首句，随后 Evidence、Warrant、Qualifier。不编造文献、作者、页码；缺来源时写 [需补引]。' },
    { id: 'demo:lit', name: '文献综述', description: '结构化单篇分诊 + 跨文献综合，输出可核查表格', category: 'research', boardIds: ['research'], enabled: true, scope: 'builtin', bytes: 3400, body: '先逐篇分诊：relevance_score、research_role、理论/方法/实证相关性、useful_for、cautions。再按主题脉络综合，写清共识、分歧与研究空白。只依据给定材料。' },
    { id: 'demo:mentor', name: '研究导师', description: '选题、研究问题、方法、章节推进，先澄清再给建议', category: 'research', boardIds: ['research'], enabled: true, scope: 'builtin', bytes: 3100, body: '先澄清（最多 3 问），再给一条核心判断、依据与风险、下一步最小可完成动作。不做代写，不替用户决定选题。' },
  ].map(function (r) { r.estTokens = Math.ceil(r.body.length / 4); return r; });
  var DEMO_BODIES = {};
  DEMO_SKILLS.forEach(function (r) { DEMO_BODIES[r.id] = r.body; });

  /* ---------- 三个注册表：板块 / 技能 / 预设 ---------- */
  function boardStorage() {
    if (!DESKTOP) return null;
    return {
      load: function () { return window.ingrid.loadBoardsSync(); },
      save: function (b) { window.ingrid.saveBoards(b); },
    };
  }
  function presetStorage() {
    if (!DESKTOP) return null;
    return {
      load: function () { return window.ingrid.loadPresetsSync(); },
      save: function (p) { window.ingrid.savePresets(p); },
    };
  }
  function ledgerStorage() {
    if (!DESKTOP) return null;
    return {
      load: function () { return window.ingrid.loadUsageSync(); },
      append: function (r) { window.ingrid.recordUsage(r); },
      clear: function () { window.ingrid.clearUsage(); },
      getBudget: function () { return window.ingrid.getBudgetSync(); },
      setBudget: function (n) { window.ingrid.setBudgetSync(n); },
    };
  }

  var scan;
  try { scan = DESKTOP ? window.ingrid.scanSkillsSync() : null; }
  catch (e) { scan = null; }
  if (!scan || !scan.records) scan = { boards: DEMO_BOARDS, records: DEMO_SKILLS, stats: {} };
  var boards = new S.BoardRegistry(scan.boards, boardStorage());
  var skills = new S.SkillRegistry(scan.records);
  var presets = new S.PresetStore(presetStorage());
  window.__skills = { boards: boards, skills: skills, presets: presets, scan: scan };

  var ledger = new C.UsageLedger(ledgerStorage());
  var router = new C.ModelRouter();
  var eventLog = [];
  var realMode = false;

  // 面板状态（render() 重建 DOM 时靠这些变量恢复）
  var currentBoardId = (boards.list()[0] || {}).id || '';
  var selectedIds = [];
  var skillQuery = '';
  var showImport = false;

  function log(type, payload) {
    eventLog.push({ type: type, at: Date.now(), payload: payload || {} });
    if (eventLog.length > 60) eventLog.shift();
    renderEventLog();
  }

  /* ---------- 执行器：soul 用 ctx.soul（已含本次挂载的技能正文） ---------- */
  var executor = DESKTOP
    ? function (agent, task, ctx) {
        return window.ingrid.runAgent({
          prompt: task, engine: ctx.engine, soul: ctx.soul || agent.soul || '',
          dryRun: !!ctx.dryRun,
        });
      }
    : null;

  /* ---------- 按需读技能正文（桌面走主进程只读通道） ---------- */
  function readBodies(ids) {
    return Promise.all(ids.map(function (id) {
      if (DESKTOP) return window.ingrid.readSkill(id);
      return Promise.resolve({ id: id, name: (skills.byId(id) || {}).name, body: DEMO_BODIES[id] || '' });
    })).then(function (rows) {
      return rows.map(function (r) {
        return { id: r.id, name: r.name || (skills.byId(r.id) || {}).name, body: r.body || '' };
      }).filter(function (r) { return r.body; });
    });
  }

  /* ---------- 审批队列 ---------- */
  var pendingApprovals = [], approvalBusy = false;
  function askApproval(req) {
    return new Promise(function (resolve) {
      pendingApprovals.push({ req: req, resolve: resolve });
      showNextApproval();
    });
  }
  function showNextApproval() {
    var box = document.getElementById('orch-approval');
    if (!box || approvalBusy || !pendingApprovals.length) return;
    approvalBusy = true;
    var item = pendingApprovals[0];
    box.style.display = 'block';
    box.innerHTML = '<div class="oa-card">' +
      '<div class="oa-title">⏸ 需要你批准</div>' +
      '<div class="oa-body"><b>' + esc(item.req.commander.name) + '</b> 想让 <b>' + esc(item.req.target.name) +
      '</b> 执行：<br><span>' + esc(item.req.task) + '</span></div>' +
      '<div class="oa-actions"><button id="oa-yes">批准执行</button><button id="oa-no">跳过</button></div></div>';
    function done(v) {
      pendingApprovals.shift(); approvalBusy = false;
      box.style.display = 'none'; box.innerHTML = '';
      item.resolve(v); showNextApproval();
    }
    document.getElementById('oa-yes').addEventListener('click', function () { done(true); });
    document.getElementById('oa-no').addEventListener('click', function () { done(false); });
  }

  var orch = new C.AgentOrchestrator({
    registry: registry, router: router, ledger: ledger, executor: executor,
    onEvent: log, onApproval: askApproval,
  });
  window.__orchestrator = orch;
  window.__ledger = ledger;

  /* ---------- 样式 ---------- */
  var style = document.createElement('style');
  style.textContent = [
    '.orch-modal{width:min(920px,100%);}',
    '.orch-bar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;}',
    '.orch-stat{flex:1;min-width:130px;background:#f6f9f8;border:1px solid var(--line);border-radius:12px;padding:11px 14px;}',
    '.orch-stat .k{font-size:11px;color:var(--ink-faint);font-weight:600;}',
    '.orch-stat .v{font-size:17px;font-weight:700;margin-top:3px;color:var(--ink);}',
    '.orch-stat.alert{background:#fdf3e5;border-color:#ecdfc0;} .orch-stat.alert .v{color:#8a7043;}',
    '.orch-cols{display:grid;grid-template-columns:1fr 1fr;gap:18px;}',
    '@media(max-width:720px){.orch-cols{grid-template-columns:1fr;}}',
    '.orch-field{margin-bottom:12px;}',
    '.orch-field label{display:block;font-size:12px;font-weight:700;color:var(--ink-faint);margin-bottom:6px;}',
    '.orch-field input[type=text],.orch-field textarea,.orch-field select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font-size:13px;color:var(--ink);background:#fff;font-family:inherit;}',
    '.orch-field textarea{resize:vertical;min-height:70px;line-height:1.6;}',
    '.orch-targets{max-height:190px;overflow:auto;border:1px solid var(--line);border-radius:11px;background:#fff;}',
    '.orch-target{display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid #f0f3f2;cursor:pointer;font-size:13px;}',
    '.orch-target:last-child{border-bottom:none;} .orch-target:hover{background:#f6f9f8;}',
    '.orch-target input{accent-color:var(--accent);width:15px;height:15px;flex:none;}',
    '.orch-target .tn{font-weight:650;flex:1;}',
    '.orch-target .te{font-size:11px;color:var(--gold-text);background:#f7f1e3;padding:2px 8px;border-radius:999px;white-space:nowrap;}',
    '.orch-target .ta{font-size:10.5px;color:var(--ink-faint);}',
    '.orch-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:16px 0 8px;}',
    '.orch-btn{padding:10px 20px;border:none;border-radius:11px;background:var(--accent);color:#fff;font-size:14px;font-weight:650;cursor:pointer;}',
    '.orch-btn:hover{background:var(--accent-2);} .orch-btn:disabled{opacity:.55;cursor:default;}',
    '.orch-btn.ghost{background:#fff;color:var(--ink-soft);border:1px solid var(--line);font-size:12.5px;padding:8px 13px;}',
    '.orch-check{display:flex;align-items:center;gap:7px;font-size:12.5px;color:var(--ink-soft);cursor:pointer;}',
    '.orch-check input{accent-color:var(--accent);}',
    '.orch-results{margin-top:6px;display:flex;flex-direction:column;gap:9px;max-height:230px;overflow:auto;}',
    '.orch-res{border:1px solid var(--line);border-radius:11px;padding:11px 13px;background:#fff;font-size:12.5px;}',
    '.orch-res .rh{display:flex;align-items:center;gap:9px;flex-wrap:wrap;}',
    '.orch-res .rn{font-weight:700;font-size:13.5px;}',
    '.orch-res .rs{font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:999px;}',
    '.orch-res .rs.ok{background:#e2f1ee;color:var(--accent);} .orch-res .rs.err{background:#fbe9e6;color:var(--danger);}',
    '.orch-res .rs.skip{background:#f1f3f2;color:var(--ink-faint);}',
    '.orch-res .rm{color:var(--ink-faint);font-size:11.5px;}',
    '.orch-res .rt{margin-top:7px;color:var(--ink-soft);line-height:1.6;white-space:pre-wrap;max-height:90px;overflow:auto;background:#f8faf9;border-radius:8px;padding:8px 10px;}',
    '.orch-switch{color:#8a7043;font-weight:650;}',
    '.orch-log{margin-top:10px;background:#f8faf9;border:1px solid var(--line);border-radius:11px;padding:10px 12px;max-height:110px;overflow:auto;font-size:11.5px;color:var(--ink-soft);line-height:1.75;}',
    '.orch-log .lg-sw{color:#8a7043;font-weight:700;} .orch-log .lg-er{color:var(--danger);font-weight:700;}',
    '.orch-foot{display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin-top:16px;padding-top:14px;border-top:1px solid var(--line);}',
    '.orch-foot input{width:96px;padding:7px 10px;border:1px solid var(--line);border-radius:9px;font-size:12.5px;}',
    '.orch-note{font-size:11.5px;color:var(--ink-faint);line-height:1.6;margin-top:8px;}',
    '#orch-approval{display:none;position:fixed;inset:0;background:rgba(23,59,73,.45);z-index:80;align-items:center;justify-content:center;padding:24px;}',
    '#orch-approval[style*="block"]{display:flex;}',
    '.oa-card{width:min(430px,100%);background:#fff;border-radius:18px;padding:24px;box-shadow:var(--shadow-lg);}',
    '.oa-title{font-size:17px;font-weight:700;margin-bottom:12px;}',
    '.oa-body{font-size:13.5px;line-height:1.7;color:var(--ink-soft);}',
    '.oa-body span{display:inline-block;margin-top:8px;background:#f6f9f8;border-radius:8px;padding:8px 10px;font-size:12.5px;}',
    '.oa-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:20px;}',
    '.oa-actions button{padding:9px 16px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--ink-soft);font-size:13px;font-weight:650;cursor:pointer;}',
    '.oa-actions #oa-yes{background:var(--accent);border-color:var(--accent);color:#fff;}',
    '.sk-tabs{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:9px;}',
    '.sk-tab{padding:5px 12px;border-radius:999px;border:1px solid var(--line);background:#fff;font-size:12px;color:var(--ink-soft);cursor:pointer;}',
    '.sk-tab.on{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:650;}',
    '.sk-tab.plus{border-style:dashed;color:var(--ink-faint);}',
    '.sk-rec{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:8px;min-height:26px;}',
    '.sk-rec .lb{font-size:11px;color:var(--ink-faint);margin-right:2px;}',
    '.sk-chip{padding:4px 10px;border-radius:999px;border:1px solid #ecdfc0;background:#faf6ec;font-size:11.5px;color:#6b5a34;cursor:pointer;}',
    '.sk-chip:hover{border-color:var(--gold);} .sk-chip.picked{background:var(--accent-soft);border-color:var(--accent);color:var(--accent);}',
    '.sk-list{max-height:168px;overflow:auto;border:1px solid var(--line);border-radius:10px;background:#fff;}',
    '.sk-row{display:flex;align-items:flex-start;gap:9px;padding:8px 10px;border-bottom:1px solid #f0f3f2;cursor:pointer;font-size:12.5px;}',
    '.sk-row:last-child{border-bottom:none;} .sk-row:hover{background:#f6f9f8;}',
    '.sk-row input{accent-color:var(--accent);margin-top:2px;flex:none;}',
    '.sk-row .sn{font-weight:650;color:var(--ink);}',
    '.sk-row .sd{font-size:11px;color:var(--ink-faint);line-height:1.45;margin-top:2px;}',
    '.sk-row .sx{font-size:10px;padding:2px 6px;border-radius:6px;background:#f7f1e3;color:var(--gold-text);white-space:nowrap;margin-top:2px;}',
    '.sk-row .sx.auth{background:#fbe9e6;color:var(--danger);}',
    '.sk-foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px;}',
    '.sk-foot button{padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:#fff;font-size:11.5px;color:var(--ink-soft);cursor:pointer;}',
    '.sk-foot button:hover{border-color:var(--accent);}',
    '.sk-est{margin-left:auto;font-size:11.5px;font-weight:650;color:var(--gold-text);}',
    '.sk-warn{font-size:11px;color:var(--danger);margin-top:5px;}',
    '.orch-preset{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap;}',
    '.orch-preset select{flex:1;min-width:130px;padding:7px 9px;border:1px solid var(--line);border-radius:9px;font-size:12px;background:#fff;color:var(--ink);}',
  ].join('\n');
  document.head.appendChild(style);

  /* ---------- DOM ---------- */
  var mask = document.createElement('div');
  mask.className = 'mask'; mask.id = 'orchMask';
  var modal = document.createElement('div');
  modal.className = 'modal orch-modal'; modal.id = 'orchModal';
  mask.appendChild(modal); document.body.appendChild(mask);

  var approval = document.createElement('div');
  approval.id = 'orch-approval'; document.body.appendChild(approval);

  var entry = document.createElement('button');
  entry.className = 'chip chip-btn'; entry.id = 'btnOrchestrator';
  entry.textContent = '🎛️ 调度中枢';
  entry.title = '让一个 Agent 指挥其他 Agent 干活';
  var meta = document.querySelector('.topbar .meta');
  if (meta) meta.insertBefore(entry, document.getElementById('btnSettings'));
  entry.addEventListener('click', open);
  window.__openOrchestrator = open;

  function close() { mask.classList.remove('open'); }
  mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && mask.classList.contains('open')) close();
  });

  /* ---------- 通用渲染 ---------- */
  function agents() { return registry.list(); }
  function commanderId() {
    var a = agents().filter(function (x) {
      return x.role === 'orchestrator' || x.canControl === true || /路由|调度|\bra\b/i.test(x.name || '');
    })[0];
    return a ? a.id : (agents()[0] ? agents()[0].id : '');
  }
  function budgetHtml() {
    var b = ledger.budgetStatus();
    var m = ledger.summary({ month: ledger.currentMonth() });
    return '<div class="orch-stat"><div class="k">本月实际花费</div><div class="v">' + usd(m.spent) + '</div></div>' +
      '<div class="orch-stat"><div class="k">演练估算（未花钱）</div><div class="v">' + usd(m.simulated) + '</div></div>' +
      '<div class="orch-stat' + (b.exceeded ? ' alert' : '') + '"><div class="k">月度预算</div><div class="v">' +
        (b.budget > 0 ? usd(b.budget) + (b.exceeded ? ' · 已超' : '') : '未设置') + '</div></div>' +
      '<div class="orch-stat"><div class="k">调用次数</div><div class="v">' + m.count + '</div></div>';
  }

  /* ---------- 技能区（独立重绘，不重建整个面板，任务文字不丢） ---------- */
  function boardRows() {
    return boards.list().map(function (b) {
      return '<button class="sk-tab' + (b.id === currentBoardId ? ' on' : '') + '" data-board="' + esc(b.id) + '">' +
        esc(b.emoji + ' ' + b.name) + ' <span style="opacity:.7">' + b.skillIds.length + '</span></button>';
    }).join('') + '<button class="sk-tab plus" id="sk-newboard">＋ 板块</button>';
  }
  function skillRows() {
    var q = skillQuery.trim();
    var rows = showImport
      ? skills.search(q, 0, { enabledOnly: false }).filter(function (r) { return r.scope === 'local'; })
      : skills.search(q, 0, { boardId: currentBoardId, enabledOnly: true });
    if (!rows.length) {
      return '<div style="padding:12px;color:var(--ink-faint);font-size:12px">' +
        (showImport ? '本机没有找到可导入的 skill' : '这个板块还没有技能，点「从本机导入」或新建板块') + '</div>';
    }
    return rows.slice(0, 60).map(function (r) {
      if (showImport) {
        return '<div class="sk-row" data-import="' + esc(r.id) + '">' +
          '<div style="flex:1"><div class="sn">' + esc(r.name) + '</div>' +
          '<div class="sd">' + esc(r.description.slice(0, 90) || r.rel) + '</div></div>' +
          '<span class="sx">' + (r.enabled ? '已在本板块' : '＋ 加入') + '</span></div>';
      }
      var picked = selectedIds.indexOf(r.id) >= 0;
      return '<label class="sk-row"><input type="checkbox" class="sk-cb" value="' + esc(r.id) + '"' + (picked ? ' checked' : '') + '>' +
        '<div style="flex:1;min-width:0"><div class="sn">' + esc(r.name) + '</div>' +
        '<div class="sd">' + esc(r.description.slice(0, 90) || '（无描述）') + '</div></div>' +
        (r.executable ? '<span class="sx auth">需授权</span>' : '<span class="sx">' + Math.ceil(r.estTokens / 100) / 10 + 'k tok</span>') +
        '</label>';
    }).join('');
  }
  function estimateHtml() {
    var est = skills.estimate(selectedIds, C.ENGINES);
    var worst = 0;
    for (var k in est.perEngine) worst = Math.max(worst, est.perEngine[k]);
    var warn = selectedIds.length > skills.maxSkills
      ? '<div class="sk-warn">已选 ' + selectedIds.length + ' 个，建议不超过 ' + skills.maxSkills + ' 个（上下文与费用都会上升）</div>' : '';
    return '<span class="sk-est">已选 ' + est.count + ' · 约 ' + est.tokens.toLocaleString() +
      ' token · 单次最多 ' + usd(worst) + '</span>' + warn;
  }
  function renderRecommend() {
    var box = document.getElementById('sk-rec');
    if (!box) return;
    var task = (document.getElementById('orch-task') || {}).value || '';
    var rec = skills.recommend(task, { boardId: currentBoardId, limit: 3 });
    box.innerHTML = '<span class="lb">自动推荐</span>' + rec.map(function (x) {
      var picked = selectedIds.indexOf(x.skill.id) >= 0;
      return '<button class="sk-chip' + (picked ? ' picked' : '') + '" data-rec="' + esc(x.skill.id) + '" title="' +
        esc(x.reasons.join(' / ')) + '">' + esc(x.skill.name) + (picked ? ' ✓' : ' ＋') + '</button>';
    }).join('');
    box.querySelectorAll('[data-rec]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-rec');
        var i = selectedIds.indexOf(id);
        if (i >= 0) selectedIds.splice(i, 1); else selectedIds.push(id);
        renderSkillBox();
      });
    });
  }
  function renderSkillBox() {
    var box = document.getElementById('sk-box');
    if (!box) return;
    box.innerHTML =
      '<div class="orch-field"><label>挂载技能 · 只在本次任务生效</label>' +
        '<div class="sk-tabs">' + boardRows() + '</div>' +
        '<div class="sk-rec" id="sk-rec"></div>' +
        '<input type="text" id="sk-search" placeholder="' + (showImport ? '搜索本机全部 skill…' : '搜索本板块技能…') + '" value="' + esc(skillQuery) + '">' +
        '<div class="sk-list" id="sk-list" style="margin-top:8px">' + skillRows() + '</div>' +
        '<div class="sk-foot">' +
          '<button id="sk-import">' + (showImport ? '← 返回本板块' : '从本机导入…') + '</button>' +
          '<button id="sk-rescan">重新扫描</button>' +
          estimateHtml() +
        '</div>' +
        '<div class="orch-note">索引只放名字与简介；勾选后才读正文并拼进本次请求的 soul，用完即卸。' +
          '带「需授权」标记的是含脚本的本机 skill，目前只注入说明书、不执行脚本。</div>' +
      '</div>';
    renderRecommend();
    bindSkillBox();
  }
  function bindSkillBox() {
    var box = document.getElementById('sk-box');
    if (!box) return;
    box.querySelectorAll('[data-board]').forEach(function (b) {
      b.addEventListener('click', function () {
        currentBoardId = b.getAttribute('data-board'); showImport = false;
        selectedIds = selectedIds.filter(function (id) {
          var r = skills.byId(id); return r && r.boardIds.indexOf(currentBoardId) >= 0;
        });
        renderSkillBox();
      });
    });
    box.querySelector('#sk-newboard').addEventListener('click', function () {
      var name = prompt('新板块名字（例如：Writing / 教学 / 投资）');
      if (!name || !name.trim()) return;
      var b = boards.create({ name: name.trim(), emoji: '📁', desc: '', skillIds: [] });
      currentBoardId = b.id; showImport = false; selectedIds = [];
      refreshHome(); renderSkillBox(); tip('已新建板块：' + b.name);
    });
    box.querySelector('#sk-import').addEventListener('click', function () {
      showImport = !showImport; skillQuery = ''; renderSkillBox();
    });
    box.querySelector('#sk-rescan').addEventListener('click', function () {
      if (!DESKTOP) { tip('浏览器预览用的是内置示例技能'); return; }
      var fresh = window.ingrid.scanSkillsSync();
      skills = new S.SkillRegistry(fresh.records);
      boards = new S.BoardRegistry(fresh.boards, boardStorage());
      window.__skills = { boards: boards, skills: skills, presets: presets, scan: fresh };
      selectedIds = selectedIds.filter(function (id) { return skills.byId(id); });
      renderSkillBox(); tip('已重新扫描：共 ' + fresh.records.length + ' 条，本工作台启用 ' + fresh.stats.enabled + ' 条');
    });
    var search = box.querySelector('#sk-search');
    search.addEventListener('input', function () {
      skillQuery = search.value;
      var list = box.querySelector('#sk-list');
      if (list) list.innerHTML = skillRows();
      bindRows();
    });
    bindRows();
  }
  function bindRows() {
    var list = document.getElementById('sk-list');
    if (!list) return;
    list.querySelectorAll('.sk-cb').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = cb.value, i = selectedIds.indexOf(id);
        if (cb.checked && i < 0) selectedIds.push(id);
        if (!cb.checked && i >= 0) selectedIds.splice(i, 1);
        renderSkillBox();
      });
    });
    list.querySelectorAll('[data-import]').forEach(function (row) {
      row.addEventListener('click', function () {
        var id = row.getAttribute('data-import');
        var rec = skills.byId(id);
        if (!rec) return;
        rec.enabled = true;
        if (rec.boardIds.indexOf(currentBoardId) < 0) rec.boardIds.push(currentBoardId);
        var board = boards.get(currentBoardId);
        if (board) boards.addSkill(currentBoardId, id);
        if (selectedIds.indexOf(id) < 0) selectedIds.push(id);
        renderSkillBox(); refreshHome(); tip('已把「' + rec.name + '」加入 ' + (board ? board.name : '本板块'));
      });
    });
  }
  function refreshHome() {
    if (wb.renderAgents) wb.renderAgents();
  }

  /* ---------- 完整面板 ---------- */
  function render() {
    var list = agents();
    var cid = commanderId();
    var cmdOpts = list.map(function (a) {
      return '<option value="' + esc(a.id) + '"' + (a.id === cid ? ' selected' : '') + '>' +
        esc(a.emoji + ' ' + a.name) + (a.role === 'orchestrator' ? '（调度者）' : '') + '</option>';
    }).join('');
    var targets = list.filter(function (a) { return a.id !== cid; }).map(function (a) {
      var pick = router.resolve(a);
      var lim = router.limits()[a.engine] ? ' · 主引擎限额中' : '';
      return '<label class="orch-target">' +
        '<input type="checkbox" class="ot" value="' + esc(a.id) + '">' +
        '<span class="tn">' + esc(a.emoji + ' ' + a.name) + '</span>' +
        '<span class="te">' + esc(pick.engine) + (pick.switched ? ' ↳降级' : '') + esc(lim) + '</span>' +
        '<span class="ta">' + esc(a.approvalMode === 'ask' ? '需批准' : '自动') + '</span></label>';
    }).join('');
    var presetOpts = '<option value="">（选择一个预设）</option>' + presets.list().map(function (p) {
      return '<option value="' + esc(p.id) + '">' + esc(p.emoji + ' ' + p.name) + '</option>';
    }).join('');

    modal.innerHTML =
      '<header><div class="emoji">🎛️</div><div><h2>调度中枢</h2>' +
        '<div class="sub">一个 Agent 指挥其他 Agent · 按板块挂载技能 · 限额切换 · 成本记账</div></div>' +
        '<button class="close" id="orch-close">✕</button></header>' +
      '<div class="orch-bar" id="orch-bar">' + budgetHtml() + '</div>' +
      '<div class="orch-cols">' +
        '<div>' +
          '<div class="orch-field"><label>指挥官（有权限调度的 Agent）</label><select id="orch-cmd">' + cmdOpts + '</select></div>' +
          '<div class="orch-field"><label>任务内容</label><textarea id="orch-task" placeholder="例如：审一下这段讨论，重点看论证链和证据缺口"></textarea>' +
            '<div style="margin-top:6px"><button class="orch-btn ghost" id="orch-ra">🧭 让 ra 自动判断：派谁 + 挂哪些 skill</button></div></div>' +
          '<div class="orch-field"><label>执行方式</label><select id="orch-mode">' +
            '<option value="parallel">并行 · 同时派给所有人</option>' +
            '<option value="sequential">串行 · 一个接一个</option>' +
            '<option value="chain">流水线 · 上一位的结果传给下一位</option></select></div>' +
          '<div id="sk-box"></div>' +
        '</div>' +
        '<div>' +
          '<div class="orch-field"><label>派给哪些 Agent</label><div class="orch-targets">' +
            (targets || '<div style="padding:14px;color:var(--ink-faint);font-size:12.5px">还没有可派的 Agent</div>') +
          '</div></div>' +
          '<label class="orch-check" style="margin-top:10px"><input type="checkbox" id="orch-auto"> 自动批准（跳过审批卡片）</label>' +
          '<label class="orch-check" style="margin-top:8px"><input type="checkbox" id="orch-real"> 真实调用模型（需先在引擎设置里开启并配置 CLI / API Key）</label>' +
          '<div class="orch-note">不勾选就是<b>演练模式</b>：委派、审批、限额切换、技能注入、记账全流程照跑，但不调用真实模型、不产生费用。</div>' +
          '<div class="orch-field" style="margin-top:16px"><label>常用组合（存成首页方块）</label>' +
            '<div class="orch-preset"><select id="orch-preset">' + presetOpts + '</select>' +
            '<button class="orch-btn ghost" id="orch-applypreset">应用</button>' +
            '<button class="orch-btn ghost" id="orch-savepreset">存当前为预设</button>' +
            '<button class="orch-btn ghost" id="orch-delpreset">删除</button></div></div>' +
        '</div>' +
      '</div>' +
      '<div class="orch-actions"><button class="orch-btn" id="orch-run">▶ 开始委派</button>' +
        '<button class="orch-btn ghost" id="orch-refresh">刷新状态</button>' +
        '<span id="orch-tip" style="font-size:12px;color:var(--ink-faint)"></span></div>' +
      '<div class="orch-results" id="orch-results"></div>' +
      '<div class="orch-log" id="orch-log"></div>' +
      '<div class="orch-foot">' +
        '<span style="font-size:12.5px;font-weight:650;color:var(--ink-soft)">月度预算 $</span>' +
        '<input type="text" id="orch-budget" placeholder="0 = 不限" value="' + esc(ledger.getBudget() || '') + '">' +
        '<button class="orch-btn ghost" id="orch-savebudget">保存预算</button>' +
        '<button class="orch-btn ghost" id="orch-export">导出 CSV</button>' +
        '<button class="orch-btn ghost" id="orch-clear">清空账本</button>' +
        '<button class="orch-btn ghost" id="orch-clearlimits">解除所有限额</button>' +
      '</div>' +
      '<div class="orch-note">账本按月份写在 <b>data/usage/YYYY-MM.jsonl</b>，记录 skills 与 skillTokens，只记元数据、不记消息正文。' +
        '板块与预设存 data/boards.json、data/presets.json；内置技能在 skills/&lt;板块&gt;/*.md，可直接编辑。</div>';
    document.getElementById('orch-close').addEventListener('click', close);
    bind();
    renderSkillBox();
    renderEventLog();
  }

  function bind() {
    var real = document.getElementById('orch-real');
    if (DESKTOP && window.ingrid.getRunMode) {
      window.ingrid.getRunMode().then(function (on) { realMode = !!on; real.checked = realMode; });
    } else { real.disabled = true; real.title = '浏览器预览模式不能真实调用模型'; }
    real.addEventListener('change', function () {
      realMode = real.checked;
      if (DESKTOP && window.ingrid.setRunMode) window.ingrid.setRunMode(realMode);
      tip(realMode ? '已开启真实调用：会产生 API 费用' : '已切回演练模式：不花钱');
    });
    var taskEl = document.getElementById('orch-task');
    var recTimer = null;
    taskEl.addEventListener('input', function () {
      clearTimeout(recTimer);
      recTimer = setTimeout(renderRecommend, 280);
    });

    document.getElementById('orch-ra').addEventListener('click', autoRoute);

    document.getElementById('orch-run').addEventListener('click', run);
    document.getElementById('orch-refresh').addEventListener('click', render);
    document.getElementById('orch-savepreset').addEventListener('click', savePreset);
    document.getElementById('orch-applypreset').addEventListener('click', function () {
      var id = document.getElementById('orch-preset').value;
      var p = id ? presets.get(id) : null;
      if (p) { openWith(p); tip('已应用预设：' + p.name); }
      else tip('请先选择一个预设');
    });
    document.getElementById('orch-delpreset').addEventListener('click', function () {
      var id = document.getElementById('orch-preset').value;
      if (!id) { tip('请先选择一个预设'); return; }
      if (!confirm('删除这个预设？（只删快捷方式，不影响板块和技能）')) return;
      presets.remove(id); refreshHome(); render(); tip('预设已删除');
    });
    document.getElementById('orch-savebudget').addEventListener('click', function () {
      var v = Number(document.getElementById('orch-budget').value) || 0;
      ledger.setBudget(v); render(); tip('预算已保存：$' + v.toFixed(2) + (v ? '/月' : '（不限）'));
    });
    document.getElementById('orch-export').addEventListener('click', function () {
      var blob = new Blob(['\ufeff' + ledger.exportCsv()], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'ingrid-usage-' + ledger.currentMonth() + '.csv';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      tip('账本已导出 CSV（含 skills / skillTokens 两列）');
    });
    document.getElementById('orch-clear').addEventListener('click', function () {
      if (!confirm('确定清空本机用量账本？此操作不可撤销。')) return;
      ledger.clear(); render(); tip('账本已清空');
    });
    document.getElementById('orch-clearlimits').addEventListener('click', function () {
      router.clearLimit(); render(); tip('所有限额标记已解除');
    });
  }

  function savePreset() {
    var name = prompt('给这个组合起个名字（会变成首页的一个方块）', '写稿流程');
    if (!name || !name.trim()) return;
    var ids = Array.prototype.slice.call(document.querySelectorAll('.ot:checked')).map(function (x) { return x.value; });
    var p = presets.create({
      name: name.trim(), emoji: '⚡', boardId: currentBoardId,
      agentIds: ids, skillIds: selectedIds.slice(), commanderId: document.getElementById('orch-cmd').value,
      task: document.getElementById('orch-task').value.trim(), mode: document.getElementById('orch-mode').value,
      tag: (boards.get(currentBoardId) || {}).name || '',
    });
    refreshHome(); render();
    document.getElementById('orch-preset').value = p.id;
    tip('已存为预设：' + p.name + '（首页多了一个方块）');
  }

  /* ---------- ra 任务类型路由：自动判断派谁 + 挂哪些 skill ---------- */
  function autoRoute() {
    if (!window.__taskRouter) { tip('任务路由不可用'); return; }
    var task = document.getElementById('orch-task').value.trim();
    if (!task) { tip('⚠ 请先填写任务内容，ra 才能判断'); return; }
    tip('🧭 ra 正在判断派谁 + 挂哪些 skill…');
    window.__taskRouter.route(task, {
      agents: agents(), commanderId: commanderId(),
      skills: skills, boardId: currentBoardId,
      maxTargets: 3, maxSkills: 3,
    }).then(function (plan) {
      document.querySelectorAll('.ot').forEach(function (cb) { cb.checked = plan.targetIds.indexOf(cb.value) >= 0; });
      if (plan.boardId) currentBoardId = plan.boardId;
      selectedIds = (plan.skillIds || []).filter(function (id) { return skills.byId(id); });
      renderSkillBox();
      tip('🧭 ra 判断：' + plan.summary);
    }).catch(function (e) { tip('✕ ' + (e && e.message || e)); });
  }

  function tip(text) {
    var el = document.getElementById('orch-tip');
    if (el) el.textContent = text;
  }
  function renderEventLog() {
    var box = document.getElementById('orch-log');
    if (!box) return;
    if (!eventLog.length) { box.innerHTML = '<span style="color:var(--ink-faint)">事件日志：委派后这里会显示技能挂载、限额切换、审批、完成情况</span>'; return; }
    box.innerHTML = eventLog.slice(-20).reverse().map(function (e) {
      var t = new Date(e.at).toLocaleTimeString();
      var p = e.payload, cls = e.type === 'switched' ? 'lg-sw' : (e.type === 'failed' ? 'lg-er' : '');
      var text = e.type;
      if (e.type === 'delegated') text = '委派：' + p.commander + ' → ' + (p.targets || []).join('、') +
        ((p.skills || []).length ? ' · 挂载 ' + p.skills.length + ' 个技能 / ' + p.skillTokens + ' token' : '');
      else if (e.type === 'started') text = '启动：' + p.target + ' @ ' + p.engine;
      else if (e.type === 'switched') text = '限额切换：' + p.target + '  ' + p.from + ' → ' + p.to;
      else if (e.type === 'finished') text = '完成：' + p.agentName + '  花费 ' + usd(p.cost);
      else if (e.type === 'failed') text = '失败：' + (p.target || p.agentName) + '  ' + (p.reason || p.error || '');
      else if (e.type === 'approval') text = '等待批准：' + p.target;
      else if (e.type === 'completed') text = '本轮结束：成功 ' + p.succeeded + ' / 失败 ' + p.failed;
      return '<div class="' + cls + '">' + esc(t + '  ' + text) + '</div>';
    }).join('');
  }
  function renderResults(out) {
    var box = document.getElementById('orch-results');
    if (!box) return;
    box.innerHTML = out.results.map(function (r) {
      var cls = r.status === 'ok' ? 'ok' : (r.status === 'skipped' || r.status === 'blocked' ? 'skip' : 'err');
      var label = r.status === 'ok' ? '完成' : (r.status === 'skipped' ? '跳过' : (r.status === 'blocked' ? '阻塞' : '失败'));
      return '<div class="orch-res"><div class="rh">' +
        '<span class="rn">' + esc(r.agentName) + '</span>' +
        '<span class="rs ' + cls + '">' + label + '</span>' +
        '<span class="rm">' + esc(r.engine || '—') + ' · ' + usd(r.cost) +
          (r.dryRun ? ' · 演练' : '') + '</span>' +
        (r.skillTokens ? '<span class="rm">· 技能注入 ' + r.skillTokens + ' tok</span>' : '') +
        (r.switched ? '<span class="orch-switch">↳ 自动换引擎 ' + esc(r.switchedFrom) + ' → ' + esc(r.engine) + '</span>' : '') +
        '</div>' +
        (r.error ? '<div class="rt" style="color:var(--danger)">' + esc(r.error) + '</div>' : '') +
        (r.text ? '<div class="rt">' + esc(r.text) + '</div>' : '') + '</div>';
    }).join('') +
    '<div class="orch-res" style="background:#f6f9f8"><div class="rh"><span class="rn">本轮合计</span>' +
      '<span class="rm">成功 ' + out.succeeded + ' · 失败 ' + out.failed + ' · 切换 ' + out.switched +
      ' · 挂载 ' + out.skills.length + ' 技能 / ' + out.skillTokens + ' tok · 实际 ' + usd(out.spent) +
      ' · 演练估算 ' + usd(out.simulated) + '</span></div></div>';
  }

  function run() {
    var cid = document.getElementById('orch-cmd').value;
    var ids = Array.prototype.slice.call(document.querySelectorAll('.ot:checked')).map(function (x) { return x.value; });
    var task = document.getElementById('orch-task').value.trim();
    var mode = document.getElementById('orch-mode').value;
    var auto = document.getElementById('orch-auto').checked;
    var dryRun = !document.getElementById('orch-real').checked;
    var btn = document.getElementById('orch-run');
    if (!ids.length) { tip('⚠ 请至少勾选一个目标 Agent'); return; }
    if (!task) { tip('⚠ 请填写任务内容'); return; }

    // 监督者开着时：把核心需求 + 纠偏提醒自动挂在本次任务前（不断提醒、防止跑偏）
    var supRem = (typeof window.__supervisorReminder === 'function') ? window.__supervisorReminder() : '';
    var finalTask = task;
    if (supRem && task.indexOf('【监督者 · 核心需求】') < 0) {
      finalTask = supRem + '\n\n【任务】\n' + task;
    }

    btn.disabled = true; btn.textContent = '执行中…'; tip('正在读取技能正文…');
    readBodies(selectedIds.slice()).then(function (entries) {
      var built = skills.buildContext(entries);
      if (built.truncated) tip('注意：技能正文过长已截断，注入 ' + built.tokens + ' token');
      return orch.delegate({
        commanderId: cid, targetIds: ids, task: finalTask, mode: mode,
        autoApprove: auto, dryRun: dryRun, taskType: 'general',
        skillIds: built.ids, skillContext: built.text, skillTokens: built.tokens,
      });
    }).then(function (out) {
      renderResults(out);
      document.getElementById('orch-bar').innerHTML = budgetHtml();
      tip('完成：成功 ' + out.succeeded + ' / 失败 ' + out.failed +
        ' · 注入 ' + out.skillTokens + ' token' + (out.switched ? ' · ' + out.switched + ' 次限额切换' : ''));
      // 监督者：对每一轮产出做漂移检测（快路径），偏离则生成纠偏指令（慢路径）
      if (typeof window.__superviseResult === 'function') {
        out.results.forEach(function (r) { window.__superviseResult(r, task); });
      }
    }).catch(function (e) { tip('✕ ' + (e && e.message || e)); })
      .then(function () { btn.disabled = false; btn.textContent = '▶ 开始委派'; });
  }

  function open() { render(); mask.classList.add('open'); }
  function openWith(p) {
    currentBoardId = p.boardId || currentBoardId;
    selectedIds = (p.skillIds || []).filter(function (id) { return skills.byId(id); });
    render();
    document.getElementById('orch-task').value = p.task || '';
    document.getElementById('orch-mode').value = p.mode || 'parallel';
    if (p.commanderId) document.getElementById('orch-cmd').value = p.commanderId;
    (p.agentIds || []).forEach(function (id) {
      var cb = document.querySelector('.ot[value="' + id + '"]');
      if (cb) cb.checked = true;
    });
    renderSkillBox();
    mask.classList.add('open');
  }
  window.__openOrchestratorWith = openWith;
  // 秘书等外部调用：把一段任务 + ra 路由计划填进调度中枢
  window.__openOrchestratorTask = function (task, plan) {
    currentBoardId = (plan && plan.boardId) ? plan.boardId : currentBoardId;
    selectedIds = (plan && plan.skillIds) ? plan.skillIds.filter(function (id) { return skills.byId(id); }) : [];
    render();
    document.getElementById('orch-task').value = task || '';
    if (plan && plan.targetIds) {
      document.querySelectorAll('.ot').forEach(function (cb) { cb.checked = plan.targetIds.indexOf(cb.value) >= 0; });
    }
    renderSkillBox();
    mask.classList.add('open');
  };

  if (DESKTOP && window.ingrid.getRunMode) {
    window.ingrid.getRunMode().then(function (on) { realMode = !!on; });
  }
})();
