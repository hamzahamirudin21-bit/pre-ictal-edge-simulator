import { describe, it, expect } from 'vitest';
import { designLowpass, designHighpass } from '../src/dsp/butterworth.js';
import {
  dcGain,
  filterBiquad,
  filterCascade,
  responseAt,
  cascadeResponseAt,
  magnitudeAt,
  poleRadius,
  groupDelaySec,
  l1Norm,
} from '../src/dsp/biquad.js';
import { createRng } from '../src/generator/prng.js';

const Q = Math.SQRT1_2;

/** Independent RBJ cookbook reference. */
function rbj(type, fs, fc) {
  const w0 = (2 * Math.PI * fc) / fs;
  const c = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  const a0 = 1 + alpha;
  const b =
    type === 'lowpass'
      ? [(1 - c) / 2, 1 - c, (1 - c) / 2]
      : [(1 + c) / 2, -(1 + c), (1 + c) / 2];
  return {
    b0: b[0] / a0,
    b1: b[1] / a0,
    b2: b[2] / a0,
    a1: (-2 * c) / a0,
    a2: (1 - alpha) / a0,
  };
}

const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

function randomInput(n, seed = 1) {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => rng.next() * 2 - 1);
}

/** Amplitude of a sinusoid at f Hz over the last windowSec seconds (whole periods). */
function toneAmplitude(y, f, fs, windowSec) {
  const N = windowSec * fs;
  const start = y.length - N;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < N; i++) {
    const w = (2 * Math.PI * f * (start + i)) / fs;
    sa += y[start + i] * Math.sin(w);
    sb += y[start + i] * Math.cos(w);
  }
  return Math.hypot((2 * sa) / N, (2 * sb) / N);
}

const MODULE2 = [
  ['highpass', 0.5, designHighpass],
  ['lowpass', 4, designLowpass],
  ['highpass', 2, designHighpass],
];

describe('Butterworth design vs RBJ reference (R4.1)', () => {
  const cases = [
    [25, 4],
    [64, 0.5],
    [256, 0.5],
    [64, 2],
    [256, 4],
    [25, 2],
  ];
  for (const [fs, fc] of cases) {
    it(`matches for fs=${fs}, fc=${fc}`, () => {
      for (const [type, design] of [
        ['lowpass', designLowpass],
        ['highpass', designHighpass],
      ]) {
        const got = design(fs, fc);
        const ref = rbj(type, fs, fc);
        for (const k of ['b0', 'b1', 'b2', 'a1', 'a2']) {
          expect(rel(got[k], ref[k])).toBeLessThanOrEqual(1e-12);
        }
        expect(got.type).toBe(type);
        expect(got.fc).toBe(fc);
        expect(got.fs).toBe(fs);
      }
    });
  }
});

describe('DC gain and cutoff magnitude (R4.4)', () => {
  it('high-pass has DC gain 0, low-pass has DC gain 1', () => {
    for (const fs of [25, 64, 100, 256]) {
      for (const fc of [0.5, 2]) {
        expect(Math.abs(dcGain(designHighpass(fs, fc)))).toBeLessThanOrEqual(1e-12);
      }
      expect(Math.abs(dcGain(designLowpass(fs, 4)) - 1)).toBeLessThanOrEqual(1e-12);
    }
  });

  it('magnitude at fc is 1/sqrt(2) for the three Module 2 sections', () => {
    for (const fs of [25, 50, 64, 100, 128, 256]) {
      for (const [, fc, design] of MODULE2) {
        const m = magnitudeAt(design(fs, fc), fc, fs);
        expect(rel(m, Math.SQRT1_2)).toBeLessThanOrEqual(1e-9);
      }
    }
  });
});

describe('pole radius (R4.5)', () => {
  it('is below 1 for every Module 2 section at every integer fs in 25..256', () => {
    let worst = { r: 0, fs: 0, fc: 0, type: '' };
    for (let fs = 25; fs <= 256; fs++) {
      for (const [type, fc, design] of MODULE2) {
        const r = poleRadius(design(fs, fc));
        expect(r).toBeLessThan(1);
        if (r > worst.r) worst = { r, fs, fc, type };
      }
    }
    // Documented worst case: slowest high-pass at the highest rate.
    expect(worst.type).toBe('highpass');
    expect(worst.fc).toBe(0.5);
    expect(worst.fs).toBe(256);
    expect(worst.r).toBeCloseTo(0.991, 3);
  });
});

