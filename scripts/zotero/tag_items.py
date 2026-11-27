#!/usr/bin/env python3
"""为无标签文献按标题关键词自动打主题标签。

标签规则（标签 -> 词边界正则）内置；已去父子冗余、限制每篇最多 4 个标签。

用法：
    python3 tag_items.py --dry-run   # 只预览，不写入
    python3 tag_items.py             # 执行写入
"""
import os
import re
import sys
import time
import sqlite3
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import zotero_api as za

ZOTERO_DATA = Path(os.environ.get("ZOTERO_DATA", str(Path.home() / "Zotero")))
DB_PATH = ZOTERO_DATA / "zotero.sqlite"


def B(w):
    return r"\b" + re.escape(w) + r"\b"


# 标签 -> [正则]（词边界匹配，避免 "Thomas" 误匹配 "mas" 等）
RULES = [
    ("Agentic AI", [r"agentic"]),
    ("Generative AI", [r"generative ai", r"large language model", B("llm"), r"chatgpt", r"conversational ai", r"language model"]),
    ("Machine Learning", [r"machine learning", r"deep learning", r"neural network", r"natural language processing", r"text mining", B("nlp"), r"prediction interval", r"interpretable", r"predictive analytics"]),
    ("AI", [r"artificial intelligence", B("ai"), r"machine intelligence", r"hybrid intelligence", r"human.{0,25}machine"]),
    ("RPA", [r"robotic process automation", B("rpa"), r"workflow automation", r"process automation"]),
    ("BPM", [r"business process", B("bpm"), r"process management", r"workflow", r"process reengineering", r"reengineering", r"process improvement", r"process mining", r"process model", r"process monitoring", r"\bprocesses\b"]),
    ("Servitization", [r"servitiz", r"product.service", r"service productivity", r"service science", r"service development"]),
    ("Service", [r"\bservices?\b"]),
    ("Supply Chain", [r"supply chain", B("scm"), r"logistics", r"purchasing"]),
    ("Sustainability", [r"sustainab", r"circular economy", r"triple.bottom", r"life.cycle", r"lifecycle", r"environmental"]),
    ("NPD", [r"new product development", B("npd"), r"product development", r"product design", r"product management", r"product innovation", r"product returns"]),
    ("Order Fulfilment", [r"order fulfillment", r"order fulfilment", r"order penetration", r"order allocation", r"order management", r"order decoupling", r"assemble.to.order", r"change order", r"customer order", r"mass customization", r"decoupling", r"front office", r"back office", r"mid office", r"inventory replenishment"]),
    ("Dynamic Capabilities", [r"\bcapabilit", r"\broutines\b", r"resource.based"]),
    ("Decision-Making", [r"decision.making", r"decision making", r"decision support", r"automated decision"]),
    ("Trust in AI", [r"trustworthy", r"\btrust\b", r"provenance", r"\baccountable\b"]),
    ("Digital Transformation", [r"digital transformation", r"digital business", r"digitali[sz]ation", r"digitiz", r"digitising", r"digital technolog"]),
    ("Industry 4.0", [r"industry 4", r"industry 5", r"smart manufacturing", r"smart factory"]),
    ("Knowledge Graph", [r"knowledge graph", r"knowledge.based", r"knowledge based", r"knowledge engineering"]),
    ("Ontology", [r"ontolog", r"semantic representation"]),
    ("DSR", [r"design science", B("dsr"), r"design research", r"design based", r"design theory"]),
    ("Case Study", [r"case study", r"case method", r"case.based", r"case based", r"case research", r"theory building", r"cognitive task analysis", r"critical decision method", r"expert cognition"]),
    ("Systematic Review", [r"systematic review", r"systematic literature", r"literature review", r"a review", r"research priorities", r"research agenda", r"state.of.the.art", r"a survey", r"review and classification"]),
    ("Empirical", [r"empirical", r"\bevidence\b"]),
    ("Blockchain", [r"blockchain"]),
    ("Big Data", [r"big data"]),
    ("Smart Service", [r"smart service", r"smart product", r"smart future", r"smart nudging"]),
    ("Customer Experience", [r"customer experience", r"customer satisfaction", r"customer service", r"personaliz", r"customer complaint", r"customer focus"]),
    ("Value Co-Creation", [r"value co.creation", r"value creation", r"value proposition"]),
    ("Marketing", [r"marketing"]),
    ("RFID", [r"rfid"]),
    ("Autonomic", [r"autonomic", B("dao"), r"decentralized autonomous", r"autonomous organization"]),
    ("Multi-Agent", [r"multi.agent", r"agent.based", r"agent system", r"multiagent", r"agent.oriented", r"autonomous agent"]),
    ("Healthcare", [r"healthcare", r"health care", r"\bclinical\b", r"\bmedical\b", r"\bhospital\b", r"inpatient", r"\bpatient"]),
    ("Serious Games", [r"serious game", r"gamif", r"simulation game"]),
    ("Resilience", [r"resilienc", r"disruption"]),
    ("Procurement", [r"procurement"]),
    ("ERP", [B("erp"), r"enterprise resource"]),
    ("TQM", [r"tqm", r"total quality"]),
    ("Innovation", [r"innovation"]),
    ("Emerging Technology", [r"emerging technolog", B("drone"), r"drone adoption", r"technology adoption"]),
    ("Knowledge Management", [r"knowledge creation", r"knowing in practice", r"organizational knowledge", r"knowledge management", r"boundary object"]),
    ("Theory", [r"theory of the firm", r"organizational design", r"organisation design", r"organization design", r"coordinat", r"strategic int[eo]gration"]),
]


