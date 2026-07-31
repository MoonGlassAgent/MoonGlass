---
name: doc-repository
description: Create, organize, migrate, and validate ASIC project documentation using the MoonGlass canonical docs tree. Use for requirements, architecture, interface, verification, validation, implementation, and release documents.
---

# Document Repository

Use this canonical document layout:

```text
docs/
  01_project/project_charter.md
  02_requirements/product_requirements.md
  02_requirements/requirements_traceability.md
  03_design/architecture.md
  03_design/microarchitecture.md
  03_design/interface_spec.md
  03_design/register_map.md
  03_design/clock_reset.md
  04_verification/verification_plan.md
  04_verification/test_plan.md
  04_verification/coverage_plan.md
  05_implementation/
  06_validation/
  07_release/
```

## Rules

- Preserve previous-stage documents. Update them deliberately; never silently
  replace them with a new interpretation.
- Use stable IDs for requirements, interfaces, registers, tests, and decisions.
- Keep `requirements_traceability.md` bidirectional and current.
- State assumptions, unresolved items, acceptance criteria, and source evidence.
- Link related documents using relative paths.
- Templates are available in `assets/templates/`; adapt them to the project
  instead of retaining placeholder text.
- Run:

```bash
python <skill-dir>/scripts/check_doc_repo.py .
```

Fix structural errors and placeholder sections before declaring a stage complete.
