/**
 * Synthetic PPG rendering: per-beat pulses, normalization, respiratory wander.
 *
 * EDUCATIONAL SIMULATION ONLY. All data is synthetic. NOT a medical device.
 * Every constant below is an illustrative simulation value, not a clinical value.
 *
 * Pipeline: sum of pulses (systolic Gaussian + smaller diastolic Gaussian),
 * divide by max|x| (pulse part has max |x| = 1 exactly), add respiratory
 * baseline wander, clip to [-PPG_CLIP, PPG_CLIP]. With the amplitudes below
 * the result satisfies |x| <= 1 + WANDER_AMPLITUDE.
 */

/** Systolic peak position as a fraction of the local RR interval. */
export const SYSTOLIC_CENTER_FRAC = 0.15;
/** Systolic Gaussian sigma as a fraction of the local RR interval. */
export const SYSTOLIC_SIGMA_FRAC = 0.07;
/** Diastolic (dicrotic) peak position as a fraction of the local RR interval. */
export const DIASTOLIC_CENTER_FRAC = 0.4;
/** Diastolic Gaussian sigma as a fraction of the local RR interval. */
export const DIASTOLIC_SIGMA_FRAC = 0.09;
/** Diastolic amplitude relative to the systolic amplitude. */
export const DIASTOLIC_AMPLITUDE = 0.35;
/** Beat-to-beat width variation: width scale is 1 +- this fraction. */
export const WIDTH_VARIATION = 0.1;
/** Beat-to-beat amplitude variation: amplitude scale is 1 +- this fraction. */
export const AMPLITUDE_VARIATION = 0.05;
/** Local RR (s) assumed when no neighbouring interval exists. */
export const DEFAULT_RR_SEC = 0.8;
/** Respiratory baseline wander frequency, Hz. */
export const WANDER_FREQ_HZ = 0.25;
/** Respiratory baseline wander amplitude (peak). */
export const WANDER_AMPLITUDE = 0.05;
/** Final safety clip bound. */
export const PPG_CLIP = 1.5;
/** Gaussians are evaluated within +- this many sigmas of their center. */
export const GAUSSIAN_WINDOW_SIGMAS = 4;

function addGaussian(out, n, fs, center, sigma, amp) {
  const half = GAUSSIAN_WINDOW_SIGMAS * sigma;
  const lo = Math.max(0, Math.ceil((center - half) * fs));
  const hi = Math.min(n - 1, Math.floor((center + half) * fs));
  const inv = 1 / (2 * sigma * sigma);
  for (let i = lo; i <= hi; i++) {
    const d = i / fs - center;
    out[i] += amp * Math.exp(-d * d * inv);
  }
}

/**
 * Render a clean synthetic PPG waveform.
 * @param {Float64Array} beatTimes beat start times in seconds, increasing
 * @param {number} n number of samples
 * @param {number} fs sampling rate in Hz
 * @param {{next: () => number}} rng from createRng(deriveSeed(seed, 'ppg'))
 *   Consumed exactly 1 + 2 * beatTimes.length times, independent of values.
 * @returns {Float64Array} length n, values in [-1.5, 1.5]
 */
export function renderPPG(beatTimes, n, fs, rng) {
  const out = new Float64Array(n);
  const phase = 2 * Math.PI * rng.next();

  for (let b = 0; b < beatTimes.length; b++) {
    const wDraw = rng.next();
    const aDraw = rng.next();
    const t0 = beatTimes[b];
    let rr;
    if (b + 1 < beatTimes.length) rr = beatTimes[b + 1] - t0;
    else if (b > 0) rr = t0 - beatTimes[b - 1];
    else rr = DEFAULT_RR_SEC;
    if (!(rr > 0)) rr = DEFAULT_RR_SEC;

    const width = 1 + WIDTH_VARIATION * (2 * wDraw - 1);
    const amp = 1 + AMPLITUDE_VARIATION * (2 * aDraw - 1);

    addGaussian(out, n, fs, t0 + SYSTOLIC_CENTER_FRAC * rr, SYSTOLIC_SIGMA_FRAC * rr * width, amp);
    addGaussian(
      out, n, fs,
      t0 + DIASTOLIC_CENTER_FRAC * rr,
      DIASTOLIC_SIGMA_FRAC * rr * width,
      DIASTOLIC_AMPLITUDE * amp,
    );
  }

  let peak = 0;
  for (let i = 0; i < n; i++) {
    const a = Math.abs(out[i]);
    if (a > peak) peak = a;
  }
  const scale = peak > 0 ? 1 / peak : 1;

  for (let i = 0; i < n; i++) {
    let v = out[i] * scale + WANDER_AMPLITUDE * Math.sin(2 * Math.PI * WANDER_FREQ_HZ * (i / fs) + phase);
    if (v > PPG_CLIP) v = PPG_CLIP;
    else if (v < -PPG_CLIP) v = -PPG_CLIP;
    out[i] = v;
  }
  return out;
}
