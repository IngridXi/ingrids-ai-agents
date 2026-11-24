#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把前端 mermaid.js 渲染出的 PNG 嵌入一张 16:9 的 .pptx（保真导出）。

用法：<venv_mermaid>/bin/python mermaid2ppt_image.py < input.json
输入 JSON：{"png": "<base64 PNG>", "out_path": "/abs/path.pptx"}
输出 JSON：{"ok": true, "path": "..."} 或 {"ok": false, "error": "..."}

背景：diagram-pptx（beta）对 sequence/class/state 等复杂图的布局质量差
（participant/label 宽度固定、长文本溢出、生命线过长），而预览用的 mermaid.js
布局是正确的。因此这些图走「图片导出」保证与预览 100% 一致；flowchart 仍走
可编辑形状导出。
"""
import base64
import io
import json
import struct
import sys

from pptx import Presentation
from pptx.util import Emu, Inches


def png_size(data):
    """从 PNG 头部解析像素宽高（IHDR 里 width/height 为大端 uint32）。"""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    w, h = struct.unpack(">II", data[16:24])
    if w <= 0 or h <= 0:
        return None
    return w, h


def main():
    data = json.loads(sys.stdin.read())
    png_b64 = str(data.get("png") or "").strip()
    out_path = str(data.get("out_path") or "").strip()

    if not png_b64:
        print(json.dumps({"ok": False, "error": "缺少图片数据"}))
        return
    if not out_path:
        print(json.dumps({"ok": False, "error": "缺少输出路径"}))
        return

    try:
        raw = base64.b64decode(png_b64)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": "图片解码失败：" + str(e)}))
        return

    if not raw:
        print(json.dumps({"ok": False, "error": "图片数据为空"}))
        return

    prs = Presentation()
    prs.slide_width = Inches(13.333)  # 16:9
    prs.slide_height = Inches(7.5)
    slide = prs.slides.add_slide(prs.slide_layouts[6])  # 空白版式

    size = png_size(raw)
    if size:
        w_px, h_px = size
        max_w = Emu(int(prs.slide_width * 0.92))   # 四周留 4% 边距
        max_h = Emu(int(prs.slide_height * 0.92))
        scale = min(max_w / w_px, max_h / h_px)
        width = Emu(int(w_px * scale))
        height = Emu(int(h_px * scale))
        left = Emu(int((prs.slide_width - width) / 2))
        top = Emu(int((prs.slide_height - height) / 2))
        slide.shapes.add_picture(io.BytesIO(raw), left, top, width=width, height=height)
    else:
        slide.shapes.add_picture(io.BytesIO(raw), Emu(0), Emu(0))

    prs.save(out_path)
    print(json.dumps({"ok": True, "path": out_path}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": str(e)}))
