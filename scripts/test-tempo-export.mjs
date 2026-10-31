import {pcm16} from './wav-test-utils.mjs';
import {build} from 'esbuild';import assert from 'node:assert/strict';import {mkdtemp,rm,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
globalThis.AudioBuffer=class {constructor({length,numberOfChannels,sampleRate}){Object.assign(this,{length,numberOfChannels,sampleRate,duration:length/sampleRate});this.data=Array.from({length:numberOfChannels},()=>new Float32Array(length));}copyToChannel(data,c){this.data[c].set(data);}getChannelData(c){return this.data[c];}};
const dir=await mkdtemp(join(tmpdir(),'tempo-export-'));
try{
 const file=join(dir,'lib.mjs');await build({stdin:{contents:"export * from './src/audio/exportAudio';export * from './src/edit/episodeTimeline';export * from './src/edit/draftStore';",resolveDir:process.cwd()},bundle:true,plugins:[{name:'browser-worker-url',setup(b){b.onResolve({filter:/speechProcessor\?worker&url$/},()=>({path:'worker-url',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export default "browser-only-worklet"',loader:'js'}));}}],platform:'node',format:'esm',outfile:file,logLevel:'silent'});
 const {exportMixedWav,episodeSegments,projectToDraft,draftToProject}=await import(file);
 const sr=16000,buf=(duration,hz,channel)=>{const data=Array.from({length:2},(_,c)=>Float32Array.from({length:Math.round(duration*sr)},(_,i)=>c===channel?.25*Math.sin(2*Math.PI*hz*i/sr):0));return {duration,sampleRate:sr,numberOfChannels:2,length:data[0].length,getChannelData:c=>data[c]};};
 const voice=buf(4,220,0),bed=buf(6,660,1),stinger=buf(1,880,1);
 const words=[{id:'a',text:'前句。',start:0,end:2,breakAfter:true},{id:'b',text:'后句。',start:2,end:4}];
 const clips=[{id:'c',name:'speech',duration:4,buffer:voice,cleanBuffer:voice,ranges:[{start:0,end:1},{start:1.1,end:2},{start:2,end:4}],words,gainDb:0}];
 const music=[{id:'bed',name:'bed',kind:'bed',buffer:bed,inPoint:0,outPoint:6,gainDb:0,clipId:'c',wordId:'a',originalTime:0,anchorSide:'before',leadInSec:1,fadeInSec:0,fadeOutSec:0},{id:'st',name:'st',kind:'stinger',buffer:stinger,inPoint:0,outPoint:1,gainDb:-12,clipId:'c',wordId:'b',originalTime:2,anchorSide:'before',fadeInSec:0,fadeOutSec:0}];
 function frequency(v,ch,start,duration){let crossings=0,prev=0;for(let i=Math.round(start*sr);i<Math.round((start+duration)*sr);i++){const sample=pcm16(v,i*2+ch);if(prev<=0&&sample>0)crossings++;prev=sample;}return crossings/duration;}
 const results=[];
 for(const speed of [.5,1,1.01,1.1,1.25,1.5,2]){
  const blob=await exportMixedWav(clips,music,1,speed),ab=await blob.arrayBuffer(),v=new DataView(ab),duration=v.getUint32(40,true)/v.getUint16(32,true)/sr;
  assert.ok(Math.abs(duration-Math.max(6,2+3.9/speed))<1/sr);
  const hz=frequency(v,0,1.15,.5),musicHz=frequency(v,1,.1,.7);assert.ok(Math.abs(hz-220)<5,`voice ${speed}: ${hz}`);assert.ok(Math.abs(musicHz-660)<3);
  // Both intro and bed tail are bit-exact at every speed: music never goes through WSOLA.
  for(const time of [.2,.4,5.8]){const i=Math.round(time*sr),sample=pcm16(v,i*2+1);assert.ok(Math.abs(sample-bed.getChannelData(1)[i]*32767)<2);}
  const end=2+3.9/speed;let peak=0;for(let i=Math.floor((end-.025)*sr);i<Math.floor((end-.005)*sr);i++)peak=Math.max(peak,Math.abs(pcm16(v,i*2)));assert.ok(peak>3000,`tail preserved ${speed}`);
  const segments=episodeSegments(clips,music,speed);assert.equal(segments[0].start,1);assert.ok(Math.abs(segments[0].end-(1+1.9/speed))<1e-8);assert.ok(Math.abs(segments[1].start-(2+1.9/speed))<1e-8);
  const draft=projectToDraft({project:{clips,music:[],gainDb:0,audioName:'test',speechRate:speed},activeClipId:'c',clipIdSeq:1,musicIdSeq:0});assert.equal(draft.speechRate,speed);
  const restored=await draftToProject(draft,{decode:async()=>voice,loadSfxBlob:async()=>null,applyFx:async b=>b});assert.equal(restored.project.speechRate,speed);
  results.push({speed,duration,speechHz:hz,musicHz,tailPeak:peak});
  if(speed===1.5)await writeFile('/private/tmp/podcut-tempo-export-1.5.wav',Buffer.from(ab));
 }
 console.log(JSON.stringify(results,null,2));
}finally{await rm(dir,{recursive:true,force:true});}
