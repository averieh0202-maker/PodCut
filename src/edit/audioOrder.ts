import type { TimeRange, Word } from './types';

/** Recover older drafts whose text was reordered but whose ranges were sorted by source time. */
export function inferAudioOrder(words: Word[], duration: number): TimeRange[] {
  if (!(duration > 0)) return [];
  const owners = new Map<number, number>();
  words.forEach((w, index) => {
    if (Number.isFinite(w.start) && w.start >= 0 && w.start < duration && !owners.has(w.start)) owners.set(w.start, index);
  });
  const starts = [...owners.keys()].sort((a, b) => a - b);
  if (!starts.length) return [{ start: 0, end: duration }];
  const pieces = starts.map((start, i) => ({ start: i ? start : 0, end: starts[i + 1] ?? duration, rank: owners.get(start)! }));
  pieces.sort((a, b) => a.rank - b.rank);
  return mergeAdjacent(pieces);
}
function mergeAdjacent(ranges: TimeRange[]): TimeRange[] {
  const out: TimeRange[] = [];
  for (const r of ranges) {
    if (r.end - r.start <= 1e-7) continue;
    const last = out.at(-1);
    if (last && Math.abs(last.end - r.start) < 1e-7) last.end = r.end;
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}
/** Restore/cut changes coverage, never the stored playback order. Includes deleted audio in `order`. */
export function rangesInAudioOrder(ranges: TimeRange[], order: TimeRange[]): TimeRange[] {
  const coverage: TimeRange[] = [];
  for (const r of [...ranges].sort((a,b) => a.start-b.start)) {
    const last=coverage.at(-1);
    if (last && r.start <= last.end + 1e-7) last.end=Math.max(last.end,r.end);
    else coverage.push({...r});
  }
  return mergeAdjacent(order.flatMap(part => coverage.map(r => ({start:Math.max(part.start,r.start),end:Math.min(part.end,r.end)})).filter(r=>r.end>r.start)));
}
export function ensureAudioOrder(clip: {words:Word[]; duration:number; ranges:TimeRange[]; audioOrder?:TimeRange[]}) {
  clip.audioOrder ??= inferAudioOrder(clip.words, clip.duration);
  clip.ranges = rangesInAudioOrder(clip.ranges, clip.audioOrder);
  return clip.audioOrder;
}
