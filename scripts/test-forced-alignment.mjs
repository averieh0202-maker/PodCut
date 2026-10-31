import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const temp=await mkdtemp(join(tmpdir(),'podcast-align-'));let count=0;
try {
 const file=join(temp,'align.mjs');await build({entryPoints:[resolve('src/edit/forcedAlignment.ts')],outfile:file,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
 const {alignmentMono,alignmentChunks,mapAlignedTokens,applyForcedAlignment,alignmentFingerprint}=await import(pathToFileURL(file));
 const test=(name,fn)=>{fn();count++;console.log('✓',name);};
 const w=(id,text,start,end,extra={})=>({id,text,start,end,deleted:false,...extra});
 const clip=()=>({id:'test',words:[w('a','我',0,1),w('b','们',1,2)],ranges:[{start:0,end:3}],duration:3});
 test('Stereo alignment retains speakers on both independent channels',()=>{
  const left=new Float32Array(64),right=new Float32Array(64);left.fill(.8,0,32);right.fill(.4,32,64);
  const mono=alignmentMono([left,right]);assert.ok(mono[10]>.39);assert.ok(mono[40]>.19);
 });
 test('Anti-phase stereo cannot cancel the alignment audio',()=>{
  const a=new Float32Array(64).fill(.5),b=new Float32Array(64).fill(-.5);
  assert.ok(alignmentMono([a,b]).every(x=>Math.abs(x-.5)<1e-6));
 });
 test('Repeated characters match in full sequence, never nearest timestamp',()=>{
  const words=[w('a','我',0,.5),w('b','我',.5,1)];const chunk={start:10,end:12,words,coreIds:['a','b']};
  assert.deepEqual(mapAlignedTokens(chunk,[{text:'我',start:.1,end:.2},{text:'我',start:.7,end:.9}]),[{id:'a',start:10.1,end:10.2},{id:'b',start:10.7,end:10.9}]);
 });
 test('No fabricated splitting of a multi-character model interval',()=>{
  const chunk={start:0,end:2,words:[w('a','我',0,1),w('b','们',1,2)],coreIds:['a','b']};
  assert.throws(()=>mapAlignedTokens(chunk,[{text:'我们',start:0,end:2}]));
  assert.throws(()=>mapAlignedTokens(chunk,[{text:'你',start:0,end:1},{text:'们',start:1,end:2}]));
 });
 test('Nonfinite, reversed, overlapping and outside-audio times are rejected',()=>{
  const chunk={start:0,end:2,words:[w('a','我',0,1),w('b','们',1,2)],coreIds:['a','b']};
  for(const tokens of [[{text:'我',start:NaN,end:1},{text:'们',start:1,end:2}],[{text:'我',start:0,end:1.2},{text:'们',start:1,end:2}],[{text:'我',start:0,end:1},{text:'们',start:1,end:3}]]) assert.throws(()=>mapAlignedTokens(chunk,tokens));
 });
 test('Deleted and manually adjusted words remain in acoustic context',()=>{
  const words=[w('p','呀',5,6),w('a','我',0,1,{deleted:true}),w('b','们',1,2,{manualBoundary:true})];
  const chunks=alignmentChunks(words,6);assert.deepEqual(chunks.flatMap(c=>c.coreIds),['a','b','p']);assert.equal(chunks[0].words[0].deleted,true);
 });
 test('Long recordings use bounded overlapping chunks, every core token once',()=>{
  const words=Array.from({length:300},(_,i)=>w(String(i),'字',i*.4,i*.4+.3));const chunks=alignmentChunks(words,120);
  assert.ok(chunks.length>4);assert.equal(new Set(chunks.flatMap(c=>c.coreIds)).size,300);assert.ok(chunks.every(c=>c.end-c.start<27));assert.ok(chunks[0].words.some(w=>chunks[1].words.includes(w)));
 });
 test('Manual boundaries and arbitrary cuts remain unchanged; source is immutable',()=>{
  const c=clip();c.words[0].manualBoundary=true;c.ranges=[{start:0,end:.4},{start:.5,end:3}];const original=JSON.stringify(c);
  const r=applyForcedAlignment(c,[{id:'a',start:.1,end:.8},{id:'b',start:1.1,end:1.9}]);
  assert.equal(r.words[0].start,0);assert.equal(r.manual,1);assert.equal(r.words[1].alignmentSource,'qwen3');assert.deepEqual(r.ranges,c.ranges);assert.equal(JSON.stringify(c),original);
 });
 test('Deleted-word cuts are replaced atomically without restoring pause cuts',()=>{
  const c=clip();Object.assign(c.words[0],{deleted:true,removedAudio:[{start:0,end:1}]});c.ranges=[{start:1,end:2.4},{start:2.6,end:3}];c.clearedPauses=[{id:'pause',start:2.4,end:2.6}];
  const r=applyForcedAlignment(c,[{id:'a',start:.2,end:.8},{id:'b',start:1.1,end:1.8}]);
  assert.equal(r.words[0].deleted,true);assert.deepEqual(r.words[0].removedAudio,[{start:.2,end:.8}]);
  assert.deepEqual(r.ranges,[{start:0,end:.2},{start:.8,end:2.4},{start:2.6,end:3}]);
 });
 test('Copied-first playback order survives acoustic source-order analysis',()=>{
  const c=clip();c.words.unshift(w('p','我',2,3));c.audioOrder=[{start:2,end:3},{start:0,end:2}];c.ranges=c.audioOrder.map(r=>({...r}));
  const r=applyForcedAlignment(c,[{id:'a',start:.1,end:.9},{id:'b',start:1.1,end:1.9},{id:'p',start:2.1,end:2.9}]);
  assert.deepEqual(r.ranges,c.ranges);assert.deepEqual(r.words.map(w=>w.id),['p','a','b']);
 });
 test('Zero-width and conflicts with manual neighbours remain reviewable',()=>{
  const c=clip();c.words[0].manualBoundary=true;
  const r=applyForcedAlignment(c,[{id:'b',start:.5,end:1.9}]);assert.equal(r.aligned,0);assert.equal(r.skipped,1);
  assert.equal(applyForcedAlignment(c,[{id:'b',start:1.2,end:1.2}]).aligned,0);
 });
 test('Fingerprint detects deletion, boundary, pause and order changes during inference',()=>{
  for(const edit of [c=>c.words[0].deleted=true,c=>c.words[0].start=.1,c=>c.clearedPauses=[{start:2,end:3}],c=>c.audioOrder=[{start:2,end:3},{start:0,end:2}]]){const c=clip(),key=alignmentFingerprint(c);edit(c);assert.notEqual(alignmentFingerprint(c),key);}
 });
 console.log(`\n${count} acoustic-alignment checks passed`);
} finally {await rm(temp,{recursive:true,force:true});}
