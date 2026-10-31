import {build} from 'esbuild';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';import assert from 'node:assert/strict';
const root=await mkdtemp(join(tmpdir(),'podcut-export-test-')),sr=48000;
try{
 await mkdir(join(root,'assets'));await build({entryPoints:['server/localExportWorker.ts'],bundle:true,platform:'node',format:'esm',outfile:join(root,'worker.mjs'),logLevel:'silent'});
 async function asset(seconds,freq,amp){const data=Float32Array.from({length:seconds*sr},(_,i)=>amp*Math.sin(2*Math.PI*freq*i/sr)),buf=Buffer.from(data.buffer),id=createHash('sha256').update(buf).digest('hex');await writeFile(join(root,'assets',id),buf);return {sampleRate:sr,numberOfChannels:1,length:data.length,channels:[{diskAsset:id,bytes:buf.length}]};}
 const voice=await asset(2,440,.3),music=await asset(3,880,.1);
 for(const speed of [1,1.1,2]){
  const dir=join(root,'job-'+speed);await mkdir(dir);const snapshot={revision:'fixture',payload:{gainDb:0,speechRate:speed,clips:[{id:'c',current:voice,ranges:[{start:0,end:.8},{start:1,end:1.7}],audioOrder:[{start:0,end:2}],words:[],gainDb:0}],music:[{id:'bed',kind:'bed',buffer:music,clipId:'c',originalTime:0,anchorSide:'before',leadInSec:.5,inPoint:0,outPoint:3,gainDb:0,fadeInSec:0,fadeOutSec:0}]}};
  await writeFile(join(dir,'snapshot.json'),JSON.stringify(snapshot));const run=spawnSync(process.execPath,[join(root,'worker.mjs'),root,dir,'/opt/homebrew/bin/ffmpeg'],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
  const status=JSON.parse(await readFile(join(dir,'status.json'),'utf8'));assert.equal(status.done,true);assert.equal(status.duration,3);assert.ok(status.peak<.41);
  const pcm=spawnSync('/opt/homebrew/bin/ffmpeg',['-v','error','-i',join(dir,'audio.wav'),'-f','f32le','-'],{maxBuffer:10e6});assert.equal(pcm.status,0);const x=new Float32Array(pcm.stdout.buffer,pcm.stdout.byteOffset,pcm.stdout.length/4);
  function power(freq,a,b){let re=0,im=0,n=0;for(let i=Math.round(a*sr);i<Math.round(b*sr);i++){const v=x[i*2];re+=v*Math.cos(2*Math.PI*freq*i/sr);im+=v*Math.sin(2*Math.PI*freq*i/sr);n++;assert.equal(x[i*2],x[i*2+1]);}return 2*Math.hypot(re,im)/n;}
  assert.ok(Math.abs(power(880,.05,.4)-.1)<.0001,'opening music gain preserved');assert.ok(power(440,.05,.4)<.0001,'voice must not precede music lead');
  assert.ok(power(440,.7,1.2)>.27,'pitch and voice gain preserved');assert.ok(Math.abs(power(880,.7,1.2)-.1)<.002,'music remains original speed during speech');
  assert.ok(power(440,2.1,2.4)<.001,'voice must end at scheduled time');assert.ok(Math.abs(power(880,2.65,2.95)-.1)<.0001,'music tail preserved');
  console.log(JSON.stringify({speed,pass:true,...status}));
 }
}finally{await rm(root,{recursive:true,force:true});}
