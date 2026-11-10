# Implementation Plan: Module 2 - Signal Processing Core

> EDUCATIONAL SIMULATION ONLY. All data is synthetic. This is NOT a medical device and makes no clinical claims.

## Overview

This plan builds Module 2 in small steps: biquad design and the PPG bandpass, the DC tracker and IMU conditioning, the NLMS adaptive noise canceller with gate and clamp, peak detection and RR, the evaluation helper, and the `processSignals` assembly. Property tests, a reported-metrics script, and the module docs follow. All code is plain JavaScript (ES modules) under `src/dsp/`, with tests in `test/`, using the existing pinned Vite, Vitest, and fast-check setup from Module 1. Module 2 has no UI; UI integration is a future module.

## Tasks

- [x] 1. Biquad design and PPG bandpass
  - [x] 1.1 Implement `src/dsp/biquad.js` and `src/dsp/butterworth.js`
    - `designLowpass` / `designHighpass`: 2nd-order Butterworth, Q = 1/sqrt(2), bilinear transform with prewarping `K = tan(pi * fc / fs)`, RBJ form, `a0 = 1`; `RangeError` naming `fc` and `fs` for invalid cutoffs
    - `filterBiquad`: transposed Direct Form II, double precision, causal single pass, optional steady-state initialization from `x[0]`; returns a new `Float64Array`
    - Helpers: `dcGain`, `magnitudeAt`, `poleRadius`, impulse-response `l1Norm` (tail below 1e-12 for 1 s)
    - _Requirements: 4.1, 4.2, 4.3, 4.6_
  - [x] 1.2 Implement `src/dsp/bandpass.js`
    - Cascade of the 0.5 Hz high-pass then the 4 Hz low-pass, steady-state initialization, `bandpassPpg(x, fs)`, `bandpassDesign(fs)` returning `{sections, groupDelaySecAt1Hz, l1}`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6_
  - [x] 1.3 Write unit tests in `test/dsp.biquad.test.js` and `test/dsp.bandpass.test.js`
    - Coefficients against closed-form values for several `fs`; DC gain 0 (high-pass) and 1 (low-pass); -3 dB at `fc`; pole radius below 1 for every integer `fs` from 25 to 256; steady-state initialization; cascade order and 4 poles / 4 zeros; group delay reported; L1 bound on example inputs; invalid cutoff errors
    - _Requirements: 4.1, 4.2, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 16.1_

- [x] 2. DC tracker and IMU conditioning
  - [x] 2.1 Implement `src/dsp/dcTracker.js`
    - `trackDc(z, fs)` with `beta = 1 - exp(-2 * pi * 0.05 / fs)` and `dc[0] = z[0]`; `ancReference(z, fs)` returns `r = z - dc` with no 2 Hz high-pass
    - _Requirements: 6.1, 6.2, 6.5_
  - [x] 2.2 Implement `src/dsp/imuConditioning.js`
    - `tremorHighpass(axis, fs)`: 2 Hz 2nd-order Butterworth high-pass with steady-state initialization; `conditionImu(accel, fs)` returns `{ancReference, imuTremor: {x, y, z}}`, feeding the tremor path from the raw axes and keeping it independent of the ANC; no feature extraction
    - _Requirements: 6.2, 6.5, 7.1, 7.4, 7.5_
  - [x] 2.3 Write unit tests in `test/dsp.imu.test.js`
    - DC tracker recurrence and `dc[0]`; constant z gives `|r| <= 1e-12`; step convergence below 1e-3 of the step after 30 s; `imuTremor` gain at most 0.07 at 0.5 Hz and at least 0.95 at 4 Hz; L1 bound on examples; reference path has no 2 Hz high-pass (0.3 Hz sinusoid gain 0.980-0.986 depending on fs (0.9802 at 25 Hz, 0.9840 at 64 Hz, 0.9858 at 256 Hz))
    - _Requirements: 6.1, 6.3, 6.4, 6.5, 7.2, 7.3, 16.1_

- [ ] 3. NLMS adaptive noise canceller
  - [ ] 3.1 Implement `src/dsp/anc.js`
    - `nlmsCancel(d, r, fs)`: centred window `n-D .. n+D`, `D = round(0.1 * fs)`, `L = 2D + 1`, zero outside `0 .. N-1`; `mu = 0.1`, `eps = L * 0.01^2`, weights start at 0; gate on the population standard deviation of `r` over the last `2 * fs` samples (closed while the window is not full or the value is below 0.01 g; frozen weights and `e = d` exactly); weight norm clamp `W_MAX = 10`; returns `{e, gatedFraction, weightClampActive, taps, lookaheadSamples, mu}`
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 10.1, 10.2, 10.3_
  - [ ] 3.2 Write unit tests in `test/dsp.anc.test.js`
    - Window and `taps` / `lookaheadSamples` for several `fs` (including `fs` = 25 and 256); convergence on a known FIR system with a white-noise reference (mean residual power below 1e-3 of the primary power over samples from `2 * fs + 100 * L` to the end); gate closed gives `e === d` exactly and unchanged weights; gate not full at the start; weight clamp activation with a forced large reference and the reported flag; output bound
    - _Requirements: 8.2, 8.3, 8.4, 8.5, 9.1, 9.2, 10.1, 10.2, 10.3, 16.1_

