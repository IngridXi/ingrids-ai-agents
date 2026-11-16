#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
image_tools.py — 本地图片处理（抠图去背景 + 缩放 + 格式转换 + 信息查询）。

抠图用 rembg（u2net 模型，本地推理、图片不出本机）；缩放/转换用 Pillow。

用法:  python3 image_tools.py '<json>'

  {"action":"remove_bg", "input":"/path/in.png",  "output":"/path/out.png"}   # 抠图，输出透明 PNG
  {"action":"resize",    "input":"/path/in.png",  "output":"/path/out.png", "width":800, "height":600}  # 任一可省略=保持比例
  {"action":"convert",   "input":"/path/in.png",  "output":"/path/out.jpg", "quality":85}
  {"action":"info",      "input":"/path/in.png"}                              # 尺寸/格式/模式/大小

输出: 单行 JSON，{"ok": true/false, ...}
"""
import sys
import os
import json


def _load_image(path):
    from PIL import Image
    return Image.open(path)


def _save(img, output):
    from PIL import Image
    ext = os.path.splitext(output)[1].lower()
    # 透明图存 jpg 会报错，自动转 RGB；png 保留 alpha
    if ext in ('.jpg', '.jpeg'):
        if img.mode in ('RGBA', 'P', 'LA'):
            img = img.convert('RGB')
        img.save(output, quality=90)
    elif ext == '.webp':
        img.save(output, 'WEBP')
    else:
        img.save(output)
    return output


def do_remove_bg(args):
    try:
        from rembg import remove, new_session
        from PIL import Image
    except ImportError as e:
        return {'ok': False, 'error': '缺少 rembg / Pillow，请先运行: python3 -m pip install --user rembg Pillow（首次抠图会自动下载 u2net 模型，约 176MB）'}
    inp = args['input']
    out = args.get('output') or (os.path.splitext(inp)[0] + '_nobg.png')
    try:
        img = Image.open(inp)
        # 用 u2net 会话；模型首次会自动下载到 ~/.u2net/
        session = new_session('u2net')
        result = remove(img, session=session, alpha_matting=(args.get('alpha_matting') is True))
        _save(result, out)
        return {'ok': True, 'output': out, 'action': 'remove_bg'}
    except Exception as e:
        return {'ok': False, 'error': '抠图失败：' + str(e)}


def do_resize(args):
    from PIL import Image
    inp = args['input']
    out = args.get('output') or (os.path.splitext(inp)[0] + '_resized' + os.path.splitext(inp)[1])
    w = args.get('width')
    h = args.get('height')
    if not w and not h:
        return {'ok': False, 'error': 'resize 需指定 width 或 height'}
    try:
        img = Image.open(inp)
        ow, oh = img.size
        if w and h:
            nw, nh = int(w), int(h)
        elif w:
            nw = int(w)
            nh = int(oh * nw / ow)
        else:
            nh = int(h)
            nw = int(ow * nh / oh)
        img = img.resize((nw, nh), Image.LANCZOS)
        _save(img, out)
        return {'ok': True, 'output': out, 'action': 'resize', 'size': [nw, nh]}
    except Exception as e:
        return {'ok': False, 'error': '缩放失败：' + str(e)}


def do_convert(args):
    from PIL import Image
    inp = args['input']
    out = args.get('output')
    if not out:
        return {'ok': False, 'error': 'convert 需指定 output（含目标扩展名，如 .jpg/.png/.webp）'}
    try:
        img = Image.open(inp)
        _save(img, out)
        return {'ok': True, 'output': out, 'action': 'convert'}
    except Exception as e:
        return {'ok': False, 'error': '转换失败：' + str(e)}


def do_info(args):
    from PIL import Image
    inp = args['input']
    try:
        img = Image.open(inp)
        st = os.stat(inp)
        return {'ok': True, 'path': inp, 'format': img.format, 'mode': img.mode,
                'width': img.width, 'height': img.height, 'bytes': st.st_size}
    except Exception as e:
        return {'ok': False, 'error': '读取失败：' + str(e)}


def main():
    try:
        args = json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')
    except Exception:
        print(json.dumps({'ok': False, 'error': '参数解析失败'}))
        return

    action = str(args.get('action', '')).strip().lower()
    inp = str(args.get('input', '')).strip()
    if not inp or not os.path.exists(inp):
        print(json.dumps({'ok': False, 'error': '输入图片不存在：' + inp}))
        return

    if action == 'remove_bg':
        res = do_remove_bg(args)
    elif action == 'resize':
        res = do_resize(args)
    elif action == 'convert':
        res = do_convert(args)
    elif action == 'info':
        res = do_info(args)
    else:
        res = {'ok': False, 'error': '未知 action：' + action + '（支持 remove_bg / resize / convert / info）'}

    print(json.dumps(res, ensure_ascii=False))


if __name__ == '__main__':
    main()
