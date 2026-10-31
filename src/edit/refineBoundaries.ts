import type { Word } from './types';
import { isPunctText, sortWordsByTime } from './alignment';
import { bufferAcoustics, envelope } from './acoustics';
export interface RefineOpts {
  searchSec?: number;
  frameMs?: number;
  minDurSec?: number;
  channels?: Float32Array[];
}
export interface RefineStats { adjusted: number; meanAbsShiftMs: number }
/** Energy is not phonetic alignment. Only adjust near the ASR boundary when
 * there is a strong local valley; preserve pauses and quiet consonants. */
export function refineWordBoundariesInPlace(
  words: Word[], channel: Float32Array, sampleRate: number, clipDuration: number, opts?: RefineOpts,
): RefineStats {
  if (!(sampleRate > 0) || !channel.length || !words.length) return { adjusted: 0, meanAbsShiftMs: 0 };
  const duration = Math.min(clipDuration, channel.length / sampleRate);
  const ordered = sortWordsByTime(words);
  const speech = ordered.filter(w => !isPunctText(w.text));
  const before = speech.map(w => ({ start: w.start, end: w.end }));
  const { rms, step } = envelope({ channel, sampleRate, channels: opts?.channels });
  const search = Math.min(0.04, Math.max(0, opts?.searchSec ?? 0.03));
  const minDur = opts?.minDurSec ?? 0.025;
  for (const w of speech) {
    w.start = Math.max(0, Math.min(duration, Number.isFinite(w.start) ? w.start : 0));
    w.end = Math.max(w.start, Math.min(duration, Number.isFinite(w.end) ? w.end : w.start));
  }
  for (let i = 0; i + 1 < speech.length; i++) {
    const a = speech[i]!, b = speech[i + 1]!;
    if (a.manualBoundary || b.manualBoundary || a.alignmentSource || b.alignmentSource) continue;
    const gap = b.start - a.end;
    if (gap > 0.06 || a.end <= a.start || b.end <= b.start) continue;
    const anchor = (a.end + b.start) / 2;
    const lo = Math.max(a.start + minDur, a.end - search, b.start - search);
    const hi = Math.min(b.end - minDur, a.end + search, b.start + search);
    if (lo > hi) continue;
    const anchorF = Math.min(rms.length - 1, Math.floor(anchor / step));
    let best = anchor, score = Infinity, peak = 0;
    for (let f = Math.ceil(lo / step); f <= Math.floor(hi / step); f++) peak = Math.max(peak, rms[f] ?? 0);
    for (let f = Math.ceil(lo / step); f <= Math.floor(hi / step); f++) {
      const time = f * step, e = rms[f] ?? 0;
      if (peak < 0.0001 || e > peak * 0.45 || e > (rms[anchorF] ?? 0) * 0.8) continue;
      const candidate = e / peak + Math.abs(time - anchor) / Math.max(search, step) * 0.25;
      if (candidate < score) { best = time; score = candidate; }
    }
    if (Number.isFinite(score) || gap < 0) {
      const split = Math.max(lo, Math.min(hi, best));
      a.end = split;
      b.start = split;
    }
  }
  let previous: Word | undefined;
  for (const w of ordered) {
    if (isPunctText(w.text)) w.start = w.end = previous?.end ?? w.start;
    else previous = w;
  }
  let adjusted = 0, sum = 0;
  speech.forEach((w, i) => {
    const ds = Math.abs(w.start - before[i]!.start), de = Math.abs(w.end - before[i]!.end);
    if (ds > 0.001 || de > 0.001) adjusted++;
    sum += ds + de;
  });
  return { adjusted, meanAbsShiftMs: speech.length ? sum / (2 * speech.length) * 1000 : 0 };
}
export function refineWordBoundariesFromBuffer(words: Word[], buffer: AudioBuffer, opts?: RefineOpts): RefineStats {
  const input = bufferAcoustics(buffer);
  return refineWordBoundariesInPlace(words, input.channel, input.sampleRate, buffer.duration, { ...opts, channels: input.channels });
}
