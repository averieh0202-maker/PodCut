/** Longer overlap reduces phase-mismatch buzz in voiced speech. Fast correlation
 * remains enabled on the render thread: exhaustive search exceeds a 128-frame
 * deadline on some devices, producing actual dropouts despite better matches. */
export const SPEECH_STRETCH = { sequenceMs: 80, seekWindowMs: 20, overlapMs: 16, quickSeek: true };
/** A fixed reserve absorbs WSOLA's bursty windows and fractional-frame rounding.
 * Music and playhead use the same delay; no source audio is trimmed to hide it. */
export function tempoLatency(sampleRate:number):number {
  return Math.ceil(sampleRate * .2 / 128) * 128 / sampleRate;
}

/** Identical pre-source warmup for live and offline speech processors. */
export const SPEECH_PREROLL_SEC = .06;
