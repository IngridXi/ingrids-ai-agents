#!/usr/bin/env bash
# 会议录音处理（meeting_audio）后端依赖安装脚本
# 技术路线：本地开源、离线推理、无云 API
#   - 降噪           noisereduce（纯 numpy）
#   - 语音转写        FunASR Paraformer-zh（中文强，带时间戳）
#   - 说话人分离      FunASR CAM++（spk_model）
#   - 说话人识别/声纹 FunASR CAM++（提取声纹向量 → 余弦比对）
# 首次使用会从 ModelScope 下载模型权重（国内可达），见 prepare_models.py。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VENV="$HERE/.venv"
PY="${PYTHON:-python3}"

echo "==> Python: $("$PY" --version 2>&1)"
if [ ! -d "$VENV" ]; then
  echo "==> 创建虚拟环境 $VENV"
  "$PY" -m venv "$VENV"
fi
"$VENV/bin/pip" install --upgrade pip -q

echo "==> [1/3] 安装 torch / torchaudio（macOS arm64 用 MPS，无 GPU 自动回退 CPU）"
"$VENV/bin/pip" install torch torchaudio

echo "==> [2/3] 安装 funasr / modelscope / noisereduce / python-pptx / websockets"
"$VENV/bin/pip" install funasr modelscope noisereduce numpy python-pptx websockets

echo "==> [3/3] 验证导入"
"$VENV/bin/python" - <<'PY'
import torch
print("torch", torch.__version__, "| mps:", torch.backends.mps.is_available())
import funasr
print("funasr", getattr(funasr, "__version__", "ok"))
import modelscope, noisereduce, pptx, websockets
print("modelscope / noisereduce / python-pptx / websockets 导入正常")
print("依赖安装完成 ✓（实时总结与纪要还需本机 Ollama 运行 qwen3:8b）")
PY

echo "==> 下一步：下载模型权重"
echo "    $VENV/bin/python prepare_models.py"
