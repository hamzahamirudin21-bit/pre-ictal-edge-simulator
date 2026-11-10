import { describe, it, expect } from 'vitest';
import {
  DC_TRACKER_HZ,
  dcTrackerBeta,
  trackDc,
  ancReference,
} from '../src/dsp/dcTracker.js';
import {
  TREMOR_HIGHPASS_HZ,
  tremorSection,
  tremorHighpass,
  tremorL1,
  conditionImu,
} from '../src/dsp/imuConditioning.js';
import { magnitudeAt } from '../src/dsp/biquad.js';
import { createRng } from '../src/generator/prng.js';
import { generateSignals } from '../src/generator/index.js';

const FS_LIST = [25, 64, 256];

function randomInput(n, seed) {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => rng.next() * 2 - 1);
}

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

// Analytic reference response r = z - dc: H_r(w) = 1 - beta / (1 - (1-beta) e^{-jw}).
function referenceResponse(f, fs) {
  const beta = 1 - Math.exp((-2 * Math.PI * DC_TRACKER_HZ) / fs);
  const w = (2 * Math.PI * f) / fs;
  // denominator D = 1 - (1-beta)(cos w - j sin w)
  const dr = 1 - (1 - beta) * Math.cos(w);
  const di = (1 - beta) * Math.sin(w);
  const d2 = dr * dr + di * di;
  // beta / D = beta * conj(D) / |D|^2
  const re = 1 - (beta * dr) / d2;
  const im = (beta * di) / d2;
  return { gain: Math.hypot(re, im), phaseDeg: (Math.atan2(im, re) * 180) / Math.PI };
}

describe('DC tracker recurrence (R6.1)', () => {
  it('constants are as specified', () => {
    expect(DC_TRACKER_HZ).toBe(0.05);
    expect(TREMOR_HIGHPASS_HZ).toBe(2);
  });

  for (const fs of FS_LIST) {
    it(`fs=${fs}: dcTrackerBeta and trackDc match an independent loop exactly`, () => {
      const beta = 1 - Math.exp((-2 * Math.PI * 0.05) / fs);
      expect(dcTrackerBeta(fs)).toBe(beta);
      const z = randomInput(20 * fs, 11).map((v, i) => 9.81 + 0.5 * v + Math.sin(i / fs));
      const dc = trackDc(z, fs);
      const ref = new Array(z.length);
      ref[0] = z[0];
      for (let n = 1; n < z.length; n++) ref[n] = ref[n - 1] + beta * (z[n] - ref[n - 1]);
      expect(dc).toHaveLength(z.length);
      for (let n = 0; n < z.length; n++) expect(dc[n]).toBe(ref[n]);
    });
  }
});

describe('constant z (R6.3)', () => {
  it('gives a zero reference', () => {
    for (const fs of FS_LIST) {
      for (const c of [1, -1, 0.3333333333333333, 9.81, 0]) {
        const r = ancReference(new Array(10 * fs).fill(c), fs);
        let maxAbs = 0;
        for (const v of r) maxAbs = Math.max(maxAbs, Math.abs(v));
        expect(maxAbs).toBeLessThanOrEqual(1e-12);
        expect(maxAbs).toBe(0);
      }
    }
  });
});

describe('step convergence (R6.4)', () => {
  for (const fs of FS_LIST) {
    for (const S of [1, -0.4]) {
      it(`fs=${fs}, S=${S}: offset < 1e-3 of S after 30 s`, () => {
        const step = 5 * fs;
        const n = 40 * fs;
        const z = Array.from({ length: n }, (_, i) => (i < step ? 0 : S));
        const r = ancReference(z, fs);
        expect(Math.abs(r[step + 30 * fs]) / Math.abs(S)).toBeLessThan(1e-3);
        // Stays converged to the end of the record.
        expect(Math.abs(r[n - 1]) / Math.abs(S)).toBeLessThan(1e-3);
      });
    }
  }
});

