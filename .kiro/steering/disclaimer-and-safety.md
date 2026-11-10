---
inclusion: always
---

# Disclaimer and Safety Policy

## Core statements (non-negotiable)
- All data in this project is **synthetic**. No real patient or sensor data is used or collected.
- This project is **NOT a medical device**.
- It makes **no clinical claims**. It does not detect, predict, diagnose, monitor, or prevent seizures or any condition.
- "Pre-ictal-like" refers to a tunable simulation parameter for teaching, never a clinical finding.

## Required disclaimer text
Use this wording (or a stricter variant) everywhere:

> EDUCATIONAL SIMULATION ONLY. All data is synthetic. This is NOT a medical device and makes no clinical claims. Do not use it for any medical decision.

## Rules
1. `README.md` must show the disclaimer prominently at the top.
2. Every user-facing screen/page/view must display a clear, visible disclaimer (not hidden in a tooltip or collapsed by default). Provide one shared disclaimer component/constant and reuse it.
3. Never use language implying clinical validity: avoid "detects seizures", "predicts", "diagnosis", "accuracy for patients", "clinically validated". Use "simulated", "synthetic", "illustrative".
4. Label generated signals and charts as synthetic.
5. Spec requirements, tasks, and UI copy for new modules must include a disclaimer-visibility check.
6. Parameter names and docs describing the pre-ictal-like knob must state it is a simulation knob.
