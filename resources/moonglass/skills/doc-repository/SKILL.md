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
- Define each ID once in a heading or an explicit `需求 ID` / `规格 ID` table column. References do not create new IDs.
- Use `REQ-VER-0XX` for top-level verification requirements and `REQ-VER-1XX` only for formally registered detailed verification requirements. Use `SPEC-*` for design specifications and `VER-*`, `TEST-*`, or `CG-*` for verification artifacts.
- Prefer one complete ID per reference. Legacy range and slash forms such as `SPEC-AXI-001~005` and `SPEC-AXI-001/002` are accepted and expanded by the checker, but new content should spell out complete IDs when review clarity matters.
- Keep `requirements_traceability.md` bidirectional and current across requirement, specification, design, and verification IDs.
- Keep traceability states within `草稿 / 冻结 / 验证 / 已验证 / 已验收 / 开放 / 关闭`.
- State assumptions, unresolved items, acceptance criteria, and source evidence.
- Link related documents using relative paths.
- Treat `microarchitecture.md` as optional for a simple single-module design. Create it when internal pipelines, state machines, scheduling, datapaths, or module interactions need a separate review surface.
- Treat `clock_reset.md` as optional for a single-clock, single-reset design without CDC/RDC. Create it for multiple clock/reset domains, generated or gated clocks, reset sequencing, CDC/RDC, or special low-power behavior.
- When either optional document is omitted, retain the necessary concise description and rationale in `architecture.md`.
- Templates are available in `assets/templates/`; adapt them to the project
  instead of retaining placeholder text.
- On Windows, use the Python wrapper for Chinese document parsing; do not use shell `grep`/`sed` as a traceability gate. Run with the actual current stage:

```bash
python -X utf8 <skill-dir>/scripts/check_doc_repo.py --path . --stage arch --json --output reports/doc_check_arch.json
```

Supported stages are `req_spec`, `arch`, `rtl`, `verif`, `qa`, and `synth`. Future-stage files are informational rather than errors. The checker ignores templates and `.gitkeep`, supports `.check_doc_repo_ignore`, expands range/slash IDs, validates bidirectional REQ/SPEC coverage and state values, and writes UTF-8-safe JSON.

Fix current-stage structural errors, undefined IDs, missing reverse mappings, and placeholder sections before declaring a stage complete.
