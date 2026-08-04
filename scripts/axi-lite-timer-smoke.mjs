/**
 * AXI-Lite Timer 真实 RTL 冒烟脚本
 *
 * 覆盖：
 *   1. 内置 IP 模板库中的 RTL 可被 eda-bridge lint；
 *   2. Icarus Verilog 可编译并执行 testbench；
 *   3. 仿真输出包含 SMOKE_PASS，并生成 VCD / result.json 质量证据。
 *
 * 运行：pnpm smoke:axi-lite-timer
 */
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const { locateTool, run, toolEnv } = await import('../packages/eda-bridge/src/tool-runner.ts')
const { runLint } = await import('../packages/eda-bridge/src/lint.ts')

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const ipRoot = join(repoRoot, 'resources', 'moonglass', 'ip-library', 'utility', 'axi_lite_timer')
const rtlSource = join(ipRoot, 'rtl', 'axi_lite_timer.sv')
const tbSource = join(ipRoot, 'verification', 'tb_axi_lite_timer.sv')

const IVERILOG_CANDIDATES = process.platform === 'win32' ? ['iverilog.exe', 'iverilog'] : ['iverilog']
const VVP_CANDIDATES = process.platform === 'win32' ? ['vvp.exe', 'vvp'] : ['vvp']

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

function assertSourceExists(filePath) {
  if (!existsSync(filePath)) {
    throw new Error(`样例文件不存在: ${filePath}`)
  }
}

assertSourceExists(rtlSource)
assertSourceExists(tbSource)

const workRoot = await mkdtemp(join(tmpdir(), 'moonglass-axi-lite-timer-'))
const rtlDir = join(workRoot, 'rtl')
const simDir = join(workRoot, 'sim')
mkdirSync(rtlDir, { recursive: true })
mkdirSync(simDir, { recursive: true })

const rtlPath = join(rtlDir, basename(rtlSource))
const tbPath = join(simDir, basename(tbSource))
const simImage = join(simDir, 'axi_lite_timer_tb.vvp')
const compileLogPath = join(simDir, 'compile.log')
const simLogPath = join(simDir, 'simulation.log')
const resultPath = join(simDir, 'result.json')
const vcdPath = join(simDir, 'axi_lite_timer.vcd')

copyFileSync(rtlSource, rtlPath)
copyFileSync(tbSource, tbPath)

console.log(`工作目录: ${workRoot}`)

const lintResult = await runLint({ filePath: rtlPath })
check(
  'RTL lint 通过',
  lintResult.passed,
  `engine=${lintResult.engine} errors=${lintResult.errors.length} warnings=${lintResult.warnings.length}`
)
if (!lintResult.passed) {
  console.log(JSON.stringify(lintResult.errors.slice(0, 3), null, 2))
}

const iverilogPath = await locateTool(IVERILOG_CANDIDATES)
const vvpPath = await locateTool(VVP_CANDIDATES)
check('找到 Icarus 编译器', iverilogPath !== null, iverilogPath ?? '未找到 iverilog')
check('找到 vvp 运行器', vvpPath !== null, vvpPath ?? '未找到 vvp')

let compileResult = { stdout: '', stderr: '', code: null }
let simResult = { stdout: '', stderr: '', code: null }
if (iverilogPath && vvpPath) {
  compileResult = await run(
    iverilogPath,
    ['-g2012', '-Wall', '-s', 'tb_axi_lite_timer', '-o', simImage, rtlPath, tbPath],
    toolEnv(iverilogPath),
    undefined,
    simDir
  )
  writeFileSync(compileLogPath, `${compileResult.stdout}\n${compileResult.stderr}`)
  check('Icarus 编译通过', compileResult.code === 0, `code=${compileResult.code}`)

  if (compileResult.code === 0) {
    simResult = await run(vvpPath, [simImage], toolEnv(vvpPath), undefined, simDir)
    writeFileSync(simLogPath, `${simResult.stdout}\n${simResult.stderr}`)
    check('仿真进程通过', simResult.code === 0, `code=${simResult.code}`)
    check('仿真命中 SMOKE_PASS', /SMOKE_PASS axi_lite_timer/.test(simResult.stdout + simResult.stderr))
    check('VCD 已生成', existsSync(vcdPath), vcdPath)
  }
}

const result = {
  passed: failures === 0,
  workRoot,
  lint: {
    engine: lintResult.engine,
    passed: lintResult.passed,
    errors: lintResult.errors.length,
    warnings: lintResult.warnings.length
  },
  compile: {
    tool: iverilogPath,
    code: compileResult.code,
    log: compileLogPath
  },
  simulation: {
    tool: vvpPath,
    code: simResult.code,
    log: simLogPath,
    vcd: vcdPath,
    smokePass: /SMOKE_PASS axi_lite_timer/.test(
      `${simResult.stdout ?? ''}\n${simResult.stderr ?? ''}`
    )
  }
}
writeFileSync(resultPath, JSON.stringify(result, null, 2))

if (existsSync(simLogPath)) {
  const simLog = readFileSync(simLogPath, 'utf-8').trim()
  if (simLog) console.log(`仿真日志摘要:\n${simLog.split(/\r?\n/).slice(-5).join('\n')}`)
}

console.log(`质量证据: ${resultPath}`)
console.log('')
console.log(failures === 0 ? '✅ AXI-Lite Timer 冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
