// 仿真停滞检测冒烟（挂死防护，刻意区别于 wall-clock 超时）：
// 1. run() 单元级：静默进程在阈值处被终止并标记 stalled（挂死防护生效）；
//    持续输出进程即使总时长远超阈值也不被误杀（慢仿真保护）。
// 2. resolveSimStallMs：显式参数 > MOONGLASS_SIM_STALL_MS > 缺省 10 分钟。
// 3. 集成级：runCocotbSimulation（icarus，rtlCoverage=false 跳过覆盖率升级）跑一个
//    启动后永久静默的挂死用例，验证 result.json 诚实标记 stalled/passed=false、
//    仿真日志含停滞 banner，且与普通失败（stalled=false）语义区分。
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { run, resolveSimStallMs, DEFAULT_SIM_STALL_MS } = await import('../packages/eda-bridge/src/tool-runner.ts')
const { runCocotbSimulation } = await import('../packages/eda-bridge/src/simulation.ts')

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

// ============ 用例 1：单元级——静默进程被停滞终止，持续输出进程不误杀 ============
{
  // 静默挂死进程：永无输出
  const silent = await run(process.execPath, ['-e', 'setInterval(()=>{}, 1000)'], undefined, undefined, undefined, 0, 1200)
  check('静默进程被停滞终止并标记 stalled', silent.stalled === true && silent.code !== 0,
    `code=${String(silent.code)} stalled=${String(silent.stalled)}`)
  check('结果携带生效的停滞阈值', silent.stallMs === 1200, String(silent.stallMs))

  // 持续输出进程：总时长 2.5s 远超 1.2s 阈值，但每 200ms 有输出 → 不得误杀
  const chatty = await run(
    process.execPath,
    ['-e', "const t=setInterval(()=>console.log('tick'), 200); setTimeout(()=>{clearInterval(t); console.log('done')}, 2500)"],
    undefined, undefined, undefined, 0, 1200
  )
  check('持续输出的慢进程不被停滞误杀（自然跑完 code=0）',
    chatty.stalled !== true && chatty.code === 0 && chatty.stdout.includes('done'),
    `code=${String(chatty.code)} stalled=${String(chatty.stalled)}`)

  // 普通失败：有输出但退出非零 → stalled 必须为 false（区别于停滞）
  const failing = await run(process.execPath, ['-e', "console.log('x'); process.exit(3)"], undefined, undefined, undefined, 0, 5000)
  check('普通失败不被误标 stalled', failing.stalled !== true && failing.code === 3, `code=${String(failing.code)}`)

  // 未启用停滞检测时无 stalled/stallMs 字段
  const plain = await run(process.execPath, ['-e', "console.log('ok')"], undefined, undefined, undefined, 30000)
  check('未启用停滞检测时结果无 stalled/stallMs', plain.stalled === undefined && plain.stallMs === undefined)
}

// ============ 用例 2：阈值解析——显式参数 > 环境变量 > 缺省 ============
{
  const saved = process.env.MOONGLASS_SIM_STALL_MS
  delete process.env.MOONGLASS_SIM_STALL_MS
  check('缺省阈值 10 分钟', resolveSimStallMs() === DEFAULT_SIM_STALL_MS && DEFAULT_SIM_STALL_MS === 600_000)
  process.env.MOONGLASS_SIM_STALL_MS = '2500'
  check('环境变量覆盖缺省', resolveSimStallMs() === 2500)
  check('显式参数覆盖环境变量', resolveSimStallMs(800) === 800)
  process.env.MOONGLASS_SIM_STALL_MS = '0'
  check('非法环境变量值回落缺省', resolveSimStallMs() === DEFAULT_SIM_STALL_MS)
  if (saved === undefined) delete process.env.MOONGLASS_SIM_STALL_MS
  else process.env.MOONGLASS_SIM_STALL_MS = saved
}

// ============ 用例 3：集成级——cocotb 挂死用例被停滞终止并诚实落 result.json ============
{
  process.env.MOONGLASS_SIM_STALL_MS = '2500'
  const root = mkdtempSync(join(tmpdir(), 'moonglass-sim-stall-'))
  const testDir = join(root, 'verification', 'hang_tb')
  const buildDir = join(testDir, 'sim', 'sim_build')
  const resultDir = join(root, 'verification', 'results', 'hang')
  mkdirSync(join(testDir, 'tests'), { recursive: true })

  const rtl = join(root, 'hang.v')
  writeFileSync(rtl, `module hang(input wire clk, input wire rst_n, output reg [3:0] count, output wire done);
always @(posedge clk or negedge rst_n) begin
  if (!rst_n) count <= 0;
  else count <= count + 1'b1;
end
assign done = 1'b0;
endmodule
`)
  writeFileSync(join(testDir, 'tests', '__init__.py'), '')
  writeFileSync(join(testDir, 'tests', 'test_hang.py'), `import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

@cocotb.test()
async def hang_silently(dut):
    # 挂死形态：时钟一直跑（仿真持续推进、吃墙钟）但 done 永不拉高——
    # cocotb 打完启动 banner 后永久静默。正常时应在停滞阈值处被 runner 终止；
    # 停滞失效才会无限挂死（注： bare Timer 挂不住 Icarus，其空闲时间会直接跳完）
    cocotb.start_soon(Clock(dut.clk, 10, unit="ns").start())
    cocotb.log.info("entering silent wait")
    await RisingEdge(dut.done)
    assert False, "unreachable"
`)
  const startedAt = Date.now()
  const result = await runCocotbSimulation({
    topModule: 'hang', rtlFiles: [rtl], testModule: 'tests.test_hang', testDir,
    simulator: 'icarus', rtlCoverage: false, waves: false, buildDir, resultDir
  })
  const elapsed = Date.now() - startedAt
  const meta = JSON.parse(readFileSync(result.resultPath, 'utf-8'))
  const simLog = readFileSync(meta.simulationLogPath, 'utf-8')

  console.log(`    [集成] 停滞终止耗时 ${(elapsed / 1000).toFixed(1)}s（阈值 2.5s）`)
  check('挂死仿真在停滞阈值附近被终止（远快于批次兜底）', elapsed < 60_000, `${(elapsed / 1000).toFixed(1)}s`)
  check('返回结果 stalled=true 且 passed=false', result.stalled === true && result.passed === false)
  check('result.json 诚实标记 stalled/passed=false/阈值', meta.stalled === true && meta.passed === false && meta.stallThresholdMs === 2500)
  check('result.json runExitCode 非 0（进程被终止）', meta.runExitCode !== 0, String(meta.runExitCode))
  check('仿真日志含停滞保护 banner', simLog.includes('停滞保护终止'))
  check('icarus 请求 + rtlCoverage=false 不触发覆盖率升级回退留痕', meta.coverageUpgrade === undefined)
  rmSync(root, { recursive: true, force: true })
}

// 收尾：清掉停滞阈值环境变量，避免影响同进程后续用例
delete process.env.MOONGLASS_SIM_STALL_MS

if (failures === 0) {
  console.log('\n✅ 仿真停滞检测冒烟通过')
} else {
  console.log(`\n❌ ${failures} 项失败`)
}
process.exit(failures === 0 ? 0 : 1)
