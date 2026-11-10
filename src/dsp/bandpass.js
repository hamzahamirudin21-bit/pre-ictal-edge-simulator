/**
 * PPG band-pass: 0.5-4 Hz, "4th order" = high-pass section then low-pass section.
 *
 * EDUCATIONAL SIMULATION ONLY. All data is synthetic. NOT a medical device.
 * Every constant below is an illustrative simulation value, not a clinical value.
 */
import { designHighpass, designLowpass } from './butterworth.js';
import { filterCascade, groupDelaySec, l1Norm } from './biquad.js';

/** High-pass corner of the PPG band-pass, Hz. */
export const PPG_HIGHPASS_HZ = 0.5;
/** Low-pass corner of the PPG band-pass, Hz. */
export const PPG_LOWPASS_HZ = 4;
/** Reference frequency for the reported group delay, Hz. */
export const GROUP_DELAY_REF_HZ = 1;

const FS_MIN = 25;
const FS_MAX = 256;

function checkFs(fs) {
  if (typeof fs !== 'number') throw new TypeError('fs must be a number');
  if (!Number.isInteger(fs) || fs < FS_MIN || fs > FS_MAX) {
    throw new RangeError(`fs must be an integer in ${FS_MIN}..${FS_MAX}, got ${fs}`);
  }
}

/**
 * The two cascaded 2nd-order Butterworth sections, high-pass first.
 * Total 4 poles and 4 zeros. This differs from an LP->BP-transformed
 * 2nd-order prototype (which would give a different pole/zero layout).
 * @param {number} fs integer sampling rate in 25..256 Hz
 * @returns {Array<object>} [highpass(0.5 Hz), lowpass(4 Hz)]
 * @throws {TypeError} fs not a number
 * @throws {RangeError} fs not an integer in 25..256
 */
export function bandpassSections(fs) {
  checkFs(fs);
  return [designHighpass(fs, PPG_HIGHPASS_HZ), designLowpass(fs, PPG_LOWPASS_HZ)];
}

/**
 * Design summary for meta.bandpass.
 * @param {number} fs
 * @returns {Readonly<{sections: Array<{b0:number,b1:number,b2:number,a1:number,a2:number}>, groupDelaySecAt1Hz: number, l1: number}>}
 */
export function bandpassDesign(fs) {
  const sections = bandpassSections(fs);
  return Object.freeze({
    sections: sections.map(({ b0, b1, b2, a1, a2 }) => ({ b0, b1, b2, a1, a2 })),
    groupDelaySecAt1Hz: groupDelaySec(sections, GROUP_DELAY_REF_HZ, fs),
    l1: l1Norm(sections, fs),
  });
}

/**
 * Causal band-pass of a PPG signal (steady-state init, delay not compensated).
 * @param {ArrayLike<number>} x
 * @param {number} fs
 * @returns {Float64Array} new array; x is not mutated
 * @throws {TypeError} fs not a number, or x not array-like
 * @throws {RangeError} fs not an integer in 25..256
 */
export function bandpassPpg(x, fs) {
  checkFs(fs);
  if (x == null || typeof x === 'string' || typeof x.length !== 'number') {
    throw new TypeError('x must be an array-like of numbers');
  }
  if (x.length === 0) return new Float64Array(0);
  return filterCascade(bandpassSections(fs), x, { steadyState: true });
}
