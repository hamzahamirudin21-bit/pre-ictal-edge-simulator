/**
 * Motion artifact for the synthetic PPG, correlated with accelerometer z.
 *
 * EDUCATIONAL SIMULATION ONLY. All data is synthetic. NOT a medical device.
 * Every constant below is an illustrative simulation value, not a clinical value.
 *
 *   dynZ     = z - g_z       (gravity subtraction on the fixed device z axis;
 *                             g_z = gravityVector(pitch, roll)[2])
 *   smooth   = lowpassZeroPhase(dynZ, fs, 8 Hz)
 *   artifact = artifactGain * ARTIFACT_SCALE * smooth
 *   ppg      = clamp(ppgClean + artifact, -PPG_ARTIFACT_CLIP, PPG_ARTIFACT_CLIP)
 *
 * The low-pass is a convex single-pole filter run forward then backward, so
 * its kernel is non-negative with unit DC gain (constant input is preserved
 * exactly). The artifact is a signed projection, not a magnitude.
 *
 * Bound: the IMU output is z = clamp(g_z + clamp(dyn, -0.75, 0.75), -4, 4)
 * with |g_z| <= 1, so the outer clamp never acts and dynZ equals the clamped
 * dynamic part (up to ~1e-15 rounding). Hence |dynZ| <= 0.75 (at most 0.71 by
 * construction). The non-negative unit-sum kernel gives |smooth| <= 0.75, so
 * |artifact| <= 1.5 and |ppgClean + artifact| <= 1.05 + 1.5 = 2.55 < 3; the
 * final clamp is a safety net. Mean removal was rejected because a
 * mean-removed signal can reach the full peak-to-peak range (~1.42 g), which
 * would break this bound.
 */

/** Artifact amplitude per unit of smoothed dynamic z, PPG units per g (illustrative). */
export const ARTIFACT_SCALE = 2.0;
/** Low-pass cutoff applied to dynamic z, Hz (illustrative). */
export const ARTIFACT_LOWPASS_HZ = 8;
/** Final safety clip bound for ppg = ppgClean + artifact. */
export const PPG_ARTIFACT_CLIP = 3;

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Zero-phase single-pole low-pass: forward pass then backward pass.
 * Update is y += alpha * (x - y), alpha = 1 - exp(-2*pi*fc/fs) in (0, 1].
 * Forward pass starts with y = x[0] (so out[0] of that pass is x[0]); the
 * backward pass runs from the end, starting with y = last forward output.
 * @param {ArrayLike<number>} signal
 * @param {number} fs sampling rate, Hz (> 0, finite)
 * @param {number} [fcHz=8] cutoff, Hz (> 0, finite)
 * @returns {Float64Array} new array; the input is not mutated
 * @throws {RangeError} if fs or fcHz is not a positive finite number
 */
export function lowpassZeroPhase(signal, fs, fcHz = ARTIFACT_LOWPASS_HZ) {
  if (typeof fs !== 'number' || !Number.isFinite(fs) || !(fs > 0)) {
    throw new RangeError('fs must be a positive finite number');
  }
  if (typeof fcHz !== 'number' || !Number.isFinite(fcHz) || !(fcHz > 0)) {
    throw new RangeError('fcHz must be a positive finite number');
  }
  const n = signal.length;
  const out = new Float64Array(n);
  if (n === 0) return out;

  const alpha = 1 - Math.exp((-2 * Math.PI * fcHz) / fs);
  let y = signal[0];
  out[0] = y;
  for (let i = 1; i < n; i++) {
    y += alpha * (signal[i] - y);
    out[i] = y;
  }
  y = out[n - 1];
  for (let i = n - 2; i >= 0; i--) {
    y += alpha * (out[i] - y);
    out[i] = y;
  }
  return out;
}

function checkGravityZ(gravityZ) {
  if (typeof gravityZ !== 'number') throw new TypeError('gravityZ must be a number');
  if (!Number.isFinite(gravityZ) || gravityZ < -1 || gravityZ > 1) {
    throw new RangeError('gravityZ must be a finite number in [-1, 1]');
  }
}

/**
 * Dynamic z (gravity subtracted) and its zero-phase low-pass (artifact shape).
 * dynZ[i] = accelZ[i] - gravityZ; no mean removal.
 * @param {ArrayLike<number>} accelZ accelerometer z, g
 * @param {number} gravityZ gravity component on z, g_z = gravityVector(pitch, roll)[2], in [-1, 1]
 * @param {number} fs sampling rate, Hz
 * @returns {{dynZ: Float64Array, smooth: Float64Array}}
 * @throws {TypeError} if gravityZ is not a number
 * @throws {RangeError} if gravityZ is non-finite or outside [-1, 1]
 */
export function artifactComponents(accelZ, gravityZ, fs) {
  checkGravityZ(gravityZ);
  const n = accelZ.length;
  const dynZ = new Float64Array(n);
  for (let i = 0; i < n; i++) dynZ[i] = accelZ[i] - gravityZ;
  return { dynZ, smooth: lowpassZeroPhase(dynZ, fs, ARTIFACT_LOWPASS_HZ) };
}

/**
 * Motion artifact: artifactGain * ARTIFACT_SCALE * lowpass(z - g_z).
 * With artifactGain === 0 every sample is exactly +0.
 * @param {ArrayLike<number>} accelZ accelerometer z, g
 * @param {number} gravityZ gravity component on z, in [-1, 1] (required)
 * @param {number} artifactGain in [0, 1]
 * @param {number} fs sampling rate, Hz
 * @returns {Float64Array}
 * @throws {TypeError} if gravityZ is not a number
 * @throws {RangeError} if gravityZ is non-finite or outside [-1, 1]
 */
export function computeArtifact(accelZ, gravityZ, artifactGain, fs) {
  checkGravityZ(gravityZ);
  if (artifactGain === 0) return new Float64Array(accelZ.length);
  const { smooth } = artifactComponents(accelZ, gravityZ, fs);
  const k = artifactGain * ARTIFACT_SCALE;
  const out = new Float64Array(smooth.length);
  for (let i = 0; i < smooth.length; i++) out[i] = k * smooth[i];
  return out;
}

/**
 * ppg = clamp(ppgClean + artifact, -3, 3). If every artifact sample is zero,
 * returns an exact copy of ppgClean (preserves -0 and equality exactly).
 * Inputs are not mutated.
 * @param {ArrayLike<number>} ppgClean
 * @param {ArrayLike<number>} artifact same length as ppgClean
 * @returns {Float64Array}
 * @throws {RangeError} if lengths differ
 */
export function applyArtifact(ppgClean, artifact) {
  const n = ppgClean.length;
  if (artifact.length !== n) {
    throw new RangeError(`artifact length ${artifact.length} must equal ppgClean length ${n}`);
  }
  const out = new Float64Array(n);
  let allZero = true;
  for (let i = 0; i < n; i++) {
    if (artifact[i] !== 0) {
      allZero = false;
      break;
    }
  }
  if (allZero) {
    out.set(ppgClean);
    return out;
  }
  for (let i = 0; i < n; i++) {
    out[i] = clamp(ppgClean[i] + artifact[i], -PPG_ARTIFACT_CLIP, PPG_ARTIFACT_CLIP);
  }
  return out;
}
