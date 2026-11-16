#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
setup_chrome.py —— 步骤 0：检查并确保本机有可用于 CDP 调试的 Chromium 系浏览器。

三种获取途径：
1. 已安装 Chrome / Chromium         → 直接记录路径
2. 未安装，愿意自动安装（Windows）    → winget 安装，失败则下载官方离线安装包
3. 不想装 / 装不上                   → 使用系统自带 Edge（Windows 自带，Chromium 内核，同样支持 CDP）

用法：
    python scripts/setup_chrome.py                 仅探测并报告
    python scripts/setup_chrome.py --install        缺失时自动尝试安装
    python scripts/setup_chrome.py --use-edge       强制使用 Edge 作为浏览器
    python scripts/setup_chrome.py --path "<路径>"   手动指定浏览器可执行文件

退出码：0 已就绪；1 未找到且未安装成功。
"""

import argparse
import platform
import shutil
import subprocess
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import save_config  # noqa: E402

# 官方分发渠道（不含任何第三方代理或加速镜像）
CHROME_DOWNLOAD_PAGE = "https://www.google.com/chrome/"
CHROME_MSI_URL = "https://dl.google.com/edgedl/chrome/install/GoogleChromeStandaloneEnterprise64.msi"


def _reconfigure():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def _candidate_paths():
    """按平台返回常见安装路径。"""
    system = platform.system()
    home = Path.home()
    paths = []
    if system == "Windows":
        pf = __import__("os").environ.get("ProgramFiles", r"C:\Program Files")
        pf86 = __import__("os").environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
        local = __import__("os").environ.get("LOCALAPPDATA", str(home / "AppData" / "Local"))
        paths = [
            (str(Path(pf) / "Google" / "Chrome" / "Application" / "chrome.exe"), "Google Chrome"),
            (str(Path(pf86) / "Google" / "Chrome" / "Application" / "chrome.exe"), "Google Chrome"),
            (str(Path(local) / "Google" / "Chrome" / "Application" / "chrome.exe"), "Google Chrome (用户级)"),
            (str(Path(pf) / "Chromium" / "Application" / "chrome.exe"), "Chromium"),
            (str(Path(pf86) / "Microsoft" / "Edge" / "Application" / "msedge.exe"), "Microsoft Edge"),
            (str(Path(pf) / "Microsoft" / "Edge" / "Application" / "msedge.exe"), "Microsoft Edge"),
        ]
    elif system == "Darwin":
        paths = [
            ("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "Google Chrome"),
            (str(home / "Applications" / "Google Chrome.app" / "Contents" / "MacOS" / "Google Chrome"), "Google Chrome"),
            ("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "Microsoft Edge"),
            ("/Applications/Chromium.app/Contents/MacOS/Chromium", "Chromium"),
        ]
    else:
        paths = [
            ("/usr/bin/google-chrome", "Google Chrome"),
            ("/usr/bin/google-chrome-stable", "Google Chrome"),
            ("/usr/bin/chromium", "Chromium"),
            ("/usr/bin/chromium-browser", "Chromium"),
            ("/snap/bin/chromium", "Chromium"),
        ]
    return paths


def _from_registry():
    """Windows：从注册表 App Paths 读取真实安装路径。"""
    if platform.system() != "Windows":
        return []
    found = []
    try:
        import winreg
    except ImportError:
        return found
    roots = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe"),
    ]
    for root, key in roots:
        try:
            with winreg.OpenKey(root, key) as h:
                value, _ = winreg.QueryValueEx(h, None)
                name = "Google Chrome" if "chrome" in key.lower() else "Microsoft Edge"
                found.append((str(value).strip('"'), name))
        except OSError:
            continue
    return found


def _from_path_env():
    found = []
    for exe, label in (("chrome", "Google Chrome"), ("google-chrome", "Google Chrome"),
                       ("chromium", "Chromium"), ("msedge", "Microsoft Edge")):
        p = shutil.which(exe)
        if p:
            found.append((p, label))
    return found


def detect_all():
    """返回去重后的 [(路径, 名称)]，Chrome/Chromium 优先于 Edge。"""
    raw = _from_registry() + _candidate_paths() + _from_path_env()
    seen, chromium, edge = set(), [], []
    for path, name in raw:
        try:
            p = Path(path)
        except (TypeError, ValueError):
            continue
        if not p.exists():
            continue
        key = str(p.resolve()).lower()
        if key in seen:
            continue
        seen.add(key)
        (edge if "edge" in name.lower() else chromium).append((str(p), name))
    return chromium + edge


def install_chrome():
    """Windows 自动安装：winget 优先，失败则下载官方离线安装包。"""
    system = platform.system()
    if system == "Windows":
        print("[1/2] 尝试使用系统包管理器 winget 安装 Google Chrome ...")
        print("      命令：winget install -e --id Google.Chrome --accept-source-agreements --accept-package-agreements")
        try:
            rc = subprocess.call(
                ["winget", "install", "-e", "--id", "Google.Chrome",
                 "--accept-source-agreements", "--accept-package-agreements"],
                timeout=900,
            )
            if rc == 0:
                print("      winget 安装完成。")
                return True
            print("      winget 返回码 %s，改用官方离线安装包。" % rc)
        except FileNotFoundError:
            print("      未找到 winget，改用官方离线安装包。")
        except subprocess.TimeoutExpired:
            print("      winget 安装超时，改用官方离线安装包。")

        print("[2/2] 下载 Google Chrome 官方离线安装包 ...")
        print("      来源：%s" % CHROME_MSI_URL)
        import tempfile
        msi = Path(tempfile.gettempdir()) / "GoogleChromeStandaloneEnterprise64.msi"
        try:
            with urllib.request.urlopen(CHROME_MSI_URL, timeout=900) as resp, open(msi, "wb") as fh:
                total = int(resp.headers.get("Content-Length") or 0)
                done = 0
                while True:
                    chunk = resp.read(262144)
                    if not chunk:
                        break
                    fh.write(chunk)
                    done += len(chunk)
                    if total:
                        print("\r      已下载 %.1f / %.1f MB" % (done / 1048576, total / 1048576), end="", flush=True)
            print()
        except Exception as exc:
            print("      下载失败：%s" % exc)
            return False

        print("      开始安装（可能需要管理员权限，若弹出 UAC 请确认）...")
        print("      命令：msiexec /i %s /quiet /norestart" % msi)
        rc = subprocess.call(["msiexec", "/i", str(msi), "/quiet", "/norestart"], timeout=900)
        if rc == 0:
            print("      离线安装包安装完成。")
            return True
        print("      安装程序返回码 %s（0 表示成功）。若提示权限不足，请以管理员身份重试。" % rc)
        return False

    print("当前系统（%s）不支持自动安装，请手动安装后重新运行本脚本：" % system)
    if system == "Darwin":
        print("  方式一：brew install --cask google-chrome")
        print("  方式二：访问 %s 下载安装" % CHROME_DOWNLOAD_PAGE)
    else:
        print("  方式一：使用系统包管理器安装 chromium 或 google-chrome-stable")
        print("  方式二：访问 %s 下载 .deb / .rpm 安装包" % CHROME_DOWNLOAD_PAGE)
    return False


def main(argv=None):
    _reconfigure()
    parser = argparse.ArgumentParser(prog="setup_chrome.py", description="检查并确保存在可用的 Chromium 系浏览器")
    parser.add_argument("--install", action="store_true", help="未找到 Chrome 时自动尝试安装")
    parser.add_argument("--use-edge", action="store_true", help="强制使用系统自带 Edge")
    parser.add_argument("--path", help="手动指定浏览器可执行文件路径")
    args = parser.parse_args(argv)

    if args.path:
        p = Path(args.path)
        if not p.exists():
            print("错误：指定路径不存在：%s" % p)
            return 1
        save_config({"browser_path": str(p), "browser_name": "自定义", "detected_at": _now()})
        print("READY")
        print("浏览器：%s" % p)
        return 0

    found = detect_all()

    if args.use_edge:
        edge = [f for f in found if "edge" in f[1].lower()]
        if not edge:
            print("错误：未找到 Microsoft Edge。")
            return 1
        save_config({"browser_path": edge[0][0], "browser_name": edge[0][1], "detected_at": _now()})
        print("READY")
        print("浏览器：%s（%s）" % edge[0])
        return 0

    if found:
        preferred = [f for f in found if "edge" not in f[1].lower()]
        pick = (preferred or found)[0]
        save_config({"browser_path": pick[0], "browser_name": pick[1], "detected_at": _now()})
        print("READY")
        print("已找到 %d 个可用浏览器，选用：%s" % (len(found), pick[0]))
        for path, name in found:
            print("  - [%s] %s" % (name, path))
        if len(found) > 1:
            print("如需切换，运行：python scripts/setup_chrome.py --use-edge 或 --path \"<路径>\"")
        return 0

    print("NOT_FOUND：本机未检测到 Chrome / Chromium / Edge。")
    print()
    print("请选择一种方式获取浏览器：")
    print("  A. 手动下载安装（推荐，最稳妥）")
    print("     访问官方下载页 %s ，下载安装后重新运行本脚本。" % CHROME_DOWNLOAD_PAGE)
    print("  B. 自动安装")
    print("     重新运行：python scripts/setup_chrome.py --install")
    print("  C. 使用系统自带 Edge（Windows 自带，无需安装）")
    print("     运行：python scripts/setup_chrome.py --use-edge")

    if args.install:
        print()
        if install_chrome():
            found = detect_all()
            if found:
                pick = [f for f in found if "edge" not in f[1].lower()]
                pick = (pick or found)[0]
                save_config({"browser_path": pick[0], "browser_name": pick[1], "detected_at": _now()})
                print("READY")
                print("浏览器：%s（%s）" % pick)
                return 0
        print("自动安装未成功，请改用方式 A 手动安装，或方式 C 使用 Edge。")
    return 1


def _now():
    import time
    return time.strftime("%Y-%m-%d %H:%M:%S")


if __name__ == "__main__":
    sys.exit(main())
