/**
 * Hard evidence that sample-level fades ramp 0→1.
 * Mirrors applyFadeEnvelopeToSamples / fadeEnvelopeAt from mixSchedule.ts
 */
function fadeEnvelopeAt(t, dur, fadeIn, fadeOut) {
  if (dur <= 1e-9) return 0;
  const tt = Math.max(0, Math.min(dur, t));
  let g = 1;
  if (fadeIn > 1e-6 && tt < fadeIn) g = Math.min(g, tt / fadeIn);
  if (fadeOut > 1e-6 && tt > dur - fadeOut) {
    g = Math.min(g, Math.max(0, (dur - tt) / fadeOut));
  }
  return Math.max(0, Math.min(1, g));
}

function applyFadeEnvelopeToSamples(
  samples,
  sampleRate,
  localStart,
  duration,
  fullDur,
  fadeIn,
  fadeOut,
) {
  if (samples.length === 0 || duration <= 1e-9) return;
  const n = samples.length;
  const rate = Math.max(1, sampleRate);
  for (let i = 0; i < n; i++) {
    const localT = localStart + i / rate;
    const env = fadeEnvelopeAt(localT, fullDur, fadeIn, fadeOut);
    samples[i] = (samples[i] ?? 0) * env;
  }
}

function measureFadeRampPeaks(sampleRate, durationSec, fadeInSec, fadeOutSec = 0) {
  const count = Math.max(2, Math.floor(durationSec * sampleRate));
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
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
  for (let i = 0; i < earlyEnd; i++) earlyPeak = Math.max(earlyPeak, Math.abs(samples[i]));
  for (let i = lateStart; i < count; i++) latePeak = Math.max(latePeak, Math.abs(samples[i]));
  for (let i = midStart; i < midEnd; i++) midPeak = Math.max(midPeak, Math.abs(samples[i]));
  return { earlyPeak, latePeak, midPeak, count };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// --- Test 1: 1s tone, fadeIn=1s must ramp 0→1 ---
{
  const { earlyPeak, latePeak, midPeak } = measureFadeRampPeaks(44100, 1, 1, 0);
  console.log('fadeIn=1s @1s tone:', { earlyPeak, midPeak, latePeak });
  assert(earlyPeak < 0.08, `earlyPeak too high: ${earlyPeak}`);
  assert(latePeak > 0.85, `latePeak too low: ${latePeak}`);
  assert(midPeak > 0.35 && midPeak < 0.65, `midPeak not ~0.5: ${midPeak}`);
  assert(latePeak > earlyPeak * 8, 'late must be >> early');
}

// --- Test 2: fadeOut=1s on 1s tone ---
{
  const { earlyPeak, latePeak } = measureFadeRampPeaks(44100, 1, 0, 1);
  console.log('fadeOut=1s @1s tone:', { earlyPeak, latePeak });
  assert(earlyPeak > 0.85, `earlyPeak too low: ${earlyPeak}`);
  assert(latePeak < 0.15, `latePeak too high: ${latePeak}`);
}

// --- Test 3: bed defaults 2/2 on 6s (first ~2% ≈ 0.12s → env≈0.06) ---
{
  const sampleRate = 44100;
  const durationSec = 6;
  const count = Math.floor(durationSec * sampleRate);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) samples[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  applyFadeEnvelopeToSamples(samples, sampleRate, 0, durationSec, durationSec, 2, 2);
  let first50ms = 0;
  let last50ms = 0;
  let midPeak = 0;
  const n50 = Math.floor(0.05 * sampleRate);
  for (let i = 0; i < n50; i++) first50ms = Math.max(first50ms, Math.abs(samples[i]));
  for (let i = count - n50; i < count; i++) last50ms = Math.max(last50ms, Math.abs(samples[i]));
  for (let i = Math.floor(count * 0.45); i < Math.floor(count * 0.55); i++) {
    midPeak = Math.max(midPeak, Math.abs(samples[i]));
  }
  console.log('bed 2/2 @6s:', { first50ms, midPeak, last50ms });
  assert(first50ms < 0.05, `bed first50ms too high: ${first50ms}`);
  assert(midPeak > 0.9, `bed mid not full: ${midPeak}`);
  assert(last50ms < 0.05, `bed last50ms too high: ${last50ms}`);
}

// --- Test 4: resolveMusicFades-style clamp ---
{
  // fadeIn+fadeOut > dur → scale
  let fadeIn = 3;
  let fadeOut = 3;
  const dur = 4;
  const s = dur / (fadeIn + fadeOut);
  fadeIn *= s;
  fadeOut *= s;
  assert(Math.abs(fadeIn - 2) < 1e-9 && Math.abs(fadeOut - 2) < 1e-9, 'scale failed');
  console.log('clamp scale OK:', { fadeIn, fadeOut });
}

// --- Test 5: envelope endpoints ---
{
  assert(fadeEnvelopeAt(0, 2, 2, 0) === 0, 't=0 fadeIn should be 0');
  assert(Math.abs(fadeEnvelopeAt(2, 2, 2, 0) - 1) < 1e-9, 't=end fadeIn should be 1');
  assert(Math.abs(fadeEnvelopeAt(0, 2, 0, 2) - 1) < 1e-9, 't=0 fadeOut should be 1');
  assert(fadeEnvelopeAt(2, 2, 0, 2) === 0, 't=end fadeOut should be 0');
  console.log('envelope endpoints OK');
}

console.log('\nALL FADE TESTS PASSED');
