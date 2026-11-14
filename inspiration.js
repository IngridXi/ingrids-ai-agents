/**
 * inspiration.js — 灵感目录面板（生态雷达前端，零依赖）
 *
 * 吸收 DSH「万物皆插件」的生态思想：把「每日调研 DSH 插件生态」的结果，
 * 以可解释、按用途板块分组的方式呈现在工作台里。
 *   - 顶部状态条：累计追踪插件数 / 上次调研时间 / 调研次数
 *   - 最近一次调研：markdown 简报（按板块分组 + 全部新插件）
 *   - 历史调研：折叠时间线，点击展开当次简报
 *   - 「立即调研」按钮：手动触发一次生态雷达
 *
 * 数据来源：window.ingrid.ecoRadarStatus() / ecoRadarRun() / onEcoRadarUpdated()
 */
(function () {
  'use strict';
  var IS_DESKTOP = !!(window.ingrid && window.ingrid.isDesktop);

  var STYLE = [
    '.ir-mask{position:fixed;inset:0;background:rgba(20,18,35,.45);display:none;align-items:center;justify-content:center;z-index:300;}',
    '.ir-mask.open{display:flex;}',
    '.ir-panel{width:min(760px,92vw);max-height:88vh;display:flex;flex-direction:column;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.25);}',
    '.ir-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid #eee;}',
    '.ir-head h2{margin:0;font-size:17px;font-weight:600;color:#2c2c2a;}',
    '.ir-head .ir-sub{font-size:12px;color:#888780;font-weight:400;margin-top:2px;}',
    '.ir-head .ir-actions{display:flex;align-items:center;gap:8px;}',
    '.ir-run{border:none;background:#7F77DD;color:#fff;border-radius:8px;padding:7px 14px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;white-space:nowrap;}',
    '.ir-run:hover{background:#534AB7;}',
    '.ir-run:disabled{opacity:.5;cursor:not-allowed;}',
    '.ir-close{border:none;background:transparent;font-size:24px;line-height:1;cursor:pointer;color:#888780;padding:4px 8px;}',
    '.ir-close:hover{color:#2c2c2a;}',
    '.ir-statusbar{display:flex;gap:10px;padding:12px 22px;border-bottom:1px solid #eee;flex-wrap:wrap;}',
    '.ir-chip{font-size:12px;color:#5F5E5A;background:#F1EFE8;border-radius:20px;padding:5px 12px;}',
    '.ir-chip b{color:#2c2c2a;font-weight:600;}',
    '.ir-body{flex:1;overflow-y:auto;padding:16px 22px;display:flex;flex-direction:column;gap:14px;}',
    '.ir-empty{text-align:center;color:#888780;font-size:13px;padding:40px 0;}',
    '.ir-err{font-size:13px;color:#A32D2D;background:#FCEBEB;border-radius:8px;padding:12px;}',
    '.ir-sec{border:1px solid #eee;border-radius:12px;padding:14px 16px;}',
    '.ir-sec h3{margin:0 0 12px;font-size:13px;font-weight:600;color:#2c2c2a;}',
    '.md-h1{font-size:15px;font-weight:600;color:#2c2c2a;margin:4px 0 8px;}',
    '.md-h2{font-size:14px;font-weight:600;color:#2c2c2a;margin:12px 0 6px;}',
    '.md-h3{font-size:13px;font-weight:600;color:#2c2c2a;margin:10px 0 4px;}',
    '.md-p{font-size:13px;color:#5F5E5A;line-height:1.6;margin:4px 0;}',
    '.md-ul{margin:4px 0;padding-left:18px;}',
    '.md-ul li{font-size:13px;color:#3C3489;line-height:1.7;margin:3px 0;}',
    '.md-link{color:#534AB7;text-decoration:none;font-weight:600;}',
    '.md-link:hover{text-decoration:underline;}',
    '.ir-hist{border:1px solid #eee;border-radius:10px;padding:10px 14px;display:flex;align-items:center;gap:10px;cursor:pointer;}',
    '.ir-hist:hover{border-color:#7F77DD;}',
    '.ir-hist .t{flex:1;font-size:13px;color:#2c2c2a;}',
    '.ir-hist .n{font-size:12px;font-weight:600;color:#534AB7;white-space:nowrap;}',
    '.ir-hist .time{font-size:11px;color:#b4b2a9;white-space:nowrap;}',
    '.ir-hist-body{border:1px solid #eee;border-top:none;border-radius:0 0 10px 10px;padding:12px 14px;background:#fafafa;}',
  ].join('');

  var mask, bodyEl, statusEl, runBtn;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtDateTime(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts);
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (e) { return ''; }
  }

  // 行内 markdown：链接 + 加粗
  function inline(s) {
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (_m, txt, url) {
      return '<a href="' + url + '" class="md-link">' + txt + '</a>';
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return s;
  }

  // 轻量 markdown → HTML（标题 / 列表 / 段落）
  function md(s) {
    var lines = esc(String(s || '')).split('\n');
    var html = '', inList = false;
    function closeList() { if (inList) { html += '</ul>'; inList = false; } }
    lines.forEach(function (line) {
      var t = line;
      if (/^###\s+/.test(t)) { closeList(); html += '<div class="md-h3">' + inline(t.replace(/^###\s+/, '')) + '</div>'; }
      else if (/^##\s+/.test(t)) { closeList(); html += '<div class="md-h2">' + inline(t.replace(/^##\s+/, '')) + '</div>'; }
      else if (/^#\s+/.test(t)) { closeList(); html += '<div class="md-h1">' + inline(t.replace(/^#\s+/, '')) + '</div>'; }
      else if (/^[-*]\s+/.test(t)) { if (!inList) { html += '<ul class="md-ul">'; inList = true; } html += '<li>' + inline(t.replace(/^[-*]\s+/, '')) + '</li>'; }
      else if (!t.trim()) { closeList(); }
      else { closeList(); html += '<div class="md-p">' + inline(t) + '</div>'; }
    });
    closeList();
    return html;
  }

  function openUrl(url) {
    if (!url) return;
    if (IS_DESKTOP && window.ingrid.openExternal) window.ingrid.openExternal(url);
    else window.open(url, '_blank');
  }

  function ensurePanel() {
    if (mask) return;
    var st = document.createElement('style');
    st.textContent = STYLE;
    document.head.appendChild(st);

    mask = document.createElement('div');
    mask.className = 'ir-mask';
    mask.innerHTML =
      '<div class="ir-panel">' +
      '  <div class="ir-head">' +
      '    <div><h2>灵感目录</h2><div class="ir-sub">每日调研 DSH 插件生态，按你的用途板块筛选新功能</div></div>' +
      '    <div class="ir-actions"><button class="ir-run" type="button">立即调研</button><button class="ir-close" type="button">&times;</button></div>' +
      '  </div>' +
      '  <div class="ir-statusbar"></div>' +
      '  <div class="ir-body"></div>' +
      '</div>';
    document.body.appendChild(mask);

    bodyEl = mask.querySelector('.ir-body');
    statusEl = mask.querySelector('.ir-statusbar');
    runBtn = mask.querySelector('.ir-run');

    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    mask.querySelector('.ir-close').addEventListener('click', close);
    runBtn.addEventListener('click', runNow);

    // 面板内链接统一走系统浏览器
    bodyEl.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('.md-link') : null;
      if (a) { e.preventDefault(); openUrl(a.getAttribute('href')); }
    });

    // 生态雷达跑完主动刷新
    if (IS_DESKTOP && window.ingrid.onEcoRadarUpdated) {
      window.ingrid.onEcoRadarUpdated(function () { if (mask && mask.classList.contains('open')) load(); });
    }
  }

  function open() {
    ensurePanel();
    mask.classList.add('open');
    load();
  }
  function close() { if (mask) mask.classList.remove('open'); }
  window.__openInspiration = open;

  function load() {
    if (!IS_DESKTOP) {
      bodyEl.innerHTML = '<div class="ir-empty">灵感目录需在桌面应用中使用</div>';
      statusEl.innerHTML = '';
      return;
    }
    window.ingrid.ecoRadarStatus().then(render).catch(function (e) {
      bodyEl.innerHTML = '<div class="ir-err">加载失败：' + esc((e && e.message) || e) + '</div>';
    });
  }

  function runNow() {
    if (!IS_DESKTOP) return;
    runBtn.disabled = true;
    runBtn.textContent = '调研中…';
    window.ingrid.ecoRadarRun().then(function (r) {
      runBtn.disabled = false;
      runBtn.textContent = '立即调研';
      if (r && r.ok) { load(); }
      else { alert('调研失败：' + ((r && r.error) || '未知错误')); }
    }).catch(function (e) {
      runBtn.disabled = false;
      runBtn.textContent = '立即调研';
      alert('调研失败：' + ((e && e.message) || e));
    });
  }

  function render(d) {
    var seen = Array.isArray(d.seen) ? d.seen : [];
    var lastRun = d.lastRun || 0;
    var entries = Array.isArray(d.entries) ? d.entries : [];

    statusEl.innerHTML =
      '<span class="ir-chip">累计追踪 <b>' + seen.length + '</b> 个插件</span>' +
      '<span class="ir-chip">上次调研 <b>' + (lastRun ? fmtDateTime(lastRun) : '尚未') + '</b></span>' +
      '<span class="ir-chip">调研 <b>' + entries.length + '</b> 次</span>';

    if (!entries.length) {
      bodyEl.innerHTML = '<div class="ir-empty">还没有调研记录。点右上角「立即调研」，第一次跑完就会有简报。</div>';
      return;
    }

    var rev = entries.slice().reverse(); // 新 → 旧
    var html = '';

    var latest = rev[0];
    html += '<div class="ir-sec"><h3>最近调研 · ' + fmtDateTime(latest.at) + '</h3>' + md(latest.report) + '</div>';

    if (rev.length > 1) {
      html += '<div class="ir-sec"><h3>历史调研</h3>';
      for (var i = 1; i < rev.length; i++) {
        var e = rev[i];
        html += '<div class="ir-hist"><span class="t">' + fmtDateTime(e.at) + '</span>' +
          '<span class="n">+' + (e.newCount || 0) + ' 个新插件</span>' +
          '<span class="time">点击展开</span></div>' +
          '<div class="ir-hist-body" hidden>' + md(e.report) + '</div>';
      }
      html += '</div>';
    }

    bodyEl.innerHTML = html;

    bodyEl.querySelectorAll('.ir-hist').forEach(function (h) {
      h.addEventListener('click', function () {
        var b = h.nextElementSibling;
        if (b && b.classList.contains('ir-hist-body')) b.hidden = !b.hidden;
      });
    });
  }
})();
