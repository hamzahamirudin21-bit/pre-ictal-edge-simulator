/**
 * Spectrum helpers: band energy and dominant frequency via a direct DFT.
 *
 * EDUCATIONAL SIMULATION ONLY. All data is synthetic. NOT a medical device.
 *
 * Normalization (fixed): after mean removal, for bin k (f_k = k * fs / N),
 *   X_k    = sum_n x[n] * exp(-2*pi*i*k*n/N)
 *   energy = sum over bins in band of |X_k|^2 / N
 * Energy is exactly quadratic in amplitude scaling. Only bins k = 1..floor(N/2)
 * are considered. Cost is O(N * bins).
 */

/** Lower edge of the tremor band, Hz. */
export const TREMOR_BAND_LO_HZ = 3;
/** Upper edge of the tremor band, Hz. */
export const TREMOR_BAND_HI_HZ = 6;

function validate(signal, fs, loHz, hiHz) {
  if (signal === null || typeof signal !== 'object' || typeof signal.length !== 'number') {
    throw new TypeError('signal must be a Float64Array or number array');
  }
  if (typeof fs !== 'number' || !Number.isFinite(fs) || fs <= 0) {
    throw new RangeError('fs must be a finite number > 0');
  }
  if (typeof loHz !== 'number' || typeof hiHz !== 'number' || Number.isNaN(loHz) || Number.isNaN(hiHz)) {
    throw new TypeError('loHz and hiHz must be numbers');
  }
  if (loHz < 0 || loHz > hiHz) {
    throw new RangeError('band must satisfy 0 <= loHz <= hiHz');
  }
}

/** Mean-removed copy of the signal (input is never mutated). */
function demeaned(signal) {
  const n = signal.length;
  const x = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += signal[i];
  const mean = n > 0 ? sum / n : 0;
  for (let i = 0; i < n; i++) x[i] = signal[i] - mean;
  return x;
}

/** Calls visit(k, |X_k|^2 / N) for each bin k in 1..floor(N/2) with f_k in [loHz, hiHz]. */
function forEachBin(signal, fs, loHz, hiHz, visit) {
  validate(signal, fs, loHz, hiHz);
  const n = signal.length;
  if (n < 2) return;
  const x = demeaned(signal);
  const kMin = Math.max(1, Math.ceil((loHz * n) / fs - 1e-9));
  const kMax = Math.min(Math.floor(n / 2), Math.floor((hiHz * n) / fs + 1e-9));
  for (let k = kMin; k <= kMax; k++) {
    // Math.cos/sin of the reduced phase per term keeps accuracy high for large N.
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const phase = (2 * Math.PI * ((k * i) % n)) / n;
      re += x[i] * Math.cos(phase);
      im -= x[i] * Math.sin(phase);
    }
    visit(k, (re * re + im * im) / n);
  }
}

/**
 * Total spectral energy in [loHz, hiHz] (inclusive) of the mean-removed signal.
 * Returns 0 for an empty band or a zero signal. O(N * bins).
 * @param {Float64Array|number[]} signal
 * @param {number} fs sample rate, Hz
 * @param {number} loHz
 * @param {number} hiHz
 * @returns {number}
 */
export function bandEnergy(signal, fs, loHz, hiHz) {
  let total = 0;
  forEachBin(signal, fs, loHz, hiHz, (_k, e) => {
    total += e;
  });
  return total;
}

/**
 * Tremor-band (3-6 Hz) energy summed over the x, y, z axes.
 * @param {{x: Float64Array|number[], y: Float64Array|number[], z: Float64Array|number[]}} accel
 * @param {number} fs
 * @returns {number}
 */
export function tremorBandEnergy(accel, fs) {
  return (
    bandEnergy(accel.x, fs, TREMOR_BAND_LO_HZ, TREMOR_BAND_HI_HZ) +
    bandEnergy(accel.y, fs, TREMOR_BAND_LO_HZ, TREMOR_BAND_HI_HZ) +
    bandEnergy(accel.z, fs, TREMOR_BAND_LO_HZ, TREMOR_BAND_HI_HZ)
  );
}

/**
 * Frequency (Hz) of the max-energy bin (k >= 1) within [loHz, hiHz] after mean
 * removal. Returns 0 if there is no bin in range or the signal is all zero.
 * O(N * bins).
 * @param {Float64Array|number[]} signal
 * @param {number} fs
 * @param {number} [loHz=0]
 * @param {number} [hiHz=fs/2]
 * @returns {number}
 */
export function dominantFrequency(signal, fs, loHz = 0, hiHz = fs / 2) {
  let best = 0;
  let bestK = 0;
  forEachBin(signal, fs, loHz, hiHz, (k, e) => {
    if (e > best) {
      best = e;
      bestK = k;
    }
  });
  return bestK === 0 ? 0 : (bestK * fs) / signal.length;
}
