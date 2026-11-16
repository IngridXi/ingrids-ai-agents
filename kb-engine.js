/**
 * 知识库引擎（Knowledge Base Engine）— local-first
 *
 * 职责：把本地 Markdown 笔记（Obsidian 库 / 任意笔记目录）增量摄取为
 * 可语义检索的知识库，为研究助手提供「本地文献/笔记支持」，而不是每次联网搜。
 *
 * 流程：
 *   数据源(.md) → MD5 增量比对 → 分块(标题+段落) → Ollama embedding → JSON 向量索引
 *   查询 → embedding(或关键词回退) → 余弦相似度 → top-k 带来源片段
 *
 * 说明：
 *   - 向量索引存 JSON（chunks 内嵌 embedding），面向个人级语料（数百~数千篇），
 *     免装原生向量库依赖，随 Electron 主进程直接用 Node 全局 fetch。
 *   - embedding 默认 bge-m3（多语言，中文效果好）；未就绪时自动回退关键词检索。
 *   - Zotero 源：spawn kb-zotero.py（读 sqlite 元数据 + pypdf 提 PDF 全文）→ 组合成 markdown 分块入库。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFile, execFileSync } = require('child_process');

function md5(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

function detectObsidianVaults(home) {
  const out = [];
  const h = home || os.homedir();
  const cfg = path.join(h, 'Library', 'Application Support', 'obsidian', 'obsidian.json');
  try {
    const j = JSON.parse(fs.readFileSync(cfg, 'utf8'));
    for (const k of Object.keys(j.vaults || {})) {
      const p = j.vaults[k] && j.vaults[k].path;
      if (p && fs.existsSync(p)) out.push(p);
    }
  } catch { /* 未安装或未配置 Obsidian */ }
  return out;
}

// 判断一个 vault 是否为「工位库」（AI 的凌乱库），主库之外的独立库按名字识别
function isWorkspaceVault(p) {
  const base = path.basename(String(p || '')).toLowerCase();
  return /工位库|ai.?工位|workspace|scratch|staging|messy/.test(base);
}

function detectZoteroDir(home) {
  const p = path.join(home || os.homedir(), 'Zotero');
  return fs.existsSync(p) ? p : null;
}

