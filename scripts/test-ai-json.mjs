import {build} from 'esbuild';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'podcut-ai-json-')),original=globalThis.fetch;
try{
 await build({entryPoints:['server/agentAiSettings.ts'],bundle:true,platform:'node',format:'esm',outfile:join(dir,'lib.mjs'),logLevel:'silent'});const {compatibleAsk}=await import(join(dir,'lib.mjs'));
 let requests=[];const response=content=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content}}]}),{status:200,headers:{'Content-Type':'application/json'}});
 globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return response(requests.length===1?'{"article":"第一段\n第二段"}':'{"article":"第一段\\n第二段"}');};
 const ask=compatibleAsk({baseUrl:'https://api.deepseek.com',model:'test',apiKey:'test-only'});
 assert.deepEqual(await ask('Output JSON',{task:'article-write'}),{article:'第一段\n第二段'});assert.equal(requests.length,2);assert.equal(requests[0].response_format.type,'json_object');assert.equal(JSON.parse(requests[1].messages[1].content).task,'json-repair');
 requests=[];globalThis.fetch=async()=>{requests.push(1);return response('说明：\n{"article":"可恢复对象"}\n结束');};assert.equal((await ask('JSON',{})).article,'可恢复对象');assert.equal(requests.length,1);
 requests=[];globalThis.fetch=async()=>{requests.push(1);return response('{broken');};await assert.rejects(()=>ask('JSON',{}),/未返回有效 JSON/);assert.equal(requests.length,2,'format repair must be bounded, not recursively retry forever');
 requests=[];globalThis.fetch=async()=>{requests.push(1);return new Response('{}',{status:402});};await assert.rejects(()=>ask('JSON',{}),/402/);assert.equal(requests.length,1,'payment/credit error must not be retried automatically');
 console.log('AI JSON checks passed: strict DeepSeek JSON mode, syntax-only repair, valid object extraction, bounded failures.');
}finally{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
