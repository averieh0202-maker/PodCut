#!/usr/bin/env python3
"""Generate demo Chinese podcast WAV + word-level transcript JSON."""
import asyncio, json, struct, wave, os
from pathlib import Path

import edge_tts

# Phrases with intentional gaps (seconds) AFTER each phrase
PHRASES = [
    ("大家好，欢迎收听今天的播客。", 0.85),
    ("今天我们来聊聊如何提升工作效率。", 1.05),
    ("嗯，这个话题其实挺有意思的。", 0.7),
    ("首先呢，我觉得专注力是最关键的。", 0.95),
    ("好了，我们下期再见。", 0.0),
]

VOICE = "zh-CN-YunyangNeural"
OUT_DIR = Path(__file__).resolve().parents[1] / "public" / "demo"
import tempfile
TMP = Path(tempfile.mkdtemp(prefix="podcut-demo-"))
OUT_DIR.mkdir(parents=True, exist_ok=True)

def pcm_silence(duration_s: float, rate=24000) -> bytes:
    n = int(duration_s * rate)
    return b"\x00\x00" * n

def read_wav_pcm(path: Path):
    with wave.open(str(path), "rb") as w:
        assert w.getnchannels() == 1
        rate = w.getframerate()
        sampwidth = w.getsampwidth()
        frames = w.readframes(w.getnframes())
        duration = w.getnframes() / rate
    return frames, rate, sampwidth, duration

async def synth_phrase(text: str, out_mp3: Path):
    communicate = edge_tts.Communicate(text, VOICE)
    await communicate.save(str(out_mp3))

def mp3_to_wav(mp3: Path, wav: Path, rate=24000):
    import subprocess
    subprocess.check_call([
        "ffmpeg", "-y", "-i", str(mp3),
        "-ac", "1", "-ar", str(rate), "-sample_fmt", "s16",
        str(wav)
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def chars_of(text: str):
    """Split into character-level tokens (Chinese chars + punctuation as tokens)."""
    tokens = []
    for ch in text:
        if ch.strip() == "":
            continue
        tokens.append(ch)
    return tokens

async def main():
    rate = 24000
    all_pcm = b""
    words = []
    t = 0.0  # seconds

    for i, (text, gap_after) in enumerate(PHRASES):
        mp3 = TMP / f"p{i}.mp3"
        wav = TMP / f"p{i}.wav"
        await synth_phrase(text, mp3)
        mp3_to_wav(mp3, wav, rate)
        pcm, r, sw, dur = read_wav_pcm(wav)
        assert r == rate

        tokens = chars_of(text)
        # Distribute time across tokens; leave tiny lead-in/out
        lead = 0.04
        usable = max(dur - lead * 2, 0.05)
        per = usable / len(tokens)
        phrase_start = t
        t += lead
        for tok in tokens:
            start = t
            end = t + per
            words.append({
                "text": tok,
                "start": round(start, 3),
                "end": round(end, 3),
            })
            t = end
        t = phrase_start + dur  # sync to actual audio end
        # Fix last word end to phrase end
        if words:
            words[-1]["end"] = round(t, 3)

        all_pcm += pcm

        if gap_after > 0:
            all_pcm += pcm_silence(gap_after, rate)
            t += gap_after

    out_wav = OUT_DIR / "sample.wav"
    with wave.open(str(out_wav), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(all_pcm)

    full_text = "".join(p[0] for p in PHRASES)
    transcript = {
        "language": "zh-CN",
        "audio": "demo/sample.wav",
        "duration": round(t, 3),
        "text": full_text,
        "words": words,
        "note": "演示稿：含故意插入的句间停顿，便于测试「一键清除停顿」",
    }
    with open(OUT_DIR / "transcript.json", "w", encoding="utf-8") as f:
        json.dump(transcript, f, ensure_ascii=False, indent=2)

    print(f"WAV: {out_wav} ({out_wav.stat().st_size} bytes)")
    print(f"Duration: {t:.2f}s, words: {len(words)}")
    print(f"Text: {full_text}")

asyncio.run(main())
