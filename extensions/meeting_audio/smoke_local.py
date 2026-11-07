"""真实端到端冒烟：转写 + 说话人分离 + 声纹注册/识别。

前置：bash setup.sh && .venv/bin/python prepare_models.py
用法：.venv/bin/python smoke_local.py [音频路径]
默认用 knowledge-collection/ai-services/合成中文采访.wav（单人采访，可验转写与声纹；
多人分离请另备多人会议音频）。
"""
import sys
import time
from pathlib import Path

import meeting_audio as ma


def main() -> int:
    here = Path(__file__).resolve().parent
    repo = here.parents[1]
    audio = Path(sys.argv[1]) if len(sys.argv) > 1 else repo / 'knowledge-collection' / 'ai-services' / '合成中文采访.wav'
    if not audio.exists():
        print(f"音频不存在：{audio}")
        return 1

    print("==> 1) 转写（含说话人分离）")
    t0 = time.time()
    r = ma.transcribe(str(audio), denoise_first=True)
    print(f"    用时 {time.time() - t0:.1f}s · {len(r['segments'])} 段 · 说话人 {r['speakers']}")
    for s in r["segments"][:6]:
        print(f"    [{s['start']:.1f}-{s['end']:.1f}] spk{s['spk']}: {s['text']}")

    print("==> 2) 声纹注册（用同一段音频，名字「冒烟测试」）")
    out = ma.enroll(str(audio), "冒烟测试")
    print("    已登记:", out["speaker_id"], out["name"], f"{out['duration_seconds']}s")

    print("==> 3) 声纹识别（同一段音频应命中）")
    pcm = ma.load_audio(str(audio))
    hit = ma.identify(pcm, ma._load_profiles())
    print("    命中:", hit)

    print("==> 4) 一键 process（转写 + 分离 + 认人）")
    full = ma.process(str(audio))
    print("    说话人标注:", [(s["spk"], s.get("name"), s.get("score")) for s in full["speakers"]])

    ma.delete_speaker(out["speaker_id"])
    print("==> 完成，已清理测试声纹")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
