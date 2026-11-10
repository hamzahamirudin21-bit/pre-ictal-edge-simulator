import { describe, it, expect } from 'vitest';
import { nlmsCancel } from '../src/dsp/anc.js';
import { ancReference } from '../src/dsp/dcTracker.js';
import { createRng } from '../src/generator/prng.js';
import { generateSignals } from '../src/generator/index.js';

// Every reference value in this file comes from the spec numbers below, hardcoded on
// purpose. No reference reads a constant or a returned parameter of src/dsp/anc.js.
// Inputs come from Module 1 (createRng, generateSignals) and from ancReference in
// src/dsp/dcTracker.js, which test/dsp.imu.test.js covers.

const FS_LIST = [25, 64, 256];

const MU = 0.1; // R8.3 step size
const SIGMA_FLOOR = 0.01; // R8.3: eps = L * 0.01^2
const W_MAX = 10; // R10.1 weight-norm clamp
const GATE_SEC = 2; // R9.1: the gate window is the 2 * fs samples before n
const GATE_STD = 0.01; // R9.2: the gate is closed while the window std is below 0.01 g
const RESIDUAL_RATIO = 1e-3; // R8.5 residual-to-primary power target

/** D = round(0.1 * fs) with halves rounded up (R8.2), in an independent integer form. */
const lookahead = (fs) => Math.floor((fs + 5) / 10);

function gaussianNoise(n, seed, std) {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => std * rng.gaussian());
}

function randomInput(n, seed) {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => rng.next() * 2 - 1);
}

function maxAbs(x) {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  return m;
}

function l2(v) {
  let s = 0;
  for (const x of v) s += x * x;
  return Math.sqrt(s);
}

/** First index i in [from, to) where Object.is(a[i], b[i]) is false, or -1. */
function firstMismatch(a, b, from = 0, to = a.length) {
  for (let i = from; i < to; i++) if (!Object.is(a[i], b[i])) return i;
  return -1;
}

/** Number of closed samples, recovered from gatedFraction = closed / N. */
const closedCount = (out, N) => Math.round(out.gatedFraction * N);

/** Population standard deviation of r[a .. b - 1], direct two-pass computation. */
function windowStd(r, a, b) {
  const G = b - a;
  let sum = 0;
  for (let i = a; i < b; i++) sum += r[i];
  const mean = sum / G;
  let ss = 0;
  for (let i = a; i < b; i++) {
    const u = r[i] - mean;
    ss += u * u;
  }
  return Math.sqrt(ss / G);
}

/**
 * Direct two-pass gate (R9.1, R9.2): closed for n < 2 * fs; from n = 2 * fs on,
 * closed while the population std of r[n - 2*fs .. n - 1] is below 0.01. Also
 * counts the windows whose std is within 1e-12 of 0.01 (`near`), the smallest
 * distance to 0.01, and the number of open/closed changes.
 */
function directGate(r, fs) {
  const G = GATE_SEC * fs;
  let closed = 0;
  let near = 0;
  let minMargin = Infinity;
  let transitions = 0;
  let prev = 1;
  for (let n = 0; n < r.length; n++) {
    let isClosed = 1; // window not yet full
    if (n >= G) {
      const std = windowStd(r, n - G, n);
      const margin = Math.abs(std - GATE_STD);
      if (margin <= 1e-12) near++;
      if (margin < minMargin) minMargin = margin;
      isClosed = std < GATE_STD ? 1 : 0;
    }
    if (isClosed !== prev) transitions++;
    prev = isClosed;
    closed += isClosed;
  }
  return { closed, near, minMargin, transitions };
}

/** Tap vector x_vec[n] = r[n - D .. n + D], with r = 0 outside 0..N-1 (R8.2). */
function tapVector(r, n, D) {
  const x = [];
  for (let i = n - D; i <= n + D; i++) x.push(i >= 0 && i < r.length ? r[i] : 0);
  return x;
}

