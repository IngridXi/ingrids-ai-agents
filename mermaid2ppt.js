/**
 * mermaid2ppt.js — 「流程图」工具面板（local-first）
 *
 * 左侧粘贴 Mermaid 代码，右侧 mermaid.js 实时预览，点「导出 PPT」调主进程
 * 生成可编辑原生形状的 .pptx（底层 diagram-pptx，复用本机 venv_mermaid 环境）。
 */
(function () {
  'use strict';
  var IS_DESKTOP = !!(window.ingrid && window.ingrid.isDesktop);

  var EXAMPLE = [
    'flowchart LR',
    '    Customer([顾客下单]) --> Order[生成订单]',
    '    Order --> Check{库存充足?}',
    '    Check -->|是| Pick[拣货打包]',
    '    Check -->|否| Backorder[补货采购]',
    '    Backorder --> Pick',
    '    Pick --> Ship[物流发货]',
    '    Ship --> Deliver([顾客收货])',
  ].join('\n');

  var STYLE = [
    '.m2-mask{position:fixed;inset:0;background:rgba(20,18,35,.45);display:none;align-items:center;justify-content:center;z-index:300;}',
    '.m2-mask.open{display:flex;}',
    '.m2-panel{width:min(1120px,96vw);max-height:90vh;display:flex;flex-direction:column;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.25);}',
    '.m2-head{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid #eee;}',
    '.m2-head h2{margin:0;font-size:17px;font-weight:600;color:#2c2c2a;}',
    '.m2-head .m2-sub{font-size:12px;color:#888780;font-weight:400;margin-top:2px;}',
    '.m2-head .m2-actions{display:flex;align-items:center;gap:8px;}',
    '.m2-head select{border:1px solid #ddd;background:#fff;color:#5F5E5A;border-radius:8px;padding:6px 8px;font-size:12px;font-family:inherit;cursor:pointer;}',
    '.m2-export{border:none;background:#7F77DD;color:#fff;border-radius:8px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;}',
    '.m2-export:hover{background:#6C63C9;}',
    '.m2-export:disabled{background:#c5c0ec;cursor:default;}',
    '.m2-ghost{border:1px solid #ddd;background:#fff;color:#5F5E5A;border-radius:8px;padding:6px 14px;font-size:12px;cursor:pointer;font-family:inherit;}',
    '.m2-ghost:hover{border-color:#7F77DD;color:#534AB7;}',
    '.m2-close{border:none;background:transparent;font-size:24px;line-height:1;cursor:pointer;color:#888780;padding:4px 8px;}',
    '.m2-close:hover{color:#2c2c2a;}',
    '.m2-body{flex:1;display:flex;min-height:0;}',
    '.m2-left{width:46%;display:flex;flex-direction:column;border-right:1px solid #eee;min-width:0;}',
    '.m2-left textarea{flex:1;border:none;resize:none;outline:none;padding:16px;font-family:Menlo,Consolas,monospace;font-size:12.5px;line-height:1.6;color:#2c2c2a;background:#fbfbfa;}',
    '.m2-right{flex:1;overflow:auto;padding:18px;background:#fbfbfa;display:flex;align-items:flex-start;justify-content:center;}',
    '.m2-right svg{max-width:100%;height:auto;}',
    '.m2-empty{color:#888780;font-size:13px;padding:40px 20px;text-align:center;width:100%;}',
    '.m2-err{color:#A32D2D;font-size:12.5px;background:#FCEBEB;border-radius:8px;padding:12px;width:100%;white-space:pre-wrap;word-break:break-all;font-family:Menlo,Consolas,monospace;}',
    '.m2-foot{display:flex;align-items:center;gap:10px;padding:10px 20px;border-top:1px solid #eee;font-size:12px;color:#888780;}',
    '.m2-foot .m2-status{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  ].join('');

  var mask, inputEl, previewEl, styleSel, statusEl, exportBtn;
  var renderSeq = 0;
  var debounceTimer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function ensurePanel() {
    if (mask) return;
    var st = document.createElement('style');
    st.textContent = STYLE;
    document.head.appendChild(st);

    mask = document.createElement('div');
    mask.className = 'm2-mask';
    mask.innerHTML =
      '<div class="m2-panel">' +
      '  <div class="m2-head">' +
      '    <div><h2>流程图</h2><div class="m2-sub">Mermaid 代码 → 可编辑 PPT（预览用 mermaid.js，导出用 diagram-pptx）</div></div>' +
      '    <div class="m2-actions">' +
      '      <select title="导出样式"><option value="native">native 样式</option><option value="official">official 样式</option></select>' +
      '      <button class="m2-ghost" type="button" title="载入示例">示例</button>' +
      '      <button class="m2-export" type="button">导出 PPT</button>' +
      '      <button class="m2-close" type="button">&times;</button>' +
      '    </div>' +
      '  </div>' +
      '  <div class="m2-body">' +
      '    <div class="m2-left"><textarea spellcheck="false" placeholder="在此粘贴 Mermaid 代码，例如 flowchart LR …"></textarea></div>' +
      '    <div class="m2-right"><div class="m2-empty">输入 Mermaid 代码后实时预览</div></div>' +
      '  </div>' +
      '  <div class="m2-foot"><span class="m2-status">就绪</span><span>支持 flowchart / sequence / class / ER / state 图</span></div>' +
      '</div>';
    document.body.appendChild(mask);

    inputEl = mask.querySelector('textarea');
    previewEl = mask.querySelector('.m2-right');
    styleSel = mask.querySelector('select');
    statusEl = mask.querySelector('.m2-status');
    exportBtn = mask.querySelector('.m2-export');

    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    mask.querySelector('.m2-close').addEventListener('click', close);
    mask.querySelector('.m2-ghost').addEventListener('click', function () {
      inputEl.value = EXAMPLE;
      renderPreview();
    });
    exportBtn.addEventListener('click', exportPpt);
    inputEl.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(renderPreview, 350);
    });

    if (window.mermaid && window.mermaid.initialize) {
      try {
        window.mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' });
      } catch (e) { /* 忽略重复初始化 */ }
    }
  }

  function open() {
    ensurePanel();
    mask.classList.add('open');
    if (!inputEl.value.trim()) inputEl.value = EXAMPLE;
    renderPreview();
  }
  function close() { if (mask) mask.classList.remove('open'); }
  window.__openMermaid = open;

  function renderPreview() {
    var src = inputEl.value.trim();
    if (!src) {
      previewEl.innerHTML = '<div class="m2-empty">输入 Mermaid 代码后实时预览</div>';
      return;
    }
    if (!window.mermaid) {
      previewEl.innerHTML = '<div class="m2-err">未加载 mermaid 渲染库（vendor/mermaid.min.js）</div>';
      return;
    }
    // 先做语法校验，出错直接提示，不进入渲染
    try {
      window.mermaid.parse(src);
    } catch (e) {
      previewEl.innerHTML = '<div class="m2-err">语法错误：' + esc((e && e.message) || e) + '</div>';
      return;
    }
    var id = 'm2ppt-' + (++renderSeq);
    window.mermaid.render(id, src).then(function (r) {
      previewEl.innerHTML = r.svg;
    }).catch(function (e) {
      previewEl.innerHTML = '<div class="m2-err">渲染失败：' + esc((e && e.message) || e) + '</div>';
    });
  }

  function exportPpt() {
    var src = inputEl.value.trim();
    if (!src) { statusEl.textContent = '请先输入 Mermaid 代码'; return; }
    if (!IS_DESKTOP) { statusEl.textContent = '导出需在桌面应用中使用'; return; }
    exportBtn.disabled = true;
    statusEl.textContent = '正在导出…';
    window.ingrid.mermaid2pptExport({ source: src, style: styleSel.value }).then(function (r) {
      exportBtn.disabled = false;
      if (r && r.canceled) { statusEl.textContent = '已取消导出'; return; }
      if (r && r.ok) {
        var d = r.diagnostics || 0;
        statusEl.textContent = '已导出：' + (r.path || '') + (d ? '（含 ' + d + ' 条提示）' : '');
      } else {
        var errMsg = (r && r.error) || '未知错误';
        if (/cannot model|native backend/i.test(errMsg)) {
          errMsg += '\n\n常见原因：节点 ID 用了中文（如「顾客[顾客下单]」）。请把 ID 改成英文、中文放在标签里，例如「Customer[顾客下单]」。';
        }
        statusEl.textContent = '导出失败';
        window.alert('导出失败：\n' + errMsg);
      }
    }).catch(function (e) {
      exportBtn.disabled = false;
      statusEl.textContent = '导出失败：' + ((e && e.message) || e);
    });
  }
})();
