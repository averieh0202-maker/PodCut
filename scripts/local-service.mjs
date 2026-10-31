import {createHash} from 'node:crypto';
import {readFile,writeFile,readdir,stat,mkdir,open,unlink,rename,access,realpath} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {serviceOptions} from './local-service-options.mjs';

export async function buildFingerprint(root){
 const hash=createHash('sha256').update(process.versions.node);
 async function visit(relative){
  const absolute=path.join(root,relative);const info=await stat(absolute).catch(()=>null);if(!info)return;
  if(info.isDirectory()){for(const name of(await readdir(absolute)).sort())if(!['fixtures','__pycache__','.cache','outputs','node_modules','.DS_Store'].includes(name))await visit(path.join(relative,name));}
  else if(info.isFile()){hash.update(relative);hash.update(await readFile(absolute));}
 }
 for(const name of ['src','server','scripts','public','skills','vite.config.ts','tsconfig.json','package.json','package-lock.json','index.html','export.html','publication.html'])await visit(name);
 // Environment content never enters a manifest or a log. Changing it still
 // invalidates the build and causes the service to reload its configuration.
 for(const name of ['.env','.env.local','.env.production','.env.production.local']){const s=await stat(path.join(root,name)).catch(()=>null);hash.update(name+':'+(s?`${s.size}:${s.mtimeMs}`:'missing'));}
 return hash.digest('hex');
}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function builtFiles(root){
 const files=[];
 async function visit(relative){for(const name of(await readdir(path.join(root,'dist',relative))).sort()){
  const file=path.join(relative,name),s=await stat(path.join(root,'dist',file));
  if(s.isDirectory())await visit(file);else if(s.isFile())files.push({path:file,bytes:s.size});
 }}
 await visit('');return files;
}
async function completeBuild(root,saved){
 if(!Array.isArray(saved?.files)||!saved.files.length)return false;
 return (await Promise.all(saved.files.map(async f=>{
  if(typeof f.path!=='string'||path.isAbsolute(f.path)||f.path.split(/[\\/]/).includes('..'))return false;
  return stat(path.join(root,'dist',f.path)).then(s=>s.isFile()&&s.size===f.bytes,()=>false);
 }))).every(Boolean);
}
export async function ensureServiceBuild(root,runtime,buildFn){
 await mkdir(runtime,{recursive:true,mode:0o700});
 const lock=path.join(runtime,'build.lock'),manifest=path.join(runtime,'build.json');let handle;
 for(let i=0;i<600;i++){
  try{handle=await open(lock,'wx',0o600);await handle.writeFile(String(process.pid));break;}
  catch(e){if(e.code!=='EEXIST')throw e;const owner=Number(await readFile(lock,'utf8').catch(()=>''));
   if(owner){try{process.kill(owner,0);}catch(e){if(e.code==='ESRCH'){await unlink(lock).catch(()=>{});continue;}}}
   else if(await stat(lock).then(s=>Date.now()-s.mtimeMs>30000,()=>false)){await unlink(lock).catch(()=>{});continue;}
   await pause(100);
  }
 }
 if(!handle)throw Error('PodCut 构建仍被其他进程占用，请查看本机服务日志');
 try{
  const fingerprint=await buildFingerprint(root),saved=await readFile(manifest,'utf8').then(JSON.parse,()=>null);
  const files=['index.html','export.html','publication.html'];
  const complete=(await Promise.all(files.map(f=>access(path.join(root,'dist',f)).then(()=>true,()=>false)))).every(Boolean);
  if(saved?.fingerprint===fingerprint&&complete&&await completeBuild(root,saved))return false;
  await buildFn();
  for(const file of files)await access(path.join(root,'dist',file));
  const tmp=manifest+'.'+process.pid+'.tmp';await writeFile(tmp,JSON.stringify({fingerprint,builtAt:Date.now(),files:await builtFiles(root)}),{mode:0o600});await rename(tmp,manifest);return true;
 }finally{await handle.close();await unlink(lock).catch(()=>{});}
}
export async function assertPortFree(host,port){
 await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',e=>reject(Error(e.code==='EADDRINUSE'?`端口 ${port} 已被占用；PodCut 不会自动更换地址`:`无法使用端口 ${port}：${e.message}`)));probe.listen({host,port,exclusive:true},()=>probe.close(resolve));});
}
export async function startLocalService(options){
 options={...options,root:await realpath(options.root)};
 process.umask(0o077);process.chdir(options.root);
 await assertPortFree(options.host,options.port);
 const {build,preview}=await import('vite');
 await ensureServiceBuild(options.root,options.runtime,()=>build({root:options.root,mode:'production',logLevel:'warn'}));
 // Production preview serves built assets and the same local API plugins.
 // No development watcher, automatic port switching, or source-triggered reload.
 const server=await preview({root:options.root,mode:'production',preview:{host:options.host,port:options.port,strictPort:true,open:false}});
 console.log(`[PodCut] ready ${options.url}`);
 return server;
}
async function main(){
 const options=await serviceOptions();const server=await startLocalService(options);let stopping=false;
 const stop=()=>{if(stopping)return;stopping=true;server.httpServer.close(()=>process.exit(0));setTimeout(()=>process.exit(0),10000).unref();};
 process.once('SIGINT',stop);process.once('SIGTERM',stop);
 server.httpServer.once('close',()=>{if(!stopping){console.error('[PodCut] HTTP service closed unexpectedly');process.exit(1);}});
 const crash=error=>{console.error('[PodCut] service failed:',error instanceof Error?error.message:String(error));process.exit(1);};
 process.on('uncaughtException',crash);process.on('unhandledRejection',crash);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error('[PodCut]',e.message);process.exitCode=1;});
