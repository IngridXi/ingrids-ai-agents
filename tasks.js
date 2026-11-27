/**
 * tasks.js — 任务中心面板（后台任务队列前端，零依赖）
 *
 * 吸收 dsh「丢任务后台跑、只在需要时打扰人」的交互：
 *   - 新建任务 → 丢进后台队列，主进程 runBackgroundTask 独立会话自主跑完
 *   - 状态：排队中 / 运行中 / 需决策 / 已完成 / 失败 / 已取消
 *   - 完成 / 需决策 / 失败 时才值得用户看，其余安静排队
 *   - 监听 task:changed 实时刷新；「任务中心」入口红点提示「需决策」
 *
 * v11 升级：顶部 tab 化 —— 把四类待办（需决策任务 / 经验提案 / CityVerse 规划 / 研究待办）
 * 从「混在一个待你处理区块」拆成各自带数字徽标的 tab，点进去只看那一类、再分别去处理。
 * 默认停在「待办」总览（4 个分类入口卡片），后台任务（含新建表单）单独一个 tab。
 */
(function () {
  'use strict';
  var IS_DESKTOP = !!(window.ingrid && window.ingrid.isDesktop);

  var STATUS_META = {
    queued:    { label: '排队中', color: '#888780', bg: '#F1EFE8' },
    running:   { label: '运行中', color: '#185FA5', bg: '#E6F1FB' },
    waiting:   { label: '需决策', color: '#854F0B', bg: '#FAEEDA' },
    done:      { label: '已完成', color: '#3B6D11', bg: '#EAF3DE' },
    failed:    { label: '失败',   color: '#A32D2D', bg: '#FCEBEB' },
    cancelled: { label: '已取消', color: '#5F5E5A', bg: '#F1EFE8' },
  };

  // 待办 tab 定义（顺序即展示顺序；「待办」= 总览入口，其余是单类）
  var TABS = [
    { key: 'all',         label: '待办' },
    { key: 'waiting',     label: '需决策' },
    { key: 'experience',  label: '经验提案' },
    { key: 'cityverse',   label: 'CityVerse' },
    { key: 'research',    label: '研究待办' },
    { key: 'tasks',       label: '后台任务' },
  ];

  var STYLE = [
    '.tk-mask{position:fixed;inset:0;background:rgba(20,18,35,.45);display:none;align-items:center;justify-content:center;z-index:300;}',
    '.tk-mask.open{display:flex;}',
    '.tk-panel{width:min(760px,92vw);max-height:86vh;display:flex;flex-direction:column;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.25);}',
    '.tk-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px 12px;border-bottom:1px solid #eee;}',
    '.tk-head h2{margin:0;font-size:17px;font-weight:600;color:#2c2c2a;}',
    '.tk-head .tk-sub{font-size:12px;color:#888780;font-weight:400;}',
    '.tk-close{border:none;background:transparent;font-size:24px;line-height:1;cursor:pointer;color:#888780;padding:4px 8px;}',
    '.tk-close:hover{color:#2c2c2a;}',
    // 顶部 tab 栏
    '.tk-tabs{display:flex;gap:6px;padding:12px 22px 12px;border-bottom:1px solid #eee;flex-wrap:wrap;}',
    '.tk-tab{position:relative;border:1px solid #e5e3dc;background:#fff;color:#5F5E5A;border-radius:10px;padding:7px 13px;font-size:13px;cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;gap:6px;}',
    '.tk-tab:hover{border-color:#7F77DD;color:#534AB7;}',
    '.tk-tab.active{background:#EEEDFE;border-color:#7F77DD;color:#3C3489;font-weight:600;}',
    '.tk-tbadge{background:#A32D2D;color:#fff;font-size:11px;font-weight:700;min-width:18px;height:18px;border-radius:9px;display:inline-flex;align-items:center;justify-content:center;padding:0 5px;}',
    '.tk-tbadge.zero{background:#EFEEE9;color:#a9a79d;font-weight:500;}',
    // 新建任务表单（仅「后台任务」tab 显示）
    '.tk-form{display:flex;gap:10px;padding:16px 22px;border-bottom:1px solid #eee;flex-wrap:wrap;}',
    '.tk-form input,.tk-form select{flex:1;min-width:140px;padding:10px 12px;border:1px solid #ddd;border-radius:10px;font-size:13px;font-family:inherit;}',
    '.tk-form input:focus,.tk-form select:focus{outline:none;border-color:#7F77DD;}',
    '.tk-form .tk-goal{flex:2 1 260px;}',
    '.tk-go-btn{padding:10px 20px;border:none;border-radius:10px;background:#7F77DD;color:#fff;font-size:13px;font-weight:600;cursor:pointer;white-space:nowrap;}',
    '.tk-go-btn:hover{background:#534AB7;}',
    '.tk-go-btn:disabled{opacity:.5;cursor:not-allowed;}',
    '.tk-body{flex:1;overflow-y:auto;padding:16px 22px;display:flex;flex-direction:column;gap:12px;}',
    '.tk-empty{text-align:center;color:#888780;font-size:13px;padding:40px 0;}',
    '.tk-countbar{font-size:12px;color:#888780;padding:0 2px;}',
    '.tk-item{border:1px solid #eee;border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:8px;}',
    '.tk-item .tk-top{display:flex;align-items:center;gap:10px;}',
    '.tk-item .tk-title{flex:1;font-size:14px;font-weight:600;color:#2c2c2a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.tk-badge{font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;white-space:nowrap;}',
    '.tk-item .tk-goal{font-size:12px;color:#5F5E5A;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
    '.tk-item .tk-result{font-size:12px;color:#3C3489;background:#EEEDFE;border-radius:8px;padding:10px 12px;line-height:1.6;max-height:180px;overflow-y:auto;white-space:pre-wrap;word-break:break-word;}',
    '.tk-item .tk-err{font-size:12px;color:#A32D2D;background:#FCEBEB;border-radius:8px;padding:8px 12px;}',
    '.tk-item .tk-question{font-size:13px;color:#854F0B;background:#FAEEDA;border-radius:8px;padding:10px 12px;}',
    '.tk-item .tk-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;}',
    '.tk-item .tk-time{font-size:11px;color:#b4b2a9;}',
    '.tk-item .tk-actions{display:flex;gap:6px;}',
    '.tk-item button{border:1px solid #ddd;background:#fff;color:#5F5E5A;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;}',
    '.tk-item button:hover{border-color:#7F77DD;color:#534AB7;}',
    '.tk-item button.tk-danger:hover{border-color:#A32D2D;color:#A32D2D;}',
    '.tk-footbar{display:flex;justify-content:space-between;align-items:center;padding:12px 22px;border-top:1px solid #eee;}',
    '.tk-footbar button{border:1px solid #ddd;background:#fff;color:#5F5E5A;border-radius:8px;padding:7px 14px;font-size:12px;cursor:pointer;font-family:inherit;}',
    '.tk-footbar button:hover{border-color:#A32D2D;color:#A32D2D;}',
    '.tk-footbar .tk-note{font-size:11px;color:#b4b2a9;}',
    // 待办总览入口卡片
    '.tk-overview{display:flex;flex-direction:column;gap:10px;}',
    '.tk-ov-card{display:flex;align-items:center;gap:12px;border:1px solid #eee;border-radius:12px;padding:14px 16px;cursor:pointer;background:#fff;}',
    '.tk-ov-card:hover{border-color:#7F77DD;background:#FBFBFF;}',
    '.tk-ov-card .tk-ov-ico{font-size:20px;line-height:1;}',
    '.tk-ov-card .tk-ov-main{flex:1;}',
    '.tk-ov-card .tk-ov-title{font-size:14px;font-weight:600;color:#2c2c2a;}',
    '.tk-ov-card .tk-ov-desc{font-size:12px;color:#888780;margin-top:2px;}',
    '.tk-ov-card .tk-ov-num{font-size:22px;font-weight:700;color:#A32D2D;}',
    '.tk-ov-card .tk-ov-num.zero{color:#c9c7bf;}',
    '.tk-ov-card .tk-ov-arrow{color:#b4b2a9;font-size:14px;}',
    // 单类待办列表
    '.tk-ap-section{border:1px solid #f0c9a0;background:#fdf6ee;border-radius:12px;padding:12px 14px;margin-bottom:4px;}',
    '.tk-ap-head{font-size:13px;font-weight:700;color:#854F0B;margin-bottom:8px;}',
    '.tk-ap-group{margin-bottom:10px;}',
    '.tk-ap-group:last-child{margin-bottom:0;}',
    '.tk-ap-gtitle{font-size:11px;font-weight:600;color:#b45309;margin-bottom:6px;}',
    '.tk-ap-item{display:flex;flex-direction:column;gap:6px;background:#fff;border:1px solid #f0e4d5;border-radius:10px;padding:10px 12px;margin-bottom:6px;}',
    '.tk-ap-item:last-child{margin-bottom:0;}',
    '.tk-ap-title{font-size:13px;color:#2c2c2a;font-weight:600;line-height:1.4;}',
    '.tk-ap-item button{align-self:flex-start;border:1px solid #7F77DD;background:#fff;color:#534AB7;border-radius:8px;padding:5px 12px;font-size:12px;cursor:pointer;font-family:inherit;}',
    '.tk-ap-item button:hover{background:#EEEDFE;}',
  ].join('');

  var mask, panel, bodyEl, formEl, tabsEl, titleEl, goalEl, engineEl, scheduleEl, goBtn, clearBtn, noteEl;

  // 面板状态：当前 tab + 最近一次拉取的数据
  var state = { tab: 'all', approvals: { total: 0, waiting: [], experience: [], research: [], cityverse: [] }, tickets: [], counts: {} };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fmtTime(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso);
      var p = function (n) { return (n < 10 ? '0' : '') + n; };
      return d.getMonth() + 1 + '/' + d.getDate() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (e) { return ''; }
  }

  function ensurePanel() {
    if (mask) return;
    var st = document.createElement('style');
    st.textContent = STYLE;
    document.head.appendChild(st);

    mask = document.createElement('div');
    mask.className = 'tk-mask';
    mask.innerHTML =
      '<div class="tk-panel">' +
      '  <div class="tk-head">' +
      '    <h2>任务中心 <span class="tk-sub">丢任务后台跑，完成或需决策才打扰你</span></h2>' +
      '    <button class="tk-close" type="button">&times;</button>' +
      '  </div>' +
      '  <div class="tk-tabs"></div>' +
      '  <div class="tk-form">' +
      '    <input class="tk-title" placeholder="标题（可选）">' +
      '    <input class="tk-goal" placeholder="任务目标，例如：读取 Desktop/PhD 文件并生成对比报告">' +
      '    <select class="tk-engine">' +
      '      <option value="auto" selected>自动分拣</option>' +
      '      <option value="deepseek">DeepSeek</option>' +
      '      <option value="gpt">GPT</option>' +
      '      <option value="qwen">Qwen</option>' +
      '    </select>' +
      '    <input class="tk-schedule" placeholder="定时(可选) 如「每天9点」或「明天下午3点」">' +
      '    <button class="tk-go-btn" type="button">丢到后台运行</button>' +
      '  </div>' +
      '  <div class="tk-body"></div>' +
      '  <div class="tk-footbar">' +
      '    <span class="tk-note"></span>' +
      '    <button type="button">清除已完成/失败</button>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(mask);

    panel = mask.querySelector('.tk-panel');
    bodyEl = mask.querySelector('.tk-body');
    formEl = mask.querySelector('.tk-form');
    tabsEl = mask.querySelector('.tk-tabs');
    titleEl = mask.querySelector('.tk-title');
    goalEl = mask.querySelector('.tk-goal');
    engineEl = mask.querySelector('.tk-engine');
    scheduleEl = mask.querySelector('.tk-schedule');
    goBtn = mask.querySelector('.tk-go-btn');
    clearBtn = mask.querySelector('.tk-footbar button');
    noteEl = mask.querySelector('.tk-note');

    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    mask.querySelector('.tk-close').addEventListener('click', close);
    goBtn.addEventListener('click', createTask);
    goalEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') createTask(); });
    clearBtn.addEventListener('click', clearDone);

    // tab 切换（事件委托）
    tabsEl.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('.tk-tab') : null;
      if (!t) return;
      state.tab = t.getAttribute('data-tab') || 'all';
      renderAll();
    });

    // 任务变化实时刷新
    if (IS_DESKTOP && window.ingrid.onTaskChanged) {
      window.ingrid.onTaskChanged(function () { load(); });
    }
  }

  function open() {
    ensurePanel();
    mask.classList.add('open');
    load();
  }
  function close() { if (mask) mask.classList.remove('open'); }
  window.__openTasks = open;

  function load() {
    if (!IS_DESKTOP) {
      bodyEl.innerHTML = '<div class="tk-empty">任务中心需在桌面应用中使用</div>';
      return;
    }
    var approvalsPromise = window.ingrid.approvalsSummary
      ? window.ingrid.approvalsSummary()
      : Promise.resolve({ total: 0, waiting: [], experience: [], research: [], cityverse: [] });
    Promise.all([window.ingrid.taskList(), approvalsPromise]).then(function (vals) {
      var d = vals[0] || {};
      state.tickets = d.tickets || [];
      state.counts = d.counts || {};
      state.approvals = vals[1] || { total: 0, waiting: [], experience: [], research: [], cityverse: [] };
      renderAll();
    }).catch(function (e) {
      bodyEl.innerHTML = '<div class="tk-empty">加载失败：' + esc((e && e.message) || e) + '</div>';
    });
  }

  function tabCount(key) {
    switch (key) {
      case 'all':        return state.approvals.total || 0;
      case 'waiting':    return state.approvals.waiting.length;
      case 'experience': return state.approvals.experience.length;
      case 'cityverse':  return state.approvals.cityverse.length;
      case 'research':   return state.approvals.research.length;
      case 'tasks':      return state.tickets.length;
      default: return 0;
    }
  }

  function renderAll() {
    renderTabs();
    renderBody();
    updateDot(state.approvals.total);
  }

  function renderTabs() {
    var html = '';
    TABS.forEach(function (t) {
      var n = tabCount(t.key);
      var badge = n > 0
        ? '<span class="tk-tbadge">' + (n > 99 ? '99+' : n) + '</span>'
        : '<span class="tk-tbadge zero">0</span>';
      html += '<button class="tk-tab' + (state.tab === t.key ? ' active' : '') + '" data-tab="' + t.key + '" type="button">' +
        t.label + badge + '</button>';
    });
    tabsEl.innerHTML = html;
  }

  function renderBody() {
    // 新建任务表单只属于「后台任务」tab
    formEl.style.display = (state.tab === 'tasks') ? 'flex' : 'none';
    if (state.tab === 'tasks') {
      bodyEl.innerHTML = renderTasks();
      bindTaskButtons();
      noteEl.textContent = state.tickets.length + ' 个任务';
      clearBtn.style.display = '';
      return;
    }
    clearBtn.style.display = 'none';
    bodyEl.innerHTML = renderTabContent(state.tab);
    bindDelegateButtons();
    noteEl.textContent = tabCount(state.tab) + ' 项待办';
  }

  // 「待办」总览：4 个分类入口卡片，点卡片进对应 tab
  function renderOverview() {
    var cards = [
      { key: 'waiting',    ico: '🧭', title: '需决策任务', desc: '后台任务卡在需要你拍板的问题上' },
      { key: 'experience', ico: '💡', title: '经验提案',   desc: '知识沉淀官复盘出的经验，等你批准入库' },
      { key: 'cityverse',  ico: '🏙️', title: 'CityVerse 规划', desc: '虚实城建设规划待你审批' },
      { key: 'research',   ico: '📚', title: '研究待办',   desc: '研究助手清单里尚未完成的事项' },
    ];
    var html = '<div class="tk-overview">';
    cards.forEach(function (c) {
      var n = tabCount(c.key);
      var numCls = n > 0 ? '' : ' zero';
      var num = n > 0 ? n : 0;
      html += '<div class="tk-ov-card" data-goto="' + c.key + '">' +
        '<span class="tk-ov-ico">' + c.ico + '</span>' +
        '<span class="tk-ov-main"><span class="tk-ov-title">' + esc(c.title) + '</span>' +
        '<span class="tk-ov-desc">' + esc(c.desc) + '</span></span>' +
        '<span class="tk-ov-num' + numCls + '">' + num + '</span>' +
        '<span class="tk-ov-arrow">›</span>' +
        '</div>';
    });
    html += '</div>';
    return html;
  }

  function renderTabContent(key) {
    if (key === 'all') return renderOverview();

    var list = [];
    if (key === 'waiting')    list = state.approvals.waiting;
    if (key === 'experience') list = state.approvals.experience;
    if (key === 'cityverse')  list = state.approvals.cityverse;
    if (key === 'research')   list = state.approvals.research;

    if (!list.length) return '<div class="tk-empty">没有待处理的「' + esc(tabLabel(key)) + '」</div>';

    var html = '<div class="tk-ap-section"><div class="tk-ap-head">' + esc(tabLabel(key)) + ' · ' + list.length + '</div>';
    list.forEach(function (x) {
      var btn = '';
      if (key === 'experience') btn = '<button data-ap="experience" type="button">去总控审批</button>';
      else if (key === 'cityverse') btn = '<button data-ap="cityverse" type="button">去审批</button>';
      else if (key === 'research') btn = '<button data-ap="research" type="button">打开研究助手处理</button>';
      else if (key === 'waiting') btn = '<button data-goto="tasks" type="button">去后台任务查看</button>';

      html += '<div class="tk-ap-item"><div class="tk-ap-title">' + esc(x.title) + '</div>';
      if (x.question) html += '<div class="tk-question">' + esc(x.question) + '</div>';
      html += btn + '</div>';
    });
    html += '</div>';
    return html;
  }

  function tabLabel(key) {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].key === key) return TABS[i].label;
    return key;
  }

  // 后台任务列表（原 tickets 渲染逻辑，含状态徽标与操作按钮）
  function renderTasks() {
    var counts = state.counts || {};
    var html = '';
    if (!state.tickets.length) {
      return '<div class="tk-empty">还没有后台任务。在上面输入目标，点「丢到后台运行」。</div>';
    }
    html += '<div class="tk-countbar">排队 ' + (counts.queued || 0) +
      ' · 运行 ' + (counts.running || 0) +
      ' · 需决策 ' + (counts.waiting || 0) +
      ' · 完成 ' + (counts.done || 0) +
      ' · 失败 ' + (counts.failed || 0) + '</div>';
    state.tickets.slice().reverse().forEach(function (t) {
      var m = STATUS_META[t.status] || STATUS_META.queued;
      var badge;
      if (t.schedule) {
        var isDaily = String(t.schedule).indexOf(' ') < 0;
        badge = '<span class="tk-badge" style="color:#534AB7;background:#EEEDFE">' +
          (isDaily ? '每天 ' : '定时 ') + esc(t.schedule) + '</span>';
      } else {
        badge = '<span class="tk-badge" style="color:' + m.color + ';background:' + m.bg + '">' + m.label + '</span>';
      }
      html += '<div class="tk-item">' +
        '<div class="tk-top"><span class="tk-title">' + esc(t.title || '未命名任务') + '</span>' +
        (t.category ? '<span class="tk-badge" style="color:#0F6E56;background:#E1F5EE">' + esc(t.category) + '</span>' : '') +
        badge + '</div>';
      if (t.goal) html += '<div class="tk-goal">' + esc(t.goal) + '</div>';
      if (t.status === 'waiting' && t.question) html += '<div class="tk-question">' + esc(t.question) + '</div>';
      if (t.status === 'done' && t.result) html += '<div class="tk-result">' + esc(t.result) + '</div>';
      if (t.status === 'failed' && t.error) html += '<div class="tk-err">' + esc(t.error) + '</div>';
      html += '<div class="tk-foot"><span class="tk-time">' + fmtTime(t.createdAt) + ' · ' + esc(t.engine || 'deepseek') + '</span>' +
        '<span class="tk-actions">';
      if (t.status === 'queued') html += '<button data-act="run" data-id="' + t.id + '">运行</button>';
      if (t.status === 'failed') html += '<button data-act="retry" data-id="' + t.id + '">重试</button>';
      if (t.status === 'running' || t.status === 'queued') html += '<button data-act="stop" data-id="' + t.id + '">停止</button>';
      html += '<button class="tk-danger" data-act="remove" data-id="' + t.id + '">删除</button>';
      html += '</span></div></div>';
    });
    return html;
  }

  function bindTaskButtons() {
    bodyEl.querySelectorAll('button[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.getAttribute('data-act');
        var id = b.getAttribute('data-id');
        if (act === 'run') { window.ingrid.taskRun(id).then(load); }
        else if (act === 'retry') { window.ingrid.taskRetry(id).then(load); }
        else if (act === 'stop') { window.ingrid.taskStop(id).then(load); }
        else if (act === 'remove') { window.ingrid.taskRemove(id).then(load); }
      });
    });
  }

  // 待办 tab 里的按钮：data-ap=去对应 agent 处理；data-goto=切到某 tab
  function bindDelegateButtons() {
    // 待审批「去审批」跳转：先关掉任务中心面板，再用带返回条的入口打开总控台。
    bodyEl.querySelectorAll('button[data-ap]').forEach(function (b) {
      b.addEventListener('click', function () {
        var ap = b.getAttribute('data-ap');
        if (ap === 'experience') {
          close();
          if (typeof window.openAgentInView === 'function') {
            window.openAgentInView({ name: '后台总控 · 经验提案', href: 'agents/agent-console/index.html#experience' });
          } else if (window.ingrid && window.ingrid.openAgent) {
            window.ingrid.openAgent('agents/agent-console/index.html#experience');
          }
        } else if (ap === 'cityverse') {
          close();
          if (typeof window.openAgentInView === 'function') {
            window.openAgentInView({ name: '后台总控 · CityVerse 审批', href: 'agents/agent-console/index.html#cityverse' });
          } else if (window.ingrid && window.ingrid.openAgent) {
            window.ingrid.openAgent('agents/agent-console/index.html#cityverse');
          }
        } else if (ap === 'research') {
          close();
          if (typeof window.openAgentInView === 'function') {
            window.openAgentInView({ name: '研究助手', href: 'agents/research-chat/index.html' });
          } else if (window.ingrid && window.ingrid.openAgent) {
            window.ingrid.openAgent('agents/research-chat/index.html');
          }
        }
      });
    });
    // 总览卡片 / 「去后台任务查看」→ 切 tab
    bodyEl.querySelectorAll('[data-goto]').forEach(function (el) {
      el.addEventListener('click', function () {
        state.tab = el.getAttribute('data-goto') || 'all';
        renderAll();
      });
    });
  }

  function updateDot(n) {
    var dot = document.getElementById('taskDot');
    if (!dot) return;
    dot.textContent = n > 99 ? '99+' : String(n || 0);
    dot.hidden = !(n > 0);
  }

  function createTask() {
    var goal = goalEl.value.trim();
    if (!goal) { goalEl.focus(); return; }
    if (!IS_DESKTOP) return;
    var sched = scheduleEl.value.trim();
    var engineSel = engineEl.value || 'auto';
    goBtn.disabled = true;

    var resolveClassify = function () {
      if (engineSel !== 'auto') return Promise.resolve({ engine: engineSel, category: '' });
      return window.ingrid.taskClassify(goal).then(function (r) {
        r = r || {};
        return {
          engine: r.engine || 'deepseek',
          category: r.label || '',
          noBackground: !!r.noBackground,
          note: r.note || '',
          downgradedFrom: r.downgradedFrom || '',
        };
      }).catch(function () { return { engine: 'deepseek', category: '' }; });
    };
    var resolveSchedule = function () {
      if (!sched) return Promise.resolve(null);
      return window.ingrid.scheduleParse(sched).then(function (r) {
        if (!r || r.ok === false) throw new Error('定时没看懂：' + ((r && r.error) || '') + '。试试「每天9点」「明天下午3点」「下周一上午10点」，或留空表示只跑一次');
        return r.schedule;
      });
    };

    Promise.all([resolveClassify(), resolveSchedule()]).then(function (vals) {
      var cls = vals[0], schedule = vals[1];
      if (cls.noBackground) {
        goBtn.disabled = false;
        alert('这类活后台队列干不了。' + (cls.note ? '\n\n' + cls.note : '') + '\n\n请到对应的 agent 里做。');
        return;
      }
      var t = {
        title: titleEl.value.trim() || goal.slice(0, 20),
        goal: goal,
        engine: cls.engine,
        category: cls.category + (cls.downgradedFrom ? '（原建议 ' + cls.downgradedFrom + '，已降级）' : ''),
        schedule: schedule || null,
      };
      window.ingrid.taskCreate(t).then(function (ticket) {
        titleEl.value = '';
        goalEl.value = '';
        scheduleEl.value = '';
        engineEl.value = 'auto';
        goBtn.disabled = false;
        if (!schedule) window.ingrid.taskRun(ticket.id).then(load);
        else load();
      }).catch(function (e) {
        goBtn.disabled = false;
        alert('创建失败：' + ((e && e.message) || e));
      });
    }).catch(function (e) {
      goBtn.disabled = false;
      alert(String((e && e.message) || e));
      scheduleEl.focus();
    });
  }

  function clearDone() {
    if (!IS_DESKTOP) return;
    window.ingrid.taskClear().then(load);
  }

  // 页面加载即初始化首页「任务中心」红色数字徽章：监听待办广播 + 首次拉取（不依赖打开面板）
  if (IS_DESKTOP && window.ingrid.onApprovalsChanged) {
    window.ingrid.onApprovalsChanged(function (s) {
      state.approvals = s || { total: 0, waiting: [], experience: [], research: [], cityverse: [] };
      updateDot(state.approvals.total);
      if (mask && mask.classList.contains('open')) load();
    });
  }
  if (IS_DESKTOP && window.ingrid.approvalsSummary) {
    window.ingrid.approvalsSummary().then(function (s) { updateDot((s && s.total) || 0); }).catch(function () {});
  }
})();
