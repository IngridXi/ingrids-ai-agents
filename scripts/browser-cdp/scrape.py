#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scrape.py —— 通用页面采集：打开网址 → 等页面 → 执行抽取脚本 → 落盘 JSON + CSV。

内置登录态过期检测：若页面被重定向到登录页，本轮跳过落盘并写告警日志，
不会把登录页当成有效数据记下来（这是长期定时采集最容易踩的坑）。

用法：
    python scripts/scrape.py --url "<网址>" --extract templates/extract.example.js --out "<数据目录>"
    python scripts/scrape.py --url "<网址>" --extract my.js --out data --name 价格 --wait 8
    python scripts/scrape.py --url "<网址>" --extract my.js --out data --login-marker "登录"

参数：
    --url            目标网址（必填）
    --extract        抽取脚本路径（必填，内容为一段返回 JSON 字符串的 JS）
    --out            数据输出根目录（必填）
    --name           任务名，用于区分子目录，默认 default
    --wait           导航后额外等待秒数，默认 5
    --nav-timeout    导航超时秒数，默认 30
    --login-marker   登录页特征串，可重复传入；默认 login / signin / sign-in / 登录 / 验证身份 / passport
    --port/--host    CDP 地址
    --no-csv         只写 JSON

输出结构：
    <out>/<任务名>/<YYYY-MM-DD>/data-<时间>.json    机读
    <out>/<任务名>/<YYYY-MM-DD>/data-<时间>.csv     人读
    <out>/<任务名>/login-expiry.log          登录过期告警

退出码：0 成功；1 执行失败；2 登录态失效（需人工重新登录）；3 CDP 不可达。
"""

import argparse
import csv
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cdp import CDPClient  # noqa: E402

DEFAULT_MARKERS = ["login", "signin", "sign-in", "登录", "验证身份", "passport"]


def _reconfigure():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass


def write_csv(path, records):
    if not records:
        return 0
    if isinstance(records, dict):
        records = [records]
    if records and isinstance(records[0], dict):
        keys = []
        for r in records:
            for k in r.keys():
                if k not in keys:
                    keys.append(k)
    else:
        keys = ["value"]
        records = [{"value": r} for r in records]
    with open(path, "w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=keys)
        writer.writeheader()
        for r in records:
            writer.writerow({k: r.get(k, "") for k in keys})
    return len(records)


def main(argv=None):
    _reconfigure()
    parser = argparse.ArgumentParser(prog="scrape.py", description="通用 CDP 页面采集")
    parser.add_argument("--url", required=True)
    parser.add_argument("--extract", required=True, help="抽取 JS 文件路径")
    parser.add_argument("--out", required=True, help="数据输出根目录")
    parser.add_argument("--name", default="default", help="任务名，用于区分子目录")
    parser.add_argument("--wait", type=float, default=5.0)
    parser.add_argument("--nav-timeout", type=float, default=30.0)
    parser.add_argument("--login-marker", action="append", default=None)
    parser.add_argument("--port", type=int, default=9222)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--no-csv", action="store_true")
    args = parser.parse_args(argv)

    client = CDPClient(host=args.host, port=args.port, timeout=20)
    if not client.is_alive():
        print("CDP 不可达：http://%s:%d" % (args.host, args.port))
        print("请先运行：python scripts/start_chrome.py --port %d" % args.port)
        return 3

    js_path = Path(args.extract)
    if not js_path.exists():
        print("错误：抽取脚本不存在：%s" % js_path)
        return 1
    expression = js_path.read_text(encoding="utf-8")

    out_root = Path(args.out) / args.name / time.strftime("%Y-%m-%d")

    try:
        page = client.ensure_page()
        print("使用标签页：%s" % page.get("id"))
        ok = client.navigate(args.url, timeout=args.nav_timeout)
        if not ok:
            print("警告：页面在 %.0f 秒内未加载完成，仍继续尝试抽取。" % args.nav_timeout)
        if args.wait:
            time.sleep(args.wait)

        final_url = client.page_url() or ""
        title = client.page_title() or ""
        print("最终 URL：%s" % final_url)
        print("页面标题：%s" % title)

        # 导航失败页检测：Chrome 导航失败会停在 chrome-error://，此时页面文本是错误页内容，
        # 直接抽取会把错误页当数据存下来，且调用方看到的是成功码。
        if final_url.startswith("chrome-error://"):
            print("错误：导航失败，浏览器停在错误页（%s）。本轮不落盘数据。" % final_url)
            print("常见原因：网址不可达、DNS 解析失败，或需要代理（如需代理请用 start_chrome.py --proxy 重启）。")
            return 1

        # 登录态检测：命中特征即本轮跳过，绝不把登录页当数据
        markers = args.login_marker or DEFAULT_MARKERS
        body_head = client.page_text(max_chars=1500)
        hit = [m for m in markers if m.lower() in final_url.lower() or m.lower() in (title + body_head).lower()]
        if hit:
            log_path = Path(args.out) / args.name / "login-expiry.log"
            log_path.parent.mkdir(parents=True, exist_ok=True)
            with open(log_path, "a", encoding="utf-8") as fh:
                fh.write("%s\t登录态失效\t命中特征=%s\tURL=%s\n" % (
                    time.strftime("%Y-%m-%d %H:%M:%S"), ",".join(hit), final_url))
            print("LOGIN_EXPIRED：疑似已跳转到登录页（命中：%s）。本轮不落盘数据。" % ",".join(hit))
            print("处理方式：以持久 profile 打开浏览器，手动登录该站点一次，下次自动恢复。")
            print("  python scripts/start_chrome.py --port %d" % args.port)
            print("  python scripts/cdp.py --port %d open \"%s\"" % (args.port, args.url))
            print("告警已记录：%s" % log_path)
            return 2

        raw = client.evaluate(expression).get("value")
        if raw is None:
            print("错误：抽取脚本未返回任何内容。请确认脚本以 return 返回字符串或对象。")
            return 1
        if isinstance(raw, str):
            try:
                records = json.loads(raw)
            except json.JSONDecodeError:
                records = {"text": raw}
        else:
            records = raw

        # 确认要落盘时才建目录：登录失效/导航失败时不留空 <任务名>/<日期>/ 目录
        out_root.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%H%M%S")
        json_path = out_root / ("data-%s.json" % stamp)
        json_path.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
        print("已写入：%s" % json_path)

        if not args.no_csv:
            csv_path = out_root / ("data-%s.csv" % stamp)
            n = write_csv(csv_path, records)
            if n:
                print("已写入：%s（%d 行）" % (csv_path, n))
            else:
                print("0 条记录，未生成 CSV。")

        count = len(records) if isinstance(records, list) else 1
        print("SCRAPE_OK：共 %d 条记录。" % count)
        return 0
    except Exception as exc:
        print("错误：%s" % exc)
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
