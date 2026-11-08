/**
 * ============================================================
 *  secretary.js — 秘书悬浮面板（渲染层，零依赖）
 *  ============================================================
 *  · 可拖拽、浮在窗口左侧（与右侧监事并排）。
 *  · 随时对话：写想法 → 秘书记住 → 一键「分配给合适的 Agent」。
 *  · 日程：列表 + 添加 + 提醒（系统通知）+ 从邮件截图加日历。
 *  · 邮件：导入 + 自动分类分级 + 重要信息及时告知。
 *
 *  依赖：index.html 的 window.__workbench、secretary-core.js、task-router.js。
 * ============================================================
 */
(function () {
  'use strict';
  var wb = window.__workbench;
  var SC = window.SecretaryCore;
  var TR = window.TaskRouter;
  if (!wb || !SC) return;

  var DESKTOP = wb.IS_DESKTOP;
  var registry = wb.registry;
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  /* ---------- 存储（桌面走文件，浏览器回退 localStorage） ---------- */
  function secStorage() {
    if (!DESKTOP) return null;
    return {
      load: function () { return window.ingrid.loadSecretarySync(); },
      save: function (s) { window.ingrid.saveSecretary(s); },
    };
  }
  var RAW = (secStorage() && secStorage().load()) || {};
  var events = new SC.EventStore((secStorage() ? { load: function () { return RAW.events || []; }, save: function (d) { RAW.events = d; persist(); } } : null));
  var emails = new SC.EmailStore((secStorage() ? { load: function () { return RAW.emails || []; }, save: function (d) { RAW.emails = d; persist(); } } : null));
  var thoughts = new SC.ThoughtStore((secStorage() ? { load: function () { return RAW.thoughts || []; }, save: function (d) { RAW.thoughts = d; persist(); } } : null));
  function persist() { if (secStorage()) secStorage().save({ events: events.events, emails: emails.emails, thoughts: thoughts.thoughts }); }

  var minimized = false;
  var shotDataUrl = '';   // 邮件截图预览

  /* ---------- 样式 ---------- */
  var style = document.createElement('style');
  style.textContent = [
    '.sec-panel{position:fixed;top:76px;left:22px;width:342px;z-index:70;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 18px 48px rgba(23,59,73,.22);overflow:hidden;font-size:12.5px;color:var(--ink);}',
    '.sec-head{display:flex;align-items:center;gap:8px;padding:10px 13px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;cursor:move;user-select:none;}',
    '.sec-title{font-weight:700;font-size:13.5px;}',
    '.sec-count{font-size:10.5px;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.2);}',
    '.sec-btns{margin-left:auto;display:flex;gap:6px;}',
    '.sec-btns button{width:22px;height:22px;border:none;border-radius:7px;background:rgba(255,255,255,.2);color:#fff;cursor:pointer;font-size:12px;line-height:1;}',
    '.sec-btns button:hover{background:rgba(255,255,255,.35);}',
    '.sec-body{padding:12px 13px;max-height:calc(100vh - 150px);overflow:auto;display:flex;flex-direction:column;gap:13px;}',
    '.sec-body.hide{display:none;}',
    '.sec-sec label{display:block;font-size:10.5px;font-weight:700;letter-spacing:.03em;color:var(--ink-faint);margin-bottom:6px;text-transform:uppercase;}',
    '.sec-sec textarea,.sec-sec input[type=text],.sec-sec input[type=datetime-local]{width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:9px;font-size:12px;color:var(--ink);background:#fff;font-family:inherit;}',
    '.sec-sec textarea{resize:vertical;min-height:44px;line-height:1.5;}',
    '.sec-row{display:flex;gap:6px;margin-top:6px;}',
    '.sec-btn{flex:none;padding:7px 11px;border:none;border-radius:9px;background:var(--accent);color:#fff;font-weight:650;font-size:12px;cursor:pointer;white-space:nowrap;}',
    '.sec-btn:hover{background:var(--accent-2);}',
    '.sec-btn.ghost{background:#fff;color:var(--ink-soft);border:1px solid var(--line);}',
    '.sec-btn.ghost:hover{border-color:var(--accent);color:var(--accent);}',
    '.sec-list{max-height:150px;overflow:auto;display:flex;flex-direction:column;gap:5px;}',
    '.sec-item{display:flex;gap:7px;align-items:flex-start;padding:6px 8px;border:1px solid var(--line);border-radius:9px;background:var(--surface-2);font-size:11.5px;line-height:1.4;}',
    '.sec-item .tt{flex:1;min-width:0;word-break:break-word;}',
    '.sec-item .tt .sub{color:var(--ink-faint);font-size:10.5px;}',
    '.sec-item .del{flex:none;color:var(--ink-faint);cursor:pointer;font-size:13px;}',
    '.sec-item .del:hover{color:var(--danger);}',
    '.sec-cat{flex:none;font-size:9.5px;font-weight:700;padding:1px 6px;border-radius:6px;white-space:nowrap;}',
    '.sec-cat.imp{background:var(--danger-soft);color:var(--danger);}',
    '.sec-cat.mid{background:var(--warning-soft);color:var(--warning);}',
    '.sec-cat.low{background:var(--surface-2);color:var(--ink-faint);}',
    '.sec-empty{color:var(--ink-faint);font-size:11px;padding:4px 0;}',
    '.sec-chat{background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:8px;max-height:110px;overflow:auto;font-size:11.5px;color:var(--ink-soft);line-height:1.6;margin-top:6px;}',
    '.sec-chat .m{color:var(--accent);font-weight:650;}',
    '.sec-chat .a{color:var(--accent);font-weight:650;}',
    '#secModalMask{display:none;position:fixed;inset:0;background:rgba(23,59,73,.45);z-index:90;align-items:center;justify-content:center;padding:24px;}',
    '#secModalMask[style*="flex"]{display:flex;}',
    '.sec-modal{width:min(560px,100%);background:#fff;border-radius:18px;box-shadow:var(--shadow-lg);padding:24px;max-height:88vh;overflow:auto;}',
    '.sec-modal h3{font-size:16px;font-weight:700;margin-bottom:4px;}',
    '.sec-modal .sub{font-size:12px;color:var(--ink-faint);margin-bottom:14px;line-height:1.6;}',
    '.sec-modal .f{margin-bottom:11px;}',
    '.sec-modal .f label{display:block;font-size:12px;font-weight:650;color:var(--ink-soft);margin-bottom:5px;}',
    '.sec-modal .f input,.sec-modal .f textarea{width:100%;padding:9px 11px;border:1px solid var(--line);border-radius:9px;font-size:13px;color:var(--ink);background:#fff;font-family:inherit;}',
    '.sec-modal .shot{max-width:100%;max-height:180px;border-radius:10px;border:1px solid var(--line);margin-bottom:12px;display:block;}',
    '.sec-modal .foot{display:flex;gap:9px;justify-content:flex-end;margin-top:16px;}',
    '.sec-modal .foot button{padding:9px 16px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--ink-soft);font-size:13px;font-weight:650;cursor:pointer;}',
    '.sec-modal .foot .primary{background:var(--accent);border-color:var(--accent);color:#fff;}',
    '.sec-bout{margin-top:7px;max-height:150px;overflow:auto;font-size:11px;color:var(--ink-soft);background:var(--surface-2);border:1px solid var(--line);border-radius:9px;padding:8px;line-height:1.5;white-space:pre-wrap;word-break:break-word;}',
    '.sec-bhint{font-size:10px;color:var(--ink-faint);margin-top:5px;line-height:1.5;}',
  ].join('\n');
  document.head.appendChild(style);

  /* ---------- DOM ---------- */
  var panel = document.createElement('div');
  panel.id = 'secPanel'; panel.className = 'sec-panel';
  panel.innerHTML =
    '<div class="sec-head" id="secHead">' +
      '<span class="sec-title">' + iconSvg('feather') + ' 秘书</span>' +
      '<span class="sec-count" id="secCount">0 日程</span>' +
      '<span class="sec-btns">' +
        '<button id="secMin" title="收起/展开">—</button>' +
        '<button id="secHide" title="隐藏（可从顶栏重新打开）">✕</button>' +
      '</span>' +
    '</div>' +
    '<div class="sec-body" id="secBody">' +
      '<div class="sec-sec"><label>随时告诉秘书你的想法</label>' +
        '<textarea id="secThought" placeholder="例如：下周有个报告要交，帮我盯着点"></textarea>' +
        '<div class="sec-row"><button class="sec-btn" id="secRemember">记住</button>' +
        '<button class="sec-btn ghost" id="secAssign" style="flex:1">' + iconSvg('compass') + ' 记住并分配给合适的 Agent</button></div>' +
        '<div class="sec-chat" id="secChat"></div></div>' +
      '<div class="sec-sec"><label>日程 · 提醒</label><div class="sec-list" id="secEvents"></div>' +
        '<div class="sec-row"><button class="sec-btn ghost" id="secAddEvent">＋ 添加日程</button>' +
        '<button class="sec-btn ghost" id="secFromShot">' + iconSvg('camera') + ' 从邮件截图添加</button></div></div>' +
      '<div class="sec-sec"><label>邮件 · 分类 + 重要提醒</label><div class="sec-list" id="secEmails"></div>' +
        '<div class="sec-row"><button class="sec-btn ghost" id="secAddEmail">＋ 导入邮件</button></div></div>' +
      '<div class="sec-sec"><label>浏览器自动化 · 只读</label>' +
        '<div class="sec-row"><input type="text" id="secUrl" placeholder="粘贴网址，如 https://arxiv.org/abs/..." style="flex:1">' +
        '<button class="sec-btn" id="secBrowse">打开</button></div>' +
        '<div class="sec-row"><button class="sec-btn ghost" id="secBrowseShot">' + iconSvg('camera') + ' 截图</button>' +
        '<button class="sec-btn ghost" id="secBrowseText">提取文本</button></div>' +
        '<div class="sec-bout" id="secBrowseOut" hidden></div>' +
        '<div class="sec-bhint">只读：打开网页 / 截图 / 取文本 · 不绕过验证码与登录</div></div>' +
    '</div>';
  document.body.appendChild(panel);
  panel.style.display = 'none';   // 默认收起，从右上角入口打开

  var modalMask = document.createElement('div');
  modalMask.id = 'secModalMask';
  document.body.appendChild(modalMask);

  var fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  /* 顶栏入口 */
  var chip = document.createElement('button');
  chip.className = 'chip chip-btn'; chip.id = 'btnSecretary';
  chip.innerHTML = iconFor('🕊️') + ' 秘书';
  chip.title = '日程提醒 · 邮件分类 · 记想法并分配';
  var meta = document.querySelector('.topbar .meta');
  if (meta) meta.insertBefore(chip, document.getElementById('btnSupervisor') || document.getElementById('btnSettings'));
  chip.addEventListener('click', function () {
    panel.style.display = (panel.style.display === 'block') ? 'none' : 'block';
  });

  /* ---------- 渲染 ---------- */
  function fmtAt(at) {
    if (!at) return '';
    var d = new Date(at);
    if (!isFinite(d.getTime())) return esc(at);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    var mm = ('0' + (d.getMonth() + 1)).slice(-2), dd = ('0' + d.getDate()).slice(-2);
    var hh = ('0' + d.getHours()).slice(-2), mi = ('0' + d.getMinutes()).slice(-2);
    var datePart = sameDay ? '今天' : (mm + '月' + dd + '日');
    return datePart + ' ' + hh + ':' + mi;
  }
  function renderEvents() {
    var box = document.getElementById('secEvents');
    var list = events.upcoming();
    document.getElementById('secCount').textContent = list.length + ' 日程';
    if (!list.length) { box.innerHTML = '<div class="sec-empty">暂无日程。点下方添加，或从邮件截图导入。</div>'; return; }
    box.innerHTML = list.slice(0, 12).map(function (e) {
      var remind = e.reminderMin ? ' · ' + iconSvg('clock') + ' 提前' + (e.reminderMin >= 60 ? (e.reminderMin / 60) + 'h' : e.reminderMin + 'm') : '';
      var src = e.source ? ' · ' + esc(e.source) : '';
      return '<div class="sec-item"><div class="tt"><b>' + esc(e.title || '（无标题）') + '</b>' +
        '<div class="sub">' + fmtAt(e.at) + (e.location ? ' · ' + esc(e.location) : '') + remind + src + '</div>' +
        (e.link ? '<div class="sub">' + iconSvg('link') + ' <a href="' + esc(e.link) + '" target="_blank" style="color:var(--accent)">' + esc(e.link.slice(0, 40)) + '</a></div>' : '') +
        '</div><span class="del" data-del="' + esc(e.id) + '">✕</span></div>';
    }).join('');
    box.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () { events.remove(b.getAttribute('data-del')); renderEvents(); });
    });
  }
  function renderEmails() {
    var box = document.getElementById('secEmails');
    var list = emails.list();
    if (!list.length) { box.innerHTML = '<div class="sec-empty">暂无邮件。点下方导入（粘贴 / 手动填）。</div>'; return; }
    box.innerHTML = list.slice(0, 15).map(function (m) {
      var cls = m.importance >= 3 ? 'imp' : (m.importance >= 2 ? 'mid' : 'low');
      return '<div class="sec-item"><div class="tt"><b>' + esc(m.subject) + '</b>' +
        '<div class="sub">' + esc(m.from) + (m.important && !m.read ? ' · <b style="color:var(--danger)">未读重要</b>' : '') + '</div></div>' +
        '<span class="sec-cat ' + cls + '" title="重要度 ' + m.importance + '">' + iconFor(SC.categoryEmoji(m.category)) + ' ' + esc(SC.categoryLabel(m.category)) + '</span>' +
        '<span class="del" data-del="' + esc(m.id) + '">✕</span></div>';
    }).join('');
    box.querySelectorAll('[data-del]').forEach(function (b) {
      b.addEventListener('click', function () { emails.remove(b.getAttribute('data-del')); renderEmails(); });
    });
  }
  function renderChat() {
    var box = document.getElementById('secChat');
    if (!box) return;
    var list = thoughts.list();
    if (!list.length) { box.innerHTML = '<span style="color:var(--ink-faint)">秘书还没收到你的想法。</span>'; return; }
    box.innerHTML = list.slice(0, 6).map(function (t) {
      var st = t.status === 'assigned' ? ' · 已分配' : '';
      return '<div><span class="m">你：</span>' + esc(t.text) + st + '</div>';
    }).join('');
  }
  function renderAll() { renderEvents(); renderEmails(); renderChat(); }

  /* ---------- 拖拽 ---------- */
  var head = document.getElementById('secHead');
  var drag = null;
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

  /* ---------- 事件 ---------- */
  document.getElementById('secMin').addEventListener('click', function () {
    minimized = !minimized;
    document.getElementById('secBody').classList.toggle('hide', minimized);
    this.textContent = minimized ? '＋' : '—';
  });
  document.getElementById('secHide').addEventListener('click', function () { panel.style.display = 'none'; });

  /* 想法：记住 / 分配 */
  function currentThought() { return document.getElementById('secThought').value.trim(); }
  document.getElementById('secRemember').addEventListener('click', function () {
    var t = currentThought();
    if (!t) return;
    thoughts.add(t);
    document.getElementById('secThought').value = '';
    renderChat();
    addChat('a', '已记住。需要的话点「分配给合适的 Agent」。');
  });
  document.getElementById('secAssign').addEventListener('click', function () {
    var t = currentThought();
    if (!t) { addChat('a', '先写一句你的想法，我才能分配。'); return; }
    var th = thoughts.add(t); document.getElementById('secThought').value = '';
    var agents = registry.list();
    var commander = agents.filter(function (a) { return a.role === 'orchestrator' || a.canControl; })[0];
    var skillsReg = (window.__skills && window.__skills.skills) || null;
    addChat('a', '收到，我来判断交给谁、挂哪些技能…');
    TR.route(t, { agents: agents, commanderId: commander ? commander.id : '', skills: skillsReg, maxTargets: 3, maxSkills: 3 })
      .then(function (plan) {
        thoughts.update(th.id, { status: 'assigned', assignedTo: plan.targetNames.join('、') });
        addChat('a', '建议：' + plan.summary);
        if (typeof window.__openOrchestratorTask === 'function') window.__openOrchestratorTask(t, plan);
        renderChat();
      }).catch(function (e) { addChat('a', '分配失败：' + (e && e.message || e)); });
  });
  function addChat(who, text) {
    var box = document.getElementById('secChat');
    if (!box) return;
    box.innerHTML += '<div><span class="' + who + '">' + (who === 'a' ? '秘书：' : '你：') + '</span>' + esc(text) + '</div>';
    box.scrollTop = box.scrollHeight;
  }

  /* 添加日程 */
  document.getElementById('secAddEvent').addEventListener('click', function () { openEventModal(null); });

  /* 从邮件截图添加 */
  document.getElementById('secFromShot').addEventListener('click', function () {
    shotDataUrl = '';
    fileInput.click();
  });
  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () { shotDataUrl = reader.result; openEventModal(null, true); };
    reader.readAsDataURL(f);
  });

  /* 浏览器自动化（安全白名单：打开 / 截图 / 提取文本） */
  function secUrl() { return document.getElementById('secUrl').value.trim(); }
  function secBrowseOut(msg) {
    var o = document.getElementById('secBrowseOut');
    o.hidden = false; o.textContent = msg;
  }
  function secBusy(on) {
    ['secBrowse', 'secBrowseShot', 'secBrowseText'].forEach(function (id) {
      document.getElementById(id).disabled = !!on;
    });
  }
  function secBrowseRun(action) {
    var u = secUrl();
    if (!u) { secBrowseOut('请先粘贴网址'); return; }
    if (!/^https?:\/\//.test(u)) { secBrowseOut('网址需以 http:// 或 https:// 开头'); return; }
    secBusy(true); secBrowseOut('执行中…');
    window.ingrid.browserAutomate({ action: action, url: u }).then(function (r) {
      secBusy(false);
      if (r && r.ok) secBrowseOut((action === 'text' ? '已提取页面文本：\n\n' : '完成：\n\n') + (r.output || ''));
      else secBrowseOut('失败：' + ((r && r.error) || '未知错误'));
    }).catch(function (e) { secBusy(false); secBrowseOut('失败：' + (e && e.message || e)); });
  }
  document.getElementById('secBrowse').addEventListener('click', function () { secBrowseRun('open'); });
  document.getElementById('secBrowseShot').addEventListener('click', function () { secBrowseRun('shot'); });
  document.getElementById('secBrowseText').addEventListener('click', function () { secBrowseRun('text'); });

  /* 事件弹窗（新增日程 / 截图→日历） */
  function openEventModal(prefill, isShot) {
    var hint = prefill || {};
    modalMask.style.display = 'flex';
    modalMask.innerHTML =
      '<div class="sec-modal"><h3>' + (isShot ? iconSvg('camera') + ' 从邮件截图添加日程' : iconSvg('calendar') + ' 添加日程') + '</h3>' +
      '<div class="sub">' + (isShot ? '可先粘贴邮件文字让秘书自动提取，或直接手填；保存后会自动设提醒并附上邮件链接。' : '保存后秘书会按提醒时间通知你。') + '</div>' +
      (shotDataUrl ? '<img class="shot" src="' + shotDataUrl + '">' : '') +
      '<div class="f"><label>邮件文字（可选，帮秘书提取）</label><textarea id="evText" rows="3">' + esc(hint.raw || '') + '</textarea>' +
        '<div style="margin-top:6px"><button class="sec-btn ghost" id="evExtract">' + iconSvg('sparkles') + ' 从文字自动提取</button></div></div>' +
      '<div class="f"><label>标题 *</label><input id="evTitle" value="' + esc(hint.title || '') + '"></div>' +
      '<div class="f"><label>时间 *</label><input type="datetime-local" id="evAt" value="' + esc(hint.atLocal || '') + '"></div>' +
      '<div class="f"><label>地点</label><input id="evLoc" value="' + esc(hint.location || '') + '"></div>' +
      '<div class="f"><label>邮件链接</label><input id="evLink" value="' + esc(hint.link || '') + '"></div>' +
      '<div class="f"><label>备注</label><textarea id="evNote" rows="2">' + esc(hint.note || '') + '</textarea></div>' +
      '<div class="f"><label>提前提醒</label><select id="evRemind">' +
        '<option value="0">不提醒</option><option value="15">15 分钟</option><option value="60">1 小时</option><option value="1440" selected>1 天</option><option value="4320">3 天</option></select></div>' +
      '<div class="foot"><button id="evCancel">取消</button><button class="primary" id="evSave">保存到日程</button></div></div>';

    var atInput = modalMask.querySelector('#evAt');
    if (!atInput.value) {
      var d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0);
      atInput.value = toLocal(d);
    }
    modalMask.querySelector('#evCancel').addEventListener('click', closeModal);
    modalMask.querySelector('#evExtract').addEventListener('click', function () {
      var h = SC.extractEventHint(modalMask.querySelector('#evText').value, Date.now());
      if (h.title) modalMask.querySelector('#evTitle').value = h.title;
      if (h.at) modalMask.querySelector('#evAt').value = toLocal(new Date(h.at));
      if (h.link) modalMask.querySelector('#evLink').value = h.link;
    });
    modalMask.querySelector('#evSave').addEventListener('click', function () {
      var title = modalMask.querySelector('#evTitle').value.trim();
      var at = modalMask.querySelector('#evAt').value;
      if (!title || !at) { alert('标题和时间必填'); return; }
      events.add({
        title: title, at: new Date(at).toISOString(),
        location: modalMask.querySelector('#evLoc').value.trim(),
        link: modalMask.querySelector('#evLink').value.trim(),
        note: modalMask.querySelector('#evNote').value.trim(),
        reminderMin: Number(modalMask.querySelector('#evRemind').value) || 0,
        source: isShot ? '邮件截图' : '',
      });
      closeModal(); renderEvents();
      addChat('a', '已添加日程「' + title + '」，到点会提醒你。');
    });
  }
  function toLocal(d) {
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function closeModal() { modalMask.style.display = 'none'; modalMask.innerHTML = ''; shotDataUrl = ''; }
  modalMask.addEventListener('click', function (e) { if (e.target === modalMask) closeModal(); });

  /* 导入邮件 */
  document.getElementById('secAddEmail').addEventListener('click', function () {
    modalMask.style.display = 'flex';
    modalMask.innerHTML =
      '<div class="sec-modal"><h3>' + iconSvg('mail') + ' 导入邮件</h3>' +
      '<div class="sub">粘贴一封邮件的发件人 / 主题 / 正文，秘书会自动分类并判断是否重要。' +
      '（IMAP/Gmail 实时同步需在「引擎设置」里接入邮箱凭据，后续可做）</div>' +
      '<div class="f"><label>发件人</label><input id="emFrom" placeholder="name@example.com"></div>' +
      '<div class="f"><label>主题</label><input id="emSubject"></div>' +
      '<div class="f"><label>正文（可整段粘贴）</label><textarea id="emBody" rows="5"></textarea></div>' +
      '<div class="f"><label>邮件链接（可选）</label><input id="emLink"></div>' +
      '<div class="foot"><button id="emCancel">取消</button><button class="primary" id="emSave">导入并分类</button></div></div>';
    modalMask.querySelector('#emCancel').addEventListener('click', closeModal);
    modalMask.querySelector('#emSave').addEventListener('click', function () {
      var m = emails.add({
        from: modalMask.querySelector('#emFrom').value.trim(),
        subject: modalMask.querySelector('#emSubject').value.trim(),
        body: modalMask.querySelector('#emBody').value.trim(),
        link: modalMask.querySelector('#emLink').value.trim(),
      });
      closeModal(); renderEmails();
      if (m.important) {
        addChat('a', '⚠ 这封是重要邮件（' + SC.categoryLabel(m.category) + '），请注意。');
        if (DESKTOP && window.ingrid.notify) window.ingrid.notify({ title: '📧 重要邮件：' + m.subject, body: '来自 ' + (m.from || '未知') + ' · 分类 ' + SC.categoryLabel(m.category) });
      } else {
        addChat('a', '已分类：「' + SC.categoryLabel(m.category) + '」。');
      }
    });
  });

  /* ---------- 提醒循环：每 30 秒检查，到点发系统通知 ---------- */
  function checkReminders() {
    if (!DESKTOP || !window.ingrid.notify) return;
    var due = events.dueReminders();
    due.forEach(function (e) {
      window.ingrid.notify({ title: '⏰ ' + e.title, body: (e.location ? e.location + ' · ' : '') + '即将开始' });
      events.update(e.id, { reminded: true });
    });
    if (due.length) renderEvents();
  }
  setInterval(checkReminders, 30000);

  /* ---------- 暴露 ---------- */
  window.__secretary = { events: events, emails: emails, thoughts: thoughts, addChat: addChat };

  /* ---------- 初始化 ---------- */
  renderAll();
  checkReminders();
})();
