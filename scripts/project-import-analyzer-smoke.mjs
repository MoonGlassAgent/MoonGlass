import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeExistingProject } from '../src/main/services/ProjectImportAnalyzer.ts'

const root = mkdtempSync(join(tmpdir(), 'moonglass-import-'))
const assert = (condition, message) => {
  if (!condition) throw new Error(`✗ ${message}`)
  console.log(`✓ ${message}`)
}
const write = (path, content = '') => {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content, 'utf-8')
}

try {
  write('unusual_src/core_a.sv', 'module core_a; endmodule')
  write('unusual_src/core_b.v', 'module core_b; endmodule')
  let result = analyzeExistingProject(root)
  assert(result.suggestedPhase === 'RTL', '非标准源码目录可识别为 RTL 阶段')
  assert(result.warnings.some((item) => item.includes('架构文档')), '缺少架构文档时给出适配提醒')

  write('dv/cocotb/test_core.py', 'def test_core(): pass')
  write('run/regression/results.xml', '<testsuite/>')
  result = analyzeExistingProject(root)
  assert(result.suggestedPhase === 'VERIF', '验证代码和回归结果可识别为验证阶段')

  write('backend/constraints/top.sdc', 'create_clock -period 10 [get_ports clk]')
  write('backend/reports/timing.rpt', 'slack 0.1')
  result = analyzeExistingProject(root)
  assert(result.suggestedPhase === 'SYNTH', '约束和综合报告可识别为综合阶段')
  assert(result.evidence.SYNTH.paths.some((path) => path.endsWith('.sdc')), '评估保留真实综合证据路径')

  write('node_modules/fake/coverage.xml', '<fake/>')
  const afterNoise = analyzeExistingProject(root)
  assert(afterNoise.fileCount === result.fileCount, '忽略 node_modules 噪声目录')
  console.log('\n✅ 已有项目阶段识别冒烟全部通过')
} finally {
  rmSync(root, { recursive: true, force: true })
}
