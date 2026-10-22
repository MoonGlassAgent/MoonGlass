// 波形体积熔断冒烟（资源保护，非 wall-clock 超时）：
// 1. cpp 模式：真实调用 generate_tb 生成含熔断标记的 TB，再用 run_simulation(mode=cpp)
//    以极小阈值（0.0001 GB）真实跑 Verilator 仿真，验证“超限只停 dump、仿真继续”。
// 2. cocotb 模式：runner 侧监控产物体积（cocotb 后端波形由其内部生成的 wrapper
//    控制，外部无法只停 dump），超限终止仿真并诚实标记 waveformAborted。
// 两种模式都验证 result.json 标记与 diagnostic-control.json 的 C6（工具/插桩）留痕。
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const root = resolve('out', `waveform-guard-smoke-${process.pid}`)
const bridgeDir = join(root, 'bridge')
mkdirSync(join(bridgeDir, 'eda-bridge', 'src'), { recursive: true })
mkdirSync(join(bridgeDir, 'verification-intelligence', 'src'), { recursive: true })

// 与 pi-tools-smoke 一致：把 pi-bridge 扩展与共享实现复制到独立目录后 import。
// 放在仓库 out/ 下而非系统临时目录，是为了让 Node 沿目录树解析到仓库 node_modules。
// 复制保留 src/ 布局（与 packages 源目录一致），与 AgentService 运行时复制口径统一。
for (const f of ['moonglass-tools.ts', 'rtl-write-guard.ts']) {
  writeFileSync(join(bridgeDir, f), readFileSync(join('resources', 'moonglass', 'pi-bridge', f), 'utf-8'))
}
for (const f of ['tool-runner.ts', 'rtl-files.ts', 'simulation.ts', 'synthesis.ts', 'lint.ts', 'formal.ts', 'dead-logic.ts', 'slang-runner.ts']) {
  writeFileSync(join(bridgeDir, 'eda-bridge', 'src', f), readFileSync(join('packages', 'eda-bridge', 'src', f), 'utf-8'))
}
for (const f of ['engine.ts', 'types.ts', 'structural-analyzer.ts']) {
  writeFileSync(join(bridgeDir, 'verification-intelligence', 'src', f), readFileSync(join('packages', 'verification-intelligence-engine', 'src', f), 'utf-8'))
}
// moonglass-tools.ts 运行时依赖 typebox（pnpm 下仅在 .pnpm 虚拟存储中），建 junction 使其可解析
const pnpmDir = join(process.cwd(), 'node_modules', '.pnpm')
const typeboxStore = readdirSync(pnpmDir).find((d) => d.startsWith('typebox@'))
if (!typeboxStore) {
  console.error('❌ 未找到 node_modules/.pnpm/typebox@*，无法加载 moonglass-tools')
  process.exit(1)
}
mkdirSync(join(bridgeDir, 'node_modules'), { recursive: true })
symlinkSync(join(pnpmDir, typeboxStore, 'node_modules', 'typebox'), join(bridgeDir, 'node_modules', 'typebox'), 'junction')

const tools = new Map()
const registerTools = (await import(pathToFileURL(join(bridgeDir, 'moonglass-tools.ts')).href)).default
registerTools({ registerTool: (def) => tools.set(def.name, def), on: () => {} })
const generateTb = tools.get('generate_tb')
const runSimulation = tools.get('run_simulation')
check('generate_tb / run_simulation 已注册', Boolean(generateTb && runSimulation))