describe('reference does not use the 2 Hz high-pass (R6.5)', () => {
  it('analytic: discrete gain matches the exact value per fs and phase lead is about 9.5 degrees at 0.3 Hz', () => {
    // 0.986 is the continuous-time value; the discrete gain depends on fs.
    const exact = { 25: 0.9802, 64: 0.984, 256: 0.9858 };
    for (const fs of FS_LIST) {
      const h = referenceResponse(0.3, fs);
      expect(Math.abs(h.gain - exact[fs])).toBeLessThan(0.002);
      expect(Math.abs(h.phaseDeg - 9.5)).toBeLessThan(0.5);
    }
  });

  for (const fs of FS_LIST) {
    it(`fs=${fs}: measured 0.3 Hz gain is within 0.002 of the exact discrete gain`, () => {
      const total = 200 * fs;
      const x = Array.from({ length: total }, (_, i) => Math.sin((2 * Math.PI * 0.3 * i) / fs));
      const g = toneAmplitude(ancReference(x, fs), 0.3, fs, 140);
      const exactGain = referenceResponse(0.3, fs).gain;
      expect(Math.abs(g - exactGain)).toBeLessThan(0.002);
    });
  }

  for (const fs of FS_LIST) {
    it(`fs=${fs}: measured 0.3 Hz gain matches the analytic gain`, () => {
      const total = 200 * fs;
      const x = Array.from({ length: total }, (_, i) => Math.sin((2 * Math.PI * 0.3 * i) / fs));
      const r = ancReference(x, fs);
      // Use the last 140 s = 42 whole periods after a >60 s transient (decay ~ 6e-9).
      // Tolerance 0.005 (not in the spec) covers finite-window estimation error and
      // amplitude estimation on a sampled tone; the true error is far smaller.
      const g = toneAmplitude(r, 0.3, fs, 140);
      expect(Math.abs(g - referenceResponse(0.3, fs).gain)).toBeLessThan(0.005);
    });

    it(`fs=${fs}: tremor high-pass at 0.3 Hz is far below the reference gain`, () => {
      const tremorGain = magnitudeAt(tremorSection(fs), 0.3, fs);
      expect(tremorGain).toBeLessThan(0.05);
      expect(tremorGain).toBeLessThan(referenceResponse(0.3, fs).gain / 10);
    });
  }

  it('conditionImu ancReference equals ancReference(accel.z) on module 1 output', () => {
    const sig = generateSignals({ seed: 3, fs: 64, durationSec: 20 });
    const out = conditionImu(sig.accel, sig.fs);
    expect(out.ancReference).toEqual(ancReference(sig.accel.z, sig.fs));
  });
});

describe('tremor high-pass gains (R7.2)', () => {
  it('meets 0.5 Hz <= 0.07 and 4 Hz >= 0.95 for every integer fs in 25..256', () => {
    for (let fs = 25; fs <= 256; fs++) {
      const s = tremorSection(fs);
      expect(magnitudeAt(s, 0.5, fs)).toBeLessThanOrEqual(0.07);
      expect(magnitudeAt(s, 4, fs)).toBeGreaterThanOrEqual(0.95);
    }
  });

  it('measured steady-state sine gains at fs=64 match magnitudeAt within 1e-3', () => {
    const fs = 64;
    for (const f of [0.5, 4]) {
      const x = Array.from({ length: 60 * fs }, (_, i) => Math.sin((2 * Math.PI * f * i) / fs));
      const g = toneAmplitude(tremorHighpass(x, fs), f, fs, 20);
      expect(Math.abs(g - magnitudeAt(tremorSection(fs), f, fs))).toBeLessThan(1e-3);
    }
  });
});

describe('tremor L1 bound (R7.3)', () => {
  for (const fs of [25, 64, 128, 256]) {
    it(`|y| <= L1 * max|x| at fs=${fs}`, () => {
      const l1 = tremorL1(fs);
      const n = 20 * fs;
      const sig = generateSignals({ seed: 5, fs, durationSec: 20 });
      const inputs = [
        randomInput(n, 5),
        Array.from({ length: n }, (_, i) => 3 + (Math.floor(i / (fs / 2)) % 2 ? 2 : -2)),
        Array.from({ length: n }, (_, i) => (i % fs === 0 ? 4 : 0)),
        sig.accel.x,
      ];
      for (const x of inputs) {
        let maxX = 0;
        for (const v of x) maxX = Math.max(maxX, Math.abs(v));
        const y = tremorHighpass(x, fs);
        for (const v of y) expect(Math.abs(v)).toBeLessThanOrEqual(l1 * maxX * (1 + 1e-9) + 1e-12);
      }
    });
  }
});

