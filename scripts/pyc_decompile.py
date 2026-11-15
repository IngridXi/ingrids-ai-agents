#!/usr/bin/env python3
"""反编译 .pyc：提取 code object，用 dis 反汇编 + 提取常量，尝试 decompyle3/uncompyle6 反编译源码。

用法：python3 pyc_decompile.py /abs/path/file.pyc
输出 JSON：{ok, fileSize, pythonVersion, names, constants, disassembly, decompiledSource?, decompiler?}
"""
import sys, json, os, dis, marshal, types

def load_code(data):
    """从 .pyc 二进制里尝试多个偏移 marshal 出 code object（兼容不同 Python 版本 header）。"""
    cands = []
    n = len(data)
    # header 通常 4~16 字节，尝试前 32 字节内的每个偏移
    for off in range(4, min(32, n)):
        try:
            obj = marshal.loads(data[off:])
            if isinstance(obj, types.CodeType):
                cands.append((off, obj))
        except Exception:
            continue
    return cands

def main():
    path = sys.argv[1] if len(sys.argv) > 1 else ""
    if not path or not os.path.isfile(path):
        print(json.dumps({"ok": False, "error": "文件不存在"})); return
    try:
        with open(path, "rb") as f:
            data = f.read()
    except Exception as e:
        print(json.dumps({"ok": False, "error": "读取失败: %s" % e})); return
    cands = load_code(data)
    if not cands:
        print(json.dumps({"ok": False, "error": "未解析到 code object（可能不是 .pyc，或 Python 版本不匹配）"})); return
    off, code = cands[0]
    info = {
        "ok": True,
        "path": path,
        "fileSize": len(data),
        "pythonVersion": ".".join(map(str, sys.version_info[:3])),
        "names": list(code.co_names),
        "constants": [repr(c) for c in code.co_consts],
        "disassembly": "",
    }
    try:
        info["disassembly"] = dis.Bytecode(code).dis()
    except Exception as e:
        info["disassembly"] = "反汇编失败: %s" % e
    # 尝试反编译源码
    source = None
    used = None
    for mod in ("decompyle3", "uncompyle6"):
        try:
            m = __import__(mod)
            try:
                source = m.decompile(3, code, None, None) if mod == "uncompyle6" else m.decompile(3, code)
            except TypeError:
                source = m.decompile(3, code)
            if source:
                used = mod
                break
        except Exception:
            continue
    info["decompiler"] = used
    info["decompiledSource"] = source
    if not source:
        info["note"] = "未安装 decompyle3/uncompyle6，仅提供反汇编 + 常量。可 pip3 install decompyle3 后重试。"
    info["disassembly"] = info["disassembly"][:120000]
    if info.get("decompiledSource"):
        info["decompiledSource"] = str(info["decompiledSource"])[:120000]
    print(json.dumps(info, ensure_ascii=False))

if __name__ == "__main__":
    main()
