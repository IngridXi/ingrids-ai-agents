#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Mermaid -> PPTX 导出（供 Ingrid's AI Agents 工作台主进程调用）。

用法：<venv_mermaid>/bin/python mermaid2ppt_export.py < input.json
输入 JSON：{"source": "flowchart LR ...", "style": "native|official", "out_path": "/abs/path.pptx"}
输出 JSON：{"ok": true, "path": "...", "renamed": 3, "diagnostics": 0} 或 {"ok": false, "error": "..."}

依赖：diagram-pptx + python-pptx（需 Python >= 3.10，装在 venv_mermaid 环境）。
"""
import json
import re
import sys

from pptx import Presentation
from pptx.util import Inches
from diagram_pptx import render_mermaid

# ---------------------------------------------------------------------------
# Mermaid 节点 ID 规范化：diagram-pptx 的 native 后端要求节点 ID 为 ASCII，
# 但允许中文标签。因此把「中文 ID」自动映射为英文 ID（n1/n2/...），
# 节点标签与边标签原样保留，用户无需手动改成英文。
# ---------------------------------------------------------------------------

_SHAPE_PAIRS = [
    ("[[", "]]"), ("[(", ")]"), ("[/", "/]"), ("[\\", "\\]"),
    ("((", "))"), ("{{", "}}"),
    ("[", "]"), ("(", ")"), ("{", "}"),
]
_SHAPE_OPEN_SORTED = sorted((p[0] for p in _SHAPE_PAIRS), key=len, reverse=True)
_SHAPE_CLOSE = dict(_SHAPE_PAIRS)

_EDGE_OPS_SORTED = sorted(
    ["-.->", "-.-", "-->", "---", "==>", "===", "~~", "->", "==", "--", "-."],
    key=len,
    reverse=True,
)

_TOKEN_BREAK = set('[](){}|;,\'"`<>:')
_DIRECT = set('[](){}|;,\'"`<>:')

_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]")


def _has_cjk(s):
    return bool(_CJK_RE.search(s))


def _match_open(s, k):
    if k >= len(s):
        return None
    for op in _SHAPE_OPEN_SORTED:
        if s.startswith(op, k):
            return op
    return None


def _match_edge(s, i):
    """从位置 i 匹配一条边运算符（含可选的 |label| 或 -- text -->）。"""
    n = len(s)
    for op in _EDGE_OPS_SORTED:
        if s.startswith(op, i):
            j = i + len(op)
            # -->|label| 形式
            if j < n and s[j] == "|":
                k = s.find("|", j + 1)
                if k != -1:
                    j = k + 1
            # -- text --> / --- text --- 形式
            if op in ("--", "---"):
                k = j
                while k < n and s[k].isspace():
                    k += 1
                cands = [
                    x for x in (s.find("-->", k), s.find("---", k), s.find("==>", k))
                    if x != -1
                ]
                if cands:
                    m = min(cands)
                    if m > j:
                        j = m + 3
                        if j < n and s[j] == "|":
                            kk = s.find("|", j + 1)
                            if kk != -1:
                                j = kk + 1
                        return j
            return j
    return None


def _transform_line(main, alloc):
    out = []
    pending = ""
    i = 0
    n = len(main)
    prev_edge = True  # 行首视为「边之前」，第一个 token 可能是源节点 ID
    while i < n:
        ch = main[i]
        if ch.isspace():
            pending += ch
            i += 1
            continue
        if ch in _DIRECT:
            out.append(pending + ch)
            pending = ""
            i += 1
            continue
        if ch in "-=~":
            j = _match_edge(main, i)
            if j is not None:
                out.append(pending + main[i:j])
                pending = ""
                i = j
                prev_edge = True
                continue
            out.append(pending + ch)
            pending = ""
            i += 1
            prev_edge = False
            continue
        # 读取 token
        j = i
        while (
            j < n
            and not main[j].isspace()
            and main[j] not in _TOKEN_BREAK
            and main[j] not in "-=~"
        ):
            j += 1
        token = main[i:j]
        k = j
        while k < n and main[k].isspace():
            k += 1
        opened = _match_open(main, k)
        if opened:
            # 节点声明：ID[标签]
            new_tok = alloc(token) if _has_cjk(token) else token
            out.append(pending + new_tok + main[j:k])
            pending = ""
            close = _SHAPE_CLOSE[opened]
            c = k + len(opened)
            end = main.find(close, c)
            end = n if end == -1 else end
            out.append(main[k:end + len(close)])
            i = end + len(close)
            prev_edge = False
            continue
        # 裸 token：边里的 ID（前面是边运算符/行首）才映射，subgraph 标题等不映射
        if _has_cjk(token) and prev_edge:
            out.append(pending + alloc(token))
            pending = ""
        else:
            out.append(pending + token)
            pending = ""
        i = j
        prev_edge = False
    out.append(pending)
    return "".join(out)


def normalize_mermaid_ids(source):
    """把 flowchart/graph 中非 ASCII 节点 ID 替换为英文 ID，返回 (新源码, 映射表)。"""
    if not source:
        return source, {}
    if not re.search(r"^\s*(flowchart|graph)\b", source, re.M):
        return source, {}

    id_map = {}
    used = set(re.findall(r"[A-Za-z][A-Za-z0-9_]*", source))
    counter = 0

    def alloc(orig):
        nonlocal counter
        if orig in id_map:
            return id_map[orig]
        while True:
            counter += 1
            cand = "n%d" % counter
            if cand not in used:
                used.add(cand)
                id_map[orig] = cand
                return cand

    out = []
    for line in source.split("\n"):
        idx = line.find("%%")
        main = line if idx == -1 else line[:idx]
        comment = "" if idx == -1 else line[idx:]
        out.append(_transform_line(main, alloc) + comment)
    return "\n".join(out), id_map


def main():
    data = json.loads(sys.stdin.read())
    source = str(data.get("source") or "").strip()
    style = str(data.get("style") or "native")
    out_path = str(data.get("out_path") or "").strip()

    if not source:
        print(json.dumps({"ok": False, "error": "Mermaid 源码为空"}))
        return
    if not out_path:
        print(json.dumps({"ok": False, "error": "缺少输出路径"}))
        return

    source, id_map = normalize_mermaid_ids(source)

    prs = Presentation()
    prs.slide_width = Inches(13.333)   # 16:9
    prs.slide_height = Inches(7.5)
    slide = prs.slides.add_slide(prs.slide_layouts[6])  # 空白版式
    result = render_mermaid(
        source,
        slide=slide,
        relative_bounds=(0.05, 0.05, 0.90, 0.90),  # 四周留 5% 边距
        style=style,
    )
    prs.save(out_path)
    diags = getattr(result, "diagnostics", None) or []
    print(json.dumps({
        "ok": True,
        "path": out_path,
        "renamed": len(id_map),
        "diagnostics": len(diags),
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)}))
