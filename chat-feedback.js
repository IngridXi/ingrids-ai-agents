/**
 * ============================================================
 *  chat-feedback.js —— 每一条 AI 回复下方的 👍/👎 反馈组件
 *  ============================================================
 *
 *  目标（对齐 WorkBuddy / ChatGPT 的反馈体验）：
 *    1. 👍/👎 固定显示在每一条 assistant 回复的正下方（不再 hover 才出现、
 *       不再悬浮在气泡右上角、不再只出现在思考过程里）。
 *    2. 点击 👍/👎 弹出「细化」窗口：给出几个原因选项（chips）+ 一个手动
 *       输入条，让用户清楚阐述对哪里满意 / 不满。
 *    3. 窗口里带「是否沉淀」判断：勾选「沉淀为长期偏好」时，把这条反馈
 *       提交给经验沉淀官（仍停 pending_approval，人工在环铁律不变）；
 *       不确定时给出「什么时候该沉淀」的引导说明。
 *
 *  参考的开源范式（仅借鉴设计，非照搬代码）：
 *    - teachanything #559：thumbs up/down + 点踩时追问「哪里不对」；
 *    - lovstudio/feedback-loop：「点赞/点踩/评分走同一条闭环 → 迭代提示词」；
 *    - ContextJet/collect-user-feedback：点踩给下拉原因（wrong/unhelpful/unsafe/other）。
 *
 *  零依赖。由各 chat agent 通过 <script src="../../chat-feedback.js"> 引入，
 *  在 addBubble 里调用 window.ChatFeedback.attach(bodyEl, opts)。
 *
 *  宿主契约（opts）：
 *    {
 *      agent:        '研究助手',              // 当前 agent 名（用于偏好归类）
 *      getSessionId: function() -> string,   // 当前会话 id（可为空串）
 *      getContext:   function() -> string,   // 被评价回复的纯文本（截断即可）
 *      api:          {                        // 可选；缺省时自动取 window.ingrid
 *        observe: fn(raw),                   // 记录情绪/评价信号（sentimentObserve）
 *        settle:  fn(item),                  // 提交经验沉淀（settlerSubmit）
 *        distill: fn(),                      // 提炼偏好（sentimentDistill，可选）
 *      },
 *    }
 * ============================================================
 */
