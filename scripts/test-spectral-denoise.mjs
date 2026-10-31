import {build} from 'esbuild';import assert from 'node:assert/strict';import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {spawnSync} from 'node:child_process';import {tmpdir} from 'node:os';import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'podcut-denoise-test-'));
try{
 await build({entryPoints:['server/audioDenoisePlugin.ts'],bundle:true,platform:'node',format:'esm',outfile:join(dir,'filter.mjs'),logLevel:'silent'});
 const {denoiseFilter}=await import(join(dir,'filter.mjs'));const rows=[];
 for(const rate of [16000,44100,48000,96000]){
  const n=rate,source=new Float32Array(n);let seed=7;
  for(let i=0;i<n;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;source[i]=.001*(seed/2**32-.5)*2;if(i>rate*.2&&i<rate*.8)source[i]+=.1*Math.sin(2*Math.PI*220*i/rate);}
  source[64]=.8;source[n-64]=.8;
  const input=join(dir,'in.f32'),output=join(dir,'out.f32');await writeFile(input,Buffer.from(source.buffer));
  const proc=spawnSync('/opt/homebrew/bin/ffmpeg',['-v','error','-f','f32le','-ar',String(rate),'-ac','1','-i',input,'-af',denoiseFilter(rate,n,-55),'-f','f32le',output,'-y']);assert.equal(proc.status,0,proc.stderr.toString());
  const b=await readFile(output),out=new Float32Array(b.buffer,b.byteOffset,b.byteLength/4);assert.equal(out.length,n);assert.ok(out.every(Number.isFinite));
  const peak=(start,end)=>{let best=start;for(let i=start;i<end;i++)if(Math.abs(out[i])>Math.abs(out[best]))best=i;return best;};
  assert.equal(peak(0,rate*.1),64,'opening pulse stays on its sample');assert.equal(peak(n-rate*.1,n),n-64,'last pulse stays on its sample');
  const db=(start,end)=>{let a=0,b=0;for(let i=Math.round(start*rate);i<end*rate;i++){a+=source[i]**2;b+=out[i]**2;}return 10*Math.log10(b/a);};
  const noiseDb=db(.1,.18),voiceDb=db(.3,.7);assert.ok(noiseDb< -2,`noise ${noiseDb}`);assert.ok(Math.abs(voiceDb)<.3,`voice ${voiceDb}`);
  rows.push({rate,frames:n,noiseDb,voiceDb,firstPulse:64,lastPulse:n-64});
 }
 console.log(JSON.stringify({pass:true,rows},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
