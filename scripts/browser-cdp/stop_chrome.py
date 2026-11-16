#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
stop_chrome.py —— 停止以 CDP 调试模式运行的浏览器。

优先通过 CDP 的 Browser.close 优雅关闭（跨平台、最干净）；
CDP 不可达时回退到按 PID 终止。无论哪种方式，持久 profile 中的登录态都会保留。

用法：
    python scripts/stop_chrome.py                关闭默认端口 9222 的调试浏览器
    python scripts/stop_chrome.py --port 9333    关闭指定端口
    python scripts/stop_chrome.py --force        跳过 CDP，直接按 PID 结束进程

退出码：0 成功；1 失败。
"""

import argparse
import os
import signal
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import CDPClient, default_profile_dir, pid_path  # noqa: E402


def _reconfigure():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def find_cdp_pids(port):
    """按命令行精确匹配调试端口，找出属于本 skill 的浏览器进程。

    不用 PID 文件直接杀进程：Chrome 启动器进程会立刻退出，记录到的 PID 可能已被系统分配给别的进程，
    直接 kill 有误杀风险。按命令行匹配 remote-debugging-port=<port> 最安全，
    也不会影响用户日常使用的浏览器（它没有这个参数）。
    """
    pids = []
    try:
        if os.name == "nt":
            ps = (
                "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe' or Name='msedge.exe'\" | "
                "Where-Object { $_.CommandLine -like '*-remote-debugging-port=%d*' } | "
                "ForEach-Object { $_.ProcessId }" % port
            )
            out = subprocess.run(
                ["powershell", "-NoProfile", "-Command", ps],
                capture_output=True, text=True, timeout=30,
            )
            for line in out.stdout.splitlines():
                line = line.strip()
                if line.isdigit():
                    pids.append(int(line))
        else:
            out = subprocess.run(["ps", "-eo", "pid,args"], capture_output=True, text=True, timeout=30)
            for line in out.stdout.splitlines():
                parts = line.strip().split(None, 1)
                if len(parts) == 2 and parts[0].isdigit():
                    if ("--remote-debugging-port=%d" % port) in parts[1]:
                        pids.append(int(parts[0]))
    except (OSError, subprocess.SubprocessError):
        pass
    return pids


def kill_by_pid(pid):
    if os.name == "nt":
        rc = subprocess.call(["taskkill", "/PID", str(pid), "/T", "/F"],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return rc == 0
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
        return True
    except (ProcessLookupError, PermissionError, OSError):
        try:
            os.kill(pid, signal.SIGTERM)
            return True
        except OSError:
            return False


def main(argv=None):
    _reconfigure()
    parser = argparse.ArgumentParser(prog="stop_chrome.py", description="停止 CDP 调试浏览器")
    parser.add_argument("--port", type=int, default=9222, help="调试端口，默认 9222")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认 127.0.0.1")
    parser.add_argument("--force", action="store_true", help="跳过 CDP，直接按 PID 结束进程")
    args = parser.parse_args(argv)

    client = CDPClient(host=args.host, port=args.port, timeout=5)
    closed = False

    if not args.force and client.is_alive():
        try:
            client.connect_browser()
            client.send("Browser.close", timeout=5)
            closed = True
            print("已通过 CDP 发送关闭指令。")
        except Exception as exc:
            print("CDP 关闭失败（%s），回退到按 PID 终止。" % exc)

    pid_file = pid_path(args.port)
    killed_pids = find_cdp_pids(args.port)
    if not closed and killed_pids:
        for pid in killed_pids:
            kill_by_pid(pid)
        print("已按命令行匹配终止 %d 个进程：%s" % (len(killed_pids), killed_pids))
        closed = True
    elif not closed and pid_file.exists():
        try:
            pid = int(pid_file.read_text(encoding="utf-8").strip())
        except (ValueError, OSError):
            pid = None
        if pid and kill_by_pid(pid):
            print("已按 PID %d 终止进程。" % pid)
            closed = True

    for _ in range(20):
        if not client.is_alive():
            break
        import time
        time.sleep(0.5)
        if not closed:
            for pid in find_cdp_pids(args.port):
                kill_by_pid(pid)

    if pid_file.exists():
        try:
            pid_file.unlink()
        except OSError:
            pass

    if not client.is_alive():
        print("STOPPED：%s:%d 已停止。" % (args.host, args.port))
        print("登录态：持久 profile 保留在 %s（--temp 启动则已清空）。" % default_profile_dir())
        return 0

    print("错误：浏览器仍未停止。可手动结束：")
    if os.name == "nt":
        print("  打开任务管理器，结束所有命令行含 remote-debugging-port=%d 的进程。" % args.port)
    else:
        print("  执行：ps aux | grep 'remote-debugging-port=%d' 找到 PID 后 kill 之。" % args.port)
    return 1


if __name__ == "__main__":
    sys.exit(main())
