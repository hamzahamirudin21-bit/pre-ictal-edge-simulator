# Requirements Document

> EDUCATIONAL SIMULATION ONLY. All data is synthetic. This is NOT a medical device and makes no clinical claims.

## Introduction

Module 2 of a browser-based educational simulator of an edge-ML wearable pipeline (PPG + IMU sensor fusion). It consumes the output object of Module 1, `generateSignals(params)` (see `src/generator/index.js`), and conditions the signals with digital signal processing (DSP) stages that a small wearable could run:

- a causal PPG bandpass (0.5-4 Hz) built from two biquad sections;
- a causal IMU high-pass path (2 Hz) that isolates tremor-band content for later feature extraction;
- a separate IMU noise-reference path (gravity/DC removal only) that feeds a toggleable normalized-LMS (NLMS) adaptive noise canceller (ANC) which removes the motion artifact from the PPG;
- peak detection on the filtered PPG, which yields a peak time series and an RR-interval series;
- a pure evaluation helper and a reporting script that compare detected beats with the ground-truth `beatTimes` of Module 1.

Module 2 carries over the Module 1 decisions: pure functions, `Float64Array` for every signal, index, and time array, no mutation of inputs, deterministic output, sampling rate `fs` an integer in 25..256 Hz, `TypeError` / `RangeError` validation with field-named messages, and the disclaimer policy in `.kiro/steering/disclaimer-and-safety.md`. Module 2 has no randomness. If randomness is ever added, it must use Module 1's `createRng(deriveSeed(seed, label))`.

Out of scope: any user interface (UI integration is a future module), and feature extraction from `imuTremor` (for example band power), which is also a future module. Module 2 only produces the conditioned signals.

All numeric constants in this document are illustrative simulation values and provisional design targets, not clinical values.

## Glossary

- **Signal_Processor**: The public function `processSignals(signals, options?)` in `src/dsp/index.js`, which assembles all Module 2 stages.
- **Module_1_Output**: The object returned by `generateSignals(params)`: `{ synthetic, seed, fs, durationSec, n, ppg, ppgClean, artifact, accel: {x, y, z}, beatTimes, meta }`.
- **Biquad_Designer**: The code in `src/dsp/butterworth.js` that computes second-order Butterworth coefficients.
- **Biquad_Filter**: The code in `src/dsp/biquad.js` that runs one second-order section in transposed Direct Form II.
- **PPG_Bandpass**: The cascade in `src/dsp/bandpass.js` of a 2nd-order Butterworth high-pass at 0.5 Hz followed by a 2nd-order Butterworth low-pass at 4 Hz.
- **Tremor_Conditioner**: The code in `src/dsp/imuConditioning.js` that applies a 2 Hz 2nd-order Butterworth high-pass per accelerometer axis.
- **DC_Tracker**: The code in `src/dsp/dcTracker.js`, a causal one-pole tracker of the slowly varying (gravity/DC) part of the accelerometer z axis.
- **Reference_Signal**: The ANC noise reference `r = accel.z - dc`, exposed as `ancReference`.
- **ANC**: The adaptive noise canceller in `src/dsp/anc.js` using the normalized least-mean-squares (NLMS) algorithm.
- **Primary_Signal**: The raw `ppg` of Module_1_Output (before the bandpass), used as the ANC desired signal `d`.
- **Gate**: The ANC activity gate that freezes adaptation and passes the primary sample through while the Reference_Signal is nearly silent.
- **No_Motion_Condition**: `motionIntensity = 0` and `tremorIntensity = 0` in the Module 1 parameters (tremor bursts also create artifact in Module 1).
- **Peak_Detector**: The code in `src/dsp/peaks.js` that finds pulse peaks and RR intervals.
- **Beat_Evaluator**: The pure helper in `src/dsp/evaluate.js` that compares detected peaks with the ground-truth `beatTimes`.
- **Metrics_Script**: The script `scripts/beat-metrics.js` (npm script `metrics`) that prints reported beat-detection metrics.
- **DSP_Documentation**: The file `src/dsp/README.md`.
- **Test_Suite**: The Vitest and fast-check tests of Module 2 (`test/dsp.*.test.js`, `test/dsp.property.test.js`).
- **Evaluation_Window**: The time interval `[2 s, durationSec - 1 s]` used by the Beat_Evaluator (2 s start warm-up, 1 s end margin).
- **L1_Norm**: For a filter with impulse response `h`, the sum of `|h[n]|`, computed numerically until the tail is below 1e-12.

