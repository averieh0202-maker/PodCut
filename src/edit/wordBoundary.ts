import type { Clip, Word } from './types';
import { isPunctText } from './alignment';
import { addRange, removeRange } from './timeline';
import { ensureAudioOrder } from './audioOrder';

/** Changing a deleted word replaces only its own cut and preserves all other exclusions. */
export function updateWordBoundary(clip: Pick<Clip,'words'|'ranges'|'duration'|'audioOrder'|'clearedPauses'|'manualPauses'>, word: Word, start: number, end: number): void {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > clip.duration + 1e-7 || end - start < 0.02 - 1e-7) throw new Error('请输入有效字界，至少保留 0.02 秒选区');
  ensureAudioOrder(clip);
  if (word.deleted) {
    for (const r of word.removedAudio ?? [{start:word.start,end:word.end}]) clip.ranges=addRange(clip.ranges,r.start,r.end);
    for (const other of clip.words) {
      if (other === word || !other.deleted || isPunctText(other.text)) continue;
      for (const r of other.removedAudio ?? [{start:other.start,end:other.end}]) clip.ranges=removeRange(clip.ranges,r.start,r.end);
    }
    for (const pause of clip.clearedPauses ?? []) clip.ranges=removeRange(clip.ranges,pause.start,pause.end);
    word.removedAudio=clip.ranges.map(r=>({start:Math.max(start,r.start),end:Math.min(end,r.end)})).filter(r=>r.end>r.start);
    clip.ranges=removeRange(clip.ranges,start,end);
  }
  if (!word.deleted) {
    // A retained word owns its manually selected audio. Shrink overlapping
    // pause cuts as well as their labels; never resurrect another deleted word.
    clip.clearedPauses = (clip.clearedPauses ?? []).flatMap(p => {
      const a=Math.max(start,p.start), b=Math.min(end,p.end);
      if (b>a) clip.ranges=addRange(clip.ranges,a,b);
      return removeRange([p],start,end).map((part,i)=>({...part,id:i ? `${p.id}-right` : p.id}));
    });
    clip.manualPauses = (clip.manualPauses ?? []).flatMap(p =>
      removeRange([p],start,end).map((part,i)=>({...p,...part,id:i ? `${p.id}-right` : p.id})));
    for (const other of clip.words) if (other.deleted && !isPunctText(other.text)) {
      for (const cut of other.removedAudio ?? [{start:other.start,end:other.end}]) clip.ranges=removeRange(clip.ranges,cut.start,cut.end);
    }
  }
  word.start=start;word.end=end;word.estimated=false;word.manualBoundary=true;
  ensureAudioOrder(clip);
}
