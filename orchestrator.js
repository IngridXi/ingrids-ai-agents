/**
 * ============================================================
 *  orchestrator.js — 调度中枢面板（渲染层，零依赖）
 *  ============================================================
 *  让一个 Agent（默认「智能路由 ra」）指挥其他 Agent 干活：
 *    · 委派 / 并行 / 串行 / 流水线
 *    · 审批卡片（approvalMode = ask 时逐个确认）
 *    · 限额自动切换（撞到额度自动换降级引擎）
 *    · 每次调用记账、月度预算、CSV 导出
 *    · 默认「演练模式」：流程全真跑，但不调模型、不花钱
 *
 *  依赖：index.html 暴露的 window.__workbench
 * ============================================================
 */
(function () {
  'use strict';
  var wb = window.__workbench;
  var C = window.AgentsCore;
  if (!wb || !C) return;

  var DESKTOP = wb.IS_DESKTOP;
  var registry = wb.registry;
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var usd = function (n) { return '$' + Number(n || 0).toFixed(4); };

  /* ---------- 账本存储：桌面走文件，浏览器走 localStorage ---------- */
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

  var ledger = new C.UsageLedger(ledgerStorage());
  var router = new C.ModelRouter();
  var eventLog = [];
  var realMode = false;

  function log(type, payload) {
    eventLog.push({ type: type, at: Date.now(), payload: payload || {} });
    if (eventLog.length > 60) eventLog.shift();
    renderEventLog();
  }

  /* ---------- 执行器：桌面走主进程（CLI / API），浏览器走演练 ---------- */
  var executor = DESKTOP
    ? function (agent, task, ctx) {
        return window.ingrid.runAgent({
          prompt: task, engine: ctx.engine, soul: agent.soul || '', dryRun: !!ctx.dryRun,
        });
      }
    : null;

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
      pendingApprovals.shift();
      approvalBusy = false;
      box.style.display = 'none';
      box.innerHTML = '';
      item.resolve(v);
      showNextApproval();
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
    '.orch-modal{width:min(860px,100%);}',
    '.orch-bar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px;}',
    '.orch-stat{flex:1;min-width:130px;background:#f6f9f8;border:1px solid var(--line);border-radius:12px;padding:11px 14px;}',
    '.orch-stat .k{font-size:11px;color:var(--ink-faint);font-weight:600;}',
    '.orch-stat .v{font-size:17px;font-weight:700;margin-top:3px;color:var(--ink);}',
    '.orch-stat.alert{background:#fdf3e5;border-color:#ecdfc0;} .orch-stat.alert .v{color:#8a7043;}',
    '.orch-cols{display:grid;grid-template-columns:1fr 1fr;gap:18px;}',
    '@media(max-width:720px){.orch-cols{grid-template-columns:1fr;}}',
    '.orch-field{margin-bottom:12px;}',
    '.orch-field label{display:block;font-size:12px;font-weight:700;color:var(--ink-faint);margin-bottom:6px;}',
    '.orch-field input[type=text],.orch-field textarea,.orch-field select{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:10px;font-size:13px;color:var(--ink);background:#fff;font-family:inherit;}',
    '.orch-field textarea{resize:vertical;min-height:74px;line-height:1.6;}',
    '.orch-targets{max-height:230px;overflow:auto;border:1px solid var(--line);border-radius:11px;background:#fff;}',
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
    '.orch-results{margin-top:6px;display:flex;flex-direction:column;gap:9px;max-height:250px;overflow:auto;}',
    '.orch-res{border:1px solid var(--line);border-radius:11px;padding:11px 13px;background:#fff;font-size:12.5px;}',
    '.orch-res .rh{display:flex;align-items:center;gap:9px;flex-wrap:wrap;}',
    '.orch-res .rn{font-weight:700;font-size:13.5px;}',
    '.orch-res .rs{font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:999px;}',
    '.orch-res .rs.ok{background:#e2f1ee;color:var(--accent);} .orch-res .rs.err{background:#fbe9e6;color:var(--danger);}',
    '.orch-res .rs.skip{background:#f1f3f2;color:var(--ink-faint);}',
    '.orch-res .rm{color:var(--ink-faint);font-size:11.5px;}',
    '.orch-res .rt{margin-top:7px;color:var(--ink-soft);line-height:1.6;white-space:pre-wrap;max-height:90px;overflow:auto;background:#f8faf9;border-radius:8px;padding:8px 10px;}',
    '.orch-switch{color:#8a7043;font-weight:650;}',
    '.orch-log{margin-top:10px;background:#f8faf9;border:1px solid var(--line);border-radius:11px;padding:10px 12px;max-height:120px;overflow:auto;font-size:11.5px;color:var(--ink-soft);line-height:1.75;}',
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
  ].join('\n');
  document.head.appendChild(style);

  /* ---------- DOM ---------- */
  var mask = document.createElement('div');
  mask.className = 'mask';
  mask.id = 'orchMask';
  var modal = document.createElement('div');
  modal.className = 'modal orch-modal';
  modal.id = 'orchModal';
  mask.appendChild(modal);
  document.body.appendChild(mask);

  var approval = document.createElement('div');
  approval.id = 'orch-approval';
  document.body.appendChild(approval);

  var entry = document.createElement('button');
  entry.className = 'chip chip-btn';
  entry.id = 'btnOrchestrator';
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

  /* ---------- 渲染 ---------- */
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

  function render() {
    var list = agents();
    var cid = commanderId();
    var cmdOpts = list.map(function (a) {
      return '<option value="' + esc(a.id) + '"' + (a.id === cid ? ' selected' : '') + '>' +
        esc(a.emoji + ' ' + a.name) + (a.role === 'orchestrator' ? '（调度者）' : '') + '</option>';
    }).join('');
    var targets = list.filter(function (a) { return a.id !== cid; }).map(function (a) {
      var pick = router.resolve(a);
      var limits = router.limits();
      var lim = limits[a.engine] ? ' · 主引擎限额中' : '';
      return '<label class="orch-target">' +
        '<input type="checkbox" class="ot" value="' + esc(a.id) + '">' +
        '<span class="tn">' + esc(a.emoji + ' ' + a.name) + '</span>' +
        '<span class="te">' + esc(pick.engine) + (pick.switched ? ' ↳降级' : '') + esc(lim) + '</span>' +
        '<span class="ta">' + esc(a.approvalMode === 'ask' ? '需批准' : '自动') + '</span></label>';
    }).join('');

    modal.innerHTML =
      '<header><div class="emoji">🎛️</div><div><h2>调度中枢</h2>' +
        '<div class="sub">让一个 Agent 指挥其他 Agent 干活 · 限额自动切换 · 每次调用记账</div></div>' +
        '<button class="close" id="orch-close">✕</button></header>' +
      '<div class="orch-bar" id="orch-bar">' + budgetHtml() + '</div>' +
      '<div class="orch-cols">' +
        '<div>' +
          '<div class="orch-field"><label>指挥官（有权限调度的 Agent）</label><select id="orch-cmd">' + cmdOpts + '</select></div>' +
          '<div class="orch-field"><label>任务内容</label><textarea id="orch-task" placeholder="例如：整理今天的会议要点，写成一份简报"></textarea></div>' +
          '<div class="orch-field"><label>执行方式</label><select id="orch-mode">' +
            '<option value="parallel">并行 · 同时派给所有人</option>' +
            '<option value="sequential">串行 · 一个接一个</option>' +
            '<option value="chain">流水线 · 上一位的结果传给下一位</option></select></div>' +
        '</div>' +
        '<div>' +
          '<div class="orch-field"><label>派给哪些 Agent</label><div class="orch-targets">' +
            (targets || '<div style="padding:14px;color:var(--ink-faint);font-size:12.5px">还没有可派的 Agent</div>') +
          '</div></div>' +
          '<label class="orch-check" style="margin-top:10px"><input type="checkbox" id="orch-auto"> 自动批准（跳过审批卡片）</label>' +
          '<label class="orch-check" style="margin-top:8px"><input type="checkbox" id="orch-real"> 真实调用模型（需先在引擎设置里开启并配置 CLI / API Key）</label>' +
          '<div class="orch-note">不勾选就是<b>演练模式</b>：委派、审批、限额切换、记账全流程照跑，但不调用真实模型、不产生费用。</div>' +
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
      '<div class="orch-note">账本按月份写在 <b>data/usage/YYYY-MM.jsonl</b>（桌面版），只记元数据、不记消息正文。' +
        '价格表在 agents-core.js 的 ENGINES.price，可自行调整；costSource 区分 metered / estimated / simulated。</div>';
    document.getElementById('orch-close').addEventListener('click', close);
    bind();
    renderEventLog();
  }

  function bind() {
    var real = document.getElementById('orch-real');
    if (DESKTOP && window.ingrid.getRunMode) {
      window.ingrid.getRunMode().then(function (on) { realMode = !!on; real.checked = realMode; });
    } else {
      real.disabled = true;
      real.title = '浏览器预览模式不能真实调用模型';
    }
    real.addEventListener('change', function () {
      realMode = real.checked;
      if (DESKTOP && window.ingrid.setRunMode) window.ingrid.setRunMode(realMode);
      tip(realMode ? '已开启真实调用：会产生 API 费用' : '已切回演练模式：不花钱');
    });

    document.getElementById('orch-run').addEventListener('click', run);
    document.getElementById('orch-refresh').addEventListener('click', render);
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
      tip('账本已导出 CSV');
    });
    document.getElementById('orch-clear').addEventListener('click', function () {
      if (!confirm('确定清空本机用量账本？此操作不可撤销。')) return;
      ledger.clear(); render(); tip('账本已清空');
    });
    document.getElementById('orch-clearlimits').addEventListener('click', function () {
      router.clearLimit(); render(); tip('所有限额标记已解除');
    });
  }

  function tip(text) {
    var el = document.getElementById('orch-tip');
    if (el) el.textContent = text;
  }

  function renderEventLog() {
    var box = document.getElementById('orch-log');
    if (!box) return;
    if (!eventLog.length) { box.innerHTML = '<span style="color:var(--ink-faint)">事件日志：委派后这里会显示限额切换、审批、完成情况</span>'; return; }
    box.innerHTML = eventLog.slice(-20).reverse().map(function (e) {
      var t = new Date(e.at).toLocaleTimeString();
      var p = e.payload, cls = e.type === 'switched' ? 'lg-sw' : (e.type === 'failed' ? 'lg-er' : '');
      var text = e.type;
      if (e.type === 'delegated') text = '委派：' + p.commander + ' → ' + (p.targets || []).join('、');
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
        (r.switched ? '<span class="orch-switch">↳ 自动换引擎 ' + esc(r.switchedFrom) + ' → ' + esc(r.engine) + '</span>' : '') +
        '</div>' +
        (r.error ? '<div class="rt" style="color:var(--danger)">' + esc(r.error) + '</div>' : '') +
        (r.text ? '<div class="rt">' + esc(r.text) + '</div>' : '') + '</div>';
    }).join('') +
    '<div class="orch-res" style="background:#f6f9f8"><div class="rh"><span class="rn">本轮合计</span>' +
      '<span class="rm">成功 ' + out.succeeded + ' · 失败 ' + out.failed + ' · 切换 ' + out.switched +
      ' · 实际 ' + usd(out.spent) + ' · 演练估算 ' + usd(out.simulated) + '</span></div></div>';
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

    btn.disabled = true; btn.textContent = '执行中…'; tip('正在委派…');
    orch.delegate({ commanderId: cid, targetIds: ids, task: task, mode: mode,
      autoApprove: auto, dryRun: dryRun, taskType: 'general' })
      .then(function (out) {
        renderResults(out);
        document.getElementById('orch-bar').innerHTML = budgetHtml();
        tip('完成：成功 ' + out.succeeded + ' / 失败 ' + out.failed +
          (out.switched ? ' · 发生 ' + out.switched + ' 次限额切换' : ''));
      })
      .catch(function (e) { tip('✕ ' + (e && e.message || e)); })
      .then(function () { btn.disabled = false; btn.textContent = '▶ 开始委派'; });
  }

  function open() { render(); mask.classList.add('open'); }

  // 启动后同步一次「真实执行」开关状态
  if (DESKTOP && window.ingrid.getRunMode) {
    window.ingrid.getRunMode().then(function (on) { realMode = !!on; });
  }
})();
