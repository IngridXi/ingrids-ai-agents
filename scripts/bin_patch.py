#!/usr/bin/env python3
"""二进制补丁：在指定字节偏移处写入字节（hex），自动备份原文件。

用法：python3 bin_patch.py '{"path":"/abs/file","offset":123,"bytes":"90 90"}'
bytes 支持 "9090" / "90 90" / "0x90, 0x90" 等写法。
"""
import sys, json, os, shutil, time

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"ok": False, "error": "缺少参数"})); return
    try:
        req = json.loads(sys.argv[1])
    except Exception as e:
        print(json.dumps({"ok": False, "error": "参数不是合法 JSON: %s" % e})); return
    path = req.get("path", "")
    offset = req.get("offset", 0)
    bytes_hex = req.get("bytes", "")
    if not path or not os.path.isfile(path):
        print(json.dumps({"ok": False, "error": "文件不存在"})); return
    hx = str(bytes_hex).strip().replace(" ", "").replace("0x", "").replace(",", "").replace("\n", "")
    if not hx:
        print(json.dumps({"ok": False, "error": "bytes 为空"})); return
    try:
        data = bytes.fromhex(hx)
    except Exception as e:
        print(json.dumps({"ok": False, "error": "bytes 不是合法 hex: %s" % e})); return
    try:
        off = int(offset)
    except Exception:
        print(json.dumps({"ok": False, "error": "offset 不是整数"})); return
    with open(path, "rb") as f:
        orig = f.read()
    if off < 0 or off + len(data) > len(orig):
        print(json.dumps({"ok": False, "error": "offset 越界：文件 %d 字节，要写入 %d~%d" % (len(orig), off, off + len(data))})); return
    bak = "%s.cu-bak-%d" % (path, int(time.time() * 1000))
    shutil.copyfile(path, bak)
    before = orig[off:off + len(data)]
    patched = orig[:off] + data + orig[off + len(data):]
    with open(path, "wb") as f:
        f.write(patched)
    print(json.dumps({
        "ok": True, "path": path, "offset": off,
        "before": before.hex(" "), "after": data.hex(" "),
        "backup": bak, "fileSize": len(orig),
    }))

if __name__ == "__main__":
    main()
