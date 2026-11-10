import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { createRng, deriveSeed } from '../src/generator/prng.js';
import { resolveHrv, generateRRSeries } from '../src/generator/hrv.js';

const SEEDS = [1, 2, 3, 42, 1234, 99999];

function series(hr, sdnn, k, dur, seed) {
  const hrv = resolveHrv(hr, sdnn, k);
  const out = generateRRSeries(hrv, dur, createRng(deriveSeed(seed, 'rr')));
  return { hrv, ...out };
}

// Population SD (divide by N) of the RR series in ms.
function popSd(xs) {
  let m = 0;
  for (const x of xs) m += x;
  m /= xs.length;
  let s = 0;
  for (const x of xs) s += (x - m) ** 2;
  return Math.sqrt(s / xs.length);
}

function expectSdnnTolerance(measured, eff) {
  const tol = eff < 20 ? 3 : 0.15 * eff;
  expect(Math.abs(measured - eff)).toBeLessThanOrEqual(tol);
}

describe('resolveHrv formulas (R3.4)', () => {
  it('computes exact values at defaults', () => {
    const r = resolveHrv(70, 50, 0);
    expect(r.effectiveHrBpm).toBe(70);
    expect(r.meanRrMs).toBeCloseTo(60000 / 70, 10);
    expect(r.effectiveSdnnMs).toBe(50);
    expect(r.lfhf).toBe(1);
    expect(r.clamped).toEqual({ hr: false, sdnn: false });
  });

  it('applies the pre-ictal-like shift at k = 1', () => {
    const r = resolveHrv(70, 50, 1);
    expect(r.effectiveHrBpm).toBeCloseTo(77, 10);
    expect(r.effectiveSdnnMs).toBeCloseTo(25, 10);
    expect(r.lfhf).toBe(4);
    expect(r.clamped).toEqual({ hr: false, sdnn: false });
  });

  it('applies partial shift at k = 0.5', () => {
    const r = resolveHrv(100, 80, 0.5);
    expect(r.effectiveHrBpm).toBeCloseTo(105, 10);
    expect(r.effectiveSdnnMs).toBeCloseTo(60, 10);
    expect(r.lfhf).toBe(2.5);
  });

  it('caps HR at 180 and flags it', () => {
    const r = resolveHrv(170, 0, 1);
    expect(r.effectiveHrBpm).toBe(180);
    expect(r.clamped.hr).toBe(true);
  });

  it('caps k=1 effHr = hr*1.1 below the limit without flag', () => {
    const r = resolveHrv(160, 10, 1);
    expect(r.effectiveHrBpm).toBeCloseTo(176, 10);
    expect(r.clamped.hr).toBe(false);
  });

  it('caps SDNN at the feasibility cap and flags it', () => {
    // hr 150: meanRr = 400, cap = (400-300)/2.5 = 40
    const r = resolveHrv(150, 100, 0);
    expect(r.effectiveSdnnMs).toBeCloseTo(40, 10);
    expect(r.clamped.sdnn).toBe(true);
    expect(r.clamped.hr).toBe(false);
  });

  it('is the identity at k = 0 (effHr = hr, effSdnn = min(sdnn, cap), lfhf = 1)', () => {
    for (const hr of [40, 70, 120, 170, 180]) {
      for (const sd of [0, 20, 50, 150]) {
        const r = resolveHrv(hr, sd, 0);
        const rr = 60000 / hr;
        const cap = Math.min(150, (rr - 300) / 2.5, (2000 - rr) / 2.5);
        expect(r.effectiveHrBpm).toBe(hr);
        expect(r.effectiveSdnnMs).toBe(Math.min(sd, cap));
        expect(r.lfhf).toBe(1);
        expect(r.clamped.hr).toBe(false);
      }
    }
  });

  it('hr = 40, sdnn = 150, k = 0: meanRr 1500, cap 150, no clamp', () => {
    const r = resolveHrv(40, 150, 0);
    expect(r.meanRrMs).toBeCloseTo(1500, 9);
    expect(r.effectiveSdnnMs).toBe(150);
    expect(r.clamped).toEqual({ hr: false, sdnn: false });
  });

  it('hr = 180, sdnn = 150: k = 0 not hr-clamped, k = 1 hr-clamped; sdnn clamped in both', () => {
    const a = resolveHrv(180, 150, 0);
    expect(a.effectiveHrBpm).toBe(180);
    expect(a.clamped.hr).toBe(false);
    expect(a.clamped.sdnn).toBe(true);
    const b = resolveHrv(180, 150, 1);
    expect(b.effectiveHrBpm).toBe(180);
    expect(b.clamped.hr).toBe(true);
    expect(b.clamped.sdnn).toBe(true);
    expect(b.effectiveSdnnMs).toBeCloseTo((60000 / 180 - 300) / 2.5, 10);
  });

  it('throws TypeError for non-finite or non-number input', () => {
    expect(() => resolveHrv('70', 50, 0)).toThrow(TypeError);
    expect(() => resolveHrv(70, NaN, 0)).toThrow(TypeError);
  });
});

