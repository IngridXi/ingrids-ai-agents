/**
 * ============================================================
 *  supervisor.js — 监事常驻面板（渲染层，零依赖）
 *  ============================================================
 *  · 常驻在主界面底部；随时增删「核心需求」；
 *  · 先「对话确认」把模糊需求讲清楚，确认后写入 GoalStore；
 *  · 监督开关打开后，每轮委派结果都做快路径漂移检测，
 *    偏离时慢路径生成纠偏指令，自动挂回下一次委派。
 *
 *  依赖：index.html 的 window.__workbench、supervisor-core.js。
 * ============================================================
 */
(function () {
  'use strict';
  var wb = window.__workbench;
  var C = window.AgentsCore;
  var SC = window.SupervisorCore;
  if (!wb || !C || !SC) return;
  var DESKTOP = wb.IS_DESKTOP;
  var registry = wb.registry;
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var realMode = false;

  /* ---------- 存储（桌面走文件，浏览器回退 localStorage） ---------- */
  function goalStorage() {
    if (!DESKTOP) return null;
    return {
      load: function () { return window.ingrid.loadSupervisorSync(); },
      save: function (state) { window.ingrid.saveSupervisor(state); },
    };
  }
  var goals = new SC.GoalStore(goalStorage());

  /* ---------- 慢路径纠偏用的执行器（复用主进程 agent:run） ---------- */
  var judgeExecutor = DESKTOP
    ? function (agent, task, ctx) {
        return window.ingrid.runAgent({
          prompt: task, engine: ctx.engine, soul: ctx.soul || agent.soul || '', dryRun: false,
        });
      }
    : null;

  var sup = new SC.Supervisor({
    goals: goals, executor: judgeExecutor, realMode: false,
    judgeAgent: {
      name: '监事', emoji: '👁️', engine: 'deepseek', fallbacks: ['gpt', 'qwen'],
      soul: '你是监事（Steering Agent）。职责：判断工作 Agent 的产出是否偏离用户的核心需求，若偏离则给一句可执行的纠偏指令；不代做工作本身，只把关方向。',
    },
    onLog: function () { renderLog(); },
  });

  /* ---------- 状态 ---------- */
  var supTarget = '__all__';   // '__all__' 所有 | '__orch__' 本轮委派 | 具体 agent id
  var minimized = false;

  /* ---------- 样式 ---------- */
  var style = document.createElement('style');
  style.textContent = [
    '.sup-panel{position:static;width:100%;background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden;font-size:12.5px;color:var(--ink);display:flex;flex-direction:column;}',
    '.sup-head{display:flex;align-items:center;gap:8px;padding:10px 13px;background:linear-gradient(135deg,var(--deep),var(--accent));color:#fff;user-select:none;flex:none;}',
    '.sup-title{font-weight:700;font-size:13.5px;display:flex;align-items:center;gap:6px;}',
    '.sup-status{font-size:10.5px;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.16);}',
    '.sup-status.on{background:rgba(255,255,255,.92);color:var(--accent);font-weight:700;}',
    '.sup-btns{margin-left:auto;display:flex;gap:6px;}',
    '.sup-btns button{width:22px;height:22px;border:none;border-radius:7px;background:rgba(255,255,255,.16);color:#fff;cursor:pointer;font-size:12px;line-height:1;}',
    '.sup-btns button:hover{background:rgba(255,255,255,.32);}',
    '.sup-body{padding:12px 13px;max-height:236px;overflow:auto;display:flex;flex-direction:column;gap:13px;}',
    '.sup-body.hide{display:none;}',
    '.sup-sec label{display:block;font-size:10.5px;font-weight:700;letter-spacing:.03em;color:var(--ink-faint);margin-bottom:6px;text-transform:uppercase;}',
    '.sup-sec select,.sup-sec input[type=text]{width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:9px;font-size:12px;color:var(--ink);background:#fff;font-family:inherit;}',
    '.sup-goal{display:flex;align-items:flex-start;gap:7px;padding:6px 8px;border:1px solid var(--line);border-radius:9px;margin-bottom:6px;background:var(--surface-2);}',
    '.sup-goal .gx{font-size:11px;line-height:1.45;flex:1;min-width:0;word-break:break-word;}',
    '.sup-goal.off .gx{text-decoration:line-through;color:var(--ink-faint);}',
    '.sup-goal .w{flex:none;font-size:9.5px;font-weight:700;color:var(--ink-soft);background:var(--accent-softer);padding:1px 5px;border-radius:6px;margin-top:1px;}',
    '.sup-goal .d{flex:none;font-size:13px;color:var(--ink-faint);cursor:pointer;padding:0 2px;}',
    '.sup-goal .d:hover{color:var(--danger);}',
    '.sup-add{display:flex;gap:6px;margin-bottom:8px;}',
    '.sup-add button{flex:none;padding:7px 11px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-weight:700;cursor:pointer;}',
    '.sup-btn{width:100%;padding:8px 12px;border:none;border-radius:10px;background:var(--accent);color:#fff;font-size:12.5px;font-weight:650;cursor:pointer;}',
    '.sup-btn:hover{background:var(--accent-2);}',
    '.sup-btn.ghost{background:#fff;color:var(--ink-soft);border:1px solid var(--line);}',
    '.sup-btn.ghost:hover{border-color:var(--accent);color:var(--accent);}',
    '.sup-switch-row{display:flex;gap:8px;align-items:center;}',
    '.sup-check{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:650;color:var(--ink-soft);cursor:pointer;white-space:nowrap;}',
    '.sup-check input{accent-color:var(--accent);width:15px;height:15px;}',
    '.sup-log{max-height:150px;overflow:auto;display:flex;flex-direction:column;gap:5px;background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:8px 9px;}',
    '.sup-log .le{font-size:11px;line-height:1.5;color:var(--ink-soft);}',
    '.sup-log .le.alert{color:var(--danger);font-weight:650;}',
    '.sup-log .le.warn{color:var(--warning);font-weight:650;}',
    '.sup-log .le.correct{color:var(--accent);font-weight:650;}',
    '.sup-log .le.ok{color:var(--accent);}',
    '.sup-log .le.info{color:var(--ink-faint);}',
    '.sup-corr{margin-top:5px;background:var(--warning-soft);border:1px solid var(--warning);border-left:3px solid var(--warning);border-radius:8px;padding:8px 9px;font-size:11.5px;color:var(--ink-soft);line-height:1.55;white-space:pre-wrap;}',
    '.sup-empty{color:var(--ink-faint);font-size:11px;padding:4px 0;}',
    '#supClarifyMask{display:none;position:fixed;inset:0;background:rgba(23,59,73,.45);z-index:90;align-items:center;justify-content:center;padding:24px;}',
    '#supClarifyMask[style*="flex"]{display:flex;}',
    '.sup-clarify{width:min(560px,100%);background:#fff;border-radius:18px;box-shadow:var(--shadow-lg);padding:24px;max-height:88vh;overflow:auto;}',
    '.sup-clarify h3{font-size:16px;font-weight:700;margin-bottom:4px;}',
    '.sup-clarify .sub{font-size:12px;color:var(--ink-faint);margin-bottom:14px;line-height:1.6;}',
    '.sup-clarify textarea{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font-size:13px;color:var(--ink);background:#fff;font-family:inherit;line-height:1.6;resize:vertical;}',
    '.sup-clarify .qa{margin-bottom:12px;}',
    '.sup-clarify .qa .q{font-size:12.5px;font-weight:650;color:var(--ink-soft);margin-bottom:5px;}',
    '.sup-clarify .foot{display:flex;gap:9px;justify-content:flex-end;margin-top:16px;}',
    '.sup-clarify .foot button{padding:9px 16px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--ink-soft);font-size:13px;font-weight:650;cursor:pointer;}',
    '.sup-clarify .foot .primary{background:var(--accent);border-color:var(--accent);color:#fff;}',
    '.sup-clarify .summary{background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:12px 13px;font-size:12.5px;line-height:1.7;white-space:pre-wrap;color:var(--ink-soft);}',
  ].join('\n');
  document.head.appendChild(style);

  /* ---------- DOM ---------- */
  var panel = document.createElement('div');
  panel.id = 'supPanel'; panel.className = 'sup-panel';
  panel.innerHTML =
    '<div class="sup-head" id="supHead">' +
      '<span class="sup-title">' + iconSvg('eye') + ' 监事</span>' +
      '<span class="sup-status" id="supStatus">已暂停</span>' +
      '<span class="sup-btns">' +
        '<button id="supMin" title="收起/展开">—</button>' +
      '</span>' +
    '</div>' +
    '<div class="sup-body" id="supBody">' +
      '<div class="sup-sec"><label>监督的工作</label><select id="supTarget"></select></div>' +
      '<div class="sup-sec"><label>核心需求 · 可随时增删</label><div id="supGoals"></div>' +
        '<div class="sup-add"><input type="text" id="supGoalInput" placeholder="新增一条核心需求…"><button id="supGoalAdd">＋</button></div>' +
        '<button class="sup-btn ghost" id="supClarify">' + iconSvg('message') + ' 对话确认需求（先讲清楚再做）</button></div>' +
      '<div class="sup-switch-row"><label class="sup-check"><input type="checkbox" id="supActive"> 开始监督</label>' +
        '<button class="sup-btn ghost" id="supInject" style="flex:1">' + iconSvg('megaphone') + ' 提醒当前工作</button></div>' +
      '<div class="sup-sec" id="supCorrWrap" style="display:none"><label>当前纠偏指令</label><div class="sup-corr" id="supCorr"></div></div>' +
      '<div class="sup-sec"><label>监督日志</label><div class="sup-log" id="supLog"></div></div>' +
    '</div>';
  var dock = document.getElementById('residentDock');
  (dock || document.body).appendChild(panel);

  /* 澄清对话弹窗 */
  var clarifyMask = document.createElement('div');
  clarifyMask.id = 'supClarifyMask';
  document.body.appendChild(clarifyMask);

  /* 左侧导航入口：滚动定位到常驻面板 + 高亮 */
  var nav = document.getElementById('navSupervisor');
  if (nav) {
    nav.addEventListener('click', function () {
      if (typeof window.__setActiveNav === 'function') window.__setActiveNav('navSupervisor');
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      panel.classList.add('flash');
      setTimeout(function () { panel.classList.remove('flash'); }, 1000);
    });
  }

  /* ---------- 渲染 ---------- */
  function targetOptions() {
    var agents = registry.list();
    var opts = '<option value="__all__"' + (supTarget === '__all__' ? ' selected' : '') + '>' + iconSvg('globe') + ' 所有正在进行的委派</option>';
    agents.forEach(function (a) {
      if (a.role === 'orchestrator') return;
      opts += '<option value="' + esc(a.id) + '"' + (supTarget === a.id ? ' selected' : '') + '>' +
        iconFor(a.emoji) + ' ' + esc(a.name) + '</option>';
    });
    return opts;
  }
  function renderGoals() {
    var box = document.getElementById('supGoals');
    var list = goals.list();
    if (!list.length) {
      box.innerHTML = '<div class="sup-empty">还没有核心需求。点下方「对话确认需求」，或直接新增一条。</div>';
    } else {
      box.innerHTML = list.map(function (g) {
        return '<div class="sup-goal' + (g.active ? '' : ' off') + '" data-id="' + esc(g.id) + '">' +
          '<span class="w">' + g.weight + '</span>' +
          '<span class="gx">' + esc(g.text) + '</span>' +
          '<span class="d" title="停用/启用" data-act="toggle">' + (g.active ? '◉' : '○') + '</span>' +
          '<span class="d" title="删除" data-act="del">✕</span></div>';
      }).join('');
    }
    box.querySelectorAll('.sup-goal').forEach(function (row) {
      var id = row.getAttribute('data-id');
      row.querySelector('[data-act=toggle]').addEventListener('click', function () { goals.toggle(id); renderGoals(); });
      row.querySelector('[data-act=del]').addEventListener('click', function () { goals.remove(id); renderGoals(); });
    });
  }
  function renderStatus() {
    var el = document.getElementById('supStatus');
    var active = goals.active;
    el.textContent = active ? '监督中' : '已暂停';
    el.className = 'sup-status' + (active ? ' on' : '');
    var cb = document.getElementById('supActive');
    if (cb) cb.checked = active;
  }
  function renderCorrection() {
    var wrap = document.getElementById('supCorrWrap');
    var box = document.getElementById('supCorr');
    if (!wrap || !box) return;
    if (goals.lastCorrection) { wrap.style.display = 'block'; box.textContent = goals.lastCorrection; }
    else wrap.style.display = 'none';
  }
  function renderLog() {
    var box = document.getElementById('supLog');
    if (!box) return;
    if (!sup.log.length) {
      box.innerHTML = '<div class="le info">开一轮委派后，这里会显示每个 Agent 是否贴合核心需求。</div>';
      return;
    }
    box.innerHTML = sup.log.slice(0, 20).map(function (e) {
      var t = new Date(e.at).toLocaleTimeString();
      return '<div class="le ' + e.level + '">' + esc(t + ' · ' + e.text) + '</div>';
    }).join('');
  }
  function renderAll() {
    var tgt = document.getElementById('supTarget');
    if (tgt) tgt.innerHTML = targetOptions();
    renderGoals(); renderStatus(); renderCorrection(); renderLog();
  }

  /* ---------- 事件 ---------- */
  document.getElementById('supMin').addEventListener('click', function () {
    minimized = !minimized;
    document.getElementById('supBody').classList.toggle('hide', minimized);
    this.textContent = minimized ? '＋' : '—';
  });

  document.getElementById('supTarget').addEventListener('change', function (e) { supTarget = e.target.value; });

  function addGoal(text) {
    text = String(text || '').trim();
    if (!text) return;
    goals.add(text, 1);
    renderGoals(); renderCorrection();
  }
  document.getElementById('supGoalAdd').addEventListener('click', function () {
    var inp = document.getElementById('supGoalInput');
    addGoal(inp.value); inp.value = '';
  });
  document.getElementById('supGoalInput').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { addGoal(this.value); this.value = ''; }
  });

  document.getElementById('supActive').addEventListener('change', function (e) {
    goals.setActive(e.target.checked);
    renderStatus();
    sup.addLog('info', e.target.checked ? '开始监督：后续每轮委派都会对照核心需求把关' : '监督已暂停');
  });

  document.getElementById('supInject').addEventListener('click', function () {
    var rem = sup.reminder();
    if (!rem) { sup.addLog('info', '没有核心需求可提醒，请先设定'); renderLog(); return; }
    var taskEl = document.getElementById('orch-task');
    if (taskEl && document.getElementById('orchModal') && document.getElementById('orchModal').closest('.mask.open')) {
      taskEl.value = rem + '\n\n【任务】\n' + taskEl.value;
      taskEl.focus();
    } else {
      window.__openOrchestrator && window.__openOrchestrator();
      setTimeout(function () {
        var t = document.getElementById('orch-task');
        if (t) { t.value = rem + '\n\n【任务】\n' + t.value; }
      }, 50);
    }
    sup.addLog('ok', '已把核心需求 + 纠偏提醒注入到本次任务');
  });

  document.getElementById('supClarify').addEventListener('click', openClarify);

  /* ---------- 澄清对话流程 ---------- */
  var clarifyStep = 0, clarifyInstruction = '', clarifyAnswers = [];
  function openClarify() {
    clarifyStep = 0; clarifyInstruction = ''; clarifyAnswers = ['', '', ''];
    renderClarify();
    clarifyMask.style.display = 'flex';
  }
  function renderClarify() {
    var qs = SC.CLARIFY_QUESTIONS;
    if (clarifyStep === 0) {
      clarifyMask.innerHTML =
        '<div class="sup-clarify"><h3>' + iconSvg('message') + ' 对话确认需求</h3>' +
        '<div class="sub">先别急着开工。用一句话告诉我你这次想做什么，我会先问你几个问题、把「你真正想达成的」讲清楚，确认后再开始监督。</div>' +
        '<textarea id="ccInstr" rows="3" placeholder="例如：帮我把这篇论文改得更有学术味、更严谨">' + esc(clarifyInstruction) + '</textarea>' +
        '<div class="foot"><button id="ccCancel">取消</button><button class="primary" id="ccNext">下一步</button></div></div>';
      document.getElementById('ccCancel').addEventListener('click', closeClarify);
      document.getElementById('ccNext').addEventListener('click', function () {
        clarifyInstruction = document.getElementById('ccInstr').value.trim();
        if (!clarifyInstruction) { alert('请先写一句你想做的事'); return; }
        clarifyStep = 1; renderClarify();
      });
    } else if (clarifyStep === 1) {
      var body = qs.map(function (c, i) {
        return '<div class="qa"><div class="q">' + (i + 1) + '. ' + esc(c.q) + '</div>' +
          '<textarea rows="2" data-a="' + i + '">' + esc(clarifyAnswers[i]) + '</textarea></div>';
      }).join('');
      clarifyMask.innerHTML =
        '<div class="sup-clarify"><h3>' + iconSvg('message') + ' 澄清你的意思</h3>' +
        '<div class="sub">你的原始需求：<b>' + esc(clarifyInstruction) + '</b>。请回答下面几个问题，帮助我把「你到底想做什么」讲清楚。</div>' +
        body +
        '<div class="foot"><button id="ccBack">上一步</button><button class="primary" id="ccGen">生成确认稿</button></div></div>';
      document.getElementById('ccBack').addEventListener('click', function () { clarifyStep = 0; renderClarify(); });
      document.getElementById('ccGen').addEventListener('click', function () {
        clarifyMask.querySelectorAll('[data-a]').forEach(function (ta) { clarifyAnswers[Number(ta.getAttribute('data-a'))] = ta.value; });
        clarifyStep = 2; renderClarify();
      });
    } else {
      var comp = SC.composeGoalSummary(clarifyInstruction, clarifyAnswers);
      clarifyMask.innerHTML =
        '<div class="sup-clarify"><h3>' + iconSvg('message') + ' 确认：你真正想做的事</h3>' +
        '<div class="sub">下面是我理解的你的核心需求。请确认无误后写入监督清单（写进去后还可随时增删改）。</div>' +
        '<div class="summary">' + esc(comp.summary) + '</div>' +
        '<div class="foot"><button id="ccBack2">再改改</button><button class="primary" id="ccCommit">✓ 确认并写入核心需求</button></div></div>';
      document.getElementById('ccBack2').addEventListener('click', function () { clarifyStep = 1; renderClarify(); });
      document.getElementById('ccCommit').addEventListener('click', function () {
        comp.goals.forEach(function (g) { goals.add(g.text, g.weight); });
        closeClarify(); renderAll();
        sup.addLog('ok', '已写入 ' + comp.goals.length + ' 条核心需求');
      });
    }
  }
  function closeClarify() { clarifyMask.style.display = 'none'; clarifyMask.innerHTML = ''; }
  clarifyMask.addEventListener('click', function (e) { if (e.target === clarifyMask) closeClarify(); });

  /* ---------- 供调度中枢调用的接口 ---------- */
  window.__supervisor = sup;
  window.__supGoals = goals;
  window.__supervisorReminder = function () { return sup.reminder(); };
  window.__superviseResult = function (r, task) {
    sup.realMode = realMode;
    if (supTarget !== '__all__' && supTarget !== '__orch__' && supTarget !== r.agentId) return;
    sup.supervise(r, task);
    renderCorrection(); renderLog(); renderStatus();
  };

  /* ---------- 初始化 ---------- */
  renderAll();
  if (DESKTOP && window.ingrid.getRunMode) {
    window.ingrid.getRunMode().then(function (on) { realMode = !!on; });
  }
  // 与调度中枢的「真实调用」开关保持同步
  document.addEventListener('change', function (e) {
    if (e.target && e.target.id === 'orch-real') realMode = e.target.checked;
  });
})();
