#!/usr/bin/env python3
"""Zotero 文献自动入库与治理（无人值守全流程）。

单脚本完成：扫描下载目录新 PDF → 导入 Zotero（自动识别元数据）→ 等识别
→ CrossRef 补元数据 → 按主题自动分组 → 打标签 → 生成汇总报告。

用法：
    python3 auto_ingest.py --dry-run           # 只预览，不写入
    python3 auto_ingest.py                     # 执行导入 + 处理 + 出当日摘要
    python3 auto_ingest.py --import-existing   # 强制导入下载目录现有全部 PDF（含基线）
    python3 auto_ingest.py --ingest <file.pdf> # 手动导入单个 PDF
    python3 auto_ingest.py --report weekly     # 汇总本周处理情况生成周报

设计要点：
- 幂等：state.json 记录已处理 PDF（路径+大小+mtime），重复运行不重复导入。
- 容错：Zotero 未运行 / 识别失败 / CrossRef 查不到，均不崩溃、不瞎写。
- 安全：写操作带版本保护；元数据只写高置信结果。
"""
import os
import re
import sys
import time
import json
import shutil
import sqlite3
import urllib.request
import urllib.error
import urllib.parse
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import zotero_api as za
from tag_items import compute_tags
from enrich_metadata import look_doi, look_title, year_of

HOME = Path.home()
DOWNLOADS = Path(os.environ.get("ZOTERO_DOWNLOADS", str(HOME / "Downloads")))
AUTO_DIR = Path(os.environ.get("ZOTERO_AUTO_DIR", str(HOME / "Library" / "Application Support" / "Ingrid's AI Agents" / "data" / "zotero-automation")))
STATE_FILE = AUTO_DIR / "state.json"
REPORT_DIR = AUTO_DIR / "reports"
LOCAL_API = "http://localhost:23119"
UA = {"User-Agent": "WorkBuddy/1.0 (mailto:user@example.com)"}

# 递归扫描时跳过的目录：.app 应用包、隐藏目录（. 开头）、迁移备份目录
SKIP_DIR_PREFIXES = ("phd-ra-agent-migration",)


def _skip_dir(d):
    return d.endswith(".app") or d.startswith(".") or d.startswith(SKIP_DIR_PREFIXES)


def scan_pdfs():
    """递归扫描下载目录（含子文件夹），排除应用包/隐藏目录/迁移备份目录。"""
    if not DOWNLOADS.exists():
        return []
    results = []
    for p in DOWNLOADS.rglob("*.pdf"):
        dirs = p.relative_to(DOWNLOADS).parts[:-1]
        if any(_skip_dir(d) for d in dirs):
            continue
        results.append(p)
    return sorted(results)


def trash_file(p):
    """把已成功导入的源文件移到 macOS 废纸篓（可恢复，非硬删）。返回是否成功。"""
    p = Path(p)
    try:
        trash = HOME / ".Trash"
        if not trash.exists() or not p.exists():
            return False
        dst = trash / p.name
        if dst.exists():
            dst = trash / f"{p.stem}_{int(time.time())}{p.suffix}"
        shutil.move(str(p), str(dst))
        return True
    except Exception as e:
        print(f"  [清理失败] {p.name}: {e}")
        return False