- [ ] 4. Peak detection and RR
  - [ ] 4.1 Implement `src/dsp/peaks.js`
    - `detectPeaks(y, fs, {interpolate})`: strict-rise local maxima, positive and at least 0.5 times the running maximum over the previous 3 s, refractory `max(0.3 s, 0.6 * median of last up to 5 accepted RR)` tested on the interpolated time, parabolic interpolation (default on); `rrFromPeaks(times)`; empty arrays when fewer peaks than needed
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 13.1, 13.2, 13.3_
  - [ ] 4.2 Write unit tests in `test/dsp.peaks.test.js`
    - Synthetic pulse trains at 40 bpm and 180 bpm; a diastolic bump (0.35 of the systolic amplitude) is not detected; refractory behaviour; interpolation on and off; flat signal gives empty arrays; one peak gives empty `rrSec`; strictly increasing times
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 13.1, 13.2, 13.3, 16.1_

- [ ] 5. Evaluation helper
  - [ ] 5.1 Implement `src/dsp/evaluate.js`
    - `evaluateBeats(signals, result, options?)`: validation of `beatTimes`, lag estimate in [0, 0.6 s], Evaluation_Window `[2 s, durationSec - 1 s]`, one-to-one nearest matching within `0.25 * median true RR`, TP / FP / FN, sensitivity, PPV, `beatCountError`, `rrMaeMs`, `null` for empty denominators; `windowedMse(a, b, fs, startSec, endSec)`
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7_
  - [ ] 5.2 Write unit tests in `test/dsp.evaluate.test.js`
    - Hand-made cases: perfect detection, one missed beat, one extra peak, constant lag, peaks outside the window, no peaks (lag 0, `lagEstimated = false`, `null` ratios); invalid `beatTimes`; `windowedMse` on known arrays
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7, 16.1_

- [ ] 6. Assemble `processSignals`
  - [ ] 6.1 Implement `src/dsp/index.js`
    - Validation in the documented order (signals, `fs`, array types, lengths, `n` / `durationSec`, finiteness, options); defaults `anc: true`, `peakInterpolation: true`; compute `ppgBandpassed`, `ppgCleanBandpassed`, `ancReference`, `imuTremor`, ANC (or a copy of `ppg` when disabled), `ppgFiltered`, peaks, `rrSec`; build `meta.anc` and `meta.bandpass`; fresh output arrays; no mutation; no `Math.random`, `Date.now`, or module-level mutable state
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 5.5, 5.6, 8.6, 9.3, 9.4, 11.1, 11.2, 11.3_
  - [ ] 6.2 Write unit tests in `test/dsp.index.test.js`
    - Each validation error (type and range, field named); defaults; output field list and meta shape; `anc: false` metadata (`gatedFraction === null`); no aliasing of input arrays; source scan for `Math.random` and `Date.now` under `src/dsp/`; end-to-end run on a default Module 1 output
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.1, 2.4, 2.5, 3.3, 5.5, 5.6, 11.1, 11.3, 16.1_

- [ ] 7. Property-based tests in `test/dsp.property.test.js` (fast-check, at least 40 runs for generator-based properties, 100 for Property 1, explicit timeouts, arbitraries from the Module 1 parameter table with the full `fs` range 25..256, biased toward boundary values)
  - [ ] 7.1 Create the test file with shared arbitraries and write Property 1
    - **Property 1: Filter outputs are finite and L1-bounded**
    - **Validates: Requirements 5.4, 7.3**
  - [ ] 7.2 Write Property 2
    - **Property 2: ANC output is finite and bounded**
    - **Validates: Requirements 10.3, 8.1**
  - [ ] 7.3 Write Property 3
    - **Property 3: Peak and RR structure**
    - **Validates: Requirements 12.5, 13.1, 13.2**
  - [ ] 7.4 Write Property 4
    - **Property 4: Inputs are never mutated**
    - **Validates: Requirements 3.2**
  - [ ] 7.5 Write Property 5
    - **Property 5: Determinism**
    - **Validates: Requirements 3.1**
  - [ ] 7.6 Write Property 6
    - **Property 6: ANC is an exact pass-through under the no-motion condition**
    - **Validates: Requirements 9.2, 9.3, 9.4**
  - [ ] 7.7 Write Property 7
    - **Property 7: Disabled ANC is the identity**
    - **Validates: Requirements 11.2, 11.3, 2.5**
  - [ ] 7.8 Write Property 8
    - **Property 8: ANC reduces the error under correlated artifact**
    - **Validates: Requirements 8.1, 8.6, 16.6**
  - [ ] 7.9 Write Property 9
    - **Property 9: Beat count at no motion**
    - **Validates: Requirements 12.1, 12.2, 12.3, 14.5**
  - [ ] 7.10 Write Property 10
    - **Property 10: Output contract**
    - **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 8.6**

