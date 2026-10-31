import { randomUUID } from 'node:crypto';
import { productionOptions,type ProductionOptions,type AgentMaterial } from '../src/edit/agentProduction';
import type { planEpisode } from './episodeEditorial';
import { episodeSegments } from '../src/edit/episodeTimeline';
import { isPunctText } from '../src/edit/alignment';
type Editorial=Awaited<ReturnType<typeof planEpisode>>;
export function assembleProduction(payload:any,raw:ProductionOptions,editorial:Editorial|undefined,selectedIds:string[]=[]){
 const options=productionOptions(raw),result=structuredClone(payload);
 const spoken=(c:any)=>c.words.filter((w:any)=>!w.deleted&&!isPunctText(w.text)&&c.ranges.some((r:any)=>r.start<w.end&&r.end>w.start));
 const originalBody=result.clips.filter((c:any)=>!c.id.startsWith('teaser-'));
 if(!originalBody.some((c:any)=>spoken(c).length))throw Error('没有可保留的人声');
 if(options.highlights!=='none'&&result.clips.some((c:any)=>c.id.startsWith('teaser-')))throw Error('工程已有片头精句，请选择不添加精句，避免重复组装');
 if(options.highlights==='none'&&selectedIds.length)throw Error('当前未启用片头精句');
 if(options.highlights!=='none'&&(!selectedIds.length||selectedIds.length>5||new Set(selectedIds).size!==selectedIds.length))throw Error('请选择 1–5 条不同精句');
 const teasers=selectedIds.map((id,i)=>{
  const h=editorial?.highlights.find(h=>h.id===id);if(!h||h.parts.length!==1)throw Error('精句选择无效');
  const segs=h.parts[0].segments,original=result.clips.find((c:any)=>c.id===segs[0].clipId);
  if(!original)throw Error('精句录音不存在');
  const a=original.words.findIndex((w:any)=>w.id===segs[0].startWordId),b=original.words.findIndex((w:any)=>w.id===segs.at(-1).endWordId);
  if(a<0||b<a)throw Error('精句字范围无效');
  const words=original.words.slice(a,b+1),kept=words.filter((w:any)=>!w.deleted&&!isPunctText(w.text));
  if(!kept.length||kept.some((w:any,n:number)=>n>0&&w.start<kept[n-1].start))throw Error('精句跨越倒序音频，请选择连续原话');
  const start=kept[0].start,end=kept.at(-1).end,clipId='teaser-'+randomUUID();
  const ranges=original.ranges.map((r:any)=>({start:Math.max(start,r.start),end:Math.min(end,r.end)})).filter((r:any)=>r.end>r.start);
  if(!ranges.length)throw Error('精句没有可播放音频');
  return {...structuredClone(original),id:clipId,name:`片头精句 ${i+1} · ${h.title}`,words:words.map((w:any)=>({...w,id:clipId+'-'+w.id})),ranges,audioOrder:[{start,end}],clearedPauses:[],manualPauses:[]};
 });
 result.clips.unshift(...teasers);result.speechRate=options.speechRate;
 result.music=options.musicMode==='keep'?(result.music??[]):[];
 const first=result.clips.find((c:any)=>spoken(c).length),firstBody=originalBody.find((c:any)=>spoken(c).length);
 const last=[...originalBody].reverse().find((c:any)=>spoken(c).length);
 const music=(material:AgentMaterial|undefined,clip:any,word:any,kind:'bed'|'stinger',gainDb:number,side='before',lead=0,outPoint?:number)=>{
  if(!material)return;
  result.music.push({id:'agent-music-'+randomUUID(),name:material.name,kind,gainDb,clipId:clip.id,wordId:word.id,originalTime:side==='before'?word.start:word.end,anchorSide:side,inPoint:0,outPoint:outPoint??material.duration,leadInSec:lead,fadeInSec:kind==='bed'?1.5:.1,fadeOutSec:kind==='bed'?1.5:.3,source:{mime:material.mime,blob:{diskAsset:material.asset.id,bytes:material.asset.bytes,kind:'blob',mime:material.mime}}});
 };
 if(options.musicMode==='configure'){
  if(options.opening){
   const lead=Math.min(options.openingLeadSec,options.opening.duration);
   const voiceSeconds=teasers.reduce((n,c)=>n+c.ranges.reduce((sum:number,r:any)=>sum+r.end-r.start,0),0)/options.speechRate;
   const duration=Math.min(options.opening.duration,options.openingScope==='highlights'&&teasers.length?lead+voiceSeconds:options.openingDurationSec);
   music(options.opening,first,spoken(first)[0],'bed',options.bedGainDb,'before',Math.min(lead,duration),duration);
  }
  if(options.transition){
   const bodySegments=episodeSegments(originalBody),anchors=new Set<string>();
   const add=(clip:any,word:any)=>{const key=clip.id+':'+word.id;if(anchors.has(key))return;anchors.add(key);music(options.transition,clip,word,'stinger',options.transitionGainDb);};
   if(teasers.length)add(firstBody,spoken(firstBody)[0]);
   for(const chapter of editorial?.chapters??[]){const seg=bodySegments.find(s=>s.id===chapter.id);if(!seg)continue;const c=originalBody.find((c:any)=>c.id===seg.clipId),w=c.words.find((w:any)=>w.id===seg.startWordId);if(c===firstBody&&w.id===spoken(firstBody)[0].id)continue;add(c,w);}
  }
  if(options.ending){
   const w=spoken(last).at(-1);
   last.ranges=last.ranges.map((r:any)=>({...r,end:Math.min(r.end,w.end)})).filter((r:any)=>r.end>r.start);
   music(options.ending,last,w,'stinger',options.endingGainDb,'after');
  }
 }
 result.activeClipId=teasers[0]?.id??result.activeClipId;result.savedAt=Date.now();
 return result;
}
