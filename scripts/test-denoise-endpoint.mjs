import {build} from 'esbuild';import {createServer} from 'node:http';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const tmp=await mkdtemp(join(tmpdir(),'denoise-http-test-'));let server;
try{
 await build({entryPoints:['server/audioDenoisePlugin.ts'],bundle:true,platform:'node',format:'esm',outfile:join(tmp,'plugin.mjs'),logLevel:'silent'});const {audioDenoisePlugin}=await import(join(tmp,'plugin.mjs'));
 let handler;server=createServer((req,res)=>handler(req,res,()=>{res.statusCode=404;res.end();}));audioDenoisePlugin().configureServer({httpServer:server,middlewares:{use(fn){handler=fn;}}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port,url=base+'/api/audio/denoise?rate=48000&frames=4800&floor=-55';
 const data=new Float32Array(4800);data[64]=.7;data[4736]=.7;
 const opts={method:'POST',headers:{'Content-Type':'application/octet-stream','X-Podcut-Audio':'1','Origin':base},body:Buffer.from(data.buffer)};
 assert.equal((await fetch(url,{...opts,headers:{...opts.headers,Origin:'https://example.com'}})).status,403);
 assert.equal((await fetch(url,{...opts,headers:{'Content-Type':'application/octet-stream'}})).status,400);
 assert.equal((await fetch(url.replace('48000','1'),opts)).status,400);
 const response=await fetch(url,opts);assert.equal(response.status,200,await(response.ok?Promise.resolve(''):response.text()));const pcm=new Float32Array(await response.arrayBuffer());assert.equal(pcm.length,data.length);assert.ok(Math.abs(pcm[64])>.6&&Math.abs(pcm[4736])>.6);
 assert.equal((await fetch(url,{...opts,body:Buffer.alloc(4)})).status,500);
 assert.equal((await fetch(url,opts)).status,200,'server recovers after a rejected request');
 console.log('PASS: local-only origin/header/dimension checks; float streaming; exact sample count; onset/tail; failure recovery');
}finally{await new Promise(r=>server?server.close(r):r());await rm(tmp,{recursive:true,force:true});}
