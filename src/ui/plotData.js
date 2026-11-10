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

/**
 * Plot density threshold in samples per pixel column. Below this many samples
 * per column the plot draws a polyline through the samples; at or above it,
 * the plot draws one vertical min/max bar per column (see decimateMinMax).
 */
export const MIN_SAMPLES_PER_COLUMN = 3;

function assertNumber(name, v) {
  if (typeof v !== 'number') throw new TypeError(`${name} must be a number`);
}

/**
 * Choose how to draw `sampleCount` samples into `columns` pixel columns:
 * 'line' (polyline through the samples) if
 * sampleCount < minSamplesPerColumn * columns, otherwise 'minmax' (one min/max
 * bar per column). With integer counts and an integer threshold such as the
 * default 3, the product is an exact integer (for any column count below
 * 2^53 / threshold), so the boundary has no rounding error.
 * @param {number} sampleCount integer >= 0
 * @param {number} columns integer >= 1
 * @param {number} [minSamplesPerColumn] finite number > 0
 * @returns {'line' | 'minmax'}
 * @throws {TypeError} if an argument is not a number
 * @throws {RangeError} if an argument is outside its range
 */
export function choosePlotMode(sampleCount, columns, minSamplesPerColumn = MIN_SAMPLES_PER_COLUMN) {
  assertNumber('sampleCount', sampleCount);
  if (!Number.isInteger(sampleCount) || sampleCount < 0) {
    throw new RangeError('sampleCount must be an integer >= 0');
  }
  assertNumber('columns', columns);
  if (!Number.isInteger(columns) || columns < 1) {
    throw new RangeError('columns must be an integer >= 1');
  }
  assertNumber('minSamplesPerColumn', minSamplesPerColumn);
  if (!Number.isFinite(minSamplesPerColumn) || minSamplesPerColumn <= 0) {
    throw new RangeError('minSamplesPerColumn must be a finite number > 0');
  }
  return sampleCount < minSamplesPerColumn * columns ? 'line' : 'minmax';
}

/**
 * Prepare one trace for a plot area `width` CSS px wide. The mode is
 * choosePlotMode(count, columns, minSamplesPerColumn), where
 * columns = max(1, floor(width)) and count is the number of samples in
 * signal[start, end).
 *
 * 'line' gives {mode, x, y, yMin, yMax} with one point per sample:
 * y[k] = signal[start + k] (a copy) and x[k] = (k / count) * width. This puts
 * sample k at its time position: for the full signal, x[k] matches
 * timeToX(k / fs, durationSec, width) because durationSec is about n / fs.
 * The first sample is at 0 and the last at width * (count - 1) / count.
 *
 * 'minmax' gives {mode, x, min, max, yMin, yMax} with one vertical bar per
 * pixel column: min and max come from decimateMinMax(signal, columns, start, end)
 * and x[c] = columns > 1 ? (c * width) / (columns - 1) : 0, the column
 * positions the min/max drawing already used.
 *
 * yMin and yMax are the minimum and maximum of the plotted values (of y, or of
 * min and max). An empty range gives mode 'line', empty arrays and
 * yMin = yMax = null. The input is never mutated; all returned arrays are new.
 *
 * @param {ArrayLike<number>} signal
 * @param {number} width plot width in CSS px, finite and > 0
 * @param {{start?: number, end?: number, minSamplesPerColumn?: number}} [options]
 *   start (default 0) and end (default signal.length) are floored and clamped
 *   to [0, signal.length] like in decimateMinMax; minSamplesPerColumn defaults
 *   to MIN_SAMPLES_PER_COLUMN.
 * @returns {{mode: 'line', x: Float64Array, y: Float64Array, yMin: number | null, yMax: number | null}
 *   | {mode: 'minmax', x: Float64Array, min: Float64Array, max: Float64Array, yMin: number, yMax: number}}
 * @throws {TypeError} if signal is not an array-like of numbers, or width,
 *   start, end or minSamplesPerColumn is not a number
 * @throws {RangeError} if width is not a finite number > 0, start or end is
 *   NaN, or minSamplesPerColumn is not a finite number > 0
 */
export function preparePlotSeries(signal, width, options = {}) {
  if (typeof signal !== 'object' || signal === null || !Number.isInteger(signal.length) || signal.length < 0) {
    throw new TypeError('signal must be an array-like of numbers');
  }
  assertNumber('width', width);
  if (!Number.isFinite(width) || width <= 0) throw new RangeError('width must be a finite number > 0');
  const { start = 0, end = signal.length, minSamplesPerColumn = MIN_SAMPLES_PER_COLUMN } = options;
  assertNumber('start', start);
  assertNumber('end', end);
  if (Number.isNaN(start) || Number.isNaN(end)) throw new RangeError('start and end must not be NaN');

  const s = Math.min(signal.length, Math.max(0, Math.floor(start)));
  const e = Math.min(signal.length, Math.max(0, Math.floor(end)));
  const count = Math.max(0, e - s);
  for (let i = s; i < s + count; i++) {
    if (typeof signal[i] !== 'number') throw new TypeError(`signal[${i}] must be a number`);
  }
  const columns = Math.max(1, Math.floor(width));
  const mode = choosePlotMode(count, columns, minSamplesPerColumn);

  if (mode === 'line') {
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let k = 0; k < count; k++) {
      const v = signal[s + k];
      x[k] = (k / count) * width;
      y[k] = v;
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
    return count > 0 ? { mode, x, y, yMin, yMax } : { mode, x, y, yMin: null, yMax: null };
  }

  // Here count >= minSamplesPerColumn * columns > 0. For a threshold >= 1 (the
  // default is 3) decimateMinMax returns exactly `columns` columns.
  const { min, max, columns: cols } = decimateMinMax(signal, columns, s, e);
  const x = new Float64Array(cols);
  let yMin = min[0];
  let yMax = max[0];
  for (let c = 0; c < cols; c++) {
    x[c] = cols > 1 ? (c * width) / (cols - 1) : 0;
    if (min[c] < yMin) yMin = min[c];
    if (max[c] > yMax) yMax = max[c];
  }
  return { mode, x, min, max, yMin, yMax };
}
