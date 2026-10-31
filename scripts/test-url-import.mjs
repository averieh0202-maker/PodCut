import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=await mkdtemp(join(tmpdir(),'podcut-url-'));
try {
 const out=join(dir,'url.mjs');
 await build({entryPoints:[resolve('src/audio/urlImport.ts')],outfile:out,bundle:true,format:'esm',platform:'node',logLevel:'silent'});
 const {parseAudioUrl,audioFileName,downloadAudioFile}=await import(pathToFileURL(out));
 for(const value of ['','not-a-url','javascript:alert(1)','file:///etc/passwd','data:audio/wav;base64,AA','https://user:password@example.com/music.mp3'])assert.throws(()=>parseAudioUrl(value));
 assert.equal(parseAudioUrl(' https://example.com/a.mp3?sig=abc ').href,'https://example.com/a.mp3?sig=abc');
 assert.equal(audioFileName(new URL('https://example.com/%E8%BF%87%E5%9C%BA.mp3?sig=abc')),'过场.mp3');
 assert.equal(audioFileName(new URL('https://example.com/download'),'attachment; filename="opening.wav"'),'opening.wav');
 assert.equal(audioFileName(new URL('https://example.com/download'),"attachment; filename*=UTF-8''%E5%BC%80%E5%A4%B4.mp3"),'开头.mp3');
 const source=new Uint8Array([82,73,70,70,1,2,3,4]);let called=false;
 const file=await downloadAudioFile('https://example.com/original.wav',async(url,options)=>{
  called=true;assert.equal(url,'https://example.com/original.wav');assert.equal(options.credentials,'omit');assert.ok(options.signal);
  return new Response(source,{headers:{'content-type':'audio/wav','content-disposition':'attachment; filename="source.wav"'}});
 });
 assert.equal(called,true);assert.equal(file.name,'source.wav');assert.equal(file.type,'audio/wav');assert.deepEqual(new Uint8Array(await file.arrayBuffer()),source,'download does not resample or alter the audio');
 await assert.rejects(downloadAudioFile('https://example.com/music',async()=>new Response('page',{headers:{'content-type':'text/html; charset=utf-8'}})),/网页/);
 await assert.rejects(downloadAudioFile('https://example.com/music',async()=>new Response(null,{status:403})),/HTTP 403/);
 await assert.rejects(downloadAudioFile('https://example.com/music',async()=>new Response(null)),/空文件/);
 await assert.rejects(downloadAudioFile('https://example.com/music',async()=>{throw new TypeError('CORS');}),/跨域/);
 console.log('✓ URL validation, signed URLs, Chinese/download filenames, original-byte fidelity, credential omission and actionable failures');
} finally {await rm(dir,{recursive:true,force:true});}
