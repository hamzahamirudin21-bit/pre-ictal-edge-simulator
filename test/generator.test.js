import { describe, it, expect } from 'vitest';
import { generateSignals } from '../src/generator/index.js';
import { validateParams } from '../src/generator/params.js';
import { resolveHrv } from '../src/generator/hrv.js';

const SEEDS = [1, 42, 1234];

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}
const clamp3 = (v) => Math.min(3, Math.max(-3, v));
function allFinite(a) {
  for (const v of a) if (!Number.isFinite(v)) return false;
  return true;
}
function maxAbs(a) {
  let m = 0;
  for (const v of a) m = Math.max(m, Math.abs(v));
  return m;
}
function signalArrays(o) {
  return [o.ppg, o.ppgClean, o.artifact, o.accel.x, o.accel.y, o.accel.z, o.beatTimes];
}

describe('output shape and types', () => {
  it('has exactly the documented keys and defaults', () => {
    const o = generateSignals();
    expect(Object.keys(o).sort()).toEqual(
      ['synthetic', 'seed', 'fs', 'durationSec', 'n', 'ppg', 'ppgClean', 'artifact', 'accel', 'beatTimes', 'meta'].sort(),
    );
    expect(o.synthetic).toBe(true);
    expect(o.seed).toBe(1);
    expect(o.fs).toBe(64);
    expect(o.durationSec).toBe(30);
    expect(o.n).toBe(1920);
    expect(Object.keys(o.accel).sort()).toEqual(['x', 'y', 'z']);
    expect(Object.keys(o.meta).sort()).toEqual(
      ['clamped', 'effectiveHrBpm', 'effectiveSdnnMs', 'lfhf', 'tremorBursts'],
    );
    expect(Object.keys(o.meta.clamped).sort()).toEqual(['hr', 'sdnn']);
    for (const a of signalArrays(o)) expect(a).toBeInstanceOf(Float64Array);
    for (const a of signalArrays(o).slice(0, 6)) expect(a.length).toBe(o.n);
    for (let i = 1; i < o.beatTimes.length; i++) expect(o.beatTimes[i]).toBeGreaterThan(o.beatTimes[i - 1]);
  });

  it('echoes resolved params and rounds n', () => {
    const o = generateSignals({ seed: 7, fs: 25, durationSec: 7.25 });
    expect(o.n).toBe(181);
    expect(o.seed).toBe(7);
    expect(o.fs).toBe(25);
    expect(o.durationSec).toBe(7.25);
    expect(o.ppg.length).toBe(181);
    expect(o.accel.z.length).toBe(181);
  });
});

describe('determinism', () => {
  const sets = [
    {},
    { seed: 42, motionIntensity: 1, tremorIntensity: 1, artifactGain: 1 },
    { seed: 9, fs: 25, durationSec: 8, heartRateBpm: 150, preIctalLikeness: 0.7, orientation: { pitchDeg: 30, rollDeg: -60 } },
  ];
  it.each(sets.map((s) => [s]))('same params give equal output %#', (s) => {
    expect(generateSignals(s)).toEqual(generateSignals(s));
  });
  it('different seeds differ', () => {
    const a = generateSignals({ seed: 1 });
    const b = generateSignals({ seed: 2 });
    expect(a.ppg).not.toEqual(b.ppg);
    expect(a.accel.x).not.toEqual(b.accel.x);
  });
});

describe('immutability and aliasing', () => {
  it('does not mutate frozen input', () => {
    const p = deepFreeze({ seed: 3, durationSec: 6, orientation: { pitchDeg: 10, rollDeg: 20 }, tremorIntensity: 1 });
    const copy = JSON.parse(JSON.stringify(p));
    expect(() => generateSignals(p)).not.toThrow();
    expect(p).toEqual(copy);
  });

  it('signal arrays are distinct objects', () => {
    const o = generateSignals({ durationSec: 5 });
    const arrs = signalArrays(o);
    expect(new Set(arrs).size).toBe(7);
  });

  it('mutating returned data does not affect later calls', () => {
    const p = { seed: 5, durationSec: 10, tremorIntensity: 1, heartRateBpm: 180, preIctalLikeness: 1 };
    const a = generateSignals(p);
    for (const arr of signalArrays(a)) arr.fill(99);
    a.meta.tremorBursts.length = 0;
    a.meta.clamped.hr = !a.meta.clamped.hr;
    a.meta.clamped.sdnn = !a.meta.clamped.sdnn;
    const b = generateSignals(p);
    const c = generateSignals(p);
    expect(b).toEqual(c);
    expect(b.meta.tremorBursts.length).toBeGreaterThan(0);
  });
});

