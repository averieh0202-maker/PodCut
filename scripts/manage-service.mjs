import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,readFile,lstat,rename,unlink,chmod} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {serviceOptions,launchAgentXml} from './local-service-options.mjs';
import {ensureServiceBuild,assertPortFree} from './local-service.mjs';

const exec=promisify(execFile),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function readHealth(url){
 try{const r=await fetch(url+'/api/health',{signal:AbortSignal.timeout(2000),cache:'no-store'});if(r.ok&&r.headers.get('content-type')?.includes('application/json')){const j=await r.json();if(j.app==='PodCut'&&j.status==='ok')return j;}}catch{}
 return null;
}
async function main(){
 if(process.platform!=='darwin')throw Error('自动登录启动目前支持 macOS；其他系统请用 npm start，并交给系统服务管理器维护');
 process.umask(0o077);const action=process.argv[2]??'status',options=await serviceOptions();process.chdir(options.root);
 if(!['install','start','stop','restart','status','uninstall'].includes(action))throw Error('用法：install / start / stop / restart / status / uninstall');
 const domain=`gui/${process.getuid()}`,target=`${domain}/${options.label}`,directory=path.join(homedir(),'Library','LaunchAgents'),file=path.join(directory,options.label+'.plist');
 const existing=await lstat(file).catch(()=>null);
 if(existing){
  if(existing.isSymbolicLink()||!existing.isFile())throw Error('后台服务配置不是普通文件，未改动');
  const owner=JSON.parse((await exec('/usr/bin/plutil',['-convert','json','-o','-',file])).stdout);
  if(owner.WorkingDirectory!==options.root)throw Error(`端口 ${options.port} 的后台服务属于另一份安装；请为当前安装指定独立端口`);
 }
 const loaded=async()=>exec('/bin/launchctl',['print',target]).then(()=>true,()=>false);
 async function waitReady(){
  for(let i=0;i<60;i++){const health=await readHealth(options.url);if(health?.mode==='production'){console.log(JSON.stringify({status:'ready',url:options.url,pid:health.pid,autoStart:true}));return;}await sleep(500);}
  throw Error('后台服务尚未就绪；请查看 .podcast-drafts/service/stderr.log');
 }
 if(action==='status'){
  const health=await readHealth(options.url);console.log(JSON.stringify({registered:!!existing,loaded:await loaded(),health,url:options.url}));if(!health)process.exitCode=1;return;
 }
 if(action==='stop'||action==='uninstall'){
  if(await loaded()){if(!existing)throw Error('缺少属于当前安装的服务配置，未停止未知服务');await exec('/bin/launchctl',['bootout',target]);}
  if(action==='uninstall'&&existing)await unlink(file);
  console.log(action==='uninstall'?'已移除 PodCut 登录启动服务':'已停止 PodCut 后台服务；下次登录仍会自动启动');return;
 }
 if(action==='restart'&&existing&&await loaded()){await exec('/bin/launchctl',['kickstart','-k',target]);await waitReady();return;}
 if(action==='start'&&existing){if(!await loaded())await exec('/bin/launchctl',['bootstrap',domain,file]);else await exec('/bin/launchctl',['kickstart',target]);await waitReady();return;}
 // Build and validate before replacing an existing service registration.
 // Port checks must never evict another application or silently switch URLs.
 const wasLoaded=await loaded();if(!wasLoaded)await assertPortFree(options.host,options.port);
 const {build}=await import('vite');await ensureServiceBuild(options.root,options.runtime,()=>build({root:options.root,mode:'production',logLevel:'warn'}));
 await mkdir(directory,{recursive:true});await mkdir(options.runtime,{recursive:true,mode:0o700});
 const logs={stdout:path.join(options.runtime,'stdout.log'),stderr:path.join(options.runtime,'stderr.log')};
 for(const p of Object.values(logs)){await writeFile(p,'',{flag:'a',mode:0o600});await chmod(p,0o600);}
 if(existing)await writeFile(path.join(options.runtime,'previous-service.plist'),await readFile(file),{mode:0o600});
 const xml=launchAgentXml(options,process.execPath,path.join(options.root,'scripts','local-service.mjs'),logs,[path.dirname(process.execPath),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'].join(':'));
 const temp=file+'.tmp';await writeFile(temp,xml,{mode:0o600});await exec('/usr/bin/plutil',['-lint',temp]);
 if(wasLoaded){if(!existing)throw Error('无法验证已有服务归属，未停止');await exec('/bin/launchctl',['bootout',target]);}
 await rename(temp,file);await exec('/bin/launchctl',['bootstrap',domain,file]);await waitReady();
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error('[PodCut]',e.message);process.exitCode=1;});
