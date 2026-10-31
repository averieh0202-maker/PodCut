import { isPunctText } from './alignment';
import type { TimeRange, Word } from './types';

/** Total duration of the edited timeline (kept ranges only). */
export function editedDuration(ranges: TimeRange[]): number {
  return ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
}

/** Map edit-timeline time → original audio time. */
export function toOriginal(ranges: TimeRange[], editTime: number): number | null {
  if (ranges.length === 0) return null;
  let t = 0;
  for (const r of ranges) {
    const d = r.end - r.start;
    if (editTime <= t + d) {
      return r.start + Math.max(0, editTime - t);
    }
    t += d;
  }
  return ranges[ranges.length - 1].end;
}

/** Map original time → edit-timeline time; null if that moment was cut. */
export function toEdit(ranges: TimeRange[], originalTime: number): number | null {
  let t = 0;
  for (const r of ranges) {
    if (originalTime + 1e-6 >= r.start && originalTime < r.end) {
      return t + (originalTime - r.start);
    }
    t += r.end - r.start;
  }
  return null;
}

/** Insert [start, end] into kept ranges and merge overlaps. */
export function addRange(ranges: TimeRange[], start: number, end: number): TimeRange[] {
  if (end - start <= 1e-4) return ranges.map((r) => ({ ...r }));
  const merged = [...ranges.map((r) => ({ ...r })), { start, end }].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  );
  const out: TimeRange[] = [];
  for (const r of merged) {
    const last = out[out.length - 1];
    if (!last || r.start > last.end + 1e-4) {
      out.push({ ...r });
    } else {
      last.end = Math.max(last.end, r.end);
    }
  }
  return out.filter((r) => r.end - r.start > 1e-4);
}

/** Subtract [cutStart, cutEnd] from a list of kept ranges. */
export function removeRange(ranges: TimeRange[], cutStart: number, cutEnd: number): TimeRange[] {
  if (cutEnd <= cutStart) return ranges.map((r) => ({ ...r }));
  const out: TimeRange[] = [];
  for (const r of ranges) {
    if (cutEnd <= r.start || cutStart >= r.end) {
      out.push({ ...r });
      continue;
    }
    if (cutStart > r.start) {
      out.push({ start: r.start, end: Math.min(cutStart, r.end) });
    }
    if (cutEnd < r.end) {
      out.push({ start: Math.max(cutEnd, r.start), end: r.end });
    }
  }
  return out.filter((r) => r.end - r.start > 1e-4);
}

/** Build initial full-range edit list from audio duration. */
export function fullRange(duration: number): TimeRange[] {
  return duration > 0 ? [{ start: 0, end: duration }] : [];
}

export interface FindPauseOptions {
  /**
   * Leave this much of the gap on each side uncut so ASR word edges
   * (often slightly early/late) are not clipped. Default 100ms.
   */
  padSec?: number;
  /**
   * Also remove leading silence before first word / trailing after last.
   * Default false — only interior gaps between kept speech words.
   */
  includeLeadingTrailing?: boolean;
  /** Minimum cut length after padding; shorter gaps are skipped. Default 50ms. */
  minCutSec?: number;
}

/**
 * Find silence gaps BETWEEN consecutive kept speech words longer than threshold.
 *
 * - Ignores deleted words and zero-duration tokens (e.g. inserted punctuation).
 * - Never expands into a word’s [start, end]; only cuts the interior of a gap,
 *   leaving `padSec` on each side.
 * - By default does not remove leading/trailing silence.
 */
