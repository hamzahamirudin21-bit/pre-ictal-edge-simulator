import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  decimateMinMax, valueToY, timeToX, niceTicks, burstSpans,
  MIN_SAMPLES_PER_COLUMN, choosePlotMode, preparePlotSeries,
} from '../src/ui/plotData.js';

function brute(sig, columns, start, end) {
  const count = end - start;
  const min = [];
  const max = [];
  for (let c = 0; c < columns; c++) {
    const a = start + Math.floor((c * count) / columns);
    const b = start + Math.floor(((c + 1) * count) / columns);
    const slice = Array.from(sig.slice(a, b));
    min.push(Math.min(...slice));
    max.push(Math.max(...slice));
  }
  return { min, max };
}

function rand(n, seed = 7) {
  let s = seed;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = (s / 4294967296) * 4 - 2;
  }
  return out;
}

describe('decimateMinMax', () => {
  it.each([[1000, 100], [1001, 100], [997, 13], [5000, 7], [101, 100]])(
    'keeps per-column min/max (n=%i, columns=%i)',
    (n, cols) => {
      const sig = rand(n);
      const d = decimateMinMax(sig, cols);
      const b = brute(sig, cols, 0, n);
      expect(d.columns).toBe(cols);
      expect(Array.from(d.min)).toEqual(b.min);
      expect(Array.from(d.max)).toEqual(b.max);
      expect(Math.min(...d.min)).toBe(Math.min(...sig));
      expect(Math.max(...d.max)).toBe(Math.max(...sig));
    },
  );

  it('returns one column per sample when n < columns', () => {
    const sig = rand(10);
    const d = decimateMinMax(sig, 100);
    expect(d.columns).toBe(10);
    expect(Array.from(d.min)).toEqual(Array.from(sig));
    expect(Array.from(d.max)).toEqual(Array.from(sig));
  });

  it('returns one column per sample when n equals columns', () => {
    const sig = rand(50);
    const d = decimateMinMax(sig, 50);
    expect(d.columns).toBe(50);
    expect(Array.from(d.min)).toEqual(Array.from(sig));
  });

  it('supports start/end subranges', () => {
    const sig = rand(1000);
    const d = decimateMinMax(sig, 20, 100, 700);
    const b = brute(sig, 20, 100, 700);
    expect(Array.from(d.min)).toEqual(b.min);
    expect(Array.from(d.max)).toEqual(b.max);
  });

  it('is finite and does not mutate input', () => {
    const sig = rand(2000);
    const copy = Float64Array.from(sig);
    const d = decimateMinMax(sig, 64);
    expect(sig).toEqual(copy);
    expect([...d.min, ...d.max].every(Number.isFinite)).toBe(true);
  });

  it('rejects invalid columns', () => {
    for (const c of [0, -1, 1.5, NaN]) {
      expect(() => decimateMinMax(new Float64Array(5), c)).toThrow(RangeError);
    }
  });

  it('property: column min/max match brute force', { timeout: 20000 }, () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: -100, max: 100, noNaN: true }), { minLength: 1, maxLength: 400 }),
        fc.integer({ min: 1, max: 60 }),
        (arr, cols) => {
          const sig = Float64Array.from(arr);
          const d = decimateMinMax(sig, cols);
          if (arr.length <= cols) return d.columns === arr.length;
          const b = brute(sig, cols, 0, arr.length);
          return (
            d.columns === cols &&
            b.min.every((v, i) => v === d.min[i]) &&
            b.max.every((v, i) => v === d.max[i])
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('plot helpers', () => {
  it('valueToY maps yMax to top and yMin to bottom', () => {
    expect(valueToY(1, -1, 1, 100)).toBe(0);
    expect(valueToY(-1, -1, 1, 100)).toBe(100);
    expect(valueToY(5, 5, 5, 100)).toBe(50);
  });
  it('timeToX maps time linearly', () => {
    expect(timeToX(0, 30, 300)).toBe(0);
    expect(timeToX(15, 30, 300)).toBe(150);
    expect(timeToX(30, 30, 300)).toBe(300);
  });
  it('niceTicks returns ordered ticks within range', () => {
    const t = niceTicks(0, 30, 6);
    expect(t[0]).toBe(0);
    expect(t.every((v, i) => i === 0 || v > t[i - 1])).toBe(true);
    expect(t[t.length - 1]).toBeLessThanOrEqual(30);
  });
  it('burstSpans converts and clips bursts', () => {
    const spans = burstSpans(
      [{ onsetSec: 5, durationSec: 5, freqHz: 4 }, { onsetSec: 28, durationSec: 10, freqHz: 4 }],
      30,
      300,
    );
    expect(spans).toEqual([[50, 100], [280, 300]]);
    expect(burstSpans([], 30, 300)).toEqual([]);
  });
});

describe('choosePlotMode and preparePlotSeries', () => {
  const increasingWithin = (x, width) =>
    x.every((v, k) => v >= 0 && v < width && (k === 0 || v > x[k - 1]));

  it('choosePlotMode switches to minmax at exactly 3 samples per column', () => {
    expect(MIN_SAMPLES_PER_COLUMN).toBe(3);
    for (const c of [1, 2, 100, 640, 999]) {
      expect(choosePlotMode(3 * c - 1, c)).toBe('line');
      expect(choosePlotMode(3 * c, c)).toBe('minmax');
      expect(choosePlotMode(3 * c + 1, c)).toBe('minmax');
      expect(choosePlotMode(0, c)).toBe('line');
    }
    expect(choosePlotMode(4, 2, 2.5)).toBe('line');
    expect(choosePlotMode(5, 2, 2.5)).toBe('minmax');
  });

  it('choosePlotMode rejects invalid arguments', () => {
    for (const n of [-1, 1.5]) expect(() => choosePlotMode(n, 10)).toThrow(RangeError);
    for (const c of [0, 1.5]) expect(() => choosePlotMode(10, c)).toThrow(RangeError);
    for (const t of [0, -1, NaN]) expect(() => choosePlotMode(10, 10, t)).toThrow(RangeError);
    expect(() => choosePlotMode('10', 10)).toThrow(TypeError);
  });

  it('gives a polyline through every sample when n is smaller than the width', () => {
    const sig = rand(125);
    const p = preparePlotSeries(sig, 600);
    expect(p.mode).toBe('line');
    expect(p.x).toHaveLength(125);
    expect(p.y).toHaveLength(125);
    expect(Array.from(p.y)).toEqual(Array.from(sig));
    expect(Array.from(p.x)).toEqual(Array.from({ length: 125 }, (_, k) => (k / 125) * 600));
    expect(increasingWithin(p.x, 600)).toBe(true);
    expect(p.yMin).toBe(Math.min(...sig));
    expect(p.yMax).toBe(Math.max(...sig));
  });

  it('switches to min/max columns at 3 samples per column (width 200)', () => {
    const below = rand(599);
    const pl = preparePlotSeries(below, 200);
    expect(pl.mode).toBe('line');
    expect(pl.x).toHaveLength(599);
    expect(pl.y).toHaveLength(599);

    const sig = rand(600);
    const d = decimateMinMax(sig, 200);
    const pm = preparePlotSeries(sig, 200);
    expect(pm.mode).toBe('minmax');
    expect(pm.x).toHaveLength(200);
    expect(Array.from(pm.min)).toEqual(Array.from(d.min));
    expect(Array.from(pm.max)).toEqual(Array.from(d.max));
    expect(Array.from(pm.x)).toEqual(Array.from({ length: 200 }, (_, c) => c * 200 / 199));

    expect(preparePlotSeries(below, 200.9).mode).toBe('line');
    const frac = preparePlotSeries(sig, 200.9);
    expect(frac.mode).toBe('minmax');
    expect(frac.x).toHaveLength(200);
    expect(Array.from(frac.min)).toEqual(Array.from(d.min));
    expect(Array.from(frac.max)).toEqual(Array.from(d.max));
  });

  it('keeps min/max decimation for a dense signal (600 s at 256 Hz)', () => {
    const sig = rand(153600);
    const p = preparePlotSeries(sig, 800);
    expect(p.mode).toBe('minmax');
    expect(p.x).toHaveLength(800);
    expect(p.min).toHaveLength(800);
    expect(p.max).toHaveLength(800);
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of sig) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    expect(p.yMin).toBe(lo);
    expect(p.yMax).toBe(hi);
  });

  it('does not mutate the input and returns new arrays in both modes', () => {
    const cases = [
      [rand(100), 500, 'line'],
      [rand(3000), 500, 'minmax'],
      [Object.freeze(Array.from(rand(50))), 100, 'line'],
      [Object.freeze(Array.from(rand(400))), 100, 'minmax'],
    ];
    for (const [sig, width, mode] of cases) {
      const copy = Array.from(sig);
      const p = preparePlotSeries(sig, width);
      expect(p.mode).toBe(mode);
      expect(Array.from(sig)).toEqual(copy);
      for (const out of mode === 'line' ? [p.x, p.y] : [p.x, p.min, p.max]) expect(out).not.toBe(sig);
    }
  });

  it('returns finite outputs for finite input', () => {
    for (const [n, width] of [[125, 600], [5000, 300.5]]) {
      const p = preparePlotSeries(rand(n), width);
      const values = p.mode === 'line' ? [...p.x, ...p.y] : [...p.x, ...p.min, ...p.max];
      expect(values.every(Number.isFinite)).toBe(true);
      expect(Number.isFinite(p.yMin) && Number.isFinite(p.yMax)).toBe(true);
    }
  });

  it('maps a start/end subrange onto the full width', () => {
    const sig = rand(1000);
    const p = preparePlotSeries(sig, 100, { start: 50, end: 250 });
    expect(p.mode).toBe('line');
    expect(Array.from(p.y)).toEqual(Array.from(sig.slice(50, 250)));
    expect(Array.from(p.x)).toEqual(Array.from({ length: 200 }, (_, k) => (k / 200) * 100));
    // start/end are floored and clamped like in decimateMinMax.
    const floored = preparePlotSeries(sig, 100, { start: 50.9, end: 250.9 });
    expect(Array.from(floored.y)).toEqual(Array.from(sig.slice(50, 250)));
    const clamped = preparePlotSeries(sig, 100, { start: -5, end: 5000 });
    expect(clamped.mode).toBe('minmax');
    expect(Array.from(clamped.min)).toEqual(Array.from(decimateMinMax(sig, 100).min));
  });

  it('handles an empty range and a single sample', () => {
    const empties = [
      preparePlotSeries(new Float64Array(0), 300),
      preparePlotSeries([], 300),
      preparePlotSeries(rand(10), 300, { start: 8, end: 3 }),
    ];
    for (const p of empties) {
      expect(p.mode).toBe('line');
      expect(p.x).toHaveLength(0);
      expect(p.y).toHaveLength(0);
      expect(p.yMin).toBeNull();
      expect(p.yMax).toBeNull();
    }
    const one = preparePlotSeries([0.75], 300);
    expect(one.mode).toBe('line');
    expect(Array.from(one.x)).toEqual([0]);
    expect(Array.from(one.y)).toEqual([0.75]);
    expect(one.yMin).toBe(0.75);
    expect(one.yMax).toBe(0.75);
  });

  it('validates its arguments', () => {
    const sig = rand(10);
    for (const w of [0, -1, NaN, Infinity]) expect(() => preparePlotSeries(sig, w)).toThrow(RangeError);
    expect(() => preparePlotSeries(sig, '600')).toThrow(TypeError);
    for (const t of [0, -1, NaN]) {
      expect(() => preparePlotSeries(sig, 100, { minSamplesPerColumn: t })).toThrow(RangeError);
    }
    for (const s of [null, 'abc', 5]) expect(() => preparePlotSeries(s, 100)).toThrow(TypeError);
  });

  it('property: mode follows the 3-per-column rule and output matches the input', { timeout: 20000 }, () => {
    fc.assert(
      fc.property(
        // size: 'max' so lengths really span 0..2000 (fast-check defaults to small arrays).
        fc.array(fc.double({ min: -100, max: 100, noNaN: true }), { minLength: 0, maxLength: 2000, size: 'max' }),
        fc.oneof(fc.integer({ min: 1, max: 400 }), fc.double({ min: 1, max: 400, noNaN: true })),
        (arr, width) => {
          const sig = Float64Array.from(arr);
          const cols = Math.floor(width);
          const p = preparePlotSeries(sig, width);
          if (!sig.every((v, i) => Object.is(v, arr[i]))) return false;
          if (p.mode !== (arr.length < 3 * cols ? 'line' : 'minmax')) return false;
          if (p.mode === 'line') {
            return (
              p.y.length === arr.length &&
              p.y.every((v, k) => v === sig[k]) &&
              p.x.length === arr.length &&
              increasingWithin(p.x, width)
            );
          }
          const d = decimateMinMax(sig, cols);
          return (
            p.min.length === d.min.length &&
            p.max.length === d.max.length &&
            d.min.every((v, c) => v === p.min[c]) &&
            d.max.every((v, c) => v === p.max[c])
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});
