/**
 * Biquad filtering and analysis (transposed Direct Form II, causal, double precision).
 *
 * EDUCATIONAL SIMULATION ONLY. All data is synthetic. NOT a medical device.
 * Every constant below is an illustrative simulation value, not a clinical value.
 *
 * A section is { b0, b1, b2, a1, a2 } with a0 = 1:
 *   y  = b0 x + z1
 *   z1 = b1 x - a1 y + z2
 *   z2 = b2 x - a2 y
 */

/** Impulse-response tail tolerance for the L1 norm. */
export const L1_TAIL_TOL = 1e-12;
/** Hard cap on impulse-response length for l1Norm, in seconds of samples. */
export const L1_MAX_SECONDS = 600;
/** Frequency step for the numerical group delay, Hz. */
export const GROUP_DELAY_DF_HZ = 1e-4;

/**
 * DC gain H(1) = (b0 + b1 + b2) / (1 + a1 + a2).
 * @param {{b0:number,b1:number,b2:number,a1:number,a2:number}} s
 * @returns {number}
 */
export function dcGain(s) {
  return (s.b0 + s.b1 + s.b2) / (1 + s.a1 + s.a2);
}

/**
 * Filter one section causally in a single forward pass.
 * With steadyState and a non-empty input, the state is set for a constant input
 * x0 = x[0], so a constant x0 gives the constant output dcGain * x0 from sample 0.
 * @param {{b0:number,b1:number,b2:number,a1:number,a2:number}} section
 * @param {ArrayLike<number>} x
 * @param {{steadyState?: boolean}} [options]
 * @returns {Float64Array} new array; inputs are not mutated
 */
export function filterBiquad(section, x, { steadyState = false } = {}) {
  const { b0, b1, b2, a1, a2 } = section;
  const n = x.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  let z1 = 0;
  let z2 = 0;
  if (steadyState) {
    const G = dcGain(section);
    const x0 = x[0];
    z2 = (b2 - a2 * G) * x0;
    z1 = (b1 - a1 * G) * x0 + z2;
  }
  for (let i = 0; i < n; i++) {
    const xi = x[i];
    const y = b0 * xi + z1;
    z1 = b1 * xi - a1 * y + z2;
    z2 = b2 * xi - a2 * y;
    out[i] = y;
  }
  return out;
}

/**
 * Apply sections in order. With steadyState each section is initialized from
 * its own first input sample.
 * @param {Array<{b0:number,b1:number,b2:number,a1:number,a2:number}>} sections
 * @param {ArrayLike<number>} x
 * @param {{steadyState?: boolean}} [options]
 * @returns {Float64Array} new array
 */
export function filterCascade(sections, x, { steadyState = false } = {}) {
  let cur = Float64Array.from(x);
  for (const s of sections) cur = filterBiquad(s, cur, { steadyState });
  return cur;
}

/**
 * Complex frequency response of one section at f Hz.
 * @returns {{re:number, im:number}}
 */
export function responseAt(s, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  // Numerator/denominator in e^{-jw}: b0 + b1 e^{-jw} + b2 e^{-2jw}
  const nr = s.b0 + s.b1 * c1 + s.b2 * c2;
  const ni = -(s.b1 * s1 + s.b2 * s2);
  const dr = 1 + s.a1 * c1 + s.a2 * c2;
  const di = -(s.a1 * s1 + s.a2 * s2);
  const den = dr * dr + di * di;
  return { re: (nr * dr + ni * di) / den, im: (ni * dr - nr * di) / den };
}

/**
 * Complex response of a cascade (product of section responses).
 * @returns {{re:number, im:number}}
 */
export function cascadeResponseAt(sections, f, fs) {
  let re = 1;
  let im = 0;
  for (const s of sections) {
    const h = responseAt(s, f, fs);
    const r = re * h.re - im * h.im;
    im = re * h.im + im * h.re;
    re = r;
  }
  return { re, im };
}

/**
 * Magnitude |H(e^{j 2 pi f / fs})| of one section.
 * @returns {number}
 */
export function magnitudeAt(s, f, fs) {
  const h = responseAt(s, f, fs);
  return Math.hypot(h.re, h.im);
}

/**
 * Largest pole magnitude: roots of z^2 + a1 z + a2.
 * @returns {number}
 */
export function poleRadius(s) {
  const disc = s.a1 * s.a1 - 4 * s.a2;
  if (disc < 0) return Math.sqrt(s.a2);
  const r = Math.sqrt(disc);
  return Math.max(Math.abs((-s.a1 + r) / 2), Math.abs((-s.a1 - r) / 2));
}

/**
 * Group delay (seconds) of a cascade at f Hz, -dphi/domega, from the numerical
 * phase derivative. The phase difference between f -/+ df is taken as
 * atan2(Im(H(f-df)* H(f+df)... )) i.e. the wrapped angle of H(f+df)/H(f-df),
 * which is the unwrapped difference for a small step; then a central difference
 * with df = GROUP_DELAY_DF_HZ gives tau = -dphi / (2 pi * 2 df).
 * @returns {number}
 */
export function groupDelaySec(sections, f, fs) {
  const df = GROUP_DELAY_DF_HZ;
  const lo = cascadeResponseAt(sections, f - df, fs);
  const hi = cascadeResponseAt(sections, f + df, fs);
  // angle(hi / lo) = angle(hi * conj(lo)), wrapped to (-pi, pi]
  const dphi = Math.atan2(hi.im * lo.re - hi.re * lo.im, hi.re * lo.re + hi.im * lo.im);
  return -dphi / (2 * Math.PI * 2 * df);
}

/**
 * L1 norm of the cascade impulse response, sum |h[n]|, accumulated until
 * |h[n]| stays below L1_TAIL_TOL for ceil(fs) consecutive samples.
 * @throws {Error} if not converged within L1_MAX_SECONDS * fs samples
 * @returns {number}
 */
export function l1Norm(sections, fs) {
  const tail = Math.ceil(fs);
  const cap = Math.ceil(L1_MAX_SECONDS * fs);
  const states = sections.map(() => [0, 0]);
  let sum = 0;
  let quiet = 0;
  for (let n = 0; n < cap; n++) {
    let v = n === 0 ? 1 : 0;
    for (let k = 0; k < sections.length; k++) {
      const s = sections[k];
      const st = states[k];
      const y = s.b0 * v + st[0];
      st[0] = s.b1 * v - s.a1 * y + st[1];
      st[1] = s.b2 * v - s.a2 * y;
      v = y;
    }
    const a = Math.abs(v);
    sum += a;
    quiet = a < L1_TAIL_TOL ? quiet + 1 : 0;
    if (quiet >= tail) return sum;
  }
  throw new Error('l1Norm did not converge; sections may be unstable');
}
