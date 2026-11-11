"""会议录音处理核心：降噪 → 转写 → 说话人分离 → 声纹注册/识别。

技术路线（全部本地开源、离线推理、无云 API）：
  - 降噪            noisereduce（纯 numpy）
  - 语音转写        FunASR Paraformer-zh（中文，带句级时间戳）
  - 说话人分离      FunASR CAM++（spk_model 自动聚类）
  - 说话人识别/声纹 FunASR CAM++（speaker verification，提取 192 维向量做余弦比对）

边界与合规（与主平台证据链哲学一致）：
  - AI 判定均为辅助，需人工复核；会议录制/转写须事先告知并取得参会人员同意。
  - 模型只在本机加载、推理只读本地文件，无云上传、无遥测。
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import time
import uuid
from pathlib import Path

import numpy as np

# 声纹默认阈值：余弦相似度高于该值判定为同一人（CAM++ 经验值，可调）。
DEFAULT_SIM_THRESHOLD = 0.62
PROFILE_DIR = Path(__file__).resolve().parent / "speaker_profiles"

_ASR_MODEL = None
_ASR_LIGHT = None
_ASR_MULTI = None
_SV_MODEL = None


def _device() -> str:
    env = os.environ.get("MEETING_AUDIO_DEVICE", "").strip().lower()
    if env:
        return env
    try:
        import torch
        if torch.backends.mps.is_available():
            return "mps"
    except Exception:
        pass
    return "cpu"


def _load_asr():
    """加载「转写 + VAD + 标点 + 说话人分离」组合模型（懒加载）。"""
    global _ASR_MODEL
    if _ASR_MODEL is None:
        from funasr import AutoModel
        _ASR_MODEL = AutoModel(
            model="paraformer-zh",
            vad_model="fsmn-vad",
            punc_model="ct-punc-c",
            spk_model="cam++",
            device=_device(),
            disable_update=True,
        )
    return _ASR_MODEL


def _load_sv():
    """加载 CAM++ 说话人确认模型，用于提取声纹向量（懒加载）。"""
    global _SV_MODEL
    if _SV_MODEL is None:
        from funasr import AutoModel
        _SV_MODEL = AutoModel(
            model="iic/speech_campplus_sv_zh-cn_16k-common",
            device=_device(),
            disable_update=True,
        )
    return _SV_MODEL


def _load_asr_light():
    """轻量 ASR（无 VAD / 无说话人分离），用于实时段级转写，加载与推理更快。"""
    global _ASR_LIGHT
    if _ASR_LIGHT is None:
        from funasr import AutoModel
        _ASR_LIGHT = AutoModel(
            model="paraformer-zh",
            punc_model="ct-punc-c",
            device=_device(),
            disable_update=True,
        )
    return _ASR_LIGHT


def _load_asr_multilang():
    """加载多语言模型 SenseVoice（中文 / 粤语 / 英 / 日 / 韩 + 自动检测）。

    用于非普通话转写。注意：SenseVoice 不做说话人分离（CAM++ 是中文普通话声纹），
    故多语言转写时 segments 的 spk 恒为 -1（前端显示「说话人 ?」）。
    """
    global _ASR_MULTI
    if _ASR_MULTI is None:
        from funasr import AutoModel
        _ASR_MULTI = AutoModel(
            model="iic/SenseVoiceSmall",
            device=_device(),
            disable_update=True,
        )
    return _ASR_MULTI


# SenseVoice 输出带富文本标签（如 <|zh|><|NEUTRAL|><|Speech|><|woitn|>），需清洗
_RICH_TAG_RE = re.compile(r"<\|[^|]*\|>")


def _clean_sensevoice(text: str) -> str:
    return _RICH_TAG_RE.sub("", str(text or "")).strip()


def transcribe_light(pcm: np.ndarray, sr: int = 16000) -> str:
    """轻量转写一段已切分的语音（实时链路用），返回纯文本。"""
    if pcm is None or pcm.size == 0:
        return ""
    tmp = Path(tempfile.mkdtemp(prefix="meeting_audio_rt_")) / "seg.wav"
    _write_wav(np.asarray(pcm, dtype=np.float32), sr, tmp)
    try:
        res = _load_asr_light().generate(input=str(tmp), batch_size_s=30)
    finally:
        tmp.unlink(missing_ok=True)
        try:
            tmp.parent.rmdir()
        except OSError:
            pass
    if not res:
        return ""
    info = res[0]
    if isinstance(info, dict) and info.get("text"):
        return str(info["text"]).strip()
    return "".join((s.get("text") or "") for s in (info.get("sentence_info") or [])).strip()


# --------------------------------------------------------------------------- #
# 音频基础工具
# --------------------------------------------------------------------------- #
def load_audio(path, target_sr: int = 16000) -> np.ndarray:
    """解码为单声道 float32 PCM（目标采样率），兼容 wav/mp3/m4a/webm 等。

    说明：torchaudio 2.11 的 load() 已强制走 torchcodec 后端（忽略 backend 参数），
    故这里直接用 soundfile 解码 wav/flac/ogg，PyAV（ffmpeg）兜底压缩格式。
    """
    p = str(path)
    pcm = None
    sr = None
    # 1) soundfile：wav/flac/ogg（已随依赖安装，无需 ffmpeg）
    try:
        import soundfile as sf
        data, sr = sf.read(p, dtype="float32", always_2d=False)
        if data.ndim > 1:
            data = data.mean(axis=1)
        pcm = np.ascontiguousarray(data, dtype=np.float32)
    except Exception:
        pcm = None
    # 2) PyAV 兜底：mp3/m4a/webm 等压缩格式
    if pcm is None:
        import av
        with av.open(p) as container:
            streams = container.streams.audio
            if not streams:
                raise ValueError("没有可解码的音轨")
            resampler = av.AudioResampler(format="flt", layout="mono", rate=target_sr)
            chunks = []
            for frame in container.decode(streams[0]):
                chunks.extend(f.to_ndarray().reshape(-1) for f in resampler.resample(frame))
            chunks.extend(f.to_ndarray().reshape(-1) for f in resampler.resample(None))
        pcm = np.concatenate(chunks).astype(np.float32)
        sr = target_sr
    if pcm is None or pcm.size == 0:
        raise ValueError("音频为空")
    # 重采样到目标采样率
    if sr != target_sr:
        try:
            import torch
            import torchaudio
            w = torch.as_tensor(pcm, dtype=torch.float32).unsqueeze(0)
            w = torchaudio.functional.resample(w, sr, target_sr)
            pcm = w[0].detach().numpy().astype(np.float32)
        except Exception:
            import scipy.signal as sig
            n_out = int(round(pcm.size * target_sr / sr))
            pcm = sig.resample(pcm, n_out).astype(np.float32)
    return pcm


def _write_wav(pcm: np.ndarray, sr: int, path: Path) -> Path:
    import scipy.io.wavfile as wavfile
    audio = np.clip(pcm, -1.0, 1.0)
    wavfile.write(str(path), sr, (audio * 32767).astype(np.int16))
    return path


def denoise(pcm: np.ndarray, sr: int = 16000) -> np.ndarray:
    """谱减法降噪（noisereduce）。"""
    import noisereduce as nr
    return nr.reduce_noise(y=pcm, sr=sr).astype(np.float32)


# --------------------------------------------------------------------------- #
# 转写 + 说话人分离
# --------------------------------------------------------------------------- #
def transcribe(audio_path, denoise_first: bool = True, language: str = "zh"):
    """转写一段音频并做说话人分离（可多语言）。

    语言路由：
      - zh / 普通话 → paraformer-zh + CAM++（有说话人分离、声纹认人）
      - yue / en / ja / ko / auto 等 → SenseVoice 多语言模型（无说话人分离，spk 恒为 -1）

    返回 dict：
      text      全文
      segments  [{"start":s,"end":e,"text":t,"spk":i}, ...]
      speakers  [去重后的说话人编号]
      duration_seconds
    """
    src = Path(audio_path)
    pcm = load_audio(src)
    duration = round(float(pcm.size / 16000.0), 3)
    if duration < 0.15:
        raise ValueError("音频过短，请至少录制/上传 1 秒以上")

    lang = (language or "zh").strip().lower()
    is_zh = lang in ("", "zh", "zh-cn", "zh_cn", "cn", "mandarin", "chinese")
    model = _load_asr() if is_zh else _load_asr_multilang()
    # funasr 接受文件路径；降噪后先落临时 wav 再送入。
    if denoise_first:
        tmp = Path(tempfile.mkdtemp(prefix="meeting_audio_")) / "denoised.wav"
        _write_wav(denoise(pcm, 16000), 16000, tmp)
        input_arg = str(tmp)
    else:
        tmp = Path(tempfile.mkdtemp(prefix="meeting_audio_")) / "raw.wav"
        _write_wav(pcm, 16000, tmp)
        input_arg = str(tmp)

    try:
        if is_zh:
            res = model.generate(input=input_arg, batch_size_s=60)
        else:
            res = model.generate(input=input_arg, language=lang, batch_size_s=60)
    finally:
        for f in tmp.parent.iterdir():
            f.unlink(missing_ok=True)
        tmp.parent.rmdir()

    segments = []
    if res:
        info = res[0]
        for s in (info.get("sentence_info") or []):
            seg_text = (s.get("text") or "").strip()
            if not is_zh:
                seg_text = _clean_sensevoice(seg_text)
            segments.append({
                "start": round(float(s.get("start", 0)) / 1000.0, 3),
                "end": round(float(s.get("end", 0)) / 1000.0, 3),
                "text": seg_text,
                "spk": int(s.get("spk", -1)),
            })
    text = "".join(s["text"] for s in segments)
    speakers = sorted({s["spk"] for s in segments if s["spk"] >= 0})
    return {"text": text, "segments": segments, "speakers": speakers,
            "duration_seconds": duration}


# --------------------------------------------------------------------------- #
# 声纹：提取 / 注册 / 识别
# --------------------------------------------------------------------------- #
def _to_numpy(x) -> np.ndarray:
    """把任意结果（可能是 torch tensor，且可能位于 mps/cuda）转成 CPU float32 numpy。"""
    if hasattr(x, "detach"):  # torch.Tensor
        x = x.detach().cpu()
    return np.asarray(x, dtype=np.float32)


def _sv_embedding_from_result(out) -> np.ndarray:
    """从 CAM++ 输出里稳健地取出声纹向量（不同 funasr 版本字段名略有差异）。"""
    if not isinstance(out, dict):
        raise ValueError("声纹提取返回结构异常")
    for key in ("spk_embedding", "embedding", "emb", "feat"):
        if key in out and out[key] is not None:
            arr = _to_numpy(out[key]).reshape(-1)
            if arr.size >= 8:
                return arr
    for val in out.values():
        try:
            arr = _to_numpy(val)
        except Exception:
            continue
        if arr.ndim == 1 and arr.size >= 8:
            return arr
    raise ValueError("声纹提取结果中未找到向量")


def extract_embedding(pcm: np.ndarray, sr: int = 16000):
    """提取 CAM++ 声纹向量（返回 float 列表）。"""
    sv = _load_sv()
    res = sv.generate(input=pcm)
    if not res:
        raise ValueError("声纹提取失败")
    return _sv_embedding_from_result(res[0]).tolist()


def cosine(a, b) -> float:
    a = np.asarray(a, dtype=np.float32)
    b = np.asarray(b, dtype=np.float32)
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom == 0:
        return 0.0
    return float(np.dot(a, b) / denom)


def _load_profiles() -> dict:
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    meta = PROFILE_DIR / "index.json"
    if meta.exists():
        return json.loads(meta.read_text(encoding="utf-8"))
    return {}


def _save_profiles(profiles: dict) -> None:
    PROFILE_DIR.mkdir(parents=True, exist_ok=True)
    (PROFILE_DIR / "index.json").write_text(
        json.dumps(profiles, ensure_ascii=False, indent=2), encoding="utf-8")


def enroll(audio_path, name: str, speaker_id: str | None = None) -> dict:
    """注册一个人物：提取其声纹并存入本地声纹库。"""
    return enroll_pcm(load_audio(audio_path), name, speaker_id)


def enroll_pcm(pcm, name: str, speaker_id: str | None = None) -> dict:
    """从内存 PCM 数组注册声纹（实时链路「未知人声命名」用）。"""
    name = (name or "").strip()
    if not name:
        raise ValueError("请填写人物姓名")
    pcm = np.asarray(pcm, dtype=np.float32)
    if pcm.size / 16000.0 < 1.0:
        raise ValueError("注册音频过短，请录制/上传至少 1 秒的清晰人声")
    emb = [float(x) for x in extract_embedding(pcm)]
    profiles = _load_profiles()
    sid = speaker_id or uuid.uuid4().hex[:12]
    profiles[sid] = {
        "speaker_id": sid,
        "name": name,
        "embedding": emb,
        "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "duration_seconds": round(float(pcm.size / 16000.0), 2),
    }
    _save_profiles(profiles)
    return {"speaker_id": sid, "name": name, "duration_seconds": profiles[sid]["duration_seconds"]}


def list_speakers() -> list[dict]:
    return [{"speaker_id": k, "name": v["name"],
             "created_at": v.get("created_at", ""),
             "duration_seconds": v.get("duration_seconds", 0)}
            for k, v in _load_profiles().items()]


def delete_speaker(speaker_id: str) -> bool:
    profiles = _load_profiles()
    if speaker_id in profiles:
        del profiles[speaker_id]
        _save_profiles(profiles)
        return True
    return False


def identify(pcm: np.ndarray, profiles: dict, threshold: float = DEFAULT_SIM_THRESHOLD):
    """把一段人声与声纹库比对，返回最佳匹配。"""
    emb = extract_embedding(pcm)
    best_id, best_name, best_score = None, None, -1.0
    for sid, prof in profiles.items():
        s = cosine(emb, prof.get("embedding", []))
        if s > best_score:
            best_id, best_name, best_score = sid, prof.get("name"), s
    if best_score < threshold:
        return {"speaker_id": None, "name": None, "score": round(best_score, 4), "matched": False}
    return {"speaker_id": best_id, "name": best_name, "score": round(best_score, 4), "matched": True}


# --------------------------------------------------------------------------- #
# 一键处理入口：转写 + 分离 + 自动识别人物
# --------------------------------------------------------------------------- #
def process(audio_path, denoise_first: bool = True, threshold: float = DEFAULT_SIM_THRESHOLD, language: str = "zh") -> dict:
    """端到端处理：降噪 → 转写（可多语言）→ 说话人分离 → 与声纹库比对标注人名。"""
    profiles = _load_profiles()
    result = transcribe(audio_path, denoise_first=denoise_first, language=language)
    pcm = load_audio(audio_path)

    # 为每个分离出的说话人取代表音频段，做声纹识别
    speaker_map = {}
    per_spk_segments: dict[int, list[dict]] = {}
    for s in result["segments"]:
        if s["spk"] >= 0:
            per_spk_segments.setdefault(s["spk"], []).append(s)

    for spk, segs in per_spk_segments.items():
        # 取该说话人累计时长最长的一段（拼接相邻段，简化：取总时长最大的若干段拼接）
        total = sum(x["end"] - x["start"] for x in segs)
        segs_sorted = sorted(segs, key=lambda x: x["end"] - x["start"], reverse=True)
        picked = []
        acc = 0.0
        for x in segs_sorted:
            if acc >= 12.0:
                break
            picked.append(x)
            acc += x["end"] - x["start"]
        picked.sort(key=lambda x: x["start"])
        # 拼接代表音频
        chunks = []
        for x in picked:
            s_i = max(0, int(x["start"] * 16000))
            e_i = min(pcm.size, int(x["end"] * 16000))
            if e_i > s_i:
                chunks.append(pcm[s_i:e_i])
        if not chunks:
            speaker_map[spk] = {"spk": spk, "name": None, "matched": False,
                                "score": 0.0, "duration_seconds": round(total, 2)}
            continue
        rep = np.concatenate(chunks)
        if profiles:
            hit = identify(rep, profiles, threshold=threshold)
        else:
            hit = {"speaker_id": None, "name": None, "score": 0.0, "matched": False}
        speaker_map[spk] = {"spk": spk, "name": hit.get("name"),
                            "matched": bool(hit.get("matched")),
                            "score": hit.get("score", 0.0),
                            "duration_seconds": round(total, 2)}

    # 把 speaker 名回填到每个 segment
    for s in result["segments"]:
        m = speaker_map.get(s["spk"])
        s["speaker_name"] = (m or {}).get("name")
        s["speaker_matched"] = (m or {}).get("matched", False)

    result["speakers"] = [{"spk": spk, **{k: v for k, v in m.items() if k != "spk"}}
                          for spk, m in speaker_map.items()]
    result["speaker_profiles_count"] = len(profiles)
    return result
