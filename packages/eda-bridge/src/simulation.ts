/**
 * 仿真器封装（Phase 4 真实现）
 *
 * 调用 Verilator 编译 RTL + C++ 测试台并运行仿真，收集日志、覆盖率与波形路径。
 * VCS / Xcelium 为预留类型，当前仅 Verilator 有真实现。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import {
  locateTool,
  run,
  toolEnv,
  VERILATOR_CANDIDATES
} from './tool-runner'

export type SimulatorKind = 'verilator' | 'icarus' | 'vcs' | 'xcelium'

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
  compileLogPath?: string
  simulationLogPath?: string
  resultPath?: string
}

export interface VerilatorSimOptions {
  topModule: string
  tbCpp: string
  rtlFiles: string[]
  trace?: boolean
  signal?: AbortSignal
  buildDir?: string
  resultDir?: string
}

export interface VerilatorSimResult {
  passed: boolean
  log: string
  vcdPath: string | null
  compileLogPath: string
  simulationLogPath: string
  resultPath: string
}

export interface CocotbSimOptions {
  topModule: string
  rtlFiles: string[]
  testModule: string
  testDir: string
  simulator?: 'icarus' | 'verilator'
  testcase?: string
  waves?: boolean
  signal?: AbortSignal
  buildDir: string
  resultDir: string
  timeoutSec?: number
  pythonExecutable?: string
}

function findWaveform(dir: string): string | null {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = findWaveform(full)
      if (nested) return nested
    } else if (/\.(vcd|fst)$/i.test(entry.name)) return full
  }
  return null
}

function windowsExitCode(code: number | null): string {
  if (code === null) return '未知'
  return process.platform === 'win32' && code > 255
    ? `${code} (0x${code.toString(16).toUpperCase().padStart(8, '0')})`
    : String(code)
}

async function checkIcarusToolchain(
  iverilogPath: string,
  buildDir: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<void> {
  const vvpPath = join(dirname(iverilogPath), process.platform === 'win32' ? 'vvp.exe' : 'vvp')
  if (!existsSync(vvpPath)) throw new Error(`Icarus 工具链不完整：未找到配套运行器 ${vvpPath}`)

  const smokeDir = join(buildDir, '.moonglass-icarus-check')
  const sourcePath = join(smokeDir, 'smoke.v')
  const outputPath = join(smokeDir, 'smoke.vvp')
  mkdirSync(smokeDir, { recursive: true })
  writeFileSync(sourcePath, 'module smoke; initial begin $display("MOONGLASS_ICARUS_OK"); $finish; end endmodule\n', 'utf-8')
  try {
    const compile = await run(iverilogPath, ['-o', outputPath, sourcePath], env, signal, smokeDir, 15_000)
    if (compile.code !== 0 || !existsSync(outputPath)) {
      throw new Error(`iverilog 最小编译失败，退出码 ${windowsExitCode(compile.code)}：${(compile.stderr || compile.stdout).trim() || '无输出'}`)
    }
    const execute = await run(vvpPath, [outputPath], env, signal, smokeDir, 15_000)
    if (execute.code !== 0 || !execute.stdout.includes('MOONGLASS_ICARUS_OK')) {
      throw new Error(`vvp 最小运行失败，退出码 ${windowsExitCode(execute.code)}：${(execute.stderr || execute.stdout).trim() || '无输出'}`)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Icarus 工具链自检未通过。MoonGlass 已绑定 ${dirname(iverilogPath)} 并隔离冲突的 MinGW DLL；请在“设置 > 工具链”重新安装 OSS CAD Suite。\n${detail}`)
  } finally {
    rmSync(smokeDir, { recursive: true, force: true })
  }
}

/** 使用 cocotb 2.x Python Runner 运行测试，并统一归档日志、JUnit、结果和波形。 */
export async function runCocotbSimulation(options: CocotbSimOptions): Promise<VerilatorSimResult> {
  const simulator = options.simulator ?? 'icarus'
  const python = options.pythonExecutable ?? await locateTool(process.platform === 'win32' ? ['python.exe', 'python'] : ['python3', 'python'])
  if (!python) throw new Error('未找到 Python；Cocotb 仿真需要 Python 3')
  const simulatorPath = await locateTool(simulator === 'icarus'
    ? (process.platform === 'win32' ? ['iverilog.exe', 'iverilog'] : ['iverilog'])
    : VERILATOR_CANDIDATES)
  if (!simulatorPath) throw new Error(`未找到 ${simulator === 'icarus' ? 'Icarus Verilog' : 'Verilator'}`)
  for (const file of options.rtlFiles) if (!existsSync(file)) throw new Error(`RTL 文件不存在: ${file}`)
  if (!existsSync(options.testDir)) throw new Error(`Cocotb 测试目录不存在: ${options.testDir}`)

  mkdirSync(options.buildDir, { recursive: true })
  mkdirSync(options.resultDir, { recursive: true })
  const runnerPath = join(options.buildDir, 'moonglass_cocotb_runner.py')
  const compileLogPath = join(options.resultDir, 'compile.log')
  const simulationLogPath = join(options.resultDir, 'simulation.log')
  const resultPath = join(options.resultDir, 'result.json')
  const resultsXml = join(options.resultDir, 'results.xml')
  const script = [
    'from cocotb_tools.runner import get_runner',
    `runner = get_runner(${JSON.stringify(simulator)})`,
    `runner.build(sources=${JSON.stringify(options.rtlFiles)}, hdl_toplevel=${JSON.stringify(options.topModule)}, build_dir=${JSON.stringify(options.buildDir)}, always=True, waves=${options.waves !== false ? 'True' : 'False'}, timescale=('1ns', '1ps'))`,
    'print("__MOONGLASS_BUILD_DONE__", flush=True)',
    `runner.test(hdl_toplevel=${JSON.stringify(options.topModule)}, test_module=${JSON.stringify(options.testModule)}, testcase=${options.testcase ? JSON.stringify(options.testcase) : 'None'}, build_dir=${JSON.stringify(options.buildDir)}, test_dir=${JSON.stringify(options.resultDir)}, results_xml=${JSON.stringify(resultsXml)}, waves=${options.waves !== false ? 'True' : 'False'})`
  ].join('\n')
  writeFileSync(runnerPath, script, 'utf-8')

  const env = toolEnv(simulatorPath)
  env.PYTHONPATH = `${resolve(options.testDir)}${delimiter}${env.PYTHONPATH ?? ''}`
  env.COCOTB_RESULTS_FILE = resultsXml
  if (simulator === 'icarus') {
    await checkIcarusToolchain(simulatorPath, options.buildDir, env, options.signal)
  }
  const execution = await run(
    python,
    [runnerPath],
    env,
    options.signal,
    resolve(options.testDir),
    Math.max(30, options.timeoutSec ?? 300) * 1000
  )
  const output = [execution.stdout, execution.stderr].filter(Boolean).join('\n')
  const marker = output.indexOf('__MOONGLASS_BUILD_DONE__')
  writeFileSync(compileLogPath, marker >= 0 ? output.slice(0, marker) : output, 'utf-8')
  writeFileSync(simulationLogPath, marker >= 0 ? output.slice(marker + '__MOONGLASS_BUILD_DONE__'.length) : output, 'utf-8')

  const sourceWaveform = findWaveform(options.buildDir) ?? findWaveform(options.resultDir)
  let waveformPath: string | null = null
  if (sourceWaveform) {
    waveformPath = join(options.resultDir, `${options.topModule}${sourceWaveform.toLowerCase().endsWith('.fst') ? '.fst' : '.vcd'}`)
    if (resolve(sourceWaveform) !== resolve(waveformPath)) copyFileSync(sourceWaveform, waveformPath)
  }
  const xml = existsSync(resultsXml) ? readFileSync(resultsXml, 'utf-8') : ''
  const testsTotal = (xml.match(/<testcase\b/g) ?? []).length
  const testsFailed = (xml.match(/<(?:failure|error)\b/g) ?? []).length
  const testsSkipped = (xml.match(/<skipped\b/g) ?? []).length
  const testsPassed = Math.max(0, testsTotal - testsFailed - testsSkipped)
  const passed = execution.code === 0 && testsPassed > 0 && testsFailed === 0
  writeFileSync(resultPath, JSON.stringify({
    passed,
    framework: 'cocotb',
    simulator,
    topModule: options.topModule,
    testModule: options.testModule,
    testcase: options.testcase ?? null,
    runExitCode: execution.code,
    testsTotal,
    testsPassed,
    testsFailed,
    testsSkipped,
    waveformPath,
    compileLogPath,
    simulationLogPath,
    resultsXml: existsSync(resultsXml) ? resultsXml : null,
    finishedAt: new Date().toISOString()
  }, null, 2), 'utf-8')
  return {
    passed,
    log: output.slice(-6000) || '(无输出)',
    vcdPath: waveformPath,
    compileLogPath,
    simulationLogPath,
    resultPath
  }
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

  const objDir = options.buildDir ?? join(dirname(tbCpp), 'obj_dir')
  const binPath = join(objDir, `V${topModule}`)
  const binExe = process.platform === 'win32' ? `${binPath}.exe` : binPath
  const resultDir = options.resultDir ?? join(dirname(tbCpp), 'results', topModule)
  const compileLogPath = join(resultDir, 'compile.log')
  const simulationLogPath = join(resultDir, 'simulation.log')
  const resultPath = join(resultDir, 'result.json')
  mkdirSync(resultDir, { recursive: true })

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
  writeFileSync(
    compileLogPath,
    [`[command] ${verilatorPath} ${ccArgs.join(' ')}`, '', ccOut, ccErr].join('\n'),
    'utf-8'
  )

  if (ccCode !== null && ccCode !== 0) {
    const failed = {
      passed: false,
      topModule,
      compileExitCode: ccCode,
      runExitCode: null,
      waveformPath: null,
      compileLogPath,
      simulationLogPath,
      finishedAt: new Date().toISOString()
    }
    writeFileSync(simulationLogPath, '仿真未运行：Verilator 编译失败\n', 'utf-8')
    writeFileSync(resultPath, JSON.stringify(failed, null, 2), 'utf-8')
    return {
      passed: false,
      log: `Verilator 编译失败 (code=${ccCode}):\n${ccErr.slice(0, 2000)}`,
      vcdPath: null,
      compileLogPath,
      simulationLogPath,
      resultPath
    }
  }

  // Step 2: 运行仿真
  if (!existsSync(binExe)) {
    writeFileSync(simulationLogPath, `仿真可执行文件未找到: ${binExe}\n`, 'utf-8')
    writeFileSync(resultPath, JSON.stringify({
      passed: false,
      topModule,
      compileExitCode: ccCode,
      runExitCode: null,
      waveformPath: null,
      compileLogPath,
      simulationLogPath,
      finishedAt: new Date().toISOString()
    }, null, 2), 'utf-8')
    return {
      passed: false,
      log: `仿真可执行文件未找到: ${binExe}\n编译日志:\n${ccOut.slice(0, 1000)}`,
      vcdPath: null,
      compileLogPath,
      simulationLogPath,
      resultPath
    }
  }

  // 测试台通常用相对路径创建 VCD；必须在结果目录运行，确保波形位置稳定。
  const { stdout: runOut, stderr: runErr, code: runCode } = await run(
    binExe,
    [],
    undefined,
    signal,
    resultDir
  )

  const log = [runOut, runErr].filter(Boolean).join('\n')
  writeFileSync(
    simulationLogPath,
    [`[executable] ${binExe}`, `[exitCode] ${runCode}`, '', runOut, runErr].join('\n'),
    'utf-8'
  )
  const vcdPath = trace ? join(resultDir, `${topModule}.vcd`) : null
  const resolvedVcd = vcdPath && existsSync(vcdPath) ? vcdPath : null
  const passed = runCode === 0 || runCode === null
  writeFileSync(resultPath, JSON.stringify({
    passed,
    topModule,
    compileExitCode: ccCode,
    runExitCode: runCode,
    waveformPath: resolvedVcd,
    compileLogPath,
    simulationLogPath,
    finishedAt: new Date().toISOString()
  }, null, 2), 'utf-8')

  return {
    passed,
    log: log.slice(0, 4000) || '(无输出)',
    vcdPath: resolvedVcd,
    compileLogPath,
    simulationLogPath,
    resultPath
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
    executablePath: join(dirname(options.testbench), 'obj_dir', `V${options.topModule}`),
    compileLogPath: result.compileLogPath,
    simulationLogPath: result.simulationLogPath,
    resultPath: result.resultPath
  }
}
