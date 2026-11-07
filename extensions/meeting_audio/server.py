"""会议录音处理本机 HTTP 服务（仅监听 127.0.0.1，无公网开关）。

供前端 agent 页面（haiguihai/agents/meeting-audio/）调用。
音频以请求 body 二进制上传；JSON 接口用于总结/纪要/PPT。

启动：
    .venv/bin/python server.py            # HTTP 127.0.0.1:8950 + WS 127.0.0.1:8951

接口：
    GET  /health            健康检查（含实时转写端口）
    GET  /speakers          列出已注册人物
    POST /enroll?name=张三   上传一段人声注册声纹（body=音频二进制）
    POST /enroll-segment    实时段命名注册（JSON: {segment_id, name}）
    DELETE /speaker/<id>    删除人物
    POST /transcribe?denoise=1   上传会议录音 → 转写+分离+自动识别人物
    POST /summary           实时总结（JSON: {transcript, notes}）
    POST /minutes           生成会议纪要（JSON: {transcript, notes, speakers}）
    POST /ppt               生成会议总结 PPT（JSON: {minutes, title}）
    GET  /download/<file>   下载生成的 .pptx
    WS   ws://127.0.0.1:8951/realtime   实时流式转写 + 说话人识别
"""
from __future__ import annotations

import json
import os
import tempfile
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import meeting_audio as ma
import ppt as ppt_gen
import realtime
import summarize

HOST = "127.0.0.1"
PORT = int(os.environ.get("MEETING_AUDIO_PORT", "8950"))
REALTIME_PORT = int(os.environ.get("MEETING_AUDIO_REALTIME_PORT", "8951"))
MAX_BYTES = int(os.environ.get("MEETING_AUDIO_MAX_BYTES", str(60 * 1024 * 1024)))  # 60MiB
GENERATED_DIR = Path(__file__).resolve().parent / "generated"
CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
}


def _json(handler, obj, status: int = 200):
    body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    for k, v in CORS.items():
        handler.send_header(k, v)
    handler.end_headers()
    handler.wfile.write(body)


def _read_body(handler) -> bytes:
    length = int(handler.headers.get("Content-Length") or 0)
    if length <= 0:
        raise ValueError("请求体为空")
    if length > MAX_BYTES:
        raise ValueError(f"音频过大（上限 {MAX_BYTES // 1024 // 1024}MiB）")
    return handler.rfile.read(length)


def _read_json(handler) -> dict:
    raw = _read_body(handler)
    return json.loads(raw.decode("utf-8"))


def _save_tmp(data: bytes, suffix: str) -> Path:
    fd, name = tempfile.mkstemp(prefix="meeting_audio_", suffix=suffix)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    return Path(name)


