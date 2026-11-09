/* ============================================================
 * knowledge.js — 知识库面板（Zotero / Obsidian / Notion 统一入口）
 *
 * 左侧导航「知识库」→ window.__openKnowledge()
 * 三个来源：连接状态 + 直接打开（应用 / 网页 / 本地目录）+ 跨库检索
 * 本机优先：Zotero 与 Obsidian 内容在本机建立索引；Notion 走官方 API。
 * ============================================================ */
(function () {
  'use strict';
  var DESKTOP = !!(window.ingrid && window.ingrid.isDesktop);
  var iconSvg = window.iconSvg || function () { return ''; };
  function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  var CSS = [
    '#kbMask{position:fixed;inset:0;background:rgba(23,59,73,.42);backdrop-filter:blur(3px);display:none;align-items:center;justify-content:center;padding:24px;z-index:60;}',
    '#kbMask.open{display:flex;}',
    '#kbModal{width:min(620px,100%);max-height:88vh;overflow:auto;background:#fff;border-radius:22px;box-shadow:0 22px 52px rgba(34,31,51,.18);padding:26px 28px;color:#221f33;font-size:13.5px;line-height:1.6;}',
    '#kbModal h2{font-size:20px;font-weight:700;display:flex;align-items:center;gap:9px;}',
    '#kbModal h2 .ic{color:#6c5ce7;}',
    '#kbModal .kb-sub{color:#a29baf;font-size:12.5px;margin-top:3px;}',
    '#kbModal .kb-head{display:flex;align-items:flex-start;gap:13px;margin-bottom:18px;}',
    '#kbModal .kb-close{margin-left:auto;flex:none;width:32px;height:32px;border-radius:9px;border:1px solid #eae8f0;background:#f1f0f5;color:#5e596e;font-size:16px;cursor:pointer;line-height:1;}',
    '#kbModal .kb-search{display:flex;gap:8px;margin-bottom:18px;}',
    '#kbModal .kb-search input{flex:1;padding:10px 13px;border:1px solid #eae8f0;border-radius:11px;font-size:13.5px;color:#221f33;background:#fff;}',
    '#kbModal .kb-search input:focus{outline:none;border-color:#6c5ce7;}',
    '#kbModal .kb-search button{padding:10px 16px;border:none;border-radius:11px;background:#6c5ce7;color:#fff;font-size:13px;font-weight:650;cursor:pointer;display:flex;align-items:center;gap:6px;}',
    '#kbModal .kb-search button:hover{background:#5a4bd1;}',
    '#kbModal .kb-src{border:1px solid #eae8f0;border-radius:14px;padding:15px 16px;margin-bottom:12px;background:#fff;}',
    '#kbModal .kb-src .top{display:flex;align-items:center;gap:11px;}',
    '#kbModal .kb-src .ic{width:42px;height:42px;border-radius:11px;display:grid;place-items:center;font-size:21px;flex:none;background:#f6f4fd;}',
    '#kbModal .kb-src .nm{font-size:15px;font-weight:700;}',
    '#kbModal .kb-src .st{margin-left:auto;font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;flex:none;white-space:nowrap;}',
    '#kbModal .kb-src .st.ok{background:#e9f7ee;color:#16a34a;}',
    '#kbModal .kb-src .st.miss{background:#f1f0f5;color:#a29baf;}',
    '#kbModal .kb-src .meta{font-size:12px;color:#5e596e;margin-top:7px;line-height:1.55;}',
    '#kbModal .kb-src .meta .p{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;color:#a29baf;word-break:break-all;}',
    '#kbModal .kb-src .acts{display:flex;gap:8px;margin-top:11px;flex-wrap:wrap;}',
    '#kbModal .kb-src .acts button{padding:7px 13px;border-radius:9px;border:1px solid #eae8f0;background:#fff;color:#5e596e;font-size:12.5px;font-weight:650;cursor:pointer;display:flex;align-items:center;gap:5px;}',
    '#kbModal .kb-src .acts button:hover{border-color:#6c5ce7;color:#6c5ce7;background:#f6f4fd;}',
    '#kbModal .kb-src .acts button.primary{background:#6c5ce7;border-color:#6c5ce7;color:#fff;}',
    '#kbModal .kb-src .acts button.primary:hover{background:#5a4bd1;color:#fff;}',
    '#kbModal .kb-src .cfgrow{display:flex;gap:8px;margin-top:10px;}',
    '#kbModal .kb-src .cfgrow input{flex:1;padding:9px 11px;border:1px solid #eae8f0;border-radius:9px;font-size:13px;color:#221f33;background:#fff;}',
    '#kbModal .kb-res{margin-bottom:18px;border:1px solid #eae8f0;border-radius:12px;padding:12px 14px;background:#fbfafd;font-size:12.5px;color:#5e596e;max-height:220px;overflow:auto;}',
    '#kbModal .kb-res .it{padding:8px 0;border-bottom:1px solid #eae8f0;}',
    '#kbModal .kb-res .it:last-child{border-bottom:none;}',
    '#kbModal .kb-res .it b{color:#221f33;}',
    '#kbModal .kb-res .it .src{font-size:10.5px;color:#6c5ce7;font-weight:700;}',
    '#kbModal .kb-res .it .p{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#a29baf;margin-top:2px;word-break:break-all;}',
    '#kbModal .kb-hint{margin-top:14px;font-size:11.5px;color:#a29baf;line-height:1.6;}',
  ].join('\n');

  var style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  var mask = document.createElement('div');
  mask.id = 'kbMask';
  mask.innerHTML = '<div id="kbModal"></div>';
  document.body.appendChild(mask);
  var modal = mask.querySelector('#kbModal');

  /* 术语图谱进度（全局只注册一次，避免重复构建累积监听） */
  var termsStatusEl = null;
  if (DESKTOP && window.ingrid.onKbTermsProgress) {
    window.ingrid.onKbTermsProgress(function (p) {
      if (!termsStatusEl || !p) return;
      if (p.phase === 'ollama') {
        termsStatusEl.textContent = p.msg || '正在启动本地 Ollama…';
      } else if (p.phase === 'extract') {
        termsStatusEl.textContent = '正在提取术语… 本次处理 ' + p.done + ' / ' + p.total + ' 篇（已构建的自动跳过）';
      }
    });
  }

  /* ---------- 打开来源（应用 / 网页 / 本地目录） ---------- */
  function openSource(kind) {
    if (!DESKTOP) { alert('请在桌面版使用'); return; }
    window.ingrid.kbOpen(kind).then(function (r) {
      if (r && !r.ok) alert(r.error || '打开失败');
    }).catch(function (e) { alert(String(e && e.message || e)); });
  }

  /* ---------- 跨库检索：本地知识库（Zotero+Obsidian） + Notion ---------- */
  function doSearch(q) {
    var box = modal.querySelector('#kbRes');
    box.style.display = 'block';
    box.innerHTML = '搜索中…';
    var jobs = [];
    if (DESKTOP && window.ingrid.kbSearch) {
      jobs.push(window.ingrid.kbSearch(q, 5).then(function (r) { return { src: '本地知识库', list: r || [] }; }).catch(function () { return { src: '本地知识库', list: [] }; }));
    }
    if (DESKTOP && window.ingrid.notionSearch) {
      jobs.push(window.ingrid.notionSearch(q).then(function (r) { return { src: 'Notion', list: (r && r.ok && r.results) ? r.results : [] }; }).catch(function () { return { src: 'Notion', list: [] }; }));
    }
    Promise.all(jobs).then(function (groups) {
      var html = '';
      var total = 0;
      groups.forEach(function (g) {
        (g.list || []).forEach(function (it) {
          if (!it || !it.title) return;
          total++;
          html += '<div class="it"><span class="src">' + esc(g.src) + '</span> · <b>' + esc(it.title) + '</b>';
          if (it.relPath) html += '<div class="p">' + esc(it.relPath) + '</div>';
          if (it.object) html += '<div class="p">' + (it.object === 'database' ? '🗂️ 数据库' : '📄 页面') + ' · ' + esc(it.id || '') + '</div>';
          html += '</div>';
        });
      });
      box.innerHTML = total ? html : '<div>没有找到相关内容。若 Notion 未配 token，此处只搜本地知识库（Zotero + Obsidian）。</div>';
    });
  }

  /* ---------- 三个来源卡片 ---------- */
  function srcCard(o) {
    return '<div class="kb-src"><div class="top">' +
      '<div class="ic">' + o.icon + '</div>' +
      '<div><div class="nm">' + esc(o.name) + '</div></div>' +
      '<span class="st ' + (o.ok ? 'ok' : 'miss') + '">' + esc(o.ok ? o.okText : o.missText) + '</span>' +
      '</div>' +
      (o.meta ? '<div class="meta">' + o.meta + '</div>' : '') +
      '<div class="acts">' + o.acts.map(function (a) {
        return '<button data-kind="' + esc(a.kind) + '">' + iconSvg('link') + esc(a.label) + '</button>';
      }).join('') + '</div>' +
      '</div>';
  }

  function notionCard(configured) {
    return '<div class="kb-src"><div class="top">' +
      '<div class="ic">🧠</div>' +
      '<div><div class="nm">Notion</div></div>' +
      '<span class="st ' + (configured ? 'ok' : 'miss') + '">' + (configured ? '已连接' : '未连接') + '</span>' +
      '</div>' +
      '<div class="meta">' + (configured ? 'token 已保存（加密存本机），可跨库搜索' : '需在 notion.so/my-integrations 建集成，复制 token 后粘贴到这里') + '</div>' +
      '<div class="acts">' +
        '<button data-kind="notion">' + iconSvg('link') + '打开 Notion</button>' +
        '<button id="kbNotionCfg">' + iconSvg('key') + (configured ? '重新配置 token' : '配置 token') + '</button>' +
      '</div>' +
      '<div id="kbNotionBox" style="display:none" class="cfgrow">' +
        '<input id="kbNotionToken" type="password" placeholder="ntn_... 或 secret_...">' +
        '<button id="kbNotionSave" class="primary">保存</button>' +
      '</div>' +
      '</div>';
  }

  /* ---------- 渲染骨架 ---------- */
  function render() {
    modal.innerHTML =
      '<div class="kb-head">' +
        '<div><h2><span class="ic">' + iconSvg('book') + '</span>知识库</h2><div class="kb-sub">Zotero · Obsidian · Notion 三个来源，统一进入与检索</div></div>' +
        '<button class="kb-close" id="kbClose">✕</button>' +
      '</div>' +
      '<div class="kb-search"><input id="kbQuery" placeholder="跨库搜索：文献 / 笔记 / Notion 页面…"><button id="kbSearchBtn">' + iconSvg('search') + '搜索</button></div>' +
      '<div id="kbRes" class="kb-res" style="display:none"></div>' +
      '<div id="kbSources"><div class="kb-hint">检测中…</div></div>' +
      '<div class="kb-src" style="border-color:#6c5ce7">' +
        '<div class="top"><div class="ic">🕸️</div><div><div class="nm">术语图谱</div></div><span class="st miss">Zotero → Obsidian</span></div>' +
        '<div class="meta">从 Zotero 文献自动提取术语（理论 / 概念 / 商业词汇），按共现关系连线，写入 Obsidian「术语库/」。图谱里只想看术语、不想看到「文献综述/概念笔记」等其他笔记时，在 Obsidian 图谱视图过滤框输入 <b>path:术语库</b> 即可。</div>' +
        '<div class="cfgrow" style="margin-top:11px">' +
          '<label style="flex:1;display:flex;flex-direction:column;font-size:11px;color:#a29baf;gap:4px">文献数<input id="kbTermsMax" type="number" min="10" max="1000" step="10" value="200" style="width:100%;padding:8px 10px;border:1px solid #eae8f0;border-radius:8px;font-size:13px;color:#221f33"></label>' +
          '<label style="flex:1;display:flex;flex-direction:column;font-size:11px;color:#a29baf;gap:4px">术语数<input id="kbTermsTopK" type="number" min="10" max="300" step="10" value="80" style="width:100%;padding:8px 10px;border:1px solid #eae8f0;border-radius:8px;font-size:13px;color:#221f33"></label>' +
        '</div>' +
        '<div class="acts">' +
          '<button id="kbTermsBuild" class="primary">' + iconSvg('sparkles') + '构建术语网</button>' +
          '<button data-kind="obsidian">' + iconSvg('link') + '打开 Obsidian 看图谱</button>' +
        '</div>' +
        '<div id="kbTermsStatus" class="meta" style="margin-top:9px"></div>' +
        '<div id="kbTermsResult" class="kb-res" style="display:none;margin-top:9px;margin-bottom:0"></div>' +
      '</div>' +
      '<div class="kb-hint">本机优先：Zotero 与 Obsidian 内容在本机建立索引；Notion 走官方 API。「打开」会用系统默认方式启动对应应用或目录。</div>';

    modal.querySelector('#kbClose').addEventListener('click', close);
    modal.querySelector('#kbSearchBtn').addEventListener('click', function () {
      var q = modal.querySelector('#kbQuery').value.trim();
      if (q) doSearch(q);
    });
    modal.querySelector('#kbQuery').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { var q = this.value.trim(); if (q) doSearch(q); }
    });

    // 术语图谱区的「打开」按钮（此时 kbSources 尚未填充，只有术语网区带 data-kind）
    modal.querySelectorAll('[data-kind]').forEach(function (b) {
      b.addEventListener('click', function () { openSource(b.getAttribute('data-kind')); });
    });

    // 术语图谱构建
    var termsBuild = modal.querySelector('#kbTermsBuild');
    if (termsBuild) {
      termsBuild.addEventListener('click', function () {
        if (!DESKTOP || !window.ingrid.kbTermsBuild) { alert('术语图谱需在桌面版使用（并运行本地 Ollama）'); return; }
        var status = modal.querySelector('#kbTermsStatus');
        var result = modal.querySelector('#kbTermsResult');
        var maxItems = parseInt(modal.querySelector('#kbTermsMax').value, 10) || 200;
        var topK = parseInt(modal.querySelector('#kbTermsTopK').value, 10) || 80;
        if (maxItems < 1 || topK < 1) { alert('文献数与术语数需为正整数'); return; }
        var btn = this;
        btn.disabled = true;
        btn.textContent = '构建中…（需本地 Ollama）';
        termsStatusEl = status;
        status.textContent = '准备中… 将处理 ' + maxItems + ' 篇文献，约需 1–10 分钟（取决于本地模型速度）';
        window.ingrid.kbTermsBuild({ maxItems: maxItems, topK: topK }).then(function (r) {
          btn.disabled = false;
          btn.textContent = '构建术语网';
          termsStatusEl = null;
          if (!r || !r.ok) { status.textContent = '失败：' + ((r && r.error) || '未知错误'); return; }
          var rangeNote = (r.totalItems != null) ? '（本次范围 ' + r.maxItems + ' / 共 ' + r.totalItems + ' 篇）' : '';
          if (r.processedCount === 0 && r.skippedCount > 0) {
            status.textContent = '已完成：全部 ' + r.skippedCount + ' 篇文献都已构建过，本次跳过（无新文献）。' + rangeNote;
          } else if (r.skippedCount > 0) {
            status.textContent = '完成：本次新处理 ' + r.processedCount + ' 篇，跳过已构建 ' + r.skippedCount + ' 篇；共 ' + r.allTermCount + ' 个术语' + rangeNote;
          } else {
            status.textContent = '完成：' + r.allTermCount + ' 个术语 · 重写 ' + r.noteCount + ' 篇笔记' + rangeNote;
          }
          result.style.display = 'block';
          var termsHtml = (r.terms || []).slice(0, 25).map(function (t) {
            return '<div class="it"><span class="src">' + esc(t.category) + '</span> · <b>' + esc(t.term) + '</b>' +
              (t.zh ? '<div style="color:#5e596e;margin-top:2px">' + esc(t.zh) + '</div>' : '') + '</div>';
          }).join('');
          var writeNote = (r.processedCount === 0)
            ? '本次无新文献，未改动笔记。当前术语网共 ' + r.allTermCount + ' 个术语、' + (r.edges ? r.edges.length : 0) + ' 条关联。'
            : '重写 ' + r.noteCount + ' 篇术语笔记（每次覆盖，保证每个术语的「相关术语」双链都是最新的）+ 刷新总览图（' + (r.edges ? r.edges.length : 0) + ' 条关联）。';
          result.innerHTML = '<div style="margin-bottom:8px">' + writeNote + ' 点上方「打开 Obsidian 看图谱」→ 打开「术语总览」→ 切到图谱视图看网状图。</div>' + termsHtml;
        }).catch(function (e) {
          btn.disabled = false;
          btn.textContent = '构建术语网';
          termsStatusEl = null;
          status.textContent = '失败：' + String(e && e.message || e);
        });
      });
    }

    if (!DESKTOP) {
      modal.querySelector('#kbSources').innerHTML = '<div class="kb-hint">浏览器预览模式，知识库接入请在桌面版使用。</div>';
      return;
    }
    loadStatus();
  }

  /* ---------- 异步加载三来源状态 ---------- */
  function loadStatus() {
    var box = modal.querySelector('#kbSources');
    var kbStatus = window.ingrid.kbStatus ? window.ingrid.kbStatus() : Promise.resolve(null);
    var notionStatus = window.ingrid.notionStatus ? window.ingrid.notionStatus() : Promise.resolve(null);
    var zoteroReport = window.ingrid.toolDbZoteroReport ? window.ingrid.toolDbZoteroReport().catch(function () { return { ok: false }; }) : Promise.resolve({ ok: false });
    var obsidianReport = window.ingrid.toolDbObsidianReport ? window.ingrid.toolDbObsidianReport().catch(function () { return { ok: false }; }) : Promise.resolve({ ok: false });

    Promise.all([kbStatus, notionStatus, zoteroReport, obsidianReport]).then(function (res) {
      var kb = res[0] || {};
      var nt = res[1] || {};
      var zr = res[2] || {};
      var or_ = res[3] || {};

      var sources = kb.sources || [];
      var obsSource = sources.filter(function (s) { return s.type === 'markdown'; })[0];
      var obsPath = (or_ && or_.vault) || (obsSource && obsSource.path) || null;
      var zoteroDetected = kb.zoteroDetected !== undefined ? kb.zoteroDetected : !!zr.ok;

      var html = '';

      html += srcCard({
        icon: '📚', name: 'Zotero', ok: !!zoteroDetected,
        okText: zr.ok ? (zr.total + ' 条文献') : '已检测到',
        missText: '未检测到（~/Zotero）',
        meta: zr.ok ? ('已打标签 ' + zr.withTags + ' · 未打标签 ' + zr.withoutTags) : '',
        acts: [
          { kind: 'zotero', label: '打开 Zotero' },
          { kind: 'zotero-folder', label: '打开数据目录' },
        ],
      });

      html += srcCard({
        icon: '📝', name: 'Obsidian', ok: !!obsPath,
        okText: or_.ok ? (or_.total + ' 篇笔记') : '已检测到',
        missText: '未检测到（需建库）',
        meta: obsPath ? '<span class="p">' + esc(obsPath) + '</span>' : '',
        acts: [
          { kind: 'obsidian', label: '打开 Obsidian' },
          { kind: 'obsidian-folder', label: '打开库文件夹' },
        ],
      });

      html += notionCard(!!nt.configured);

      box.innerHTML = html;

      box.querySelectorAll('[data-kind]').forEach(function (b) {
        b.addEventListener('click', function () { openSource(b.getAttribute('data-kind')); });
      });

      // Notion token 配置
      var cfgBtn = box.querySelector('#kbNotionCfg');
      var saveBtn = box.querySelector('#kbNotionSave');
      if (cfgBtn) cfgBtn.addEventListener('click', function () {
        var b = box.querySelector('#kbNotionBox');
        if (b) b.style.display = b.style.display === 'none' ? 'flex' : 'none';
      });
      if (saveBtn) saveBtn.addEventListener('click', function () {
        var t = box.querySelector('#kbNotionToken').value.trim();
        if (!t) { alert('请先粘贴 Notion Token'); return; }
        window.ingrid.notionConfigure(t).then(function () {
          alert('✓ 已保存。记得在 Notion 里给要读的页面/数据库授权这个集成（··· → Connections）。');
          loadStatus();
        }).catch(function (e) { alert(String(e && e.message || e)); });
      });

      // 本地索引概览
      if (kb.totalFiles) {
        var note = modal.querySelector('.kb-hint');
        if (note) note.innerHTML = '本地索引：' + kb.totalFiles + ' 个文件 · ' + kb.totalChunks + ' 个分块' + (kb.embedReady ? ' · 已向量化' : ' · 关键词检索（向量模型未就绪）');
      }
    }).catch(function () {
      box.innerHTML = '<div class="kb-hint">读取状态失败。</div>';
    });
  }

  function open() { render(); mask.classList.add('open'); }
  function close() { mask.classList.remove('open'); }
  mask.addEventListener('click', function (e) { if (e.target === mask) close(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  window.__openKnowledge = open;
})();