## Requirements

### Requirement 1: Input validation

**User Story:** As a learner, I want clear errors for bad inputs, so that I can fix a wrong call quickly.

#### Acceptance Criteria

1. IF the `signals` argument is not a non-null object, THEN THE Signal_Processor SHALL throw a `TypeError` whose message names the field `signals`.
2. IF `signals.fs` is not a number, THEN THE Signal_Processor SHALL throw a `TypeError` naming `fs`; IF `signals.fs` is not an integer in 25..256, THEN THE Signal_Processor SHALL throw a `RangeError` naming `fs` and the range 25..256.
3. IF any of `ppg`, `ppgClean`, `artifact`, `accel.x`, `accel.y`, or `accel.z` is not a `Float64Array`, THEN THE Signal_Processor SHALL throw a `TypeError` naming that field.
4. IF the length of any of those arrays differs from `signals.n`, THEN THE Signal_Processor SHALL throw a `RangeError` naming that field and both lengths.
5. IF `signals.n` is not a positive integer, or `signals.durationSec` is not a positive finite number, or `signals.n` differs from `round(durationSec * fs)`, THEN THE Signal_Processor SHALL throw a `RangeError` naming the offending field.
6. IF any sample of those arrays is not a finite number, THEN THE Signal_Processor SHALL throw a `RangeError` naming the field and the sample index.
7. IF `options` is not an object, or `options.anc` or `options.peakInterpolation` is not a boolean, THEN THE Signal_Processor SHALL throw a `TypeError` naming the option; IF `options` contains an unknown key, THEN THE Signal_Processor SHALL throw a `RangeError` naming the key.
8. WHEN `options` or one of its keys is omitted, THE Signal_Processor SHALL use `anc: true` and `peakInterpolation: true`.

### Requirement 2: Output contract

**User Story:** As a downstream module author, I want a stable output object, so that I can build on Module 2 without guessing names.

#### Acceptance Criteria

1. WHEN `processSignals` receives valid input, THE Signal_Processor SHALL return an object with the fields `synthetic`, `fs`, `n`, `ppgBandpassed`, `ppgAnc`, `ppgFiltered`, `ppgCleanBandpassed`, `ancReference`, `imuTremor: {x, y, z}`, `peaks: {indices, times}`, `rrSec`, and `meta`.
2. THE Signal_Processor SHALL return every signal, index, and time array as a `Float64Array`, with `ppgBandpassed`, `ppgAnc`, `ppgFiltered`, `ppgCleanBandpassed`, `ancReference`, and each `imuTremor` axis having length `n`.
3. THE Signal_Processor SHALL set `synthetic` to `true` and copy `fs` and `n` from the input.
4. THE Signal_Processor SHALL report in `meta` the fields `anc: { enabled, mu, taps, lookaheadSamples, gatedFraction, weightClampActive }` and `bandpass: { sections, groupDelaySecAt1Hz }`.
5. THE Signal_Processor SHALL return newly allocated arrays, so that no output array shares memory with an input array.

### Requirement 3: Purity and determinism

**User Story:** As a learner, I want identical runs to give identical results, so that I can compare experiments.

#### Acceptance Criteria

1. WHEN `processSignals` is called twice with deeply equal input and options, THE Signal_Processor SHALL return deeply equal output.
2. THE Signal_Processor SHALL leave the `signals` object, every array it contains, and the `options` object unmodified.
3. THE Signal_Processor SHALL use no `Math.random`, no `Date.now`, and no module-level mutable state in any Module 2 function.
4. WHERE randomness is added to Module 2 in the future, THE Signal_Processor SHALL draw it only from `createRng(deriveSeed(seed, label))` of Module 1.

### Requirement 4: Biquad design and filtering

**User Story:** As a learner, I want exactly specified filter sections, so that I can verify them against closed-form formulas.

#### Acceptance Criteria

