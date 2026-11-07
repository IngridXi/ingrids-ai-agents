"""会议总结 PPT 生成：把结构化纪要走 python-pptx 输出 .pptx。

风格与会议纪要官页面一致：深藏青 + 香槟金，16:9。
"""
from __future__ import annotations

import re
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.util import Inches, Pt

# 配色（深藏青 + 香槟金）
NAVY = RGBColor(0x1F, 0x3A, 0x5F)
TEAL = RGBColor(0x2A, 0x74, 0x6C)
GOLD = RGBColor(0xC9, 0xA9, 0x6A)
INK = RGBColor(0x22, 0x2A, 0x35)
MUTED = RGBColor(0x6B, 0x72, 0x80)
PAPER = RGBColor(0xFB, 0xF8, 0xF1)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

FONT = "PingFang SC"


def _parse_sections(md: str) -> dict[str, list[str]]:
    """把纪要 Markdown 拆成 {小节名: [条目列表]}。"""
    sections: dict[str, list[str]] = {}
    cur = None
    for raw in (md or "").splitlines():
        line = raw.strip()
        if not line or line.startswith(">"):
            continue
        m = re.match(r"^#{1,3}\s*(.+)$", line)
        if m:
            cur = m.group(1).strip()
            sections.setdefault(cur, [])
            continue
        # 列表项或普通文本
        line = re.sub(r"^[-*•]\s*", "", line)
        line = re.sub(r"^\d+[.、)]\s*", "", line)
        if line and (cur is not None):
            sections.setdefault(cur, []).append(line)
    return sections


def _add_text(slide, x, y, w, h, text, size=18, color=INK, bold=False, align=PP_ALIGN.LEFT, font=FONT):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame
    tf.word_wrap = True
    tf.margin_left = 0
    tf.margin_right = 0
    tf.margin_top = 0
    tf.margin_bottom = 0
    p = tf.paragraphs[0]
    p.alignment = align
    run = p.add_run()
    run.text = text
    run.font.size = Pt(size)
    run.font.bold = bold
    run.font.color.rgb = color
    run.font.name = font
    return box


def _add_bullets(slide, x, y, w, h, items, size=16, color=INK, font=FONT):
    box = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = box.text_frame
    tf.word_wrap = True
    first = True
    for it in items:
        p = tf.paragraphs[0] if first else tf.add_paragraph()
        first = False
        p.space_after = Pt(8)
        run = p.add_run()
        run.text = "•  " + it
        run.font.size = Pt(size)
        run.font.color.rgb = color
        run.font.name = font
    return box


def _cover(prs, title: str, subtitle: str):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    # 深色背景
    bg = slide.shapes.add_shape(1, 0, 0, prs.slide_width, prs.slide_height)
    bg.fill.solid()
    bg.fill.fore_color.rgb = NAVY
    bg.line.fill.background()
    # 金色装饰线
    bar = slide.shapes.add_shape(1, Inches(0.9), Inches(3.0), Inches(0.06), Inches(0.06))
    bar.fill.solid(); bar.fill.fore_color.rgb = GOLD; bar.line.fill.background()
    _add_text(slide, 0.9, 1.3, 11.5, 1.2, title, size=40, color=WHITE, bold=True)
    _add_text(slide, 0.9, 2.6, 11.5, 1.0, subtitle, size=18, color=GOLD)
    _add_text(slide, 0.9, 6.6, 11.5, 0.5, "会议纪要 · 由 AI 生成，需人工复核", size=12, color=MUTED)


def _section_slide(prs, title: str, items: list[str], accent=TEAL):
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    bg = slide.shapes.add_shape(1, 0, 0, prs.slide_width, prs.slide_height)
    bg.fill.solid(); bg.fill.fore_color.rgb = PAPER; bg.line.fill.background()
    # 顶部色条 + 标题
    bar = slide.shapes.add_shape(1, 0, 0, prs.slide_width, Inches(1.0))
    bar.fill.solid(); bar.fill.fore_color.rgb = accent; bar.line.fill.background()
    _add_text(slide, 0.6, 0.18, 12.0, 0.7, title, size=28, color=WHITE, bold=True)
    if items:
        _add_bullets(slide, 0.7, 1.4, 12.0, 5.6, items, size=17)
    else:
        _add_text(slide, 0.7, 1.5, 12.0, 0.5, "（暂无内容）", size=16, color=MUTED)


def minutes_to_ppt(minutes_md: str, output_path, title: str = "会议纪要") -> str:
    """把纪要 markdown 转成 .pptx，返回输出路径。"""
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)

    sections = _parse_sections(minutes_md)
    subject = " ".join(sections.get("会议主题", [title]))
    attendees = "、".join(sections.get("参会人", []))

    _cover(prs, subject or title, ("参会人：" + attendees) if attendees else "会议纪要")

    order = [
        ("摘要", sections.get("摘要", []), TEAL),
        ("讨论要点", sections.get("讨论要点", []), NAVY),
        ("决定事项", sections.get("决定事项", []), GOLD),
        ("待办事项", sections.get("待办事项", []), TEAL),
    ]
    for name, items, accent in order:
        _section_slide(prs, name, items, accent)

    # 兜底：若纪要里没有这些小节（异常情况），也至少保证有内容页
    if not any(items for _, items, _ in order):
        _section_slide(prs, "纪要", sections.get("摘要", []) or list(sections.values())[0] if sections else [])

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(out))
    return str(out)
