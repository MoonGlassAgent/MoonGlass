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

  // 实验 A/B 复现：裸 ID / 错前缀 / 不存在编号三种笔误的诊断（MG-DOC-001/002/003/005）
  const bad = join(root, 'bad-tree')
  for (const dir of ['docs/01_project', 'docs/02_requirements', 'docs/03_design', 'scripts']) mkdirSync(join(bad, dir), { recursive: true })
  write(join('bad-tree', 'docs/01_project/project_charter.md'), '# 项目章程\n\n## 版本历史\n')
  write(join('bad-tree', 'docs/02_requirements/product_requirements.md'), '# 产品需求（实验）\n\n## 版本历史\n\n## 5. 性能需求\n\n| 需求 ID | 指标 | 目标 |\n|---|---|---|\n| REQ-PERF-001 | 峰值算力 | 16 TOPS |\n| REQ-IF-001 | AXI4 主口 | 2x256b |\n')
  write(join('bad-tree', 'docs/02_requirements/module_specification.md'), '# 模块规格\n\n## 版本历史\n')
  write(join('bad-tree', 'docs/02_requirements/requirements_traceability.md'), '# 追溯矩阵\n\n## 版本历史\n\n| 需求 ID | 规格 ID | 状态 |\n|---|---|---|\n| REQ-PERF-099 |  | 草稿 |\n| RXE-IF-001 |  | 草稿 |\n| PERF-001 |  | 草稿 |\n')
  const badOutput = join(root, 'reports', 'bad.json')
  const badResult = spawnSync('python', ['-X', 'utf8', checker, '--path', bad, '--stage', 'req_spec', '--json', '--output', badOutput, '--quiet'], { encoding: 'utf8' })
  if (badResult.status !== 1) throw new Error(`笔误夹具应检查失败：${badResult.stderr}`)
  const badReport = JSON.parse(readFileSync(badOutput, 'utf8'))
  const badItems = badReport.results
  const formatErrors = badItems.filter((item) => item.item === '矩阵 ID 格式' && item.severity === 'error')
  if (formatErrors.length !== 2) throw new Error(`裸 ID 与错前缀应各报一条格式错误：${JSON.stringify(formatErrors)}`)
  if (!formatErrors.some((item) => item.message.includes('表1 数据行3') && item.message.includes('需求 ID') && item.message.includes('REQ-PERF-001'))) {
    throw new Error('裸 ID 未产出带 表/行/列 定位与写法建议的格式错误')
  }
  if (!formatErrors.some((item) => item.message.includes('表1 数据行2') && item.message.includes('RXE-IF-001'))) throw new Error('错前缀 ID 未报格式错误')
  const unknown = badItems.find((item) => item.item === '未知需求 ID' && item.severity === 'error')
  if (!unknown?.message.includes('REQ-PERF-099') || !unknown.message.includes('表1 数据行1')) throw new Error(`未知 ID 诊断缺失或无命中位置：${unknown?.message}`)
  const coverage = badItems.find((item) => item.item === '需求双向覆盖' && item.severity === 'error')
  if (!coverage?.message.includes('缺少映射：REQ-IF-001, REQ-PERF-001')) throw new Error(`缺失列表未排序或内容错误：${coverage?.message}`)
  if (!coverage.message.includes('若矩阵中已列，请检查命名空间前缀是否完整')) throw new Error(`缺失提示缺少可操作指引：${coverage.message}`)
  const specWarning = badItems.find((item) => item.item === '规格 ID 定义' && item.severity === 'warning')
  if (!specWarning?.message.includes('仅写在追溯矩阵中的 ID 不被视为定义')) throw new Error(`定义缺失警告未说明真实原因：${specWarning?.message}`)
  console.log('[doc-repository-validator] 矩阵 ID 格式诊断、缺失排序与定位、定义缺失文案通过')
} finally {
  rmSync(root, { recursive: true, force: true })
}
