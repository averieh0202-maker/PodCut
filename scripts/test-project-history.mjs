import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const temp = await mkdtemp(join(tmpdir(), 'podcut-history-test-'));
let count = 0;
try {
  const file = join(temp, 'test.mjs');
  await build({ stdin: { contents: "export * from './server/projectCatalog';export * from './server/diskDraftStore';export * from './src/edit/draftWriter';export * from './src/edit/saveAndLeave';", resolveDir: process.cwd() }, outfile: file, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
  const { ProjectCatalog, DiskDraftStore, DraftWriter, saveAndLeave } = await import(pathToFileURL(file));
  const root = join(temp, 'app'), catalog = new ProjectCatalog(root);
  const test = async (name, run) => { await run(); count++; console.log('✓', name); };
  let one, two, revision, asset;
  await test('New accounts list no phantom legacy draft', async () => assert.deepEqual(await catalog.list(), []));
  await test('Each new episode gets an independent durable project', async () => {
    one = await catalog.create(); two = await catalog.create();
    assert.notEqual(one.id, two.id); assert.equal((await catalog.list()).length, 2);
    assert.equal(new Set((await catalog.list()).map(p => p.id)).size, 2);
  });
  const projectDir = id => join(root, '.podcast-drafts/projects', id);
  const store = new DiskDraftStore(projectDir(one.id));
  await test('Deleted words, cuts, music and 1.1× remain in the saved project', async () => {
    asset = await store.upload((async function* () { yield Buffer.alloc(96, 3); })());
    const payload = { audioName: '真实一期', speechRate: 1.1, gainDb: 4, clips: [{ id: 'c1', name: '录音', duration: 10, ranges: [{start:0,end:4},{start:6,end:8}], words: [{id:'w1',text:'保留',start:0,end:2},{id:'w2',text:'删除',start:4,end:6,deleted:true}], source:{blob:{diskAsset:asset.id,bytes:asset.bytes,kind:'blob'}} }], music: [{id:'m1',kind:'bed',name:'片头',clipId:'c1',wordId:'w1',anchorSide:'before',leadInSec:1,inPoint:0,outPoint:2,gainDb:-15,source:{blob:{diskAsset:asset.id,bytes:asset.bytes,kind:'blob'}}}] };
    const previous = (await store.read()).snapshot;
    revision = (await store.save(payload, [asset], previous.revision)).revision;
    const restored = (await new DiskDraftStore(projectDir(one.id)).read()).snapshot;
    assert.deepEqual(restored.payload, payload);
    const row = (await catalog.list()).find(p => p.id === one.id);
    assert.equal(row.name, '真实一期'); assert.equal(row.preview, '保留'); assert.equal(row.clipCount, 1);
    assert.ok(Math.abs(row.duration - (1+6/1.1)) < 1e-6);
    assert.equal((await new DiskDraftStore(projectDir(two.id)).read()).snapshot.payload, null);
  });
  await test('Renaming changes only the title, never the audio or editing revision', async () => {
    await catalog.rename(one.id, '我的新标题');
    assert.equal((await catalog.list()).find(p => p.id === one.id).name, '我的新标题');
    assert.equal((await store.read()).snapshot.revision, revision);
    assert.equal((await readFile(store.assetPath(asset.id))).length, asset.bytes);
    await assert.rejects(() => catalog.rename('../outside', '非法'));
    await assert.rejects(() => catalog.rename(one.id, ' '));
  });
  await test('Original root drafts are discoverable without moving their audio', async () => {
    const old = new DiskDraftStore(join(root, '.podcast-drafts'));
    await old.save({audioName:'旧剪辑',clips:[{id:'c0',name:'原录音',duration:1,ranges:[{start:0,end:1}],words:[]}],music:[]}, [], null);
    assert.equal((await catalog.list()).find(p => p.id === '').name, '旧剪辑');
  });
  await test('Corrupt manifests recover a previous checkpoint and still appear', async () => {
    await writeFile(join(projectDir(one.id), 'current.json'), '{interrupted');
    const rows = await catalog.list(); assert.equal(rows.find(p => p.id === one.id).clipCount, 1);
    assert.equal((await store.read()).recovered, true);
  });
  await test('A broken project remains visible and does not erase other episodes', async () => {
    await mkdir(projectDir('broken'), {recursive:true});
    await writeFile(join(projectDir('broken'), 'current.json'), 'bad');
    const rows = await catalog.list(); assert.ok(rows.find(p => p.id === 'broken').unavailable);
    assert.ok(rows.some(p => p.id === one.id));
  });
  await test('Returning home awaits all edits arriving during an in-flight save', async () => {
    let release, value = 'first'; const writes = [], navigation = [];
    const writer = new DraftWriter(async () => { const captured = value; if (!writes.length) await new Promise(r => release = r); writes.push(captured); });
    writer.markDirty();
    const leaving = saveAndLeave({ save: async () => { await writer.flush(); return true; }, navigate: () => navigation.push('home') });
    assert.deepEqual(navigation, []); value = 'latest'; writer.markDirty(); release();
    await leaving; assert.deepEqual(writes, ['first', 'latest']); assert.deepEqual(navigation, ['home']);
  });
  await test('A failed save keeps the editor open for retry', async () => {
    let navigated = false;
    assert.equal(await saveAndLeave({ save: async () => false, navigate: () => navigated = true }), false);
    assert.equal(navigated, false);
    await assert.rejects(() => saveAndLeave({save: async () => {throw Error('disk full');}, navigate: () => navigated = true}));
    assert.equal(navigated, false);
  });
  console.log(`\n${count} project history checks passed`);
} finally { await rm(temp, {recursive:true,force:true}); }
