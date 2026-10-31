import { normalizeSpeechRate, speechTempoMap, tempoDuration } from './speechTempo';
import { renderTempoSpeech } from './tempoExport';
import { SPLICE_FADE_SEC, spliceGain } from './splice';
import { GAIN_LINEAR_MAX, softLimitSample } from './gain';
import type { ClipSchedule, MusicPlacement, TimeRange } from '../edit/types';
import {
  buildMixSchedule,
  fadeEnvelopeAt,
  type ScheduleClip,
} from './mixSchedule';

/**
 * Export concatenated edited clips to WAV, applying master linear gain (from dB).
 * Soft-limits peaks after gain so heavy boosts do not harsh-clip on encode.
 * Copies samples at the first clip's sample rate; other rates are
 * nearest-neighbour resampled. Duration matches sum of kept ranges.
 */
export async function exportEditedWav(
  clips: ClipSchedule[],
  gain = 1,
): Promise<Blob> {
  if (clips.length === 0) {
    return encodeWav(new Float32Array(0), 44100, 1);
  }

  const sampleRate = clips[0]!.buffer.sampleRate;
  let channels = 1;
  for (const c of clips) channels = Math.max(channels, c.buffer.numberOfChannels);

  const g = Math.max(
    0,
    Math.min(GAIN_LINEAR_MAX, Number.isFinite(gain) ? gain : 1),
  );
  const channelData: Float32Array[] = Array.from(
    { length: channels },
    () => new Float32Array(0),
  );

  for (const clip of clips) {
    const buf = clip.buffer;
    const rate = buf.sampleRate;
    for (const r of clip.ranges) {
      const srcStart = Math.floor(r.start * rate);
      const srcCount = Math.max(0, Math.floor((r.end - r.start) * rate));
      if (srcCount <= 0) continue;
      const outCount =
        rate === sampleRate
          ? srcCount
          : Math.max(1, Math.floor((r.end - r.start) * sampleRate));

      for (let c = 0; c < channels; c++) {
        const srcCh = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
        const chunk = new Float32Array(outCount);
        if (rate === sampleRate) {
          for (let i = 0; i < outCount; i++) {
            const idx = srcStart + i;
            const s = idx >= 0 && idx < srcCh.length ? srcCh[idx]! : 0;
            chunk[i] = softLimitSample(s * g * spliceGain(i / sampleRate, (outCount - 1) / sampleRate, r.start > 0.0001, r.end < buf.duration - 0.0001));
          }
        } else {
          for (let i = 0; i < outCount; i++) {
            const srcIdx = srcStart + Math.floor((i * srcCount) / outCount);
            const s = srcIdx >= 0 && srcIdx < srcCh.length ? srcCh[srcIdx]! : 0;
            chunk[i] = softLimitSample(s * g * spliceGain(i / sampleRate, (outCount - 1) / sampleRate, r.start > 0.0001, r.end < buf.duration - 0.0001));
          }
        }
        channelData[c] = concatFloat32(channelData[c]!, chunk);
      }
    }
  }

  const length = channelData[0]?.length ?? 0;
  if (length === 0) return encodeWav(new Float32Array(0), sampleRate, 1);

  const interleaved =
    channels === 1
      ? channelData[0]!
      : interleaveChannels(channelData as Float32Array[], length);
  return encodeWav(interleaved, sampleRate, channels);
}

/**
 * Export speech + beds + stingers mixed to WAV.
 */
