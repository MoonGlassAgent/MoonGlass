/**
 * 用户侧环境自检（T6 env doctor）冒烟脚本
 *
 * 用临时 userData 实例化 EdaService（projects 依赖仅 openWaveform 使用，给最小桩），
 * 实跑 runEnvironmentSelfCheck()：本机已装 iverilog/yosys/sby/cocotb 2.0.1（verible 未装）。
 * 关键验证点：裸 PATH 下 yosys 因 Strawberry Perl MinGW DLL 冲突 exit 127，
 * toolEnv 隔离（isolatedToolPath 剔除携带 MinGW 运行时的目录）必须让其通过。
 *
 * 运行：node scripts/env-self-check-smoke.mjs
 */
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { EdaService } = await import('../src/main/services/EdaService.ts')

const fakeUserData = mkdtempSync(join(tmpdir(), 'moonglass-selfcheck-'))
let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

// projects 仅 openWaveform 触达，自检链路不使用 → 最小桩
const eda = new EdaService(fakeUserData, { workspaceDir: () => process.cwd() })
await eda.start()

const report = await eda.runEnvironmentSelfCheck()
const byId = new Map(report.items.map((item) => [item.id, item]))

check('报告包含 5 项检查', report.totalCount === 5 && report.items.length === 5)
check('报告计数自洽', report.passedCount === report.items.filter((item) => item.passed).length)
check('ranAt 可解析', !Number.isNaN(Date.parse(report.ranAt)))
check('检查项顺序与 id 正确', report.items.map((item) => item.id).join(',') === 'icarus,verible,yosys,sby,cocotb')

for (const item of report.items) {
  console.log(`  [${item.passed ? 'PASS' : item.skipped ? 'SKIP' : 'FAIL'}] ${item.id} (${(item.durationMs / 1000).toFixed(1)}s) ${item.message.split('\n')[0]}`)
}

// 本机已装：icarus / yosys / sby / cocotb 2.0.1 必须通过；verible 未装应 skipped
check('icarus 最小编译+运行通过', byId.get('icarus')?.passed === true, byId.get('icarus')?.message)
check('yosys+ABC 最小综合通过（toolEnv 隔离生效）', byId.get('yosys')?.passed === true, byId.get('yosys')?.message)
check('sby 最小 BMC 通过', byId.get('sby')?.passed === true, byId.get('sby')?.message)
check('cocotb+icarus 最小用例通过', byId.get('cocotb')?.passed === true, byId.get('cocotb')?.message)
const verible = byId.get('verible')
check('verible 未安装时跳过并指引安装', verible?.skipped === true && verible?.passed === false && verible?.installId === 'verible', verible?.message)

eda.stop()
rmSync(fakeUserData, { recursive: true, force: true })

console.log('')
console.log(failures === 0 ? '✅ 环境自检冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
