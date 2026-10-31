import {pcm16} from './wav-test-utils.mjs';
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const temp=await mkdtemp(join(tmpdir(),'podcast-regressions-'));
let count=0;
try {
 const mods={};
 for(const file of ['audio/mixSchedule','audio/exportAudio','edit/deleteRuns','edit/pauses','edit/wordBoundary','edit/draftStore','edit/pauseEditing','edit/forcedAlignment']) {
  const out=join(temp,file.replace('/','-')+'.mjs');
  await build({entryPoints:[resolve('src',file+'.ts')],outfile:out,bundle:true,plugins:[{name:'browser-worker-url',setup(b){b.onResolve({filter:/speechProcessor\?worker&url$/},()=>({path:'worker-url',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export default "browser-only-worklet"',loader:'js'}));}}],platform:'node',format:'esm',logLevel:'silent'});
  Object.assign(mods,await import(pathToFileURL(out)));
 }
 const test=async(name,fn)=>{await fn();count++;console.log('✓',name)};
 const {buildMixSchedule,exportMixedWav,deleteWordRuns,groupPauseMarks,updateWordBoundary,musicAnchorSide}=mods;
 const w=(id,start,end,deleted=false)=>({id,text:id,start,end,deleted});
 const buffer=(duration,fn=()=>.1)=>({duration,sampleRate:1000,length:Math.round(duration*1000),numberOfChannels:1,getChannelData:()=>Float32Array.from({length:Math.round(duration*1000)},(_,i)=>fn(i/1000))});
 const clip=()=>({id:'c',buffer:buffer(5),words:[w('甲',.1,.5),w('乙',1,1.5),w('丙',2,2.4),w('丁',3,3.5)],ranges:[{start:0,end:5}],duration:5,audioOrder:[{start:0,end:5}]});
 const m=()=>({id:'m',kind:'stinger',buffer:buffer(.5,()=>0),clipId:'c',wordId:'乙',originalTime:1,anchorSide:'before',gainDb:0,fadeInSec:0,fadeOutSec:0});
 await test('Stinger follows current word onset, leaving no onset before music',async()=>{
  const c=clip(), music=m(); c.words[1].start=.8;
  const mix=buildMixSchedule([c],[music]);
  assert.equal(mix.sources.find(s=>s.role==='stinger').whenEdit,.8);
  const before=mix.sources.filter(s=>s.role==='speech'&&s.whenEdit<.8);
  assert.ok(before.every(s=>s.offset+s.duration<=.8+1e-8));
  c.buffer=buffer(5,t=>t>=.8&&t<1.5?.3:0);
  const view=new DataView(await (await exportMixedWav([c],[music])).arrayBuffer());
  for(let i=0;i<1300;i++) assert.equal(pcm16(view,i),0);
  assert.ok(pcm16(view,1350)>9000);
 });
 await test('After-word anchors follow new end and legacy sides migrate',()=>{
  const c=clip(),music={...m(),originalTime:1.5,anchorSide:undefined};
  music.anchorSide=musicAnchorSide(music,c.words);assert.equal(music.anchorSide,'after');
  c.words[1].end=1.7;
  assert.equal(buildMixSchedule([c],[music]).sources.find(s=>s.role==='stinger').whenEdit,1.7);
 });
 await test('Copied word anchor maps to editorial order, not physical buffer order',()=>{
  const c=clip();c.words.push(w('copy',4,4.5));c.ranges=[{start:4,end:5},{start:0,end:4}];
  const mix=buildMixSchedule([c],[{...m(),wordId:'copy',originalTime:4.3}]);
  assert.equal(mix.sources[0].role,'stinger');
 });
 await test('Clip gain changes only that clip, not other clips or music',async()=>{
  const a=clip(),b={...clip(),id:'b',gainDb:-6};
  const mix=buildMixSchedule([a,b],[m()]);
  assert.equal(mix.sources.find(s=>s.role==='stinger').gainLinear,1);
  assert.equal(mix.sources.filter(s=>s.role==='speech').at(-1).gainLinear,10**(-6/20));
  assert.equal(mix.hasClipGain,true);
  const data=new DataView(await(await exportMixedWav([a,b],[])).arrayBuffer());
  const ratio=pcm16(data,6000)/pcm16(data,2000);
  assert.ok(Math.abs(ratio-10**(-6/20))<.002);
 });
 await test('Normal word deletion stays inside selected boundaries, preserving unselected edges',()=>{
  const c=clip();deleteWordRuns(c,new Set(['乙']));deleteWordRuns(c,new Set(['丙']));
  assert.deepEqual(c.ranges,[{start:0,end:1},{start:2.4,end:5}]);
  const x=c.words[1].removedAudio,y=c.words[2].removedAudio;
  assert.ok(x.every(a=>y.every(b=>a.end<=b.start||b.end<=a.start)));
 });
 await test('Existing Corpse example can remove all orphaned tail fragments',()=>{
  const c=clip();c.words=[w('呢',32.27,32.47),w('是删',32.47,32.83,true),w('Carpercy',33.31,33.87,true),w('是',35.31,35.67),w('Corpse',35.83,36.27)];
  c.duration=37;c.audioOrder=[{start:0,end:37}];
  c.ranges=[{start:0,end:32.47},{start:32.83,end:32.9},{start:33.19,end:33.31},{start:33.881,end:34.067},{start:34.232,end:34.598},{start:35.104,end:35.159},{start:35.335,end:37}];
  assert.ok(deleteWordRuns(c,new Set(['Carpercy']),true)>.7);
  assert.deepEqual(c.ranges,[{start:0,end:32.47},{start:35.335,end:37}]);
 });
 await test('Deleting a whole phrase removes interior breath/quiet islands but preserves outside pauses',()=>{
  const c=clip();c.words=[w('前',0,.5),w('删一',1,1.3),w('删二',1.8,2.2),w('后',3,3.5)];
  c.buffer=buffer(5,t=>t>=1.3&&t<1.8?.0001:.1);
  deleteWordRuns(c,new Set(['删一','删二']));
  assert.deepEqual(c.ranges,[{start:0,end:1},{start:2.2,end:5}]);
  assert.ok(c.words[1].removedAudio.some(r=>r.end>1.3));assert.ok(c.words[2].removedAudio.some(r=>r.start<1.8));
  const updated=mods.applyForcedAlignment(c,[{id:'删一',start:1.05,end:1.25},{id:'删二',start:1.85,end:2.15}]);
  assert.ok(updated.ranges.every(r=>r.end<=1.05||r.start>=2.15));
 });
 await test('First onset and last offset define one cut, regardless of all interior word boundaries',()=>{
  const run=(middle)=>{const c=clip();c.words=[w('前',0,.3),w('首',.5,.7),...middle,w('末',3,3.2),w('后',4,4.3)];deleteWordRuns(c,new Set(['首',...middle.map(w=>w.id),'末']));return c;};
  const a=run([w('中',1,1.2),w('。',1.2,1.2),w('间',2.5,2.7)]);
  const b=run([{...w('中',.8,.82),estimated:true,alignmentReview:true},w('。',1.4,1.4),{...w('间',2.9,2.92),manualBoundary:true}]);
  assert.deepEqual(a.ranges,[{start:0,end:.5},{start:3.2,end:5}]);
  assert.deepEqual(b.ranges,a.ranges,'interior alignment has no say in the core cut');
  const manual=clip();manual.words=[w('前',0,.3),w('首',.5,.7),w('末',3,3.2),w('后',4,4.3)];
  manual.manualPauses=[{id:'inside',start:1,end:2,sourceStart:1,sourceEnd:2}];deleteWordRuns(manual,new Set(['首','末']));
  assert.deepEqual(manual.ranges,a.ranges,'a pause inside the selected utterance is cut with it');
 });
 await test('Export of a selected sentence equals one whole interval cut, including its interior breath',async()=>{
  const c=clip();c.words=[w('前',0,.3),w('首',.5,.7),w('中',1.5,1.7),w('末',3,3.2),w('后',4,4.3)];
  c.buffer=buffer(5,t=>t>=.8&&t<1.4?.25:t>=1.9&&t<2.8?.17:.1);
  const expected={...c,ranges:[{start:0,end:.5},{start:3.2,end:5}]};
  deleteWordRuns(c,new Set(['首','中','末']));
  const actual=new Uint8Array(await(await exportMixedWav([c],[])).arrayBuffer());
  const whole=new Uint8Array(await(await exportMixedWav([expected],[])).arrayBuffer());
  assert.deepEqual(actual,whole,'audio between character boundaries must not survive in export');
 });
 await test('Separate selections remain separate and protect the unselected middle word',()=>{
  const c=clip();deleteWordRuns(c,new Set(['甲','丙']));
  assert.ok(c.ranges.some(r=>r.start<=1&&r.end>=1.5));assert.equal(c.words[1].deleted,false);
 });
 await test('Legacy screenshot gaps of 0.58s and 0.38s are removed once without touching the following 到',()=>{
  const c=clip();c.duration=980;c.audioOrder=[{start:0,end:980}];
  c.words=[w('前',965.42,965.84),w('到删',967.68,968.66,true),w('我删',969.24,969.5,true),w('我们接触删',969.88,971,true),w('到留',971.52,971.64)];
  c.ranges=[{start:0,end:967.68},{start:968.66,end:969.24},{start:969.5,end:969.88},{start:971,end:980}];
  assert.ok(Math.abs(mods.repairLegacyDeletedAudio(c)-.96)<1e-7);
  assert.deepEqual(c.ranges,[{start:0,end:967.68},{start:971,end:980}]);
  assert.equal(mods.repairLegacyDeletedAudio(c),0);assert.equal(c.words.at(-1).deleted,false);
 });
 await test('Legacy repair preserves deliberate manual deleted boundaries and does not create a no-op undo',()=>{
  const c=clip();c.words[1].deleted=true;c.words[1].manualBoundary=true;
  const original=structuredClone(c.ranges);let snapshots=0;
  assert.equal(mods.repairLegacyDeletedAudio(c,()=>snapshots++),0);
  assert.deepEqual(c.ranges,original);assert.equal(snapshots,0);
 });
 await test('Manual outer boundaries remain exact during ordinary deletion',()=>{
  const c=clip();c.words[1].manualBoundary=true;deleteWordRuns(c,new Set(['乙']));
  assert.deepEqual(c.ranges,[{start:0,end:1},{start:1.5,end:5}]);
 });
 await test('Delete does not cross a pasted source seam or remove punctuation sound',()=>{
  const c=clip();c.audioOrder=[{start:4,end:5},{start:0,end:4}];c.words.push(w('copy',4,4.5));
  deleteWordRuns(c,new Set(['copy']));assert.ok(c.ranges.some(r=>r.start===0&&r.end===4));
  c.words.push(w('。',2.4,2.4));const before=JSON.stringify(c.ranges);deleteWordRuns(c,new Set(['。']));assert.equal(JSON.stringify(c.ranges),before);
 });
 await test('Repair, adjust deleted boundary, and restore ownership stay independent',()=>{
  const c=clip();deleteWordRuns(c,new Set(['乙','丙']));
  const other=structuredClone(c.words[2].removedAudio);
  updateWordBoundary(c,c.words[1],.7,1.6);
  assert.deepEqual(c.words[2].removedAudio,other);
  assert.ok(c.ranges.every(r=>other.every(x=>r.end<=x.start||r.start>=x.end)));
 });
 await test('Silence and inhalation form one pause, use combined duration and delete together',()=>{
  const candidate=(id,start,end,breath=false)=>({id,start,end,duration:end-start,cut:{start:start+.01,end:end-.01},breath});
  const parts=mods.mergePauseCandidates([candidate('quiet1',.5,.72),candidate('breath',.68,.92,true),candidate('quiet2',.9,1.1)]);
  assert.equal(parts.length,1);assert.ok(Math.abs(parts[0].duration-.6)<1e-7);
  assert.equal(mods.pauseExceedsThreshold(parts,.55),true);
  assert.equal(mods.pauseExceedsThreshold(parts,.6),false);
  assert.equal(mods.pauseExceedsThreshold([candidate('short-breath',.5,.7,true)],.55),false);
  const c=clip();c.words=[w('甲',.1,.5),w('乙',1.1,1.5)];
  const groups=groupPauseMarks(c.words,parts,c.audioOrder);assert.equal(groups.length,1);
  mods.deletePauseParts(c,groups[0].parts,'whole-pause');
  assert.ok(c.ranges.every(r=>r.end<=.51+1e-7||r.start>=1.09-1e-7),'breath core and silence cut together');
  assert.ok(c.ranges.some(r=>r.start<=.1&&r.end>=.5));
  assert.ok(c.ranges.some(r=>r.start<=1.1&&r.end>=1.5));
 });
 await test('Leading adjacent kept/deleted pauses form one group with separate owned intervals',()=>{
  const ps=[{id:'a',start:0,end:.2},{id:'b',start:.3,end:.5,cleared:true},{id:'c',start:.6,end:.9}];
  const groups=groupPauseMarks([w('甲',1,1.5)],ps,[{start:0,end:2}]);
  assert.equal(groups.length,1);assert.equal(groups[0].parts.length,3);assert.equal(groups[0].beforeId,'甲');
  assert.deepEqual(groups[0].parts,ps);
 });
 await test('Pause groups split at spoken words and respect pasted segment order',()=>{
  const ps=[{id:'a',start:0,end:.2},{id:'b',start:2,end:2.2},{id:'c',start:4,end:4.2}];
  const groups=groupPauseMarks([w('甲',1,1.5),w('贴',4.3,4.6)],ps,[{start:4,end:5},{start:0,end:4}]);
  assert.equal(groups.length,3);assert.equal(groups[0].beforeId,'贴');
 });
 await test('Deleting later words cannot enlarge or re-anchor the earlier pause',()=>{
  const words=[w('甲',0,.5),{...w('。',1,1),text:'。'},w('删',1.5,1.7),w('乙',2.5,3)];
  const parts=[{id:'a',start:.5,end:1.5},{id:'b',start:1.7,end:2.5}];
  const before=groupPauseMarks(words,parts,[{start:0,end:3}]);
  words[2].deleted=true;
  const after=groupPauseMarks(words,parts,[{start:0,end:3}]);
  assert.deepEqual(after,before);
  assert.equal(after.length,2);assert.equal(after[0].anchorId,'甲');assert.equal(after[1].anchorId,'删');
  assert.equal(mods.pauseGroupDisplay(after[0]).duration,1);
 });
 await test('Manual pause bounds remain exact when grouped beside deleted fragments',()=>{
  const parts=[{id:'manual-0',start:.5,end:.8},{id:'cut',start:1,end:2,cleared:true}];
  const groups=groupPauseMarks([w('甲',0,.5),w('乙',2,2.5)],parts,[{start:0,end:3}]);
  assert.equal(groups.length,1);assert.equal(groups[0].parts[0].end,.8);
  assert.equal(groups[0].parts.filter(p=>!p.cleared).length,1);
 });
 await test('Touching retained/deleted pause pieces within a coarse ASR token form one pause',()=>{
  const parts=[{id:'head',start:1,end:1.12},{id:'cut',start:1.12,end:1.43,cleared:true},{id:'tail',start:1.43,end:1.55}];
  const groups=groupPauseMarks([w('AI',.8,1.6)],parts,[{start:0,end:2}]);
  assert.equal(groups.length,1);assert.equal(groups[0].parts.length,3);
  assert.ok(Math.abs(groups[0].parts.filter(p=>!p.cleared).reduce((s,p)=>s+p.end-p.start,0)-.24)<1e-8);
  const split=groupPauseMarks([w('AI',.8,1.6)],[parts[0],parts[2]],[{start:0,end:2}]);
  assert.equal(split.length,1);assert.deepEqual(split[0].parts,[parts[0],parts[2]]); // Display together, never cut the voiced bridge.
 });
 await test('Clicking a merged pause keeps outer guards and never cuts the voiced gap',()=>{
  const c=clip();c.words=[w('字',.8,1.8)];
  const cuts=mods.deletePauseParts(c,[{start:1,end:1.2},{start:1.5,end:1.7}],'p');
  assert.ok(Math.abs(cuts[0].start-1.01)<1e-8);assert.ok(Math.abs(cuts[1].end-1.69)<1e-8);
  assert.ok(c.ranges.some(r=>r.start<=1.2&&r.end>=1.5));
 });
 await test('Bulk threshold applies to the combined pause and is stable on repeat',()=>{
  const pieces=[{start:1,end:1.12},{start:1.5,end:2.43}];
  const groups=groupPauseMarks([w('AI',.8,2.5)],pieces.map((p,i)=>({...p,id:`p${i}`})),[{start:0,end:3}]);
  assert.equal(groups.length,1);
  const cuts=mods.shortenPauseRanges(groups[0].parts,.3);
  const removed=cuts.reduce((s,p)=>s+p.end-p.start,0);
  assert.ok(Math.abs(1.05-removed-.02)<1e-8);
  assert.equal(mods.shortenPauseRanges([{start:1,end:1.12},{start:2.31,end:2.43}],.3).length,0);
 });

 await test('One mixed pause has one action; a single deletion becomes restore and guards stay hidden',()=>{
  const c=clip();c.words=[w('甲',0,.5),w('乙',2,2.5)];
  c.clearedPauses=[{id:'old',start:.74,end:1.5}];c.ranges=[{start:0,end:.74},{start:1.5,end:5}];
  const group={id:'p',anchorId:'甲',parts:[{id:'kept',start:.5,end:.74},{id:'old',start:.74,end:1.5,cleared:true}]};
  assert.deepEqual(mods.pauseGroupDisplay(group),{cleared:false,duration:.24});
  const cuts=mods.deletePauseParts(c,[group.parts[0]],'new');
  group.parts=[{id:'head',start:.5,end:.53},{id:'tail',start:.71,end:.74},...c.clearedPauses.map(p=>({...p,cleared:true}))];
  const display=mods.pauseGroupDisplay(group);
  assert.equal(display.cleared,true);assert.ok(display.duration>.9);
  assert.equal(mods.pauseGroupDisplay({parts:[{start:0,end:.09}]}),null);
  assert.equal(mods.pauseGroupDisplay({parts:[{start:0,end:.03},{start:.5,end:.53}]}),null);
  assert.equal(mods.pauseGroupDisplay({parts:[{start:0,end:.1}]}).cleared,false);
  assert.equal(cuts.length,1);
 });
 await test('Deleting a word keeps acoustic pauses beside it and removes the actual voice',()=>{
  const c=clip();c.buffer=buffer(5,t=>(t>=.55&&t<.95)||(t>=1.55&&t<1.95)?0:.1);
  deleteWordRuns(c,new Set(['乙']));
  assert.ok(c.ranges.some(r=>r.start<=.55&&r.end>=.95));
  assert.ok(c.ranges.some(r=>r.start<=1.55&&r.end>=1.95));
  assert.ok(c.ranges.every(r=>r.end<=1 || r.start>=1.5));
  assert.ok(c.words[1].removedAudio.every(r=>r.end<=.55||r.start>=.95));
  const aligned=mods.applyForcedAlignment(c,[{id:'乙',start:1.05,end:1.45}]);
  assert.ok(aligned.ranges.some(r=>r.start<=.55&&r.end>=.95));
  assert.ok(aligned.ranges.some(r=>r.start<=1.55&&r.end>=1.95));
 });
 await test('Deleting a word preserves a manually selected pause even without acoustic detection',()=>{
  const c=clip();c.manualPauses=[{id:'p',start:.6,end:.9,sourceStart:.6,sourceEnd:.9}];
  deleteWordRuns(c,new Set(['乙']));
  assert.ok(c.ranges.some(r=>r.start<=.6&&r.end>=.9));
 });
 await test('One ordinary delete removes late ASR onsets and multi-lobe tails while preserving outer silence',()=>{
  const c=clip();c.words=[w('前',.1,.3),w('删',.7,.9),w('后',1.4,1.7)];
  c.buffer=buffer(5,t=>t>=.62&&t<1.05||t>=1.09&&t<1.11?.2:0);
  deleteWordRuns(c,new Set(['删']));
  for(const t of [.63,.69,.9,1.02,1.10])assert.ok(!c.ranges.some(r=>t>=r.start&&t<r.end),'orphan phoneme at '+t);
  assert.ok(c.ranges.some(r=>r.start<=.35&&r.end>=.6),'independent pause remains');
  assert.ok(c.ranges.some(r=>r.start<=1.2&&r.end>=1.4),'following pause remains');
  const snapshot=JSON.stringify(c.ranges);assert.equal(deleteWordRuns(c,new Set(['删'])),0);assert.equal(JSON.stringify(c.ranges),snapshot);
 });
 await test('Fragmented pause removal cannot leave orphan islands around a newly deleted phrase',()=>{
  const c=clip();c.words=[w('前',.1,.3),w('删',1,1.2),w('后',2,2.2)];
  c.clearedPauses=[{id:'a',start:.4,end:.65},{id:'b',start:.72,end:.9},{id:'c',start:1.35,end:1.7}];
  c.ranges=[{start:0,end:.4},{start:.65,end:.72},{start:.9,end:1.35},{start:1.7,end:5}];
  const before=structuredClone(c.ranges);deleteWordRuns(c,new Set(['删']));
  assert.ok(c.ranges.every(r=>r.end<=.65||r.start>=1.35));
  assert.ok(c.words[1].removedAudio.some(r=>r.start===.65&&r.end===.72));
  mods.restoreWordRuns(c,new Set(['删']));assert.deepEqual(c.ranges,before,'all and only owned audio returns');
 });
 await test('Manual deleted boundaries and explicit outside pauses defeat automatic edge enlargement',()=>{
  const c=clip();c.words=[w('前',.1,.3),{...w('删',.7,.9),manualBoundary:true},w('后',1.4,1.7)];
  c.buffer=buffer(5,t=>t>=.62&&t<1.1?.2:0);deleteWordRuns(c,new Set(['删']));
  assert.deepEqual(c.ranges,[{start:0,end:.7},{start:.9,end:5}]);
  const b=clip();b.words=[w('前',.1,.3),w('删',.7,.9),w('后',1.4,1.7)];b.buffer=c.buffer;b.manualPauses=[{id:'p',start:.6,end:.7,sourceStart:.6,sourceEnd:.7}];
  deleteWordRuns(b,new Set(['删']));assert.ok(b.ranges.some(r=>r.start<=.6&&r.end>=.7));
 });
 await test('Right-channel speech and opposite-phase audio receive the same complete deletion',()=>{
  const signal=buffer(5,t=>t>=.62&&t<1.1?.2:0).getChannelData(0);
  for(const left of [new Float32Array(signal.length),Float32Array.from(signal,x=>-x)]){
   const c=clip();c.words=[w('前',.1,.3),w('删',.7,.9),w('后',1.4,1.7)];
   c.buffer={...buffer(5),numberOfChannels:2,getChannelData:i=>i===0?left:signal};deleteWordRuns(c,new Set(['删']));
   assert.ok(c.ranges.every(r=>r.end<=.62+1e-7||r.start>=1.1-1e-7));
  }
 });
 await test('Weak English tails/onsets and retained-word coverage are fenced off from deletion',()=>{
  const c=clip();c.words=[{...w('Siri',.1,.5),alignmentSource:'qwen3'},w('删',.8,1),{...w('Claude',1.2,1.5),alignmentSource:'qwen3'}];
  c.buffer=buffer(5,t=>t>=.5&&t<.55||t>=.7&&t<1.15?.2:0);deleteWordRuns(c,new Set(['删']));
  assert.ok(c.ranges.some(r=>r.start<=.5&&r.end>=.55));assert.ok(c.ranges.some(r=>r.start<=1.14&&r.end>=1.5));
  const overlap=clip();overlap.words=[w('留',.1,.8),w('删',.7,.9),w('留后',.85,1.2)];deleteWordRuns(overlap,new Set(['删']));
  assert.ok(overlap.ranges.some(r=>r.start<=.1&&r.end>=.8));assert.ok(overlap.ranges.some(r=>r.start<=.85&&r.end>=1.2));
 });
 await test('Recalibration and JSON reload cannot resurrect verified deletion edges; restore remains independent',()=>{
  const c=clip();c.words=[w('前',.1,.3),w('删一',.7,.9),w('删二',1.3,1.5),w('后',2,2.3)];
  c.buffer=buffer(5,t=>t>=.62&&t<.98||t>=1.25&&t<1.6?.2:0);deleteWordRuns(c,new Set(['删一','删二']));
  const owned=structuredClone(c.words[1].removedAudio),before=structuredClone(c.ranges);
  Object.assign(c,mods.applyForcedAlignment(c,[{id:'删一',start:.72,end:.88},{id:'删二',start:1.32,end:1.48}]));
  for(const cut of owned)assert.ok(c.ranges.every(r=>r.end<=cut.start+1e-7||r.start>=cut.end-1e-7));
  const reloaded=JSON.parse(JSON.stringify({words:c.words,ranges:c.ranges,duration:c.duration,audioOrder:c.audioOrder,clearedPauses:c.clearedPauses}));
  const other=structuredClone(reloaded.words[2].removedAudio);mods.restoreWordRuns(reloaded,new Set(['删一']));
  for(const cut of other)assert.ok(reloaded.ranges.every(r=>r.end<=cut.start+1e-7||r.start>=cut.end-1e-7));
  assert.equal(reloaded.words[1].deleted,false);assert.equal(reloaded.words[2].deleted,true);
  assert.ok(before.length);
 });
 await test('Opening an old draft repairs edge residues once, with undo, while respecting manual cuts',()=>{
  const c=clip();c.words=[w('前',.1,.3),{...w('删',.7,.9),deleted:true,continuousCut:true,removedAudio:[{start:.7,end:.9}]},w('后',1.4,1.7)];
  c.ranges=[{start:0,end:.7},{start:.9,end:5}];c.buffer=buffer(5,t=>t>=.62&&t<1.1?.2:0);let snapshots=0;
  assert.ok(mods.repairDeletedEdges(c,()=>snapshots++)>.2);assert.equal(snapshots,1);
  assert.equal(mods.repairDeletedEdges(c,()=>snapshots++),0);assert.equal(snapshots,1);
  const manual=clip();manual.words[1].deleted=true;manual.words[1].manualBoundary=true;const before=JSON.stringify(manual);
  assert.equal(mods.repairDeletedEdges(manual,()=>snapshots++),0);assert.equal(JSON.stringify(manual),before);
 });
 await test('100ms visibility threshold and acoustic guards survive deletion and draft JSON reload',()=>{
  const c=clip();c.words=[];const input={channel:new Float32Array(5000),sampleRate:1000};
  const detected=mods.detectPauses([],c.ranges,input,5);
  mods.deletePauseParts(c,detected,'cut');
  const restored=JSON.parse(JSON.stringify({ranges:c.ranges,clearedPauses:c.clearedPauses}));
  const kept=mods.detectPauses([],restored.ranges,input,5);
  assert.equal(kept.length,0);
  const gs=groupPauseMarks([],restored.clearedPauses.map(p=>({...p,cleared:true})),[{start:0,end:5}]);
  assert.equal(gs.length,1);assert.equal(mods.pauseGroupDisplay(gs[0]).cleared,true);
  assert.ok(Math.abs(restored.ranges.reduce((s,p)=>s+p.end-p.start,0)-.02)<1e-8);
 });
 class BufferAudio {constructor({length,numberOfChannels,sampleRate}){this.length=length;this.numberOfChannels=numberOfChannels;this.sampleRate=sampleRate;this.duration=length/sampleRate;this.channels=Array.from({length:numberOfChannels},()=>new Float32Array(length));}getChannelData(i){return this.channels[i];}copyToChannel(a,i){this.channels[i].set(a);}}
 globalThis.AudioBuffer=BufferAudio;
 await test('Disk draft serialization and restore retain clip gain, music edge, and cut ownership',async()=>{
  const buf=new BufferAudio({length:5000,numberOfChannels:1,sampleRate:1000});
  const c={...clip(),buffer:buf,cleanBuffer:buf,bufferDirty:true,gainDb:-6,denoised:false,beautified:false};
  c.legacyDeletionRepairVersion=1;
  c.words[0].duplicateReason='相邻短句重录';
  c.manualPauses=[{id:'manual',start:.6,end:.8,sourceStart:.5,sourceEnd:1}];
  deleteWordRuns(c,new Set(['乙']));
  const payload=mods.slimDraftForQuota(mods.projectToDraft({project:{clips:[c],music:[{...m(),buffer:buf,anchorSide:'after'}],gainDb:0,audioName:'test'},activeClipId:'c',clipIdSeq:1,musicIdSeq:1}));
  const result=await mods.draftToProject(payload,{decode:async()=>{throw Error('unexpected')},loadSfxBlob:async()=>null,applyFx:async b=>b});
  assert.equal(result.project.clips[0].gainDb,-6);
  assert.equal(result.project.clips[0].words[0].duplicateReason,'相邻短句重录');
  assert.equal(result.project.clips[0].legacyDeletionRepairVersion,1);
  assert.deepEqual(result.project.clips[0].manualPauses,c.manualPauses);
  assert.equal(result.project.music[0].anchorSide,'after');
  assert.deepEqual(result.project.clips[0].words[1].removedAudio,c.words[1].removedAudio);
 });
 await test('0.30s threshold deletes a 0.31s pause leaving only 20ms guards',()=>{
  const cuts=mods.shortenPauseRanges([{start:1,end:1.31}],.3);
  assert.ok(cuts.length); assert.ok(Math.abs(cuts[0].end-cuts[0].start-.29)<1e-8);
 });
 await test('Adjacent fragments use their combined length for threshold and retain one breath',()=>{
  const cuts=mods.shortenPauseRanges([{start:0,end:.15},{start:.2,end:.35},{start:.4,end:.55}],.3);
  assert.ok(Math.abs(cuts.reduce((s,r)=>s+r.end-r.start,0)-.43)<1e-8);
  assert.deepEqual(mods.shortenPauseRanges([{start:0,end:.3}],.3),[]);
 });
 await test('Adjusting deleted pause never resurrects another cut or deleted word',()=>{
  const c=clip();c.words[1].deleted=true;c.words[1].removedAudio=[{start:1,end:1.5}];
  c.clearedPauses=[{id:'p',start:.6,end:.9},{id:'q',start:2.6,end:2.8}];
  c.ranges=[{start:0,end:.6},{start:.9,end:1},{start:1.5,end:2.6},{start:2.8,end:5}];
  mods.replacePauseCut(c,new Set(['p']),{start:.7,end:1.2},'new');
  assert.ok(c.ranges.every(r=>r.end<=.7||r.start>=1.5));
  assert.ok(c.ranges.every(r=>r.end<=2.6||r.start>=2.8));
 });
 await test('Automatic alignment cannot reopen a repaired deleted-word run',()=>{
  const c=clip();deleteWordRuns(c,new Set(['乙','丙']),true);
  const result=mods.applyForcedAlignment(c,[{id:'乙',start:1.1,end:1.4},{id:'丙',start:2.1,end:2.3}]);
  assert.ok(result.ranges.every(r=>r.end<=.5||r.start>=3));
 });
 await test('Moving 哈 earlier restores its pause-cut audio without swallowing 喽',async()=>{
  const c=clip();c.words=[w('哈',2,2.3),w('喽',2.3,2.6)];
  c.clearedPauses=[{id:'leading',start:0,end:2.1}];c.ranges=[{start:2.1,end:5}];
  c.buffer=buffer(5,t=>t>=1.8&&t<2.6?.3:0);
  updateWordBoundary(c,c.words[0],1.8,2.3);
  assert.deepEqual(c.clearedPauses,[{id:'leading',start:0,end:1.8}]);
  assert.deepEqual(c.ranges,[{start:1.8,end:5}]);
  assert.equal(c.words[1].start,2.3);assert.equal(c.words[1].end,2.6);
  const data=new DataView(await(await exportMixedWav([c],[])).arrayBuffer());
  for(const sample of [100,300,600]) assert.ok(pcm16(data,sample)>9000);
 });
 await test('Retained boundary repair leaves independent deleted words excluded',()=>{
  const c=clip();c.words[1].deleted=true;c.words[1].removedAudio=[{start:1,end:1.5}];
  c.clearedPauses=[{id:'p',start:.5,end:2.2}];c.ranges=[{start:0,end:.5},{start:2.2,end:5}];
  updateWordBoundary(c,c.words[2],1.2,2.4);
  assert.ok(c.ranges.every(r=>r.end<=1 || r.start>=1.5));
  assert.ok(c.ranges.some(r=>r.start<=1.5 && r.end>=2.4));
 });
 await test('Shortening a deleted pause replaces its old cut and restores the released tail',()=>{
  const c=clip();c.words=[w('哈',2,2.3),w('喽',2.3,2.6)];
  c.clearedPauses=[{id:'p',start:0,end:2}];c.ranges=[{start:2,end:5}];
  mods.replacePauseCut(c,new Set(['p']),{start:0,end:1.5},'new');
  assert.deepEqual(c.clearedPauses,[{id:'new-0',start:0,end:1.5}]);
  assert.deepEqual(c.ranges,[{start:1.5,end:5}]);
  mods.replacePauseCut(c,new Set(['new-0']),{start:0,end:1.2},'next');
  assert.deepEqual(c.ranges,[{start:1.2,end:5}]);
  assert.equal(c.clearedPauses[0].end,1.2);
 });
 await test('A grouped pause cut cannot consume retained syllables in its bounding span',()=>{
  const c=clip();c.words=[w('哈',1.8,2.3),w('喽',2.3,2.6)];
  mods.replacePauseCut(c,new Set(),{start:0,end:2.8},'p');
  assert.deepEqual(c.ranges,[{start:1.8,end:2.6},{start:2.8,end:5}]);
  assert.deepEqual(c.clearedPauses,[{id:'p-0',start:0,end:1.8},{id:'p-1',start:2.6,end:2.8}]);
 });
 await test('Silence detection cannot relabel a manually retained weak syllable as a pause',()=>{
  const words=[{...w('哈',1,1.3),manualBoundary:true},{...w('喽',1.3,1.6),alignmentSource:'local'}];
  const pauses=mods.detectPauses(words,[{start:0,end:3}],{channel:new Float32Array(3000),sampleRate:1000},3);
  assert.ok(pauses.length);
  assert.ok(pauses.every(p=>p.end<=1 || p.start>=1.6));
 });
 await test('Legacy project boost cannot amplify transition or bed material',async()=>{
  const c=clip(),music={...m(),buffer:buffer(.5,()=>.1),gainDb:-3};
  for(const kind of ['stinger','bed']) {
    const mix=buildMixSchedule([c],[{...music,kind}],10**(13.5/20));
    const material=mix.sources.find(s=>s.role===kind);
    assert.ok(Math.abs(material.gainLinear-10**(-3/20))<1e-9);
  }
  const a=new DataView(await(await exportMixedWav([c],[music],1)).arrayBuffer());
  const b=new DataView(await(await exportMixedWav([c],[music],10**(13.5/20))).arrayBuffer());
  for(let i=1010;i<1490;i++) assert.equal(pcm16(a,i),pcm16(b,i));
 });
 await test('Legacy draft gain migrates once to clips while material gain stays independent',async()=>{
  const buf=new BufferAudio({length:5000,numberOfChannels:1,sampleRate:1000});
  const c={...clip(),buffer:buf,cleanBuffer:buf,bufferDirty:true,gainDb:2,denoised:false,beautified:false};
  const encode=project=>mods.slimDraftForQuota(mods.projectToDraft({project,activeClipId:'c',clipIdSeq:1,musicIdSeq:1}));
  const decode=d=>mods.draftToProject(d,{decode:async()=>{throw Error('unexpected')},loadSfxBlob:async()=>null,applyFx:async b=>b});
  const first=await decode(encode({clips:[c],music:[{...m(),buffer:buf,gainDb:-3}],gainDb:13.5,audioName:'test'}));
  assert.equal(first.project.gainDb,0);assert.equal(first.project.clips[0].gainDb,15.5);assert.equal(first.project.music[0].gainDb,-3);
  const second=await decode(encode(first.project));assert.equal(second.project.clips[0].gainDb,15.5);assert.equal(second.project.music[0].gainDb,-3);
 });
 console.log(`${count} edit regression checks passed`);
} finally {await rm(temp,{recursive:true,force:true});}
