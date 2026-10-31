import { normalizeSpeechRate } from '../audio/speechTempo';
import { loadDiskDraft, saveDiskDraft } from './draftDisk';
/**
 * Persist unfinished edit drafts (B2) for podcasts including 250MB+ files.
 *
 * Strategy (Chrome / Mac):
 * - Meta (words/ranges/flags) → IndexedDB "meta" (small)
 * - Source audio ≥ 8MB → Origin Private File System (OPFS); never IDB
 * - Source audio < 8MB → IDB "blobs" (fast path)
 * - Never toast-success without verified readable bytes (size match on readback)
 *
 * CRITICAL: never await mid-IDB-transaction.
 */

import type {
  MusicKind,
  MusicPlacement,
  ProjectState,
  TimeRange,
  Word,
} from './types';

const DB_NAME = 'podcut-community-draft' + (new URLSearchParams(globalThis.location?.search ?? '').get('project') ? '-'+new URLSearchParams(globalThis.location?.search ?? '').get('project') : '');
const DB_VER = 2;
const STORE_META = 'meta';
const STORE_BLOBS = 'blobs';
const META_KEY = 'current';
const CANARY_KEY = 'podcut-community-draft-canary';
/** Files at or above this go to OPFS (IDB is unreliable / OOM-prone for 100MB+). */
export const IDB_BLOB_MAX_BYTES = 8 * 1024 * 1024;
const OPFS_DIR = 'podcut-community-sources';

export interface SerializedBuffer {
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  channels: ArrayBuffer[];
}

export interface DraftSourceAudio {
  mime: string;
  blob: Blob;
}

export interface DraftClip {
  legacyDeletionRepairVersion?: number;
  id: string;
  name: string;
  duration: number;
  words: Word[];
  ranges: TimeRange[];
  audioOrder?: TimeRange[];
  gainDb?: number;
  denoised: boolean;
  beautified: boolean;
  clearedPauses?: Array<{ id: string; start: number; end: number }>;
  manualPauses?: Array<{id:string;start:number;end:number;sourceStart:number;sourceEnd:number}>;
  source?: DraftSourceAudio;
  sourceBlobKey?: string;
  /** OPFS file name under podcut-sources/, e.g. clip-c2.bin */
  sourceOpfsName?: string;
  /** Expected byte size for verify / readback */
  sourceBytes?: number;
  clean?: SerializedBuffer;
  current?: SerializedBuffer;
  bufferDirty?: boolean;
}

export interface DraftMusic {
  leadInSec?: number;
  id: string;
  kind: MusicKind;
  name: string;
  libraryId?: string;
  gainDb: number;
  clipId: string;
  originalTime: number;
  wordId?: string;
  anchorSide?: 'before' | 'after';
  inPoint?: number;
  outPoint?: number;
  fadeInSec?: number;
  fadeOutSec?: number;
  source?: DraftSourceAudio;
  sourceBlobKey?: string;
  sourceOpfsName?: string;
  sourceBytes?: number;
  buffer?: SerializedBuffer;
}

export interface DraftPayload {
  speechRate?: number;
  version: 1 | 2;
  savedAt: number;
  audioName: string;
  gainDb: number;
  activeClipId: string | null;
  clipIdSeq: number;
  musicIdSeq: number;
  clips: DraftClip[];
  music: DraftMusic[];
}

export interface DraftClipFailure {
  id: string;
  name: string;
  reason: string;
  sourceBytes?: number;
}

type BlobRow = { key: string; mime: string; blob: Blob };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
      if (!db.objectStoreNames.contains(STORE_BLOBS)) db.createObjectStore(STORE_BLOBS);
      if (!db.objectStoreNames.contains('draft')) db.createObjectStore('draft');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('draft DB open failed'));
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('draft IDB request failed'));
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('draft tx failed'));
    tx.onabort = () => reject(tx.error ?? new Error('draft tx aborted'));
  });
}

function setCanary(savedAt: number, clipCount: number, blobBytes: number): void {
  try {
    localStorage.setItem(
      CANARY_KEY,
      JSON.stringify({ savedAt, clipCount, blobBytes, v: 3 }),
    );
  } catch {
    /* */
  }
}

function clearCanary(): void {
  try {
    localStorage.removeItem(CANARY_KEY);
  } catch {
    /* */
  }
}

function opfsSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.storage?.getDirectory;
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}

