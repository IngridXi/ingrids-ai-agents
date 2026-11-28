/**
 * ============================================================
 *  pending-panel.js —— 待办捕获官 · 漂浮面板（共享组件，零依赖）
 * ============================================================
 *  每个助手（研究助手/软件工程/通用助手）窗口右下角漂浮一个「待办清单」：
 *    - 未完成项标红，已完成项打勾灰显（不删除）
 *    - 可勾选完成 / 恢复 / 删除 / 清除已完成 / 手动刷新
 *    - 监听 pending:changed 广播自动刷新；随 agent 隔离（各自独立记忆）
 *
 *  用法：在 agent 的 index.html 末尾引入本文件，再：
 *    PendingPanel.init({ agent: AGENT_NAME });
 */
(function (global) {
  'use strict';

  var AGENT = '';
  var fabEl = null, panelEl = null, bodyEl = null, qBodyEl = null, stepBodyEl = null, autoBodyEl = null, countEl = null;
  var currentTab = 'todo';
  var autoState = null;
  var autoKinds = ['todo', 'question'];
  var todoOpenCount = 0, qOpenCount = 0, stepOpenCount = 0;

  /* ---------- 样式 ---------- */
  function ensureStyle() {
    if (document.getElementById('pp-style')) return;
    var css = [
      '#pending-panel-fab{position:fixed;right:18px;bottom:18px;z-index:999999;width:52px;height:52px;',
      'border-radius:50%;background:#7F77DD;color:#fff;display:flex;align-items:center;justify-content:center;',
      'cursor:pointer;box-shadow:0 6px 18px rgba(63,55,150,.35);font-size:22px;user-select:none;',
      'transition:transform .12s ease;border:none;}',
      '#pending-panel-fab:hover{transform:scale(1.08);}',
      '#pending-panel-fab .pp-count{position:absolute;top:-2px;right:-2px;min-width:20px;height:20px;',
      'border-radius:10px;background:#E5484D;color:#fff;font-size:12px;font-weight:700;',
      'display:flex;align-items:center;justify-content:center;padding:0 5px;box-sizing:border-box;}',
      '#pending-panel-fab .pp-count.zero{background:#9B98B0;}',
      '#pending-panel{position:fixed;right:18px;bottom:78px;z-index:999999;width:340px;max-height:70vh;',
      'background:#fff;border:1px solid #e8e6f2;border-radius:16px;box-shadow:0 18px 50px rgba(20,18,45,.22);',
      'display:flex;flex-direction:column;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;}',
      '#pending-panel .pp-head{display:flex;align-items:center;gap:8px;padding:12px 14px;',
      'border-bottom:1px solid #f0eef8;background:#FAFAFE;}',
      '#pending-panel .pp-title{font-size:14px;font-weight:700;color:#2c2c2a;}',
      '#pending-panel .pp-agent{font-size:11px;color:#9B98B0;background:#EEEBFB;padding:2px 8px;border-radius:10px;}',
      '#pending-panel .pp-spacer{flex:1;}',
      '#pending-panel .pp-iconbtn{border:none;background:transparent;cursor:pointer;font-size:16px;color:#9B98B0;padding:2px 6px;border-radius:6px;}',
      '#pending-panel .pp-iconbtn:hover{background:#F0EEF8;color:#534AB7;}',
      '#pending-panel .pp-body,#pending-panel .pp-qbody,#pending-panel .pp-stepbody{flex:1;overflow-y:auto;padding:8px 10px;}',
      '#pending-panel .pp-empty{padding:34px 16px;text-align:center;color:#9B98B0;font-size:13px;line-height:1.7;}',
      '#pending-panel .pp-item{display:flex;align-items:flex-start;gap:8px;padding:9px 8px;border-radius:10px;margin-bottom:4px;}',
      '#pending-panel .pp-item:hover{background:#F7F6FD;}',
      '#pending-panel .pp-check{flex:0 0 auto;width:18px;height:18px;border-radius:5px;border:2px solid #D4D2E4;',
      'background:#fff;cursor:pointer;margin-top:1px;display:flex;align-items:center;justify-content:center;',
      'font-size:11px;color:#fff;transition:all .12s ease;padding:0;}',
      '#pending-panel .pp-item.open .pp-check{border-color:#E5484D;}',
      '#pending-panel .pp-item.open .pp-check:hover{background:#FCEBEB;}',
      '#pending-panel .pp-item.done .pp-check{background:#5DBB63;border-color:#5DBB63;}',
      '#pending-panel .pp-mid{flex:1;min-width:0;}',
      '#pending-panel .pp-txt{font-size:13px;line-height:1.45;color:#2c2c2a;word-break:break-word;}',
      '#pending-panel .pp-item.open .pp-txt{color:#A32D2D;font-weight:600;}',
      '#pending-panel .pp-item.done .pp-txt{color:#9B98B0;text-decoration:line-through;}',
      '#pending-panel .pp-item.suggested{background:#FDF8EE;border:1px solid #F5E6C8;}',
      '#pending-panel .pp-item.suggested .pp-txt{color:#854F0B;}',
      '#pending-panel .pp-sugtag{display:inline-block;font-size:10px;color:#854F0B;background:#FAEEDA;padding:1px 6px;border-radius:8px;margin-right:6px;vertical-align:1px;}',
      '#pending-panel .pp-section-hint{font-size:11px;color:#B45309;padding:4px 8px 2px;margin-top:2px;}',
      '#pending-panel .pp-meta{font-size:11px;color:#b4b2a9;margin-top:3px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;}',
      '#pending-panel .pp-tag{font-size:10px;color:#854F0B;background:#FAEEDA;padding:1px 6px;border-radius:8px;}',
      '#pending-panel .pp-item-actions{flex:0 0 auto;display:flex;gap:2px;opacity:0;transition:opacity .12s ease;}',
      '#pending-panel .pp-item:hover .pp-item-actions{opacity:1;}',
      '#pending-panel .pp-act{border:none;background:transparent;cursor:pointer;font-size:13px;color:#9B98B0;padding:2px 4px;border-radius:5px;}',
      '#pending-panel .pp-act:hover{background:#F0EEF8;color:#534AB7;}',
      '#pending-panel .pp-run{color:#7F77DD;font-weight:700;font-size:14px;}',
      '#pending-panel .pp-run:hover{background:#EEEBFC;color:#534AB7;}',
      '#pending-panel .pp-run[disabled]{color:#C9C4E0;cursor:default;}',
      '#pending-panel .pp-run[disabled]:hover{background:transparent;}',
      '#pending-panel .pp-item.running{background:#F4F2FD;}',
      '#pending-panel .pp-err{font-size:11px;color:#B45309;background:#FFF7E6;border-left:2px solid #E6A23C;padding:2px 6px;border-radius:4px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '#pending-panel .pp-foot{display:flex;gap:8px;padding:10px 14px;border-top:1px solid #f0eef8;}',
      '#pending-panel .pp-foot button{flex:1;border:1px solid #E3E1F0;background:#fff;color:#5F5E5A;',
      'border-radius:8px;padding:6px 0;font-size:12px;cursor:pointer;font-family:inherit;}',
      '#pending-panel .pp-foot button:hover{border-color:#7F77DD;color:#534AB7;}',
      '#pending-panel .pp-foot button.pp-clear:hover{border-color:#E5484D;color:#E5484D;}',
      '#pending-panel .pp-tabs{display:flex;border-bottom:1px solid #f0eef8;background:#FAFAFE;}',
      '#pending-panel .pp-tab{flex:1;border:none;background:transparent;padding:9px 4px;font-size:13px;color:#9B98B0;cursor:pointer;font-family:inherit;border-bottom:2px solid transparent;}',
      '#pending-panel .pp-tab:hover{color:#534AB7;}',
      '#pending-panel .pp-tab.active{color:#534AB7;font-weight:700;border-bottom-color:#7F77DD;}',
      '#pending-panel .pp-auto{padding:14px;}',
      '#pending-panel .pp-auto-start{width:100%;border:none;background:#7F77DD;color:#fff;padding:12px 0;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit;}',
      '#pending-panel .pp-auto-start:hover{background:#6B63CC;}',
      '#pending-panel .pp-auto-start.running{background:#E5484D;}',
      '#pending-panel .pp-auto-start.running:hover{background:#D03C40;}',
      '#pending-panel .pp-auto-status{margin:12px 2px 0;font-size:13px;color:#2c2c2a;line-height:1.6;}',
      '#pending-panel .pp-auto-status .dim{color:#9B98B0;}',
      '#pending-panel .pp-auto-stats{margin:10px 2px 0;font-size:13px;color:#2c2c2a;display:flex;gap:14px;}',
      '#pending-panel .pp-auto-log{margin-top:12px;border-top:1px solid #f0eef8;padding-top:10px;max-height:42vh;overflow-y:auto;}',
      '#pending-panel .pp-auto-log .lg-title{font-size:11px;color:#9B98B0;margin-bottom:6px;}',
      '#pending-panel .pp-auto-log .lg-item{font-size:12px;line-height:1.5;padding:4px 0;color:#5F5E5A;display:flex;gap:6px;align-items:flex-start;}',
      '#pending-panel .pp-auto-log .lg-item .v{flex:none;font-weight:700;}',
      '#pending-panel .pp-auto-log .lg-item.done .v{color:#3BA55D;}',
      '#pending-panel .pp-auto-log .lg-item.blocked .v{color:#E6A23C;}',
      // 相关问题清单
      '#pending-panel .pp-q-why{font-size:11px;color:#7a6a3a;line-height:1.5;margin-top:2px;}',
      '#pending-panel .pp-q-anchor{display:inline-block;font-size:10px;color:#534AB7;background:#EEEBFB;padding:1px 6px;border-radius:8px;margin-right:6px;margin-top:3px;}',
      '#pending-panel .pp-answer{font-size:12px;color:#3f6b43;background:#F1FAF2;border-left:2px solid #5DBB63;padding:4px 8px;border-radius:5px;margin-top:4px;line-height:1.5;max-height:96px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;}',
      '#pending-panel .pp-discover{width:100%;border:none;background:#F3F1FC;color:#534AB7;padding:8px 0;border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;margin-bottom:4px;}',
      '#pending-panel .pp-discover:hover{background:#E9E5FB;}',
      '#pending-panel .pp-discover[disabled]{color:#C9C4E0;cursor:default;}',
      '#pending-panel .pp-q-head{display:flex;gap:8px;padding:8px 10px;}',
      '#pending-panel .pp-q-head input{flex:1;border:1px solid #E3E1F0;border-radius:8px;padding:6px 8px;font-size:12px;font-family:inherit;color:#2c2c2a;}',
      '#pending-panel .pp-q-head button{border:1px solid #E3E1F0;background:#fff;color:#534AB7;border-radius:8px;padding:6px 10px;font-size:12px;cursor:pointer;font-family:inherit;}',
      '#pending-panel .pp-q-head button:hover{background:#F3F1FC;border-color:#7F77DD;}',
      '#pending-panel .pp-kinds{display:flex;gap:14px;margin:10px 2px 0;font-size:12px;color:#5F5E5A;}',
      '#pending-panel .pp-kinds label{display:flex;align-items:center;gap:5px;cursor:pointer;user-select:none;}',
      '#pending-panel .pp-kinds input{accent-color:#7F77DD;}',
      // 步骤清单
      '#pending-panel .pp-step-detail{font-size:11px;color:#5F5E5A;line-height:1.5;margin-top:2px;}',
      '#pending-panel .pp-step-road{display:inline-block;font-size:10px;color:#0f766e;background:#E6F7F5;padding:1px 6px;border-radius:8px;margin-right:6px;margin-top:3px;}',
      '#pending-panel .pp-step-num{flex:0 0 auto;width:20px;height:20px;border-radius:6px;background:#F3F1FC;color:#534AB7;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px;}',
    ].join('\n');
    var st = document.createElement('style');
    st.id = 'pp-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------- DOM ---------- */
  function ensureDom() {
    if (fabEl) return;
    fabEl = document.createElement('div');
    fabEl.id = 'pending-panel-fab';
    fabEl.title = '待办清单';
    fabEl.innerHTML = '<span style="pointer-events:none">📋</span><span class="pp-count zero" style="display:none">0</span>';
    fabEl.addEventListener('click', function () {
      var show = panelEl.style.display === 'none';
      panelEl.style.display = show ? 'flex' : 'none';
      if (show) PendingPanel.refresh();
    });

    panelEl = document.createElement('div');
    panelEl.id = 'pending-panel';
    panelEl.style.display = 'none';
    panelEl.innerHTML =
      '<div class="pp-head">' +
      '<span class="pp-title">待办清单</span>' +
      '<span class="pp-agent"></span>' +
      '<span class="pp-spacer"></span>' +
      '<button class="pp-iconbtn" data-act="refresh" title="刷新">↻</button>' +
      '<button class="pp-iconbtn" data-act="close" title="收起">×</button>' +
      '</div>' +
      '<div class="pp-tabs">' +
      '<button class="pp-tab active" data-tab="todo">📋 待办</button>' +
      '<button class="pp-tab" data-tab="questions">❓ 相关问题</button>' +
      '<button class="pp-tab" data-tab="steps">🪜 步骤</button>' +
      '<button class="pp-tab" data-tab="auto">🚀 自动托管</button>' +
      '</div>' +
      '<div class="pp-body"></div>' +
      '<div class="pp-qbody" style="display:none"></div>' +
      '<div class="pp-stepbody" style="display:none"></div>' +
      '<div class="pp-auto" style="display:none"></div>' +
      '<div class="pp-foot">' +
      '<button data-act="scan">重新扫描</button>' +
      '<button class="pp-clear" data-act="clear">清除已完成</button>' +
      '</div>';

    bodyEl = panelEl.querySelector('.pp-body');
    qBodyEl = panelEl.querySelector('.pp-qbody');
    stepBodyEl = panelEl.querySelector('.pp-stepbody');
    autoBodyEl = panelEl.querySelector('.pp-auto');
    countEl = fabEl.querySelector('.pp-count');
    panelEl.querySelector('.pp-agent').textContent = AGENT || '';

    panelEl.addEventListener('click', function (e) {
      var tab = e.target.closest('[data-tab]');
      if (tab) { switchTab(tab.getAttribute('data-tab')); return; }
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'close') { panelEl.style.display = 'none'; }
      else if (act === 'refresh') { PendingPanel.refresh(); }
      else if (act === 'scan') { PendingPanel.scan(); }
      else if (act === 'clear') { window.ingrid.pendingClearDone(AGENT).then(function () { PendingPanel.refresh(); }); }
      else if (act === 'discover') { PendingPanel.discover(); }
      else if (act === 'qclear') { window.ingrid.questionClearDone(AGENT).then(function () { PendingPanel.refresh(); }); }
      else if (act === 'sgen') { PendingPanel.generateSteps(); }
      else if (act === 'sclear') { window.ingrid.stepClearDone(AGENT).then(function () { PendingPanel.refresh(); }); }
      else if (act === 'autopilot') { toggleAutopilot(); }
    });

    document.body.appendChild(fabEl);
    document.body.appendChild(panelEl);
  }

  /* ---------- 工具 ---------- */
  function relTime(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    var d = new Date(ts);
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------- 渲染 ---------- */
  function render(data) {
    var open = (data && data.open) || [];
    var done = (data && data.done) || [];
    // 正式项（显式写）与建议项（正则扫历史猜的，待确认）分开
    var explicitOpen = open.filter(function (x) { return x.source === 'explicit' || !x.source; });
    var suggestedOpen = open.filter(function (x) { return x.source === 'suggested'; });
    var total = open.length + done.length;

    // 角标只算「正式未完成」（建议项是待确认，不算正式待办）
    todoOpenCount = explicitOpen.length;

    if (!total) {
      bodyEl.innerHTML = '<div class="pp-empty">暂无待办 🎉<br>研究助手显式写清单、或聊天里交代「未完成」时会自动进清单</div>';
      updateFabBadge();
      return;
    }

    var html = '';
    if (suggestedOpen.length) {
      html += '<div class="pp-section-hint">🟡 待确认（正则自动抓取，可能有误，请确认或忽略）</div>';
    }
    explicitOpen.forEach(function (it) { html += itemHtml(it, 'open', false); });
    suggestedOpen.forEach(function (it) { html += itemHtml(it, 'open', true); });
    done.forEach(function (it) { html += itemHtml(it, 'done', false); });
    bodyEl.innerHTML = html;

    // 绑定操作
    bodyEl.querySelectorAll('.pp-check').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-id');
        var isOpen = el.getAttribute('data-status') === 'open';
        if (isOpen) window.ingrid.pendingComplete(id).then(function () { PendingPanel.refresh(); });
        else window.ingrid.pendingReopen(id).then(function () { PendingPanel.refresh(); });
      });
    });
    bodyEl.querySelectorAll('.pp-act[data-act="confirm"]').forEach(function (el) {
      el.addEventListener('click', function () {
        window.ingrid.pendingConfirm(el.getAttribute('data-id')).then(function () { PendingPanel.refresh(); });
      });
    });
    bodyEl.querySelectorAll('.pp-act[data-act="del"]').forEach(function (el) {
      el.addEventListener('click', function () {
        if (!confirm('从清单删除这条待办？')) return;
        window.ingrid.pendingRemove(el.getAttribute('data-id')).then(function () { PendingPanel.refresh(); });
      });
    });
    bodyEl.querySelectorAll('.pp-act[data-act="run"]').forEach(function (el) {
      el.addEventListener('click', function () {
        if (el.disabled) return;
        var id = el.getAttribute('data-id');
        if (!window.ingrid || !window.ingrid.pendingDispatch) { alert('当前环境不支持派发执行'); return; }
        el.disabled = true;
        window.ingrid.pendingDispatch(id).then(function (res) {
          if (res && res.ok) { PendingPanel.refresh(); }
          else { el.disabled = false; if (res && res.error) alert(res.error); }
        }).catch(function () { el.disabled = false; });
      });
    });
  }

  function itemHtml(it, status, suggested) {
    var check = status === 'done' ? '✓' : '';
    var title = esc(it.title);
    var evidence = it.evidence ? esc(it.evidence).slice(0, 120) : '';
    var time = status === 'done' ? relTime(it.doneAt) : relTime(it.updatedAt || it.createdAt);
    var tag = suggested ? '<span class="pp-sugtag">待确认</span>' : '';
    var running = !!it.running;
    var err = it.lastError ? esc(it.lastError) : '';
    var actions = '<button class="pp-act" data-act="del" data-id="' + esc(it.id) + '" title="删除/忽略">🗑</button>';
    if (suggested) {
      actions = '<button class="pp-act" data-act="confirm" data-id="' + esc(it.id) + '" title="确认为正式待办">✓确认</button>' + actions;
    }
    if (status === 'open') {
      actions = '<button class="pp-act pp-run" data-act="run" data-id="' + esc(it.id) + '" title="' + (running ? '执行中…' : '派发给研究助手执行') + '"' + (running ? ' disabled' : '') + '>' + (running ? '⏳' : '▶') + '</button>' + actions;
    }
    var errHtml = err ? '<div class="pp-err" title="' + err + '">⚠️ ' + err + '</div>' : '';
    return '<div class="pp-item ' + status + (suggested ? ' suggested' : '') + (running ? ' running' : '') + '">' +
      '<button class="pp-check" data-id="' + esc(it.id) + '" data-status="' + status + '" title="' + (status === 'open' ? '标记完成' : '恢复为未完成') + '">' + check + '</button>' +
      '<div class="pp-mid">' +
      '<div class="pp-txt"' + (evidence ? ' title="' + evidence + '"' : '') + '>' + tag + title + '</div>' +
      '<div class="pp-meta"><span>' + esc(it.agent || '') + '</span>' + (time ? '<span>' + time + '</span>' : '') + '</div>' +
      errHtml +
      '</div>' +
      '<div class="pp-item-actions">' + actions + '</div>' +
      '</div>';
  }

  /* ---------- 相关问题清单 ---------- */
  function questionItemHtml(it, status) {
    var check = status === 'done' ? '✓' : '';
    var title = esc(it.title);
    var value = it.value ? esc(it.value) : '';
    var anchor = it.anchor ? esc(it.anchor) : '';
    var time = status === 'done' ? relTime(it.doneAt) : relTime(it.updatedAt || it.createdAt);
    var running = !!it.running;
    var err = it.lastError ? esc(it.lastError) : '';
    var answer = (status === 'done' && it.answer) ? '<div class="pp-answer">' + esc(it.answer) + '</div>' : '';
    var tag = (it.source === 'discovered') ? '<span class="pp-sugtag" style="background:#EEEBFB;color:#534AB7">🪄 发掘</span>' : '';
    var actions = '<button class="pp-act" data-act="del" data-id="' + esc(it.id) + '" title="删除/忽略">🗑</button>';
    if (status === 'open') {
      actions = '<button class="pp-act pp-run" data-act="run" data-id="' + esc(it.id) + '" title="' + (running ? '执行中…' : '派发给 agent 研究回答') + '"' + (running ? ' disabled' : '') + '>' + (running ? '⏳' : '▶') + '</button>' + actions;
    }
    var errHtml = err ? '<div class="pp-err" title="' + err + '">⚠️ ' + err + '</div>' : '';
    return '<div class="pp-item ' + status + (running ? ' running' : '') + '">' +
      '<button class="pp-check" data-id="' + esc(it.id) + '" data-status="' + status + '" title="' + (status === 'open' ? '标记已想清楚' : '恢复为未解决') + '">' + check + '</button>' +
      '<div class="pp-mid">' +
      '<div class="pp-txt">' + tag + title + '</div>' +
      (value ? '<div class="pp-q-why">💡 ' + value + '</div>' : '') +
      '<div class="pp-meta">' + (anchor ? '<span class="pp-q-anchor">' + anchor + '</span>' : '') + (time ? '<span>' + time + '</span>' : '') + '</div>' +
      errHtml + answer +
      '</div>' +
      '<div class="pp-item-actions">' + actions + '</div>' +
      '</div>';
  }

  function renderQuestions(data) {
    var open = (data && data.open) || [];
    var done = (data && data.done) || [];
    qOpenCount = open.length;
    var html = '<button class="pp-discover" data-act="discover">🪄 发散式发掘相关问题</button>' +
      '<div class="pp-q-head"><input id="pp-q-input" placeholder="手动添加一个问题…" /><button data-act="qadd">添加</button></div>';
    if (!open.length && !done.length) {
      html += '<div class="pp-empty">暂无相关问题<br>点上方「发掘」发散思考，或让 agent 在对话中自动发掘<br>（围绕核心目的与需求的高价值问题）</div>';
    } else {
      open.forEach(function (it) { html += questionItemHtml(it, 'open'); });
      done.forEach(function (it) { html += questionItemHtml(it, 'done'); });
      if (done.length) html += '<div style="text-align:right;margin-top:6px"><button class="pp-act" data-act="qclear" style="font-size:11px;color:#9B98B0">清除已答 ✕</button></div>';
    }
    qBodyEl.innerHTML = html;

    // 手动添加
    var inp = qBodyEl.querySelector('#pp-q-input');
    var doAdd = function () {
      var v = inp ? (inp.value || '').trim() : '';
      if (!v) return;
      if (!window.ingrid || !window.ingrid.questionAdd) return;
      window.ingrid.questionAdd(AGENT, { title: v, source: 'manual' }).then(function () { PendingPanel.refresh(); });
    };
    if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') doAdd(); });
    qBodyEl.querySelectorAll('.pp-act[data-act="qadd"]').forEach(function (el) { el.addEventListener('click', doAdd); });

    // 勾选完成 / 恢复
    qBodyEl.querySelectorAll('.pp-check').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-id');
        var isOpen = el.getAttribute('data-status') === 'open';
        if (isOpen) window.ingrid.questionComplete(id).then(function () { PendingPanel.refresh(); });
        else window.ingrid.questionReopen(id).then(function () { PendingPanel.refresh(); });
      });
    });
    // 删除 / 忽略
    qBodyEl.querySelectorAll('.pp-act[data-act="del"]').forEach(function (el) {
      el.addEventListener('click', function () {
        if (!confirm('从清单删除这个问题？')) return;
        window.ingrid.questionRemove(el.getAttribute('data-id')).then(function () { PendingPanel.refresh(); });
      });
    });
    // 派发回答
    qBodyEl.querySelectorAll('.pp-act[data-act="run"]').forEach(function (el) {
      el.addEventListener('click', function () {
        if (el.disabled) return;
        var id = el.getAttribute('data-id');
        if (!window.ingrid || !window.ingrid.questionDispatch) { alert('当前环境不支持派发执行'); return; }
        el.disabled = true;
        window.ingrid.questionDispatch(id).then(function (res) {
          if (res && res.ok) { PendingPanel.refresh(); }
          else { el.disabled = false; if (res && res.error) alert(res.error); }
        }).catch(function () { el.disabled = false; });
      });
    });
    updateFabBadge();
  }

  /* ---------- 步骤清单（路线图拆解） ---------- */
  function stepItemHtml(it, status, order) {
    var check = status === 'done' ? '✓' : '';
    var title = esc(it.title);
    var detail = it.detail ? esc(it.detail) : '';
    var roadmap = it.roadmap ? esc(it.roadmap) : '';
    var time = status === 'done' ? relTime(it.doneAt) : relTime(it.updatedAt || it.createdAt);
    var running = !!it.running;
    var err = it.lastError ? esc(it.lastError) : '';
    var actions = '<button class="pp-act" data-act="del" data-id="' + esc(it.id) + '" title="删除/忽略">🗑</button>';
    if (status === 'open') {
      actions = '<button class="pp-act pp-run" data-act="run" data-id="' + esc(it.id) + '" title="' + (running ? '执行中…' : '派发给 ' + esc(it.agent || '') + ' 执行这一步') + '"' + (running ? ' disabled' : '') + '>' + (running ? '⏳' : '▶') + '</button>' + actions;
    }
    var errHtml = err ? '<div class="pp-err" title="' + err + '">⚠️ ' + err + '</div>' : '';
    return '<div class="pp-item ' + status + (running ? ' running' : '') + '">' +
      '<button class="pp-check" data-id="' + esc(it.id) + '" data-status="' + status + '" title="' + (status === 'open' ? '标记完成' : '恢复为未完成') + '">' + check + '</button>' +
      (order != null ? '<span class="pp-step-num">' + order + '</span>' : '') +
      '<div class="pp-mid">' +
      '<div class="pp-txt">' + title + '</div>' +
      (detail ? '<div class="pp-step-detail">' + detail + '</div>' : '') +
      '<div class="pp-meta">' + (roadmap ? '<span class="pp-step-road">🧭 ' + roadmap + '</span>' : '') +
      '<span>' + esc(it.agent || '') + '</span>' + (time ? '<span>' + time + '</span>' : '') + '</div>' +
      errHtml +
      '</div>' +
      '<div class="pp-item-actions">' + actions + '</div>' +
      '</div>';
  }

  function renderSteps(data) {
    var open = (data && data.open) || [];
    var done = (data && data.done) || [];
    stepOpenCount = open.length;
    var html = '<button class="pp-discover" data-act="sgen">🪜 根据路线图生成详细步骤</button>';
    if (!open.length && !done.length) {
      html += '<div class="pp-empty">暂无步骤<br>先在监事面板设定「路线图大方向」，再点上方生成步骤<br>（会按 agent 自动分发到各自的清单）</div>';
    } else {
      open.forEach(function (it, i) { html += stepItemHtml(it, 'open', it.order != null ? it.order : (i + 1)); });
      done.forEach(function (it) { html += stepItemHtml(it, 'done', null); });
      if (done.length) html += '<div style="text-align:right;margin-top:6px"><button class="pp-act" data-act="sclear" style="font-size:11px;color:#9B98B0">清除已完成 ✕</button></div>';
    }
    stepBodyEl.innerHTML = html;

    // 勾选完成 / 恢复
    stepBodyEl.querySelectorAll('.pp-check').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = el.getAttribute('data-id');
        var isOpen = el.getAttribute('data-status') === 'open';
        if (isOpen) window.ingrid.stepComplete(id).then(function () { PendingPanel.refresh(); });
        else window.ingrid.stepReopen(id).then(function () { PendingPanel.refresh(); });
      });
    });
    // 删除 / 忽略
    stepBodyEl.querySelectorAll('.pp-act[data-act="del"]').forEach(function (el) {
      el.addEventListener('click', function () {
        if (!confirm('从清单删除这条步骤？')) return;
        window.ingrid.stepRemove(el.getAttribute('data-id')).then(function () { PendingPanel.refresh(); });
      });
    });
    // 派发执行
    stepBodyEl.querySelectorAll('.pp-act[data-act="run"]').forEach(function (el) {
      el.addEventListener('click', function () {
        if (el.disabled) return;
        var id = el.getAttribute('data-id');
        if (!window.ingrid || !window.ingrid.stepDispatch) { alert('当前环境不支持派发执行'); return; }
        el.disabled = true;
        window.ingrid.stepDispatch(id).then(function (res) {
          if (res && res.ok) { PendingPanel.refresh(); }
          else { el.disabled = false; if (res && res.error) alert(res.error); }
        }).catch(function () { el.disabled = false; });
      });
    });
    updateFabBadge();
  }

  // 更新 tab 上的计数角标
  function updateTabs() {
    var tabs = panelEl.querySelectorAll('.pp-tab');
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i].getAttribute('data-tab');
      if (t === 'todo') tabs[i].innerHTML = '📋 待办' + (todoOpenCount ? ' (' + todoOpenCount + ')' : '');
      else if (t === 'questions') tabs[i].innerHTML = '❓ 相关问题' + (qOpenCount ? ' (' + qOpenCount + ')' : '');
      else if (t === 'steps') tabs[i].innerHTML = '🪜 步骤' + (stepOpenCount ? ' (' + stepOpenCount + ')' : '');
    }
  }

  // 更新 FAB 角标：正式待办 + 相关问题 + 步骤（都是「open 的工作」）
  function updateFabBadge() {
    var total = todoOpenCount + qOpenCount + stepOpenCount;
    countEl.textContent = String(total);
    countEl.style.display = total > 0 ? 'flex' : 'none';
    updateTabs();
  }

  /* ---------- 自动托管 ---------- */
  function switchTab(name) {
    currentTab = name;
    var tabs = panelEl.querySelectorAll('.pp-tab');
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
    }
    bodyEl.style.display = name === 'todo' ? '' : 'none';
    qBodyEl.style.display = name === 'questions' ? '' : 'none';
    stepBodyEl.style.display = name === 'steps' ? '' : 'none';
    autoBodyEl.style.display = name === 'auto' ? '' : 'none';
    panelEl.querySelector('.pp-foot').style.display = name === 'todo' ? '' : 'none';
    if (name === 'questions') refreshQuestions();
    if (name === 'steps') refreshSteps();
    if (name === 'auto') renderAutopilot();
  }

  function renderAutopilot() {
    if (!autoBodyEl) return;
    var st = autoState || { active: false, done: 0, blocked: 0, current: '', log: [], kinds: autoKinds };
    var active = !!st.active;
    var kinds = active ? (st.kinds && st.kinds.length ? st.kinds : autoKinds) : autoKinds;
    var html = '';
    // 托管范围：待办 / 相关问题 / 步骤（分别或同时勾选）
    html += '<div class="pp-kinds">' +
      '<span style="font-size:11px;color:#9B98B0">托管范围</span>' +
      '<label><input type="checkbox" data-kind="todo" ' + (kinds.indexOf('todo') >= 0 ? 'checked' : '') + (active ? ' disabled' : '') + '> 📋 待办</label>' +
      '<label><input type="checkbox" data-kind="question" ' + (kinds.indexOf('question') >= 0 ? 'checked' : '') + (active ? ' disabled' : '') + '> ❓ 相关问题</label>' +
      '<label><input type="checkbox" data-kind="step" ' + (kinds.indexOf('step') >= 0 ? 'checked' : '') + (active ? ' disabled' : '') + '> 🪜 步骤</label>' +
      '</div>';
    html += '<button class="pp-auto-start' + (active ? ' running' : '') + '" data-act="autopilot" style="margin-top:10px">' + (active ? '⏹ 停止托管' : '🚀 开始自动托管') + '</button>';
    html += '<div class="pp-auto-status">';
    if (active) {
      html += '状态：<b>运行中…</b>';
      if (st.current) html += '<br>当前：<span class="dim">' + esc(st.current) + '</span>';
    } else {
      html += '状态：<span class="dim">空闲</span>';
    }
    html += '</div>';
    html += '<div class="pp-auto-stats"><span>✅ 完成 <b>' + (st.done || 0) + '</b></span><span>⚠️ 卡住 <b>' + (st.blocked || 0) + '</b></span></div>';
    var log = st.log || [];
    if (log.length) {
      html += '<div class="pp-auto-log"><div class="lg-title">执行记录</div>';
      for (var i = log.length - 1; i >= 0; i--) {
        var it = log[i];
        var isDone = it.verdict === 'done';
        var reason = it.reason ? ' · ' + esc(it.reason) : '';
        var kindTag = it.kind === 'question' ? '❓' : it.kind === 'step' ? '🪜' : '📋';
        html += '<div class="lg-item ' + (isDone ? 'done' : 'blocked') + '"><span class="v">' + (isDone ? '✓' : '⚠') + '</span><span>' + kindTag + ' ' + esc(it.title) + reason + '</span></div>';
      }
      html += '</div>';
    } else {
      html += '<div class="pp-auto-status" style="margin-top:12px"><span class="dim">勾选要托管的清单（待办 / 相关问题 / 步骤，可同时），点「开始自动托管」：会先由执行编排官排好先后顺序，再逐条派发执行，直到全部打勾或卡住。</span></div>';
    }
    autoBodyEl.innerHTML = html;
    // 绑定勾选
    autoBodyEl.querySelectorAll('.pp-kinds input[type="checkbox"]').forEach(function (el) {
      el.addEventListener('change', function () {
        var kind = el.getAttribute('data-kind');
        var idx = autoKinds.indexOf(kind);
        if (el.checked && idx < 0) autoKinds.push(kind);
        else if (!el.checked && idx >= 0) autoKinds.splice(idx, 1);
      });
    });
  }

  function toggleAutopilot() {
    var st = autoState || {};
    if (st.active) {
      if (window.ingrid && window.ingrid.pendingAutopilotStop) window.ingrid.pendingAutopilotStop(AGENT);
    } else if (window.ingrid && window.ingrid.pendingAutopilot) {
      var kinds = autoKinds.length ? autoKinds.slice() : ['todo'];
      window.ingrid.pendingAutopilot(AGENT, kinds).then(function (res) {
        if (res && !res.ok && res.error) alert(res.error);
        renderAutopilot();
      });
    }
  }

  /* ---------- API ---------- */
  function refresh() {
    if (!window.ingrid) return;
    var p1 = window.ingrid.pendingList ? window.ingrid.pendingList(AGENT).catch(function () { return null; }) : Promise.resolve(null);
    var p2 = window.ingrid.questionList ? window.ingrid.questionList(AGENT).catch(function () { return null; }) : Promise.resolve(null);
    var p3 = window.ingrid.stepList ? window.ingrid.stepList(AGENT).catch(function () { return null; }) : Promise.resolve(null);
    Promise.all([p1, p2, p3]).then(function (rs) {
      if (rs[0]) render(rs[0]);
      if (rs[1]) renderQuestions(rs[1]);
      if (rs[2]) renderSteps(rs[2]);
      updateFabBadge();
    });
  }
  function refreshQuestions() {
    if (!window.ingrid || !window.ingrid.questionList) return;
    window.ingrid.questionList(AGENT).then(renderQuestions).catch(function () {});
  }
  function refreshSteps() {
    if (!window.ingrid || !window.ingrid.stepList) return;
    window.ingrid.stepList(AGENT).then(renderSteps).catch(function () {});
  }
  function generateSteps() {
    if (!window.ingrid || !window.ingrid.stepGenerate) return;
    var btn = stepBodyEl ? stepBodyEl.querySelector('[data-act="sgen"]') : null;
    if (btn) btn.disabled = true;
    window.ingrid.stepGenerate().then(function (r) {
      if (r && !r.ok && r.error) alert('生成失败：' + r.error);
      refresh();
    }).catch(function () { refresh(); }).then(function () { if (btn) btn.disabled = false; });
  }
  function scan() {
    if (!window.ingrid || !window.ingrid.pendingScan) return;
    window.ingrid.pendingScan(AGENT).then(function () { refresh(); }).catch(function () { refresh(); });
  }
  function discover() {
    if (!window.ingrid || !window.ingrid.questionDiscover) return;
    var btn = qBodyEl ? qBodyEl.querySelector('[data-act="discover"]') : null;
    if (btn) btn.disabled = true;
    window.ingrid.questionDiscover(AGENT).then(function (r) {
      if (r && !r.ok && r.error) alert('发掘失败：' + r.error);
      refresh();
    }).catch(function () { refresh(); }).then(function () { if (btn) btn.disabled = false; });
  }

  function init(opts) {
    opts = opts || {};
    AGENT = String(opts.agent || '');
    if (document.body) { ensureStyle(); ensureDom(); }
    else { document.addEventListener('DOMContentLoaded', function () { ensureStyle(); ensureDom(); }); }
    // 首次：扫描 + 加载
    if (window.ingrid && window.ingrid.pendingScan) scan(); else refresh();
    // 监听广播自动刷新
    if (window.ingrid && window.ingrid.onPendingChanged) {
      window.ingrid.onPendingChanged(function () { refresh(); });
    }
    if (window.ingrid && window.ingrid.onQuestionChanged) {
      window.ingrid.onQuestionChanged(function () { refresh(); });
    }
    if (window.ingrid && window.ingrid.onStepChanged) {
      window.ingrid.onStepChanged(function () { refresh(); });
    }
    // 监听自动托管进度广播（只响应本 agent）
    if (window.ingrid && window.ingrid.onAutopilotChanged) {
      window.ingrid.onAutopilotChanged(function (d) {
        if (d && d.agent !== AGENT) return;
        autoState = d;
        renderAutopilot();
      });
    }
  }

  global.PendingPanel = { init: init, refresh: refresh, refreshQuestions: refreshQuestions, refreshSteps: refreshSteps, scan: scan, discover: discover, generateSteps: generateSteps };
})(window);
