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
  02_requirements/module_specification.md
  02_requirements/requirements_traceability.md
  03_design/architecture.md
  03_design/microarchitecture.md  # optional for simple designs
  03_design/interface_spec.md
  03_design/register_map.md
  03_design/clock_reset.md         # optional for single-clock/single-reset designs
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
- Keep `requirements_traceability.md` bidirectional and current across requirement, specification, design, and verification IDs.
- State assumptions, unresolved items, acceptance criteria, and source evidence.
- Link related documents using relative paths.
- Treat `microarchitecture.md` as optional for a simple single-module design. Create it when internal pipelines, state machines, scheduling, datapaths, or module interactions need a separate review surface.
- Treat `clock_reset.md` as optional for a single-clock, single-reset design without CDC/RDC. Create it for multiple clock/reset domains, generated or gated clocks, reset sequencing, CDC/RDC, or special low-power behavior.
- When either optional document is omitted, retain the necessary concise description and rationale in `architecture.md`.
- Templates are available in `assets/templates/`; adapt them to the project
  instead of retaining placeholder text.
- Run:

```bash
python <skill-dir>/scripts/check_doc_repo.py .
```

Fix structural errors and placeholder sections before declaring a stage complete.
