"""Local-only forced alignment. NDJSON over stdin/stdout; no audio leaves this Mac."""
import base64
import io
import json
import re
import os
from pathlib import Path
import sys

# Keep model/library logging out of the machine-readable protocol.
protocol = sys.stdout
sys.stdout = sys.stderr
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
import numpy as np
import soundfile as sf
import torch
from qwen_asr import Qwen3ForcedAligner
from alignment_consensus import repair_short_tokens

root = Path(__file__).resolve().parent.parent
device = "mps" if torch.backends.mps.is_available() else "cpu"
torch.set_num_threads(4)
model = Qwen3ForcedAligner.from_pretrained(
    str(root / ".alignment-model"), device_map=device,
    dtype=torch.float32, attn_implementation="eager",
)

short_aligner = None

for line in sys.stdin:
    try:
        request = json.loads(line)
        audio, rate = sf.read(io.BytesIO(base64.b64decode(request["audio"], validate=True)), dtype="float32")
        if rate != 16000 or audio.ndim != 1 or not 0.02 <= len(audio) / rate <= 40:
            raise ValueError("需要 16kHz 单声道、最长 40 秒的音频片段")
        if not np.isfinite(audio).all() or np.max(np.abs(audio)) < 0.0001:
            raise ValueError("这一段没有可对齐的有效声音")
        # The model uses an 80ms timestamp grid. Shift the audio origin in four
        # 20ms steps and combine predictions in source coordinates. This reduces
        # grid-phase sensitivity; it does not imply 20ms ground-truth accuracy.
        views = []
        offsets = [0.0, 0.02, 0.04, 0.06]
        with torch.inference_mode():
            for offset in offsets:
                padded = np.pad(audio, (round(offset * rate), round((0.08 - offset) * rate)))
                views.append(list(model.align(audio=(padded, rate), text=request["text"], language="Chinese")[0]))
        words = []
        for i, token in enumerate(views[0]):
            if any(len(v) != len(views[0]) or v[i].text != token.text for v in views):
                raise ValueError("不同音频窗口的文字序列不一致")
            starts = [max(0, v[i].start_time - offset) for v, offset in zip(views, offsets)]
            ends = [min(len(audio) / rate, max(0, v[i].end_time - offset)) for v, offset in zip(views, offsets)]
            spread = max(max(starts) - min(starts), max(ends) - min(ends))
            collapsed = sum(end - start < 0.02 for start, end in zip(starts, ends))
            words.append({"text": token.text, "start": round(float(np.mean(starts)), 5),
                          "end": round(float(np.mean(ends)), 5),
                          "review": spread > 0.18 or collapsed >= 3})
        try:
            if any(w["review"] for w in words) and all(re.fullmatch(r"[\u3400-\u9fff]", w["text"]) for w in words):
                if short_aligner is None:
                    from funasr import AutoModel
                    short_aligner = AutoModel(model=str(root / ".alignment-model/fa-zh"), device="cpu",
                                              disable_update=True, disable_pbar=True, trust_remote_code=False, ncpu=4)
                secondary = short_aligner.generate(input=(audio, " ".join(w["text"] for w in words)),
                                                   data_type=("sound", "text"), fs=rate)[0]
                if secondary["text"].replace(" ", "") == "".join(w["text"] for w in words):
                    words = repair_short_tokens(words, secondary["timestamp"], len(audio) / rate)
        except Exception as secondary_error:
            print("Short-token check unavailable:", str(secondary_error)[:160], file=sys.stderr)
        payload = {"words": words, "model": "qwen3-forced-aligner-0.6b", "passes": 4}
    except Exception as exc:
        payload = {"error": str(exc)[:400]}
    print(json.dumps(payload, ensure_ascii=False), file=protocol, flush=True)