// 宽位自由运行计数器：每周期大量比特翻转，让波形快速增长以触发极小阈值
const RTL_COUNTER = `module TOPNAME(input wire i_clk, input wire i_rst_n, output reg [127:0] o_count);
always @(posedge i_clk or negedge i_rst_n) begin
  if (!i_rst_n) o_count <= 128'b0;
  else o_count <= o_count + 128'h9e3779b97f4a7c15f39cc0605cedc835;
end
endmodule
`
// 高熵宽总线：cocotb 测试每周期驱动 2048 位随机数据（压缩率极低），
// 确保 Icarus FST 缓冲在仿真中途就持续 flush 增长，runner 侧监控能在仿真进行中观察到超限
const RTL_WIDE_BUS = `module TOPNAME(input wire i_clk, input wire i_rst_n, input wire [2047:0] i_data, output reg [2047:0] o_data);
always @(posedge i_clk or negedge i_rst_n) begin
  if (!i_rst_n) o_data <= 2048'b0;
  else o_data <= i_data;
end
endmodule
`
const THRESHOLD_GB = 0.0001 // ≈105KB：极小阈值，确保微型设计也能触发熔断
const THRESHOLD_BYTES = THRESHOLD_GB * 1073741824

// 加快熔断检查节奏（仅 smoke；生产缺省为 100 万周期 / 2 秒轮询）
process.env.MOONGLASS_WAVEFORM_CHECK_CYCLES = '200'
process.env.MOONGLASS_WAVEFORM_MONITOR_INTERVAL_MS = '100'

function writeRtl(caseDir, top, template) {
  mkdirSync(caseDir, { recursive: true })
  const rtl = join(caseDir, `${top}.v`)
  writeFileSync(rtl, template.replaceAll('TOPNAME', top))
  return rtl
}

// ============ 用例 1：cpp 模式 —— TB 内熔断，只停 dump、仿真继续 ============
{
  const caseDir = join(root, 'case-cpp')
  const top = 'wguard_cpp'
  const rtl = writeRtl(caseDir, top, RTL_COUNTER)
  const ctx = { cwd: caseDir }

  const gen = await generateTb.execute('wg-tb-1', { rtlFile: rtl, numCycles: 200000, trace: true }, undefined, undefined, ctx)
  const tbPath = gen.details?.outputPath
  check('generate_tb 生成 TB', typeof tbPath === 'string' && existsSync(tbPath))
  const tbSource = tbPath ? readFileSync(tbPath, 'utf-8') : ''
  check('TB 含 MOONGLASS_WAVEFORM_GUARD 熔断标记', tbSource.includes('MOONGLASS_WAVEFORM_GUARD'))

  const res = await runSimulation.execute('wg-run-1', {
    mode: 'cpp', topModule: top, rtlFiles: [rtl], tbCpp: tbPath,
    trace: true, rtlCoverage: false, maxWaveformGB: THRESHOLD_GB
  }, undefined, undefined, ctx)

  const resultJson = JSON.parse(readFileSync(res.details.resultPath, 'utf-8'))
  const simLog = readFileSync(resultJson.simulationLogPath, 'utf-8')
  const vcdSize = resultJson.waveformPath && existsSync(resultJson.waveformPath)
    ? (await import('node:fs')).statSync(resultJson.waveformPath).size
    : 0
  const diagnostic = JSON.parse(readFileSync(join(caseDir, 'verification', 'results', 'diagnostic-control.json'), 'utf-8'))
  const lastAttempt = diagnostic.attempts.at(-1) ?? {}

  console.log(`    [cpp] VCD 最终体积 ${(vcdSize / 1024).toFixed(0)} KB（阈值 ${(THRESHOLD_BYTES / 1024).toFixed(0)} KB）`)
  check('[cpp] 仿真自然跑完且 PASS（熔断不影响 PASS/FAIL 语义）', res.details?.passed === true)
  check('[cpp] 日志含 dump stopped 令牌', simLog.includes('MOONGLASS_WAVEFORM_GUARD: dump stopped'))
  check('[cpp] result.json 标记 waveformAborted + size-limit',
    resultJson.waveformAborted === true && resultJson.waveformAbortedReason === 'size-limit')
  check('[cpp] 波形超阈值但远小于完整体积（dump 已提前停止）',
    vcdSize > THRESHOLD_BYTES && vcdSize < 4 * 1024 * 1024, `${(vcdSize / 1024).toFixed(0)} KB`)
  check('[cpp] diagnostic-control.json 留痕 C6 / dump-stopped',
    lastAttempt.waveformGuard?.classification === 'C6_TOOL_INSTRUMENTATION' && lastAttempt.waveformGuard?.behavior === 'dump-stopped')
  check('[cpp] 工具报告诚实说明熔断行为', res.content?.[0]?.text.includes('波形熔断'))
}

