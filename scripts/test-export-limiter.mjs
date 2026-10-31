import {build} from 'esbuild';import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'export-limiter-'));
try{await build({entryPoints:['server/exportLimiter.ts'],bundle:true,format:'esm',platform:'node',outfile:join(dir,'lib.mjs'),logLevel:'silent'});const {exportLimiter}=await import(join(dir,'lib.mjs'));
for(const rate of [44100,48000]){
 const a=Float32Array.from({length:rate*2},(_,i)=>.2*Math.sin(2*Math.PI*440*i/rate));a[0]=.4;a[a.length-1]=.4;a[rate]=3.5;
 await writeFile(join(dir,'in.f32'),Buffer.from(a.buffer));const r=spawnSync('/opt/homebrew/bin/ffmpeg',['-v','error','-y','-f','f32le','-ar',String(rate),'-ac','1','-i',join(dir,'in.f32'),'-af',exportLimiter(3.5,a.length),'-f','f32le',join(dir,'out.f32')]);assert.equal(r.status,0,String(r.stderr));const b=await readFile(join(dir,'out.f32')),out=new Float32Array(b.buffer,b.byteOffset,b.length/4);assert.equal(out.length,a.length);
 assert.ok(Math.abs(out[0]-.4)<1e-6&&Math.abs(out.at(-1)-.4)<1e-6,'first/last samples and latency retained');
 let error=0,peak=0;for(let i=0;i<a.length;i++){peak=Math.max(peak,Math.abs(out[i]));if(i<rate*.9||i>rate*1.2)error=Math.max(error,Math.abs(out[i]-a[i]));}assert.ok(error<1e-6,'normal audio must retain configured gain');assert.ok(peak<=.981);console.log({rate,pass:true,normalMaxError:error,peak});
}assert.equal(exportLimiter(.7,100),'anull');}finally{await rm(dir,{recursive:true,force:true});}
