/**
 * Parameter defaults and validation for the synthetic signal generator.
 *
 * EDUCATIONAL SIMULATION ONLY. All data is synthetic. NOT a medical device.
 * `preIctalLikeness` is a simulation knob, not a clinical claim.
 *
 * Ranges and defaults mirror the table in the spec's requirements.md.
 */
import { validateSeed } from './prng.js';

/**
 * User parameters for the synthetic signal generator. Every field is optional;
 * omitted fields take the default. Ranges are inclusive.
 *
 * EDUCATIONAL SIMULATION ONLY. All data is synthetic. This is NOT a medical
 * device and makes no clinical claims. Do not use it for any medical decision.
 *
 * @typedef {object} GeneratorParams
 * @property {number} seed integer, 0 to 4294967295, default 1
 * @property {number} durationSec recording length in seconds, 5 to 600, default 30
 * @property {number} fs sampling rate in Hz, integer, 25 to 256, default 64
 * @property {number} heartRateBpm base mean heart rate in bpm, 40 to 180, default 70
 * @property {number} hrvSdnnMs base SDNN in ms, 0 to 150, default 50
 * @property {number} preIctalLikeness 0 to 1, default 0. A simulation knob for
 *   teaching, NOT a clinical claim: it raises mean HR, lowers SDNN and raises
 *   LF/HF by illustrative amounts (see the feasibility clamp in README.md).
 * @property {number} motionIntensity 0 to 1, default 0.2; scales voluntary-motion-like
 *   movement (peak 0.5 * motionIntensity g per axis)
 * @property {number} tremorIntensity 0 to 1, default 0; scales tremor bursts
 *   (amplitude 0.15 * tremorIntensity g); 0 adds no tremor
 * @property {{pitchDeg?: number, rollDeg?: number}} orientation device orientation in
 *   degrees, each -180 to 180, default 0 and 0
 * @property {number} artifactGain 0 to 1, default 0.5; gain of the motion artifact in the PPG
 */

export const DEFAULTS = Object.freeze({
  seed: 1,
  durationSec: 30,
  fs: 64,
  heartRateBpm: 70,
  hrvSdnnMs: 50,
  preIctalLikeness: 0,
  motionIntensity: 0.2,
  tremorIntensity: 0,
  orientation: Object.freeze({ pitchDeg: 0, rollDeg: 0 }),
  artifactGain: 0.5,
});

/** Inclusive [min, max] for each numeric parameter (seed is checked by validateSeed). */
export const RANGES = Object.freeze({
  durationSec: Object.freeze([5, 600]),
  fs: Object.freeze([25, 256]),
  heartRateBpm: Object.freeze([40, 180]),
  hrvSdnnMs: Object.freeze([0, 150]),
  preIctalLikeness: Object.freeze([0, 1]),
  motionIntensity: Object.freeze([0, 1]),
  tremorIntensity: Object.freeze([0, 1]),
  pitchDeg: Object.freeze([-180, 180]),
  rollDeg: Object.freeze([-180, 180]),
  artifactGain: Object.freeze([0, 1]),
});

const INTEGER_FIELDS = new Set(['fs']);

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one numeric field and return its value (or the default if omitted).
 * @param {string} name field name used in error messages
 * @param {unknown} value
 * @param {number} fallback default used when value is undefined
 */
function checkNumber(name, value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number') {
    throw new TypeError(`${name} must be a number, got ${value === null ? 'null' : typeof value}`);
  }
  const [min, max] = RANGES[name];
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${name} must be a finite number in [${min}, ${max}], got ${value}`);
  }
  if (INTEGER_FIELDS.has(name) && !Number.isInteger(value)) {
    throw new RangeError(`${name} must be an integer in [${min}, ${max}], got ${value}`);
  }
  return value;
}

/**
 * Validate user parameters and fill in defaults. Does not mutate the input.
 * @param {Partial<GeneratorParams>} [input]
 * @returns {Readonly<object>} frozen, fully resolved parameters (all fields of
 *   GeneratorParams present; orientation is a frozen {pitchDeg, rollDeg})
 * @throws {TypeError} for wrong types
 * @throws {RangeError} for out-of-range, non-finite, or non-integer values
 */
export function validateParams(input = {}) {
  if (!isPlainObject(input)) {
    throw new TypeError('params must be an object');
  }

  const seed = input.seed === undefined ? DEFAULTS.seed : validateSeed(input.seed);

  let orientationIn = input.orientation;
  if (orientationIn === undefined) orientationIn = {};
  if (!isPlainObject(orientationIn)) {
    throw new TypeError('orientation must be an object with pitchDeg and rollDeg');
  }
  const orientation = Object.freeze({
    pitchDeg: checkNumber('pitchDeg', orientationIn.pitchDeg, DEFAULTS.orientation.pitchDeg),
    rollDeg: checkNumber('rollDeg', orientationIn.rollDeg, DEFAULTS.orientation.rollDeg),
  });

  return Object.freeze({
    seed,
    durationSec: checkNumber('durationSec', input.durationSec, DEFAULTS.durationSec),
    fs: checkNumber('fs', input.fs, DEFAULTS.fs),
    heartRateBpm: checkNumber('heartRateBpm', input.heartRateBpm, DEFAULTS.heartRateBpm),
    hrvSdnnMs: checkNumber('hrvSdnnMs', input.hrvSdnnMs, DEFAULTS.hrvSdnnMs),
    preIctalLikeness: checkNumber('preIctalLikeness', input.preIctalLikeness, DEFAULTS.preIctalLikeness),
    motionIntensity: checkNumber('motionIntensity', input.motionIntensity, DEFAULTS.motionIntensity),
    tremorIntensity: checkNumber('tremorIntensity', input.tremorIntensity, DEFAULTS.tremorIntensity),
    orientation,
    artifactGain: checkNumber('artifactGain', input.artifactGain, DEFAULTS.artifactGain),
  });
}