/** Noise-free FIR primary d[n] = sum_j h[j] * r[n - D + j], with r = 0 outside 0..N-1. */
function firPrimary(h, r, D) {
  const N = r.length;
  const d = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    let s = 0;
    for (let j = 0; j < h.length; j++) {
      const i = n - D + j;
      if (i >= 0 && i < N) s += h[j] * r[i];
    }
    d[n] = s;
  }
  return d;
}

/** Seeded Gaussian FIR system of length L with ||h||_2 <= norm, equal to norm up to a few ulps. */
function firSystem(L, seed, norm) {
  const rng = createRng(seed);
  const raw = Array.from({ length: L }, () => rng.gaussian());
  const scale = norm / l2(raw);
  const h = raw.map((v) => v * scale);
  // Rounding can leave ||h|| an ulp above the target; shrink until it is not.
  while (l2(h) > norm) {
    for (let j = 0; j < L; j++) h[j] *= 1 - Number.EPSILON;
  }
  return h;
}

/** Module 1 primary (raw ppg) and reference (ancReference of accel.z). */
function moduleOne(seed, fs, motionIntensity, tremorIntensity, durationSec = 30) {
  const sig = generateSignals({ seed, fs, durationSec, motionIntensity, tremorIntensity });
  return { d: sig.ppg, r: ancReference(sig.accel.z, fs) };
}

/**
 * R8.5 setup: white Gaussian reference with std 0.2, seeded FIR h of length L with
 * ||h||_2 = norm, noise-free primary with the ANC's zero-padding. The measured range
 * is the shortest one R8.5 allows: from 2 * fs + 100 * L (100 * L = 10 * L / mu) to
 * N = start + 10 * L.
 */
function convergenceCase(fs, norm, seed) {
  const D = lookahead(fs);
  const L = 2 * D + 1;
  const start = GATE_SEC * fs + 100 * L;
  const N = start + 10 * L;
  const r = gaussianNoise(N, seed, 0.2);
  const h = firSystem(L, seed + 1, norm);
  const d = firPrimary(h, r, D);
  const out = nlmsCancel(d, r, fs);
  let residual = 0;
  let primary = 0;
  for (let n = start; n < N; n++) {
    residual += out.e[n] * out.e[n];
    primary += d[n] * d[n];
  }
  // Both means run over the same N - start samples, so the 1 / (N - start) factors cancel.
  return { L, start, N, r, h, out, ratio: residual / primary };
}

/** Forced large system: d = 100 * r, i.e. h = 100 at the centre tap, ||h|| = 100 > W_MAX. */
function clampCase(fs) {
  const N = 10 * fs;
  const r = gaussianNoise(N, 1200 + fs, 1);
  const d = r.map((v) => 100 * v);
  return { d, r, out: nlmsCancel(d, r, fs) };
}

describe('tap window and parameters (R8.2, R8.3, R8.4)', () => {
  it('for every integer fs in 25..256: lookaheadSamples = floor((fs + 5) / 10), taps = 2D + 1, mu = 0.1', () => {
    for (let fs = 25; fs <= 256; fs++) {
      const out = nlmsCancel([], [], fs);
      const D = lookahead(fs);
      expect(out.lookaheadSamples).toBe(D);
      expect(out.taps).toBe(2 * D + 1);
      expect(out.mu).toBe(MU);
    }
  });

  it('spot checks: fs 25 gives D 3 and L 7; fs 256 gives D 26 and L 53', () => {
    const a = nlmsCancel([], [], 25);
    expect(a.lookaheadSamples).toBe(3);
    expect(a.taps).toBe(7);
    const b = nlmsCancel([], [], 256);
    expect(b.lookaheadSamples).toBe(26);
    expect(b.taps).toBe(53);
  });
});

