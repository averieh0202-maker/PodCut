/**
 * Build a mixed speech + bed + stinger schedule on a project edit timeline.
 *
 * - Speech keeps its relative order.
 * - Stingers insert a gap at their speech-edit anchor (play before speech at that point).
 * - Beds overlay under speech at the mapped project time (do not push timeline).
 */

import { editedDuration, toEdit } from '../edit/timeline';
import type { MusicPlacement, TimeRange, Word } from '../edit/types';
import { dbToLinear } from './gain';

export interface ScheduleClip {
  id: string;
  buffer: AudioBuffer;
  ranges: TimeRange[];
  words?: Word[];
  gainDb?: number;
}

export interface MixSource {
  buffer: AudioBuffer;
  /** Start time on the project (mixed) edit timeline. */
  whenEdit: number;
  /** Offset into the buffer (seconds). */
  offset: number;
  duration: number;
  /** Linear gain already including master * placement. */
  gainLinear: number;
  role: 'speech' | 'bed' | 'stinger';
  placementId?: string;
  /** Fade-in seconds over the full placement duration (music only). */
  fadeInSec?: number;
  /** Fade-out seconds over the full placement duration (music only). */
  fadeOutSec?: number;
}

/** Maps project timeline ↔ speech timeline for playhead / locate. */
export interface TimelineSeg {
  projectStart: number;
  projectEnd: number;
  speechStart: number;
  speechEnd: number;
  kind: 'speech' | 'stinger';
}

export interface MixSchedule {
  sources: MixSource[];
  segs: TimelineSeg[];
  totalDuration: number;
  speechDuration: number;
  hasClipGain?: boolean;
}


export const BED_GAIN_DB_DEFAULT = -15;
export const STINGER_GAIN_DB_DEFAULT = -3;

/** Default fades for background beds (seconds). */
export const BED_FADE_IN_DEFAULT = 2;
export const BED_FADE_OUT_DEFAULT = 2;
/** Default fades for stingers — short so transitions stay snappy. */
export const STINGER_FADE_IN_DEFAULT = 0.15;
export const STINGER_FADE_OUT_DEFAULT = 0.35;

/** Resolve source region kept from a music placement (inPoint/outPoint). */
export function resolveMusicRegion(m: MusicPlacement): {
  inPoint: number;
  outPoint: number;
  duration: number;
} {
  const max = Math.max(0.01, m.buffer.duration);
  let inPoint = Number.isFinite(m.inPoint) ? Number(m.inPoint) : 0;
  let outPoint = Number.isFinite(m.outPoint) ? Number(m.outPoint) : max;
  inPoint = Math.max(0, Math.min(max, inPoint));
  outPoint = Math.max(0, Math.min(max, outPoint));
  if (outPoint < inPoint) {
    const t = inPoint;
    inPoint = outPoint;
    outPoint = t;
  }
  if (outPoint - inPoint < 0.05) {
    outPoint = Math.min(max, inPoint + 0.05);
    if (outPoint - inPoint < 0.05) {
      inPoint = Math.max(0, outPoint - 0.05);
    }
  }
  return { inPoint, outPoint, duration: outPoint - inPoint };
}

/** Resolve fade-in/out for a placement, clamped to play duration. */
export function resolveMusicFades(
  m: MusicPlacement,
  playDur: number,
): { fadeInSec: number; fadeOutSec: number } {
  const defaults =
    m.kind === 'bed'
      ? { fadeInSec: BED_FADE_IN_DEFAULT, fadeOutSec: BED_FADE_OUT_DEFAULT }
      : { fadeInSec: STINGER_FADE_IN_DEFAULT, fadeOutSec: STINGER_FADE_OUT_DEFAULT };
  let fadeIn = Number.isFinite(m.fadeInSec) ? Number(m.fadeInSec) : defaults.fadeInSec;
  let fadeOut = Number.isFinite(m.fadeOutSec) ? Number(m.fadeOutSec) : defaults.fadeOutSec;
  const dur = Math.max(0, playDur);
  fadeIn = Math.max(0, Math.min(dur, fadeIn));
  fadeOut = Math.max(0, Math.min(dur, fadeOut));
  if (fadeIn + fadeOut > dur && dur > 1e-6) {
    const s = dur / (fadeIn + fadeOut);
    fadeIn *= s;
    fadeOut *= s;
  }
  return { fadeInSec: fadeIn, fadeOutSec: fadeOut };
}

/**
 * Linear fade envelope at local time t within [0, dur].
 * Returns 0..1 multiplier (fade-in from 0, fade-out to 0).
 */
