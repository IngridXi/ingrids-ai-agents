"""一次性下载会议录音处理所需的公开模型权重（来自 ModelScope，国内可达）。

在首次推理前显式运行一次；后续推理走本地缓存，不再联网。
模型均来自阿里达摩院开源的 FunASR 生态，权重许可以各模型卡为准。
模型 ID 与 funasr 当前版本的 name_maps 保持一致（见 funasr/download/name_maps_from_hub.py）。
"""
import sys
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


def main() -> int:
    ok = True
    for label, model_id in MODELS.items():
        print(f"[{label}] 下载 {model_id} …", flush=True)
        try:
            local = snapshot_download(model_id)
            print(f"   -> {local}")
        except Exception as e:  # noqa: BLE001
            print(f"   !! 下载失败：{e}", file=sys.stderr)
            ok = False
    print("完成。" if ok else "存在失败项，请检查网络后重试。")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
