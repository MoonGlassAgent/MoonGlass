---
name: cocotb-verification
description: Build and validate reusable Cocotb verification environments for RTL modules. Use when implementing drivers, monitors, scoreboards, tests, sequences, coverage, regressions, logs, or waveforms from an approved verification plan.
---

# Cocotb Verification

Read `docs/04_verification/` before implementing tests. One DUT uses:

```text
verification/<topModule>_tb/
  agents/
  env/
  coverage/
  tests/
  sequences/
  sim/
verification/results/<topModule>/
```

TOP-first policy: the DUT is by default the whole design. Build exactly one
TOP cocotb environment and write every testcase against the TOP, anchored to
TOP interfaces and spec clauses. Read
`verification/intelligence/module-verification-strategy.json` before creating
an environment:

- `TOP_SIGNOFF`: the top module(s) — the single TOP environment and complete
  end-to-end evidence live here.
- `COVERED_BY_TOP`: every other module by default — verified indirectly via
  TOP scenarios and full-design coverage; no per-module environment is built.
- `UT_EXCEPTION`: a module registered via `register_ut_escalation` after the
  diagnostic ledger reached L3/L4 and probing submodule signals still could
  not localize the failure — only then does this module get its own
  standalone testbench. Never build a module testbench without a registered
  escalation; an exception UT's PASS does not replace TOP regression evidence.

Verification depth and Oracle selection are independent. Implement a Golden Model when the module plan recommends `REFERENCE_MODEL`, or when an independent executable model materially improves judgment, localization, or convergence. Do not prohibit it merely because the module is small, and do not duplicate RTL just to satisfy a template.

## Config-sequence-first test pattern

Business and corner scenarios of these IPs are essentially register
combinations: **drive a config sequence over the bus VIP, then send business
traffic**. Register reads/writes go through the bus VIP (APB/AXI-Lite); the
test programs the config fields, lets the design settle, then issues traffic
and checks externally visible behavior. When
`verification/intelligence/config-space.json` exists, the generated
environment instruments **config coverage** automatically: the scoreboard
records every programmed field value into buckets (enum: one bucket per
value; range: 0/min/typ/max; flag: two buckets) and every constrained field
pair into crosses, then writes
`verification/results/<topModule>/config-coverage.json` at the end of
simulation, merging hits across regressions (old file is loaded at startup
and written back at the end). Without a config-space ledger the environment
simply skips this instrumentation — never invent registers.

## Required workflow

1. Inspect RTL ports and the design/interface documents.
2. Generate or update the environment with
   `scripts/gen_cocotb_env.py`; reusable examples and VIP are in `assets/`.
3. Implement only the clock/reset handling, transaction objects, drivers, monitors,
   selected Oracle strategies, deterministic tests, corner cases, assertions,
   and coverage required by the module's verification level.
4. Keep build products inside `verification/<topModule>_tb/`; write durable run
   artifacts only under `verification/results/<topModule>/`.
5. Every run must retain compile and simulation logs, a machine-readable result,
   and a VCD/FST waveform when simulation starts. When a config-space ledger
   exists, the run also writes `verification/results/<topModule>/config-coverage.json`
   (merged across regressions) — see "Config-sequence-first test pattern".
6. Validate the environment:

```bash
python <skill-dir>/scripts/validate_env.py verification/<module>_tb
```

Use MoonGlass tools for RTL collection, lint, synthesizability checks, simulation,
and waveform generation where available. Do not invent passing results or
coverage values.