(function () {
  'use strict';
  if (window.ChatFeedback) return;   // 幂等：重复引入不重复注入

  /* ---------------- 主题色（沿用各 agent 的 :root 变量，带兜底） ---------------- */
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
    danger: 'var(--danger, #dc2626)',
    ok: '#1d9e75',
  };

  /* ---------------- 样式注入 ---------------- */
  var CSS = [
    '/* chat-feedback：回复底部固定反馈条 */',
    '.msg .msg-body { display: flex; flex-direction: column; min-width: 0; flex: 1; }',
    '.msg.assistant .msg-body { align-items: flex-start; }',
    '.msg.user .msg-body { align-items: flex-end; }',
    '.cf-footer {',
    '  display: flex; align-items: center; gap: 6px; flex-wrap: wrap;',
    '  margin: 6px 0 0 10px; min-height: 26px; user-select: none;',
    '}',
    '.cf-btn {',
    '  display: inline-flex; align-items: center; gap: 5px;',
    '  padding: 4px 11px; font-size: 12px; line-height: 1.4;',
    '  border: 1px solid ' + C.line + '; border-radius: 999px;',
    '  background: ' + C.card + '; color: ' + C.inkSoft + '; cursor: pointer;',
    '  transition: color .12s, border-color .12s, background .12s;',
    '}',
    '.cf-btn:hover { border-color: ' + C.accent + '; color: ' + C.accent2 + '; }',
    '.cf-btn .cf-icon { font-size: 13px; line-height: 1; }',
    '.cf-btn.cf-up.on { border-color: ' + C.accent + '; background: ' + C.accentSoft + '; color: ' + C.accent2 + '; }',
    '.cf-btn.cf-down.on { border-color: ' + C.danger + '; background: #fdf0ef; color: ' + C.danger + '; }',
    '.cf-note { font-size: 11px; color: ' + C.inkFaint + '; }',

    '/* chat-feedback：细化弹窗 */',
    '.cf-overlay {',
    '  position: fixed; inset: 0; background: rgba(20,16,34,.45);',
    '  display: flex; align-items: center; justify-content: center;',
    '  z-index: 99999; opacity: 0; pointer-events: none; transition: opacity .15s;',
    '}',
    '.cf-overlay.cf-show { opacity: 1; pointer-events: auto; }',
    '.cf-modal {',
    '  width: 448px; max-width: calc(100vw - 36px); max-height: 86vh; overflow-y: auto;',
    '  background: ' + C.card + '; color: ' + C.ink + '; border-radius: 14px;',
    '  box-shadow: 0 22px 70px rgba(0,0,0,.28); padding: 20px 22px 18px;',
    '  transform: translateY(8px); transition: transform .15s;',
    '}',
    '.cf-overlay.cf-show .cf-modal { transform: translateY(0); }',
    '.cf-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 4px; }',
    '.cf-title { font-size: 16px; font-weight: 700; line-height: 1.4; }',
    '.cf-close {',
    '  flex: none; width: 28px; height: 28px; border: none; background: none;',
    '  color: ' + C.inkFaint + '; font-size: 20px; line-height: 1; cursor: pointer; border-radius: 8px;',
    '}',
    '.cf-close:hover { background: ' + C.bg + '; color: ' + C.ink + '; }',
    '.cf-subtitle { font-size: 13px; color: ' + C.inkSoft + '; margin: 2px 0 12px; }',
    '.cf-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }',
    '.cf-chip {',
    '  padding: 6px 12px; font-size: 12.5px; border-radius: 999px; cursor: pointer;',
    '  border: 1px solid ' + C.line + '; background: ' + C.card + '; color: ' + C.inkSoft + ';',
    '  transition: all .12s;',
    '}',
    '.cf-chip:hover { border-color: ' + C.accent + '; color: ' + C.accent2 + '; }',
    '.cf-chip.cf-on { border-color: ' + C.accent + '; background: ' + C.accentSoft + '; color: ' + C.accent2 + '; font-weight: 600; }',
    '.cf-chip.cf-on-neg { border-color: ' + C.danger + '; background: #fdf0ef; color: ' + C.danger + '; font-weight: 600; }',
    '.cf-input {',
    '  width: 100%; min-height: 68px; resize: vertical; box-sizing: border-box;',
    '  padding: 9px 11px; font-size: 13px; line-height: 1.6; font-family: inherit;',
    '  border: 1px solid ' + C.line + '; border-radius: 10px; background: ' + C.card + '; color: ' + C.ink + ';',
    '  outline: none; margin-bottom: 14px;',
    '}',
    '.cf-input:focus { border-color: ' + C.accent + '; }',
    '.cf-settle {',
    '  border: 1px solid ' + C.line + '; border-radius: 10px; padding: 10px 12px;',
    '  background: ' + C.bg + '; margin-bottom: 14px;',
    '}',
    '.cf-check { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; font-size: 13px; color: ' + C.ink + '; }',
    '.cf-check input { margin-top: 2px; accent-color: ' + C.accent2 + '; flex: none; }',
    '.cf-check .cf-check-txt strong { font-weight: 700; }',
    '.cf-settle-hint { font-size: 11.5px; color: ' + C.inkFaint + '; margin: 4px 0 2px 23px; line-height: 1.5; }',
    '.cf-settle-more { margin: 8px 0 0 23px; font-size: 12px; color: ' + C.inkSoft + '; }',
    '.cf-settle-more summary { cursor: pointer; color: ' + C.accent2 + '; outline: none; }',
    '.cf-settle-more ul { margin: 6px 0 0; padding-left: 16px; line-height: 1.7; }',
    '.cf-settle-more li { color: ' + C.inkSoft + '; }',
    '.cf-actions { display: flex; justify-content: flex-end; gap: 10px; }',
    '.cf-cancel {',
    '  padding: 8px 16px; font-size: 13px; border: 1px solid ' + C.line + '; border-radius: 9px;',
    '  background: ' + C.card + '; color: ' + C.inkSoft + '; cursor: pointer;',
    '}',
    '.cf-cancel:hover { border-color: ' + C.accent + '; color: ' + C.accent2 + '; }',
    '.cf-submit {',
    '  padding: 8px 16px; font-size: 13px; font-weight: 600; border: none; border-radius: 9px;',
    '  background: ' + C.accent + '; color: #fff; cursor: pointer;',
    '}',
    '.cf-submit:hover { background: ' + C.accent2 + '; }',
    '.cf-submit:disabled { opacity: .5; cursor: default; }',
    '.cf-toast {',
    '  position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%) translateY(20px);',
    '  background: rgba(32,28,46,.92); color: #fff; font-size: 12.5px; padding: 9px 16px;',
    '  border-radius: 10px; z-index: 100000; opacity: 0; transition: all .18s; pointer-events: none;',
    '  max-width: 80vw;',
    '}',
    '.cf-toast.cf-show { opacity: 1; transform: translateX(-50%) translateY(0); }',
  ].join('\n');

  var _cssInjected = false;
  function ensureCss() {
    if (_cssInjected) return;
    var st = document.createElement('style');
    st.setAttribute('data-cf', '1');
    st.textContent = CSS;
    document.head.appendChild(st);
    _cssInjected = true;
  }

  /* ---------------- 原因选项 + 场景映射（供偏好归类） ---------------- */
  var POS_REASONS = [
    { id: 'accurate',  label: '准确无误' },
    { id: 'clear',     label: '清晰易懂' },
    { id: 'structured',label: '结构合理' },
    { id: 'complete',  label: '内容完整' },
    { id: 'insight',   label: '有新的启发' },
    { id: 'concise',   label: '篇幅合适' },
  ];
  var NEG_REASONS = [
    { id: 'inaccurate',    label: '内容不准确' },
    { id: 'offtopic',      label: '没说到点上' },
    { id: 'verbose',       label: '太啰嗦' },
    { id: 'too_brief',     label: '太简略' },
    { id: 'format',        label: '格式混乱' },
    { id: 'misunderstood', label: '理解错我的意思' },
    { id: 'hallucination', label: '疑似编造/幻觉' },
  ];
  // reason id -> 场景词（用于情绪/偏好 Agent 的 scenario 归类，见 sentiment-agent-core）
  var REASON_SCENARIO = {
    accurate: '准确性', clear: '清晰度', structured: '结构', complete: '完整性',
    insight: '启发性', concise: '篇幅', verbose: '篇幅', too_brief: '篇幅',
    offtopic: '相关性', format: '格式', misunderstood: '理解', hallucination: '准确性',
  };

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  function defaultApi() {
    var ing = window.ingrid || {};
    return {
      observe: typeof ing.sentimentObserve === 'function' ? ing.sentimentObserve : null,
      settle:  typeof ing.settlerSubmit === 'function' ? ing.settlerSubmit : null,
      distill: typeof ing.sentimentDistill === 'function' ? ing.sentimentDistill : null,
    };
  }

  /* ---------------- 提示 toast ---------------- */
  var _toastEl = null, _toastTimer = null;
  function toast(msg) {
    if (!_toastEl) {
      _toastEl = document.createElement('div');
      _toastEl.className = 'cf-toast';
      document.body.appendChild(_toastEl);
    }
    _toastEl.textContent = msg;
    _toastEl.classList.add('cf-show');
    if (_toastTimer) clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { _toastEl.classList.remove('cf-show'); }, 2600);
  }

  /* ---------------- 主入口：attach(bodyEl, opts) ---------------- */
  /**
   * 在 assistant 回复的气泡下方（bodyEl 内）追加固定反馈条，返回控制对象
   * { footer, setRated(v), value() }。点击 👍/👎 打开细化弹窗。
   */
  function attach(bodyEl, opts) {
    ensureCss();
    opts = opts || {};
    var api = opts.api || defaultApi();
    if (!api.observe) { return { footer: null }; }   // 非桌面/旧 preload：静默降级

    var footer = document.createElement('div');
    footer.className = 'cf-footer';

    var state = { valence: '', rated: false };

    var up = document.createElement('button');
    up.className = 'cf-btn cf-up';
    up.type = 'button';
    up.innerHTML = '<span class="cf-icon">👍</span>有帮助';

    var down = document.createElement('button');
    down.className = 'cf-btn cf-down';
    down.type = 'button';
    down.innerHTML = '<span class="cf-icon">👎</span>不满意';

    var note = document.createElement('span');
    note.className = 'cf-note';
    note.textContent = '';

    up.addEventListener('click', function () { openModal('positive', { footer: footer, up: up, down: down, note: note, state: state, opts: opts, api: api }); });
    down.addEventListener('click', function () { openModal('negative', { footer: footer, up: up, down: down, note: note, state: state, opts: opts, api: api }); });

    footer.appendChild(up);
    footer.appendChild(down);
    footer.appendChild(note);
    bodyEl.appendChild(footer);

    return { footer: footer, setRated: setRated.bind(null, state, up, down, note), value: function () { return state.valence; } };
  }

  function setRated(state, up, down, note, valence) {
    state.valence = valence;
    state.rated = true;
    up.classList.toggle('on', valence === 'positive');
    down.classList.toggle('on', valence === 'negative');
    note.textContent = valence === 'positive' ? '已记录 · 感谢反馈' : '已记录 · 会改进';
  }

  /* ---------------- 细化弹窗 ---------------- */
  function openModal(valence, ctx) {
    var reasons = valence === 'positive' ? POS_REASONS : NEG_REASONS;
    var isPos = valence === 'positive';

    // 移除可能残留的旧弹窗
    var old = document.querySelector('.cf-overlay');
    if (old) old.parentNode.removeChild(old);

    var overlay = document.createElement('div');
    overlay.className = 'cf-overlay';

    var modal = document.createElement('div');
    modal.className = 'cf-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    var title = isPos
      ? '这条回答帮到你了 👍'
      : '这条回答哪里不满意 👎';
    var subtitle = isPos
      ? '哪里做得不错？（可多选，也可以直接提交）'
      : '问题出在哪？（可多选）';
    var placeholder = isPos
      ? '还想补充吗？例如希望它以后也这么做……（可选）'
      : '具体说说哪里不对，它应该怎么做？（可选）';
    var settleLabel = isPos
      ? '沉淀为长期偏好，让 AI 以后<b>继续保持</b>'
      : '沉淀为长期偏好，让 AI 以后<b>避免</b>';

    var chipsHtml = reasons.map(function (r) {
      return '<button type="button" class="cf-chip" data-id="' + esc(r.id) + '">' + esc(r.label) + '</button>';
    }).join('');

    modal.innerHTML =
      '<div class="cf-head">' +
        '<div class="cf-title">' + title + '</div>' +
        '<button type="button" class="cf-close" aria-label="关闭">×</button>' +
      '</div>' +
      '<div class="cf-subtitle">' + subtitle + '</div>' +
      '<div class="cf-chips">' + chipsHtml + '</div>' +
      '<textarea class="cf-input" placeholder="' + esc(placeholder) + '"></textarea>' +
      '<div class="cf-settle">' +
        '<label class="cf-check"><input type="checkbox" class="cf-settle-box">' +
          '<span class="cf-check-txt">' + settleLabel + '</span></label>' +
        '<div class="cf-settle-hint">勾选后，会把它提炼成「该多做 / 该避免」的偏好规则，提交给经验沉淀官（人工审批后生效），并自动注入以后的对话指导。</div>' +
        '<details class="cf-settle-more"><summary>不确定是否该沉淀？</summary><ul>' +
          '<li><b>该沉淀：</b>会反复出现的偏好或通用做法，如「总结先给结论再分点」「别啰嗦、控制在几百字内」。</li>' +
          '<li><b>不该沉淀：</b>只针对这一次的临时情况，或与本次内容强绑定的具体细节。</li>' +
          '<li>拿不准也没关系——先不勾选，仅记录本次评价，后续多次同向反馈仍会自动聚合沉淀。</li>' +
        '</ul></details>' +
      '</div>' +
      '<div class="cf-actions">' +
        '<button type="button" class="cf-cancel">取消</button>' +
        '<button type="button" class="cf-submit">提交反馈</button>' +
      '</div>';

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    var chips = Array.prototype.slice.call(modal.querySelectorAll('.cf-chip'));
    var input = modal.querySelector('.cf-input');
    var settleBox = modal.querySelector('.cf-settle-box');
    var submitBtn = modal.querySelector('.cf-submit');
    var selected = {};

    chips.forEach(function (c) {
      c.addEventListener('click', function () {
        var id = c.getAttribute('data-id');
        if (selected[id]) { delete selected[id]; }
        else { selected[id] = true; }
        c.classList.toggle(isPos ? 'cf-on' : 'cf-on-neg', !!selected[id]);
      });
    });

    function close() {
      overlay.classList.remove('cf-show');
      setTimeout(function () { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); }, 160);
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    modal.querySelector('.cf-close').addEventListener('click', close);
    modal.querySelector('.cf-cancel').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);

    submitBtn.addEventListener('click', function () {
      if (submitBtn.disabled) return;
      submitBtn.disabled = true;

      var ids = Object.keys(selected);
      var labels = ids.map(function (id) {
        var r = reasons.filter(function (x) { return x.id === id; })[0];
        return r ? r.label : id;
      });
      var freeText = clean(input.value);
      var scenario = (ids[0] && REASON_SCENARIO[ids[0]]) || '';

      // 组装反馈文本（供情绪/偏好 Agent 记录）
      var parts = [];
      if (labels.length) parts.push((isPos ? '认可：' : '不满：') + labels.join('、'));
      if (freeText) parts.push('补充：' + freeText);
      var text = parts.join('。') || (isPos ? '这条回答有帮助' : '这条回答不满意');

      var approach = freeText;
      if (!approach && labels.length) {
        approach = isPos ? ('继续保持：' + labels.join('、')) : ('应避免：' + labels.join('、'));
      }
      if (!approach) approach = isPos ? '继续保持当前做法' : '请用户补充具体改进方向';

      try {
        // 1) 总是记录一条情绪/评价信号（学习用户偏好）
        var p1 = api.observe({
          text: text,
          valence: valence,
          agent: clean(opts.agent) || '通用',
          sessionId: opts.getSessionId ? opts.getSessionId() : '',
          source: 'feedback',
          context: opts.getContext ? clean(opts.getContext()).slice(0, 800) : '',
          scenario: scenario,
        });
        if (p1 && typeof p1.catch === 'function') p1.catch(function () {});
      } catch (e) { /* 静默 */ }

      // 2) 勾选「沉淀」→ 直接提交经验沉淀官（待人工审批，人工在环铁律不变）
      if (settleBox.checked && api.settle) {
        try {
          var p2 = api.settle({
            source: 'feedback',
            rule: 'user-preference',
            title: (isPos ? '【用户偏好】保持' : '【用户偏好】避免') + (scenario ? '：' + scenario : ''),
            evidence: '用户对「' + (clean(opts.agent) || '通用') + '」的回答点了 ' + (isPos ? '👍' : '👎') + '，反馈：' + text,
            rootCause: isPos ? '用户认可这种做法' : '用户不满意这种做法',
            fixApproach: approach,
          });
          if (p2 && typeof p2.catch === 'function') p2.catch(function () {});
        } catch (e) { /* 静默 */ }
      }

      // 3) 更新按钮状态 + 提示
      setRated(ctx.state, ctx.up, ctx.down, ctx.note, valence);
      close();
      toast(settleBox.checked ? '已记录，并已提交沉淀（待人工审批）' : '已记录，感谢反馈');
    });

    // 打开动画 + 聚焦
    requestAnimationFrame(function () {
      overlay.classList.add('cf-show');
      input.focus();
    });
  }

  /* ---------------- 导出 ---------------- */
  // 立即注入布局样式（.msg-body 等）——addBubble 无条件用到，不能等 attach 才注入
  ensureCss();

  window.ChatFeedback = {
    attach: attach,
    openModal: openModal,
    REASONS: { positive: POS_REASONS, negative: NEG_REASONS },
    _toast: toast,
  };
})();
