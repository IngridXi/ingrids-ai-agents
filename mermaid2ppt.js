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
    '    顾客([顾客下单]) --> 订单[生成订单]',
    '    订单 --> 检查{库存充足?}',
    '    检查 -->|是| 拣货[拣货打包]',
    '    检查 -->|否| 补货[补货采购]',
    '    补货 --> 拣货',
    '    拣货 --> 物流[物流发货]',
    '    物流 --> 收货([顾客收货])',
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
    '.m2-left textarea.m2-ghost-example{color:#b6b4ae;}',
    '.m2-right{flex:1;overflow:auto;padding:18px;background:#fbfbfa;display:flex;align-items:flex-start;justify-content:center;}',
    '.m2-right svg{max-width:100%;height:auto;}',
    '.m2-empty{color:#888780;font-size:13px;padding:40px 20px;text-align:center;width:100%;}',
    '.m2-err{color:#A32D2D;font-size:12.5px;background:#FCEBEB;border-radius:8px;padding:12px;width:100%;white-space:pre-wrap;word-break:break-all;font-family:Menlo,Consolas,monospace;}',
    '.m2-foot{display:flex;align-items:center;gap:10px;padding:10px 20px;border-top:1px solid #eee;font-size:12px;color:#888780;}',
    '.m2-foot .m2-status{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  ].join('');

  var mask, inputEl, previewEl, styleSel, modeSel, statusEl, exportBtn;
  var renderSeq = 0;
  var debounceTimer = null;
  var ghostExample = false; // 输入框当前是否显示「灰色示例占位」（点击即清空，供直接输入）

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
      '    <div><h2>流程图</h2><div class="m2-sub">预览用 mermaid.js；流程图 / 时序图导出可编辑形状，其余图导出高清图片</div></div>' +
      '    <div class="m2-actions">' +
      '      <select id="m2-style" title="导出样式"><option value="native">native 样式</option><option value="official">official 样式</option></select>' +
      '      <select id="m2-mode" title="导出方式"><option value="auto">智能导出</option><option value="shapes">可编辑形状</option><option value="image">高清图片</option></select>' +
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
    styleSel = mask.querySelector('#m2-style');
    modeSel = mask.querySelector('#m2-mode');
    statusEl = mask.querySelector('.m2-status');
    exportBtn = mask.querySelector('.m2-export');

    mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
    mask.querySelector('.m2-close').addEventListener('click', close);
    mask.querySelector('.m2-ghost').addEventListener('click', function () {
      // 「示例」按钮：作为真实内容载入（非占位，正常深色），便于用户在此基础上改
      ghostExample = false;
      inputEl.classList.remove('m2-ghost-example');
      inputEl.value = EXAMPLE;
      renderPreview();
    });
    exportBtn.addEventListener('click', exportPpt);
    // 点击占位示例 → 立即清空，直接输入新代码
    inputEl.addEventListener('focus', function () {
      if (ghostExample) clearGhost();
    });
    inputEl.addEventListener('blur', function () {
      if (!inputEl.value.trim()) setGhost();
    });
    inputEl.addEventListener('input', function () {
      if (ghostExample) clearGhost();
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(renderPreview, 350);
    });

    if (window.mermaid && window.mermaid.initialize) {
      try {
        window.mermaid.initialize({ startOnLoad: false, theme: 'neutral', securityLevel: 'loose' });
      } catch (e) { /* 忽略重复初始化 */ }
    }
  }

  function setGhost() {
    ghostExample = true;
    inputEl.value = EXAMPLE;
    inputEl.classList.add('m2-ghost-example');
    renderPreview();
  }
  function clearGhost() {
    ghostExample = false;
    inputEl.classList.remove('m2-ghost-example');
    if (inputEl.value === EXAMPLE) inputEl.value = '';
    renderPreview();
  }

  function open() {
    ensurePanel();
    mask.classList.add('open');
    // 空框时用灰色示例作为占位提示，点击即可直接输入（不再需要手动删旧代码）
    if (!inputEl.value.trim()) setGhost();
    else renderPreview();
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

  function diagramKind(src) {
    if (/^\s*(flowchart|graph)\b/.test(src)) return 'flowchart';
    if (/^\s*sequenceDiagram\b/.test(src)) return 'sequence';
    if (/^\s*classDiagram\b/.test(src)) return 'class';
    if (/^\s*stateDiagram\b/.test(src)) return 'state';
    if (/^\s*erDiagram\b/.test(src)) return 'er';
    return 'other';
  }

  // 把 mermaid.js 渲染出的 SVG 转成高清 PNG（base64 dataURL），用于图片导出保真
  function svgToPng(svgText, scale) {
    return new Promise(function (resolve, reject) {
      scale = scale || 2;
      var m = (svgText || '').match(/viewBox=["']\s*([-\d.,\s]+)\s*["']/);
      var w = 0, h = 0;
      if (m) {
        var p = m[1].trim().split(/[\s,]+/).map(Number);
        if (p.length === 4) { w = p[2]; h = p[3]; }
      }
      var svg = svgText;
      if (w > 0 && !/<svg[^>]*\swidth=/.test(svg)) {
        svg = svg.replace('<svg', '<svg width="' + w + '" height="' + h + '"');
      }
      var blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var img = new Image();
      img.onload = function () {
        try {
          var sw = w || img.naturalWidth || img.width;
          var sh = h || img.naturalHeight || img.height;
          var canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(sw * scale));
          canvas.height = Math.max(1, Math.round(sh * scale));
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/png'));
        } catch (e) { reject(e); } finally { URL.revokeObjectURL(url); }
      };
      img.onerror = function (e) { URL.revokeObjectURL(url); reject(e || new Error('SVG 图片加载失败')); };
      img.src = url;
    });
  }

  function exportPpt() {
    if (ghostExample) { statusEl.textContent = '请先输入 Mermaid 代码（点击左侧输入框即可开始）'; return; }
    var src = inputEl.value.trim();
    if (!src) { statusEl.textContent = '请先输入 Mermaid 代码'; return; }
    if (!IS_DESKTOP) { statusEl.textContent = '导出需在桌面应用中使用'; return; }

    var mode = (modeSel && modeSel.value) || 'auto';
    var kind = diagramKind(src);
    // 智能导出：flowchart / sequence 用可编辑形状（专用渲染器，版面与预览一致）；
    // 其余图（class/state/ER/pie 等）diagram-pptx 布局质量差，走高清图片。
    var useImage = mode === 'image' || (mode === 'auto' && kind !== 'flowchart' && kind !== 'sequence');
    if (useImage) exportImage(src, kind);
    else exportShapes(src, kind);
  }

  function exportShapes(src, kind) {
    exportBtn.disabled = true;
    statusEl.textContent = kind === 'sequence' ? '正在导出（可编辑时序图）…' : '正在导出（可编辑形状）…';
    window.ingrid.mermaid2pptExport({ source: src, style: styleSel.value }).then(function (r) {
      exportBtn.disabled = false;
      if (r && r.canceled) { statusEl.textContent = '已取消导出'; return; }
      if (r && r.ok) {
        var d = r.diagnostics || 0;
        var renamed = r.renamed || 0;
        var note = renamed ? '（已自动转换 ' + renamed + ' 个中文节点 ID）' : '';
        statusEl.textContent = '已导出：' + (r.path || '') + note + (d ? '（含 ' + d + ' 条提示）' : '');
      } else {
        var errMsg = (r && r.error) || '未知错误';
        if (/cannot model|native backend/i.test(errMsg)) {
          errMsg += '\n\n提示：中文节点 ID 已自动转换，此报错通常来自其他不支持的语法（如 classDef/style/click 引用，或非法边写法）。';
        }
        statusEl.textContent = '导出失败';
        window.alert('导出失败：\n' + errMsg);
      }
    }).catch(function (e) {
      exportBtn.disabled = false;
      statusEl.textContent = '导出失败：' + ((e && e.message) || e);
    });
  }

  function exportImage(src, kind) {
    exportBtn.disabled = true;
    statusEl.textContent = kind === 'flowchart' ? '正在渲染高清图片…' : '该图类型导出为高清图片（与预览一致）…';
    var id = 'm2ppt-img-' + (++renderSeq);
    window.mermaid.render(id, src).then(function (r) {
      return svgToPng(r.svg, 2);
    }).then(function (dataUrl) {
      var b64 = String(dataUrl || '').split(',')[1] || '';
      if (!b64) throw new Error('图片编码失败');
      return window.ingrid.mermaid2pptImage({ png: b64 });
    }).then(function (r) {
      exportBtn.disabled = false;
      if (r && r.canceled) { statusEl.textContent = '已取消导出'; return; }
      if (r && r.ok) {
        statusEl.textContent = '已导出（高清图片）：' + (r.path || '');
      } else {
        statusEl.textContent = '导出失败';
        window.alert('导出失败：\n' + ((r && r.error) || '未知错误'));
      }
    }).catch(function (e) {
      exportBtn.disabled = false;
      statusEl.textContent = '导出失败：' + ((e && e.message) || e);
    });
  }
})();
