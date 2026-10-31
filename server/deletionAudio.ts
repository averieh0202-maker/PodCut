import {existsSync} from 'node:fs';
import {spawn} from 'node:child_process';
import type {DiskDraftStore} from './diskDraftStore';
import type {CutDecision} from './roughCutPlanner';
import type {AcousticInput} from '../src/edit/acoustics';

/** Decode only the edge windows used by this plan. Never load an entire
 * multi-hour source just to delete one phrase, or mix opposite-phase channels. */
export async function loadDeletionAudio(store:DiskDraftStore, payload:any, cuts:CutDecision[], signal?:AbortSignal) {
  const result=new Map<string,AcousticInput[]>();
  for(const clip of payload.clips){
    const plans=cuts.filter(c=>c.clipId===clip.id);if(!plans.length)continue;
    const raw=clip.clean??clip.current,blob=clip.source?.blob;
    if(!raw&&!blob)continue; // In-memory clients can supply AudioBuffers directly.
    const ffmpeg=['/opt/homebrew/bin/ffmpeg','/usr/local/bin/ffmpeg','/usr/bin/ffmpeg'].find(existsSync);
    if(!ffmpeg)throw Error('本机缺少 FFmpeg，无法核对删句边缘；原稿未改动');
    const windows:Array<{start:number;end:number}>=[];
    for(const p of plans)for(const id of [p.startWordId,p.endWordId]){
      const w=clip.words.find((w:any)=>w.id===id);if(!w)throw Error('删除字 ID 已变化');
      windows.push({start:Math.max(0,w.start-.5),end:Math.min(clip.duration,w.end+.5)});
    }
    const merged:Array<{start:number;end:number}>=[];
    for(const r of windows.sort((a,b)=>a.start-b.start)){const last=merged.at(-1);if(last&&r.start<=last.end)last.end=Math.max(last.end,r.end);else merged.push({...r});}
    const inputs:AcousticInput[]=[];
    for(const r of merged){
      signal?.throwIfAborted();const args=['-v','error','-nostdin'];
      if(raw){
        if(!(raw.sampleRate>=8000&&raw.sampleRate<=192000)||!raw.channels?.length||raw.channels.length>2)throw Error('人声缓存格式无效');
        for(const ch of raw.channels)args.push('-f','f32le','-ar',String(raw.sampleRate),'-ac','1','-ss',String(r.start),'-t',String(r.end-r.start),'-i',store.assetPath(ch.diskAsset));
        if(raw.channels.length===2)args.push('-filter_complex','[0:a][1:a]amerge=inputs=2[out]','-map','[out]');
      }else args.push('-ss',String(r.start),'-t',String(r.end-r.start),'-i',store.assetPath(blob.diskAsset));
      args.push('-ac','2','-ar','16000','-f','f32le','pipe:1');
      const bytes=await new Promise<Buffer>((resolve,reject)=>{
        const child=spawn(ffmpeg,args,{stdio:['ignore','pipe','pipe']}),chunks:Buffer[]=[];let size=0,problem='';
        const stop=()=>child.kill();signal?.addEventListener('abort',stop,{once:true});
        const timer=setTimeout(stop,30000);timer.unref();
        child.stdout.on('data',b=>{size+=b.length;if(size>64*1024**2){problem='切口分析窗口过大';stop();}else chunks.push(b);});
        child.stderr.on('data',b=>{problem=(problem+b).slice(-500);});child.once('error',reject);
        child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',stop);code===0?resolve(Buffer.concat(chunks)):reject(Error('无法读取删句切口音频：'+problem));});
      });
      signal?.throwIfAborted();if(!bytes.length||bytes.length%8)throw Error('切口音频不完整');
      const channels=[new Float32Array(bytes.length/8),new Float32Array(bytes.length/8)];
      for(let i=0;i<channels[0].length;i++){channels[0][i]=bytes.readFloatLE(i*8);channels[1][i]=bytes.readFloatLE(i*8+4);}
      inputs.push({channel:channels[0],channels,sampleRate:16000,offsetSec:r.start});
    }
    result.set(clip.id,inputs);
  }
  return result;
}
