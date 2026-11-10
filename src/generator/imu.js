/**
 * Synthetic 3-axis accelerometer (IMU) generator.
 *
 * EDUCATIONAL SIMULATION ONLY. All data is synthetic. NOT a medical device.
 * Every constant below is an illustrative simulation value, not a clinical value.
 *
 * Output is in g. Per axis: gravity component + clamp(dynamic, +-0.75 g), then
 * clamp to +-4 g. dynamic = motion + tremor + noise.
 *  - motion: sum of sinusoids in 0.3-2 Hz, peak <= 0.5 * motionIntensity g.
 *  - tremor: non-overlapping bursts, 3-6 Hz, Hann envelope, amplitude
 *    0.15 * tremorIntensity g. The schedule, phases and gains depend only on
 *    the seed and duration, so the tremor term is exactly linear in
 *    tremorIntensity (and exactly 0 at 0).
 *  - noise: Gaussian clipped at 4 sigma.
 * Bound: 0.5 + 0.15 + 0.06 = 0.71 < 0.75, so the clamps never act on valid
 * input; they are safety nets only.
 *
 * Random streams (all from deriveSeed): 'motion', 'noise', 'tremor'. The draw
 * count and order of each stream never depend on the intensities.
 */
import { createRng, deriveSeed } from './prng.js';

/** Motion peak amplitude per axis at motionIntensity = 1, g (illustrative). */
export const MOTION_AMPLITUDE_G = 0.5;
/** Motion component frequency range, Hz (illustrative). */
export const MOTION_FREQ_MIN_HZ = 0.3;
export const MOTION_FREQ_MAX_HZ = 2;
/** Number of sinusoids per motion axis. */
export const MOTION_COMPONENTS = 3;
/** Tremor amplitude at tremorIntensity = 1, g (illustrative). */
export const TREMOR_AMPLITUDE_G = 0.15;
/** Tremor burst frequency range, Hz (illustrative). */
export const TREMOR_FREQ_MIN_HZ = 3;
export const TREMOR_FREQ_MAX_HZ = 6;
/** Tremor burst length limits, s. Upper limit is also 0.8 * duration. */
export const TREMOR_BURST_MIN_SEC = 1.5;
export const TREMOR_BURST_MAX_SEC = 5;
/** Minimum and extra random gap between bursts, s. */
export const TREMOR_GAP_MIN_SEC = 0.25;
export const TREMOR_GAP_RANGE_SEC = 3;
/** Per-axis tremor gain range. */
export const TREMOR_GAIN_MIN = 0.5;
/** Noise sigma = NOISE_SIGMA_BASE_G + NOISE_SIGMA_MOTION_G * motionIntensity, g. */
export const NOISE_SIGMA_BASE_G = 0.005;
export const NOISE_SIGMA_MOTION_G = 0.01;
/** Noise draws are clipped at +- this many sigmas. */
export const NOISE_CLIP_SIGMAS = 4;
/** Safety-net bound on the dynamic (non-gravity) part, g. */
export const DYNAMIC_LIMIT_G = 0.75;
/** Safety-net bound on the final output, g. */
export const OUTPUT_LIMIT_G = 4;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Gravity vector: [0, 0, 1] rotated by pitch (about y) then roll (about x).
 * @param {number} pitchDeg
 * @param {number} rollDeg
 * @returns {[number, number, number]} unit vector, in g
 */
export function gravityVector(pitchDeg, rollDeg) {
  const p = (pitchDeg * Math.PI) / 180;
  const r = (rollDeg * Math.PI) / 180;
  return [Math.sin(p), -Math.cos(p) * Math.sin(r), Math.cos(p) * Math.cos(r)];
}

/**
 * Seed-determined tremor burst schedule. Uses only the 'tremor' stream and
 * never depends on tremorIntensity. Exactly 9 draws per burst. Bursts are
 * sequential, non-overlapping, fully inside [0, durationSec], and at least one
 * burst is always present (for durationSec >= 5).
 * @param {number} seed
 * @param {number} durationSec
 * @returns {ReadonlyArray<Readonly<{onsetSec: number, durationSec: number,
 *   freqHz: number, phase: number[], gain: number[]}>>}
 */
