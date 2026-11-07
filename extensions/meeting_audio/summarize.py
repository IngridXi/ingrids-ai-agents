"""会议总结与纪要生成：本地 Ollama（默认 qwen3:8b），会议内容零上云。

依赖：本机已运行 Ollama（http://127.0.0.1:11434）并已拉取模型。
无 Ollama / 无模型时降级为「规则化纪要」（基于转写文本提取，不用 LLM）。
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request

OLLAMA_URL = os.environ.get("MEETING_AUDIO_OLLAMA", "http://127.0.0.1:11434").rstrip("/")
DEFAULT_MODEL = os.environ.get("MEETING_AUDIO_LLM", "qwen3:8b")

_MINUTES_SYSTEM = (
    "你是一名专业的会议记录秘书。请根据给定的会议转写文本和旁注，生成一份结构清晰的中文会议纪要。"
    "只依据输入内容，不得虚构未出现的事实、数字、日期或人名。"
    "用 Markdown 输出，严格包含以下小节（用二级标题 ## ）："
    "## 会议主题（一句话概括）"
    "## 参会人（从说话人标注中列出，未知说话人写「说话人N」）"
    "## 摘要（3-5 句，概述讨论内容与结论）"
    "## 讨论要点（分条列出）"
    "## 决定事项（分条列出）"
    "## 待办事项（分条，尽量标注负责人与时间；没有明确负责人就写「待定」）"
)


def _chat(messages: list[dict], num_predict: int = 2048, temperature: float = 0.2) -> str:
    """调用本地 Ollama /api/chat，禁用思考，返回纯文本 content。"""
    payload = {
        "model": DEFAULT_MODEL,
        "messages": messages,
        "stream": False,
        "think": False,
        "options": {"num_predict": num_predict, "temperature": temperature},
    }
    req = urllib.request.Request(
        OLLAMA_URL + "/api/chat",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=600) as resp:  # 长纪要放宽超时
        data = json.loads(resp.read().decode("utf-8"))
    return (data.get("message") or {}).get("content", "").strip()


def available() -> bool:
    """Ollama 服务是否可用且模型存在。"""
    try:
        req = urllib.request.Request(OLLAMA_URL + "/api/tags", method="GET")
        with urllib.request.urlopen(req, timeout=5) as resp:
            tags = json.loads(resp.read().decode("utf-8"))
        names = {m.get("name", "") for m in tags.get("models", [])}
        return DEFAULT_MODEL in names or any(n.startswith(DEFAULT_MODEL.split(":")[0]) for n in names)
    except Exception:
        return False


def live_summary(transcript: str, notes: str = "") -> str:
    """实时小结：对当前转写给一句到三句的进展概括（轻量、快速）。"""
    if not available():
        return _rule_summary(transcript)
    text = (transcript or "").strip()
    if len(text) < 8:
        return "（内容还很少，继续录音，稍后会自动生成小结）"
    user = "以下是正在进行的会议实时转写：\n\n" + text[-4000:]
    if notes and notes.strip():
        user += "\n\n旁注：\n" + notes.strip()[-1500:]
    user += "\n\n请用 1-3 句中文概括目前讨论的主题、进展与已形成的结论。"
    try:
        return _chat([{"role": "user", "content": user}], num_predict=300, temperature=0.3)
    except Exception as e:  # noqa: BLE001
        return _rule_summary(transcript) + f"\n（LLM 暂不可用：{e}）"


def minutes(transcript: str, notes: str = "", speakers: list[dict] | None = None) -> str:
    """生成结构化会议纪要（Markdown）。"""
    if not available():
        return _rule_minutes(transcript, notes, speakers)
    text = (transcript or "").strip()
    if not text:
        return "（暂无转写内容，无法生成纪要）"
    user = "会议转写文本（含说话人标注）：\n\n" + text[-12000:]
    if notes and notes.strip():
        user += "\n\n会议旁注：\n" + notes.strip()[-3000:]
    if speakers:
        named = []
        for s in speakers:
            nm = s.get("name") or ("说话人" + str(s.get("spk", "?")))
            named.append(nm)
        user += "\n\n识别到的说话人：" + "、".join(named)
    user += "\n\n请生成会议纪要。"
    try:
        return _chat(
            [{"role": "system", "content": _MINUTES_SYSTEM}, {"role": "user", "content": user}],
            num_predict=2048, temperature=0.2,
        )
    except Exception as e:  # noqa: BLE001
        return _rule_minutes(transcript, notes, speakers) + f"\n\n> 说明：本地 LLM 暂不可用（{e}），以上为规则化纪要。"


# --------------------------------------------------------------------------- #
# 无 LLM 的规则化降级
# --------------------------------------------------------------------------- #
def _split_sentences(text: str) -> list[str]:
    text = re.sub(r"\s+", "", text or "")
    return [s for s in re.split(r"[。！？!?；;]", text) if len(s) >= 4]


def _rule_summary(transcript: str) -> str:
    sents = _split_sentences(transcript)
    if not sents:
        return "（内容还很少，继续录音后会自动生成小结）"
    return "；".join(sents[-3:])


def _rule_minutes(transcript: str, notes: str, speakers: list[dict] | None) -> str:
    sents = _split_sentences(transcript)
    named = []
    if speakers:
        named = [s.get("name") or f"说话人{s.get('spk', '?')}" for s in speakers]
    head = "## 会议主题\n（由规则化生成，主题待人工确认）\n\n"
    att = "## 参会人\n" + ("、".join(named) if named else "（未标注）") + "\n\n"
    summary = "## 摘要\n" + ("；".join(sents[:5]) if sents else "（暂无）") + "\n\n"
    points = "## 讨论要点\n" + "\n".join(f"- {s}" for s in sents[:10]) + "\n\n"
    decision = "## 决定事项\n- （待人工确认）\n\n"
    action = "## 待办事项\n- （待人工确认）\n"
    if notes and notes.strip():
        action = "## 待办事项\n" + "\n".join(f"- {x.strip()}" for x in notes.strip().splitlines() if x.strip()) + "\n"
    return head + att + summary + points + decision + action
