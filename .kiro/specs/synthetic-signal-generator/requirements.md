# Requirements: Module 1 - Synthetic Signal Generator

> EDUCATIONAL SIMULATION ONLY. All data is synthetic. This is NOT a medical device and makes no clinical claims. See `.kiro/steering/disclaimer-and-safety.md`.

## Introduction
Module 1 of a browser-based educational simulator of an edge-ML wearable pipeline (PPG + IMU sensor fusion). It produces synthetic PPG and 3-axis accelerometer signals, including a tunable "pre-ictal-like" HRV pattern (a simulation knob, not a clinical claim) and a motion artifact in the PPG correlated with acceleration. Later modules consume its output.

## Technical constraints
- Vanilla JavaScript (ES modules), no framework.
- Vite (dev/build), Vitest (tests), fast-check (property-based tests).
- All generator code is pure and deterministic given a seed. No `Math.random`, `Date.now`, or global state inside generator functions.
- All signal arrays are `Float64Array`.

## Parameter table (single source of truth)

| Parameter | Type / unit | Range | Default |
|---|---|---|---|
| `seed` | integer | 0 to 4294967295 | 1 |
| `durationSec` | number, s | 5 to 600 | 30 |
| `fs` | integer, Hz | 25 to 256 | 64 |
| `heartRateBpm` | number | 40 to 180 | 70 |
| `hrvSdnnMs` | number, ms | 0 to 150 | 50 |
| `preIctalLikeness` | number | 0 to 1 | 0 |
| `motionIntensity` | number | 0 to 1 | 0.2 |
| `tremorIntensity` | number | 0 to 1 | 0 |
| `orientation.pitchDeg`, `orientation.rollDeg` | number, degrees | -180 to 180 | 0, 0 |
| `artifactGain` | number | 0 to 1 | 0.5 |

The minimum `fs` of 25 Hz keeps the 3-6 Hz tremor band safely below Nyquist. The minimum duration of 5 s guarantees at least one full tremor burst and a non-empty output.

## Requirements

### R1: Seeded deterministic randomness
**User story:** As a learner, I want reproducible signals so that I can compare runs.
1. WHEN a seed is given THEN the PRNG SHALL produce a repeatable sequence in [0, 1).
2. WHEN the same seed and parameters are given THEN the generator SHALL return deeply equal output.
3. WHEN different seeds are given THEN outputs SHALL differ.
4. The generator SHALL NOT mutate its inputs or use shared mutable state; PRNG state SHALL be local to each call.
5. Independent random sub-streams for each component (RR/HRV, PPG details, IMU motion, tremor, noise) SHALL be derived from the seed through a single `deriveSeed(seed, label)` function, so changing one parameter does not change the random draws of another component.
6. `seed` SHALL be validated: a non-number SHALL throw `TypeError`; a non-integer or a value outside the table range SHALL throw `RangeError`.

### R2: Output format
1. Every signal array (`ppg`, `ppgClean`, `artifact`, `accel.x`, `accel.y`, `accel.z`, and `beatTimes`) SHALL be a `Float64Array`. Sampling rate `fs` is fixed per output and defaults to 64 Hz.
2. Sample count of `ppg`, `ppgClean`, `artifact`, and each accel axis SHALL equal `n = round(durationSec * fs)`. `beatTimes` has a variable length.
3. The output object SHALL contain: `synthetic: true`, `seed`, `fs`, `durationSec`, `n`, `ppg` (with artifact), `ppgClean` (before artifact), `artifact`, `accel: {x, y, z}`, `beatTimes` (seconds), and `meta` (see R3.5, R4.4, R5.5).
4. All samples SHALL be finite numbers (no NaN/Infinity).
5. Parameters outside the table ranges SHALL throw `RangeError`; wrong types SHALL throw `TypeError`; messages SHALL name the field and its valid range. Omitted parameters SHALL take the table defaults.

### R3: PPG with configurable HR and HRV
1. The user SHALL configure mean heart rate (`heartRateBpm`) and HRV amount (`hrvSdnnMs`) within the table ranges.
2. The generator SHALL build an RR-interval series with the effective mean and approximately the effective SDNN (R3.4), having low-frequency and high-frequency components, then render a pulse waveform per beat.
3. `beatTimes` SHALL be strictly increasing.
4. **Feasibility clamp.** Effective values SHALL be computed as:
   - `effHr = min(hr * (1 + 0.1 * preIctalLikeness), 180)`.
   - `meanRrMs = 60000 / effHr`.
   - `sdnnCap = min(150, (meanRrMs - 300) / 2.5, (2000 - meanRrMs) / 2.5)`.
   - `effSdnn = min(hrvSdnnMs * (1 - 0.5 * preIctalLikeness), sdnnCap)`.
   The cap guarantees that RR intervals stay within [300, 2000] ms, so the RR clamp is only a safety net that SHALL NOT alter the series for valid inputs.
5. `meta` SHALL report `effectiveHrBpm`, `effectiveSdnnMs`, `lfhf`, and `clamped: {hr: boolean, sdnn: boolean}`. WHEN a clamp applies THEN the corresponding flag SHALL be true.
6. The clamp rule SHALL be documented in the module docs and the parameter descriptions.
7. Measured SDNN, defined as the population standard deviation (divide by N) of the generated RR series `rrMs`, SHALL be within 15% of `effectiveSdnnMs` (or within 3 ms when it is below 20 ms) for durations of at least 30 s.

