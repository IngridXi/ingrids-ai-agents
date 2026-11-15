#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
doc_edit.py — 在 .docx 中做「查找替换」，让研究助手能直接修改 Word 文件。

用法:  python3 doc_edit.py '<json>'
  json = {"path": "...", "old": "...", "new": "..."}

行为:
  - 打开 docx，遍历正文段落 + 表格单元格内的段落；
  - 统计 old 出现次数：0 次 → 报错提示先读原文核对；>1 次 → 报错要求更长的唯一上下文；
  - 恰好 1 次 → 整段替换（保留段落样式与第一个 run 的字体格式），保存；
  - 保存前自动备份原文件为 <path>.cu-bak-<时间戳>。

输出: 单行 JSON，{"ok": true/false, ...}
"""
import sys
import os
import json
import time
import shutil


def _set_paragraph_text(p, new_text):
    """把段落文本整体替换为新文本，尽量保留样式与首个 run 的字体格式。"""
    runs = p.runs
    if runs:
        runs[0].text = new_text
        for r in runs[1:]:
            r.text = ''
    else:
        p.add_run(new_text)


def main():
    try:
        args = json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')
    except Exception:
        print(json.dumps({'ok': False, 'error': '参数解析失败'}))
        return

    path = str(args.get('path', '')).strip()
    old = str(args.get('old', '')).strip('\n')
    new = str(args.get('new', ''))

    if not path or not old:
        print(json.dumps({'ok': False, 'error': 'path / old 不能为空'}))
        return
    if not os.path.exists(path):
        print(json.dumps({'ok': False, 'error': '文件不存在：' + path}))
        return

    try:
        from docx import Document
    except ImportError:
        print(json.dumps({'ok': False, 'error': '缺少 python-docx，无法编辑 Word 文件'}))
        return

    # 备份
    bak = path + '.cu-bak-' + str(int(time.time()))
    try:
        shutil.copy2(path, bak)
    except Exception:
        bak = None

    try:
        doc = Document(path)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': '无法打开 docx：' + str(e)}))
        return

    # 收集所有段落（正文 + 表格单元格），用 id 去重避免合并单元格重复计数
    paras = []
    seen = set()

    def add(p):
        if id(p) not in seen:
            seen.add(id(p))
            paras.append(p)

    for p in doc.paragraphs:
        add(p)
    for t in doc.tables:
        for row in t.rows:
            for cell in row.cells:
                for p in cell.paragraphs:
                    add(p)

    count = sum(p.text.count(old) for p in paras)
    if count == 0:
        print(json.dumps({'ok': False, 'error': '未找到要替换的内容，请先用 fs_read 读原文核对原文是否精确一致'}))
        return
    if count > 1:
        print(json.dumps({'ok': False, 'error': '要替换的内容出现 ' + str(count) + ' 次，请给出更长的唯一上下文'}))
        return

    for p in paras:
        if old in p.text:
            _set_paragraph_text(p, p.text.replace(old, new))
            break

    try:
        doc.save(path)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': '保存失败：' + str(e)}))
        return

    print(json.dumps({'ok': True, 'path': path, 'replaced': 1, 'backup': bak}))


if __name__ == '__main__':
    main()