/* ---------------- 参考库提取：pptx / pdf / docx → markdown（内容 + 风格画像） ---------------- */
function decodeXml(s) {
  return String(s || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

// 提取 .pptx 的逐页文字 + 主题字体/配色。pptx 本质是 zip，用 macOS 自带 ditto 解压后正则解析 XML，
// 不依赖任何第三方库。产出 { pages: [{title, body}], fonts: {latin, ea}, colors: [] }
function extractPptx(filePath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-pptx-'));
  try {
    execFileSync('ditto', ['-x', '-k', filePath, tmp], { stdio: 'ignore' });
    const slidesDir = path.join(tmp, 'ppt', 'slides');
    let slideFiles = [];
    try {
      slideFiles = fs.readdirSync(slidesDir).filter((f) => /^slide\d+\.xml$/.test(f))
        .sort((a, b) => (parseInt(a.replace(/\D/g, ''), 10) || 0) - (parseInt(b.replace(/\D/g, ''), 10) || 0));
    } catch { /* 无 slides 目录 */ }

    const pages = [];
    for (const sf of slideFiles) {
      const xml = fs.readFileSync(path.join(slidesDir, sf), 'utf8');
      const texts = [];
      const re = /<a:t>([\s\S]*?)<\/a:t>/g;
      let m;
      while ((m = re.exec(xml))) {
        const t = decodeXml(m[1]).trim();
        if (t) texts.push(t);
      }
      if (texts.length) pages.push({ title: texts[0], body: texts.slice(1) });
    }

    let fonts = { latin: '', ea: '' };
    const colors = [];
    try {
      const themeXml = fs.readFileSync(path.join(tmp, 'ppt', 'theme', 'theme1.xml'), 'utf8');
      const latin = themeXml.match(/<a:latin[^>]*typeface="([^"]+)"/);
      const ea = themeXml.match(/<a:ea[^>]*typeface="([^"]+)"/);
      if (latin) fonts.latin = latin[1];
      if (ea) fonts.ea = ea[1];
      const cRe = /<a:srgbClr val="([0-9A-Fa-f]{6})"/g;
      let cm;
      while ((cm = cRe.exec(themeXml))) colors.push('#' + cm[1].toUpperCase());
    } catch { /* 无主题文件 */ }

    return { pages, fonts, colors };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

// 提取 .pdf 全文（用系统 python3 + pypdf，零额外依赖）
function extractPdfText(filePath) {
  const py = [
    'import sys, json',
    'try:',
    ' from pypdf import PdfReader',
    ' r = PdfReader(sys.argv[1])',
    " t = [p.extract_text() or '' for p in r.pages]",
    " print(json.dumps({'text': chr(10).join(t)}, ensure_ascii=False))",
    'except Exception as e:',
    " print(json.dumps({'error': str(e)}, ensure_ascii=False))",
  ].join('\n');
  try {
    const so = execFileSync('python3', ['-c', py, filePath], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
    const j = JSON.parse(so);
    return String(j.text || '').trim();
  } catch (e) { return ''; }
}

// 提取 .docx/.doc/.rtf/.odt 正文（macOS 自带 textutil）
function extractDocxText(filePath) {
  try {
    return String(execFileSync('textutil', ['-convert', 'txt', '-stdout', filePath], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 })).trim();
  } catch (e) { return ''; }
}

class KbEngine {
  constructor(opts) {
    opts = opts || {};
    this.root = opts.dataDir; // <dataDir>/kb
    this.ollamaUrl = String(opts.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    this.embedModel = opts.embedModel || 'bge-m3';
    this.chunkSize = opts.chunkSize || 1200;
    this.chunkOverlap = opts.chunkOverlap || 150;
    this.topK = opts.topK || 4;
    // Notion 源注入（由 main.js 提供）：{ getToken(), exportAll(token) }
    this.notion = opts.notion || null;
    // Notion 全量拉取较慢，两次拉取之间用缓存节流（手动重建索引可 force 绕过）
    this.notionTTL = opts.notionTTL || 30 * 60 * 1000;
    fs.mkdirSync(this.root, { recursive: true });
  }

  _indexPath() { return path.join(this.root, 'index.json'); }
  _configPath() { return path.join(this.root, 'config.json'); }

  /* ---------------- 配置 ---------------- */
  defaultConfig() {
    return {
      sources: [],
      embedModel: this.embedModel,
      chunkSize: this.chunkSize,
      chunkOverlap: this.chunkOverlap,
    };
  }
  loadConfig() {
    try {
      return Object.assign(this.defaultConfig(), JSON.parse(fs.readFileSync(this._configPath(), 'utf8')));
    } catch { return this.defaultConfig(); }
  }
  saveConfig(cfg) {
    fs.writeFileSync(this._configPath(), JSON.stringify(cfg, null, 2), 'utf8');
  }

  /** 首次运行：自动探测 Obsidian 库 + Zotero + Notion（都摄取） */
  autoDetectSources() {
    const srcs = [];
    for (const p of detectObsidianVaults()) {
      if (isWorkspaceVault(p)) continue; // 工位库（AI 草稿）不进用户知识库索引
      srcs.push({ id: 'src-' + md5('obsidian:' + p).slice(0, 8), type: 'markdown', label: 'Obsidian', path: p, enabled: true });
    }
    const z = detectZoteroDir();
    if (z) {
      srcs.push({ id: 'src-' + md5('zotero:' + z).slice(0, 8), type: 'zotero', label: 'Zotero', path: z, enabled: true });
    }
    if (this._notionToken()) {
      srcs.push({ id: 'src-notion', type: 'notion', label: 'Notion', path: 'notion://', enabled: true });
    }
    return srcs;
  }

  _notionToken() {
    if (!this.notion || typeof this.notion.getToken !== 'function') return '';
    try { return this.notion.getToken(); } catch { return ''; }
  }

  ensureConfig() {
    let cfg = this.loadConfig();
    if (!fs.existsSync(this._configPath()) || !cfg.sources.length) {
      cfg.sources = this.autoDetectSources();
      this.saveConfig(cfg);
      return cfg;
    }
    // 迁移：已有 config 但缺 Zotero 源时自动补上（老用户升级）
    if (!(cfg.sources || []).some((s) => s.type === 'zotero') && detectZoteroDir()) {
      const z = detectZoteroDir();
      cfg.sources.push({ id: 'src-' + md5('zotero:' + z).slice(0, 8), type: 'zotero', label: 'Zotero', path: z, enabled: true });
      this.saveConfig(cfg);
    }
    // 迁移：已有 config 但缺 Notion 源时自动补上（token 已配置才加）
    if (!(cfg.sources || []).some((s) => s.type === 'notion') && this._notionToken()) {
      cfg.sources.push({ id: 'src-notion', type: 'notion', label: 'Notion', path: 'notion://', enabled: true });
      this.saveConfig(cfg);
    }
    return cfg;
  }

  /* ---------------- 索引读写 ---------------- */
  _loadIndex() {
    try { return JSON.parse(fs.readFileSync(this._indexPath(), 'utf8')); }
    catch { return { chunks: [], files: {}, meta: {} }; }
  }
  _saveIndex(idx) {
    fs.writeFileSync(this._indexPath(), JSON.stringify(idx), 'utf8');
  }

  /* ---------------- 分块 ---------------- */
  _chunkMarkdown(text, meta) {
    const chunks = [];
    let headingStack = [];
    let body = [];
    const flush = () => {
      const txt = body.join('\n').trim();
      if (txt) {
        const title = headingStack.filter(Boolean).join(' › ') || meta.title || meta.name;
        this._splitLong(title, txt, meta, chunks);
      }
      body = [];
    };
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        flush();
        const level = m[1].length;
        const h = m[2].trim();
        if (level === 1) headingStack = [h];
        else {
          headingStack = headingStack.slice(0, level - 1);
          while (headingStack.length < level - 1) headingStack.push('');
          headingStack[level - 1] = h;
        }
      } else {
        body.push(line);
      }
    }
    flush();
    return chunks;
  }

  _splitLong(title, content, meta, chunks) {
    if (content.length <= this.chunkSize) { chunks.push({ title, content }); return; }
    const paras = content.split(/\n{2,}/);
    let buf = '';
    for (const p of paras) {
      const t = p.trim();
      if (!t) continue;
      if (buf && (buf.length + t.length + 2) > this.chunkSize) {
        chunks.push({ title, content: buf });
        const tail = buf.slice(-this.chunkOverlap);
        buf = tail ? tail + '\n\n' + t : t;
      } else {
        buf = buf ? buf + '\n\n' + t : t;
      }
    }
    if (buf) chunks.push({ title, content: buf });
  }

  _extractTags(content) {
    const tags = new Set();
    let m;
    const re = /(?:^|\s)#([\p{L}\p{N}_\-/]+)/gu;
    while ((m = re.exec(content))) tags.add(m[1].toLowerCase());
    const wl = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
    while ((m = wl.exec(content))) tags.add('link:' + m[1].trim().toLowerCase());
    return Array.from(tags).slice(0, 20);
  }

  /* ---------------- 源遍历 ---------------- */
  _walkSource(src) {
    const out = [];
    if (!src.path || !fs.existsSync(src.path)) return out;
    const skipDirs = new Set(['.git', '.obsidian', '.trash', 'node_modules', '.venv', '__pycache__', '.smart-connections', '.kb']);
    function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (!skipDirs.has(ent.name)) walk(full); }
        else if (ent.isFile() && /\.md$/i.test(ent.name)) {
          let content;
          try { content = fs.readFileSync(full, 'utf8'); } catch { continue; }
          if (!content.trim()) continue;
          const rel = path.relative(src.path, full).split(path.sep).join('/');
          out.push({
            rel, path: full, md5: md5(content), content,
            sourceId: src.id, sourceLabel: src.label || src.type, type: src.type,
          });
        }
      }
    }
    walk(src.path);
    return out;
  }

  /* ---------------- Zotero 源遍历（异步：spawn Python 提取） ---------------- */
  async _walkZotero(src) {
    if (!src.path || !fs.existsSync(src.path)) return [];
    const script = path.join(__dirname, 'kb-zotero.py');
    const stdout = await new Promise((resolve) => {
      execFile('python3', [script], { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, timeout: 300000 },
        (err, so) => resolve(err ? '' : so));
    });
    if (!stdout) return [];
    let items;
    try { items = JSON.parse(stdout); } catch { return []; }

    const out = [];
    for (const it of items) {
      if (!it.title && !it.abstract && !it.fulltext) continue;
      const lines = [];
      lines.push('# ' + (it.title || '（无标题）'));
      const meta = [];
      if (it.authors && it.authors.length) meta.push('作者: ' + it.authors.join(', '));
      if (it.year) meta.push('年份: ' + it.year);
      if (it.venue) meta.push('期刊/会议: ' + it.venue);
      if (it.doi) meta.push('DOI: ' + it.doi);
      if (it.url) meta.push('链接: ' + it.url);
      if (meta.length) lines.push(meta.join('\n'));
      if (it.abstract) lines.push('## 摘要\n' + it.abstract.trim());
      if (it.fulltext) lines.push('## 全文\n' + it.fulltext);
      const content = lines.join('\n\n');
      const key = it.key || md5(content).slice(0, 8);
      // 稳定标识：元数据不变就不重索引（全文细微变化不触发全量重嵌入）
      const stable = md5((it.title || '') + '|' + (it.doi || '') + '|' + key);
      out.push({
        rel: 'zotero:' + key, path: 'zotero:' + key, md5: stable, content,
        sourceId: src.id, sourceLabel: 'Zotero', type: 'zotero',
      });
    }
    return out;
  }

  /* ---------------- Notion 源遍历（异步：拉取页面正文 + 数据库条目，带缓存节流） ---------------- */
  async _walkNotion(src, force) {
    if (!this.notion || typeof this.notion.getToken !== 'function' || typeof this.notion.exportAll !== 'function') return [];
    let token;
    try { token = this.notion.getToken(); } catch { return []; }
    if (!token) return [];
    let docs = null;
    const cachePath = path.join(this.root, 'notion-cache.json');
    if (!force) {
      try {
        const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        if (c && c.fetchedAt && (Date.now() - c.fetchedAt) < this.notionTTL && Array.isArray(c.docs)) docs = c.docs;
      } catch { /* 无缓存或过期 */ }
    }
    if (!docs) {
      try { docs = await this.notion.exportAll(token); } catch { return []; }
      try { fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: Date.now(), docs: docs }, null, 2), 'utf8'); } catch { /* 写缓存失败不阻断 */ }
    }
    const out = [];
    for (const d of (docs || [])) {
      const title = d.title || d.id || '未命名';
      const content = '# ' + title + '\n\n' + String(d.text || '').trim();
      if (!String(d.text || '').trim()) continue;
      const rel = 'notion:' + d.id;
      out.push({
        rel, path: rel, md5: md5(content), content,
        sourceId: src.id, sourceLabel: 'Notion', type: 'notion',
      });
    }
    return out;
  }

  /* ---------------- 参考库源遍历（pptx/pdf/docx → markdown 内容 + 风格画像） ---------------- */
  // 性能关键：用「mtime+size」做稳定签名，文件未变则跳过昂贵的全文提取
  // （旧实现每次启动都对全部 PDF/PPTX/DOCX 用 execFileSync 同步提取全文，数百文件会阻塞主进程数分钟）
  _walkReference(src, oldFiles, opts) {
    opts = opts || {};
    oldFiles = oldFiles || {};
    const readonly = !!opts.readonly; // 只读模式：只列文件、保留旧索引、不提取、不判变更（内容等手动同步更新）
    if (!src.path || !fs.existsSync(src.path)) return [];
    const self = this;
    const out = [];
    const exts = /\.(pptx|pdf|docx|doc|rtf|odt)$/i;
    const skipDirs = new Set(['.git', '.DS_Store']);
    function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { if (!skipDirs.has(ent.name)) walk(full); }
        else if (ent.isFile() && exts.test(ent.name)) {
          const rel = path.relative(src.path, full).split(path.sep).join('/');
          let st;
          try { st = fs.statSync(full); } catch { continue; }
          // 稳定签名：mtime + size；与索引一致则视为未变，跳过全文提取
          const sig = md5(String(st.mtimeMs) + ':' + String(st.size));
          if (readonly) {
            // 只读：已索引文件保留旧 md5（不判变更、不提取）；新文件等手动同步再索引
            if (oldFiles[rel] !== undefined) {
              out.push({ rel, path: full, md5: oldFiles[rel], content: '', sourceId: src.id, sourceLabel: src.label || src.type, type: 'reference', _unchanged: true });
            }
            continue;
          }
          if (oldFiles[rel] === sig) {
            out.push({ rel, path: full, md5: sig, content: '', sourceId: src.id, sourceLabel: src.label || src.type, type: 'reference', _unchanged: true });
            continue;
          }
          const ext = path.extname(ent.name).toLowerCase();
          let content = '';
          if (ext === '.pptx') content = self._pptxToMarkdown(ent.name, extractPptx(full));
          else if (ext === '.pdf') { const t = extractPdfText(full); if (t) content = '# ' + ent.name + '\n\n' + t; }
          else { const t = extractDocxText(full); if (t) content = '# ' + ent.name + '\n\n' + t; }
          if (!content.trim()) continue;
          out.push({ rel, path: full, md5: sig, content, sourceId: src.id, sourceLabel: src.label || src.type, type: 'reference' });
        }
      }
    }
    walk(src.path);
    return out;
  }

  _pptxToMarkdown(name, r) {
    const lines = ['# ' + name.replace(/\.pptx$/i, '')];
    lines.push('');
    lines.push('【参考库 · 风格画像】');
    lines.push('- 格式: PowerPoint 演示文稿');
    lines.push('- 页数: ' + (r.pages.length || 1) + ' 页');
    if (r.fonts.latin) lines.push('- 西文字体: ' + r.fonts.latin);
    if (r.fonts.ea) lines.push('- 中文字体: ' + r.fonts.ea);
    if (r.colors.length) lines.push('- 主题色: ' + r.colors.slice(0, 8).join(' '));
    lines.push('');
    lines.push('【逐页内容】');
    r.pages.forEach(function (p, i) {
      lines.push('## 第 ' + (i + 1) + ' 页' + (p.title ? ' · ' + p.title : ''));
      if (p.body && p.body.length) p.body.forEach(function (b) { lines.push('- ' + b); });
      else if (!p.title) lines.push('（本页无文字）');
      lines.push('');
    });
    return lines.join('\n');
  }

  /* ---------------- Ollama embedding ---------------- */
  async embedModelReady() {
    try {
      const resp = await fetch(this.ollamaUrl + '/api/tags');
      if (!resp.ok) return false;
      const j = await resp.json();
      const names = (j.models || []).map((m) => m.name);
      const want = this.embedModel.split(':')[0];
      return names.includes(this.embedModel) || names.some((n) => n.split(':')[0] === want);
    } catch { return false; }
  }

  async _embed(texts) {
    const resp = await fetch(this.ollamaUrl + '/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.embedModel, input: texts }),
    });
    if (!resp.ok) throw new Error('embed HTTP ' + resp.status);
    const j = await resp.json();
    return j.embeddings || [];
  }

  /* ---------------- 扫描 + 增量摄取 ---------------- */
  async scan(opts) {
    opts = opts || {};
    const cfg = this.ensureConfig();
    this.embedModel = cfg.embedModel || this.embedModel;
    this.chunkSize = cfg.chunkSize || this.chunkSize;
    this.chunkOverlap = cfg.chunkOverlap || this.chunkOverlap;

    // reference 源（OneDrive 参考库：pptx/pdf/docx）较大较慢，默认不自动提取、手动同步（manual=true）才完整提取
    const manualOnly = !!opts.manual;
    // 自动扫描：所有源都遍历，reference 走「只读」分支（保留旧索引、不提取）；手动同步：只扫 reference 并完整提取
    const allSources = (cfg.sources || []).filter((s) => s.enabled && s.path);
    const activeSources = manualOnly ? allSources.filter((s) => s.type === 'reference') : allSources;
    const idx = this._loadIndex();
    const oldFiles = idx.files || {};

    const newFiles = {};
    const dirty = [];
    const seen = new Set();

    for (const src of activeSources) {
      const files = src.type === 'zotero' ? await this._walkZotero(src)
        : src.type === 'notion' ? await this._walkNotion(src, opts.force)
        : src.type === 'reference' ? this._walkReference(src, oldFiles, { readonly: !manualOnly })
        : this._walkSource(src);
      for (const f of files) {
        seen.add(f.rel);
        newFiles[f.rel] = f.md5;
        if (oldFiles[f.rel] !== f.md5) dirty.push(f);
      }
    }

    // 保留「本次未扫描」源的旧索引，避免误删（手动同步只扫 reference 时，Obsidian/Zotero/Notion 等需原样保留）
    const scannedIds = new Set(activeSources.map((s) => s.id));
    const relSource = {};
    for (const c of (idx.chunks || [])) { if (!relSource[c.relPath]) relSource[c.relPath] = c.sourceId; }
    for (const rel of Object.keys(oldFiles)) {
      if (!seen.has(rel)) {
        const sid = relSource[rel];
        if (sid && !scannedIds.has(sid)) { seen.add(rel); newFiles[rel] = oldFiles[rel]; }
      }
    }

    let deleted = 0;
    for (const rel of Object.keys(oldFiles)) if (!seen.has(rel)) deleted++;

    // 分块（只处理新增/变更文件）
    const newChunks = [];
    for (const f of dirty) {
      const meta = { title: path.basename(f.rel, path.extname(f.rel)), name: f.rel };
      const cs = this._chunkMarkdown(f.content, meta);
      for (let i = 0; i < cs.length; i++) {
        newChunks.push({
          id: f.md5 + ':' + i,
          sourceId: f.sourceId, sourceLabel: f.sourceLabel, type: f.type,
          relPath: f.rel, title: cs[i].title, content: cs[i].content,
          tags: this._extractTags(cs[i].content),
        });
      }
    }

    // 移除已变更/已删除文件的旧分块
    const changedRels = new Set(dirty.map((f) => f.rel));
    const kept = (idx.chunks || []).filter((c) => !changedRels.has(c.relPath) && seen.has(c.relPath));

    const chunks = kept.concat(newChunks);

    // 嵌入所有缺失向量的分块（首次嵌入新分块；模型刚就绪时补齐旧分块）
    const ready = await this.embedModelReady();
    if (ready) {
      const toEmbed = chunks.filter((c) => !c.embedding);
      const B = 32;
      for (let i = 0; i < toEmbed.length; i += B) {
        const batch = toEmbed.slice(i, i + B).map((c) => c.content);
        const embs = await this._embed(batch);
        for (let j = 0; j < embs.length; j++) if (toEmbed[i + j]) toEmbed[i + j].embedding = embs[j];
      }
    }
    const next = {
      chunks,
      files: newFiles,
      meta: {
        scannedAt: new Date().toISOString(),
        sources: allSources.map((s) => ({ type: s.type, label: s.label, path: s.path })),
        totalFiles: Object.keys(newFiles).length,
        totalChunks: chunks.length,
        embedded: chunks.filter((c) => c.embedding).length,
        embedModel: this.embedModel,
        embedReady: ready,
      },
    };
    this._saveIndex(next);
    return { files: next.meta.totalFiles, changed: dirty.length, deleted, chunks: chunks.length, embedded: next.meta.embedded, embedReady: ready };
  }

  /* ---------------- 检索 ---------------- */
  async search(query, k) {
    const idx = this._loadIndex();
    const chunks = idx.chunks || [];
    if (!chunks.length) return [];
    k = k || this.topK;

    const ready = await this.embedModelReady();
    let scored;

    if (ready && chunks.some((c) => c.embedding)) {
      let qv = null;
      try { const r = await this._embed([query]); qv = r && r[0]; } catch { /* 落到关键词 */ }
      scored = chunks.map((c) => ({ c, s: qv && c.embedding ? cosine(qv, c.embedding) : 0 }));
      const ql = query.toLowerCase();
      for (const it of scored) {
        const txt = (it.c.title + ' ' + it.c.content).toLowerCase();
        if (txt.includes(ql)) it.s += 0.25;
      }
    } else {
      const terms = query.split(/[\s,，。；;:：]+/).filter((t) => t.length >= 2);
      scored = chunks.map((c) => {
        const txt = (c.title + ' ' + c.content).toLowerCase();
        let s = 0;
        for (const t of terms) if (txt.includes(t.toLowerCase())) s += 1;
        return { c, s };
      });
    }

    scored.sort((a, b) => b.s - a.s);
    return scored.filter((it) => it.s > 0).slice(0, k).map((it) => ({
      id: it.c.id,
      title: it.c.title,
      relPath: it.c.relPath,
      source: it.c.sourceLabel,
      tags: it.c.tags || [],
      content: it.c.content.slice(0, 900),
      score: Math.round(it.s * 100) / 100,
    }));
  }

  /* ---------------- 状态 ---------------- */
  status() {
    const cfg = this.ensureConfig();
    const idx = this._loadIndex();
    const m = idx.meta || {};
    return {
      sources: cfg.sources || [],
      embedModel: cfg.embedModel || this.embedModel,
      chunkSize: cfg.chunkSize || this.chunkSize,
      totalFiles: m.totalFiles || 0,
      totalChunks: m.totalChunks || 0,
      embedded: m.embedded || 0,
      embedReady: !!m.embedReady,
      scannedAt: m.scannedAt || null,
      zoteroDetected: detectZoteroDir() ? true : false,
    };
  }
}

module.exports = { KbEngine, cosine, md5, detectObsidianVaults, detectZoteroDir, isWorkspaceVault, extractPptx, extractPdfText, extractDocxText };
