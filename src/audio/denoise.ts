/**
 * Local speech processing (no paid APIs / heavy deps).
 *
 * 降噪 (mild): high-pass rumble cut → soft noise gate with high floor
 *   tolerance, gentle attenuation, speech-band–friendly smoothing.
 * 人声美化: presence peaking (~3 kHz) → soft de-harsh high shelf
 *   (~8 kHz) → very light compression.
 *
 * Both preserve duration / sampleRate / channel count.
 */

/** Estimate a quiet-floor RMS from the quieter portion of short frames. */
function estimateNoiseFloor(data: Float32Array, frameSize: number): number {
  const levels: number[] = [];
  for (let i = 0; i + frameSize <= data.length; i += frameSize) {
    let sum = 0;
    for (let j = 0; j < frameSize; j++) {
      const s = data[i + j]!;
      sum += s * s;
    }
    levels.push(Math.sqrt(sum / frameSize));
  }
  if (levels.length === 0) return 0.008;
  levels.sort((a, b) => a - b);
  // Use ~12th percentile — higher tolerance so soft speech is not treated as noise
  const q = levels[Math.floor(levels.length * 0.12)] ?? levels[0]!;
  return Math.max(q, 1e-5);
}

/**
 * Gentle soft gate with smoothed gain.
 * Keeps more of quiet speech; only lightly ducks hush / hum between words.
 * Attenuation floor is high (~0.42) so voice never sounds gated/harsh.
 */
function softGateChannel(
  data: Float32Array,
  sampleRate: number,
  noiseFloor: number,
): void {
  const frameSize = Math.max(64, Math.floor(sampleRate * 0.015)); // ~15 ms
  // Higher multipliers = more tolerant of quiet speech near the floor
  const threshold = noiseFloor * 3.8;
  const open = noiseFloor * 9;
  const minGain = 0.42; // was ~0.08 — much milder ducking
  // Smooth gain across frames (fast open, slower close) to protect consonants
  const attack = 0.55; // blend toward open
  const release = 0.18; // blend toward closed
  let smooth = 1;

  for (let i = 0; i < data.length; i += frameSize) {
    const end = Math.min(i + frameSize, data.length);
    let sum = 0;
    for (let j = i; j < end; j++) {
      const s = data[j]!;
      sum += s * s;
    }
    const rms = Math.sqrt(sum / (end - i));
    let target = 1;
    if (rms < threshold) {
      target = minGain;
    } else if (rms < open) {
      const t = (rms - threshold) / (open - threshold);
      // Ease curve — stay open longer in the soft-knee region
      const eased = t * t * (3 - 2 * t);
      target = minGain + eased * (1 - minGain);
    }
    const coeff = target < smooth ? release : attack;
    smooth = smooth + (target - smooth) * coeff;
    if (smooth < 0.999) {
      for (let j = i; j < end; j++) data[j]! *= smooth;
    }
  }
}

/** Mild speech-band emphasis before gating: lift 200 Hz–4 kHz slightly. */
async function mildSpeechBandLift(src: AudioBuffer): Promise<AudioBuffer> {
  const channels = src.numberOfChannels;
  const sampleRate = src.sampleRate;
  const length = src.length;
  const offline = new OfflineAudioContext(channels, length, sampleRate);
  const srcNode = offline.createBufferSource();
  srcNode.buffer = src;

  // Cut only deep rumble; keep chest voice
  const hp = offline.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 80;
  hp.Q.value = 0.707;

  // Gentle presence of speech fundamentals / formants (not a harsh scoop)
  const presence = offline.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 1200;
  presence.Q.value = 0.6;
  presence.gain.value = 1.2; // subtle lift so speech sits above hiss before gate

  // Soft roll-off of extreme highs (hiss) without dulling intelligibility
  const lp = offline.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 12000;
  lp.Q.value = 0.707;

  srcNode.connect(hp);
  hp.connect(presence);
  presence.connect(lp);
  lp.connect(offline.destination);
  srcNode.start(0);
  return offline.startRendering();
}

