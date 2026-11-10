/**
 * IMU conditioning: tremor high-pass (2 Hz) and ANC reference.
 *
 * EDUCATIONAL SIMULATION ONLY. All data is synthetic. NOT a medical device.
 * Every constant below is an illustrative simulation value, not a clinical value.
 *
 * Two independent paths are fed from the RAW accelerometer axes:
 * - imuTremor: causal 2nd-order Butterworth high-pass (Q = 1/sqrt(2)) at 2 Hz
 *   on each axis. Feature extraction (band power or any other feature) belongs
 *   to a future module; this file stops at the conditioned signals.
 * - ancReference: z axis with only its slow DC/gravity component removed. The
 *   2 Hz tremor high-pass is deliberately NOT applied to the reference.
 */
import { designHighpass } from './butterworth.js';
import { filterBiquad, l1Norm } from './biquad.js';
import { ancReference } from './dcTracker.js';

/** High-pass corner of the tremor conditioner, Hz. */
export const TREMOR_HIGHPASS_HZ = 2;

const FS_MIN = 25;
const FS_MAX = 256;

function checkFs(fs) {
  if (typeof fs !== 'number') throw new TypeError('fs must be a number');
  if (!Number.isInteger(fs) || fs < FS_MIN || fs > FS_MAX) {
    throw new RangeError(`fs must be an integer in ${FS_MIN}..${FS_MAX}, got ${fs}`);
  }
}

function isArrayLike(x) {
  return x != null && typeof x !== 'string' && typeof x.length === 'number';
}

/**
 * The 2 Hz 2nd-order Butterworth high-pass section (Q = 1/sqrt(2)).
 * @param {number} fs integer sampling rate in 25..256 Hz
 * @returns {object} biquad section { b0, b1, b2, a1, a2 }
 * @throws {TypeError} fs not a number
 * @throws {RangeError} fs not an integer in 25..256
 */
export function tremorSection(fs) {
  checkFs(fs);
  return designHighpass(fs, TREMOR_HIGHPASS_HZ);
}

/**
 * Causal tremor high-pass of one axis (steady-state init, delay not compensated).
 * @param {ArrayLike<number>} axis
 * @param {number} fs
 * @returns {Float64Array} new array; axis is not mutated
 * @throws {TypeError} fs not a number, or axis not array-like
 * @throws {RangeError} fs not an integer in 25..256
 */
export function tremorHighpass(axis, fs) {
  checkFs(fs);
  if (!isArrayLike(axis)) throw new TypeError('axis must be an array-like of numbers');
  return filterBiquad(tremorSection(fs), axis, { steadyState: true });
}

/**
 * L1 norm of the tremor high-pass impulse response (bound: |y| <= L1 * max|x|).
 * @param {number} fs
 * @returns {number}
 * @throws {TypeError} fs not a number
 * @throws {RangeError} fs not an integer in 25..256
 */
export function tremorL1(fs) {
  return l1Norm([tremorSection(fs)], fs);
}

/**
 * Condition the raw accelerometer axes. Both outputs come from the raw axes;
 * the tremor path does not depend on the ANC reference. No features are
 * extracted here; that belongs to a future module.
 * @param {{x: ArrayLike<number>, y: ArrayLike<number>, z: ArrayLike<number>}} accel
 * @param {number} fs
 * @returns {{ancReference: Float64Array, imuTremor: {x: Float64Array, y: Float64Array, z: Float64Array}}}
 * @throws {TypeError} fs not a number, accel not an object, or an axis not array-like
 * @throws {RangeError} fs not an integer in 25..256, or axis lengths differ
 */
export function conditionImu(accel, fs) {
  checkFs(fs);
  if (accel == null || typeof accel !== 'object') {
    throw new TypeError('accel must be an object with x, y, z');
  }
  for (const k of ['x', 'y', 'z']) {
    if (!isArrayLike(accel[k])) throw new TypeError(`accel.${k} must be an array-like of numbers`);
  }
  const { x, y, z } = accel;
  if (x.length !== y.length || x.length !== z.length) {
    throw new RangeError(
      `accel.x, accel.y, accel.z must have equal lengths, got ${x.length}, ${y.length}, ${z.length}`
    );
  }
  return {
    ancReference: ancReference(z, fs),
    imuTremor: {
      x: tremorHighpass(x, fs),
      y: tremorHighpass(y, fs),
      z: tremorHighpass(z, fs),
    },
  };
}
