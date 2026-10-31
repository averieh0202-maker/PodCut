import type { TimeRange, Word } from './types';
import { envelope, type AcousticInput } from './acoustics';
export function isPunctText(text: string): boolean { return /^[\p{P}\s]+$/u.test(text); }
export interface EnergyCutOpts extends AcousticInput {
  clipDuration?: number;
  maxSwallowSec?: number;
  frameMs?: number;
}
export interface CutExtentOpts { padSec?: number; energy?: EnergyCutOpts }
export function sortWordsByTime(words: Word[]): Word[] {
  return [...words].sort((a, b) => a.start - b.start || a.end - b.end);
}
export function neighborKept(ordered: Word[], index: number): { prev: Word | null; next: Word | null } {
  return {
    prev: ordered.slice(0, index).reverse().find(w => !w.deleted && !isPunctText(w.text)) ?? null,
    next: ordered.slice(index + 1).find(w => !w.deleted && !isPunctText(w.text)) ?? null,
  };
}
/** Expand only over completely verified quiet frames, including the partial
 * frame at the cut boundary. No rounding into an uninspected speech frame. */
export function energySwallowRange(range: TimeRange, loFence: number, hiFence: number, energy: EnergyCutOpts): TimeRange {
  if (!(energy.sampleRate > 0) || !energy.channel.length) return { ...range };
  const { rms, step, quiet } = envelope(energy);
  const lo = Math.max(0, loFence), hi = Math.min(hiFence, energy.clipDuration ?? energy.channel.length / energy.sampleRate);
  let start = Math.max(lo, Math.min(hi, range.start));
  let end = Math.max(start, Math.min(hi, range.end));
  const limit = Math.max(0, energy.maxSwallowSec ?? 0.012);
  const left = Math.max(lo, start - limit), right = Math.min(hi, end + limit);
  while (start > left + 1e-9) {
    const f = Math.ceil(start / step - 1e-8) - 1;
    if (f < 0 || (rms[f] ?? Infinity) > quiet) break;
    start = Math.max(left, f * step);
  }
  while (end < right - 1e-9) {
    const f = Math.floor(end / step + 1e-8);
    if ((rms[f] ?? Infinity) > quiet) break;
    end = Math.min(right, (f + 1) * step);
  }
  return { start, end };
}
/** Stable per-token ownership, including previously deleted neighbours.
 * Punctuation never owns sound. No blind 60–180 ms padding into weak speech. */
export function wordCutExtent(words: Word[], wordId: string, opts?: CutExtentOpts): TimeRange | null {
  const ordered = sortWordsByTime(words);
  const i = ordered.findIndex(w => w.id === wordId);
  if (i < 0) return null;
  const w = ordered[i]!;
  if (isPunctText(w.text)) return { start: w.start, end: w.start };
  const prev = ordered.slice(0, i).reverse().find(x => !isPunctText(x.text));
  const next = ordered.slice(i + 1).find(x => !isPunctText(x.text));
  const lo = prev ? Math.max(0, prev.end) : 0;
  const hi = next?.start ?? opts?.energy?.clipDuration ?? Infinity;
  const start = Math.max(lo, w.start);
  const end = Math.max(start, Math.min(hi, w.end));
  if (end <= start || hi < lo) return { start, end: start };
  if (!opts?.energy || w.manualBoundary) return { start, end };
  return energySwallowRange({ start, end }, Math.max(lo, w.start - Math.max(0, w.start - lo) / 2),
    Math.min(hi, w.end + Math.max(0, hi - w.end) / 2),
    { ...opts.energy, maxSwallowSec: Math.min(opts.padSec ?? 0.012, opts.energy.maxSwallowSec ?? 0.012) });
}
export function cutExtentsForIds(words: Word[], ids: Iterable<string>, opts?: CutExtentOpts): TimeRange[] {
  const selected = new Set(ids), out: TimeRange[] = [];
  let run: TimeRange | null = null;
  for (const w of sortWordsByTime(words)) {
    if (isPunctText(w.text)) continue;
    if (!selected.has(w.id)) { run = null; continue; }
    const ext = wordCutExtent(words, w.id, opts);
    if (!ext || ext.end <= ext.start) { run = null; continue; }
    if (run) run.end = Math.max(run.end, ext.end);
    else { run = { ...ext }; out.push(run); }
  }
  return out;
}
export function viewWindowAround(focus: TimeRange, clipDuration: number, padSec = 0.35): TimeRange {
  const start = Math.max(0, focus.start - padSec);
  return { start, end: Math.min(clipDuration, Math.max(focus.end + padSec, start + 0.15)) };
}
