/**
 * NLMS adaptive noise canceller (ANC) with an activity gate and a weight clamp.
 *
 * EDUCATIONAL SIMULATION ONLY. All data is synthetic. NOT a medical device.
 * Every constant below is an illustrative simulation value, not a clinical value.
 *
 * Design trade-offs (design.md, Decision C):
 * - Signals: the primary d is the raw PPG (before the bandpass), and the
 *   reference r is ancReference(accel.z, fs) from dcTracker.js.
 * - Centred tap window: x_vec = r[n-D .. n+D] with D = round(0.1 * fs) (halves
 *   rounded up) and L = 2D + 1 taps, from 7 taps at 25 Hz to 53 at 256 Hz.
 *   Reference samples outside 0..N-1 count as 0. Module 1's artifact low-pass
 *   is zero-phase (two-sided), so a causal filter cannot model it. On a device
 *   the centred window costs a fixed latency of D samples; here the output
 *   stays aligned with the input index (e[n] belongs to d[n]).
 * - Update: y = w . x_vec, e = d - y, w <- w + mu * e * x_vec / (eps + x_vec . x_vec),
 *   with mu = 0.1, eps = L * 0.01^2 and w = 0 at the start. eps keeps the
 *   steps small when the reference is near silent.
 * - Gate: closed for n < 2 * fs. From n = 2 * fs on, it is closed while the
 *   population standard deviation of r[n - 2*fs .. n - 1] (the 2 * fs samples
 *   before n; the current sample is excluded) is below 0.01 g. While it is
 *   closed, the weights are frozen and e[n] = d[n] exactly. The causal window
 *   reacts up to one window late when motion starts and stays open up to one
 *   window after it stops; this lag is documented, not corrected.
 * - Weight clamp (safety net): after each update, if ||w||_2 > W_MAX = 10, w
 *   is rescaled to norm W_MAX. Then |y[n]| <= W_MAX * sqrt(L) * max|r|, so
 *   |e[n]| <= max|d| + W_MAX * sqrt(L) * max|r| up to floating-point rounding.
 * - Gate numerics: running sums of u = r - k and u^2 over the window, with k
 *   the window mean at the last exact recompute, give O(N) cost. The sums are
 *   recomputed exactly (two passes over the window) once per window length to
 *   limit drift, and also whenever the running variance is within its
 *   rounding-error bound of the threshold. The decisions therefore match a
 *   direct two-pass computation, except for windows whose standard deviation
 *   is within the rounding error of that computation from the threshold. The
 *   filter itself costs O(N * L).
 * - Range: for finite inputs with max|d| and max|r| up to 1e150, every
 *   intermediate value stays finite, so the output contains no NaN or
 *   Infinity. Larger magnitudes can overflow double precision. Module 1 output
 *   is far inside this range.
 */

/** Look-ahead (half-width) of the centred tap window, s: D = round(0.1 * fs) samples. */
export const ANC_LOOKAHEAD_SEC = 0.1;
/** NLMS step size mu. */
export const ANC_MU = 0.1;
/** Reference sigma floor for the regularization eps = L * ANC_SIGMA_FLOOR_G^2, g. */
export const ANC_SIGMA_FLOOR_G = 0.01;
/** Weight clamp W_MAX: the weight vector is rescaled to this norm when ||w||_2 exceeds it. */
export const ANC_W_MAX = 10;
/** Gate window length, s: the 2 * fs reference samples before the current sample. */
export const ANC_GATE_WINDOW_SEC = 2;
/** Gate threshold on the population standard deviation of the gate window, g. */
export const ANC_GATE_THRESHOLD_G = 0.01;

const FS_MIN = 25;
const FS_MAX = 256;

/**
 * Factor of the rounding-error bound for the running gate sums. The running
 * variance is trusted only when it differs from threshold^2 by more than
 * GATE_ROUNDING_FACTOR * G * max(u^2), where max(u^2) covers every sample seen
 * since the last exact recompute. The worst-case error of the running variance
 * is about 6 * G * 2^-53 * max(u^2); this factor is about 5 times larger.
 */
const GATE_ROUNDING_FACTOR = 16 * Number.EPSILON;

function checkFs(fs) {
  if (typeof fs !== 'number') throw new TypeError('fs must be a number');
  if (!Number.isInteger(fs) || fs < FS_MIN || fs > FS_MAX) {
    throw new RangeError(`fs must be an integer in ${FS_MIN}..${FS_MAX}, got ${fs}`);
  }
}

function checkArrayLike(x, name) {
  if (x == null || typeof x !== 'object' || !Number.isInteger(x.length) || x.length < 0) {
    throw new TypeError(`${name} must be an array-like of numbers`);
  }
}

function checkFinite(x, name) {
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!Number.isFinite(v)) {
      const got = typeof v === 'number' ? String(v) : typeof v;
      throw new RangeError(`${name}[${i}] must be a finite number, got ${got}`);
    }
  }
}

/**
 * Gate decision for every sample: 1 = closed, 0 = open. Closed for n < G; from
 * n = G on, closed while the population standard deviation of r[n - G .. n - 1]
 * is below threshold.
 * @param {ArrayLike<number>} r reference signal, finite samples
 * @param {number} G window length in samples (2 * fs)
 * @param {number} threshold standard-deviation threshold
 * @returns {Uint8Array}
 */
