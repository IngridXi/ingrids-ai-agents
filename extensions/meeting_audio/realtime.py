"""实时段级转写 + 说话人识别（WebSocket）。

链路：浏览器麦克风 → 16k PCM 帧（int16 二进制）→ 能量 VAD 切段 →
段级轻量 ASR + CAM++ 声纹比对 → turn 事件（已知人名 / 未知说话人临时标签）。

参考开源方案 ovs-realtime-pipeline（Silero VAD → 段级 ASR + CAM++ → 在线聚类），
本实现用能量阈值 VAD + 会话内余弦聚类，零额外依赖、复用已缓存的 FunASR 模型。
"""
from __future__ import annotations

import asyncio
import json
import threading
import uuid

import numpy as np

import meeting_audio as ma

SR = 16000
FRAME_MS = 20
FRAME_SAMPLES = int(SR * FRAME_MS / 1000)  # 320 样本/帧

# 能量 VAD 参数（float32，已归一化到 [-1,1]）
SPEECH_RMS = 0.008      # 语音阈值
SILENCE_MS = 600        # 静音超时判段结束
MIN_SEG_MS = 400        # 最小段长，短于此忽略
MAX_SEG_MS = 20000      # 最大段长，强制切分


class Segmenter:
    """能量阈值 + 静音超时的增量 VAD 分段器（带绝对时间戳）。"""

    def __init__(self):
        self.buf: list[np.ndarray] = []
        self.in_speech = False
        self.silence_frames = 0
        self.total_samples = 0          # 累计样本数（含静音）
        self.seg_start_sample = 0

    def _rms(self, frame: np.ndarray) -> float:
        if frame.size == 0:
            return 0.0
        return float(np.sqrt(np.mean(frame.astype(np.float64) ** 2)))

    def feed(self, pcm: np.ndarray):
        """输入 float32 PCM，返回 [(seg_pcm, start_s, end_s), ...] 完整段。"""
        segs = []
        n = pcm.size
        for i in range(0, n, FRAME_SAMPLES):
            frame = pcm[i:i + FRAME_SAMPLES]
            self.total_samples += frame.size
            if self._rms(frame) >= SPEECH_RMS:
                if not self.in_speech:
                    self.in_speech = True
                    self.seg_start_sample = self.total_samples - frame.size
                    self.buf = []
                    self.silence_frames = 0
                self.buf.append(frame)
                self.silence_frames = 0
            elif self.in_speech:
                self.buf.append(frame)
                self.silence_frames += 1
                seg_ms = len(self.buf) * FRAME_MS
                if self.silence_frames * FRAME_MS >= SILENCE_MS or seg_ms >= MAX_SEG_MS:
                    segs.append(self._finish())
        return segs

    def flush(self):
        """结束时把残余缓冲作为最后一段返回。"""
        segs = []
        if self.in_speech and self.buf:
            segs.append(self._finish())
        return segs

    def _finish(self):
        seg = np.concatenate(self.buf) if self.buf else np.zeros(0, dtype=np.float32)
        start = self.seg_start_sample / SR
        end = (self.seg_start_sample + seg.size) / SR
        self.buf = []
        self.in_speech = False
        self.silence_frames = 0
        return seg, round(start, 2), round(end, 2)


