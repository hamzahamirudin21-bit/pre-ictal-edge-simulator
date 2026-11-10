# Design: Module 1 - Synthetic Signal Generator

> EDUCATIONAL SIMULATION ONLY. All data is synthetic. This is NOT a medical device and makes no clinical claims.

Parameter ranges and defaults are defined once, in the table in `requirements.md`. This document refers to them and does not redefine them.

## Layout
```
index.html                 Vite demo page (static disclaimer banner, plots)
package.json, vite.config.js
src/
  disclaimer.js            DISCLAIMER_TEXT constant + renderDisclaimer(el)
  main.js                  demo wiring (only impure code)
  generator/
    README.md              module docs with disclaimer and clamp documentation
    prng.js                mulberry32, gaussian (Box-Muller), deriveSeed
    params.js              DEFAULTS, validateParams -> frozen resolved params
    hrv.js                 resolveHrv (shift + clamp), generateRRSeries
    ppg.js                 renderPPG(beatTimes, n, fs, rng)
    imu.js                 generateIMU
    artifact.js            lowpassZeroPhase, computeArtifact
    spectrum.js            bandEnergy(signal, fs, lo, hi) (Goertzel/DFT), used by tests and demo
    index.js               generateSignals(params) -> output
test/
  prng.test.js, params.test.js, hrv.test.js, ppg.test.js,
  imu.test.js, artifact.test.js, generator.test.js,
  generator.property.test.js
```

## Determinism
`createRng(seed)` returns `{next(), gaussian()}` with state local to the call (mulberry32). `deriveSeed(seed, label)` is the **only** way sub-stream seeds are produced: it hashes the seed and a string label (e.g. `"rr"`, `"ppg"`, `"motion"`, `"tremor"`, `"noise"`) to a 32-bit integer. No XOR shortcuts. Each component owns its stream, so changing `tremorIntensity` cannot shift draws used by motion, noise, or HRV. Tremor schedule and phases depend only on the seed and duration, never on the intensity.

Seed validation lives in `params.js`: `TypeError` if not a number, `RangeError` if non-integer or outside 0..4294967295.

## API
```js
generateSignals(params?) => {
  synthetic: true, seed, fs, durationSec, n,
  ppg, ppgClean, artifact,          // Float64Array(n)
  accel: { x, y, z },               // Float64Array(n), in g
  beatTimes,                        // Float64Array, seconds, strictly increasing
  meta: {
    effectiveHrBpm, effectiveSdnnMs, lfhf,
    clamped: { hr, sdnn },
    tremorBursts: [{ onsetSec, durationSec, freqHz }]
  }
}
```
Pure: returns new arrays, never mutates inputs; `params.js` freezes resolved params. All arrays are `Float64Array`, including `beatTimes`.

## Components

### HRV (`hrv.js`)
`resolveHrv(hr, sdnn, k)` implements requirements R3.4 and R4.1 exactly:
```
effHr     = min(hr * (1 + 0.1k), 180)          clamped.hr   = (unclamped > 180)
meanRr    = 60000 / effHr
sdnnCap   = min(150, (meanRr - 300)/2.5, (2000 - meanRr)/2.5)
shiftedSd = sdnn * (1 - 0.5k)
effSdnn   = min(shiftedSd, sdnnCap)            clamped.sdnn = (shiftedSd > sdnnCap)
lfhf      = 1 + 3k
```
Variability is an LF sinusoid (~0.1 Hz) plus an HF sinusoid (~0.25 Hz) with random phases, power split per `lfhf` (LF power / HF power = lfhf), evaluated at beat time, with a combined (total) SD of `effSdnn * sqrt(0.96)`; plus Gaussian beat-to-beat jitter with sigma_j where sigma_j^2 = 0.04 * effSdnn^2 (sigma_j = 0.2 * effSdnn), clipped at +-2.5 * sigma_j.

Amplitudes are computed analytically from `effSdnn` (each sinusoid amplitude a_i = sqrt(2 * P_i)); there is no division by a measured SD. When `effSdnn = 0`, all variability terms are exactly 0 and every RR equals meanRr.

Bound: sinusoid peak <= 2 * sqrt(0.96) * effSdnn (about 1.96 effSdnn) plus jitter peak <= 0.5 * effSdnn, so the peak deviation is below 2.5 * effSdnn. Combined with sdnnCap, RR stays within [300, 2000] ms; the RR clamp is a safety net that never alters valid series.

In `generateRRSeries`, the constants (0.1, 0.5, 3) are named, illustrative simulation values; cumulative sum gives beat times until `durationSec` plus one beat; expected total SD is about effSdnn (0.96 + 0.04 * clipped-Gaussian variance factor), satisfying R3.7.

### PPG (`ppg.js`)
Per beat, a pulse = systolic Gaussian + smaller diastolic Gaussian (dicrotic notch), with small beat-to-beat width variation. Sum over beats, normalize so peak is about 1, add respiratory baseline wander (~0.25 Hz, amplitude 0.05), then clip to [-1.5, 1.5].

