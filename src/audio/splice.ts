/** Four millisecond edge ramps remove splice clicks without changing duration. */
export const SPLICE_FADE_SEC = 0.004;
export function spliceGain(time: number, duration: number, fadeIn: boolean, fadeOut: boolean): number {
  const ramp = Math.min(SPLICE_FADE_SEC, duration / 2);
  if (ramp <= 0) return 1;
  return Math.max(0, Math.min(1, fadeIn ? time / ramp : 1, fadeOut ? (duration - time) / ramp : 1));
}