/** Clone an AudioBuffer (same length / rate / channels). */
export function cloneAudioBuffer(src: AudioBuffer): AudioBuffer {
  const out = new AudioBuffer({
    length: src.length,
    numberOfChannels: src.numberOfChannels,
    sampleRate: src.sampleRate,
  });
  for (let c = 0; c < src.numberOfChannels; c++) {
    out.copyToChannel(src.getChannelData(c), c);
  }
  return out;
}

const denoiseCache=new WeakMap<AudioBuffer,Promise<AudioBuffer>>();

/** Local spectral suppression acts on the clean voice before gain/tempo. Music
 * never calls this function. Preserve every sample position and original level. */
async function spectralDenoise(src:AudioBuffer):Promise<AudioBuffer> {
  const out=new AudioBuffer({numberOfChannels:src.numberOfChannels,length:src.length,sampleRate:src.sampleRate});
  for(let c=0;c<src.numberOfChannels;c++){
    const input=src.getChannelData(c);
    // Conservative broadband calibration; max 8 dB attenuation, no noise gate,
    // makeup gain, presence boost or adaptive tracking of quiet syllables.
    const measured=20*Math.log10(estimateNoiseFloor(input,Math.max(64,Math.floor(src.sampleRate*.02))));
    const floor=Math.max(-80,Math.min(-45,measured+10));
    const query=new URLSearchParams({rate:String(src.sampleRate),frames:String(src.length),floor:floor.toFixed(2)});
    const response=await fetch('/api/audio/denoise?'+query,{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Podcut-Audio':'1'},body:new Blob([input])});
    if(!response.ok){const detail=await response.json().catch(()=>null);throw Error(detail?.error??'本机降噪服务未就绪，请刷新后重试');}
    const bytes=await response.arrayBuffer();if(bytes.byteLength!==src.length*4)throw Error('降噪输出长度异常，已保留原音');
    const samples=new Float32Array(bytes);if(!samples.every(Number.isFinite))throw Error('降噪返回无效音频');
    out.copyToChannel(samples,c);
  }
  return out;
}

/** Reversible speech-only denoising. Local desktop uses the FFT denoiser;
 * hosted builds without the local service retain the lightweight fallback. */
export async function denoiseBuffer(src: AudioBuffer): Promise<AudioBuffer> {
  if(typeof location!=='undefined' && ['localhost','127.0.0.1','[::1]'].includes(location.hostname)){
    const cached=denoiseCache.get(src);if(cached)return cached;
    const pending=spectralDenoise(src);denoiseCache.set(src,pending);
    try{return await pending;}catch(error){denoiseCache.delete(src);throw error;}
  }
  const filtered=await mildSpeechBandLift(src),out=cloneAudioBuffer(filtered);
  const frameSize=Math.max(64,Math.floor(src.sampleRate*.02));
  for(let c=0;c<src.numberOfChannels;c++){const data=out.getChannelData(c);softGateChannel(data,src.sampleRate,estimateNoiseFloor(data,frameSize));}
  return out;
}

/**
 * Light voice beautify for podcast speech (tasteful, not radio overprocess).
 * Pipeline: presence bump (~3 kHz) → soft de-harsh high shelf (~8 kHz)
 *   → very light compression + tiny makeup.
 * Label: 人声美化
 */
export async function beautifyBuffer(src: AudioBuffer): Promise<AudioBuffer> {
  const channels = src.numberOfChannels;
  const sampleRate = src.sampleRate;
  const length = src.length;
  const offline = new OfflineAudioContext(channels, length, sampleRate);
  const srcNode = offline.createBufferSource();
  srcNode.buffer = src;

  // Presence / intelligibility bump in the speech clarity band
  const presence = offline.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = 3000;
  presence.Q.value = 0.9;
  presence.gain.value = 2.2; // subtle ~+2 dB

  // Soft de-harsh: tame brittle highs without killing air
  const deHarsh = offline.createBiquadFilter();
  deHarsh.type = 'highshelf';
  deHarsh.frequency.value = 8000;
  deHarsh.gain.value = -3.5;

  // Very light compression — even level, not squashed
  const comp = offline.createDynamicsCompressor();
  comp.threshold.value = -22;
  comp.knee.value = 14;
  comp.ratio.value = 2.2;
  comp.attack.value = 0.012;
  comp.release.value = 0.22;

  // Tiny makeup so perceived loudness stays similar after soft compression
  const makeup = offline.createGain();
  makeup.gain.value = 1.12; // ~+1 dB

  srcNode.connect(presence);
  presence.connect(deHarsh);
  deHarsh.connect(comp);
  comp.connect(makeup);
  makeup.connect(offline.destination);
  srcNode.start(0);
  return offline.startRendering();
}

/**
 * Rebuild processed buffer from clean source with optional mild denoise
 * and/or voice beautify. Order: denoise → beautify.
 */
export async function applyVoiceProcessing(
  clean: AudioBuffer,
  opts: { denoise?: boolean; beautify?: boolean },
): Promise<AudioBuffer> {
  let buf = clean;
  if (opts.denoise) buf = await denoiseBuffer(buf);
  if (opts.beautify) buf = await beautifyBuffer(buf);
  return buf;
}

/** Slice [startSec, endSec) from a buffer into a new AudioBuffer. */
export function sliceAudioBuffer(
  src: AudioBuffer,
  startSec: number,
  endSec: number,
): AudioBuffer {
  const sr = src.sampleRate;
  const start = Math.max(0, Math.min(src.length, Math.floor(startSec * sr)));
  const end = Math.max(start, Math.min(src.length, Math.ceil(endSec * sr)));
  const length = Math.max(1, end - start);
  const out = new AudioBuffer({
    length,
    numberOfChannels: src.numberOfChannels,
    sampleRate: sr,
  });
  for (let c = 0; c < src.numberOfChannels; c++) {
    const channel = src.getChannelData(c).subarray(start, end);
    out.copyToChannel(channel.slice(0), c);
  }
  return out;
}

/** Concatenate buffers (same sample rate; channel count = max of inputs). */
export function concatAudioBuffers(a: AudioBuffer, b: AudioBuffer): AudioBuffer {
  if (Math.abs(a.sampleRate - b.sampleRate) > 1) {
    throw new Error('sampleRate mismatch');
  }
  const sr = a.sampleRate;
  const channels = Math.max(a.numberOfChannels, b.numberOfChannels);
  const length = a.length + b.length;
  const out = new AudioBuffer({ length, numberOfChannels: channels, sampleRate: sr });
  for (let c = 0; c < channels; c++) {
    const dest = out.getChannelData(c);
    const srcA = a.getChannelData(Math.min(c, a.numberOfChannels - 1));
    const srcB = b.getChannelData(Math.min(c, b.numberOfChannels - 1));
    dest.set(srcA, 0);
    dest.set(srcB, a.length);
  }
  return out;
}

type TimeRangeLike = { start: number; end: number };

/**
 * Extract multiple original-time ranges from src and glue them into one buffer.
 * Returns the glued buffer and the destination TimeRanges covering each piece.
 */
export function glueRangesFromBuffer(
  src: AudioBuffer,
  pieces: TimeRangeLike[],
): { buffer: AudioBuffer; destRanges: TimeRangeLike[] } | null {
  const valid = pieces.filter((r) => r.end - r.start > 1e-4);
  if (valid.length === 0) return null;
  let acc: AudioBuffer | null = null;
  const destRanges: TimeRangeLike[] = [];
  let cursor = 0;
  for (const r of valid) {
    const slice = sliceAudioBuffer(src, r.start, r.end);
    const dur = slice.duration;
    destRanges.push({ start: cursor, end: cursor + dur });
    cursor += dur;
    acc = acc ? concatAudioBuffers(acc, slice) : slice;
  }
  if (!acc) return null;
  return { buffer: acc, destRanges };
}
