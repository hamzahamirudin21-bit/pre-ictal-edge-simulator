import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { decimateMinMax, valueToY, timeToX, niceTicks, burstSpans } from '../src/ui/plotData.js';

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