describe('conditionImu structure (R7.1, R7.4)', () => {
  const fs = 64;
  const sig = generateSignals({ seed: 7, fs, durationSec: 20 });

  it('returns Float64Arrays of length n with the expected shape', () => {
    const out = conditionImu(sig.accel, fs);
    expect(Object.keys(out).sort()).toEqual(['ancReference', 'imuTremor']);
    expect(Object.keys(out.imuTremor).sort()).toEqual(['x', 'y', 'z']);
    for (const a of [out.ancReference, out.imuTremor.x, out.imuTremor.y, out.imuTremor.z]) {
      expect(a).toBeInstanceOf(Float64Array);
      expect(a).toHaveLength(sig.n);
    }
  });

  it('imuTremor axes are the tremor high-pass of the RAW axes', () => {
    const out = conditionImu(sig.accel, fs);
    for (const k of ['x', 'y', 'z']) {
      expect(out.imuTremor[k]).toEqual(tremorHighpass(sig.accel[k], fs));
    }
  });

  it('x/y tremor output does not depend on z', () => {
    const a = conditionImu(sig.accel, fs);
    const z2 = Float64Array.from(sig.accel.z, (v) => v + 5);
    const b = conditionImu({ x: sig.accel.x, y: sig.accel.y, z: z2 }, fs);
    expect(b.imuTremor.x).toEqual(a.imuTremor.x);
    expect(b.imuTremor.y).toEqual(a.imuTremor.y);
  });

  it('steady-state init: constant axes give exactly zero tremor output', () => {
    const c = new Array(10 * fs);
    const out = conditionImu({ x: c.fill(9.81), y: new Array(c.length).fill(-0.3), z: c }, fs);
    for (const k of ['x', 'y', 'z']) {
      for (const v of out.imuTremor[k]) expect(v).toBe(0);
    }
  });
});

describe('validation and purity', () => {
  const ok = { x: [1, 2, 3], y: [1, 2, 3], z: [1, 2, 3] };

  it('non-number fs throws TypeError', () => {
    for (const bad of ['64', null, undefined, {}]) {
      expect(() => dcTrackerBeta(bad)).toThrow(TypeError);
      expect(() => trackDc([1], bad)).toThrow(TypeError);
      expect(() => ancReference([1], bad)).toThrow(TypeError);
      expect(() => tremorSection(bad)).toThrow(TypeError);
      expect(() => tremorHighpass([1], bad)).toThrow(TypeError);
      expect(() => tremorL1(bad)).toThrow(TypeError);
      expect(() => conditionImu(ok, bad)).toThrow(TypeError);
    }
  });

  it('fs outside 25..256 or non-integer throws RangeError naming fs and 25..256', () => {
    for (const bad of [24, 257, 64.5, NaN, Infinity]) {
      for (const fn of [
        () => dcTrackerBeta(bad),
        () => trackDc([1], bad),
        () => ancReference([1], bad),
        () => tremorSection(bad),
        () => tremorHighpass([1], bad),
        () => tremorL1(bad),
        () => conditionImu(ok, bad),
      ]) {
        expect(fn).toThrow(RangeError);
        expect(fn).toThrow(/fs/);
        expect(fn).toThrow(/25\.\.256/);
      }
    }
  });

  it('accel null or non-object throws TypeError', () => {
    for (const bad of [null, undefined, 5, 'abc']) {
      expect(() => conditionImu(bad, 64)).toThrow(TypeError);
    }
  });

  it('missing or non-array-like axis throws TypeError naming accel.<axis>', () => {
    for (const k of ['x', 'y', 'z']) {
      for (const bad of [undefined, null, 'abc', 5]) {
        const a = { ...ok, [k]: bad };
        expect(() => conditionImu(a, 64)).toThrow(TypeError);
        expect(() => conditionImu(a, 64)).toThrow(new RegExp(`accel\\.${k}`));
      }
    }
    expect(() => trackDc(null, 64)).toThrow(TypeError);
    expect(() => tremorHighpass('abc', 64)).toThrow(TypeError);
  });

  it('unequal axis lengths throw RangeError', () => {
    expect(() => conditionImu({ x: [1, 2], y: [1, 2, 3], z: [1, 2, 3] }, 64)).toThrow(RangeError);
    expect(() => conditionImu({ x: [1, 2, 3], y: [1, 2, 3], z: [1] }, 64)).toThrow(RangeError);
  });

  it('empty axes give empty arrays', () => {
    const out = conditionImu({ x: [], y: [], z: [] }, 64);
    for (const a of [out.ancReference, out.imuTremor.x, out.imuTremor.y, out.imuTremor.z]) {
      expect(a).toBeInstanceOf(Float64Array);
      expect(a).toHaveLength(0);
    }
    expect(trackDc([], 64)).toHaveLength(0);
  });

  it('does not mutate inputs and returns new arrays', () => {
    const accel = {
      x: Float64Array.from(randomInput(300, 1)),
      y: Float64Array.from(randomInput(300, 2)),
      z: Float64Array.from(randomInput(300, 3)),
    };
    const copy = { x: Array.from(accel.x), y: Array.from(accel.y), z: Array.from(accel.z) };
    const out = conditionImu(accel, 64);
    for (const k of ['x', 'y', 'z']) {
      expect(Array.from(accel[k])).toEqual(copy[k]);
      expect(out.imuTremor[k]).not.toBe(accel[k]);
    }
    expect(out.ancReference).not.toBe(accel.z);
    expect(trackDc(accel.z, 64)).not.toBe(accel.z);
    expect(Array.from(accel.z)).toEqual(copy.z);
  });
});
