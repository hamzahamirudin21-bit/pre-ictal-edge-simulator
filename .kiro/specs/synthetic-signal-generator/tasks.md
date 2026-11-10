# Implementation Plan: Module 1 - Synthetic Signal Generator

> EDUCATIONAL SIMULATION ONLY. All data is synthetic. This is NOT a medical device and makes no clinical claims.

## Overview

This plan builds the synthetic signal generator in small steps: seeded PRNG and parameters, then HRV and PPG, IMU, and motion artifact, followed by assembly, property-based tests, docs, and a demo page.

## Tasks

- [x] 1. Add the disclaimer to README.md and create the steering doc (`.kiro/steering/disclaimer-and-safety.md`) _(R8)_

- [x] 2. Scaffold the project
  - [x] 2.1 Create `package.json` (type: module) with pinned versions of vite, vitest, fast-check; scripts: `dev`, `build`, `test` (`vitest --run`)
  - [x] 2.2 Add `vite.config.js` with the Vitest config, `index.html` with a static visible disclaimer banner, `src/disclaimer.js`, and a minimal stub `src/main.js` that renders the disclaimer _(R8)_
  - [x] 2.3 Add a placeholder test (for example `test/disclaimer.test.js` checking that `DISCLAIMER_TEXT` mentions "synthetic" and "NOT a medical device") so the test runner does not fail with no test files
  - [x] 2.4 Verify that `npm run build` and `npm test` pass

- [x] 3. Seeded PRNG and params
  - [x] 3.1 Implement `src/generator/prng.js` (mulberry32, gaussian, `deriveSeed`) _(R1.1, R1.5)_
  - [x] 3.2 Implement `src/generator/params.js` (DEFAULTS, validateParams, including seed, `fs`, and duration ranges from the table) _(R1.6, R2.5)_
  - [x] 3.3 Unit tests: repeatability, range [0,1), different seeds differ, `deriveSeed` stability and label independence, validation errors (type and range, including seed and non-integer `fs`), defaults _(R1, R2, R9.1)_

- [ ] 4. HRV and PPG
  - [ ] 4.1 Implement `hrv.js`: `resolveHrv` (shift + feasibility clamp, `clamped` flags) and `generateRRSeries` _(R3, R4)_
  - [ ] 4.2 Implement `ppg.js` (pulse rendering, baseline wander, clip; `Float64Array` output) _(R3, R7)_
  - [ ] 4.3 Unit tests: effective HR and SDNN formulas, clamp at 180 bpm and at the SDNN cap with flags, RR within [300, 2000] ms, sample SDNN within tolerance (R3.7) for 30 s or more, strictly increasing beat times, knob identity at 0, SDNN decreases and LF/HF increases with the knob, bounded PPG _(R9.1)_

- [ ] 5. IMU
  - [ ] 5.1 Implement `imu.js` (gravity and orientation, motion, noise, non-overlapping tremor bursts 3-6 Hz, dynamic bound) _(R5)_
  - [ ] 5.2 Implement `spectrum.js` (`bandEnergy`, `tremorBandEnergy`)
  - [ ] 5.3 Unit tests: gravity magnitude near 1 g at rest, no tremor at 0, at least one burst, bursts do not overlap, burst frequencies inside 3-6 Hz, dominant spectral peak inside 3-6 Hz, tremor difference signal scales as `t^2`, bounds

- [ ] 6. Motion artifact
  - [ ] 6.1 Implement `artifact.js` (`lowpassZeroPhase`, `computeArtifact` on fixed z axis, scale 2.0) and integrate into the PPG _(R6)_
  - [ ] 6.2 Unit tests: low-pass has unit DC gain and non-negative kernel, gain 0 gives zeros and `ppg` equals `ppgClean`, correlation thresholds (0.999 and 0.9), bounds

- [ ] 7. Assemble `generateSignals` in `src/generator/index.js`
  - [ ] 7.1 Independent RNG sub-streams via `deriveSeed`, output shape, `synthetic: true`, `meta` (effective values, `clamped`, `tremorBursts`) _(R1, R2, R8)_
  - [ ] 7.2 Unit tests in `test/generator.test.js`: output shape, all arrays are `Float64Array`, default `fs` 64, defaults, non-mutation of input, changing `tremorIntensity` leaves `ppgClean` unchanged

- [ ] 8. Property-based tests (`test/generator.property.test.js`), arbitraries drawn from the requirements table _(R9)_
  - [ ] 8.1 P1 same seed gives same output
  - [ ] 8.2 P2 sample count equals duration x rate
  - [ ] 8.3 P3 amplitudes bounded, finite, `Float64Array`
  - [ ] 8.4 P4 tremor energy rises with the tremor parameter (difference signal, gap of at least 0.1, `t^2` scaling, full signal at 1 above 0)
  - [ ] 8.5 P5 artifact zero at gain 0 and `ppg` equals `ppgClean`
  - [ ] 8.6 P6 strictly increasing beat times
  - [ ] 8.7 P7 pre-ictal knob monotonic (SDNN, HR, LF/HF)
  - [ ] 8.8 P8 artifact correlation thresholds
  - [ ] 8.9 P9 feasibility (RR within [0.3, 2.0] s, effective HR at most 180) and P10 input immutability

- [ ] 9. Docs
  - [ ] 9.1 Write `src/generator/README.md` and JSDoc for `generateSignals` and the parameters: open with the standard disclaimer, document the parameter table, the feasibility clamp (R3.4, R3.6), and that the pre-ictal-like knob is a simulation knob and not a clinical claim _(R3.6, R4.3, R8.1)_

- [ ] 10. Demo page
  - [ ] 10.1 `src/main.js`: parameter controls, canvas plots of PPG and accel labeled "Synthetic data", clamp indicator, pre-ictal control labeled as a simulation knob, disclaimer visible _(R4.3, R8)_
  - [ ] 10.2 Manually check that the disclaimer is visible without interaction and that no copy implies clinical meaning

- [ ] 11. Final checkpoint: run `npm test` and `npm run build`; confirm the README, the module docs, and every screen show the disclaimer

## Notes

- Parameter ranges and defaults: see the table in `requirements.md`.
- All data is synthetic. This is NOT a medical device and makes no clinical claims.
- Dependencies between top-level tasks: 2 after 1; 3 after 2; 4 and 5 after 3; 6 after 4 and 5; 7 after 4, 5, 6; 8 and 9 after 7; 10 after 7 and 9; 11 after 8, 9, 10.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["3.1", "3.2"] },
    { "id": 1, "tasks": ["3.3", "4.1", "5.1", "5.2"] },
    { "id": 2, "tasks": ["4.2", "5.3"] },
    { "id": 3, "tasks": ["4.3", "6.1"] },
    { "id": 4, "tasks": ["6.2", "7.1"] },
    { "id": 5, "tasks": ["7.2", "8.1", "9.1"] },
    { "id": 6, "tasks": ["8.2", "10.1"] },
    { "id": 7, "tasks": ["8.3", "10.2"] },
    { "id": 8, "tasks": ["8.4"] },
    { "id": 9, "tasks": ["8.5"] },
    { "id": 10, "tasks": ["8.6"] },
    { "id": 11, "tasks": ["8.7"] },
    { "id": 12, "tasks": ["8.8"] },
    { "id": 13, "tasks": ["8.9"] }
  ]
}
```
