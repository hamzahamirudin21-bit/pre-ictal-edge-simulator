import { describe, it, expect, vi } from 'vitest';
import { controlSpecs, tryValidate, debounce, formatNumber, HRV_SHIFT_LABEL } from '../src/ui/format.js';
import { DEFAULTS, RANGES, validateParams } from '../src/generator/params.js';
import { SEED_MIN, SEED_MAX } from '../src/generator/prng.js';

const KEYS = [
  'seed', 'durationSec', 'fs', 'heartRateBpm', 'hrvSdnnMs', 'preIctalLikeness',
  'motionIntensity', 'tremorIntensity', 'orientation.pitchDeg', 'orientation.rollDeg', 'artifactGain',
];

function defaultsRaw() {
  const raw = {};
  for (const s of controlSpecs()) raw[s.key] = String(s.default);
  return raw;
}

describe('controlSpecs', () => {
  const specs = controlSpecs();
  const by = Object.fromEntries(specs.map((s) => [s.key, s]));

  it('covers exactly the 11 parameters', () => {
    expect(specs.map((s) => s.key).sort()).toEqual([...KEYS].sort());
  });
  it('matches RANGES, DEFAULTS and seed bounds', () => {
    expect([by.seed.min, by.seed.max, by.seed.default]).toEqual([SEED_MIN, SEED_MAX, DEFAULTS.seed]);
    for (const k of ['durationSec', 'fs', 'heartRateBpm', 'hrvSdnnMs', 'preIctalLikeness',
      'motionIntensity', 'tremorIntensity', 'artifactGain']) {
      expect([by[k].min, by[k].max, by[k].default]).toEqual([...RANGES[k], DEFAULTS[k]]);
    }
    expect([by['orientation.pitchDeg'].min, by['orientation.pitchDeg'].max]).toEqual([...RANGES.pitchDeg]);
    expect([by['orientation.rollDeg'].min, by['orientation.rollDeg'].max]).toEqual([...RANGES.rollDeg]);
    expect(by['orientation.rollDeg'].default).toBe(DEFAULTS.orientation.rollDeg);
  });
  it('seed and fs are integers with step 1', () => {
    for (const k of ['seed', 'fs']) {
      expect(by[k].integer).toBe(true);
      expect(by[k].step).toBe(1);
    }
  });
  it('uses the exact HRV shift label', () => {
    expect(by.preIctalLikeness.label).toBe('HRV shift (illustrative, not clinical)');
    expect(by.preIctalLikeness.label).toBe(HRV_SHIFT_LABEL);
    expect(by.preIctalLikeness.note).toMatch(/synthetic/);
  });
});

describe('tryValidate', () => {
  it('accepts defaults', () => {
    const r = tryValidate(defaultsRaw());
    expect(r.ok).toBe(true);
    expect(r.params.durationSec).toBe(30);
  });
  it('maps a range error to its field with the validateParams message', () => {
    const r = tryValidate({ ...defaultsRaw(), heartRateBpm: '500' });
    let expected;
    try { validateParams({ heartRateBpm: 500 }); } catch (e) { expected = e.message; }
    expect(r).toEqual({ ok: false, field: 'heartRateBpm', message: expected });
  });
  it('maps pitchDeg to orientation.pitchDeg', () => {
    const r = tryValidate({ ...defaultsRaw(), 'orientation.pitchDeg': '999' });
    expect(r.ok).toBe(false);
    expect(r.field).toBe('orientation.pitchDeg');
  });
  it('reports empty strings and never throws', () => {
    const r = tryValidate({ ...defaultsRaw(), fs: '' });
    expect(r).toMatchObject({ ok: false, field: 'fs' });
    expect(() => tryValidate(undefined)).not.toThrow();
    expect(() => tryValidate({ seed: 'abc' })).not.toThrow();
    expect(tryValidate({ ...defaultsRaw(), fs: '64.5' }).ok).toBe(false);
  });
});

describe('debounce', () => {
  it('calls once after ms with the last args', () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = debounce(fn, 150, {
      setTimeout: (f, t) => setTimeout(f, t),
      clearTimeout: (h) => clearTimeout(h),
    });
    d(1); d(2); d(3);
    vi.advanceTimersByTime(149);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(3);
    vi.useRealTimers();
  });
});

describe('formatNumber', () => {
  it('formats finite numbers and dashes otherwise', () => {
    expect(formatNumber(1.2345, 2)).toBe('1.23');
    expect(formatNumber(NaN)).toBe('-');
  });
});