function safeOpfsName(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]+/g, '_') + '.bin';
}

async function writeOpfsBlob(
  name: string,
  blob: Blob,
): Promise<{ name: string; bytes: number }> {
  const dir = await opfsRoot();
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
  const file = await handle.getFile();
  if (file.size !== blob.size) {
    throw new Error(
      `OPFS 校验失败：写入 ${blob.size}B，读回 ${file.size}B（${name}）`,
    );
  }
  return { name, bytes: file.size };
}

async function readOpfsBlob(name: string): Promise<Blob | null> {
  try {
    const dir = await opfsRoot();
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    if (!file.size) return null;
    return file;
  } catch {
    return null;
  }
}

async function removeOpfsName(name: string): Promise<void> {
  try {
    const dir = await opfsRoot();
    await dir.removeEntry(name);
  } catch {
    /* */
  }
}

async function listOpfsNames(): Promise<string[]> {
  if (!opfsSupported()) return [];
  try {
    const dir = await opfsRoot();
    const names: string[] = [];
    // @ts-expect-error async iterator on directory handle
    for await (const [name] of dir.entries()) {
      names.push(String(name));
    }
    return names;
  } catch {
    return [];
  }
}

const serializedCache = new WeakMap<AudioBuffer, SerializedBuffer>();
export function serializeAudioBuffer(buf: AudioBuffer): SerializedBuffer {
  const cached = serializedCache.get(buf);
  if (cached) return cached;
  const channels: ArrayBuffer[] = [];
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const src = buf.getChannelData(c);
    channels.push(src.byteOffset === 0 && src.byteLength === src.buffer.byteLength
      ? src.buffer as ArrayBuffer : src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) as ArrayBuffer);
  }
  const result = {
    sampleRate: buf.sampleRate,
    numberOfChannels: buf.numberOfChannels,
    length: buf.length,
    channels,
  };
  serializedCache.set(buf, result);
  return result;
}

export function deserializeAudioBuffer(data: SerializedBuffer): AudioBuffer {
  const buf = new AudioBuffer({
    length: data.length,
    numberOfChannels: data.numberOfChannels,
    sampleRate: data.sampleRate,
  });
  for (let c = 0; c < data.numberOfChannels; c++) {
    const ab = data.channels[c]!;
    const bytes = ab instanceof ArrayBuffer
      ? new Float32Array(ab)
      : new Float32Array((ab as ArrayBufferView).buffer,(ab as ArrayBufferView).byteOffset,(ab as ArrayBufferView).byteLength/4);
    buf.copyToChannel(bytes, c);
  }
  return buf;
}

function clipBlobKey(id: string): string {
  return `clip:${id}`;
}
function musicBlobKey(id: string): string {
  return `music:${id}`;
}

async function writeMetaOnly(meta: DraftPayload): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction(STORE_META, 'readwrite');
    tx.objectStore(STORE_META).put(meta, META_KEY);
    await txDone(tx);
  } finally {
    db.close();
  }
}

async function writeIdbBlobs(blobs: BlobRow[], keepKeys: Set<string>): Promise<void> {
  const db = await openDb();
  try {
    let existing: IDBValidKey[] = [];
    {
      const txList = db.transaction(STORE_BLOBS, 'readonly');
      existing = await idbReq(
        txList.objectStore(STORE_BLOBS).getAllKeys() as IDBRequest<IDBValidKey[]>,
      );
      await txDone(txList).catch(() => undefined);
    }
    const tx = db.transaction(STORE_BLOBS, 'readwrite');
    const store = tx.objectStore(STORE_BLOBS);
    // Previous audio is retained until explicit project clearing.
    void existing; void keepKeys;
    for (const row of blobs) {
      store.put(row, row.key);
    }
    await txDone(tx);
  } finally {
    db.close();
  }
}

async function loadIdbBlobMap(keys: string[]): Promise<Map<string, BlobRow>> {
  const out = new Map<string, BlobRow>();
  if (!keys.length) return out;
  const db = await openDb();
  try {
    if (!db.objectStoreNames.contains(STORE_BLOBS)) return out;
    const unique = [...new Set(keys)];
    const tx = db.transaction(STORE_BLOBS, 'readonly');
    const store = tx.objectStore(STORE_BLOBS);
    const reqs = unique.map((key) =>
      idbReq(store.get(key) as IDBRequest<BlobRow | undefined>).then((br) => ({
        key,
        br,
      })),
    );
    const results = await Promise.all(reqs);
    await txDone(tx).catch(() => undefined);
    for (const { key, br } of results) {
      if (br?.blob && br.blob.size > 0) {
        out.set(key, {
          key,
          mime: br.mime || 'application/octet-stream',
          blob: br.blob,
        });
      }
    }
  } finally {
    db.close();
  }
  return out;
}

