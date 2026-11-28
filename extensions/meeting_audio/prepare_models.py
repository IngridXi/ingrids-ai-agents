"""一次性下载会议录音处理所需的公开模型权重（来自 ModelScope，国内可达）。

在首次推理前显式运行一次；后续推理走本地缓存，不再联网。
模型均来自阿里达摩院开源的 FunASR 生态，权重许可以各模型卡为准。
模型 ID 与 funasr 当前版本的 name_maps 保持一致（见 funasr/download/name_maps_from_hub.py）。
"""
import sys
import time
from modelscope import snapshot_download

MODELS = {
    # 语音转写（中文，带句级时间戳；seaco 热词增强版）
    "paraformer-zh": "iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch",
    # 语音活动检测 VAD
    "fsmn-vad": "iic/speech_fsmn_vad_zh-cn-16k-common-pytorch",
    # 标点恢复（中文小模型 ct-punc-c）
    "ct-punc-c": "iic/punc_ct-transformer_zh-cn-common-vocab272727-pytorch",
    # 说话人分离 + 声纹（CAM++，funasr 中 spk_model="cam++" 与声纹模型同源）
    "cam++": "iic/speech_campplus_sv_zh-cn_16k-common",
}

# ModelScope 对高频请求会返回 403「操作过于频繁」，逐模型重试 + 指数退避即可下完。
MAX_ATTEMPTS = 6          # 每个模型最多尝试 6 次
BASE_DELAY = 12.0         # 首次重试等待 12 秒，之后翻倍


def _download(model_id: str) -> str:
    last_err = None
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return snapshot_download(model_id)
        except Exception as e:  # noqa: BLE001
            last_err = e
            msg = str(e)
            throttled = ('403' in msg) or ('频繁' in msg) or ('稍后再试' in msg) or ('10013201001' in msg)
            if attempt < MAX_ATTEMPTS:
                delay = BASE_DELAY * (2 ** (attempt - 1))
                hint = '（限流，稍候重试）' if throttled else '（网络异常）'
                print(f"     第 {attempt} 次失败{hint}，{delay:.0f} 秒后重试…", flush=True)
                time.sleep(delay)
            else:
                return None
    return None if last_err else None


def main() -> int:
    ok = True
    for label, model_id in MODELS.items():
        print(f"[{label}] 下载 {model_id} …", flush=True)
        local = _download(model_id)
        if local:
            print(f"   -> {local}")
        else:
            print(f"   !! 多次重试仍失败：{model_id}", file=sys.stderr)
            ok = False
        time.sleep(3)  # 模型之间稍作停顿，避免连续请求触发限流
    print("完成。" if ok else "存在失败项，稍后重新运行本脚本即可（已下载的会走缓存）。")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
