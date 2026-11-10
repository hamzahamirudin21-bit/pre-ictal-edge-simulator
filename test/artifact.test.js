import { describe, it, expect, afterAll } from 'vitest';
import fc from 'fast-check';
import { validateParams } from '../src/generator/params.js';
import { generateIMU } from '../src/generator/imu.js';
import { createRng, deriveSeed } from '../src/generator/prng.js';
import { resolveHrv, generateRRSeries } from '../src/generator/hrv.js';
import { renderPPG } from '../src/generator/ppg.js';
import {
  lowpassZeroPhase,
  artifactComponents,
  computeArtifact,
  applyArtifact,
  ARTIFACT_SCALE,
  ARTIFACT_LOWPASS_HZ,
  PPG_ARTIFACT_CLIP,
} from '../src/generator/artifact.js';

const SEEDS = [1, 2, 3, 42, 1234, 99999];
const FSS = [25, 64, 256];
const ANGLES = [-180, -90, 0, 90, 180];
const TIMEOUT = 30000;

function imu(over = {}) {
  const out = generateIMU(validateParams(over));
  return { ...out, gz: out.gravity[2] };
}

function ppgClean(seed, hr, durationSec, fs) {
  const hrv = resolveHrv(hr, 50, 0);
  const { beatTimes } = generateRRSeries(hrv, durationSec, createRng(deriveSeed(seed, 'rr')));
  return renderPPG(beatTimes, Math.round(durationSec * fs), fs, createRng(deriveSeed(seed, 'ppg')));
}

function pearson(a, b) {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  return sab / Math.sqrt(saa * sbb);
}

function std(a) {
  const n = a.length;
  let m = 0;
  for (const v of a) m += v;
  m /= n;
  let s = 0;
  for (const v of a) s += (v - m) * (v - m);
  return Math.sqrt(s / n);
}

function maxAbs(a) {
  let m = 0;
  for (const v of a) m = Math.max(m, Math.abs(v));
  return m;
}

describe('constants', () => {
  it('match the spec', () => {
    expect(ARTIFACT_SCALE).toBe(2.0);
    expect(ARTIFACT_LOWPASS_HZ).toBe(8);
    expect(PPG_ARTIFACT_CLIP).toBe(3);
  });
});

describe('lowpassZeroPhase: DC gain (R6.1)', () => {
  it.each(FSS)('constant input stays exactly constant at fs %i', (fs) => {
    for (const c of [-3.7, -1, 0, 0.25, 1, 42]) {
      const x = new Float64Array(200).fill(c);
      expect(lowpassZeroPhase(x, fs)).toEqual(new Float64Array(200).fill(c));
    }
  });
});

describe('lowpassZeroPhase: kernel (R6.1)', () => {
  const N = 600;
  it.each(FSS)('impulse response is non-negative everywhere (fs %i)', (fs) => {
    for (const pos of [0, 1, 2, 300, N - 3, N - 2, N - 1]) {
      const x = new Float64Array(N);
      x[pos] = 1;
      const h = lowpassZeroPhase(x, fs);
      for (let i = 0; i < N; i++) expect(h[i]).toBeGreaterThanOrEqual(0);
    }
  });

  it.each(FSS)('interior impulse response sums to 1 within 1e-12 (fs %i)', (fs) => {
    const x = new Float64Array(N);
    x[300] = 1;
    const h = lowpassZeroPhase(x, fs);
    let s = 0;
    for (const v of h) s += v;
    expect(Math.abs(s - 1)).toBeLessThanOrEqual(1e-12);
  });

  it('is monotone: x <= y elementwise implies lowpass(x) <= lowpass(y)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FSS),
        fc.array(fc.tuple(fc.double({ min: -5, max: 5, noNaN: true }), fc.double({ min: 0, max: 5, noNaN: true })), {
          minLength: 1,
          maxLength: 300,
        }),
        (fs, pairs) => {
          const x = Float64Array.from(pairs, ([a]) => a);
          const y = Float64Array.from(pairs, ([a, d]) => a + d);
          const lx = lowpassZeroPhase(x, fs);
          const ly = lowpassZeroPhase(y, fs);
          for (let i = 0; i < lx.length; i++) if (lx[i] > ly[i] + 1e-12) return false;
          return true;
        },
      ),
      { numRuns: 100 },
    );
  }, TIMEOUT);
});

