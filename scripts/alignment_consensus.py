"""Conservative short-token repair using independently predicted acoustic times."""
from statistics import median
import math


def repair_short_tokens(words, timestamps, duration):
    if len(words) != len(timestamps):
        return words
    # FA-zh can have an utterance-wide offset. Estimate it from reliable Qwen
    # anchors in this very audio window; never bake a constant delay into cuts.
    differences = []
    for w, (a, b) in zip(words, timestamps):
        if not w.get("review") and w["end"] - w["start"] >= 0.06:
            differences.extend([a / 1000 - w["start"], b / 1000 - w["end"]])
    if len(differences) < 12 or not all(math.isfinite(x) for x in differences):
        return words
    offset = median(differences)
    if abs(offset) > 0.2 or median(abs(x - offset) for x in differences) > 0.06:
        return words
    result = [dict(w) for w in words]
    for i, (w, (a, b)) in enumerate(zip(words, timestamps)):
        if not w.get("review") or w["end"] - w["start"] > 0.06:
            continue
        # Only repair a collapsed/very short token bracketed by stable words.
        if i == 0 or i == len(words) - 1 or words[i-1].get("review") or words[i+1].get("review"):
            continue
        start, end = a / 1000 - offset, b / 1000 - offset
        if not math.isfinite(start + end) or start < 0 or end > duration:
            continue
        if start < words[i-1]["end"] - 0.02 or end > words[i+1]["start"] + 0.02:
            continue
        start, end = max(start, words[i-1]["end"]), min(end, words[i+1]["start"])
        if not 0.04 <= end - start <= 0.4 or abs((start + end - w["start"] - w["end"]) / 2) > 0.2:
            continue
        result[i].update(start=round(start, 5), end=round(end, 5), review=False, source="fa-zh")
    return result
