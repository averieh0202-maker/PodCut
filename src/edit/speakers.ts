import type { Word } from './types';

export interface SpeakerInfo { speakerId?: string; speakerName?: string }
export const UNKNOWN_SPEAKER = '说话人待确认';

/** Provider IDs identify people within ONE recognition task, never across recordings. */
export function scopeSpeakers<T extends SpeakerInfo>(words: T[], scope: string): T[] {
  const names = new Map<string, string>();
  return words.map(w => {
    if (!w.speakerId) return { ...w };
    const raw = w.speakerId;
    if (!names.has(raw)) names.set(raw, w.speakerName?.trim() || `说话人 ${names.size + 1}`);
    return { ...w, speakerId: `${scope}:speaker:${raw}`, speakerName: names.get(raw)! };
  });
}

export function listSpeakers(words: SpeakerInfo[]): Array<{id: string; name: string}> {
  const names = new Map<string, string>();
  for (const w of words) if (w.speakerId && !names.has(w.speakerId)) {
    names.set(w.speakerId, w.speakerName || `说话人 ${names.size + 1}`);
  }
  return [...names].map(([id, name]) => ({id, name}));
}

/** Paragraph boundaries and speaker boundaries are independent of acoustic word edges. */
export function groupSpeakerUtterances<T extends SpeakerInfo & { breakAfter?: boolean }>(words: T[]): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  for (const w of words) {
    if (current.length && current[0].speakerId !== w.speakerId) { groups.push(current); current = []; }
    current.push(w);
    if (w.breakAfter) { groups.push(current); current = []; }
  }
  if (current.length) groups.push(current);
  return groups;
}

/** Preserve the original wording; show labels once per turn, including unknown turns. */
export function speakerParagraphs(rows: Array<SpeakerInfo & {text: string; scope?: string}>): string {
  const labelled = rows.some(r => !!r.speakerId);
  let previous: string | undefined;
  const names = new Map(listSpeakers(rows).map(s => [s.id, s.name]));
  return rows.filter(r => r.text.trim()).map(r => {
    const key = `${r.scope || ''}/${r.speakerId || ''}`;
    const prefix = labelled && key !== previous ? `${r.speakerName || (r.speakerId && names.get(r.speakerId)) || UNKNOWN_SPEAKER}：\n` : '';
    previous = key;
    return prefix + r.text.trim();
  }).join('\n\n');
}

/** Backfill only speaker metadata. IDs, transcript, boundaries, deletions and cuts stay intact.
 * Unclear/overlapping speakers are left unknown rather than attributed by proximity. */
export function applySpeakerLabels(words: Word[], recognized: Array<SpeakerInfo & {start: number; end: number}>, scope: string): Word[] {
  const spans: Array<SpeakerInfo & {start: number; end: number}> = [];
  for (const w of scopeSpeakers(recognized, scope)) {
    if (!(w.end > w.start)) continue;
    const prev = spans.at(-1);
    if (prev && prev.speakerId === w.speakerId && w.start >= prev.start && w.start <= prev.end + .3) prev.end = Math.max(prev.end, w.end);
    else spans.push({...w});
  }
  spans.sort((a,b) => a.start-b.start);
  const maxEnds: number[] = [];
  spans.forEach((s,i) => maxEnds.push(Math.max(s.end,maxEnds[i-1] ?? -Infinity)));
  const result = words.map(w => {
    // Remove stale labels only in the proposed result, never mutate the edited words.
    const {speakerId: _id, speakerName: _name, ...rest} = w;
    if (w.end <= w.start) return rest as Word;
    // Binary search the time-sorted spans, then inspect all overlapping intervals.
    let lo=0, hi=spans.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(spans[mid].start<w.end)lo=mid+1;else hi=mid;}
    const scores = new Map<string, {amount: number; info: SpeakerInfo}>();
    for(let i=lo-1;i>=0 && maxEnds[i]>w.start;i--){
      const s=spans[i];
      // Spans are usually non-overlapping but simultaneous voices may overlap.
      const overlap=Math.max(0,Math.min(w.end,s.end)-Math.max(w.start,s.start));
      if(overlap && s.speakerId){const score=scores.get(s.speakerId);scores.set(s.speakerId,{amount:(score?.amount||0)+overlap,info:s});}
    }
    const ranked=[...scores.values()].sort((a,b)=>b.amount-a.amount);
    const best=ranked[0], second=ranked[1];
    if(!best || best.amount/(w.end-w.start)<.55 || (second && second.amount>best.amount*.5)) return rest as Word;
    return {...rest,speakerId:best.info.speakerId,speakerName:best.info.speakerName} as Word;
  });
  // Zero-duration punctuation belongs to the immediately preceding spoken word.
  result.forEach((w,i)=>{if(w.start===w.end && /^[\p{P}\s]+$/u.test(w.text)){
    const adjacent=result[i-1] || result[i+1];
    if(adjacent?.speakerId && Math.abs(w.start-adjacent.end)<.3){w.speakerId=adjacent.speakerId;w.speakerName=adjacent.speakerName;}
  }});
  return result;
}
