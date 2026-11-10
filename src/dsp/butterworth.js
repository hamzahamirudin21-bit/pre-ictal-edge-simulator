/**
 * 2nd-order Butterworth biquad design (low-pass / high-pass).
 *
 * EDUCATIONAL SIMULATION ONLY. All data is synthetic. NOT a medical device.
 * Every constant below is an illustrative simulation value, not a clinical value.
 *
 * Bilinear transform with frequency prewarping, K = tan(pi * fc / fs),
 * RBJ-cookbook equivalent in K-form, normalized so that a0 = 1:
 *
 *   norm = 1 / (1 + K/Q + K^2)
 *   a1 = 2 (K^2 - 1) norm,  a2 = (1 - K/Q + K^2) norm
 *   low-pass:  b0 = K^2 norm, b1 = 2 b0, b2 = b0
 *   high-pass: b0 = norm,     b1 = -2 b0, b2 = b0
 */

/** Butterworth quality factor for a 2nd-order section, 1/sqrt(2). */
export const BUTTERWORTH_Q = Math.SQRT1_2;

function checkDesign(fs, fc) {
  if (typeof fs !== 'number') throw new TypeError('fs must be a number');
  if (!Number.isFinite(fs) || !(fs > 0)) {
    throw new RangeError(`fs must be a finite number > 0, got ${fs}`);
  }
  if (typeof fc !== 'number') throw new TypeError('fc must be a number');
  if (!Number.isFinite(fc) || !(fc > 0) || !(fc < fs / 2)) {
    throw new RangeError(`fc must be in (0, fs/2) = (0, ${fs / 2}) for fs = ${fs}, got ${fc}`);
  }
}

function kTerms(fs, fc) {
  const K = Math.tan((Math.PI * fc) / fs);
  const K2 = K * K;
  const norm = 1 / (1 + K / BUTTERWORTH_Q + K2);
  return {
    K2,
    norm,
    a1: 2 * (K2 - 1) * norm,
    a2: (1 - K / BUTTERWORTH_Q + K2) * norm,
  };
}

/**
 * 2nd-order Butterworth low-pass section (DC gain 1).
 * @param {number} fs sampling rate, Hz
 * @param {number} fc cutoff, Hz, in (0, fs/2)
 * @returns {Readonly<{b0:number,b1:number,b2:number,a1:number,a2:number,type:string,fc:number,fs:number}>}
 * @throws {TypeError} if fs or fc is not a number
 * @throws {RangeError} if fs is not finite > 0, or fc is outside (0, fs/2)
 */
export function designLowpass(fs, fc) {
  checkDesign(fs, fc);
  const { K2, norm, a1, a2 } = kTerms(fs, fc);
  const b0 = K2 * norm;
  return Object.freeze({ b0, b1: 2 * b0, b2: b0, a1, a2, type: 'lowpass', fc, fs });
}

/**
 * 2nd-order Butterworth high-pass section (DC gain 0).
 * @param {number} fs sampling rate, Hz
 * @param {number} fc cutoff, Hz, in (0, fs/2)
 * @returns {Readonly<{b0:number,b1:number,b2:number,a1:number,a2:number,type:string,fc:number,fs:number}>}
 * @throws {TypeError} if fs or fc is not a number
 * @throws {RangeError} if fs is not finite > 0, or fc is outside (0, fs/2)
 */
export function designHighpass(fs, fc) {
  checkDesign(fs, fc);
  const { norm, a1, a2 } = kTerms(fs, fc);
  const b0 = norm;
  return Object.freeze({ b0, b1: -2 * b0, b2: b0, a1, a2, type: 'highpass', fc, fs });
}
