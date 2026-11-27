#!/usr/bin/env python3
"""Zotero 本地 API 共享模块：自动探测配置 + 提供读写函数。

用法（其他脚本）：
    import zotero_api as za
    cfg = za.detect_config()
    item = za.get_item("ABC123", cfg)
    za.patch_item("ABC123", {"tags": [...]}, version=..., cfg=cfg)
"""
import os
import json
import shutil
import sqlite3
import tempfile
import urllib.request
import urllib.error
from pathlib import Path

ZOTERO_DATA = Path(os.environ.get("ZOTERO_DATA", str(Path.home() / "Zotero")))
DB_PATH = ZOTERO_DATA / "zotero.sqlite"
PROFILE_DIR = Path(os.environ.get(
    "ZOTERO_PROFILE",
    str(Path.home() / "Library/Application Support/Zotero/Profiles"),
))


def _first_profile_dir():
    if not PROFILE_DIR.exists():
        return None
    for d in sorted(PROFILE_DIR.iterdir()):
        if d.is_dir():
            return d
    return None


def snapshot_db():
    """复制数据库快照（含 -wal/-shm），避免与运行中的 Zotero 锁冲突。

    返回快照 sqlite 路径；调用方读完可删除其父目录。
    """
    if not DB_PATH.exists():
        raise FileNotFoundError(f"找不到 Zotero 数据库: {DB_PATH}")
    snap = Path(tempfile.mkdtemp(prefix="zotero_snap_"))
    for suffix in ("", "-wal", "-shm"):
        src = Path(str(DB_PATH) + suffix)
        if src.exists():
            shutil.copy2(src, snap / (DB_PATH.name + suffix))
    return snap / DB_PATH.name


def read_only_conn():
    """返回指向数据库快照的只读连接。"""
    snap = snapshot_db()
    con = sqlite3.connect(f"file:{snap}?mode=ro", uri=True)
    return con, snap.parent


def detect_config():
    """自动探测 userID、serverID、API-Key。"""
    if not DB_PATH.exists():
        raise FileNotFoundError(f"找不到 Zotero 数据库: {DB_PATH}")
    snap = snapshot_db()
    con = sqlite3.connect(f"file:{snap}?mode=ro", uri=True)
    cur = con.cursor()
    cur.execute("SELECT userID FROM users LIMIT 1")
    row = cur.fetchone()
    user_id = row[0] if row else None
    cur.execute("SELECT value FROM settings WHERE setting='localAPI' AND key='serverID'")
    row = cur.fetchone()
    server_id = row[0] if row else None
    con.close()

    api_key = None
    prof = _first_profile_dir()
    if prof:
        kf = prof / "localAPIKeys.json"
        if kf.exists():
            try:
                keys = json.loads(kf.read_text(encoding="utf-8")).get("keys", [])
                if keys:
                    api_key = keys[0].get("key")
            except Exception:
                api_key = None

    return {
        "user_id": user_id,
        "server_id": server_id,
        "api_key": api_key,
        "base": f"http://localhost:23119/api/users/{user_id}",
    }


def request(method, path, body=None, version=None, cfg=None):
    """发起本地 API 请求，返回 (status, last_modified_version, raw_body)。"""
    cfg = cfg or detect_config()
    data = json.dumps(body).encode("utf-8") if body is not None else None
    h = {"Content-Type": "application/json"}
    if cfg.get("server_id"):
        h["Zotero-Server-ID"] = cfg["server_id"]
    if cfg.get("api_key"):
        h["Zotero-API-Key"] = cfg["api_key"]
    if version is not None:
        h["If-Unmodified-Since-Version"] = str(version)
    req = urllib.request.Request(cfg["base"] + path, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.headers.get("Last-Modified-Version"), resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, None, e.read().decode()
    except urllib.error.URLError as e:
        return 0, None, str(e)


def get_item(key, cfg=None):
    st, _, raw = request("GET", f"/items/{key}", cfg=cfg)
    return json.loads(raw) if st == 200 else None


def patch_item(key, data, version=None, cfg=None):
    return request("PATCH", f"/items/{key}", body=data, version=version, cfg=cfg)


def delete_item(key, version=None, cfg=None):
    return request("DELETE", f"/items/{key}", version=version, cfg=cfg)


def get_collections(cfg=None):
    st, _, raw = request("GET", "/collections?limit=100", cfg=cfg)
    return json.loads(raw) if st == 200 else []


if __name__ == "__main__":
    import sys
    cfg = detect_config()
    print(json.dumps(cfg, ensure_ascii=False, indent=2))
