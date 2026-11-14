/**
 * sessions.js — 会话回放面板（append-only 事件日志前端，零依赖）
 *
 * 吸收 DSH「可回放会话（Replayable Sessions）」设计：
 *   - 左侧：会话列表（标题 / 事件数 / 时间）
 *   - 右侧：选中会话的事件流（按 seq 升序），每条事件带类型徽标 + 时间 + 内容
 *   - 操作：分叉（复制事件流开新会话）、查看续跑上下文（折叠回对话）
 *
 * 数据来源：window.ingrid.sessionLogList() / sessionLogReplay() / sessionLogFork() / sessionLogResume()
 */
(function () {
  'use strict';
  var IS_DESKTOP = !!(window.ingrid && window.ingrid.isDesktop);

  var TYPE_META = {
    session_created: { label: '会话创建', color: '#534AB7', bg: '#EEEDFE' },
    user:            { label: '用户',     color: '#185FA5', bg: '#E6F1FB' },
    system:          { label: '注入上下文', color: '#5F5E5A', bg: '#F1EFE8' },
    agent_started:   { label: '开始执行', color: '#0F6E56', bg: '#E1F5EE' },
    tool_call:       { label: '工具调用', color: '#854F0B', bg: '#FAEEDA' },
    agent_output:    { label: '输出',     color: '#3B6D11', bg: '#EAF3DE' },
    correction:      { label: '纠偏',     color: '#A32D2D', bg: '#FCEBEB' },
    turn_end:        { label: '轮次结束', color: '#5F5E5A', bg: '#F1EFE8' },
    session_end:     { label: '会话结束', color: '#888780', bg: '#F1EFE8' },
  };

  var STYLE = [
    '.ss-mask{position:fixed;inset:0;background:rgba(20,18,35,.45);display:none;align-items:center;justify-content:center;z-index:300;}',
    '.ss-mask.open{display:flex;}',
    '.ss-panel{width:min(860px,94vw);height:min(620px,86vh);display:flex;flex-direction:column;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.25);}',
    '.ss-head{display:flex;align-items:center;justify-content:space-between;padding:16px 22px;border-bottom:1px solid #eee;}',
    '.ss-head h2{margin:0;font-size:17px;font-weight:600;color:#2c2c2a;}',
    '.ss-head .ss-sub{font-size:12px;color:#888780;font-weight:400;margin-top:2px;}',
    '.ss-head .ss-actions{display:flex;align-items:center;gap:8px;}',
    '.ss-refresh{border:1px solid #ddd;background:#fff;color:#5F5E5A;border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:inherit;}',
    '.ss-refresh:hover{border-color:#7F77DD;color:#534AB7;}',
    '.ss-close{border:none;background:transparent;font-size:24px;line-height:1;cursor:pointer;color:#888780;padding:4px 8px;}',
    '.ss-close:hover{color:#2c2c2a;}',
    '.ss-main{display:flex;flex:1;min-height:0;}',
    '.ss-list{width:280px;flex:none;border-right:1px solid #eee;overflow-y:auto;padding:10px;display:flex;flex-direction:column;gap:6px;background:#fafafa;}',
    '.ss-item{border:1px solid #eee;border-radius:10px;padding:10px 12px;cursor:pointer;background:#fff;}',
    '.ss-item:hover{border-color:#7F77DD;}',
    '.ss-item.active{border-color:#7F77DD;background:#EEEDFE;}',
    '.ss-item .t{font-size:13px;color:#2c2c2a;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.ss-item .m{font-size:11px;color:#888780;margin-top:3px;}',
    '.ss-detail{flex:1;min-width:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:10px;}',
    '.ss-dhead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding-bottom:10px;border-bottom:1px solid #eee;}',
    '.ss-dhead .t{font-size:14px;font-weight:600;color:#2c2c2a;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.ss-dhead button{border:1px solid #ddd;background:#fff;color:#5F5E5A;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;}',
    '.ss-dhead button:hover{border-color:#7F77DD;color:#534AB7;}',
    '.ss-ev{border:1px solid #eee;border-radius:10px;padding:10px 12px;}',
    '.ss-ev-top{display:flex;align-items:center;gap:8px;}',
    '.ss-badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:20px;white-space:nowrap;}',
    '.ss-ev-seq{font-size:11px;color:#b4b2a9;}',
    '.ss-ev-time{font-size:11px;color:#b4b2a9;margin-left:auto;white-space:nowrap;}',
    '.ss-ev-body{font-size:12px;color:#5F5E5A;line-height:1.6;margin-top:6px;white-space:pre-wrap;word-break:break-word;}',
    '.ss-resume{border:1px solid #CECBF6;border-radius:10px;padding:12px 14px;background:#f6f5fd;}',
    '.ss-resume h3{margin:0 0 8px;font-size:13px;font-weight:600;color:#3C3489;}',
    '.ss-resume .sys{font-size:12px;color:#5F5E5A;background:#EEEDFE;border-radius:8px;padding:8px 10px;white-space:pre-wrap;margin-bottom:8px;}',
    '.ss-resume .msg{font-size:12px;color:#2c2c2a;line-height:1.6;padding:4px 0;border-bottom:1px solid #eee;}',
    '.ss-resume .msg:last-child{border-bottom:none;}',
    '.ss-resume .role{font-weight:600;color:#534AB7;margin-right:6px;}',
    '.ss-empty{text-align:center;color:#888780;font-size:13px;padding:40px 0;}',
    '.ss-err{font-size:13px;color:#A32D2D;background:#FCEBEB;border-radius:8px;padding:12px;}',
  ].join('');

  var mask, listEl, detailEl, refreshBtn;
  var currentId = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtTime(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts);
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (e) { return ''; }
  }

  function eventContent(ev) {
    var d = ev.data || {};
    switch (ev.type) {
      case 'session_created':
        return (d.title || '') + (d.agent ? ' · ' + d.agent : '') + (d.engine ? ' · 引擎 ' + d.engine : '');
      case 'user': return d.text || d.task || '';
      case 'system': return d.text || '';
      case 'agent_started':
        return (d.task || d.text || '') + (d.engine ? ' · ' + d.engine : '') + (d.dryRun ? ' · 演练' : '');
      case 'tool_call':
        return (d.name || '工具') + (d.args ? ' ' + JSON.stringify(d.args) : '') + (d.result ? ' → ' + JSON.stringify(d.result) : '');
      case 'agent_output': return d.text || '';
      case 'correction': return d.text || '';
      case 'turn_end':
        return (d.status || '') + (d.error ? ' · 错误 ' + d.error : '') + (d.cost != null ? ' · 成本 ' + d.cost : '');
      case 'session_end': return d.reason || '';
      default: return JSON.stringify(d);
    }
  }

  function ensurePanel() {
    if (mask) return;
    var st = document.createElement('style');
    st.textContent = STYLE;
    document.head.appendChild(st);

    mask = document.createElement('div');
    mask.className = 'ss-mask';
    mask.innerHTML =
      '<div class="ss-panel">' +
      '  <div class="ss-head">' +
      '    <div><h2>会话回放</h2><div class="ss-sub">append-only 事件日志 · 可回放 / 分叉 / 续跑</div></div>' +
      '    <div class="ss-actions"><button class="ss-refresh" type="button">刷新</button><button class="ss-close" type="button">&times;</button></div>' +
      '  </div>' +
      '  <div class="ss-main">' +
      '    <div class="ss-list"></div>' +
      '    <div class="ss-detail"></div>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(mask);

    listEl = mask.querySelector('.ss-list');
    detailEl = mask.querySelector('.ss-detail');
    refreshBtn = mask.querySelector('.ss-refresh');

    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    mask.querySelector('.ss-close').addEventListener('click', close);
    refreshBtn.addEventListener('click', function () { loadList(); });
  }

  function open() {
    ensurePanel();
    mask.classList.add('open');
    loadList();
  }
  function close() { if (mask) mask.classList.remove('open'); }
  window.__openSessions = open;

  function loadList() {
    if (!IS_DESKTOP) {
      listEl.innerHTML = '<div class="ss-empty">需桌面应用</div>';
      detailEl.innerHTML = '<div class="ss-empty">会话回放需在桌面应用中使用</div>';
      return;
    }
    window.ingrid.sessionLogList().then(function (sessions) {
      renderList(sessions || []);
    }).catch(function (e) {
      listEl.innerHTML = '<div class="ss-err">加载失败：' + esc((e && e.message) || e) + '</div>';
    });
  }

  function renderList(sessions) {
    if (!sessions.length) {
      listEl.innerHTML = '<div class="ss-empty">还没有会话记录。每次 Agent 运行都会自动落盘成事件流。</div>';
      detailEl.innerHTML = '<div class="ss-empty">← 左侧选择会话查看事件流</div>';
      currentId = null;
      return;
    }
    var html = '';
    sessions.forEach(function (s) {
      html += '<div class="ss-item' + (s.id === currentId ? ' active' : '') + '" data-id="' + esc(s.id) + '">' +
        '<div class="t">' + esc(s.title || s.id) + '</div>' +
        '<div class="m">' + s.count + ' 事件 · ' + fmtTime(s.lastAt) + '</div>' +
        '</div>';
    });
    listEl.innerHTML = html;

    listEl.querySelectorAll('.ss-item').forEach(function (item) {
      item.addEventListener('click', function () {
        var id = item.getAttribute('data-id');
        listEl.querySelectorAll('.ss-item').forEach(function (x) { x.classList.remove('active'); });
        item.classList.add('active');
        openSession(id);
      });
    });

    // 若当前有选中会话且仍在列表里，保持；否则默认打开最新一条
    var stillThere = currentId && sessions.some(function (s) { return s.id === currentId; });
    if (stillThere) openSession(currentId);
    else openSession(sessions[0].id);
  }

  function openSession(id) {
    currentId = id;
    window.ingrid.sessionLogReplay(id).then(function (events) {
      renderDetail(id, events || []);
    }).catch(function (e) {
      detailEl.innerHTML = '<div class="ss-err">回放失败：' + esc((e && e.message) || e) + '</div>';
    });
  }

  function renderDetail(id, events) {
    var html = '<div class="ss-dhead">' +
      '<span class="t">' + esc(id) + '</span>' +
      '<button data-act="resume" type="button">续跑上下文</button>' +
      '<button data-act="fork" type="button">分叉</button>' +
      '</div>';

    if (!events.length) {
      html += '<div class="ss-empty">该会话暂无事件</div>';
    } else {
      events.forEach(function (ev) {
        var m = TYPE_META[ev.type] || { label: ev.type, color: '#888780', bg: '#F1EFE8' };
        var content = eventContent(ev);
        html += '<div class="ss-ev">' +
          '<div class="ss-ev-top">' +
          '<span class="ss-badge" style="color:' + m.color + ';background:' + m.bg + '">' + m.label + '</span>' +
          '<span class="ss-ev-seq">#' + ev.seq + '</span>' +
          '<span class="ss-ev-time">' + fmtTime(ev.at) + '</span>' +
          '</div>' +
          (content ? '<div class="ss-ev-body">' + esc(content) + '</div>' : '') +
          '</div>';
      });
    }
    detailEl.innerHTML = html;

    var dhead = detailEl.querySelector('.ss-dhead');
    if (dhead) {
      dhead.querySelector('button[data-act="fork"]').addEventListener('click', function () { forkSession(id); });
      dhead.querySelector('button[data-act="resume"]').addEventListener('click', function () { viewResume(id); });
    }
  }

  function forkSession(id) {
    if (!IS_DESKTOP) return;
    window.ingrid.sessionLogFork(id).then(function (newId) {
      loadList();
      setTimeout(function () { openSession(newId); }, 50);
    }).catch(function (e) { alert('分叉失败：' + ((e && e.message) || e)); });
  }

  function viewResume(id) {
    if (!IS_DESKTOP) return;
    window.ingrid.sessionLogResume(id, {}).then(function (ctx) {
      if (!ctx) return;
      var html = '<div class="ss-resume"><h3>续跑上下文（最近 ' + (ctx.eventCount || 0) + ' 条事件折叠回对话）</h3>';
      if (ctx.system) html += '<div class="sys">' + esc(ctx.system) + '</div>';
      var msgs = ctx.messages || [];
      if (!msgs.length) html += '<div class="ss-empty">无可续跑的对话内容</div>';
      else {
        msgs.forEach(function (m) {
          html += '<div class="msg"><span class="role">' + (m.role === 'assistant' ? 'Agent' : '用户') + '</span>' +
            esc(String(m.content || '').slice(0, 500)) + '</div>';
        });
      }
      html += '</div>';
      // 插入到事件流顶部（dhead 之后）
      var dhead = detailEl.querySelector('.ss-dhead');
      if (dhead && dhead.nextSibling) detailEl.insertBefore(createNode(html), dhead.nextSibling);
      else detailEl.insertAdjacentHTML('beforeend', html);
    }).catch(function (e) { alert('读取续跑上下文失败：' + ((e && e.message) || e)); });
  }

  function createNode(html) {
    var t = document.createElement('template');
    t.innerHTML = html;
    return t.content.firstChild;
  }
})();
