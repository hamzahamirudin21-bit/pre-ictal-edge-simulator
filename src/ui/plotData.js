/**
 * Pure plot helpers (no DOM). Synthetic data only.
 */

/**
 * Min/max decimation: each output column covers a contiguous index range of
 * signal[start, end). If the range has <= columns samples, one column per sample.
 * @param {ArrayLike<number>} signal
 * @param {number} columns
 * @param {number} [start]
 * @param {number} [end]
 * @returns {{min: Float64Array, max: Float64Array, columns: number}}
 */
export function decimateMinMax(signal, columns, start = 0, end = signal.length) {
  if (!Number.isInteger(columns) || columns < 1) {
    throw new RangeError('columns must be an integer >= 1');
  }
  const s = Math.max(0, Math.floor(start));
  const e = Math.min(signal.length, Math.floor(end));
  const count = Math.max(0, e - s);
  if (count === 0) return { min: new Float64Array(0), max: new Float64Array(0), columns: 0 };
  if (count <= columns) {
    const min = new Float64Array(count);
    for (let i = 0; i < count; i++) min[i] = signal[s + i];
    return { min, max: Float64Array.from(min), columns: count };
  }
  const min = new Float64Array(columns);
  const max = new Float64Array(columns);
  for (let c = 0; c < columns; c++) {
    const a = s + Math.floor((c * count) / columns);
    const b = s + Math.floor(((c + 1) * count) / columns); // exclusive, b > a since count > columns
    let lo = signal[a];
    let hi = lo;
    for (let i = a + 1; i < b; i++) {
      const v = signal[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[c] = lo;
    max[c] = hi;
  }
  return { min, max, columns };
}

/** Map a value to a canvas y (top = yMax). */
export function valueToY(v, yMin, yMax, height) {
  if (yMax === yMin) return height / 2;
  return height - ((v - yMin) / (yMax - yMin)) * height;
}

/** Map a time in seconds to a canvas x. */
export function timeToX(t, durationSec, width) {
  if (durationSec <= 0) return 0;
  return (t / durationSec) * width;
}

/** "Nice" tick values covering [min, max], roughly `count` of them. */
export function niceTicks(min, max, count = 5) {
  if (!(Number.isFinite(min) && Number.isFinite(max)) || count < 1) return [];
  if (max === min) return [min];
  const rawStep = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks = [];
  const first = Math.ceil(min / step - 1e-9) * step;
  for (let v = first; v <= max + step * 1e-9; v += step) {
    ticks.push(Number(v.toPrecision(12)));
  }
  return ticks;
}

/** Pixel spans [x0, x1] of tremor bursts, clipped to [0, width]. */
export function burstSpans(tremorBursts, durationSec, width) {
  const spans = [];
  for (const b of tremorBursts || []) {
    const x0 = Math.max(0, timeToX(b.onsetSec, durationSec, width));
    const x1 = Math.min(width, timeToX(b.onsetSec + b.durationSec, durationSec, width));
    if (x1 > x0) spans.push([x0, x1]);
  }
  return spans;
}
