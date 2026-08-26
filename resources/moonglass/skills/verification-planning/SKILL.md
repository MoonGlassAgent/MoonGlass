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
3. Write:
   - `docs/04_verification/verification_plan.md`
   - `docs/04_verification/test_plan.md`
   - `docs/04_verification/coverage_plan.md`
4. Give every requirement and test a stable ID. Maintain bidirectional
   requirement-to-test traceability.
5. Define stimulus, checker, expected result, coverage target, and pass/fail
   criteria for each test.
6. Call `build_verification_intelligence`. Review the ranked Scenario Registry
   and bind selected `SCN-*` IDs to requirements, RTL objects, tests, checkers,
   coverage bins, and evidence. Risk markers are planning hypotheses, not
   confirmed bugs. Do not generate arbitrary feature Cartesian products.
7. Inspect `verification/intelligence/feature-interaction-graph.json`. When semantic reasoning is useful, call `register_verification_hypotheses`; every hypothesis must cite existing Risk, RTL Object, and Interaction Edge IDs, and every claim must be classified as `SPEC_FACT`, `RTL_FACT`, `INFERENCE`, or `UNKNOWN`.
8. Call `select_next_verification_batch`. Reuse or implement the named Cocotb sequence, constraints, temporal constraints, scoreboard/assertion checkers, iteration count, and time budget from `scenario-execution-plan.json`.
   For `formal-candidate` scenarios, use the `formal-verification` skill and `run_formal_verification`; do not call bounded PASS a proof.
9. After execution, write `verification/results/<module>/scenario_hits.json`:

```json
{
  "scenarios": [
    {
      "id": "SCN-XXXXXXXX",
      "reached": true,
      "passed": true,
      "evidence": ["results_icarus.xml", "wave.fst"]
    }
  ]
}
```

10. Rebuild intelligence after every batch so passed scenarios and coverage feedback reprioritize the remaining queue. Run:

```bash
python <skill-dir>/scripts/check_vplan.py docs/04_verification/verification_plan.md
```

Resolve reported structural errors before implementing the environment.

Do not put executable tests in `docs/`. Test implementation belongs under
`verification/<module>_tb/`.
