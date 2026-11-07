"""会议录音处理扩展包（本地离线，无云依赖）。"""
from .meeting_audio import (
    transcribe, enroll, identify, process, list_speakers, delete_speaker,
    extract_embedding, denoise, cosine,
)

__all__ = [
    "transcribe", "enroll", "identify", "process", "list_speakers",
    "delete_speaker", "extract_embedding", "denoise", "cosine",
]
