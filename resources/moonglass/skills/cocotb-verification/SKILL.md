---
name: cocotb-verification
description: Build and validate reusable Cocotb verification environments for RTL modules. Use when implementing drivers, monitors, scoreboards, tests, sequences, coverage, regressions, logs, or waveforms from an approved verification plan.
---

# Cocotb Verification

Read `docs/04_verification/` before implementing tests. One DUT uses:

```text
verification/<module>_tb/
  agents/
  env/
  coverage/
  tests/
  sequences/
  sim/
verification/results/<module>/
```

Read `verification/intelligence/module-verification-strategy.json` before creating an environment:

- `IP_SIGNOFF`: complete top-level AIGV environment and end-to-end evidence.
- `UNIT_FOCUSED`: standalone risk-focused environment for a critical submodule.
- `UNIT_SMOKE`: minimal reusable smoke only; do not copy the full top-level flow.
- `STATIC_ONLY`: do not create a Cocotb environment unless later evidence upgrades the level.

Verification depth and Oracle selection are independent. Implement a Golden Model when the module plan recommends `REFERENCE_MODEL`, or when an independent executable model materially improves judgment, localization, or convergence. Do not prohibit it merely because the module is small, and do not duplicate RTL just to satisfy a template.

## Required workflow

1. Inspect RTL ports and the design/interface documents.
2. Generate or update the environment with
   `scripts/gen_cocotb_env.py`; reusable examples and VIP are in `assets/`.
3. Implement only the clock/reset handling, transaction objects, drivers, monitors,
   selected Oracle strategies, deterministic tests, corner cases, assertions,
   and coverage required by the module's verification level.
4. Keep build products inside `verification/<module>_tb/`; write durable run
   artifacts only under `verification/results/<module>/`.
5. Every run must retain compile and simulation logs, a machine-readable result,
   and a VCD/FST waveform when simulation starts.
6. Validate the environment:

```bash
python <skill-dir>/scripts/validate_env.py verification/<module>_tb
```

Use MoonGlass tools for RTL collection, lint, synthesizability checks, simulation,
and waveform generation where available. Do not invent passing results or
coverage values.
