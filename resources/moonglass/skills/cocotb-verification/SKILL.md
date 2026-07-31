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

## Required workflow

1. Inspect RTL ports and the design/interface documents.
2. Generate or update the environment with
   `scripts/gen_cocotb_env.py`; reusable examples and VIP are in `assets/`.
3. Implement clock/reset handling, transaction objects, drivers, monitors,
   reference model/scoreboard, deterministic tests, corner cases, assertions,
   and planned coverage.
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
