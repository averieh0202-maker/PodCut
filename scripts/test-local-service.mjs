import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {serviceOptions,launchAgentXml} from './local-service-options.mjs';
import {buildFingerprint,ensureServiceBuild,assertPortFree} from './local-service.mjs';

const temp=await mkdtemp(path.join(tmpdir(),'podcut-service-test-'));let count=0;
const test=async(name,fn)=>{await fn();count++;console.log('✓',name);};
async function fixture(name){const root=path.join(temp,name);await mkdir(path.join(root,'src'),{recursive:true});await writeFile(path.join(root,'package.json'),JSON.stringify({config:{podcutPort:5188}}));await writeFile(path.join(root,'src','main.ts'),'export const app=1');return root;}
async function built(root){await mkdir(path.join(root,'dist/assets'),{recursive:true});for(const f of ['index.html','export.html','publication.html'])await writeFile(path.join(root,'dist',f),'<!doctype html>PodCut');await writeFile(path.join(root,'dist/assets/bundle.js'),'console.log("ready")');}
try{
 await test('Independent installation default, environment override and explicit fixed port',async()=>{
  const root=await fixture('ports');assert.equal((await serviceOptions([],root,{})).port,5188);assert.equal((await serviceOptions([],root,{PODCUT_PORT:'5174'})).port,5174);assert.equal((await serviceOptions(['--port','5199'],root,{PODCUT_PORT:'5174'})).port,5199);
  for(const p of ['0','-1','70000','abc','5174-extra'])await assert.rejects(serviceOptions(['--port',p],root,{}));
 });
 await test('Busy port is reported without killing its owner or switching addresses',async()=>{
  const server=net.createServer(socket=>socket.end('existing owner'));await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;
  try{await assert.rejects(assertPortFree('127.0.0.1',port),new RegExp(String(port)));assert(server.listening);}finally{await new Promise(r=>server.close(r));}
 });
 await test('Cold startup builds; warm startup reuses complete validated assets',async()=>{
  const root=await fixture('cache'),runtime=path.join(root,'.podcast-drafts/service');let calls=0;const build=async()=>{calls++;await built(root);};
  assert.equal(await ensureServiceBuild(root,runtime,build),true);assert.equal(await ensureServiceBuild(root,runtime,build),false);assert.equal(calls,1);
  await rm(path.join(root,'dist/export.html'));assert.equal(await ensureServiceBuild(root,runtime,build),true);assert.equal(calls,2);
  await writeFile(path.join(root,'dist/assets/bundle.js'),'');assert.equal(await ensureServiceBuild(root,runtime,build),true);assert.equal(calls,3,'a truncated script triggers rebuild even when HTML exists');
 });
 await test('Code/configuration changes rebuild; editing a project does not',async()=>{
  const root=await fixture('changes'),runtime=path.join(root,'.podcast-drafts/service');let calls=0;const build=async()=>{calls++;await built(root);};
  await ensureServiceBuild(root,runtime,build);const initial=await buildFingerprint(root);await mkdir(path.join(root,'.podcast-drafts/projects/test'),{recursive:true});await writeFile(path.join(root,'.podcast-drafts/projects/test/current.json'),'private draft');assert.equal(await buildFingerprint(root),initial);
  await writeFile(path.join(root,'src/main.ts'),'export const app=2');assert.equal(await ensureServiceBuild(root,runtime,build),true);
  await writeFile(path.join(root,'.env.local'),'PRIVATE_KEY=private-test-value');assert.equal(await ensureServiceBuild(root,runtime,build),true);assert.equal(calls,3);assert(!(await readFile(path.join(runtime,'build.json'),'utf8')).includes('private-test-value'));
 });
 await test('Concurrent startup builds once and publishes one complete cache record',async()=>{
  const root=await fixture('concurrent'),runtime=path.join(root,'.podcast-drafts/service');let calls=0;const build=async()=>{calls++;await new Promise(r=>setTimeout(r,30));await built(root);};
  const out=await Promise.all([ensureServiceBuild(root,runtime,build),ensureServiceBuild(root,runtime,build)]);assert.equal(calls,1);assert.deepEqual(out.sort(),[false,true]);
 });
 await test('Failed build is not marked ready and releases the lock for recovery',async()=>{
  const root=await fixture('failure'),runtime=path.join(root,'.podcast-drafts/service');await assert.rejects(ensureServiceBuild(root,runtime,async()=>{throw Error('build failed');}));
  await assert.rejects(access(path.join(runtime,'build.json')));await assert.rejects(access(path.join(runtime,'build.lock')));assert.equal(await ensureServiceBuild(root,runtime,()=>built(root)),true);
 });
 await test('A build lock left by a crashed process can recover',async()=>{
  const root=await fixture('stale-lock'),runtime=path.join(root,'.podcast-drafts/service');await mkdir(runtime,{recursive:true});await writeFile(path.join(runtime,'build.lock'),'2147483647');assert.equal(await ensureServiceBuild(root,runtime,()=>built(root)),true);
 });
 await test('Login service keeps alive, preserves argument boundaries and contains no API configuration',async()=>{
  const options={root:'/tmp/PodCut & <test> "folder"',label:'com.podcut.local.5188',port:5188};const xml=launchAgentXml(options,'/tmp/node path/bin/node','/tmp/script path/start.mjs',{stdout:'/tmp/out.log',stderr:'/tmp/err.log'},'/usr/bin:/bin');assert(xml.includes('<key>KeepAlive</key><true/>'));assert(xml.includes('<key>RunAtLoad</key><true/>'));assert(xml.includes('&amp;'));assert(!xml.includes('PRIVATE_KEY'));
  if(process.platform==='darwin'){const parsed=spawnSync('/usr/bin/plutil',['-convert','json','-o','-','-'],{input:xml,encoding:'utf8'});assert.equal(parsed.status,0,parsed.stderr);const plist=JSON.parse(parsed.stdout);assert.equal(plist.WorkingDirectory,options.root);assert.equal(plist.ProgramArguments[0],'/tmp/node path/bin/node');assert.deepEqual(plist.ProgramArguments.slice(-2),['--port','5188']);}
 });
 console.log(`${count} service stability checks passed`);
}finally{await rm(temp,{recursive:true,force:true});}