export function findPauseRanges(
  words: Word[],
  duration: number,
  thresholdSec: number,
  opts?: FindPauseOptions,
): TimeRange[] {
  const pad = opts?.padSec ?? 0.1;
  const includeEnds = opts?.includeLeadingTrailing ?? false;
  const minCut = opts?.minCutSec ?? 0.05;

  // Speech anchors only: non-deleted, positive duration (skip punct tokens).
  const speech = words
    .filter((w) => !w.deleted && w.end - w.start > 1e-4)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const pauses: TimeRange[] = [];

  if (speech.length === 0) {
    // Nothing to protect — only clear all if explicitly including ends and long enough
    if (includeEnds && duration >= thresholdSec) {
      const cutStart = pad;
      const cutEnd = duration - pad;
      if (cutEnd - cutStart >= minCut) pauses.push({ start: cutStart, end: cutEnd });
    }
    return pauses;
  }

  if (includeEnds) {
    const firstStart = speech[0]!.start;
    if (firstStart >= thresholdSec) {
      const cutStart = 0;
      const cutEnd = firstStart - pad;
      if (cutEnd - cutStart >= minCut) pauses.push({ start: cutStart, end: cutEnd });
    }
  }

  for (let i = 0; i < speech.length - 1; i++) {
    const gapStart = speech[i]!.end;
    const gapEnd = speech[i + 1]!.start;
    const gap = gapEnd - gapStart;
    if (gap < thresholdSec) continue;
    // Only the middle of the gap — never into either word
    const cutStart = gapStart + pad;
    const cutEnd = gapEnd - pad;
    if (cutEnd - cutStart < minCut) continue;
    if (cutStart < gapStart || cutEnd > gapEnd) continue; // safety
    pauses.push({ start: cutStart, end: cutEnd });
  }

  if (includeEnds) {
    const lastEnd = speech[speech.length - 1]!.end;
    if (duration - lastEnd >= thresholdSec) {
      const cutStart = lastEnd + pad;
      const cutEnd = duration;
      if (cutEnd - cutStart >= minCut) pauses.push({ start: cutStart, end: cutEnd });
    }
  }

  return pauses;
}

/** Word that contains an original-time playhead (for highlight). */
export function wordAtOriginal(words: Word[], originalTime: number): Word | null {
  for (const w of words) {
    if (w.deleted || isPunctText(w.text)) continue;
    if (originalTime >= w.start && originalTime < w.end) return w;
  }
  // nearest previous kept word if in a micro-gap
  let best: Word | null = null;
  for (const w of words) {
    if (w.deleted) continue;
    if (w.end <= originalTime && (!best || w.end > best.end)) best = w;
  }
  return best;
}

/** Deep-clone snapshot pieces. */
export function cloneWords(words: Word[]): Word[] {
  return words.map((w) => ({ ...w }));
}

export function cloneRanges(ranges: TimeRange[]): TimeRange[] {
  return ranges.map((r) => ({ ...r }));
}

/** Keep only the portions of ranges that overlap [start, end]. */
export function extractRanges(ranges: TimeRange[], start: number, end: number): TimeRange[] {
  if (end <= start) return [];
  const out: TimeRange[] = [];
  for (const r of ranges) {
    const a = Math.max(r.start, start);
    const b = Math.min(r.end, end);
    if (b - a > 1e-4) out.push({ start: a, end: b });
  }
  return out;
}

/**
 * Insert `insert` into the kept-range list at a given edit-timeline time.
 * If editTime falls mid-range, that range is split.
 */
export function insertRangesAt(
  ranges: TimeRange[],
  editTime: number,
  insert: TimeRange[],
): TimeRange[] {
  if (insert.length === 0) return ranges.map((r) => ({ ...r }));
  const pieces = insert.filter((r) => r.end - r.start > 1e-4).map((r) => ({ ...r }));
  if (pieces.length === 0) return ranges.map((r) => ({ ...r }));

  const tTarget = Math.max(0, editTime);
  const out: TimeRange[] = [];
  let editPos = 0;
  let placed = false;

  for (const r of ranges) {
    const dur = r.end - r.start;
    if (dur <= 1e-4) continue;
    if (placed) {
      out.push({ ...r });
      editPos += dur;
      continue;
    }
    if (editPos + dur <= tTarget + 1e-9) {
      out.push({ ...r });
      editPos += dur;
      continue;
    }
    const offsetInRange = Math.max(0, tTarget - editPos);
    if (offsetInRange <= 1e-9) {
      out.push(...pieces);
      out.push({ ...r });
    } else if (offsetInRange >= dur - 1e-9) {
      out.push({ ...r });
      out.push(...pieces);
    } else {
      out.push({ start: r.start, end: r.start + offsetInRange });
      out.push(...pieces);
      out.push({ start: r.start + offsetInRange, end: r.end });
    }
    placed = true;
    editPos += dur;
  }

  if (!placed) out.push(...pieces);
  return out.filter((r) => r.end - r.start > 1e-4);
}

/** Slice by playback time, so a selection may cross pasted/source segment seams. */
export function extractEditRanges(ranges: TimeRange[], start: number, end: number): TimeRange[] {
  let at=0;const out:TimeRange[]=[];
  for(const r of ranges) {
    const duration=r.end-r.start;
    const a=Math.max(start,at),b=Math.min(end,at+duration);
    if(b>a)out.push({start:r.start+a-at,end:r.start+b-at});
    at+=duration;
  }
  return out;
}