1. THE Biquad_Designer SHALL compute 2nd-order Butterworth low-pass and high-pass sections with Q = 1/sqrt(2) by the bilinear transform with frequency prewarping, `K = tan(pi * fc / fs)`, in the RBJ-cookbook form, with coefficients normalized so that `a0 = 1`.
2. IF `fc` is not a finite number greater than 0 and less than `fs / 2`, THEN THE Biquad_Designer SHALL throw a `RangeError` naming `fc` and `fs`.
3. THE Biquad_Filter SHALL run each section causally, in a single forward pass, in transposed Direct Form II, in double precision.
4. THE Biquad_Designer SHALL produce high-pass sections with DC gain 0 and low-pass sections with DC gain 1 (within 1e-12), and sections whose magnitude response at `fc` equals 1/sqrt(2) (within a relative error of 1e-9).
5. THE Biquad_Filter SHALL have a pole radius below 1 for every section used by Module 2 (0.5 Hz high-pass, 4 Hz low-pass, 2 Hz high-pass) at every integer `fs` from 25 to 256.
6. WHEN steady-state initialization is requested with first input sample `x0`, THE Biquad_Filter SHALL set the section state so that a constant input `x0` produces the constant output `DC_gain * x0` (within a relative error of 1e-12) from the first sample on.

### Requirement 5: PPG bandpass

**User Story:** As a learner, I want a documented 0.5-4 Hz PPG bandpass with known limits, so that I can reason about its delay and bounds.

#### Acceptance Criteria

1. THE PPG_Bandpass SHALL be the cascade of a 2nd-order Butterworth high-pass at 0.5 Hz followed by a 2nd-order Butterworth low-pass at 4 Hz, each with Q = 1/sqrt(2), giving 4 poles and 4 zeros overall.
2. THE PPG_Bandpass SHALL filter causally, report the group delay at 1 Hz as `meta.bandpass.groupDelaySecAt1Hz`, and leave the delay in the output uncompensated.
3. THE PPG_Bandpass SHALL initialize each section to the steady state for a constant input equal to the first sample of the signal, so that no large start-up step occurs.
4. THE PPG_Bandpass SHALL produce output with `|y[n]| <= L1_Norm * max|x|` for every finite input `x` (within a relative tolerance of 1e-9).
5. WHEN `processSignals` runs, THE Signal_Processor SHALL apply the PPG_Bandpass to the raw `ppg` (giving `ppgBandpassed`), to `ppgClean` (giving `ppgCleanBandpassed`, for evaluation only), and to `ppgAnc` (giving `ppgFiltered`).
6. THE Signal_Processor SHALL report the numeric coefficients of both sections as `meta.bandpass.sections`.

### Requirement 6: DC tracker and ANC noise reference

**User Story:** As a learner, I want the ANC reference to keep the motion spectrum that correlates with the artifact, so that the canceller has something to cancel with.

#### Acceptance Criteria

1. THE DC_Tracker SHALL compute `dc[n] = dc[n-1] + beta * (z[n] - dc[n-1])` with `beta = 1 - exp(-2 * pi * 0.05 / fs)` and `dc[0] = z[0]`.
2. THE Signal_Processor SHALL compute the Reference_Signal as `r = accel.z - dc` on the device z axis and expose it as `ancReference`.
3. WHEN the z-axis input is constant, THE Signal_Processor SHALL produce a Reference_Signal whose samples all have an absolute value of at most 1e-12.
4. WHEN the z-axis input is a constant offset step, THE DC_Tracker SHALL converge so that the remaining offset in `r` is below 1e-3 of the step size 30 s after the step.
5. THE Signal_Processor SHALL derive the Reference_Signal without applying the 2 Hz high-pass of the Tremor_Conditioner.

### Requirement 7: IMU tremor-feature path

**User Story:** As a learner, I want the tremor-band content of the accelerometer isolated, so that a later module can extract features from it.

#### Acceptance Criteria

1. THE Tremor_Conditioner SHALL apply a causal 2nd-order Butterworth high-pass at 2 Hz (Q = 1/sqrt(2)), with steady-state initialization, independently to `accel.x`, `accel.y`, and `accel.z`, and return the results as `imuTremor.x`, `imuTremor.y`, and `imuTremor.z`.
2. THE Tremor_Conditioner SHALL have a steady-state gain of at most 0.07 at 0.5 Hz and at least 0.95 at 4 Hz.
3. THE Tremor_Conditioner SHALL produce output with `|y[n]| <= L1_Norm * max|x|` for every finite input `x` (within a relative tolerance of 1e-9).
4. THE Signal_Processor SHALL feed the Tremor_Conditioner from the raw accelerometer axes and keep the `imuTremor` path independent of the ANC.
5. THE Signal_Processor SHALL stop at the conditioned signals and leave feature extraction from `imuTremor` to a future module.