describe('steady-state initialization (R4.6)', () => {
  for (const [name, section] of [
    ['low-pass', designLowpass(64, 4)],
    ['high-pass', designHighpass(64, 0.5)],
  ]) {
    it(`${name}: constant x0 gives dcGain*x0 from sample 0`, () => {
      const G = dcGain(section);
      for (const x0 of [1, 5.5, -3.25, 0, 1000, -0.001]) {
        const y = filterBiquad(section, new Array(200).fill(x0), { steadyState: true });
        // Relative to |x0| (the high-pass target G*x0 is ~0, so |G*x0| alone is not a usable scale).
        for (let i = 0; i < y.length; i++) {
          expect(Math.abs(y[i] - G * x0)).toBeLessThanOrEqual(1e-12 * Math.abs(x0));
        }
      }
    });

    it(`${name}: without steadyState the first output differs`, () => {
      const G = dcGain(section);
      const y = filterBiquad(section, [2, 2, 2, 2]);
      expect(Math.abs(y[0] - G * 2)).toBeGreaterThan(1e-3);
    });
  }
});

describe('transposed Direct Form II correctness', () => {
  it('matches a Direct Form I reference with zero initial state', () => {
    const x = randomInput(500, 7);
    for (const s of [designLowpass(64, 4), designHighpass(64, 0.5), designHighpass(25, 2)]) {
      const ref = new Float64Array(x.length);
      for (let n = 0; n < x.length; n++) {
        ref[n] =
          s.b0 * x[n] +
          s.b1 * (n > 0 ? x[n - 1] : 0) +
          s.b2 * (n > 1 ? x[n - 2] : 0) -
          s.a1 * (n > 0 ? ref[n - 1] : 0) -
          s.a2 * (n > 1 ? ref[n - 2] : 0);
      }
      const y = filterBiquad(s, x);
      for (let n = 0; n < x.length; n++) {
        expect(Math.abs(y[n] - ref[n])).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(ref[n])));
      }
    }
  });
});

describe('filterBiquad / filterCascade hygiene', () => {
  it('returns new Float64Array and does not mutate input', () => {
    const s = designLowpass(64, 4);
    const x = Float64Array.from(randomInput(50, 3));
    const copy = Float64Array.from(x);
    const a = filterBiquad(s, x, { steadyState: true });
    const b = filterCascade([s, designHighpass(64, 0.5)], x, { steadyState: true });
    expect(a).toBeInstanceOf(Float64Array);
    expect(b).toBeInstanceOf(Float64Array);
    expect(a).not.toBe(x);
    expect(b).not.toBe(x);
    expect(Array.from(x)).toEqual(Array.from(copy));
  });

  it('cascade with no sections returns a copy', () => {
    const x = Float64Array.from([1, 2, 3]);
    const y = filterCascade([], x);
    expect(y).not.toBe(x);
    expect(Array.from(y)).toEqual([1, 2, 3]);
  });

  it('empty input gives empty output', () => {
    const s = designLowpass(64, 4);
    for (const opt of [{}, { steadyState: true }]) {
      expect(filterBiquad(s, [], opt)).toEqual(new Float64Array(0));
      expect(filterCascade([s], [], opt)).toEqual(new Float64Array(0));
    }
  });
});

