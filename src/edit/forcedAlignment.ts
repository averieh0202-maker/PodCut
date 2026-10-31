import { deleteWordRuns } from './deleteRuns';
import type { Clip, Word } from './types';
import { isPunctText } from './alignment';
import { addRange, removeRange } from './timeline';
import { ensureAudioOrder } from './audioOrder';

export interface AlignedToken { text: string; start: number; end: number; review?: boolean; source?: 'fa-zh' }
export interface AlignmentChunk { start: number; end: number; words: Word[]; coreIds: string[] }
export interface BoundaryProposal { id: string; start: number; end: number; review?: boolean; source?: 'fa-zh' }
export const alignmentText = (s: string) => s.normalize('NFC').replace(/[^\p{L}\p{N}']/gu, '').toLowerCase();

/** Always align source order, including deleted words. Small overlapping windows
 * keep model memory bounded; surrounding words anchor each chunk's edges. */
export function alignmentChunks(words: Word[], duration: number): AlignmentChunk[] {
  const ordered = words.filter(w => alignmentText(w.text)).sort((a,b) => a.start-b.start || a.end-b.end);
  const chunks: AlignmentChunk[] = [];
  for (let i=0; i<ordered.length;) {
    let j=i+1;
    while(j<ordered.length && ordered[j].end-ordered[i].start<24 && j-i<180) {
      if (ordered[j-1].end-ordered[i].start>12 && (ordered[j].start-ordered[j-1].end>0.35 || ordered[j-1].breakAfter)) break;
      j++;
    }
    // Only include nearby source context, not distant unrelated material.
    const lo = i>0 && ordered[i].start-ordered[i-1].end<0.6 ? i-1 : i;
    const hi = j<ordered.length && ordered[j].start-ordered[j-1].end<0.6 ? j+1 : j;
    const group=ordered.slice(lo,hi);
    const start=Math.max(0,group[0].start-0.4), end=Math.min(duration,group.at(-1)!.end+0.4);
    if (end-start>39 || end<=start) throw new Error('原转写时间跨度异常，需重新转写后对齐');
    chunks.push({start,end,words:group,coreIds:ordered.slice(i,j).map(w=>w.id)});
    i=j;
  }
  return chunks;
}

/** Match the entire token sequence exactly, never distribute a larger timestamp
 * evenly or guess a matching repeated character by nearest position. */
export function mapAlignedTokens(chunk: AlignmentChunk, tokens: AlignedToken[]): BoundaryProposal[] {
  const input=chunk.words.map(w=>alignmentText(w.text));
  const output=tokens.map(w=>alignmentText(w.text));
  if (output.some(t=>!t) || input.join('')!==output.join('')) throw new Error('模型文字与原文不一致，保留原字界');
  let p=0, previous=0;
  for (const t of tokens) {
    if (![t.start,t.end].every(Number.isFinite) || t.start<previous-0.001 || t.end<t.start || t.end>chunk.end-chunk.start+0.03) throw new Error('模型时间顺序异常，保留原字界');
    previous=t.end;
  }
  const out: BoundaryProposal[]=[];
  for(let i=0;i<input.length;i++) {
    const first=p; let text='';
    while(text.length<input[i].length && p<output.length) text+=output[p++];
    if(text!==input[i]) throw new Error('模型未返回独立字界，保留原字界');
    if(chunk.coreIds.includes(chunk.words[i].id)) out.push({id:chunk.words[i].id,start:chunk.start+tokens[first].start,end:Math.min(chunk.end,chunk.start+tokens[p-1].end), ...(tokens.slice(first,p).some(t=>t.review) ? {review:true} : {}), ...(tokens.slice(first,p).some(t=>t.source==='fa-zh') ? {source:'fa-zh' as const} : {})});
  }
  return out;
}

export function alignmentFingerprint(clip: Pick<Clip,'words'|'ranges'|'audioOrder'|'clearedPauses'|'duration'|'manualPauses'>): string {
  return JSON.stringify([clip.words,clip.ranges,clip.audioOrder,clip.clearedPauses,clip.duration,clip.manualPauses]);
}

/** Prepare an atomic result. Preserve manual boundaries, timeline order, silence
 * cuts and arbitrary audio cuts; re-position only cuts owned by changed words. */
export function applyForcedAlignment(clip: Clip, proposals: BoundaryProposal[]) {
  const result = { ...clip, words:clip.words.map(w=>({...w,removedAudio:w.removedAudio?.map(r=>({...r}))})), ranges:clip.ranges.map(r=>({...r})), audioOrder:clip.audioOrder?.map(r=>({...r})) };
  ensureAudioOrder(result);
  const byId=new Map(proposals.map(p=>[p.id,p]));
  const changed = new Set<string>();
  let skipped=0, manual=0;
  const ordered=[...clip.words].filter(w=>!isPunctText(w.text)).sort((a,b)=>a.start-b.start || a.end-b.end);
  const accepted=new Map<string,BoundaryProposal>();
  for(const w of ordered) {
    if(w.manualBoundary) { manual++; continue; }
    const p=byId.get(w.id); if(!p) { skipped++;continue; }
    const span=p.end-p.start;
    if (p.review || ![p.start,p.end].every(Number.isFinite) || p.start<0 || p.end>clip.duration+1e-6 || span<0.02-1e-6 || span>Math.max(2,alignmentText(w.text).length*1.2)) { skipped++; continue; }
    accepted.set(w.id,p);
  }
  // Reject conflicts against retained/manual neighbours as well as chunk seams.
  // Repeat until removing a candidate no longer introduces a new conflict.
  let again=true;
  while(again) {
    again=false;
    for(let i=1;i<ordered.length;i++) {
      const a=ordered[i-1], b=ordered[i], pa=accepted.get(a.id),pb=accepted.get(b.id);
      if ((pa?.end??a.end)>(pb?.start??b.start)+0.001) {
        if(pa){accepted.delete(a.id);skipped++;again=true;}
        if(pb){accepted.delete(b.id);skipped++;again=true;}
      }
    }
  }
  for(const w of result.words) {
    const p=accepted.get(w.id); if(!p) { if (!w.manualBoundary && !isPunctText(w.text)) w.alignmentReview = true; continue; }
    changed.add(w.id);
    if(w.deleted && w.joinedCut===undefined && !w.manualBoundary && w.removedAudio?.some(r=>r.start<w.start-.025 || r.end>w.end+.025)) w.joinedCut=true;
    if(w.deleted&&!w.continuousCut&&!w.joinedCut) for(const r of w.removedAudio??[{start:w.start,end:w.end}]) result.ranges=addRange(result.ranges,r.start,r.end);
    w.start=p.start;w.end=p.end;w.estimated=false;w.alignmentSource=p.source ?? 'qwen3';w.alignmentReview=false;
  }
  // Retain every pre-existing cut which was not owned by a changed word.
  for(const w of result.words) if(w.deleted && !changed.has(w.id) && !isPunctText(w.text)) {
    for(const r of w.removedAudio??[{start:w.start,end:w.end}]) result.ranges=removeRange(result.ranges,r.start,r.end);
  }
  for(const p of result.clearedPauses??[]) result.ranges=removeRange(result.ranges,p.start,p.end);
  const available=result.ranges.map(r=>({...r}));
  for(const w of result.words) if(w.deleted && changed.has(w.id)) {
    // Calibrating timestamps must not restore an already verified utterance
    // cut. Explicit manual boundary edits use updateWordBoundary instead.
    if(w.continuousCut||w.joinedCut)continue;
    w.removedAudio=available.map(r=>({start:Math.max(w.start,r.start),end:Math.min(w.end,r.end)})).filter(r=>r.end>r.start);
    result.ranges=removeRange(result.ranges,w.start,w.end);
  }
  const joined = new Set(result.words.filter(w=>w.deleted && w.joinedCut && changed.has(w.id)).map(w=>w.id));
  if(joined.size) deleteWordRuns(result,joined,true);
  const continuous=new Set(result.words.filter(w=>w.deleted&&w.continuousCut&&!w.joinedCut&&changed.has(w.id)).map(w=>w.id));
  if(continuous.size)deleteWordRuns(result,continuous);
  // Punctuation remains silent and follows its preceding transcript token.
  let previous: Word|undefined;
  for(const w of result.words) { if(isPunctText(w.text) && previous && !w.manualBoundary) w.start=w.end=previous.end; else if(!isPunctText(w.text)) previous=w; }
  ensureAudioOrder(result);
  return {words:result.words,ranges:result.ranges,audioOrder:result.audioOrder,aligned:changed.size,skipped,manual};
}

/** Preserve speakers on separate channels. Correct strongly anti-correlated
 * channels before mixing, instead of losing one speaker or cancelling speech. */
export function alignmentMono(channels: Float32Array[]): Float32Array {
  const length=channels[0]?.length || 0, mixed=new Float32Array(length);
  let best=0;const energies=channels.map(data=>{let e=0;for(let i=0;i<length;i+=16)e+=(data[i]||0)**2;return e;});
  for(let ch=1;ch<channels.length;ch++)if(energies[ch]>energies[best])best=ch;
  for(let ch=0;ch<channels.length;ch++) {
    let dot=0;for(let i=0;i<length;i+=16)dot+=(channels[ch][i]||0)*(channels[best][i]||0);
    const polarity=dot < -0.6*Math.sqrt(energies[ch]*energies[best]) ? -1 : 1;
    for(let i=0;i<length;i++)mixed[i]+=(channels[ch][i]||0)*polarity/Math.max(1,channels.length);
  }
  return mixed;
}
async function audioPayload(buffer: AudioBuffer, start: number, end: number): Promise<string> {
  const first=Math.floor(start*buffer.sampleRate), length=Math.min(buffer.length-first,Math.ceil((end-start)*buffer.sampleRate));
  const channels=Array.from({length:buffer.numberOfChannels},(_,ch)=>buffer.getChannelData(ch).subarray(first,first+length));
  const ctx=new OfflineAudioContext(1,Math.ceil(length/buffer.sampleRate*16000),16000);
  const mono=ctx.createBuffer(1,length,buffer.sampleRate);mono.copyToChannel(alignmentMono(channels),0);
  const source=ctx.createBufferSource();source.buffer=mono;source.connect(ctx.destination);source.start();
  const rendered=await ctx.startRendering(), data=rendered.getChannelData(0);
  const bytes=new Uint8Array(44+data.length*2), view=new DataView(bytes.buffer);
  const ascii=(at:number,s:string)=>{for(let i=0;i<s.length;i++)bytes[at+i]=s.charCodeAt(i);};
  ascii(0,'RIFF');view.setUint32(4,bytes.length-8,true);ascii(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);ascii(36,'data');view.setUint32(40,data.length*2,true);
  data.forEach((x,i)=>view.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,x))*32767),true));
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(binary);
}

export async function requestForcedAlignment(clip: Clip, signal: AbortSignal, progress: (done:number,total:number)=>void): Promise<BoundaryProposal[]> {
  const status=await fetch('/api/alignment',{signal});
  if(!status.ok || !(await status.json()).ready) throw new Error('本机对齐模型不可用，原字界已保留');
  const chunks=alignmentChunks(clip.words,clip.duration), all:BoundaryProposal[]=[];
  for(let i=0;i<chunks.length;i++) {
    signal.throwIfAborted(); progress(i,chunks.length);
    const c=chunks[i], audio=await audioPayload(clip.cleanBuffer,c.start,c.end);
    signal.throwIfAborted();
    const res=await fetch('/api/alignment',{method:'POST',headers:{'Content-Type':'application/json','X-Local-Alignment':'1'},body:JSON.stringify({audio,text:c.words.map(w=>w.text).join(' ')}),signal});
    const json=await res.json();if(!res.ok)throw new Error(json.error||'本机对齐失败');
    all.push(...mapAlignedTokens(c,json.words));progress(i+1,chunks.length);
  }
  return all;
}
