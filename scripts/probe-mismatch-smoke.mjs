/**
 * probe 证据语义冒烟（MISMATCH 不得 PASS）+ request_user_decision 决策纪律文案断言
 *
 * 背景：purpose='probe' 的隔离运行不写 scenario_hits、不进态势，但其自身 result.json/
 * 报告的 passed 必须诚实。修复前 probe 与其他用途共用同一判定（cocotb 只看 JUnit 断言、
 * cpp 只看退出码），TB 打印 MISMATCH 但不 assert 时 probe 照样 PASS。
 *
 * 行为级（真 icarus 仿真，经 pi-bridge 临时布局直接驱动 run_simulation execute）：
 *   1. probe + TB 打印 MISMATCH（cocotb log.error、不 assert，框架层 PASS）
 *      → 工具结果 passed=false / isError=true，报告含 MISMATCH 比对失败节；
 *      隔离目录 result.json passed=false 且 probe.semantics='oracle-mismatch'；
 *      主 result.json 与 scenario_hits.json 均不产生（隔离不变）。
 *   2. probe + 纯观测 TB（无 MISMATCH）
 *      → passed=true 但报告显式注明"运行完成，非判定结论"；
 *      result.json probe.semantics='run-completed-not-a-verdict'。
 * 文案级（源码标记）：
 *   3. request_user_decision 收紧为仅限真正领域裁决，禁止可忽略/样式性事项调用，
 *      含"默认不问、继续干"，且保留"最多一个推荐项"等原有指引。
 *   4. run_simulation probe passed 语义标记（MISMATCH 强制 false / 非判定注明）齐全。
 * 运行：node scripts/probe-mismatch-smoke.mjs
 */
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'moonglass-probe-mismatch-'))
const bridgeDir = join(root, 'pi-bridge')
mkdirSync(join(bridgeDir, 'eda-bridge', 'src'), { recursive: true })
mkdirSync(join(bridgeDir, 'verification-intelligence', 'src'), { recursive: true })
// 与 AgentService 复制到 userData 的布局一致：pi-bridge 平铺 + eda-bridge/src + verification-intelligence/src
for (const f of ['moonglass-tools.ts', 'rtl-write-guard.ts']) {
  writeFileSync(join(bridgeDir, f), readFileSync(join(process.cwd(), 'resources', 'moonglass', 'pi-bridge', f), 'utf-8'))
}
for (const f of ['tool-runner.ts', 'simulation.ts', 'synthesis.ts', 'lint.ts', 'formal.ts', 'dead-logic.ts', 'rtl-files.ts', 'slang-runner.ts']) {
  writeFileSync(join(bridgeDir, 'eda-bridge', 'src', f), readFileSync(join(process.cwd(), 'packages', 'eda-bridge', 'src', f), 'utf-8'))
}
for (const f of ['engine.ts', 'types.ts', 'structural-analyzer.ts']) {
  writeFileSync(join(bridgeDir, 'verification-intelligence', 'src', f), readFileSync(join(process.cwd(), 'packages', 'verification-intelligence-engine', 'src', f), 'utf-8'))
}
// 桥接文件从临时目录加载，裸导入（typebox，运行时仅这一个）经 node_modules 链接解析。
// typebox 是 pi-coding-agent 的依赖（pnpm 不提升），从 pi 包上下文解析入口后向上找包根建 junction（无需提权）。
import { createRequire } from 'node:module'
const piCliReal = realpathSync(join(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'))
const piRequire = createRequire(piCliReal)
let typeboxDir = join(piRequire.resolve('typebox'), '..')
while (basename(typeboxDir) !== 'typebox') typeboxDir = join(typeboxDir, '..')
mkdirSync(join(bridgeDir, 'node_modules'), { recursive: true })
symlinkSync(typeboxDir, join(bridgeDir, 'node_modules', 'typebox'), 'junction')

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).split('\n')[0].slice(0, 160)}` : ''}`)
  if (!condition) failures++
}

