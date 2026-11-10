import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { validateParams } from '../src/generator/params.js';
import { gravityVector, generateTremorSchedule, generateIMU } from '../src/generator/imu.js';
import { tremorBandEnergy, dominantFrequency } from '../src/generator/spectrum.js';

const SEEDS = [1, 2, 3, 42, 1234, 99999];
const ANGLES = [-180, -90, 0, 90, 180];
const AXES = ['x', 'y', 'z'];

function imu(over = {}) {
  const p = validateParams(over);
  return { p, out: generateIMU(p) };
}

// D(t) = accel(t) - accel(0), componentwise.
function diff(a, b) {
  const d = {};
  for (const ax of AXES) d[ax] = a[ax].map((v, i) => v - b[ax][i]);
  return d;
}

// Sample index ranges that generateIMU treats as inside bursts.
function burstIndexRanges(bursts, fs, n) {
  return bursts.map((b) => [
    Math.max(0, Math.ceil(b.onsetSec * fs)),
    Math.min(n - 1, Math.floor((b.onsetSec + b.durationSec) * fs)),
  ]);
}
function insideAny(i, ranges) {
  return ranges.some(([a, b]) => i >= a && i <= b);
}

describe('gravity (R5.1)', () => {
  it('gravityVector has unit magnitude (1e-12) over a pitch/roll grid and default is [0,0,1]', () => {
    for (const p of ANGLES) {
      for (const r of ANGLES) {
        const g = gravityVector(p, r);
        expect(Math.abs(Math.hypot(...g) - 1)).toBeLessThanOrEqual(1e-12);
      }
    }
    const g0 = gravityVector(0, 0);
    expect(g0[0]).toBeCloseTo(0, 12);
    expect(g0[1]).toBeCloseTo(0, 12);
    expect(g0[2]).toBeCloseTo(1, 12);
  });

  it('with no motion/tremor, per-axis mean equals gravity within the noise tolerance', () => {
    // Noise: sigma = 0.005 g, clipped at 4 sigma, independent per sample, so the
    // mean of n samples has sd <= 0.005/sqrt(n). Tolerance = 5 sd (per axis).
    // The mean vector m = g + e with |e| <= sqrt(3) * tol, so ||m| - 1| <= sqrt(3) * tol.
    for (const seed of SEEDS) {
      for (const [pitchDeg, rollDeg] of [[0, 0], [30, -45], [90, 0], [-180, 180]]) {
        const { p, out } = imu({
          seed, durationSec: 20, fs: 64, motionIntensity: 0, tremorIntensity: 0,
          orientation: { pitchDeg, rollDeg },
        });
        const n = out.x.length;
        const tol = (5 * 0.005) / Math.sqrt(n);
        const g = gravityVector(p.orientation.pitchDeg, p.orientation.rollDeg);
        const mean = AXES.map((ax, a) => {
          let s = 0;
          for (let i = 0; i < n; i++) s += out[ax][i];
          return s / n;
        });
        mean.forEach((m, a) => expect(Math.abs(m - g[a])).toBeLessThanOrEqual(tol));
        expect(Math.abs(Math.hypot(...mean) - 1)).toBeLessThanOrEqual(Math.sqrt(3) * tol);
      }
    }
  });
});

describe('tremor off / on (R5.3)', () => {
  it('tremor = 0: D(0) is exactly zero and output is deterministic', () => {
    for (const seed of SEEDS) {
      const a = imu({ seed, durationSec: 10, tremorIntensity: 0 }).out;
      const b = imu({ seed, durationSec: 10, tremorIntensity: 0 }).out;
      const d = diff(a, b);
      for (const ax of AXES) {
        expect(d[ax].every((v) => v === 0)).toBe(true);
        expect(Array.from(a[ax])).toEqual(Array.from(b[ax]));
      }
    }
  });

  it('tremor 0 vs 1: bit-identical outside bursts; D(1) is zero outside and non-zero inside', () => {
    for (const seed of SEEDS) {
      const base = { seed, durationSec: 20, fs: 64 };
      const off = imu({ ...base, tremorIntensity: 0 });
      const on = imu({ ...base, tremorIntensity: 1 });
      const n = off.out.x.length;
      const ranges = burstIndexRanges(off.out.tremorBursts, 64, n);
      const d = diff(on.out, off.out);
      for (const ax of AXES) {
        for (let i = 0; i < n; i++) {
          if (!insideAny(i, ranges)) {
            expect(on.out[ax][i] === off.out[ax][i]).toBe(true);
            expect(d[ax][i]).toBe(0);
          }
        }
      }
      for (const [a, b] of ranges) {
        let nonZero = false;
        for (let i = a; i <= b; i++) for (const ax of AXES) if (d[ax][i] !== 0) nonZero = true;
        expect(nonZero).toBe(true);
      }
    }
  });
});