describe('|smooth| <= max|dynZ| (R6.1)', () => {
  it.each(FSS)('imu z, fs %i', (fs) => {
    for (const seed of SEEDS) {
      for (const tremorIntensity of [0, 1]) {
        const { z, gz } = imu({ seed, durationSec: 10, fs, motionIntensity: 0.8, tremorIntensity });
        const { dynZ, smooth } = artifactComponents(z, gz, fs);
        expect(maxAbs(smooth), `seed ${seed}`).toBeLessThanOrEqual(maxAbs(dynZ) + 1e-12);
      }
    }
  });
});

describe('gain 0 (R6.2)', () => {
  it.each(FSS)('artifact is all +0 and ppg equals ppgClean exactly (fs %i)', (fs) => {
    for (const seed of SEEDS) {
      const { z, gz } = imu({ seed, durationSec: 10, fs, motionIntensity: 1, tremorIntensity: 1 });
      const zCopy = Float64Array.from(z);
      const art = computeArtifact(z, gz, 0, fs);
      expect(art).toBeInstanceOf(Float64Array);
      expect(art.length).toBe(z.length);
      for (const v of art) expect(Object.is(v, 0)).toBe(true);
      expect(z).toEqual(zCopy);

      const clean = ppgClean(seed, 70, 10, fs);
      const out = applyArtifact(clean, art);
      expect(out).toEqual(clean);
      expect(out).not.toBe(clean);
    }
  });

  it('preserves -0 and negative values in ppgClean', () => {
    const clean = Float64Array.from([-0, -1.2, 0.5, -0, 1.5, -1.5]);
    const copy = Float64Array.from(clean);
    const art = new Float64Array(clean.length);
    const out = applyArtifact(clean, art);
    expect(out).toEqual(clean);
    clean.forEach((v, i) => expect(Object.is(out[i], v)).toBe(true));
    expect(clean).toEqual(copy);
    expect(art).toEqual(new Float64Array(clean.length));
  });
});

describe('correlation (R6.3, P5)', () => {
  const minPearson = {};
  const minRaw = {};
  const record = (store, fs, v) => { store[fs] = Math.min(store[fs] ?? Infinity, v); };

  afterAll(() => {
    console.log('min Pearson(artifact, smooth) per fs:', JSON.stringify(minPearson));
    console.log('min Pearson(artifact, raw z) per fs:', JSON.stringify(minRaw));
  });

  it.each(FSS)('fs %i: thresholds hold across seeds/durations/tremor/gain/motion', (fs) => {
    for (const durationSec of [5, 30]) {
      for (const seed of SEEDS) {
        for (const tremorIntensity of [0, 0.5, 1]) {
          for (const motionIntensity of [0.3, 0.6, 1]) {
            const { z, gz } = imu({ seed, durationSec, fs, motionIntensity, tremorIntensity });
            const { dynZ, smooth } = artifactComponents(z, gz, fs);
            const ctx = `seed ${seed} fs ${fs} dur ${durationSec} motion ${motionIntensity} tremor ${tremorIntensity}`;
            expect(std(dynZ), ctx).toBeGreaterThanOrEqual(0.01);
            for (const gain of [0.01, 0.5, 1]) {
              const art = computeArtifact(z, gz, gain, fs);
              const r1 = pearson(art, smooth);
              const r2 = pearson(art, z);
              record(minPearson, fs, r1);
              record(minRaw, fs, r2);
              expect(r1, `${ctx} gain ${gain}`).toBeGreaterThanOrEqual(0.999);
              expect(r2, `${ctx} gain ${gain}`).toBeGreaterThanOrEqual(0.9);
            }
          }
        }
      }
    }
  }, TIMEOUT);

  it('smooth correlation also holds at default motion 0.2 when RMS precondition is met', () => {
    for (const fs of FSS) {
      for (const seed of SEEDS) {
        const { z, gz } = imu({ seed, durationSec: 30, fs, motionIntensity: 0.2 });
        const { dynZ, smooth } = artifactComponents(z, gz, fs);
        if (std(dynZ) < 0.01) continue;
        for (const gain of [0.01, 0.5, 1]) {
          expect(pearson(computeArtifact(z, gz, gain, fs), smooth), `seed ${seed} fs ${fs}`).toBeGreaterThanOrEqual(0.999);
        }
      }
    }
  }, TIMEOUT);
});

