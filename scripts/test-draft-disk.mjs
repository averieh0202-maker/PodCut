import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const temp=await mkdtemp(join(tmpdir(),'podcast-disk-'));
let count=0;
try {
  for(const [name,entry] of [['store','server/diskDraftStore.ts'],['writer','src/edit/draftWriter.ts']]) {
    await build({entryPoints:[resolve(entry)],outfile:join(temp,name+'.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent'});
  }
  const {DiskDraftStore,DraftConflict}=await import(pathToFileURL(join(temp,'store.mjs')));
  const {DraftWriter}=await import(pathToFileURL(join(temp,'writer.mjs')));
  const test=async(name,fn)=>{await fn();count++;console.log('✓',name);};
  const root=join(temp,'disk');let store=new DiskDraftStore(root);
  const bytes=Buffer.alloc(1024*1024,42);
  async function* audio(n=1) {for(let i=0;i<n;i++)yield bytes;}
  let asset,saved;
  await test('259MB audio streams to disk without a giant in-memory copy',async()=>{
    asset=await store.upload(audio(259));assert.equal(asset.bytes,259*1024**2);
  });
  await test('Identical audio is immutable and deduplicated',async()=>{
    const small=await store.upload(audio());const again=await store.upload(audio());assert.deepEqual(small,again);
    assert.equal((await readdir(join(root,'assets'))).filter(n=>!n.startsWith('.')).length,2);
  });
  const payload={clips:[{id:'c',words:[{text:'字',start:.1,end:.3}],source:{blob:{diskAsset:asset.id,bytes:asset.bytes,kind:'blob'}}}],music:[]};
  await test('Manifest cannot commit missing or truncated audio',async()=>{
    await assert.rejects(()=>store.save(payload,[{...asset,bytes:asset.bytes-1}],null));
    assert.equal((await store.read()).snapshot,null);
  });
  await test('Commit survives a new store instance (server restart)',async()=>{
    saved=await store.save(payload,[asset],null);
    store=new DiskDraftStore(root);
    assert.deepEqual((await store.read()).snapshot.payload,payload);
  });
  await test('Stale tab cannot overwrite a more recent draft',async()=>{
    await assert.rejects(()=>store.save({clips:[]},[],null),DraftConflict);
    assert.equal((await store.read()).snapshot.revision,saved.revision);
  });
  await test('Interrupted upload leaves previous manifest and audio intact',async()=>{
    async function* broken(){yield bytes;throw new Error('connection lost');}
    await assert.rejects(()=>store.upload(broken()));
    assert.equal((await store.read()).snapshot.revision,saved.revision);
    assert.equal((await readdir(join(root,'assets'))).filter(n=>n.startsWith('.upload')).length,0);
  });
  await test('Unlisted audio references are rejected',async()=>{
    await assert.rejects(()=>store.save(payload,[],saved.revision));
  });
  await test('Corrupted current manifest recovers a durable checkpoint',async()=>{
    await writeFile(join(root,'current.json'),'{broken');
    const recovered=await store.read();assert.ok(recovered.recovered);assert.deepEqual(recovered.snapshot.payload,payload);
  });
  await test('Clear is a durable tombstone; source remains recoverable',async()=>{
    saved=await store.save(null,[],saved.revision);store=new DiskDraftStore(root);
    assert.equal((await store.read()).snapshot.payload,null);
    assert.equal((await readFile(store.assetPath(asset.id))).length,asset.bytes);
  });
  await test('Concurrent commits use revision checks under a file lock',async()=>{
    const two=await Promise.allSettled([store.save({a:1},[],saved.revision),new DiskDraftStore(root).save({a:2},[],saved.revision)]);
    assert.equal(two.filter(x=>x.status==='fulfilled').length,1);
    assert.equal(two.filter(x=>x.status==='rejected').length,1);
  });
  await test('An abandoned empty commit lock is recovered after a crash',async()=>{
    const lock=join(root,'.commit-lock');await writeFile(lock,'');
    const past=new Date(Date.now()-60000);await utimes(lock,past,past);
    const current=(await store.read()).snapshot;
    const recovered=await store.save({recovered:true},[],current.revision);
    assert.equal((await store.read()).snapshot.revision,recovered.revision);
  });
  await test('Edits during a pending save produce a second commit',async()=>{
    let release;let state='first';const writes=[];
    const writer=new DraftWriter(async()=>{const value=state;if(writes.length===0)await new Promise(r=>release=r);writes.push(value);});
    writer.markDirty();const flush=writer.flush();state='second';writer.markDirty();release();await flush;
    assert.deepEqual(writes,['first','second']);assert.equal(writer.dirty,false);
  });
  await test('A failed save stays dirty and can be retried',async()=>{
    let fail=true;const writer=new DraftWriter(async()=>{if(fail)throw new Error('disk full');});writer.markDirty();
    await assert.rejects(()=>writer.flush());assert.ok(writer.dirty);fail=false;await writer.flush();assert.equal(writer.dirty,false);
  });
  await test('Clear queued behind a save cannot resurrect an old project',async()=>{
    let release;let state='audio';const writes=[];
    const writer=new DraftWriter(async()=>{const value=state;if(!writes.length)await new Promise(r=>release=r);writes.push(value);});
    writer.markDirty();const pending=writer.flush();state=null;writer.markDirty();release();await pending;assert.deepEqual(writes,['audio',null]);
  });
  console.log(`\n${count} disk persistence checks passed`);
} finally {await rm(temp,{recursive:true,force:true});}