/**
 * Persist draft: large audio → OPFS (verified), small → IDB, meta → IDB.
 * Throws if any source cannot be verified readable after write.
 */
export async function saveDraftPayload(payload: DraftPayload): Promise<void> {
  if (await saveDiskDraft(payload)) return;
  const idbBlobs: BlobRow[] = [];
  const keepIdb = new Set<string>();
  const keepOpfs = new Set<string>();
  let totalSourceBytes = 0;

  const clips: DraftClip[] = [];
  for (const c of payload.clips) {
    const row: DraftClip = {
      id: c.id,
      name: c.name,
      duration: c.duration,
      words: c.words,
      ranges: c.ranges,
      audioOrder: c.audioOrder,
      gainDb: c.gainDb ?? 0,
      denoised: c.denoised,
      beautified: c.beautified,
      clearedPauses: c.clearedPauses,
      manualPauses: c.manualPauses?.map(p=>({...p})),
      legacyDeletionRepairVersion: c.legacyDeletionRepairVersion,
      bufferDirty: c.bufferDirty,
      clean: c.clean,
      current: c.current,
    };

    if (c.source?.blob && c.source.blob.size > 0) {
      const bytes = c.source.blob.size;
      totalSourceBytes += bytes;
      const mime = c.source.mime || 'application/octet-stream';
      const key = clipBlobKey(c.id);
      if (bytes >= IDB_BLOB_MAX_BYTES) {
        if (!opfsSupported()) {
          throw new Error(
            '浏览器不支持 OPFS，无法可靠保存大音频草稿，请使用最新 Chrome 或先导出',
          );
        }
        const name = safeOpfsName(`${key}-${crypto.randomUUID()}`);
        const written = await writeOpfsBlob(name, c.source.blob);
        row.sourceOpfsName = written.name;
        row.sourceBytes = written.bytes;
        keepOpfs.add(written.name);
        const probe = await readOpfsBlob(written.name);
        if (!probe || probe.size !== written.bytes) {
          throw new Error(`OPFS 读回失败：${c.name}（${written.name}）`);
        }
      } else {
        idbBlobs.push({ key, mime, blob: c.source.blob });
        keepIdb.add(key);
        row.sourceBlobKey = key;
        row.sourceBytes = bytes;
      }
    } else if (c.sourceOpfsName && c.sourceBytes) {
      row.sourceOpfsName = c.sourceOpfsName;
      row.sourceBytes = c.sourceBytes;
      keepOpfs.add(c.sourceOpfsName);
    } else if (c.sourceBlobKey && c.sourceBytes) {
      row.sourceBlobKey = c.sourceBlobKey;
      row.sourceBytes = c.sourceBytes;
      keepIdb.add(c.sourceBlobKey);
    } else if (!c.clean || !c.current) {
      // No audio at all — allow meta-only only if caller slimmed; still flag
      row.clean = c.clean;
      row.current = c.current;
    }

    clips.push(row);
  }

  const music: DraftMusic[] = [];
  for (const m of payload.music) {
    const row: DraftMusic = {
      id: m.id,
      kind: m.kind,
      name: m.name,
      libraryId: m.libraryId,
      gainDb: m.gainDb,
      clipId: m.clipId,
      originalTime: m.originalTime,
      wordId: m.wordId,
      anchorSide: m.anchorSide,
      leadInSec: m.leadInSec,
      inPoint: m.inPoint,
      outPoint: m.outPoint,
      fadeInSec: m.fadeInSec,
      fadeOutSec: m.fadeOutSec,
      buffer: m.buffer,
    };

    if (m.source?.blob && m.source.blob.size > 0) {
      const bytes = m.source.blob.size;
      totalSourceBytes += bytes;
      const mime = m.source.mime || 'application/octet-stream';
      const key = musicBlobKey(m.id);
      if (bytes >= IDB_BLOB_MAX_BYTES) {
        if (!opfsSupported()) {
          throw new Error('浏览器不支持 OPFS，无法保存大配乐草稿');
        }
        const name = safeOpfsName(`${key}-${crypto.randomUUID()}`);
        const written = await writeOpfsBlob(name, m.source.blob);
        row.sourceOpfsName = written.name;
        row.sourceBytes = written.bytes;
        keepOpfs.add(written.name);
        const probe = await readOpfsBlob(written.name);
        if (!probe || probe.size !== written.bytes) {
          throw new Error(`OPFS 读回失败：配乐 ${m.name}`);
        }
      } else {
        idbBlobs.push({ key, mime, blob: m.source.blob });
        keepIdb.add(key);
        row.sourceBlobKey = key;
        row.sourceBytes = bytes;
      }
    } else if (m.sourceOpfsName && m.sourceBytes) {
      row.sourceOpfsName = m.sourceOpfsName;
      row.sourceBytes = m.sourceBytes;
      keepOpfs.add(m.sourceOpfsName);
    } else if (m.sourceBlobKey) {
      row.sourceBlobKey = m.sourceBlobKey;
      row.sourceBytes = m.sourceBytes;
      keepIdb.add(m.sourceBlobKey);
    }

    music.push(row);
  }

  const meta: DraftPayload = {
    ...payload,
    version: 2,
    clips,
    music,
  };

  await writeIdbBlobs(idbBlobs, keepIdb);
  await writeMetaOnly(meta);

  // Keep prior immutable OPFS sources for recovery; do not purge on save.

  // Clear legacy single-store
  try {
    const db2 = await openDb();
    if (db2.objectStoreNames.contains('draft')) {
      const tx2 = db2.transaction('draft', 'readwrite');
      tx2.objectStore('draft').delete('current');
      await txDone(tx2).catch(() => undefined);
    }
    db2.close();
  } catch {
    /* */
  }

  setCanary(meta.savedAt, meta.clips.length, totalSourceBytes);
}

