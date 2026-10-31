import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import net from 'node:net';
import {spawn} from 'node:child_process';

const repository=fileURLToPath(new URL('../',import.meta.url));
const temp=await mkdtemp(path.join(tmpdir(),'podcut-recovery-')),root=path.join(temp,'隔离工程 with spaces');
let child,logs='';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function health(){try{const r=await fetch(`http://127.0.0.1:${port}/api/health`,{signal:AbortSignal.timeout(1000)});return r.ok?await r.json():null;}catch{return null;}}
async function start(){
 logs='';child=spawn(process.execPath,[path.join(temp,'runner.mjs')],{cwd:root,stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>logs+=b);child.stderr.on('data',b=>logs+=b);
 for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('Service exited: '+logs);const h=await health();if(h?.app==='PodCut'&&h.mode==='production')return h;await sleep(100);}
 throw Error('Service did not become ready: '+logs);
}
async function stop(signal='SIGTERM'){if(!child||child.exitCode!==null||child.signalCode!==null)return;await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('child did not exit')),10000);child.once('exit',()=>{clearTimeout(timer);resolve();});child.kill(signal);});}
const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve);});const port=probe.address().port;await new Promise(r=>probe.close(r));
try{
 await mkdir(path.join(root,'src'),{recursive:true});await writeFile(path.join(root,'package.json'),JSON.stringify({type:'module'}));await writeFile(path.join(root,'src/main.js'),'document.body.dataset.ready="yes"');
 for(const f of ['index.html','export.html','publication.html'])await writeFile(path.join(root,f),'<!doctype html><html><body>PodCut service test<script type="module" src="/src/main.js"></script></body></html>');
 const healthModule=JSON.stringify(path.join(repository,'server/healthPlugin.ts')),draftModule=JSON.stringify(path.join(repository,'server/draftPlugin.ts'));
 await writeFile(path.join(root,'vite.config.ts'),`import {healthPlugin} from ${healthModule};import {diskDraftPlugin} from ${draftModule};export default {plugins:[healthPlugin(),diskDraftPlugin()],build:{rollupOptions:{input:{main:'index.html',export:'export.html',publication:'publication.html'}}}};`);
 await writeFile(path.join(temp,'runner.mjs'),`import {startLocalService} from ${JSON.stringify(pathToFileURL(path.join(repository,'scripts/local-service.mjs')).href)};const server=await startLocalService(${JSON.stringify({root,port,host:'127.0.0.1',url:`http://127.0.0.1:${port}`,runtime:path.join(root,'.podcast-drafts/service')})});process.on('SIGTERM',()=>server.httpServer.close(()=>process.exit(0)));`);
 const first=await start();assert.equal(first.mode,'production');const url=`http://127.0.0.1:${port}`;
 const html=await(await fetch(url)).text();assert(html.includes('PodCut service test'));assert(!html.includes('/@vite/client'));
 const headers={'X-Project-Id':'service-test','Content-Type':'application/json'};
 headers['X-Draft-Token']=(await(await fetch(url+'/api/draft/session')).json()).token;
 const save=await fetch(url+'/api/draft/current',{method:'PUT',headers,body:JSON.stringify({payload:{version:2,clips:[],music:[],note:'recording-free persistence test'},assets:[],expectedRevision:null})});assert.equal(save.status,200);const receipt=await save.json();
 const cache=JSON.parse(await readFile(path.join(root,'.podcast-drafts/service/build.json'),'utf8'));
 console.log('✓ Built frontend and real draft API are served together without development reload');
 await stop('SIGKILL');const second=await start();assert.notEqual(second.pid,first.pid);
 headers['X-Draft-Token']=(await(await fetch(url+'/api/draft/session')).json()).token;const recovered=await(await fetch(url+'/api/draft/current',{headers})).json();assert.equal(recovered.snapshot.revision,receipt.revision);assert.equal(recovered.snapshot.payload.note,'recording-free persistence test');
 assert.deepEqual(JSON.parse(await readFile(path.join(root,'.podcast-drafts/service/build.json'),'utf8')),cache);
 console.log('✓ Abrupt process death preserves the committed project and restart reuses the validated build');
 await stop();await writeFile(path.join(root,'src/main.js'),'document.body.dataset.ready="updated"');await start();const rebuilt=JSON.parse(await readFile(path.join(root,'.podcast-drafts/service/build.json'),'utf8'));assert.notEqual(rebuilt.fingerprint,cache.fingerprint);assert.equal((await(await fetch(url+'/api/draft/current',{headers:{'X-Project-Id':'service-test','X-Draft-Token':(await(await fetch(url+'/api/draft/session')).json()).token}})).json()).snapshot.revision,receipt.revision);
 console.log('✓ Source update rebuilds on startup while retaining project state');
 console.log('3 production service integration checks passed');
}finally{await stop().catch(()=>child?.kill('SIGKILL'));await rm(temp,{recursive:true,force:true});}
