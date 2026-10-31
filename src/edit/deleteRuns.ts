import type { Clip, TimeRange } from './types';
import { isPunctText, wordCutExtent } from './alignment';
import { ensureAudioOrder } from './audioOrder';
import { addRange, removeRange } from './timeline';
import { deletionEdgeCuts, deletionAcoustics, type DeletionAudio } from './deletionEdges';

type EditableClip = Pick<Clip, 'words'|'ranges'|'audioOrder'|'duration'> & Partial<Pick<Clip,'buffer'|'cleanBuffer'|'manualPauses'|'clearedPauses'>>;
/** Normal deletion owns the complete run and acoustically verified edge audio. Explicit cut repair
 * may extend through ASR holes between retained neighbours.
 * Already-deleted neighbours join the run, so sequential deletion cannot leave
 * unowned syllables in ASR gaps. Never bridge a paste/edit-order seam. */
export function deleteWordRuns(clip: EditableClip, ids: Set<string>, repairEdges = false, input:DeletionAudio|undefined=deletionAcoustics(clip)): number {
  const order = ensureAudioOrder(clip);
  let removed = 0;
  for (const part of order) {
    const words = clip.words.filter(w => !isPunctText(w.text) && w.start >= part.start - 1e-7 && w.start < part.end - 1e-7)
      .sort((a,b) => a.start-b.start || a.end-b.end);
    for (let i=0; i<words.length;) {
      if (!ids.has(words[i]!.id) && !words[i]!.deleted) { i++; continue; }
      const first = i;
      while (i<words.length && (words[i]!.deleted || ids.has(words[i]!.id))) i++;
      const run = words.slice(first,i);
      if (!run.some(w => ids.has(w.id))) continue;
      const a = run[0]!, b = run.at(-1)!;
      const prev = words[first-1], next = words[i];
      const start = Math.max(part.start, repairEdges ? prev?.end ?? a.start : a.start, prev?.end ?? 0,
        a.manualBoundary && !repairEdges ? a.start : 0);
      const end = Math.min(part.end, repairEdges ? next?.start ?? b.end : b.end, next?.start ?? Infinity,
        b.manualBoundary && !repairEdges ? b.end : Infinity);
      if (end <= start) continue;
      // One contiguous selection has ONE core cut: first onset -> last offset.
      // Interior token boundaries, punctuation, pauses and alignment confidence
      // never split this interval. Acoustic checks only refine its outer edges.
      let cuts: TimeRange[]=[{start,end}];
      if(!repairEdges)for(const extra of deletionEdgeCuts(clip,a,b,prev,next,part,input))cuts=addRange(cuts,extra.start,extra.end);
      // Even malformed/overlapping timestamps cannot erase an unselected word.
      for(const w of clip.words)if(!w.deleted&&!ids.has(w.id)&&!isPunctText(w.text))cuts=removeRange(cuts,w.start,w.end);
      // Outer pauses stay outside these endpoints. Everything INSIDE a deleted
      // run belongs to that run, including breaths and inter-word gaps.
      // The per-word pieces BELOW are restoration bookkeeping only. Playback
      // is cut once per interval AFTER this loop, never once per character.
      // Each removed sample has exactly one owner, so single-word restoration
      // and later boundary adjustment don't resurrect another word's cut.
      for (let j=0; j<run.length; j++) {
        const w = run[j]!;
        const lo = j ? (run[j-1]!.end + w.start)/2 : Math.min(start,...cuts.map(r=>r.start));
        const hi = j+1<run.length ? (w.end + run[j+1]!.start)/2 : Math.max(end,...cuts.map(r=>r.end));
        const pieces = cuts.flatMap(cut=>clip.ranges.map(r => ({start:Math.max(r.start,cut.start,lo),end:Math.min(r.end,cut.end,hi)})).filter(r=>r.end>r.start));
        let owned: TimeRange[] = w.removedAudio ?? (w.deleted ? [{start:w.start,end:w.end}] : []);
        for (const p of pieces) { owned=addRange(owned,p.start,p.end); removed+=p.end-p.start; }
        w.removedAudio=owned; w.joinedCut=w.joinedCut||repairEdges; w.continuousCut=true;
      }
      for(const cut of cuts) clip.ranges=removeRange(clip.ranges,cut.start,cut.end);
    }
  }
  for (const w of clip.words) if (ids.has(w.id)) w.deleted=true;
  ensureAudioOrder(clip);
  return removed;
}

