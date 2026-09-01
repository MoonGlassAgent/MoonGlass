---
name: verification-planning
description: Plan ASIC/RTL verification from requirements and design documents. Use before creating a testbench, when defining test cases, coverage goals, traceability, pass criteria, or reviewing verification completeness.
---

# Verification Planning

Create and maintain the verification documents under `docs/04_verification/`.

## Required workflow

1. Read `docs/02_requirements/product_requirements.md`,
   `docs/02_requirements/requirements_traceability.md`, and the relevant files in
   `docs/03_design/`.
2. Identify every externally observable requirement, corner case, error path,
   clock/reset behavior, and interface protocol rule.
3. Write the baseline plans:
   - `docs/04_verification/verification_plan.md`
   - `docs/04_verification/test_plan.md`
   - `docs/04_verification/coverage_plan.md`
   These are the authoritative plans, not a legacy document set. Keep one shared
   trace chain: `REQ/SPEC -> VI -> SCN -> TEST/COVER/PROPERTY -> EVIDENCE -> SIGNOFF`.
   `verification_plan.md` owns scope, methods, milestones, resources, and signoff;
   `test_plan.md` owns executable TEST items; `coverage_plan.md` owns COVER items
   and hole closure. Never maintain a second, conflicting test list in AIGV documents.
4. Write and continuously maintain the AIGV method and closure set:
   - `docs/04_verification/aigv_verification_strategy.md`: scope, evidence-driven loop,
     tool allocation, iteration policy, stop criteria, limitations, and responsibilities.
   - `docs/04_verification/verification_intent_matrix.md`: REQ/SPEC to VI/SCN,
     RTL object, temporal interaction, boundary, stimulus, checker, coverage bin,
     method, status, and raw evidence.
   - `docs/04_verification/risk_scenario_plan.md`: risk taxonomy, interaction graph,
     ranked scenarios, execution batches, budgets, and C1-C6 hole disposition.
   - `docs/04_verification/formal_verification_plan.md`: formal candidates,
     properties, assumptions, bound/depth, BMC/cover/prove semantics, and traces.
   - `docs/04_verification/coverage_closure_plan.md`: functional/code coverage model,
     targets, exclusions, deltas, hole ownership, and closure actions.
   - `docs/04_verification/verification_signoff_plan.md`: required logs, JUnit,
     result JSON, waveforms, coverage, Formal evidence, waivers, review, and signoff.
5. Give every requirement and test a stable ID. Maintain bidirectional
   requirement-to-test traceability.
6. Define stimulus, checker, expected result, coverage target, and pass/fail
   criteria for each test.
7. Call `build_verification_intelligence`. Review the ranked Scenario Registry,
   `module-verification-strategy.json`,
   `verification-intent-registry.json`, `spec-gap-register.json`, and
   `coverage-hole-register.json`. Bind each selected `VI-*` / `SCN-*` to
   requirements, RTL objects, temporal offsets, boundary points, tests,
   checkers, coverage bins, and evidence. Risk markers and Spec Gaps are review
   inputs, not confirmed RTL bugs. Do not generate arbitrary feature Cartesian products.
   The engine-generated Scenario pool is a candidate set, not a task list. After the
   build, read `risk-register.json` and `structural-model.json` together with the spec,
   select 5-10 real verification points (each naming concrete signals, a concrete
   failure mode, and concrete pass criteria), and register them with
   `register_verification_intents`, anchored to existing riskIds / requirementIds /
   rtlSignals. Fix and resubmit REJECTED anchors; never bypass the tool by editing
   registry JSON by hand.
   The generated `aigv_execution_snapshot.md` is the synchronization bridge between
   the baseline plans and AIGV execution state. Do not edit it manually.
   Every open Intent must be written as a falsifiable engineering statement and include:
   initial state, timed stimulus procedure, boundary values, observation points,
   expected externally visible behavior, checker/pass criteria, and required evidence.
   A taxonomy label such as `Error/Normal Collision` or `error x response` is not an Intent.
   Treat the configured `topModule` as the final IP signoff scope. Use full AIGV only for
   `IP_SIGNOFF` and risk-selected `UNIT_FOCUSED` modules. `UNIT_SMOKE` and `STATIC_ONLY`
   modules must not receive duplicate full Scenario sets. Decide verification depth from
   risk, and Oracle type from module semantics. Recommend a Golden Model when it improves
   independent judgment, fault localization, or convergence, regardless of module size.
