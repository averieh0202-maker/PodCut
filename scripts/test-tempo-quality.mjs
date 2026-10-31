import {build} from 'esbuild';import assert from 'node:assert/strict';import {readFile,mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const tmp=await mkdtemp(join(tmpdir(),'tempo-quality-'));
const old=await readFile('node_modules/@soundtouchjs/audio-worklet/.dist/soundtouch-processor.js','utf8');
try {
 const file=join(tmp,'processor.js');await build({entryPoints:['src/audio/speechProcessor.ts'],bundle:true,format:'iife',platform:'browser',outfile:file,logLevel:'silent'});const fixed=await readFile(file,'utf8');
 const rows=[];let baselineGaps=0;
 for(const sr of [44100,48000])for(const speed of [.5,1.01,1.1,1.25,1.5,2])for(const legacy of [true,false]){
  let Processor;Object.assign(globalThis,{sampleRate:sr,AudioWorkletProcessor:class {port={postMessage(){},onmessage:null};},registerProcessor:(_name,P)=>Processor=P});(0,eval)(legacy?old:fixed);
  const p=new Processor();if(legacy)p.port.onmessage({data:{type:'set-stretch-parameters',params:{sequenceMs:40,seekWindowMs:15,overlapMs:8}}});
  let gaps=0,maxJump=0,prev=0,crossings=0,peak=0;
  // Capture actual 128-frame output, not just frequency: zero-filled holes click.
  for(let pos=0;pos<sr*8;pos+=128){
   const x=Float32Array.from({length:128},(_,i)=>.4*Math.sin(2*Math.PI*220*(pos+i)/sr*speed)),l=new Float32Array(128),r=new Float32Array(128);
   p.process([[x]],[[l,r]],{pitch:new Float32Array([1]),pitchSemitones:new Float32Array([0]),playbackRate:new Float32Array([speed])});
   if(pos<sr*.3){prev=l.at(-1);continue;}
   for(let i=0;i<128;i++){const v=l[i];if(v===0)gaps++;assert.ok(Number.isFinite(v));assert.equal(v,r[i]);maxJump=Math.max(maxJump,Math.abs(v-prev));peak=Math.max(peak,Math.abs(v));if(prev<=0&&v>0)crossings++;prev=v;}
  }
  if(legacy){baselineGaps+=gaps;continue;}
  assert.equal(gaps,0,`${sr}Hz ${speed}×: no zero-filled holes after warmup`);
  assert.ok(maxJump<.025,`${sr}Hz ${speed}×: no sudden jumps (${maxJump})`);
  assert.ok(Math.abs(crossings/7.7-220)<2,'original pitch retained');assert.ok(peak<.405,'no processing gain overshoot');
  rows.push({sampleRate:sr,speed,gaps,maxJump:+maxJump.toFixed(5),frequency:+(crossings/7.7).toFixed(2)});
 }
 assert.ok(baselineGaps>0,'baseline must reproduce a dropout in this fixture');
 console.log(JSON.stringify({baselineZeroFilledSamples:baselineGaps,checks:rows},null,2));
}finally{await rm(tmp,{recursive:true,force:true});}
