import { describe, it, expect } from 'vitest';
import { createRng } from '../src/generator/prng.js';
import {
  bandEnergy,
  tremorBandEnergy,
  dominantFrequency,
  TREMOR_BAND_LO_HZ,
  TREMOR_BAND_HI_HZ,
} from '../src/generator/spectrum.js';

const FS = 64;
const N = 640; // 10 s, bin width 0.1 Hz

function sine(freq, amp = 1, n = N, fs = FS) {
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / fs);
  return x;
}

function noise(seed, n = N) {
  const rng = createRng(seed);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = rng.gaussian();
  return x;
}

describe('bandEnergy / dominantFrequency on sines', () => {
  it('concentrates a bin-centred 4 Hz sine in the 3-6 Hz band', () => {
    const x = sine(4, 2);
    const inBand = bandEnergy(x, FS, 3, 6);
    // |X_k|^2 / N = (A N / 2)^2 / N = A^2 N / 4
    expect(Math.abs(inBand - (4 * N) / 4) / ((4 * N) / 4)).toBeLessThan(1e-9);
    expect(bandEnergy(x, FS, 8, 12)).toBeLessThan(1e-9 * inBand);
  });

  it('finds the dominant frequency over the full range and in a sub-band', () => {
    expect(dominantFrequency(sine(4), FS)).toBeCloseTo(4, 9);
    expect(dominantFrequency(sine(10), FS)).toBeCloseTo(10, 9);
    const mix = sine(4, 1);
    const hi = sine(10, 3);
    for (let i = 0; i < N; i++) mix[i] += hi[i];
    expect(dominantFrequency(mix, FS)).toBeCloseTo(10, 9);
    expect(dominantFrequency(mix, FS, 3, 6)).toBeCloseTo(4, 9);
  });
});

describe('bandEnergy properties', () => {
  it('is unaffected by a constant offset and does not mutate its input', () => {
    const x = noise(3);
    const shifted = x.map((v) => v + 5);
    const copy = Array.from(shifted);
    const a = bandEnergy(x, FS, 3, 6);
    const b = bandEnergy(shifted, FS, 3, 6);
    expect(Math.abs(a - b) / a).toBeLessThan(1e-9);
    expect(Array.from(shifted)).toEqual(copy);
  });

  it('scales quadratically: bandEnergy(c*x) = c^2 * bandEnergy(x) within 1e-12 relative', () => {
    const x = noise(11);
    const c = 3.7;
    const cx = x.map((v) => c * v);
    const a = bandEnergy(cx, FS, 3, 6);
    const b = c * c * bandEnergy(x, FS, 3, 6);
    expect(Math.abs(a - b) / b).toBeLessThanOrEqual(1e-12);
  });

  it('returns 0 for an empty band, a zero signal, and an empty signal', () => {
    expect(bandEnergy(noise(5), FS, 3.01, 3.02)).toBe(0); // no bin k*0.1 in range
    expect(bandEnergy(new Float64Array(N), FS, 3, 6)).toBe(0);
    expect(bandEnergy(new Float64Array(0), FS, 3, 6)).toBe(0);
    expect(dominantFrequency(new Float64Array(N), FS)).toBe(0);
  });

  it('tremorBandEnergy equals the sum of per-axis bandEnergy over [3, 6]', () => {
    const accel = { x: noise(1), y: noise(2), z: noise(3) };
    const expected =
      bandEnergy(accel.x, FS, TREMOR_BAND_LO_HZ, TREMOR_BAND_HI_HZ) +
      bandEnergy(accel.y, FS, TREMOR_BAND_LO_HZ, TREMOR_BAND_HI_HZ) +
      bandEnergy(accel.z, FS, TREMOR_BAND_LO_HZ, TREMOR_BAND_HI_HZ);
    expect(TREMOR_BAND_LO_HZ).toBe(3);
    expect(TREMOR_BAND_HI_HZ).toBe(6);
    expect(tremorBandEnergy(accel, FS)).toBe(expected);
  });
});

describe('spectrum validation', () => {
  const x = new Float64Array(16);
  it('throws RangeError for fs <= 0 or non-finite', () => {
    expect(() => bandEnergy(x, 0, 3, 6)).toThrow(RangeError);
    expect(() => bandEnergy(x, -64, 3, 6)).toThrow(RangeError);
    expect(() => bandEnergy(x, Infinity, 3, 6)).toThrow(RangeError);
  });
  it('throws RangeError when lo > hi or lo < 0', () => {
    expect(() => bandEnergy(x, FS, 6, 3)).toThrow(RangeError);
    expect(() => bandEnergy(x, FS, -1, 3)).toThrow(RangeError);
  });
  it('throws TypeError for a non-array signal', () => {
    expect(() => bandEnergy('abc', FS, 3, 6)).toThrow(TypeError);
    expect(() => bandEnergy(null, FS, 3, 6)).toThrow(TypeError);
    expect(() => bandEnergy(5, FS, 3, 6)).toThrow(TypeError);
    expect(() => bandEnergy({}, FS, 3, 6)).toThrow(TypeError);
  });
});
