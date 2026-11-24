#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""sequenceDiagram -> 原生可编辑形状 PPT 渲染器（local-first）。

diagram-pptx 对 sequence 图布局质量差（时序图导出「全乱」），
但时序图几何规律固定（参与者泳道 + 水平消息箭头 + loop/alt 框 + note），
因此这里用 python-pptx 直接绘制为原生形状（文本框 + 直线/箭头 + 矩形），
版面与 mermaid 预览基本一致，且导出后每个元素都能在 PowerPoint/WPS 里点开修改。

支持语法子集：
- participant / actor [别名 [as 标签]]
- 消息：A->>B: 文本  /  A-->>B  /  A->B  /  A-->B  /  A-)B  /  A-xB 等
- note over A[,B]: 文本 / note left of A / note right of A
- loop / alt / else / opt / par / and / critical / break ... end
- activate / deactivate
"""
import re
from math import ceil

from pptx.util import Inches, Pt
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE, MSO_CONNECTOR
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.enum.dml import MSO_LINE_DASH_STYLE
from pptx.oxml.ns import qn

# ---------------------------------------------------------------------------
# 版式常量（英寸）
# ---------------------------------------------------------------------------
SLIDE_W = 13.333
SLIDE_H = 7.5
LEFT = 0.55
RIGHT = 0.55
TOP = 0.5
BOTTOM = 0.35
CONTENT_W = SLIDE_W - LEFT - RIGHT          # 12.233
AVAIL_H = SLIDE_H - TOP - BOTTOM            # 6.65

BOX_H = 0.52                                 # 参与者头框高度
MSG_START_GAP = 0.34                         # 头框底到第一条消息的间距
MSG_H = 0.46                                 # 每条消息占用的行高
FRAME_HEADER = 0.34                          # loop/alt 框头部标签带高度
FRAME_TOP_GAP = 0.28                         # 框头部标签带下到首条消息的间隙（容纳消息标签）
FRAME_PAD = 0.10                             # 框底部留白
NOTE_LINE_H = 0.20

# 配色（贴近 mermaid neutral 主题）
C_TEXT = RGBColor(0x1F, 0x1F, 0x1F)
C_PART_FILL = RGBColor(0xEC, 0xEC, 0xF4)
C_PART_LINE = RGBColor(0x5B, 0x5B, 0x66)
C_LIFELINE = RGBColor(0xB0, 0xB0, 0xBB)
C_MSG = RGBColor(0x3A, 0x3A, 0x3A)
C_ACT_FILL = RGBColor(0xDE, 0xDE, 0xEB)
C_FRAME = RGBColor(0x8A, 0x8A, 0x95)
C_NOTE_FILL = RGBColor(0xFF, 0xF7, 0xC8)
C_NOTE_LINE = RGBColor(0xC9, 0xB4, 0x58)
C_BAND = RGBColor(0xFA, 0xFA, 0xFC)

# ---------------------------------------------------------------------------
# 解析
# ---------------------------------------------------------------------------

PART_RE = re.compile(r"^\s*(participant|actor)\s+([A-Za-z][\w]*)\s*(?:as\s+(.+))?\s*$")
MSG_RE = re.compile(
    r"^\s*(?:\[\s*(?:active|inactive|off)\s*\]\s*)?"
    r"([A-Za-z][\w]*)\s*"
    r"(-->>|-->|--x|--\)|->>|->|-x|-\))\s*"
    r"([A-Za-z][\w]*)\s*"
    r"(?::\s*(.*))?$"
)
NOTE_RE = re.compile(r"^\s*note\s+(over|left\s+of|right\s+of)\s+(.+?)\s*:\s*(.*)$")
FRAME_RE = re.compile(r"^\s*(loop|alt|opt|par|critical|break)\s+(.*)$")
ELSE_RE = re.compile(r"^\s*(else|and|option)\s*(.*)$")
END_RE = re.compile(r"^\s*end\s*$", re.I)
ACT_RE = re.compile(r"^\s*(activate|deactivate)\s+([A-Za-z][\w]*)\s*$")

# 箭头语义：dashed? / 尾端标记
ARROW_META = {
    "->>": (False, "arrow"),
    "->": (False, "none"),
    "-->": (True, "none"),
    "-->>": (True, "arrow"),
    "-x": (False, "cross"),
    "--x": (True, "cross"),
    "-)": (False, "async"),
    "--)": (True, "async"),
}


def _strip_comment(line):
    idx = line.find("%%")
    return line if idx == -1 else line[:idx]


def parse(source):
    """返回 (participants, tree)。
    participants: 有序 alias 列表；plabel: alias->显示标签。
    tree: 嵌套 item 列表，item 为 dict，kind 见下。"""
    participants = []
    porder = {}
    plabel = {}

    def ensure(alias):
        if alias not in porder:
            porder[alias] = len(participants)
            plabel[alias] = alias
            participants.append(alias)
        return porder[alias]

    lines = [_strip_comment(ln) for ln in source.split("\n")]
    # 第一遍收集参与者（保持首次出现顺序）
    for ln in lines:
        m = PART_RE.match(ln)
        if m:
            ensure(m.group(2))
            if m.group(3):
                plabel[m.group(2)] = m.group(3).strip()

    root = []
    current = root
    frame_stack = []

    for ln in lines:
        s = ln.strip()
        if not s:
            continue
        m = PART_RE.match(ln)
        if m:
            continue
        m = FRAME_RE.match(ln)
        if m:
            kind, label = m.group(1), m.group(2).strip()
            node = {"kind": "frame", "ftype": kind,
                    "branches": [{"label": (kind + " " + label).strip(), "children": []}]}
            current.append(node)
            frame_stack.append(node)
            current = node["branches"][0]["children"]
            continue
        m = ELSE_RE.match(ln)
        if m:
            if not frame_stack:
                continue
            kind, label = m.group(1), m.group(2).strip()
            f = frame_stack[-1]
            br = {"label": (kind + (" " + label if label else "")).strip(), "children": []}
            f["branches"].append(br)
            current = br["children"]
            continue
        if END_RE.match(ln):
            if frame_stack:
                frame_stack.pop()
                current = frame_stack[-1]["branches"][-1]["children"] if frame_stack else root
            continue
        m = ACT_RE.match(ln)
        if m:
            current.append({"kind": m.group(1), "target": m.group(2)})
            continue
        m = MSG_RE.match(ln)
        if m:
            src, arrow, dst, label = m.groups()
            dashed, marker = ARROW_META[arrow]
            ensure(src)
            ensure(dst)
            current.append({"kind": "message", "src": src, "dst": dst,
                            "dashed": dashed, "marker": marker,
                            "label": (label or "").strip()})
            continue
        m = NOTE_RE.match(ln)
        if m:
            placement = m.group(1).replace(" ", "")
            targets = [t.strip() for t in m.group(2).split(",") if t.strip()]
            for t in targets:
                ensure(t)
            current.append({"kind": "note", "placement": placement,
                            "targets": targets, "text": m.group(3).replace("<br/>", "\n")})
            continue
        # 无法识别的行静默忽略
    return participants, plabel, root


# ---------------------------------------------------------------------------
# 布局：递归计算每个 item 的 y / h，返回最终 y
# ---------------------------------------------------------------------------

def _collect_cols(item, porder):
    """返回 item 子树内涉及的最小/最大列索引。"""
    mn, mx = None, None
    if item["kind"] == "message":
        cols = [porder[item["src"]], porder[item["dst"]]]
    elif item["kind"] == "note":
        cols = [porder[t] for t in item["targets"]]
    elif item["kind"] == "frame":
        cols = []
        for br in item["branches"]:
            for ch in br["children"]:
                a, b = _collect_cols(ch, porder)
                if a is not None:
                    cols.append(a)
                    cols.append(b)
    else:
        return None, None
    if cols:
        mn, mx = min(cols), max(cols)
    return mn, mx


def _note_lines(text):
    n = 0
    for seg in text.split("\n"):
        n += max(1, ceil(len(seg) / 40.0))
    return max(1, n)


def _note_height(text):
    return 0.16 + NOTE_LINE_H * _note_lines(text)


def layout(items, y, porder):
    """就地给每个 item 标 y（框还有 end_y）。返回最终 y。"""
    for it in items:
        kind = it["kind"]
        if kind == "message":
            it["y"] = y
            y += MSG_H
        elif kind == "note":
            it["y"] = y
            it["h"] = _note_height(it["text"])
            y += it["h"]
        elif kind == "frame":
            it["y"] = y
            inner = y + FRAME_HEADER + FRAME_TOP_GAP
            for br in it["branches"]:
                br["y"] = inner
                inner = layout(br["children"], inner, porder)
            it["end_y"] = inner + FRAME_PAD
            y = it["end_y"]
        elif kind in ("activate", "deactivate"):
            it["y"] = y
        else:
            it["y"] = y
    return y


# ---------------------------------------------------------------------------
# 绘制
# ---------------------------------------------------------------------------

class _Ctx:
    def __init__(self, slide, porder, plabel, ncols, scale):
        self.slide = slide
        self.porder = porder
        self.plabel = plabel
        self.ncols = ncols
        self.scale = scale
        self.col_w = CONTENT_W / ncols
        self.ops = []          # (priority, callable)
        self.lifeline_bottom = None

    # 坐标换算：y 做垂直缩放，x 不变
    def cx(self, col):
        return LEFT + (col + 0.5) * self.col_w

    def sy(self, y):
        return TOP + (y - TOP) * self.scale

    def sh(self, h):
        return h * self.scale

    def add(self, priority, fn):
        self.ops.append((priority, fn))


def _text_box(ctx, x, y, w, h, text, size=11.0, bold=False, color=C_TEXT,
              align=PP_ALIGN.CENTER, fill=None, line=None, anchor=MSO_ANCHOR.MIDDLE):
    def draw():
        tb = ctx.slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
        tf = tb.text_frame
        tf.word_wrap = True
        tf.margin_left = Pt(3)
        tf.margin_right = Pt(3)
        tf.margin_top = Pt(1)
        tf.margin_bottom = Pt(1)
        tf.vertical_anchor = anchor
        lines = text.split("\n") if text else [""]
        for i, seg in enumerate(lines):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.alignment = align
            r = p.add_run()
            r.text = seg
            r.font.size = Pt(size)
            r.font.bold = bold
            r.font.color.rgb = color
        if fill is None:
            tb.fill.background()
        else:
            tb.fill.solid()
            tb.fill.fore_color.rgb = fill
        if line is None:
            tb.line.fill.background()
        else:
            tb.line.color.rgb = line
            tb.line.width = Pt(1)
    return draw


def _rect(ctx, x, y, w, h, fill=None, line=None, line_w=1.0, dash=None):
    def draw():
        shp = ctx.slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Inches(x), Inches(y), Inches(w), Inches(h))
        if fill is None:
            shp.fill.background()
        else:
            shp.fill.solid()
            shp.fill.fore_color.rgb = fill
        if line is None:
            shp.line.fill.background()
        else:
            shp.line.color.rgb = line
            shp.line.width = Pt(line_w)
            if dash:
                shp.line.dash_style = dash
    return draw


def _line_end(ln, end_tag, typ):
    # 只清理「本端」已有的标记，避免误删另一端刚设好的箭头
    for e in ln.findall(qn(end_tag)):
        ln.remove(e)
    if typ in (None, "none"):
        return
    if typ == "arrow":
        e = ln.makeelement(qn(end_tag), {"type": "triangle", "w": "med", "len": "med"})
    elif typ == "async":
        e = ln.makeelement(qn(end_tag), {"type": "arrow", "w": "med", "len": "med"})
    else:
        return
    ln.append(e)


def _connector(ctx, x1, y1, x2, y2, color=C_MSG, width=1.2, dashed=False,
               tail=None, head=None):
    def draw():
        conn = ctx.slide.shapes.add_connector(
            MSO_CONNECTOR.STRAIGHT, Inches(x1), Inches(y1), Inches(x2), Inches(y2))
        conn.line.color.rgb = color
        conn.line.width = Pt(width)
        if dashed:
            conn.line.dash_style = MSO_LINE_DASH_STYLE.DASH
        ln = conn.line._get_or_add_ln()
        _line_end(ln, "a:tailEnd", tail)
        _line_end(ln, "a:headEnd", head)
    return draw


def _draw_lifeline(ctx, col, top_y, bottom_y):
    x = ctx.cx(col)
    ctx.add(2, _connector(ctx, x, top_y, x, bottom_y, color=C_LIFELINE, width=1.0, dashed=True))


def _draw_participant(ctx, col, alias, label):
    x = ctx.cx(col)
    w = min(ctx.col_w * 0.72, 2.0)
    h = BOX_H
    ctx.add(7, _rect(ctx, x - w / 2, TOP, w, h, fill=C_PART_FILL, line=C_PART_LINE))
    ctx.add(8, _text_box(ctx, x - w / 2, TOP, w, h, label, size=11.5, bold=True))


def _draw_activation(ctx, col, y1, y2):
    x = ctx.cx(col)
    w = 0.12
    ctx.add(3, _rect(ctx, x - w / 2, ctx.sy(y1), w, ctx.sh(y2 - y1), fill=C_ACT_FILL, line=C_PART_LINE, line_w=0.75))


def _draw_frame(ctx, node):
    mn, mx = _collect_cols(node, ctx.porder)
    if mn is None:
        mn, mx = 0, ctx.ncols - 1
    left = ctx.cx(mn) - ctx.col_w * 0.35
    right = ctx.cx(mx) + ctx.col_w * 0.35
    top = ctx.sy(node["y"])
    bottom = ctx.sy(node["end_y"])
    # 框体（仅边框，透明填充，让泳道线透出）
    ctx.add(0, _rect(ctx, left, top, right - left, bottom - top, fill=None, line=C_FRAME))
    # 头部标签带（不透明，盖住穿过来的泳道线）
    ctx.add(6, _rect(ctx, left, top, right - left, ctx.sh(FRAME_HEADER), fill=C_BAND, line=None))
    # 头部标签带下缘分隔线
    ctx.add(6, _connector(ctx, left, top + ctx.sh(FRAME_HEADER), right, top + ctx.sh(FRAME_HEADER),
                           color=C_FRAME, width=1.0))
    label = node["branches"][0]["label"] if node["branches"] else ""
    ctx.add(8, _text_box(ctx, left + 0.06, top, min(4.0, right - left), ctx.sh(FRAME_HEADER),
                          label, size=11.0, bold=True, align=PP_ALIGN.LEFT))
    # 多分支（alt/else、par/and）之间画分隔线 + 分支标签
    if len(node["branches"]) > 1:
        for i in range(1, len(node["branches"])):
            br = node["branches"][i]
            yy = ctx.sy(br["y"])
            ctx.add(5, _connector(ctx, left, yy, right, yy, color=C_FRAME, width=1.0, dashed=True))
            ctx.add(6, _text_box(ctx, left + 0.06, yy, min(4.0, right - left), 0.22,
                                 br["label"], size=11.0, bold=True, align=PP_ALIGN.LEFT))
    # 递归绘制分支内容
    for br in node["branches"]:
        _draw_items(ctx, br["children"])


def _draw_note(ctx, node):
    col = ctx.porder[node["targets"][0]]
    y = ctx.sy(node["y"])
    h = ctx.sh(node["h"])
    if node["placement"] == "over":
        cols = [ctx.porder[t] for t in node["targets"]]
        mn, mx = min(cols), max(cols)
        left = ctx.cx(mn) + 0.08
        w = (ctx.cx(mx) - ctx.cx(mn)) - 0.16
    elif node["placement"] == "right":
        w = min(2.2, ctx.col_w * 1.1)
        left = ctx.cx(col) + 0.22
    else:  # left
        w = min(2.2, ctx.col_w * 1.1)
        left = ctx.cx(col) - 0.22 - w
    ctx.add(4, _rect(ctx, left, y, w, h, fill=C_NOTE_FILL, line=C_NOTE_LINE))
    ctx.add(5, _text_box(ctx, left + 0.05, y, w - 0.1, h, node["text"], size=10.5,
                          color=C_TEXT, align=PP_ALIGN.LEFT))


def _draw_message(ctx, node):
    s = ctx.porder[node["src"]]
    t = ctx.porder[node["dst"]]
    y = ctx.sy(node["y"])
    marker = node["marker"]
    dashed = node["dashed"]
    if s == t:
        x = ctx.cx(s)
        ctx.add(5, _connector(ctx, x + 0.04, y, x + 0.42, y, color=C_MSG, width=1.1, dashed=dashed))
        ctx.add(5, _connector(ctx, x + 0.42, y, x + 0.42, y + 0.26, color=C_MSG, width=1.1, dashed=dashed))
        ctx.add(5, _connector(ctx, x + 0.42, y + 0.26, x + 0.04, y + 0.26, color=C_MSG,
                               width=1.1, dashed=dashed, head=marker if marker in ("arrow", "async") else None))
        if node["label"]:
            ctx.add(6, _text_box(ctx, x + 0.45, y - 0.05, min(3.0, ctx.col_w), 0.3,
                                  node["label"], size=10.5, align=PP_ALIGN.LEFT))
    else:
        x1 = ctx.cx(s)
        x2 = ctx.cx(t)
        ctx.add(5, _connector(ctx, x1, y, x2, y, color=C_MSG, width=1.2,
                               dashed=dashed, tail=(marker if marker in ("arrow", "async") else None)))
        if marker == "cross":
            ctx.add(6, _text_box(ctx, x2 - 0.14, y - 0.14, 0.28, 0.28, "×", size=10.0, bold=True))
        if node["label"]:
            mid = (x1 + x2) / 2
            w = min(max(1.0, abs(x2 - x1) * 0.9), 5.5)
            ctx.add(6, _text_box(ctx, mid - w / 2, y - 0.24, w, 0.26, node["label"], size=10.5))


def _draw_items(ctx, items):
    for it in items:
        kind = it["kind"]
        if kind == "message":
            _draw_message(ctx, it)
        elif kind == "note":
            _draw_note(ctx, it)
        elif kind == "frame":
            _draw_frame(ctx, it)
        elif kind in ("activate", "deactivate"):
            pass  # 激活条由消息启发式统一处理，见 _draw_activations


def _draw_activations(ctx, root):
    """按消息顺序启发式绘制激活条。"""
    active = {}   # col -> 开始 y

    def close(col, end_y):
        if col in active:
            s = active.pop(col)
            if end_y - s > 0.12:
                _draw_activation(ctx, col, s, end_y)

    def walk(items):
        for it in items:
            if it["kind"] == "message":
                s = ctx.porder[it["src"]]
                t = ctx.porder[it["dst"]]
                y = it["y"]
                if not it["dashed"]:
                    if s != t:
                        if s not in active:
                            active[s] = y
                        if t not in active:
                            active[t] = y
                else:
                    if s != t and s in active:
                        close(s, y)
            elif it["kind"] == "frame":
                for br in it["branches"]:
                    walk(br["children"])
            elif it["kind"] == "activate":
                c = ctx.porder[it["target"]]
                if c not in active:
                    active[c] = it["y"]
            elif it["kind"] == "deactivate":
                close(ctx.porder[it["target"]], it["y"])

    walk(root)
    last_y = getattr(ctx, "_last_y", None)
    if last_y is None:
        last_y = max((ctx.lifeline_bottom or TOP) - 0.3, TOP + 0.5)
    for c in list(active.keys()):
        close(c, last_y)


def render_sequence(source, slide):
    """把 sequenceDiagram 源码绘制到给定 slide 上（原生可编辑形状）。"""
    participants, plabel, root = parse(source)
    if not participants:
        participants = ["A", "B"]
        plabel = {"A": "A", "B": "B"}
    porder = {a: i for i, a in enumerate(participants)}
    ncols = len(participants)

    end_y = layout(root, TOP + BOX_H + MSG_START_GAP, porder)
    content_bottom = end_y + 0.25

    scale = 1.0
    if content_bottom - TOP > AVAIL_H:
        scale = min(1.0, AVAIL_H / (content_bottom - TOP))
        if scale < 0.55:
            scale = 0.55

    ctx = _Ctx(slide, porder, plabel, ncols, scale)
    ctx.lifeline_bottom = content_bottom
    ctx._last_y = end_y

    # 泳道线
    lifeline_top = TOP + BOX_H
    for col in range(ncols):
        _draw_lifeline(ctx, col, ctx.sy(lifeline_top), ctx.sy(content_bottom))

    # 激活条（在箭头之下）
    _draw_activations(ctx, root)

    # 主体
    _draw_items(ctx, root)

    # 参与者头框（最上层）
    for col, alias in enumerate(participants):
        _draw_participant(ctx, col, alias, plabel.get(alias, alias))

    # 按优先级执行
    ctx.ops.sort(key=lambda x: x[0])
    for _, fn in ctx.ops:
        fn()

    return {"ok": True, "participants": ncols, "height": content_bottom - TOP}