describe('bounds at extreme corners (R7.1, P8)', () => {
  let maxDyn = 0;
  let maxArt = 0;
  let maxSum = 0;
  afterAll(() => {
    console.log(`max |dynZ| = ${maxDyn}, max |artifact| = ${maxArt}, max |ppgClean + artifact| = ${maxSum}`);
  });

  it.each([[5, 25], [5, 64], [5, 256], [30, 64]])('dur %i s, fs %i', (durationSec, fs) => {
    for (const seed of [1, 42]) {
      const cleans = [40, 180].map((hr) => ppgClean(seed, hr, durationSec, fs));
      for (const pitchDeg of ANGLES) {
        for (const rollDeg of ANGLES) {
          const { z, gz } = imu({
            seed, durationSec, fs, motionIntensity: 1, tremorIntensity: 1, artifactGain: 1,
            orientation: { pitchDeg, rollDeg },
          });
          const { dynZ } = artifactComponents(z, gz, fs);
          const art = computeArtifact(z, gz, 1, fs);
          const ctx = `seed ${seed} p${pitchDeg} r${rollDeg}`;
          expect(maxAbs(dynZ), ctx).toBeLessThanOrEqual(0.71 + 1e-12);
          expect(maxAbs(art), ctx).toBeLessThanOrEqual(1.42 + 1e-12);
          expect(maxAbs(art), ctx).toBeLessThanOrEqual(1.5);
          maxDyn = Math.max(maxDyn, maxAbs(dynZ));
          maxArt = Math.max(maxArt, maxAbs(art));
          for (const clean of cleans) {
            const out = applyArtifact(clean, art);
            let m = 0;
            for (let i = 0; i < clean.length; i++) {
              const sum = clean[i] + art[i];
              m = Math.max(m, Math.abs(sum));
              // clamp inactive: output is exactly the unclamped sum
              if (out[i] !== sum) expect(out[i], `${ctx} i ${i}`).toBe(sum);
            }
            expect(m, ctx).toBeLessThanOrEqual(3);
            maxSum = Math.max(maxSum, m);
          }
        }
      }
    }
  }, TIMEOUT);
});