describe('NLMS convergence on a known FIR system (R8.5)', () => {
  for (const fs of FS_LIST) {
    for (const norm of [W_MAX / 2, 1]) {
      it(`fs=${fs}, ||h||=${norm}: residual power < 1e-3 of primary power, clamp inactive`, () => {
        const c = convergenceCase(fs, norm, 100 * fs + norm);
        // Preconditions of R8.5; h fills the L-tap window by construction. firSystem
        // leaves ||h|| a few ulps (about 1e-15 relative) below the target, so the
        // 1e-12 (not in the spec) only confirms that h sits at the target norm.
        expect(l2(c.h)).toBeLessThanOrEqual(W_MAX / 2);
        expect(l2(c.h)).toBeGreaterThan(norm * (1 - 1e-12));
        expect(windowStd(c.r, 0, c.N)).toBeGreaterThanOrEqual(0.1);
        expect(c.N - c.start).toBeGreaterThanOrEqual(10 * c.L);
        console.log(
          `R8.5 fs=${fs} ||h||=${norm}: residual/primary power = ${c.ratio.toExponential(3)} ` +
            `over [${c.start}, ${c.N}) (L=${c.L})`,
        );
        expect(c.ratio).toBeLessThan(RESIDUAL_RATIO);
        expect(c.out.weightClampActive).toBe(false);
      });
    }
  }
});

describe('first adapted sample (R8.1, R8.3)', () => {
  for (const fs of FS_LIST) {
    it(`fs=${fs}: w starts at 0, and the first update uses mu = 0.1 and eps = L * 0.01^2`, () => {
      const D = lookahead(fs);
      const L = 2 * D + 1;
      const G = GATE_SEC * fs;
      const N = 3 * fs;
      // Slow sinusoid: neighbouring tap vectors are strongly correlated, and eps is
      // about half of x_vec . x_vec, so a wrong eps shows clearly.
      const r = Array.from({ length: N }, (_, n) => 0.03 * Math.sin((2 * Math.PI * n) / fs + 0.3));
      const d = randomInput(N, 700 + fs);
      d[G] = 1; // |e| = 1 at the first step: ||w|| <= mu / (2 * sqrt(eps)) = 5 / sqrt(L) < W_MAX
      d[G + 1] = 0.5;
      // The gate is open at n = G and n = G + 1 (window std 0.03 / sqrt(2) = 0.021).
      expect(windowStd(r, 0, G)).toBeGreaterThan(GATE_STD);
      expect(windowStd(r, 1, G + 1)).toBeGreaterThan(GATE_STD);

      const out = nlmsCancel(d, r, fs);
      // w = 0 at the first open sample, so y = 0 and e = d exactly.
      expect(Object.is(out.e[G], d[G])).toBe(true);

      // One update: w = mu * e[G] * x0 / (eps + x0 . x0); then y = w . x1.
      const x0 = tapVector(r, G, D);
      const x1 = tapVector(r, G + 1, D);
      let p = 0;
      let c = 0;
      for (let j = 0; j < L; j++) {
        p += x0[j] * x0[j];
        c += x0[j] * x1[j];
      }
      const eps = L * SIGMA_FLOOR * SIGMA_FLOOR;
      const y1 = (MU * d[G] * c) / (eps + p);
      // Tolerance (not in the spec): 1e-12 of |d| + |y|. Test and implementation form the
      // same sums of L <= 53 products and one division in a different order; each has a
      // rounding error below about 2 * L * 2^-53 (about 1.2e-14) of that scale, so 1e-12
      // is about 100x the rounding error. A wrong mu, eps, D or initial weight moves
      // e[2*fs + 1] by orders of magnitude more; the last check shows this for eps.
      const tol = 1e-12 * (Math.abs(d[G + 1]) + Math.abs(y1));
      expect(Math.abs(out.e[G + 1] - (d[G + 1] - y1))).toBeLessThanOrEqual(tol);
      expect(Math.abs((MU * d[G] * c) / p - y1)).toBeGreaterThan(1e6 * tol);
    });
  }
});