### Requirement 8: NLMS adaptive noise cancellation

**User Story:** As a learner, I want an NLMS canceller with documented parameters, so that I can see how a motion artifact is removed from PPG.

#### Acceptance Criteria

1. THE ANC SHALL compute `y = w . x_vec` and `e = d - y` with the Primary_Signal as `d` and the Reference_Signal as input, and SHALL update the weights by `w <- w + mu * e * x_vec / (eps + x_vec . x_vec)`.
2. THE ANC SHALL use `D = round(0.1 * fs)` (halves rounded up), `L = 2D + 1` taps, and a centred tap window over reference samples `n-D .. n+D`, treating reference samples outside the index range `0 .. N-1` (N = `n`) as zero.
3. THE ANC SHALL use step size `mu = 0.1`, regularization `eps = L * 0.01^2`, and initial weights equal to 0.
4. THE ANC SHALL keep the output aligned with the input index (`e[n]` belongs to `d[n]`) and report the fixed latency of the centred window as `meta.anc.lookaheadSamples = D` and `meta.anc.taps = L`.
5. WHEN the Primary_Signal `d` is generated noise-free from a white-noise reference of standard deviation at least 0.1 by a fixed FIR system `h` that lies inside the tap window and has `||h||_2 <= W_MAX / 2`, and `d` uses the same zero-padding as the ANC window (reference samples outside `0 .. N-1` are zero), THE ANC SHALL make the mean residual power below 1e-3 of the mean Primary_Signal power, both measured over the same samples, from sample `2 * fs + 100 * L` to the end (the Gate window is first full at sample `2 * fs`; `100 * L` equals `10 * L / mu`), with at least `10 * L` samples in that range.
6. WHEN the ANC is enabled, THE Signal_Processor SHALL compute `ppgFiltered` as the PPG_Bandpass of `ppgAnc`, where `ppgAnc` is the ANC output `e`.

### Requirement 9: ANC activity gate

**User Story:** As a learner, I want the canceller to stay out of the way when there is no motion, so that clean PPG passes through unchanged while the motion reference is nearly silent.

#### Acceptance Criteria

1. THE Gate SHALL compute, for sample `n`, the population standard deviation of the Reference_Signal over the window `r[n - 2*fs .. n - 1]`, the `2 * fs` samples before `n` (the current sample is excluded), and SHALL stay closed for `n < 2 * fs`, so that the window is first full exactly at `n = 2 * fs`.
2. WHILE the Gate is closed (window standard deviation below 0.01 g, or window not yet full), THE ANC SHALL freeze the weights and output `e[n] = d[n]` exactly.
3. WHILE the No_Motion_Condition holds, THE Signal_Processor SHALL report `meta.anc.gatedFraction >= 0.99` for each configuration tested (Property 6 tests at least 40 configurations). This is a statistical target, not a bound for every input: 0.99 was chosen below the minimum `gatedFraction` (1) measured over 1200 configurations, and design.md, Decision C, gives the measurement. WHEN the Gate is closed for every sample (`gatedFraction = 1`), THE Signal_Processor SHALL return `ppgFiltered` equal to `ppgBandpassed` within an absolute difference of 1e-12.
4. THE Signal_Processor SHALL report `meta.anc.gatedFraction` as the fraction of samples (in 0..1) for which the Gate was closed. IF the ANC receives a zero-length input, THEN THE ANC SHALL return `gatedFraction = null`, the same convention as Requirement 14.6.

### Requirement 10: Weight clamp safety net

**User Story:** As a learner, I want a documented safety net on the ANC weights, so that the output stays bounded.

#### Acceptance Criteria

1. IF the Euclidean norm of the ANC weight vector exceeds `W_MAX = 10` after an update, THEN THE ANC SHALL rescale the weight vector to norm `W_MAX`.
2. THE Signal_Processor SHALL set `meta.anc.weightClampActive` to `true` if and only if a rescaling occurred at least once.
3. THE ANC SHALL produce output with `|e[n]| <= max|d| + W_MAX * sqrt(L) * max|r|` for every finite input.