8. Inspect `verification/intelligence/feature-interaction-graph.json`. When semantic reasoning is useful, call `register_verification_hypotheses`; every hypothesis must cite existing Risk, RTL Object, and Interaction Edge IDs, and every claim must be classified as `SPEC_FACT`, `RTL_FACT`, `INFERENCE`, or `UNKNOWN`.
9. Call `select_next_verification_batch` with a default batch of at most three Scenarios. Reuse the current execution plan unless specification, RTL, or regression evidence changed. Reuse or implement the named Cocotb sequence, constraints, temporal constraints, scoreboard/assertion checkers, iteration count, and time budget from `scenario-execution-plan.json`.
   For `formal-candidate` scenarios, use the `formal-verification` skill and `run_formal_verification`; do not call bounded PASS a proof.
10. Execution evidence is registered by the tool, not by hand. Bind each directed
    run to its scenarios via `run_simulation(scenarioIds=[...])` (or embed
    `scn_<8-hex>` in the testcase name); the tool writes
    `verification/results/<module>/scenario_hits.json` — including FAILs — with the
    current rtlHash and evidence paths, and rebuilds the posture snapshot
    automatically. Never hand-write or hand-edit `scenario_hits.json`.
    Execution-derived statuses (VERIFIED/FAILED/REACHED/...) are derived from this
    evidence only; `record_scenario_adjudication` is reserved for spec
    clarification and waivers, and WAIVED requires a prior named approval in
    `signoff-approvals.json`.

11. Intelligence is rebuilt automatically after every evidence-producing tool run;
    review the refreshed posture after each batch so passed scenarios and coverage
    feedback reprioritize the remaining queue — a manual `build_verification_intelligence`
    is only needed after spec or RTL edits outside the tools. Run expensive Verilator code coverage, broad Formal, and full regression at milestone boundaries (baseline stable, affected batch stable, pre-signoff), not after every local edit. Update only affected AIGV documents from actual machine-readable artifacts and raw evidence; do not rewrite unchanged documents or claim closure from an Agent summary. Run:

```bash
python <skill-dir>/scripts/check_vplan.py docs/04_verification/verification_plan.md
```

Resolve reported structural errors before implementing the environment.

Classify every uncovered target as C1 unreachable, C2 constraint blocked,
C3 stimulus missing, C4 observation missing, C5 spec undefined, or C6
tool/instrumentation. Do not respond to a coverage hole by merely increasing seeds.
For every hole, identify the exact Scenario behavior that is missing, the directed
stimulus needed to reach it, the signal/state/checker needed to observe it, and the
raw artifacts that will prove closure. A generic phrase such as "stimulus missing"
is insufficient.

Do not put executable tests in `docs/`. Test implementation belongs under
`verification/<module>_tb/`.

## Status reads and root-cause records

- Use `verification/intelligence/execution-summary.json` as the only routine
  status entry point. Never read `slang-ast.json`, `verification-state.json`,
  or `feature-interaction-graph.json` in full; when more detail is needed, call
  `select_next_verification_batch` or run a targeted query instead.
- Once a fix is verified (the scenario moves from FAIL to PASS), call
  `record_root_cause` to register the root cause: `rootCause` in at most 200
  characters, `fix` as an action-level description in at most 120 characters,
  and chain already-disproven hypotheses via `refutedHypotheses`.

## Progressive diagnostic control

Do not use a universal simulation-cycle or wall-clock limit when the project has
no justified baseline. Observe progress and preserve elapsed time as evidence;
only apply a hard timeout when the project or user explicitly defines one.

After a failure, fix the testcase and seed, state one root-cause hypothesis, and
make one minimal change. Read `verification/results/diagnostic-control.json`.
When it enters `DIAGNOSTIC_ENHANCEMENT`, stop repeatedly editing RTL and improve
diagnostic evidence first: staged checkers, protocol/state assertions,
transaction identifiers, scoreboard queue reporting, focused traces and the
first divergence point. The objective is progressive uncertainty reduction from
L0 final failure toward interface, time-window, state and root-cause evidence;
MoonGlass does not promise cycle-accurate root-cause localization.

Diagnostic enhancement may add observations, but it must not weaken or rewrite
the correct expected behavior to match the RTL.
