#!/usr/bin/env python3
"""Generate original tech/premium podcast beds (numpy + optional ffmpeg polish)."""
from __future__ import annotations

import os
import subprocess
import wave

import numpy as np

SR = 48000
OUT = os.path.join(os.path.dirname(__file__), "..", "public", "sfx")


def soft_clip(x: np.ndarray, drive: float = 1.0) -> np.ndarray:
    return np.tanh(x * drive)


def lowpass_1pole(x: np.ndarray, cutoff: float, sr: int) -> np.ndarray:
    rc = 1.0 / (2 * np.pi * cutoff)
    dt = 1.0 / sr
    a = dt / (rc + dt)
    y = np.zeros_like(x)
    for i in range(1, len(x)):
        y[i] = y[i - 1] + a * (x[i] - y[i - 1])
    return y


def highpass_1pole(x: np.ndarray, cutoff: float, sr: int) -> np.ndarray:
    rc = 1.0 / (2 * np.pi * cutoff)
    dt = 1.0 / sr
    a = rc / (rc + dt)
    y = np.zeros_like(x)
    for i in range(1, len(x)):
        y[i] = a * (y[i - 1] + x[i] - x[i - 1])
    return y


def env_adsr(n: int, sr: int, a=0.02, d=0.1, s=0.7, r=0.3) -> np.ndarray:
    out = np.ones(n)
    na = int(a * sr)
    if na > 0:
        out[:na] = np.linspace(0, 1, na)
    nd = int(d * sr)
    if nd > 0 and na + nd < n:
        out[na : na + nd] = np.linspace(1, s, nd)
    sustain_end = n - int(r * sr)
    if na + nd < sustain_end:
        out[na + nd : sustain_end] = s
    nr = n - sustain_end
    if nr > 0:
        start = s if sustain_end > 0 else 1.0
        out[sustain_end:] = np.linspace(start, 0, nr)
    return out


def pad_voice(dur: float, sr: int, root: float = 110.0, brightness: float = 0.35) -> np.ndarray:
    n = int(dur * sr)
    t = np.arange(n) / sr
    partials = [
        (root, 0.55),
        (root * 1.5, 0.22),
        (root * 2.0, 0.18),
        (root * 2.996, 0.08),
        (root * 4.02, 0.04),
    ]
    out = np.zeros(n)
    for f, a in partials:
        det = 1.0 + 0.0015 * np.sin(2 * np.pi * 0.07 * t + f * 0.01)
        phase = 2 * np.pi * f * np.cumsum(det) / sr
        out += a * np.sin(phase)
    shimmer = (
        0.04
        * brightness
        * np.sin(2 * np.pi * root * 8.03 * t + 0.3 * np.sin(2 * np.pi * 0.11 * t))
    )
    shimmer *= 0.5 + 0.5 * np.sin(2 * np.pi * 0.23 * t)
    out += shimmer
    breathe = 0.78 + 0.22 * np.sin(2 * np.pi * 0.09 * t)
    return soft_clip(out * breathe * 0.55)


def subtle_pulse(dur: float, sr: int, bpm: float = 72, tone: float = 55.0) -> np.ndarray:
    n = int(dur * sr)
    out = np.zeros(n)
    beat = 60.0 / bpm
    t0 = 0.0
    while t0 < dur:
        i0 = int(t0 * sr)
        length = int(0.18 * sr)
        if i0 >= n:
            break
        seg = np.arange(min(length, n - i0)) / sr
        env = np.exp(-seg * 18)
        thump = np.sin(2 * np.pi * tone * seg) * env * 0.22
        tick = np.sin(2 * np.pi * 1800 * seg) * np.exp(-seg * 90) * 0.015
        out[i0 : i0 + len(seg)] += thump + tick
        t0 += beat
    return out


def sparse_melody(dur, sr, notes, start=0.4, note_dur=0.55, gap=0.85):
    n = int(dur * sr)
    out = np.zeros(n)
    t_pos = start
    for f in notes:
        if t_pos + 0.05 >= dur:
            break
        i0 = int(t_pos * sr)
        length = int(min(note_dur, dur - t_pos) * sr)
        if i0 + length > n:
            length = n - i0
        seg = np.arange(length) / sr
        env = np.exp(-seg * 2.8) * (1 - np.exp(-seg * 80))
        tone = (
            0.55 * np.sin(2 * np.pi * f * seg)
            + 0.22 * np.sin(2 * np.pi * f * 2.01 * seg)
            + 0.08 * np.sin(2 * np.pi * f * 3.97 * seg)
            + 0.04 * np.sin(2 * np.pi * f * 5.4 * seg)
        )
        out[i0 : i0 + length] += tone * env * 0.28
        t_pos += gap
    return out


def noise_whoosh(dur: float, sr: int, rise: bool = True) -> np.ndarray:
    n = int(dur * sr)
    rng = np.random.default_rng(42)
    noise = rng.standard_normal(n)
    noise = highpass_1pole(noise, 400, sr)
    noise = lowpass_1pole(noise, 6000, sr)
    t = np.arange(n) / sr
    if rise:
        env = (t / dur) ** 1.6
        chirp = np.sin(2 * np.pi * (180 + 900 * (t / dur) ** 1.3) * t) * 0.15 * env
    else:
        env = ((dur - t) / dur) ** 1.4
        chirp = np.sin(2 * np.pi * (900 - 600 * (t / dur)) * t) * 0.12 * env
    return (noise * 0.35 * env + chirp) * 0.55