async function loadLegacyDraft(db: IDBDatabase): Promise<DraftPayload | null> {
  if (!db.objectStoreNames.contains('draft')) return null;
  const tx = db.transaction('draft', 'readonly');
  const row = await idbReq(
    tx.objectStore('draft').get('current') as IDBRequest<DraftPayload | undefined>,
  );
  await txDone(tx).catch(() => undefined);
  if (!row) return null;
  if (row.version !== 1 && row.version !== 2) return null;
  return row;
}

export async function loadDraftPayload(): Promise<DraftPayload | null> {
  const disk = await loadDiskDraft();
  if (disk.initialized) return disk.payload;
  const db = await openDb();
  let meta: DraftPayload | null = null;
  try {
    if (db.objectStoreNames.contains(STORE_META)) {
      const tx = db.transaction(STORE_META, 'readonly');
      const row = await idbReq(
        tx.objectStore(STORE_META).get(META_KEY) as IDBRequest<DraftPayload | undefined>,
      );
      await txDone(tx).catch(() => undefined);
      if (row && (row.version === 1 || row.version === 2)) meta = row;
    }
    if (!meta?.clips?.length) {
      meta = await loadLegacyDraft(db);
    }
  } finally {
    db.close();
  }

  if (!meta?.clips?.length) return null;

  const idbKeys: string[] = [];
  for (const c of meta.clips) {
    if (!c.source?.blob && c.sourceBlobKey && !c.sourceOpfsName) {
      idbKeys.push(c.sourceBlobKey);
    }
  }
  for (const m of meta.music) {
    if (!m.source?.blob && m.sourceBlobKey && !m.sourceOpfsName) {
      idbKeys.push(m.sourceBlobKey);
    }
  }
  const blobMap = await loadIdbBlobMap(idbKeys);

  const clips: DraftClip[] = [];
  for (const c of meta.clips) {
    if (c.source?.blob && c.source.blob.size > 0) {
      clips.push(c);
      continue;
    }
    if (c.sourceOpfsName) {
      const file = await readOpfsBlob(c.sourceOpfsName);
      if (file && file.size > 0) {
        if (c.sourceBytes && file.size !== c.sourceBytes) {
          console.warn('OPFS size mismatch', c.id, file.size, c.sourceBytes);
        }
        clips.push({
          ...c,
          source: {
            mime: (file as File).type || 'application/octet-stream',
            blob: file,
          },
        });
        continue;
      }
    }
    if (c.sourceBlobKey) {
      const br = blobMap.get(c.sourceBlobKey);
      if (br) {
        clips.push({
          ...c,
          source: { mime: br.mime, blob: br.blob },
        });
        continue;
      }
    }
    clips.push(c);
  }

  const music: DraftMusic[] = [];
  for (const m of meta.music) {
    if (m.source?.blob && m.source.blob.size > 0) {
      music.push(m);
      continue;
    }
    if (m.sourceOpfsName) {
      const file = await readOpfsBlob(m.sourceOpfsName);
      if (file && file.size > 0) {
        music.push({
          ...m,
          source: {
            mime: (file as File).type || 'application/octet-stream',
            blob: file,
          },
        });
        continue;
      }
    }
    if (m.sourceBlobKey) {
      const br = blobMap.get(m.sourceBlobKey);
      if (br) {
        music.push({ ...m, source: { mime: br.mime, blob: br.blob } });
        continue;
      }
    }
    music.push(m);
  }

  return { ...meta, clips, music };
}

