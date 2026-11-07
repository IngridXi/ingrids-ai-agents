"""手动冒烟：向已启动的本机模型服务发送合成采访 PCM 帧并收集 turn 事件。"""
import asyncio
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import websockets

async def main():
    repo = Path(__file__).resolve().parent.parents[1]
    wav = repo / "knowledge-collection" / "ai-services" / "合成中文采访.wav"
    data, sr = sf.read(str(wav), dtype="float32")
    if data.ndim > 1:
        data = data.mean(axis=1)
    if sr != 16000:
        import scipy.signal as sig
        n = int(round(len(data) * 16000 / sr))
        data = sig.resample(data, n).astype(np.float32)
    # 模拟实时：只取前 12 秒
    data = data[: 12 * 16000]
    pcm = (np.clip(data, -1, 1) * 32767).astype(np.int16)

    uri = "ws://127.0.0.1:8951/realtime"
    turns = []
    async with websockets.connect(uri, max_size=8 * 1024 * 1024) as ws:
        print("READY:", await ws.recv())
        frame = 320  # 20ms
        for i in range(0, len(pcm), frame):
            await ws.send(pcm[i:i + frame].tobytes())
            # 模拟实时节奏：稍微放慢，让后端来得及处理
            if i % (frame * 10) == 0:
                await asyncio.sleep(0.01)
        await ws.send(json.dumps({"type": "stop"}))
        while True:
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=90)
            except asyncio.TimeoutError:
                print("TIMEOUT waiting for events")
                break
            obj = json.loads(msg)
            if obj.get("type") == "turn":
                turns.append(obj)
                print(f"  TURN [{obj['start']}-{obj['end']}] {obj['speaker_label']} (matched={obj['matched']}): {obj['text']}")
            elif obj.get("type") == "done":
                print("DONE")
                break
            else:
                print("  MSG:", obj)
    print(f"\n共收到 {len(turns)} 个 turn 事件")
    return 0 if turns else 1

if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
