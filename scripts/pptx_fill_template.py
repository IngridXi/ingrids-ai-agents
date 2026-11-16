#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
pptx_fill_template.py — 把内容「填进」已有 .pptx 模板，1:1 套用母版 / 背景 / 主题 / SmartArt。

借鉴：python-pptx 官方「打开→改文本→保存」模式 + shigeyf/ai-agent-tools 的占位符填充
     + RobbyBobby77/agent-skills 的「不重建品牌模板，保留母版/主题/图片」原则。

用法:
  python3 pptx_fill_template.py '<json>'

  action=inspect（了解模板结构，套模板前必先 inspect）:
    {"action":"inspect", "template":"/path/template.pptx"}
    → 返回每页形状名 + 当前文本

  action=fill（默认，填内容）:
    {
      "action":"fill",
      "template":"/path/template.pptx",
      "output":"/path/output.pptx",          # 可选，默认 <template>_filled_<时间戳>.pptx
      "replacements":{"{{Title}}":"新标题","旧文字":"新文字"},   # 全局文本替换（跨 run 安全）
      "byName":[{"name":"Title 1","text":"新标题"}, ...]          # 按形状名定位填空
    }

要点:
  - 不覆盖模板：默认另存为新文件；指定 output 时才写该路径。
  - 保留母版 / 版式 / 主题色 / 背景图 / SmartArt（只改文本，不动结构）。
  - 占位符跨 run 拆分（PowerPoint 常把 {{T}} 拆成多段）会被安全合并替换。
  - 文本替换覆盖：普通文本框 + 表格单元格 + 图形/占位符内的文字。

