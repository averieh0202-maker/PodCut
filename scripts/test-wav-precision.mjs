import {build} from 'esbuild';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
const tmp=await mkdtemp(join(tmpdir(),'podcut-wav24-'));
try{
 const file=join(tmp,'lib.mjs');await build({entryPoints:['src/audio/exportAudio.ts'],bundle:true,format:'esm',platform:'node',outfile:file,logLevel:'silent',plugins:[{name:'worker-url',setup(b){b.onResolve({filter:/speechProcessor\?worker&url$/},()=>({path:'url',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export default "browser-only"',loader:'js'}));}}]});
 const {exportEditedWav}=await import(file);
 const sr=44100,input=Float32Array.from({length:1003},(_,i)=>i<3?[.5,-.5,0][i]:2e-6*Math.sin(i*.17));
 const buffer={sampleRate:sr,length:input.length,numberOfChannels:1,duration:input.length/sr,getChannelData:()=>input};
 const view=new DataView(await(await exportEditedWav([{buffer,ranges:[{start:0,end:buffer.duration}]}])).arrayBuffer());
 assert.equal(view.getUint16(34,true),24);assert.equal(view.getUint16(32,true),3);assert.equal(view.getUint32(40,true),input.length*3);assert.equal(view.byteLength,44+input.length*3+1);assert.equal(view.getUint32(4,true)+8,view.byteLength);
 let maxError=0,retainedQuiet=0;for(let i=0;i<input.length;i++){const at=44+i*3,v=view.getUint8(at)|(view.getUint8(at+1)<<8)|(view.getInt8(at+2)<<16);maxError=Math.max(maxError,Math.abs(v/8388608-input[i]));if(i>=3&&v!==0)retainedQuiet++;}
 assert.ok(maxError<=.5/8388608);assert.ok(retainedQuiet>950);console.log({pass:true,bits:24,maxError,retainedQuiet,oddLengthPadding:true});
}finally{await rm(tmp,{recursive:true,force:true});}
