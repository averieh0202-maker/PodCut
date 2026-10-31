import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface AssetRef { id: string; bytes: number }
export interface DiskSnapshot {
  revision: string;
  savedAt: number;
  payload: unknown | null;
  assets: AssetRef[];
}
export class DraftConflict extends Error {}
const ASSET_ID = /^[a-f0-9]{64}$/;
/** Immutable audio + atomic manifests. Audio is never rewritten or removed on
 * save/clear. Previous manifests remain available after an interrupted commit. */
export class DiskDraftStore {
  constructor(readonly root: string) {}
  async init() {
    await fs.mkdir(path.join(this.root, 'assets'), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(this.root, 'snapshots'), { recursive: true, mode: 0o700 });
  }
  assetPath(id: string) {
    if (!ASSET_ID.test(id)) throw new Error('Invalid audio asset id');
    return path.join(this.root, 'assets', id);
  }
  async upload(chunks: AsyncIterable<Uint8Array>): Promise<AssetRef> {
    await this.init();
    const temp = path.join(this.root, 'assets', `.upload-${randomUUID()}`);
    const file = await fs.open(temp, 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of chunks) {
        bytes += chunk.byteLength;
        if (bytes > 4 * 1024 ** 3) throw new Error('Audio asset exceeds 4GB');
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length) offset += (await file.write(chunk, offset, chunk.length - offset)).bytesWritten;
      }
      if (!bytes) throw new Error('Empty audio asset');
      await file.sync(); await file.close();
      const id = hash.digest('hex');
      try { await fs.link(temp, this.assetPath(id)); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      const dir = await fs.open(path.join(this.root, 'assets'), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      const stat = await fs.stat(this.assetPath(id));
      if (stat.size !== bytes) throw new Error('Audio asset verification failed');
      return { id, bytes };
    } finally { await file.close().catch(() => {}); await fs.unlink(temp).catch(() => {}); }
  }
  async validate(snapshot: DiskSnapshot) {
    if (!snapshot || typeof snapshot.revision !== 'string' || !Array.isArray(snapshot.assets)) throw new Error('Invalid draft manifest');
    for (const asset of snapshot.assets) {
      if (!(asset.bytes > 0) || !Number.isSafeInteger(asset.bytes)) throw new Error('Invalid audio size');
      const stat = await fs.stat(this.assetPath(asset.id));
      if (!stat.isFile() || stat.size !== asset.bytes) throw new Error(`Audio missing or truncated: ${asset.id}`);
    }
  }
  async read(): Promise<{ snapshot: DiskSnapshot | null; recovered: boolean }> {
    await this.init();
    const current = path.join(this.root, 'current.json');
    try {
      const snapshot = JSON.parse(await fs.readFile(current, 'utf8')) as DiskSnapshot;
      await this.validate(snapshot);
      return { snapshot, recovered: false };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        // First run may still have a completed recovery snapshot from a crash.
      }
    }
    const names = (await fs.readdir(path.join(this.root, 'snapshots'))).filter(n => n.endsWith('.json')).sort().reverse();
    for (const name of names) {
      try {
        const snapshot = JSON.parse(await fs.readFile(path.join(this.root, 'snapshots', name), 'utf8')) as DiskSnapshot;
        await this.validate(snapshot);
        return { snapshot, recovered: true };
      } catch { /* try the previous durable checkpoint */ }
    }
    // An existing, unreadable draft must not be silently replaced with empty.
    if (names.length || await fs.stat(current).then(() => true, () => false)) throw new Error('No readable draft checkpoint; original files retained');
    return { snapshot: null, recovered: false };
  }
  private async atomicJson(target: string, data: unknown) {
    const temp = `${target}.${randomUUID()}.tmp`;
    const file = await fs.open(temp, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(data)); await file.sync(); await file.close();
      await fs.rename(temp, target);
      const dir = await fs.open(path.dirname(target), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
    } finally { await file.close().catch(() => {}); await fs.unlink(temp).catch(() => {}); }
  }
  private async lock() {
    const lockPath = path.join(this.root, '.commit-lock');
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const handle = await fs.open(lockPath, 'wx', 0o600);
        await handle.writeFile(String(process.pid));
        return async () => { await handle.close(); await fs.unlink(lockPath); };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const pid = Number(await fs.readFile(lockPath, 'utf8').catch(() => ''));
        if (!pid) {
          const age = await fs.stat(lockPath).then(s => Date.now() - s.mtimeMs, () => 0);
          if (age > 30000) { await fs.unlink(lockPath).catch(() => {}); continue; }
        }
        if (pid > 0) {
          try { process.kill(pid, 0); }
          catch (probe) { if ((probe as NodeJS.ErrnoException).code === 'ESRCH') { await fs.unlink(lockPath).catch(() => {}); continue; } }
        }
        await new Promise(r => setTimeout(r, 100));
      }
    }
    throw new Error('Draft commit busy; retry shortly');
  }
  async save(payload: unknown | null, assets: AssetRef[], expectedRevision: string | null): Promise<DiskSnapshot> {
    await this.init();
    const release = await this.lock();
    try {
      const { snapshot: previous } = await this.read();
      if ((previous?.revision ?? null) !== expectedRevision) throw new DraftConflict('另一窗口已更新草稿，本窗口尚未保存；请保留本窗口并保存副本');
      const snapshot: DiskSnapshot = { revision: randomUUID(), savedAt: Date.now(), payload, assets };
      await this.validate(snapshot);
      // References in the JSON must all exist in the verified asset list.
      const refs = new Map(assets.map(a => [a.id, a.bytes]));
      const visit = (v: unknown) => {
        if (!v || typeof v !== 'object') return;
        const row = v as Record<string, unknown>;
        if ('diskAsset' in row && refs.get(String(row.diskAsset)) !== row.bytes) throw new Error('Unverified audio reference');
        Object.values(row).forEach(visit);
      };
      visit(payload);
      await this.atomicJson(path.join(this.root, 'snapshots', `${snapshot.savedAt}-${snapshot.revision}.json`), snapshot);
      await this.atomicJson(path.join(this.root, 'current.json'), snapshot);
      // Retain recovery checkpoints; never garbage-collect source audio here.
      const names = (await fs.readdir(path.join(this.root, 'snapshots'))).filter(n => n.endsWith('.json')).sort().reverse();
      for (const name of names.slice(20)) await fs.unlink(path.join(this.root, 'snapshots', name)).catch(() => {});
      return snapshot;
    } finally { await release(); }
  }
}
