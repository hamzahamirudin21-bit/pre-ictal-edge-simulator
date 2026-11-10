/**
 * Property-based tests for the synthetic signal generator.
 * Synthetic data, educational only, NOT a medical device.
 *
 * Parameter arbitraries follow the table in the spec's requirements.md (R9.4).
 * Note: fc.double with min 0 may produce -0; validateParams accepts it.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { generateSignals } from '../src/generator/index.js';
import { tremorBandEnergy } from '../src/generator/spectrum.js';
import { lowpassZeroPhase, ARTIFACT_LOWPASS_HZ } from '../src/generator/artifact.js';

export const FULL_RUNS = 40;
export const TIMEOUT = 60000;

export function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

/** Boundary-biased double in [min, max]. */
export function boundaryDouble(min, max) {
  return fc.oneof(
    { arbitrary: fc.constantFrom(min, max), weight: 1 },
    { arbitrary: fc.double({ min, max, noNaN: true, noDefaultInfinity: true }), weight: 3 },
  );
}

/** Boundary-biased integer in [min, max]. */
export function boundaryInt(min, max) {
  return fc.oneof(
    { arbitrary: fc.constantFrom(min, max), weight: 1 },
    { arbitrary: fc.integer({ min, max }), weight: 3 },
  );
}

/**
 * Full-range params arbitrary. `overrides` replaces the arbitrary for any
 * top-level field (seed, durationSec, fs, heartRateBpm, hrvSdnnMs,
 * preIctalLikeness, motionIntensity, tremorIntensity, artifactGain,
 * orientation). Override values may be arbitraries.
 */
export function paramsArb(overrides = {}) {
  const fields = {
    seed: boundaryInt(0, 4294967295),
    durationSec: boundaryDouble(5, 600),
    fs: boundaryInt(25, 256),
    heartRateBpm: boundaryDouble(40, 180),
    hrvSdnnMs: boundaryDouble(0, 150),
    preIctalLikeness: boundaryDouble(0, 1),
    motionIntensity: boundaryDouble(0, 1),
    tremorIntensity: boundaryDouble(0, 1),
    orientation: fc.record({
      pitchDeg: boundaryDouble(-180, 180),
      rollDeg: boundaryDouble(-180, 180),
    }),
    artifactGain: boundaryDouble(0, 1),
    ...overrides,
  };
  return fc.record(fields);
}

describe('P1 determinism', () => {
  it('equal params give deeply equal output (R1.2)', () => {
    fc.assert(
      fc.property(paramsArb(), (p) => {
        expect(generateSignals(p)).toEqual(generateSignals(p));
      }),
      { numRuns: FULL_RUNS, verbose: 1 },
    );
  }, TIMEOUT);
});

describe('P2 output lengths', () => {
  it('all series have length round(durationSec * fs) (R2.2)', () => {
    fc.assert(
      fc.property(paramsArb(), (p) => {
        const o = generateSignals(p);
        const n = Math.round(p.durationSec * p.fs);
        expect(o.n).toBe(n);
        expect(o.ppg.length).toBe(n);
        expect(o.ppgClean.length).toBe(n);
        expect(o.artifact.length).toBe(n);
        expect(o.accel.x.length).toBe(n);
        expect(o.accel.y.length).toBe(n);
        expect(o.accel.z.length).toBe(n);
      }),
      { numRuns: FULL_RUNS, verbose: 1 },
    );
  }, TIMEOUT);
});

/** Scan once: returns { allFinite, min, max, maxAbs }. */
function scan(a) {
  let allFinite = true;
  let min = Infinity;
  let max = -Infinity;
  let maxAbs = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i];
    if (!Number.isFinite(v)) { allFinite = false; continue; }
    if (v < min) min = v;
    if (v > max) max = v;
    const m = Math.abs(v);
    if (m > maxAbs) maxAbs = m;
  }
  return { allFinite, min, max, maxAbs };
}