describe('constant z', () => {
  const GZS = [1, -1, 0, 0.3333333333333333, -0.6];

  it.each(FSS)('z equal to gravityZ gives an all-zero finite artifact at fs %i', (fs) => {
    for (const gz of GZS) {
      const z = new Float64Array(10 * fs).fill(gz);
      for (const gain of [0.01, 0.5, 1]) {
        const art = computeArtifact(z, gz, gain, fs);
        for (const v of art) {
          expect(Number.isFinite(v)).toBe(true);
          expect(Math.abs(v)).toBeLessThanOrEqual(1e-12);
        }
        const clean = ppgClean(3, 70, 10, fs);
        for (const v of applyArtifact(clean, art)) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  // Here dynZ is constant (standard deviation 0) with a non-zero offset c - gravityZ;
  // the unit-DC-gain low-pass preserves it, so the artifact is the constant gain * 2 * (c - gravityZ).
  it.each(FSS)('z = gravityZ + offset gives a constant artifact at fs %i', (fs) => {
    for (const gz of GZS) {
      for (const offset of [0.3, -0.5]) {
        const z = new Float64Array(10 * fs).fill(gz + offset);
        for (const gain of [0.01, 0.5, 1]) {
          const art = computeArtifact(z, gz, gain, fs);
          const expected = gain * 2 * (z[0] - gz);
          for (const v of art) {
            expect(Number.isFinite(v)).toBe(true);
            expect(Math.abs(v - expected)).toBeLessThanOrEqual(1e-12);
          }
          const clean = ppgClean(3, 70, 10, fs);
          for (const v of applyArtifact(clean, art)) expect(Number.isFinite(v)).toBe(true);
        }
      }
    }
  });
});

describe('gravityZ validation', () => {
  const z = Float64Array.from([0.1, 0.2, 0.3, 0.2]);
  const calls = [
    (g) => computeArtifact(z, g, 0.5, 64),
    (g) => artifactComponents(z, g, 64),
  ];

  it.each([['0.5'], [null], [undefined]])('throws TypeError for %s', (bad) => {
    for (const f of calls) expect(() => f(bad)).toThrow(TypeError);
  });

  it.each([[NaN], [Infinity], [-Infinity], [1.0001], [-1.0001]])('throws RangeError for %s', (bad) => {
    for (const f of calls) expect(() => f(bad)).toThrow(RangeError);
  });

  it.each([[-1], [0], [1]])('accepts %i', (g) => {
    for (const f of calls) expect(() => f(g)).not.toThrow();
  });

  it('gain 0 returns all +0 for any valid gravityZ', () => {
    for (const g of [-1, -0.4, 0, 0.7, 1]) {
      const art = computeArtifact(z, g, 0, 64);
      expect(art.length).toBe(z.length);
      for (const v of art) expect(Object.is(v, 0)).toBe(true);
    }
  });
});
describe('format, errors, purity', () => {
  it('returns Float64Array of the same length and does not mutate input', () => {
    const { z, gz } = imu({ seed: 5, durationSec: 8, fs: 64, motionIntensity: 0.7 });
    const copy = Float64Array.from(z);
    const lp = lowpassZeroPhase(z, 64);
    const { dynZ, smooth } = artifactComponents(z, gz, 64);
    const art = computeArtifact(z, gz, 0.5, 64);
    for (const a of [lp, dynZ, smooth, art]) {
      expect(a).toBeInstanceOf(Float64Array);
      expect(a.length).toBe(z.length);
    }
    expect(z).toEqual(copy);
    expect(lp).not.toBe(z);
  });

  it('is deterministic', () => {
    const { z, gz } = imu({ seed: 5, durationSec: 8, fs: 64, motionIntensity: 0.7 });
    expect(computeArtifact(z, gz, 0.5, 64)).toEqual(computeArtifact(z, gz, 0.5, 64));
    expect(lowpassZeroPhase(z, 64)).toEqual(lowpassZeroPhase(z, 64));
  });

  it('artifact = gain * 2 * smooth', () => {
    const { z, gz } = imu({ seed: 6, durationSec: 8, fs: 64, motionIntensity: 0.7 });
    const { smooth } = artifactComponents(z, gz, 64);
    const art = computeArtifact(z, gz, 0.4, 64);
    for (let i = 0; i < art.length; i++) expect(art[i]).toBeCloseTo(0.4 * 2 * smooth[i], 12);
  });

  it('dynZ[i] === z[i] - gravityZ exactly, for several orientations', () => {
    for (const [pitchDeg, rollDeg] of [[0, 0], [30, -20], [90, 45], [-180, 90], [10, 180]]) {
      const { z, gz } = imu({ seed: 6, durationSec: 8, fs: 64, motionIntensity: 0.7, orientation: { pitchDeg, rollDeg } });
      const { dynZ } = artifactComponents(z, gz, 64);
      expect(dynZ).toEqual(Float64Array.from(z, (v) => v - gz));
    }
  });

  it('applyArtifact throws RangeError on length mismatch and does not mutate inputs', () => {
    expect(() => applyArtifact(new Float64Array(5), new Float64Array(4))).toThrow(RangeError);
    const clean = Float64Array.from([0.1, 0.2, 0.3]);
    const art = Float64Array.from([5, -5, 0.1]);
    const c0 = Float64Array.from(clean);
    const a0 = Float64Array.from(art);
    const out = applyArtifact(clean, art);
    expect(clean).toEqual(c0);
    expect(art).toEqual(a0);
    expect(Array.from(out)).toEqual([3, -3, 0.4].map((v, i) => (i === 2 ? 0.3 + 0.1 : v)));
  });

  it('lowpassZeroPhase throws RangeError for bad fs / fc', () => {
    const x = new Float64Array(10);
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      expect(() => lowpassZeroPhase(x, bad)).toThrow(RangeError);
      expect(() => lowpassZeroPhase(x, 64, bad)).toThrow(RangeError);
    }
  });

  it('empty input returns an empty Float64Array', () => {
    const e = lowpassZeroPhase(new Float64Array(0), 64);
    expect(e).toBeInstanceOf(Float64Array);
    expect(e.length).toBe(0);
    expect(computeArtifact(new Float64Array(0), 0, 0.5, 64).length).toBe(0);
    expect(applyArtifact(new Float64Array(0), new Float64Array(0)).length).toBe(0);
    const c = artifactComponents(new Float64Array(0), 0, 64);
    expect(c.dynZ.length).toBe(0);
    expect(c.smooth.length).toBe(0);
  });
});
