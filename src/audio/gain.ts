/** Master gain in decibels: −24 … +36, default 0. */

export const GAIN_DB_MIN = -24;
export const GAIN_DB_MAX = 36;
export const GAIN_DB_DEFAULT = 0;

/** Linear amplitude ceiling for GainNode / export (~+36 dB ≈ 63×). */
export const GAIN_LINEAR_MAX = 80;

export function clampGainDb(db: number): number {
  if (!Number.isFinite(db)) return GAIN_DB_DEFAULT;
  return Math.max(GAIN_DB_MIN, Math.min(GAIN_DB_MAX, db));
}

/** Amplitude multiplier: 10^(dB/20). */
export function dbToLinear(db: number): number {
  return Math.pow(10, clampGainDb(db) / 20);
}

/** Display: `+3.0 dB` / `−6.0 dB` / `0 dB`. */
export function formatGainDb(db: number): string {
  const v = clampGainDb(db);
  if (Math.abs(v) < 0.05) return '0 dB';
  const rounded = Math.round(v * 10) / 10;
  if (rounded > 0) return `+${rounded.toFixed(1)} dB`;
  return `−${Math.abs(rounded).toFixed(1)} dB`;
}

/**
 * HTMLAudioElement.volume is clamped to 0–1 by the browser.
 * Use only for attenuation (≤ 0 dB). Boosts must go through GainNode.
 */
export function linearToElementVolume(linear: number): number {
  if (!Number.isFinite(linear) || linear <= 0) return 0;
  return Math.min(1, linear);
}

/** Soft-knee limiter so boosted peaks approach ±1 without harsh digital clip. */
export function softLimitSample(x: number): number {
  if (!Number.isFinite(x)) return 0;
  const lim = 0.95;
  const a = Math.abs(x);
  if (a <= lim) return x;
  const sign = x < 0 ? -1 : 1;
  const over = a - lim;
  return sign * (lim + (1 - lim) * Math.tanh(over / (1 - lim)));
}
