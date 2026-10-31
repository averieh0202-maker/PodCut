#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Isolated runtime, official model weights. Application inference is offline.
PYTHON_BIN="${ALIGNMENT_PYTHON:-python3.12}"
"$PYTHON_BIN" -m venv .alignment-venv
.alignment-venv/bin/pip install -r scripts/alignment-requirements.txt
.alignment-venv/bin/python - <<'PY'
from modelscope import snapshot_download
snapshot_download('Qwen/Qwen3-ForcedAligner-0.6B', local_dir='.alignment-model',
                  allow_patterns=['*.json', '*.safetensors', '*.txt', '*.model', 'LICENSE*', 'NOTICE*', 'README.md'])
snapshot_download('iic/speech_timestamp_prediction-v1-16k-offline', local_dir='.alignment-model/fa-zh',
                  allow_patterns=['*.json', '*.yaml', '*.pt', '*.txt', '*.mvn', 'LICENSE*', 'NOTICE*', 'README.md'])
PY
echo '本机逐字对齐模型已就绪。重启 npm run dev 后使用。'
