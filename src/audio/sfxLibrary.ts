/**
 * IndexedDB library for reusable music / SFX (blobs + metadata).
 * Tags: 开头 / 过场 / 结尾 / 自定义
 */

export type SfxTag = '开头' | '过场' | '结尾' | '自定义';

export const SFX_TAGS: SfxTag[] = ['开头', '过场', '结尾', '自定义'];

export interface SfxLibraryMeta {
  id: string;
  name: string;
  tag: SfxTag;
  duration: number;
  createdAt: number;
  mime: string;
}

const DB_NAME = 'podcut-community-sfx';
const DB_VER = 1;
const STORE_META = 'meta';
const STORE_BLOB = 'blobs';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_BLOB)) {
        db.createObjectStore(STORE_BLOB, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export async function listSfxLibrary(): Promise<SfxLibraryMeta[]> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_META, 'readonly');
    const all = await idbReq(tx.objectStore(STORE_META).getAll() as IDBRequest<SfxLibraryMeta[]>);
    return (all ?? []).sort((a, b) => b.createdAt - a.createdAt);
  } finally {
    db.close();
  }
}

export async function getSfxBlob(id: string): Promise<Blob | null> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_BLOB, 'readonly');
    const row = await idbReq(
      tx.objectStore(STORE_BLOB).get(id) as IDBRequest<{ id: string; blob: Blob } | undefined>,
    );
    return row?.blob ?? null;
  } finally {
    db.close();
  }
}

export async function addSfxToLibrary(opts: {
  name: string;
  tag: SfxTag;
  blob: Blob;
  duration: number;
}): Promise<SfxLibraryMeta> {
  const id = `sfx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const meta: SfxLibraryMeta = {
    id,
    name: opts.name || '未命名',
    tag: opts.tag,
    duration: opts.duration,
    createdAt: Date.now(),
    mime: opts.blob.type || 'audio/wav',
  };
  const db = await openDb();
  try {
    const tx = db.transaction([STORE_META, STORE_BLOB], 'readwrite');
    tx.objectStore(STORE_META).put(meta);
    tx.objectStore(STORE_BLOB).put({ id, blob: opts.blob });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('save failed'));
    });
  } finally {
    db.close();
  }
  return meta;
}

export async function updateSfxMeta(
  id: string,
  patch: Partial<Pick<SfxLibraryMeta, 'name' | 'tag'>>,
): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_META, 'readwrite');
    const store = tx.objectStore(STORE_META);
    const cur = await idbReq(store.get(id) as IDBRequest<SfxLibraryMeta | undefined>);
    if (!cur) return;
    store.put({ ...cur, ...patch });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('update failed'));
    });
  } finally {
    db.close();
  }
}

export async function deleteSfxFromLibrary(id: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction([STORE_META, STORE_BLOB], 'readwrite');
    tx.objectStore(STORE_META).delete(id);
    tx.objectStore(STORE_BLOB).delete(id);
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('delete failed'));
    });
  } finally {
    db.close();
  }
}

/** Bundled demo beds under /public/sfx (original synthesis, not stock). */
export interface DemoSfxSpec {
  /** Public URL path, e.g. /sfx/opening-tech.wav */
  url: string;
  name: string;
  tag: SfxTag;
}

export const DEMO_SFX: DemoSfxSpec[] = [
  { url: '/sfx/opening-tech.wav', name: '科技开场', tag: '开头' },
  { url: '/sfx/transition-tech.wav', name: '科技过场', tag: '过场' },
  { url: '/sfx/ending-tech.wav', name: '科技结尾', tag: '结尾' },
];

const DEMO_SEED_FLAG = 'podcast-cutter-demo-sfx-seeded-v1';

export function wasDemoSfxSeeded(): boolean {
  try {
    return localStorage.getItem(DEMO_SEED_FLAG) === '1';
  } catch {
    return false;
  }
}

export function markDemoSfxSeeded(): void {
  try {
    localStorage.setItem(DEMO_SEED_FLAG, '1');
  } catch {
    /* ignore */
  }
}