describe('stream independence', () => {
  const base = { durationSec: 10, motionIntensity: 0.5 };
  it.each(SEEDS)('seed %i', (seed) => {
    const g = (o) => generateSignals({ ...base, seed, ...o });

    const t = [0, 0.5, 1].map((tremorIntensity) => g({ tremorIntensity }));
    for (const o of t.slice(1)) {
      expect(o.ppgClean).toEqual(t[0].ppgClean);
      expect(o.beatTimes).toEqual(t[0].beatTimes);
      for (const k of ['effectiveHrBpm', 'effectiveSdnnMs', 'lfhf', 'clamped']) {
        expect(o.meta[k]).toEqual(t[0].meta[k]);
      }
    }

    const ref = g({});
    for (const o of [g({ heartRateBpm: 120 }), g({ hrvSdnnMs: 100 }), g({ preIctalLikeness: 1 })]) {
      expect(o.accel.x).toEqual(ref.accel.x);
      expect(o.accel.y).toEqual(ref.accel.y);
      expect(o.accel.z).toEqual(ref.accel.z);
    }

    for (const m of [0, 1]) {
      const o = g({ motionIntensity: m });
      expect(o.ppgClean).toEqual(ref.ppgClean);
      expect(o.beatTimes).toEqual(ref.beatTimes);
    }

    for (const artifactGain of [0, 1]) {
      const o = g({ artifactGain });
      expect(o.ppgClean).toEqual(ref.ppgClean);
      expect(o.accel).toEqual(ref.accel);
    }
  });
});

describe('artifact consistency', () => {
  const sets = [
    { durationSec: 10 },
    { seed: 42, durationSec: 10, motionIntensity: 1, tremorIntensity: 1, artifactGain: 1 },
    { seed: 7, fs: 256, durationSec: 5, motionIntensity: 1, tremorIntensity: 1, artifactGain: 1, heartRateBpm: 40 },
    { seed: 8, fs: 25, durationSec: 20, motionIntensity: 0.6, artifactGain: 0.3, orientation: { pitchDeg: 90, rollDeg: 180 } },
  ];
  it.each(sets.map((s) => [s]))('ppg = clamp(ppgClean + artifact) %#', (s) => {
    const o = generateSignals(s);
    for (let i = 0; i < o.n; i++) {
      expect(o.ppg[i]).toBe(clamp3(o.ppgClean[i] + o.artifact[i]));
    }
  });

  it('gain 0 gives +0 artifact and ppg equals ppgClean', () => {
    for (const seed of SEEDS) {
      const o = generateSignals({ seed, durationSec: 10, motionIntensity: 1, tremorIntensity: 1, artifactGain: 0 });
      for (const v of o.artifact) expect(Object.is(v, 0)).toBe(true);
      expect(o.ppg).toEqual(o.ppgClean);
    }
  });
});

