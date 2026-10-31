import type { DraftPayload } from './draftStore';
interface Asset { id: string; bytes: number }
interface Snapshot { revision: string; savedAt: number; payload: unknown; assets: Asset[] }
const projectId=new URLSearchParams(globalThis.location?.search??'').get('project');
let session: {token:string} | null = null;
let revision: string | null | undefined;
const uploaded = new WeakMap<object, Asset>();
let lastStorage: 'disk' | 'browser' = 'browser';
export function draftRevision() { return revision; }
export function draftStorageKind() { return lastStorage; }
async function connect(): Promise<boolean> {
  if (session) return true;
  const res = await fetch('/api/draft/session',{cache:'no-store',signal:AbortSignal.timeout(10000)});
  if (res.status === 404 || !res.headers.get('content-type')?.includes('application/json')) return false;
  if (!res.ok) throw new Error(`本机草稿服务不可用（${res.status}）`);
  const value = await res.json();
  if (value.protocol !== 1 || typeof value.token !== 'string') return false;
  session = value; return true;
}
async function request(path: string, init: RequestInit = {}, retry = true): Promise<Response> {
  if (!await connect()) throw new Error('本机草稿服务未启动');
  const headers = new Headers(init.headers); headers.set('X-Draft-Token', session!.token);if(projectId)headers.set('X-Project-Id',projectId);
  const res = await fetch(`/api/draft/${path}`,{...init,headers,cache:'no-store',signal:AbortSignal.timeout(180000)});
  if (res.status === 401 && retry) { session=null; return request(path,init,false); }
  if (!res.ok) {
    const body=await res.json().catch(()=>({}));
    throw new Error(body.error || `本机草稿读写失败（${res.status}）`);
  }
  return res;
}
export async function saveDiskDraft(payload: DraftPayload | null): Promise<boolean> {
  if (!await connect()) {if(projectId)throw Error('独立项目需要本机草稿服务');return false;}
  if (revision === undefined) {
    const state = await (await request('current')).json(); revision = state.snapshot?.revision ?? null;
  }
  if (payload) {
    for (const clip of payload.clips) {
      if (!clip.source?.blob?.size && !(clip.clean?.channels?.length && clip.current?.channels?.length)) throw new Error(`缺少音频字节：${clip.name}，原草稿未覆盖`);
    }
    for (const music of payload.music) {
      if (!music.source?.blob?.size && !music.buffer?.channels?.length) throw new Error(`配乐缺少音频字节：${music.name}`);
    }
  }
  const assets = new Map<string,Asset>();
  async function encode(value: unknown): Promise<unknown> {
    if (value instanceof Blob || value instanceof ArrayBuffer) {
      let asset=uploaded.get(value);
      if (!asset) {
        const body = value instanceof Blob ? value : new Blob([value]);
        asset=await(await request('asset',{method:'POST',body})).json() as Asset;
        if (asset.bytes !== body.size || !/^[a-f0-9]{64}$/.test(asset.id)) throw new Error('本机音频写入校验不通过');
        uploaded.set(value,asset);
      }
      assets.set(asset.id,asset);
      return { diskAsset:asset.id,bytes:asset.bytes,kind:value instanceof Blob?'blob':'arraybuffer',mime:value instanceof Blob?value.type:undefined };
    }
    if (Array.isArray(value)) { const out=[]; for (const item of value) out.push(await encode(item)); return out; }
    if (value && typeof value === 'object') {
      const out: Record<string,unknown>={};
      for (const [key,item] of Object.entries(value)) {
        // Legacy browser references do not apply to an independent disk copy.
        if (['sourceOpfsName','sourceBlobKey'].includes(key)) continue;
        if (item !== undefined) out[key]=await encode(item);
      }
      return out;
    }
    return value;
  }
  const encoded=await encode(payload);
  const receipt=await(await request('current',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({payload:encoded,assets:[...assets.values()],expectedRevision:revision})})).json();
  if (typeof receipt.revision !== 'string' || receipt.assetCount !== assets.size) throw new Error('本机草稿提交校验不通过');
  revision=receipt.revision;lastStorage='disk';return true;
}
export async function loadDiskDraft(): Promise<{available:boolean; initialized:boolean; payload:DraftPayload|null; recovered?:boolean}> {
  if (!await connect()) {if(projectId)throw Error('独立项目需要本机草稿服务');return {available:false,initialized:false,payload:null};}
  const state=await(await request('current')).json() as {snapshot:Snapshot|null;recovered:boolean};
  revision=state.snapshot?.revision??null;
  if (!state.snapshot) return {available:true,initialized:false,payload:null};
  const assetMap=new Map(state.snapshot.assets.map(a=>[a.id,a]));
  const decoded=new Map<string,Blob|ArrayBuffer>();
  async function decode(value: unknown): Promise<any> {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) { const out=[];for(const item of value)out.push(await decode(item));return out; }
    const row=value as Record<string,any>;
    if (typeof row.diskAsset==='string') {
      const asset=assetMap.get(row.diskAsset);
      if (!asset || asset.bytes!==row.bytes) throw new Error('草稿含未验证音频引用');
      const key=`${asset.id}:${row.kind}`;
      let bytes=decoded.get(key);
      if (!bytes) {
        const res=await request(`asset/${asset.id}`);
        bytes=row.kind==='blob'?new Blob([await res.blob()],{type:row.mime||'application/octet-stream'}):await res.arrayBuffer();
        if ((bytes instanceof Blob?bytes.size:bytes.byteLength)!==asset.bytes) throw new Error('本机草稿音频读取不完整');
        decoded.set(key,bytes);uploaded.set(bytes,asset);
      }
      return bytes;
    }
    const out:Record<string,unknown>={};for(const [key,item] of Object.entries(row))out[key]=await decode(item);return out;
  }
  const payload=await decode(state.snapshot.payload) as DraftPayload|null;
  lastStorage='disk';return {available:true,initialized:true,payload,recovered:state.recovered};
}
