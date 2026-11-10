/**
 * Synthetic signal generator entry point.
 *
 * EDUCATIONAL SIMULATION ONLY. All data is synthetic. NOT a medical device.
 * `preIctalLikeness` is a simulation knob, not a clinical claim.
 *
 * Pure and deterministic: the same params always give the same output. No
 * module-level mutable state, no Math.random, no Date.now.
 */
import { validateParams } from './params.js';
import { createRng, deriveSeed } from './prng.js';
import { resolveHrv, generateRRSeries } from './hrv.js';
import { renderPPG } from './ppg.js';
import { generateIMU } from './imu.js';
import { computeArtifact, applyArtifact } from './artifact.js';

/** @typedef {import('./params.js').GeneratorParams} GeneratorParams */

/**
 * Generate a synthetic PPG + accelerometer recording.
 *
 * EDUCATIONAL SIMULATION ONLY. All data is synthetic. This is NOT a medical
 * device and makes no clinical claims. Do not use it for any medical decision.
 * The output has `synthetic: true`.
 *
 * `meta.tremorBursts` is `[]` when `tremorIntensity` is 0 (no tremor is added);
 * otherwise it is the full seed-determined burst schedule, which never depends
 * on `tremorIntensity`. Gravity and other internals are not exposed.
 *
 * @param {Partial<GeneratorParams>} [params] user parameters (see the
 *   GeneratorParams typedef in params.js); validated first.
 * @returns {{
 *   synthetic: true, seed: number, fs: number, durationSec: number, n: number,
 *   ppg: Float64Array, ppgClean: Float64Array, artifact: Float64Array,
 *   accel: {x: Float64Array, y: Float64Array, z: Float64Array},
 *   beatTimes: Float64Array,
 *   meta: {
 *     effectiveHrBpm: number, effectiveSdnnMs: number, lfhf: number,
 *     clamped: {hr: boolean, sdnn: boolean},
 *     tremorBursts: {onsetSec: number, durationSec: number, freqHz: number}[]
 *   }
 * }} ppg, ppgClean, artifact and accel axes have length n; beatTimes (seconds,
 *   strictly increasing) has variable length.
 * @throws {TypeError|RangeError} from validateParams for invalid input
 */
export function generateSignals(params = {}) {
  const p = validateParams(params);
  const n = Math.round(p.durationSec * p.fs);

  const hrv = resolveHrv(p.heartRateBpm, p.hrvSdnnMs, p.preIctalLikeness);
  const { beatTimes } = generateRRSeries(hrv, p.durationSec, createRng(deriveSeed(p.seed, 'rr')));

  const ppgClean = renderPPG(beatTimes, n, p.fs, createRng(deriveSeed(p.seed, 'ppg')));

  const imu = generateIMU(p);

  const artifact = computeArtifact(imu.z, imu.gravity[2], p.artifactGain, p.fs);
  const ppg = applyArtifact(ppgClean, artifact);

  const tremorBursts =
    p.tremorIntensity === 0
      ? []
      : imu.tremorBursts.map((b) => ({
          onsetSec: b.onsetSec,
          durationSec: b.durationSec,
          freqHz: b.freqHz,
        }));

  return {
    synthetic: true,
    seed: p.seed,
    fs: p.fs,
    durationSec: p.durationSec,
    n,
    ppg,
    ppgClean,
    artifact,
    accel: { x: imu.x, y: imu.y, z: imu.z },
    beatTimes,
    meta: {
      effectiveHrBpm: hrv.effectiveHrBpm,
      effectiveSdnnMs: hrv.effectiveSdnnMs,
      lfhf: hrv.lfhf,
      clamped: { hr: hrv.clamped.hr, sdnn: hrv.clamped.sdnn },
      tremorBursts,
    },
  };
}
