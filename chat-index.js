/**
 * ============================================================
 *  chat-index.js —— 右侧「问题提炼 + 快速跳转」索引面板
 *  ============================================================
 *
 *  目标（对齐 WorkBuddy / ChatGPT 的对话大纲体验）：
 *    - 把当前会话里的「用户问题」逐条提炼成索引（去掉前缀/补充说明等噪声，
 *      截断成长标题）；
 *    - 把 assistant 回复里的标题（h2/h3，即 markdown 的 ##/###）也列成子级
 *      跳转点，方便在长回答里快速定位；
 *    - 点任意条目 → 平滑滚动到对应消息/标题并短暂高亮。
 *
 *  零依赖。各 chat agent 通过 <script src="../../chat-index.js"> 引入，
 *  在 init 阶段调用 window.ChatIndex.mount({ messagesEl })，之后自动跟随
 *  消息增删刷新（MutationObserver + 防抖），无需手动调用 refresh。
 *
 *  宿主契约（opts）：
 *    { messagesEl: Element,          // #messages 容器
 *      toggleEl:   Element | null }  // 可选：外部开关按钮；缺省自动创建浮动按钮
 *
 *  mount 返回 { refresh, toggle, show, hide } 控制器。
 * ============================================================
 */
(function () {
  'use strict';
  if (window.ChatIndex) return;

  var C = {
    accent: 'var(--accent, #7c6fd6)',
    accent2: 'var(--accent-2, #6355c4)',
    accentSoft: 'var(--accent-soft, #ebe7f7)',
    ink: 'var(--ink, #26232e)',
    inkSoft: 'var(--ink-soft, #55515e)',
    inkFaint: 'var(--ink-faint, #8f8b98)',
    line: 'var(--line, #e6e4ec)',
    card: 'var(--card, #ffffff)',
    bg: 'var(--bg, #f7f6f9)',
  };

  var CSS = [
    '/* chat-index：右侧问题索引抽屉 */',
    '.ci-toggle {',
    '  position: fixed; right: 14px; bottom: 104px; z-index: 9000;',
    '  width: 44px; height: 44px; border-radius: 50%; border: 1px solid ' + C.line + ';',
    '  background: ' + C.card + '; color: ' + C.accent2 + '; cursor: pointer;',
    '  box-shadow: 0 4px 16px rgba(40,32,70,.16); font-size: 18px; line-height: 1;',
    '  display: flex; align-items: center; justify-content: center;',
    '  transition: transform .15s, background .15s;',
    '}',
    '.ci-toggle:hover { background: ' + C.accentSoft + '; transform: translateY(-1px); }',
    '.ci-toggle.on { background: ' + C.accent + '; color: #fff; border-color: ' + C.accent + '; }',
    '.ci-panel {',
    '  position: fixed; top: 0; right: 0; bottom: 0; width: 300px; max-width: 86vw;',
    '  background: ' + C.card + '; border-left: 1px solid ' + C.line + ';',
    '  box-shadow: -10px 0 34px rgba(30,24,52,.14); z-index: 9500;',
    '  display: flex; flex-direction: column;',
    '  transform: translateX(105%); transition: transform .2s ease;',
    '}',
    '.ci-panel.ci-show { transform: translateX(0); }',
    '.ci-head {',
    '  flex: none; display: flex; align-items: center; justify-content: space-between;',
    '  padding: 14px 14px 10px 16px; border-bottom: 1px solid ' + C.line + ';',
    '}',
    '.ci-head .ci-title { font-size: 14px; font-weight: 700; color: ' + C.ink + '; }',
    '.ci-head .ci-title small { display: block; font-weight: 400; font-size: 11px; color: ' + C.inkFaint + '; margin-top: 2px; }',
    '.ci-close {',
    '  flex: none; width: 28px; height: 28px; border: none; background: none;',
    '  color: ' + C.inkFaint + '; font-size: 20px; line-height: 1; cursor: pointer; border-radius: 8px;',
    '}',
    '.ci-close:hover { background: ' + C.bg + '; color: ' + C.ink + '; }',
    '.ci-list { flex: 1; overflow-y: auto; padding: 8px; }',
    '.ci-item {',
    '  width: 100%; display: flex; align-items: flex-start; gap: 8px; text-align: left;',
    '  padding: 8px 9px; margin-bottom: 2px; border: none; border-radius: 9px;',
    '  background: none; color: ' + C.ink + '; cursor: pointer; font-family: inherit;',
    '}',
    '.ci-item:hover { background: ' + C.accentSoft + '; }',
    '.ci-item .ci-dot {',
    '  flex: none; width: 7px; height: 7px; border-radius: 50%; margin-top: 5px;',
    '  background: ' + C.accent + ';',
    '}',
    '.ci-item.ci-user .ci-dot { background: ' + C.accent + '; }',
    '.ci-item.ci-heading { padding-left: 26px; }',
    '.ci-item.ci-heading .ci-dot { background: ' + C.line + '; border: 1px solid ' + C.inkFaint + '; }',
    '.ci-item .ci-label { flex: 1; min-width: 0; font-size: 12.5px; line-height: 1.45; word-break: break-word; }',
    '.ci-item.ci-user .ci-label { font-weight: 600; color: ' + C.ink + '; }',
    '.ci-item.ci-heading .ci-label { color: ' + C.inkSoft + '; }',
    '.ci-item .ci-time { flex: none; font-size: 10.5px; color: ' + C.inkFaint + '; margin-top: 2px; white-space: nowrap; }',
    '.ci-empty { padding: 22px 14px; font-size: 12.5px; color: ' + C.inkFaint + '; text-align: center; }',
    '/* 跳转高亮动画 */',
    '@keyframes ciFlash { 0% { box-shadow: 0 0 0 3px ' + C.accent + '; } 100% { box-shadow: 0 0 0 3px transparent; } }',
    '.msg.ci-flash .bubble { animation: ciFlash 1.4s ease-out; }',
  ].join('\n');

  var _cssInjected = false;
  function ensureCss() {
    if (_cssInjected) return;
    var st = document.createElement('style');
    st.setAttribute('data-ci', '1');
    st.textContent = CSS;
    document.head.appendChild(st);
    _cssInjected = true;
  }

  var _panel = null, _toggle = null, _messagesEl = null, _open = false;
  var _debounce = null, _observer = null;

  function cleanLabel(t) {
    var s = String(t == null ? '' : t).replace(/[\s\u00a0]+/g, ' ').trim();
    // 去掉补充说明前缀、拖入文件标记等噪声
    s = s.replace(/^补充说明\s*/, '');
    s = s.replace(/^【补充说明[^】]*】\s*/, '');
    s = s.replace(/^【用户拖入的文件】[\s\S]*/, '').trim();
    s = s.replace(/^\/note\s+/i, '').replace(/^\/n\s+/i, '');
    if (!s) return '';
    return s.length > 32 ? s.slice(0, 32) + '…' : s;
  }

  function makeItem(label, time, cls, onclick) {
    var row = document.createElement('button');
    row.type = 'button';
    row.className = 'ci-item ' + cls;
    row.innerHTML = '<span class="ci-dot"></span><span class="ci-label"></span>' + (time ? '<span class="ci-time"></span>' : '');
    row.querySelector('.ci-label').textContent = label;
    if (time) row.querySelector('.ci-time').textContent = time;
    row.addEventListener('click', onclick);
    return row;
  }

  function jump(target) {
    if (!target) return;
    try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { target.scrollIntoView(); }
    var msg = target.closest ? target.closest('.msg') : null;
    if (msg) {
      msg.classList.remove('ci-flash');
      void msg.offsetWidth;
      msg.classList.add('ci-flash');
      setTimeout(function () { msg.classList.remove('ci-flash'); }, 1500);
    }
  }

  function refresh() {
    if (!_panel || !_messagesEl) return;
    var list = _panel.querySelector('.ci-list');
    list.innerHTML = '';
    var msgs = Array.prototype.slice.call(_messagesEl.querySelectorAll('.msg'));
    var userCount = 0, headingCount = 0;

    msgs.forEach(function (m) {
      var isUser = m.classList.contains('user');
      var bubble = m.querySelector('.bubble');
      if (!bubble) return;
      var time = m.getAttribute('data-ts') || '';

      if (isUser) {
        var label = cleanLabel(bubble.textContent);
        if (!label) return;
        userCount++;
        list.appendChild(makeItem(label, time, 'ci-user', function () { jump(m); }));
      } else {
        // assistant 回复里的标题作为子级跳转点
        var heads = bubble.querySelectorAll('h2, h3');
        Array.prototype.forEach.call(heads, function (h) {
          var t = cleanLabel(h.textContent);
          if (!t) return;
          headingCount++;
          list.appendChild(makeItem(t, '', 'ci-heading', function () { jump(h); }));
        });
      }
    });

    if (!userCount && !headingCount) {
      list.innerHTML = '<div class="ci-empty">暂无问题记录<br>提问后这里会自动生成索引</div>';
    }
    if (_toggle) _toggle.title = _open ? '收起问题索引' : '展开问题索引（' + (userCount + headingCount) + ' 条）';
  }

  function show() {
    _open = true;
    if (_panel) _panel.classList.add('ci-show');
    if (_toggle) _toggle.classList.add('on');
  }
  function hide() {
    _open = false;
    if (_panel) _panel.classList.remove('ci-show');
    if (_toggle) _toggle.classList.remove('on');
  }
  function toggle() { if (_open) hide(); else { refresh(); show(); } }

  function mount(opts) {
    ensureCss();
    opts = opts || {};
    _messagesEl = opts.messagesEl;

    // 面板
    _panel = document.createElement('aside');
    _panel.className = 'ci-panel';
    _panel.innerHTML =
      '<div class="ci-head">' +
        '<div class="ci-title">问题索引<small>提炼对话问题 · 点击快速跳转</small></div>' +
        '<button type="button" class="ci-close" aria-label="关闭">×</button>' +
      '</div>' +
      '<div class="ci-list"></div>';
    document.body.appendChild(_panel);
    _panel.querySelector('.ci-close').addEventListener('click', hide);

    // 开关按钮
    _toggle = opts.toggleEl || null;
    if (!_toggle) {
      _toggle = document.createElement('button');
      _toggle.type = 'button';
      _toggle.className = 'ci-toggle';
      _toggle.innerHTML = '☰';
      _toggle.title = '展开问题索引';
      document.body.appendChild(_toggle);
    }
    _toggle.addEventListener('click', toggle);

    // 自动跟随消息增删刷新（防抖 500ms，流式期间合并）
    if (_messagesEl && window.MutationObserver) {
      _observer = new MutationObserver(function () {
        if (_debounce) clearTimeout(_debounce);
        _debounce = setTimeout(function () { if (_open) refresh(); }, 500);
      });
      _observer.observe(_messagesEl, { childList: true, subtree: true, characterData: true });
    }

    return { refresh: refresh, toggle: toggle, show: show, hide: hide };
  }

  window.ChatIndex = { mount: mount, refresh: refresh };
})();
