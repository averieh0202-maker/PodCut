import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'podcut-editorial-'));
try{
 await build({stdin:{contents:"export * from './server/publicationResearch';export * from './server/publicationArticle'",resolveDir:process.cwd()},bundle:true,platform:'node',format:'esm',outfile:join(dir,'lib.mjs'),logLevel:'silent'});
 const {publicAddress,researchPublication,normalizeTerms,parseArticlePlan,articleGroups,writePublicationArticle,applyParagraphPatches}=await import(join(dir,'lib.mjs'));
 for(const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','100.64.0.1','::1','::ffff:127.0.0.1','fc00::1'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('8.8.8.8'),true);assert.equal(publicAddress('2606:4700:4700::1111'),true);
 const paragraphs=[{id:'P1',text:'## 便利与隐私'},{id:'P2',text:'便利不应掩盖隐私担忧。'}];
 assert.equal(applyParagraphPatches(paragraphs,[{id:'P2',quote:'便利不应掩盖',after:'便利与隐私需要共同权衡。'}]),'## 便利与隐私\n\n便利与隐私需要共同权衡。');
 assert.throws(()=>applyParagraphPatches(paragraphs,[{id:'P1',quote:'便利不应掩盖',after:'错放'}]),/定位无效/);
 const text='Muse was introduced as a personal assistant. The product has its own app. '.repeat(4);
 let reads=0;
 const claim={id:'F1',claim:'Muse 是个人助手。',query:'Muse assistant',urls:['https://example.org/muse']};
 const opts={search:async()=>[],read:async url=>{reads++;return {url,text:'<title>Product</title><p>'+text+'</p>'};}};
 const verified=await researchPublication([claim],async()=>({findings:[{id:'F1',status:'supported',wording:'Muse 是个人助手。',reason:'原文明确说明',evidence:[{sourceId:'S1',quote:'Muse was introduced as a personal assistant.'}]}]}),()=>{},opts);
 assert.equal(verified.findings[0].status,'supported');assert.equal(verified.sources[0].url,'https://example.org/muse');assert.equal(reads,1);
 const fabricated=await researchPublication([claim],async()=>({findings:[{id:'F1',status:'supported',wording:'Muse 有一百万用户。',evidence:[{sourceId:'S1',quote:'The product has one million users.'}]}]}),()=>{},opts);
 assert.equal(fabricated.findings[0].status,'unverified','invented quote cannot certify a claim');assert.deepEqual(fabricated.findings[0].evidence,[]);
 const offline=await researchPublication([claim],()=>{throw Error('must not ask model to verify without sources');},()=>{},{read:async()=>{throw Error('offline');},search:async()=>[]});assert.equal(offline.findings[0].status,'unverified');assert.ok(offline.warnings.length);
 const before=reads;const local=await researchPublication([{...claim,urls:['https://127.0.0.1/api/draft/current','http://localhost/','file:///etc/passwd']}],()=>{throw Error('no valid evidence');},()=>{},opts);assert.equal(reads,before);assert.equal(local.findings[0].status,'unverified');
 const phoneTerms=[{canonical:'AT&T',aliases:['AT','ATT']}];assert.equal(normalizeTerms(normalizeTerms('AT&T 与 ATT',phoneTerms),phoneTerms),'AT&T 与 AT&T','normalization must be idempotent and preserve canonical names');
 const terms=[{canonical:'Muse',aliases:['缪斯','muse']}];assert.equal(normalizeTerms('Instagram 的账号',[{canonical:'Instinct',aliases:['Instagram']}]),'Instagram 的账号','semantic entity resolution must not become a global brand replacement');assert.equal(normalizeTerms('缪斯和 muse，museum 不改变。',terms),'Muse和 Muse，museum 不改变。');
 const segments=[{id:'a',clipId:'c',text:'缪斯很方便，但我担心隐私。',start:0,end:3},{id:'b',clipId:'c',text:'这不代表所有用户都如此。',start:4,end:6}];
 const plan=parseArticlePlan({terms:[...terms,{canonical:'Invented',aliases:['缪斯']}],factChecks:[{public:false,claim:'我住哪里',query:'private'}]},segments,'Muse');assert.equal(plan.terms.length,1);assert.equal(plan.facts.length,0);
 assert.equal(articleGroups(segments,[4]).length,1,'tiny opening paragraphs must not become standalone article sections');
 let checks=0;
 const researcher=async()=>({checkedAt:'2026-10-21',sources:[],findings:[],warnings:[]});
 const ask=async(_system,data)=>{
  if(data.task==='article-final-review')return {pass:true,issues:[],missingViews:[],newClaims:[],edits:[],coverage:data.views.map(v=>({id:v.id,status:'preserved'}))};
  if(data.task==='article-style')return {article:data.article};
  if(data.task==='article-repair')return {article:data.article};
  if(data.task==='article-acceptance'){checks++;return {approved:true,remainingIssues:[]};}
  if(data.task==='article-write')return {article:'## 我的使用体验\n\n缪斯很方便。[S999]'};
  if(data.task==='article-review'){checks++;return {pass:false,issues:['遗漏隐私担忧'],missingViews:['隐私担忧'],newClaims:[],article:'## 便利与隐私的取舍\n\nMuse 很方便，但我仍担心隐私；这一体验不能代表所有用户。'};}
  checks++;return {pass:true,issues:[],missingViews:[],newClaims:[],article:data.article};
 };
 const article=await writePublicationArticle(segments,{title:'便利与隐私',terms,views:[{text:'便利不应掩盖隐私担忧'}]},'Muse',ask,'rules',[],()=>{},researcher);
 assert.equal(checks,2,'failed audit must be corrected and independently rechecked');assert.match(article.article,/仍担心隐私/);assert.ok(!article.article.includes('[S999]'));assert.ok(article.factReport.includes('便利不应掩盖隐私担忧'));
 await assert.rejects(()=>writePublicationArticle(segments,{},'',async(_sys,data)=>data.task==='article-write'?{article:'只有便利。'}:{pass:false,issues:['观点反转'],missingViews:['隐私'],newClaims:[],edits:[],article:'只有便利。'},'rules',[],()=>{},researcher),/全文统稿仍有核心观点遗漏或论证问题/);
 let writeCalls=0;
 const recovered=await writePublicationArticle(segments,{},'',async(_sys,data)=>{
  if(data.task==='article-write'){writeCalls++;if(!data.schemaRetry)return {title:'missing article field'};return {article:'便利与隐私需要共同权衡。'};}
  if(data.task==='article-style')return {article:data.article};
  return {pass:true,issues:[],missingViews:[],newClaims:[],coverage:[],edits:[],article:data.article};
 },'rules',[],()=>{},researcher);
 assert.equal(writeCalls,2,'missing article field should receive one schema retry');assert.ok(recovered.article.includes('便利与隐私'));
 console.log('Editorial checks passed: source-grounded verification, fabricated-evidence rejection, offline disclosure, local-URL rejection, canonical terms, topic grouping, viewpoint review/repair/rejection, citation filtering.');
}finally{await rm(dir,{recursive:true,force:true});}
