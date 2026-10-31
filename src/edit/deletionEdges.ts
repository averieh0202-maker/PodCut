import type { Clip, TimeRange, Word } from './types';
import { bufferAcoustics, envelope, type AcousticInput } from './acoustics';
import { removeRange } from './timeline';

type EdgeClip = Pick<Clip,'duration'|'ranges'> & Partial<Pick<Clip,'buffer'|'cleanBuffer'|'manualPauses'|'clearedPauses'>>;
export type DeletionAudio = AcousticInput | readonly AcousticInput[];
/** Edges belong to the deleted utterance only when audio supplies an edge.
 * Never pad blindly into a neighbour or consume an independent pause. */
function acousticEdge(at:number, fence:number, direction:-1|1, input:AcousticInput):number {
  const {rms,step,quiet}=envelope(input);
  const origin=input.offsetSec??0;
  const limit=direction<0?Math.max(fence,at-.4,origin):Math.min(fence,at+.4,origin+input.channel.length/input.sampleRate);
  if(direction*(limit-at)<=1e-7)return at;
  let gap=0, quietTime=0, firstActivity=false, last=at, separated=false;
  for(let t=at;direction*(limit-t)>1e-7;t+=direction*step){
    const f=direction<0?Math.ceil((t-origin)/step-1e-8)-1:Math.floor((t-origin)/step+1e-8);
    if(f<0||f>=rms.length)break;
    if(rms[f]!>quiet){
      firstActivity=true;gap=0;
      last=direction<0?Math.max(limit,origin+f*step):Math.min(limit,origin+(f+1)*step);
    }else{
      gap+=step;quietTime+=step;
      // Weak final consonants/breath tails can have several lobes separated
      // by short dips. A 40ms dip is not a safe end of a deleted utterance.
      if(gap>=.08-1e-8){separated=true;break;}
    }
  }
  // Continuous/flat energy is ambiguous. It is never permission to enlarge a cut.
  return firstActivity&&(separated||quietTime>=.025-1e-8)?last:at;
}

export function deletionAcoustics(clip:EdgeClip):AcousticInput|undefined {
  const buffer=clip.cleanBuffer??clip.buffer;
  return buffer?bufferAcoustics(buffer):undefined;
}

/** Keep only the loudest-channel 5ms envelope for CLI plans. This has the
 * same edge decisions while releasing the full decoded recording. */
export function deletionAudioSummary(input:AcousticInput):AcousticInput {
  const e=envelope(input);
  return {channel:e.rms,sampleRate:1/e.step,offsetSec:input.offsetSec};
}

/** Return supplementary cuts; original word timestamps remain editable.
 * Tiny islands enclosed by previous pause cuts and this deletion are owned by
 * the deleted run, not left to play as isolated consonants or breaths. */
export function deletionEdgeCuts(clip:EdgeClip, first:Word, last:Word, prev:Word|undefined, next:Word|undefined,
  part:TimeRange, input:DeletionAudio|undefined=deletionAcoustics(clip)):TimeRange[] {
  const guard=(w:Word|undefined)=>w?(/[a-z]/i.test(w.text)||(!w.alignmentSource&&!w.manualBoundary)? .06:.03):0;
  const lo=Math.max(part.start,(prev?.end??part.start)+guard(prev));
  const hi=Math.min(part.end,(next?.start??part.end)-guard(next));
  const cuts:TimeRange[]=[];
  const at=(time:number)=>input&&(Array.isArray(input)?input.find(x=>time>=(x.offsetSec??0)&&time<=(x.offsetSec??0)+x.channel.length/x.sampleRate):input as AcousticInput);
  const leftAudio=at(first.start),rightAudio=at(last.end);
  if(leftAudio&&!first.manualBoundary){const start=acousticEdge(first.start,lo,-1,leftAudio);if(start<first.start)cuts.push({start,end:first.start});}
  if(rightAudio&&!last.manualBoundary){const end=acousticEdge(last.end,hi,1,rightAudio);if(end>last.end)cuts.push({start:last.end,end});}
  const pauses=clip.clearedPauses??[];
  const touches=(time:number,edge:'start'|'end')=>pauses.some(p=>Math.abs(p[edge]-time)<1e-6);
  for(const r of clip.ranges){
    const leftEnd=Math.min(r.end,first.start),rightStart=Math.max(r.start,last.end);
    const left=!first.manualBoundary&&r.start>lo+1e-7&&leftEnd>r.start&&leftEnd-r.start<=.25+1e-7&&touches(r.start,'end')&&(touches(r.end,'start')||r.end>=first.start);
    const right=!last.manualBoundary&&r.end<hi-1e-7&&r.end>rightStart&&r.end-rightStart<=.25+1e-7&&(touches(r.start,'end')||r.start<=last.end)&&touches(r.end,'start');
    if(left)cuts.push({start:r.start,end:leftEnd});
    if(right)cuts.push({start:rightStart,end:r.end});
    // A pause may have been cut just before the next word. Its tiny remaining
    // prefix is part of a long kept range, not a separate range object.
    if(!last.manualBoundary&&next&&r.start>=last.end&&touches(r.start,'end')&&next.start-r.start<=.25+1e-7&&r.start<hi)
      cuts.push({start:r.start,end:Math.min(r.end,hi)});
  }
  // Manual pauses remain independent, even when acoustic activity touches them.
  return (clip.manualPauses??[]).reduce((parts,p)=>removeRange(parts,p.start,p.end),cuts);
}