### Requirement 11: ANC toggle

**User Story:** As a learner, I want to switch the canceller off, so that I can compare the pipeline with and without it.

#### Acceptance Criteria

1. THE Signal_Processor SHALL enable the ANC by default (`options.anc = true`).
2. WHEN `options.anc` is `false`, THE Signal_Processor SHALL return `ppgAnc` as a copy of `ppg` and `ppgFiltered` equal to `ppgBandpassed` exactly.
3. WHEN `options.anc` is `false`, THE Signal_Processor SHALL report `meta.anc.enabled = false`, `meta.anc.gatedFraction = null`, and `meta.anc.weightClampActive = false`, while still reporting `mu`, `taps`, `lookaheadSamples`, and the `ancReference`.

### Requirement 12: Peak detection

**User Story:** As a learner, I want pulse peaks detected on the filtered PPG, so that I can derive beat timing.

#### Acceptance Criteria

1. THE Peak_Detector SHALL consider as candidates the sample indices `n` in `1 .. N-2` with `y[n-1] < y[n]` and `y[n] >= y[n+1]`, where `y` is `ppgFiltered`.
2. THE Peak_Detector SHALL accept a candidate only if `y[n] > 0` and `y[n] >= 0.5 * M[n]`, where `M[n]` is the maximum of `y` over the previous `min(n, 3 * fs)` samples.
3. THE Peak_Detector SHALL reject a candidate whose time is less than `max(0.3 s, 0.6 * median of the last up to 5 accepted RR intervals)` after the last accepted peak time (0.3 s alone while no RR interval exists).
4. WHERE `options.peakInterpolation` is `true`, THE Peak_Detector SHALL refine each peak time by parabolic interpolation through the three samples around the peak; WHERE it is `false`, THE Peak_Detector SHALL use `index / fs`.
5. THE Peak_Detector SHALL return `peaks.indices` (integer sample indices) and `peaks.times` (seconds) as `Float64Array`, with `times` strictly increasing and every time within `[0, durationSec]`.
6. WHEN the filtered signal contains no accepted peak, THE Peak_Detector SHALL return empty arrays without throwing.

### Requirement 13: RR intervals

**User Story:** As a learner, I want RR intervals derived from the detected peaks, so that I can see heart-rhythm timing.

#### Acceptance Criteria

1. THE Signal_Processor SHALL return `rrSec` as the successive differences of `peaks.times`, with length `max(0, peakCount - 1)`.
2. THE Signal_Processor SHALL return every `rrSec` value as at least 0.3 s minus a floating-point tolerance of 1e-9, matching the 300 ms RR minimum of Module 1.
3. WHEN fewer than two peaks are accepted, THE Signal_Processor SHALL return an empty `rrSec`.

### Requirement 14: Evaluation helper

**User Story:** As a learner, I want a pure helper that scores detected beats against the known beats, so that I can measure the pipeline on synthetic data.

#### Acceptance Criteria

1. IF `signals.beatTimes` is not a `Float64Array`, THEN THE Beat_Evaluator SHALL throw a `TypeError` naming `beatTimes`; IF it is not strictly increasing and finite, THEN THE Beat_Evaluator SHALL throw a `RangeError` naming `beatTimes`.
2. THE Beat_Evaluator SHALL estimate the lag as the median over true beats of (nearest detected peak time minus beat onset), restricted to offsets in [0, 0.6 s], and use lag 0 with `lagEstimated = false` when no such offset exists.
3. THE Beat_Evaluator SHALL count a true beat only if `onset + lag` lies in the Evaluation_Window, and SHALL count a detected peak only if its time lies in the Evaluation_Window.
4. THE Beat_Evaluator SHALL match each counted true beat to at most one detected peak within `0.25 * median true RR` of `onset + lag`, using each detected peak at most once and preferring the nearest.
5. THE Beat_Evaluator SHALL return `tp`, `fp`, `fn`, `sensitivity`, `ppv`, `trueCount`, `detectedCount`, `beatCountError` (detected minus true), `rrMaeMs` (mean absolute RR error in ms over consecutive true-beat pairs that are both matched), `lag`, and `lagEstimated`.
6. IF a ratio or mean has an empty denominator, THEN THE Beat_Evaluator SHALL return `null` for that value.
7. THE Beat_Evaluator SHALL provide a pure helper `windowedMse(a, b, fs, startSec, endSec)` that returns the mean squared difference of two equal-length arrays over the sample range `[startSec * fs, endSec * fs)`.

