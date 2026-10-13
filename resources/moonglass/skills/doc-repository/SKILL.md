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
- Use explicit `需求 ID` and `规格 ID` table headers so the validator recognizes definitions without repair passes.
- Write complete IDs (`REQ-` / `SPEC-` prefixes) in the traceability matrix. Bare or misspelled prefixes such as `PERF-001` or `RXE-IF-001` are rejected as `矩阵 ID 格式` errors with file/table/row/column locations; IDs written only in the matrix are not treated as definitions.
- Run the stage validator after the initial batch write. Fix only reported failures in one batch, rerun immediately, and stop when it passes; warnings do not justify open-ended polishing.
- After repeated exact-edit failures, reread the target section once and replace it by stable heading/ID anchors. Never repair Markdown by deleting a drifting fixed line number.
- Keep traceability states within `草稿 / 冻结 / 验证 / 已验证 / 已验收 / 开放 / 关闭`.
- State assumptions, unresolved items, acceptance criteria, and source evidence.
- Link related documents using relative paths.
- Treat `microarchitecture.md` as optional for a simple single-module design. Create it when internal pipelines, state machines, scheduling, datapaths, or module interactions need a separate review surface. 一旦创建，粒度必须能直接指导 RTL 开发：每个非平凡模块写清接口信号与参数（位宽/方向/默认值/握手）、状态机（状态/转移条件/每态行为）或流水线各级行为、寄存器与存储语义（地址/字段/读写行为/复位值/副作用）、边界与异常处理（空满/越界/非法配置/并发）、关键时序关系（延迟拍数/吞吐/反压）。判定标准：RTL 开发会话只凭本文档与规格即可实现，无需重新做设计决策；只写"做什么"不写"怎么做"视为不合格。
- Treat `clock_reset.md` as optional for a single-clock, single-reset design without CDC/RDC. Create it for multiple clock/reset domains, generated or gated clocks, reset sequencing, CDC/RDC, or special low-power behavior.
- When either optional document is omitted, retain the necessary concise description and rationale in `architecture.md`.
- Templates are available in `assets/templates/`; adapt them to the project
  instead of retaining placeholder text.
- On Windows, use the Python wrapper for Chinese document parsing; do not use shell `grep`/`sed` as a traceability gate. Run with the actual current stage:

```bash
python -X utf8 <skill-dir>/scripts/check_doc_repo.py --path . --stage arch --json --output reports/doc_check_arch.json
```

Supported stages are `req_spec`, `arch`, `rtl`, `verif`, `qa`, and `synth`. Future-stage files are informational rather than errors. The checker ignores templates and `.gitkeep`, supports `.check_doc_repo_ignore`, expands range/slash IDs, validates bidirectional REQ/SPEC coverage and state values, flags malformed matrix IDs with table/row/column locations and the correct prefix form, and writes UTF-8-safe JSON.

Fix current-stage structural errors, undefined IDs, missing reverse mappings, and placeholder sections before declaring a stage complete.