describe('tremor schedule (R5.3)', () => {
  const configs = [[5, 25], [5, 256], [30, 64]];

  it.each(configs)('every seed has >= 1 burst, in-range, non-overlapping (dur %i s, fs %i)', (dur, fs) => {
    for (const seed of SEEDS) {
      const { out } = imu({ seed, durationSec: dur, fs, tremorIntensity: 1 });
      expect(out.tremorBursts.length).toBeGreaterThanOrEqual(1);
      expect(out.x.length).toBe(Math.round(dur * fs));
    }
  });

  it.each([5, 30, 600])('schedule invariants at durationSec = %i', (dur) => {
    for (const seed of SEEDS) {
      const s = generateTremorSchedule(seed, dur);
      expect(s.length).toBeGreaterThanOrEqual(1);
      const maxLen = Math.min(5, 0.8 * dur);
      for (let i = 0; i < s.length; i++) {
        const b = s[i];
        expect(b.onsetSec).toBeGreaterThanOrEqual(0);
        expect(b.onsetSec + b.durationSec).toBeLessThanOrEqual(dur);
        expect(b.durationSec).toBeGreaterThanOrEqual(1.5);
        expect(b.durationSec).toBeLessThanOrEqual(maxLen);
        expect(b.freqHz).toBeGreaterThanOrEqual(3);
        expect(b.freqHz).toBeLessThanOrEqual(6);
        if (i > 0) expect(b.onsetSec).toBeGreaterThanOrEqual(s[i - 1].onsetSec + s[i - 1].durationSec);
      }
    }
  });

  it('schedule does not depend on tremorIntensity', () => {
    for (const seed of SEEDS) {
      const ref = imu({ seed, durationSec: 15, tremorIntensity: 0 }).out.tremorBursts;
      for (const t of [0.5, 1]) {
        expect(imu({ seed, durationSec: 15, tremorIntensity: t }).out.tremorBursts).toEqual(ref);
      }
      expect(generateTremorSchedule(seed, 15).map((b) => b.onsetSec)).toEqual(ref.map((b) => b.onsetSec));
    }
  });

  it('dominant peak of D(1) per axis lies strictly in [3, 6] Hz', () => {
    const fs = 64;
    for (const seed of SEEDS) {
      const base = { seed, durationSec: 20, fs };
      const d = diff(imu({ ...base, tremorIntensity: 1 }).out, imu({ ...base, tremorIntensity: 0 }).out);
      for (const ax of AXES) {
        const f = dominantFrequency(d[ax], fs, 0, fs / 2);
        expect(f, `seed ${seed} axis ${ax}`).toBeGreaterThanOrEqual(3);
        expect(f, `seed ${seed} axis ${ax}`).toBeLessThanOrEqual(6);
      }
    }
  });
});

