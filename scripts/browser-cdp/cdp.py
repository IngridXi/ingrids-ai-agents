#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cdp.py —— 零依赖 Chrome DevTools Protocol（CDP）客户端 + 命令行工具。

设计目标：
1. 只用 Python 标准库（自带精简 WebSocket 实现），任何装了 Python 的机器都能直接跑，无需 pip。
2. 命令行子命令固定、输出可机读，方便能力较弱的模型按步执行。
3. 已规避自写 CDP 客户端的三个经典 bug：
   - navigate() 加载超时必须返回 False（不是 True），否则下游静默失败；
   - send() 响应循环必须跳过 event 消息，否则事件会被误当成下一条命令的响应；
   - 建立连接前必须校验 WebSocket URL 格式（含 ws:// 与目标端口）。

命令行用法：
    python scripts/cdp.py status                      检查 CDP 是否可达
    python scripts/cdp.py tabs                        列出所有标签页
    python scripts/cdp.py open <URL> [--wait 25]      打开/导航到指定网址
    python scripts/cdp.py eval "<JS>"                 执行 JS 并返回结果
    python scripts/cdp.py eval --file extract.js      从文件读取 JS 并执行
    python scripts/cdp.py text [--max 3000]           取当前页可见文本
    python scripts/cdp.py title                       取当前页标题
    python scripts/cdp.py click "<选择器>"             点击元素
    python scripts/cdp.py type "<选择器>" "<文本>"      向输入框填入文本
    python scripts/cdp.py wait "<JS条件>" [--timeout 15]  轮询等待条件为真
    python scripts/cdp.py shot <输出.png> [--full]    截图

通用选项：
    --port 9222          CDP 端口（默认 9222）
    --host 127.0.0.1     CDP 主机（默认 127.0.0.1）
    --target <id>        指定标签页 targetId
    --url-contains <串>  按 URL 关键字挑选标签页
    --timeout 15         单条命令超时秒数

