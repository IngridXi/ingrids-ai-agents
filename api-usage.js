/**
 * api-usage.js — API 用量与余额监控仪表盘（零依赖，local-first）
 *
 * 监控各家云端 API（DeepSeek / GPT / Qwen·通义万相）的：
 *   - 余额（DeepSeek 走官方 /user/balance 自动查；GPT/Qwen 手动填）
 *   - 本工作台用量（本地按月 jsonl 账本，聊天链路已自动记账）
 *   - 其他用量（仅 DeepSeek 可反推：充值额 − 余额 − 工作台成本）
 *   - 低余额提醒（余额 ≤ 阈值 → 红色字体 + 系统通知，主进程定时检查）
 *
 * 参考开源范式：
 *   - river291/display-api-balance：低余额阈值变红
 *   - Rannist/balance-dsh：余额 + 用量反推「其他用量」
 *   - dsh-cost-meter / TokenBar：多供应商余额 + 预算提醒
 */
(function () {
  'use strict';
  var IS_DESKTOP = !!(window.ingrid && window.ingrid.isDesktop);

  var STYLE = [
    '.au-mask{position:fixed;inset:0;background:rgba(20,18,35,.45);display:none;align-items:center;justify-content:center;z-index:300;}',
    '.au-mask.open{display:flex;}',
    '.au-panel{width:min(920px,95vw);max-height:90vh;display:flex;flex-direction:column;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.25);}',
    '.au-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid #eee;flex:none;}',
    '.au-head h2{margin:0;font-size:17px;font-weight:650;color:#2c2c2a;}',
    '.au-head .au-sub{font-size:12px;color:#888780;font-weight:400;margin-top:2px;}',
    '.au-head .au-actions{display:flex;align-items:center;gap:8px;}',
    '.au-refresh{border:1px solid #ddd;background:#fff;color:#5F5E5A;border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:inherit;}',
    '.au-refresh:hover{border-color:#7F77DD;color:#534AB7;}',
    '.au-close{border:none;background:transparent;font-size:24px;line-height:1;cursor:pointer;color:#888780;padding:4px 8px;}',
    '.au-close:hover{color:#2c2c2a;}',
    '.au-body{flex:1;overflow-y:auto;padding:18px 22px;display:flex;flex-direction:column;gap:16px;}',
    '.au-overview{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;}',
    '.au-ocard{border:1px solid #eee;border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:4px;}',
    '.au-ocard .n{font-size:22px;font-weight:650;color:#2c2c2a;line-height:1.1;}',
    '.au-ocard .l{font-size:12px;color:#5F5E5A;}',
    '.au-ocard .s{font-size:11px;color:#b4b2a9;}',
    '.au-eng{display:flex;flex-direction:column;gap:14px;}',
    '.au-card{border:1px solid #eee;border-radius:14px;padding:16px 18px;}',
    '.au-card.low{border-color:#e5484d;background:#fff8f8;}',
    '.au-card .au-top{display:flex;align-items:center;gap:10px;margin-bottom:10px;}',
    '.au-card .au-ename{font-size:15px;font-weight:650;color:#2c2c2a;flex:1;}',
    '.au-badge{font-size:11px;font-weight:600;padding:2px 9px;border-radius:999px;flex:none;}',
    '.au-badge.key{background:#eef3fb;color:#2f6fed;}',
    '.au-badge.nokey{background:#f3f0ea;color:#a09b8c;}',
    '.au-badge.low{background:#fdeaea;color:#e5484d;animation:auPulse 1.2s infinite;}',
    '.au-badge.auto{background:#ecf8ef;color:#2f9e5f;}',
    '.au-badge.manual{background:#f6f1e7;color:#b08938;}',
    '@keyframes auPulse{0%,100%{opacity:1;}50%{opacity:.5;}}',
    '.au-bal{display:flex;align-items:baseline;gap:8px;}',
    '.au-bal .num{font-size:30px;font-weight:700;color:#2c2c2a;line-height:1;}',
    '.au-bal .num.low{color:#e5484d;}',
    '.au-bal .cur{font-size:13px;color:#888780;}',
    '.au-bal .thr{font-size:11px;color:#b4b2a9;}',
    '.au-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:12px;}',
    '.au-cell{background:#faf9f7;border-radius:9px;padding:10px 12px;}',
    '.au-cell .k{font-size:11px;color:#a09b8c;}',
    '.au-cell .v{font-size:15px;font-weight:650;color:#2c2c2a;margin-top:2px;}',
    '.au-cell .v.other{color:#b08938;}',
    '.au-foot{display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap;}',
    '.au-foot .inp{padding:6px 9px;border:1px solid #ddd;border-radius:8px;font-size:12px;width:80px;font-family:inherit;}',
    '.au-foot .btn{padding:6px 12px;border:1px solid #ddd;background:#fff;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;color:#5F5E5A;}',
    '.au-foot .btn:hover{border-color:#7F77DD;color:#534AB7;}',
    '.au-foot .lbl{font-size:12px;color:#a09b8c;}',
    '.au-sec{border:1px solid #eee;border-radius:12px;padding:14px 16px;}',
    '.au-sec h3{margin:0 0 12px;font-size:13px;font-weight:600;color:#2c2c2a;}',
    '.au-bars{display:flex;align-items:flex-end;gap:3px;height:90px;}',
    '.au-bars .b{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0;}',
    '.au-bars .bar{width:100%;background:#7F77DD;border-radius:3px 3px 0 0;min-height:1px;}',
    '.au-bars .bar.zero{background:#eee;}',
    '.au-bars .day{font-size:9px;color:#b4b2a9;transform:rotate(-45deg);white-space:nowrap;}',
    '.au-legend{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:8px;font-size:11px;color:#b4b2a9;}',
    '.au-empty{text-align:center;color:#888780;font-size:13px;padding:40px 0;}',
    '.au-err{font-size:13px;color:#A32D2D;background:#FCEBEB;border-radius:8px;padding:12px;}',
    '.au-updated{font-size:11px;color:#b4b2a9;}',
  ].join('');

  var mask, bodyEl, headEl;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtMoney(n, dec) {
    n = Number(n) || 0;
    return n.toFixed(dec == null ? 2 : dec);
  }
  function fmtTokens(n) {
    n = Number(n) || 0;
    if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return String(Math.round(n));
  }
  // 工作台成本按 USD 记账；展示时：$ 币种原样，¥ 币种 ×7.2
  function costDisplay(usd, symbol) {
    usd = Number(usd) || 0;
    if (symbol === '$') return '$' + fmtMoney(usd);
    return '¥' + fmtMoney(usd * 7.2);
  }
  function relTime(ts) {
    if (!ts) return '从未';
    var d = Date.now() - ts;
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return new Date(ts).toLocaleDateString('zh-CN');
  }

  function ensurePanel() {
    if (mask) return;
    var st = document.createElement('style');
    st.textContent = STYLE;
    document.head.appendChild(st);

    mask = document.createElement('div');
    mask.className = 'au-mask';
    mask.innerHTML =
      '<div class="au-panel">' +
      '  <div class="au-head">' +
      '    <div><h2>API 用量与余额</h2><div class="au-sub">监控各家云端 API 的余额、工作台用量与其他用量 · 低余额自动变红并提醒</div></div>' +
      '    <div class="au-actions"><button class="au-refresh" type="button">刷新余额</button><button class="au-close" type="button">&times;</button></div>' +
      '  </div>' +
      '  <div class="au-body"></div>' +
      '</div>';
    document.body.appendChild(mask);

    bodyEl = mask.querySelector('.au-body');
    headEl = mask.querySelector('.au-head');
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    mask.querySelector('.au-close').addEventListener('click', close);
    mask.querySelector('.au-refresh').addEventListener('click', refresh);
  }

  function open() {
    ensurePanel();
    mask.classList.add('open');
    load();
  }
  function close() { if (mask) mask.classList.remove('open'); }
  window.__openApiUsage = open;

  function load() {
    if (!IS_DESKTOP) {
      bodyEl.innerHTML = '<div class="au-empty">API 用量仪表盘需在桌面应用中使用</div>';
      return;
    }
    bodyEl.innerHTML = '<div class="au-empty">正在读取用量与余额…</div>';
    window.ingrid.getBalance().then(render).catch(function (e) {
      bodyEl.innerHTML = '<div class="au-err">加载失败：' + esc((e && e.message) || e) + '</div>';
    });
  }

  function refresh() {
    if (!IS_DESKTOP) return;
    headEl.querySelector('.au-refresh').disabled = true;
    headEl.querySelector('.au-refresh').textContent = '刷新中…';
    window.ingrid.refreshBalance().then(function (r) {
      headEl.querySelector('.au-refresh').disabled = false;
      headEl.querySelector('.au-refresh').textContent = '刷新余额';
      if (r && r.dashboard) render(r.dashboard);
      else load();
      if (r && r.deepseek && r.deepseek.ok === false) {
        // 静默：余额查询失败不打断渲染，卡片上会显示「未查到」
      }
    }).catch(function (e) {
      headEl.querySelector('.au-refresh').disabled = false;
      headEl.querySelector('.au-refresh').textContent = '刷新余额';
      bodyEl.innerHTML = '<div class="au-err">刷新失败：' + esc((e && e.message) || e) + '</div>';
    });
  }

  function render(d) {
    if (!d || !d.engines) {
      bodyEl.innerHTML = '<div class="au-err">' + esc((d && d.error) || '数据异常') + '</div>';
      return;
    }
    var s = d.summary || {};
    var html = '';

    // 1) 概览
    html += '<div class="au-overview">';
    html += ocard(costDisplay(s.totalCost, '¥'), '本月工作台成本', '全部引擎累计');
    html += ocard(fmtTokens(s.totalIn + s.totalOut), '累计 Token', '输入 ' + fmtTokens(s.totalIn) + ' · 输出 ' + fmtTokens(s.totalOut));
    html += ocard(fmtNum(s.calls), '累计调用', '记账条数');
    html += '</div>';

    // 2) 各家 API 卡片
    html += '<div class="au-eng">';
    ['deepseek', 'gpt', 'qwen'].forEach(function (id) {
      var e = d.engines[id];
      if (!e) return;
      html += engineCard(e);
    });
    html += '</div>';

    // 3) 近 30 天用量
    html += '<div class="au-sec"><h3>近 30 天工作台成本（按天，¥）</h3>' + bars(s) + '</div>';

    html += '<div class="au-updated">数据更新于 ' + new Date(d.updatedAt).toLocaleString('zh-CN') + ' · DeepSeek 余额自动查询，GPT/Qwen 余额请手动填写</div>';

    bodyEl.innerHTML = html;
    bindCards();
  }

  function ocard(n, label, sub) {
    return '<div class="au-ocard"><div class="n">' + esc(n) + '</div>' +
      '<div class="l">' + esc(label) + '</div><div class="s">' + esc(sub) + '</div></div>';
  }

  function engineCard(e) {
    var balClass = e.low ? ' low' : '';
    var badges = '';
    if (e.hasKey) badges += '<span class="au-badge key">已配 Key</span>';
    else badges += '<span class="au-badge nokey">未配 Key</span>';
    if (e.auto) badges += '<span class="au-badge auto">余额自动查</span>';
    else badges += '<span class="au-badge manual">余额手动填</span>';
    if (e.low) badges += '<span class="au-badge low">余额不足</span>';

    var balNum = (typeof e.balance === 'number')
      ? '<span class="num' + balClass + '">' + e.symbol + fmtMoney(e.balance) + '</span>'
      : '<span class="num" style="color:#b4b2a9">' + e.symbol + '—</span>';

    var otherTxt = (e.otherUsageCny != null)
      ? '<span class="v other">¥' + fmtMoney(e.otherUsageCny) + '</span>'
      : '<span class="v" style="color:#b4b2a9">—</span>';

    var html =
      '<div class="au-card' + (e.low ? ' low' : '') + '" data-engine="' + esc(e.engine) + '">' +
      '  <div class="au-top"><span class="au-ename">' + esc(e.name) + '</span>' + badges + '</div>' +
      '  <div class="au-bal">' + balNum +
      '    <span class="cur">' + esc(e.currency) + '</span>' +
      '    <span class="thr">阈值 ' + e.symbol + (e.threshold || '—') + ' · 更新 ' + relTime(e.updatedAt) + '</span>' +
      '  </div>' +
      '  <div class="au-grid">' +
      '    <div class="au-cell"><div class="k">本月工作台</div><div class="v">' + costDisplay(e.monthCostUsd, e.symbol) + '</div></div>' +
      '    <div class="au-cell"><div class="k">累计工作台</div><div class="v">' + costDisplay(e.allCostUsd, e.symbol) + '</div></div>' +
      '    <div class="au-cell"><div class="k">其他用量</div>' + otherTxt + '</div>' +
      '  </div>' +
      '  <div class="au-grid">' +
      '    <div class="au-cell"><div class="k">本月 Token</div><div class="v">' + fmtTokens(e.monthIn + e.monthOut) + '</div></div>' +
      '    <div class="au-cell"><div class="k">累计 Token</div><div class="v">' + fmtTokens((e.monthIn + e.monthOut)) + '</div></div>' +
      '    <div class="au-cell"><div class="k">调用次数</div><div class="v">' + fmtNum(e.calls) + '</div></div>' +
      '  </div>' +
      '  <div class="au-foot">';
    if (!e.auto) {
      html += '<span class="lbl">手动填余额 ' + e.symbol + '</span>' +
        '<input class="inp au-manual" type="number" min="0" step="0.01" placeholder="' + esc(e.currency) + '" />' +
        '<button class="btn au-save-manual" type="button">保存</button>';
    }
    html += '<span class="lbl">低余额阈值 ' + e.symbol + '</span>' +
      '<input class="inp au-threshold" type="number" min="0" step="1" value="' + esc(e.threshold || '') + '" />' +
      '<button class="btn au-save-threshold" type="button">保存阈值</button>';
    html += '  </div>' +
      '</div>';
    return html;
  }

  function bars(s) {
    var labels = s.dayLabels || [];
    var days = s.days || {};
    if (!labels.length) return '<div class="au-empty">暂无用量数据</div>';
    var max = 0;
    labels.forEach(function (k) { max = Math.max(max, Number(days[k]) || 0); });
    var html = '<div class="au-bars">';
    labels.forEach(function (k) {
      var v = Number(days[k]) || 0;
      var h = max > 0 ? Math.max(1, Math.round(v / max * 80)) : 1;
      var day = k.slice(5).replace('-', '/');
      html += '<div class="b"><span class="bar' + (v <= 0 ? ' zero' : '') + '" style="height:' + h + 'px" title="' + esc(k) + ' · ¥' + fmtMoney(v * 7.2) + '"></span><span class="day">' + day + '</span></div>';
    });
    html += '</div>';
    html += '<div class="au-legend"><span>峰值 ¥' + fmtMoney(max * 7.2) + '</span></div>';
    return html;
  }

  function fmtNum(n) {
    n = Number(n) || 0;
    return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n);
  }

  function bindCards() {
    bodyEl.querySelectorAll('.au-card').forEach(function (card) {
      var eng = card.getAttribute('data-engine');

      var saveThreshold = card.querySelector('.au-save-threshold');
      var thrInput = card.querySelector('.au-threshold');
      if (saveThreshold && thrInput) {
        saveThreshold.addEventListener('click', function () {
          var v = thrInput.value.trim();
          window.ingrid.setBalanceThreshold(eng, v).then(function () { load(); });
        });
      }

      var saveManual = card.querySelector('.au-save-manual');
      var manualInput = card.querySelector('.au-manual');
      if (saveManual && manualInput) {
        saveManual.addEventListener('click', function () {
          var v = manualInput.value.trim();
          if (v === '') return;
          window.ingrid.setManualBalance(eng, v).then(function () { load(); });
        });
      }
    });
  }
})();