/** Every clip has source bytes on disk/IDB or PCM snapshot (after loadDraftPayload). */
export function draftHasPlayableAudio(draft: DraftPayload): boolean {
  if (!draft.clips?.length) return false;
  return draft.clips.every(
    (c) =>
      (c.source?.blob && c.source.blob.size > 0) ||
      (c.clean != null && c.current != null),
  );
}

/**
 * Strong verify used before success toast: re-open OPFS/IDB and check sizes.
 */
export async function verifyDraftSources(draft: DraftPayload): Promise<{
  ok: boolean;
  detail: string;
}> {
  for (const c of draft.clips) {
    const expected = c.sourceBytes || c.source?.blob?.size || 0;
    if (c.clean && c.current && !expected) continue;

    if (c.sourceOpfsName) {
      const file = await readOpfsBlob(c.sourceOpfsName);
      if (!file) return { ok: false, detail: `OPFS 缺失：${c.name}` };
      if (expected && file.size !== expected) {
        return {
          ok: false,
          detail: `OPFS 大小不符：${c.name} ${file.size}/${expected}`,
        };
      }
      continue;
    }

    if (c.sourceBlobKey) {
      const map = await loadIdbBlobMap([c.sourceBlobKey]);
      const br = map.get(c.sourceBlobKey);
      if (!br?.blob?.size) return { ok: false, detail: `IDB 缺失：${c.name}` };
      if (expected && br.blob.size !== expected) {
        return {
          ok: false,
          detail: `IDB 大小不符：${c.name} ${br.blob.size}/${expected}`,
        };
      }
      continue;
    }

    if (c.source?.blob?.size) continue;
    if (c.clean && c.current) continue;
    return { ok: false, detail: `无音频：${c.name}` };
  }
  return { ok: true, detail: 'ok' };
}

export async function clearDraftPayload(): Promise<void> {
  // A durable tombstone prevents old browser drafts from reappearing.
  const diskCleared = await saveDiskDraft(null);
  if (diskCleared) { clearCanary(); return; }
  const db = await openDb();
  try {
    const names = [STORE_META, STORE_BLOBS, 'draft'].filter((n) =>
      db.objectStoreNames.contains(n),
    );
    if (names.length) {
      const tx = db.transaction(names, 'readwrite');
      if (names.includes(STORE_META)) tx.objectStore(STORE_META).delete(META_KEY);
      if (names.includes(STORE_BLOBS)) tx.objectStore(STORE_BLOBS).clear();
      if (names.includes('draft')) tx.objectStore('draft').delete('current');
      await txDone(tx);
    }
  } finally {
    db.close();
  }
  if (opfsSupported()) {
    const existing = await listOpfsNames();
    for (const name of existing) await removeOpfsName(name);
  }
  clearCanary();
}