describe('closed gate is an exact pass-through (R9.2)', () => {
  for (const fs of FS_LIST) {
    it(`fs=${fs}: all-zero, constant and small clipped-noise references give gatedFraction 1 and e === d`, () => {
      const N = 10 * fs;
      const rng = createRng(300 + fs);
      const references = {
        'all zero': new Array(N).fill(0),
        'constant 9.81': new Array(N).fill(9.81),
        'constant -1': new Array(N).fill(-1),
        'constant 1/3': new Array(N).fill(0.3333333333333333),
        // Sensor-like noise: std 0.005, clipped at 4 sigma = 0.02.
        'clipped noise': Array.from({ length: N }, () =>
          Math.min(0.02, Math.max(-0.02, 0.005 * rng.gaussian())),
        ),
      };
      const d = randomInput(N, 400 + fs);
      d[0] = -0;
      d[1] = Number.MIN_VALUE;
      for (const [name, r] of Object.entries(references)) {
        // Precondition: every full window has std below 0.01 (direct computation).
        expect(directGate(r, fs).closed, name).toBe(N);
        const out = nlmsCancel(d, r, fs);
        expect(out.gatedFraction, name).toBe(1);
        expect(firstMismatch(out.e, d), name).toBe(-1);
      }
    });
  }
});

describe('closed gate freezes the weights (R9.2)', () => {
  for (const fs of FS_LIST) {
    it(`fs=${fs}: changing d where the gate is closed changes e nowhere else`, () => {
      const G = GATE_SEC * fs;
      const D = lookahead(fs);
      const quietStart = 6 * fs;
      const quietEnd = quietStart + 5 * fs; // r is quiet on [quietStart, quietEnd)
      const N = quietEnd + 4 * fs;
      const rng = createRng(500 + fs);
      // Quiet samples have |r| <= 0.008, so a window inside the quiet part has std <= 0.008 < 0.01.
      const r = Array.from({ length: N }, (_, n) =>
        n >= quietStart && n < quietEnd
          ? Math.min(0.008, Math.max(-0.008, 0.002 * rng.gaussian()))
          : rng.gaussian(),
      );
      const fir = firPrimary(firSystem(2 * D + 1, 600 + fs, 2), r, D);
      const d = Array.from(fir, (v, n) => v + 0.3 * Math.sin((2 * Math.PI * 1.3 * n) / fs));
      // For n in [lo, hi] the window r[n - G .. n - 1] lies inside the quiet part: closed.
      const lo = quietStart + G;
      const hi = quietEnd;
      const d2 = d.slice();
      for (let n = lo; n <= hi; n++) d2[n] += 3;

      const a = nlmsCancel(d, r, fs);
      const b = nlmsCancel(d2, r, fs);
      expect(firstMismatch(a.e, d, lo, hi + 1)).toBe(-1);
      expect(firstMismatch(b.e, d2, lo, hi + 1)).toBe(-1);
      // The filter adapted before the quiet part and is active after it, so moving
      // the weights inside [lo, hi] would change e after hi ...
      expect(firstMismatch(a.e, d, G + 1, quietStart)).not.toBe(-1);
      expect(firstMismatch(a.e, d, hi + 1, N)).not.toBe(-1);
      // ... but both runs agree exactly outside [lo, hi].
      expect(firstMismatch(b.e, a.e, 0, lo)).toBe(-1);
      expect(firstMismatch(b.e, a.e, hi + 1, N)).toBe(-1);
    });
  }
});

describe('gate closed until its window is full (R9.1)', () => {
  for (const fs of FS_LIST) {
    it(`fs=${fs}: with a strong reference, e === d for every n < 2*fs`, () => {
      const G = GATE_SEC * fs;
      const N = 6 * fs;
      const r = gaussianNoise(N, 900 + fs, 1);
      const d = randomInput(N, 950 + fs);
      const out = nlmsCancel(d, r, fs);
      expect(firstMismatch(out.e, d, 0, G)).toBe(-1);
      // Every full window of this reference has std near 1: only the 2*fs start samples are closed.
      expect(directGate(r, fs).closed).toBe(G);
      expect(closedCount(out, N)).toBe(G);
      // R8.3: w = 0 at the first open sample, so e[2*fs] === d[2*fs]; the next sample is filtered.
      expect(Object.is(out.e[G], d[G])).toBe(true);
      expect(out.e[G + 1]).not.toBe(d[G + 1]);
    });
  }
});