function gateDecisions(r, G, threshold) {
  const N = r.length;
  const closed = new Uint8Array(N);
  closed.fill(1, 0, Math.min(G, N));
  const thr2 = threshold * threshold;
  // Window sums of u = r[i] - k and u^2. The shift k is the window mean at the
  // last exact recompute, which keeps u small and limits cancellation.
  let k = 0;
  let s1 = 0;
  let s2 = 0;
  let qMax = 0; // largest u^2 seen since the last exact recompute
  let nextRecompute = G;

  const recompute = (n) => {
    let sum = 0;
    for (let i = n - G; i < n; i++) sum += r[i];
    k = sum / G;
    s1 = 0;
    s2 = 0;
    qMax = 0;
    for (let i = n - G; i < n; i++) {
      const u = r[i] - k;
      const q = u * u;
      s1 += u;
      s2 += q;
      if (q > qMax) qMax = q;
    }
    nextRecompute = n + G;
  };
  const variance = () => {
    const m = s1 / G;
    return Math.max(0, s2 / G - m * m);
  };

  for (let n = G; n < N; n++) {
    let v;
    if (n === nextRecompute) {
      recompute(n);
      v = variance();
    } else {
      // Slide the window by one sample: r[n - 1] enters, r[n - 1 - G] leaves.
      const uIn = r[n - 1] - k;
      const uOut = r[n - 1 - G] - k;
      const qIn = uIn * uIn;
      s1 += uIn - uOut;
      s2 += qIn - uOut * uOut;
      if (qIn > qMax) qMax = qIn;
      v = variance();
      if (Math.abs(v - thr2) <= GATE_ROUNDING_FACTOR * G * qMax) {
        // Too close to the threshold to trust the running sums.
        recompute(n);
        v = variance();
      }
    }
    closed[n] = Math.sqrt(v) < threshold ? 1 : 0;
  }
  return closed;
}

/**
 * Remove the reference-correlated part of d with a gated, clamped NLMS filter.
 *
 * For each sample n: if the gate is closed, e[n] = d[n] and the weights stay
 * frozen. Otherwise x_vec = r[n - D .. n + D] (0 outside 0..N-1),
 * y = w . x_vec, e[n] = d[n] - y, w <- w + mu * e[n] * x_vec / (eps + x_vec . x_vec),
 * and w is rescaled to norm W_MAX if ||w||_2 > W_MAX.
 *
 * @param {ArrayLike<number>} d primary signal (raw PPG), finite samples
 * @param {ArrayLike<number>} r reference signal (ancReference), finite samples,
 *   same length as d
 * @param {number} fs integer sampling rate in 25..256 Hz
 * @returns {{e: Float64Array, gatedFraction: number|null, weightClampActive: boolean,
 *   taps: number, lookaheadSamples: number, mu: number}}
 *   e: new array aligned with d (e[n] belongs to d[n]); gatedFraction: fraction
 *   of samples with the gate closed, null for zero-length input;
 *   weightClampActive: true if and only if the clamp rescaled w at least once;
 *   taps: L = 2D + 1; lookaheadSamples: D; mu: the step size.
 *   d and r are not mutated.
 * @throws {TypeError} fs not a number, or d or r not array-like
 * @throws {RangeError} fs not an integer in 25..256, d and r lengths differ, or
 *   a sample of d or r is not a finite number
 */
export function nlmsCancel(d, r, fs) {
  checkFs(fs);
  checkArrayLike(d, 'd');
  checkArrayLike(r, 'r');
  if (d.length !== r.length) {
    throw new RangeError(
      `d and r must have equal lengths, got d.length = ${d.length} and r.length = ${r.length}`
    );
  }
  checkFinite(d, 'd');
  checkFinite(r, 'r');

  const N = d.length;
  const D = Math.round(ANC_LOOKAHEAD_SEC * fs);
  const L = 2 * D + 1;
  const mu = ANC_MU;
  const eps = L * (ANC_SIGMA_FLOOR_G * ANC_SIGMA_FLOOR_G);
  const G = Math.round(ANC_GATE_WINDOW_SEC * fs);

  const closed = gateDecisions(r, G, ANC_GATE_THRESHOLD_G);
  const e = new Float64Array(N);
  const w = new Float64Array(L); // w[j] weights r[n - D + j]; starts at 0
  let closedCount = 0;
  let weightClampActive = false;

  for (let n = 0; n < N; n++) {
    if (closed[n] === 1) {
      e[n] = d[n];
      closedCount++;
      continue;
    }
    // Taps whose reference index n - D + j lies outside 0..N-1 see 0; skip them.
    const base = n - D;
    const j0 = Math.max(0, -base);
    const j1 = Math.min(L, N - base);
    let y = 0;
    let p = 0;
    for (let j = j0; j < j1; j++) {
      const x = r[base + j];
      y += w[j] * x;
      p += x * x;
    }
    const en = d[n] - y;
    e[n] = en;
    const g = (mu * en) / (eps + p);
    for (let j = j0; j < j1; j++) w[j] += g * r[base + j];
    let norm2 = 0;
    for (let j = 0; j < L; j++) norm2 += w[j] * w[j];
    const norm = Math.sqrt(norm2);
    if (norm > ANC_W_MAX) {
      const s = ANC_W_MAX / norm;
      for (let j = 0; j < L; j++) w[j] *= s;
      weightClampActive = true;
    }
  }

  return {
    e,
    gatedFraction: N === 0 ? null : closedCount / N,
    weightClampActive,
    taps: L,
    lookaheadSamples: D,
    mu,
  };
}
