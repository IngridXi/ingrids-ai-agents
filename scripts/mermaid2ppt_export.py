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
from math import hypot

from pptx import Presentation
from pptx.enum.shapes import MSO_CONNECTOR
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


# ---------------------------------------------------------------------------
# 连线跟随修复：
# 1) group=False —— 形状平铺到 slide。PowerPoint/WPS 对 group 内 connector 的
#    连接点跟随支持不完整，去掉外层 group 后拖动节点连线才能正常跟随。
# 2) 多段折线边改用 ELBOW connector —— 有拐点的边不再被拆成多段静态直线，
#    拐点交给 PowerPoint 自动布线，拖动节点时整条线（含拐点）跟随。
# ---------------------------------------------------------------------------

_patch_applied = False


def _install_elbow_patch():
    """把 diagram-pptx 的多段折线边渲染为 ELBOW connector（幂等，带 fallback）。"""
    global _patch_applied
    if _patch_applied:
        return
    _patch_applied = True  # 只尝试一次；失败则静默回退到默认直线渲染
    try:
        from diagram_pptx.render.python_pptx import PythonPptxRenderer, _simplify_path
        from diagram_pptx.scene import Point
        from diagram_pptx.styles import ElementStyle
    except ImportError:
        return

    _orig = PythonPptxRenderer._render_connector

    def _render_connector_elbow(self, slide, item, transform):
        try:
            points = _simplify_path(item.points)
        except Exception:
            return _orig(self, slide, item, transform)
        if len(points) <= 2:
            return _orig(self, slide, item, transform)
        try:
            start, end = points[0], points[-1]
            sx, sy = transform.point(start)
            ex, ey = transform.point(end)
            connector = slide.shapes.add_connector(MSO_CONNECTOR.ELBOW, sx, sy, ex, ey)
            connector.name = self._shape_name(item)
            self._apply_line(
                connector.line, item.style, default="#536273", scale=transform.stroke_scale
            )
            if item.start_marker:
                self._set_line_end(connector.line, "headEnd", item.start_marker)
            if item.directed and item.end_marker:
                self._set_line_end(connector.line, "tailEnd", item.end_marker)
            connectors = [connector]

            label_shape = None
            if item.label:
                raw_label_point = item.metadata.get("label_point")
                midpoint, label_segment = self._path_midpoint_segment(points)
                if isinstance(raw_label_point, (list, tuple)) and len(raw_label_point) == 2:
                    midpoint = Point(float(raw_label_point[0]), float(raw_label_point[1]))
                center_x, center_y = transform.point(midpoint)
                label_width_inches = self._connector_label_width(
                    item.label, item.style, font_scale=transform.font_scale,
                    slide_height_points=transform.slide_height_points,
                )
                label_width = Inches(label_width_inches)
                label_height = Inches(0.36)
                label_top = center_y - Inches(0.18)
                label_left = center_x - label_width // 2
                placement = str(item.metadata.get("label_placement", "auto"))
                seg_start, seg_end = label_segment
                seg_h = abs(seg_end.x - seg_start.x) >= abs(seg_end.y - seg_start.y)
                seg_len = hypot(seg_end.x - seg_start.x, seg_end.y - seg_start.y) * transform.scale
                detached = placement == "above" or (
                    placement == "auto"
                    and seg_len < label_width_inches + 0.28
                    and (len(points) == 2 or seg_h)
                )
                if placement == "above" or (detached and seg_h):
                    label_top = center_y - label_height - Inches(0.06)
                elif detached:
                    label_left = center_x + Inches(0.06)
                label_shape = slide.shapes.add_textbox(
                    label_left, label_top, label_width, label_height
                )
                label_shape.name = f"{self._shape_name(item)}:label"
                if detached and item.style.label_fill is None:
                    label_shape.fill.background()
                else:
                    self._apply_fill(
                        label_shape.fill,
                        ElementStyle(fill=item.style.label_fill or "#FFFFFF"),
                        default="#FFFFFF",
                    )
                label_shape.line.fill.background()
                self._format_text_frame(
                    label_shape.text_frame, item.label, item.style,
                    default_color=item.style.line or "#536273", default_size=12.0,
                    font_scale=transform.font_scale,
                    slide_height_points=transform.slide_height_points,
                    min_size=max(
                        12.0,
                        self.typography.edge_min_font_size.resolve(
                            slide_height_points=transform.slide_height_points
                        ),
                    ),
                    max_size=18.0, box_width=label_width, box_height=label_height,
                )
            return connectors, label_shape
        except Exception:
            return _orig(self, slide, item, transform)

    PythonPptxRenderer._render_connector = _render_connector_elbow


def render_editable(source, slide, style):
    """渲染可编辑原生形状，并启用连线跟随修复。返回 CompileResult。"""
    _install_elbow_patch()
    return render_mermaid(
        source,
        slide=slide,
        relative_bounds=(0.05, 0.05, 0.90, 0.90),  # 四周留 5% 边距
        style=style,
        group=False,  # 形状平铺 slide，保证拖动节点时连线跟随
    )


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
    result = render_editable(source, slide, style)
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
