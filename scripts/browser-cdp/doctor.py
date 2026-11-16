#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
doctor.py —— 一键体检：把「浏览器在不在、CDP 通不通、profile 是哪种、页面能不能拿到」一次查完。

遇到任何浏览器自动化问题，先跑这个脚本，按输出的「建议动作」逐条处理。

用法：
    python scripts/doctor.py
    python scripts/doctor.py --port 9333

退出码：0 全部正常；1 存在问题（输出中已给出修复建议）。
"""

import argparse
import socket
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import CDPClient, default_profile_dir, load_config, pid_path  # noqa: E402


def _reconfigure():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def port_in_use(host, port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        return s.connect_ex((host, port)) == 0


def main(argv=None):
    _reconfigure()
    parser = argparse.ArgumentParser(prog="doctor.py", description="浏览器自动化环境体检")
    parser.add_argument("--port", type=int, default=9222)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args(argv)

    problems = []
    lines = []

    # 1. 浏览器可执行文件
    cfg = load_config()
    saved = cfg.get("browser_path")
    if saved and Path(saved).exists():
        lines.append("[OK]   浏览器可执行文件：%s（%s）" % (saved, cfg.get("browser_name", "未记录")))
    else:
        lines.append("[FAIL] 未记录可用的浏览器路径")
        problems.append("运行：python scripts/setup_chrome.py")

    # 2. 端口与 CDP
    client = CDPClient(host=args.host, port=args.port, timeout=5)
    if port_in_use(args.host, args.port):
        lines.append("[OK]   端口 %d 已被占用（有程序在监听）" % args.port)
        if client.is_alive():
            info = client.version()
            lines.append("[OK]   CDP 可达：%s" % info.get("Browser"))
            pages = client.list_pages()
            lines.append("[OK]   标签页数：%d" % len(pages))
            for pg in pages[:5]:
                lines.append("         - %s | %s" % (pg.get("title", "")[:40], pg.get("url", "")[:70]))
            # 3. 页面连通性：试着读一次标题
            if pages:
                try:
                    client.connect_page(pages[0]["id"])
                    title = client.page_title()
                    if title:
                        lines.append("[OK]   可读页面标题：%s" % title)
                    else:
                        lines.append("[INFO] 页面标题为空（多为 about:blank 空白页，属正常）")
                    client.close()
                except Exception as exc:
                    lines.append("[WARN] 页面读取失败：%s" % exc)
                    problems.append("标签页可能正在加载或已崩溃，重启浏览器：python scripts/stop_chrome.py 后 start_chrome.py")
        else:
            lines.append("[FAIL] 端口 %d 有程序监听，但不是 CDP（返回内容不是调试接口）" % args.port)
            problems.append("端口被其它程序占用，换一个端口：python scripts/start_chrome.py --port 9333")
    else:
        lines.append("[FAIL] 端口 %d 无监听，浏览器未以调试模式运行" % args.port)
        problems.append("启动：python scripts/start_chrome.py --port %d" % args.port)

    # 4. profile 与登录态
    prof = default_profile_dir()
    if prof.exists():
        try:
            count = sum(1 for _ in prof.rglob("*") if _.is_file())
            lines.append("[OK]   持久 profile：%s（%d 个文件，登录态会保留）" % (prof, count))
        except OSError:
            lines.append("[OK]   持久 profile：%s" % prof)
    else:
        lines.append("[INFO] 尚无持久 profile，首次运行 start_chrome.py 会自动创建")

    pid_file = pid_path(args.port)
    if pid_file.exists():
        lines.append("[INFO] 上次记录的 PID：%s" % pid_file.read_text(encoding="utf-8").strip())

    print("=" * 60)
    print("浏览器自动化环境体检")
    print("=" * 60)
    for line in lines:
        print(line)
    print("-" * 60)
    if problems:
        print("发现 %d 个问题，建议按序处理：" % len(problems))
        for i, p in enumerate(problems, 1):
            print("  %d. %s" % (i, p))
        return 1
    print("全部正常，可以开始自动化操作。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
