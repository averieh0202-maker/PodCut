import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {publishEpisode} from './episodeEditorial';
import type {Ask} from './roughCutPlanner';
import type {EpisodeSegment} from '../src/edit/episodeTimeline';
import {validatePublicationSegments} from '../src/edit/publicationTranscript';

const EXPORT_VERSION='2026-10-22-transcript-only';
export type PublicationKind='transcript'|'showNotes';
export class PublicationStore {
 private active=new Map<string,Promise<void>>();
 constructor(private root:string){}
 private async atomic(file:string,value:unknown){const tmp=file+'.'+randomUUID()+'.tmp';await writeFile(tmp,JSON.stringify(value));await rename(tmp,file);}
 async latest(){
  try{
   const {key}=JSON.parse(await readFile(join(this.root,'publications/latest.json'),'utf8'));
   if(!/^[a-f0-9]{64}$/.test(key))return null;
   const state=JSON.parse(await readFile(join(this.root,'publications',key,'status.json'),'utf8'));
   // Archived AI rewrites stay on disk but must not reappear as the current export.
   if(state.version!==EXPORT_VERSION)return null;
   if(!state.done&&!state.error&&!this.active.has(key)&&Date.now()-state.updatedAt>300000)state.error='生成已中断，可点击重试';
   return state;
  }catch{return null;}
 }
 async start(segments:EpisodeSegment[],ask?:Ask,reference='',options:{force?:boolean;kind?:PublicationKind}={}){
  validatePublicationSegments(segments);
  if(JSON.stringify(segments).length>2e6)throw Error('剪后文字稿过大');
  const kind=options.kind??'transcript';
  if(kind!=='transcript'&&kind!=='showNotes')throw Error('不支持的导出类型');
  if(kind==='showNotes'&&!ask)throw Error('生成简介与时间戳需要先绑定 AI API');
  const key=createHash('sha256').update(JSON.stringify({version:EXPORT_VERSION,kind,segments,reference:kind==='showNotes'?reference:''})).digest('hex');
  const dir=join(this.root,'publications',key);await mkdir(dir,{recursive:true});
  await this.atomic(join(this.root,'publications/latest.json'),{key});
  const old=await readFile(join(dir,'status.json'),'utf8').then(JSON.parse).catch(()=>null);
  if(old?.done||this.active.has(key))return old;
  let state:any={key,version:EXPORT_VERSION,kind,stage:kind==='showNotes'?'准备生成简介与时间戳':'整理剪后文字',percent:0,updatedAt:Date.now()};
  const update=async(value:unknown)=>{state={...state,...value as object,updatedAt:Date.now()};await this.atomic(join(dir,'status.json'),state);};
  await update({error:null,done:false});
  const work=(async()=>{try{
   const result=await publishEpisode(segments,kind==='showNotes'?ask:undefined,reference,async(stage,done,total)=>update({stage,percent:Math.round(5+90*done/Math.max(1,total))}));
   await writeFile(join(dir,'article.md'),result.article);
   if(result.showNotes)await writeFile(join(dir,'show-notes.md'),result.showNotes);
   await writeFile(join(dir,'export-info.md'),result.factReport);
   await this.atomic(join(dir,'editorial-audit.json'),result.editorialAudit);
   await update({stage:'已保存到本机',percent:100,done:true,result});
  }catch(e){await update({stage:'生成失败',error:e instanceof Error?e.message:String(e)});}finally{this.active.delete(key);}})();
  this.active.set(key,work);return state;
 }
}
