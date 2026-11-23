#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Mermaid -> PPTX 导出（供 Ingrid's AI Agents 工作台主进程调用）。

用法：<venv_mermaid>/bin/python mermaid2ppt_export.py < input.json
输入 JSON：{"source": "flowchart LR ...", "style": "native|official", "out_path": "/abs/path.pptx"}
输出 JSON：{"ok": true, "path": "...", "diagnostics": 0} 或 {"ok": false, "error": "..."}

依赖：diagram-pptx + python-pptx（需 Python >= 3.10，装在 venv_mermaid 环境）。
"""
import json
import sys

from pptx import Presentation
from pptx.util import Inches
from diagram_pptx import render_mermaid


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
    print(json.dumps({"ok": True, "path": out_path, "diagnostics": len(diags)}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)}))
