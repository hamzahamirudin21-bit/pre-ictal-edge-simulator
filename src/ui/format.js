/**
 * Pure UI helpers: formatting, control specs, form validation, debounce.
 * Synthetic data only; no DOM access.
 */
import { DEFAULTS, RANGES, validateParams } from '../generator/params.js';
import { SEED_MIN, SEED_MAX } from '../generator/prng.js';

export function formatNumber(v, digits = 2) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '-';
  return v.toFixed(digits);
}

export const PRE_ICTAL_LABEL = 'Pre-ictal-like (simulation knob, not clinical)';
export const PRE_ICTAL_NOTE = 'Only shifts the simulated HRV and heart rate of this synthetic signal.';

/**
 * @returns {{key: string, path: string[], label: string, unit: string, min: number,
 *   max: number, step: number, default: number, integer: boolean, note?: string}[]}
 */
export function controlSpecs() {
  const mk = (key, path, label, unit, min, max, step, def, integer = false, note) => {
    const spec = { key, path, label, unit, min, max, step, default: def, integer };
    if (note) spec.note = note;
    return spec;
  };
  const r = RANGES;
  return [
    mk('seed', ['seed'], 'Seed', '', SEED_MIN, SEED_MAX, 1, DEFAULTS.seed, true),
    mk('durationSec', ['durationSec'], 'Duration', 's', ...r.durationSec, 1, DEFAULTS.durationSec),
    mk('fs', ['fs'], 'Sampling rate', 'Hz', ...r.fs, 1, DEFAULTS.fs, true),
    mk('heartRateBpm', ['heartRateBpm'], 'Base heart rate', 'bpm', ...r.heartRateBpm, 1, DEFAULTS.heartRateBpm),
    mk('hrvSdnnMs', ['hrvSdnnMs'], 'Base SDNN', 'ms', ...r.hrvSdnnMs, 1, DEFAULTS.hrvSdnnMs),
    mk('preIctalLikeness', ['preIctalLikeness'], PRE_ICTAL_LABEL, '', ...r.preIctalLikeness, 0.01,
      DEFAULTS.preIctalLikeness, false, PRE_ICTAL_NOTE),
    mk('motionIntensity', ['motionIntensity'], 'Motion intensity', '', ...r.motionIntensity, 0.01, DEFAULTS.motionIntensity),
    mk('tremorIntensity', ['tremorIntensity'], 'Tremor intensity', '', ...r.tremorIntensity, 0.01, DEFAULTS.tremorIntensity),
    mk('orientation.pitchDeg', ['orientation', 'pitchDeg'], 'Pitch', 'deg', ...r.pitchDeg, 1, DEFAULTS.orientation.pitchDeg),
    mk('orientation.rollDeg', ['orientation', 'rollDeg'], 'Roll', 'deg', ...r.rollDeg, 1, DEFAULTS.orientation.rollDeg),
    mk('artifactGain', ['artifactGain'], 'Artifact gain', '', ...r.artifactGain, 0.01, DEFAULTS.artifactGain),
  ];
}

/**
 * Build params from raw form values (keyed by spec key, strings or numbers) and validate.
 * Never throws.
 * @returns {{ok: true, params: object} | {ok: false, field: string, message: string}}
 */
export function tryValidate(rawValues) {
  const input = { orientation: {} };
  try {
    for (const spec of controlSpecs()) {
      const raw = rawValues ? rawValues[spec.key] : undefined;
      const text = typeof raw === 'string' ? raw.trim() : raw;
      if (text === undefined || text === null || text === '') {
        return { ok: false, field: spec.key, message: `${spec.path[spec.path.length - 1]} must not be empty` };
      }
      const num = typeof text === 'number' ? text : Number(text);
      if (Number.isNaN(num)) {
        return { ok: false, field: spec.key, message: `${spec.path[spec.path.length - 1]} must be a number` };
      }
      if (spec.path.length === 2) input.orientation[spec.path[1]] = num;
      else input[spec.path[0]] = num;
    }
    return { ok: true, params: validateParams(input) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name = (message.match(/^(\w+)/) || [])[1] || '';
    const field = name === 'pitchDeg' || name === 'rollDeg' ? `orientation.${name}` : name || 'params';
    return { ok: false, field, message };
  }
}

/** Trailing debounce with injectable timers. */
export function debounce(fn, ms, timers = {
  setTimeout: (f, t) => setTimeout(f, t),
  clearTimeout: (h) => clearTimeout(h),
}) {
  let handle = null;
  return (...args) => {
    if (handle !== null) timers.clearTimeout(handle);
    handle = timers.setTimeout(() => {
      handle = null;
      fn(...args);
    }, ms);
  };
}
