/**
 * Heart-rate / HRV model: feasibility clamp and RR-interval series.
 *
 * EDUCATIONAL SIMULATION ONLY. All data is synthetic. NOT a medical device.
 * `preIctalLikeness` is a simulation knob, not a clinical claim. Every constant
 * below is an illustrative simulation value, not a clinical value.
 *
 * Feasibility clamp (R3.4), with k = preIctalLikeness:
 *   effHr     = min(hr * (1 + 0.1k), 180)
 *   meanRrMs  = 60000 / effHr
 *   sdnnCap   = min(150, (meanRrMs - 300) / 2.5, (2000 - meanRrMs) / 2.5)
 *   effSdnn   = min(hrvSdnnMs * (1 - 0.5k), sdnnCap)
 * The cap keeps RR intervals inside [300, 2000] ms, so the RR clamp in
 * generateRRSeries is only a safety net and never alters valid series.
 */

/** Fractional mean-HR increase at preIctalLikeness = 1 (illustrative). */
export const HR_SHIFT_FRACTION = 0.1;
/** Fractional SDNN reduction at preIctalLikeness = 1 (illustrative). */
export const SDNN_REDUCTION_FRACTION = 0.5;
/** LF/HF = 1 + LFHF_SLOPE * k (illustrative). */
export const LFHF_SLOPE = 3;
/** Maximum effective heart rate, bpm (illustrative). */
export const HR_MAX_BPM = 180;
/** Minimum RR interval, ms (illustrative safety bound). */
export const RR_MIN_MS = 300;
/** Maximum RR interval, ms (illustrative safety bound). */
export const RR_MAX_MS = 2000;
/** Maximum effective SDNN, ms. */
export const SDNN_MAX_MS = 150;
/** Peak RR deviation is below CAP_FACTOR * SDNN, so the cap divides by this. */
export const SDNN_CAP_FACTOR = 2.5;
/** Low-frequency oscillation frequency, Hz (illustrative). */
export const LF_FREQ_HZ = 0.1;
/** High-frequency oscillation frequency, Hz (illustrative). */
export const HF_FREQ_HZ = 0.25;
/** Fraction of SDNN variance carried by the LF + HF sinusoids. */
export const SINUSOID_VARIANCE_FRACTION = 0.96;
/** Fraction of SDNN variance carried by beat-to-beat jitter. */
export const JITTER_VARIANCE_FRACTION = 0.04;
/** Jitter draws are clipped at +- this many jitter sigmas. */
export const JITTER_CLIP_SIGMAS = 2.5;

function requireFinite(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, got ${value}`);
  }
}

/**
 * Apply the pre-ictal-like shift and the feasibility clamp.
 * @param {number} heartRateBpm base mean heart rate
 * @param {number} hrvSdnnMs base SDNN in ms
 * @param {number} preIctalLikeness k in [0, 1] (simulation knob, not clinical)
 * @returns {{effectiveHrBpm: number, meanRrMs: number, effectiveSdnnMs: number,
 *   lfhf: number, clamped: {hr: boolean, sdnn: boolean}}}
 */
export function resolveHrv(heartRateBpm, hrvSdnnMs, preIctalLikeness) {
  requireFinite('heartRateBpm', heartRateBpm);
  requireFinite('hrvSdnnMs', hrvSdnnMs);
  requireFinite('preIctalLikeness', preIctalLikeness);
  const k = preIctalLikeness;

  const shiftedHr = heartRateBpm * (1 + HR_SHIFT_FRACTION * k);
  const effectiveHrBpm = Math.min(shiftedHr, HR_MAX_BPM);
  const meanRrMs = 60000 / effectiveHrBpm;

  const sdnnCap = Math.min(
    SDNN_MAX_MS,
    (meanRrMs - RR_MIN_MS) / SDNN_CAP_FACTOR,
    (RR_MAX_MS - meanRrMs) / SDNN_CAP_FACTOR,
  );
  const shiftedSd = hrvSdnnMs * (1 - SDNN_REDUCTION_FRACTION * k);
  const effectiveSdnnMs = Math.min(shiftedSd, sdnnCap);

  return {
    effectiveHrBpm,
    meanRrMs,
    effectiveSdnnMs,
    lfhf: 1 + LFHF_SLOPE * k,
    clamped: {
      hr: shiftedHr > HR_MAX_BPM,
      sdnn: shiftedSd > sdnnCap,
    },
  };
}

/**
 * Generate an RR series and beat times.
 *
 * The first beat is at t = 0. Each RR is
 *   meanRr + a_lf sin(2 pi f_lf t + phi_lf) + a_hf sin(2 pi f_hf t + phi_hf) + jitter
 * evaluated at the time t (s) of the beat that starts the interval, with
 * a_i = sqrt(2 P_i), P_lf / P_hf = lfhf, P_lf + P_hf = 0.96 effSdnn^2, and
 * jitter ~ N(0, (0.2 effSdnn)^2) clipped at +-2.5 sigma. Beats are added until
 * the last beat time exceeds durationSec (one beat past the end).
 * The RNG is always consumed identically (2 phases, then 1 gaussian per
 * interval), so the draw sequence does not depend on effSdnn. With
 * effSdnn === 0 every RR equals meanRrMs exactly.
 *
 * @param {{meanRrMs: number, effectiveSdnnMs: number, lfhf: number}} hrv result of resolveHrv
 * @param {number} durationSec recording length in seconds
 * @param {{next: () => number, gaussian: () => number}} rng from createRng(deriveSeed(seed, 'rr'))
 * @returns {{rrMs: Float64Array, beatTimes: Float64Array}} beatTimes in seconds, strictly increasing
 */
export function generateRRSeries(hrv, durationSec, rng) {
  const { meanRrMs, effectiveSdnnMs: sd, lfhf } = hrv;
  requireFinite('meanRrMs', meanRrMs);
  requireFinite('effectiveSdnnMs', sd);
  requireFinite('lfhf', lfhf);
  requireFinite('durationSec', durationSec);

  const totalPower = SINUSOID_VARIANCE_FRACTION * sd * sd;
  const pLf = (totalPower * lfhf) / (1 + lfhf);
  const pHf = totalPower - pLf;
  const aLf = Math.sqrt(2 * pLf);
  const aHf = Math.sqrt(2 * pHf);
  const sigmaJ = Math.sqrt(JITTER_VARIANCE_FRACTION) * sd;
  const jitterLimit = JITTER_CLIP_SIGMAS * sigmaJ;

  const phiLf = 2 * Math.PI * rng.next();
  const phiHf = 2 * Math.PI * rng.next();

  const rr = [];
  const beats = [0];
  let t = 0;
  while (t <= durationSec) {
    let g = rng.gaussian() * sigmaJ;
    if (g > jitterLimit) g = jitterLimit;
    else if (g < -jitterLimit) g = -jitterLimit;

    let interval = meanRrMs;
    if (sd !== 0) {
      interval +=
        aLf * Math.sin(2 * Math.PI * LF_FREQ_HZ * t + phiLf) +
        aHf * Math.sin(2 * Math.PI * HF_FREQ_HZ * t + phiHf) +
        g;
    }
    // Safety net only: never active for inputs that went through resolveHrv.
    interval = Math.min(Math.max(interval, RR_MIN_MS), RR_MAX_MS);

    rr.push(interval);
    t += interval / 1000;
    beats.push(t);
  }

  return { rrMs: Float64Array.from(rr), beatTimes: Float64Array.from(beats) };
}
