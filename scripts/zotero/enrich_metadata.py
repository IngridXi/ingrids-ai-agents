#!/usr/bin/env python3
"""通过 CrossRef 补全缺失的年份（date）与作者（creators）。

策略：
- 有 DOI：用 CrossRef DOI 精确匹配（高置信）
- 无 DOI：用 query.bibliographic（标题+作者）双重匹配（高置信才采用）
- 仅标题匹配、作者对不上的：不写入，只给建议

用法：
    python3 enrich_metadata.py --dry-run   # 只查询预览，不写入
    python3 enrich_metadata.py             # 查询并写入高置信结果
"""
import os
import re
import sys
import time
import json
import sqlite3
import urllib.request
import urllib.parse
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import zotero_api as za

ZOTERO_DATA = Path(os.environ.get("ZOTERO_DATA", str(Path.home() / "Zotero")))
DB_PATH = ZOTERO_DATA / "zotero.sqlite"
UA = {"User-Agent": "WorkBuddy/1.0 (mailto:user@example.com)"}


def crossref(url):
    r = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(r, timeout=25) as resp:
            return json.loads(resp.read().decode())
    except Exception:
        return None


def year_of(m):
    for k in ("published-print", "published-online", "published", "issued"):
        v = m.get(k)
        if v and v.get("date-parts") and v["date-parts"][0] and v["date-parts"][0][0]:
            return str(v["date-parts"][0][0])
    return None


def norm(s):
    return re.sub(r"[^a-z0-9 ]", " ", (s or "").lower()).split()


def look_doi(doi):
    d = crossref(f"https://api.crossref.org/works/{urllib.parse.quote(doi)}")
    if d and d.get("message"):
        m = d["message"]
        return {
            "year": year_of(m),
            "authors": [a.get("family", "") for a in m.get("author", [])][:6],
            "title": (m.get("title") or [""])[0],
            "confidence": "doi",
        }
    return None


def look_title(title, expect_authors):
    q = urllib.parse.quote((title or "")[:160])
    d = crossref(f"https://api.crossref.org/works?query.bibliographic={q}&rows=5")
    if not d:
        return None
    best = None
    best_score = -1
    for m in d.get("message", {}).get("items", []):
        mtitle = (m.get("title") or [""])[0]
        auths = [a.get("family", "") for a in m.get("author", [])][:6]
        ov = len(set(norm(mtitle)) & set(norm(title))) / max(1, len(set(norm(title))))
        score = ov
        auth_hit = False
        if expect_authors:
            em = set(norm(" ".join(expect_authors)))
            am = set(norm(" ".join(auths)))
            auth_hit = bool(em and am and (em & am))
            if auth_hit:
                score += 0.5
        cand = {"year": year_of(m), "authors": auths, "title": mtitle,
                "overlap": round(ov, 2), "auth_match": auth_hit,
                "confidence": "title+author" if auth_hit else "title-only"}
        if score > best_score:
            best_score, best = score, cand
    return best


def get_missing():
    con = sqlite3.connect(f"file:{za.snapshot_db()}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    cur.execute("""
        SELECT i.key, it.typeName,
          (SELECT idv.value FROM itemData id JOIN itemDataValues idv ON id.valueID=idv.valueID
            WHERE id.itemID=i.itemID AND id.fieldID=(SELECT fieldID FROM fields WHERE fieldName='title')) AS title,
          (SELECT idv.value FROM itemData id JOIN itemDataValues idv ON id.valueID=idv.valueID
            WHERE id.itemID=i.itemID AND id.fieldID=(SELECT fieldID FROM fields WHERE fieldName='DOI')) AS doi,
          (SELECT idv.value FROM itemData id JOIN itemDataValues idv ON id.valueID=idv.valueID
            WHERE id.itemID=i.itemID AND id.fieldID=(SELECT fieldID FROM fields WHERE fieldName='date')) AS date,
          (SELECT GROUP_CONCAT(cr.lastName,';') FROM itemCreators ic JOIN creators cr ON ic.creatorID=cr.creatorID WHERE ic.itemID=i.itemID) AS authors
        FROM items i JOIN itemTypes it ON i.itemTypeID=it.itemTypeID
        WHERE i.libraryID=1 AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
          AND it.typeName NOT IN ('attachment','note','annotation')
    """)
    rows = []
    for r in cur.fetchall():
        if not r["date"]:
            authors = [a for a in (r["authors"] or "").split(";") if a]
            rows.append({"key": r["key"], "type": r["typeName"], "title": r["title"],
                         "doi": r["doi"], "date": r["date"], "authors": authors})
    con.close()
    return rows


def enrich(dry_run=True, cfg=None):
    cfg = cfg or za.detect_config()
    rows = get_missing()
    print(f"缺年份文献 {len(rows)} 条，开始 CrossRef 查询...\n")
    results = []
    for r in rows:
        found = None
        if r["doi"]:
            found = look_doi(r["doi"])
        if (not found or not found.get("year")) and r["title"]:
            found = look_title(r["title"], r["authors"])
        if found is None:
            found = {}
        found.update(key=r["key"], title=r["title"], local_authors=r["authors"])
        results.append(found)
        conf = found.get("confidence", "none")
        print(f"[{r['key']}] {conf:12} year={str(found.get('year')):5}  {(r['title'] or '')[:45]}")
        time.sleep(0.3)

    high_conf = [r for r in results if r.get("confidence") in ("doi", "title+author") and r.get("year")]
    print(f"\n高置信可补全 {len(high_conf)} 条：")

    if dry_run:
        for r in high_conf:
            print(f"[预览] {r['key']} -> {r['year']}  ({r['title'][:40]})")
        print("\n(未写入，去掉 --dry-run 即可执行)")
        return results

    ok = fail = 0
    for r in high_conf:
        it = za.get_item(r["key"], cfg)
        if not it:
            fail += 1
            continue
        if it["data"].get("date"):
            continue
        st, _, _ = za.patch_item(r["key"], {"date": r["year"]}, version=it["version"], cfg=cfg)
        if st == 204:
            ok += 1
            print(f"[OK] {r['key']} -> {r['year']}")
        else:
            fail += 1
            print(f"[FAIL] {r['key']} -> {st}")
        time.sleep(0.1)
    print(f"\n完成：写入 {ok}，失败 {fail}")
    return results


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    enrich(dry_run=dry)
