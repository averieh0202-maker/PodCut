import { speechTempoMap } from '../audio/speechTempo';
import { buildMixSchedule, resolveSpeechEditTime } from '../audio/mixSchedule';
export interface EpisodeSegment {id:string;clipId:string;startWordId:string;endWordId:string;text:string;start:number;end:number;speakerId?:string;speakerName?:string}
/** Derive timecodes from the actual kept audio, including music and lead-ins. */
export function episodeSegments(clips:any[],music:any[]=[],speechRate=1):EpisodeSegment[]{
 const scheduleClips=clips.map(c=>({...c,buffer:c.buffer||{duration:c.duration}}));
 const placements=music.map(m=>({...m,buffer:m.buffer||{duration:m.duration??m.outPoint??0}}));
 const schedule=buildMixSchedule(scheduleClips,placements);
 const projectAt=(time:number,end=false)=>{for(const s of schedule.segs)if(s.kind==='speech'&&(end ? time>s.speechStart+1e-8&&time<=s.speechEnd+1e-8 : time>=s.speechStart-1e-8&&time<s.speechEnd-1e-8))return s.projectStart+time-s.speechStart;return schedule.segs.filter(s=>s.kind==='speech').at(-1)?.projectEnd??0;};
 const out:EpisodeSegment[]=[];
 for(const c of clips){let group:any[]=[];
  const flush=()=>{if(!group.length)return;const first=group.find(w=>w.end>w.start)||group[0],last=[...group].reverse().find(w=>w.end>w.start)||group.at(-1);const t=resolveSpeechEditTime(scheduleClips,c.id,first.start);if(t!==null)out.push({id:`${c.id}:${first.id}`,clipId:c.id,startWordId:group[0].id,endWordId:group.at(-1).id,text:group.map(w=>w.text).join(''),speakerId:group[0].speakerId,speakerName:group[0].speakerName,start:projectAt(t),end:projectAt(resolveSpeechEditTime(scheduleClips,c.id,last.end)??t,true)});group=[];};
  for(const w of c.words){if(!w.deleted&&(w.end===w.start||c.ranges.some((r:any)=>r.start<w.end&&r.end>w.start))){if(group.length && group[0].speakerId!==w.speakerId)flush();group.push(w);if(w.breakAfter||/[。！？!?]$/.test(w.text)||group.map(x=>x.text).join('').length>=180)flush();}}flush();
 }
 const tempo=speechTempoMap(schedule,speechRate);
 return out.map(s=>({...s,start:tempo.toWall(s.start),end:tempo.toWall(s.end)}));
}