describe('P3 types, finiteness and bounds', () => {
  it('arrays are Float64Array, finite and within bounds (R2.1, R2.4, R7)', () => {
    fc.assert(
      fc.property(paramsArb(), (p) => {
        const o = generateSignals(p);
        const arrays = {
          ppg: o.ppg, ppgClean: o.ppgClean, artifact: o.artifact,
          'accel.x': o.accel.x, 'accel.y': o.accel.y, 'accel.z': o.accel.z,
          beatTimes: o.beatTimes,
        };
        for (const [name, a] of Object.entries(arrays)) {
          expect(a instanceof Float64Array, `${name} is Float64Array`).toBe(true);
          expect(scan(a).allFinite, `${name} all finite`).toBe(true);
        }
        const bound = (name, a, lim) => {
          const s = scan(a);
          expect(s.maxAbs <= lim, `${name} max |value| = ${s.maxAbs} (limit ${lim})`).toBe(true);
        };
        bound('ppgClean', o.ppgClean, 1.5);
        bound('ppg', o.ppg, 3);
        bound('artifact', o.artifact, 1.5);
        bound('artifact', o.artifact, 1.42);
        bound('accel.x', o.accel.x, 4);
        bound('accel.y', o.accel.y, 4);
        bound('accel.z', o.accel.z, 4);
      }),
      { numRuns: FULL_RUNS, verbose: 1 },
    );
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// P4 tremor energy. R9.4 EXCEPTION: bandEnergy is O(N x bins), so this property
// uses durationSec <= 30, fs <= 64 and numRuns <= 30. Other fields: full range.
// ---------------------------------------------------------------------------
const P4_RUNS = 30;
const tArb = fc.oneof(fc.constant(0), boundaryDouble(0.05, 1));

function diffAccel(a, b) {
  const sub = (u, v) => {
    const r = new Float64Array(u.length);
    for (let i = 0; i < u.length; i++) r[i] = u[i] - v[i];
    return r;
  };
  return { x: sub(a.x, b.x), y: sub(a.y, b.y), z: sub(a.z, b.z) };
}

describe('P4 tremor energy', () => {
  it('tremor-band energy of D(t) scales as t^2 and is monotonic (R5.4)', () => {
    fc.assert(
      fc.property(
        paramsArb({ durationSec: boundaryDouble(5, 30), fs: boundaryInt(25, 64) }),
        tArb, tArb, tArb,
        (p, t, ra, rb) => {
          const cache = new Map();
          const acc = (tt) => {
            if (!cache.has(tt)) cache.set(tt, generateSignals({ ...p, tremorIntensity: tt }).accel);
            return cache.get(tt);
          };
          const a0 = acc(0);
          const E = (tt) => tremorBandEnergy(diffAccel(acc(tt), a0), p.fs);
          const E1 = E(1);
          const ctx = `p=${JSON.stringify(p)}`;
          expect(E1 > 0, `E1=${E1} must be > 0; ${ctx}`).toBe(true);
          for (const tt of [t, ra, rb]) {
            const e = E(tt);
            expect(
              Math.abs(e - tt * tt * E1) <= 1e-6 * E1,
              `t=${tt} E(D(t))=${e} t^2*E1=${tt * tt * E1} E1=${E1}; ${ctx}`,
            ).toBe(true);
          }
          const t1 = Math.min(ra, rb);
          const t2 = Math.max(ra, rb);
          if (t2 - t1 >= 0.05) {
            const e1 = E(t1);
            const e2 = E(t2);
            expect(e2 > e1, `t1=${t1} E=${e1}, t2=${t2} E=${e2}, E1=${E1}; ${ctx}`).toBe(true);
          }
          const full = tremorBandEnergy(acc(1), p.fs);
          const none = tremorBandEnergy(a0, p.fs);
          expect(full > none, `E(accel(1))=${full} E(accel(0))=${none}; ${ctx}`).toBe(true);
        },
      ),
      { numRuns: P4_RUNS, verbose: 1 },
    );
  }, TIMEOUT);
});

describe('P5 zero artifact gain', () => {
  it('gain 0 / -0 gives all +0 artifact and ppg equal to ppgClean (R6.2)', () => {
    fc.assert(
      fc.property(paramsArb({ artifactGain: fc.constantFrom(0, -0) }), (p) => {
        const o = generateSignals(p);
        let badIdx = -1;
        for (let i = 0; i < o.artifact.length; i++) {
          if (!Object.is(o.artifact[i], 0)) { badIdx = i; break; }
        }
        expect(
          badIdx,
          badIdx >= 0 ? `artifact[${badIdx}] = ${Object.is(o.artifact[badIdx], -0) ? '-0' : o.artifact[badIdx]}` : '',
        ).toBe(-1);
        expect(o.ppg).toEqual(o.ppgClean);
        expect(o.ppg !== o.ppgClean, 'ppg and ppgClean are distinct objects').toBe(true);
      }),
      { numRuns: FULL_RUNS, verbose: 1 },
    );
  }, TIMEOUT);
});

describe('P6 beat times', () => {
  it('beatTimes are >= 0, strictly increasing, and extend past durationSec (R3.3)', () => {
    fc.assert(
      fc.property(paramsArb(), (p) => {
        const o = generateSignals(p);
        const b = o.beatTimes;
        expect(b.length >= 2, `beatTimes.length = ${b.length}`).toBe(true);
        expect(b[0] >= 0, `beatTimes[0] = ${b[0]}`).toBe(true);
        let bad = -1;
        for (let i = 1; i < b.length; i++) {
          if (!(b[i] > b[i - 1])) { bad = i; break; }
        }
        expect(
          bad,
          bad >= 0 ? `not strictly increasing at i=${bad}: beatTimes[${bad - 1}]=${b[bad - 1]}, beatTimes[${bad}]=${b[bad]}` : '',
        ).toBe(-1);
        const last = b[b.length - 1];
        expect(last > p.durationSec, `last beat ${last} <= durationSec ${p.durationSec}`).toBe(true);
      }),
      { numRuns: FULL_RUNS, verbose: 1 },
    );
  }, TIMEOUT);
});

describe('P7 pre-ictal knob monotonicity and clamp flags', () => {
  it('knob moves HR up, SDNN down, LF/HF up; clamp flags follow R3.4 (R4.2, R3.4, R3.5)', () => {
    fc.assert(
      fc.property(paramsArb(), boundaryDouble(0, 1), boundaryDouble(0, 1), (p, ka, kb) => {
        const k1 = Math.min(ka, kb);
        const k2 = Math.max(ka, kb);
        const a = generateSignals({ ...p, preIctalLikeness: k1 }).meta;
        const b = generateSignals({ ...p, preIctalLikeness: k2 }).meta;
        const ctx = `p=${JSON.stringify(p)} k1=${k1} k2=${k2}`;

        expect(b.effectiveSdnnMs <= a.effectiveSdnnMs, `sdnn a=${a.effectiveSdnnMs} b=${b.effectiveSdnnMs}; ${ctx}`).toBe(true);
        expect(b.effectiveHrBpm >= a.effectiveHrBpm, `hr a=${a.effectiveHrBpm} b=${b.effectiveHrBpm}; ${ctx}`).toBe(true);
        expect(b.lfhf >= a.lfhf, `lfhf a=${a.lfhf} b=${b.lfhf}; ${ctx}`).toBe(true);

        for (const [name, meta, k] of [['a', a, k1], ['b', b, k2]]) {
          const shiftedHr = p.heartRateBpm * (1 + 0.1 * k);
          const effHr = Math.min(shiftedHr, 180);
          const meanRr = 60000 / effHr;
          const cap = Math.min(150, (meanRr - 300) / 2.5, (2000 - meanRr) / 2.5);
          const shiftedSd = p.hrvSdnnMs * (1 - 0.5 * k);
          const c = `${name}: ${ctx}`;
          expect(meta.clamped.hr, `clamped.hr; ${c}`).toBe(shiftedHr > 180);
          expect(meta.clamped.sdnn, `clamped.sdnn; ${c}`).toBe(shiftedSd > cap);
          expect(meta.effectiveHrBpm <= 180, `effHr <= 180; ${c}`).toBe(true);
          expect(meta.effectiveHrBpm, `effHr; ${c}`).toBe(effHr);
          expect(meta.effectiveSdnnMs, `effSdnn; ${c}`).toBe(Math.min(shiftedSd, cap));
          expect(meta.lfhf, `lfhf; ${c}`).toBe(1 + 3 * k);
        }
      }),
      { numRuns: FULL_RUNS, verbose: 1 },
    );
  }, TIMEOUT);
});

// ---------------------------------------------------------------------------
// P8 artifact correlation with accel z (R6.3).
//
// accel.z can replace dynZ: dynZ = accel.z - g_z where g_z is a constant for the
// whole recording. Pearson correlation and standard deviation are invariant to
// adding a constant. The low-pass is linear with unit DC gain, so
// lowpass(accel.z) = lowpass(dynZ) + g_z (up to rounding), which differs from
// lowpass(dynZ) only by a constant. Hence
// Pearson(artifact, lowpass(accel.z)) = Pearson(artifact, lowpass(dynZ)) and
// std(accel.z) = std(dynZ).
// The precondition uses the standard deviation, while R6.3 says "RMS of dynZ".
// Since dynZ is not mean-removed these differ (std <= RMS), so std >= 0.01
// implies RMS >= 0.01.
// ---------------------------------------------------------------------------
function mean(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

/** Population standard deviation. */
function std(a) {
  const m = mean(a);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
  return Math.sqrt(s / a.length);
}

function pearson(a, b) {
  const ma = mean(a);
  const mb = mean(b);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db;
    saa += da * da;
    sbb += db * db;
  }
  return sab / Math.sqrt(saa * sbb);
}

describe('P8 artifact correlates with accel z', () => {
  it('Pearson(artifact, lowpass(z)) >= 0.999 for motion >= 0.1 (R6.3)', () => {
    let discarded = 0;
    let minR = Infinity;
    fc.assert(
      fc.property(
        paramsArb({ artifactGain: boundaryDouble(0.01, 1), motionIntensity: boundaryDouble(0.1, 1) }),
        (p) => {
          const o = generateSignals(p);
          const sd = std(o.accel.z);
          if (!(sd >= 0.01)) discarded++;
          fc.pre(sd >= 0.01);
          const r = pearson(o.artifact, lowpassZeroPhase(o.accel.z, p.fs, ARTIFACT_LOWPASS_HZ));
          if (r < minR) minR = r;
          expect(r >= 0.999, `pearson=${r} std=${sd}; p=${JSON.stringify(p)}`).toBe(true);
        },
      ),
      { numRuns: FULL_RUNS, verbose: 1 },
    );
    console.log(`P8a discarded=${discarded} minPearson=${minR}`);
  }, TIMEOUT);

  it('Pearson(artifact, z) >= 0.9 for motion >= 0.3 (R6.3)', () => {
    let discarded = 0;
    let minLow = Infinity;
    let minRaw = Infinity;
    fc.assert(
      fc.property(
        paramsArb({ artifactGain: boundaryDouble(0.01, 1), motionIntensity: boundaryDouble(0.3, 1) }),
        (p) => {
          const o = generateSignals(p);
          const sd = std(o.accel.z);
          if (!(sd >= 0.01)) discarded++;
          fc.pre(sd >= 0.01);
          const rLow = pearson(o.artifact, lowpassZeroPhase(o.accel.z, p.fs, ARTIFACT_LOWPASS_HZ));
          const rRaw = pearson(o.artifact, o.accel.z);
          if (rLow < minLow) minLow = rLow;
          if (rRaw < minRaw) minRaw = rRaw;
          const ctx = `std=${sd}; p=${JSON.stringify(p)}`;
          expect(rRaw >= 0.9, `pearson(raw z)=${rRaw} ${ctx}`).toBe(true);
          expect(rLow >= 0.999, `pearson(lowpass z)=${rLow} ${ctx}`).toBe(true);
        },
      ),
      { numRuns: FULL_RUNS, verbose: 1 },
    );
    console.log(`P8b discarded=${discarded} minPearsonLowpass=${minLow} minPearsonRaw=${minRaw}`);
  }, TIMEOUT);
});

describe('P9 beat interval bounds', () => {
  it('every beat interval is within [0.3, 2.0] s and effective HR <= 180 (R3.4)', () => {
    fc.assert(
      fc.property(paramsArb(), (p) => {
        const o = generateSignals(p);
        const b = o.beatTimes;
        let minD = Infinity;
        let maxD = -Infinity;
        let minI = -1;
        let maxI = -1;
        for (let i = 1; i < b.length; i++) {
          const d = b[i] - b[i - 1];
          if (d < minD) { minD = d; minI = i; }
          if (d > maxD) { maxD = d; maxI = i; }
        }
        const ctx = `p=${JSON.stringify(p)}`;
        expect(minD >= 0.3 - 1e-9, `min interval ${minD} at i=${minI}; ${ctx}`).toBe(true);
        expect(maxD <= 2.0 + 1e-9, `max interval ${maxD} at i=${maxI}; ${ctx}`).toBe(true);
        expect(o.meta.effectiveHrBpm <= 180, `effectiveHrBpm=${o.meta.effectiveHrBpm}; ${ctx}`).toBe(true);
      }),
      { numRuns: FULL_RUNS, verbose: 1 },
    );
  }, TIMEOUT);
});

describe('P10 input immutability and no aliasing', () => {
  it('does not mutate a deep-frozen input and returns no references into it (R1.4)', () => {
    fc.assert(
      fc.property(paramsArb(), (p) => {
        const before = structuredClone(p);
        const q = deepFreeze(structuredClone(p));
        const snapshot = JSON.stringify(q);
        const o = generateSignals(q);
        expect(q).toEqual(before);
        const sameLeaves = (a, b, path) => {
          if (typeof a === 'number' || typeof b === 'number') {
            expect(Object.is(a, b), `leaf mismatch at ${path}`).toBe(true);
            return;
          }
          if (a && b && typeof a === 'object') {
            expect(Object.keys(a)).toEqual(Object.keys(b));
            for (const k of Object.keys(a)) sameLeaves(a[k], b[k], `${path}.${k}`);
          }
        };
        sameLeaves(q, before, 'q');
        expect(JSON.stringify(q)).toBe(snapshot);
        expect(o !== q).toBe(true);
        expect(o.meta !== q).toBe(true);
        const seen = new Set();
        const walk = (v, path) => {
          if (!v || typeof v !== 'object' || seen.has(v)) return;
          seen.add(v);
          expect(v !== q && v !== q.orientation, `aliasing at ${path}`).toBe(true);
          if (ArrayBuffer.isView(v)) return;
          for (const [k, c] of Object.entries(v)) walk(c, `${path}.${k}`);
        };
        walk(o, 'o');
      }),
      { numRuns: FULL_RUNS, verbose: 1 },
    );
  }, TIMEOUT);
});
