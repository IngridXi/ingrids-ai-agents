#!/usr/bin/env python3
"""Zotero 文献库只读诊断扫描。

输出：条目总数、文献数、元数据缺失统计、收藏夹结构、重复组、异常条目。

用法：
    python3 scan_library.py
    python3 scan_library.py --json   # 输出 JSON
"""
import os
import re
import sys
import json
import sqlite3
from collections import defaultdict
from pathlib import Path

ZOTERO_DATA = Path(os.environ.get("ZOTERO_DATA", str(Path.home() / "Zotero")))
DB_PATH = ZOTERO_DATA / "zotero.sqlite"

LIT_EXCLUDED = ("attachment", "note", "annotation")


def norm_title(s):
    s = re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())
    return re.sub(r"\s+", " ", s).strip()


def _snapshot():
    import shutil, tempfile
    snap = Path(tempfile.mkdtemp(prefix="zotero_snap_"))
    for suffix in ("", "-wal", "-shm"):
        src = Path(str(DB_PATH) + suffix)
        if src.exists():
            shutil.copy2(src, snap / (DB_PATH.name + suffix))
    return snap / DB_PATH.name


def scan():
    con = sqlite3.connect(f"file:{_snapshot()}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    # 文献条目（非附属）
    cur.execute(f"""
        SELECT i.itemID, i.key, i.dateAdded, it.typeName,
          (SELECT idv.value FROM itemData id JOIN itemDataValues idv ON id.valueID=idv.valueID
            WHERE id.itemID=i.itemID AND id.fieldID=(SELECT fieldID FROM fields WHERE fieldName='title')) AS title,
          (SELECT idv.value FROM itemData id JOIN itemDataValues idv ON id.valueID=idv.valueID
            WHERE id.itemID=i.itemID AND id.fieldID=(SELECT fieldID FROM fields WHERE fieldName='DOI')) AS doi,
          (SELECT idv.value FROM itemData id JOIN itemDataValues idv ON id.valueID=idv.valueID
            WHERE id.itemID=i.itemID AND id.fieldID=(SELECT fieldID FROM fields WHERE fieldName='date')) AS date
        FROM items i JOIN itemTypes it ON i.itemTypeID=it.itemTypeID
        WHERE i.libraryID=1 AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
          AND it.typeName NOT IN ('attachment','note','annotation')
        ORDER BY i.itemID
    """)
    items = []
    for r in cur.fetchall():
        d = dict(r)
        d["n_attach"] = cur.execute(
            "SELECT COUNT(*) FROM itemAttachments WHERE parentItemID=?", (d["itemID"],)
        ).fetchone()[0]
        d["n_tags"] = cur.execute(
            "SELECT COUNT(*) FROM itemTags WHERE itemID=?", (d["itemID"],)
        ).fetchone()[0]
        d["authors"] = [x[0] for x in cur.execute(
            "SELECT cr.lastName FROM itemCreators ic JOIN creators cr ON ic.creatorID=cr.creatorID WHERE ic.itemID=?",
            (d["itemID"],),
        ).fetchall()]
        d["cols"] = [x[0] for x in cur.execute(
            "SELECT c.collectionName FROM collectionItems ci JOIN collections c ON ci.collectionID=c.collectionID WHERE ci.itemID=?",
            (d["itemID"],),
        ).fetchall()]
        items.append(d)

    # 收藏夹
    cur.execute("""
        SELECT collectionID, key, collectionName, parentCollectionID,
          (SELECT COUNT(*) FROM collectionItems ci WHERE ci.collectionID=c.collectionID) AS n
        FROM collections c ORDER BY parentCollectionID, collectionID
    """)
    collections = [dict(r) for r in cur.fetchall()]

    # 重复组
    groups = defaultdict(list)
    for d in items:
        t = norm_title(d["title"])
        if t:
            groups[t].append(d)
    dup_groups = [v for v in groups.values() if len(v) > 1]

    # 异常条目
    anomalous = []
    for d in items:
        t = (d["title"] or "").strip()
        if (not t) or ("No title found" in t) or ("阅读历史" in t) or \
           ("Addon" in t) or (d["typeName"] == "dataset" and t and " " in t):
            anomalous.append(d)
        # dataset 且 DOI 形如 UUID 前缀的伪造 DOI
        doi = d["doi"] or ""
        if d["typeName"] == "dataset" and doi.startswith("10.") and len(doi) > 30:
            anomalous.append(d)

    # 去重 anomalous
    seen = set()
    anom_uniq = []
    for d in anomalous:
        if d["key"] not in seen:
            seen.add(d["key"])
            anom_uniq.append(d)

    con.close()

    report = {
        "total_literature": len(items),
        "no_tags": sum(1 for d in items if d["n_tags"] == 0),
        "no_date": sum(1 for d in items if not d["date"]),
        "no_authors": sum(1 for d in items if not d["authors"]),
        "no_collection": sum(1 for d in items if not d["cols"]),
        "has_doi": sum(1 for d in items if d["doi"]),
        "collections": collections,
        "duplicate_groups": [
            {
                "title": g[0]["title"],
                "count": len(g),
                "items": [
                    {"key": d["key"], "type": d["typeName"], "date": d["date"],
                     "cols": d["cols"], "doi": d["doi"], "authors": d["authors"]}
                    for d in sorted(g, key=lambda x: x["dateAdded"])
                ],
            }
            for g in sorted(dup_groups, key=lambda g: -len(g))
        ],
        "anomalous": [
            {"key": d["key"], "type": d["typeName"], "title": d["title"],
             "doi": d["doi"], "cols": d["cols"]}
            for d in anom_uniq
        ],
    }
    return report


def print_report(r):
    print(f"文献总数: {r['total_literature']}")
    print(f"  无标签: {r['no_tags']}  无日期: {r['no_date']}  无作者: {r['no_authors']}  "
          f"无分类: {r['no_collection']}  有DOI: {r['has_doi']}")
    print(f"\n收藏夹 ({len(r['collections'])} 个):")
    for c in r["collections"]:
        indent = "  " if c["parentCollectionID"] else ""
        print(f"  {indent}{c['collectionName']:34} items={c['n']}")
    print(f"\n重复组: {len(r['duplicate_groups'])} 组")
    for g in r["duplicate_groups"]:
        print(f"  x{g['count']}  {g['title'][:60]}")
    print(f"\n异常条目: {len(r['anomalous'])} 条")
    for a in r["anomalous"]:
        print(f"  [{a['key']}] {a['type']:14} {(a['title'] or '(空标题)')[:40]}  doi={a['doi'][:26] or '-'}")


if __name__ == "__main__":
    r = scan()
    if "--json" in sys.argv:
        print(json.dumps(r, ensure_ascii=False, indent=2))
    else:
        print_report(r)