export async function exportMixedWav(
  clips: ScheduleClip[],
  music: MusicPlacement[],
  masterGain = 1,
  speechRate = 1,
  renderSampleRate?: number,
): Promise<Blob> {
  if (clips.length === 0 && music.length === 0) {
    return encodeWav(new Float32Array(0), 44100, 1);
  }

  const mix = buildMixSchedule(clips, music, masterGain);
  if (mix.sources.length === 0) {
    return encodeWav(new Float32Array(0), 44100, 1);
  }

  const sampleRate = renderSampleRate ?? mix.sources[0]!.buffer.sampleRate;
  let channels = 1;
  for (const s of mix.sources) {
    channels = Math.max(channels, s.buffer.numberOfChannels);
  }

  speechRate=normalizeSpeechRate(speechRate);
  if(typeof OfflineAudioContext!=='undefined'){
    const {renderNativeMix}=await import('./nativeMixExport');
    const {buffer,offset,frames}=await renderNativeMix(mix,speechRate,sampleRate,channels);
    return encodePlanarWav(Array.from({length:channels},(_,c)=>buffer.getChannelData(c)),sampleRate,offset,frames);
  }
  const tempo=speechTempoMap(mix,speechRate);
  const totalSamples = Math.max(1, Math.ceil(tempoDuration(mix,speechRate) * sampleRate));
  const outs: Float32Array[] = Array.from(
    { length: channels },
    () => new Float32Array(totalSamples),
  );

  if(speechRate!==1)await renderTempoSpeech(mix,speechRate,sampleRate,outs);
  for (const src of mix.sources) {
    if(speechRate!==1 && src.role==='speech')continue;
    const buf = src.buffer;
    const rate = buf.sampleRate;
    const g = Math.max(0, Math.min(GAIN_LINEAR_MAX, src.gainLinear));
    const outStart = Math.floor(tempo.toWall(src.whenEdit) * sampleRate);
    const srcStart = Math.floor(src.offset * rate);
    const srcCount = Math.max(0, Math.floor(src.duration * rate));
    const outCount =
      rate === sampleRate
        ? Math.max(0, Math.floor(src.duration * sampleRate))
        : Math.max(1, Math.floor(src.duration * sampleRate));

    const fadeIn = src.role === 'speech' ? (src.offset > 0.0001 ? SPLICE_FADE_SEC : 0) : (src.fadeInSec ?? 0);
    const fadeOut = src.role === 'speech' ? (src.offset + src.duration < buf.duration - 0.0001 ? SPLICE_FADE_SEC : 0) : (src.fadeOutSec ?? 0);
    const useFade = fadeIn > 1e-6 || fadeOut > 1e-6;

    for (let c = 0; c < channels; c++) {
      const srcCh = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
      const dest = outs[c]!;
      for (let i = 0; i < outCount; i++) {
        const di = outStart + i;
        if (di < 0 || di >= dest.length) continue;
        let sample = 0;
        if (rate === sampleRate) {
          const idx = srcStart + i;
          sample = idx >= 0 && idx < srcCh.length ? srcCh[idx]! : 0;
        } else {
          const srcIdx = srcStart + Math.floor((i * srcCount) / Math.max(1, outCount));
          sample = srcIdx >= 0 && srcIdx < srcCh.length ? srcCh[srcIdx]! : 0;
        }
        let amp = g;
        if (useFade) {
          const localSec =
            rate === sampleRate
              ? i / sampleRate
              : (i / Math.max(1, outCount)) * src.duration;
          amp = g * (src.role === "speech" ? spliceGain(localSec, (outCount - 1) / sampleRate, fadeIn > 0, fadeOut > 0) : fadeEnvelopeAt(localSec, src.duration, fadeIn, fadeOut));
        }
        dest[di] = dest[di]! + sample * amp;
      }
    }
  }

  const interleaved =
    channels === 1 ? outs[0]! : interleaveChannels(outs, totalSamples);
  return encodeWav(interleaved, sampleRate, channels);
}

/** Back-compat helper for a single buffer. */
export async function exportSingleEditedWav(
  buffer: AudioBuffer,
  ranges: TimeRange[],
  gain = 1,
): Promise<Blob> {
  return exportEditedWav([{ buffer, ranges }], gain);
}

function concatFloat32(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function interleaveChannels(chans: Float32Array[], length: number): Float32Array {
  const channels = chans.length;
  const out = new Float32Array(length * channels);
  let i = 0;
  for (let s = 0; s < length; s++) {
    for (let c = 0; c < channels; c++) out[i++] = chans[c]![s]!;
  }
  return out;
}

function encodeWav(samples:Float32Array,sampleRate:number,channels:number):Blob {
  return encodePcm(samples.length/channels,sampleRate,channels,(i,c)=>samples[i*channels+c]!);
}
function encodePlanarWav(channels:Float32Array[],sampleRate:number,offset:number,length:number):Blob {
  return encodePcm(length,sampleRate,channels.length,(i,c)=>channels[c]![offset+i]!);
}
/** A single constant gain protects overloaded mixes without adding harmonics
 * or changing voice/music balance. Below full scale the signal is untouched. */
function encodePcm(frames:number,sampleRate:number,channels:number,sample:(i:number,c:number)=>number):Blob {
  let peak=0;
  for(let i=0;i<frames;i++)for(let c=0;c<channels;c++){
    const value=sample(i,c);if(!Number.isFinite(value))throw Error('音频包含无效采样，导出已停止');
    peak=Math.max(peak,Math.abs(value));
  }
  const gain=peak>1?.999/peak:1,blockAlign=channels*3,dataSize=frames*blockAlign,padding=dataSize%2;
  const buffer=new ArrayBuffer(44+dataSize+padding),view=new DataView(buffer);
  writeStr(view,0,'RIFF');view.setUint32(4,36+dataSize+padding,true);writeStr(view,8,'WAVE');writeStr(view,12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,channels,true);view.setUint32(24,sampleRate,true);
  view.setUint32(28,sampleRate*blockAlign,true);view.setUint16(32,blockAlign,true);view.setUint16(34,24,true);
  writeStr(view,36,'data');view.setUint32(40,dataSize,true);
  let offset=44;
  for(let i=0;i<frames;i++)for(let c=0;c<channels;c++){
    // Quantize only once, after fades/mixing. 24-bit retains quiet music detail
    // that a second 16-bit truncation discards after attenuation.
    const v=Math.max(-8388608,Math.min(8388607,Math.round(sample(i,c)*gain*8388608)));
    view.setUint8(offset,v&255);view.setUint8(offset+1,(v>>8)&255);view.setUint8(offset+2,(v>>16)&255);offset+=3;
  }
  return new Blob([buffer],{type:'audio/wav'});
}

function writeStr(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
