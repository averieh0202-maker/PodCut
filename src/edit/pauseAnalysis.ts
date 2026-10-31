import type { Word, TimeRange } from './types';
import type { ManualPause } from './pauseEditing';
import { bufferAcoustics } from './acoustics';
import { detectBreaths } from './breaths';
import { detectPauses, mergePauseCandidates, groupPauseMarks, pauseGroupDisplay, type PauseCandidate, type PauseGroup } from './pauses';
interface PauseClip {
 words:Word[]; ranges:TimeRange[]; duration:number; audioOrder:TimeRange[];
 buffer:AudioBuffer;cleanBuffer?:AudioBuffer;manualPauses?:ManualPause[];
 clearedPauses?:Array<TimeRange&{id:string}>;
}
interface Analysis {key:string;buffer:AudioBuffer;pauses:PauseCandidate[];groups:PauseGroup[]}
const cache=new WeakMap<PauseClip,Analysis>();
/** Audio is immutable. Include editable values rather than array identity:
 * word-boundary dragging and pause restore can mutate those arrays in place. */
export function analyzeClipPauses(clip:PauseClip,withBreaths=true):Analysis {
 const buffer=clip.cleanBuffer||clip.buffer;
 const key=JSON.stringify([withBreaths,clip.duration,clip.words.map(w=>[w.id,w.text,w.start,w.end,w.deleted,!!w.manualBoundary,!!w.alignmentSource]),clip.ranges,clip.audioOrder,clip.manualPauses,clip.clearedPauses]);
 const hit=cache.get(clip);if(hit?.buffer===buffer&&hit.key===key)return hit;
 const manual=clip.manualPauses??[],acoustic=bufferAcoustics(buffer);
 const merged=mergePauseCandidates([...detectPauses(clip.words,clip.ranges,acoustic,clip.duration),...(withBreaths?detectBreaths(clip.words,clip.ranges,acoustic,clip.duration):[])]);
 const detected=merged.filter(p=>!manual.some(m=>(p.start<m.sourceEnd&&p.end>m.sourceStart)||(p.start<m.end&&p.end>m.start)));
 const pauses=[...detected,...manual.flatMap(m=>clip.ranges.map((r,i)=>({id:`${m.id}-${i}`,start:Math.max(m.start,r.start),end:Math.min(m.end,r.end)})).filter(r=>r.end-r.start>=.1-1e-7).map(r=>({...r,duration:r.end-r.start,cut:r})))];
 const groups=groupPauseMarks(clip.words,[...pauses,...(clip.clearedPauses??[]).map(p=>({...p,cleared:true}))],clip.audioOrder).filter(g=>pauseGroupDisplay(g));
 const value={key,buffer,pauses,groups};cache.set(clip,value);return value;
}
