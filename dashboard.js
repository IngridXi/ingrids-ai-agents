/**
 * dashboard.js — 数据仪表盘面板（零依赖，local-first）
 *
 * 把「散落在各处的行为」聚合成一张图（吸收 letschips「Obsidian 接 AI」那套思想）：
 *   - 数据层：本机已有的 笔记(md frontmatter) / 聊天历史 / 任务队列 / 日历事件 / 术语库
 *   - 聚合层：主进程 buildDashboard() 汇总出计数、分布、按天热力
 *   - 可视化层：本面板渲染统计卡片 + GitHub 式热力图 + 分布条
 *
 * 判断权红线：仪表盘只「如实呈现」，不替你决定哪条重要。
 */
(function () {
  'use strict';
  var IS_DESKTOP = !!(window.ingrid && window.ingrid.isDesktop);

  var STYLE = [
    '.dh-mask{position:fixed;inset:0;background:rgba(20,18,35,.45);display:none;align-items:center;justify-content:center;z-index:300;}',
    '.dh-mask.open{display:flex;}',
    '.dh-panel{width:min(860px,94vw);max-height:88vh;display:flex;flex-direction:column;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.25);}',
    '.dh-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid #eee;}',
    '.dh-head h2{margin:0;font-size:17px;font-weight:600;color:#2c2c2a;}',
    '.dh-head .dh-sub{font-size:12px;color:#888780;font-weight:400;margin-top:2px;}',
    '.dh-head .dh-actions{display:flex;align-items:center;gap:8px;}',
    '.dh-refresh{border:1px solid #ddd;background:#fff;color:#5F5E5A;border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:inherit;}',
    '.dh-refresh:hover{border-color:#7F77DD;color:#534AB7;}',
    '.dh-close{border:none;background:transparent;font-size:24px;line-height:1;cursor:pointer;color:#888780;padding:4px 8px;}',
    '.dh-close:hover{color:#2c2c2a;}',
    '.dh-body{flex:1;overflow-y:auto;padding:18px 22px;display:flex;flex-direction:column;gap:16px;}',
    '.dh-stats{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;}',
    '.dh-card{border:1px solid #eee;border-radius:12px;padding:14px 14px;display:flex;flex-direction:column;gap:4px;}',
    '.dh-card .n{font-size:22px;font-weight:600;color:#2c2c2a;line-height:1.1;}',
    '.dh-card .l{font-size:12px;color:#5F5E5A;}',
    '.dh-card .s{font-size:11px;color:#b4b2a9;}',
    '.dh-sec{border:1px solid #eee;border-radius:12px;padding:14px 16px;}',
    '.dh-sec h3{margin:0 0 12px;font-size:13px;font-weight:600;color:#2c2c2a;}',
    '.dh-heat{display:flex;gap:3px;}',
    '.dh-heat .col{flex:1;display:flex;flex-direction:column;gap:3px;}',
    '.dh-cell{aspect-ratio:1;border-radius:3px;background:#F1EFE8;min-width:0;}',
    '.dh-legend{display:flex;align-items:center;justify-content:flex-end;gap:4px;margin-top:10px;font-size:11px;color:#b4b2a9;}',
    '.dh-legend i{width:10px;height:10px;border-radius:2px;display:inline-block;}',
    '.dh-cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;}',
    '.dh-bar{display:flex;align-items:center;gap:8px;margin-bottom:7px;}',
    '.dh-bar .k{width:120px;font-size:12px;color:#5F5E5A;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.dh-bar .track{flex:1;height:10px;background:#F1EFE8;border-radius:5px;overflow:hidden;}',
    '.dh-bar .fill{height:100%;background:#7F77DD;border-radius:5px;}',
    '.dh-bar .v{width:34px;font-size:11px;color:#888780;}',
    '.dh-agent{display:flex;align-items:center;gap:12px;padding:8px 0;border-bottom:1px solid #f4f4f2;}',
    '.dh-agent:last-child{border-bottom:none;}',
    '.dh-agent .name{flex:1;font-size:13px;color:#2c2c2a;}',
    '.dh-agent .meta{font-size:12px;color:#888780;}',
    '.dh-empty{text-align:center;color:#888780;font-size:13px;padding:40px 0;}',
    '.dh-err{font-size:13px;color:#A32D2D;background:#FCEBEB;border-radius:8px;padding:12px;}',
  ].join('');

  var mask, bodyEl;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtNum(n) {
    n = Number(n) || 0;
    return n >= 10000 ? (n / 10000).toFixed(1) + '万' : String(n);
  }
  function heatColor(n) {
    if (!n || n <= 0) return '#F1EFE8';
    if (n <= 2) return '#C0DD97';
    if (n <= 5) return '#97C459';
    if (n <= 8) return '#639922';
    return '#27500A';
  }

  function ensurePanel() {
    if (mask) return;
    var st = document.createElement('style');
    st.textContent = STYLE;
    document.head.appendChild(st);

    mask = document.createElement('div');
    mask.className = 'dh-mask';
    mask.innerHTML =
      '<div class="dh-panel">' +
      '  <div class="dh-head">' +
      '    <div><h2>数据仪表盘</h2><div class="dh-sub">把笔记、聊天、任务、日历、术语聚合成一张图</div></div>' +
      '    <div class="dh-actions"><button class="dh-refresh" type="button">刷新</button><button class="dh-close" type="button">&times;</button></div>' +
      '  </div>' +
      '  <div class="dh-body"></div>' +
      '</div>';
    document.body.appendChild(mask);

    bodyEl = mask.querySelector('.dh-body');
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    mask.querySelector('.dh-close').addEventListener('click', close);
    mask.querySelector('.dh-refresh').addEventListener('click', load);
  }

  function open() {
    ensurePanel();
    mask.classList.add('open');
    load();
  }
  function close() { if (mask) mask.classList.remove('open'); }
  window.__openDashboard = open;

  function load() {
    if (!IS_DESKTOP) {
      bodyEl.innerHTML = '<div class="dh-empty">仪表盘需在桌面应用中使用</div>';
      return;
    }
    bodyEl.innerHTML = '<div class="dh-empty">正在聚合本地数据…</div>';
    window.ingrid.dashboardGet().then(render).catch(function (e) {
      bodyEl.innerHTML = '<div class="dh-err">加载失败：' + esc((e && e.message) || e) + '</div>';
    });
  }

  function render(d) {
    if (!d || d.ok === false) {
      bodyEl.innerHTML = '<div class="dh-err">' + esc((d && d.error) || '数据异常') + '</div>';
      return;
    }
    var notes = d.notes || {};
    var chat = d.chat || {};
    var tasks = d.tasks || {};
    var counts = tasks.counts || {};
    var cal = d.calendar || {};
    var terms = d.terms || {};

    var fmPct = notes.total ? Math.round(notes.withFm / notes.total * 100) : 0;

    var html = '';

    // 1) 统计卡片
    html += '<div class="dh-stats">';
    html += card(notes.total, '笔记', 'frontmatter ' + fmPct + '% · ' + fmtNum(notes.totalChars) + ' 字');
    html += card(chat.totalSessions, '会话', '消息 ' + fmtNum(chat.totalMessages));
    html += card(counts.done || 0, '任务完成', '运行 ' + (counts.running || 0) + ' · 定时 ' + (tasks.scheduled || 0));
    html += card(cal.total, '日历事件', '未来 7 天 ' + (cal.upcoming7 || 0));
    html += card(terms.total, '术语', '本地术语库');
    html += '</div>';

    // 2) 热力图（近 12 周）
    html += '<div class="dh-sec"><h3>近 12 周活跃（笔记·聊天·任务·日历按天叠加）</h3>';
    var heat = (d.heatmap || []);
    if (heat.length) {
      html += '<div class="dh-heat">';
      var cols = 12, per = 7;
      for (var c = 0; c < cols; c++) {
        html += '<div class="col">';
        for (var r = 0; r < per; r++) {
          var idx = c * per + r;
          var cell = heat[idx];
          if (!cell) { html += '<div class="dh-cell"></div>'; continue; }
          var title = cell.date + ' · ' + (cell.count || 0) + ' 次';
          html += '<div class="dh-cell" title="' + title + '" style="background:' + heatColor(cell.count) + '"></div>';
        }
        html += '</div>';
      }
      html += '</div>';
      html += '<div class="dh-legend"><span>少</span><i style="background:#F1EFE8"></i><i style="background:#C0DD97"></i><i style="background:#97C459"></i><i style="background:#639922"></i><i style="background:#27500A"></i><span>多</span></div>';
    } else {
      html += '<div class="dh-empty">暂无活跃数据</div>';
    }
    html += '</div>';

    // 3) 分布（笔记目录 / 日历分类）
    html += '<div class="dh-cols">';
    html += '<div class="dh-sec"><h3>笔记目录分布</h3>' + bars(notes.dirs || {}) + '</div>';
    html += '<div class="dh-sec"><h3>日历分类</h3>' + bars(cal.categories || {}) + '</div>';
    html += '</div>';

    // 4) Agent 会话
    var agents = chat.agents || [];
    if (agents.length) {
      html += '<div class="dh-sec"><h3>Agent 会话</h3>';
      agents.forEach(function (a) {
        html += '<div class="dh-agent"><span class="name">' + esc(a.name) + '</span>' +
          '<span class="meta">' + fmtNum(a.sessions) + ' 会话 · ' + fmtNum(a.messages) + ' 消息 · ' + fmtNum(a.chars) + ' 字</span></div>';
      });
      html += '</div>';
    }

    bodyEl.innerHTML = html;
  }

  function card(n, label, sub) {
    return '<div class="dh-card"><div class="n">' + fmtNum(n) + '</div>' +
      '<div class="l">' + esc(label) + '</div><div class="s">' + esc(sub) + '</div></div>';
  }

  function bars(obj) {
    var entries = Object.keys(obj || {}).map(function (k) { return { k: k, v: obj[k] }; })
      .sort(function (a, b) { return b.v - a.v; }).slice(0, 6);
    if (!entries.length) return '<div class="dh-empty">暂无数据</div>';
    var max = entries[0].v || 1;
    var html = '';
    entries.forEach(function (e) {
      var pct = Math.round(e.v / max * 100);
      html += '<div class="dh-bar"><span class="k" title="' + esc(e.k) + '">' + esc(e.k) + '</span>' +
        '<span class="track"><span class="fill" style="width:' + pct + '%"></span></span>' +
        '<span class="v">' + fmtNum(e.v) + '</span></div>';
    });
    return html;
  }
})();
