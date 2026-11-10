import { describe, it, expect } from 'vitest';
import { createRng, deriveSeed } from '../src/generator/prng.js';
import { resolveHrv, generateRRSeries } from '../src/generator/hrv.js';
import { renderPPG } from '../src/generator/ppg.js';

function render(hr, sd, k, dur, fs, seed) {
  const hrv = resolveHrv(hr, sd, k);
  const { beatTimes } = generateRRSeries(hrv, dur, createRng(deriveSeed(seed, 'rr')));
  const n = Math.round(dur * fs);
  return { n, beatTimes, ppg: renderPPG(beatTimes, n, fs, createRng(deriveSeed(seed, 'ppg'))) };
}

describe('renderPPG', () => {
  const cases = [];
  for (const fs of [25, 64, 256]) for (const hr of [40, 70, 180]) cases.push([fs, hr]);

  it.each(cases)('fs %i hr %i: length, type, finite, bounded, peak near 1', (fs, hr) => {
    const { n, ppg } = render(hr, 50, 0, 30, fs, 4);
    expect(ppg).toBeInstanceOf(Float64Array);
    expect(ppg.length).toBe(n);
    let peak = 0;
    for (const v of ppg) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(-1.5);
      expect(v).toBeLessThanOrEqual(1.5);
      peak = Math.max(peak, Math.abs(v));
    }
    expect(peak).toBeGreaterThanOrEqual(0.95);
    expect(peak).toBeLessThanOrEqual(1.05 + 1e-12);
  });

  it('is deterministic for the same seed and differs for another seed', () => {
    const a = render(70, 50, 0.3, 30, 64, 9).ppg;
    const b = render(70, 50, 0.3, 30, 64, 9).ppg;
    const c = render(70, 50, 0.3, 30, 64, 10).ppg;
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });

  it('handles hrvSdnnMs = 0 with finite, bounded output', () => {
    for (const hr of [40, 70, 180]) {
      const { ppg } = render(hr, 0, 0, 30, 64, 2);
      for (const v of ppg) {
        expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(v)).toBeLessThanOrEqual(1.05 + 1e-12);
      }
    }
  });

  it('handles extreme HR/HRV with the knob at 0 and 1', () => {
    for (const [hr, sd, k] of [[180, 150, 0], [180, 150, 1], [40, 150, 0], [40, 150, 1]]) {
      const { ppg } = render(hr, sd, k, 30, 64, 5);
      for (const v of ppg) {
        expect(Number.isFinite(v)).toBe(true);
        expect(Math.abs(v)).toBeLessThanOrEqual(1.5);
      }
    }
  });

  it('has roughly one systolic peak per beat (strong peaks near beat times)', () => {
    const fs = 64;
    const { ppg, beatTimes } = render(70, 0, 0, 30, fs, 1);
    // Mean of the signal around systolic position exceeds the global mean.
    const globalMean = ppg.reduce((a, b) => a + b, 0) / ppg.length;
    let acc = 0;
    let cnt = 0;
    for (const t of beatTimes) {
      const i = Math.round((t + 0.15 * (60 / 70)) * fs);
      if (i < ppg.length) { acc += ppg[i]; cnt++; }
    }
    expect(acc / cnt).toBeGreaterThan(globalMean + 0.3);
  });

  it('consumes the RNG a fixed number of times: 1 + 2 * beats', () => {
    const beats = Float64Array.from([0, 0.8, 1.6, 2.4]);
    let calls = 0;
    const rng = { next: () => { calls++; return 0.5; } };
    renderPPG(beats, 192, 64, rng);
    expect(calls).toBe(1 + 2 * beats.length);
  });

  it('does not mutate beatTimes', () => {
    const beats = Float64Array.from([0, 0.8, 1.6]);
    const copy = Array.from(beats);
    renderPPG(beats, 128, 64, createRng(1));
    expect(Array.from(beats)).toEqual(copy);
  });
});
