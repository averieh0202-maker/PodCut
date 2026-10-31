import {build} from 'esbuild';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const temp=await mkdtemp(join(tmpdir(),'podcut-health-'));
try{
 const file=join(temp,'engine.mjs');
 await build({entryPoints:['src/audio/engine.ts'],bundle:true,platform:'node',format:'esm',outfile:file,logLevel:'silent',plugins:[{name:'worklet-browser-stub',setup(b){b.onResolve({filter:/^@soundtouchjs\/audio-worklet|speechProcessor\?worker&url/},a=>({path:a.path,namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},a=>({contents:a.path.endsWith('&url')||a.path.endsWith('?url')?'export default "processor.js"':'export class SoundTouchNode {}'}));}}]});
 const {AudioEngine}=await import(file);globalThis.window={setTimeout:()=>0};
 const node=()=>({connections:[],disconnect(){this.connections=[];},connect(n){this.connections.push(n);}});
 for(const mix of [true,false]){
  const engine=new AudioEngine(),master=node(),stretch=node(),input=node(),dest=node(),meter={frequencyBinCount:2,getByteTimeDomainData:a=>a.fill(128)};
  input.connect(stretch);if(mix)stretch.connect(master);else master.connect(stretch);
  Object.assign(engine,{playing:true,ctx:{state:'running'},gainNode:master,stretch,speechInput:input,speakerDest:dest,analyser:meter,speed:1.5,usesMixSchedule:mix,sources:[{}],speakerEl:{play:()=>Promise.resolve()}});
  engine.ensureSpeakerGraph=()=>{throw Error('健康检查不应重建已连接的人声节点');};
  for(let i=0;i<3;i++)engine.healthCheck();
  assert.equal(engine.speechInput,input);assert.equal(engine.stretch,stretch);
  assert.deepEqual(input.connections,[stretch]);
  assert.deepEqual((mix?master:stretch).connections,[dest,meter]);
  assert.deepEqual((mix?stretch:master).connections,[mix?master:stretch]);
  console.log(`PASS ${mix?'混音':'纯人声'}：连续健康检查保留倍速人声连接`);
 }
}finally{await rm(temp,{recursive:true,force:true});}
