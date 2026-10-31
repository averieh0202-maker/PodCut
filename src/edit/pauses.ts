import type { TimeRange, Word } from './types';
import { envelope, type AcousticInput } from './acoustics';
import { isPunctText, sortWordsByTime } from './alignment';
import { removeRange } from './timeline';
export interface PauseCandidate extends TimeRange {
  id: string;
  duration: number;
  cut: TimeRange;
  breath?: boolean;
}
/** Silence and detected inhalation are parts of the same pause. Union before
 * display/threshold checks so overlapping detections are never counted twice. */
export function mergePauseCandidates(candidates:PauseCandidate[]):PauseCandidate[] {
  const merged:PauseCandidate[]=[];
  for(const p of candidates.slice().sort((a,b)=>a.start-b.start)){
    const prev=merged.at(-1);
    if(prev&&p.start<=prev.end+1e-7){
      prev.end=Math.max(prev.end,p.end);prev.duration=prev.end-prev.start;
      prev.breath=prev.breath||p.breath;prev.cut=singlePauseCut(prev);
    }else merged.push({...p});
  }
  return merged;
}
export function pauseExceedsThreshold(parts:TimeRange[],threshold:number):boolean {
  return parts.reduce((s,p)=>s+p.end-p.start,0)>threshold+1e-7;
}
/** Scan every acoustic pause, even when an old ASR token spans the silence.
 * Mark >=100ms continuously quiet on EVERY channel. Cuts keep only
 * 10ms outer guards, which are never offered as new pause markers.
 * Work within a single kept range so repeat cleanup cannot shorten it again.
 */
export function detectPauses(words: Word[], ranges: TimeRange[], input: AcousticInput, duration: number, _removed: TimeRange[] = [], minDuration = .1): PauseCandidate[] {
  if (!(input.sampleRate > 0) || !input.channel.length) return [];
  const { rms, step, quiet } = envelope(input);
  const speech = sortWordsByTime(words).filter(w => !w.deleted && !isPunctText(w.text));
  const out: PauseCandidate[] = [];
  for (let f = 0; f < rms.length;) {
    if (rms[f]! > quiet) { f++; continue; }
    const first = f;
    while (f < rms.length && rms[f]! <= quiet) f++;
    const start = first * step, end = Math.min(duration, f * step);
    const length = end - start;
    if (length < minDuration-1e-9) continue;
    const keep = .02;
    for (let ri = 0; ri < ranges.length; ri++) {
      const r = ranges[ri]!;
      const keptStart = Math.max(start, r.start), keptEnd = Math.min(end, r.end);
      const keptLength = keptEnd - keptStart;
      if (keptLength < minDuration - 1e-9) continue;
      const trim = Math.max(0, keptLength - keep);
      const cut = { start: keptStart + (keptLength - trim) / 2, end: keptEnd - (keptLength - trim) / 2 };
      out.push({ id: `p-${first}-${f}-${ri}`, start: keptStart, end: keptEnd, duration: keptLength, cut });
    }
  }
  // Low energy alone does not prove silence: protect aligned/manual syllables,
  // including weak consonants and breaths inside a retained word.
  const protectedWords=speech.filter(w=>w.manualBoundary || !!w.alignmentSource || /[a-z]/i.test(w.text));
  return out.flatMap(p=>{
    let parts: TimeRange[]=[p];
    for(const w of protectedWords) if(w.start<p.end && w.end>p.start) parts=removeRange(parts,w.start,w.end);
    return parts.filter(r=>r.end-r.start>=minDuration-1e-9).map((r,i)=>({...p,...r,id:`${p.id}-${i}`,duration:r.end-r.start,cut:{start:Math.max(r.start,p.cut.start),end:Math.min(r.end,p.cut.end)}}));
  });
}

/** Manual click: remove the chosen quiet interval, preserving 10ms acoustic guards. */
export function singlePauseCut(pause: TimeRange): TimeRange {
  const guard = Math.min(0.01, (pause.end - pause.start) / 4);
  return { start: pause.start + guard, end: pause.end - guard };
}

export interface PausePart extends TimeRange { id: string; cleared?: boolean; breath?: boolean }
export interface PauseGroup { id: string; anchorId: string | null; beforeId?: string; parts: PausePart[] }
/** Group adjacent pause marks in the same source/editorial segment. Keep each
 * acoustic cut separately: grouping must never swallow a noisy/voiced gap. */
export function groupPauseMarks(words: Word[], pauses: PausePart[], order: TimeRange[]): PauseGroup[] {
  const groups = new Map<string, PauseGroup>();
  const latest = new Map<string, PauseGroup>();
  for (let si=0; si<order.length; si++) {
    const segment=order[si]!;
    const timed=words.filter(w=>!isPunctText(w.text) && w.start>=segment.start && w.start<segment.end).sort((a,b)=>a.start-b.start);
    for (const p of [...pauses].sort((a,b)=>a.start-b.start)) {
      const at=(p.start+p.end)/2;
      if (at<segment.start || at>=segment.end) continue;
      let lo=0,hi=timed.length;
      while(lo<hi) { const mid=(lo+hi)>>>1; if(timed[mid]!.start<=at) lo=mid+1; else hi=mid; }
      // Use original spoken anchors, including deleted words. Deleting a
      // later phrase must not move its trailing pause into the earlier one.
      // Punctuation still does not split one pause into labels.
      // A leading pause for a pasted segment belongs before that segment's
      // first word, not at the beginning of the whole transcript.
      const anchor=timed[lo-1]?.id ?? null;
      let key=`${si}:${anchor ?? 'head'}`;
      let g=latest.get(key);
      // One display location, one group. Preserve the constituent intervals:
      // an untranscribed voiced gap must never become part of the cut.
      if(!g) { g={id:`pg-${key}`,anchorId:anchor,beforeId:!anchor ? timed[0]?.id : undefined,parts:[]}; groups.set(g.id,g); latest.set(key,g); }
      g.parts.push(p);
    }
  }
  return [...groups.values()];
}

/** One logical pause has one visual/action state. Guards stay in the audio only. */
export function pauseGroupDisplay(group: PauseGroup) {
  const kept = group.parts.filter(p=>!p.cleared);
  const removed = group.parts.filter(p=>p.cleared);
  const remaining = kept.reduce((s,p)=>s+p.end-p.start,0);
  if (remaining >= .1-1e-7) return {cleared:false,duration:remaining};
  const cut = removed.reduce((s,p)=>s+p.end-p.start,0);
  return removed.length
    ? {cleared:true,duration:cut} : null;
}

/** A newly detected breath belongs to its original pause, even if an earlier
 * silence-only pass already removed most of that pause. Never re-cut guards. */
export function bulkPauseParts(group:PauseGroup,threshold:number):TimeRange[] {
  const kept=group.parts.filter(p=>!p.cleared);
  if(pauseExceedsThreshold(kept,threshold))return kept;
  if(kept.some(p=>p.breath)&&group.parts.some(p=>p.cleared)&&pauseExceedsThreshold(group.parts,threshold))return group.parts;
  return [];
}