export function generateTremorSchedule(seed, durationSec) {
  const rng = createRng(deriveSeed(seed, 'tremor'));
  const maxLen = Math.min(TREMOR_BURST_MAX_SEC, 0.8 * durationSec);
  const bursts = [];
  let t = 0;
  for (;;) {
    const len = TREMOR_BURST_MIN_SEC + rng.next() * (maxLen - TREMOR_BURST_MIN_SEC);
    const gap = TREMOR_GAP_MIN_SEC + rng.next() * TREMOR_GAP_RANGE_SEC;
    const freqHz = TREMOR_FREQ_MIN_HZ + rng.next() * (TREMOR_FREQ_MAX_HZ - TREMOR_FREQ_MIN_HZ);
    const phase = [];
    const gain = [];
    for (let a = 0; a < 3; a++) phase.push(2 * Math.PI * rng.next());
    for (let a = 0; a < 3; a++) gain.push(TREMOR_GAIN_MIN + (1 - TREMOR_GAIN_MIN) * rng.next());

    let onset = bursts.length === 0 ? gap : t + gap;
    if (onset + len > durationSec) {
      if (bursts.length > 0) break;
      onset = Math.max(0, durationSec - len); // first burst always fits
    }
    bursts.push(
      Object.freeze({
        onsetSec: onset,
        durationSec: len,
        freqHz,
        phase: Object.freeze(phase),
        gain: Object.freeze(gain),
      }),
    );
    t = onset + len;
  }
  return Object.freeze(bursts);
}

/**
 * Generate the accelerometer signal. Does not mutate params.
 * @param {{seed: number, durationSec: number, fs: number, motionIntensity: number,
 *   tremorIntensity: number, orientation: {pitchDeg: number, rollDeg: number}}} params
 *   resolved parameters from validateParams
 * @returns {{x: Float64Array, y: Float64Array, z: Float64Array,
 *   gravity: number[], tremorBursts: {onsetSec: number, durationSec: number, freqHz: number}[]}}
 *   tremorBursts is the seed-determined schedule, returned regardless of tremorIntensity.
 */
export function generateIMU(params) {
  const { seed, durationSec, fs, motionIntensity, tremorIntensity, orientation } = params;
  const n = Math.round(durationSec * fs);
  const gravity = gravityVector(orientation.pitchDeg, orientation.rollDeg);

  // Unit motion components (fixed draw count: 3 per component per axis).
  const motionRng = createRng(deriveSeed(seed, 'motion'));
  const motion = [];
  for (let a = 0; a < 3; a++) {
    const comps = [];
    let ampSum = 0;
    for (let c = 0; c < MOTION_COMPONENTS; c++) {
      const freq = MOTION_FREQ_MIN_HZ + motionRng.next() * (MOTION_FREQ_MAX_HZ - MOTION_FREQ_MIN_HZ);
      const phase = 2 * Math.PI * motionRng.next();
      const amp = 0.5 + 0.5 * motionRng.next();
      ampSum += amp;
      comps.push({ w: 2 * Math.PI * freq, phase, amp });
    }
    for (const c of comps) c.amp /= ampSum; // sum of amplitudes = 1, so peak <= 1
    motion.push(comps);
  }

  const schedule = generateTremorSchedule(seed, durationSec);
  const noiseRng = createRng(deriveSeed(seed, 'noise'));

  const motionScale = MOTION_AMPLITUDE_G * motionIntensity;
  const tremorScale = TREMOR_AMPLITUDE_G * tremorIntensity;
  const sigma = NOISE_SIGMA_BASE_G + NOISE_SIGMA_MOTION_G * motionIntensity;

  const out = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];

  // Unit tremor per axis, evaluated only inside bursts.
  const tremorUnit = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  for (const b of schedule) {
    const i0 = Math.max(0, Math.ceil(b.onsetSec * fs));
    const i1 = Math.min(n - 1, Math.floor((b.onsetSec + b.durationSec) * fs));
    for (let i = i0; i <= i1; i++) {
      const tl = i / fs - b.onsetSec;
      const hann = 0.5 * (1 - Math.cos((2 * Math.PI * tl) / b.durationSec));
      for (let a = 0; a < 3; a++) {
        tremorUnit[a][i] = b.gain[a] * hann * Math.sin(2 * Math.PI * b.freqHz * tl + b.phase[a]);
      }
    }
  }

  for (let i = 0; i < n; i++) {
    const t = i / fs;
    for (let a = 0; a < 3; a++) {
      let m = 0;
      for (const c of motion[a]) m += c.amp * Math.sin(c.w * t + c.phase);
      const g = clamp(noiseRng.gaussian(), -NOISE_CLIP_SIGMAS, NOISE_CLIP_SIGMAS);
      const dyn = motionScale * m + tremorScale * tremorUnit[a][i] + sigma * g;
      out[a][i] = clamp(
        gravity[a] + clamp(dyn, -DYNAMIC_LIMIT_G, DYNAMIC_LIMIT_G),
        -OUTPUT_LIMIT_G,
        OUTPUT_LIMIT_G,
      );
    }
  }

  return {
    x: out[0],
    y: out[1],
    z: out[2],
    gravity,
    tremorBursts: schedule.map((b) => ({
      onsetSec: b.onsetSec,
      durationSec: b.durationSec,
      freqHz: b.freqHz,
    })),
  };
}
