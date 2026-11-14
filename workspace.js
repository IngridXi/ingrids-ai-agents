/**
 * workspace.js — 工位库面板（零依赖，local-first）
 *
 * 列出 AI 工位库（Obsidian AI 工位库）里的笔记，每条带「晋升」按钮，
 * 一键搬到主库（默认术语库），把「AI生成」标签换成「已采纳」。
 * 判断权归用户：只有人点按钮，AI 内容才会进主库。
 */
(function () {
  'use strict';
  var IS_DESKTOP = !!(window.ingrid && window.ingrid.isDesktop);

  var STYLE = [
    '.ws-mask{position:fixed;inset:0;background:rgba(20,18,35,.45);display:none;align-items:center;justify-content:center;z-index:300;}',
    '.ws-mask.open{display:flex;}',
    '.ws-panel{position:relative;width:min(720px,94vw);max-height:86vh;display:flex;flex-direction:column;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.25);}',
    '.ws-head{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid #eee;gap:12px;}',
    '.ws-head h2{margin:0;font-size:17px;font-weight:600;color:#2c2c2a;}',
    '.ws-head .ws-sub{font-size:12px;color:#888780;font-weight:400;margin-top:2px;}',
    '.ws-actions{display:flex;align-items:center;gap:8px;}',
    '.ws-target{display:flex;align-items:center;gap:6px;border:1px solid #ddd;border-radius:8px;padding:5px 10px;background:#fff;}',
    '.ws-target .lbl{font-size:12px;color:#5F5E5A;white-space:nowrap;}',
    '.ws-target input{border:none;outline:none;width:84px;font-size:12px;color:#2c2c2a;font-family:inherit;}',
    '.ws-refresh{border:1px solid #ddd;background:#fff;color:#5F5E5A;border-radius:8px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;}',
    '.ws-refresh:hover{border-color:#7F77DD;color:#534AB7;}',
    '.ws-close{border:none;background:transparent;font-size:24px;line-height:1;cursor:pointer;color:#888780;padding:4px 8px;}',
    '.ws-close:hover{color:#2c2c2a;}',
    '.ws-body{flex:1;overflow-y:auto;padding:16px 22px 20px;}',
    '.ws-note{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid #eee;border-radius:12px;margin-bottom:10px;}',
    '.ws-note:hover{border-color:#CECBF6;}',
    '.ws-main{flex:1;min-width:0;}',
    '.ws-title{font-size:14px;font-weight:500;color:#2c2c2a;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
    '.ws-meta{display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap;}',
    '.ws-tag{font-size:11px;color:#534AB7;background:#EEEDFE;border-radius:6px;padding:1px 7px;}',
    '.ws-time{font-size:11px;color:#b4b2a9;}',
    '.ws-promote{border:1px solid #534AB7;background:#EEEDFE;color:#3C3489;border-radius:8px;padding:7px 14px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;display:flex;align-items:center;gap:5px;}',
    '.ws-promote:hover{background:#534AB7;color:#fff;}',
    '.ws-promote:disabled{opacity:.45;cursor:default;}',
    '.ws-empty{text-align:center;color:#888780;font-size:13px;padding:44px 0;}',
    '.ws-err{font-size:13px;color:#A32D2D;background:#FCEBEB;border-radius:8px;padding:12px;}',
    '.ws-toast{position:absolute;top:14px;left:50%;transform:translateX(-50%);background:#3B6D11;color:#fff;font-size:12px;border-radius:8px;padding:8px 16px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:5;max-width:80%;}',
    '.ws-toast.show{opacity:1;}',
    '.ws-toast.err{background:#A32D2D;}',
  ].join('');

  var mask, bodyEl, targetEl, toastEl;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtTime(ms) {
    if (!ms) return '';
    var d = new Date(ms), now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    var hh = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (sameDay) return '今天 ' + hh;
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2) + ' ' + hh;
  }

  function ensurePanel() {
    if (mask) return;
    var st = document.createElement('style');
    st.textContent = STYLE;
    document.head.appendChild(st);
    mask = document.createElement('div');
    mask.className = 'ws-mask';
    mask.innerHTML =
      '<div class="ws-panel">' +
      '  <div class="ws-head">' +
      '    <div><h2>工位库</h2><div class="ws-sub">AI 的凌乱库——确认值得留，再一键晋升到主库</div></div>' +
      '    <div class="ws-actions">' +
      '      <span class="ws-target"><span class="lbl">晋升到</span><input id="wsTargetInput" value="术语库" spellcheck="false"></span>' +
      '      <button class="ws-refresh" type="button">刷新</button>' +
      '      <button class="ws-close" type="button">&times;</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="ws-body"></div>' +
      '</div>';
    document.body.appendChild(mask);
    bodyEl = mask.querySelector('.ws-body');
    targetEl = mask.querySelector('#wsTargetInput');
    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    mask.querySelector('.ws-close').addEventListener('click', close);
    mask.querySelector('.ws-refresh').addEventListener('click', load);
  }

  function open() { ensurePanel(); mask.classList.add('open'); load(); }
  function close() { if (mask) mask.classList.remove('open'); }
  window.__openWorkspace = open;

  function toast(msg, isErr) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'ws-toast';
      mask.querySelector('.ws-panel').appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.toggle('err', !!isErr);
    toastEl.classList.add('show');
    setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
  }

  function load() {
    if (!IS_DESKTOP) {
      bodyEl.innerHTML = '<div class="ws-empty">工位库需在桌面应用中使用</div>';
      return;
    }
    bodyEl.innerHTML = '<div class="ws-empty">正在读取工位库…</div>';
    window.ingrid.workspaceList().then(render).catch(function (e) {
      bodyEl.innerHTML = '<div class="ws-err">加载失败：' + esc((e && e.message) || e) + '</div>';
    });
  }

  function render(r) {
    if (!r || r.ok === false) {
      bodyEl.innerHTML = '<div class="ws-err">' + esc((r && r.error) || '数据异常') + '</div>';
      return;
    }
    if (!r.vault) {
      bodyEl.innerHTML = '<div class="ws-empty">未检测到工位库（Obsidian AI 工位库）</div>';
      return;
    }
    var notes = r.notes || [];
    if (!notes.length) {
      bodyEl.innerHTML = '<div class="ws-empty">工位库还是空的——让 AI 写点东西，或把草稿直接丢进工位库</div>';
      return;
    }
    var upIcon = (typeof window.iconSvg === 'function') ? window.iconSvg('arrowUp') : '↑';
    var html = '';
    notes.forEach(function (n) {
      var tags = (n.tags || []).map(function (t) { return '<span class="ws-tag">' + esc(t) + '</span>'; }).join('');
      html += '<div class="ws-note">' +
        '<div class="ws-main">' +
        '  <div class="ws-title" title="' + esc(n.path) + '">' + esc(n.title || n.name) + '</div>' +
        '  <div class="ws-meta">' + tags + '<span class="ws-time">' + esc(fmtTime(n.mtime)) + '</span></div>' +
        '</div>' +
        '<button class="ws-promote" type="button" data-path="' + esc(n.path) + '">' + upIcon + '<span>晋升</span></button>' +
        '</div>';
    });
    bodyEl.innerHTML = html;
    bodyEl.querySelectorAll('.ws-promote').forEach(function (btn) {
      btn.addEventListener('click', function () { promote(btn.getAttribute('data-path'), btn); });
    });
  }

  function promote(path, btn) {
    var target = (targetEl && targetEl.value || '').trim() || '术语库';
    if (btn) btn.disabled = true;
    window.ingrid.toolDbObsidianPromote({ path: path, folder: target, tags: ['已采纳'] })
      .then(function (res) {
        if (res && res.ok) {
          toast('已晋升到主库「' + target + '」');
          load();
        } else {
          if (btn) btn.disabled = false;
          toast('晋升失败：' + ((res && res.error) || '未知错误'), true);
        }
      })
      .catch(function (e) {
        if (btn) btn.disabled = false;
        toast('晋升失败：' + ((e && e.message) || e), true);
      });
  }
})();