export function fadeEnvelopeAt(
  t: number,
  dur: number,
  fadeIn: number,
  fadeOut: number,
): number {
  if (dur <= 1e-9) return 0;
  const tt = Math.max(0, Math.min(dur, t));
  let g = 1;
  if (fadeIn > 1e-6 && tt < fadeIn) g = Math.min(g, tt / fadeIn);
  if (fadeOut > 1e-6 && tt > dur - fadeOut) {
    g = Math.min(g, Math.max(0, (dur - tt) / fadeOut));
  }
  return Math.max(0, Math.min(1, g));
}

export function resolveSpeechEditTime(
  clips: ScheduleClip[],
  clipId: string,
  originalTime: number,
): number | null {
  let base = 0;
  for (const c of clips) {
    if (c.id === clipId) {
      const exact = toEdit(c.ranges, originalTime);
      if (exact != null) return base + exact;
      let best = 0;
      let bestDist = Infinity;
      let t = 0;
      for (const r of c.ranges) {
        for (const edge of [r.start, r.end] as const) {
          const d = Math.abs(originalTime - edge);
          if (d < bestDist) {
            bestDist = d;
            best = t + (edge <= r.start + 1e-9 ? 0 : r.end - r.start);
          }
        }
        t += r.end - r.start;
      }
      return base + best;
    }
    base += editedDuration(c.ranges);
  }
  return null;
}

/** Old drafts lacked the edge. Infer it once, then persist anchorSide. */
export function musicAnchorSide(m: MusicPlacement, words: Word[] = []): 'before' | 'after' {
  if (m.anchorSide) return m.anchorSide;
  const w = words.find(w => w.id === m.wordId);
  return w && !w.manualBoundary && Math.abs(m.originalTime - w.end) < 1e-4 && Math.abs(m.originalTime - w.end) < Math.abs(m.originalTime - w.start) ? 'after' : 'before';
}
export function resolveMusicAnchorTime(clips: ScheduleClip[], m: MusicPlacement): number | null {
  const clip = clips.find(c => c.id === m.clipId);
  if (!clip) return null;
  const w = clip.words?.find(w => w.id === m.wordId);
  const time = w ? (musicAnchorSide(m, clip.words) === 'after' ? w.end : w.start) : m.originalTime;
  return resolveSpeechEditTime(clips, m.clipId, time);
}

interface SpeechAtom {
  buffer: AudioBuffer;
  bufStart: number;
  dur: number;
  speechStart: number;
  gainLinear: number;
}

function flattenSpeech(clips: ScheduleClip[]): SpeechAtom[] {
  const out: SpeechAtom[] = [];
  let speechT = 0;
  for (const c of clips) {
    for (const r of c.ranges) {
      const dur = r.end - r.start;
      if (dur <= 1e-4) continue;
      out.push({
        buffer: c.buffer,
        bufStart: r.start,
        dur,
        speechStart: speechT,
        gainLinear: dbToLinear(c.gainDb ?? 0),
      });
      speechT += dur;
    }
  }
  return out;
}

function splitAtPoints(atoms: SpeechAtom[], points: number[]): SpeechAtom[] {
  const cuts = [...new Set(points.filter((p) => Number.isFinite(p) && p > 0))].sort(
    (a, b) => a - b,
  );
  if (cuts.length === 0) return atoms;

  const out: SpeechAtom[] = [];
  for (const atom of atoms) {
    let start = atom.speechStart;
    let buf = atom.bufStart;
    let remaining = atom.dur;
    const end = atom.speechStart + atom.dur;
    for (const cut of cuts) {
      if (cut <= start + 1e-9 || cut >= end - 1e-9) continue;
      const left = cut - start;
      out.push({
        buffer: atom.buffer,
        gainLinear: atom.gainLinear,
        bufStart: buf,
        dur: left,
        speechStart: start,
      });
      start = cut;
      buf += left;
      remaining -= left;
    }
    if (remaining > 1e-4) {
      out.push({
        buffer: atom.buffer,
        gainLinear: atom.gainLinear,
        bufStart: buf,
        dur: remaining,
        speechStart: start,
      });
    }
  }
  return out;
}

interface ResolvedStinger {
  leadOnly?: boolean;
  id: string;
  speechEdit: number;
  buffer: AudioBuffer;
  offset: number;
  playDur: number;
  gainLinear: number;
  fadeInSec: number;
  fadeOutSec: number;
}

interface ResolvedBed {
  leadInSec: number;
  id: string;
  speechEdit: number;
  buffer: AudioBuffer;
  offset: number;
  playDur: number;
  gainLinear: number;
  fadeInSec: number;
  fadeOutSec: number;
}

/** Project time where speech at speechEdit begins. */
export function speechToProjectTime(
  speechEdit: number,
  stingers: Array<{ speechEdit: number; playDur: number }>,
): number {
  let extra = 0;
  for (const st of stingers) {
    if (st.speechEdit <= speechEdit + 1e-9) extra += st.playDur;
  }
  return speechEdit + extra;
}

