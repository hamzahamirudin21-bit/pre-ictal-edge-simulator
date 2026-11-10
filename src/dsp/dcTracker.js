/**
 * DC tracker and ANC reference: r = z - slowly-tracked DC of z.
 *
 * EDUCATIONAL SIMULATION ONLY. All data is synthetic. NOT a medical device.
 * Every constant below is an illustrative simulation value, not a clinical value.
 *
 * Design trade-offs (design.md, Decision B, path B2):
 * - The tracker is a one-pole low-pass at DC_TRACKER_HZ, so r = z - dc acts
 *   as a one-pole high-pass on the reference. At 0.3 Hz that costs a gain of
 *   0.980-0.986 depending on fs (0.9802 at 25 Hz, 0.9840 at 64 Hz,
 *   0.9858 at 256 Hz) and a phase lead of about 9.5 degrees.
 * - Start-up: dc[0] = z[0], so a start-up offset in z decays with
 *   tau ~ 3.2 s (1 / (2*pi*0.05 Hz)).
 * - The device z axis is used as the reference. This matches Module 1's
 *   artifact model and is a teaching simplification.
 * - The reference deliberately does NOT use the 2 Hz high-pass of the
 *   tremor conditioner. Module 1's artifact is
 *   artifactGain * 2 * lowpass8Hz(z - g_z), which carries its motion energy
 *   at 0.3-2 Hz; a 2 Hz high-pass would remove most of what the ANC must
 *   cancel.
 */

/** Corner frequency of the DC tracker, Hz. */
export const DC_TRACKER_HZ = 0.05;

const FS_MIN = 25;
const FS_MAX = 256;

function checkFs(fs) {
  if (typeof fs !== 'number') throw new TypeError('fs must be a number');
  if (!Number.isInteger(fs) || fs < FS_MIN || fs > FS_MAX) {
    throw new RangeError(`fs must be an integer in ${FS_MIN}..${FS_MAX}, got ${fs}`);
  }
}

function checkSignal(z) {
  if (z == null || typeof z === 'string' || typeof z.length !== 'number') {
    throw new TypeError('z must be an array-like of numbers');
  }
}

/**
 * Smoothing coefficient of the one-pole DC tracker.
 * @param {number} fs integer sampling rate in 25..256 Hz
 * @returns {number} beta = 1 - exp(-2*pi*DC_TRACKER_HZ/fs)
 * @throws {TypeError} fs not a number
 * @throws {RangeError} fs not an integer in 25..256
 */
export function dcTrackerBeta(fs) {
  checkFs(fs);
  return 1 - Math.exp((-2 * Math.PI * DC_TRACKER_HZ) / fs);
}

/**
 * Track the slow (DC) component of z.
 * dc[0] = z[0]; dc[n] = dc[n-1] + beta * (z[n] - dc[n-1]).
 * @param {ArrayLike<number>} z
 * @param {number} fs
 * @returns {Float64Array} new array; z is not mutated
 * @throws {TypeError} fs not a number, or z not array-like
 * @throws {RangeError} fs not an integer in 25..256
 */
export function trackDc(z, fs) {
  const beta = dcTrackerBeta(fs);
  checkSignal(z);
  const n = z.length;
  const dc = new Float64Array(n);
  if (n === 0) return dc;
  dc[0] = z[0];
  for (let i = 1; i < n; i++) dc[i] = dc[i - 1] + beta * (z[i] - dc[i - 1]);
  return dc;
}

/**
 * ANC reference: r[n] = z[n] - dc[n]. No other filtering is applied.
 * A constant z gives r exactly 0.
 * @param {ArrayLike<number>} z
 * @param {number} fs
 * @returns {Float64Array} new array; z is not mutated
 * @throws {TypeError} fs not a number, or z not array-like
 * @throws {RangeError} fs not an integer in 25..256
 */
export function ancReference(z, fs) {
  const dc = trackDc(z, fs);
  const r = new Float64Array(dc.length);
  for (let i = 0; i < r.length; i++) r[i] = z[i] - dc[i];
  return r;
}
