/**
 * ============================================================
 *  notion-engine.js — Notion 接入引擎（Node 侧，主进程调用）
 * ============================================================
 *  职责：
 *    · 用 Notion 官方 API（Bearer token）搜索 / 读取页面
 *    · 把页面 blocks 拍平成 Markdown 文本（供知识库 / 研究助手消费）
 *
 *  设计：local-first，token 由主进程（main.js）用系统钥匙串加密后
 *        传入本模块，本模块不落盘、不打印 token。
 * ============================================================
 */
'use strict';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/** 统一请求封装：自动带 Authorization + Notion-Version 头 */
async function notionRequest(token, method, path, body) {
  const headers = {
    'Authorization': 'Bearer ' + token,
    'Notion-Version': NOTION_VERSION,
  };
  const opts = { method: method, headers: headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(NOTION_API + path, opts);
  if (!resp.ok) {
    let msg = 'Notion 请求失败 HTTP ' + resp.status;
    try { const j = await resp.json(); if (j && j.message) msg += '：' + j.message; } catch (e) {}
    throw new Error(msg);
  }
  if (resp.status === 204) return null;
  return resp.json();
}

function richText(rt) {
  if (!Array.isArray(rt)) return '';
  return rt.map(function (t) { return (t && t.plain_text) || ''; }).join('');
}

/** 提取页面 / 数据库标题（兼容 title 数组 与 properties.title） */
function titleOf(obj) {
  if (!obj) return '';
  if (Array.isArray(obj.title)) return richText(obj.title);
  if (obj.properties) {
    for (var k in obj.properties) {
      var p = obj.properties[k];
      if (p && p.type === 'title' && Array.isArray(p.title)) return richText(p.title);
    }
  }
  return '';
}

/** 单个 block → 一行 Markdown */
function blockToMarkdown(block) {
  var b = block || {};
  var t = b.type || '';
  var data = b[t] || {};
  var text = richText(data.rich_text || data.title || data.caption || []);
  switch (t) {
    case 'heading_1': return '# ' + text;
    case 'heading_2': return '## ' + text;
    case 'heading_3': return '### ' + text;
    case 'bulleted_list_item': return '- ' + text;
    case 'numbered_list_item': return '1. ' + text;
    case 'to_do': return '- [ ] ' + text;
    case 'quote': return '> ' + text;
    case 'code': return '```\n' + richText(data.rich_text || []) + '\n```';
    case 'divider': return '---';
    case 'toggle': return text;
    case 'child_page': return '📄 ' + (data.title || '');
    case 'child_database': return '🗂️ ' + (data.title || '');
    case 'paragraph': return text;
    default: return text || '';
  }
}

/** 读取页面所有 blocks → Markdown 文本（含一层嵌套列表） */
async function readPageBlocks(token, id) {
  var out = [];
  var cursor = null;
  do {
    var q = '?page_size=100' + (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : '');
    var j = await notionRequest(token, 'GET', '/blocks/' + id + '/children' + q);
    for (var i = 0; i < (j.results || []).length; i++) {
      var b = j.results[i];
      var line = blockToMarkdown(b);
      if (line) out.push(line);
      // 展开一层嵌套列表项
      if (b.has_children && (b.type === 'bulleted_list_item' || b.type === 'numbered_list_item' || b.type === 'toggle')) {
        try {
          var kids = await notionRequest(token, 'GET', '/blocks/' + b.id + '/children?page_size=100');
          for (var k = 0; k < (kids.results || []).length; k++) {
            var kl = blockToMarkdown(kids.results[k]);
            if (kl) out.push('    ' + kl);
          }
        } catch (e) { /* 子块读取失败不阻断 */ }
      }
    }
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return out.join('\n');
}

/** 查询一个数据库里的条目（row），返回 [{id, title}]。
 *  Notion /search 不索引数据库内的条目，必须用 /databases/{id}/query 单独查。 */
async function queryDatabaseRows(token, dbId, q) {
  var titleProp = null;
  try {
    var schema = await notionRequest(token, 'GET', '/databases/' + dbId);
    var props = (schema && schema.properties) || {};
    for (var k in props) {
      if (props[k] && props[k].type === 'title') { titleProp = k; break; }
    }
  } catch (e) { /* 拿不到 schema 不阻断，走全量 */ }
  var body = { page_size: 50 };
  if (q && titleProp) body.filter = { property: titleProp, title: { contains: q } };
  var j = await notionRequest(token, 'POST', '/databases/' + dbId + '/query', body);
  var rows = [];
  for (var i = 0; i < (j.results || []).length; i++) {
    var it = j.results[i];
    var title = '';
    if (titleProp && it.properties && it.properties[titleProp]) {
      title = richText(it.properties[titleProp].title);
    }
    if (!title) title = titleOf(it) || it.id;
    rows.push({ id: it.id, title: title });
  }
  return rows;
}

/** 搜索页面 / 数据库 / 数据库条目。
 *  Notion /search 只按标题匹配 page/database、不索引数据库内的 row；这里对命中的
 *  database 追加条目查询，并在无命中时用空 query 兜底枚举最近数据库的条目。 */
async function search(token, query) {
  const q = String(query || '').trim();
  var j = await notionRequest(token, 'POST', '/search', { query: q, page_size: 30 });
  var results = [];
  var dbHits = 0;
  for (var i = 0; i < (j.results || []).length; i++) {
    var it = j.results[i];
    var entry = {
      id: it.id,
      object: it.object,       // 'page' | 'database'
      title: titleOf(it) || it.id,
      url: it.url || '',
      lastEdited: it.last_edited_time || '',
    };
    if (it.object === 'database') {
      dbHits++;
      // 数据库标题命中 query：返回该库条目；若按 query 过滤为空则回退到全量前 50 条
      var rows = await queryDatabaseRows(token, it.id, q);
      if (!rows.length && q) rows = await queryDatabaseRows(token, it.id, '');
      entry.rows = rows;
    }
    results.push(entry);
  }
  // 兜底：query 没直接命中任何 database，但用户的内容可能藏在某个数据库的条目里
  // （例如「研究进度」是某进度库的一行，库名不含关键词）→ 空 query 枚举最近数据库逐个过滤
  if (q && dbHits === 0) {
    try {
      var all = await notionRequest(token, 'POST', '/search', { query: '', page_size: 30 });
      var dbs = (all.results || []).filter(function (x) { return x.object === 'database'; }).slice(0, 5);
      for (var d = 0; d < dbs.length; d++) {
        var rows = await queryDatabaseRows(token, dbs[d].id, q);
        if (rows.length) {
          results.push({
            id: dbs[d].id, object: 'database',
            title: titleOf(dbs[d]) || dbs[d].id,
            url: dbs[d].url || '', lastEdited: dbs[d].last_edited_time || '',
            rows: rows,
          });
        }
      }
    } catch (e) { /* 兜底枚举失败不影响已返回结果 */ }
  }
  return results;
}

/** 读取单个页面 → { id, title, text } */
async function readPage(token, id) {
  var title = '';
  try {
    var p = await notionRequest(token, 'GET', '/pages/' + id);
    title = titleOf(p);
  } catch (e) { /* 元信息失败不阻断，仍尝试读块 */ }
  var text = await readPageBlocks(token, id);
  return { id: id, title: title, text: text };
}

module.exports = {
  search: search,
  readPage: readPage,
  titleOf: titleOf,
};
