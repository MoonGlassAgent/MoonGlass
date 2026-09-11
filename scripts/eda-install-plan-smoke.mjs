/**
 * EDA 一键安装计划 smoke：断言缺失计算纯函数与 PATH 合并纯函数。
 * 不涉及真实下载/安装链路（由用户在设置页实测）。
 */

import assert from 'node:assert/strict'
import { delimiter } from 'node:path'
import { computeMissingInstallPlan, mergePathEntries } from '../packages/eda-bridge/src/install-plan.ts'

const found = (tool, extra = {}) => ({ tool, found: true, category: 'eda', ...extra })

// 1. 全部就绪 → 空计划
{
  const plan = computeMissingInstallPlan([
    found('Verilator', { installId: 'oss-cad-suite' }),
    found('Cocotb', { category: 'verification', installId: 'python-cocotb' }),
    found('Verible', { category: 'verification', installId: 'verible' }),
    found('Node.js', { category: 'runtime', installUrl: 'https://nodejs.org/en/download' })
  ])
  assert.deepEqual(plan.bundles, [])
  assert.deepEqual(plan.manualGuidance, [])
}

// 2. 缺 Verilator → 计划含 oss-cad-suite
{
  const plan = computeMissingInstallPlan([{ tool: 'Verilator', found: false, category: 'eda', installId: 'oss-cad-suite' }])
  assert.deepEqual(plan.bundles, ['oss-cad-suite'])
  assert.deepEqual(plan.manualGuidance, [])
}

// 3. 缺 Cocotb → 计划含 python-cocotb
{
  const plan = computeMissingInstallPlan([{ tool: 'Cocotb', found: false, category: 'verification', installId: 'python-cocotb' }])
  assert.deepEqual(plan.bundles, ['python-cocotb'])
}

// 4. 缺 Verible → 计划含 verible
{
  const plan = computeMissingInstallPlan([{ tool: 'Verible', found: false, category: 'verification', installId: 'verible' }])
  assert.deepEqual(plan.bundles, ['verible'])
}

// 5. 缺 Node.js（runtime，无 installId）→ 进手动指引，不进 bundle
{
  const plan = computeMissingInstallPlan([{ tool: 'Node.js', found: false, category: 'runtime', installUrl: 'https://nodejs.org/en/download' }])
  assert.deepEqual(plan.bundles, [])
  assert.deepEqual(plan.manualGuidance, [{ tool: 'Node.js', installUrl: 'https://nodejs.org/en/download' }])
}

// 6. physical 类别缺失 → 不进任何计划
{
  const plan = computeMissingInstallPlan([{ tool: 'OpenSTA', found: false, category: 'physical', installUrl: 'https://openroad.readthedocs.io' }])
  assert.deepEqual(plan.bundles, [])
  assert.deepEqual(plan.manualGuidance, [])
}

// 7. builtin 缺失（内置组件异常）→ 不进任何计划
{
  const plan = computeMissingInstallPlan([{ tool: 'Slang', found: false, category: 'verification', builtin: true }])
  assert.deepEqual(plan.bundles, [])
  assert.deepEqual(plan.manualGuidance, [])
}

// 8. PATH 合并：注册表 PATH 与进程 PATH 合并去重，进程原有顺序在前、新增条目追加
{
  const current = ['D:\\Tools\\Managed\\bin', 'C:\\Windows\\System32', 'C:\\Existing\\'].join(delimiter)
  const registry = ['c:\\windows\\system32', 'C:\\NewTool\\bin', 'D:\\Tools\\Managed\\bin\\'].join(delimiter)
  const merged = mergePathEntries(current, registry)
  const entries = merged.split(delimiter)
  assert.deepEqual(entries, ['D:\\Tools\\Managed\\bin', 'C:\\Windows\\System32', 'C:\\Existing\\', 'C:\\NewTool\\bin'])
  // 自管目录保持最前
  assert.equal(entries[0], 'D:\\Tools\\Managed\\bin')
}

// 9. PATH 合并：空段与空白被忽略，空注册表 PATH 不改变原顺序
{
  const current = ['C:\\A', '', 'C:\\B'].join(delimiter)
  assert.equal(mergePathEntries(current, ''), ['C:\\A', 'C:\\B'].join(delimiter))
}

console.log('EDA install plan smoke passed: missing-plan & PATH-merge assertions OK')
