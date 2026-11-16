#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
start_chrome.py —— 以远程调试（CDP）模式启动浏览器。

要点：
1. 独立 --user-data-dir 是关键：与日常使用的浏览器完全隔离，既不会串用登录态，
   也不会出现「新进程把 URL 丢给已有窗口后立刻退出」导致启动失败。
2. 若该端口的 CDP 已在响应，直接复用，不重复启动。
3. 持久 profile 保留登录态（需登录的站点用这个）；临时 profile 重启即清空（一次性抓取用这个）。

用法：
    python scripts/start_chrome.py                 默认：持久 profile，端口 9222
    python scripts/start_chrome.py --temp           临时 profile（不保留登录态）
    python scripts/start_chrome.py --headless       无头模式（不显示窗口）
    python scripts/start_chrome.py --port 9333      换端口
    python scripts/start_chrome.py --profile "<目录>"  指定 profile 目录
    python scripts/start_chrome.py --proxy http://<代理主机>:<端口>   仅在确需代理时使用

退出码：0 就绪；1 启动失败。
"""

import argparse
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import CDPClient, default_profile_dir, load_config, pid_path, temp_profile_dir  # noqa: E402
from setup_chrome import detect_all  # noqa: E402


def _reconfigure():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def resolve_browser(browser_path=None):
    if browser_path:
        p = Path(browser_path)
        if not p.exists():
            raise SystemExit("错误：指定的浏览器路径不存在：%s" % p)
        return str(p)
    cfg = load_config()
    saved = cfg.get("browser_path")
    if saved and Path(saved).exists():
        return saved
    found = detect_all()
    if not found:
        raise SystemExit(
            "未找到可用浏览器。请先运行：python scripts/setup_chrome.py "
            "（或加 --install 自动安装，或 --use-edge 使用系统自带 Edge）"
        )
    preferred = [f for f in found if "edge" not in f[1].lower()]
    return (preferred or found)[0][0]


def wait_ready(port, host, seconds=30):
    client = CDPClient(host=host, port=port, timeout=5)
    deadline = time.time() + seconds
    while time.time() < deadline:
        if client.is_alive():
            return client.version()
        time.sleep(0.5)
    return None


def main(argv=None):
    _reconfigure()
    parser = argparse.ArgumentParser(prog="start_chrome.py", description="以 CDP 调试模式启动浏览器")
    parser.add_argument("--port", type=int, default=9222, help="调试端口，默认 9222")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认 127.0.0.1")
    parser.add_argument("--temp", action="store_true", help="使用临时 profile（不保留登录态）")
    parser.add_argument("--profile", help="自定义 profile 目录")
    parser.add_argument("--headless", action="store_true", help="无头模式，不显示浏览器窗口")
    parser.add_argument("--proxy", help="可选：HTTP 代理地址，形如 http://<代理主机>:<端口>")
    parser.add_argument("--path", "--browser", dest="browser", help="浏览器可执行文件路径")
    parser.add_argument("--wait", type=float, default=30.0, help="等待就绪的秒数，默认 30")
    parser.add_argument("--no-start", action="store_true", help="只做检查，若未运行则不启动")
    args = parser.parse_args(argv)

    client = CDPClient(host=args.host, port=args.port, timeout=5)
    if client.is_alive():
        info = client.version()
        print("ALREADY_RUNNING：CDP 已在 %s:%d 响应" % (args.host, args.port))
        print("浏览器：%s" % info.get("Browser"))
        print("无需重复启动。如需换 profile，请先运行 python scripts/stop_chrome.py --port %d 再启动。" % args.port)
        return 0

    if args.no_start:
        print("NOT_RUNNING：%s:%d 无响应（--no-start 已指定，未启动）" % (args.host, args.port))
        return 1

    exe = resolve_browser(args.browser)
    if args.profile:
        profile = Path(args.profile)
    elif args.temp:
        profile = temp_profile_dir()
    else:
        profile = default_profile_dir()
    profile.mkdir(parents=True, exist_ok=True)

    cmd = [
        exe,
        "--remote-debugging-port=%d" % args.port,
        "--remote-allow-origins=*",
        "--user-data-dir=%s" % profile,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-sync",
        "--disable-default-apps",
        "--disable-popup-blocking",
    ]
    if args.headless:
        cmd.append("--headless=new")
    if args.proxy:
        # 仅在用户显式提供时添加。注意：若代理服务未运行，页面会报 ERR_PROXY_CONNECTION_FAILED，
        # 届时去掉本参数重新启动即可。
        cmd.append("--proxy-server=%s" % args.proxy)
    cmd.append("about:blank")

    print("启动命令：%s" % " ".join('"%s"' % c if " " in c else c for c in cmd))
    print("profile：%s（%s）" % (profile, "临时，重启即清空" if args.temp else "持久，保留登录态"))

    creation = 0
    if sys.platform.startswith("win"):
        creation = getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                stdin=subprocess.DEVNULL, creationflags=creation, close_fds=True)
    except OSError as exc:
        print("错误：启动浏览器失败：%s" % exc)
        return 1

    pid_path(args.port).write_text(str(proc.pid), encoding="utf-8")
    print("进程 PID：%d" % proc.pid)

    info = wait_ready(args.port, args.host, args.wait)
    if not info:
        print("错误：%d 秒内 CDP 未就绪。" % args.wait)
        print("排查：1) 是否已有同名 profile 的浏览器在运行（先 stop 再 start）；"
              "2) 端口 %d 是否被占用（换 --port）；3) 去掉 --headless 观察窗口是否弹出。" % args.port)
        return 1

    print("READY")
    print("浏览器：%s" % info.get("Browser"))
    print("调试地址：http://%s:%d" % (args.host, args.port))
    print("下一步：python scripts/doctor.py --port %d  或 python scripts/cdp.py --port %d status" % (args.port, args.port))
    return 0


if __name__ == "__main__":
    sys.exit(main())
