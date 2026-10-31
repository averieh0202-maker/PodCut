import type { MixSchedule } from './mixSchedule';
/** Only spoken intervals change duration. Inserted music and lead-ins stay 1×. */
export function speechTempoMap(mix:MixSchedule,rate:number) {
  rate = normalizeSpeechRate(rate);
  const pieces:Array<{start:number;end:number;wallStart:number;wallEnd:number;rate:number}>=[];
  let original=0,wall=0;
  const add=(start:number,end:number,speed:number)=>{if(end<=start)return;pieces.push({start,end,wallStart:wall,wallEnd:wall+(end-start)/speed,rate:speed});wall+=(end-start)/speed;original=end;};
  for(const seg of mix.segs){if(seg.projectStart>original)add(original,seg.projectStart,1);add(seg.projectStart,seg.projectEnd,seg.kind==='speech'?rate:1);}
  if(original<mix.totalDuration)add(original,mix.totalDuration,1);
  const toWall=(t:number)=>{
    const p=pieces.find(p=>t<p.end-1e-9)??pieces.at(-1);
    return p?p.wallStart+(Math.max(p.start,t)-p.start)/p.rate:t;
  };
  const toProject=(t:number)=>{
    const p=pieces.find(p=>t<p.wallEnd-1e-9)??pieces.at(-1);
    return p?p.start+(Math.max(p.wallStart,t)-p.wallStart)*p.rate:t;
  };
  return {toWall,toProject,pieces};
}

export function normalizeSpeechRate(rate:unknown):number {
  return typeof rate==='number' && Number.isFinite(rate) && rate>=.5 && rate<=2 ? rate : 1;
}
export function tempoDuration(mix:MixSchedule,rate:number):number {
  rate=normalizeSpeechRate(rate);
  const map=speechTempoMap(mix,rate);
  return mix.sources.reduce((end,s)=>Math.max(end,map.toWall(s.whenEdit)+s.duration/(s.role==='speech'?rate:1)),0);
}