// 以最小 mock 扩展 API 注册全部工具（pi.on 仅订阅、不触发）
const tools = []
const mockPi = { registerTool: (tool) => tools.push(tool), on: () => {} }
const activate = (await import(pathToFileURL(join(bridgeDir, 'moonglass-tools.ts')).href)).default
activate(mockPi)
const runSimulation = tools.find((tool) => tool.name === 'run_simulation')
check('run_simulation 工具已注册', Boolean(runSimulation))

// ---- 工作区：计数器 RTL + 两个 probe 观测用例（mismatch 只打印不 assert）----
const ws = join(root, 'ws')
const testDir = join(ws, 'verification', 'cnt_tb')
mkdirSync(join(testDir, 'tests'), { recursive: true })
writeFileSync(join(ws, 'cnt.v'), `module cnt(input wire i_clk, input wire i_rst_n, output reg [3:0] o_count);
always @(posedge i_clk or negedge i_rst_n) begin
  if (!i_rst_n) o_count <= 4'd0;
  else          o_count <= o_count + 4'd1;
end
endmodule
`, 'utf-8')
writeFileSync(join(testDir, 'tests', '__init__.py'), '', 'utf-8')
writeFileSync(join(testDir, 'tests', 'test_cnt.py'), `import cocotb
from cocotb.clock import Clock
from cocotb.triggers import ClockCycles

@cocotb.test()
async def probe_mismatch_observed(dut):
    cocotb.start_soon(Clock(dut.i_clk, 10, unit="ns").start())
    dut.i_rst_n.value = 0
    await ClockCycles(dut.i_clk, 2)
    dut.i_rst_n.value = 1
    await ClockCycles(dut.i_clk, 4)
    # oracle 比对失败：只打印 MISMATCH、不 assert——cocotb 框架层该用例仍 PASS
    dut._log.error("[Scoreboard] MISMATCH:")
    dut._log.error("  Actual:   0x9")
    dut._log.error("  Expected: 0x5")

@cocotb.test()
async def probe_clean_observed(dut):
    cocotb.start_soon(Clock(dut.i_clk, 10, unit="ns").start())
    dut.i_rst_n.value = 0
    await ClockCycles(dut.i_clk, 2)
    dut.i_rst_n.value = 1
    await ClockCycles(dut.i_clk, 4)
    dut._log.info(f"[Probe] o_count={int(dut.o_count.value)}")
`, 'utf-8')

const baseParams = {
  mode: 'cocotb',
  topModule: 'cnt',
  rtlFiles: ['cnt.v'],
  testModule: 'tests.test_cnt',
  testDir: 'verification/cnt_tb',
  simulator: 'icarus',
  rtlCoverage: false,
  trace: false,
  purpose: 'probe'
}

// ---- 用例 1：probe 含 MISMATCH → passed 必须为 false ----
const mismatchRun = await runSimulation.execute('smoke-mismatch', { ...baseParams, testcase: 'probe_mismatch_observed' }, undefined, undefined, { cwd: ws })
const mismatchText = mismatchRun.content.map((c) => c.text).join('\n')
check('probe 含 MISMATCH：工具结果 passed=false', mismatchRun.details?.passed === false, `details.passed=${String(mismatchRun.details?.passed)}`)
check('probe 含 MISMATCH：工具结果 isError=true', mismatchRun.isError === true)
check('probe 含 MISMATCH：报告注明 passed 强制为 false', mismatchText.includes('passed 强制为 false'))
check('probe 含 MISMATCH：报告含 MISMATCH 比对失败节', mismatchText.includes('### MISMATCH 比对失败'))

