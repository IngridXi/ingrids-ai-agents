#!/usr/bin/env python3
"""Zotero 文献库去重。

保留信息最全的一条，合并其分类归属与标签，删除其余重复项（软删除前请先备份）。

用法：
    python3 deduplicate.py --dry-run   # 只预览，不执行
    python3 deduplicate.py             # 执行去重
"""
import os
import re
import sys
import json
import sqlite3
import time
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import zotero_api as za

ZOTERO_DATA = Path(os.environ.get("ZOTERO_DATA", str(Path.home() / "Zotero")))
DB_PATH = ZOTERO_DATA / "zotero.sqlite"


def norm_title(s):
    s = re.sub(r"[^a-z0-9 ]", " ", (s or "").lower())
    return re.sub(r"\s+", " ", s).strip()


def find_duplicate_groups():
    con = sqlite3.connect(f"file:{za.snapshot_db()}?mode=ro", uri=True)
    cur = con.cursor()
    cur.execute("""
        SELECT i.key, it.typeName,
          (SELECT idv.value FROM itemData id JOIN itemDataValues idv ON id.valueID=idv.valueID
            WHERE id.itemID=i.itemID AND id.fieldID=(SELECT fieldID FROM fields WHERE fieldName='title')) AS title
        FROM items i JOIN itemTypes it ON i.itemTypeID=it.itemTypeID
        WHERE i.libraryID=1 AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
          AND it.typeName NOT IN ('attachment','note','annotation')
    """)
    groups = defaultdict(list)
    for key, typ, title in cur.fetchall():
        t = norm_title(title)
        if t:
            groups[t].append(key)
    con.close()
    return [keys for keys in groups.values() if len(keys) > 1]


def score(item):
    data = item["data"]
    s = 0
    if data.get("date"):
        s += 100
    if data.get("collections"):
        s += 80
    s += len(data.get("tags") or []) * 10
    if data.get("DOI"):
        s += 20
    return s


def deduplicate(dry_run=True, cfg=None):
    cfg = cfg or za.detect_config()
    groups = find_duplicate_groups()
    print(f"发现 {len(groups)} 组重复，共 {sum(len(g) for g in groups)} 条")
    plan = []
    for keys in groups:
        items = []
        for k in keys:
            it = za.get_item(k, cfg)
            if it:
                items.append(it)
        if len(items) < 2:
            continue
        keep = max(items, key=lambda x: (score(x), 0))
        # 优先保留最早导入的（dateAdded 小）作为 tiebreak —— 简化处理
        removes = [x for x in items if x["key"] != keep["key"]]
        plan.append({"keep": keep, "removes": removes})

    print(f"可去重 {len(plan)} 组，删除 {sum(len(p['removes']) for p in plan)} 条\n")

    if dry_run:
        for p in plan:
            keep, removes = p["keep"], p["removes"]
            print(f"[预览] 保留 {keep['key']} ({keep['data'].get('title','')[:40]})")
            for r in removes:
                print(f"        删 {r['key']} ({r['data'].get('title','')[:40]})")
        print("\n(未执行，去掉 --dry-run 即可真正执行)")
        return plan

    ok = fail = 0
    for p in plan:
        keep, removes = p["keep"], p["removes"]
        # 合并 collections + tags
        keep_cols = set(keep["data"].get("collections") or [])
        keep_tags = {t["tag"]: t.get("type", 0) for t in (keep["data"].get("tags") or [])}
        for r in removes:
            keep_cols |= set(r["data"].get("collections") or [])
            for t in (r["data"].get("tags") or []):
                keep_tags.setdefault(t["tag"], t.get("type", 0))
        body = {
            "collections": sorted(keep_cols),
            "tags": [{"tag": n, "type": tp} for n, tp in sorted(keep_tags.items())],
        }
        st, _, raw = za.patch_item(keep["key"], body, version=keep["version"], cfg=cfg)
        patch_ok = st == 204
        # 删除重复项
        del_ok = True
        for r in removes:
            st2, _, _ = za.delete_item(r["key"], version=r["version"], cfg=cfg)
            if st2 != 204:
                del_ok = False
        if patch_ok and del_ok:
            ok += 1
            print(f"[OK] {keep['key']} 保留，删 {len(removes)} 条")
        else:
            fail += 1
            print(f"[FAIL] {keep['key']} patch={patch_ok} del={del_ok}")
        time.sleep(0.15)
    print(f"\n完成：成功 {ok} 组，失败 {fail} 组")
    return plan


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    deduplicate(dry_run=dry)