# ---------------------------------------------------------------------------
# 分类：标签 -> 收藏夹名
#   PRIORITY_TAGS：专属主题标签，最具体、最能定性，命中即定（优先于 AI+运营组合）
#   OTHER_TAGS：方法/通用标签，在 AI+运营组合之后兜底
# ---------------------------------------------------------------------------
PRIORITY_TAGS = {
    "Agentic AI":            "9. Agentic AI",
    "Multi-Agent":           "9. Agentic AI",
    "Autonomic":             "9. Agentic AI",
    "Serious Games":         "12. Serious Games",
    "Healthcare":            "13. AI in Healthcare",
    "Marketing":             "11. AI in Marketing",
    "Servitization":         "7. Servitization & Service",
    "Smart Service":         "7. Servitization & Service",
    "Value Co-Creation":     "7. Servitization & Service",
    "Customer Experience":   "7. Servitization & Service",
    "NPD":                   "8. Sustainable Ops & NPD",
    "Sustainability":        "8. Sustainable Ops & NPD",
    "Industry 4.0":          "8. Sustainable Ops & NPD",
    "Emerging Technology":   "8. Sustainable Ops & NPD",
    "Digital Transformation":"14. Digital Transformation",
    "Order Fulfilment":      "4. Order Fulfilment Core",
    "Supply Chain":          "4. Order Fulfilment Core",
    "Procurement":           "4. Order Fulfilment Core",
    "RFID":                  "4. Order Fulfilment Core",
    "ERP":                   "4. Order Fulfilment Core",
    "Resilience":            "4. Order Fulfilment Core",
    "BPM":                   "6. Business Process Management",
    "RPA":                   "6. Business Process Management",
    "Service":               "7. Servitization & Service",
}
OTHER_TAGS = {
    "Ontology":              "2. DSR & Ontology",
    "DSR":                   "2. DSR & Ontology",
    "Knowledge Graph":       "3. Case Method & KG",
    "Case Study":            "3. Case Method & KG",
    "Knowledge Management":  "1. Theory Foundations",
    "Generative AI":         "10. AI & ML Foundations",
    "Machine Learning":      "10. AI & ML Foundations",
    "AI":                    "10. AI & ML Foundations",
    "Big Data":              "10. AI & ML Foundations",
    "Blockchain":            "10. AI & ML Foundations",
    "Trust in AI":           "10. AI & ML Foundations",
    "Decision-Making":       "10. AI & ML Foundations",
    "Dynamic Capabilities":  "1. Theory Foundations",
    "Theory":                "1. Theory Foundations",
}
FALLBACK_COLLECTION = "99. To Review"

# AI + 运营相关词 -> 归入 5. AI in Operations
AI_OPS_WORDS = (
    "operation", "supply chain", "order", "process", "manufactur",
    "planning", "inventory", "fulfil", "fulfill", "logistics", "production",
)
AI_TAGS = ("AI", "Generative AI", "Machine Learning")


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
def http_get(url, timeout=15):
    req = urllib.request.Request(url, headers=UA)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except urllib.error.URLError as e:
        return 0, str(e).encode()


def api_available():
    st, _ = http_get(LOCAL_API + "/api/", timeout=5)
    return st in (200, 301, 302, 404)


def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")


def file_sig(path):
    st = os.stat(path)
    return {"size": st.st_size, "mtime": int(st.st_mtime)}


def clean_filename(name):
    """从文件名提取可用作检索的标题线索。"""
    n = name
    if n.lower().endswith(".pdf"):
        n = n[:-4]
    n = urllib.parse.unquote(n)
    # 去掉 ScienceDirect 的 PII 前缀 "1-s2.0-S0925527303001191-main"
    n = re.sub(r"^\d+-s2\.0-S\d+-main", "", n)
    # 去掉 EBSCO 之类前缀
    n = re.sub(r"^EBSCO-FullText[-_]", "", n)
    # 常见 "作者 - 年份 - 标题" 格式：保留整串让 CrossRef 自己判断，仅清理分隔噪音
    n = re.sub(r"[_\-.]+", " ", n)
    n = re.sub(r"\s+", " ", n).strip()
    return n