def _send_file(handler, fpath: Path):
    data = fpath.read_bytes()
    handler.send_response(200)
    handler.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation")
    handler.send_header("Content-Disposition", f'attachment; filename="{fpath.name}"')
    handler.send_header("Content-Length", str(len(data)))
    for k, v in CORS.items():
        handler.send_header(k, v)
    handler.end_headers()
    handler.wfile.write(data)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # 静默默认日志
        pass

    def _handle_audio(self, action):
        qs = parse_qs(urlparse(self.path).query)
        try:
            data = _read_body(self)
            tmp = _save_tmp(data, ".audio")
            try:
                if action == "enroll":
                    name = (qs.get("name") or [""])[0].strip()
                    if not name:
                        return _json(self, {"error": "缺少人物姓名"}, 400)
                    out = ma.enroll(str(tmp), name)
                    return _json(self, {"ok": True, "speaker": out})
                if action == "transcribe":
                    denoise = (qs.get("denoise") or ["1"])[0] != "0"
                    threshold = float((qs.get("threshold") or [str(ma.DEFAULT_SIM_THRESHOLD)])[0])
                    out = ma.process(str(tmp), denoise_first=denoise, threshold=threshold)
                    return _json(self, {"ok": True, "result": out})
                return _json(self, {"error": "未知动作"}, 400)
            finally:
                tmp.unlink(missing_ok=True)
        except ValueError as e:
            return _json(self, {"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return _json(self, {"error": f"处理失败：{e}"}, 500)

    def _handle_summary(self):
        try:
            data = _read_json(self)
            out = summarize.live_summary(data.get("transcript", ""), data.get("notes", ""))
            return _json(self, {"ok": True, "summary": out})
        except ValueError as e:
            return _json(self, {"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return _json(self, {"error": f"总结失败：{e}"}, 500)

    def _handle_minutes(self):
        try:
            data = _read_json(self)
            out = summarize.minutes(data.get("transcript", ""), data.get("notes", ""), data.get("speakers"))
            return _json(self, {"ok": True, "minutes": out})
        except ValueError as e:
            return _json(self, {"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return _json(self, {"error": f"纪要生成失败：{e}"}, 500)

    def _handle_ppt(self):
        try:
            data = _read_json(self)
            minutes_md = (data.get("minutes") or "").strip()
            if not minutes_md:
                return _json(self, {"error": "缺少纪要内容"}, 400)
            title = (data.get("title") or "会议纪要").strip()
            GENERATED_DIR.mkdir(parents=True, exist_ok=True)
            fname = "meeting_minutes_" + time.strftime("%Y%m%d_%H%M%S") + ".pptx"
            ppt_gen.minutes_to_ppt(minutes_md, GENERATED_DIR / fname, title)
            return _json(self, {"ok": True, "file": fname, "url": "/download/" + fname})
        except ValueError as e:
            return _json(self, {"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return _json(self, {"error": f"PPT 生成失败：{e}"}, 500)

    def _handle_enroll_segment(self):
        try:
            data = _read_json(self)
            sid = (data.get("segment_id") or "").strip()
            name = (data.get("name") or "").strip()
            if not sid or not name:
                return _json(self, {"error": "缺少 segment_id 或姓名"}, 400)
            pcm = realtime.pop_segment(sid)
            if pcm is None:
                return _json(self, {"error": "该语音段已失效，请重新录制"}, 404)
            out = ma.enroll_pcm(pcm, name)
            return _json(self, {"ok": True, "speaker": out})
        except ValueError as e:
            return _json(self, {"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            return _json(self, {"error": f"注册失败：{e}"}, 500)

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS.items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return _json(self, {"ok": True, "service": "meeting-audio", "port": PORT, "realtime_port": REALTIME_PORT})
        if path == "/speakers":
            return _json(self, {"ok": True, "speakers": ma.list_speakers()})
        if path.startswith("/download/"):
            fname = path[len("/download/"):]
            root = GENERATED_DIR.resolve()
            fpath = (GENERATED_DIR / fname).resolve()
            if not str(fpath).startswith(str(root)) or not fpath.exists():
                return _json(self, {"error": "未找到"}, 404)
            return _send_file(self, fpath)
        return _json(self, {"error": "未找到"}, 404)

    def do_DELETE(self):
        path = urlparse(self.path).path
        prefix = "/speaker/"
        if path.startswith(prefix):
            sid = path[len(prefix):]
            ok = ma.delete_speaker(sid)
            return _json(self, {"ok": ok, "deleted": sid} if ok else {"error": "未找到该人物"}, 200 if ok else 404)
        return _json(self, {"error": "未找到"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path == "/enroll":
            return self._handle_audio("enroll")
        if path == "/transcribe":
            return self._handle_audio("transcribe")
        if path == "/summary":
            return self._handle_summary()
        if path == "/minutes":
            return self._handle_minutes()
        if path == "/ppt":
            return self._handle_ppt()
        if path == "/enroll-segment":
            return self._handle_enroll_segment()
        return _json(self, {"error": "未找到"}, 404)


def main():
    realtime.start_realtime_server(HOST, REALTIME_PORT)
    print(f"会议录音处理服务启动：http://{HOST}:{PORT}（仅本机）")
    print(f"实时转写 WebSocket：ws://{HOST}:{REALTIME_PORT}/realtime")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
