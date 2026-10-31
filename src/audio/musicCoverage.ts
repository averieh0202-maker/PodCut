import { speechTempoMap } from './speechTempo';
import type { MixSchedule, ScheduleClip } from './mixSchedule';
import { isPunctText } from '../edit/alignment';

export interface TimedWord { id:string; clipId:string; text:string; start:number; end:number }
/** Map retained word pieces through the same inserted gaps used by playback. */
export function mixedWords(clips:ScheduleClip[], mix:MixSchedule):TimedWord[] {
  const speech=mix.segs.filter(s=>s.kind==='speech');
  const at=(t:number,end=false)=>{
    let lo=0,hi=speech.length;
    while(lo<hi){const m=(lo+hi)>>>1;if(speech[m]!.speechEnd < t+(end?-1e-8:1e-8))lo=m+1;else hi=m;}
    const seg=speech[Math.min(lo,speech.length-1)];
    return seg?seg.projectStart+Math.max(0,Math.min(seg.speechEnd-seg.speechStart,t-seg.speechStart)):0;
  };
  const out:TimedWord[]=[];let base=0;
  for(const c of clips){
    for(const r of c.ranges){
      for(const w of c.words??[]){
        if(w.deleted||isPunctText(w.text))continue;
        const a=Math.max(r.start,w.start),b=Math.min(r.end,w.end);
        if(b>a+1e-8)out.push({id:w.id,clipId:c.id,text:w.text,start:at(base+a-r.start),end:at(base+b-r.start,true)});
      }
      base+=r.end-r.start;
    }
  }
  return out.sort((a,b)=>a.start-b.start);
}
export function musicCoverage(placementId:string,words:TimedWord[],mix:MixSchedule,rate=1) {
  const source=mix.sources.find(s=>s.placementId===placementId);
  if(!source)return null;
  const tempo=speechTempoMap(mix,rate);
  const start=source.whenEdit,end=tempo.toProject(tempo.toWall(start)+source.duration);
  const covered=new Set(words.filter(w=>w.start<end-1e-7&&w.end>start+1e-7).map(w=>w.id));
  let word=words.find(w=>w.start<end-1e-7&&w.end>=end-1e-7);
  let side:'inside'|'before'|'after'='inside';
  if(!word){word=words.find(w=>w.start>=end-1e-7);side='before';}
  if(!word){word=words.at(-1);side='after';}
  if(word&&Math.abs(end-word.end)<1e-7)side='after';
  const index=word?words.indexOf(word):-1;
  const context=index<0?'':words.slice(Math.max(0,index-5),index+6).map(w=>w===word?`「${w.text}」`:w.text).join('');
  const gap=word?(side==='before'?word.start-end:side==='after'?end-word.end:0):0;
  return {start,end,outputEnd:tempo.toWall(start)+source.duration,covered,word,side,context,gap};
}
