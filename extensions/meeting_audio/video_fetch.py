"""视频链接 → 字幕 / 音频（字幕优先，无字幕才下载音频交给 ASR 兜底）。

多平台抓取依赖 yt-dlp（YouTube / Bilibili / 抖音 / 小红书 / 小宇宙 / 微博视频等）。
本地文件不下载，直接交给会议纪要官的转写链路处理。

对外主入口 fetch(url_or_path, workdir=None)，返回统一 dict：
    source      "subtitle"（抓到字幕）| "audio"（需转写，audio_path 有效）
    title       视频标题（本地文件用文件名）
    text        纯文本（字幕源时有效；audio 源为空串）
    segments    [{"start":秒,"end":秒,"text":str}, ...]（字幕源带时间戳）
    audio_path  音频路径（audio 源时有效）
    workdir     本次下载/解析用的临时目录（调用方负责清理）
    meta        附加信息（语言、字幕来源、是否本地文件等）
"""
from __future__ import annotations

import re
import tempfile
import urllib.request
from pathlib import Path

# 字幕语言偏好：简中 → 繁中 → 粤语 → 英/日/韩
_PREFERRED_LANGS = ["zh-Hans", "zh-CN", "zh", "zh-Hant", "zh-TW", "yue", "en", "ja", "ko"]


def _load_ytdlp():
    try:
        import yt_dlp  # noqa: PLC0415
        return yt_dlp
    except ImportError as e:  # pragma: no cover
        raise RuntimeError("未安装 yt-dlp，请先运行 setup.sh 或 `pip install yt-dlp`") from e


def is_url(s: str) -> bool:
    s = (s or "").strip()
    return s.startswith(("http://", "https://", "www."))


# 微信视频号（视频号 / 视频号直播回放 / 分享短链 sph）yt-dlp 无法解析：视频真实地址需微信登录态 +
# 动态签名 + JS 动态加载，抓取门槛高。单独识别，给出可操作的替代方案，而不是甩一个 Unsupported URL。
_WEIXIN_CHANNELS_RE = re.compile(
    r"(weixin\.qq\.com/sph|channels\.weixin\.qq\.com|weixin\.qq\.com/flnder|finder\.video\.qq\.com)",
    re.I,
)


def _platform_hint(url: str) -> str | None:
    """对 yt-dlp 不支持但用户常见的平台，返回针对性指引；支持则返回 None。"""
    if _WEIXIN_CHANNELS_RE.search(url):
        return (
            "微信视频号暂不支持自动抓取（视频号视频需要微信登录态和动态签名，无法直接解析）。"
            "请在微信里把该视频「转发 → 保存到手机/电脑」得到 mp4 文件后，"
            "点「选择本地视频」导入总结；或改用 YouTube / B站 / 抖音 / 小红书等平台链接。"
        )
    return None


def _friendly_dlp_error(e: Exception) -> str:
    msg = str(e).replace("ERROR: ", "").strip()
    msg = re.sub(r"\s+", " ", msg)
    if "Unsupported URL" in msg or "No suitable extractor" in msg or "no suitable extractor" in msg:
        return "暂不支持该链接/平台：" + msg
    return "视频抓取失败：" + msg


def _extract_info(url: str) -> dict:
    # 先做平台识别（无需 yt-dlp），不支持直接友好拦截；再加载 yt-dlp 解析支持的平台。
    hint = _platform_hint(url)
    if hint:
        raise ValueError(hint)
    yt_dlp = _load_ytdlp()
    opts = {"skip_download": True, "quiet": True, "no_warnings": True, "noplaylist": True}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            return ydl.extract_info(url, download=False)
    except yt_dlp.utils.UnsupportedError as e:
        raise ValueError(_friendly_dlp_error(e)) from e
    except yt_dlp.utils.DownloadError as e:
        raise ValueError(_friendly_dlp_error(e)) from e


def _pick_subtitle(info: dict):
    """优先人工字幕，其次自动字幕；语言按偏好；返回 (来源, 语言, 格式列表)。"""
    subs = info.get("subtitles") or {}
    autos = info.get("automatic_captions") or {}
    for src_name, src in (("subtitles", subs), ("automatic_captions", autos)):
        if not src:
            continue
        for lang in _PREFERRED_LANGS:
            if lang in src and src[lang]:
                return src_name, lang, src[lang]
        for lang, entries in src.items():
            if entries:
                return src_name, lang, entries
    return None, None, None