/** Remove one corrupt clip's audio from OPFS/IDB; keep other clips. */
export async function purgeClipSource(clipId: string): Promise<void> {
  const draft = await loadDraftPayload();
  if (!draft) return;
  const clip = draft.clips.find((c) => c.id === clipId);
  if (clip?.sourceOpfsName) await removeOpfsName(clip.sourceOpfsName);
  draft.clips = draft.clips.filter((c) => c.id !== clipId);
  if (draft.activeClipId === clipId) {
    draft.activeClipId = draft.clips[0]?.id ?? null;
  }
  // Re-save without this clip's source (meta only for remaining)
  const payload: DraftPayload = {
    ...draft,
    clips: draft.clips.map((c) => {
      const { source: _s, ...rest } = c;
      return rest;
    }),
    music: draft.music.filter((m) => m.clipId !== clipId).map((m) => {
      const { source: _s, ...rest } = m;
      return rest;
    }),
  };
  // Reload blobs from disk keys already on rows
  await saveDraftPayload({
    ...payload,
    clips: await Promise.all(
      payload.clips.map(async (c) => {
        if (c.sourceOpfsName) {
          const f = await readOpfsBlob(c.sourceOpfsName);
          if (f) return { ...c, source: { mime: 'application/octet-stream', blob: f } };
        }
        if (c.sourceBlobKey) {
          const map = await loadIdbBlobMap([c.sourceBlobKey]);
          const br = map.get(c.sourceBlobKey);
          if (br) return { ...c, source: { mime: br.mime, blob: br.blob } };
        }
        return c;
      }),
    ),
  });
}

export function estimateDraftBytes(payload: DraftPayload): number {
  let n = 2048;
  for (const c of payload.clips) {
    if (c.source?.blob) n += c.source.blob.size;
    else if (c.sourceBytes) n += c.sourceBytes;
    if (c.clean) n += c.clean.length * c.clean.numberOfChannels * 4;
    if (c.current) n += c.current.length * c.current.numberOfChannels * 4;
    n += JSON.stringify(c.words).length;
  }
  for (const m of payload.music) {
    if (m.source?.blob) n += m.source.blob.size;
    if (m.buffer) n += m.buffer.length * m.buffer.numberOfChannels * 4;
  }
  return n;
}

export function slimDraftForQuota(payload: DraftPayload): DraftPayload {
  return {
    ...payload,
    version: 2,
    clips: payload.clips.map((c) => {
      const next: DraftClip = {
        id: c.id,
        name: c.name,
        duration: c.duration,
        words: c.words,
        ranges: c.ranges,
      audioOrder: c.audioOrder,
        gainDb: c.gainDb ?? 0,
      denoised: c.denoised,
        beautified: c.beautified,
        clearedPauses: c.clearedPauses,
      manualPauses: c.manualPauses?.map(p=>({...p})),
      legacyDeletionRepairVersion: c.legacyDeletionRepairVersion,
        source: c.source,
        bufferDirty: false,
      };
      if (!c.source || c.bufferDirty) {
        next.source = undefined;
        next.clean = c.clean;
        next.current = c.current;
        next.bufferDirty = c.bufferDirty;
      }
      return next;
    }),
    music: payload.music.map((m) => {
      const next: DraftMusic = {
        id: m.id,
        kind: m.kind,
        name: m.name,
        libraryId: m.libraryId,
        gainDb: m.gainDb,
        clipId: m.clipId,
        originalTime: m.originalTime,
        wordId: m.wordId,
      anchorSide: m.anchorSide,
      leadInSec: m.leadInSec,
        inPoint: m.inPoint,
        outPoint: m.outPoint,
        fadeInSec: m.fadeInSec,
        fadeOutSec: m.fadeOutSec,
        source: m.source,
      };
      if (!m.source) next.buffer = m.buffer;
      return next;
    }),
  };
}

type ClipRuntime = ProjectState['clips'][number] & {
  sourceBlob?: Blob;
  sourceMime?: string;
  bufferDirty?: boolean;
};

type MusicRuntime = MusicPlacement & {
  sourceBlob?: Blob;
  sourceMime?: string;
};

