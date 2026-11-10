import { describe, it, expect } from 'vitest';
import { DEFAULTS, RANGES, validateParams } from '../src/generator/params.js';

const ORIENTATION_FIELDS = new Set(['pitchDeg', 'rollDeg']);
const withField = (name, v) => (ORIENTATION_FIELDS.has(name) ? { orientation: { [name]: v } } : { [name]: v });

describe('validateParams defaults', () => {
  it('returns the documented defaults when nothing is given', () => {
    const p = validateParams();
    expect(p).toEqual(DEFAULTS);
    expect(p).toEqual({
      seed: 1,
      durationSec: 30,
      fs: 64,
      heartRateBpm: 70,
      hrvSdnnMs: 50,
      preIctalLikeness: 0,
      motionIntensity: 0.2,
      tremorIntensity: 0,
      orientation: { pitchDeg: 0, rollDeg: 0 },
      artifactGain: 0.5,
    });
  });

  it('fills only the omitted fields', () => {
    const p = validateParams({ heartRateBpm: 90, orientation: { pitchDeg: 10 } });
    expect(p.heartRateBpm).toBe(90);
    expect(p.fs).toBe(64);
    expect(p.orientation).toEqual({ pitchDeg: 10, rollDeg: 0 });
  });

  it('returns a frozen object, including orientation', () => {
    const p = validateParams();
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.orientation)).toBe(true);
  });

  it('does not mutate the input', () => {
    const input = { seed: 5, orientation: { pitchDeg: 1 } };
    const copy = structuredClone(input);
    validateParams(input);
    expect(input).toEqual(copy);
  });
});

describe('validateParams ranges', () => {
  it('accepts both ends of every range', () => {
    for (const [name, [min, max]] of Object.entries(RANGES)) {
      for (const v of [min, max]) {
        expect(() => validateParams(withField(name, v)), `${name}=${v}`).not.toThrow();
      }
    }
  });

  it('rejects values just outside every range with RangeError', () => {
    for (const [name, [min, max]] of Object.entries(RANGES)) {
      for (const v of [min - 1, max + 1]) {
        expect(() => validateParams(withField(name, v)), `${name}=${v}`).toThrow(RangeError);
      }
    }
  });

  it('rejects NaN and Infinity with RangeError', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(() => validateParams({ heartRateBpm: bad })).toThrow(RangeError);
    }
  });

  it('error messages name the field and its range', () => {
    expect(() => validateParams({ heartRateBpm: 500 })).toThrow(/heartRateBpm.*\[40, 180\]/);
    expect(() => validateParams({ orientation: { pitchDeg: 999 } })).toThrow(/pitchDeg.*\[-180, 180\]/);
  });
});

describe('validateParams types', () => {
  it('rejects non-number values with TypeError', () => {
    for (const bad of ['70', null, true, {}, []]) {
      expect(() => validateParams({ heartRateBpm: bad })).toThrow(TypeError);
    }
  });

  it('rejects a non-object params argument', () => {
    for (const bad of [null, 5, 'x', []]) {
      expect(() => validateParams(bad)).toThrow(TypeError);
    }
  });

  it('rejects a non-object orientation', () => {
    for (const bad of [null, 5, 'x', []]) {
      expect(() => validateParams({ orientation: bad })).toThrow(TypeError);
    }
  });
});

describe('validateParams seed', () => {
  it('accepts 0 and 4294967295', () => {
    expect(validateParams({ seed: 0 }).seed).toBe(0);
    expect(validateParams({ seed: 4294967295 }).seed).toBe(4294967295);
  });

  it('throws TypeError for a non-number seed', () => {
    expect(() => validateParams({ seed: '1' })).toThrow(TypeError);
    expect(() => validateParams({ seed: null })).toThrow(TypeError);
  });

  it('throws RangeError for a non-integer or out-of-range seed', () => {
    for (const bad of [1.5, -1, 4294967296, NaN]) {
      expect(() => validateParams({ seed: bad })).toThrow(RangeError);
    }
  });
});

describe('validateParams fs and duration', () => {
  it('rejects a non-integer fs', () => {
    expect(() => validateParams({ fs: 64.5 })).toThrow(RangeError);
  });

  it('accepts a non-integer duration inside the range', () => {
    expect(validateParams({ durationSec: 7.25 }).durationSec).toBe(7.25);
  });

  it('rejects fs below 25 and duration below 5', () => {
    expect(() => validateParams({ fs: 24 })).toThrow(RangeError);
    expect(() => validateParams({ durationSec: 4.9 })).toThrow(RangeError);
  });
});