/** Map project edit time → speech edit time (stingers freeze speech clock). */
export function projectToSpeechTime(
  projectT: number,
  segs: TimelineSeg[],
  speechDuration: number,
): number {
  if (segs.length === 0) return 0;
  for (const seg of segs) {
    if (projectT + 1e-9 < seg.projectStart) {
      return seg.speechStart;
    }
    if (projectT <= seg.projectEnd + 1e-9) {
      if (seg.kind === 'speech') {
        const into = Math.max(0, projectT - seg.projectStart);
        return Math.min(seg.speechEnd, seg.speechStart + into);
      }
      return seg.speechStart;
    }
  }
  return speechDuration;
}

export function buildMixSchedule(
  clips: ScheduleClip[],
  music: MusicPlacement[],
  masterLinear = 1,
): MixSchedule {
  const speechDuration = clips.reduce((s, c) => s + editedDuration(c.ranges), 0);
  const stingers: ResolvedStinger[] = [];
  const beds: ResolvedBed[] = [];

  for (const m of music) {
    const speechEdit = resolveMusicAnchorTime(clips, m);
    if (speechEdit == null) continue;
    const clamped = Math.max(0, Math.min(speechEdit, speechDuration));
    const placeGain = dbToLinear(m.gainDb); // Material gain is independent of speech processing.
    const region = resolveMusicRegion(m);
    const fades = resolveMusicFades(m, region.duration);
    if (m.kind === 'stinger') {
      stingers.push({
        id: m.id,
        speechEdit: clamped,
        buffer: m.buffer,
        offset: region.inPoint,
        playDur: region.duration,
        gainLinear: placeGain,
        fadeInSec: fades.fadeInSec,
        fadeOutSec: fades.fadeOutSec,
      });
    } else {
      const leadInSec=Math.max(0,Math.min(30,region.duration,Number(m.leadInSec)||0));
      if(leadInSec>0)stingers.push({id:m.id+'-lead',speechEdit:clamped,buffer:m.buffer,offset:0,playDur:leadInSec,gainLinear:0,fadeInSec:0,fadeOutSec:0,leadOnly:true});
      beds.push({
        leadInSec,
        id: m.id,
        speechEdit: clamped,
        buffer: m.buffer,
        offset: region.inPoint,
        playDur: region.duration,
        gainLinear: placeGain,
        fadeInSec: fades.fadeInSec,
        fadeOutSec: fades.fadeOutSec,
      });
    }
  }
  // Beds at the same anchor share one lead-in, rather than delaying speech twice.
  for(let i=stingers.length-1;i>=0;i--){const lead=stingers[i];if(!lead.leadOnly)continue;const other=stingers.find((s,j)=>j<i&&s.leadOnly&&Math.abs(s.speechEdit-lead.speechEdit)<1e-7);if(other){other.playDur=Math.max(other.playDur,lead.playDur);stingers.splice(i,1);}}
  stingers.sort((a, b) => a.speechEdit - b.speechEdit || a.id.localeCompare(b.id));

  const atoms = splitAtPoints(
    flattenSpeech(clips),
    stingers.map((s) => s.speechEdit),
  );

  const sources: MixSource[] = [];
  const segs: TimelineSeg[] = [];
  let projectT = 0;
  let sti = 0;

  const emitStingersAt = (at: number) => {
    while (sti < stingers.length && stingers[sti]!.speechEdit <= at + 1e-9) {
      const st = stingers[sti]!;
      const start = projectT;
      if(!st.leadOnly)sources.push({
        buffer: st.buffer,
        whenEdit: start,
        offset: st.offset,
        duration: st.playDur,
        gainLinear: st.gainLinear,
        role: 'stinger',
        placementId: st.id,
        fadeInSec: st.fadeInSec,
        fadeOutSec: st.fadeOutSec,
      });
      segs.push({
        projectStart: start,
        projectEnd: start + st.playDur,
        speechStart: st.speechEdit,
        speechEnd: st.speechEdit,
        kind: 'stinger',
      });
      projectT += st.playDur;
      sti += 1;
    }
  };

  if (atoms.length === 0) {
    emitStingersAt(speechDuration);
  } else {
    for (const atom of atoms) {
      emitStingersAt(atom.speechStart);
      const start = projectT;
      sources.push({
        buffer: atom.buffer,
        whenEdit: start,
        offset: atom.bufStart,
        duration: atom.dur,
        gainLinear: masterLinear * atom.gainLinear,
        role: 'speech',
      });
      segs.push({
        projectStart: start,
        projectEnd: start + atom.dur,
        speechStart: atom.speechStart,
        speechEnd: atom.speechStart + atom.dur,
        kind: 'speech',
      });
      projectT += atom.dur;
    }
    emitStingersAt(speechDuration);
  }

  for (const bed of beds) {
    sources.push({
      buffer: bed.buffer,
      whenEdit: speechToProjectTime(bed.speechEdit, stingers)-bed.leadInSec,
      offset: bed.offset,
      duration: bed.playDur,
      gainLinear: bed.gainLinear,
      role: 'bed',
      placementId: bed.id,
      fadeInSec: bed.fadeInSec,
      fadeOutSec: bed.fadeOutSec,
    });
  }

  const totalDuration = Math.max(
    projectT,
    0,
    ...sources.map((s) => s.whenEdit + s.duration),
  );

  return { sources, segs, totalDuration, speechDuration, hasClipGain: clips.some(c => Math.abs(c.gainDb ?? 0) > 1e-9) };
}