### IMU (`imu.js`)
- Gravity: `[0,0,1]` rotated by pitch then roll (degrees); magnitude stays 1 g.
- Motion: sum of sinusoids in 0.3-2 Hz with random phases per axis, normalized so peak is at most 1, scaled by `0.5 * motionIntensity` g.
- Noise: Gaussian clipped at 4 sigma, sigma `0.005 + 0.01 * motionIntensity` g (at most 0.06 g).
- Tremor: a **sequential, non-overlapping** burst schedule from the tremor stream: at least one burst fully inside the recording (guaranteed by min duration 5 s), burst length in [1.5, min(5, 0.8 * duration)] s, gaps from the RNG, each burst with its own frequency in [3, 6] Hz, Hann envelope, and per-axis phase and gain in [0.5, 1]. Amplitude is `0.15 * tremorIntensity` g. Schedule and phases ignore the intensity, so the tremor contribution is exactly linear in `tremorIntensity`.
- Dynamic bound: motion (at most 0.5) + tremor (at most 0.15, non-overlapping) + noise (at most 0.06) is below 0.71, under the 0.75 g bound. The clamp to 0.75 g (and the final +-4 g) is a safety net that is never active for valid inputs, which keeps the linearity in the tremor test exact.

### Artifact (`artifact.js`)
```
dynZ     = z - mean(z)                         (fixed axis: device z)
smooth   = lowpassZeroPhase(dynZ, fc = 8 Hz)   (single-pole forward then backward;
                                                non-negative kernel, unit DC gain)
artifact = artifactGain * 2.0 * smooth
ppg      = clamp(ppgClean + artifact, -3, 3)
```
Because the kernel is non-negative and sums to 1, `|smooth| <= max|dynZ| <= 0.75`, so `|artifact| <= 1.5` and `|ppgClean + artifact| <= 3`. The clamp never changes valid output. With gain 0, `artifact` is all zeros (no floating-point residue) and `ppg` equals `ppgClean`. Using a fixed axis removes the sign ambiguity of a "dominant direction" and makes the correlation thresholds testable.

### Spectrum helper (`spectrum.js`)
`bandEnergy(signal, fs, loHz, hiHz)`: remove the mean, apply a DFT or Goertzel sum over bins in [lo, hi], return total energy. `tremorBandEnergy(accel, fs)` sums it over x, y, z for 3-6 Hz.

## Correctness properties (fast-check)
Parameter arbitraries draw from the table in `requirements.md`.

1. **P1 Determinism:** equal params and seed give deeply equal output (`Float64Array` equality).
2. **P2 Length:** `ppg`, `ppgClean`, `artifact`, `accel.x/y/z` all have length `round(duration * fs)`.
3. **P3 Bounds:** `ppgClean` in [-1.5, 1.5], `ppg` in [-3, 3], `artifact` in [-1.5, 1.5], accel in [-4, 4], all finite, all arrays are `Float64Array`.
4. **P4 Tremor energy:** for fixed seed and other params, let `D(t) = accel(t) - accel(0)` and `E = tremorBandEnergy`. For `t1 < t2` with `t1, t2 ∈ {0} ∪ [0.05, 1]`: `E(D(t2)) > E(D(t1))`, and for every such t: `|E(D(t)) − t^2 · E(D(1))| <= 1e-6 · E(D(1))`. Also `E(accel(1)) > E(accel(0))`.
5. **P5 Artifact at gain 0:** `artifact` all zeros and `ppg` equals `ppgClean`.
6. **P6 Beat times:** strictly increasing.
7. **P7 Pre-ictal monotonic:** for `k1 <= k2` (`preIctalLikeness`), `meta.effectiveSdnnMs` (after the R3.4 cap) is non-increasing, and `meta.effectiveHrBpm` and `meta.lfhf` are non-decreasing; clamp flags are consistent with R3.4.
8. **P8 Artifact correlation:** when `artifactGain >= 0.01` and RMS(dynZ) >= 0.01 g, Pearson(`artifact`, `lowpass(dynZ)`) >= 0.999; with `motionIntensity >= 0.3`, Pearson(`artifact`, `accel.z`) >= 0.9.
9. **P9 Feasibility:** RR intervals (differences of `beatTimes`) lie in [0.3, 2.0] s for all valid inputs, and `effectiveHrBpm <= 180`.
10. **P10 Input immutability:** the params object is not mutated.

Unit tests also check the measured SDNN (population SD, divide by N, of `rrMs`) against `effectiveSdnnMs` (R3.7) for durations of at least 30 s.

## Error handling
`validateParams` throws `TypeError` for non-numeric and `RangeError` for out-of-range or non-finite inputs (including non-integer `seed` and `fs`), with messages naming the field and valid range.

## Disclaimer
`src/disclaimer.js` exports `DISCLAIMER_TEXT` and `renderDisclaimer(el)`. `index.html` includes a static banner (visible without JS) and `main.js` also renders it. Plots are captioned "Synthetic data". The pre-ictal-like control is labeled "Pre-ictal-like (simulation knob, not clinical)". `src/generator/README.md` and the JSDoc open with the disclaimer and document the feasibility clamp.