describe('gate window excludes the current sample (R9.1)', () => {
  for (const fs of FS_LIST) {
    it(`fs=${fs}: r = 0 before 2*fs and large after it gives exactly 2*fs + 1 closed samples`, () => {
      const G = GATE_SEC * fs;
      const N = 6 * fs;
      const rng = createRng(1000 + fs);
      // From n = 2*fs on: alternating sign, magnitude in [1, 2), never constant.
      const r = Array.from({ length: N }, (_, n) => (n < G ? 0 : (n % 2 ? -1 : 1) * (1 + rng.next())));
      const d = randomInput(N, 1050 + fs);
      // n < 2*fs: closed (window not full). n = 2*fs: the window r[0 .. 2*fs - 1] is all
      // zero, so closed. n >= 2*fs + 1: the window holds k >= 1 samples of magnitude in
      // [1, 2) with alternating signs, so its std is at least sqrt(2*fs - 4) / (2*fs) > 0.04
      // (the k = 1 case): open. A window that included the current sample would already
      // hold r[2*fs] at n = 2*fs and open the gate there, giving 2*fs closed samples
      // instead of 2*fs + 1.
      expect(directGate(r, fs).closed).toBe(G + 1);
      expect(closedCount(nlmsCancel(d, r, fs), N)).toBe(G + 1);
    });
  }
});

describe('gate count matches a direct two-pass computation (R9.1)', () => {
  // Exact count match is required, except for windows whose direct std is within 1e-12
  // of 0.01 (not in the spec). The direct std is accurate to about 1e-15 here (std near
  // 0.01, offset up to 9.81), and the running sums in anc.js are recomputed exactly near
  // the threshold, so only a window that close to 0.01 may be decided the other way.
  // Each such window can change the count by at most 1.
  const cases = [];
  for (const fs of FS_LIST) {
    for (const [motion, tremor, seed] of [
      [0.3, 1, 21],
      [0, 1, 22],
    ]) {
      cases.push({
        name: `Module 1 fs=${fs} motion=${motion} tremor=${tremor}`,
        fs,
        ramp: false,
        make: () => moduleOne(seed, fs, motion, tremor),
      });
    }
    for (const offset of [0, 9.81]) {
      cases.push({
        name: `ramp fs=${fs} offset=${offset}`,
        fs,
        ramp: true,
        // Window std follows a slow triangle 0.007 -> 0.013 -> 0.007 over 60 s, with
        // sampling jitter, so it crosses 0.01 several times.
        make: () => {
          const N = 60 * fs;
          const rng = createRng(1300 + fs);
          const r = Array.from({ length: N }, (_, n) => {
            const a = 0.007 + 0.006 * (1 - Math.abs((2 * n) / (N - 1) - 1));
            return offset + a * rng.gaussian();
          });
          return { d: randomInput(N, 1350 + fs), r };
        },
      });
    }
  }

  for (const c of cases) {
    it(`${c.name}: closed count equals the direct count`, () => {
      const { d, r } = c.make();
      const direct = directGate(r, c.fs);
      const impl = closedCount(nlmsCancel(d, r, c.fs), r.length);
      console.log(
        `R9.1 ${c.name}: closed impl=${impl} direct=${direct.closed} of N=${r.length}, ` +
          `open/closed changes=${direct.transitions}, near-threshold windows=${direct.near}, ` +
          `min |std - 0.01|=${direct.minMargin.toExponential(2)}`,
      );
      if (c.ramp) expect(direct.transitions).toBeGreaterThanOrEqual(2);
      expect(Math.abs(impl - direct.closed)).toBeLessThanOrEqual(direct.near);
    });
  }
});

