import { promises as fs } from 'node:fs';
import { publishEpisode } from './episodeEditorial';
import {PublicationStore} from './publicationStore';
import { AgentAiSettings } from './agentAiSettings';
import { podcastSkill,setPodcastSkillRoot } from './podcastSkill';
import { projectRoot } from './projectScope';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Plugin } from 'vite';
import { DiskDraftStore } from './diskDraftStore';
import { RoughCutJobs } from './roughCutJobs';
export async function referenceText(bytes:Buffer,name:string):Promise<string>{
 const ext=path.extname(name).toLowerCase();let text:string;
 if(ext==='.docx')text=await new Promise((resolve,reject)=>{
  const child=spawn('python3',['-c',`import sys,io,zipfile,xml.etree.ElementTree as E
z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
i=z.getinfo('word/document.xml')
if i.file_size>4000000: raise ValueError('document too large')
r=E.fromstring(z.read(i))
ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
print('\\n'.join(''.join(p.itertext()) for p in r.findall('.//w:p',ns)))`],{stdio:['pipe','pipe','pipe']});let out='';const timer=setTimeout(()=>{child.kill();reject(Error('DOCX 读取超时'));},10000);child.stdout.setEncoding('utf8');child.stdout.on('data',b=>{out+=b;if(out.length>200000)child.kill();});child.stderr.resume();child.on('error',()=>{clearTimeout(timer);reject(Error('DOCX 读取需要本机 Python 3，可改用粘贴文字'));});child.on('close',code=>{clearTimeout(timer);code===0?resolve(out):reject(Error('无法读取 DOCX，请另存为 TXT 或粘贴内容'));});child.stdin.on('error',()=>{});child.stdin.end(bytes);
 });
 else if(['.txt','.md','.srt','.vtt'].includes(ext))text=bytes.toString('utf8');
 else throw Error('支持 TXT、MD、SRT、VTT 和 DOCX');
 text=text.replace(/^\uFEFF/,'');
 if(['.srt','.vtt'].includes(ext))text=text.split(/\r?\n/).filter(l=>!/^\s*\d+\s*$/.test(l)&&!l.includes('-->')&&!/^WEBVTT/.test(l)).join('\n');
 if(text.includes('\uFFFD'))throw Error('文字编码无法读取，请另存为 UTF-8 或粘贴内容');
 if(text.length>50000)throw Error('参考稿最多 5 万字');
 if(!text.trim())throw Error('文档中没有可读取的正文，请上传包含文字的 DOCX，或直接粘贴逐字稿');return text.trim();
}
export function roughCutPlugin(env:NodeJS.ProcessEnv):Plugin{
 const token=randomBytes(32).toString('hex');
 const install=(server:any)=>{
  setPodcastSkillRoot(server.config.root);
  const ai=new AgentAiSettings(server.config.root,env);
  const jobStores=new Map<string,RoughCutJobs>();const publications=new Map<string,PublicationStore>();
  server.middlewares.use(async(req:any,res:any,next:()=>void)=>{
   const url=new URL(req.url||'/','http://localhost');if(!url.pathname.startsWith('/api/rough-cut/'))return next();
   const json=(status:number,value:unknown)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end(JSON.stringify(value));};
   const host=req.headers.host||'',remote=req.socket.remoteAddress||'';let hostname='';try{hostname=new URL(`http://${host}`).hostname;}catch{}
   if(!['localhost','127.0.0.1','[::1]'].includes(hostname)||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)||req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&![`http://${host}`,`https://${host}`].includes(req.headers.origin))return json(403,{error:'仅限本机页面访问'});
   try{
    const root=projectRoot(server.config.root,req.headers['x-project-id']);
    let jobs=jobStores.get(root);if(!jobs){jobs=new RoughCutJobs(new DiskDraftStore(root),env,signal=>ai.ask(signal));jobStores.set(root,jobs);}
    const route=url.pathname.slice('/api/rough-cut/'.length);
    if(route==='session'&&req.method==='GET')return json(200,{token});
    if(req.headers['x-agent-token']!==token)return json(401,{error:'初剪连接已过期'});
    if(route==='publish-progress'&&req.method==='GET'){let pub=publications.get(root);if(!pub){pub=new PublicationStore(root);publications.set(root,pub);}return json(200,await pub.latest());}
    if(route==='skill'&&req.method==='GET')return json(200,podcastSkill());
    if(route==='ai'&&req.method==='GET')return json(200,await ai.publicInfo());
    if(route==='latest'&&req.method==='GET')return json(200,await jobs.latest());
    if(route.startsWith('jobs/')&&req.method==='GET')return json(200,await jobs.get(route.slice(5)));
    if(req.method!=='POST')return json(405,{error:'不支持的操作'});
    if(route==='material'){
     const name=decodeURIComponent(String(req.headers['x-file-name']||'配乐')).slice(0,200),duration=Number(req.headers['x-audio-duration']),mime=String(req.headers['content-type']||'audio/wav');
     if(!Number.isFinite(duration)||duration<=0||duration>600||!/^audio\/[a-z0-9.+-]+$/i.test(mime))throw Error('配乐需为 10 分钟以内的音频');
     async function* limited(){let n=0;for await(const chunk of req){n+=chunk.length;if(n>128*1024**2)throw Error('单个配乐最多 128 MB');yield chunk;}}
     const asset=await new DiskDraftStore(root).upload(limited());return json(200,{name,duration,mime,asset});
    }
    const limit=route==='reference'?20*1024**2:4*1024**2;
    const chunks:Buffer[]=[];let size=0;for await(const b of req){size+=b.length;if(size>limit)return json(413,{error:'上传内容过大'});chunks.push(b);}const buffer=Buffer.concat(chunks);
    if(route==='reference')return json(200,{text:await referenceText(buffer,decodeURIComponent(String(req.headers['x-file-name']||'')))});
    const body=JSON.parse(buffer.toString('utf8'));
    if(route==='publish-start'){if(body.kind!==undefined&&!['transcript','showNotes'].includes(body.kind))throw Error('不支持的导出类型');const kind=body.kind==='showNotes'?'showNotes':'transcript';const context=kind==='showNotes'?await fs.readFile(path.join(root,'episode-context.json'),'utf8').then(text=>JSON.parse(text)).catch(()=>null):null;let pub=publications.get(root);if(!pub){pub=new PublicationStore(root);publications.set(root,pub);}return json(202,await pub.start(body.segments,kind==='showNotes'?await ai.ask():undefined,String(context?.reference||''),{kind,force:body.force===true}));}
    if(route==='publish'){const context=await fs.readFile(path.join(root,'episode-context.json'),'utf8').then(text=>JSON.parse(text)).catch(()=>null);return json(200,await publishEpisode(body.segments,await ai.ask(),String(context?.reference||'')));}
    if(route==='ai-save')return json(200,await ai.save(body));
    if(route==='ai-test')return json(200,await ai.test(body));
    if(route==='select')return json(200,await jobs.select(body.id,body.selectedIds));
    if(route==='start')return json(202,await jobs.start(body));
    if(route==='apply')return json(200,await jobs.apply(body.id,body.revision));
    if(route==='undo')return json(200,await jobs.undo(body.id,body.revision));
    if(route==='cancel')return json(200,await jobs.cancel(body.id));
    return json(404,{error:'未知初剪操作'});
   }catch(e){return json(400,{error:e instanceof Error?e.message:String(e)});}
  });
 };
 return {name:'local-agent-rough-cut',configureServer:install,configurePreviewServer:install};
}
