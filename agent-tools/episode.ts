import {promises as fs,createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {referenceText} from '../server/roughCutPlugin';
import {recognize,readVolcCredsFromEnv} from '../server/volcAsr';
import {alignmentChunks,mapAlignedTokens,applyForcedAlignment} from '../src/edit/forcedAlignment';
import {detectPauses,mergePauseCandidates,groupPauseMarks,pauseExceedsThreshold} from '../src/edit/pauses';
import {detectBreaths} from '../src/edit/breaths';
import {deepSeekAsk,planRoughCut} from '../server/roughCutPlanner';
import {executePlan} from '../server/roughCutJobs';
import {deletionAudioSummary} from '../src/edit/deletionEdges';
import {episodeSegments} from '../src/edit/episodeTimeline';
import {planEpisode,publishEpisode} from '../server/episodeEditorial';
import {DiskDraftStore} from '../server/diskDraftStore';
import {projectRoot} from '../server/projectScope';
const json=async(p:string)=>JSON.parse(await fs.readFile(p,'utf8'));
async function save(p:string,value:unknown){await fs.mkdir(path.dirname(p),{recursive:true});const tmp=p+'.'+randomUUID()+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2),{mode:0o600});await fs.rename(tmp,p);}
async function digest(p:string){const h=createHash('sha256');for await(const b of createReadStream(p))h.update(b);return h.digest('hex');}
function command(bin:string,args:string[],max=500*1024**2):Promise<Buffer>{return new Promise((resolve,reject)=>{const p=spawn(bin,args,{stdio:['ignore','pipe','pipe']});const out:Buffer[]=[];let size=0,err='';p.stdout.on('data',b=>{size+=b.length;if(size>max)p.kill();else out.push(b);});p.stderr.on('data',b=>{err=(err+b).slice(-2000);});p.on('error',reject);p.on('close',code=>code===0?resolve(Buffer.concat(out)):reject(Error(`${bin} failed: ${err}`)));});}
async function probe(p:string){const v=JSON.parse((await command('ffprobe',['-v','error','-show_entries','format=duration:stream=channels','-of','json',p])).toString());return {duration:Number(v.format.duration),channels:Number(v.streams[0].channels)};}
async function pcm(p:string){const bytes=await command('ffmpeg',['-v','error','-i',p,'-vn','-ac','1','-ar','16000','-f','f32le','pipe:1']);return new Float32Array(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));}
function wav(data:Float32Array){const b=Buffer.alloc(44+data.length*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(data.length*2,40);data.forEach((x,i)=>b.writeInt16LE(Math.round(Math.max(-1,Math.min(1,x))*32767),44+i*2));return b;}
async function cacheClip(config:any,file:string,index:number,out:string,env:any){
 const hash=await digest(file),cache=path.join(out,`clip-${index}-${hash.slice(0,12)}.json`),meta=await probe(file);
 if(!(meta.duration>0))throw Error('无效录音时长');
 let clip:any;try{clip=await json(cache);}catch{}
 if(!clip){
  // Only reuse externally supplied alignment when its source hash matches exactly.
  const seed=config.aligned?.find((x:any)=>x.sha256===hash);
  let words:any[],reuseAligned=false;
  if(seed){words=(await json(seed.path)).words;reuseAligned=seed.complete===true;console.log(`复用已验证字界 ${path.basename(file)}`);}
  else{const creds=readVolcCredsFromEnv(env);if(!creds)throw Error('缺少录音转写凭据 VOLC_API_KEY');console.log(`转写 ${path.basename(file)}`);const asr=await recognize({kind:'data',buffer:await fs.readFile(file),filename:path.basename(file)},creds,{onProgress:e=>console.log('ASR',index,e.phase)});words=asr.words;}
  clip={id:`ep${index}`,name:path.basename(file,path.extname(file)),duration:meta.duration,words:words.map((w:any,i:number)=>({text:w.text,start:w.start,end:w.end,breakAfter:w.breakAfter,estimated:w.estimated,alignmentSource:w.alignmentSource,manualBoundary:w.manualBoundary,id:`ep${index}-w${i}`,deleted:false})),ranges:[{start:0,end:meta.duration}],audioOrder:[{start:0,end:meta.duration}],denoised:false,beautified:false,gainDb:config.voiceGainDb??0,sourcePath:file,sourceHash:hash,legacyDeletionRepairVersion:1,alignmentComplete:reuseAligned};await save(cache,clip);
 }
 const data=await pcm(file);
 if(!clip.alignmentComplete){
  const chunks=alignmentChunks(clip.words,clip.duration),proposals:any[]=[];
  for(const [i,c] of chunks.entries()){
   if(c.words.every(w=>w.alignmentSource||w.manualBoundary))continue;
   const chunkFile=path.join(out,`align-${index}-${hash.slice(0,12)}-${i}.json`);
   let proposal:any;try{proposal=await json(chunkFile);}catch{}
   if(!proposal){console.log(`字界 ${index}: ${i+1}/${chunks.length}`);const first=Math.floor(c.start*16000),end=Math.ceil(c.end*16000);const res=await fetch((config.previewUrl||'http://127.0.0.1:5188')+'/api/alignment',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Alignment':'1'},body:JSON.stringify({audio:wav(data.subarray(first,end)).toString('base64'),text:c.words.map(w=>w.text).join(' ')}),signal:AbortSignal.timeout(200000)});const result:any=await res.json();if(!res.ok)throw Error(result.error||'字界对齐失败');proposal=mapAlignedTokens(c,result.words);await save(chunkFile,proposal);}
   proposals.push(...proposal);
  }
  Object.assign(clip,applyForcedAlignment(clip,proposals));clip.alignmentComplete=true;await save(cache,clip);
 }
 const pauses=mergePauseCandidates([...detectPauses(clip.words,clip.ranges,{channel:data,sampleRate:16000},clip.duration),...detectBreaths(clip.words,clip.ranges,{channel:data,sampleRate:16000},clip.duration)]);
 const groups=groupPauseMarks(clip.words,pauses,clip.audioOrder).filter(g=>pauseExceedsThreshold(g.parts,config.pauseThreshold??.3));
 return {clip,audio:deletionAudioSummary({channel:data,sampleRate:16000}),pauses:groups.map(g=>({clipId:clip.id,parts:g.parts,breath:g.parts.some(p=>p.breath)}))};
}
export async function run(args:string[],root:string,env:any){
 const [action,arg,output,choice,...flags]=args;
 if(action==='prepare'){
  if(!arg||!output)throw Error('prepare <episode.json> <work-directory>');
  const config=await json(arg),out=path.resolve(output);await fs.mkdir(out,{recursive:true});
  if(!Array.isArray(config.audio)||!config.audio.length)throw Error('缺少录音文件');
  if(!Number.isFinite(config.pauseThreshold??.3)||(config.pauseThreshold??.3)<.1)throw Error('停顿阈值不得小于 0.1 秒');
  const reference=config.reference?await referenceText(await fs.readFile(config.reference),config.reference):'';
  const clips:any[]=[],pauses:any[]=[],deletionAudio=new Map();
  for(const [i,file] of config.audio.entries()){const prepared=await cacheClip(config,path.resolve(file),i+1,out,env);clips.push(prepared.clip);pauses.push(...prepared.pauses);deletionAudio.set(prepared.clip.id,prepared.audio);}
  const base={version:2,savedAt:Date.now(),audioName:config.name||'整期播客',gainDb:0,clips,music:[],activeClipId:clips[0].id,clipIdSeq:100,musicIdSeq:100};
  const signature=createHash('sha256').update(JSON.stringify({clips,pauses,reference})).digest('hex'),cutFile=path.join(out,'cuts-'+signature+'.json');
  let cuts:any;try{cuts=await json(cutFile);}catch{cuts=await planRoughCut(clips,reference,deepSeekAsk(env),async label=>{console.log(label);await save(path.join(out,'status.json'),{stage:label});});await save(cutFile,cuts);}
  const edited=executePlan(base,cuts,pauses,deletionAudio);const segments=episodeSegments(edited.result.clips);
  await save(path.join(out,'prepared-audio.json'),{config,reference,base,...edited,signature,segments});
  const editorialOverride=config.editorialPlan?await json(config.editorialPlan):null;
  const editorialKey=createHash('sha256').update(signature+JSON.stringify(editorialOverride)).digest('hex');
  const planFile=path.join(out,'plan-'+editorialKey+'.json');let editorial:any;try{editorial=await json(planFile);}catch{console.log('选择片头精华和话题转场');editorial=await planEpisode(segments,reference,async(system,data)=>{const raw=editorialOverride??await deepSeekAsk(env)(system,data);await save(path.join(out,'editorial-response.json'),raw);return raw;});await save(planFile,editorial);}
  await save(path.join(out,'prepared.json'),{config,reference,base,...edited,editorial,signature});
  const audioCache=new Map<string,Float32Array>();
  for(const h of editorial.highlights){const pieces:Float32Array[]=[];
   for(const part of h.parts){const c=edited.result.clips.find((c:any)=>c.id===part.segments[0].clipId);let data=audioCache.get(c.id);if(!data){data=await pcm(c.sourcePath);audioCache.set(c.id,data);}
    const first=c.words.find((w:any)=>w.id===part.segments[0].startWordId),last=c.words.find((w:any)=>w.id===part.segments.at(-1).endWordId);
    for(const r of c.ranges){const start=Math.max(first.start,r.start),end=Math.min(last.end,r.end);if(end>start)pieces.push(data.subarray(Math.floor(start*16000),Math.ceil(end*16000)));}
   }
   const joined=new Float32Array(pieces.reduce((n,p)=>n+p.length,0));let offset=0;for(const piece of pieces){joined.set(piece,offset);offset+=piece.length;}
   h.preview=path.join(out,h.id+'.wav');await fs.writeFile(h.preview,wav(joined));
  }
  await save(path.join(out,'choices.json'),editorial.highlights);
  await save(path.join(out,'status.json'),{stage:'awaiting-highlight-choice',removedSeconds:edited.removedSeconds,textCuts:cuts.length});
  console.log(JSON.stringify({status:'awaiting-highlight-choice',choices:path.join(out,'choices.json'),work:out}));return;
 }
 if(action==='assemble'){
  if(!arg||!output||!choice||!flags.includes('--confirmed'))throw Error('assemble <work-directory> <project-id> <quote-ids> --confirmed（须先获得用户片头选择）');
  const out=path.resolve(arg),prepared=await json(path.join(out,'prepared.json'));
  const chosenIds=choice.split(',');if(chosenIds.length<2||new Set(chosenIds).size!==chosenIds.length)throw Error('请指定用户选定的多个精句 ID，例如 q1,q3,q5');
  const chosen=chosenIds.map(id=>prepared.editorial.highlights.find((h:any)=>h.id===id));if(chosen.some(h=>!h))throw Error('无效精句选择');
  const selected={title:'片头精句串烧',parts:chosen.flatMap(h=>h.parts)};
  const store=new DiskDraftStore(projectRoot(root,output));if((await store.read()).snapshot)throw Error('该独立项目已存在；请换新项目编号，避免覆盖人工修改');
  const payload=structuredClone(prepared.result),config=prepared.config;
  for(const c of payload.clips)if(await digest(c.sourcePath)!==c.sourceHash)throw Error('录音在初剪后发生变化，请重新准备');
  const teasers=selected.parts.map((part:any,index:number)=>{
   const original=payload.clips.find((c:any)=>c.id===part.segments[0].clipId),a=original.words.findIndex((w:any)=>w.id===part.segments[0].startWordId),b=original.words.findIndex((w:any)=>w.id===part.segments.at(-1).endWordId);
   const teaser={...structuredClone(original),id:'teaser-'+index,name:`片头精句 ${index+1} · ${chosen[index]?.title||selected.title}`};
   teaser.words=teaser.words.slice(a,b+1).map((w:any)=>({...w,id:`teaser-${index}-`+w.id}));const start=original.words[a].start,end=original.words[b].end;
   teaser.ranges=teaser.ranges.map((r:any)=>({start:Math.max(start,r.start),end:Math.min(end,r.end)})).filter((r:any)=>r.end>r.start);teaser.audioOrder=[{start,end}];teaser.clearedPauses=[];teaser.manualPauses=[];return teaser;
  });
  const firstBody=payload.clips[0];payload.clips.unshift(...teasers);payload.activeClipId=teasers[0].id;payload.audioName=prepared.editorial.title;
  const assets=new Map<string,any>();
  async function source(file:string){const asset=await store.upload(createReadStream(file));assets.set(asset.id,asset);const mime=file.toLowerCase().endsWith('.mp3')?'audio/mpeg':'audio/wav';return {mime,blob:{diskAsset:asset.id,bytes:asset.bytes,kind:'blob',mime}};}
  for(const c of payload.clips){c.source=await source(c.sourcePath);delete c.sourcePath;delete c.sourceHash;delete c.alignmentComplete;delete c.aligned;delete c.skipped;delete c.manual;}
  let sequence=0;
  async function music(file:string,clip:any,word:any,kind:string,side='before',lead=0){if(!file)return;const meta=await probe(file);payload.music.push({id:'episode-m'+(++sequence),kind,name:path.basename(file,path.extname(file)),gainDb:kind==='bed'?(config.musicBedGainDb??-18):(config.musicStingerGainDb??-3),clipId:clip.id,wordId:word.id,originalTime:side==='after'?word.end:word.start,anchorSide:side,inPoint:0,outPoint:meta.duration,fadeInSec:kind==='bed'?1.5:.1,fadeOutSec:kind==='bed'?2:.4,leadInSec:lead,source:await source(file)});}
  const spoken=(c:any)=>c.words.filter((w:any)=>!w.deleted&&/[\p{L}\p{N}]/u.test(w.text));
  await music(config.music?.opening,teasers[0],spoken(teasers[0])[0],'bed','before',config.leadInSec??3);
  const opening=payload.music.at(-1);if(opening?.kind==='bed')opening.outPoint=Math.min(opening.outPoint,teasers.reduce((sum:number,c:any)=>sum+c.ranges.reduce((n:number,r:any)=>n+r.end-r.start,0),0)+(opening.leadInSec||0));
  const segments=episodeSegments(payload.clips),transitions=config.music?.transitions||[];
  if(transitions.length){const first=firstBody;await music(transitions[0],first,spoken(first)[0],'stinger');for(const [i,chapter] of prepared.editorial.chapters.entries()){const seg=segments.find(s=>s.id===chapter.id);if(!seg)continue;const clip=payload.clips.find((c:any)=>c.id===seg.clipId),word=clip.words.find((w:any)=>w.id===seg.startWordId);if(clip===first&&word===spoken(first)[0])continue;await music(transitions[i%transitions.length],clip,word,'stinger');}}
  const lastClip=payload.clips.findLast((c:any)=>spoken(c).length),last=spoken(lastClip).at(-1);
  // Trim only post-speech tail so the outro follows the final spoken phoneme.
  lastClip.ranges=lastClip.ranges.map((r:any)=>({...r,end:Math.min(r.end,last.end)})).filter((r:any)=>r.end>r.start);
  await music(config.music?.ending,lastClip,last,'stinger','after');
  payload.savedAt=Date.now();await store.save(payload,[...assets.values()],null);
  await save(path.join(store.root,'episode-context.json'),{reference:prepared.reference,choice,signature:prepared.signature});
  const packageDir=path.join(out,output+'.podcast');await fs.mkdir(packageDir,{recursive:true});await fs.cp(store.root,packageDir,{recursive:true});
  const url=(config.previewUrl||'http://127.0.0.1:5188')+'/?project='+output;
  await save(path.join(out,'result.json'),{projectId:output,url,package:packageDir,choice,signature:prepared.signature});console.log(JSON.stringify({url,package:packageDir}));return;
 }
 if(action==='transcript'||action==='publish'){
  const store=new DiskDraftStore(projectRoot(root,arg)),snapshot=(await store.read()).snapshot;if(!snapshot)throw Error('项目不存在');const p:any=snapshot.payload;
  const segments=episodeSegments(p.clips,p.music,p.speechRate??1);
  const raw=await publishEpisode(segments);await fs.mkdir(output,{recursive:true});
  await fs.writeFile(path.join(output,'长文稿.md'),raw.article);await fs.writeFile(path.join(output,'导出说明.md'),raw.factReport);
  await save(path.join(output,'发布资料来源.json'),{revision:snapshot.revision,chapters:raw.chapters,editorialAudit:raw.editorialAudit});
  if(action==='transcript'){console.log('已直接导出当前剪后长文稿，未调用 AI');return;}
  try{
   const context=await json(path.join(store.root,'episode-context.json')).catch(()=>null);
   const result=await publishEpisode(segments,deepSeekAsk(env),String(context?.reference||''));
   await fs.writeFile(path.join(output,'简介与时间戳.md'),result.showNotes);
   await save(path.join(output,'发布资料来源.json'),{revision:snapshot.revision,chapters:result.chapters,editorialAudit:result.editorialAudit});
   console.log('已导出剪后长文稿、简介与时间戳');
  }catch(e){throw Error(`长文稿已保存到 ${output}；简介与时间戳生成失败：${e instanceof Error?e.message:String(e)}`);}
  return;
 }
 if(action==='import'){
  const sourceStore=new DiskDraftStore(path.resolve(arg)),snapshot=(await sourceStore.read()).snapshot;if(!snapshot)throw Error('无有效播客工程');const target=new DiskDraftStore(projectRoot(root,output));if((await target.read()).snapshot)throw Error('项目编号已存在');for(const asset of snapshot.assets){const copied=await target.upload(createReadStream(sourceStore.assetPath(asset.id)));if(copied.id!==asset.id)throw Error('音频校验失败');}await target.save(snapshot.payload,snapshot.assets,null);const context=await json(path.join(sourceStore.root,'episode-context.json')).catch(()=>null);if(typeof context?.reference==='string'&&context.reference.length<=50000)await save(path.join(target.root,'episode-context.json'),{reference:context.reference});console.log('http://127.0.0.1:5188/?project='+output);return;
 }
 throw Error('用法：prepare / assemble / transcript / publish / import。参见 podcast-producer skill。');
}