describe('gatedFraction (R9.4)', () => {
  it('is null for zero-length input', () => {
    for (const fs of FS_LIST) expect(nlmsCancel([], [], fs).gatedFraction).toBeNull();
  });

  it('is 1 for all-zero and constant references', () => {
    for (const fs of FS_LIST) {
      const N = 5 * fs;
      const d = randomInput(N, 1100 + fs);
      for (const v of [0, 9.81, -2.5]) {
        expect(nlmsCancel(d, new Array(N).fill(v), fs).gatedFraction).toBe(1);
      }
    }
  });

  it('is a finite number in [0, 1] otherwise', () => {
    for (const fs of FS_LIST) {
      const m1 = moduleOne(23, fs, 0.3, 1, 10);
      const inputs = [
        { d: randomInput(6 * fs, 1150 + fs), r: gaussianNoise(6 * fs, 1160 + fs, 1) },
        { d: randomInput(fs, 1170 + fs), r: gaussianNoise(fs, 1180 + fs, 1) }, // N < 2*fs
        m1,
      ];
      for (const { d, r } of inputs) {
        const g = nlmsCancel(d, r, fs).gatedFraction;
        expect(typeof g).toBe('number');
        expect(Number.isFinite(g)).toBe(true);
        expect(g).toBeGreaterThanOrEqual(0);
        expect(g).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('weight clamp (R10.1, R10.2)', () => {
  for (const fs of FS_LIST) {
    it(`fs=${fs}: a forced large system (d = 100 * r, ||h|| = 100 > 10) sets weightClampActive`, () => {
      expect(clampCase(fs).out.weightClampActive).toBe(true);
    });
  }

  it('the R8.5 convergence cases and a fully gated run leave weightClampActive false', () => {
    for (const fs of FS_LIST) {
      for (const norm of [W_MAX / 2, 1]) {
        expect(convergenceCase(fs, norm, 100 * fs + norm).out.weightClampActive).toBe(false);
      }
      const N = 5 * fs;
      const gated = nlmsCancel(gaussianNoise(N, 1250 + fs, 100), new Array(N).fill(0), fs);
      expect(gated.gatedFraction).toBe(1);
      expect(gated.weightClampActive).toBe(false);
    }
  });
});

describe('output bound (R10.3)', () => {
  // |e[n]| <= max|d| + W_MAX * sqrt(L) * max|r|. Slack (not in the spec): 1e-12 relative.
  // The bound is exact in real arithmetic (Cauchy-Schwarz with ||w|| <= 10 and
  // ||x_vec|| <= sqrt(L) * max|r|). In floating point the rescaled w can exceed norm 10
  // by a few ulps (the norm, 10 / norm and each w[j] * s are rounded), y = w . x_vec
  // has a rounding error of at most about L * 2^-53 of sum |w[j] * x[j]|, and e = d - y
  // and the bound itself add a few roundings. With L <= 53 this totals below about
  // 1e-14, so 1e-12 is about 100x the rounding error and far below a real violation.
  function check(d, r, fs) {
    const L = 2 * lookahead(fs) + 1;
    const bound = maxAbs(d) + W_MAX * Math.sqrt(L) * maxAbs(r);
    const out = nlmsCancel(d, r, fs);
    expect(maxAbs(out.e)).toBeLessThanOrEqual(bound * (1 + 1e-12));
    return { out, q: maxAbs(out.e) / bound };
  }

  for (const fs of FS_LIST) {
    it(`fs=${fs}: holds for the clamp case and for Module 1 output (motion 0.6, tremor 1)`, () => {
      const cl = clampCase(fs);
      const a = check(cl.d, cl.r, fs);
      expect(a.out.weightClampActive).toBe(true);
      const m1 = moduleOne(41, fs, 0.6, 1);
      const b = check(m1.d, m1.r, fs);
      console.log(
        `R10.3 fs=${fs}: max|e| / bound = ${a.q.toFixed(4)} (clamp case), ` +
          `${b.q.toFixed(4)} (Module 1)`,
      );
    });
  }
});

describe('finite output for degenerate inputs', () => {
  it('zero-length, constant and all-zero inputs give a finite Float64Array of length N', () => {
    for (const fs of FS_LIST) {
      const N = 5 * fs;
      const zero = new Array(N).fill(0);
      const constD = new Array(N).fill(1.5);
      const constR = new Array(N).fill(9.81);
      const pairs = [
        [[], []],
        [zero, zero],
        [constD, constR],
        [zero, constR],
        [constD, zero],
      ];
      for (const [d, r] of pairs) {
        const { e } = nlmsCancel(d, r, fs);
        expect(e).toBeInstanceOf(Float64Array);
        expect(e).toHaveLength(d.length);
        expect(e.every((v) => Number.isFinite(v))).toBe(true);
      }
    }
  });
});

describe('purity', () => {
  const fs = 64;
  const { d, r } = moduleOne(31, fs, 0.6, 1, 20);

  it('does not mutate d or r (typed or plain) and returns a new array', () => {
    const dCopy = Array.from(d);
    const rCopy = Array.from(r);
    const out = nlmsCancel(d, r, fs);
    expect(out.gatedFraction).toBeLessThan(1); // the filter ran
    expect(Array.from(d)).toEqual(dCopy);
    expect(Array.from(r)).toEqual(rCopy);
    expect(out.e).toBeInstanceOf(Float64Array);
    expect(out.e).not.toBe(d);
    expect(out.e).not.toBe(r);
    expect(out.e.buffer).not.toBe(d.buffer);
    expect(out.e.buffer).not.toBe(r.buffer);

    const dPlain = Array.from(d);
    const rPlain = Array.from(r);
    nlmsCancel(dPlain, rPlain, fs);
    expect(dPlain).toEqual(dCopy);
    expect(rPlain).toEqual(rCopy);
  });

  it('two calls give equal output', () => {
    expect(nlmsCancel(d, r, fs)).toEqual(nlmsCancel(d, r, fs));
  });

  it('plain arrays and Float64Arrays give the same result', () => {
    expect(nlmsCancel(Array.from(d), Array.from(r), fs)).toEqual(nlmsCancel(d, r, fs));
  });
});

describe('validation', () => {
  const ok = [1, 2, 3, 4];

  it('non-number fs throws TypeError', () => {
    for (const bad of ['64', null, undefined, {}]) {
      expect(() => nlmsCancel(ok, ok, bad)).toThrow(TypeError);
      expect(() => nlmsCancel([], [], bad)).toThrow(TypeError);
    }
  });

  it('fs outside 25..256 or non-integer throws RangeError naming fs and 25..256', () => {
    for (const bad of [24, 257, 64.5, NaN, Infinity]) {
      const fn = () => nlmsCancel(ok, ok, bad);
      expect(fn).toThrow(RangeError);
      expect(fn).toThrow(/fs/);
      expect(fn).toThrow(/25\.\.256/);
    }
  });

  it('d or r not array-like throws TypeError naming it', () => {
    for (const bad of [null, undefined, 5, 'abc', {}]) {
      expect(() => nlmsCancel(bad, ok, 64)).toThrow(TypeError);
      expect(() => nlmsCancel(bad, ok, 64)).toThrow(/\bd\b/);
      expect(() => nlmsCancel(ok, bad, 64)).toThrow(TypeError);
      expect(() => nlmsCancel(ok, bad, 64)).toThrow(/\br\b/);
    }
  });

  it('unequal lengths throw RangeError', () => {
    expect(() => nlmsCancel([1, 2], [1, 2, 3], 64)).toThrow(RangeError);
    expect(() => nlmsCancel([1, 2, 3], [], 64)).toThrow(RangeError);
  });

  it('a NaN or Infinity sample throws RangeError naming the array and index', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      for (const x of [[0, 1, bad, 3], Float64Array.from([0, 1, bad, 3])]) {
        expect(() => nlmsCancel(x, ok, 64)).toThrow(RangeError);
        expect(() => nlmsCancel(x, ok, 64)).toThrow(/d\[2\]/);
        expect(() => nlmsCancel(ok, x, 64)).toThrow(RangeError);
        expect(() => nlmsCancel(ok, x, 64)).toThrow(/r\[2\]/);
      }
    }
  });
});
