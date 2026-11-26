/**
 * ops-governor.js — 运营治理面板（CFO 成本 / 模型调控 / Agent 总管 三 tab）
 *
 * 三个治理 agent 共用一个面板，数据来自主进程的运营治理引擎（agent-ops-governor.js）：
 *   1) CFO 成本官   —— 实时用量/费用（按 agent、引擎）、预算进度、成本提示；
 *   2) 模型调控官  —— 本地模型状态 + 每个 agent 的「当前 → 推荐 → 实际分配」，锁定/解锁；
 *   3) Agent 总管   —— 工作量 + 职责重叠 + 增/分割/合并建议 + 团队健康度。
 *
 * 借鉴开源范式：RouteLLM/Route42 的本地优先降级链、Louter 的内容分类路由、
 * LiteLLM 的成本账单、以及「手动指定模型绕过自动判断」= 本面板的「锁定」。
 */
(function () {
  'use strict';
  var IS_DESKTOP = !!(window.ingrid && window.ingrid.isDesktop);

  var STYLE = [
    '.og-mask{position:fixed;inset:0;background:rgba(20,18,35,.45);display:none;align-items:center;justify-content:center;z-index:310;}',
    '.og-mask.open{display:flex;}',
    '.og-panel{width:min(980px,96vw);max-height:92vh;display:flex;flex-direction:column;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.25);}',
    '.og-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #eee;flex:none;}',
    '.og-head h2{margin:0;font-size:17px;font-weight:650;color:#2c2c2a;}',
    '.og-head .og-sub{font-size:12px;color:#888780;font-weight:400;margin-top:2px;}',
    '.og-head .og-actions{display:flex;align-items:center;gap:8px;}',
    '.og-refresh{border:1px solid #ddd;background:#fff;color:#5F5E5A;border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:inherit;}',
    '.og-refresh:hover{border-color:#7F77DD;color:#534AB7;}',
    '.og-close{border:none;background:transparent;font-size:24px;line-height:1;cursor:pointer;color:#888780;padding:4px 8px;}',
    '.og-close:hover{color:#2c2c2a;}',
    '.og-tabs{display:flex;gap:2px;padding:0 20px;border-bottom:1px solid #eee;flex:none;background:#faf9f7;}',
    '.og-tab{padding:11px 16px;font-size:13px;font-weight:600;color:#888780;cursor:pointer;border:none;background:transparent;border-bottom:2px solid transparent;font-family:inherit;}',
    '.og-tab:hover{color:#5F5E5A;}',
    '.og-tab.active{color:#534AB7;border-bottom-color:#7F77DD;}',
    '.og-body{flex:1;overflow-y:auto;padding:18px 20px;display:flex;flex-direction:column;gap:14px;}',
    '.og-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;}',
    '.og-grid.g3{grid-template-columns:repeat(3,1fr);}',
    '.og-card{border:1px solid #eee;border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:4px;background:#fff;}',
    '.og-card .n{font-size:22px;font-weight:650;color:#2c2c2a;line-height:1.1;}',
    '.og-card .l{font-size:12px;color:#5F5E5A;}',
    '.og-card .s{font-size:11px;color:#b4b2a9;}',
    '.og-card.warn{border-color:#f0c36d;background:#fffbf2;}',
    '.og-card.danger{border-color:#e5484d;background:#fff8f8;}',
    '.og-sec{border:1px solid #eee;border-radius:12px;padding:14px 16px;background:#fff;}',
    '.og-sec h3{margin:0 0 12px;font-size:13px;font-weight:600;color:#2c2c2a;}',
    '.og-bar{height:8px;border-radius:999px;background:#eee;overflow:hidden;margin-top:6px;}',
    '.og-bar .fill{height:100%;background:#7F77DD;border-radius:999px;transition:width .3s;}',
    '.og-bar .fill.warn{background:#f0c36d;}',
    '.og-bar .fill.danger{background:#e5484d;}',
    'table.og-tbl{width:100%;border-collapse:collapse;font-size:12px;}',
    'table.og-tbl th,table.og-tbl td{text-align:left;padding:8px 10px;border-bottom:1px solid #f2f1ee;}',
    'table.og-tbl th{color:#a09b8c;font-weight:600;font-size:11px;white-space:nowrap;}',
    'table.og-tbl td{color:#2c2c2a;}',
    'table.og-tbl tr:last-child td{border-bottom:none;}',
    'table.og-tbl .num{text-align:right;font-variant-numeric:tabular-nums;}',
    '.og-badge{font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap;}',
    '.og-badge.local{background:#ecf8ef;color:#2f9e5f;}',
    '.og-badge.api{background:#eef3fb;color:#2f6fed;}',
    '.og-badge.cli{background:#f6f1e7;color:#b08938;}',
    '.og-badge.locked{background:#f3e8ff;color:#7c4dcc;}',
    '.og-badge.switch{background:#fdeaea;color:#e5484d;}',
    '.og-badge.ok{background:#ecf8ef;color:#2f9e5f;}',
    '.og-hint{display:flex;gap:8px;align-items:flex-start;padding:9px 12px;border-radius:9px;font-size:12px;margin-bottom:8px;}',
    '.og-hint.info{background:#f2f5fb;color:#3a5f9e;}',
    '.og-hint.warn{background:#fff7e6;color:#a06a12;}',
    '.og-hint.danger{background:#fdeaea;color:#c23a3f;}',
    '.og-lockbtn{border:1px solid #ddd;background:#fff;color:#5F5E5A;border-radius:7px;padding:4px 10px;font-size:11px;cursor:pointer;font-family:inherit;white-space:nowrap;}',
    '.og-lockbtn:hover{border-color:#7F77DD;color:#534AB7;}',
    '.og-lockbtn.on{border-color:#7c4dcc;background:#f3e8ff;color:#7c4dcc;}',
    '.og-sug{border:1px solid #eee;border-radius:10px;padding:10px 12px;margin-bottom:8px;}',
    '.og-sug .t{font-size:13px;font-weight:600;color:#2c2c2a;}',
    '.og-sug .d{font-size:12px;color:#5F5E5A;margin-top:3px;}',
    '.og-sug.warn{border-color:#f0c36d;background:#fffbf2;}',
    '.og-sug.danger{border-color:#e5484d;background:#fff8f8;}',
    '.og-empty{text-align:center;color:#888780;font-size:13px;padding:40px 0;}',
    '.og-err{font-size:13px;color:#A32D2D;background:#FCEBEB;border-radius:8px;padding:12px;}',
    '.og-updated{font-size:11px;color:#b4b2a9;margin-top:4px;}',
    '.og-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#ccc;margin-right:5px;}',
    '.og-dot.on{background:#2f9e5f;}',
    '.og-dot.busy{background:#e5484d;}',
  ].join('');

  var mask, bodyEl, headEl, tabsEl;
  var activeTab = 'cfo';
  var lastReport = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(usd) { return '¥' + (Number(usd) || 0).toFixed(2); }
  function usd(usd) { return '$' + (Number(usd) || 0).toFixed(3); }
  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return String(Math.round(n));
  }
  function fmtNum(n) {
    n = Number(n) || 0;
    return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n);
  }
  function clsOf(e) { return { local: '本地', api: 'API', cli: '会员' }[e] || 'API'; }
  function clsBadge(e) { return '<span class="og-badge ' + (e || 'api') + '">' + clsOf(e) + '</span>'; }

  function ensurePanel() {
    if (mask) return;
    var st = document.createElement('style');
    st.textContent = STYLE;
    document.head.appendChild(st);

    mask = document.createElement('div');
    mask.className = 'og-mask';
    mask.innerHTML =
      '<div class="og-panel">' +
      '  <div class="og-head">' +
      '    <div><h2>运营治理</h2><div class="og-sub">CFO 成本 · 模型调控 · Agent 总管 —— 本地优先，占满自动切 API，手动锁定才固定</div></div>' +
      '    <div class="og-actions"><button class="og-refresh" type="button">刷新</button><button class="og-close" type="button">&times;</button></div>' +
      '  </div>' +
      '  <div class="og-tabs">' +
      '    <button class="og-tab active" data-tab="cfo" type="button">CFO 成本</button>' +
      '    <button class="og-tab" data-tab="model" type="button">模型调控</button>' +
      '    <button class="og-tab" data-tab="workforce" type="button">Agent 总管</button>' +
      '  </div>' +
      '  <div class="og-body"></div>' +
      '</div>';
    document.body.appendChild(mask);

    bodyEl = mask.querySelector('.og-body');
    headEl = mask.querySelector('.og-head');
    tabsEl = mask.querySelector('.og-tabs');
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    mask.querySelector('.og-close').addEventListener('click', close);
    mask.querySelector('.og-refresh').addEventListener('click', refresh);
    tabsEl.addEventListener('click', function (e) {
      var btn = e.target.closest('.og-tab');
      if (!btn) return;
      activeTab = btn.getAttribute('data-tab');
      tabsEl.querySelectorAll('.og-tab').forEach(function (t) { t.classList.toggle('active', t === btn); });
      if (lastReport) render(lastReport);
    });
  }

  function open() {
    ensurePanel();
    mask.classList.add('open');
    refresh();
  }
  function close() { if (mask) mask.classList.remove('open'); }
  window.__openOpsGovernor = open;

  function refresh() {
    if (!IS_DESKTOP) {
      bodyEl.innerHTML = '<div class="og-empty">运营治理面板需在桌面应用中使用</div>';
      return;
    }
    bodyEl.innerHTML = '<div class="og-empty">正在巡检用量 / 模型 / 团队…</div>';
    var btn = headEl.querySelector('.og-refresh');
    if (btn) { btn.disabled = true; btn.textContent = '巡检中…'; }
    window.ingrid.opsRun().then(function (r) {
      if (btn) { btn.disabled = false; btn.textContent = '刷新'; }
      render(r);
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = '刷新'; }
      bodyEl.innerHTML = '<div class="og-err">巡检失败：' + esc((e && e.message) || e) + '</div>';
    });
  }

  function render(r) {
    if (!r || r.error) {
      bodyEl.innerHTML = '<div class="og-err">' + esc((r && r.error) || '数据异常') + '</div>';
      return;
    }
    lastReport = r;
    if (activeTab === 'model') bodyEl.innerHTML = renderModel(r);
    else if (activeTab === 'workforce') bodyEl.innerHTML = renderWorkforce(r);
    else bodyEl.innerHTML = renderCfo(r);
    bindRowActions();
  }

  /* ============ Tab 1：CFO 成本 ============ */
  function renderCfo(r) {
    var c = r.cfo || {};
    var t = c.totals || {};
    var b = c.budget || {};
    var html = '';
    var budgetPct = b.budget > 0 ? Math.min(100, Math.round(b.ratio * 100)) : 0;
    var budgetCls = b.exceeded ? 'danger' : (budgetPct >= 80 ? 'warn' : '');

    html += '<div class="og-grid">';
    html += ocard(money(t.monthCost), '本月成本', t.thisMonth ? '记账月 ' + t.thisMonth : '');
    html += ocard(money(t.totalCost), '累计成本', '全部引擎');
    html += ocard(fmtTokens(t.tokensIn + t.tokensOut), '累计 Token', '入 ' + fmtTokens(t.tokensIn) + ' · 出 ' + fmtTokens(t.tokensOut));
    html += ocard(fmtNum(t.calls), '调用次数', 'API ' + fmtNum(t.apiCalls) + ' · 本地 ' + fmtNum(t.localCalls) + ' · 会员 ' + fmtNum(t.cliCalls));
    html += '</div>';

    // 预算
    html += '<div class="og-sec"><h3>月度预算</h3>';
    if (b.budget > 0) {
      html += '<div style="font-size:13px;color:#2c2c2a;">已用 ' + usd(b.monthCost) + ' / ' + usd(b.budget) +
        ' · 剩余 ' + (isFinite(b.remaining) ? usd(b.remaining) : '—') + ' · ' + budgetPct + '%</div>';
      html += '<div class="og-bar"><div class="fill ' + budgetCls + '" style="width:' + budgetPct + '%"></div></div>';
    } else {
      html += '<div style="font-size:13px;color:#888780;">未设置预算上限（在「API 用量」面板可设置）</div>';
    }
    html += '</div>';

    // 成本提示
    var hints = c.hints || [];
    if (hints.length) {
      html += '<div class="og-sec"><h3>成本提示</h3>';
      hints.forEach(function (h) {
        html += '<div class="og-hint ' + (h.level || 'info') + '">' + (h.level === 'danger' ? '⚠️ ' : (h.level === 'warn' ? '🔶 ' : 'ℹ️ ')) + esc(h.text) + '</div>';
      });
      html += '</div>';
    }

    // 按引擎
    var byEngine = c.byEngine || [];
    html += '<div class="og-sec"><h3>按引擎</h3>' + table(
      ['引擎', '类别', '调用', '本月成本', '累计成本', 'Token'],
      byEngine.map(function (e) {
        return '<td>' + esc(e.label || e.engine) + '</td><td>' + clsBadge(e.cls) + '</td>' +
          '<td class="num">' + fmtNum(e.calls) + '</td><td class="num">' + money(e.monthCost) + '</td>' +
          '<td class="num">' + money(e.cost) + '</td><td class="num">' + fmtTokens(e.tokensIn + e.tokensOut) + '</td>';
      })
    ) + '</div>';

    // 按 agent
    var byAgent = c.byAgent || [];
    html += '<div class="og-sec"><h3>按 Agent</h3>' + table(
      ['Agent', '调用', 'Token', '本月成本', '累计成本'],
      byAgent.map(function (a) {
        return '<td>' + esc(a.agent) + '</td><td class="num">' + fmtNum(a.calls) + '</td>' +
          '<td class="num">' + fmtTokens(a.tokensIn + a.tokensOut) + '</td>' +
          '<td class="num">' + money(a.monthCost) + '</td><td class="num">' + money(a.cost) + '</td>';
      })
    ) + '</div>';

    html += '<div class="og-updated">CFO 成本官 · 更新于 ' + new Date(c.generated_at || Date.now()).toLocaleString('zh-CN') + ' · 本地零成本调用不计费</div>';
    return html;
  }

  /* ============ Tab 2：模型调控 ============ */
  function renderModel(r) {
    var ls = r.localStatus || {};
    var plan = r.modelPlan || [];
    var html = '';

    // 本地状态卡
    var dot = ls.online ? (ls.busy ? 'busy' : 'on') : '';
    var statusTxt = ls.online ? (ls.busy ? '本地已占满' : '本地可用') : '本地离线';
    html += '<div class="og-sec"><h3>本地模型（Ollama）状态</h3>' +
      '<div style="font-size:14px;color:#2c2c2a;font-weight:600;"><span class="og-dot ' + dot + '"></span>' + esc(statusTxt) + '</div>' +
      '<div style="font-size:12px;color:#5F5E5A;margin-top:6px;">' +
      '在线：' + (ls.online ? '是' : '否') + ' · 显存中活跃模型：' + (ls.activeCount || 0) + ' 个' +
      (ls.vramBytes ? ' · 显存占用 ' + (ls.vramBytes / 1024 / 1024 / 1024).toFixed(1) + ' GB' : '') +
      ' · 占满判定：' + (ls.busy ? '是（自动切 API）' : '否（本地优先）') +
      '</div>';
    if (ls.activeModels && ls.activeModels.length) {
      html += '<div style="font-size:11px;color:#888780;margin-top:6px;">' +
        ls.activeModels.map(function (m) { return esc(m.name); }).join('、') + '</div>';
    }
    html += '</div>';

    // 模型分配表
    html += '<div class="og-sec"><h3>每个 Agent 的模型分配</h3>';
    html += '<div style="font-size:11px;color:#a09b8c;margin-bottom:8px;">「实际分配」= 调控官决策（本地优先 · 占满切 API · 锁定豁免）；点「锁定」固定为推荐模型，之后不再自动改。</div>';
    html += table(
      ['Agent', '任务类型', '当前', '推荐', '实际分配', '状态', ''],
      plan.map(function (m) {
        var status = m.locked
          ? '<span class="og-badge locked">已锁定</span>'
          : (m.switched ? '<span class="og-badge switch">自动切换</span>' : '<span class="og-badge ok">自动</span>');
        var lockBtn = m.locked
          ? '<button class="og-lockbtn on" data-unlock="' + esc(m.agent) + '" type="button">解锁</button>'
          : '<button class="og-lockbtn" data-lock="' + esc(m.agent) + '" data-engine="' + esc(m.recommended) + '" type="button">锁定</button>';
        return '<td>' + esc(m.agent) + '</td><td>' + esc(m.taskLabel) + '</td>' +
          '<td>' + esc(m.currentEngine) + '</td><td>' + esc(m.recommendedLabel) + '</td>' +
          '<td>' + esc(m.resolvedLabel) + '</td><td>' + status + '</td><td>' + lockBtn + '</td>';
      })
    );
    html += '</div>';

    html += '<div class="og-updated">模型调控官 · 更新于 ' + new Date(r.generated_at || Date.now()).toLocaleString('zh-CN') + ' · 本地占满/离线时自动切 DeepSeek 兜底</div>';
    return html;
  }

  /* ============ Tab 3：Agent 总管 ============ */
  function renderWorkforce(r) {
    var w = r.workforce || {};
    var s = w.summary || {};
    var html = '';
    var health = s.health || 0;
    var healthCls = health >= 70 ? '' : (health >= 40 ? 'warn' : 'danger');

    html += '<div class="og-grid">';
    html += ocard(fmtNum(s.agents), 'Agent 总数', 'workers ' + fmtNum(s.workers) + ' · 控制面 ' + fmtNum(s.controlPlane));
    html += ocard(Math.round((s.utilization || 0) * 100) + '%', '利用率', '有实际调用的 agent 占比');
    html += ocard(fmtNum(s.overlapCount), '职责重叠', '需人工明确边界');
    html += ocard(fmtNum(s.suggestionCount), '建议数', '增 / 分割 / 合并');
    html += '</div>';

    // 健康度
    html += '<div class="og-sec"><h3>团队健康度</h3>' +
      '<div style="font-size:14px;color:#2c2c2a;font-weight:600;">' + health + ' / 100</div>' +
      '<div class="og-bar"><div class="fill ' + healthCls + '" style="width:' + health + '%"></div></div>' +
      '<div style="font-size:11px;color:#a09b8c;margin-top:6px;">利用率越高、职责重叠越少，健康度越高。</div></div>';

    // 建议
    var sugs = w.suggestions || [];
    html += '<div class="og-sec"><h3>增 / 分割 / 合并建议</h3>';
    if (!sugs.length) html += '<div class="og-empty">暂无建议，团队结构健康。</div>';
    sugs.forEach(function (sg) {
      var kindLabel = { merge: '合并', split: '分割', add: '新增' }[sg.kind] || sg.kind;
      html += '<div class="og-sug ' + (sg.level || 'info') + '">' +
        '<div class="t">[' + kindLabel + '] ' + esc(sg.title) + '</div>' +
        '<div class="d">' + esc(sg.detail) + '</div></div>';
    });
    html += '</div>';

    // 重叠
    var overlaps = w.overlaps || [];
    html += '<div class="og-sec"><h3>职责重叠</h3>';
    if (!overlaps.length) html += '<div class="og-empty">无职责重叠。</div>';
    else {
      html += table(['Agent A', 'Agent B', '重叠职责域'],
        overlaps.map(function (o) {
          return '<td>' + esc(o.a) + '</td><td>' + esc(o.b) + '</td><td>' + esc(o.shared.join('、')) + '</td>';
        }));
    }
    html += '</div>';

    // 工作量明细
    var profile = w.profile || [];
    html += '<div class="og-sec"><h3>工作量明细</h3>' + table(
      ['Agent', '职责域', '调用', 'Token', '成本'],
      profile.map(function (p) {
        return '<td>' + esc(p.name) + '</td><td>' + esc((p.domains || []).slice(0, 3).join('、') || '—') + '</td>' +
          '<td class="num">' + fmtNum(p.workload.calls) + '</td>' +
          '<td class="num">' + fmtTokens(p.workload.tokensIn + p.workload.tokensOut) + '</td>' +
          '<td class="num">' + money(p.workload.cost) + '</td>';
      })
    ) + '</div>';

    html += '<div class="og-updated">Agent 总管 · 更新于 ' + new Date(w.generated_at || Date.now()).toLocaleString('zh-CN') + '</div>';
    return html;
  }

  /* ============ 工具 ============ */
  function ocard(n, label, sub) {
    return '<div class="og-card"><div class="n">' + esc(n) + '</div>' +
      '<div class="l">' + esc(label) + '</div><div class="s">' + esc(sub || '') + '</div></div>';
  }
  function table(heads, rows) {
    var html = '<table class="og-tbl"><thead><tr>' +
      heads.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') +
      '</tr></thead><tbody>';
    if (!rows.length) html += '<tr><td colspan="' + heads.length + '" style="color:#b4b2a9;text-align:center;padding:16px;">暂无数据</td></tr>';
    else rows.forEach(function (r) { html += '<tr>' + r + '</tr>'; });
    html += '</tbody></table>';
    return html;
  }

  function bindRowActions() {
    bodyEl.querySelectorAll('[data-lock]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-lock');
        var engine = btn.getAttribute('data-engine');
        window.ingrid.opsLockModel(name, engine).then(function () { refresh(); });
      });
    });
    bodyEl.querySelectorAll('[data-unlock]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var name = btn.getAttribute('data-unlock');
        window.ingrid.opsUnlockModel(name).then(function () { refresh(); });
      });
    });
  }

  // 主进程定时巡检（每 15 分钟）会广播 ops:changed，面板开着时自动刷新
  if (IS_DESKTOP && window.ingrid.onOpsChanged) {
    window.ingrid.onOpsChanged(function (r) { if (mask && mask.classList.contains('open')) render(r); });
  }
})();
