import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = mkdtempSync(join(tmpdir(), 'moonglass-doc-check-'))
const checker = resolve('resources/moonglass/skills/doc-repository/scripts/check_doc_repo.py')
const write = (path, text) => {
  const target = join(root, path)
  mkdirSync(resolve(target, '..'), { recursive: true })
  writeFileSync(target, text, 'utf8')
}

try {
  for (const dir of ['docs/01_project', 'docs/02_requirements', 'docs/03_design', 'scripts']) mkdirSync(join(root, dir), { recursive: true })
  write('docs/01_project/project_charter.md', '# 项目章程\n\n## 版本历史\n')
  write('docs/02_requirements/product_requirements.md', '# 产品需求\n\n## REQ-FUNC-001 功能\n\n## REQ-FUNC-002 功能\n\n## 版本历史\n')
  write('docs/02_requirements/module_specification.md', '# 模块规格\n\n| 规格 ID | 内容 |\n|---|---|\n| SPEC-FUNC-001~002 | 规格 |\n\n## 版本历史\n')
  write('docs/02_requirements/requirements_traceability.md', '# 追溯矩阵\n\n| 需求 ID | 规格 ID | 状态 |\n|---|---|---|\n| REQ-FUNC-001/002 | SPEC-FUNC-001~002 | 草稿 |\n\n## 版本历史\n')
  write('docs/03_design/architecture.md', '# 架构设计\n\n## 版本历史\n')
  write('docs/03_design/interface_spec.md', '# 接口规格\n\n## 版本历史\n')
  write('docs/04_verification/.gitkeep', '')
  const output = join(root, 'reports', 'result.json')
  const result = spawnSync('python', ['-X', 'utf8', checker, '--path', root, '--stage', 'arch', '--json', '--output', output, '--quiet'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`校验器应通过：${result.stderr}\n${readFileSync(output, 'utf8')}`)
  const report = JSON.parse(readFileSync(output, 'utf8'))
  if (!report.passed || report.stage !== 'arch') throw new Error('JSON 报告状态或阶段错误')
  if (report.results.some((item) => item.item.includes('verification_plan') && item.severity === 'error')) throw new Error('未来阶段文档被误报')
  console.log('[doc-repository-validator] 阶段、UTF-8 JSON、范围 ID 与忽略规则通过')
} finally {
  rmSync(root, { recursive: true, force: true })
}
