import {build} from 'esbuild';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'podcut-transcript-'));
try{
 await build({stdin:{contents:"export * from './src/edit/publicationTranscript';export * from './src/edit/publicationClient';export * from './src/edit/episodeTimeline';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile:join(dir,'lib.mjs'),logLevel:'silent'});
 const {buildPublicationTranscript,mountPublicationExport,episodeSegments}=await import(join(dir,'lib.mjs'));
 const clip={id:'body',duration:5,buffer:{duration:5},words:[{id:'a',text:'其实 Siri ',start:0,end:1},{id:'b',text:'删除的字',start:1,end:2,deleted:true},{id:'c',text:'Apple Pencil。',start:2,end:3,breakAfter:true},{id:'d',text:'已剪除范围的字',start:4,end:5}],ranges:[{start:0,end:3}]};
 const kept=episodeSegments([clip]);let rows=[{...kept[0],clipId:'teaser-0'},...kept,{...kept[0],id:'intentional-repeat'}];
 const expected='# 播客长文稿\n\n其实 Siri Apple Pencil。\n\n其实 Siri Apple Pencil。\n';assert.equal(buildPublicationTranscript(rows),expected,'exclude only the teaser copy; retain intentional body repetition and English spacing');assert.ok(!buildPublicationTranscript(rows).includes('删除的字'));assert.ok(!buildPublicationTranscript(rows).includes('已剪除范围的字'));
 assert.ok(buildPublicationTranscript([rows[0]]).includes('Siri'),'a teaser-only project still exports its content');assert.throws(()=>buildPublicationTranscript([]));
 const downloads=[],blobs=new Map(),requests=[];
 function node(tag){return {tag,style:{},children:[],disabled:false,listeners:{},append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},setAttribute(){},addEventListener(name,fn){this.listeners[name]=fn;},click(){if(this.tag==='a')downloads.push({href:this.href,name:this.download});else this.listeners.click?.();},remove(){}};}
 const article=node('button'),notes=node('button');globalThis.location={hostname:'test.invalid',search:''};globalThis.document={body:node('body'),createElement:node,getElementById:id=>id==='btn-export-article'?article:notes};globalThis.window={setTimeout:()=>1};
 globalThis.URL.createObjectURL=blob=>{const key='blob:test-'+blobs.size;blobs.set(key,blob);return key;};globalThis.URL.revokeObjectURL=()=>{};
 globalThis.fetch=async(url,opts)=>{requests.push({url,opts});return {ok:true,status:200,json:async()=>url.endsWith('/session')?{token:'test'}:{key:'test',kind:'showNotes',stage:'生成简介',percent:10,done:false}};};
 mountPublicationExport(()=>rows,()=> 'episode');article.click();assert.equal(requests.length,0,'manuscript button downloads locally without any API request');assert.equal(await blobs.get(downloads[0].href).text(),expected);
 notes.click();await new Promise(resolve=>setImmediate(resolve));assert.equal(notes.disabled,true);assert.equal(JSON.parse(requests.find(r=>r.url.endsWith('publish-start')).opts.body).kind,'showNotes');
 rows=[{...kept[0],text:'最新精修后的字。'}];article.click();assert.equal(downloads.length,2,'transcript remains available while notes generate');assert.equal(await blobs.get(downloads[1].href).text(),'# 播客长文稿\n\n最新精修后的字。\n');assert.equal(article.disabled,false);
 console.log('Transcript export passed: actual kept audio ranges, deleted words excluded, teaser copies omitted, repetitions and English preserved, no API or rewrite, live edits and concurrent notes.');
}finally{await rm(dir,{recursive:true,force:true});}