def stereoize(mono: np.ndarray, sr: int, width: float = 0.18) -> np.ndarray:
    n = len(mono)
    delay = int(0.012 * sr)
    L = mono.copy()
    R = np.zeros(n)
    R[delay:] = mono[:-delay] * 0.92
    R[:delay] = mono[:delay] * 0.3
    mid = 0.5 * (L + R)
    side = 0.5 * (L - R) * (1 + width * 4)
    return np.stack([mid + side, mid - side], axis=1)


def normalize_peak(x: np.ndarray, peak: float = 0.72) -> np.ndarray:
    m = np.max(np.abs(x))
    return x if m < 1e-9 else x * (peak / m)


def fade_edges(x: np.ndarray, sr: int, fade_in: float = 0.05, fade_out: float = 0.4) -> np.ndarray:
    n = len(x)
    fi = int(fade_in * sr)
    fo = int(fade_out * sr)
    if x.ndim == 1:
        if fi > 0:
            x[:fi] *= np.linspace(0, 1, fi)
        if fo > 0:
            x[-fo:] *= np.linspace(1, 0, fo)
    else:
        if fi > 0:
            x[:fi] *= np.linspace(0, 1, fi)[:, None]
        if fo > 0:
            x[-fo:] *= np.linspace(1, 0, fo)[:, None]
    return x


def write_wav_stereo(path: str, stereo: np.ndarray, sr: int) -> None:
    pcm = (np.clip(stereo, -1.0, 1.0) * 32767.0).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def ffmpeg_limit(path: str) -> None:
    tmp = path + ".tmp.wav"
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            path,
            "-af",
            "alimiter=limit=0.85:attack=5:release=50",
            "-ar",
            str(SR),
            "-ac",
            "2",
            "-c:a",
            "pcm_s16le",
            tmp,
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    os.replace(tmp, path)


def main() -> None:
    os.makedirs(OUT, exist_ok=True)

    dur_o = 11.5
    pad = pad_voice(dur_o, SR, root=98.0, brightness=0.4)
    pulse = subtle_pulse(dur_o, SR, bpm=66, tone=49.0)
    mel = sparse_melody(dur_o, SR, [220.0, 261.63, 329.63, 392.0, 440.0], start=1.2, note_dur=0.9, gap=1.7)
    t = np.arange(int(dur_o * SR)) / SR
    presence = 0.55 + 0.45 * (t / dur_o) ** 0.85
    opening = normalize_peak((pad * 0.72 + pulse * 0.55 + mel * 0.9) * presence, 0.55)
    opening = fade_edges(opening, SR, 0.8, 1.8)
    write_wav_stereo(os.path.join(OUT, "opening-tech.wav"), stereoize(opening, SR, 0.22), SR)

    dur_t = 3.0
    whoosh = noise_whoosh(dur_t, SR, rise=True)
    chime = sparse_melody(dur_t, SR, [523.25, 659.25, 783.99], start=0.55, note_dur=1.4, gap=0.35)
    swell = pad_voice(dur_t, SR, root=82.4, brightness=0.25) * env_adsr(int(dur_t * SR), SR, 0.4, 0.3, 0.5, 1.2)
    trans = normalize_peak(whoosh * 0.85 + chime * 1.1 + swell * 0.35, 0.68)
    trans = fade_edges(trans, SR, 0.05, 0.55)
    write_wav_stereo(os.path.join(OUT, "transition-tech.wav"), stereoize(trans, SR, 0.28), SR)

    dur_e = 11.5
    pad_e = pad_voice(dur_e, SR, root=87.3, brightness=0.28)
    pulse_e = subtle_pulse(dur_e, SR, bpm=58, tone=43.65)
    mel_e = sparse_melody(dur_e, SR, [329.63, 261.63, 220.0, 196.0, 164.81], start=0.6, note_dur=1.2, gap=2.0)
    t_e = np.arange(int(dur_e * SR)) / SR
    presence_e = 0.95 - 0.55 * (t_e / dur_e) ** 1.1
    ending = normalize_peak((pad_e * 0.78 + pulse_e * 0.4 + mel_e * 0.85) * presence_e, 0.58)
    ending = fade_edges(ending, SR, 0.4, 3.5)
    write_wav_stereo(os.path.join(OUT, "ending-tech.wav"), stereoize(ending, SR, 0.2), SR)

    for name in ("opening-tech.wav", "transition-tech.wav", "ending-tech.wav"):
        path = os.path.join(OUT, name)
        try:
            ffmpeg_limit(path)
        except (FileNotFoundError, subprocess.CalledProcessError):
            pass
        with wave.open(path) as w:
            print(f"{name}: {w.getnframes() / w.getframerate():.3f}s")


if __name__ == "__main__":
    main()
