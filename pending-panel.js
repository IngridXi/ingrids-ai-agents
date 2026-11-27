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
  var fabEl = null, panelEl = null, bodyEl = null, countEl = null;

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
      '#pending-panel .pp-body{flex:1;overflow-y:auto;padding:8px 10px;}',
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
      '<div class="pp-body"></div>' +
      '<div class="pp-foot">' +
      '<button data-act="scan">重新扫描</button>' +
      '<button class="pp-clear" data-act="clear">清除已完成</button>' +
      '</div>';

    bodyEl = panelEl.querySelector('.pp-body');
    countEl = fabEl.querySelector('.pp-count');
    panelEl.querySelector('.pp-agent').textContent = AGENT || '';

    panelEl.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'close') { panelEl.style.display = 'none'; }
      else if (act === 'refresh') { PendingPanel.refresh(); }
      else if (act === 'scan') { PendingPanel.scan(); }
      else if (act === 'clear') { window.ingrid.pendingClearDone(AGENT).then(function () { PendingPanel.refresh(); }); }
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
    countEl.textContent = String(explicitOpen.length);
    countEl.style.display = explicitOpen.length > 0 ? 'flex' : 'none';

    if (!total) {
      bodyEl.innerHTML = '<div class="pp-empty">暂无待办 🎉<br>研究助手显式写清单、或聊天里交代「未完成」时会自动进清单</div>';
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

  /* ---------- API ---------- */
  function refresh() {
    if (!window.ingrid || !window.ingrid.pendingList) return;
    window.ingrid.pendingList(AGENT).then(render).catch(function () {});
  }
  function scan() {
    if (!window.ingrid || !window.ingrid.pendingScan) return;
    window.ingrid.pendingScan(AGENT).then(function () { refresh(); }).catch(function () { refresh(); });
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
  }

  global.PendingPanel = { init: init, refresh: refresh, scan: scan };
})(window);