export function projectToDraft(opts: {
  project: ProjectState;
  activeClipId: string | null;
  clipIdSeq: number;
  musicIdSeq: number;
}): DraftPayload {
  const { project, activeClipId, clipIdSeq, musicIdSeq } = opts;
  return {
    version: 2,
    savedAt: Date.now(),
    audioName: project.audioName,
    gainDb: project.gainDb,
    speechRate: normalizeSpeechRate(project.speechRate),
    activeClipId,
    clipIdSeq,
    musicIdSeq,
    clips: project.clips.map((raw) => {
      const c = raw as ClipRuntime;
      const dirty = Boolean(c.bufferDirty);
      const source =
        c.sourceBlob && c.sourceBlob.size > 0
          ? {
              mime: c.sourceMime || c.sourceBlob.type || 'application/octet-stream',
              blob: c.sourceBlob,
            }
          : undefined;
      const row: DraftClip = {
        id: c.id,
        name: c.name,
        duration: c.duration,
        words: c.words.map((w) => ({ ...w })),
        ranges: c.ranges.map((r) => ({ ...r })),
      audioOrder: c.audioOrder?.map(r => ({...r})),
        gainDb: c.gainDb ?? 0,
      denoised: c.denoised,
        beautified: c.beautified,
        clearedPauses: (c.clearedPauses ?? []).map((p) => ({ ...p })),
      manualPauses: c.manualPauses?.map(p=>({...p})),
      legacyDeletionRepairVersion: c.legacyDeletionRepairVersion,
        source,
        sourceBytes: source?.blob.size,
        bufferDirty: dirty,
      };
      if (!source || dirty || c.denoised || c.beautified) {
        row.source = undefined;
        row.clean = serializeAudioBuffer(c.cleanBuffer);
        row.current = serializeAudioBuffer(c.buffer);
      }
      return row;
    }),
    music: (project.music ?? []).map((raw) => {
      const m = raw as MusicRuntime;
      const source =
        m.sourceBlob && m.sourceBlob.size > 0
          ? {
              mime: m.sourceMime || m.sourceBlob.type || 'application/octet-stream',
              blob: m.sourceBlob,
            }
          : undefined;
      const row: DraftMusic = {
        id: m.id,
        kind: m.kind,
        name: m.name,
        libraryId: m.libraryId,
        gainDb: m.gainDb,
        clipId: m.clipId,
        originalTime: m.originalTime,
        wordId: m.wordId,
      anchorSide: m.anchorSide,
      leadInSec: m.leadInSec,
        inPoint: m.inPoint,
        outPoint: m.outPoint,
        fadeInSec: m.fadeInSec,
        fadeOutSec: m.fadeOutSec,
        source,
        sourceBytes: source?.blob.size,
      };
      if (!source) {
        row.buffer = serializeAudioBuffer(m.buffer);
      }
      return row;
    }),
  };
}

export type DraftDecodeFn = (data: ArrayBuffer) => Promise<AudioBuffer>;
export type DraftSfxLoader = (libraryId: string) => Promise<Blob | null>;

async function bufferFromSource(
  source: DraftSourceAudio,
  decode: DraftDecodeFn,
): Promise<AudioBuffer> {
  // One ArrayBuffer only — do not keep extra copies (259MB+ OOM).
  const ab = await source.blob.arrayBuffer();
  return decode(ab);
}