describe('knob monotonicity on post-cap values (R4.2)', () => {
  const grid = Array.from({ length: 21 }, (_, i) => i * 0.05);
  const pairs = [];
  for (const hr of [40, 70, 170, 180]) for (const sd of [0, 50, 150]) pairs.push([hr, sd]);

  it.each(pairs)('hr %i sdnn %i over k grid', (hr, sd) => {
    let prev = resolveHrv(hr, sd, grid[0]);
    for (let i = 1; i < grid.length; i++) {
      const cur = resolveHrv(hr, sd, grid[i]);
      expect(cur.effectiveSdnnMs).toBeLessThanOrEqual(prev.effectiveSdnnMs + 1e-12);
      expect(cur.effectiveHrBpm).toBeGreaterThanOrEqual(prev.effectiveHrBpm);
      expect(cur.lfhf).toBeGreaterThanOrEqual(prev.lfhf);
      prev = cur;
    }
  });

  it('property: monotone over table ranges', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 40, max: 180, noNaN: true }),
        fc.double({ min: 0, max: 150, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (hr, sd, ka, kb) => {
          const [k1, k2] = ka <= kb ? [ka, kb] : [kb, ka];
          const a = resolveHrv(hr, sd, k1);
          const b = resolveHrv(hr, sd, k2);
          return (
            b.effectiveSdnnMs <= a.effectiveSdnnMs + 1e-9 &&
            b.effectiveHrBpm >= a.effectiveHrBpm &&
            b.lfhf >= a.lfhf &&
            b.effectiveHrBpm <= 180
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('generateRRSeries', () => {
  it('is deterministic for the same seed and differs for another', () => {
    const a = series(70, 50, 0, 30, 5);
    const b = series(70, 50, 0, 30, 5);
    const c = series(70, 50, 0, 30, 6);
    expect(Array.from(a.rrMs)).toEqual(Array.from(b.rrMs));
    expect(Array.from(a.beatTimes)).toEqual(Array.from(b.beatTimes));
    expect(Array.from(a.rrMs)).not.toEqual(Array.from(c.rrMs));
  });

  it('returns Float64Array with beatTimes one longer than rrMs, starting at 0, passing the end', () => {
    const { rrMs, beatTimes } = series(70, 50, 0, 30, 1);
    expect(rrMs).toBeInstanceOf(Float64Array);
    expect(beatTimes).toBeInstanceOf(Float64Array);
    expect(beatTimes.length).toBe(rrMs.length + 1);
    expect(beatTimes[0]).toBe(0);
    expect(beatTimes[beatTimes.length - 1]).toBeGreaterThan(30);
  });

  it('keeps beat times strictly increasing and RR within [300, 2000] for extreme configs', () => {
    const configs = [
      [40, 150, 0], [40, 150, 1], [180, 150, 0], [180, 150, 1],
      [150, 150, 0], [170, 150, 1], [70, 150, 1], [70, 0, 0], [100, 100, 0.5],
    ];
    for (const [hr, sd, k] of configs) {
      for (const seed of SEEDS) {
        const { rrMs, beatTimes } = series(hr, sd, k, 60, seed);
        for (let i = 1; i < beatTimes.length; i++) {
          expect(beatTimes[i]).toBeGreaterThan(beatTimes[i - 1]);
        }
        for (const r of rrMs) {
          expect(r).toBeGreaterThanOrEqual(300);
          expect(r).toBeLessThanOrEqual(2000);
        }
      }
    }
  });

  it('hrvSdnnMs = 0: effSdnn 0 and every RR exactly equals meanRrMs', () => {
    for (const hr of [40, 70, 180]) {
      for (const k of [0, 1]) {
        const { hrv, rrMs, beatTimes } = series(hr, 0, k, 30, 7);
        expect(hrv.effectiveSdnnMs).toBe(0);
        for (const r of rrMs) expect(r).toBe(hrv.meanRrMs);
        for (let i = 1; i < beatTimes.length; i++) {
          expect(beatTimes[i]).toBeGreaterThan(beatTimes[i - 1]);
        }
      }
    }
  });

  it('RR never alters from the safety clamp for valid inputs (mean RR near meanRrMs)', () => {
    const { hrv, rrMs } = series(180, 150, 0, 60, 3);
    const peak = Math.max(...rrMs.map((r) => Math.abs(r - hrv.meanRrMs)));
    expect(peak).toBeLessThan(2.5 * hrv.effectiveSdnnMs + 1e-9);
  });

  // Measured SDNN (R3.7) = population SD (divide by N) of rrMs.
  describe('measured SDNN (population SD) within R3.7 tolerance at 30 s', () => {
    const configs = [
      [70, 50, 0], [70, 50, 1], [40, 150, 0], [60, 100, 0], [100, 30, 0],
      [180, 150, 0], [180, 150, 1], [70, 15, 0], [70, 5, 0], [120, 60, 0.5],
    ];
    it.each(configs)('hr %i sdnn %i k %d', (hr, sd, k) => {
      for (const seed of SEEDS) {
        const { hrv, rrMs } = series(hr, sd, k, 30, seed);
        expectSdnnTolerance(popSd(rrMs), hrv.effectiveSdnnMs);
      }
    });
  });

  it('SDNN decreases and LF/HF increases with the knob', () => {
    const lo = series(70, 80, 0, 120, 11);
    const hi = series(70, 80, 1, 120, 11);
    expect(popSd(hi.rrMs)).toBeLessThan(popSd(lo.rrMs));
    expect(hi.hrv.lfhf).toBeGreaterThan(lo.hrv.lfhf);
    expect(hi.hrv.effectiveHrBpm).toBeGreaterThan(lo.hrv.effectiveHrBpm);
  });
});