class SessionState:
    """单个实时会话的状态：未知说话人会话内聚类。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.unknown: list[dict] = []       # [{"embedding": np.ndarray, "label": str}]
        self.next_label = 1

    def resolve_unknown(self, emb: np.ndarray):
        """对未命中已登记声纹的向量，做会话内聚类，返回 (label, score)。"""
        with self.lock:
            best = None
            for u in self.unknown:
                s = ma.cosine(emb, u["embedding"])
                if s > ma.DEFAULT_SIM_THRESHOLD and (best is None or s > best[0]):
                    best = (s, u["label"])
            if best:
                return best[1], round(best[0], 4)
            label = f"说话人{self.next_label}"
            self.next_label += 1
            self.unknown.append({"embedding": emb, "label": label})
            return label, 0.0


# 全局段缓存：实时段音频按 segment_id 暂存，供 HTTP /enroll-segment 命名注册时取用。
_SEGMENT_STORE: dict[str, np.ndarray] = {}
_SEGMENT_LOCK = threading.Lock()


def store_segment(pcm: np.ndarray) -> str:
    sid = uuid.uuid4().hex[:12]
    with _SEGMENT_LOCK:
        _SEGMENT_STORE[sid] = np.asarray(pcm, dtype=np.float32)
    return sid


def pop_segment(sid: str):
    with _SEGMENT_LOCK:
        return _SEGMENT_STORE.pop(sid, None)


def _match_profiles(emb: np.ndarray, profiles: dict):
    """与已登记声纹库比对（等价于 ma.identify 但直接吃向量）。"""
    best_id, best_name, best_score = None, None, -1.0
    for sid, prof in profiles.items():
        s = ma.cosine(emb, prof.get("embedding", []))
        if s > best_score:
            best_id, best_name, best_score = sid, prof.get("name"), s
    if best_score < ma.DEFAULT_SIM_THRESHOLD:
        return {"speaker_id": None, "name": None, "score": round(best_score, 4), "matched": False}
    return {"speaker_id": best_id, "name": best_name, "score": round(best_score, 4), "matched": True}


def process_segment(seg_pcm: np.ndarray, start: float, end: float, state: SessionState):
    """阻塞式处理一个语音段：转写 + 声纹识别，返回 turn 事件 dict 或 None。"""
    if seg_pcm.size < SR * MIN_SEG_MS / 1000:
        return None
    text = ma.transcribe_light(seg_pcm)
    if not text:
        return None
    emb = np.asarray(ma.extract_embedding(seg_pcm), dtype=np.float32)
    profiles = ma._load_profiles()
    hit = _match_profiles(emb, profiles) if profiles else {"speaker_id": None, "name": None, "score": 0.0, "matched": False}
    if hit["matched"]:
        return {
            "type": "turn", "text": text, "start": start, "end": end,
            "speaker_name": hit["name"], "speaker_label": hit["name"],
            "matched": True, "score": hit["score"], "segment_id": None,
        }
    label, score = state.resolve_unknown(emb)
    seg_id = store_segment(seg_pcm)
    return {
        "type": "turn", "text": text, "start": start, "end": end,
        "speaker_name": None, "speaker_label": label,
        "matched": False, "score": score, "segment_id": seg_id,
    }


async def realtime_handler(ws, path=""):
    """WebSocket 实时会话。接收 int16 PCM 帧，逐段回传 turn 事件。"""
    state = SessionState()
    segmenter = Segmenter()
    loop = asyncio.get_running_loop()
    executor = None  # 懒建线程池

    await ws.send(json.dumps({"type": "ready", "samplerate": SR, "speakers": ma.list_speakers()}, ensure_ascii=False))

    async def run_blocking(fn, *args):
        nonlocal executor
        if executor is None:
            import concurrent.futures
            executor = concurrent.futures.ThreadPoolExecutor(max_workers=2)
        return await loop.run_in_executor(executor, fn, *args)

    try:
        async for message in ws:
            if isinstance(message, str):
                # 控制消息
                try:
                    ctrl = json.loads(message)
                except Exception:
                    ctrl = {}
                if ctrl.get("type") == "reset":
                    segmenter = Segmenter(); state = SessionState()
                    await ws.send(json.dumps({"type": "reset_ok"}))
                elif ctrl.get("type") == "stop":
                    break
                continue
            pcm = np.frombuffer(message, dtype=np.int16).astype(np.float32) / 32768.0
            for seg_pcm, start, end in segmenter.feed(pcm):
                turn = await run_blocking(process_segment, seg_pcm, start, end, state)
                if turn:
                    await ws.send(json.dumps(turn, ensure_ascii=False))
        # 断连：flush 残余段
        for seg_pcm, start, end in segmenter.flush():
            turn = await run_blocking(process_segment, seg_pcm, start, end, state)
            if turn:
                await ws.send(json.dumps(turn, ensure_ascii=False))
        await ws.send(json.dumps({"type": "done"}))
    finally:
        if executor is not None:
            executor.shutdown(wait=False)


def start_realtime_server(host: str = "127.0.0.1", port: int = 8951):
    """在独立线程启动 WebSocket 服务器，返回线程对象（非阻塞）。"""
    import websockets

    async def _run():
        async with websockets.serve(realtime_handler, host, port, max_size=8 * 1024 * 1024):
            await asyncio.Future()  # 一直运行

    def _thread_main():
        asyncio.run(_run())

    t = threading.Thread(target=_thread_main, name="meeting-audio-realtime", daemon=True)
    t.start()
    return t