export async function draftToProject(
  draft: DraftPayload,
  opts: {
    decode: DraftDecodeFn;
    loadSfxBlob?: DraftSfxLoader;
    applyFx?: (
      clean: AudioBuffer,
      flags: { denoise: boolean; beautify: boolean },
    ) => Promise<AudioBuffer>;
  },
): Promise<{
  project: ProjectState;
  activeClipId: string | null;
  clipIdSeq: number;
  musicIdSeq: number;
  failedClips: DraftClipFailure[];
}> {
  const { decode, loadSfxBlob, applyFx } = opts;
  // Teasers and body may share one immutable source. Decode it only once.
  const decodedSources=new WeakMap<Blob,Promise<AudioBuffer>>();
  const readSource=(source:DraftSourceAudio)=>{let value=decodedSources.get(source.blob);if(!value){value=bufferFromSource(source,decode);decodedSources.set(source.blob,value);}return value;};
  const clips: ClipRuntime[] = [];
  const failedClips: DraftClipFailure[] = [];

  for (const c of draft.clips) {
    let cleanBuffer: AudioBuffer | null = null;
    let buffer: AudioBuffer | null = null;
    let sourceBlob: Blob | undefined;
    let sourceMime: string | undefined;
    let lastErr = '';

    if (c.source?.blob && c.source.blob.size > 0) {
      try {
        cleanBuffer = await readSource(c.source);
        sourceBlob = c.source.blob;
        sourceMime = c.source.mime;
        if ((c.denoised || c.beautified) && applyFx) {
          buffer = await applyFx(cleanBuffer, {
            denoise: c.denoised,
            beautify: c.beautified,
          });
        } else {
          buffer = cleanBuffer;
        }
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
        console.warn('draft clip source decode failed', c.id, e);
        cleanBuffer = null;
        buffer = null;
      }
    }

    if (!cleanBuffer || !buffer) {
      if (c.clean && c.current) {
        try {
          cleanBuffer = deserializeAudioBuffer(c.clean);
          const same = c.clean.sampleRate===c.current.sampleRate&&c.clean.length===c.current.length&&c.clean.numberOfChannels===c.current.numberOfChannels&&c.clean.channels.every((ch,i)=>ch===c.current!.channels[i]);
          buffer = same ? cleanBuffer : deserializeAudioBuffer(c.current);
          if (c.source?.blob) {
            sourceBlob = c.source.blob;
            sourceMime = c.source.mime;
          }
        } catch (e) {
          lastErr = e instanceof Error ? e.message : String(e);
          cleanBuffer = null;
          buffer = null;
        }
      }
    }

    if (!cleanBuffer || !buffer) {
      failedClips.push({
        id: c.id,
        name: c.name,
        reason:
          lastErr ||
          `缺少可解码音频（blob=${c.source?.blob?.size ?? 0}B, opfs=${c.sourceOpfsName || '—'}）`,
        sourceBytes: c.source?.blob?.size || c.sourceBytes,
      });
      continue;
    }

    clips.push({
      id: c.id,
      name: c.name,
      duration: c.duration,
      words: c.words.map((w) => ({ ...w })),
      ranges: c.ranges.map((r) => ({ ...r })),
      audioOrder: c.audioOrder?.map(r => ({...r})),
      gainDb: (c.gainDb ?? 0) + (Number.isFinite(draft.gainDb) ? draft.gainDb : 0),
      denoised: c.denoised,
      beautified: c.beautified,
      clearedPauses: (c.clearedPauses ?? []).map((p) => ({ ...p })),
      manualPauses: c.manualPauses?.map(p=>({...p})),
      legacyDeletionRepairVersion: c.legacyDeletionRepairVersion,
      cleanBuffer,
      buffer,
      sourceBlob,
      sourceMime,
      bufferDirty: Boolean(c.bufferDirty),
    });
  }

  if (clips.length === 0) {
    const first = failedClips[0];
    throw new Error(
      first
        ? `草稿片段「${first.name}」恢复失败：${first.reason}`
        : '草稿中没有可恢复的片段',
    );
  }

  const music: MusicRuntime[] = [];
  const okClipIds = new Set(clips.map((c) => c.id));
  for (const m of draft.music) {
    if (!okClipIds.has(m.clipId)) continue;
    let buffer: AudioBuffer | null = null;
    let sourceBlob: Blob | undefined;
    let sourceMime: string | undefined;

    if (m.libraryId && loadSfxBlob) {
      try {
        const libBlob = await loadSfxBlob(m.libraryId);
        if (libBlob) {
          buffer = await decode(await libBlob.arrayBuffer());
          sourceBlob = libBlob;
          sourceMime = libBlob.type || 'audio/wav';
        }
      } catch (e) {
        console.warn('draft music library reload failed', m.id, e);
      }
    }

    if (!buffer && m.source?.blob && m.source.blob.size > 0) {
      try {
        buffer = await readSource(m.source);
        sourceBlob = m.source.blob;
        sourceMime = m.source.mime;
      } catch (e) {
        console.warn('draft music source decode failed', m.id, e);
      }
    }

    if (!buffer && m.buffer) {
      buffer = deserializeAudioBuffer(m.buffer);
    }

    if (!buffer) continue;

    music.push({
      id: m.id,
      kind: m.kind,
      name: m.name,
      libraryId: m.libraryId,
      gainDb: m.gainDb,
      clipId: m.clipId,
      originalTime: m.originalTime,
      wordId: m.wordId,
      anchorSide: m.anchorSide,
      leadInSec: m.leadInSec,
      inPoint: m.inPoint,
      outPoint: m.outPoint,
      fadeInSec: m.fadeInSec,
      fadeOutSec: m.fadeOutSec,
      buffer,
      sourceBlob,
      sourceMime,
    });
  }

  let activeClipId = draft.activeClipId;
  if (!activeClipId || !okClipIds.has(activeClipId)) {
    activeClipId = clips[0]?.id ?? null;
  }

  return {
    project: {
      clips,
      gainDb: 0, // Legacy project gain now belongs to speech clips only.
      audioName: draft.audioName,
      speechRate: normalizeSpeechRate(draft.speechRate),
      music,
    },
    activeClipId,
    clipIdSeq: draft.clipIdSeq,
    musicIdSeq: draft.musicIdSeq,
    failedClips,
  };
}
