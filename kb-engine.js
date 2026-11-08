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
const { execFile } = require('child_process');

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

function detectZoteroDir(home) {
  const p = path.join(home || os.homedir(), 'Zotero');
  return fs.existsSync(p) ? p : null;
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

  /** 首次运行：自动探测 Obsidian 库 + Zotero（两者都摄取） */
  autoDetectSources() {
    const srcs = [];
    for (const p of detectObsidianVaults()) {
      srcs.push({ id: 'src-' + md5('obsidian:' + p).slice(0, 8), type: 'markdown', label: 'Obsidian', path: p, enabled: true });
    }
    const z = detectZoteroDir();
    if (z) {
      srcs.push({ id: 'src-' + md5('zotero:' + z).slice(0, 8), type: 'zotero', label: 'Zotero', path: z, enabled: true });
    }
    return srcs;
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
  async scan() {
    const cfg = this.ensureConfig();
    this.embedModel = cfg.embedModel || this.embedModel;
    this.chunkSize = cfg.chunkSize || this.chunkSize;
    this.chunkOverlap = cfg.chunkOverlap || this.chunkOverlap;

    const sources = (cfg.sources || []).filter((s) => s.enabled && s.path);
    const idx = this._loadIndex();
    const oldFiles = idx.files || {};

    const newFiles = {};
    const dirty = [];
    const seen = new Set();

    for (const src of sources) {
      const files = src.type === 'zotero' ? await this._walkZotero(src) : this._walkSource(src);
      for (const f of files) {
        seen.add(f.rel);
        newFiles[f.rel] = f.md5;
        if (oldFiles[f.rel] !== f.md5) dirty.push(f);
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
        sources: sources.map((s) => ({ type: s.type, label: s.label, path: s.path })),
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

module.exports = { KbEngine, cosine, md5, detectObsidianVaults, detectZoteroDir };
