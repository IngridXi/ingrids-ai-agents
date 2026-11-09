#!/usr/bin/env python3
"""Zotero 知识库提取器（local-first）

读取 ~/Zotero/zotero.sqlite 的文献元数据 + storage/ 里的 PDF 全文，
输出 JSON 数组到 stdout，供 kb-engine.js 分块 + 向量化入库。

设计要点：
- 不写 Zotero 原库：先复制 sqlite(+wal+shm) 到临时目录再读，避免锁库、且能拿到 WAL 里最新数据
- PDF 全文用 pypdf（纯 Python），无需额外系统依赖
- 只提取「顶层文献」（排除 attachment/note/annotation），字段动态查 fields 表
"""
import os
import sys
import json
import shutil
import tempfile
import sqlite3

ZOTERO = os.path.expanduser('~/Zotero')
FULLTEXT_LIMIT = 20000          # 单篇全文截断上限（字符），控制向量化体积
WANT_FIELDS = ('title', 'abstractNote', 'DOI', 'date', 'publicationTitle',
               'volume', 'issue', 'pages', 'url', 'extra', 'series', 'publisher', 'language')


def _connect_ro(dbpath):
    """复制 sqlite(+wal/shm) 到临时目录后打开，避免锁库且能读最新 WAL 数据"""
    tmpdir = tempfile.mkdtemp(prefix='zotero-kb-')
    dst = os.path.join(tmpdir, 'zotero.sqlite')
    shutil.copy(dbpath, dst)
    for ext in ('-wal', '-shm'):
        src = dbpath + ext
        if os.path.exists(src):
            shutil.copy(src, dst + ext)
    conn = sqlite3.connect(dst)
    conn.row_factory = sqlite3.Row
    return conn


def _extract_pdf(path):
    """用 pypdf 提取 PDF 文本；失败返回空串"""
    try:
        from pypdf import PdfReader
    except ImportError:
        try:
            from PyPDF2 import PdfReader
        except ImportError:
            return ''
    try:
        reader = PdfReader(path)
        parts = []
        for p in reader.pages:
            t = p.extract_text()
            if t:
                parts.append(t)
        return '\n'.join(parts)
    except Exception:
        return ''


def _walk_pdfs(conn, item_id):
    """返回某文献所有 PDF 附件的本地绝对路径"""
    out = []
    try:
        rows = conn.execute(
            "SELECT ia.path, k.key FROM itemAttachments ia "
            "JOIN items k ON ia.itemID = k.itemID "
            "WHERE ia.parentItemID = ? AND ia.contentType = 'application/pdf'",
            (item_id,),
        ).fetchall()
        for r in rows:
            p = r['path'] or ''
            if p.startswith('storage:'):
                p = p[len('storage:'):]
                full = os.path.join(ZOTERO, 'storage', r['key'], p)
                if os.path.exists(full):
                    out.append(full)
    except Exception:
        pass
    return out


def main():
    meta_only = '--meta-only' in sys.argv
    dbpath = os.path.join(ZOTERO, 'zotero.sqlite')
    if not os.path.exists(dbpath):
        json.dump([], sys.stdout)
        return

    conn = _connect_ro(dbpath)
    try:
        # 字段定义（fieldName -> fieldID）
        fields = {}
        for row in conn.execute("SELECT fieldID, fieldName FROM fields"):
            fields[row['fieldName']] = row['fieldID']

        # 顶层文献条目
        rows = conn.execute(
            "SELECT i.itemID, i.key, it.typeName, i.dateAdded FROM items i "
            "JOIN itemTypes it ON i.itemTypeID = it.itemTypeID "
            "WHERE i.itemID NOT IN (SELECT itemID FROM deletedItems) "
            "AND it.typeName NOT IN ('attachment','note','annotation')"
        ).fetchall()

        result = []
        for item in rows:
            meta = {}
            for fn in WANT_FIELDS:
                fid = fields.get(fn)
                if not fid:
                    continue
                r = conn.execute(
                    "SELECT v.value FROM itemData d "
                    "JOIN itemDataValues v ON d.valueID = v.valueID "
                    "WHERE d.itemID = ? AND d.fieldID = ?",
                    (item['itemID'], fid),
                ).fetchone()
                if r and r['value']:
                    meta[fn] = r['value'].strip()

            # 作者（按顺序）
            authors = []
            try:
                for r in conn.execute(
                    "SELECT c.firstName, c.lastName FROM itemCreators ic "
                    "JOIN creators c ON ic.creatorID = c.creatorID "
                    "WHERE ic.itemID = ? ORDER BY ic.orderIndex",
                    (item['itemID'],),
                ):
                    name = ' '.join(x for x in (r['firstName'], r['lastName']) if x)
                    if name:
                        authors.append(name)
            except Exception:
                pass

            # 标签（排除自动标签 type=1）
            tags = []
            try:
                for r in conn.execute(
                    "SELECT t.name FROM tags t "
                    "JOIN itemTags it ON t.tagID = it.tagID "
                    "WHERE it.itemID = ? AND it.type = 0 ORDER BY t.name",
                    (item['itemID'],),
                ):
                    tags.append(r['name'])
            except Exception:
                pass

            # PDF 全文（--meta-only 时跳过，加快 kb-digest 取元数据）
            fulltext = ''
            if not meta_only:
                for pdf in _walk_pdfs(conn, item['itemID']):
                    fulltext += _extract_pdf(pdf) + '\n\n'
                fulltext = fulltext.strip()[:FULLTEXT_LIMIT]

            date = meta.get('date', '')
            year = (date[:4] if date and date[:4].isdigit() else '')

            result.append({
                'key': item['key'],
                'type': item['typeName'],
                'dateAdded': item['dateAdded'] or '',
                'title': meta.get('title', ''),
                'authors': authors,
                'year': year,
                'venue': meta.get('publicationTitle', ''),
                'doi': meta.get('DOI', ''),
                'abstract': meta.get('abstractNote', ''),
                'url': meta.get('url', ''),
                'volume': meta.get('volume', ''),
                'issue': meta.get('issue', ''),
                'pages': meta.get('pages', ''),
                'tags': tags,
                'fulltext': fulltext,
            })
        json.dump(result, sys.stdout, ensure_ascii=False)
    finally:
        conn.close()


if __name__ == '__main__':
    main()