# ---------------------------------------------------------------------------
# 导入 PDF（用 Zotero connector 端点，无需鉴权，自动识别元数据）
# ---------------------------------------------------------------------------
def ingest_pdf(filepath):
    """上传 PDF，返回 (attachment_key, recognized_parent_key_or_None)。

    用 POST /connector/saveStandaloneAttachment：Zotero 收到 PDF 后会在后台
    识别元数据；识别成功会生成父条目（parentItem），失败则只有独立 attachment。
    """
    filename = os.path.basename(filepath)
    pdf_bytes = open(filepath, "rb").read()
    before = _latest_dateadded()
    session = "wb-%d" % int(time.time() * 1000)
    meta = json.dumps({
        "sessionID": session,
        "url": "file://" + os.path.abspath(filepath),
        "title": filename,
    }, ensure_ascii=True)
    req = urllib.request.Request(
        LOCAL_API + "/connector/saveStandaloneAttachment",
        data=pdf_bytes,
        method="POST",
        headers={
            "Content-Type": "application/pdf",
            "Content-Length": str(len(pdf_bytes)),
            "X-Metadata": meta,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            st = resp.status
    except urllib.error.HTTPError as e:
        return None, "HTTP %d" % e.code
    except urllib.error.URLError as e:
        return None, str(e)
    if st not in (200, 201):
        return None, "HTTP %d" % st

    # 等识别，并定位新建条目（识别成功后 attachment 的 title 会被 Zotero 改写，
    # 因此不能只靠 title==文件名匹配，还要兜底找新建的 PDF 附件）
    for _ in range(15):
        time.sleep(3)
        new_items = _items_after(before)
        att = _find_attachment(new_items, filename)
        if att:
            return att, _parent_of(att)  # parent 可能为 None（识别失败）
    return None, "未在 45s 内定位到新条目"


def _find_attachment(items, filename):
    # 1) 优先：title 仍是原文件名的附件
    for it in items:
        d = it["data"]
        if d.get("itemType") == "attachment" and (d.get("title") or "") == filename:
            return d["key"]
    # 2) 兜底：任意新建的 PDF 附件
    for it in items:
        d = it["data"]
        if d.get("itemType") == "attachment" and d.get("contentType") == "application/pdf":
            return d["key"]
    return None


def _latest_dateadded():
    st, raw = http_get(LOCAL_API + "/api/users/0/items?limit=1&sort=dateAdded&direction=desc")
    if st != 200:
        return None
    try:
        return json.loads(raw)[0]["data"].get("dateAdded")
    except Exception:
        return None


def _items_after(dateadded):
    if not dateadded:
        return []
    st, raw = http_get(
        LOCAL_API + "/api/users/0/items?limit=20&sort=dateAdded&direction=desc")
    if st != 200:
        return []
    out = []
    for it in json.loads(raw):
        d = it["data"]
        if (d.get("dateAdded") or "") > dateadded:
            out.append(it)
    return out


def _parent_of(attachment_key):
    st, raw = http_get(LOCAL_API + "/api/users/0/items/" + attachment_key)
    if st != 200:
        return None
    d = json.loads(raw)["data"]
    return d.get("parentItem") or None


def create_item(data, cfg):
    """用标准 API 创建条目，返回新条目的 key（失败返回 None）。"""
    body = json.dumps([data]).encode("utf-8")
    h = {"Content-Type": "application/json"}
    if cfg.get("server_id"):
        h["Zotero-Server-ID"] = cfg["server_id"]
    if cfg.get("api_key"):
        h["Zotero-API-Key"] = cfg["api_key"]
    req = urllib.request.Request(cfg["base"] + "/items", data=body, method="POST", headers=h)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            d = json.loads(resp.read().decode())
            for v in d.get("successful", {}).values():
                return v.get("key")
    except Exception:
        return None
    return None


def resolve_unrecognized(att_key, filepath, cfg):
    """识别失败的 PDF 兜底：CrossRef 按文件名检索，高置信才建父条目并关联。

    返回 parent key；若检索不到高置信结果则返回 None（留给人工）。
    """
    name = clean_filename(os.path.basename(filepath))
    if len(name) < 15:
        return None
    found = look_title(name, None)
    if not found or not found.get("title"):
        return None
    # 标题词重叠度需足够高才采信（纯文件名检索，宁缺毋滥）
    if found.get("overlap", 0) < 0.6:
        return None
    item = {"itemType": "journalArticle", "title": found["title"]}
    auths = [a for a in (found.get("authors") or []) if a]
    if auths:
        item["creators"] = [{"creatorType": "author", "lastName": a} for a in auths]
    if found.get("year"):
        item["date"] = found["year"]
    parent = create_item(item, cfg)
    if not parent:
        return None
    it = za.get_item(att_key, cfg)
    if it:
        za.patch_item(att_key, {"parentItem": parent}, version=it["version"], cfg=cfg)
    return parent


def _reset_to_toreview(item_key, cfg):
    """把新导入条目强制移到 99. To Review，清掉 Zotero 默认放置的「当前选中文件夹」。

    根因：POST /connector/saveStandaloneAttachment 的 X-Metadata 未指定 collection 时，
    Zotero 会把新条目保存到用户当前选中的集合。为确保新文献统一先落 To Review、
    再由 process_pending 正确分类，这里在导入后立即重置其集合归属。
    """
    it = za.get_item(item_key, cfg)
    if not it:
        return
    key_map = get_collection_key_map()
    tr_key = key_map.get(FALLBACK_COLLECTION)
    if not tr_key:
        return
    cur = set(it["data"].get("collections") or [])
    if cur == {tr_key}:
        return
    za.patch_item(item_key, {"collections": [tr_key]}, version=it["version"], cfg=cfg)


# ---------------------------------------------------------------------------
# 分组：标题 + 标签 -> 收藏夹名
# ---------------------------------------------------------------------------
def classify(title, tags):
    t = (title or "").lower()
    tags = set(tags)
    # 1. 专属主题优先（最具体，命中即定）
    for tag, coll in PRIORITY_TAGS.items():
        if tag in tags:
            return coll
    # 2. AI + 运营 组合 -> 5. AI in Operations
    if any(x in tags for x in AI_TAGS) and any(w in t for w in AI_OPS_WORDS):
        return "5. AI in Operations"
    # 3. 其余按标签映射
    for tag, coll in OTHER_TAGS.items():
        if tag in tags:
            return coll
    return FALLBACK_COLLECTION


def get_collection_key_map():
    """读取 收藏夹名 -> key 映射（数据库快照）。"""
    con = sqlite3.connect(f"file:{za.snapshot_db()}?mode=ro", uri=True)
    cur = con.cursor()
    cur.execute("SELECT collectionName, key FROM collections")
    m = {n: k for n, k in cur.fetchall()}
    con.close()
    return m


# ---------------------------------------------------------------------------
# 处理 Zotero 里未处理（缺元数据/未分类/无标签）的文献条目
# ---------------------------------------------------------------------------
def get_literature_snapshot():
    """返回全部文献条目：key, type, title, doi, date, authors, tags, collections。"""
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
          (SELECT GROUP_CONCAT(cr.lastName,';') FROM itemCreators ic JOIN creators cr ON ic.creatorID=cr.creatorID WHERE ic.itemID=i.itemID) AS authors,
          (SELECT GROUP_CONCAT(t.name,';;') FROM itemTags itg JOIN tags t ON itg.tagID=t.tagID WHERE itg.itemID=i.itemID) AS tags,
          (SELECT GROUP_CONCAT(c.key,';;') FROM collectionItems ci JOIN collections c ON ci.collectionID=c.collectionID WHERE ci.itemID=i.itemID) AS colkeys
        FROM items i JOIN itemTypes it ON i.itemTypeID=it.itemTypeID
        WHERE i.libraryID=1 AND i.itemID NOT IN (SELECT itemID FROM deletedItems)
          AND it.typeName NOT IN ('attachment','note','annotation')
    """)
    rows = [dict(r) for r in cur.fetchall()]
    con.close()
    return rows


def enrich_one(r):
    """CrossRef 补元数据，返回补全后的 dict（高置信才采纳）。"""
    found = None
    if r["doi"]:
        found = look_doi(r["doi"])
    if (not found or not found.get("year")) and r["title"]:
        authors = [a for a in (r["authors"] or "").split(";") if a]
        found = look_title(r["title"], authors)
    if found and found.get("confidence") in ("doi", "title+author") and found.get("year"):
        return found
    return None


def ensure_collection(name, key_map, cfg):
    """确保收藏夹存在，返回其 key；不存在则创建（父级为顶层）。"""
    if name in key_map:
        return key_map[name]
    body = [{"name": name, "parentCollection": False}]
    st, _, raw = za.request("POST", "/collections", body=body, cfg=cfg)
    if st == 200:
        try:
            d = json.loads(raw)
            for v in d.get("successful", {}).values():
                key_map[name] = v.get("key")
                return v.get("key")
        except Exception:
            pass
    return None


def process_pending(cfg, dry_run=False):
    """处理未处理条目：补元数据 -> 分组 -> 打标签。返回事件列表。

    关键：把「99. To Review」视为"未处理"。凡是没有其他有效分类（只在 To Review
    或无任何集合）的条目，都会用标题+标签重算目标文件夹，并**从 To Review 移走**，
    确保 To Review 里只留下确实无法分类的文献。
    """
    rows = get_literature_snapshot()
    key_map = get_collection_key_map()
    to_review_key = key_map.get(FALLBACK_COLLECTION)
    events = []

    for r in rows:
        title = r["title"] or ""
        # 排除 Zotero 系统标签（以 "/" 开头，如 /unread、/favorite），只认用户标签
        tags = [t for t in ((r["tags"] or "").split(";;") if r["tags"] else [])
                if t and not t.startswith("/")]
        cols = [c for c in ((r["colkeys"] or "").split(";;") if r["colkeys"] else []) if c]
        needs_meta = not r["date"] or not r["authors"]
        needs_tags = not tags
        # 有效分类 = 除 To Review 之外的其他集合；无有效分类才需要（重新）分类
        has_valid_col = any(c != to_review_key for c in cols)
        needs_col = not has_valid_col

        if not (needs_meta or needs_tags or needs_col):
            continue

        # 1. 补元数据
        meta_patch = {}
        if needs_meta:
            found = enrich_one(r)
            if found:
                if not r["date"] and found.get("year"):
                    meta_patch["date"] = found["year"]
                if not r["authors"] and found.get("authors"):
                    meta_patch["creators"] = [
                        {"creatorType": "author", "lastName": a}
                        for a in found["authors"]
                    ]

        # 2. 计算标签（缺标签才补；分类始终基于"已有 + 新算"标签重算）
        new_tags = []
        if needs_tags:
            new_tags = compute_tags(title)

        # 3. 分组：无有效分类时重算目标文件夹
        target_col = None
        if needs_col:
            all_tags = tags + new_tags
            target_col = classify(title, all_tags)

        ev = {
            "key": r["key"], "title": title[:60],
            "meta": bool(meta_patch), "tags": new_tags, "collection": target_col,
        }
        events.append(ev)

        if dry_run:
            continue

        # 执行写入（带版本保护）
        it = za.get_item(r["key"], cfg)
        if not it:
            ev["status"] = "get-fail"
            continue
        ver = it["version"]

        # PATCH 元数据 + 标签
        if meta_patch or new_tags:
            body = {}
            if meta_patch:
                body.update(meta_patch)
            if new_tags:
                existing = {t.get("tag") for t in (it["data"].get("tags") or [])
                            if not (t.get("tag") or "").startswith("/")}
                merged = sorted(existing | set(new_tags))
                body["tags"] = [{"tag": t, "type": 0} for t in merged]
            st, _, _ = za.patch_item(r["key"], body, version=ver, cfg=cfg)
            if st != 204:
                ev["status"] = "patch-fail"
                continue
            it = za.get_item(r["key"], cfg)
            ver = it["version"] if it else ver

        # PATCH 分组：从 To Review 移走，加入目标文件夹（目标不存在则先创建）
        if target_col and target_col != FALLBACK_COLLECTION:
            target_key = ensure_collection(target_col, key_map, cfg)
            if target_key:
                cur_cols = set(it["data"].get("collections") or []) if it else set(cols)
                if to_review_key:
                    cur_cols.discard(to_review_key)
                cur_cols.add(target_key)
                st, _, _ = za.patch_item(
                    r["key"], {"collections": sorted(cur_cols)},
                    version=ver, cfg=cfg)
                ev["collection_key"] = target_key
        ev["status"] = "ok"
        time.sleep(0.1)

    return events


# ---------------------------------------------------------------------------
# 汇总报告
# ---------------------------------------------------------------------------
def append_report(lines, dry_run=False):
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    today = datetime.now().strftime("%Y-%m-%d")
    path = REPORT_DIR / f"{today}.md"
    header = f"\n## {datetime.now().strftime('%H:%M:%S')}{'（预览）' if dry_run else ''}\n"
    with open(path, "a", encoding="utf-8") as f:
        f.write(header + "\n".join(lines) + "\n")


def weekly_report():
    if not REPORT_DIR.exists():
        print("暂无日报数据。")
        return
    week_start = (datetime.now() - timedelta(days=datetime.now().weekday())).strftime("%Y-%m-%d")
    parts = ["# 本周 Zotero 文献自动管理周报\n"]
    for p in sorted(REPORT_DIR.glob("*.md")):
        if p.name.startswith("weekly-"):
            continue
        if p.name[:10] >= week_start:
            parts.append(f"\n---\n\n## {p.name}\n\n")
            parts.append(p.read_text(encoding="utf-8"))
    out = REPORT_DIR / f"weekly-{week_start}.md"
    out.write_text("".join(parts), encoding="utf-8")
    print(f"周报已生成: {out}")
    print("\n".join(parts)[:3000])


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def main():
    dry_run = "--dry-run" in sys.argv
    import_existing = "--import-existing" in sys.argv

    if "--report" in sys.argv:
        weekly_report()
        return

    # 手动导入单个文件
    if "--ingest" in sys.argv:
        idx = sys.argv.index("--ingest")
        if idx + 1 < len(sys.argv):
            _run_ingest([sys.argv[idx + 1]], dry_run=dry_run)
        return

    if not api_available():
        print("⚠️ Zotero 未运行或本地 API 不可用（http://localhost:23119）。请先启动 Zotero。")
        sys.exit(1)

    # 扫描下载目录（递归含子文件夹）
    pdfs = scan_pdfs()
    state = load_state()

    def is_skip(p):
        v = state.get(str(p))
        return isinstance(v, dict) and bool(v.get("skip"))

    new_pdfs = []
    done_pdfs = []  # 已在 state 且未变化 = 之前已成功导入、源文件仍留在磁盘
    for p in pdfs:
        # 标记为 skip 的文件（个人文件/非文献）永不导入、永不删除
        if is_skip(p):
            continue
        prev = state.get(str(p))
        sig = file_sig(p)
        if import_existing or not prev or prev != sig:
            new_pdfs.append(p)
        elif prev == sig:
            done_pdfs.append(p)
    if import_existing:
        new_pdfs = [p for p in pdfs if not is_skip(p)]
        done_pdfs = []

    # 首次运行：若无任何记录，把现有 PDF 记为基线（不导入），只处理之后新增的
    if not state and not import_existing:
        if dry_run:
            print(f"[预览] 首次运行会把现有 {len(pdfs)} 个 PDF 记为基线（不导入）。")
        else:
            for p in pdfs:
                state[str(p)] = file_sig(p)
            save_state(state)
            print(f"首次运行：已将现有 {len(pdfs)} 个 PDF 记为基线，不自动导入。"
                  f"之后新下载的 PDF 才会自动处理（如需导入现有 PDF 请用 --import-existing）。")
        new_pdfs = []
        done_pdfs = []

    _run_ingest(new_pdfs, dry_run=dry_run)

    # 清理：之前已成功导入、源文件仍留在 Downloads 的，移入废纸篓
    if done_pdfs:
        if dry_run:
            print(f"\n[预览] 将清理 {len(done_pdfs)} 个已导入但仍留在 Downloads 的文件")
        else:
            n = sum(1 for p in done_pdfs if trash_file(p))
            print(f"\n[清理] 已移入废纸篓 {n}/{len(done_pdfs)} 个已导入文件")


def _run_ingest(pdfs, dry_run=False):
    pdfs = [Path(p) for p in pdfs]  # 统一转 Path（--ingest 传入的是字符串）
    cfg = za.detect_config()
    state = load_state()
    report = []

    # --- 1. 导入新 PDF ---
    imported = []
    for p in pdfs:
        if dry_run:
            print(f"[预览] 将导入 {p.name}")
            imported.append({"file": p.name, "status": "preview"})
            continue
        att, parent = ingest_pdf(str(p))
        if not att:
            print(f"[失败] {p.name}: {parent}")
            imported.append({"file": p.name, "status": f"fail:{parent}"})
            continue
        state[str(p)] = file_sig(p)
        # 识别失败 -> CrossRef 按文件名兜底；仍失败则待人工
        if not parent:
            parent = resolve_unrecognized(att, str(p), cfg)
        imported.append({"file": p.name, "attachment": att, "parent": parent})
        # 修复：Zotero 会把新条目存到「当前选中文件夹」，这里强制先落 To Review，
        # 交由 process_pending 正确分类，避免被存进用户正浏览的文件夹
        if parent:
            _reset_to_toreview(parent, cfg)
        print(f"[导入] {p.name} -> attachment {att} (parent={parent or '待人工'})")
        # 成功导入后，把 Downloads 里的源文件移入废纸篓（可恢复）
        if trash_file(p):
            print(f"  [清理] 已移入废纸篓: {p.name}")
        time.sleep(0.5)
    save_state(state)

    # --- 2. 处理未处理条目 ---
    print("\n开始处理未处理条目（补元数据 + 分组 + 打标签）...")
    events = process_pending(cfg, dry_run=dry_run)
    ok = sum(1 for e in events if e.get("status") == "ok")
    print(f"处理条目 {len(events)} 条" + ("（预览）" if dry_run else f"，成功 {ok} 条"))

    # --- 2.5 自动去重（同一篇论文以不同文件名下载会被导入两次，这里合并并删除冗余）---
    if not dry_run:
        try:
            from deduplicate import deduplicate as run_dedup
            print("\n开始自动去重...")
            run_dedup(dry_run=False, cfg=cfg)
        except Exception as e:
            print(f"[去重] 跳过：{e}")

    # --- 3. 汇总 ---
    lines = [
        f"- 新导入 PDF：{len(imported)} 个",
        f"- 处理未处理条目：{len(events)} 个",
    ]
    manual = [it for it in imported if it.get("attachment") and not it.get("parent")]
    if manual:
        lines.append(f"- ⚠️ 识别失败待人工：{len(manual)} 个")
        for it in manual:
            lines.append(f"  - {it['file']}")
    for ev in events:
        tag_s = ",".join(ev["tags"]) or "-"
        col_s = ev["collection"] or "-"
        meta_s = "补元数据" if ev["meta"] else "-"
        lines.append(f"  - {ev['title']} | 标签: {tag_s} | 分组: {col_s} | {meta_s}")
    append_report(lines, dry_run=dry_run)

    if not dry_run:
        print("\n✅ 完成。当日摘要已写入 reports/")
    else:
        print("\n（--dry-run 预览模式，未写入任何数据）")


if __name__ == "__main__":
    main()