输出: 单行 JSON，{"ok": true/false, ...}
"""
import sys
import os
import json
import time
import shutil


def _ensure_user_site():
    """兜底：App 从 Finder/桌面启动时 HOME 可能异常，导致用户级 site-packages 不在 sys.path。
    显式把用户级 site-packages 目录插入 sys.path，保证 python-pptx 可导入。"""
    try:
        import site
        usp = site.getusersitepackages()
        if usp and os.path.isdir(usp) and usp not in sys.path:
            sys.path.insert(0, usp)
    except Exception:
        pass
    # 用 pwd 拿真实 home（不依赖 HOME 环境变量，彻底免疫 HOME 异常）
    home = None
    try:
        import pwd
        home = pwd.getpwuid(os.getuid()).pw_dir
    except Exception:
        home = None
    if not home:
        home = os.path.expanduser('~')
    try:
        for v in ('3.9', '3.10', '3.11', '3.12', '3.13'):
            for p in (os.path.join(home, 'Library', 'Python', v, 'lib', 'python', 'site-packages'),
                      os.path.join(home, '.local', 'lib', 'python' + v, 'site-packages')):
                if os.path.isdir(p) and p not in sys.path:
                    sys.path.insert(0, p)
    except Exception:
        pass


_ensure_user_site()


def _safe_replace_paragraph(paragraph, replacements):
    """在单个 paragraph 内做跨 run 安全的替换：拼接全部 run → 替换 → 写回首个 run。"""
    runs = paragraph.runs
    if not runs:
        return False
    full = ''.join(r.text for r in runs)
    if not full:
        return False
    new = full
    for k, v in replacements.items():
        if k and k in new:
            new = new.replace(k, v)
    if new == full:
        return False
    # 保留首个 run 的格式，文本整体写回，其余 run 清空
    runs[0].text = new
    for r in runs[1:]:
        r.text = ''
    return True


def _fill_textframe(tf, replacements):
    changed = 0
    for p in tf.paragraphs:
        if _safe_replace_paragraph(p, replacements):
            changed += 1
    return changed


def _walk_text_frames(shapes, replacements, by_name_map):
    """遍历形状（含表格单元格、分组内形状），做文本替换 + 按名填空。返回 {replaced, byName}。"""
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    replaced = 0
    by_name_done = 0

    def handle_shape(shape):
        nonlocal replaced, by_name_done
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            for sub in shape.shapes:
                handle_shape(sub)
            return
        if shape.shape_type == MSO_SHAPE_TYPE.TABLE and shape.has_table:
            for row in shape.table.rows:
                for cell in row.cells:
                    replaced += _fill_textframe(cell.text_frame, replacements)
            return
        if not shape.has_text_frame:
            return
        # 1) 按形状名定位填空（优先级高于全局替换）
        if shape.name in by_name_map:
            spec = by_name_map[shape.name]
            text = spec.get('text')
            if text is not None:
                tf = shape.text_frame
                if tf.paragraphs and tf.paragraphs[0].runs:
                    tf.paragraphs[0].runs[0].text = str(text)
                    for r in tf.paragraphs[0].runs[1:]:
                        r.text = ''
                elif tf.paragraphs:
                    tf.paragraphs[0].text = str(text)
                else:
                    tf.text = str(text)
                by_name_done += 1
                return
        # 2) 全局文本替换
        replaced += _fill_textframe(shape.text_frame, replacements)

    for sh in shapes:
        handle_shape(sh)
    return {'replaced': replaced, 'byName': by_name_done}


def _inspect(prs):
    from pptx.enum.shapes import MSO_SHAPE_TYPE

    pages = []

    def shape_desc(shape):
        if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
            subs = [shape_desc(s) for s in shape.shapes]
            return {'name': shape.name, 'type': 'group', 'children': subs}
        if shape.shape_type == MSO_SHAPE_TYPE.TABLE and shape.has_table:
            return {'name': shape.name, 'type': 'table', 'rows': len(shape.table.rows)}
        if shape.has_text_frame:
            txt = shape.text_frame.text.strip()
            if txt:
                return {'name': shape.name, 'type': 'text', 'text': txt[:120]}
        # 图片/图形等
        return {'name': shape.name, 'type': str(shape.shape_type)}

    for i, slide in enumerate(prs.slides, 1):
        shapes = [shape_desc(s) for s in slide.shapes]
        pages.append({'slide': i, 'layout': slide.slide_layout.name if slide.slide_layout else '', 'shapes': shapes})
    return pages


def main():
    try:
        args = json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')
    except Exception:
        print(json.dumps({'ok': False, 'error': '参数解析失败'}))
        return

    try:
        from pptx import Presentation
    except ImportError:
        print(json.dumps({
            'ok': False,
            'error': '套模板依赖 python-pptx 未安装（本机环境异常）。请在终端运行以下命令后重试：%s -m pip install --user python-pptx' % sys.executable,
            'python': sys.executable,
            'pythonVersion': sys.version.split()[0],
            'fix': '%s -m pip install --user python-pptx' % sys.executable,
        }, ensure_ascii=False))
        return

    action = str(args.get('action', 'fill')).strip().lower()
    template = str(args.get('template', '')).strip()
    if not template or not os.path.exists(template):
        print(json.dumps({'ok': False, 'error': '模板不存在：' + template}))
        return
    if not template.lower().endswith('.pptx'):
        print(json.dumps({'ok': False, 'error': '仅支持 .pptx 模板（旧 .ppt 请先用 PowerPoint 另存为 .pptx）'}))
        return

    try:
        prs = Presentation(template)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': '无法打开模板：' + str(e)}))
        return

    if action == 'inspect':
        try:
            print(json.dumps({'ok': True, 'slides': len(list(prs.slides)), 'pages': _inspect(prs)}, ensure_ascii=False))
        except Exception as e:
            print(json.dumps({'ok': False, 'error': 'inspect 失败：' + str(e)}))
        return

    # action=fill（默认）
    replacements = args.get('replacements') or {}
    by_name = args.get('byName') or []
    if not isinstance(replacements, dict):
        replacements = {}
    if not isinstance(by_name, list):
        by_name = []
    # 键/值统一转 str
    replacements = {str(k): str(v) for k, v in replacements.items() if str(k)}
    by_name_map = {}
    for spec in by_name:
        if isinstance(spec, dict) and spec.get('name'):
            by_name_map[str(spec['name'])] = spec

    if not replacements and not by_name_map:
        print(json.dumps({'ok': False, 'error': 'replacements 和 byName 都为空，没有要填的内容'}))
        return

    changed = 0
    for slide in prs.slides:
        r = _walk_text_frames(slide.shapes, replacements, by_name_map)
        changed += r['replaced'] + r['byName']

    # 输出路径：默认另存新文件，绝不覆盖模板
    output = str(args.get('output', '')).strip()
    if not output:
        base = os.path.splitext(template)[0]
        output = base + '_filled_' + str(int(time.time())) + '.pptx'

    # 备份（仅当 output 已存在时）
    bak = None
    if os.path.exists(output):
        bak = output + '.cu-bak-' + str(int(time.time()))
        try:
            shutil.copy2(output, bak)
        except Exception:
            bak = None

    try:
        prs.save(output)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': '保存失败：' + str(e)}))
        return

    print(json.dumps({'ok': True, 'output': output, 'replaced': changed, 'slides': len(list(prs.slides)), 'backup': bak}, ensure_ascii=False))


if __name__ == '__main__':
    main()
