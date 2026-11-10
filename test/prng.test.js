import { describe, it, expect } from 'vitest';
import { createRng, deriveSeed, validateSeed, SEED_MAX } from '../src/generator/prng.js';

function take(rng, n, fn = 'next') {
  const out = [];
  for (let i = 0; i < n; i++) out.push(rng[fn]());
  return out;
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('createRng', () => {
  it('repeats the same sequence for the same seed', () => {
    expect(take(createRng(42), 100)).toEqual(take(createRng(42), 100));
  });

  it('gives different sequences for different seeds', () => {
    expect(take(createRng(1), 20)).not.toEqual(take(createRng(2), 20));
  });

  it('keeps every value in [0, 1)', () => {
    const values = take(createRng(7), 10000);
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('is roughly uniform (mean near 0.5)', () => {
    expect(Math.abs(mean(take(createRng(123), 20000)) - 0.5)).toBeLessThan(0.01);
  });

  it('keeps state local: using one generator does not affect another', () => {
    const expected = take(createRng(5), 3);
    const a = createRng(5);
    const b = createRng(5);
    take(b, 50);
    expect(take(a, 3)).toEqual(expected);
  });

  it('accepts the seed boundaries 0 and 4294967295', () => {
    expect(() => createRng(0)).not.toThrow();
    expect(() => createRng(SEED_MAX)).not.toThrow();
  });

  it('gaussian gives finite values with mean near 0 and sd near 1', () => {
    const values = take(createRng(99), 20000, 'gaussian');
    expect(values.every(Number.isFinite)).toBe(true);
    const m = mean(values);
    const sd = Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
    expect(Math.abs(m)).toBeLessThan(0.03);
    expect(Math.abs(sd - 1)).toBeLessThan(0.03);
  });

  it('gaussian is repeatable for the same seed', () => {
    expect(take(createRng(3), 50, 'gaussian')).toEqual(take(createRng(3), 50, 'gaussian'));
  });
});

describe('validateSeed', () => {
  it('throws TypeError for non-numbers', () => {
    for (const bad of ['1', null, undefined, {}, true]) {
      expect(() => validateSeed(bad)).toThrow(TypeError);
    }
  });

  it('throws RangeError for non-integers and out-of-range values', () => {
    for (const bad of [1.5, -1, SEED_MAX + 1, NaN, Infinity]) {
      expect(() => validateSeed(bad)).toThrow(RangeError);
    }
  });

  it('createRng rejects bad seeds', () => {
    expect(() => createRng(-1)).toThrow(RangeError);
    expect(() => createRng('x')).toThrow(TypeError);
  });
});

describe('deriveSeed', () => {
  const labels = ['rr', 'ppg', 'motion', 'tremor', 'noise'];

  it('is stable: same seed and label give the same result', () => {
    expect(deriveSeed(1, 'rr')).toBe(deriveSeed(1, 'rr'));
  });

  it('returns an integer in [0, 4294967295]', () => {
    for (const label of labels) {
      const s = deriveSeed(12345, label);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(SEED_MAX);
    }
  });

  it('gives different seeds for different labels', () => {
    expect(new Set(labels.map((l) => deriveSeed(1, l))).size).toBe(labels.length);
  });

  it('gives different seeds for different base seeds', () => {
    expect(deriveSeed(1, 'rr')).not.toBe(deriveSeed(2, 'rr'));
  });

  it('keeps streams independent: using one label does not change another', () => {
    const before = take(createRng(deriveSeed(9, 'tremor')), 10);
    take(createRng(deriveSeed(9, 'motion')), 500);
    expect(take(createRng(deriveSeed(9, 'tremor')), 10)).toEqual(before);
  });

  it('rejects bad input', () => {
    expect(() => deriveSeed(1.5, 'rr')).toThrow(RangeError);
    expect(() => deriveSeed('1', 'rr')).toThrow(TypeError);
    expect(() => deriveSeed(1, '')).toThrow(TypeError);
    expect(() => deriveSeed(1, 5)).toThrow(TypeError);
  });
});