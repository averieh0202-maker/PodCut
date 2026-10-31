import {build} from 'esbuild';import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'podcut-voice-'));
try{
 await build({stdin:{contents:"export * from './server/publicationStore';export * from './server/episodeEditorial';export * from './src/edit/publicationTranscript';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile:join(dir,'lib.mjs'),logLevel:'silent'});
 const {PublicationStore,publishEpisode,buildPublicationTranscript}=await import(join(dir,'lib.mjs'));
 const project=join(dir,'project');await mkdir(project,{recursive:true});const profile=join(project,'publication-voice.md');await writeFile(profile,'PROFILE_MUST_NOT_LEAK: '+ 'x'.repeat(20000));
 const segments=[{id:'a',clipId:'body',text:'澳洲口音像外地人学说北京话。其实 Siri 也得保留。',start:0,end:8}];
 const raw=await publishEpisode(segments);assert.equal(raw.article,buildPublicationTranscript(segments));assert.equal(raw.editorialAudit.editingMode,'transcript-only');
 const requests=[];const ask=async(system,data)=>{requests.push({system,data});return {title:'节目',description:'本期的简介',chapters:[{id:'s1',title:'经历',quote:segments[0].text}]};};
 const notes=await publishEpisode(segments,ask);assert.equal(requests.length,1);assert.equal(requests[0].data.task,'publication-notes');assert.ok(!JSON.stringify(requests).includes('PROFILE_MUST_NOT_LEAK'));assert.equal(notes.article,raw.article,'notes may not rewrite the manuscript');
 const store=new PublicationStore(project);async function finished(){for(let i=0;i<100;i++){const s=await store.latest();if(s?.done||s?.error)return s;await new Promise(r=>setTimeout(r,10));}throw Error('job did not finish');}
 await store.start(segments);const first=await finished();await writeFile(profile,'Completely different author and style');await store.start(segments);const second=await finished();assert.equal(first.key,second.key,'author profiles must not influence transcript exports');assert.equal(first.result.article,second.result.article);
 console.log('Publication voice boundary passed: no profile loading, no prose generation, exact original humor and English, same manuscript with or without notes.');
}finally{await rm(dir,{recursive:true,force:true});}
