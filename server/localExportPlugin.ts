import type {Plugin} from 'vite';
import {build} from 'esbuild';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync,createReadStream,openSync,closeSync} from 'node:fs';
import {readFile,writeFile,mkdir,stat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {projectRoot} from './projectScope';
export function localExportPlugin():Plugin{
 const install=(server:any)=>{server.middlewares.use(async(req:any,res:any,next:()=>void)=>{
  const url=new URL(req.url??'/','http://localhost');if(!url.pathname.startsWith('/api/export/'))return next();
  const json=(status:number,value:any)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
  const host=req.headers.host??'';let hostname='';try{hostname=new URL('http://'+host).hostname;}catch{return json(400,{error:'Invalid host'});}
  if(!['127.0.0.1','localhost','[::1]'].includes(hostname)||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))return json(403,{error:'Local access only'});
  if(req.headers['sec-fetch-site']==='cross-site'||(req.headers.origin&&!['http://'+host,'https://'+host].includes(req.headers.origin)))return json(403,{error:'Origin mismatch'});
  try{
   const root=projectRoot(server.config.root,url.searchParams.get('project')??undefined),exports=join(root,'exports');await mkdir(exports,{recursive:true});
   const readStatus=async(id:string)=>{const state=JSON.parse(await readFile(join(exports,id,'status.json'),'utf8'));if(!state.done&&!state.error&&state.pid){try{process.kill(state.pid,0);}catch{state.error='导出进程已停止，请重新导出';}}return {...state,id,download:`/api/export/file/${id}?project=${encodeURIComponent(url.searchParams.get('project')??'')}`};};
   if(url.pathname==='/api/export/latest'&&req.method==='GET'){
    const ids=(await readdir(exports)).filter(s=>/^[a-f0-9-]{36}$/.test(s));const rows=await Promise.all(ids.map(id=>readStatus(id).catch(()=>null)));return json(200,rows.filter(Boolean).sort((a,b)=>b.updatedAt-a.updatedAt)[0]??null);
   }
   const match=url.pathname.match(/^\/api\/export\/(status|file)\/([a-f0-9-]{36})$/);
   if(match&&req.method==='GET'){
    const state=await readStatus(match[2]);if(match[1]==='status')return json(200,state);
    if(!state.done)return json(409,{error:'文件尚未生成'});
    const file=join(exports,match[2],'audio.wav'),bytes=(await stat(file)).size;
    res.setHeader('Content-Type','audio/wav');res.setHeader('Content-Length',String(bytes));res.setHeader('Content-Disposition',`attachment; filename="podcast-edited.wav"`);
    const stream=createReadStream(file);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);return;
   }
   if(url.pathname!=='/api/export/start'||req.method!=='POST')return json(405,{error:'Unsupported export operation'});
   if(req.headers['x-podcut-export']!=='1')return json(403,{error:'Missing export header'});
   let body='';for await(const chunk of req){body+=chunk;if(body.length>4096)return json(413,{error:'Request too large'});}
   const {revision}=JSON.parse(body),snapshot=JSON.parse(await readFile(join(root,'current.json'),'utf8'));
   if(!revision||revision!==snapshot.revision)return json(409,{error:'工程已经更新，请保存后重新导出'});
   // Reuse an in-flight job. Repeated clicks must never launch parallel renders.
   for(const id of(await readdir(exports)).filter(s=>/^[a-f0-9-]{36}$/.test(s))){const s=await readStatus(id).catch(()=>null);if(s&&!s.done&&!s.error&&Date.now()-s.updatedAt<3600000)return json(200,s);}
   const ffmpeg=['/opt/homebrew/bin/ffmpeg','/usr/local/bin/ffmpeg','/usr/bin/ffmpeg'].find(existsSync);if(!ffmpeg)return json(503,{error:'本机未安装 FFmpeg'});
   const id=randomUUID(),dir=join(exports,id);await mkdir(dir);await writeFile(join(dir,'snapshot.json'),JSON.stringify(snapshot));
   await build({entryPoints:[join(server.config.root,'server/localExportWorker.ts')],bundle:true,platform:'node',format:'esm',outfile:join(dir,'worker.mjs'),logLevel:'silent'});
   const initial={id,stage:'开始导出',percent:0,updatedAt:Date.now(),revision};await writeFile(join(dir,'status.json'),JSON.stringify(initial));
   const log=openSync(join(dir,'worker.log'),'a');let child;
   try{child=spawn(process.execPath,[join(dir,'worker.mjs'),root,dir,ffmpeg],{detached:true,stdio:['ignore',log,log]});}finally{closeSync(log);}
   child.on('error',async error=>{await writeFile(join(dir,'status.json'),JSON.stringify({...initial,error:error.message}));});child.unref();return json(202,initial);
  }catch(e){return json(500,{error:e instanceof Error?e.message:String(e)});}
 });};
 return {name:'local-disk-export',configureServer:install,configurePreviewServer:install};
}
