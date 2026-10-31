import {pcm16} from './wav-test-utils.mjs';
/** Compare encoded export against the actual preview worklet, not just pitch.
 * Optional fixture: mono 44.1kHz f32le recording (never uploaded). */
import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const tmp=await mkdtemp(join(tmpdir(),'podcut-export-preview-'));
try{
 await build({stdin:{contents:"export {exportMixedWav} from './src/audio/exportAudio';export {ContinuousResampler} from './src/audio/continuousResampler';export {tempoLatency} from './src/audio/tempoQuality';",resolveDir:process.cwd()},bundle:true,plugins:[{name:'browser-worker-url',setup(b){b.onResolve({filter:/speechProcessor\?worker&url$/},()=>({path:'worker-url',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export default "browser-only-worklet"',loader:'js'}));}}],platform:'node',format:'esm',outfile:join(tmp,'lib.mjs'),logLevel:'silent'});
 await build({entryPoints:['src/audio/speechProcessor.ts'],bundle:true,format:'iife',outfile:join(tmp,'processor.js'),logLevel:'silent'});
 const {exportMixedWav,ContinuousResampler,tempoLatency}=await import(join(tmp,'lib.mjs'));
 const processorCode=await readFile(join(tmp,'processor.js'),'utf8');
 let Processor;
 const rows=[];
 async function verify(data,sr,speed,label){
  Object.assign(globalThis,{sampleRate:sr,AudioWorkletProcessor:class{port={postMessage(){}}},registerProcessor:(_name,P)=>Processor=P});(0,eval)(processorCode);
  const input={duration:data.length/sr,length:data.length,sampleRate:sr,numberOfChannels:1,getChannelData:()=>data};
  const blob=await exportMixedWav([{id:'voice',buffer:input,ranges:[{start:0,end:input.duration}],gainDb:0}],[],1,speed);
  const bytes=await blob.arrayBuffer(),wav=new DataView(bytes),count=wav.getUint32(40,true)/wav.getUint16(32,true);
  assert.equal(wav.getUint32(24,true),sr);assert.equal(wav.getUint16(20,true),1);assert.equal(wav.getUint16(22,true),1);
  assert.ok(Math.abs(count-data.length/speed)<=1);
  // Rate-adjusted source into the actual worklet, exactly as preview does.
  const rate=Math.fround(speed),resampler=new ContinuousResampler(rate),p=new Processor();
  const stereo=new Float32Array((data.length+sr)*2);for(let i=0;i<data.length;i++)stereo[i*2]=stereo[i*2+1]=data[i];
  const source=[];
  for(let pos=0;pos<stereo.length/2;pos+=2048){resampler.inputBuffer.putSamples(stereo,pos,Math.min(2048,stereo.length/2-pos));resampler.process();const n=resampler.outputBuffer.frameCount,b=new Float32Array(n*2);resampler.outputBuffer.extract(b,0,n);resampler.outputBuffer.receive(n);for(let i=0;i<n;i++)source.push(b[i*2]);}
  const latency=Math.round(tempoLatency(sr)*sr),reference=[];
  for(let pos=0;pos<count+latency;pos+=128){const b=Float32Array.from({length:128},(_,i)=>source[pos+i]??0),l=new Float32Array(128),r=new Float32Array(128);p.process([[b]],[[l,r]],{pitch:new Float32Array([1]),pitchSemitones:new Float32Array([0]),playbackRate:new Float32Array([speed])});if(pos>=latency)for(const x of l)reference.push(x);}
  let error=0,peak=0;for(let i=0;i<count;i++){const x=reference[i],encoded=Math.trunc(Math.max(-1,Math.min(1,x))*(x<0?32768:32767)),actual=pcm16(wav,i);error=Math.max(error,Math.abs(encoded-actual));peak=Math.max(peak,Math.abs(actual));}
  // 4 PCM units allow float summation differences; larger errors are audible-chain drift.
  assert.ok(error<=4,`${label} ${sr}Hz ${speed}× differs from preview by ${error} PCM units`);
  assert.ok(peak>100,'speech is present');
  rows.push({label,sampleRate:sr,speed,seconds:count/sr,maxPcmDifference:error});
  if(label==='recording'&&process.argv[3])await writeFile(process.argv[3],Buffer.from(bytes));
 }
 for(const sr of [44100,48000])for(const speed of [.5,1.1,1.25,2]){
  // Nonstationary voiced harmonics + sibilant, unlike a lone 220Hz tone.
  const data=Float32Array.from({length:sr*3},(_,i)=>{const t=i/sr,phase=2*Math.PI*(170*t+15*t*t);return .18*(.6+.4*Math.sin(2*Math.PI*3*t))*(Math.sin(phase)+.3*Math.sin(3*phase))+.015*Math.sin(2*Math.PI*(3700*t+210*t*t));});
  await verify(data,sr,speed,'varying-speech');
 }
 if(process.argv[2]){const b=await readFile(process.argv[2]);await verify(new Float32Array(b.buffer,b.byteOffset,b.byteLength/4),44100,1.1,'recording');}
 console.log(JSON.stringify({pass:true,checks:rows},null,2));
}finally{await rm(tmp,{recursive:true,force:true});}
