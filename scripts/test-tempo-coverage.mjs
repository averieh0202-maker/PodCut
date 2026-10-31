import {build} from 'esbuild';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const tmp=await mkdtemp(join(tmpdir(),'podcut-tempo-'));
try{
 const file=join(tmp,'test.mjs');await build({stdin:{contents:"export * from './src/audio/mixSchedule';export * from './src/audio/musicCoverage';export * from './src/audio/speechTempo';export * from './src/edit/pauseEditing';export * from './src/edit/pauses';",resolveDir:process.cwd()},outfile:file,bundle:true,format:'esm',platform:'node',logLevel:'silent'});
 const {buildMixSchedule,mixedWords,musicCoverage,speechTempoMap,pauseDeletionCuts,bulkPauseParts}=await import(file);
 const words=Array.from({length:10},(_,i)=>({id:'w'+i,text:i===3?'Siri':'字'+i,start:i,end:i+1,deleted:false}));
 const clips=[{id:'c',buffer:{duration:10},ranges:[{start:0,end:10}],words}];
 const music=[{id:'bed',kind:'bed',name:'背景',buffer:{duration:8},inPoint:0,outPoint:8,clipId:'c',wordId:'w0',originalTime:0,anchorSide:'before',leadInSec:2,gainDb:-15},{id:'st',kind:'stinger',buffer:{duration:3},inPoint:0,outPoint:3,clipId:'c',wordId:'w5',originalTime:5,anchorSide:'before',gainDb:-3}];
 const mix=buildMixSchedule(clips,music);const timed=mixedWords(clips,mix);
 assert.equal(timed[0].start,2);assert.equal(timed[5].start,10);
 const bed=musicCoverage('bed',timed,mix);assert.equal(bed.side,'before');assert.equal(bed.word.id,'w5');assert.equal(bed.gap,2);
 assert.equal(musicCoverage('st',timed,mix).word.id,'w5');assert.equal(musicCoverage('st',timed,mix).side,'before');
 const map=speechTempoMap(mix,2);
 assert.equal(map.toWall(2),2,'music lead remains two seconds');
 assert.equal(map.toWall(7),4.5,'five seconds speech compresses to 2.5');
 assert.equal(map.toWall(10)-map.toWall(7),3,'stinger remains three seconds');
 assert.equal(map.toWall(15),10,'only speech compresses');
 for(let t=0;t<15;t+=.031)assert.ok(Math.abs(map.toProject(map.toWall(t))-t)<1e-6,'seek clock roundtrip');
 const fastBed=musicCoverage('bed',timed,mix,2);assert.equal(fastBed.word.id,'w5');assert.equal(fastBed.side,'after','8s bed ends at next spoken word at 2x');
 assert.deepEqual(pauseDeletionCuts(words,[{start:3.1,end:3.8}]),[],'unaligned English word cannot become silence');
 const residue={id:'gap',anchorId:'w0',parts:[{id:'silence',start:1,end:1.7,cleared:true},{id:'inhale',start:1.7,end:1.78,breath:true}]};
 assert.equal(bulkPauseParts(residue,.55).length,2,'80ms inhalation left inside an already deleted long pause remains removable');
 assert.equal(bulkPauseParts({...residue,parts:residue.parts.map(p=>({...p,breath:false}))},.55).length,0,'old deleted duration must not make silent guards repeatedly eligible');
 console.log('Tempo/music checks passed: lead, stinger, bed duration, endpoints, seek roundtrip, unaligned English protection');
}finally{await rm(tmp,{recursive:true,force:true});}