### R4: Pre-ictal-like HRV knob
1. `preIctalLikeness` in [0, 1] SHALL shift the HRV profile toward a pre-ictal-like pattern: reduced overall HRV (`x(1 - 0.5k)`), a higher LF/HF ratio (`1 + 3k`), and a small increase in mean heart rate (`x(1 + 0.1k)`, before the R3.4 clamp).
2. At 0 the output SHALL equal that of the unshifted configuration. With respect to `preIctalLikeness`, `meta.effectiveSdnnMs` (the value after the R3.4 cap) SHALL be non-increasing, and `meta.effectiveHrBpm` and `meta.lfhf` SHALL be non-decreasing.
3. Docs, parameter descriptions, and UI labels SHALL state that this is a simulation knob and not a clinical claim.
4. Constants SHALL be named and documented as illustrative simulation values.

### R5: IMU (3-axis accelerometer)
1. Output SHALL be in units of g with a static gravity component of magnitude 1 g, default on the z axis, rotated by `orientation` (pitch, roll in degrees).
2. `motionIntensity` scales low-frequency voluntary-motion-like movement (0.3-2 Hz) with peak amplitude `0.5 * motionIntensity` g per axis, plus sensor noise.
3. `tremorIntensity` adds tremor bursts with per-burst frequency in [3, 6] Hz and randomized onset and duration. At 0 no tremor is added. Bursts SHALL NOT overlap, and at least one full burst SHALL lie inside the recording.
4. **Tremor energy.** Define tremor band energy as the summed spectral energy over 3-6 Hz of the detrended signal across the three axes. For a fixed seed and other parameters:
   - the tremor-attributable energy, measured on `accel(t) - accel(0)` (the same output with `tremorIntensity` set to 0 subtracted), SHALL be strictly increasing in `tremorIntensity` and scale as its square (within 1e-6 relative error);
   - the full-signal band energy with tremor at 1 SHALL exceed the band energy with tremor at 0.
5. `meta` SHALL report `tremorBursts` (list of onset, duration, frequency).
6. The dynamic (non-gravity) part of each axis SHALL be bounded by 0.75 g by construction; clamping is a safety net only.

### R6: Motion artifact in PPG
1. The artifact SHALL be defined as `artifact = artifactGain * 2.0 * lowpass(dynZ)`, where `dynZ` is the mean-removed accel z-axis (a **fixed axis**, device z), and `lowpass` is a zero-phase single-pole low-pass at 8 Hz with non-negative kernel and unit DC gain. The artifact is a signed projection, not a magnitude.
2. `ppg = clamp(ppgClean + artifact, -3, 3)`. With `artifactGain = 0`, `artifact` SHALL be all zeros and `ppg` SHALL equal `ppgClean` exactly.
3. **Correlation thresholds.** When `artifactGain >= 0.01` and the RMS of `dynZ` is at least 0.01 g:
   - Pearson correlation between `artifact` and `lowpass(dynZ)` SHALL be at least 0.999;
   - Pearson correlation between `artifact` and raw `accel.z` SHALL be at least 0.9 when `motionIntensity >= 0.3`.
4. `ppgClean`, `artifact`, and `ppg` SHALL all be exposed.

### R7: Bounded amplitudes
1. `ppgClean` SHALL lie in [-1.5, 1.5] (normalized units); `ppg` within [-3, 3]; `artifact` within [-1.5, 1.5].
2. Accelerometer axes SHALL lie within [-4, 4] g for all valid parameters (gravity at most 1 g plus a dynamic part of at most 0.75 g).

### R8: Disclaimer
1. The module docs (`src/generator/README.md` and JSDoc on the public API) and the demo page SHALL show the standard disclaimer from the steering doc.
2. A shared exported disclaimer constant SHALL exist and be rendered on the Vite demo page visibly without interaction; the static HTML SHALL also contain it.
3. Output SHALL include `synthetic: true`.
4. The demo page SHALL label the pre-ictal-like control as a simulation knob and plots as "Synthetic data".

### R9: Testing
1. Unit tests SHALL cover the PRNG, `deriveSeed`, parameter validation (including seed), each signal component, the feasibility clamp, and defaults.
2. Property-based tests (fast-check) SHALL cover: same seed gives same output; sample count equals duration x rate; amplitudes bounded; tremor energy rises with the tremor parameter (R5.4).
3. Additional properties: finite samples; artifact zero when gain is 0; strictly increasing beat times; pre-ictal knob monotonicity (SDNN, HR, LF/HF); artifact correlation thresholds (R6.3); arrays are `Float64Array`.
4. Generators for property tests SHALL draw parameters from the table ranges in this document, with one explicit exception: because `bandEnergy` costs O(N x bins), the P4 tremor-energy property (R5.4), which calls `tremorBandEnergy`, SHALL draw `durationSec <= 30` and `fs <= 64` (still within the table ranges) and use `numRuns <= 30`. All other properties keep drawing from the full table ranges.
5. Property tests SHALL set an explicit timeout through the test options (for example 30000 ms).