describe('frequency response', () => {
  it('magnitudeAt equals hypot of responseAt and the direct formula', () => {
    const s = designLowpass(64, 4);
    const fs = 64;
    for (const f of [0.1, 1, 4, 10, 31]) {
      const w = (2 * Math.PI * f) / fs;
      const num = {
        re: s.b0 + s.b1 * Math.cos(w) + s.b2 * Math.cos(2 * w),
        im: -(s.b1 * Math.sin(w) + s.b2 * Math.sin(2 * w)),
      };
      const den = {
        re: 1 + s.a1 * Math.cos(w) + s.a2 * Math.cos(2 * w),
        im: -(s.a1 * Math.sin(w) + s.a2 * Math.sin(2 * w)),
      };
      const expected = Math.hypot(num.re, num.im) / Math.hypot(den.re, den.im);
      expect(rel(magnitudeAt(s, f, fs), expected)).toBeLessThanOrEqual(1e-12);
      const h = responseAt(s, f, fs);
      expect(Math.hypot(h.re, h.im)).toBeCloseTo(magnitudeAt(s, f, fs), 12);
    }
  });

  it('matches the steady-state amplitude of a filtered sine (within 1e-3)', () => {
    const fs = 64;
    const sections = [designHighpass(fs, 0.5), designLowpass(fs, 4)];
    for (const f of [1, 2, 3]) {
      const N = 60 * fs;
      const x = Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * f * i) / fs));
      const y = filterCascade(sections, x);
      const amp = toneAmplitude(y, f, fs, 20);
      const h = cascadeResponseAt(sections, f, fs);
      expect(Math.abs(amp - Math.hypot(h.re, h.im))).toBeLessThan(1e-3);
    }
  });
});

describe('l1Norm', () => {
  it('equals sum |h| of a long impulse response', () => {
    for (const fs of [25, 64, 256]) {
      const sections = [designHighpass(fs, 0.5), designLowpass(fs, 4)];
      const imp = new Float64Array(120 * fs);
      imp[0] = 1;
      const h = filterCascade(sections, imp);
      let sum = 0;
      for (const v of h) sum += Math.abs(v);
      expect(rel(l1Norm(sections, fs), sum)).toBeLessThanOrEqual(1e-9);
    }
  });

  it('bounds |y| by l1 * max|x| on deterministic inputs', () => {
    const fs = 64;
    const sections = [designHighpass(fs, 0.5), designLowpass(fs, 4)];
    const l1 = l1Norm(sections, fs);
    const inputs = [
      randomInput(2000, 11),
      Array.from({ length: 2000 }, (_, i) => (Math.floor(i / 16) % 2 ? 1 : -1)),
      Array.from({ length: 2000 }, (_, i) => (i % 50 === 0 ? 1 : 0)),
    ];
    for (const x of inputs) {
      const maxX = Math.max(...x.map(Math.abs));
      const y = filterCascade(sections, x);
      for (const v of y) expect(Math.abs(v)).toBeLessThanOrEqual(l1 * maxX * (1 + 1e-9) + 1e-12);
    }
  });
});

describe('groupDelaySec', () => {
  it('is positive for the bandpass cascade at 1 Hz and matches a coarser estimate', () => {
    for (const fs of [25, 64, 256]) {
      const sections = [designHighpass(fs, 0.5), designLowpass(fs, 4)];
      const tau = groupDelaySec(sections, 1, fs);
      expect(tau).toBeGreaterThan(0);
      const df = 1e-3;
      const lo = cascadeResponseAt(sections, 1 - df, fs);
      const hi = cascadeResponseAt(sections, 1 + df, fs);
      const dphi = Math.atan2(hi.im * lo.re - hi.re * lo.im, hi.re * lo.re + hi.im * lo.im);
      const ref = -dphi / (2 * Math.PI * 2 * df);
      expect(rel(tau, ref)).toBeLessThanOrEqual(1e-4);
    }
  });
});

describe('design validation (R4.2)', () => {
  for (const [name, design] of [
    ['designLowpass', designLowpass],
    ['designHighpass', designHighpass],
  ]) {
    it(`${name}: bad fc throws RangeError naming fc and fs`, () => {
      for (const fc of [0, -1, 32, 40, NaN, Infinity, -Infinity]) {
        expect(() => design(64, fc)).toThrow(RangeError);
        expect(() => design(64, fc)).toThrow(/fc/);
        expect(() => design(64, fc)).toThrow(/fs/);
      }
    });

    it(`${name}: bad fs throws RangeError`, () => {
      for (const fs of [0, -5, NaN, Infinity]) {
        expect(() => design(fs, 1)).toThrow(RangeError);
      }
    });

    it(`${name}: non-number fs or fc throws TypeError`, () => {
      for (const bad of ['4', null, undefined, {}, [], true]) {
        expect(() => design(bad, 1)).toThrow(TypeError);
        expect(() => design(64, bad)).toThrow(TypeError);
      }
    });
  }
});
