import {build} from 'esbuild';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const tmp=await mkdtemp(join(tmpdir(),'podcut-performance-'));
try{
 const out=join(tmp,'modules.mjs');await build({stdin:{contents:"export * from './src/edit/pauseAnalysis';export * from './src/edit/draftStore';export * from './src/audio/denoise';",resolveDir:process.cwd()},outfile:out,bundle:true,format:'esm',platform:'node',logLevel:'silent'});
 const {analyzeClipPauses,draftToProject,serializeAudioBuffer,deserializeAudioBuffer,applyVoiceProcessing}=await import(pathToFileURL(out));
 class BufferAudio{constructor({length,numberOfChannels,sampleRate}){this.length=length;this.sampleRate=sampleRate;this.numberOfChannels=numberOfChannels;this.duration=length/sampleRate;this.channels=Array.from({length:numberOfChannels},()=>new Float32Array(length));}getChannelData(i){return this.channels[i];}copyToChannel(a,i){this.channels[i].set(a);}}
 globalThis.AudioBuffer=BufferAudio;
 const buffer=new BufferAudio({length:24000,numberOfChannels:1,sampleRate:8000});
 for(let i=0;i<24000;i++)buffer.channels[0][i]=i>=4000&&i<16000?0:.1*Math.sin(i*.15);
 const w=(id,start,end)=>({id,text:id,start,end,deleted:false,alignmentSource:'qwen3'});
 const c={id:'c',name:'test',buffer,cleanBuffer:buffer,duration:3,words:[w('甲',0,.5),w('乙',2,3)],ranges:[{start:0,end:3}],audioOrder:[{start:0,end:3}],manualPauses:[],clearedPauses:[],denoised:false,beautified:false};
 let a=analyzeClipPauses(c);assert.equal(analyzeClipPauses(c),a,'unchanged render reuses exact analysis');
 c.gainDb=6;assert.equal(analyzeClipPauses(c),a,'gain and UI changes do not rerun detection');
 c.words[0].end=.7;let b=analyzeClipPauses(c);assert.notEqual(a,b);assert.ok(b.pauses.every(p=>p.start>=.7),'manual boundary cannot leave cached pause over speech');a=b;
 c.ranges=[{start:0,end:.71},{start:1.99,end:3}];c.clearedPauses.push({id:'cut',start:.71,end:1.99});b=analyzeClipPauses(c);assert.notEqual(a,b);assert.ok(b.groups.some(g=>g.parts.some(p=>p.cleared)));a=b;
 c.ranges=[{start:0,end:3}];c.clearedPauses.length=0;b=analyzeClipPauses(c);assert.notEqual(a,b,'pause restore invalidates cache');a=b;
 c.words[1].deleted=true;b=analyzeClipPauses(c);assert.notEqual(a,b,'delete invalidates cache');a=b;
 c.manualPauses.push({id:'m',start:.9,end:1.1,sourceStart:.5,sourceEnd:2});b=analyzeClipPauses(c);assert.notEqual(a,b);assert.ok(b.pauses.some(p=>p.start===.9&&p.end===1.1));a=b;
 c.manualPauses[0].end=1.2;b=analyzeClipPauses(c);assert.notEqual(a,b,'in-place pause drag invalidates cache');a=b;
 c.audioOrder=[{start:1.5,end:3},{start:0,end:1.5}];b=analyzeClipPauses(c);assert.notEqual(a,b,'pasted/reordered audio invalidates cache');
 const clean=new BufferAudio({length:24000,numberOfChannels:1,sampleRate:8000});clean.channels[0].fill(.1);c.cleanBuffer=clean;assert.notEqual(analyzeClipPauses(c),b,'replacement audio invalidates cache');
 assert.equal(await applyVoiceProcessing(buffer,{}),buffer,'no-effects playback shares immutable PCM');
 const pcm=serializeAudioBuffer(buffer),restored=deserializeAudioBuffer(pcm);assert.notEqual(restored,buffer);assert.deepEqual(restored.channels[0],buffer.channels[0]);restored.channels[0][0]=.9;assert.notEqual(buffer.channels[0][0],.9,'restoration still owns its audio storage');
 const payload={version:2,clips:[{...c,clean:pcm,current:pcm,source:undefined}],music:[],gainDb:0,savedAt:0};
 const opts={decode:async()=>buffer,loadSfxBlob:async()=>null,applyFx:async()=>{throw Error('unexpected processing')}};
 const loaded=await draftToProject(payload,opts);assert.equal(loaded.project.clips[0].buffer,loaded.project.clips[0].cleanBuffer,'identical saved audio decoded once');
 const compressed=await draftToProject({...payload,clips:[{...payload.clips[0],clean:undefined,current:undefined,source:{blob:new Blob(['test']),mime:'audio/wav'}}]},opts);
 assert.equal(compressed.project.clips[0].buffer,compressed.project.clips[0].cleanBuffer,'new compressed import retains one decoded copy');
 console.log('Performance correctness passed: cache reuse and all edit invalidations; PCM sharing and isolated restoration');
}finally{await rm(tmp,{recursive:true,force:true});}
