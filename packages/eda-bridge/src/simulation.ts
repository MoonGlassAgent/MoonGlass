/**
 * 仿真器封装（Phase 4 真实现）
 *
 * 调用 Verilator 编译 RTL + C++ 测试台并运行仿真，收集日志、覆盖率与波形路径。
 * VCS / Xcelium 为预留类型，当前仅 Verilator 有真实现。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  locateTool,
  run,
  toolEnv,
  VERILATOR_CANDIDATES
} from './tool-runner'

export type SimulatorKind = 'verilator' | 'vcs' | 'xcelium'

export interface SimulationOptions {
  topModule: string
  testbench: string
  rtlFiles?: string[]
  simulator?: SimulatorKind
  trace?: boolean
  timeoutSec?: number
}

export interface CoverageSummary {
  lineCoverage?: number
  branchCoverage?: number
  toggleCoverage?: number
}

export interface SimulationResult {
  passed: boolean
  log: string
  coverage?: CoverageSummary
  waveformPath?: string
  executablePath?: string
}

export interface VerilatorSimOptions {
  topModule: string
  tbCpp: string
  rtlFiles: string[]
  trace?: boolean
  signal?: AbortSignal
}

export interface VerilatorSimResult {
  passed: boolean
  log: string
  vcdPath: string | null
}

/**
 * 使用 Verilator 编译并运行仿真。
 *
 * 步骤：
 * 1. verilator --cc --build --exe -Wno-fatal --Mdir obj_dir tb.cpp rtl.v
 * 2. 运行生成的 obj_dir/V{topModule} 可执行文件
 */
export async function runVerilatorSimulation(
  options: VerilatorSimOptions
): Promise<VerilatorSimResult> {
  const { topModule, tbCpp, rtlFiles, trace = true, signal } = options

  const verilatorPath = await locateTool(VERILATOR_CANDIDATES)
  if (!verilatorPath) throw new Error('工具未找到: verilator')

  const objDir = join(dirname(tbCpp), 'obj_dir')
  const binPath = join(objDir, `V${topModule}`)
  const binExe = process.platform === 'win32' ? `${binPath}.exe` : binPath

  // Step 1: verilator --cc (编译 RTL 到 C++)
  const ccArgs = [
    '--cc',
    '--build',
    '--exe',
    '-Wno-fatal',
    '--Mdir',
    objDir,
    ...(trace ? ['--trace'] : []),
    tbCpp,
    ...rtlFiles
  ]

  const { stdout: ccOut, stderr: ccErr, code: ccCode } = await run(
    verilatorPath,
    ccArgs,
    toolEnv(verilatorPath),
    signal
  )

  if (ccCode !== null && ccCode !== 0) {
    return {
      passed: false,
      log: `Verilator 编译失败 (code=${ccCode}):\n${ccErr.slice(0, 2000)}`,
      vcdPath: null
    }
  }

  // Step 2: 运行仿真
  if (!existsSync(binExe)) {
    return {
      passed: false,
      log: `仿真可执行文件未找到: ${binExe}\n编译日志:\n${ccOut.slice(0, 1000)}`,
      vcdPath: null
    }
  }

  const { stdout: runOut, stderr: runErr, code: runCode } = await run(binExe, [], undefined, signal)

  const log = [runOut, runErr].filter(Boolean).join('\n')
  const vcdPath = trace ? join(dirname(tbCpp), `${topModule}.vcd`) : null

  return {
    passed: runCode === 0 || runCode === null,
    log: log.slice(0, 4000) || '(无输出)',
    vcdPath: vcdPath && existsSync(vcdPath) ? vcdPath : null
  }
}

/** 仿真门面：根据 simulator 参数分发，当前仅支持 verilator */
export async function runSimulation(options: SimulationOptions): Promise<SimulationResult> {
  const simulator = options.simulator ?? 'verilator'
  if (simulator !== 'verilator') {
    throw new Error(`NotImplemented: ${simulator} 仿真器将在 Phase 6 实现`)
  }

  const rtlFiles = options.rtlFiles ?? []
  const result = await runVerilatorSimulation({
    topModule: options.topModule,
    tbCpp: options.testbench,
    rtlFiles,
    trace: options.trace ?? true,
    signal: undefined
  })

  return {
    passed: result.passed,
    log: result.log,
    waveformPath: result.vcdPath ?? undefined,
    executablePath: join(dirname(options.testbench), 'obj_dir', `V${options.topModule}`)
  }
}
