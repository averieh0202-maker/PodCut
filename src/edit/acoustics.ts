/** Cached 5 ms envelopes. The loudest channel protects stereo speech. */
export interface AcousticInput {
  channel: Float32Array;
  channels?: Float32Array[];
  sampleRate: number;
  /** Source-time origin for a bounded server-side analysis window. */
  offsetSec?: number;
}
export interface Envelope { rms: Float32Array; step: number; quiet: number }
const cache = new WeakMap<Float32Array, Map<string, Envelope>>();
export function envelope(input: AcousticInput): Envelope {
  const channels = input.channels?.length ? input.channels : [input.channel];
  const key = `${input.sampleRate}:${channels.length}`;
  const saved = cache.get(input.channel)?.get(key);
  if (saved) return saved;
  const hop = Math.max(1, Math.round(input.sampleRate * 0.005));
  const rms = new Float32Array(Math.ceil(input.channel.length / hop));
  for (let f = 0; f < rms.length; f++) {
    for (const ch of channels) {
      let sum = 0;
      const end = Math.min(ch.length, (f + 1) * hop);
      for (let i = f * hop; i < end; i++) sum += ch[i]! ** 2;
      rms[f] = Math.max(rms[f]!, Math.sqrt(sum / Math.max(1, end - f * hop)));
    }
  }
  const sorted = Float32Array.from(rms).sort();
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const speech = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  // A high noise floor must never classify continuous speech as silence.
  const quiet = Math.max(0.00003, Math.min(0.003, speech * 0.06, floor * 2 + 0.00015));
  const result = { rms, step: hop / input.sampleRate, quiet };
  let entries = cache.get(input.channel);
  if (!entries) cache.set(input.channel, entries = new Map());
  entries.set(key, result);
  return result;
}
export function bufferAcoustics(buffer: AudioBuffer): AcousticInput {
  return {
    channel: buffer.getChannelData(0),
    channels: Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c)),
    sampleRate: buffer.sampleRate,
  };
}
