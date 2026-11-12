/**
 * tasks.js — 任务中心面板（后台任务队列前端，零依赖）
 *
 * 吸收 dsh「丢任务后台跑、只在需要时打扰人」的交互：
 *   - 新建任务 → 丢进后台队列，主进程 runBackgroundTask 独立会话自主跑完
 *   - 状态：排队中 / 运行中 / 需决策 / 已完成 / 失败 / 已取消
 *   - 完成 / 需决策 / 失败 时才值得用户看，其余安静排队
 *   - 监听 task:changed 实时刷新；「任务中心」入口红点提示「需决策」
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

  var STYLE = [
    '.tk-mask{position:fixed;inset:0;background:rgba(20,18,35,.45);display:none;align-items:center;justify-content:center;z-index:300;}',
    '.tk-mask.open{display:flex;}',
    '.tk-panel{width:min(720px,92vw);max-height:86vh;display:flex;flex-direction:column;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.25);}',
    '.tk-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid #eee;}',
    '.tk-head h2{margin:0;font-size:17px;font-weight:600;color:#2c2c2a;}',
    '.tk-head .tk-sub{font-size:12px;color:#888780;font-weight:400;}',
    '.tk-close{border:none;background:transparent;font-size:24px;line-height:1;cursor:pointer;color:#888780;padding:4px 8px;}',
    '.tk-close:hover{color:#2c2c2a;}',
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
  ].join('');

  var mask, panel, bodyEl, form, titleEl, goalEl, engineEl, scheduleEl, goBtn, clearBtn, noteEl;

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
      '  <div class="tk-form">' +
      '    <input class="tk-title" placeholder="标题（可选）">' +
      '    <input class="tk-goal" placeholder="任务目标，例如：读取 Desktop/PhD 文件并生成对比报告">' +
      '    <select class="tk-engine">' +
      '      <option value="deepseek">DeepSeek</option>' +
      '      <option value="gpt">GPT</option>' +
      '      <option value="qwen">Qwen</option>' +
      '    </select>' +
      '    <input class="tk-schedule" placeholder="定时(可选) 如 09:00 每天跑">' +
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
    window.ingrid.taskList().then(function (d) { render(d); }).catch(function (e) {
      bodyEl.innerHTML = '<div class="tk-empty">加载失败：' + esc((e && e.message) || e) + '</div>';
    });
  }

  function render(d) {
    var tickets = (d && d.tickets) || [];
    var counts = (d && d.counts) || {};
    if (!tickets.length) {
      bodyEl.innerHTML = '<div class="tk-empty">还没有后台任务。在上面输入目标，点「丢到后台运行」。</div>';
      noteEl.textContent = '0 个任务';
      updateDot(0);
      return;
    }
    var html = '<div class="tk-countbar">排队 ' + (counts.queued || 0) +
      ' · 运行 ' + (counts.running || 0) +
      ' · 需决策 ' + (counts.waiting || 0) +
      ' · 完成 ' + (counts.done || 0) +
      ' · 失败 ' + (counts.failed || 0) + '</div>';
    // 新任务在上，按创建时间倒序
    tickets.slice().reverse().forEach(function (t) {
      var m = STATUS_META[t.status] || STATUS_META.queued;
      var badge = t.schedule
        ? '<span class="tk-badge" style="color:#534AB7;background:#EEEDFE">定时 ' + esc(t.schedule) + ' 每天</span>'
        : '<span class="tk-badge" style="color:' + m.color + ';background:' + m.bg + '">' + m.label + '</span>';
      html += '<div class="tk-item">' +
        '<div class="tk-top"><span class="tk-title">' + esc(t.title || '未命名任务') + '</span>' + badge + '</div>';
      if (t.goal) html += '<div class="tk-goal">' + esc(t.goal) + '</div>';
      if (t.status === 'waiting' && t.question) html += '<div class="tk-question">' + esc(t.question) + '</div>';
      if (t.status === 'done' && t.result) html += '<div class="tk-result">' + esc(t.result) + '</div>';
      if (t.status === 'failed' && t.error) html += '<div class="tk-err">' + esc(t.error) + '</div>';
      html += '<div class="tk-foot"><span class="tk-time">' + fmtTime(t.createdAt) + ' · ' + esc(t.engine || 'deepseek') + '</span>' +
        '<span class="tk-actions">';
      if (t.status === 'queued') html += '<button data-act="run" data-id="' + t.id + '">运行</button>';
      if (t.status === 'running' || t.status === 'queued') html += '<button data-act="stop" data-id="' + t.id + '">停止</button>';
      html += '<button class="tk-danger" data-act="remove" data-id="' + t.id + '">删除</button>';
      html += '</span></div></div>';
    });
    bodyEl.innerHTML = html;
    noteEl.textContent = tickets.length + ' 个任务';
    updateDot((counts.waiting || 0) + (counts.running || 0));

    bodyEl.querySelectorAll('button[data-act]').forEach(function (b) {
      b.addEventListener('click', function () {
        var act = b.getAttribute('data-act');
        var id = b.getAttribute('data-id');
        if (act === 'run') { window.ingrid.taskRun(id).then(load); }
        else if (act === 'stop') { window.ingrid.taskStop(id).then(load); }
        else if (act === 'remove') { window.ingrid.taskRemove(id).then(load); }
      });
    });
  }

  function updateDot(n) {
    var dot = document.getElementById('taskDot');
    if (dot) dot.hidden = !(n > 0);
  }

  function createTask() {
    var goal = goalEl.value.trim();
    if (!goal) { goalEl.focus(); return; }
    if (!IS_DESKTOP) return;
    var sched = scheduleEl.value.trim();
    if (sched && !/^([01]\d|2[0-3]):[0-5]\d$/.test(sched)) {
      alert('定时格式应为 HH:MM（24 小时制），例如 09:00，或留空表示只跑一次');
      scheduleEl.focus();
      return;
    }
    var t = {
      title: titleEl.value.trim() || goal.slice(0, 20),
      goal: goal,
      engine: engineEl.value || 'deepseek',
      schedule: sched || null,
    };
    goBtn.disabled = true;
    window.ingrid.taskCreate(t).then(function (ticket) {
      titleEl.value = '';
      goalEl.value = '';
      scheduleEl.value = '';
      goBtn.disabled = false;
      // 定时任务交给调度器到点触发；一次性任务创建后立即丢后台跑
      if (!sched) window.ingrid.taskRun(ticket.id).then(load);
      else load();
    }).catch(function (e) {
      goBtn.disabled = false;
      alert('创建失败：' + ((e && e.message) || e));
    });
  }

  function clearDone() {
    if (!IS_DESKTOP) return;
    window.ingrid.taskClear().then(load);
  }
})();