退出码：0 成功；1 一般失败；2 CDP 不可达（通常意味着浏览器未以调试模式启动）。
"""

import argparse
import base64
import json
import os
import socket
import ssl
import struct
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

DEFAULT_PORT = 9222
DEFAULT_HOST = "127.0.0.1"


class CDPError(Exception):
    """CDP 相关错误。"""


# --------------------------------------------------------------------------
# 精简 WebSocket 客户端（RFC 6455 客户端子集，纯标准库）
# --------------------------------------------------------------------------
class WSClient:
    """最小可用的 WebSocket 客户端：文本帧、分片接收、掩码发送。"""

    def __init__(self, url, timeout=10.0):
        if not isinstance(url, str) or not url.startswith(("ws://", "wss://")):
            raise CDPError("非法 WebSocket URL（必须以 ws:// 或 wss:// 开头）：%r" % (url,))
        self.url = url
        self.sock = None
        self._buf = b""
        self._timeout = timeout
        self._handshake(timeout)

    @staticmethod
    def looks_valid(url, port):
        """校验 WebSocket URL 格式（含 ws:// 与目标端口）。"""
        if not isinstance(url, str) or not url.startswith("ws://"):
            return False
        return (":%d" % port) in url

    def _handshake(self, timeout):
        u = urlparse(self.url)
        host = u.hostname
        port = u.port or (443 if u.scheme == "wss" else 80)
        try:
            self.sock = socket.create_connection((host, port), timeout=timeout)
        except OSError as exc:
            raise CDPError("连接 %s:%s 失败：%s" % (host, port, exc))
        if u.scheme == "wss":
            ctx = ssl.create_default_context()
            self.sock = ctx.wrap_socket(self.sock, server_hostname=host)
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        path = u.path or "/"
        if u.query:
            path += "?" + u.query
        req = (
            "GET %s HTTP/1.1\r\n"
            "Host: %s:%s\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "Origin: http://%s:%s\r\n"
            "\r\n" % (path, host, port, key, host, port)
        )
        self.sock.sendall(req.encode("ascii"))
        buf = b""
        deadline = time.time() + timeout
        while b"\r\n\r\n" not in buf:
            self.sock.settimeout(max(0.1, deadline - time.time()))
            try:
                chunk = self.sock.recv(4096)
            except (socket.timeout, TimeoutError):
                raise CDPError("WebSocket 握手超时：%s" % self.url)
            if not chunk:
                raise CDPError("WebSocket 握手失败：连接被关闭")
            buf += chunk
        head, rest = buf.split(b"\r\n\r\n", 1)
        status_line = head.split(b"\r\n")[0].decode("utf-8", "replace")
        if "101" not in status_line:
            raise CDPError("WebSocket 握手被拒绝：%s" % status_line)
        self._buf = rest

    def _read_exact(self, n):
        while len(self._buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise CDPError("WebSocket 连接已关闭")
            self._buf += chunk
        data, self._buf = self._buf[:n], self._buf[n:]
        return data

    def _recv_one_frame(self):
        while True:
            b1, b2 = self._read_exact(2)
            fin = b1 & 0x80
            opcode = b1 & 0x0F
            masked = b2 & 0x80
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._read_exact(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._read_exact(8))[0]
            mask = self._read_exact(4) if masked else None
            payload = self._read_exact(length) if length else b""
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:
                raise CDPError("WebSocket 收到关闭帧（页面或标签页已关闭）")
            if opcode in (0x9, 0xA):  # ping / pong，忽略
                continue
            return fin, opcode, payload

    def send_text(self, text):
        payload = text.encode("utf-8")
        header = bytearray([0x81])  # FIN + text frame
        n = len(payload)
        mask = os.urandom(4)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(bytes(header) + masked)

    def recv_text(self, timeout=None):
        """接收一条完整文本消息（自动合并分片）。"""
        chunks = []
        while True:
            if timeout is not None:
                self.sock.settimeout(timeout)
            fin, opcode, payload = self._recv_one_frame()
            if opcode in (0x0, 0x1):  # continuation / text
                chunks.append(payload)
            if fin:
                break
        return b"".join(chunks).decode("utf-8", "replace")

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
            self.sock = None


# --------------------------------------------------------------------------
# CDP 客户端
# --------------------------------------------------------------------------
class CDPClient:
    def __init__(self, host=DEFAULT_HOST, port=DEFAULT_PORT, timeout=15.0):
        self.host = host
        self.port = port
        self.timeout = timeout
        self.ws = None
        self.target_id = None
        self._msg_id = 0

    @property
    def base_http(self):
        return "http://%s:%d" % (self.host, self.port)

    # ---------- HTTP 端点 ----------
    def _http_json(self, path, timeout=None, method="GET"):
        url = self.base_http + path
        req = urllib.request.Request(url, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                return json.loads(resp.read().decode("utf-8", "replace"))
        except urllib.error.URLError as exc:
            raise CDPError(
                "无法连接 CDP（%s）。请确认浏览器已以调试模式启动："
                "python scripts/start_chrome.py 。原始错误：%s" % (url, exc)
            )
        except json.JSONDecodeError as exc:
            raise CDPError("CDP 返回了非 JSON 内容：%s" % exc)

    def version(self):
        return self._http_json("/json/version", timeout=5)

    def targets(self):
        return self._http_json("/json/list", timeout=5)

    def is_alive(self):
        try:
            info = self.version()
            return bool(info.get("Browser"))
        except CDPError:
            return False

    # ---------- WebSocket 连接 ----------
    def connect_browser(self):
        info = self.version()
        ws_url = info.get("webSocketDebuggerUrl")
        if not WSClient.looks_valid(ws_url, self.port):
            raise CDPError(
                "浏览器返回的 WebSocket 地址格式异常（应形如 ws://%s:%d/devtools/browser/...）：%r"
                % (self.host, self.port, ws_url)
            )
        self.ws = WSClient(ws_url, timeout=self.timeout)
        self.target_id = None
        return self

    def connect_page(self, target_id):
        path = "/devtools/page/%s" % target_id
        ws_url = "ws://%s:%d%s" % (self.host, self.port, path)
        if not WSClient.looks_valid(ws_url, self.port):
            raise CDPError("构造的页面 WebSocket 地址非法：%r" % ws_url)
        self.ws = WSClient(ws_url, timeout=self.timeout)
        self.target_id = target_id
        return self

    # ---------- 命令收发 ----------
    def send(self, method, params=None, timeout=None):
        if self.ws is None:
            raise CDPError("尚未建立 WebSocket 连接")
        timeout = timeout or self.timeout
        self._msg_id += 1
        cmd_id = self._msg_id
        self.ws.send_text(json.dumps({"id": cmd_id, "method": method, "params": params or {}}))
        deadline = time.time() + timeout
        while True:
            remain = deadline - time.time()
            if remain <= 0:
                break
            try:
                raw = self.ws.recv_text(timeout=remain)
            except (socket.timeout, TimeoutError):
                break
            except CDPError:
                raise
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if msg.get("id") == cmd_id:
                if "error" in msg:
                    err = msg["error"]
                    raise CDPError("CDP 命令 %s 失败：[%s] %s" % (method, err.get("code"), err.get("message")))
                return msg.get("result", {})
            # 事件消息 / 其它命令的响应：跳过，绝不误当作本条命令的响应
            continue
        raise CDPError("CDP 命令超时（%s 秒）：%s" % (timeout, method))

    def close(self):
        if self.ws:
            self.ws.close()
            self.ws = None

    # ---------- 标签页管理 ----------
    def list_pages(self):
        return [t for t in self.targets() if t.get("type") == "page"]

    def pick_page(self, target=None, url_contains=None):
        pages = self.list_pages()
        if target:
            for p in pages:
                if p.get("id") == target:
                    return p
            raise CDPError("找不到指定的 targetId：%s（可用 python scripts/cdp.py tabs 查看）" % target)
        if not pages:
            return None
        if url_contains:
            for p in pages:
                if url_contains in (p.get("url") or ""):
                    return p
            raise CDPError("没有 URL 包含 %r 的标签页" % url_contains)
        return pages[0]

    def ensure_page(self, target=None, url_contains=None):
        page = self.pick_page(target=target, url_contains=url_contains)
        if page is None:
            self.connect_browser()
            result = self.send("Target.createTarget", {"url": "about:blank"})
            target_id = result.get("targetId")
            if not target_id:
                raise CDPError("创建标签页失败：%r" % result)
            self.close()
            time.sleep(0.4)
            page = {"id": target_id, "url": "about:blank", "title": ""}
        self.connect_page(page["id"])
        self.target_id = page["id"]
        return page

    # ---------- 页面动作 ----------
    def navigate(self, url, timeout=30.0):
        self.send("Page.enable")
        self.send("Page.navigate", {"url": url})
        deadline = time.time() + timeout
        while time.time() < deadline:
            time.sleep(0.4)
            try:
                res = self.send(
                    "Runtime.evaluate",
                    {"expression": "document.readyState", "returnByValue": True},
                    timeout=5,
                )
                if res.get("result", {}).get("value") == "complete":
                    return True
            except CDPError:
                pass
        # 关键：超时必须返回 False，返回 True 会让下游把失败当成成功
        return False

    def evaluate(self, expression, return_by_value=True, timeout=None):
        res = self.send(
            "Runtime.evaluate",
            {
                "expression": expression,
                "returnByValue": return_by_value,
                "awaitPromise": False,
                "userGesture": True,
            },
            timeout=timeout,
        )
        if res.get("exceptionDetails"):
            exc = res["exceptionDetails"]
            raise CDPError("JS 执行异常：%s" % (exc.get("exception", {}).get("description") or exc.get("text")))
        return res.get("result", {})

    def page_url(self):
        return self.evaluate("location.href").get("value")

    def page_title(self):
        return self.evaluate("document.title").get("value")

    def page_text(self, max_chars=None):
        expr = "document.body ? document.body.innerText : ''"
        text = self.evaluate(expr).get("value") or ""
        if max_chars and len(text) > max_chars:
            return text[:max_chars]
        return text

    def click(self, selector):
        expr = (
            "(function(sel){"
            "var el=document.querySelector(sel);"
            "if(!el){return 'NOT_FOUND:'+sel;}"
            "if(typeof el.click!=='function'){return 'NOT_CLICKABLE:'+sel;}"
            "el.scrollIntoView({block:'center'});"
            "el.click();"
            "return 'OK';})( %s )" % json.dumps(selector)
        )
        return self.evaluate(expr).get("value")

    def type_text(self, selector, text):
        # 用原生 setter 赋值并触发 input/change，兼容 React/Vue 等框架
        # 先校验命中元素类型：非表单元素没有可用的 value setter，硬调会抛原生 Illegal invocation
        expr = (
            "(function(sel, val){"
            "var el=document.querySelector(sel);"
            "if(!el){return 'NOT_FOUND:'+sel;}"
            "var tag=(el.tagName||'').toUpperCase();"
            "if(tag!=='INPUT'&&tag!=='TEXTAREA'&&tag!=='SELECT'){return 'NOT_INPUT:'+sel+'(实际为'+tag+')';}"
            "el.scrollIntoView({block:'center'});"
            "el.focus();"
            "var proto = el.tagName==='TEXTAREA' ? window.HTMLTextAreaElement.prototype"
            " : (el.tagName==='SELECT' ? window.HTMLSelectElement.prototype"
            " : window.HTMLInputElement.prototype);"
            "var desc=Object.getOwnPropertyDescriptor(proto,'value');"
            "if(desc && desc.set){desc.set.call(el, val);}else{el.value=val;}"
            "el.dispatchEvent(new Event('input',{bubbles:true}));"
            "el.dispatchEvent(new Event('change',{bubbles:true}));"
            "return 'OK';})( %s, %s )" % (json.dumps(selector), json.dumps(text))
        )
        return self.evaluate(expr).get("value")

    def wait_for(self, expression, timeout=15.0, interval=0.5):
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                val = self.evaluate(expression, timeout=min(5, timeout)).get("value")
                if val:
                    return True
            except CDPError:
                pass
            time.sleep(interval)
        return False

    def screenshot(self, out_path, full_page=False):
        if full_page:
            metrics = self.send("Page.getLayoutMetrics")
            content = metrics.get("contentSize", {})
            clip = {
                "x": 0,
                "y": 0,
                "width": max(1, int(content.get("width", 1280))),
                "height": max(1, int(content.get("height", 800))),
                "scale": 1,
            }
            res = self.send("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": True, "clip": clip})
        else:
            res = self.send("Page.captureScreenshot", {"format": "png"})
        data = res.get("data")
        if not data:
            raise CDPError("截图失败：CDP 未返回图片数据")
        Path(out_path).write_bytes(base64.b64decode(data))
        return str(Path(out_path).resolve())


# --------------------------------------------------------------------------
# 运行时目录与配置
# 运行时产物统一放在用户主目录下，skill 目录始终保持干净（打包时不会混入历史数据）
# --------------------------------------------------------------------------
def runtime_dir():
    d = Path.home() / ".cdp-browser"
    d.mkdir(parents=True, exist_ok=True)
    return d


def config_path():
    return runtime_dir() / "browser.json"


def default_profile_dir():
    return runtime_dir() / "profile"


def temp_profile_dir():
    import tempfile
    d = Path(tempfile.gettempdir()) / "cdp-browser-temp"
    d.mkdir(parents=True, exist_ok=True)
    return d


def pid_path(port):
    return runtime_dir() / ("chrome-%d.pid" % port)


def load_config():
    p = config_path()
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def save_config(data):
    cfg = load_config()
    cfg.update(data)
    config_path().write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return cfg


# --------------------------------------------------------------------------
# 命令行
# --------------------------------------------------------------------------
def _read_expr(args):
    if getattr(args, "file", None):
        p = Path(args.file)
        if not p.exists():
            raise CDPError("JS 文件不存在：%s" % p)
        return p.read_text(encoding="utf-8")
    return args.expression


def _attach(args, client):
    page = client.ensure_page(target=args.target, url_contains=args.url_contains)
    return page


def _print_json(obj):
    print(json.dumps(obj, ensure_ascii=False, indent=2))


def build_parser():
    p = argparse.ArgumentParser(prog="cdp.py", description="零依赖 Chrome CDP 命令行客户端")
    p.add_argument("--port", type=int, default=DEFAULT_PORT, help="CDP 端口，默认 %d" % DEFAULT_PORT)
    p.add_argument("--host", default=DEFAULT_HOST, help="CDP 主机，默认 %s" % DEFAULT_HOST)
    p.add_argument("--target", help="指定标签页 targetId")
    p.add_argument("--url-contains", help="按 URL 关键字挑选标签页")
    p.add_argument("--timeout", type=float, default=15.0, help="单条命令超时秒数，默认 15")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="检查 CDP 是否可达")

    sub.add_parser("tabs", help="列出所有标签页")

    o = sub.add_parser("open", help="打开或导航到指定网址")
    o.add_argument("url")
    o.add_argument("--wait", type=float, default=25.0, help="等待页面加载的秒数，默认 25")

    e = sub.add_parser("eval", help="执行 JavaScript 并返回结果")
    e.add_argument("expression", nargs="?", help="JS 表达式；与 --file 二选一")
    e.add_argument("--file", help="从文件读取 JS（推荐，避免命令行转义问题）")

    t = sub.add_parser("text", help="取当前页可见文本")
    t.add_argument("--max", type=int, default=3000, help="最大字符数，默认 3000")

    sub.add_parser("title", help="取当前页标题")
    sub.add_parser("url", help="取当前页 URL")

    c = sub.add_parser("click", help="点击匹配 CSS 选择器的元素")
    c.add_argument("selector")

    ty = sub.add_parser("type", help="向匹配 CSS 选择器的输入框填入文本")
    ty.add_argument("selector")
    ty.add_argument("text")

    w = sub.add_parser("wait", help="轮询等待 JS 条件为真")
    w.add_argument("expression")
    w.add_argument("--timeout", dest="wait_timeout", type=float, default=15.0)

    s = sub.add_parser("shot", help="截图")
    s.add_argument("output")
    s.add_argument("--full", action="store_true", help="截取整页")
    return p


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    args = build_parser().parse_args(argv)
    client = CDPClient(host=args.host, port=args.port, timeout=args.timeout)
    try:
        if args.cmd == "status":
            if not client.is_alive():
                print("CDP_UNREACHABLE: %s 无响应" % client.base_http)
                print("下一步：运行 python scripts/start_chrome.py 启动调试模式浏览器")
                return 2
            info = client.version()
            pages = client.list_pages()
            print("CDP_OK")
            print("浏览器: %s" % info.get("Browser"))
            print("调试地址: %s" % client.base_http)
            print("标签页数: %d" % len(pages))
            for pg in pages:
                print("  - %s | %s | %s" % (pg.get("id"), pg.get("title", "")[:40], pg.get("url", "")[:80]))
            return 0

        if not client.is_alive():
            print("CDP_UNREACHABLE: %s 无响应" % client.base_http)
            print("下一步：运行 python scripts/start_chrome.py 启动调试模式浏览器")
            return 2

        if args.cmd == "tabs":
            _print_json(client.list_pages())
            return 0

        if args.cmd == "open":
            page = _attach(args, client)
            ok = client.navigate(args.url, timeout=args.wait)
            final_url = client.page_url() or ""
            # 注意：loaded=true 只表示页面加载完成，不代表拿到了目标内容。
            # Chrome 导航失败时会停在 chrome-error:// 页，此时 readyState 同样是 complete。
            is_error_page = final_url.startswith("chrome-error://")
            print(json.dumps({
                "targetId": client.target_id,
                "url": final_url,
                "title": client.page_title(),
                "loaded": ok,
                "isErrorPage": is_error_page,
            }, ensure_ascii=False, indent=2))
            if is_error_page:
                print("导航失败：Chrome 停在错误页。常见原因：网址不可达、DNS 解析失败、"
                      "或网络需要经由代理（如需代理请用 start_chrome.py --proxy 重启浏览器）。")
                return 1
            if not ok:
                print("警告：页面在 %.0f 秒内未加载完成，继续执行前建议先用 text 子命令确认内容。" % args.wait)
            return 0

        page = _attach(args, client)

        if args.cmd == "eval":
            value = client.evaluate(_read_expr(args)).get("value")
            if isinstance(value, (dict, list)):
                _print_json(value)
            else:
                print(value if value is not None else "")
            return 0

        if args.cmd == "text":
            print(client.page_text(max_chars=args.max))
            return 0

        if args.cmd == "title":
            print(client.page_title())
            return 0

        if args.cmd == "url":
            print(client.page_url())
            return 0

        if args.cmd == "click":
            print(client.click(args.selector))
            return 0

        if args.cmd == "type":
            print(client.type_text(args.selector, args.text))
            return 0

        if args.cmd == "wait":
            ok = client.wait_for(args.expression, timeout=args.wait_timeout)
            print("WAIT_OK" if ok else "WAIT_TIMEOUT")
            return 0 if ok else 1

        if args.cmd == "shot":
            path = client.screenshot(args.output, full_page=args.full)
            print("截图已保存：%s" % path)
            return 0

        return 1
    except CDPError as exc:
        print("错误：%s" % exc, file=sys.stderr)
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.exit(main())