const probeRunsDir = join(ws, 'verification', 'results', 'cnt', 'probe-runs')
const mismatchResultPath = mismatchRun.details?.resultPath
check('probe 结果落盘到 probe-runs 隔离目录', typeof mismatchResultPath === 'string' && mismatchResultPath.startsWith(probeRunsDir), String(mismatchResultPath))
const mismatchMeta = JSON.parse(readFileSync(mismatchResultPath, 'utf-8'))
check('隔离 result.json passed=false（诚实证据）', mismatchMeta.passed === false, `passed=${String(mismatchMeta.passed)}`)
check('隔离 result.json probe.semantics=oracle-mismatch', mismatchMeta.probe?.semantics === 'oracle-mismatch', JSON.stringify(mismatchMeta.probe))
check('隔离 result.json 记录 MISMATCH 证据行', Array.isArray(mismatchMeta.probe?.mismatchLines) && mismatchMeta.probe.mismatchLines.some((line) => /MISMATCH/i.test(line)))

// ---- 隔离不变量：主 result.json 与 scenario_hits.json 均不产生 ----
check('主 result.json 未被回写（隔离）', !existsSync(join(ws, 'verification', 'results', 'cnt', 'result.json')))
check('scenario_hits.json 未产生（隔离）', !existsSync(join(ws, 'verification', 'scenario_hits.json')))

// ---- 用例 2：probe 纯观测（无 MISMATCH）→ passed=运行完成，显式注明非判定 ----
const cleanRun = await runSimulation.execute('smoke-clean', { ...baseParams, testcase: 'probe_clean_observed' }, undefined, undefined, { cwd: ws })
const cleanText = cleanRun.content.map((c) => c.text).join('\n')
check('probe 无 MISMATCH：passed=true（运行完成）', cleanRun.details?.passed === true, `details.passed=${String(cleanRun.details?.passed)}`)
check('probe 无 MISMATCH：报告显式注明非判定结论', cleanText.includes('运行完成') && cleanText.includes('非判定结论'))
check('probe 无 MISMATCH：工具结果 isError=false', cleanRun.isError === false)
const cleanMeta = JSON.parse(readFileSync(cleanRun.details?.resultPath, 'utf-8'))
check('隔离 result.json probe.semantics=run-completed-not-a-verdict', cleanMeta.probe?.semantics === 'run-completed-not-a-verdict', JSON.stringify(cleanMeta.probe))

// ---- 用例 3：request_user_decision 决策纪律文案 ----
const toolsSource = readFileSync(join(process.cwd(), 'resources', 'moonglass', 'pi-bridge', 'moonglass-tools.ts'), 'utf-8')
const decisionBlock = toolsSource.slice(toolsSource.indexOf("name: 'request_user_decision'"), toolsSource.indexOf('async execute', toolsSource.indexOf("name: 'request_user_decision'")))
for (const marker of [
  '仅限真正的领域裁决',
  '规格歧义',
  'IP 行为/接口/寄存器语义',
  '面积/性能/功耗取舍',
  '禁止调用本工具',
  'internal 死逻辑',
  '命名风格',
  '纯重构',
  '报告格式',
  '无行为影响的选项',
  '默认不问、继续干',
  '没有实质行为后果的决策不应打断自治流水线',
  // 原有合理指引保留
  'mark at most one recommended option',
  'stop your response after calling the tool until the user answers',
  'IP 行为语言'
]) {
  check(`request_user_decision 文案含「${marker}」`, decisionBlock.includes(marker))
}
check('request_user_decision schema 未变（options/recommended 仍在）',
  decisionBlock.includes('recommended: Type.Optional(Type.Boolean())') && decisionBlock.includes("mode: Type.Union([Type.Literal('single'), Type.Literal('multiple')])"))

// ---- 用例 4：run_simulation probe 语义标记 ----
const simBlock = toolsSource.slice(toolsSource.indexOf("name: 'run_simulation'"), toolsSource.indexOf("name: 'generate_sdc'"))
for (const marker of [
  'passed 强制为 false',
  'run-completed-not-a-verdict',
  'oracle-mismatch',
  'MISMATCH 比对失败',
  '非判定结论'
]) {
  check(`run_simulation probe 语义含「${marker}」`, simBlock.includes(marker))
}

rmSync(root, { recursive: true, force: true })
console.log('')
console.log(failures === 0 ? '✅ probe 证据语义与决策纪律冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
