import type { Clip, TimeRange } from './types';
import { addRange, removeRange } from './timeline';
import { ensureAudioOrder } from './audioOrder';
import { isPunctText } from './alignment';

export interface ManualPause extends TimeRange { id: string; sourceStart: number; sourceEnd: number }
/** Cut the middle in edited order, retaining a total (not per-fragment) breath. */
export function shortenPauseRanges(ranges: TimeRange[], threshold: number, keep = .02): TimeRange[] {
  const total=ranges.reduce((s,r)=>s+r.end-r.start,0);
  if (total <= threshold + 1e-7) return [];
  const retain=Math.min(keep,threshold), lo=retain/2, hi=total-retain/2;
  let at=0;
  return ranges.flatMap(r=>{
    const length=r.end-r.start;
    const a=Math.max(0,lo-at),b=Math.min(length,hi-at); at+=length;
    return b>a+1e-7 ? [{start:r.start+a,end:r.start+b}] : [];
  });
}
/** Replacing a deleted pause cut cannot restore deleted words or other pauses. */
export function replacePauseCut(clip: Pick<Clip,'words'|'ranges'|'duration'|'audioOrder'|'clearedPauses'>, ids: Set<string>, cut: TimeRange, id: string) {
  if(!Number.isFinite(cut.start)||!Number.isFinite(cut.end)||cut.start<0||cut.end>clip.duration||cut.end-cut.start<.02-1e-7) throw Error('停顿边界无效');
  ensureAudioOrder(clip);
  for(const p of clip.clearedPauses??[]) if(ids.has(p.id)) clip.ranges=addRange(clip.ranges,p.start,p.end);
  clip.clearedPauses=(clip.clearedPauses??[]).filter(p=>!ids.has(p.id));
  for(const w of clip.words) if(w.deleted&&!isPunctText(w.text)) for(const r of w.removedAudio??[{start:w.start,end:w.end}]) clip.ranges=removeRange(clip.ranges,r.start,r.end);
  for(const p of clip.clearedPauses) clip.ranges=removeRange(clip.ranges,p.start,p.end);
  // Editing a pause cannot consume a retained word, even when an old ASR or
  // silence detector put that word inside the pause's bounding interval.
  let cuts: TimeRange[]=[cut];
  for(const w of clip.words) if(!w.deleted&&!isPunctText(w.text)) cuts=removeRange(cuts,w.start,w.end);
  const pieces=cuts.flatMap(cut=>clip.ranges.map(r=>({start:Math.max(r.start,cut.start),end:Math.min(r.end,cut.end)})).filter(r=>r.end>r.start));
  for(const [i,p] of pieces.entries()) clip.clearedPauses.push({id:`${id}-${i}`,...p});
  for(const part of cuts) clip.ranges=removeRange(clip.ranges,part.start,part.end); ensureAudioOrder(clip);
}

/** Remove verified quiet pieces, leaving one 10ms guard at each outer edge.
 * Gaps between pieces are never cut. Strong word boundaries remain protected. */
export function deletePauseParts(clip: Pick<Clip,'words'|'ranges'|'duration'|'audioOrder'|'clearedPauses'>, parts: TimeRange[], id: string) {
  ensureAudioOrder(clip);
  const cuts=pauseDeletionCuts(clip.words,parts);
  clip.clearedPauses??=[];
  const added=[];
  for(const cut of cuts) {
    for(const r of clip.ranges) {
      const start=Math.max(r.start,cut.start),end=Math.min(r.end,cut.end);
      if(end-start>1e-4) added.push({id:`${id}-${added.length}`,start,end});
    }
    clip.ranges=removeRange(clip.ranges,cut.start,cut.end);
  }
  clip.clearedPauses.push(...added);ensureAudioOrder(clip);
  return added;
}

export function pauseDeletionCuts(words: Clip['words'], parts: TimeRange[]) {
  const ordered=parts.slice().sort((a,b)=>a.start-b.start);
  const total=ordered.reduce((s,p)=>s+p.end-p.start,0);
  const retain=Math.min(.02,total/2);
  let cuts=shortenPauseRanges(ordered,retain,retain);
  for(const w of words) if(!w.deleted&&!isPunctText(w.text)&&(w.manualBoundary||w.alignmentSource||/[a-z]/i.test(w.text))) cuts=cuts.flatMap(p=>removeRange([p],w.start,w.end));
  return cuts;
}
