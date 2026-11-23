/**
 * ============================================================
 *  secretary.js — 秘书常驻面板（渲染层，零依赖）
 *  ============================================================
 *  · 常驻在主界面底部（与右侧监事并排），始终可见。
 *  · 随时对话：写想法 → 秘书记住。
 *  · 日程：列表 + 添加 + 提醒（系统通知）+ 从邮件截图加日历。
 *  · 邮件：导入 + 自动分类分级 + 重要信息及时告知。
 *
 *  依赖：index.html 的 window.__workbench、secretary-core.js。
 * ============================================================
 */
(function () {
  'use strict';
  var wb = window.__workbench;
  var SC = window.SecretaryCore;
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
  function persist() {
    if (secStorage()) {
      var p = secStorage().save({ events: events.events, emails: emails.emails, thoughts: thoughts.thoughts });
      // saveSecretary 是异步写盘：等写完成后再刷新日历，避免读到旧盘数据
      if (p && typeof p.then === 'function') { p.then(refreshCal).catch(refreshCal); }
      else { refreshCal(); }
    }
  }
  function refreshCal() {
    if (typeof window.__refreshCalendar === 'function') { try { window.__refreshCalendar(); } catch (e) {} }
  }

  var minimized = false;
  var shotDataUrls = [];   // 截图列表（同一活动多张合并 / 不同活动分别识别）
  var shotEvents = [];     // 识别出的日程结果（待确认，可多条）

  /* ---------- 样式 ---------- */
  var style = document.createElement('style');
  style.textContent = [
    '.sec-panel{position:static;width:100%;background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow);overflow:hidden;font-size:12.5px;color:var(--ink);display:flex;flex-direction:column;}',
    '.sec-head{display:flex;align-items:center;gap:8px;padding:10px 13px;background:linear-gradient(135deg,var(--accent),var(--accent-2));color:#fff;user-select:none;flex:none;}',
    '.sec-title{font-weight:700;font-size:13.5px;}',
    '.sec-count{font-size:10.5px;padding:2px 8px;border-radius:999px;background:rgba(255,255,255,.2);}',
    '.sec-btns{margin-left:auto;display:flex;gap:6px;}',
    '.sec-btns button{width:22px;height:22px;border:none;border-radius:7px;background:rgba(255,255,255,.2);color:#fff;cursor:pointer;font-size:12px;line-height:1;}',
    '.sec-btns button:hover{background:rgba(255,255,255,.35);}',
    '.sec-body{padding:12px 13px;max-height:236px;overflow:auto;display:flex;flex-direction:column;gap:13px;}',
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
    '.sec-modal .shot-drop{display:flex;align-items:center;justify-content:center;gap:8px;padding:26px 16px;border:2px dashed var(--line);border-radius:12px;color:var(--ink-faint);font-size:12.5px;cursor:pointer;margin-bottom:12px;transition:border-color .15s,color .15s,background .15s;}',
    '.sec-modal .shot-drop:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-soft);}',
    '.sec-modal .foot{display:flex;gap:9px;justify-content:flex-end;margin-top:16px;}',
    '.sec-modal .foot button{padding:9px 16px;border-radius:10px;border:1px solid var(--line);background:#fff;color:var(--ink-soft);font-size:13px;font-weight:650;cursor:pointer;}',
    '.sec-modal .foot .primary{background:var(--accent);border-color:var(--accent);color:#fff;}',
    '.sec-bout{margin-top:7px;max-height:150px;overflow:auto;font-size:11px;color:var(--ink-soft);background:var(--surface-2);border:1px solid var(--line);border-radius:9px;padding:8px;line-height:1.5;white-space:pre-wrap;word-break:break-word;}',
    '.sec-bhint{font-size:10px;color:var(--ink-faint);margin-top:5px;line-height:1.5;}',
    '.sec-modal .shot-thumbs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px;}',
    '.sec-modal .shot-thumb{position:relative;width:70px;height:70px;border:1px solid var(--line);border-radius:9px;overflow:hidden;flex:none;background:#fff;}',
    '.sec-modal .shot-thumb img{width:100%;height:100%;object-fit:cover;display:block;}',
    '.sec-modal .shot-thumb .rm{position:absolute;top:2px;right:2px;width:18px;height:18px;border:none;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font-size:11px;line-height:1;cursor:pointer;padding:0;}',
    '.sec-modal .shot-add{display:inline-flex;align-items:center;gap:5px;padding:6px 11px;border:1px dashed var(--line);border-radius:9px;color:var(--ink-faint);font-size:12px;cursor:pointer;margin-bottom:10px;}',
    '.sec-modal .shot-add:hover{border-color:var(--accent);color:var(--accent);}',
    '.sec-modal .shot-state{font-size:12px;color:var(--ink-faint);min-height:18px;line-height:1.5;margin-bottom:6px;}',
    '.sec-modal .shot-results{display:flex;flex-direction:column;gap:8px;margin-bottom:8px;}',
    '.sec-modal .shot-ev{border:1px solid var(--line);border-radius:11px;padding:9px 10px;background:var(--surface-2);}',
    '.sec-modal .shot-ev .g{display:flex;gap:6px;margin-bottom:6px;}',
    '.sec-modal .shot-ev .g input{flex:1;min-width:0;}',
    '.sec-modal .shot-ev .g .lbl{flex:none;font-size:10.5px;color:var(--ink-faint);align-self:center;width:22px;}',
    '.sec-modal .shot-ev .acts{display:flex;gap:6px;justify-content:flex-end;}',
    '.sec-modal .shot-ev .acts button{padding:6px 13px;border-radius:8px;border:1px solid var(--line);background:#fff;color:var(--ink-soft);font-size:12px;cursor:pointer;}',
    '.sec-modal .shot-ev .acts .add{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:650;}',
    '.sec-modal .shot-ev .acts .add.on{opacity:.5;cursor:default;}',
    '.sec-modal .shot-ev.added{border-color:#1d9e75;background:#eefaf3;}',
    '.sec-modal .shot-bar{display:flex;gap:6px;margin-bottom:10px;}',
    '.sec-modal .shot-bar button{flex:1;padding:7px 10px;border-radius:9px;border:1px solid var(--line);background:#fff;color:var(--ink-soft);font-size:12px;cursor:pointer;}',
    '.sec-modal .shot-bar .primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:650;}',
    '.sec-modal .divider{border:none;border-top:1px dashed var(--line);margin:12px 0;}',
    '.sec-modal .agenda-prev{font-size:11px;color:var(--ink-soft);background:var(--surface-2);border-radius:7px;padding:6px 8px;margin-bottom:6px;line-height:1.5;word-break:break-all;}',
    '.sec-modal .dup-warn{font-size:11px;color:#b45309;background:#fff7e6;border:1px solid #f6d9a0;border-radius:7px;padding:6px 8px;margin-bottom:6px;line-height:1.5;word-break:break-all;}',
    '.sec-modal .src-text{font-size:11px;color:var(--ink-soft);background:var(--surface-2);border-left:2px solid var(--accent);border-radius:7px;padding:6px 8px;margin-bottom:6px;line-height:1.6;word-break:break-word;max-height:96px;overflow-y:auto;white-space:pre-wrap;}',
    '.sec-modal .src-text .src-label{display:block;font-size:10px;font-weight:700;color:var(--accent);margin-bottom:2px;}',
    '.sec-modal .shot-ev .acts .add.merge{opacity:1;cursor:pointer;background:var(--accent-soft,#eef3ff);border-color:var(--accent);color:var(--accent);}',
    '.sec-panel.drag-over{outline:2px dashed var(--accent);outline-offset:-2px;background:var(--accent-soft);}',
    '.sec-modal.drag-over{outline:3px dashed var(--accent);outline-offset:-4px;}',
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
      '</span>' +
    '</div>' +
    '<div class="sec-body" id="secBody">' +
      '<div class="sec-sec"><label>随时告诉秘书你的想法</label>' +
        '<textarea id="secThought" placeholder="例如：下周有个报告要交，帮我盯着点"></textarea>' +
        '<div class="sec-row"><button class="sec-btn" id="secRemember">记住</button></div>' +
        '<div class="sec-chat" id="secChat"></div></div>' +
      '<div class="sec-sec"><label>日程 · 提醒</label><div class="sec-list" id="secEvents"></div>' +
        '<div class="sec-row"><button class="sec-btn" id="secFromShot" style="flex:1">' + iconSvg('camera') + ' 识别日程（图片＋链接）</button></div>' +
        '<div class="sec-row"><button class="sec-btn ghost" id="secAddEvent">＋ 手动添加</button>' +
        '<button class="sec-btn ghost" id="secSyncCal" style="flex:1">' + iconSvg('calendar') + ' 同步日历</button></div></div>' +
      '<div class="sec-sec"><label>邮件 · 分类 + 重要提醒</label><div class="sec-list" id="secEmails"></div>' +
        '<div class="sec-row"><button class="sec-btn ghost" id="secAddEmail">＋ 导入邮件</button>' +
        '<button class="sec-btn ghost" id="secSyncMail" style="flex:1">' + iconSvg('mail') + ' 同步 Outlook</button></div>' +
        '<div class="sec-row"><button class="sec-btn" id="secScanMail" style="flex:1">' + iconSvg('sparkles') + ' 扫描邮件 · 识别活动</button></div>' +
        '<div class="sec-row"><button class="sec-btn" id="secReadOutlook" style="flex:1">' + iconSvg('mail') + ' 读取本周 Outlook 邮件 · 识别活动</button></div>' +
        '<div class="sec-bout" id="secMailOut" hidden></div>' +
        '<div class="sec-bout" id="secOutlookOut" hidden></div></div>' +
      '<div class="sec-sec"><label>短信 · 确认信息</label>' +
        '<div class="sec-row"><button class="sec-btn" id="secReadSms" style="flex:1">' + iconSvg('message') + ' 读取短信 · 识别活动</button></div>' +
        '<div class="sec-bout" id="secSmsOut" hidden></div>' +
        '<div class="sec-bhint">读取本机 iMessage / 短信，识别「报名成功 / 已预订 / 出票」等确认信息并帮你加日程（需授权「完全磁盘访问权限」）。</div></div>' +
      '<div class="sec-sec"><label>知识库</label>' +
        '<div class="sec-row"><button class="sec-btn ghost" id="secNotion" style="flex:1">' + iconSvg('book') + ' 打开知识库（Notion · Obsidian）</button></div>' +
        '<div class="sec-bout" id="secNotionOut" hidden></div>' +
        '<div class="sec-row"><button class="sec-btn ghost" id="secPerm" style="flex:1">' + iconSvg('lock') + ' 系统权限自检</button></div>' +
        '<div class="sec-bout" id="secPermOut" hidden></div></div>' +
      '<div class="sec-sec"><label>浏览器自动化 · 只读</label>' +
        '<div class="sec-row"><input type="text" id="secUrl" placeholder="粘贴网址，如 https://arxiv.org/abs/..." style="flex:1">' +
        '<button class="sec-btn" id="secBrowse">打开</button></div>' +
        '<div class="sec-row"><button class="sec-btn ghost" id="secBrowseShot">' + iconSvg('camera') + ' 截图</button>' +
        '<button class="sec-btn ghost" id="secBrowseText">提取文本</button></div>' +
        '<div class="sec-bout" id="secBrowseOut" hidden></div>' +
        '<div class="sec-bhint">只读：打开网页 / 截图 / 取文本 · 不绕过验证码与登录</div></div>' +
    '</div>';
  var dock = document.getElementById('residentDock');
  (dock || document.body).appendChild(panel);

  var modalMask = document.createElement('div');
  modalMask.id = 'secModalMask';
  document.body.appendChild(modalMask);

  var fileInput = document.createElement('input');
  fileInput.type = 'file'; fileInput.accept = 'image/*'; fileInput.multiple = true; fileInput.style.display = 'none';
  document.body.appendChild(fileInput);

  /* 左侧导航入口：滚动定位到常驻面板 + 高亮 */
  var nav = document.getElementById('navSecretary');
  if (nav) {
    nav.addEventListener('click', function () {
      if (typeof window.__setActiveNav === 'function') window.__setActiveNav('navSecretary');
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      panel.classList.add('flash');
      setTimeout(function () { panel.classList.remove('flash'); }, 1000);
    });
  }

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

  /* ---------- 事件 ---------- */
  document.getElementById('secMin').addEventListener('click', function () {
    minimized = !minimized;
    document.getElementById('secBody').classList.toggle('hide', minimized);
    this.textContent = minimized ? '＋' : '—';
  });

  /* 想法：记住 / 分配 */
  function currentThought() { return document.getElementById('secThought').value.trim(); }
  document.getElementById('secRemember').addEventListener('click', function () {
    var t = currentThought();
    if (!t) return;
    thoughts.add(t);
    document.getElementById('secThought').value = '';
    renderChat();
    addChat('a', '已记住。');
  });
  function addChat(who, text) {
    var box = document.getElementById('secChat');
    if (!box) return;
    box.innerHTML += '<div><span class="' + who + '">' + (who === 'a' ? '秘书：' : '你：') + '</span>' + esc(text) + '</div>';
    box.scrollTop = box.scrollHeight;
  }

  /* 添加日程 */
  document.getElementById('secAddEvent').addEventListener('click', function () { openEventModal(null); });

  /* 发截图 → 自动识别日程（支持多选文件 + ⌘V 粘贴追加，多图可辅助识别同一条日程） */
  document.getElementById('secFromShot').addEventListener('click', function () {
    shotDataUrls = [];
    shotEvents = [];
    openEventModal(null, true);
  });

  /* 抓取多个链接正文 → 提取日程（统一识别入口使用） */
  function fetchLinksAndExtract(links) {
    if (!links || !links.length) return Promise.resolve([]);
    if (!window.ingrid || !window.ingrid.webFetch) return Promise.resolve([]);
    return Promise.all(links.map(function (u) {
      return window.ingrid.webFetch({ url: u }).then(function (r) {
        return (r && r.ok) ? ((r.title ? r.title + '\n' : '') + r.content) : '';
      }).catch(function () { return ''; });
    })).then(function (parts) {
      var text = parts.join('\n\n---\n\n');
      if (!text.trim()) return [];
      return extractEventsFromText(text);
    });
  }

  /* ---------- 本地语义去重：标题归一化 + 相似度 + 时间窗（免费、确定性兜底） ---------- */
  // 归一化：只保留字母数字与汉字，统一小写（用于「包含关系」判断，不改原始标题）
  function normTitle(t) {
    return String(t || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '');
  }
  // 提取关键词：英文按词（保留词边界）、中文按连续汉字串的 bigram（避免单字误判）
  function titleTokens(t) {
    var s = String(t || '').toLowerCase();
    var out = [];
    var latin = s.match(/[a-z0-9]+/g) || [];
    out = out.concat(latin);
    var han = s.match(/[\u4e00-\u9fa5]+/g) || [];
    han.forEach(function (h) {
      if (h.length <= 2) { out.push(h); return; }
      for (var k = 0; k < h.length - 1; k++) out.push(h.slice(k, k + 2));
    });
    return out;
  }
  // 标题相似度 0~1：完全相等 / 互相包含 = 1；否则用 token 覆盖度（公共 token / 较短标题 token 数）
  function titleSimilarity(a, b) {
    var A = normTitle(a), B = normTitle(b);
    if (!A || !B) return 0;
    if (A === B) return 1;
    if (A.indexOf(B) >= 0 || B.indexOf(A) >= 0) return 1;
    var ta = titleTokens(A), tb = titleTokens(B);
    if (!ta.length || !tb.length) return 0;
    var setA = {}, setB = {}, common = 0;
    ta.forEach(function (x) { setA[x] = 1; });
    tb.forEach(function (x) { setB[x] = 1; });
    Object.keys(setA).forEach(function (x) { if (setB[x]) common++; });
    return common / Math.min(Object.keys(setA).length, Object.keys(setB).length);
  }
  // 两个事件是否「疑似重复」：标题语义相似（≥0.6）+ 时间接近（同一天 ± 90 分钟；缺时间则只看标题）
  function eventsSimilar(aTitle, aAt, bTitle, bAt) {
    // 时间槽强匹配：同一天且开始时间几乎相同（≤5 分钟）→ 直接判同一活动，越过标题。
    // 这是最强也最安全的重复信号——同一时间你不可能同时出现在两个活动。
    // 它能救「活动全称 vs 主题口号」这类字面零重叠的同义标题（如「与光同行·信则将至」=「光尘杯青年领袖峰会」）。
    if (aAt && bAt) {
      var ta0 = new Date(aAt), tb0 = new Date(bAt);
      if (isFinite(ta0.getTime()) && isFinite(tb0.getTime()) &&
          ta0.toDateString() === tb0.toDateString() &&
          Math.abs(ta0.getTime() - tb0.getTime()) <= 5 * 60000) return true;
    }
    if (titleSimilarity(aTitle, bTitle) < 0.6) return false;
    if (!aAt || !bAt) return true;
    var ta = new Date(aAt), tb = new Date(bAt);
    if (!isFinite(ta.getTime()) || !isFinite(tb.getTime())) return true;
    if (ta.toDateString() !== tb.toDateString()) return false;
    return Math.abs(ta.getTime() - tb.getTime()) <= 90 * 60000;
  }

  /* 合并多个识别结果列表：标题语义相似 + 时间接近 判重，字段取更完整的 */
  function mergeEventLists(lists) {
    var out = [];
    (lists || []).forEach(function (l) {
      (l || []).forEach(function (ev) {
        var dup = null;
        for (var i = 0; i < out.length; i++) {
          if (eventsSimilar(out[i].title, out[i].at, ev.title, ev.at)) { dup = out[i]; break; }
        }
        if (dup) {
          // 标题取更完整（更长）的，其余字段逐项补空
          if (String(ev.title || '').length > String(dup.title || '').length) dup.title = ev.title;
          if (!dup.location && ev.location) dup.location = ev.location;
          if (!dup.link && ev.link) dup.link = ev.link;
          if (!dup.note && ev.note) dup.note = ev.note;
          if (!dup.end && ev.end) dup.end = ev.end;
          if (!dup.sourceText && ev.sourceText) dup.sourceText = ev.sourceText;
          if (!(dup.agenda && dup.agenda.length) && (ev.agenda && ev.agenda.length)) dup.agenda = ev.agenda;
        } else {
          out.push(ev);
        }
      });
    });
    return out;
  }

  /* 统一识别：图片（视觉模型）+ 链接（抓正文 + 文本模型）→ 合并去重 */
  function recognizeUnified(dataUrls, links, onProgress) {
    var tasks = [];
    if (dataUrls && dataUrls.length) tasks.push(recognizeShot(dataUrls, onProgress));
    if (links && links.length) tasks.push(fetchLinksAndExtract(links));
    if (!tasks.length) return Promise.resolve([]);
    return Promise.all(tasks).then(mergeEventLists);
  }

  /* 判定一封邮件是否含「确认信息」（活动报名 / 会议 / 票务 / 预订 / 注册等） */
  function isConfirmationEmail(m) {
    var blob = ((m.subject || '') + ' ' + (m.body || '')).toLowerCase();
    var words = ['确认', '报名成功', '已报名', '已预订', '预订成功', '注册成功', '已注册', '出票', '已出票', '订单', '预约成功',
      'confirmation', 'confirmed', 'booking', 'reservation', 'rsvp', 'ticket', 'boarding', 'registration', '您已成功', '席位', '名额', '参会', '邀请函'];
    return words.some(function (w) { return blob.indexOf(w) >= 0; });
  }

  /* 判定一条短信是否含「活动确认」信息（报名 / 预订 / 出票 / 预约等）。过滤只决定「是否送去识别」，不决定是否添加，
   * 因此关键词可略宽，误送的多余短信识别不出日程自然被丢弃。 */
  function isConfirmationMessage(m) {
    var blob = String((m && m.text) || '').toLowerCase();
    var words = ['报名成功', '已报名', '已预订', '预订成功', '预约成功', '已预约', '注册成功', '已注册', '出票', '已出票',
      '订单', '确认', '已确认', '席位', '名额', '参会', '邀请函', '您已成功', '订了', '订好',
      'confirmation', 'confirmed', 'booking', 'reservation', 'rsvp', 'ticket', 'boarding', 'registration'];
    return words.some(function (w) { return blob.indexOf(w) >= 0; });
  }

  /* 扫描邮件里的确认信息 → 提取日程 → 弹确认 + 通知（用日程去重防重复添加）。
   * silent=true 时（自动同步触发）无结果不刷屏，只提示发现的新日程。 */
  document.getElementById('secScanMail').addEventListener('click', function () { scanEmailsForEvents(false); });
  function scanEmailsForEvents(silent) {
    var out = document.getElementById('secMailOut');
    function show(msg, isErr) {
      if (out) { out.hidden = false; out.innerHTML = (isErr ? '⚠️ ' : '') + esc(msg); }
    }
    if (!emails.emails || !emails.emails.length) {
      show('还没有邮件可扫描。请先点「同步 Outlook」拉取邮箱，或点「＋ 导入邮件」粘贴一封邮件。', true);
      if (!silent) addChat('a', '暂无邮件。可先「同步 Outlook」或「导入邮件」。');
      return;
    }
    var candidates = emails.emails.filter(isConfirmationEmail);
    if (!candidates.length) {
      show('已扫描 ' + emails.emails.length + ' 封邮件，未发现报名 / 预订 / 出票等「确认信息」。');
      if (!silent) addChat('a', '未在邮件里发现「确认信息」类内容。');
      return;
    }
    var text = candidates.slice(0, 12).map(function (m) {
      return '【' + (m.fromName || m.from || '') + '】' + m.subject + '\n' + m.body;
    }).join('\n\n---\n\n');
    show('发现 ' + candidates.length + ' 封确认类邮件，正在识别日程…');
    if (!silent) addChat('a', '发现 ' + candidates.length + ' 封确认类邮件，正在识别日程…');
    extractEventsFromText(text).then(function (list) {
      if (!list.length) { show('扫描了确认邮件，未识别出明确日程。'); if (!silent) addChat('a', '扫描了确认邮件，未识别出明确日程。'); return; }
      show('识别出 ' + list.length + ' 条日程，请在弹出的确认框里核对。');
      notifyConfirm(list, '邮件确认');
      openConfirmEvents(list, '邮件确认', (candidates[0] && candidates[0].link) || '');
    });
  }

  /* 读取本机短信（macOS Messages 数据库），扫描确认信息 → 提取日程 → 确认 */
  document.getElementById('secReadSms').addEventListener('click', readSmsAndScan);
  function readSmsAndScan() {
    var out = document.getElementById('secSmsOut');
    if (!DESKTOP || !window.ingrid || !window.ingrid.messagesRead) {
      out.hidden = false; out.textContent = '读取短信仅支持桌面版（macOS）。';
      return;
    }
    var btn = document.getElementById('secReadSms');
    btn.disabled = true; btn.textContent = '读取中…';
    out.hidden = false; out.textContent = '正在读取本机短信…';
    window.ingrid.messagesRead({ limit: 60 }).then(function (r) {
      btn.disabled = false; btn.textContent = '读取短信 · 识别活动';
      if (!r || !r.ok) {
        out.innerHTML = '⚠️ ' + esc((r && r.error) || '读取失败') +
          '<br><span style="font-size:10px;color:var(--ink-faint)">若提示无权限，请到 系统设置 → 隐私与安全性 → 完全磁盘访问，添加本应用并勾选，然后 ⌘Q 完全退出再重启。</span>';
        return;
      }
      var msgs = r.messages || [];
      if (!msgs.length) { out.textContent = '未读到短信（可能权限不足或暂无短信）。'; return; }
      var candidates = msgs.filter(isConfirmationMessage);
      if (!candidates.length) { out.textContent = '读完 ' + msgs.length + ' 条短信，未发现活动确认信息。'; addChat('a', '读完短信，未发现活动确认信息。'); return; }
      out.textContent = '读到 ' + msgs.length + ' 条短信，发现 ' + candidates.length + ' 条确认信息，正在识别…';
      // 逐条识别确认类短信：每条日程都附上原始短信内容（发送人 + 时间 + 正文）作为核对参考
      var tasks = candidates.slice(0, 12).map(function (m) {
        var srcText = '【' + (m.from || '') + ' ' + (m.dateText || '') + '】' + m.text;
        return extractEventsFromText(srcText).then(function (list) {
          (list || []).forEach(function (ev) { ev.sourceText = srcText; });
          return list;
        });
      });
      Promise.all(tasks).then(function (lists) {
        var merged = mergeEventLists(lists);
        if (!merged.length) { out.textContent = '读完短信，未发现活动确认信息。'; addChat('a', '读完短信，未发现活动确认信息。'); return; }
        out.textContent = '';
        notifyConfirm(merged, '短信确认');
        openConfirmEvents(merged, '短信确认', '');
      });
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = '读取短信 · 识别活动';
      out.textContent = '读取失败：' + (e && e.message || e);
    });
  }

  /* 读取本机 Outlook 邮件（AppleScript，绕开 OAuth），扫描确认信息 → 提取日程 → 确认 */
  document.getElementById('secReadOutlook').addEventListener('click', readOutlookAndScan);
  function readOutlookAndScan() {
    var out = document.getElementById('secOutlookOut');
    if (!DESKTOP || !window.ingrid || !window.ingrid.outlookMailRead) {
      out.hidden = false; out.textContent = '读取本机 Outlook 仅支持桌面版（macOS）。';
      return;
    }
    var btn = document.getElementById('secReadOutlook');
    btn.disabled = true; btn.textContent = '读取中…';
    out.hidden = false; out.textContent = '正在读取本机 Outlook 最近一周的邮件…';
    window.ingrid.outlookMailRead().then(function (r) {
      btn.disabled = false; btn.textContent = '读取本周 Outlook 邮件 · 识别活动';
      if (!r || !r.ok) {
        out.innerHTML = '⚠️ ' + esc((r && r.error) || '读取失败') +
          '<br><span style="font-size:10px;color:var(--ink-faint)">首次使用需在 macOS 弹窗里点「允许」控制 Microsoft Outlook；若之前拒绝过，到 系统设置 → 隐私与安全性 → 自动化 里勾选本应用。</span>';
        return;
      }
      var mails = r.mails || [];
      if (!mails.length) {
        var total = r.total || 0;
        var acc = r.account || '';
        if (total === 0) {
          out.textContent = acc
            ? '剑桥账号 ' + acc + ' 的收件箱为空（可能邮件未同步到本机 Outlook，或该账号收件箱无邮件）。'
            : '读不到剑桥邮件。请先在 Outlook 里点选剑桥收件箱（Inbox），再点一次本按钮重试。';
          if (r.diag) out.innerHTML += '<br><span style="font-size:10px;color:var(--ink-faint)">诊断：' + esc(r.diag) + '</span>';
        } else { out.textContent = '收件箱共 ' + total + ' 封，但最近一周没有新邮件。'; }
        addChat('a', '读完 Outlook 邮件，未发现活动确认信息。');
        return;
      }
      var candidates = mails.filter(isConfirmationEmail);
      if (!candidates.length) { out.textContent = '读完最近一周 ' + mails.length + ' 封邮件，未发现活动确认信息。'; addChat('a', '读完 Outlook 邮件，未发现活动确认信息。'); return; }
      out.textContent = '最近一周共 ' + mails.length + ' 封邮件，筛选出 ' + candidates.length + ' 封确认类，正在识别…';
      // 逐封识别确认类邮件：每条日程附上原始邮件（发件人+主题+正文）作为核对参考
      var tasks = candidates.slice(0, 12).map(function (m) {
        var srcText = '【' + (m.from || '') + '】' + m.subject + '\n' + m.body;
        return extractEventsFromText(srcText).then(function (list) {
          (list || []).forEach(function (ev) { ev.sourceText = srcText; });
          return list;
        });
      });
      Promise.all(tasks).then(function (lists) {
        var merged = mergeEventLists(lists);
        if (!merged.length) { out.textContent = '读完 Outlook 邮件，未发现明确日程。'; addChat('a', '读完 Outlook 邮件，未发现明确日程。'); return; }
        out.textContent = '';
        notifyConfirm(merged, 'Outlook 邮件');
        openConfirmEvents(merged, 'Outlook 邮件', '');
      });
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = '读取本周 Outlook 邮件 · 识别活动';
      out.textContent = '读取失败：' + (e && e.message || e);
    });
  }

  /* 追加一组图片（去重）并重新打开弹窗触发识别 */
  function appendShotsAndRerun(urls) {
    (urls || []).forEach(function (u) { if (u && shotDataUrls.indexOf(u) < 0) shotDataUrls.push(u); });
    shotEvents = [];
    openEventModal(null, true);
  }

  /* 选文件（支持多选） */
  fileInput.addEventListener('change', function () {
    var files = fileInput.files;
    if (!files || !files.length) return;
    var list = Array.prototype.slice.call(files);
    var pending = list.length, urls = [];
    list.forEach(function (f) {
      var reader = new FileReader();
      reader.onload = function () {
        urls.push(reader.result);
        if (--pending === 0) { appendShotsAndRerun(urls); fileInput.value = ''; }
      };
      reader.readAsDataURL(f);
    });
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

  /* 用视觉模型识别多张截图中的日程（可多条），返回 [{ title, at, location, link, note }]。
   * 视觉模型只负责「提取原文 + 语义分组」，日期/年份换算交给本地 parseEventDateTime，保证不会推到过去。 */
  function recognizeShot(dataUrls, onProgress) {
    return new Promise(function (resolve, reject) {
      if (!DESKTOP || !window.ingrid || !window.ingrid.chatStream) { reject(new Error('仅桌面应用支持识图')); return; }
      var now = new Date();
      var today = now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日（星期' + '日一二三四五六'[now.getDay()] + '）';
      var content = [{ type: 'text', text:
        '今天是 ' + today + '。你是日程识别助手。请识别下面这些截图里的所有日程信息。' +
        '这些截图可能是同一个活动的多张截图（信息互补），也可能是多个不同活动的截图，或一张图里包含多个不同日程。' +
        '\n\n只输出一个 JSON 数组，不要输出任何其他文字、解释或 markdown 代码块。数组每一项是一条日程，格式严格为：' +
        '{"title":"标题","dateText":"日期原文","timeText":"开始时间原文","endTimeText":"结束时间原文","location":"地点","link":"链接","note":"备注","agenda":[{"timeText":"时间原文","title":"议程项"}]}。' +
        '\n\n规则：' +
        '\n1) 逐张识别：每一张截图里的每个日程都要识别出来，不要漏掉任何一张。' +
        '\n2) 多张截图若是同一个活动（如邮件正文+日历+海报描述同一件事），合并为一条，字段取最完整的。' +
        '\n2.1) 【重要】同一个活动即使标题措辞不同（如活动全称 vs 主题口号、简称 vs 全称），只要时间地点一致，就必须合并成一条，输出最完整、最正式的标题，绝不允许把同一活动拆成多条。' +
        '\n3) 不同的活动——无论出现在同一张图里还是不同的多张图里——都要分别输出为独立的多条。' +
        '\n3.1) 【关键】每条日程的日期时间只能来自它自己所在的那张截图，绝不能把一张图的日期/时间安到另一张图的活动上（例如把海报的结束时间「20:00」当成短信预约的时间、把海报日期安到短信预约上）。' +
        '\n4) dateText / timeText / endTimeText 必须原样保留截图里的原始文字（如「11月29日」「下周三」「下午3点」「15:30」「Nov 29」「9am」「17:00」），绝对不要换算成日期、不要猜测年份。' +
        '\n4.1) dateText 只填「活动举办日期」；报名截止、简餐/票务预留截止、早鸟价截止、材料提交截止等日期都不是活动日期，不要填进 dateText（可放进 note）。' +
        '\n4.2) 【关键】若截图没有明确写出「活动举办的日期」，dateText 留空字符串，绝不要填「今天」、绝不要猜日期（如 12/20）。' +
        '\n4.3) 【关键】英文日期必须逐字符精确读取，数字严格对应：如「03 Dec 2026」的日就是 03、「26 Nov 2026」的日就是 26，绝不要把 03 读成 20、把 26 读成别的数字，也不要把 Nov 和 Dec 混淆。' +
        '\n5) timeText 填开始时间；endTimeText 填结束时间。若截图只给一段「15:00-17:00」，则 timeText 取「15:00」、endTimeText 取「17:00」；没有结束时间就留空。' +
        '\n5.1) 【关键】若截图没有明确写出「活动开始的时间」，timeText 留空字符串，绝不要编造 09:00、12:00 这类默认时间。「预约提醒 / 通知 / 温馨提示 / 提醒」这类文字通常不含具体活动日期和时间，此时 dateText 与 timeText 都应留空，宁可留空让用户手动补，也不要编造。' +
        '\n6) 若截图里有活动的详细议程/时间表（多个「时间+事项」，如「9:00 签到」「10:30 主题演讲」），逐项提取到 agenda 数组（每项 timeText 保留原始时间写法、title 为该议程项标题）；没有议程就输出空数组 []。' +
        '\n7) 地点/链接/备注从截图提取，没有就留空字符串。' +
        '\n8) 标题简短准确，去掉「邀请函」「通知」等装饰词。' +
        '\n9) 【关键】「预约取消提醒」「请勿前往诊所」「请致电取消预约」这类短信（含 cancel / do not wish / 请勿前往 / 取消预约 等）不是预约日程，不要输出为日程；只有真正有明确日期时间的预约、报名、出票、会议、活动才输出。' }];
      (dataUrls || []).forEach(function (u) { content.push({ type: 'image_url', image_url: { url: u } }); });
      var msgs = [{ role: 'user', content: content }];
      // 引擎优先级：DeepSeek（deepseek-flash 已支持图片、语义分组强、重复少）→ 本地视觉模型兜底
      var engines = [
        { engine: 'deepseek', model: 'deepseek-flash' },
        { engine: 'ollama-vision', model: 'qwen2.5vl:7b' },
      ];
      (function attempt(i) {
        if (i >= engines.length) { reject(new Error('识图失败（DeepSeek 与本地视觉模型均不可用），可在下方手动填写')); return; }
        var out = '';
        window.ingrid.chatStream({ engine: engines[i].engine, model: engines[i].model, messages: msgs, sessionId: 'sec-shot' }, {
          onDelta: function (chunk) { if (chunk && chunk.text) { out += chunk.text; if (onProgress) onProgress(out); } },
          onDone: function (d) {
            if (!d || !d.ok) { attempt(i + 1); return; }
            var m = out.match(/\[[\s\S]*\]/);
            if (!m) { attempt(i + 1); return; }
            try {
              var arr = JSON.parse(m[0]);
              if (!Array.isArray(arr) || !arr.length) { attempt(i + 1); return; }
              var list = arr.map(function (j) {
                var endText = String(j.endTimeText || '').trim();
                var ag = Array.isArray(j.agenda) ? j.agenda.map(function (a) {
                  return { timeText: String((a && a.timeText) || '').trim(), title: String((a && a.title) || '').trim() };
                }).filter(function (a) { return a.title || a.timeText; }) : [];
                return {
                  title: String(j.title || '').trim(),
                  at: parseEventDateTime(j.dateText, j.timeText, now),
                  end: endText ? parseEventDateTime(j.dateText, endText, now) : '',
                  location: String(j.location || '').trim(),
                  link: String(j.link || '').trim(),
                  note: String(j.note || '').trim(),
                  dateText: String(j.dateText || '').trim(),
                  timeText: String(j.timeText || '').trim(),
                  endTimeText: endText,
                  agenda: ag,
                };
              }).filter(function (e) { return (e.title || e.at) && !isCancellationNotice(e); });
              if (!list.length) { attempt(i + 1); return; }
              resolve(list);
            } catch (e) { attempt(i + 1); }
          },
        });
      })(0);
    });
  }

  /* 本地确定性解析「日期原文 + 时间原文」→ ISO 字符串。基准 now，推断「最近未来」，绝不落到过去。 */
  function parseEventDateTime(dateText, timeText, now) {
    var base = now || new Date();
    var dt = String(dateText || '').replace(/\s+/g, ' ').trim();
    var date = null;
    var m;

    // 既无日期原文也无时间原文 → 时间待定，返回空（绝不捏造「今天 09:00」这类默认时间）
    if (!dt && !String(timeText || '').trim()) return '';

    if (!dt) {
      date = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    } else if (/今天|今日|tonight/i.test(dt)) {
      date = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    } else if (/明天|明日|tomorrow/i.test(dt)) {
      date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1);
    } else if (/后天/i.test(dt)) {
      date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 2);
    } else if (/大后天/i.test(dt)) {
      date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + 3);
    } else if ((m = dt.match(/周([一二三四五六日天])/)) || (m = dt.match(/星期([一二三四五六日天])/)) || (m = dt.match(/(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)/i))) {
      var DOW = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 0, '天': 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0 };
      var key = m[1];
      if (/mon|tue|wed|thu|fri|sat|sun/i.test(key)) key = key.toLowerCase().slice(0, 3);
      var target = DOW[key];
      var cur = base.getDay();
      var diff = (target - cur + 7) % 7;
      if (diff === 0) diff = 7;             // 本周当天已过 → 下同星期
      date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + diff);
      if (/下|next/i.test(dt)) date = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7);
    } else if ((m = dt.match(/(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(\s+\d{4})?/i))) {
      // 日 月 [年]："03 Dec 2026" / "3rd Dec 2026" / "26 Nov"。必须放在「月 日」之前，
      // 否则 "03 Dec 2026" 会被「月 日」正则误匹配成 "Dec 20"（把年份 2026 前两位当日期）。
      var MON_DF = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      var yrDF = m[3] ? Number(m[3].trim()) : base.getFullYear();
      date = new Date(yrDF, MON_DF.indexOf(m[2].toLowerCase().slice(0, 3)), Number(m[1]));
    } else if ((m = dt.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(\s+\d{4})?/i))) {
      // 月 日 [年]："Dec 03 2026" / "Dec 3"
      var MON_MF = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      var yrMF = m[3] ? Number(m[3].trim()) : base.getFullYear();
      date = new Date(yrMF, MON_MF.indexOf(m[1].toLowerCase().slice(0, 3)), Number(m[2]));
    } else if ((m = dt.match(/(\d{4})\s*[-/.]\s*(\d{1,2})\s*[-/.]\s*(\d{1,2})/))) {
      date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    } else if ((m = dt.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/))) {
      date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    } else if ((m = dt.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/))) {
      date = new Date(base.getFullYear(), Number(m[1]) - 1, Number(m[2]));
    } else if ((m = dt.match(/(\d{1,2})\s*[-/.]\s*(\d{1,2})(?!\d)/))) {
      var a = Number(m[1]), b = Number(m[2]);
      if (a > 12 && b <= 12) date = new Date(base.getFullYear(), b - 1, a);   // 英式 DD/MM
      else date = new Date(base.getFullYear(), a - 1, b);                      // MM/DD
    } else if ((m = dt.match(/(\d{1,2})\s*月/))) {
      date = new Date(base.getFullYear(), Number(m[1]) - 1, 1);
    }

    // 推断日期若已过去：无年份的（月日/星期）顺延一年，保证「最近未来」
    if (date && isFinite(date.getTime())) {
      var today0 = new Date(base.getFullYear(), base.getMonth(), base.getDate());
      if (date < today0) {
        if (!/\d{4}/.test(dt)) date = new Date(date.getFullYear() + 1, date.getMonth(), date.getDate());
        if (date < today0) date = today0;
      }
    }

    // ---- 时间 ----
    var hour = 9, minute = 0, hasTime = false;
    var tt = String(timeText || '').replace(/\s+/g, ' ').toLowerCase().trim();
    var tm;
    if (tt) {
      if ((tm = tt.match(/(\d{1,2})[:：](\d{1,2})\s*(am|pm)?/))) {
        hour = Number(tm[1]); minute = Number(tm[2]);
        if (tm[3] === 'pm' && hour < 12) hour += 12;
        if (tm[3] === 'am' && hour === 12) hour = 0;
        hasTime = true;
      } else if ((tm = tt.match(/(上午|下午|晚上|中午)?\s*(\d{1,2})\s*点\s*(半|(\d{1,2})\s*分)?/))) {
        hour = Number(tm[2]);
        if (tm[3] === '半') minute = 30; else if (tm[4]) minute = Number(tm[4]);
        if (tm[1] === '下午' || tm[1] === '晚上') hour = (hour % 12) + 12;
        else if (tm[1] === '上午') hour = hour % 12;
        else if (tm[1] === '中午') hour = 12;
        hasTime = true;
      } else if ((tm = tt.match(/(\d{1,2})(?::(\d{1,2}))?\s*(am|pm)/))) {
        hour = Number(tm[1]); minute = tm[2] ? Number(tm[2]) : 0;
        if (tm[3] === 'pm' && hour < 12) hour += 12;
        if (tm[3] === 'am' && hour === 12) hour = 0;
        hasTime = true;
      }
    }

    if (!date) return '';
    // 只给了时间没日期：若今天该时刻已过，顺延到明天
    if (!dt && hasTime) {
      var cand = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
      if (cand < base) date = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
    }
    date.setHours(hour, minute, 0, 0);
    return date.toISOString();
  }

  /* 判断一条识别结果是否是「取消/提醒」类通知（不是真正的日程），应过滤掉。
   * 典型：「预约取消提醒」「请勿前往诊所」「请致电取消预约」「Dear Patient...do not wish」等。 */
  function isCancellationNotice(ev) {
    var blob = String((ev.title || '') + ' ' + (ev.note || '') + ' ' + (ev.location || '')).toLowerCase();
    return /cancel|do not wish|do not attend|please do not|请勿前往|取消预约|致电取消|取消提醒|退订|unsubscribe/.test(blob);
  }

  /* 事件弹窗（新增日程 / 发截图自动识别：多图辅助一条 + 一图多日程 + 逐条核对） */
  function openEventModal(prefill, isShot) {
    var hint = prefill || {};
    modalMask.style.display = 'flex';
    var html =
      '<div class="sec-modal"><h3>' + (isShot ? iconSvg('camera') + ' 识别日程（图片＋链接）' : iconSvg('calendar') + ' 添加日程') + '</h3>' +
      '<div class="sub">' + (isShot ? '拖入 / 粘贴 / 选择截图，可同时粘贴活动链接；点「开始识别」一次性识别。同一活动的多张会合并，不同活动会分别列出；重复活动自动补全缺失信息、不重复添加。提示：短信 / 邮件这类文字截图，改用下方「读取短信」「扫描邮件」读原文会更准（看图识别数字偶尔会读错）。' : '保存后秘书会按提醒时间通知你。') + '</div>';
    if (isShot) {
      html += '<div class="shot-thumbs" id="evThumbs">' + shotDataUrls.map(function (u, i) {
        return '<div class="shot-thumb"><img src="' + u + '"><button class="rm" data-rm="' + i + '" title="移除">✕</button></div>';
      }).join('') + '</div>';
      html += '<span class="shot-add" id="evAddShot">' + iconSvg('camera') + ' 添加图片（也可直接拖入，或 ⌘V / Ctrl+V 粘贴）</span>';
      html += '<div class="f"><label>活动链接（可选，可多行多个）</label><textarea id="evLinks" rows="2" placeholder="https://...&#10;https://..."></textarea></div>';
      html += '<div class="shot-state" id="evShotState"></div>';
      html += '<div class="shot-bar"><button class="primary" id="evRecognize">' + iconSvg('sparkles') + ' 开始识别</button><button id="evAddAll">＋ 全部添加</button></div>';
      html += '<div class="shot-results" id="evResults"></div>';
      html += '<hr class="divider"><div class="sub" style="margin-bottom:8px">没有识别到、或想再补一条？手动填写：</div>';
    }
    html +=
      '<div class="f"><label>标题 *</label><input id="evTitle" value="' + esc(hint.title || '') + '"></div>' +
      '<div class="f"><label>时间 *</label><input type="datetime-local" id="evAt" value="' + esc(hint.atLocal || '') + '"></div>' +
      '<div class="f"><label>地点</label><input id="evLoc" value="' + esc(hint.location || '') + '"></div>' +
      '<div class="f"><label>链接</label><input id="evLink" value="' + esc(hint.link || '') + '"></div>' +
      '<div class="f"><label>备注</label><textarea id="evNote" rows="2">' + esc(hint.note || '') + '</textarea></div>' +
      '<div class="f"><label>提前提醒</label><select id="evRemind">' +
        '<option value="0">不提醒</option><option value="15">15 分钟</option><option value="60">1 小时</option><option value="1440" selected>1 天</option><option value="4320">3 天</option></select></div>' +
      '<div class="foot"><button id="evCancel">取消</button><button class="primary" id="evSave">' + (isShot ? '保存这一条' : '保存到日程') + '</button></div></div>';
    modalMask.innerHTML = html;

    var atInput = modalMask.querySelector('#evAt');
    if (!atInput.value) {
      var d = new Date(Date.now() + 3600000); d.setMinutes(0, 0, 0);
      atInput.value = toLocal(d);
    }
    modalMask.querySelector('#evCancel').addEventListener('click', closeModal);

    if (isShot) {
      // 缩略图删除
      var thumbs = modalMask.querySelector('#evThumbs');
      if (thumbs) {
        Array.prototype.forEach.call(thumbs.querySelectorAll('[data-rm]'), function (b) {
          b.addEventListener('click', function () {
            shotDataUrls.splice(Number(b.getAttribute('data-rm')), 1);
            shotEvents = [];
            openEventModal(null, true);
          });
        });
      }
      modalMask.querySelector('#evAddShot').addEventListener('click', function () { fileInput.click(); });
      modalMask.querySelector('#evAddAll').addEventListener('click', addAllShots);

      var stEl = modalMask.querySelector('#evShotState');
      var recognizeBtn = modalMask.querySelector('#evRecognize');
      recognizeBtn.addEventListener('click', function () {
        var linksRaw = ((modalMask.querySelector('#evLinks') || {}).value || '');
        var links = linksRaw.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(function (s) { return /^https?:\/\//.test(s); });
        if (!shotDataUrls.length && !links.length) { stEl.textContent = '💡 请先添加图片或粘贴链接，再开始识别。'; return; }
        recognizeBtn.disabled = true;
        stEl.textContent = '🔍 正在识别' + (shotDataUrls.length ? ' ' + shotDataUrls.length + ' 张截图' : '') + (links.length ? ' ＋ ' + links.length + ' 个链接' : '') + '…';
        recognizeUnified(shotDataUrls, links, function (stream) {
          stEl.textContent = '🔍 正在识别…（' + Math.min(stream.length, 40) + ' 字符）';
        }).then(function (list) {
          shotEvents = list;
          recognizeBtn.disabled = false;
          stEl.textContent = '✅ 识别出 ' + list.length + ' 条日程，请核对后逐条「＋ 添加」或「＋ 全部添加」。';
          renderShotResults();
        }).catch(function (e) {
          recognizeBtn.disabled = false;
          stEl.textContent = '⚠️ 识别失败：' + (e && e.message || e) + '（可在下方手动填写）';
          renderShotResults();
        });
      });
      if (shotDataUrls.length) {
        stEl.textContent = '📎 已添加 ' + shotDataUrls.length + ' 张截图，可继续粘贴链接，然后点「开始识别」。';
      } else {
        stEl.textContent = '💡 添加图片或粘贴链接后，点「开始识别」。';
      }
      renderShotResults();
    }

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
        source: isShot ? '截图识别' : '',
      });
      closeModal(); renderEvents();
      addChat('a', '已添加日程「' + title + '」，到点会提醒你。');
    });
  }

  /* 渲染识别出的日程结果（可编辑标题/起止时间/地点，逐条添加或忽略，重复项补全） */
  function renderShotResults() {
    var box = document.getElementById('evResults');
    var allBtn = document.getElementById('evAddAll');
    if (!box) return;
    if (!shotEvents.length) {
      if (allBtn) allBtn.style.display = 'none';
      box.innerHTML = '<div style="color:var(--ink-faint);font-size:12px;padding:2px 0;">暂无识别结果，可在下方手动添加。</div>';
      return;
    }
    if (allBtn) allBtn.style.display = '';
    box.innerHTML = shotEvents.map(function (ev, i) {
      var atLocal = '', endLocal = '';
      if (ev.at) { var dd = new Date(ev.at); if (isFinite(dd.getTime())) atLocal = toLocal(dd); }
      if (ev.end) { var de = new Date(ev.end); if (isFinite(de.getTime())) endLocal = toLocal(de); }
      var added = ev._added, merged = ev._merged;
      var existing = !added && !merged && ev.at ? findExistingEvent(ev.title, ev.at) : null;
      var nearDup = !existing && !added && !merged ? findNearDuplicate(ev.title, ev.at) : null;
      var nearText = '';
      if (nearDup) {
        var nd = nearDup.at ? new Date(nearDup.at) : null;
        nearText = esc(nearDup.title) + (nd && isFinite(nd.getTime())
          ? '（' + nd.getFullYear() + '/' + (nd.getMonth() + 1) + '/' + nd.getDate() + ' ' + (nd.getHours() < 10 ? '0' : '') + nd.getHours() + ':' + (nd.getMinutes() < 10 ? '0' : '') + nd.getMinutes() + '）'
          : '');
      }
      var ag = agendaPreview(ev.agenda);
      return '<div class="shot-ev' + (added || merged || existing ? ' added' : '') + '" data-i="' + i + '">' +
        '<div class="g"><span class="lbl">题</span><input class="e-title" value="' + esc(ev.title || '') + '" placeholder="标题"></div>' +
        '<div class="g"><span class="lbl">始</span><input class="e-at" type="datetime-local" value="' + esc(atLocal) + '">' +
        '<span class="lbl">终</span><input class="e-end" type="datetime-local" value="' + esc(endLocal) + '"></div>' +
        (!ev.at ? '<div class="dup-warn">⚠ 未识别到时间：请手动填写准确的日期时间，或点「忽略」跳过。</div>' : '') +
        '<div class="g"><span class="lbl">地</span><input class="e-loc" value="' + esc(ev.location || '') + '" placeholder="地点"></div>' +
        (ev.sourceText ? '<div class="src-text"><span class="src-label">📱 短信原文</span>' + esc(ev.sourceText) + '</div>' : '') +
        (nearDup ? '<div class="dup-warn">⚠ 疑似重复：日历已有「' + nearText + '」，请核对本条的日期时间。</div>' : '') +
        (ag ? '<div class="agenda-prev">' + esc(ag) + '</div>' : '') +
        '<div class="acts"><button class="skip" data-i="' + i + '">忽略</button>' +
        (existing
          ? '<button class="add on merge" data-i="' + i + '">⇄ 补全信息</button>'
          : (merged
            ? '<button class="add on" disabled>✓ 已补全</button>'
            : '<button class="add' + (added ? ' on' : '') + '" data-i="' + i + '">' + (added ? '✓ 已添加' : '＋ 添加') + '</button>')) +
        '</div></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.skip'), function (b) {
      b.addEventListener('click', function () {
        shotEvents.splice(Number(b.getAttribute('data-i')), 1);
        renderShotResults();
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('.add:not(.on):not(.merge)'), function (b) {
      b.addEventListener('click', function () {
        var i = Number(b.getAttribute('data-i'));
        var card = box.querySelector('.shot-ev[data-i="' + i + '"]');
        var title = ((card.querySelector('.e-title') || {}).value || '').trim();
        var at = (card.querySelector('.e-at') || {}).value || '';
        var endv = (card.querySelector('.e-end') || {}).value || '';
        var loc = ((card.querySelector('.e-loc') || {}).value || '').trim();
        if (!title) { alert('请填写标题'); return; }
        if (!at) { alert('请填写时间'); return; }
        var r = addEventSmart({
          title: title, at: new Date(at).toISOString(), end: endv ? new Date(endv).toISOString() : '',
          location: loc, link: shotEvents[i].link || '', note: shotEvents[i].note || '',
          agenda: shotEvents[i].agenda || [], reminderMin: 1440, source: '截图识别',
        });
        if (r.mode === 'added') { shotEvents[i]._added = true; addChat('a', '已添加日程「' + title + '」。'); }
        else if (r.mode === 'merged') { shotEvents[i]._merged = true; addChat('a', '「' + title + '」已存在，已补全缺失信息。'); }
        else { shotEvents[i]._merged = true; addChat('a', '「' + title + '」已存在且信息完整，未重复添加。'); }
        renderShotResults();
        renderEvents();
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('.add.merge'), function (b) {
      b.addEventListener('click', function () {
        var i = Number(b.getAttribute('data-i'));
        var card = box.querySelector('.shot-ev[data-i="' + i + '"]');
        var title = ((card.querySelector('.e-title') || {}).value || '').trim();
        var at = (card.querySelector('.e-at') || {}).value || '';
        var endv = (card.querySelector('.e-end') || {}).value || '';
        var loc = ((card.querySelector('.e-loc') || {}).value || '').trim();
        var existing = findExistingEvent(title, at ? new Date(at).toISOString() : '');
        var merged = mergeIntoExisting(existing, {
          location: loc, link: shotEvents[i].link || '', note: shotEvents[i].note || '',
          end: endv ? new Date(endv).toISOString() : '', agenda: shotEvents[i].agenda || [],
        });
        shotEvents[i]._merged = true;
        addChat('a', merged ? '已补全「' + title + '」的缺失信息。' : '「' + title + '」信息已完整，无需补全。');
        renderShotResults();
        renderEvents();
      });
    });
  }

  /* 一键添加全部识别结果（重复项自动补全，非重复项新增） */
  function addAllShots() {
    var box = document.getElementById('evResults');
    if (!box) return;
    var added = 0, merged = 0;
    Array.prototype.forEach.call(box.querySelectorAll('.shot-ev:not(.added)'), function (card) {
      var i = Number(card.getAttribute('data-i'));
      var title = ((card.querySelector('.e-title') || {}).value || '').trim();
      var at = (card.querySelector('.e-at') || {}).value || '';
      var endv = (card.querySelector('.e-end') || {}).value || '';
      var loc = ((card.querySelector('.e-loc') || {}).value || '').trim();
      if (!title || !at) return;
      var r = addEventSmart({
        title: title, at: new Date(at).toISOString(), end: endv ? new Date(endv).toISOString() : '',
        location: loc, link: shotEvents[i].link || '', note: shotEvents[i].note || '',
        agenda: shotEvents[i].agenda || [], reminderMin: 1440, source: '截图识别',
      });
      if (r.mode === 'added') { shotEvents[i]._added = true; added++; }
      else { shotEvents[i]._merged = true; merged++; }
    });
    var msg = [];
    if (added) msg.push('新增 ' + added + ' 条');
    if (merged) msg.push('补全 ' + merged + ' 条重复活动');
    if (msg.length) { renderShotResults(); renderEvents(); addChat('a', '已' + msg.join('、') + '。'); }
  }
  function toLocal(d) {
    var p = function (n) { return ('0' + n).slice(-2); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function closeModal() { modalMask.style.display = 'none'; modalMask.innerHTML = ''; shotDataUrls = []; shotEvents = []; }
  modalMask.addEventListener('click', function (e) { if (e.target === modalMask) closeModal(); });

  /* ============ 多来源「文本 → 日程」识别 + 统一确认弹窗 ============
   * 三种来源（链接 / 邮件 / 短信）都汇聚到同一套「提取 → 弹确认 → 用户核对 → 添加」流程。
   * 日期换算统一走 parseEventDateTime（模型只提取原文，本地确定性换算，绝不落到过去）。 */

  /* 本地确定性规则：从一段文字提取日程候选（LLM 不可用时的兜底，免费、可解释）。
     覆盖常见「确认信息」格式：报名/预订/注册成功、航班/车票/酒店、会议/讲座通知等。 */
  function parseEventsFromText(text, now) {
    var src = String(text || '');
    if (!src.trim()) return [];
    var base = now || new Date();
    var link = (src.match(/https?:\/\/[^\s"'<>]+/) || [''])[0];

    // 标题：优先「」/引号包裹，其次「报名/预订/确认/活动/会议」关键词后，最后取首行
    var title = '', m;
    if ((m = src.match(/「([^」]{2,40})」/)) || (m = src.match(/"([^"]{2,40})"/))) {
      title = m[1].trim();
    } else if ((m = src.match(/(?:已?(?:成功)?(?:报名|预订|预约|订购|注册|出票)|确认了?|您的订单|订了?)[：: ]*([^。，,;\n]{2,40})/))) {
      title = m[1].trim();
    } else if ((m = src.match(/(?:活动|会议|讲座|论坛|峰会|演出|航班|列车|酒店|餐厅|课程|比赛|答辩|组会)[：: ]*([^。，,;\n]{2,40})/))) {
      title = m[1].trim();
    }
    if (!title) {
      var lines = src.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
      title = (lines[0] || '').replace(/^[【\[（(].{0,20}[】\]）)]\s*/, '').slice(0, 40);
    }

    // 日期原文
    var dateText = '', dm;
    if ((dm = src.match(/\d{4}\s*[年/-]\s*\d{1,2}\s*[月/-]\s*\d{1,2}\s*[日号]?/))) dateText = dm[0];
    else if ((dm = src.match(/(今天|明天|后天|大后天|今日|明日)/))) dateText = dm[0];
    else if ((dm = src.match(/(?:下|本)?周[一二三四五六日天]|星期[一二三四五六日天]/))) dateText = dm[0];
    else if ((dm = src.match(/\d{1,2}\s*月\s*\d{1,2}\s*[日号]/))) dateText = dm[0];
    else if ((dm = src.match(/(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?/i))) dateText = dm[0];
    else if ((dm = src.match(/\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/i))) dateText = dm[0];
    else if ((dm = src.match(/\d{4}\s*[-/.]\s*\d{1,2}\s*[-/.]\s*\d{1,2}/))) dateText = dm[0];

    // 时间原文（开始/结束，支持「15:00-17:00」「下午2点-5点」）
    var timeText = '', endTimeText = '', tm;
    if ((tm = src.match(/(\d{1,2})[:：]\s*(\d{1,2})\s*(am|pm)?\s*[-—~至到]\s*(\d{1,2})[:：]\s*(\d{1,2})\s*(am|pm)?/i))) {
      timeText = tm[1] + ':' + tm[2] + (tm[3] || '');
      endTimeText = tm[4] + ':' + tm[5] + (tm[6] || '');
    } else if ((tm = src.match(/(上午|下午|晚上|中午)\s*(\d{1,2})\s*点\s*[-—~至到]\s*(上午|下午|晚上|中午)?\s*(\d{1,2})\s*点/))) {
      timeText = tm[1] + tm[2] + '点';
      endTimeText = (tm[3] || tm[1]) + tm[4] + '点';
    } else if ((tm = src.match(/(\d{1,2})[:：]\s*\d{1,2}\s*(?:am|pm)?/i))) {
      timeText = tm[0];
    } else if ((tm = src.match(/(上午|下午|晚上|中午)\s*\d{1,2}\s*点(?:\s*(?:半|\d{1,2}\s*分)?)?/))) {
      timeText = tm[0];
    }

    // 地点
    var location = '', lm;
    if ((lm = src.match(/(?:地点|地址|位置|venue|location)\s*[：:]\s*([^\n,，。]{2,50})/i))) location = lm[1].trim();
    else if ((lm = src.match(/(?:在|于)\s*([^\n,，。]{2,40}(?:会议室|教室|礼堂|报告厅|厅|馆|中心|酒店|大厦|楼|号|room|hall|college|street|road|campus))/i))) location = lm[1].trim();

    // 议程（本地规则兜底：匹配「时间 事项」行，至少2项）
    var agenda = [];
    var agRe = /(?:^|\n)[ \t]*(\d{1,2}[:：]\d{2}|(?:上午|下午|晚上|中午)[ \t]*\d{1,2}[ \t]*点)[ \t]+([^\n]{2,40})/g;
    var am;
    while ((am = agRe.exec(src))) {
      var agTitle = am[2].replace(/^[-—:：·\s]+/, '').trim();
      if (agTitle && !/^\d/.test(agTitle)) agenda.push({ timeText: am[1].trim(), title: agTitle });
      if (agenda.length >= 12) break;
    }
    if (agenda.length < 2) agenda = [];

    var at = parseEventDateTime(dateText, timeText, base);
    var end = endTimeText ? parseEventDateTime(dateText, endTimeText, base) : '';
    if (!title && !at) return [];
    return [{ title: title, at: at, end: end, location: location, link: link, note: '', dateText: dateText, timeText: timeText, endTimeText: endTimeText, agenda: agenda }];
  }

  /* 用本地文本模型从文字提取日程（返回原始 dateText/timeText，本地换算日期）。
     模型不可用 / 解析失败时降级到 parseEventsFromText 本地规则。 */
  function extractEventsFromText(text, now) {
    return new Promise(function (resolve) {
      var base = now || new Date();
      var today = base.getFullYear() + '年' + (base.getMonth() + 1) + '月' + base.getDate() + '日（星期' + '日一二三四五六'[base.getDay()] + '）';
      if (!DESKTOP || !window.ingrid || !window.ingrid.chatStream) { resolve(parseEventsFromText(text, base)); return; }
      var msgs = [{ role: 'user', content:
        '今天是 ' + today + '。你是日程识别助手。请从下面这段文字里识别所有日程 / 活动 / 预订信息。\n\n文字：\n"""\n' + String(text || '').slice(0, 6000) + '\n"""\n\n' +
        '只输出一个 JSON 数组，不要输出任何其他文字、解释或 markdown。数组每一项是一条日程，格式严格为：' +
        '{"title":"标题","dateText":"日期原文","timeText":"开始时间原文","endTimeText":"结束时间原文","location":"地点","link":"链接","note":"备注","agenda":[{"timeText":"时间原文","title":"议程项"}]}。' +
        '\n规则：dateText / timeText / endTimeText 必须原样保留文字里的原始写法（如「11月29日」「下周三」「下午3点」「15:30」「Nov 29」「9am」「17:00」），绝对不要换算、不要猜测年份；dateText 只填「活动举办日期」，报名截止/预留截止/早鸟价截止等日期不是活动日期、不要填进 dateText（可放进 note），若文字里没有明确活动日期就留空、绝不要填「今天」或任何猜测的日期；timeText 填开始时间、endTimeText 填结束时间（若文字是「15:00-17:00」则 timeText 取「15:00」、endTimeText 取「17:00」），若文字没有明确写出开始时间，timeText 留空、绝不要编造 09:00 等默认时间；「预约提醒 / 通知 / 温馨提示」这类文字通常不含具体活动日期和时间，dateText 与 timeText 都应留空、不要硬填，宁可留空让用户手动补也不要编造；没有的字段填空字符串；若文字里含详细议程/时间表（多个「时间+事项」）逐项提取到 agenda 数组，否则输出空数组 []；可能是会议、讲座、航班、车票、酒店、报名确认、预约等。' }];
      // 引擎优先级：DeepSeek（deepseek-flash 便宜、质量高）→ 本地文本模型 → 纯本地规则兜底
      var engines = [
        { engine: 'deepseek', model: 'deepseek-flash' },
        { engine: 'ollama' },
      ];
      (function attempt(i) {
        if (i >= engines.length) { resolve(parseEventsFromText(text, base)); return; }
        var out = '';
        window.ingrid.chatStream({ engine: engines[i].engine, model: engines[i].model, messages: msgs, sessionId: 'sec-text' }, {
          onDelta: function (c) { if (c && c.text) out += c.text; },
          onDone: function (d) {
            if (!d || !d.ok) { attempt(i + 1); return; }
            var m = out.match(/\[[\s\S]*\]/);
            if (!m) { attempt(i + 1); return; }
            try {
              var arr = JSON.parse(m[0]);
              if (!Array.isArray(arr) || !arr.length) { attempt(i + 1); return; }
              var list = arr.map(function (j) {
                var endText = String(j.endTimeText || '').trim();
                var ag = Array.isArray(j.agenda) ? j.agenda.map(function (a) {
                  return { timeText: String((a && a.timeText) || '').trim(), title: String((a && a.title) || '').trim() };
                }).filter(function (a) { return a.title || a.timeText; }) : [];
                return {
                  title: String(j.title || '').trim(),
                  at: parseEventDateTime(j.dateText, j.timeText, base),
                  end: endText ? parseEventDateTime(j.dateText, endText, base) : '',
                  location: String(j.location || '').trim(),
                  link: String(j.link || '').trim(),
                  note: String(j.note || '').trim(),
                  dateText: String(j.dateText || '').trim(),
                  timeText: String(j.timeText || '').trim(),
                  endTimeText: endText,
                  agenda: ag,
                };
              }).filter(function (e) { return (e.title || e.at) && !isCancellationNotice(e); });
              resolve(list.length ? list : parseEventsFromText(text, base));
            } catch (e) { attempt(i + 1); }
          },
        });
      })(0);
    });
  }

  /* 系统通知：识别到日程后提醒用户确认 */
  function notifyConfirm(list, sourceLabel) {
    if (!DESKTOP || !window.ingrid.notify || !list || !list.length) return;
    var first = list[0] || {};
    var title = '📅 识别到 ' + list.length + ' 条日程（' + (sourceLabel || '自动') + '）';
    var body = (first.title || '未命名活动') + (list.length > 1 ? ' 等' : '') + ' · 请确认是否添加到日历';
    window.ingrid.notify({ title: title, body: body });
  }

  /* 查找已存在的重复活动：标题语义相似 + 时间接近（优先精确时间，其次同一天/时间窗）。返回匹配事件对象或 null。 */
  function findExistingEvent(title, at) {
    var t = String(title || '').trim();
    var a = String(at || '');
    if (!t) return null;
    var byDay = null;
    for (var i = 0; i < events.events.length; i++) {
      var e = events.events[i];
      if (!eventsSimilar(t, a, e.title, e.at)) continue;
      if (a && e.at === a) return e;                 // 精确时间命中，最可信
      if (!byDay) byDay = e;                          // 同一天 / 时间窗内
    }
    return byDay;
  }

  /* 疑似重复：标题语义高度相似（≥0.8，能抓住「全称 vs 简称」但不会误伤「电话预约」这类泛化词）但时间对不上
   * （可能识别错了日期）。用于确认卡片上给用户一个「请核对日期」的提醒，不自动判重（避免误伤每周/隔周重复的例行会议）。 */
  function findNearDuplicate(title, at) {
    var t = String(title || '').trim();
    if (!t) return null;
    for (var i = 0; i < events.events.length; i++) {
      var e = events.events[i];
      if (titleSimilarity(t, e.title) < 0.8) continue;
      if (at && e.at && eventsSimilar(t, at, e.title, e.at)) continue;   // 已属确定重复的，不算「疑似」
      return e;
    }
    return null;
  }

  /* 用新识别的信息补全已有日程的缺失字段（不重复新增、不覆盖已有内容）。返回是否发生了补全。 */
  function mergeIntoExisting(existing, incoming) {
    if (!existing || !incoming) return false;
    var changed = false;
    ['location', 'link', 'note', 'end', 'sourceText'].forEach(function (k) {
      var v = incoming[k];
      if (!v) return;
      if (!existing[k]) { existing[k] = v; changed = true; }
    });
    // agenda：已有为空且新识别有议程时补入
    if (Array.isArray(incoming.agenda) && incoming.agenda.length && !(Array.isArray(existing.agenda) && existing.agenda.length)) {
      existing.agenda = incoming.agenda; changed = true;
    }
    if (changed) events.update(existing.id, existing);
    return changed;
  }

  /* 智能添加：重复活动补全缺失内容，否则新增。返回 { mode:'added'|'merged'|'duplicate', event } */
  function addEventSmart(incoming) {
    var existing = findExistingEvent(incoming.title, incoming.at);
    if (existing) {
      var merged = mergeIntoExisting(existing, incoming);
      return { mode: merged ? 'merged' : 'duplicate', event: existing };
    }
    return { mode: 'added', event: events.add(incoming) };
  }

  /* 兼容旧引用：eventExists 返回布尔 */
  function eventExists(title, at) { return !!findExistingEvent(title, at); }

  /* 统一确认弹窗：识别到日程后请用户确认是否添加（可编辑、逐条添加/忽略、一键全部） */
  function openConfirmEvents(list, sourceLabel, sourceLink) {
    var list = list || [];
    modalMask.style.display = 'flex';
    modalMask.innerHTML =
      '<div class="sec-modal"><h3>' + iconSvg('check') + ' 识别到 ' + list.length + ' 条日程，请确认</h3>' +
      '<div class="sub">来源：' + esc(sourceLabel || '自动识别') + '。请核对是否正确、是否添加到日历——可逐条「＋ 添加」，或「＋ 全部添加」；不对的可「忽略」或直接修改。</div>' +
      '<div class="shot-results" id="cfResults"></div>' +
      '<div class="shot-bar"><button class="primary" id="cfAddAll">＋ 全部添加</button><button id="cfClose">关闭</button></div>' +
      '</div>';
    modalMask.querySelector('#cfClose').addEventListener('click', closeModal);
    modalMask.querySelector('#cfAddAll').addEventListener('click', function () { confirmAddAll(list, sourceLabel, sourceLink); });
    renderConfirmCards(list, sourceLabel, sourceLink);
  }

  /* 议程预览文本（供卡片显示） */
  function agendaPreview(ag) {
    if (!Array.isArray(ag) || !ag.length) return '';
    return ag.map(function (a) { return ((a.timeText || '') + ' ' + (a.title || '')).trim(); }).filter(Boolean).join(' · ');
  }

  /* 渲染确认卡片（可编辑标题/起止时间/地点，逐条「＋ 添加」/「补全」/「忽略」） */
  function renderConfirmCards(list, sourceLabel, sourceLink) {
    var box = document.getElementById('cfResults');
    if (!box) return;
    if (!list.length) {
      box.innerHTML = '<div style="color:var(--ink-faint);font-size:12px;padding:2px 0;">没有可添加的日程。</div>';
      return;
    }
    box.innerHTML = list.map(function (ev, i) {
      var atLocal = '', endLocal = '';
      if (ev.at) { var dd = new Date(ev.at); if (isFinite(dd.getTime())) atLocal = toLocal(dd); }
      if (ev.end) { var de = new Date(ev.end); if (isFinite(de.getTime())) endLocal = toLocal(de); }
      var added = ev._added, merged = ev._merged;
      var existing = !added && !merged && ev.at ? findExistingEvent(ev.title, ev.at) : null;
      var nearDup = !existing && !added && !merged ? findNearDuplicate(ev.title, ev.at) : null;
      var nearText = '';
      if (nearDup) {
        var nd = nearDup.at ? new Date(nearDup.at) : null;
        nearText = esc(nearDup.title) + (nd && isFinite(nd.getTime())
          ? '（' + nd.getFullYear() + '/' + (nd.getMonth() + 1) + '/' + nd.getDate() + ' ' + (nd.getHours() < 10 ? '0' : '') + nd.getHours() + ':' + (nd.getMinutes() < 10 ? '0' : '') + nd.getMinutes() + '）'
          : '');
      }
      var ag = agendaPreview(ev.agenda);
      return '<div class="shot-ev' + (added || merged || existing ? ' added' : '') + '" data-i="' + i + '">' +
        '<div class="g"><span class="lbl">题</span><input class="e-title" value="' + esc(ev.title || '') + '" placeholder="标题"></div>' +
        '<div class="g"><span class="lbl">始</span><input class="e-at" type="datetime-local" value="' + esc(atLocal) + '">' +
        '<span class="lbl">终</span><input class="e-end" type="datetime-local" value="' + esc(endLocal) + '"></div>' +
        (!ev.at ? '<div class="dup-warn">⚠ 未识别到时间：请手动填写准确的日期时间，或点「忽略」跳过。</div>' : '') +
        '<div class="g"><span class="lbl">地</span><input class="e-loc" value="' + esc(ev.location || '') + '" placeholder="地点"></div>' +
        (ev.sourceText ? '<div class="src-text"><span class="src-label">📱 短信原文</span>' + esc(ev.sourceText) + '</div>' : '') +
        (nearDup ? '<div class="dup-warn">⚠ 疑似重复：日历已有「' + nearText + '」，请核对本条的日期时间。</div>' : '') +
        (ag ? '<div class="agenda-prev">' + esc(ag) + '</div>' : '') +
        '<div class="acts"><button class="skip" data-i="' + i + '">忽略</button>' +
        (existing
          ? '<button class="add on merge" data-i="' + i + '">⇄ 补全信息</button>'
          : (merged
            ? '<button class="add on" disabled>✓ 已补全</button>'
            : '<button class="add' + (added ? ' on' : '') + '" data-i="' + i + '">' + (added ? '✓ 已添加' : '＋ 添加') + '</button>')) +
        '</div></div>';
    }).join('');
    Array.prototype.forEach.call(box.querySelectorAll('.skip'), function (b) {
      b.addEventListener('click', function () { list.splice(Number(b.getAttribute('data-i')), 1); renderConfirmCards(list, sourceLabel, sourceLink); });
    });
    // 单条添加（非重复项）
    Array.prototype.forEach.call(box.querySelectorAll('.add:not(.on):not(.merge)'), function (b) {
      b.addEventListener('click', function () {
        var i = Number(b.getAttribute('data-i'));
        var card = box.querySelector('.shot-ev[data-i="' + i + '"]');
        var title = ((card.querySelector('.e-title') || {}).value || '').trim();
        var at = (card.querySelector('.e-at') || {}).value || '';
        var endv = (card.querySelector('.e-end') || {}).value || '';
        var loc = ((card.querySelector('.e-loc') || {}).value || '').trim();
        if (!title) { alert('请填写标题'); return; }
        if (!at) { alert('请填写时间'); return; }
        var r = addEventSmart({
          title: title, at: new Date(at).toISOString(), end: endv ? new Date(endv).toISOString() : '',
          location: loc, link: list[i].link || sourceLink || '', note: list[i].note || '', sourceText: list[i].sourceText || '',
          agenda: list[i].agenda || [], reminderMin: 1440, source: sourceLabel || '自动识别',
        });
        if (r.mode === 'added') { list[i]._added = true; addChat('a', '已添加日程「' + title + '」。'); }
        else if (r.mode === 'merged') { list[i]._merged = true; addChat('a', '「' + title + '」已存在，已补全缺失信息。'); }
        else { list[i]._merged = true; addChat('a', '「' + title + '」已存在且信息完整，未重复添加。'); }
        renderConfirmCards(list, sourceLabel, sourceLink);
        renderEvents();
      });
    });
    // 补全按钮（重复项）
    Array.prototype.forEach.call(box.querySelectorAll('.add.merge'), function (b) {
      b.addEventListener('click', function () {
        var i = Number(b.getAttribute('data-i'));
        var card = box.querySelector('.shot-ev[data-i="' + i + '"]');
        var title = ((card.querySelector('.e-title') || {}).value || '').trim();
        var at = (card.querySelector('.e-at') || {}).value || '';
        var endv = (card.querySelector('.e-end') || {}).value || '';
        var loc = ((card.querySelector('.e-loc') || {}).value || '').trim();
        var existing = findExistingEvent(title, at ? new Date(at).toISOString() : '');
        var merged = mergeIntoExisting(existing, {
          location: loc, link: list[i].link || sourceLink || '', note: list[i].note || '', sourceText: list[i].sourceText || '',
          end: endv ? new Date(endv).toISOString() : '', agenda: list[i].agenda || [],
        });
        list[i]._merged = true;
        addChat('a', merged ? '已补全「' + title + '」的缺失信息。' : '「' + title + '」信息已完整，无需补全。');
        renderConfirmCards(list, sourceLabel, sourceLink);
        renderEvents();
      });
    });
  }

  /* 一键添加全部确认卡片（重复项自动补全，非重复项新增） */
  function confirmAddAll(list, sourceLabel, sourceLink) {
    var box = document.getElementById('cfResults');
    if (!box) return;
    var added = 0, merged = 0;
    Array.prototype.forEach.call(box.querySelectorAll('.shot-ev:not(.added)'), function (card) {
      var i = Number(card.getAttribute('data-i'));
      var title = ((card.querySelector('.e-title') || {}).value || '').trim();
      var at = (card.querySelector('.e-at') || {}).value || '';
      var endv = (card.querySelector('.e-end') || {}).value || '';
      var loc = ((card.querySelector('.e-loc') || {}).value || '').trim();
      if (!title || !at) return;
      var r = addEventSmart({
        title: title, at: new Date(at).toISOString(), end: endv ? new Date(endv).toISOString() : '',
        location: loc, link: list[i].link || sourceLink || '', note: list[i].note || '', sourceText: list[i].sourceText || '',
        agenda: list[i].agenda || [], reminderMin: 1440, source: sourceLabel || '自动识别',
      });
      if (r.mode === 'added') { list[i]._added = true; added++; }
      else { list[i]._merged = true; merged++; }
    });
    var msg = [];
    if (added) msg.push('新增 ' + added + ' 条');
    if (merged) msg.push('补全 ' + merged + ' 条重复活动');
    if (msg.length) { renderConfirmCards(list, sourceLabel, sourceLink); renderEvents(); addChat('a', '已' + msg.join('、') + '。'); }
  }

  /* 截图模式下的粘贴：⌘V / Ctrl+V 追加剪贴板图片（支持多张一起） */
  document.addEventListener('paste', function (e) {
    if (modalMask.style.display !== 'flex') return;   // 仅弹窗打开时响应
    var items = (e.clipboardData || {}).items;
    if (!items) return;
    var blobs = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i] && items[i].type && items[i].type.indexOf('image') === 0) {
        var blob = items[i].getAsFile();
        if (blob) blobs.push(blob);
      }
    }
    if (!blobs.length) return;
    e.preventDefault();
    var pending = blobs.length, urls = [];
    blobs.forEach(function (blob) {
      var reader = new FileReader();
      reader.onload = function () {
        urls.push(reader.result);
        if (--pending === 0) appendShotsAndRerun(urls);
      };
      reader.readAsDataURL(blob);
    });
  });

  /* 拖拽图片直接识别：拖到秘书面板自动打开识别，弹窗内拖入则追加（多张一起） */
  function handleDropImages(e) {
    var files = (e.dataTransfer && e.dataTransfer.files) || [];
    var imgs = [];
    for (var i = 0; i < files.length; i++) {
      if (files[i] && files[i].type && files[i].type.indexOf('image') === 0) imgs.push(files[i]);
    }
    if (!imgs.length) return;
    e.preventDefault();
    e.stopPropagation();
    var pending = imgs.length, urls = [];
    imgs.forEach(function (f) {
      var reader = new FileReader();
      reader.onload = function () {
        urls.push(reader.result);
        if (--pending === 0) {
          var inShotModal = modalMask.style.display === 'flex' && modalMask.querySelector('#evAddShot');
          if (!inShotModal) { shotDataUrls = []; shotEvents = []; }
          appendShotsAndRerun(urls);
        }
      };
      reader.readAsDataURL(f);
    });
  }
  panel.addEventListener('dragover', function (e) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; panel.classList.add('drag-over'); });
  panel.addEventListener('dragleave', function () { panel.classList.remove('drag-over'); });
  panel.addEventListener('drop', function (e) { panel.classList.remove('drag-over'); handleDropImages(e); });
  modalMask.addEventListener('dragover', function (e) {
    if (modalMask.style.display !== 'flex' || !modalMask.querySelector('#evAddShot')) return;
    e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    var m = modalMask.querySelector('.sec-modal'); if (m) m.classList.add('drag-over');
  });
  modalMask.addEventListener('dragleave', function () { var m = modalMask.querySelector('.sec-modal'); if (m) m.classList.remove('drag-over'); });
  modalMask.addEventListener('drop', function (e) {
    var m = modalMask.querySelector('.sec-modal'); if (m) m.classList.remove('drag-over');
    if (modalMask.style.display !== 'flex' || !modalMask.querySelector('#evAddShot')) return;
    handleDropImages(e);
  });

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

  /* 日历同步（CalDAV：iCloud 等） */
  function openSyncModal() {
    if (!DESKTOP || !window.ingrid.syncAccountsList) { alert('日历同步需要在桌面版使用'); return; }
    window.ingrid.syncAccountsList().then(function (accounts) {
      var acct = (accounts && accounts[0]) || {};
      modalMask.style.display = 'flex';
      modalMask.innerHTML =
        '<div class="sec-modal"><h3>' + iconSvg('calendar') + ' 同步日历</h3>' +
        '<div class="sub">连接 Apple 日历（iCloud），日程会自动汇入秘书。需先在 appleid.apple.com 生成「App 专用密码」（不是 Apple ID 登录密码）。</div>' +
        '<div class="f"><label>Apple ID（邮箱）</label><input id="calUser" value="' + esc(acct.username || '') + '" placeholder="you@icloud.com"></div>' +
        '<div class="f"><label>App 专用密码</label><input type="password" id="calPass" placeholder="xxxx-xxxx-xxxx-xxxx"></div>' +
        '<div class="sec-bhint">生成方法：appleid.apple.com → 登录 → 登录与安全 → App 专用密码 → 生成后粘贴到上面。密码仅加密存在本机钥匙串，不会上传。</div>' +
        '<div class="foot"><button id="calCancel">取消</button><button class="primary" id="calSave">保存并同步</button></div>' +
        '<div class="sec-bout" id="calResult" hidden></div>' +
        '<hr style="margin:16px 0 12px;border:none;border-top:1px solid var(--line)">' +
        '<div class="sub" style="font-weight:700;color:var(--ink);margin-bottom:6px">' + iconSvg('link') + ' Google 日历（OAuth 授权）</div>' +
        '<div class="sec-bhint">先在 console.cloud.google.com 创建「Web 应用」OAuth 客户端，把 <code>http://localhost:18888</code> 加入「已获授权的重定向 URI」，并启用 Calendar API。</div>' +
        '<div class="f"><label>Client ID</label><input id="gClientId" placeholder="xxx.apps.googleusercontent.com"></div>' +
        '<div class="f"><label>Client Secret</label><input type="password" id="gClientSecret" placeholder="GOCSPX-..."></div>' +
        '<div class="sec-row"><button class="sec-btn ghost" id="gConnect">' + iconSvg('link') + ' 连接 Google 日历</button></div>' +
        '<hr style="margin:16px 0 12px;border:none;border-top:1px solid var(--line)">' +
        '<div class="sub" style="font-weight:700;color:var(--ink);margin-bottom:6px">' + iconSvg('link') + ' Microsoft 365 日历（Teams / Outlook，OAuth 授权）</div>' +
        '<div class="sec-bhint">在 portal.azure.com 注册应用（重定向 URI 填 <code>http://localhost:18888</code>），授予 <b>Calendars.ReadWrite</b> 与 <b>Mail.Read</b> 委托权限。一次授权同时覆盖 Teams/Outlook 日历与 Outlook 邮箱。</div>' +
        '<div class="f"><label>Client ID</label><input id="mClientId" placeholder="Application (client) ID"></div>' +
        '<div class="f"><label>Client Secret</label><input type="password" id="mClientSecret" placeholder="..."></div>' +
        '<div class="sec-row"><button class="sec-btn ghost" id="mConnect">' + iconSvg('link') + ' 连接 Microsoft 365</button></div>' +
        '</div>';
      modalMask.querySelector('#calCancel').addEventListener('click', closeModal);
      modalMask.querySelector('#calSave').addEventListener('click', function () {
        var user = modalMask.querySelector('#calUser').value.trim();
        var pass = modalMask.querySelector('#calPass').value.trim();
        if (!user || !pass) { alert('请填写 Apple ID 和 App 专用密码'); return; }
        var btn = modalMask.querySelector('#calSave');
        btn.disabled = true; btn.textContent = '同步中…';
        var acctObj = {
          id: acct.id || 'cal-icloud',
          name: 'iCloud',
          type: 'caldav',
          serverUrl: 'https://caldav.icloud.com',
          username: user,
          password: pass,
          authMethod: 'basic',
          active: true,
        };
        window.ingrid.syncAccountSave(acctObj).then(function () {
          return window.ingrid.syncCalendarRun();
        }).then(function (res) {
          btn.disabled = false; btn.textContent = '保存并同步';
          var box = modalMask.querySelector('#calResult');
          box.hidden = false;
          var r0 = (res && res.results && res.results[0]) || {};
          if (r0.ok && res.total > 0) {
            box.innerHTML = '同步成功，汇入 ' + res.total + ' 条日程。';
          } else if (!r0.ok && r0.error) {
            box.innerHTML = esc(r0.error);
          } else {
            box.innerHTML = '同步完成，但未找到近期日程。';
          }
          try {
            var latest = window.ingrid.loadSecretarySync();
            if (latest && Array.isArray(latest.events)) { events.events = latest.events; }
          } catch (e) {}
          renderEvents();
          addChat('a', '日历已同步。');
        }).catch(function (err) {
          btn.disabled = false; btn.textContent = '保存并同步';
          var box = modalMask.querySelector('#calResult');
          box.hidden = false;
          box.innerHTML = esc(String(err && err.message || err));
        });
      });

      // Google / Microsoft OAuth 授权（浏览器完成授权后由主进程回调 oauth:done）
      function startOAuth(provider, label, idSel, secSel, btn) {
        var cid = modalMask.querySelector(idSel).value.trim();
        var csec = modalMask.querySelector(secSel).value.trim();
        if (!cid || !csec) { alert('请先填写 ' + label + ' 的 Client ID 和 Client Secret'); return; }
        btn.disabled = true; btn.textContent = '请在浏览器完成授权…';
        window.ingrid.syncOauthStart({ provider: provider, clientId: cid, clientSecret: csec, name: label + ' 日历' })
          .then(function (r) {
            if (!r || !r.ok) { btn.disabled = false; btn.textContent = '连接 ' + label + ' 日历'; alert((r && r.error) || '启动授权失败'); }
          })
          .catch(function (e) { btn.disabled = false; btn.textContent = '连接 ' + label + ' 日历'; alert(String(e && e.message || e)); });
      }
      modalMask.querySelector('#gConnect').addEventListener('click', function () { startOAuth('google', 'Google', '#gClientId', '#gClientSecret', this); });
      modalMask.querySelector('#mConnect').addEventListener('click', function () { startOAuth('microsoft', 'Microsoft 365', '#mClientId', '#mClientSecret', this); });

    });
  }
  document.getElementById('secSyncCal').addEventListener('click', openSyncModal);

  /* Notion 知识库：独立入口（不再埋在「同步日历」弹窗里） */
  function openNotionModal() {
    if (!DESKTOP || !window.ingrid.notionConfigure) { alert('Notion 接入需要在桌面版使用'); return; }
    modalMask.style.display = 'flex';
    modalMask.innerHTML =
      '<div class="sec-modal"><h3>' + iconSvg('link') + ' 连接 Notion 知识库</h3>' +
      '<div class="sub">在 notion.so/my-integrations 创建集成，把 Internal Integration Token 粘贴到下面（形如 ntn_ 或 secret_ 开头）。token 加密存本机钥匙串，不上传。</div>' +
      '<div class="f"><label>Notion Token</label><input type="password" id="notionToken" placeholder="ntn_... 或 secret_..."></div>' +
      '<div class="sec-row"><button class="sec-btn" id="notionSave">' + iconSvg('check') + ' 保存 token</button></div>' +
      '<div class="sec-bout" id="notionResult" hidden></div>' +
      '<div class="sec-row">' +
        '<button class="sec-btn ghost" id="notionTest">' + iconSvg('search') + ' 测试连接</button>' +
        '<button class="sec-btn ghost" id="notionSyncBtn" style="flex:1">' + iconSvg('zap') + ' 立即同步</button>' +
      '</div>' +
      '<div class="sec-bout" id="notionTestResult" hidden></div>' +
      '<div class="sec-bout" id="notionSyncOut" hidden></div>' +
      '<hr style="margin:16px 0 12px;border:none;border-top:1px solid var(--line)">' +
      '<div class="sub" style="font-weight:700;color:var(--ink);margin-bottom:6px">' + iconSvg('arrowUp') + ' 研究同步官（本地 latest → Notion）</div>' +
      '<div class="sec-bhint">把电脑 <b>latest</b> 目录里的 .md / .docx 自动推成 Notion 子页面（docx 自动提取正文）。需先在 Notion 建一个「研究进展」父页面并授权集成，再把页面 ID 填到下面。</div>' +
      '<div class="f"><label>Notion 父页面 ID（32 位）</label><input id="researchParentId" placeholder="从页面 URL 复制，例如 1a2b3c4d5e6f..."></div>' +
      '<div class="f"><label>本地同步目录</label><input id="researchDir" placeholder="latest 目录绝对路径（留空用默认）"></div>' +
      '<div class="sec-row">' +
        '<button class="sec-btn ghost" id="researchConfigBtn">' + iconSvg('check') + ' 保存配置</button>' +
        '<button class="sec-btn" id="researchSyncBtn" style="flex:1">' + iconSvg('arrowUp') + ' 立即推送</button>' +
      '</div>' +
      '<div class="sec-bout" id="researchSyncOut" hidden></div>' +
      '<hr style="margin:16px 0 12px;border:none;border-top:1px solid var(--line)">' +
      '<div class="sub" style="font-weight:700;color:var(--ink);margin-bottom:6px">' + iconSvg('search') + ' 验证 / 搜索你的页面</div>' +
      '<div class="sec-bhint">保存 token 后，还要在 Notion 里给要读的页面 / 数据库授权这个集成（页面右上角 ··· → Connections → 勾选），否则搜不到内容。</div>' +
      '<div class="f"><label>搜索页面 / 数据库</label><input id="notionQuery" placeholder="例如：文献综述"></div>' +
      '<div class="sec-row"><button class="sec-btn ghost" id="notionSearch">' + iconSvg('search') + ' 搜索 Notion</button></div>' +
      '<div class="sec-bout" id="notionResult2" hidden></div>' +
      '<div class="foot"><button id="notionClose">关闭</button></div>' +
      '</div>';
    modalMask.querySelector('#notionClose').addEventListener('click', closeModal);
    modalMask.querySelector('#notionSave').addEventListener('click', function () {
      var t = modalMask.querySelector('#notionToken').value.trim();
      if (!t) { alert('请先粘贴 Notion Token'); return; }
      window.ingrid.notionConfigure(t).then(function () {
        var box = modalMask.querySelector('#notionResult');
        box.hidden = false; box.textContent = '✓ Notion token 已保存（加密存本机）。';
      }).catch(function (e) { alert(String(e && e.message || e)); });
    });
    modalMask.querySelector('#notionTest').addEventListener('click', function () {
      var box = modalMask.querySelector('#notionTestResult');
      box.hidden = false; box.textContent = '测试中…';
      window.ingrid.notionTest().then(function (r) {
        if (!r) { box.textContent = '测试失败：无返回'; return; }
        if (!r.configured) { box.textContent = '尚未保存 token，请先在上方粘贴并「保存 token」。'; return; }
        if (!r.ok) {
          box.innerHTML = '<b style="color:#d33">token 无效</b>：' + esc(r.error || '未知错误') +
            '<br>请回到 notion.so/my-integrations 重新复制 token，再粘贴保存。';
          return;
        }
        if (r.total === 0) {
          box.innerHTML = '<b style="color:#d33">token 有效，但看不到任何页面</b>：集成还没被授权访问内容。<br>' +
            '去 Notion 里打开你要同步的页面 / 数据库，点右上角 <b>··· → Connections（连接）</b>，勾选你的集成，' +
            '然后到「知识库」面板点「重建索引」。';
        } else {
          box.innerHTML = '<b style="color:#2a7d2f">连接正常</b>：能看到 ' + r.total + ' 个对象（页面 ' + r.pages + '、数据库 ' + r.databases + '）。<br>' +
            '到「知识库」面板点「重建索引」，即可把 Notion 内容纳入本地检索。';
        }
      }).catch(function (e) { box.textContent = '测试失败：' + (e && e.message || e); });
    });
    modalMask.querySelector('#notionSyncBtn').addEventListener('click', function () {
      var box = modalMask.querySelector('#notionSyncOut');
      box.hidden = false; box.textContent = '同步中（拉取 Notion 全文 + 增量索引，可能需要几秒到几十秒）…';
      window.ingrid.notionSync().then(function (r) {
        if (!r) { box.textContent = '同步失败：无返回'; return; }
        if (r.skipped) { box.textContent = '尚未保存 Notion token，无法同步。请先在上方粘贴并保存。'; return; }
        if (!r.ok) { box.innerHTML = '<b style="color:#d33">同步失败</b>：' + esc(r.error || ''); return; }
        var t = new Date(r.syncedAt).toLocaleTimeString();
        var parts = [];
        if (r.added) parts.push('新增 ' + r.added);
        if (r.updated) parts.push('更新 ' + r.updated);
        if (r.removed) parts.push('移除 ' + r.removed);
        var change = parts.length ? '（' + parts.join('、') + '）' : '（无变化）';
        box.innerHTML = '<b style="color:#2a7d2f">同步完成</b>：当前 ' + r.total + ' 篇' + change + '。<br>' +
          '<span style="color:var(--ink-faint)">' + t + ' · 之后每 30 分钟自动同步一次。</span>';
      }).catch(function (e) { box.textContent = '同步失败：' + (e && e.message || e); });
    });
    modalMask.querySelector('#notionSearch').addEventListener('click', function () {
      var q = modalMask.querySelector('#notionQuery').value.trim();
      if (!q) { alert('请先输入要搜索的关键词'); return; }
      var box = modalMask.querySelector('#notionResult2');
      box.hidden = false; box.textContent = '搜索中…';
      window.ingrid.notionSearch(q).then(function (r) {
        if (!r || !r.ok) { box.textContent = (r && r.error) || '搜索失败'; return; }
        if (!r.results || !r.results.length) { box.textContent = '没有找到匹配的页面（检查是否已给页面授权集成）。'; return; }
        box.innerHTML = r.results.map(function (it) {
          return '<div style="margin-bottom:6px">' + (it.object === 'database' ? '🗂️' : '📄') + ' <b>' + esc(it.title) + '</b>' +
            '<div style="color:var(--ink-faint);font-size:10px">' + esc(it.id) + '</div></div>';
        }).join('');
      }).catch(function (e) { box.textContent = '搜索失败：' + (e && e.message || e); });
    });

    // 研究同步官：回填已保存配置
    window.ingrid.notionResearchConfig(null).then(function (c) {
      if (!c) return;
      if (c.parentId && modalMask.querySelector('#researchParentId')) modalMask.querySelector('#researchParentId').value = c.parentId;
      if (c.dir && modalMask.querySelector('#researchDir')) modalMask.querySelector('#researchDir').value = c.dir;
    }).catch(function () {});
    modalMask.querySelector('#researchConfigBtn').addEventListener('click', function () {
      var pid = modalMask.querySelector('#researchParentId').value.trim();
      var dir = modalMask.querySelector('#researchDir').value.trim();
      window.ingrid.notionResearchConfig({ parentId: pid, dir: dir }).then(function () {
        alert('研究同步官配置已保存。');
      }).catch(function (e) { alert(String(e && e.message || e)); });
    });
    modalMask.querySelector('#researchSyncBtn').addEventListener('click', function () {
      var box = modalMask.querySelector('#researchSyncOut');
      box.hidden = false; box.textContent = '推送中（读取 latest 目录 + 提取 docx 正文 + 写入 Notion）…';
      window.ingrid.notionResearchSync().then(function (r) {
        if (!r) { box.textContent = '推送失败：无返回'; return; }
        if (!r.ok) { box.innerHTML = '<b style="color:#d33">推送失败</b>：' + esc(r.error || ''); return; }
        var t = new Date(r.syncedAt).toLocaleTimeString();
        var html = '<b style="color:#2a7d2f">推送完成</b>：共 ' + r.total + ' 个文件（新增 ' + r.created + '、更新 ' + r.updated + '、跳过 ' + r.unchanged + '）';
        if (r.failed) html += '<br><span style="color:#d33">失败 ' + r.failed + ' 个</span>';
        if (r.errors && r.errors.length) html += '<br><span style="font-size:10px;color:var(--ink-faint)">' + esc(r.errors.slice(0, 5).join('；')) + '</span>';
        html += '<br><span style="color:var(--ink-faint)">' + t + ' · 之后每 30 分钟自动检查推送。</span>';
        box.innerHTML = html;
      }).catch(function (e) { box.textContent = '推送失败：' + (e && e.message || e); });
    });
  }
  document.getElementById('secNotion').addEventListener('click', function () {
    if (typeof window.openAgentInView === 'function') window.openAgentInView({ name: '知识库', href: 'agents/knowledge/index.html' });
    else if (window.ingrid && window.ingrid.openAgent) window.ingrid.openAgent('agents/knowledge/index.html');
  });

  /* 系统权限自检：检测 macOS 受保护目录（桌面/文稿/下载）可读性 */
  document.getElementById('secPerm').addEventListener('click', function () {
    if (!DESKTOP || !window.ingrid.fsPermCheck) { alert('权限自检需要在桌面版使用'); return; }
    var box = document.getElementById('secPermOut');
    box.hidden = false; box.textContent = '检测中…';
    window.ingrid.fsPermCheck().then(function (r) {
      if (!r) { box.textContent = '检测失败：无返回'; return; }
      var rows = [], anyFail = false;
      for (var k in r) {
        if (k.charAt(0) === '_') continue;
        var it = r[k];
        if (it.ok) rows.push('✅ ' + it.label + ' 可读');
        else { anyFail = true; rows.push('❌ ' + it.label + ' 不可读' + (it.code === 'EPERM' ? '（macOS 隐私保护）' : '')); }
      }
      var html = rows.join('<br>');
      if (anyFail) {
        html += '<br><b style="color:#d33">有目录读不到</b>：研究助手会因此「找不到你电脑的文件」。<br>' +
          '去 <b>系统设置 → 隐私与安全性 → 完全磁盘访问</b>，点 + 添加这个应用：<br>' +
          '<code style="font-size:10px;word-break:break-all">' + esc(r._electronApp || '(路径未知)') + '</code><br>' +
          '勾选后完全退出应用（⌘Q）再重启。';
      } else {
        html += '<br><b style="color:#2a7d2f">全部可读</b>，研究助手可以正常访问你电脑的文件。';
      }
      box.innerHTML = html;
    }).catch(function (e) { box.textContent = '检测失败：' + (e && e.message || e); });
  });

  /* 同步 Outlook 邮箱（Microsoft Graph Mail） */
  document.getElementById('secSyncMail').addEventListener('click', function () {
    if (!DESKTOP || !window.ingrid.syncMailRun) { alert('邮箱同步需要在桌面版使用'); return; }
    var btn = this; btn.disabled = true; btn.textContent = '同步中…';
    window.ingrid.syncMailRun().then(function (r) {
      btn.disabled = false; btn.textContent = '⇅ 同步 Outlook 邮箱';
      if (!r || r.skipped) { addChat('a', '尚未连接 Microsoft 365 账户，请先在「同步日历」里连接 Outlook。'); return; }
      if (r.total > 0) {
        try { var latest = window.ingrid.loadSecretarySync(); if (latest && Array.isArray(latest.emails)) { emails.emails = latest.emails; } } catch (e) {}
        renderEmails();
        addChat('a', '已同步 ' + r.total + ' 封 Outlook 邮件并自动分类分级。');
        scanEmailsForEvents(true);
      } else {
        addChat('a', '同步完成，未发现新邮件。');
      }
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = '⇅ 同步 Outlook 邮箱';
      addChat('a', '邮箱同步失败：' + (e && e.message || e));
    });
  });

  // OAuth 授权完成回调：刷新日程
  if (DESKTOP && window.ingrid.onOauthDone) {
    window.ingrid.onOauthDone(function (d) {
      if (d && d.ok) {
        addChat('a', (d.name || '日历') + ' 已授权，正在同步…');
        window.ingrid.syncCalendarRun().then(function () {
          try { var latest = window.ingrid.loadSecretarySync(); if (latest && Array.isArray(latest.events)) { events.events = latest.events; } } catch (e) {}
          renderEvents();
          addChat('a', '已同步完成。');
        }).catch(function () {});
      } else {
        addChat('a', '授权失败：' + (d && d.error ? d.error : '未知错误'));
      }
    });
  }

  // 邮箱同步完成回调：刷新邮件列表
  if (DESKTOP && window.ingrid.onMailSynced) {
    window.ingrid.onMailSynced(function (d) {
      try { var latest = window.ingrid.loadSecretarySync(); if (latest && Array.isArray(latest.emails)) { emails.emails = latest.emails; } } catch (e) {}
      renderEmails();
      if (d && d.total > 0) { addChat('a', '已自动同步 ' + d.total + ' 封 Outlook 邮件。'); scanEmailsForEvents(true); }
    });
  }

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