def compute_tags(title):
    t = (title or "").lower()
    tags = []
    for tag, pats in RULES:
        if any(re.search(p, t) for p in pats):
            tags.append(tag)
    # 子主题已覆盖时去掉泛化 AI
    if any(x in tags for x in ("Agentic AI", "Generative AI", "Machine Learning")) and "AI" in tags:
        tags.remove("AI")
    return tags[:4]


def get_untagged_literature():
    con = sqlite3.connect(f"file:{za.snapshot_db()}?mode=ro", uri=True)
    cur = con.cursor()
    cur.execute("""
        SELECT i.key,
          (SELECT idv.value FROM itemData id JOIN itemDataValues idv ON id.valueID=idv.valueID
            WHERE id.itemID=i.itemID AND id.fieldID=(SELECT fieldID FROM fields WHERE fieldName='title')) AS title
        FROM items i JOIN itemTypes it ON i.itemTypeID=it.itemTypeID
        WHERE i.libraryID=1 AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
          AND it.typeName NOT IN ('attachment','note','annotation')
          AND i.itemID NOT IN (
              SELECT itg.itemID FROM itemTags itg JOIN tags t ON itg.tagID=t.tagID
              WHERE t.name NOT LIKE '/%'
          )
    """)
    rows = [(k, t) for k, t in cur.fetchall()]
    con.close()
    return rows


def tag_items(dry_run=True, cfg=None):
    cfg = cfg or za.detect_config()
    rows = get_untagged_literature()
    plan = []
    for key, title in rows:
        tags = compute_tags(title)
        if tags:
            plan.append({"key": key, "title": title, "tags": tags})
    print(f"无标签文献 {len(rows)} 条，可自动打标签 {len(plan)} 条\n")

    if dry_run:
        for p in plan:
            print(f"[预览] {p['key']}  {(p['title'] or '')[:52]:52} => {','.join(p['tags'])}")
        print("\n(未写入，去掉 --dry-run 即可执行)")
        return plan

    ok = fail = 0
    for p in plan:
        it = za.get_item(p["key"], cfg)
        if not it:
            fail += 1
            continue
        existing = {t.get("tag") for t in (it["data"].get("tags") or [])
                    if not (t.get("tag") or "").startswith("/")}
        merged = sorted(existing | set(p["tags"]))
        taglist = [{"tag": t, "type": 0} for t in merged]
        st, _, _ = za.patch_item(p["key"], {"tags": taglist}, version=it["version"], cfg=cfg)
        if st == 204:
            ok += 1
        else:
            fail += 1
            print(f"[FAIL] {p['key']} -> {st}")
        time.sleep(0.1)
    print(f"\n完成：成功 {ok}，失败 {fail}")
    return plan


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv
    tag_items(dry_run=dry)
