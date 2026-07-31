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
6. Run:

```bash
python <skill-dir>/scripts/check_vplan.py docs/04_verification/verification_plan.md
```

Resolve reported structural errors before implementing the environment.

Do not put executable tests in `docs/`. Test implementation belongs under
`verification/<module>_tb/`.
