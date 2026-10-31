import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Plugin } from 'vite';

export function denoiseFilter(sampleRate:number,frames:number,noiseFloor:number):string {
  // afftdn introduces floor(sr/40) samples of analysis latency. Supply a tail
  // and remove that latency so word boundaries remain sample-accurate.
  // A matching prefix lets the analysis window settle before the first consonant.
  const delay=Math.floor(sampleRate/40),padding=delay*4;
  return `adelay=${padding}S:all=1,apad=pad_len=${padding},afftdn=nr=8:nf=${noiseFloor}:tn=0:gs=8,atrim=start_sample=${padding+delay}:end_sample=${padding+delay+frames},asetpts=PTS-STARTPTS`;
}

/** Local float PCM in/out only. No source paths or shell commands from callers. */
export function audioDenoisePlugin():Plugin {
  const ffmpeg=['/opt/homebrew/bin/ffmpeg','/usr/local/bin/ffmpeg','/usr/bin/ffmpeg'].find(existsSync);
  let busy=false;const active=new Set<ChildProcess>();
  const install=(server:any)=>{
    server.httpServer?.once('close',()=>{for(const child of active)child.kill();});
    server.middlewares.use(async(req:any,res:any,next:()=>void)=>{
      if(req.url?.split('?')[0]!=='/api/audio/denoise')return next();
      const json=(status:number,error:string)=>{if(res.destroyed)return;res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error}));};
      const host=req.headers.host??'';let hostname='';try{hostname=new URL(`http://${host}`).hostname;}catch{return json(400,'Invalid host');}
      if(!['localhost','127.0.0.1','[::1]'].includes(hostname)||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return json(403,'Local access only');
      if((req.headers.origin&&!['http://'+host,'https://'+host].includes(req.headers.origin))||req.headers['sec-fetch-site']==='cross-site')return json(403,'Origin mismatch');
      if(req.method!=='POST')return json(405,'POST required');
      if(req.headers['content-type']!=='application/octet-stream'||req.headers['x-podcut-audio']!=='1')return json(400,'Invalid audio request');
      if(!ffmpeg)return json(503,'本机未安装 FFmpeg，无法执行频谱降噪');
      const query=new URL(req.url,'http://localhost').searchParams;
      const rate=Number(query.get('rate')),frames=Number(query.get('frames')),floor=Number(query.get('floor'));
      if(!Number.isInteger(rate)||rate<8000||rate>192000||!Number.isInteger(frames)||frames<1||frames*4>1024**3||!Number.isFinite(floor)||floor< -80||floor> -45)return json(400,'Invalid audio dimensions');
      if(busy)return json(429,'另一段人声正在降噪，请稍后重试');
      busy=true;let ownsSlot=true;const releaseSlot=()=>{if(ownsSlot){busy=false;ownsSlot=false;}};let dir='',child:ChildProcess|undefined,timer:ReturnType<typeof setTimeout>|undefined;
      const cancel=()=>{if(!res.writableEnded)child?.kill();};res.once('close',cancel);
      try{
        dir=await mkdtemp(join(tmpdir(),'podcut-denoise-'));const input=join(dir,'input.f32'),output=join(dir,'output.f32');let bytes=0;
        const limit=new Transform({transform(chunk,_encoding,done){bytes+=chunk.length;done(bytes>frames*4?new Error('Audio body too large'):null,chunk);}});
        await pipeline(req,limit,createWriteStream(input));
        if(bytes!==frames*4)throw Error('音频数据不完整');if(res.destroyed)return;
        child=spawn(ffmpeg,['-v','error','-nostdin','-f','f32le','-ar',String(rate),'-ac','1','-i',input,'-af',denoiseFilter(rate,frames,floor),'-f','f32le',output],{stdio:['ignore','ignore','pipe']});active.add(child);
        let diagnostic='';child.stderr?.on('data',data=>{diagnostic=(diagnostic+String(data)).slice(-2000);});
        timer=setTimeout(()=>child?.kill(),600_000);timer.unref();
        await new Promise<void>((resolve,reject)=>{child!.once('error',reject);child!.once('close',code=>code===0?resolve():reject(Error('频谱降噪失败 '+diagnostic.slice(-300))));});
        if(res.destroyed)return;if((await stat(output)).size!==frames*4)throw Error('降噪输出长度异常，已保留原音');
        releaseSlot();
        res.setHeader('Content-Type','application/octet-stream');res.setHeader('Cache-Control','no-store');res.setHeader('Content-Length',String(frames*4));
        await pipeline(createReadStream(output),res);
      }catch(error){releaseSlot();json(500,error instanceof Error?error.message:'降噪失败');}
      finally{clearTimeout(timer);res.off('close',cancel);if(child)active.delete(child);try{if(dir)await rm(dir,{recursive:true,force:true});}finally{releaseSlot();}}
    });
  };
  return {name:'local-spectral-denoise',configureServer:install,configurePreviewServer:install};
}
