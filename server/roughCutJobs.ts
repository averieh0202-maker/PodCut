import { podcastSkill } from './podcastSkill';
import { planEpisode } from './episodeEditorial';
import { episodeSegments } from '../src/edit/episodeTimeline';
import { assembleProduction } from './episodeAssembly';
import { productionOptions,type ProductionOptions } from '../src/edit/agentProduction';
import { randomUUID,createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DiskDraftStore,type DiskSnapshot } from './diskDraftStore';
import { planRoughCut,validateDecisions,deepSeekAsk,type Ask,type CutDecision } from './roughCutPlanner';
import { deleteWordRuns } from '../src/edit/deleteRuns';
import type { DeletionAudio } from '../src/edit/deletionEdges';
import { loadDeletionAudio } from './deletionAudio';
import { pauseExceedsThreshold } from '../src/edit/pauses';
import { deletePauseParts } from '../src/edit/pauseEditing';
import { isPunctText } from '../src/edit/alignment';
import type { TimeRange } from '../src/edit/types';
export interface PauseProposal {clipId:string;parts:TimeRange[];breath?:boolean}
export interface StartRoughCut {id:string;revision:string;reference:string;referenceName?:string;pauses:PauseProposal[];threshold:number;breaths:boolean;production?:ProductionOptions}
export interface Seam {clipId:string;start:number;end:number;label:string;reason:string}
interface Job {
 id:string;pid?:number;createdAt:number;updatedAt:number;status:'running'|'awaiting_selection'|'ready'|'applied'|'undone'|'error'|'cancelled';stage:string;
 skill?:{version:string;sha256:string};editorial?:Awaited<ReturnType<typeof planEpisode>>;edited?:any;selectedIds?:string[];resultAssets?:DiskSnapshot['assets'];
 input:StartRoughCut;base:DiskSnapshot;result?:unknown;cuts?:CutDecision[];seams?:Seam[];removedSeconds?:number;error?:string;
}
const signature=(payload:any)=>createHash('sha256').update(JSON.stringify({...payload,savedAt:0,activeClipId:null})).digest('hex');
const kept=(c:any)=>c.ranges.reduce((s:number,r:TimeRange)=>s+r.end-r.start,0);
export function executePlan(payload:any,cuts:CutDecision[],pauses:PauseProposal[],audio?:ReadonlyMap<string,DeletionAudio>) {
 if(validateDecisions({cuts},payload.clips).length!==cuts.length)throw Error('初剪范围未通过复核，原稿未改动');
 const result=structuredClone(payload),seams:Seam[]=[];let removedSeconds=0;
 for(const clip of result.clips){
  const before=kept(clip);
  const ids=new Set<string>();
  for(const cut of cuts.filter(x=>x.clipId===clip.id)){
   const a=clip.words.findIndex((w:any)=>w.id===cut.startWordId),b=clip.words.findIndex((w:any)=>w.id===cut.endWordId);
   for(const w of clip.words.slice(a,b+1)){ids.add(w.id);w.roughCutReason=cut.reason;}
   seams.push({clipId:clip.id,start:clip.words[a].start,end:clip.words[b].end,label:cut.quote,reason:cut.reason});
  }
  if(ids.size)deleteWordRuns(clip,ids,false,audio?.get(clip.id));
  for(const [i,p] of pauses.filter(p=>p.clipId===clip.id).entries()){
   // Background candidates are tied to this saved snapshot. Protect every
   // retained word here, even if the acoustic detector lacked alignment.
   let parts=p.parts;
   for(const w of clip.words.filter((w:any)=>!w.deleted&&!isPunctText(w.text)))parts=parts.flatMap(r=>r.start<w.end&&r.end>w.start?[...(r.start<w.start?[{start:r.start,end:w.start}]:[]),...(r.end>w.end?[{start:w.end,end:r.end}]:[])]:[r]);
   const added=deletePauseParts(clip,parts,`agent-${i}-${randomUUID()}`);
   if(added.length)seams.push({clipId:clip.id,start:Math.min(...added.map(p=>p.start)),end:Math.max(...added.map(p=>p.end)),label:'停顿',reason:p.breath?'超过设定时长的停顿（含吸气）':'超过设定时长的停顿'});
  }
  removedSeconds+=before-kept(clip);
  // Coverage must only shrink, and no originally retained word outside the
  // plan may lose any of its samples. Music and source audio are untouched.
  const original=payload.clips.find((c:any)=>c.id===clip.id);
  const overlap=(ranges:TimeRange[],w:TimeRange)=>ranges.reduce((s,r)=>s+Math.max(0,Math.min(r.end,w.end)-Math.max(r.start,w.start)),0);
  for(const w of clip.words.filter((w:any)=>!w.deleted&&!isPunctText(w.text)))if(overlap(clip.ranges,w)+1e-6<overlap(original.ranges,w))throw Error('接缝检查发现相邻字音受损，初剪未保存');
 }
 seams.sort((a,b)=>{
  const ca=result.clips.findIndex((c:any)=>c.id===a.clipId),cb=result.clips.findIndex((c:any)=>c.id===b.clipId);
  if(ca!==cb)return ca-cb;
  const order=result.clips[ca].audioOrder??[];
  const part=(t:number)=>order.findIndex((r:TimeRange)=>t>=r.start-1e-7&&t<r.end+1e-7);
  return part(a.start)-part(b.start)||a.start-b.start;
 });
 result.savedAt=Date.now();return {result,seams,removedSeconds};
}
export class RoughCutJobs {
 private active=new Map<string,AbortController>();
 readonly root:string;
 constructor(readonly store:DiskDraftStore,readonly env:NodeJS.ProcessEnv,readonly askFactory:(signal:AbortSignal)=>Ask|Promise<Ask>=signal=>deepSeekAsk(env,signal)){this.root=path.join(store.root,'rough-cuts');}
 private file(id:string){if(!/^[a-zA-Z0-9-]{12,80}$/.test(id))throw Error('无效初剪任务');return path.join(this.root,id+'.json');}
 private async write(job:Job){await fs.mkdir(this.root,{recursive:true,mode:0o700});job.updatedAt=Date.now();const target=this.file(job.id),temp=target+'.'+randomUUID()+'.tmp';const handle=await fs.open(temp,'wx',0o600);try{await handle.writeFile(JSON.stringify(job));await handle.sync();await handle.close();await fs.rename(temp,target);const d=await fs.open(this.root,'r');try{await d.sync();}finally{await d.close();}}finally{await handle.close().catch(()=>{});await fs.unlink(temp).catch(()=>{});}}
 private async read(id:string):Promise<Job>{return JSON.parse(await fs.readFile(this.file(id),'utf8'));}
 private view(j:Job){return {skill:j.skill,production:j.input.production,highlights:j.editorial?.highlights,selectedIds:j.selectedIds,id:j.id,createdAt:j.createdAt,status:j.status,stage:j.stage,referenceName:j.input.referenceName,reference:j.input.reference,threshold:j.input.threshold,breaths:j.input.breaths,removedSeconds:j.removedSeconds??0,textCuts:j.cuts?.length??0,seams:j.seams??[],error:j.error};}
 async get(id:string){const j=await this.read(id);let alive=false;if(j.pid)try{process.kill(j.pid,0);alive=true;}catch{}if(j.status==='running'&&!this.active.has(id)&&!alive){j.status='error';j.error='本机服务曾重启，任务已停止；原稿未改动，可重新初剪';await this.write(j);}return this.view(j);}
 async latest(){await fs.mkdir(this.root,{recursive:true});const names=(await fs.readdir(this.root)).filter(n=>/^[a-zA-Z0-9-]{12,80}\.json$/.test(n));let latest:Job|undefined;for(const n of names){const j=await this.read(n.slice(0,-5));if(!latest||j.createdAt>latest.createdAt)latest=j;}return latest?this.get(latest.id):null;}
 async start(input:StartRoughCut){
  this.file(input.id);
  const exists=await this.read(input.id).catch(()=>null);if(exists)return this.view(exists);
  if(this.active.size)throw Error('已有初剪任务运行中');
  if(typeof input.reference!=='string'||input.reference.length>50000)throw Error('参考稿最多 5 万字');
  if(!Number.isFinite(input.threshold)||input.threshold<.1||input.threshold>3||!Array.isArray(input.pauses)||input.pauses.length>5000)throw Error('初剪选项无效');
  const {snapshot:base}=await this.store.read();if(!base||(base.payload as any)?.clips?.length<1)throw Error('请先导入录音并保存本机草稿');
  if(base.revision!==input.revision)throw Error('草稿已被更新，请先重新载入后初剪');
  const clips=(base.payload as any).clips;const words=clips.flatMap((c:any)=>c.words.filter((w:any)=>!w.deleted));
  if(!words.length||words.length>40000)throw Error('第一版支持含 1–40000 个字词的录音');
  if(!words.some((w:any)=>!isPunctText(w.text)&&(w.alignmentSource||w.manualBoundary)))throw Error('请先完成全部片段的「校准字界」，再进行自动初剪');
  for(const p of input.pauses){const c=clips.find((c:any)=>c.id===p.clipId);if(!c||!Array.isArray(p.parts)||!p.parts.length||p.parts.length>2000||p.parts.some(r=>!Number.isFinite(r.start)||!Number.isFinite(r.end)||r.start<0||r.end>c.duration||r.end<=r.start)||!pauseExceedsThreshold(p.parts,input.threshold))throw Error('停顿候选与设定不一致');}
  if(input.production){input.production=productionOptions(input.production);if(input.production.highlights!=='none'&&clips.some((c:any)=>c.id.startsWith('teaser-')))throw Error('工程已有片头精句，请选择不添加精句');}
  const materialAssets=['opening','transition','ending'].flatMap(key=>{const m=(input.production as any)?.[key];return m?[m.asset]:[];});
  const resultAssets=[...new Map([...base.assets,...materialAssets].map(a=>[a.id,a])).values()];
  await this.store.validate({...base,assets:resultAssets});
  const skill=podcastSkill();
  const j:Job={skill:{version:skill.version,sha256:skill.sha256},resultAssets,id:input.id,pid:process.pid,createdAt:Date.now(),updatedAt:Date.now(),status:'running',stage:'准备内容初剪',input,base};const controller=new AbortController();if(this.active.size)throw Error('已有初剪任务运行中');this.active.set(j.id,controller);
  try{await this.write(j);}catch(e){this.active.delete(j.id);throw e;}
  void this.run(j,controller);return this.view(j);
 }
 private async run(j:Job,controller:AbortController){try{
  const progress=async(stage:string)=>{controller.signal.throwIfAborted();j.stage=stage;await this.write(j);};
  const ask=await this.askFactory(controller.signal);
  const cuts=await planRoughCut((j.base.payload as any).clips,j.input.reference,ask,progress);
  controller.signal.throwIfAborted();await progress('检查切点并保存初剪草稿');
  const audio=await loadDeletionAudio(this.store,j.base.payload,cuts,controller.signal);
  Object.assign(j,executePlan(j.base.payload,cuts,j.input.pauses,audio),{cuts});
  if(j.input.production){
   const options=j.input.production;j.edited=j.result;
   if(options.highlights!=='none'||options.transition){
    await progress('根据剪后内容选择完整精句与话题切换');
    j.editorial=await planEpisode(episodeSegments((j.edited as any).clips.filter((c:any)=>!c.id.startsWith('teaser-'))),j.input.reference,ask,{highlights:options.highlights!=='none'});
   }
   controller.signal.throwIfAborted();
   if(options.highlights==='choose'){j.result=undefined;j.status='awaiting_selection';j.stage='初剪已完成，等待选择片头精句';await this.write(j);return;}
   j.selectedIds=options.highlights==='auto'?j.editorial!.highlights.slice(0,options.highlightCount).map(h=>h.id):[];
   j.result=assembleProduction(j.edited,options,j.editorial,j.selectedIds);
  }
  j.status='ready';j.stage='初剪与配乐已保存到本机';await this.write(j);
 }catch(e){j.status=controller.signal.aborted?'cancelled':'error';j.stage='原稿未改动';j.error=controller.signal.aborted?'已取消初剪':e instanceof Error?e.message:String(e);await this.write(j);}finally{this.active.delete(j.id);}}
 async select(id:string,selectedIds:string[]){
  const j=await this.read(id);if(j.status!=='awaiting_selection'||!j.input.production||!j.edited)throw Error('当前不在精句选择阶段');
  if(!Array.isArray(selectedIds))throw Error('请选择精句');
  if(selectedIds.length===0)j.input.production.highlights='none';
  j.result=assembleProduction(j.edited,j.input.production,j.editorial,selectedIds);j.selectedIds=selectedIds;j.status='ready';j.stage='已按选择组装片头和配乐';await this.write(j);return this.view(j);
 }
 async cancel(id:string){const controller=this.active.get(id);if(controller)controller.abort();return this.get(id);}
 async apply(id:string,revision:string){
  const j=await this.read(id);if(!['ready','applied','undone'].includes(j.status)||!j.result)throw Error('初剪尚未完成');
  const {snapshot:current}=await this.store.read();if(!current||current.revision!==revision)throw Error('草稿已更新，初剪结果仍保存在本机；没有覆盖新修改');
  if(signature(current.payload)===signature(j.result)){j.status='applied';await this.write(j);return this.view(j);}
  if(signature(current.payload)!==signature(j.base.payload))throw Error('初剪开始后原稿已有新修改。初剪结果已保留，请继续当前编辑，避免覆盖');
  await this.store.save(j.result,j.resultAssets??j.base.assets,current.revision);j.status='applied';j.stage='已打开初剪';await this.write(j);return this.view(j);
 }
 async undo(id:string,revision:string){
  const j=await this.read(id);if(j.status!=='applied'||!j.result)throw Error('当前没有可撤销的整次初剪');
  const {snapshot:current}=await this.store.read();if(!current||current.revision!==revision||signature(current.payload)!==signature(j.result))throw Error('初剪后已有其他修改。为保留这些修改，请用文字/停顿的「复原」逐处恢复');
  await this.store.save(j.base.payload,j.base.assets,current.revision);j.status='undone';j.stage='已撤销整次初剪';await this.write(j);return this.view(j);
 }
}
