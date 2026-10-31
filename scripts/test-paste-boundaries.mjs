import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
globalThis.AudioWorkletNode=class {};
const temp=await mkdtemp(join(tmpdir(),'podcast-paste-'));let count=0;
try {
 const mod={};
 for(const file of ['edit/timeline','edit/audioOrder','edit/wordBoundary','edit/history','edit/draftStore','audio/engine','audio/exportAudio','audio/mixSchedule']) {
  const out=join(temp,file.replaceAll('/','-')+'.mjs');await build({entryPoints:[resolve('src',file+'.ts')],outfile:out,bundle:true,platform:'node',format:'esm',logLevel:'silent',plugins:[{name:'worklet-url',setup(b){b.onResolve({filter:/\?worker&url$/},a=>({path:a.path,namespace:'test-worklet'}));b.onLoad({filter:/.*/,namespace:'test-worklet'},()=>({contents:'export default "/test-worklet.js"',loader:'js'}));}}]});Object.assign(mod,await import(pathToFileURL(out)));
 }
 const {ensureAudioOrder,addRange,removeRange,toEdit,toOriginal,insertRangesAt,extractEditRanges,updateWordBoundary,UndoStack,projectToDraft,slimDraftForQuota,draftToProject,AudioEngine}=mod;
 const test=async(name,fn)=>{await fn();count++;console.log('✓',name);};
 const word=(id,start,end)=>({id,text:'字',start,end,deleted:false,speakerId:id==='paste'?'recording-b:2':'recording-a:1',speakerName:id==='paste'?'嘉宾':'主持人'});
 const make=()=>({duration:3,words:[word('paste',2,3),word('a',0,1),word('b',1,2)],ranges:[{start:0,end:3}]});
 await test('Legacy sorted draft is repaired to pasted-first playback',()=>{const c=make();ensureAudioOrder(c);assert.deepEqual(c.ranges,[{start:2,end:3},{start:0,end:2}]);assert.ok(Math.abs(toOriginal(c.ranges,1.2)-.2)<1e-9);assert.equal(toEdit(c.ranges,.2),1.2);});
 await test('Restoring a word cannot move pasted text back to the end',()=>{const c=make();ensureAudioOrder(c);c.ranges=removeRange(c.ranges,.3,.7);c.ranges=addRange(c.ranges,.3,.7);ensureAudioOrder(c);assert.deepEqual(c.ranges,[{start:2,end:3},{start:0,end:2}]);});
 await test('Fully deleted pasted segment restores in its original edit slot',()=>{const c=make();ensureAudioOrder(c);c.ranges=removeRange(c.ranges,2,3);c.ranges=addRange(c.ranges,2,3);ensureAudioOrder(c);assert.equal(c.ranges[0].start,2);});
 await test('Paste into the middle survives cut/restore without moving silence',()=>{const c=make();c.audioOrder=insertRangesAt([{start:0,end:2}],.6,[{start:2,end:3}]);c.ranges=[...c.audioOrder];c.ranges=removeRange(c.ranges,.7,.9);c.ranges=addRange(c.ranges,.7,.9);ensureAudioOrder(c);assert.deepEqual(c.ranges,[{start:0,end:.6},{start:2,end:3},{start:.6,end:2}]);});
 await test('Copy across a paste seam follows playback order only',()=>{assert.deepEqual(extractEditRanges([{start:2,end:3},{start:0,end:2}],.5,1.5),[{start:2.5,end:3},{start:0,end:.5}]);});
 await test('Deleted word boundary can shrink and expand without reviving other cuts',()=>{const c=make();ensureAudioOrder(c);const w=c.words[0];w.deleted=true;w.removedAudio=[{start:2,end:3}];c.ranges=removeRange(c.ranges,2,3);c.clearedPauses=[{start:.3,end:.4}];c.ranges=removeRange(c.ranges,.3,.4);updateWordBoundary(c,w,2.2,2.8);assert.equal(w.deleted,true);assert.ok(c.ranges.some(r=>r.start===2 && Math.abs(r.end-2.2)<1e-6));assert.ok(!c.ranges.some(r=>r.start<=.35 && r.end>.35));updateWordBoundary(c,w,2.1,2.9);assert.deepEqual(w.removedAudio,[{start:2.1,end:2.9}]);assert.equal(c.ranges[0].start,2);});
 await test('Kept-word boundary edit does not delete audio',()=>{const c=make();ensureAudioOrder(c);const ranges=JSON.stringify(c.ranges);updateWordBoundary(c,c.words[0],2.1,2.9);assert.equal(JSON.stringify(c.ranges),ranges);assert.equal(c.words[0].manualBoundary,true);});
 await test('Invalid boundary cannot corrupt the timeline',()=>{const c=make();const before=JSON.stringify(c);assert.throws(()=>updateWordBoundary(c,c.words[0],3,2));assert.equal(JSON.stringify(c),before);});
 await test('Undo restores playback order and deleted-word boundaries',()=>{const c=make();ensureAudioOrder(c);const u=new UndoStack();u.push({clipId:'c',...c});updateWordBoundary(c,c.words[0],2.1,2.9);const old=u.pop();assert.equal(old.words[0].start,2);assert.equal(old.words[0].speakerName,'嘉宾');assert.deepEqual(old.audioOrder,[{start:2,end:3},{start:0,end:2}]);});
 class BufferAudio {constructor({length,numberOfChannels,sampleRate}){this.length=length;this.numberOfChannels=numberOfChannels;this.sampleRate=sampleRate;this.duration=length/sampleRate;this.channels=Array.from({length:numberOfChannels},()=>new Float32Array(length));}getChannelData(i){return this.channels[i];}copyToChannel(a,i){this.channels[i].set(a);}}
 globalThis.AudioBuffer=BufferAudio;
 const buf=new BufferAudio({length:3000,numberOfChannels:1,sampleRate:1000});buf.channels[0].fill(.2,0,2000);buf.channels[0].fill(.6,2000);
 await test('Draft roundtrip preserves explicit order and manual deleted boundaries',async()=>{const c={...make(),id:'c',name:'test',buffer:buf,cleanBuffer:buf,bufferDirty:true,denoised:false,beautified:false};ensureAudioOrder(c);const draft=slimDraftForQuota(projectToDraft({project:{clips:[c],music:[],gainDb:0,audioName:'test'},activeClipId:'c',clipIdSeq:1,musicIdSeq:0}));const restored=await draftToProject(draft,{decode:async()=>{throw new Error('unexpected decode');},loadSfxBlob:async()=>null,applyFx:async b=>b});assert.deepEqual(restored.project.clips[0].audioOrder,c.audioOrder);assert.deepEqual(restored.project.clips[0].ranges,c.ranges);assert.equal(restored.project.clips[0].words[0].speakerId,'recording-b:2');assert.equal(restored.project.clips[0].words[0].speakerName,'嘉宾');});
 await test('Actual playback scheduler crosses pasted/source seam without ending',()=>{
  const starts=[];let raf;const node=()=>({connect(){},disconnect(){}});
  const ctx={state:'running',currentTime:0,createGain(){return {...node(),context:ctx,gain:{value:1,cancelScheduledValues(){},setValueAtTime(){}}};},createMediaStreamDestination(){return {...node(),stream:{}};},createAnalyser(){return {...node(),frequencyBinCount:10};},createBuffer:(n,len,sr)=>new BufferAudio({numberOfChannels:n,length:len,sampleRate:sr}),createBufferSource(){return {...node(),playbackRate:{value:1},start(...a){starts.push(a);},stop(){}};}};
  globalThis.window={AudioContext:function(){return ctx;},setTimeout:()=>0,clearTimeout(){}};globalThis.document={createElement:()=>({setAttribute(){},style:{},play:()=>Promise.resolve(),pause(){}}),body:{appendChild(){}}};globalThis.requestAnimationFrame=fn=>{raf=fn;return 1;};globalThis.cancelAnimationFrame=()=>{};
  const c=make();ensureAudioOrder(c);const engine=new AudioEngine();let ended=0;let original;
  engine.setClips([{buffer:buf,ranges:c.ranges}]);engine.setHandlers({onEnded:()=>ended++,onTick:(_t,_c,o)=>original=o});engine.play(0);
  assert.equal(starts.length,2);assert.ok(Math.abs(starts[1][0]-starts[0][0]-1)<1e-9);
  ctx.currentTime=1.3;raf();assert.equal(ended,0);assert.ok(original>.2 && original<.3);assert.equal(engine.isPlaying(),true);engine.stop();
  // The clip-start caret includes retained silence rather than seeking the first word.
  engine.setClips([{buffer:buf,ranges:[{start:0,end:.8},{start:1.8,end:3}]}]);
  engine.seekOriginal(0,2);assert.ok(engine.getEditTime()>0);
  engine.seekClipStart(0);assert.equal(engine.getEditTime(),0);
  engine.play();assert.equal(starts.at(-2)[1],0);engine.stop();
 });
 await test('Repeated playback prepares slow PCM before scheduling, including music mixes',()=>{
  const starts=[],gains=[];const node=()=>({connect(){},disconnect(){}});
  const ctx={state:'running',currentTime:10,createGain(){const result={...node(),context:ctx,gain:{value:1,cancelScheduledValues(){},setValueAtTime(v){this.value=v;}}};gains.push(result);return result;},createMediaStreamDestination(){return {...node(),stream:{}};},createAnalyser(){return {...node(),frequencyBinCount:10};},createBuffer:(n,len,sr)=>{ctx.currentTime+=.4;return new BufferAudio({numberOfChannels:n,length:len,sampleRate:sr});},createBufferSource(){return {...node(),playbackRate:{value:1},start(when,offset,duration){starts.push({when,clock:ctx.currentTime,offset,duration});},stop(){}};}};
  globalThis.window={AudioContext:function(){return ctx;},setTimeout:()=>0,clearTimeout(){}};globalThis.document={createElement:()=>({setAttribute(){},style:{},play:()=>Promise.resolve(),pause(){}}),body:{appendChild(){}}};globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};
  const engine=new AudioEngine();const ranges=[{start:0,end:.8},{start:1.8,end:3}];
  engine.setClips([{buffer:buf,ranges}]);
  for(let run=0;run<3;run++){starts.length=0;engine.seekClipStart(0);engine.play(0);assert.equal(starts.length,2);assert.ok(starts.every(s=>s.when>=s.clock+.05));assert.equal(starts[0].offset,0);engine.pause();}
  const mix=mod.buildMixSchedule([{id:'c',buffer:buf,ranges}], [{id:'m',clipId:'c',originalTime:2,kind:'stinger',buffer:buf,inPoint:0,outPoint:.2,gainDb:0,fadeInSec:.05,fadeOutSec:.05}]);
  engine.setMixSchedule(mix);engine.setGain(10**(13.5/20));
  for(let run=0;run<3;run++){starts.length=0;engine.seekClipStart(0);engine.play(0);assert.ok(starts.length>=3);assert.ok(starts.every(s=>s.when>=s.clock+.05));assert.equal(engine.getEditTime(),0);assert.equal(gains[0].gain.value,1);engine.pause();}
 });
 console.log(`\n${count} paste / boundary regression checks passed`);
}finally{await rm(temp,{recursive:true,force:true});}
