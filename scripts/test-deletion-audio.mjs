import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const temp=await mkdtemp(join(tmpdir(),'podcut-deletion-audio-'));
try{
 const file=join(temp,'lib.mjs');
 await build({stdin:{contents:"export * from './server/deletionAudio';export * from './server/diskDraftStore';export * from './src/edit/deleteRuns';export * from './src/edit/deletionEdges';",resolveDir:process.cwd()},outfile:file,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {loadDeletionAudio,DiskDraftStore,deleteWordRuns,deletionAudioSummary}=await import(pathToFileURL(file));
 const store=new DiskDraftStore(join(temp,'draft')),sr=16000,length=sr*3;
 const signal=Float32Array.from({length},(_,i)=>i/sr>=.8&&i/sr<1.2?.2*Math.sin(2*Math.PI*180*i/sr):0);
 const wav=Buffer.alloc(44+length*4);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(2,22);wav.writeUInt32LE(sr,24);wav.writeUInt32LE(sr*4,28);wav.writeUInt16LE(4,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(length*4,40);
 for(let i=0;i<length;i++){wav.writeInt16LE(Math.round(signal[i]*32767),44+i*4);wav.writeInt16LE(-Math.round(signal[i]*32767),46+i*4);}
 const source=await store.upload(Readable.from([wav]));
 const words=[{id:'a',text:'前',start:.1,end:.4,deleted:false},{id:'b',text:'删',start:.9,end:1.1,deleted:false},{id:'c',text:'后',start:1.5,end:1.9,deleted:false}];
 const clip={id:'clip',words,duration:3,ranges:[{start:0,end:3}],audioOrder:[{start:0,end:3}],source:{blob:{diskAsset:source.id}}};
 const cuts=[{clipId:'clip',startWordId:'b',endWordId:'b'}];
 async function check(c,label){
  const map=await loadDeletionAudio(store,{clips:[c]},cuts),audio=map.get(c.id);assert.equal(audio.length,1);assert.ok(audio[0].offsetSec>0);assert.ok(audio[0].channel.length/sr<1.3);
  assert.ok(audio[0].channels[0].some(x=>Math.abs(x)>.1));assert.ok(audio[0].channels[1].some(x=>Math.abs(x)>.1));
  deleteWordRuns(c,new Set(['b']),false,audio);assert.ok(c.ranges.every(r=>r.end<=.805||r.start>=1.195),label+' does not leave late onset/tail');
  console.log('✓',label);
 }
 await check(structuredClone(clip),'Bounded encoded stereo/anti-phase audio has complete cuts');
 const channels=await Promise.all([signal,Float32Array.from(signal,x=>-x)].map(c=>store.upload(Readable.from([Buffer.from(c.buffer)]))));
 const raw=structuredClone(clip);raw.clean={sampleRate:sr,length,channels:channels.map(c=>({diskAsset:c.id}))};delete raw.source;
 await check(raw,'Saved float PCM analysis uses the same source clock and preserves channels');
 const full={channel:signal,channels:[signal,Float32Array.from(signal,x=>-x)],sampleRate:sr};
 const summary=deletionAudioSummary(full),a=structuredClone(clip),b=structuredClone(clip);deleteWordRuns(a,new Set(['b']),false,full);deleteWordRuns(b,new Set(['b']),false,summary);assert.deepEqual(a.ranges,b.ranges);assert.ok(summary.channel.length<signal.length/50);console.log('✓ Compact CLI analysis matches full PCM without retaining large recordings');
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(loadDeletionAudio(store,{clips:[clip]},cuts,cancelled.signal));console.log('✓ Cancelling analysis prevents applying an unchecked cut');
}finally{await rm(temp,{recursive:true,force:true});}
