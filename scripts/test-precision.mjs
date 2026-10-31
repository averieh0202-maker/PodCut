import {pcm16} from './wav-test-utils.mjs';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const temp = await mkdtemp(join(tmpdir(), 'podcast-precision-'));
let passed = 0;
try {
  const files = ['edit/alignment', 'edit/refineBoundaries', 'edit/pauses', 'edit/tokenize', 'edit/timeline', 'audio/exportAudio', 'audio/mixSchedule', 'audio/splice'];
  const mods = {};
  for (const file of files) {
    const outfile = join(temp, file.replace('/', '-') + '.mjs');
    await build({ entryPoints: [resolve('src', file + '.ts')], outfile, bundle: true,plugins:[{name:'browser-worker-url',setup(b){b.onResolve({filter:/speechProcessor\?worker&url$/},()=>({path:'worker-url',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export default "browser-only-worklet"',loader:'js'}));}}], platform: 'node', format: 'esm', logLevel: 'silent' });
    Object.assign(mods, await import(pathToFileURL(outfile)));
  }
  const { refineWordBoundariesInPlace: refine, wordCutExtent: cut, energySwallowRange: expand, detectPauses, singlePauseCut, characterWords, removeRange, exportEditedWav, exportMixedWav, bakeFadedBufferSlice } = mods;
  const sr = 16000;
  const tone = (dur, spans) => {
    const ch = new Float32Array(Math.round(sr * dur));
    for (const [a, b, amp = .3] of spans) for (let i = Math.round(a * sr); i < Math.min(ch.length, Math.round(b * sr)); i++) ch[i] = amp * Math.sin(2 * Math.PI * 200 * i / sr);
    return ch;
  };
  const word = (id, start, end, text = id) => ({ id, text, start, end, deleted: false });
  const test = async (name, fn) => { await fn(); passed++; console.log('✓', name); };
  await test('Long pauses survive refinement unchanged', () => {
    const w = [word('甲', .1, .3), word('乙', 1.2, 1.5)];
    refine(w, tone(2, [[.1,.3],[1.2,1.5]]), sr, 2);
    assert.equal(w[0].end, .3); assert.equal(w[1].start, 1.2);
  });
  await test('Flat energy does not manufacture a new word boundary', () => {
    const w = [word('甲', 0,.3),word('乙',.3,.6)];
    refine(w, new Float32Array(sr).fill(.2), sr, 1);
    assert.equal(w[0].end,.3); assert.equal(w[1].start,.3);
  });
  await test('Local valley adjustment stays within 30ms', () => {
    const w = [word('甲',.1,.3),word('乙',.3,.6)];
    refine(w,tone(1,[[.1,.28],[.29,.6]]),sr,1);
    assert.ok(w[0].end >= .27 && w[0].end <= .33);
    assert.ok(w[1].start >= w[0].end);
  });
  await test('Weak onset/tail cannot be swallowed as silence', () => {
    const ch=tone(1,[[.05,.2],[.21,.29,.006],[.3,.5],[.51,.6,.006],[.62,.9]]);
    const e={channel:ch,sampleRate:sr,maxSwallowSec:.2};
    const r=expand({start:.3,end:.5},.2,.62,e);
    assert.ok(r.start>=.29);assert.ok(r.end<=.51+1e-8);
  });
  await test('Partial frame inspection does not skip an audible frame', () => {
    const ch=tone(1,[[.3,.31]]);
    const r=expand({start:.2,end:.302},0,.8,{channel:ch,sampleRate:sr,maxSwallowSec:.1});
    assert.equal(r.end,.302);
  });
  await test('Deletion never crosses a kept neighbour and ignores punctuation audio', () => {
    const w=[word('甲',.1,.3),word('，',.3,.8),word('乙',.8,1)];
    assert.deepEqual(cut(w,'，'),{start:.3,end:.3});
    const r=cut(w,'甲',{energy:{channel:new Float32Array(sr),sampleRate:sr}});
    assert.ok(r.end<=.312+1e-9);assert.ok(r.start>=.088-1e-9);
  });
  await test('Manual word boundaries are respected exactly', () => {
    const w=[word('甲',.1,.3),{...word('乙',.5,.7),manualBoundary:true},word('丙',.9,1)];
    assert.deepEqual(cut(w,'乙',{energy:{channel:new Float32Array(sr),sampleRate:sr}}),{start:.5,end:.7});
  });
  await test('Acoustic pause within an old oversized word is still marked', () => {
    const ch=tone(2,[[0,.4],[1.3,2]]);
    const ps=detectPauses([word('甲',0,1.4)], [{start:0,end:2}], {channel:ch,sampleRate:sr},2);
    assert.equal(ps.length,1);assert.ok(ps[0].cut.start>=.41-1e-7);assert.ok(ps[0].cut.end<=1.29+1e-7);
    assert.ok(Math.abs(ps[0].duration-(ps[0].cut.end-ps[0].cut.start)-.02)<.001);
  });
  await test('Repeat pause removal is idempotent', () => {
    const ch=tone(2,[[0,.4],[1.3,2]]), input={channel:ch,sampleRate:sr};
    const p=detectPauses([], [{start:0,end:2}],input,2)[0];
    const ranges=removeRange([{start:0,end:2}],p.cut.start,p.cut.end);
    const remaining=detectPauses([],ranges,input,2,[p.cut]);
    assert.ok(remaining.every(p=>p.cut.end-p.cut.start<1e-7));
    assert.equal(remaining.length,0);
  });
  await test('Speech in right channel protects against false silence', () => {
    const l=new Float32Array(sr),r=tone(1,[[0,1]]);
    assert.equal(detectPauses([],[{start:0,end:1}],{channel:l,channels:[l,r],sampleRate:sr},1).length,0);
  });
  await test('Anti-phase stereo does not cancel the detector', () => {
    const l=tone(1,[[0,1]]),r=Float32Array.from(l,x=>-x);
    assert.equal(detectPauses([],[{start:0,end:1}],{channel:l,channels:[l,r],sampleRate:sr},1).length,0);
  });
  await test('Continuous noise / speech is never classified as a pause', () => {
    assert.equal(detectPauses([],[{start:0,end:1}],{channel:new Float32Array(sr).fill(.05),sampleRate:sr},1).length,0);
  });
  await test('Short pauses are individually removable with 20ms guards', () => {
    const ch=tone(1,[[0,.3],[.5,1]]);
    const ps=detectPauses([],[{start:0,end:1}],{channel:ch,sampleRate:sr},1);
    assert.equal(ps.length,1);assert.ok(Math.abs(ps[0].cut.end-ps[0].cut.start-.18)<1e-8);
    const manual=singlePauseCut(ps[0]);assert.ok(manual.end-manual.start>.16);assert.ok(manual.start>=.3);assert.ok(manual.end<=.5);
  });
  await test('Deleting a neighbouring word does not hide the remaining long pause', () => {
    const ch=tone(2,[[0,.4],[1.3,2]]);
    const ps=detectPauses([],[{start:0,end:1.28},{start:1.6,end:2}],{channel:ch,sampleRate:sr},2);
    assert.equal(ps.length,1);assert.ok(ps[0].duration>.85);
  });
  await test('Sentence guards remain audible but are not new pause labels', () => {
    const ch=tone(2,[[0,.4],[1.3,2]]), input={channel:ch,sampleRate:sr};
    const w=[{...word('甲',0,.4),breakAfter:true}];
    const p=detectPauses(w,[{start:0,end:2}],input,2)[0];
    assert.ok(Math.abs(p.duration-(p.cut.end-p.cut.start)-.02)<1e-8);
    const ranges=removeRange([{start:0,end:2}],p.cut.start,p.cut.end);
    assert.equal(detectPauses(w,ranges,input,2,[p.cut]).length,0);
  });
  await test('Han characters are individually editable; interpolated times flagged', () => {
    const ws=characterWords([word('a',0,1,'你好。')]);
    assert.deepEqual(ws.map(w=>w.text),['你','好','。']);assert.ok(ws[0].estimated);
    assert.equal(ws[2].start,ws[2].end);assert.equal(ws[1].end,1);
  });
  const buffer=(channels)=>({numberOfChannels:channels.length,sampleRate:sr,duration:channels[0].length/sr,length:channels[0].length,getChannelData:c=>channels[c]});
  await test('Edited WAV and mixed WAV have identical duration and splice ramps',async()=>{
    const b=buffer([new Float32Array(sr).fill(.2)]);
    const clips=[{id:'c',buffer:b,ranges:[{start:0,end:.3},{start:.6,end:1}]}];
    const x=new DataView(await (await exportEditedWav(clips)).arrayBuffer());
    const y=new DataView(await (await exportMixedWav(clips,[])).arrayBuffer());
    assert.equal(x.byteLength,y.byteLength);assert.equal(x.byteLength,44+sr*.7*3);
    for (const i of [0,1,4799,4800,4801,5000]) assert.ok(Math.abs(pcm16(x,i)-pcm16(y,i))<=2);
    assert.equal(pcm16(x,4799),0);assert.equal(pcm16(x,4800),0);
    assert.ok(pcm16(x,5000)>5000);
  });
  await test('Untouched whole-file export preserves original samples',async()=>{
    const b=buffer([new Float32Array(sr).fill(.2)]);
    const view=new DataView(await(await exportEditedWav([{buffer:b,ranges:[{start:0,end:1}]}])).arrayBuffer());
    assert.equal(pcm16(view,0),pcm16(view,view.getUint32(40,true)/3-1));
  });
  await test('Playback baked edges preserve sample count and fade',()=>{
    const ctx={createBuffer:(n,len)=>buffer(Array.from({length:n},()=>new Float32Array(len)))};
    const out=bakeFadedBufferSlice(ctx,buffer([new Float32Array(sr).fill(.2)]),.2,.2,.004,.004,.2,0);
    assert.equal(out.length,3200);assert.equal(out.getChannelData(0)[0],0);
    assert.ok(out.getChannelData(0)[3199]<.004);assert.ok(out.getChannelData(0)[100]>.19);
  });
  console.log(`\n${passed} production-code precision checks passed`);
} finally { await rm(temp,{recursive:true,force:true}); }
