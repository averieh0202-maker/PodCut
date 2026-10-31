import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
const tmp=await mkdtemp(join(tmpdir(),'podcut-agent-'));
try{
 const file=join(tmp,'agent.mjs');await build({stdin:{contents:"export * from './server/roughCutPlanner';export * from './server/roughCutJobs';export * from './server/diskDraftStore';export {referenceText} from './server/roughCutPlugin';",resolveDir:process.cwd()},outfile:file,bundle:true,format:'esm',platform:'node',logLevel:'silent'});
 const {validateDecisions,completeRestartStarts,planRoughCut,executePlan,RoughCutJobs,DiskDraftStore,referenceText}=await import(pathToFileURL(file));
 const words=[...'因为要不大家都去搞网页编程呢因为这可以取代很多工作今天还聊一个稿外观点'].map((text,i)=>({id:'w'+i,text,start:i*.2,end:i*.2+.15,deleted:false,alignmentSource:'qwen3'}));
 const clip={id:'c1',name:'case',words,duration:words.length*.2+1,ranges:[{start:0,end:words.length*.2+1}],audioOrder:[{start:0,end:words.length*.2+1}]};
 const cut={clipId:'c1',startWordId:'w0',endWordId:'w1',keepStartWordId:'w2',keepEndWordId:'w13',quote:'因为',keptQuote:words.slice(2,14).map(w=>w.text).join(''),kind:'false_start',reason:'放弃因果开头，保留后续完整提议'};
 assert.equal(validateDecisions({cuts:[cut]},[clip]).length,1);
 for(const bad of [{...cut,quote:'因为要'},{...cut,endWordId:'made-up'},{...cut,keepStartWordId:'w0'},{...cut,kind:'off_script'}])assert.equal(validateDecisions({cuts:[bad]},[clip]).length,0);
 assert.equal(validateDecisions({cuts:[cut]},[{...clip,words:words.map((w,i)=>i===0?{...w,manualBoundary:true}:w)}]).length,1);
 assert.equal(validateDecisions({cuts:[cut]},[{...clip,words:words.map((w,i)=>i===0?{...w,alignmentSource:undefined}:w)}]).length,0);
 let calls=0;const ask=async(system,data)=>{calls++;assert.ok(system.includes('参考稿'));return data.candidates?{approved:[0]}:{cuts:[cut]};};
 assert.equal((await planRoughCut([clip],'参考稿里没有稿外观点',ask)).length,1);assert.equal(calls,3);
 // A malformed model plan gets one repair attempt, then still needs review.
 let repaired=false,reviewedRepair=false;
 const repairedPlan=await planRoughCut([clip],'',async(system,data)=>{
   if(data.candidates){reviewedRepair=true;return {approved:[0]};}
   if(data.invalidPlans){repaired=true;return {cuts:[cut]};}
   if(data.existingCandidates)return {cuts:[]};
   return {cuts:[{...cut,startWordId:'missing'}]};
 });
 assert.equal(repairedPlan.length,1);assert.ok(repaired&&reviewedRepair);
 assert.equal((await planRoughCut([clip],'',async(_s,d)=>d.candidates?{approved:[0]}:{cuts:[{...cut,startWordId:'missing'}]})).length,0,'invalid repair never applies');
 const siriWords=['现在','Siri','Siri','是','很','早期','进入','AI','领域','的'].map((text,i)=>({...words[0],text,id:'s'+i,start:i,end:i+.8}));
 const siriClip={id:'s',words:siriWords};
 const siriCut={clipId:'s',startWordId:'s1',endWordId:'s2',keepStartWordId:'s3',keepEndWordId:'s9',quote:'SiriSiri',keptQuote:'是很早期进入AI领域的',kind:'false_start',reason:'保留后一次Siri'};
 assert.equal(validateDecisions({cuts:[siriCut]},[siriClip]).length,0,'never delete both English subjects');
 assert.equal(validateDecisions({cuts:[{...siriCut,endWordId:'s1',keepStartWordId:'s2',quote:'Siri',keptQuote:'Siri是很早期进入AI领域的'}]},[siriClip]).length,1);
 let structuralCalls=0;
 const structuralOnly=await planRoughCut([clip],'',async(system,data)=>{structuralCalls++;return data.candidates?{approved:[0]}:system.includes('专项检查未完成起句')?{cuts:[cut]}:{cuts:[]};});
 assert.equal(structuralOnly.length,1,'structural pass finds abandoned non-repeated phrasing missed by first pass');assert.equal(structuralCalls,3);
 const doubleWords=[{...words[0],id:'is1',text:'是'},...words.slice(0,2),{...words[3],id:'is2',text:'是'},...words.slice(2)];
 assert.equal(validateDecisions({cuts:[cut]},[{...clip,words:doubleWords}]).length,0,'reject a new duplicated character at the cut seam');
 assert.equal((await planRoughCut([clip],'',async(_s,d)=>d.candidates?{approved:[]}:{cuts:[cut]})).length,0);
 const restartText=[...'因为它主要是通它主要是通过邮件提供服务今天还讲稿外观点这个观点很有趣值得保留还要继续说明原理以及另外几个很有价值的案例'];
 const restartWords=restartText.map((text,i)=>({...words[0],id:'r'+i,text,start:i*.2,end:i*.2+.15}));
 const restartClip={id:'r',words:restartWords};
 const a=restartWords.findIndex(w=>w.text==='通'),b=a,k=b+1;
 const proposal={clipId:'r',startWordId:'r'+a,endWordId:'r'+b,keepStartWordId:'r'+k,keepEndWordId:'r'+(k+12),quote:restartText.slice(a,b+1).join(''),keptQuote:restartText.slice(k,k+13).join(''),kind:'false_start',reason:'放弃起句后重来'};
 const expanded=completeRestartStarts([proposal],[restartClip])[0];
 assert.equal(expanded.quote,'它主要是通');
 const planned=await planRoughCut([restartClip],'',async(_s,data)=>{if(!data.candidates)return {cuts:[proposal]};assert.equal(data.candidates[0].quote,expanded.quote);assert.ok(!data.candidates[0].afterCut.includes('它主要是它主要是'));return {approved:[0]};});
 assert.equal(planned[0].startWordId,'r2');
 const protectedStart=structuredClone(restartClip);protectedStart.words[a-1].breakAfter=true;
 assert.equal(completeRestartStarts([proposal],[protectedStart])[0].startWordId,proposal.startWordId,'never expand across a completed sentence');
 const untrustedStart=structuredClone(restartClip);delete untrustedStart.words[2].alignmentSource;
 assert.equal(validateDecisions({cuts:[expanded]},[untrustedStart]).length,0,'expanded cut still requires reliable word timing');
 const payload={version:2,clips:[clip],music:[{name:'music',gainDb:-15}],gainDb:0,savedAt:0};
 const result=executePlan(payload,[cut],[{clipId:'c1',parts:[{start:0,end:clip.duration}]}]);
 assert.equal(JSON.stringify(result.result.music),JSON.stringify(payload.music));
 assert.equal(result.result.clips[0].words[2].deleted,false);assert.equal(result.result.clips[0].words.at(-1).deleted,false);
 assert.equal(result.result.clips[0].words[0].deleted,true);
 assert.ok(result.result.clips[0].ranges.every(r=>r.start>=.35-1e-7));
 const store=new DiskDraftStore(join(tmp,'drafts'));let base=await store.save(payload,[],null);
 const service=new RoughCutJobs(store,{},()=>ask);
 const start={id:'test-rough-cut-001',revision:base.revision,reference:'保留录音的稿外内容',pauses:[],threshold:.45,breaths:true};
 let job=await service.start(start);assert.equal(job.status,'running');
 async function wait(id){for(let i=0;i<100;i++){const j=await service.get(id);if(j.status!=='running')return j;await new Promise(r=>setTimeout(r,10));}throw Error('job timed out');}
 job=await wait(start.id);assert.equal(job.status,'ready');assert.equal((await store.read()).snapshot.revision,base.revision,'background planning never overwrites live draft');
 assert.equal((await new RoughCutJobs(store,{}).get(job.id)).status,'ready','result survives page/service restart');
 await service.apply(job.id,base.revision);const applied=(await store.read()).snapshot;assert.equal(applied.payload.clips[0].words[0].deleted,true);
 assert.equal((await service.apply(job.id,applied.revision)).status,'applied','apply is idempotent');
 await service.undo(job.id,applied.revision);base=(await store.read()).snapshot;assert.equal(base.payload.clips[0].words[0].deleted,false);
 await service.start({...start,id:'test-rough-cut-002',revision:base.revision});job=await wait('test-rough-cut-002');
 const changed=structuredClone(base.payload);changed.clips[0].words[5].end+=.01;
 const newer=await store.save(changed,[],base.revision);
 await assert.rejects(service.apply(job.id,newer.revision),/新修改/);
 assert.equal((await store.read()).snapshot.revision,newer.revision);
 const failed=new RoughCutJobs(store,{},()=>async()=>{throw Error('mock API failure');});
 await failed.start({...start,id:'test-rough-cut-003',revision:newer.revision});
 for(let i=0;i<100&&(await failed.get('test-rough-cut-003')).status==='running';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal((await failed.get('test-rough-cut-003')).status,'error');assert.equal((await store.read()).snapshot.revision,newer.revision);
 assert.equal(await referenceText(Buffer.from('1\n00:00:01,000 --> 00:00:02,000\n稿外观点\n'),'test.srt'),'稿外观点');
 await assert.rejects(referenceText(Buffer.from('x'),'test.exe'));
 const docx=(xml)=>{const result=spawnSync('python3',['-c',`import io,sys,zipfile
b=io.BytesIO()
with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z: z.writestr('word/document.xml',sys.stdin.buffer.read())
sys.stdout.buffer.write(b.getvalue())`],{input:xml});assert.equal(result.status,0);return result.stdout;};
 const wordXml=(body)=>`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
 assert.equal(await referenceText(docx(wordXml('<w:p><w:r><w:t>第一段逐字稿</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格中的中文</w:t></w:r></w:p></w:tc></w:tr></w:tbl>')),'中文参考逐字稿.DOCX'),'第一段逐字稿\n表格中的中文');
 const longChinese='多字节中文参考逐字稿'.repeat(3500);assert.equal(await referenceText(docx(wordXml('<w:p><w:r><w:t>'+longChinese+'</w:t></w:r></w:p>')),'长中文.docx'),longChinese);
 await assert.rejects(referenceText(docx(wordXml('<w:p/>')),'空白.docx'),/没有可读取的正文/);
 await assert.rejects(referenceText(Buffer.from('not a zip'),'损坏.docx'),/无法读取 DOCX/);
 await assert.rejects(referenceText(Buffer.from('  \n'),'空白.txt'),/没有可读取的正文/);

 const breathService=new RoughCutJobs(store,{},()=>async()=>({cuts:[]}));
 const breathInput={...start,id:'test-short-breath-001',revision:newer.revision,threshold:.6,pauses:[{clipId:'c1',parts:[{start:clip.duration-.5,end:clip.duration-.2}],breath:true}]};
 await assert.rejects(breathService.start(breathInput),/停顿候选/,'breath is part of pause and must obey the same total-duration threshold');
 const wholePause={...breathInput,id:'test-whole-pause-001',pauses:[{clipId:'c1',parts:[{start:clip.duration-.8,end:clip.duration-.1}],breath:true}]};
 await breathService.start(wholePause);
 for(let i=0;i<100&&(await breathService.get(wholePause.id)).status==='running';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal((await breathService.get(wholePause.id)).status,'ready','combined silence and breath exceeds threshold');
 console.log('Agent checks passed: exact IDs/quotes, retained counterpart, manual/unaligned protection, independent review, outside-script retention, voice/music protection, durable background result, idempotent apply, whole-run undo, concurrent edits, API failure, reference import');
}finally{await rm(tmp,{recursive:true,force:true});}