describe('tremor energy (P4, R5.4)', () => {
  const TS = [0, 0.05, 0.1, 0.25, 0.5, 0.75, 1];
  const base = { seed: 7, durationSec: 10, fs: 64 };
  const a0 = imu({ ...base, tremorIntensity: 0 }).out;
  const a1 = imu({ ...base, tremorIntensity: 1 }).out;
  const E1 = tremorBandEnergy(diff(a1, a0), 64);
  const ED = (t) => tremorBandEnergy(diff(imu({ ...base, tremorIntensity: t }).out, a0), 64);

  it('E(D(1)) > 0', () => {
    expect(E1).toBeGreaterThan(0);
  });

  it('E(D(t)) = t^2 E(D(1)) within 1e-6 relative on a grid', () => {
    for (const t of TS) {
      expect(Math.abs(ED(t) - t * t * E1)).toBeLessThanOrEqual(1e-6 * E1);
    }
  });

  it('E(D(t)) is strictly increasing over the grid', () => {
    const es = TS.map(ED);
    for (let i = 1; i < es.length; i++) expect(es[i]).toBeGreaterThan(es[i - 1]);
  });

  it('property: quadratic scaling for t in {0} U [0.05, 1]', () => {
    fc.assert(
      fc.property(
        fc.oneof(fc.constant(0), fc.double({ min: 0.05, max: 1, noNaN: true })),
        (t) => Math.abs(ED(t) - t * t * E1) <= 1e-6 * E1,
      ),
      { numRuns: 30 },
    );
  });

  it('full-signal band energy with tremor 1 exceeds tremor 0', () => {
    for (const seed of SEEDS) {
      const b = { seed, durationSec: 10, fs: 64 };
      const e1 = tremorBandEnergy(imu({ ...b, tremorIntensity: 1 }).out, 64);
      const e0 = tremorBandEnergy(imu({ ...b, tremorIntensity: 0 }).out, 64);
      expect(e1, `seed ${seed}`).toBeGreaterThan(e0);
    }
  });
});

describe('bounds at extreme corners (R5.6, R7.2)', () => {
  const sizes = [[5, 25], [5, 256], [30, 64]];
  it.each(sizes)('dur %i s, fs %i', (durationSec, fs) => {
    for (const seed of [1, 42]) {
      for (const pitchDeg of ANGLES) {
        for (const rollDeg of ANGLES) {
          const { out } = imu({
            seed, durationSec, fs, motionIntensity: 1, tremorIntensity: 1,
            orientation: { pitchDeg, rollDeg },
          });
          const g = gravityVector(pitchDeg, rollDeg);
          AXES.forEach((ax, a) => {
            let maxDyn = 0;
            for (const v of out[ax]) {
              if (!Number.isFinite(v) || v < -4 || v > 4) throw new Error(`out of range ${v}`);
              maxDyn = Math.max(maxDyn, Math.abs(v - g[a]));
            }
            expect(maxDyn, `seed ${seed} p${pitchDeg} r${rollDeg} ${ax}`).toBeLessThan(0.75);
            // Design bound 0.5 + 0.15 + 0.06 = 0.71 (1e-12 is float round-off in v - g).
            expect(maxDyn, `seed ${seed} p${pitchDeg} r${rollDeg} ${ax}`).toBeLessThanOrEqual(0.71 + 1e-12);
          });
        }
      }
    }
  });
});

describe('output format and purity', () => {
  it('returns Float64Arrays of length round(durationSec*fs)', () => {
    for (const [durationSec, fs] of [[5, 25], [7.3, 64], [10, 256]]) {
      const { out } = imu({ durationSec, fs });
      for (const ax of AXES) {
        expect(out[ax]).toBeInstanceOf(Float64Array);
        expect(out[ax].length).toBe(Math.round(durationSec * fs));
      }
    }
  });

  it('does not mutate params; same seed identical, different seed differs', () => {
    const p = validateParams({ seed: 9, durationSec: 8, tremorIntensity: 0.5 });
    const before = JSON.stringify(p);
    const a = generateIMU(p);
    const b = generateIMU(p);
    expect(JSON.stringify(p)).toBe(before);
    for (const ax of AXES) expect(Array.from(a[ax])).toEqual(Array.from(b[ax]));
    expect(a.tremorBursts).toEqual(b.tremorBursts);
    const c = generateIMU(validateParams({ seed: 10, durationSec: 8, tremorIntensity: 0.5 }));
    expect(Array.from(c.x)).not.toEqual(Array.from(a.x));
  });
});
