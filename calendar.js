/* ============================================================
 * calendar.js — 右侧日历面板（渲染层，零依赖）
 * ============================================================
 *  · 月历视图 + 按天看日程（数据来自秘书 secretary.json 的合并日程）
 *  · 显示日历账户同步状态、可手动触发同步
 *  · 新增日程：保存到秘书，并写回 iCloud（手机可查看，双向）
 *  · 可拖拽、可收起、可隐藏；主进程定时同步后自动刷新
 * ============================================================ */
(function () {
  'use strict';
  var IS_DESKTOP = !!(window.ingrid && window.ingrid.isDesktop);
  var $ = function (id) { return document.getElementById(id); };

  /* ---------- 状态 ---------- */
  var events = [];        // 秘书合并日程
  var accounts = [];      // 日历账户（脱敏）
  var lastSyncAt = null;  // 上次同步时间
  var syncError = '';
  var viewY, viewM;       // 当前显示的年/月（0-based 月）
  var selectedDate;       // 'YYYY-MM-DD'
  var minimized = false;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function toDateStr(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function now() { var d = new Date(); viewY = d.getFullYear(); viewM = d.getMonth(); selectedDate = toDateStr(d); }

  /* ---------- 样式 ---------- */
  var style = document.createElement('style');
  style.textContent = [
    '.cal-panel{position:fixed;top:76px;right:22px;width:348px;z-index:71;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 18px 48px rgba(23,59,73,.22);overflow:hidden;font-size:12.5px;color:var(--ink);}',
    '.cal-head{display:flex;align-items:center;gap:8px;padding:10px 13px;background:linear-gradient(135deg,var(--deep),var(--accent));color:#fff;cursor:move;user-select:none;}',
    '.cal-title{font-weight:700;font-size:13.5px;display:flex;align-items:center;gap:6px;}',
    '.cal-title svg{width:15px;height:15px;}',
    '.cal-status{font-size:10px;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.18);}',
    '.cal-status.ok{background:rgba(255,255,255,.92);color:var(--accent);font-weight:700;}',
    '.cal-btns{margin-left:auto;display:flex;gap:6px;}',
    '.cal-btns button{min-width:22px;height:22px;padding:0 5px;border:none;border-radius:7px;background:rgba(255,255,255,.16);color:#fff;cursor:pointer;font-size:12px;line-height:1;}',
    '.cal-btns button:hover{background:rgba(255,255,255,.32);}',
    '.cal-btns button:disabled{opacity:.5;cursor:wait;}',
    '.cal-body{padding:12px 13px;display:flex;flex-direction:column;gap:11px;max-height:calc(100vh - 150px);overflow:auto;}',
    '.cal-body.hide{display:none;}',
    '.cal-nav{display:flex;align-items:center;gap:6px;}',
    '.cal-nav .lbl{flex:1;text-align:center;font-weight:700;font-size:13.5px;color:var(--ink);}',
    '.cal-nav button{width:26px;height:26px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink-soft);cursor:pointer;font-size:13px;line-height:1;}',
    '.cal-nav button:hover{border-color:var(--accent);color:var(--accent);}',
    '.cal-nav .today{margin-left:4px;width:auto;padding:0 9px;font-size:11.5px;font-weight:650;}',
    '.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:3px;}',
    '.cal-grid .wd{text-align:center;font-size:10px;font-weight:700;color:var(--ink-faint);padding:2px 0;}',
    '.cal-grid .day{aspect-ratio:1;display:flex;align-items:center;justify-content:center;border-radius:8px;font-size:12px;color:var(--ink);cursor:pointer;position:relative;}',
    '.cal-grid .day:hover{background:var(--accent-soft);}',
    '.cal-grid .day.other{color:var(--ink-faint);}',
    '.cal-grid .day.sel{background:var(--accent);color:#fff;font-weight:700;}',
    '.cal-grid .day.today:not(.sel){box-shadow:inset 0 0 0 1.5px var(--accent);}',
    '.cal-grid .day.has::after{content:"";position:absolute;bottom:4px;width:4px;height:4px;border-radius:50%;background:var(--accent);}',
    '.cal-grid .day.sel.has::after{background:#fff;}',
    '.cal-day-head{display:flex;align-items:baseline;gap:8px;}',
    '.cal-day-head .d{font-weight:700;font-size:13px;}',
    '.cal-day-head .cnt{font-size:11px;color:var(--ink-faint);}',
    '.cal-events{display:flex;flex-direction:column;gap:6px;max-height:180px;overflow:auto;}',
    '.cal-ev{border:1px solid var(--line);border-radius:9px;padding:7px 9px;background:var(--surface-2);display:flex;gap:8px;align-items:flex-start;}',
    '.cal-ev .time{flex:none;font-size:11px;font-weight:700;color:var(--accent);min-width:44px;padding-top:1px;}',
    '.cal-ev .body{flex:1;min-width:0;}',
    '.cal-ev .t{font-size:12.5px;font-weight:650;color:var(--ink);word-break:break-word;}',
    '.cal-ev .meta{font-size:10.5px;color:var(--ink-faint);margin-top:2px;word-break:break-word;}',
    '.cal-ev .src{font-size:9.5px;color:var(--ink-faint);background:#fff;border:1px solid var(--line);padding:0 5px;border-radius:6px;margin-top:3px;display:inline-block;}',
    '.cal-empty{color:var(--ink-faint);font-size:11.5px;text-align:center;padding:12px 0;}',
    '.cal-foot{font-size:10.5px;color:var(--ink-faint);line-height:1.6;border-top:1px solid var(--line);padding-top:9px;}',
    '.cal-foot .ok{color:#1d9e75;font-weight:600;}',
    '.cal-foot .warn{color:#b7791f;font-weight:600;}',
    '.cal-foot button{background:none;border:none;color:var(--accent);cursor:pointer;font-size:10.5px;padding:0;text-decoration:underline;}',
    '#calModalMask{display:none;position:fixed;inset:0;background:rgba(23,59,73,.45);z-index:92;align-items:center;justify-content:center;padding:24px;}',
    '#calModalMask[style*="flex"]{display:flex;}',
    '.cal-modal{width:min(420px,100%);background:#fff;border-radius:18px;box-shadow:var(--shadow-lg);padding:22px;max-height:90vh;overflow:auto;}',
    '.cal-modal h3{font-size:16px;font-weight:700;margin-bottom:3px;}',
    '.cal-modal .sub{font-size:11.5px;color:var(--ink-faint);margin-bottom:14px;line-height:1.6;}',
    '.cal-modal .kv{margin-bottom:11px;}',
    '.cal-modal .kv label{display:block;font-size:11px;font-weight:700;color:var(--ink-faint);margin-bottom:5px;}',
    '.cal-modal .kv input{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:9px;font-size:13px;color:var(--ink);background:#fff;font-family:inherit;}',
    '.cal-modal .row{display:flex;gap:9px;}',
    '.cal-modal .row .kv{flex:1;}',
    '.cal-modal .check{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--ink-soft);cursor:pointer;margin-bottom:11px;}',
    '.cal-modal .check input{accent-color:var(--accent);width:15px;height:15px;}',
    '.cal-modal .foot{display:flex;gap:9px;justify-content:flex-end;margin-top:16px;}',
    '.cal-modal .foot button{padding:9px 16px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--ink-soft);font-size:13px;font-weight:650;cursor:pointer;}',
    '.cal-modal .foot .primary{background:var(--accent);border-color:var(--accent);color:#fff;}',
    '.cal-modal .foot button:disabled{opacity:.5;cursor:wait;}',
  ].join('\n');
  document.head.appendChild(style);

  /* ---------- DOM ---------- */
  var panel = document.createElement('div');
  panel.id = 'calPanel'; panel.className = 'cal-panel';
  panel.innerHTML =
    '<div class="cal-head" id="calHead">' +
      '<span class="cal-title">' + (window.iconSvg ? window.iconSvg('calendar') : '') + ' 日历</span>' +
      '<span class="cal-status" id="calStatus">–</span>' +
      '<span class="cal-btns">' +
        '<button id="calSync" title="立即同步日历">↻</button>' +
        '<button id="calAdd" title="新增日程">＋</button>' +
        '<button id="calMin" title="收起/展开">—</button>' +
        '<button id="calHide" title="隐藏（可从顶栏重新打开）">✕</button>' +
      '</span>' +
    '</div>' +
    '<div class="cal-body" id="calBody">' +
      '<div class="cal-nav">' +
        '<button id="calPrev" title="上月">◀</button>' +
        '<div class="lbl" id="calLbl">—</div>' +
        '<button id="calNext" title="下月">▶</button>' +
        '<button class="today" id="calToday">今天</button>' +
      '</div>' +
      '<div class="cal-grid" id="calGrid"></div>' +
      '<div class="cal-day-head"><span class="d" id="calDayLabel">—</span><span class="cnt" id="calDayCount"></span></div>' +
      '<div class="cal-events" id="calEvents"></div>' +
      '<div class="cal-foot" id="calFoot"></div>' +
    '</div>';
  document.body.appendChild(panel);

  var modalMask = document.createElement('div');
  modalMask.id = 'calModalMask';
  document.body.appendChild(modalMask);

  /* ---------- 数据加载 ---------- */
  function loadEvents() {
    try { if (IS_DESKTOP) events = (window.ingrid.loadSecretarySync() || {}).events || []; } catch (e) { events = []; }
    render();
  }
  function loadAccounts() {
    if (!IS_DESKTOP) { accounts = []; return; }
    window.ingrid.syncAccountsList().then(function (a) { accounts = a || []; renderFoot(); }).catch(function () {});
  }
  function loadAll() { loadEvents(); loadAccounts(); }

  /* ---------- 渲染 ---------- */
  function render() { renderNav(); renderGrid(); renderDay(); renderFoot(); }

  function renderNav() {
    $('calLbl').textContent = viewY + ' 年 ' + (viewM + 1) + ' 月';
  }

  function renderGrid() {
    var first = new Date(viewY, viewM, 1);
    var startDow = (first.getDay() + 6) % 7;       // 周一=0
    var daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
    var daysInPrev = new Date(viewY, viewM, 0).getDate();
    var prevDate = new Date(viewY, viewM - 1, 1);  // 上月（自动处理跨年）
    var nextDate = new Date(viewY, viewM + 1, 1);  // 下月（自动处理跨年）
    var py = prevDate.getFullYear(), pm = prevDate.getMonth();
    var ny = nextDate.getFullYear(), nm = nextDate.getMonth();
    var today = toDateStr(new Date());
    var html = ['一', '二', '三', '四', '五', '六', '日'].map(function (w) { return '<div class="wd">' + w + '</div>'; }).join('');
    // 上月补位
    for (var i = startDow - 1; i >= 0; i--) {
      html += '<div class="day other" data-d="' + (py + '-' + pad(pm + 1) + '-' + pad(daysInPrev - i)) + '">' + (daysInPrev - i) + '</div>';
    }
    for (var d = 1; d <= daysInMonth; d++) {
      var ds = viewY + '-' + pad(viewM + 1) + '-' + pad(d);
      var cls = 'day';
      if (ds === selectedDate) cls += ' sel';
      if (ds === today) cls += ' today';
      if (hasEvent(ds)) cls += ' has';
      html += '<div class="' + cls + '" data-d="' + ds + '">' + d + '</div>';
    }
    // 下月补位（补齐到 35/42 格）
    var total = Math.ceil((startDow + daysInMonth) / 7) * 7;
    if (total < 35) total = 35;
    var cells = startDow + daysInMonth;
    for (var j = 0; cells + j < total; j++) {
      html += '<div class="day other" data-d="' + (ny + '-' + pad(nm + 1) + '-' + pad(1 + j)) + '">' + (1 + j) + '</div>';
    }
    $('calGrid').innerHTML = html;
    Array.prototype.forEach.call($('calGrid').querySelectorAll('.day'), function (n) {
      n.addEventListener('click', function () { selectDay(n.getAttribute('data-d')); });
    });
  }

  function hasEvent(ds) {
    return events.some(function (e) { return e.at && toDateStr(new Date(e.at)) === ds; });
  }

  function eventsOn(ds) {
    return events.filter(function (e) { return e.at && toDateStr(new Date(e.at)) === ds; })
      .sort(function (a, b) { return String(a.at || '').localeCompare(String(b.at || '')); });
  }

  function fmtTime(iso, allDay) {
    if (!iso) return '';
    if (allDay) return '全天';
    var d = new Date(iso);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function renderDay() {
    var d = new Date(selectedDate);
    var label = (d.getMonth() + 1) + '月' + d.getDate() + '日 · 星期' + '日一二三四五六'[d.getDay()];
    $('calDayLabel').textContent = label;
    var list = eventsOn(selectedDate);
    $('calDayCount').textContent = list.length ? (list.length + ' 项') : '';
    if (!list.length) {
      $('calEvents').innerHTML = '<div class="cal-empty">当天没有日程</div>';
      return;
    }
    $('calEvents').innerHTML = list.map(function (e) {
      var src = e.source ? '<span class="src">' + esc(e.source) + '</span>' : '';
      var loc = e.location ? '<div class="meta">📍 ' + esc(e.location) + '</div>' : '';
      return '<div class="cal-ev"><div class="time">' + fmtTime(e.at, e.allDay) + '</div>' +
        '<div class="body"><div class="t">' + esc(e.title) + '</div>' + loc + src + '</div></div>';
    }).join('');
  }

  function renderFoot() {
    var lines = [];
    if (accounts.length) {
      lines.push('<span class="ok">✓ 已连接 ' + accounts.length + ' 个日历账户</span>：' + accounts.map(function (a) { return esc(a.name); }).join('、'));
      if (lastSyncAt) lines.push('上次同步 ' + fmtRelative(lastSyncAt));
    } else {
      lines.push('<span class="warn">⚠ 尚未配置日历账户</span>');
      lines.push('在秘书面板「日程」区点「同步日历（iCloud）」完成配置');
    }
    if (syncError) lines.push('<span class="warn">' + esc(syncError) + '</span>');
    lines.push('<button id="calRefresh">刷新日程</button>');
    $('calFoot').innerHTML = lines.join('<br>');
    var rb = $('calRefresh'); if (rb) rb.addEventListener('click', loadAll);
  }

  function fmtRelative(ts) {
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  /* ---------- 选日 / 换月 ---------- */
  function selectDay(ds) { selectedDate = ds; render(); }
  $('calPrev').addEventListener('click', function () { viewM--; if (viewM < 0) { viewM = 11; viewY--; } render(); });
  $('calNext').addEventListener('click', function () { viewM++; if (viewM > 11) { viewM = 0; viewY++; } render(); });
  $('calToday').addEventListener('click', function () { var d = new Date(); viewY = d.getFullYear(); viewM = d.getMonth(); selectedDate = toDateStr(d); render(); });

  /* ---------- 同步 ---------- */
  function doSync() {
    var btn = $('calSync'); btn.disabled = true;
    syncError = ''; renderFoot();
    window.ingrid.syncCalendarRun().then(function (r) {
      btn.disabled = false;
      if (r && r.syncedAt) lastSyncAt = r.syncedAt;
      if (r && r.results && r.results.some(function (x) { return !x.ok; })) {
        var bad = r.results.find(function (x) { return !x.ok; });
        syncError = bad && bad.error ? bad.error : '部分账户同步失败';
      }
      $('calStatus').textContent = '已同步'; $('calStatus').classList.add('ok');
      loadEvents();
    }).catch(function (e) { btn.disabled = false; syncError = String(e && e.message || e); renderFoot(); });
  }
  $('calSync').addEventListener('click', doSync);

  /* ---------- 新增日程（含写回 iCloud） ---------- */
  function openAddModal() {
    var defDate = selectedDate || toDateStr(new Date());
    modalMask.innerHTML =
      '<div class="cal-modal">' +
        '<h3>＋ 新增日程</h3>' +
        '<div class="sub">保存到本机，并同步写回 iCloud（手机「日历」可查看）</div>' +
        '<div class="kv"><label>标题</label><input id="evTitle" placeholder="例如：组会讨论"></div>' +
        '<div class="row">' +
          '<div class="kv"><label>日期</label><input id="evDate" type="date" value="' + defDate + '"></div>' +
          '<div class="kv"><label>开始时间</label><input id="evStart" type="time" value="09:00"></div>' +
        '</div>' +
        '<div class="row">' +
          '<div class="kv"><label>结束时间</label><input id="evEnd" type="time" value="10:00"></div>' +
          '<div class="kv"><label>地点（可选）</label><input id="evLoc" placeholder="会议室 / Zoom"></div>' +
        '</div>' +
        '<label class="check"><input type="checkbox" id="evAllDay"> 全天</label>' +
        '<div class="kv"><label>备注（可选）</label><input id="evNote" placeholder="补充说明"></div>' +
        '<div class="foot"><button id="evCancel">取消</button><button class="primary" id="evSave">保存并同步</button></div>' +
      '</div>';
    modalMask.style.display = 'flex';
    $('evCancel').addEventListener('click', closeModal);
    modalMask.addEventListener('click', function (e) { if (e.target === modalMask) closeModal(); });
    $('evAllDay').addEventListener('change', function () {
      $('evStart').disabled = $('evAllDay').checked; $('evEnd').disabled = $('evAllDay').checked;
    });
    $('evSave').addEventListener('click', saveEvent);
    setTimeout(function () { $('evTitle').focus(); }, 50);
  }
  function closeModal() { modalMask.style.display = 'none'; modalMask.innerHTML = ''; }

  function saveEvent() {
    var title = $('evTitle').value.trim();
    if (!title) { $('evTitle').focus(); return; }
    var dateStr = $('evDate').value;
    var allDay = $('evAllDay').checked;
    var start = $('evStart').value, end = $('evEnd').value;
    var loc = $('evLoc').value.trim(), note = $('evNote').value.trim();
    var at = allDay ? new Date(dateStr + 'T00:00:00').toISOString() : new Date(dateStr + 'T' + start + ':00').toISOString();
    var endIso = allDay ? '' : new Date(dateStr + 'T' + end + ':00').toISOString();

    var btn = $('evSave'); btn.disabled = true; btn.textContent = '同步中…';

    function commit(ev) {
      var st = IS_DESKTOP ? window.ingrid.loadSecretarySync() : { events: [], emails: [], thoughts: [] };
      var list = Array.isArray(st.events) ? st.events.slice() : [];
      list.push(ev);
      list.sort(function (a, b) { return String(a.at || '').localeCompare(String(b.at || '')); });
      if (IS_DESKTOP) window.ingrid.saveSecretary({ events: list, emails: st.emails || [], thoughts: st.thoughts || [] });
      closeModal();
      selectedDate = toDateStr(new Date(at));
      loadEvents();
    }

    var base = {
      title: title, at: at, end: endIso, location: loc, note: note, allDay: allDay,
      reminderMin: allDay ? 0 : 30, reminded: false, done: false, createdAt: Date.now(),
    };

    // 有 iCloud 账户 → 先写回远端，成功则用远端 uid 标记（避免下次拉取重复）
    var hasCal = accounts.some(function (a) { return a.type === 'caldav' && a.hasPassword; });
    if (IS_DESKTOP && hasCal) {
      window.ingrid.syncCalendarPush(base).then(function (r) {
        if (r && r.ok) {
          var ev = Object.assign({}, base, { id: 'cal-' + String(r.uid), remoteUid: String(r.uid), source: 'iCloud · ' + (r.calendar || '日历') });
          commit(ev);
        } else {
          // 写回失败：仍保存为本地日程，并提示
          var ev2 = Object.assign({}, base, { id: 'ev-' + Date.now(), source: '本地（未同步）' });
          commit(ev2);
          alert('日程已保存到本机，但写回 iCloud 失败：\n' + (r && r.error ? r.error : '未知错误') + '\n\n可稍后在日历面板点「↻ 同步」重试。');
        }
      }).catch(function (e) {
        var ev2 = Object.assign({}, base, { id: 'ev-' + Date.now(), source: '本地（未同步）' });
        commit(ev2);
        alert('已保存到本机（未写回 iCloud）：' + String(e && e.message || e));
      });
    } else {
      var ev = Object.assign({}, base, { id: 'ev-' + Date.now(), source: '本地添加' });
      commit(ev);
    }
  }
  $('calAdd').addEventListener('click', openAddModal);

  /* ---------- 收起 / 隐藏 / 拖拽 ---------- */
  $('calMin').addEventListener('click', function () {
    minimized = !minimized;
    $('calBody').classList.toggle('hide', minimized);
    $('calMin').textContent = minimized ? '▢' : '—';
  });
  $('calHide').addEventListener('click', function () { panel.style.display = 'none'; window.__calPanelHidden = true; });

  var head = $('calHead'), drag = null;
  head.addEventListener('mousedown', function (e) {
    if (e.target.closest('button')) return;
    var r = panel.getBoundingClientRect();
    drag = { x: e.clientX - r.left, y: e.clientY - r.top };
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', function (e) {
    if (!drag) return;
    panel.style.left = (e.clientX - drag.x) + 'px';
    panel.style.top = (e.clientY - drag.y) + 'px';
    panel.style.right = 'auto';
  });
  document.addEventListener('mouseup', function () { drag = null; document.body.style.userSelect = ''; });

  /* ---------- 后台同步自动刷新 ---------- */
  if (IS_DESKTOP && window.ingrid.onCalendarSynced) {
    window.ingrid.onCalendarSynced(function (r) {
      if (r && r.syncedAt) lastSyncAt = r.syncedAt;
      if (r && r.results && r.results.some(function (x) { return !x.ok; })) {
        var bad = r.results.find(function (x) { return !x.ok; });
        syncError = bad && bad.error ? bad.error : '部分账户同步失败';
      } else { syncError = ''; }
      $('calStatus').textContent = '已同步'; $('calStatus').classList.add('ok');
      loadEvents();
    });
  }

  // 从顶栏重新打开（若被隐藏）
  window.__openCalendar = function () { panel.style.display = ''; window.__calPanelHidden = false; loadAll(); };

  /* ---------- 启动 ---------- */
  now();
  render();
  loadAll();
  if (IS_DESKTOP) { $('calStatus').textContent = '同步中…'; doSync(); }
})();
