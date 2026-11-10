import { describe, it, expect } from 'vitest';
import {
  bandpassSections,
  bandpassDesign,
  bandpassPpg,
  PPG_HIGHPASS_HZ,
  PPG_LOWPASS_HZ,
} from '../src/dsp/bandpass.js';
import { cascadeResponseAt } from '../src/dsp/biquad.js';
import { createRng } from '../src/generator/prng.js';

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

describe('bandpassSections (R5.1)', () => {
  it('is [high-pass 0.5 Hz, low-pass 4 Hz] in that order', () => {
    for (const fs of [25, 64, 256]) {
      const s = bandpassSections(fs);
      expect(s).toHaveLength(2); // 2 x (2 poles, 2 zeros) = 4 poles / 4 zeros
      expect(s[0].type).toBe('highpass');
      expect(s[0].fc).toBe(PPG_HIGHPASS_HZ);
      expect(s[1].type).toBe('lowpass');
      expect(s[1].fc).toBe(PPG_LOWPASS_HZ);
      expect(PPG_HIGHPASS_HZ).toBe(0.5);
      expect(PPG_LOWPASS_HZ).toBe(4);
    }
  });
});

describe('bandpassPpg steady-state start (R5.3)', () => {
  it('maps a constant input to zero output', () => {
    for (const fs of [25, 64, 256]) {
      for (const c of [1, -7.5, 1000]) {
        const y = bandpassPpg(new Array(10 * fs).fill(c), fs);
        let maxAbs = 0;
        for (const v of y) maxAbs = Math.max(maxAbs, Math.abs(v));
        expect(maxAbs).toBeLessThanOrEqual(1e-12 * Math.abs(c));
      }
    }
  });
});

describe('passband and stopband', () => {
  for (const fs of [64, 256]) {
    const sections = bandpassSections(fs);
    const gain = (f) => {
      const N = 60 * fs;
      const x = Array.from({ length: N }, (_, i) => Math.sin((2 * Math.PI * f * i) / fs));
      return toneAmplitude(bandpassPpg(x, fs), f, fs, 20);
    };

    it(`fs=${fs}: 1 Hz and 2 Hz pass and match the analytic response`, () => {
      for (const f of [1, 2]) {
        const g = gain(f);
        const h = cascadeResponseAt(sections, f, fs);
        expect(Math.abs(g - Math.hypot(h.re, h.im))).toBeLessThan(1e-3);
        expect(g).toBeGreaterThanOrEqual(0.9);
      }
    });

    it(`fs=${fs}: 0.25 Hz and 8 Hz are attenuated`, () => {
      const lowG = gain(0.25);
      const highG = gain(8);
      console.log(`fs=${fs}: gain(0.25 Hz)=${lowG.toFixed(4)}, gain(8 Hz)=${highG.toFixed(4)}`);
      expect(lowG).toBeLessThan(0.3);
      expect(highG).toBeLessThan(0.3);
    });
  }
});

describe('L1 bound (R5.4)', () => {
  for (const fs of [25, 64, 128, 256]) {
    it(`|y| <= l1 * max|x| at fs=${fs}`, () => {
      const { l1 } = bandpassDesign(fs);
      const n = 20 * fs;
      const inputs = [
        randomInput(n, 5),
        Array.from({ length: n }, (_, i) => 3 + (Math.floor(i / (fs / 2)) % 2 ? 2 : -2)),
        Array.from({ length: n }, (_, i) => (i % fs === 0 ? 4 : 0)),
      ];
      for (const x of inputs) {
        const maxX = Math.max(...x.map(Math.abs));
        const y = bandpassPpg(x, fs);
        for (const v of y) expect(Math.abs(v)).toBeLessThanOrEqual(l1 * maxX * (1 + 1e-9) + 1e-12);
      }
    });
  }
});

describe('bandpassDesign (R5.2, R5.6)', () => {
  it('is frozen with finite, sensible summary values', () => {
    const d = bandpassDesign(64);
    expect(Object.isFrozen(d)).toBe(true);
    expect(d.sections).toHaveLength(2);
    expect(Number.isFinite(d.groupDelaySecAt1Hz)).toBe(true);
    expect(d.groupDelaySecAt1Hz).toBeGreaterThan(0);
    expect(Number.isFinite(d.l1)).toBe(true);
    expect(d.l1).toBeGreaterThan(1);
    for (const s of d.sections) {
      expect(Object.keys(s).sort()).toEqual(['a1', 'a2', 'b0', 'b1', 'b2']);
    }
  });

  it('returns coefficient copies: mutating them does not affect later designs', () => {
    const d1 = bandpassDesign(64);
    const before = JSON.stringify(d1.sections);
    d1.sections[0].b0 = 999;
    d1.sections.push({});
    const d2 = bandpassDesign(64);
    expect(JSON.stringify(d2.sections)).toBe(before);
  });
});

describe('causality (R5.2)', () => {
  it('changing samples after index k does not change y[0..k]', () => {
    const fs = 64;
    const k = 200;
    const x = randomInput(600, 9);
    const x2 = x.slice();
    for (let i = k + 1; i < x2.length; i++) x2[i] += 5;
    const y = bandpassPpg(x, fs);
    const y2 = bandpassPpg(x2, fs);
    for (let i = 0; i <= k; i++) expect(y2[i]).toBe(y[i]);
    expect(y2[k + 1]).not.toBe(y[k + 1]);
  });
});

describe('validation', () => {
  it('non-number fs throws TypeError', () => {
    for (const bad of ['64', null, undefined, {}]) {
      expect(() => bandpassSections(bad)).toThrow(TypeError);
      expect(() => bandpassDesign(bad)).toThrow(TypeError);
      expect(() => bandpassPpg([1, 2, 3], bad)).toThrow(TypeError);
    }
  });

  it('fs outside 25..256 or non-integer throws RangeError naming fs and 25..256', () => {
    for (const bad of [24, 257, 64.5, NaN, Infinity]) {
      expect(() => bandpassSections(bad)).toThrow(RangeError);
      expect(() => bandpassSections(bad)).toThrow(/fs/);
      expect(() => bandpassSections(bad)).toThrow(/25\.\.256/);
      expect(() => bandpassPpg([1, 2, 3], bad)).toThrow(RangeError);
    }
  });

  it('x null, undefined or string throws TypeError', () => {
    for (const bad of [null, undefined, 'abc', 5]) {
      expect(() => bandpassPpg(bad, 64)).toThrow(TypeError);
    }
  });

  it('empty x gives an empty Float64Array', () => {
    const y = bandpassPpg([], 64);
    expect(y).toBeInstanceOf(Float64Array);
    expect(y).toHaveLength(0);
  });

  it('does not mutate the input and returns a new array', () => {
    const x = Float64Array.from(randomInput(300, 2));
    const copy = Array.from(x);
    const y = bandpassPpg(x, 64);
    expect(y).not.toBe(x);
    expect(Array.from(x)).toEqual(copy);
  });
});