/**
 * Apply fade envelope to interleaved-time mono/channel samples in place.
 * Samples cover local time [localStart, localStart + duration] within fullDur.
 */
export function applyFadeEnvelopeToSamples(
  samples: Float32Array,
  sampleRate: number,
  localStart: number,
  duration: number,
  fullDur: number,
  fadeIn: number,
  fadeOut: number,
): void {
  if (samples.length === 0 || duration <= 1e-9) return;
  const n = samples.length;
  const rate = Math.max(1, sampleRate);
  for (let i = 0; i < n; i++) {
    // Sample clock: i/rate seconds into this slice
    const localT = localStart + i / rate;
    const env = fadeEnvelopeAt(localT, fullDur, fadeIn, fadeOut);
    samples[i] = (samples[i] ?? 0) * env;
  }
}

/**
 * Copy a buffer slice and bake linear fade-in/out into the samples.
 * GainNode automation is unreliable on some Safari + MediaStream paths;
 * sample-level fades always audibly ramp.
 */
export function bakeFadedBufferSlice(
  ctx: { createBuffer: AudioContext['createBuffer'] },
  source: AudioBuffer,
  offsetSec: number,
  durationSec: number,
  fadeInSec: number,
  fadeOutSec: number,
  fullDur: number,
  localStart: number,
): AudioBuffer {
  const rate = source.sampleRate;
  const ch = source.numberOfChannels;
  const startSample = Math.max(0, Math.floor(offsetSec * rate));
  const count = Math.max(1, Math.floor(durationSec * rate));
  const out = ctx.createBuffer(ch, count, rate);
  const fadeIn = Math.max(0, fadeInSec);
  const fadeOut = Math.max(0, fadeOutSec);
  const useFade = fadeIn > 1e-6 || fadeOut > 1e-6;

  for (let c = 0; c < ch; c++) {
    const src = source.getChannelData(c);
    const dest = out.getChannelData(c);
    for (let i = 0; i < count; i++) {
      const idx = startSample + i;
      dest[i] = idx >= 0 && idx < src.length ? src[idx]! : 0;
    }
    if (useFade) {
      applyFadeEnvelopeToSamples(
        dest,
        rate,
        localStart,
        durationSec,
        fullDur,
        fadeIn,
        fadeOut,
      );
    }
  }
  return out;
}

/**
 * Offline-style peak check helper: build a unit tone, bake fadeIn=dur,
 * return early/late peaks. Used by unit tests (no live AudioContext needed
 * when passed a synthetic buffer factory).
 */
export function measureFadeRampPeaks(
  sampleRate: number,
  durationSec: number,
  fadeInSec: number,
  fadeOutSec = 0,
): { earlyPeak: number; latePeak: number; midPeak: number } {
  const count = Math.max(2, Math.floor(durationSec * sampleRate));
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    // Unit-amplitude tone (constant |1| envelope carrier)
    samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  applyFadeEnvelopeToSamples(
    samples,
    sampleRate,
    0,
    durationSec,
    durationSec,
    fadeInSec,
    fadeOutSec,
  );
  const earlyEnd = Math.max(1, Math.floor(count * 0.05));
  const lateStart = Math.floor(count * 0.9);
  const midStart = Math.floor(count * 0.45);
  const midEnd = Math.floor(count * 0.55);
  let earlyPeak = 0;
  let latePeak = 0;
  let midPeak = 0;
  for (let i = 0; i < earlyEnd; i++) earlyPeak = Math.max(earlyPeak, Math.abs(samples[i]!));
  for (let i = lateStart; i < count; i++) latePeak = Math.max(latePeak, Math.abs(samples[i]!));
  for (let i = midStart; i < midEnd; i++) midPeak = Math.max(midPeak, Math.abs(samples[i]!));
  return { earlyPeak, latePeak, midPeak };
}
