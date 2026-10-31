import {build} from 'esbuild';import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'publication-store-'));
try{
 await build({entryPoints:['server/publicationStore.ts'],bundle:true,format:'esm',platform:'node',outfile:join(dir,'lib.mjs'),logLevel:'silent'});
 const {PublicationStore}=await import(join(dir,'lib.mjs'));const store=new PublicationStore(dir);
 const segments=[{id:'teaser',clipId:'teaser-0',text:'片头副本。',start:0,end:4},{id:'a',clipId:'body',text:'其实 Siri 和 Apple Pencil 都应该保留。',start:30,end:40},{id:'b',clipId:'body',text:'小猫本来就是傻傻的嘛。',start:80,end:86}];
 async function finished(){for(let i=0;i<100;i++){const s=await store.latest();if(s?.done||s?.error)return s;await new Promise(r=>setTimeout(r,10));}throw Error('job did not finish');}
 let calls=0;const offline=async()=>{calls++;throw Error('AI service 402');};
 await store.start(segments,offline);let state=await finished();assert.equal(state.done,true);assert.equal(calls,0,'transcript export never calls a provider, even with an offline provider passed in');
 assert.equal(state.result.article,'# 播客长文稿\n\n其实 Siri 和 Apple Pencil 都应该保留。\n\n小猫本来就是傻傻的嘛。\n');assert.equal(state.result.showNotes,'');assert.equal(state.result.editorialAudit.rewritten,false);
 assert.equal(await readFile(join(dir,'publications',state.key,'article.md'),'utf8'),state.result.article);const transcriptKey=state.key;
 await store.start(segments,offline,'ignored reference');assert.equal((await store.latest()).key,transcriptKey,'reference cannot change verbatim export');assert.equal(calls,0);
 await store.start(segments,offline,'',{kind:'showNotes'});state=await finished();assert.match(state.error,/402/);assert.equal(calls,1);
 const requests=[];const ask=async(system,data)=>{requests.push({system,data});return {title:'本期',description:'节目简介',chapters:[{id:'s1',title:'第一章',quote:'其实 Siri 和 Apple Pencil 都应该保留。'},{id:'s2',title:'第二章',quote:'小猫本来就是傻傻的嘛。'}]};};
 await store.start(segments,ask,'',{kind:'showNotes'});state=await finished();assert.equal(state.done,true);assert.equal(requests.length,1);assert.equal(requests[0].data.task,'publication-notes');assert.ok(requests[0].data.segments.every(s=>!s.clipId.startsWith('teaser-')));
 assert.ok(state.result.showNotes.includes('00:00 片头精句'));assert.ok(state.result.showNotes.includes('01:20 第二章'));assert.ok(!state.result.article.includes('节目简介'));
 await store.start(segments,ask,'',{kind:'showNotes'});assert.equal(requests.length,1,'completed notes reuse their current-version cache');
 // Prior local rewrites must stay archived, never appear as a new export.
 const status=join(dir,'publications',state.key,'status.json');await writeFile(status,JSON.stringify({...state,version:'old-rewrite-version',result:{article:'历史AI文章'}}));assert.equal(await store.latest(),null);
 console.log('Publication store passed: offline transcript, exact original words, current-version cache, notes-only AI, real edited timestamps, archived rewrite isolation.');
}finally{await rm(dir,{recursive:true,force:true});}