/** Restore exactly the audio owned by selected words, then re-apply every
 * independent exclusion. Edge cleanup participates in undo/restore normally. */
export function restoreWordRuns(clip:EditableClip, ids:Set<string>):number {
  let count=0;
  for(const w of clip.words)if(ids.has(w.id)&&w.deleted){
    const saved=w.removedAudio??[wordCutExtent(clip.words,w.id)].filter((r):r is TimeRange=>!!r);
    for(const r of saved)clip.ranges=addRange(clip.ranges,Math.max(0,r.start),Math.min(clip.duration,r.end));
    w.deleted=false;delete w.removedAudio;delete w.joinedCut;delete w.continuousCut;count++;
  }
  for(const w of clip.words)if(w.deleted&&!isPunctText(w.text))for(const r of w.removedAudio??[{start:w.start,end:w.end}])clip.ranges=removeRange(clip.ranges,r.start,r.end);
  for(const p of clip.clearedPauses??[])clip.ranges=removeRange(clip.ranges,p.start,p.end);
  ensureAudioOrder(clip);return count;
}

/** One-time repair of legacy holes INSIDE deleted runs. Never extend the outer
 * boundaries or reinterpret a user's manually adjusted deleted-word cuts. */
export function repairLegacyDeletedAudio(clip: EditableClip, beforeChange?:()=>void): number {
  const ids=new Set<string>();
  for(const segment of ensureAudioOrder(clip)) {
    const words=clip.words.filter(w=>!isPunctText(w.text)&&w.start>=segment.start&&w.start<segment.end).sort((a,b)=>a.start-b.start);
    for(let i=0;i<words.length;) {
      if(!words[i]!.deleted){i++;continue;}
      const run: Clip['words']=[];while(i<words.length&&words[i]!.deleted)run.push(words[i++]!);
      if(run.some(w=>w.manualBoundary)||run.every(w=>w.continuousCut))continue;
      if(!clip.ranges.some(r=>Math.min(r.end,run.at(-1)!.end)-Math.max(r.start,run[0]!.start)>1e-7))continue;
      for(const w of run)ids.add(w.id);
    }
  }
  if(!ids.size)return 0;
  beforeChange?.();
  return deleteWordRuns(clip,ids);
}

/** One-time upgrade for old drafts: use the ordinary deletion path, preserve
 * deliberate manual cuts, and create an undo point only when audio changes. */
export function repairDeletedEdges(clip:EditableClip, beforeChange?:()=>void):number {
  const ids=new Set<string>();
  for(const part of ensureAudioOrder(clip)){
    const words=clip.words.filter(w=>!isPunctText(w.text)&&w.start>=part.start&&w.start<part.end).sort((a,b)=>a.start-b.start);
    for(let i=0;i<words.length;){
      if(!words[i]!.deleted){i++;continue;}
      const run:Clip['words']=[];while(i<words.length&&words[i]!.deleted)run.push(words[i++]!);
      if(!run.some(w=>w.manualBoundary))for(const w of run)ids.add(w.id);
    }
  }
  if(!ids.size)return 0;
  const result={...clip,words:clip.words.map(w=>({...w,removedAudio:w.removedAudio?.map(r=>({...r}))})),ranges:clip.ranges.map(r=>({...r})),audioOrder:clip.audioOrder?.map(r=>({...r}))};
  const removed=deleteWordRuns(result,ids);
  if(removed>1e-7){beforeChange?.();clip.words=result.words;clip.ranges=result.ranges;clip.audioOrder=result.audioOrder;}
  return removed;
}