### Requirement 15: Reported beat metrics

**User Story:** As a learner, I want printed metrics over a fixed grid, so that I can see how motion and the ANC affect beat detection without pass/fail thresholds.

#### Acceptance Criteria

1. WHEN the Metrics_Script runs, THE Metrics_Script SHALL generate Module 1 signals over a fixed grid of seeds and motion levels, run `processSignals` with and without the ANC, and print sensitivity, PPV, beat-count error, RR mean absolute error, and the ANC MSE reduction ratio (`windowedMse` against `ppgCleanBandpassed` after the 5 s warm-up, window end `durationSec - 1 s`).
2. THE Metrics_Script SHALL report the metrics without asserting any threshold and SHALL exit with status 0 unless a runtime error occurs.
3. THE Metrics_Script SHALL print identical text on repeated runs.
4. THE Metrics_Script SHALL be runnable through the npm script `metrics`.
5. THE Metrics_Script SHALL print `DISCLAIMER_TEXT` and the label "Synthetic data" at the top of its output.
6. THE Metrics_Script SHALL export a pure function that computes the metrics for a given grid, so that a test can run a reduced grid.

### Requirement 16: Testing

**User Story:** As a maintainer, I want unit and property tests with honest thresholds, so that regressions show up and failures are reported rather than hidden.

#### Acceptance Criteria

1. THE Test_Suite SHALL include unit tests for: biquad coefficients against closed-form values for several `fs`; DC gain and -3 dB gain; pole radius for every integer `fs` from 25 to 256; steady-state initialization; DC tracker convergence; `imuTremor` attenuation at 0.5 Hz and pass at 4 Hz; NLMS convergence on a known FIR system; gate pass-through exactness; the weight clamp; peak detection on simple pulse trains (including 40 bpm, 180 bpm, and a diastolic bump); evaluation matching on hand-made cases; and validation errors.
2. THE Test_Suite SHALL implement each correctness property of the design as one fast-check property test of at least 40 runs (Module 1's FULL_RUNS) for properties that run the Module 1 generator over the full parameter ranges, and at least 100 runs for properties on small synthetic arrays (Property 1), with an explicit timeout, tagged with the property number.
3. THE Test_Suite SHALL draw property-test parameters from the Module 1 parameter table (including the full `fs` range 25..256), biased toward boundary values.
4. THE Test_Suite SHALL assert no beat-detection score when `motionIntensity > 0` or `tremorIntensity > 0`; those scores belong to the Metrics_Script.
5. IF a property test finds a counterexample, THEN the maintainer SHALL report the counterexample and SHALL NOT loosen the threshold, because all thresholds are provisional design targets.
6. THE Test_Suite SHALL assert the ANC error reduction as a strict inequality of MSE values, not as a ratio.

### Requirement 17: Disclaimer and scope

**User Story:** As a maintainer, I want the disclaimer policy applied to Module 2, so that no text implies clinical meaning.

#### Acceptance Criteria

1. THE DSP_Documentation SHALL open with `DISCLAIMER_TEXT` from `src/disclaimer.js`, verbatim.
2. THE Module 2 spec files, the DSP_Documentation, and the Metrics_Script output SHALL begin with the standard disclaimer.
3. THE DSP_Documentation and the Metrics_Script output SHALL use the words "simulated", "synthetic", and "illustrative", and SHALL contain no wording that implies clinical validity.
4. THE DSP_Documentation SHALL document the exact 4th-order definition, the two IMU paths with their reasoning, the ANC parameters, the peak detection rules, and the Metrics_Script.
5. THE Module 2 SHALL add no UI and SHALL note UI integration as a future module.
6. WHEN the Test_Suite runs, THE Test_Suite SHALL check that `src/dsp/README.md` contains `DISCLAIMER_TEXT`, by extending `test/disclaimer.test.js`.