describe('meta', () => {
  const sets = [
    {},
    { heartRateBpm: 100, hrvSdnnMs: 80, preIctalLikeness: 0.5 },
    { heartRateBpm: 40, hrvSdnnMs: 150, preIctalLikeness: 0 },
    { heartRateBpm: 170, hrvSdnnMs: 120, preIctalLikeness: 1 },
  ];
  it.each(sets.map((s) => [s]))('matches resolveHrv %#', (s) => {
    const p = validateParams(s);
    const r = resolveHrv(p.heartRateBpm, p.hrvSdnnMs, p.preIctalLikeness);
    const { meta } = generateSignals(s);
    expect(meta.effectiveHrBpm).toEqual(r.effectiveHrBpm);
    expect(meta.effectiveSdnnMs).toEqual(r.effectiveSdnnMs);
    expect(meta.lfhf).toEqual(r.lfhf);
    expect(meta.clamped).toEqual(r.clamped);
  });

  it('HR 180 with likeness 1 clamps both', () => {
    expect(generateSignals({ heartRateBpm: 180, preIctalLikeness: 1 }).meta.clamped).toEqual({ hr: true, sdnn: true });
  });

  it('tremorBursts schedule', () => {
    for (const seed of SEEDS) {
      const base = { seed, durationSec: 60 };
      expect(generateSignals({ ...base, tremorIntensity: 0 }).meta.tremorBursts).toEqual([]);
      const a = generateSignals({ ...base, tremorIntensity: 0.3 }).meta.tremorBursts;
      const b = generateSignals({ ...base, tremorIntensity: 1 }).meta.tremorBursts;
      expect(a.length).toBeGreaterThan(0);
      expect(a).toEqual(b);
      a.forEach((x, i) => {
        expect(Object.keys(x).sort()).toEqual(['durationSec', 'freqHz', 'onsetSec']);
        expect(x.onsetSec).toBeGreaterThanOrEqual(0);
        expect(x.onsetSec + x.durationSec).toBeLessThanOrEqual(60);
        expect(x.freqHz).toBeGreaterThanOrEqual(3);
        expect(x.freqHz).toBeLessThanOrEqual(6);
        if (i > 0) expect(x.onsetSec).toBeGreaterThanOrEqual(a[i - 1].onsetSec + a[i - 1].durationSec);
      });
    }
  });
});

describe('invalid params', () => {
  const bad = [
    { heartRateBpm: 500 }, { seed: 1.5 }, { seed: '1' }, { fs: 64.5 },
    { durationSec: 4 }, { orientation: null }, null, 'x',
  ];
  it.each(bad.map((b) => [b]))('throws like validateParams %#', (b) => {
    let expected;
    try { validateParams(b); } catch (e) { expected = e; }
    expect(expected).toBeDefined();
    let actual;
    try { generateSignals(b); } catch (e) { actual = e; }
    expect(actual).toBeDefined();
    expect(actual.constructor).toBe(expected.constructor);
    expect(actual.message).toBe(expected.message);
  });
});

describe('extreme orientation grid', () => {
  const angles = [-180, -90, 0, 90, 180];
  const grid = angles.flatMap((pitchDeg) => angles.map((rollDeg) => [pitchDeg, rollDeg]));
  it.each(grid)('pitch %i roll %i', (pitchDeg, rollDeg) => {
    const o = generateSignals({
      durationSec: 5, fs: 25, motionIntensity: 1, tremorIntensity: 1, artifactGain: 1,
      orientation: { pitchDeg, rollDeg },
    });
    for (const a of signalArrays(o)) expect(allFinite(a)).toBe(true);
    expect(maxAbs(o.ppgClean)).toBeLessThanOrEqual(1.5);
    expect(maxAbs(o.ppg)).toBeLessThanOrEqual(3);
    expect(maxAbs(o.artifact)).toBeLessThanOrEqual(1.5);
    for (const ax of ['x', 'y', 'z']) expect(maxAbs(o.accel[ax])).toBeLessThanOrEqual(4);
  });
});

describe('extreme corners', () => {
  const cases = [];
  for (const durationSec of [5, 600]) {
    for (const fs of [25, 256]) {
      for (const heartRateBpm of [40, 180]) {
        cases.push([durationSec, fs, heartRateBpm]);
      }
    }
  }
  it.each(cases)('dur %i fs %i hr %i', (durationSec, fs, heartRateBpm) => {
    const t0 = performance.now();
    const o = generateSignals({
      seed: 1, durationSec, fs, heartRateBpm, motionIntensity: 1, tremorIntensity: 1, artifactGain: 1,
      preIctalLikeness: 1, orientation: { pitchDeg: 180, rollDeg: -180 },
    });
    const ms = performance.now() - t0;
    if (durationSec === 600) console.log(`runtime dur 600 fs ${fs} hr ${heartRateBpm}: ${ms.toFixed(0)} ms`);
    for (const a of signalArrays(o)) expect(allFinite(a)).toBe(true);
    expect(maxAbs(o.ppgClean)).toBeLessThanOrEqual(1.5);
    expect(maxAbs(o.ppg)).toBeLessThanOrEqual(3);
    expect(maxAbs(o.artifact)).toBeLessThanOrEqual(1.5);
    for (const ax of ['x', 'y', 'z']) expect(maxAbs(o.accel[ax])).toBeLessThanOrEqual(4);
  }, 30000);
});