- [ ] 8. Reported beat metrics
  - [ ] 8.1 Implement `scripts/beat-metrics.js`
    - Exported pure `computeBeatMetrics(grid)` and a CLI part that prints `DISCLAIMER_TEXT` and the label "Synthetic data", then sensitivity, PPV, beat-count error, RR MAE, and the ANC MSE reduction ratio (after the 5 s warm-up, window end `durationSec - 1 s`) over a fixed grid of seeds and motion levels, with and without the ANC; deterministic text; exit status 0 unless a runtime error occurs; no thresholds asserted
    - _Requirements: 15.1, 15.2, 15.3, 15.5, 15.6, 17.2, 17.3_
  - [ ] 8.2 Add the npm script `"metrics": "node scripts/beat-metrics.js"` to `package.json`
    - _Requirements: 15.4_
  - [ ] 8.3 Write a smoke test in `test/dsp.metrics.test.js`
    - Run `computeBeatMetrics` on a reduced grid; check output shape, determinism (two runs equal), and that no pass/fail threshold is applied
    - _Requirements: 15.1, 15.2, 15.3, 15.6, 16.4_

- [ ] 9. Docs
  - [ ] 9.1 Write `src/dsp/README.md`
    - Open with `DISCLAIMER_TEXT` from `src/disclaimer.js`, verbatim; document the exact 4th-order definition (and how it differs from a low-pass to bandpass transform), the two IMU paths and their reasoning, the ANC parameters, gate, and clamp, the peak detection rules, the evaluation helper, and the Metrics_Script; state that Module 2 has no UI and that UI integration is a future module; use only "simulated", "synthetic", and "illustrative" wording
    - _Requirements: 17.1, 17.3, 17.4, 17.5_
  - [ ] 9.2 Extend `test/disclaimer.test.js` to check that `src/dsp/README.md` contains `DISCLAIMER_TEXT`
    - _Requirements: 17.1, 17.6_

- [ ] 10. Final checkpoint
  - Run `npm test` and `npm run build`; confirm `src/dsp/README.md`, the spec files, and the metrics output show the disclaimer. Ensure all tests pass, ask the user if questions arise. If a property test finds a counterexample, report it and do not loosen the threshold.
  - _Requirements: 16.5, 17.2_

## Notes

- All data is synthetic. This is NOT a medical device and makes no clinical claims.
- Property thresholds (L1 bound tolerance, 1e-12 pass-through, beat-count tolerance, MSE reduction) are provisional design targets. If a property test fails, report the counterexample; do not loosen the threshold.
- Beat-detection scores for `motionIntensity > 0` or `tremorIntensity > 0` are reported metrics from `npm run metrics`. They are not tests and not pass/fail.
- Each requirement is covered by at least one task and one test; the coverage table is in `design.md`.
- Module 2 has no randomness. Any future randomness must use `createRng(deriveSeed(...))` from Module 1.
- UI integration and feature extraction from `imuTremor` are future modules.
- Dependencies between top-level tasks: 2 after 1 (shared biquad code); 6 after 1, 2, 3, 4; 7 and 9 after 6; 8 after 5 and 6; 10 after 7, 8, 9.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "3.1", "4.1", "5.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "3.2", "4.2", "5.2"] },
    { "id": 2, "tasks": ["1.3", "2.3", "6.1"] },
    { "id": 3, "tasks": ["6.2", "7.1", "8.1", "9.1"] },
    { "id": 4, "tasks": ["7.2", "8.2", "8.3", "9.2"] },
    { "id": 5, "tasks": ["7.3"] },
    { "id": 6, "tasks": ["7.4"] },
    { "id": 7, "tasks": ["7.5"] },
    { "id": 8, "tasks": ["7.6"] },
    { "id": 9, "tasks": ["7.7"] },
    { "id": 10, "tasks": ["7.8"] },
    { "id": 11, "tasks": ["7.9"] },
    { "id": 12, "tasks": ["7.10"] }
  ]
}
```
