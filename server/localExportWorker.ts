/** Disk-backed rendering. All large audio reads/writes are bounded blocks. */
import {open,readFile,writeFile,rename,mkdir,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {buildMixSchedule,fadeEnvelopeAt} from '../src/audio/mixSchedule';
import {speechTempoMap,tempoDuration,normalizeSpeechRate} from '../src/audio/speechTempo';
import {dbToLinear} from '../src/audio/gain';
import {exportLimiter} from './exportLimiter';
import {SPLICE_FADE_SEC} from '../src/audio/splice';
const [root,jobDir,ffmpeg]=process.argv.slice(2);
const sr=48000,channels=2,block=32768;
let lastUpdate=0;let peakRss=0;let statusSequence=0;
async function status(stage:string,percent:number,extra:object={}){
 peakRss=Math.max(peakRss,process.memoryUsage().rss);
 const state={stage,percent,updatedAt:Date.now(),pid:process.pid,peakRss,...extra};
 const tmp=join(jobDir,`status-${++statusSequence}.tmp`);await writeFile(tmp,JSON.stringify(state));await rename(tmp,join(jobDir,'status.json'));
}
async function run(args:string[]){
 await new Promise<void>((resolve,reject)=>{const child=spawn(ffmpeg,['-v','error','-nostdin','-y',...args],{stdio:['ignore','ignore','pipe']});let err='';const timer=setTimeout(()=>child.kill(),3600000);timer.unref();child.stderr.on('data',x=>err=(err+x).slice(-1500));child.once('error',reject);child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(Error('音频转换失败 '+err));});});
}
function asset(ref:any){if(!/^[a-f0-9]{64}$/.test(ref?.diskAsset))throw Error('音频引用无效');return join(root,'assets',ref.diskAsset);}
async function main(){
 const snapshot=JSON.parse(await readFile(join(jobDir,'snapshot.json'),'utf8')),p=snapshot.payload;
 await status('准备音频',1);const temp=join(jobDir,'work');await mkdir(temp,{recursive:true});
 const cache=new Map<string,any>();let index=0;
 async function decode(row:any,music=false){
  const raw=music?row.buffer:row.current;
  if(!music&&!raw&&(row.denoised||row.beautified))throw Error('请重新保存已处理的人声后导出');
  const source=raw??row.source;const key=JSON.stringify(source);if(cache.has(key))return cache.get(key);
  const file=join(temp,`source-${index++}.f32`);let args:string[]=[];
  if(raw){
   if(!Number.isFinite(raw.sampleRate)||raw.sampleRate<8000||raw.sampleRate>192000||!raw.channels?.length||raw.channels.length>2)throw Error('音频格式无效');
   for(const ch of raw.channels){if((await stat(asset(ch))).size!==raw.length*4)throw Error('音频文件不完整');args.push('-f','f32le','-ar',String(raw.sampleRate),'-ac','1','-i',asset(ch));}
   if(raw.channels.length===2)args.push('-filter_complex','[0:a][1:a]amerge=inputs=2[a]','-map','[a]');
  }else {args=['-i',asset(source?.blob)];}
  let mono=raw?.numberOfChannels===1;
  if(!raw){const info=await new Promise<string>((resolve,reject)=>{const child=spawn(ffmpeg.replace(/ffmpeg$/,'ffprobe'),['-v','error','-select_streams','a:0','-show_entries','stream=channels','-of','json',asset(source?.blob)],{stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',x=>out+=x);child.once('error',reject);child.once('close',code=>code===0?resolve(out):reject(Error('无法读取音频声道')));});mono=JSON.parse(info).streams?.[0]?.channels===1;}

  // Same linear mono duplication as Web Audio (avoid FFmpeg's default -3dB pan).
  args.push('-af','aformat=channel_layouts=stereo','-ar',String(sr),'-ac','2','-f','f32le',file);
  // Explicit mono pan is required for saved mono PCM.
  if(mono){const at=args.indexOf('-af');args[at+1]='pan=stereo|c0=c0|c1=c0';}
  await run(args);const size=(await stat(file)).size;
  const b={duration:size/(4*channels*sr),sampleRate:sr,numberOfChannels:2,file};cache.set(key,b);return b;
 }
 const clips=[];for(const c of p.clips){clips.push({...c,buffer:await decode(c),ranges:c.ranges});await status('准备音频',2+8*clips.length/p.clips.length);}
 const music=[];for(const m of p.music??[]){music.push({...m,buffer:await decode(m,true)});}
 const speed=normalizeSpeechRate(p.speechRate),mix=buildMixSchedule(clips as any,music as any,dbToLinear(p.gainDb??0)),map=speechTempoMap(mix,speed);
 const frames=Math.ceil(tempoDuration(mix,speed)*sr);if(!frames||frames>sr*86400)throw Error('导出时长无效');
 // Build a pre-tempo voice timeline. Expand music-only gaps before applying
 // atempo so those gaps return to their original wall duration afterwards.
 const voices=mix.sources.filter(s=>s.role==='speech').map(s=>({...s,start:Math.round(map.toWall(s.whenEdit)*speed*sr)}));
 const beds=mix.sources.filter(s=>s.role!=='speech').map(s=>({...s,start:Math.round(map.toWall(s.whenEdit)*sr)}));
 const handles=new Map<string,Awaited<ReturnType<typeof open>>>();
 async function handle(file:string){if(!handles.has(file))handles.set(file,await open(file,'r'));return handles.get(file)!;}
 async function mixBlocks(file:string,count:number,sources:any[],stage:string,lo:number,hi:number,voiceFile?:string){
  const out=await open(file,'w');let peak=0;
  try{for(let pos=0;pos<count;pos+=block){
   const n=Math.min(block,count-pos),data=new Float32Array(n*2);
   if(voiceFile){const bytes=Buffer.alloc(n*8);await(await handle(voiceFile)).read(bytes,0,bytes.length,pos*8);data.set(new Float32Array(bytes.buffer,bytes.byteOffset,n*2));}
   for(const s of sources){
    const dur=Math.floor(s.duration*sr),from=Math.max(pos,s.start),to=Math.min(pos+n,s.start+dur);if(to<=from)continue;
    const bytes=Buffer.alloc((to-from)*8);await(await handle(s.buffer.file)).read(bytes,0,bytes.length,(Math.floor(s.offset*sr)+from-s.start)*8);
    const pcm=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.length/4);
    const fi=s.role==='speech'?(s.offset>.0001?SPLICE_FADE_SEC:0):(s.fadeInSec??0),fo=s.role==='speech'?(s.offset+s.duration<s.buffer.duration-.0001?SPLICE_FADE_SEC:0):(s.fadeOutSec??0);
    for(let i=0;i<to-from;i++){const gain=s.gainLinear*fadeEnvelopeAt((from-s.start+i)/sr,s.duration,fi,fo),at=(from-pos+i)*2;data[at]+=pcm[i*2]*gain;data[at+1]+=pcm[i*2+1]*gain;}
   }
   for(const v of data){if(!Number.isFinite(v))throw Error('音频含无效采样');peak=Math.max(peak,Math.abs(v));}
   await out.write(Buffer.from(data.buffer));
   if(Date.now()-lastUpdate>500){lastUpdate=Date.now();await status(stage,Math.round(lo+(hi-lo)*(pos+n)/count));}
  }}finally{await out.close();}
  return peak;
 }
 try{
  const pre=join(temp,'voice-before.f32'),voice=join(temp,'voice.f32'),mixed=join(temp,'mix.f32');
  await mixBlocks(pre,Math.ceil(frames*speed),voices,'拼接人声',12,35);
  await status('处理人声倍速',36);
  const tick=setInterval(()=>void status('处理人声倍速',36).catch(()=>{}),10000);tick.unref();
  try{await run(['-f','f32le','-ar',String(sr),'-ac','2','-i',pre,'-af',`${speed===1?'anull':`atempo=${speed}`},apad,atrim=end_sample=${frames}`,'-f','f32le',voice]);}finally{clearInterval(tick);}
  const peak=await mixBlocks(mixed,frames,beds,'混合配乐',55,80,voice);
  await status('写入 24 位 WAV',82);
  await run(['-f','f32le','-ar',String(sr),'-ac','2','-i',mixed,'-af',exportLimiter(peak,frames),'-c:a','pcm_s24le','-rf64','auto',join(jobDir,'audio.tmp.wav')]);
  const bytes=(await stat(join(jobDir,'audio.tmp.wav'))).size;if(bytes<frames*6)throw Error('WAV 输出不完整');
  await rename(join(jobDir,'audio.tmp.wav'),join(jobDir,'audio.wav'));
  await status('完成',100,{done:true,bytes,duration:frames/sr,revision:snapshot.revision,peak,outputGain:1,peakLimited:peak>1});
 }finally{for(const h of handles.values())await h.close();await rm(temp,{recursive:true,force:true});}
}
main().catch(async e=>{await status('导出失败',0,{error:e instanceof Error?e.message:String(e)});await rm(join(jobDir,'work'),{recursive:true,force:true});process.exitCode=1;});
