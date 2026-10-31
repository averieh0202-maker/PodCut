import {build} from 'esbuild';import assert from 'node:assert/strict';import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const tmp=await mkdtemp(join(tmpdir(),'podcut-resampler-'));
try{
 const file=join(tmp,'lib.mjs');await build({stdin:{contents:"export {ContinuousResampler} from './src/audio/continuousResampler';export {RateTransposer} from '@soundtouchjs/core';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile:file,logLevel:'silent'});const {ContinuousResampler,RateTransposer}=await import(file);
 const sr=48000,amp=.3;
 const tone=(hz,speed)=>Float32Array.from({length:sr*8},(_,i)=>amp*Math.sin(2*Math.PI*hz*speed*Math.floor(i/2)/sr));
 function render(P,input,rate,blocks){const p=P===RateTransposer?new P({createBuffers:true}):new P(rate);if(P===RateTransposer)p.rate=rate;const out=[];let pos=0,k=0;while(pos<input.length/2){const n=Math.min(blocks[k++%blocks.length],input.length/2-pos);p.inputBuffer.putSamples(input,pos,n);pos+=n;p.process();const frames=p.outputBuffer.frameCount,x=new Float32Array(frames*2);p.outputBuffer.extract(x,0,frames);p.outputBuffer.receive(frames);for(let i=0;i<x.length;i++)out.push(x[i]);}return out;}
 function noise(pcm,hz){const a=10000,n=48000;let sin=0,cos=0,energy=0;for(let i=a;i<a+n;i++){const v=pcm[i*2],x=2*Math.PI*hz*i/sr;sin+=v*Math.sin(x);cos+=v*Math.cos(x);energy+=v*v;}const fundamental=Math.sqrt(2*(sin*sin+cos*cos))/n,residual=Math.sqrt(Math.max(0,energy/n-fundamental*fundamental));return {db:20*Math.log10(Math.max(1e-12,residual)/fundamental),fundamental};}
 const rows=[];
 for(const speed of [1.01,1.1,1.25,1.5,2,.5,.75]){
  const input=tone(8000,speed),small=render(ContinuousResampler,input,1/speed,[128]),large=render(ContinuousResampler,input,1/speed,[2048]),irregular=render(ContinuousResampler,input,1/speed,[17,389,1,2048]);
  assert.equal(small.length,large.length);assert.equal(small.length,irregular.length);
  let diff=0;for(let i=0;i<small.length;i++){diff=Math.max(diff,Math.abs(small[i]-large[i]),Math.abs(small[i]-irregular[i]));assert.ok(Number.isFinite(small[i]));}
  assert.ok(diff<1e-6,`chunk boundaries changed audio: ${speed}× ${diff}`);
  const stats=noise(small,8000),baseline=noise(render(RateTransposer,input,1/speed,[128]),8000);
  assert.ok(stats.db< -75,`high-frequency distortion ${speed}×: ${stats.db} dB`);
  assert.ok(Math.abs(stats.fundamental-amp/Math.sqrt(2))<.003,'keep high frequencies, do not mute them');
  if(!Number.isInteger(1/speed))assert.ok(stats.db<baseline.db-20,`noise improvement ${speed}×`);
  rows.push({speed,baselineNoiseDb:+baseline.db.toFixed(1),continuousNoiseDb:+stats.db.toFixed(1),chunkDifference:diff});
 }
 // A right-channel-only signal never leaks into the left channel.
 const stereo=tone(4000,1.1);for(let i=0;i<stereo.length;i+=2)stereo[i]=0;
 const pcm=render(ContinuousResampler,stereo,1/1.1,[128]);assert.ok(pcm.every((x,i)=>i%2===1||x===0));
 let recording;
 if(process.argv[2]){
  const bytes=await readFile(process.argv[2]);const mono=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4),input=new Float32Array(mono.length*2);
  for(let i=0;i<mono.length;i++)input[i*2]=input[i*2+1]=mono[i];
  const a=render(ContinuousResampler,input,1/1.1,[128]),b=render(ContinuousResampler,input,1/1.1,[2048]);
  assert.equal(a.length,b.length);let difference=0,peak=0;
  for(let i=0;i<a.length;i++){assert.ok(Number.isFinite(a[i]));difference=Math.max(difference,Math.abs(a[i]-b[i]));peak=Math.max(peak,Math.abs(a[i]));}
  assert.ok(difference<1e-6);assert.ok(peak>0);
  recording={seconds:mono.length/sr,speed:1.1,chunkDifference:difference,peak};
 }
 console.log(JSON.stringify({pass:true,rows,recording},null,2));
}finally{await rm(tmp,{recursive:true,force:true});}