// ============ 用例 2：cocotb 模式 —— runner 侧监控，超限终止仿真并诚实标记 ============
{
  const caseDir = join(root, 'case-cocotb')
  const top = 'wguard_cocotb'
  const rtl = writeRtl(caseDir, top, RTL_WIDE_BUS)
  const testDir = join(caseDir, 'verification', `${top}_tb`)
  mkdirSync(join(testDir, 'tests'), { recursive: true })
  writeFileSync(join(testDir, 'tests', '__init__.py'), '')
  writeFileSync(join(testDir, 'tests', 'test_wguard.py'), `import random
import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

@cocotb.test()
async def test_long_waveform(dut):
    cocotb.start_soon(Clock(dut.i_clk, 10, unit="ns").start())
    dut.i_rst_n.value = 0
    dut.i_data.value = 0
    for _ in range(5): await RisingEdge(dut.i_clk)
    dut.i_rst_n.value = 1
    rng = random.Random(42)
    # 长跑用例：每周期驱动 2048 位高熵随机数据，波形持续增长；
    # 正常时应在波形超阈值后被 runner 终止，熔断失效才会跑满 20 万周期
    for _ in range(200000):
        dut.i_data.value = rng.getrandbits(2048)
        await RisingEdge(dut.i_clk)
`)
  const ctx = { cwd: caseDir }

  const res = await runSimulation.execute('wg-run-2', {
    mode: 'cocotb', topModule: top, rtlFiles: [rtl],
    testModule: 'tests.test_wguard', testDir, simulator: 'icarus',
    trace: true, maxWaveformGB: THRESHOLD_GB
  }, undefined, undefined, ctx)

  const resultJson = JSON.parse(readFileSync(res.details.resultPath, 'utf-8'))
  const fstPath = resultJson.waveformPath
  const fstSize = fstPath && existsSync(fstPath) ? (await import('node:fs')).statSync(fstPath).size : 0
  const diagnostic = JSON.parse(readFileSync(join(caseDir, 'verification', 'results', 'diagnostic-control.json'), 'utf-8'))
  const lastAttempt = diagnostic.attempts.at(-1) ?? {}

  console.log(`    [cocotb] FST 终止时体积 ${(fstSize / 1024).toFixed(0)} KB（阈值 ${(THRESHOLD_BYTES / 1024).toFixed(0)} KB）`)
  check('[cocotb] result.json 诚实标记 waveformAborted + size-limit',
    resultJson.waveformAborted === true && resultJson.waveformAbortedReason === 'size-limit')
  check('[cocotb] 仿真被终止（FAIL，区别于 cpp 的“仿真继续”）', res.details?.passed === false && resultJson.runExitCode !== 0)
  check('[cocotb] 波形已落盘但被提前截断', fstSize > THRESHOLD_BYTES && fstSize < 64 * 1024 * 1024, `${(fstSize / 1024).toFixed(0)} KB`)
  check('[cocotb] diagnostic-control.json 留痕 C6 / simulation-aborted',
    lastAttempt.waveformGuard?.classification === 'C6_TOOL_INSTRUMENTATION' && lastAttempt.waveformGuard?.behavior === 'simulation-aborted')
  check('[cocotb] 工具报告诚实说明“终止仿真”而非假装只停 dump', res.content?.[0]?.text.includes('已终止仿真'))
}

if (failures === 0) {
  rmSync(root, { recursive: true, force: true })
  console.log('\n✅ 波形体积熔断冒烟通过')
} else {
  console.log(`\n❌ ${failures} 项失败（现场保留在 ${root}）`)
}
process.exit(failures === 0 ? 0 : 1)