def _fmt_to_text(fmt):
    """从字幕格式列表里挑 vtt/srt（含下载 URL），返回 (ext, url)。"""
    for ext in ("vtt", "srt"):
        for e in fmt:
            if e.get("ext") == ext and e.get("url"):
                return ext, e["url"]
    for e in fmt:
        if e.get("url"):
            return (e.get("ext") or "vtt"), e["url"]
    return None, None


def _parse_ts(s: str) -> float:
    s = s.strip().replace(",", ".")
    parts = s.split(":")
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    try:
        return float(s)
    except ValueError:
        return 0.0


def _parse_subtitle(raw: str, ext: str) -> list[dict]:
    """把 VTT/SRT 文本解析成 [{"start":秒,"end":秒,"text":str}, ...]，去掉时间轴与元数据。"""
    lines = raw.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    segments: list[dict] = []
    cur_start = cur_end = None
    buf: list[str] = []

    def flush():
        nonlocal buf, cur_start, cur_end
        txt = " ".join(buf).strip()
        # 去掉 VTT 内联标签 <c>...</c>、<00:00:00.000> 等
        txt = re.sub(r"<[^>]+>", "", txt)
        if txt and cur_start is not None:
            segments.append({"start": round(cur_start, 3), "end": round(cur_end or cur_start, 3), "text": txt})
        buf = []

    ts_re = re.compile(r"(\d{1,2}:)?\d{1,2}:\d{1,2}[.,]\d{1,3}\s*-->\s*(\d{1,2}:)?\d{1,2}:\d{1,2}[.,]\d{1,3}")
    for line in lines:
        m = ts_re.search(line)
        if m:
            flush()
            left, right = line.split("-->")
            cur_start = _parse_ts(left.strip())
            cur_end = _parse_ts(right.strip())
        elif line.strip() == "":
            flush()
        elif line.strip().isdigit() or line.strip().startswith("WEBVTT") or line.strip().startswith("NOTE"):
            # SRT 序号 / VTT 头 / 注释行，跳过
            continue
        else:
            buf.append(line.strip())
    flush()
    return segments


def _download_audio(url: str, workdir: Path, ydl) -> str:
    """下载最佳音轨（不转码，交给 load_audio 用 soundfile/PyAV 解码），返回音频路径。"""
    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(workdir / "%(id)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
    }
    with ydl.YoutubeDL(opts) as y:
        info = y.extract_info(url, download=True)
        return y.prepare_filename(info)


def fetch(url_or_path: str, workdir: str | Path | None = None) -> dict:
    target = (url_or_path or "").strip()
    if not target:
        raise ValueError("请输入视频链接或本地文件路径")
    wd = Path(workdir) if workdir else Path(tempfile.mkdtemp(prefix="video_fetch_"))
    wd.mkdir(parents=True, exist_ok=True)

    # 本地文件：不下载，直接交转写链路
    if not is_url(target):
        p = Path(target).expanduser()
        if not p.exists():
            raise ValueError("文件不存在：" + target)
        return {
            "source": "audio",
            "title": p.stem,
            "text": "",
            "segments": [],
            "audio_path": str(p),
            "workdir": str(wd),
            "meta": {"local": True},
        }

    info = _extract_info(target)
    title = info.get("title") or "未命名视频"

    # 1) 字幕优先
    src_name, lang, fmt = _pick_subtitle(info)
    if fmt:
        ext, sub_url = _fmt_to_text(fmt)
        if sub_url:
            try:
                req = urllib.request.Request(sub_url, headers={"User-Agent": "Mozilla/5.0"})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    raw = resp.read().decode("utf-8", errors="ignore")
                segments = _parse_subtitle(raw, ext)
                text = " ".join(s["text"] for s in segments)
                return {
                    "source": "subtitle",
                    "title": title,
                    "text": text,
                    "segments": segments,
                    "audio_path": None,
                    "workdir": str(wd),
                    "meta": {"lang": lang, "sub_source": src_name, "format": ext, "url": target},
                }
            except Exception:
                pass  # 字幕下载失败 → 继续走音频兜底

    # 2) 无字幕 → 下载音频兜底
    yt_dlp = _load_ytdlp()
    try:
        audio_path = _download_audio(target, wd, yt_dlp)
    except (yt_dlp.utils.DownloadError, yt_dlp.utils.UnsupportedError) as e:
        raise ValueError(_friendly_dlp_error(e)) from e
    return {
        "source": "audio",
        "title": title,
        "text": "",
        "segments": [],
        "audio_path": audio_path,
        "workdir": str(wd),
        "meta": {"local": False, "url": target},
    }
