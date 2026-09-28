/**
 * 仿真器封装（Phase 4 真实现）
 *
 * 调用 Verilator 编译 RTL + C++ 测试台并运行仿真，收集日志、覆盖率与波形路径。
 * VCS / Xcelium 为预留类型，当前仅 Verilator 有真实现。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path'
import {
  locateTool,
  run,
  toolEnv,
  VERILATOR_CANDIDATES
} from './tool-runner'
import type { CoverageDetailResult, CoveragePointDetail } from '@shared/types'

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
  expressionCoverage?: number
  toggleCoverage?: number
  fsmCoverage?: number
  functionalCoverage?: number
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

// ---- 波形体积熔断（资源保护，刻意区别于 wall-clock 超时） ----
// 既有设计原则：不设无工程依据的仿真 wall-clock 上限。体积熔断不是时间限制，
// 只保护磁盘资源——cpp 模式（我方 generate_tb 注入的 TB）超限时只关闭波形 dump、
// 仿真继续跑到自然结束；cocotb 后端的波形开关由其内部生成的 wrapper 控制，
// 外部无法只停 dump，超限只能终止整个仿真并在 result.json 诚实标记。

/** generate_tb 注入 TB 的熔断标记（源码注释）与熔断触发时打印到日志的令牌 */
export const WAVEFORM_GUARD_MARKER = 'MOONGLASS_WAVEFORM_GUARD'
export const WAVEFORM_GUARD_STOP_TOKEN = 'MOONGLASS_WAVEFORM_GUARD: dump stopped'

const DEFAULT_MAX_WAVEFORM_GB = 10

/** 解析波形体积阈值（GB）：显式参数 > 环境变量 MOONGLASS_MAX_WAVEFORM_GB > 缺省 10 */
export function resolveMaxWaveformGB(param?: number): number {
  if (typeof param === 'number' && Number.isFinite(param) && param > 0) return param
  const envValue = Number(process.env.MOONGLASS_MAX_WAVEFORM_GB ?? '')
  return Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_MAX_WAVEFORM_GB
}

/** 递归统计目录下 .vcd/.fst 波形产物的总字节数 */
function dirWaveformBytes(dir: string): number {
  if (!existsSync(dir)) return 0
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) total += dirWaveformBytes(full)
    else if (/\.(vcd|fst)$/i.test(entry.name)) {
      try { total += statSync(full).size } catch { /* 仿真并发写入/清理时忽略单次采样失败 */ }
    }
  }
  return total
}

interface WaveformSizeMonitor {
  /**
   * 停止轮询并做最后一次采样。
   * notify=false（缺省）：收尾采样只更新观测值不再回调——用于“超限即终止仿真”的场景，
   * 避免仿真已自然结束却被误标为被熔断；notify=true：收尾采样同样回调——用于
   * “只监控不干预”的外部 TB 场景，捕捉最后一个轮询间隔内发生的超限。
   */
  stop(notify?: boolean): void
  /** 是否已观察到超限 */
  readonly exceeded: boolean
  /** 观察到的最大波形体积（字节） */
  readonly observedBytes: number
}

/**
 * runner 侧波形体积监控：周期统计给定目录下的 .vcd/.fst 总大小，超阈值时回调一次。
 * 轮询间隔缺省 2 秒，可经 MOONGLASS_WAVEFORM_MONITOR_INTERVAL_MS 覆盖（冒烟测试用）。
 */
function monitorWaveformSize(dirs: string[], thresholdBytes: number, onExceed: (bytes: number) => void): WaveformSizeMonitor {
  const envInterval = Number(process.env.MOONGLASS_WAVEFORM_MONITOR_INTERVAL_MS ?? '')
  const intervalMs = Number.isFinite(envInterval) && envInterval >= 50 ? envInterval : 2000
  const state = { exceeded: false, observedBytes: 0 }
  const sample = (notify: boolean): void => {
    let total = 0
    for (const dir of dirs) total += dirWaveformBytes(dir)
    state.observedBytes = Math.max(state.observedBytes, total)
    if (notify && !state.exceeded && total > thresholdBytes) {
      state.exceeded = true
      onExceed(total)
    }
  }
  const timer = setInterval(() => sample(true), intervalMs)
  timer.unref?.()
  return {
    stop: (notify = false) => { clearInterval(timer); sample(notify) },
    get exceeded() { return state.exceeded },
    get observedBytes() { return state.observedBytes }
  }
}

export interface VerilatorSimOptions {
  topModule: string
  tbCpp: string
  rtlFiles: string[]
  trace?: boolean
  signal?: AbortSignal
  buildDir?: string
  resultDir?: string
  rtlCoverage?: boolean
  /** 波形体积阈值（GB），缺省 10；也可经环境变量 MOONGLASS_MAX_WAVEFORM_GB 覆盖 */
  maxWaveformGB?: number
}

export interface VerilatorSimResult {
  passed: boolean
  log: string
  vcdPath: string | null
  compileLogPath: string
  simulationLogPath: string
  resultPath: string
  coverage?: CoverageSummary
  coverageDataPath?: string
  coverageReportPath?: string
  /** Cocotb 模式本次产出的 JUnit XML 路径（未产出时为 null）；供 scenario→测试绑定解析 */
  resultsXmlPath?: string | null
  /** 本次生效的波形体积阈值（GB） */
  maxWaveformGB?: number
  /** 波形体积熔断已触发：cpp 模式=TB 内停止 dump、仿真继续；cocotb 模式=终止整个仿真 */
  waveformAborted?: boolean
  /** 熔断原因（当前仅 'size-limit'） */
  waveformAbortedReason?: 'size-limit'
  /** 外部自带 C++ TB（无 TB 内熔断标记）波形已超限但未能受控停止的诚实标记 */
  waveformOverLimitUncontrolled?: boolean
  /** 缺陷 DEFECT-PACK-001#17：本次失败结果写入前被旁路归档的既有成功 result.json 路径（未归档时无此字段） */
  archivedResultPath?: string
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
  rtlCoverage?: boolean
  functionalCoverageFile?: string
  /** 波形体积阈值（GB），缺省 10；也可经环境变量 MOONGLASS_MAX_WAVEFORM_GB 覆盖 */
  maxWaveformGB?: number
}

interface CoveragePointCount { total: number; covered: number }

function percentage(count?: CoveragePointCount): number | undefined {
  return count && count.total > 0 ? Number(((count.covered / count.total) * 100).toFixed(2)) : undefined
}

/** 直接解析 Verilator coverage.dat，避免依赖平台相关的 Perl wrapper。
 * 口径声明：Verilator（含 5.x）无独立 branch/condition 插桩类型，if/else 条件以
 * expr 检测点（条件求值点）记录，VerilatedCov 也不记录真假双向取值。因此
 * branchCoverage 取 branch ?? expression 时是【表达式求值口径】——最接近条件覆盖的
 * 可用度量，但不是 MC/DC 级操作数覆盖；签核文档不得宣称 MC/DC。 */
export function parseVerilatorCoverage(path: string): CoverageSummary {
  if (!existsSync(path)) return {}
  const counts = new Map<string, CoveragePointCount>()
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const type = /\x01t\x02([^\x01']+)/.exec(line)?.[1]
    const hits = /'\s+(\d+)\s*$/.exec(line)?.[1]
    if (!type || hits === undefined) continue
    const count = counts.get(type) ?? { total: 0, covered: 0 }
    count.total += 1
    if (Number(hits) > 0) count.covered += 1
    counts.set(type, count)
  }
  const branch = counts.get('branch')
  const expression = counts.get('expr')
  const fsmState = counts.get('fsm_state')
  const fsmArc = counts.get('fsm_arc')
  const fsm = fsmState || fsmArc ? {
    total: (fsmState?.total ?? 0) + (fsmArc?.total ?? 0),
    covered: (fsmState?.covered ?? 0) + (fsmArc?.covered ?? 0)
  } : undefined
  return {
    lineCoverage: percentage(counts.get('line')),
    branchCoverage: percentage(branch ?? expression),
    expressionCoverage: percentage(expression),
    toggleCoverage: percentage(counts.get('toggle')),
    fsmCoverage: percentage(fsm)
  }
}

/** 参与明细解析的检测点类型（coverage.dat 的 \x01t 取值白名单） */
const COVERAGE_DETAIL_KINDS = new Set<CoveragePointDetail['kind']>(['line', 'branch', 'expr', 'toggle', 'fsm_state', 'fsm_arc'])

/**
 * 解析 Verilator coverage.dat 的逐检测点明细：额外捕获文件、行列、语义、层级与命中次数字段，
 * 按源码文件分组；summary 与 parseVerilatorCoverage 同口径聚合（branch 缺失时由 expr 顶替，
 * fsm 为 fsm_state 与 fsm_arc 之和）。文件不存在或无记录时返回 null，不抛异常。
 */
export function parseVerilatorCoverageDetail(path: string): CoverageDetailResult | null {
  if (!existsSync(path)) return null
  const byFile = new Map<string, CoveragePointDetail[]>()
  const counts = new Map<string, CoveragePointCount>()
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const type = /\x01t\x02([^\x01']+)/.exec(line)?.[1]
    const hitsText = /'\s+(\d+)\s*$/.exec(line)?.[1]
    if (!type || hitsText === undefined || !COVERAGE_DETAIL_KINDS.has(type as CoveragePointDetail['kind'])) continue
    const file = /\x01f\x02([^\x01']+)/.exec(line)?.[1]
    const lineNo = /\x01l\x02(\d+)/.exec(line)?.[1]
    if (!file || lineNo === undefined) continue
    const point: CoveragePointDetail = { line: Number(lineNo), kind: type as CoveragePointDetail['kind'], hits: Number(hitsText) }
    const column = /\x01n\x02(\d+)/.exec(line)?.[1]
    if (column !== undefined) point.column = Number(column)
    const origin = /\x01o\x02([^\x01']+)/.exec(line)?.[1]
    if (origin !== undefined) point.origin = origin
    const hierarchy = /\x01h\x02([^\x01']+)/.exec(line)?.[1]
    if (hierarchy !== undefined) point.hierarchy = hierarchy
    const points = byFile.get(file) ?? []
    points.push(point)
    byFile.set(file, points)
    const count = counts.get(type) ?? { total: 0, covered: 0 }
    count.total += 1
    if (point.hits > 0) count.covered += 1
    counts.set(type, count)
  }
  if (byFile.size === 0) return null
  const branch = counts.get('branch')
  const expression = counts.get('expr')
  const fsmState = counts.get('fsm_state')
  const fsmArc = counts.get('fsm_arc')
  const fsm = fsmState || fsmArc ? {
    total: (fsmState?.total ?? 0) + (fsmArc?.total ?? 0),
    covered: (fsmState?.covered ?? 0) + (fsmArc?.covered ?? 0)
  } : undefined
  return {
    generatedAt: new Date().toISOString(),
    files: [...byFile.entries()].map(([file, points]) => ({ file, points })),
    summary: {
      line: percentage(counts.get('line')),
      branch: percentage(branch ?? expression),
      expression: percentage(expression),
      toggle: percentage(counts.get('toggle')),
      fsm: percentage(fsm)
    }
  }
}

function readFunctionalCoverage(path: string): number | undefined {
  if (!existsSync(path)) return undefined
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    for (const key of ['functionalCoverage', 'functional_coverage', 'coverage', 'percent']) {
      if (typeof data[key] === 'number') return data[key] as number
    }
    const total = Number(data.totalBins ?? 0)
    const covered = Number(data.coveredBins ?? 0)
    return total > 0 ? Number(((covered / total) * 100).toFixed(2)) : undefined
  } catch { return undefined }
}

function readResult(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try { return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown> } catch { return {} }
}

/**
 * RTL 输入内容哈希（路径 + 内容）：识别 result.json 里的旧覆盖率/通道结论是否属于
 * 同一 RTL 输入。RTL 变更后旧数据一律不得继承——否则旧 RTL 的覆盖率会被盖上当前
 * rtlHash 混入门禁判定（陈旧 PASS 污染防线，与引擎 rtlHash 新鲜度同口径）。
 */
function hashRtlInputs(rtlFiles: string[]): string {
  const hash = createHash('sha256')
  for (const file of [...rtlFiles].sort()) {
    hash.update(file).update('\0')
    try { hash.update(readFileSync(file)) } catch { /* 缺文件由调用方前置校验拦截 */ }
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * 缺陷 DEFECT-PACK-001#17 主 result.json 防覆盖：本次写入 passed=false 而既有文件
 * passed=true 时，先把既有成功证据旁路归档为 result.pass-<时间戳>.json 再写入，
 * 保证黄金证据可追溯；失败覆盖失败、成功覆盖成功直接写。返回归档路径（未归档为 null）。
 */
function archivePassedResult(resultPath: string, previous: Record<string, unknown>): string | null {
  if (previous.passed !== true || !existsSync(resultPath)) return null
  const archivePath = join(dirname(resultPath), `result.pass-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  try {
    renameSync(resultPath, archivePath)
    return archivePath
  } catch { return null }
}

function writeCoverageReport(resultDir: string, coverage: CoverageSummary, dataPath?: string): string {
  const reportPath = join(resultDir, 'coverage_report.md')
  const jsonPath = join(resultDir, 'coverage.json')
  writeFileSync(jsonPath, JSON.stringify({ ...coverage, coverageDataPath: dataPath ?? null, generatedAt: new Date().toISOString() }, null, 2), 'utf-8')
  // 同步落盘逐检测点明细，供验证态势页「覆盖率明细」视图直接消费（含 generatedAt）
  if (dataPath) {
    const detail = parseVerilatorCoverageDetail(dataPath)
    if (detail) writeFileSync(join(resultDir, 'coverage-detail.json'), JSON.stringify(detail, null, 2), 'utf-8')
  }
  const rows = [
    ['行/基本块', coverage.lineCoverage], ['条件（表达式求值口径，非 MC/DC）', coverage.branchCoverage],
    ['表达式', coverage.expressionCoverage], ['翻转', coverage.toggleCoverage],
    ['FSM', coverage.fsmCoverage], ['功能', coverage.functionalCoverage]
  ]
  writeFileSync(reportPath, `# 验证覆盖率报告\n\n| 类型 | 覆盖率 |\n|---|---:|\n${rows.map(([name, value]) => `| ${name} | ${typeof value === 'number' ? `${value}%` : '暂无'} |`).join('\n')}\n\n- 原始 RTL 覆盖率：${dataPath ?? '暂无'}\n- 机器可读结果：${jsonPath}\n`, 'utf-8')
  return reportPath
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

/** 使用 cocotb 2.x Python Runner 运行测试，并统一归档日志、JUnit、结果和波形。
 *
 * RTL 覆盖率仅 verilator 后端可采集（icarus 无插桩）。rtlCoverage 缺省开启且指定 icarus
 * 时，先尝试升级到 verilator；若本机 cocotb+verilator 构建阶段失败（工具链不可用），
 * 自动回退 icarus 完成功能回归——覆盖率升级不得打断功能验证，回痕写入返回日志。
 */
export async function runCocotbSimulation(options: CocotbSimOptions): Promise<VerilatorSimResult> {
  if ((options.simulator ?? 'icarus') === 'icarus' && options.rtlCoverage !== false && (await locateTool(VERILATOR_CANDIDATES))) {
    let upgraded: VerilatorSimResult & { buildStageFailed?: boolean }
    try {
      upgraded = await runCocotbSimulationOnce({ ...options, simulator: 'verilator', coverageUpgradeNote: true })
    } catch (error) {
      // verilator 工具链前置校验失败（缺 g++/make）：同样走 icarus 回退
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('Verilator Windows 仿真需要')) throw error
      upgraded = { buildStageFailed: true } as VerilatorSimResult & { buildStageFailed?: boolean }
    }
    if (!upgraded.buildStageFailed) {
      const { buildStageFailed: _ignored, ...result } = upgraded
      return result
    }
    const fallback = await runCocotbSimulationOnce({ ...options, simulator: 'icarus', rtlCoverage: false })
    return {
      ...fallback,
      log: `[note] RTL 覆盖率需 verilator 后端，但本机 cocotb+verilator 构建失败，已回退 icarus 完成功能回归（本次无 RTL 覆盖率）\n${fallback.log}`
    }
  }
  return runCocotbSimulationOnce(options)
}

/** cocotb 单次运行实现。coverageUpgradeNote=true 时在编译日志留痕"icarus 升级 verilator"；
 *  返回附 buildStageFailed（runner.build 阶段失败），供上层决定是否回退后端。 */
async function runCocotbSimulationOnce(options: CocotbSimOptions & { coverageUpgradeNote?: boolean }): Promise<VerilatorSimResult & { buildStageFailed?: boolean }> {
  const simulator = options.simulator ?? 'icarus'
  const rtlCoverage = simulator === 'verilator' && options.rtlCoverage !== false
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
  const compileLogPath = join(options.resultDir, `compile_${simulator}.log`)
  const simulationLogPath = join(options.resultDir, `simulation_${simulator}.log`)
  const resultPath = join(options.resultDir, 'result.json')
  // JUnit 文件名带 testModule（消毒为文件名安全字符），避免不同测试模块的多次
  // run_simulation 互相覆盖只剩最后一次结果；无 testModule 时保留旧名兼容。
  const testModuleSlug = options.testModule ? options.testModule.replace(/[^A-Za-z0-9_.-]+/g, '_') : ''
  const resultsXml = join(options.resultDir, testModuleSlug ? `results_${simulator}_${testModuleSlug}.xml` : `results_${simulator}.xml`)
  const coverageDataPath = join(options.resultDir, 'coverage.dat')
  const functionalCoveragePath = resolve(options.functionalCoverageFile ?? join(options.resultDir, 'functional_coverage.json'))
  const compilerPath = simulator === 'verilator' && process.platform === 'win32' ? await locateTool(['g++.exe', 'g++']) : null
  const makePath = simulator === 'verilator' && process.platform === 'win32' ? await locateTool(['mingw32-make.exe', 'gmake.exe', 'make.exe']) : null
  if (simulator === 'verilator' && process.platform === 'win32' && (!compilerPath || !makePath)) {
    throw new Error('Verilator Windows 仿真需要 g++ 和 mingw32-make/gmake；请在“设置 > 工具链”安装 C/C++ 编译器与 Make')
  }
  const buildArgs = rtlCoverage ? ['--coverage-line', '--coverage-expr', '--coverage-toggle', '--coverage-fsm'] : []
  const plusargs = rtlCoverage ? [`+verilator+coverage+file+${coverageDataPath.replace(/\\/g, '/')}`] : []
  const script = [
    'from cocotb_tools.runner import get_runner',
    `runner = get_runner(${JSON.stringify(simulator)})`,
    ...(simulator === 'verilator' && process.platform === 'win32' ? [
      'import shutil',
      '_mg_original_which = shutil.which',
      `_mg_verilator_bin = ${JSON.stringify(simulatorPath)}`,
      `_mg_make_bin = ${JSON.stringify(makePath)}`,
      'shutil.which = lambda name: _mg_verilator_bin if name == "verilator" else _mg_original_which(name)',
      '_mg_original_build_command = runner._build_command',
      'def _mg_build_command():',
      '    commands = _mg_original_build_command()',
      '    commands[0] = [_mg_verilator_bin] + commands[0][2:]',
      '    commands[1][0] = _mg_make_bin',
      '    return commands',
      'runner._build_command = _mg_build_command'
    ] : []),
    `runner.build(sources=${JSON.stringify(options.rtlFiles)}, hdl_toplevel=${JSON.stringify(options.topModule)}, build_dir=${JSON.stringify(options.buildDir)}, always=True, waves=${options.waves !== false ? 'True' : 'False'}, timescale=('1ns', '1ps'), build_args=${JSON.stringify(buildArgs)})`,
    'print("__MOONGLASS_BUILD_DONE__", flush=True)',
    `runner.test(hdl_toplevel=${JSON.stringify(options.topModule)}, test_module=${JSON.stringify(options.testModule)}, testcase=${options.testcase ? JSON.stringify(options.testcase) : 'None'}, build_dir=${JSON.stringify(options.buildDir)}, test_dir=${JSON.stringify(options.resultDir)}, results_xml=${JSON.stringify(resultsXml)}, waves=${options.waves !== false ? 'True' : 'False'}, plusargs=${JSON.stringify(plusargs)})`
  ].join('\n')
  writeFileSync(runnerPath, script, 'utf-8')

  const env = toolEnv(simulatorPath)
  if (compilerPath) env.PATH = `${dirname(compilerPath)}${delimiter}${env.PATH ?? ''}`
  env.PYTHONPATH = `${resolve(options.testDir)}${delimiter}${env.PYTHONPATH ?? ''}`
  env.COCOTB_RESULTS_FILE = resultsXml
  env.MOONGLASS_FUNCTIONAL_COVERAGE_FILE = functionalCoveragePath
  if (simulator === 'icarus') {
    await checkIcarusToolchain(simulatorPath, options.buildDir, env, options.signal)
  }

  // 波形体积熔断（资源保护，非 wall-clock 超时）：cocotb 的波形开关由 runner 内部
  // 生成的 HDL wrapper 控制（$dumpvars 在仿真 0 时刻生效），外部进程无法只停 dump，
  // 因此 runner 侧监控产物体积，超限即终止整个仿真并诚实标记 waveformAborted。
  // 这是可接受的取舍：cocotb 主要用于定向用例，超巨波形已无调试价值。
  const maxWaveformGB = resolveMaxWaveformGB(options.maxWaveformGB)
  const wavesEnabled = options.waves !== false
  // 陈旧 coverage.dat 防线：运行前记录 mtime，运行后只有本次真正重写过的 coverage.dat
  // 才解析——否则历史 cpp 运行遗留的 coverage.dat 会被当作本次（未插桩/失败）运行的覆盖率
  const coverageMtimeBefore = existsSync(coverageDataPath) ? statSync(coverageDataPath).mtimeMs : 0
  const guardAbort = new AbortController()
  if (options.signal) {
    if (options.signal.aborted) guardAbort.abort()
    else options.signal.addEventListener('abort', () => guardAbort.abort(), { once: true })
  }
  let waveformAborted = false
  const waveformMonitor = wavesEnabled
    ? monitorWaveformSize([options.buildDir, options.resultDir], maxWaveformGB * 1073741824, () => {
        waveformAborted = true
        guardAbort.abort()
      })
    : undefined

  const execution = await run(
    python,
    [runnerPath],
    env,
    guardAbort.signal,
    resolve(options.testDir),
    options.timeoutSec === undefined ? 0 : Math.max(1, options.timeoutSec) * 1000
  )
  waveformMonitor?.stop()
  // 熔断是否实际生效以“进程被终止”为准：若触发时仿真已自然结束（退出码 0，
  // 例如 FST 缓冲区仅在收尾 flush 才超阈值），诚实降级为“超限未实际终止”，不假装熔断成功。
  const waveformAbortedEffective = waveformAborted && execution.code !== 0
  const waveformOverLimitUncontrolled = waveformAborted && !waveformAbortedEffective
  const output = [execution.stdout, execution.stderr].filter(Boolean).join('\n')
  const marker = output.indexOf('__MOONGLASS_BUILD_DONE__')
  // 缺陷 DEFECT-PACK-001#10：cocotb 的编译发生在 runner.build() 阶段（icarus 由其内部
  // make 流程统一编译），与仿真同属一次 python 进程输出，按 __MOONGLASS_BUILD_DONE__
  // 标记切分；编译段为空时写明确说明行，保证 compile 日志非空且内容真实对应编译阶段。
  const buildSegment = marker >= 0 ? output.slice(0, marker) : output
  const simSegment = marker >= 0 ? output.slice(marker + '__MOONGLASS_BUILD_DONE__'.length) : ''
  writeFileSync(
    compileLogPath,
    [
      `[compile] cocotb runner.build(simulator=${simulator}, sources=${options.rtlFiles.length} 个 RTL 文件, build_dir=${options.buildDir})`,
      ...(options.coverageUpgradeNote
        ? [`[note] 请求 icarus 但 RTL 覆盖率需 verilator 后端：已自动升级 simulator=verilator（icarus 无覆盖率插桩）`]
        : []),
      buildSegment.trim()
        ? buildSegment.trimEnd()
        : `编译由 cocotb runner.build 统一执行且未产生独立编译输出，详见 ${basename(simulationLogPath)}`
    ].join('\n'),
    'utf-8'
  )
  writeFileSync(simulationLogPath, simSegment.trim() ? simSegment : output, 'utf-8')
  // 缺陷 DEFECT-PACK-001#10：compileExitCode 反映本次真实编译步骤结果——build 完成标记
  // 出现即编译成功（0）；未出现说明进程未走完编译阶段，记真实进程退出码。不得从
  // previous 继承历史失败退出码（曾出现 84/84 PASS 的回归携带 compileExitCode: 2）。
  const compileExitCode = marker >= 0 ? 0 : execution.code

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
  const coverage = rtlCoverage && existsSync(coverageDataPath) && statSync(coverageDataPath).mtimeMs > coverageMtimeBefore
    ? parseVerilatorCoverage(coverageDataPath)
    : {}
  // percentage() 可能返回全 undefined 的对象，以"存在数值字段"判定本次是否真采到覆盖率
  const freshCoverageData = Object.values(coverage).some((value) => typeof value === 'number')
  coverage.functionalCoverage = readFunctionalCoverage(functionalCoveragePath)
  const previous = readResult(resultPath)
  const rtlInputHash = hashRtlInputs(options.rtlFiles)
  // 陈旧 PASS 污染防线：旧覆盖率、旧 coverageDataPath、旧 RTL 覆盖率通道结论只在
  // 同一 RTL 输入（rtlInputHash 一致）时才继承；RTL 变更后一律丢弃，强制该通道重跑
  const previousIsCurrentRtl = typeof previous.rtlInputHash === 'string' && previous.rtlInputHash === rtlInputHash
  const previousCoverage = (previousIsCurrentRtl ? previous.coverage ?? {} : {}) as CoverageSummary
  const mergedCoverage = { ...previousCoverage, ...Object.fromEntries(Object.entries(coverage).filter(([, value]) => value !== undefined)) }
  const hasMergedCoverage = Object.values(mergedCoverage).some((value) => typeof value === 'number')
  const coverageReportPath = hasMergedCoverage ? writeCoverageReport(options.resultDir, mergedCoverage, freshCoverageData ? coverageDataPath : (previousIsCurrentRtl ? previous.coverageDataPath as string | undefined : undefined)) : undefined
  const rtlCoveragePassed = previousIsCurrentRtl ? previous.rtlCoveragePassed : undefined
  const overallPassed = rtlCoveragePassed === undefined ? passed : passed && rtlCoveragePassed === true
  // 缺陷 DEFECT-PACK-001#17：失败结果不得直接覆盖既有成功证据
  const archivedResultPath = overallPassed ? null : archivePassedResult(resultPath, previous)
  writeFileSync(resultPath, JSON.stringify({
    ...previous,
    passed: overallPassed,
    functionalPassed: passed,
    // 显式覆写（undefined 经 JSON 序列化丢弃）：防止 ...previous 把旧 RTL 的通道结论带回来
    rtlCoveragePassed,
    framework: 'cocotb',
    simulator,
    topModule: options.topModule,
    testModule: options.testModule,
    testcase: options.testcase ?? null,
    compileExitCode,
    runExitCode: execution.code,
    testsTotal,
    testsPassed,
    testsFailed,
    testsSkipped,
    waveformPath,
    compileLogPath,
    simulationLogPath,
    functionalCompileLogPath: compileLogPath,
    functionalSimulationLogPath: simulationLogPath,
    resultsXml: existsSync(resultsXml) ? resultsXml : null,
    maxWaveformGB: wavesEnabled ? maxWaveformGB : null,
    waveformAborted: waveformAbortedEffective,
    waveformAbortedReason: waveformAbortedEffective ? 'size-limit' : null,
    waveformOverLimitUncontrolled,
    coverage: hasMergedCoverage ? mergedCoverage : undefined,
    lineCoverage: mergedCoverage.lineCoverage,
    branchCoverage: mergedCoverage.branchCoverage,
    functionalCoverage: mergedCoverage.functionalCoverage,
    rtlInputHash,
    coverageDataPath: freshCoverageData ? coverageDataPath : previousIsCurrentRtl ? previous.coverageDataPath ?? null : null,
    coverageReportPath: coverageReportPath ?? null,
    finishedAt: new Date().toISOString()
  }, null, 2), 'utf-8')
  return {
    passed: overallPassed,
    log: output.slice(-6000) || '(无输出)',
    vcdPath: waveformPath,
    compileLogPath,
    simulationLogPath,
    resultPath,
    maxWaveformGB: wavesEnabled ? maxWaveformGB : undefined,
    waveformAborted: waveformAbortedEffective || undefined,
    waveformAbortedReason: waveformAbortedEffective ? 'size-limit' : undefined,
    waveformOverLimitUncontrolled: waveformOverLimitUncontrolled || undefined,
    coverage: hasMergedCoverage ? mergedCoverage : undefined,
    coverageDataPath: freshCoverageData ? coverageDataPath : undefined,
    coverageReportPath,
    resultsXmlPath: existsSync(resultsXml) ? resultsXml : null,
    buildStageFailed: marker < 0,
    ...(archivedResultPath ? { archivedResultPath } : {})
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
  const rtlCoverage = options.rtlCoverage !== false
  // 波形体积阈值（资源保护，非 wall-clock 超时）。
  // TB 内熔断仅对含 generate_tb 注入标记（MOONGLASS_WAVEFORM_GUARD）的测试台生效：
  // TB 主循环周期 stat 波形文件，超限即 tfp->close() 并停止 dump，仿真继续。
  // 外部自带 TB 无法注入，退化为 runner 侧监控 + 超限后诚实标注“未受控”。
  const maxWaveformGB = resolveMaxWaveformGB(options.maxWaveformGB)
  let tbHasWaveformGuard = false
  try { tbHasWaveformGuard = trace && readFileSync(tbCpp, 'utf-8').includes(WAVEFORM_GUARD_MARKER) } catch { /* tbCpp 不可读时按无熔断处理 */ }

  const verilatorPath = await locateTool(VERILATOR_CANDIDATES)
  if (!verilatorPath) throw new Error('工具未找到: verilator')

  const objDir = options.buildDir ?? join(dirname(tbCpp), 'obj_dir')
  const binPath = join(objDir, `V${topModule}`)
  const binExe = process.platform === 'win32' ? `${binPath}.exe` : binPath
  const resultDir = options.resultDir ?? join(dirname(tbCpp), 'results', topModule)
  const compileLogPath = join(resultDir, 'compile_verilator.log')
  const simulationLogPath = join(resultDir, 'simulation_verilator.log')
  const resultPath = join(resultDir, 'result.json')
  const coverageDataPath = join(resultDir, 'coverage.dat')
  const coverageHookPath = join(objDir, 'moonglass_coverage_hook.cpp')
  mkdirSync(resultDir, { recursive: true })
  mkdirSync(objDir, { recursive: true })
  if (rtlCoverage) {
    writeFileSync(coverageHookPath, '#include <verilated_cov.h>\n#ifdef main\n#undef main\n#endif\nextern int moonglass_user_main(int argc, char** argv);\nint main(int argc, char** argv) {\n  const int result = moonglass_user_main(argc, argv);\n  VerilatedCov::write();\n  return result;\n}\n', 'utf-8')
  }

  // Step 1: verilator --cc (编译 RTL 到 C++)
  // 缺陷 DEFECT-PACK-001#6：非 ASCII（如中文）项目路径下，Verilator（mingw/ANSI 运行时）
  // 会把用户 .cpp 的绝对路径按 GBK 写入生成的 .mk 依赖行，而 MSYS2 make 按 UTF-8 读取，
  // 路径错乱导致 "No rule to make target" 必败。对策（用户建议方案）：用户 .cpp 与 RTL
  // 一律转为相对 objDir 的相对路径（统一正斜杠），并以 objDir 为 cwd 执行 verilator；
  // 覆盖率 hook 就在 objDir 内，用纯文件名。RTL .v 虽不进 .mk 依赖，同口径处理避免
  // Verilator 诊断信息内嵌 GBK 绝对路径。cocotb 路径不经过本函数，不受影响。
  const toObjRelative = (p: string): string => relative(objDir, resolve(p)).replace(/\\/g, '/')
  const hasNonAsciiPath = [objDir, tbCpp, ...rtlFiles].some((p) => /[^\x00-\x7F]/.test(p))
  const ccArgs = [
    '--cc',
    '--build',
    '--exe',
    '-Wno-fatal',
    '--Mdir',
    objDir,
    ...(trace ? ['--trace'] : []),
    ...(rtlCoverage ? ['--coverage-line', '--coverage-expr', '--coverage-toggle', '--coverage-fsm', '-CFLAGS', '-Dmain=moonglass_user_main', basename(coverageHookPath)] : []),
    toObjRelative(tbCpp),
    ...rtlFiles.map(toObjRelative)
  ]
  const verilatorEnv = toolEnv(verilatorPath)
  if (process.platform === 'win32') {
    const compilerPath = await locateTool(['g++.exe', 'g++'])
    if (!compilerPath) throw new Error('Verilator Windows 仿真需要 g++；请在“设置 > 工具链”安装 C/C++ 编译器')
    verilatorEnv.PATH = `${dirname(compilerPath)}${delimiter}${verilatorEnv.PATH ?? ''}`
  }

  const { stdout: ccOut, stderr: ccErr, code: ccCode } = await run(
    verilatorPath,
    ccArgs,
    verilatorEnv,
    signal,
    // 缺陷 DEFECT-PACK-001#6：以 objDir 为 cwd，上述相对路径参数才能解析
    objDir
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
    // 缺陷 DEFECT-PACK-001#17：编译失败的 passed=false 不得直接覆盖既有成功证据
    const archivedResultPath = archivePassedResult(resultPath, readResult(resultPath))
    writeFileSync(resultPath, JSON.stringify(failed, null, 2), 'utf-8')
    // 缺陷 DEFECT-PACK-001#6：相对路径改造后仍失败且路径含非 ASCII 时，明确指向路径编码
    // 残留风险（如 TB/hook 之外的自定义 --include 或 Verilator 版本差异），不静默失败
    const encodingHint = hasNonAsciiPath
      ? '\n提示：项目路径包含非 ASCII 字符。Verilator(mingw) 按 GBK 写 .mk 依赖而 MSYS2 make 按 UTF-8 读取，若日志出现 "No rule to make target" 或乱码路径，属路径编码错位；请将工作区/构建目录迁移到纯 ASCII 路径后重试。'
      : ''
    return {
      passed: false,
      log: `Verilator 编译失败 (code=${ccCode}):\n${ccErr.slice(0, 2000)}${encodingHint}`,
      vcdPath: null,
      compileLogPath,
      simulationLogPath,
      resultPath,
      ...(archivedResultPath ? { archivedResultPath } : {})
    }
  }

  // Step 2: 运行仿真
  if (!existsSync(binExe)) {
    writeFileSync(simulationLogPath, `仿真可执行文件未找到: ${binExe}\n`, 'utf-8')
    // 缺陷 DEFECT-PACK-001#17：失败结果不得直接覆盖既有成功证据
    const archivedResultPath = archivePassedResult(resultPath, readResult(resultPath))
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
      resultPath,
      ...(archivedResultPath ? { archivedResultPath } : {})
    }
  }

  // 测试台通常用相对路径创建 VCD；必须在结果目录运行，确保波形位置稳定。
  // TB 内熔断经环境变量把阈值传给测试台（TB 内 getenv 读取，见 generate_tb 模板）。
  if (tbHasWaveformGuard) verilatorEnv.MOONGLASS_MAX_WAVEFORM_GB = String(maxWaveformGB)
  // 外部自带 TB：runner 侧只监控不干预，超限仅留痕（诚实声明“未受控”，不假装熔断）。
  let waveformOverLimitUncontrolled = false
  const waveformMonitor = trace && !tbHasWaveformGuard
    ? monitorWaveformSize([resultDir], maxWaveformGB * 1073741824, () => { waveformOverLimitUncontrolled = true })
    : undefined
  // 陈旧 coverage.dat 防线：与 cocotb 路径同口径——只有本次仿真重写过的 coverage.dat 才解析
  const coverageMtimeBefore = existsSync(coverageDataPath) ? statSync(coverageDataPath).mtimeMs : 0
  const { stdout: runOut, stderr: runErr, code: runCode } = await run(
    binExe,
    // 缺陷 DEFECT-PACK-001#6：仿真以 resultDir 为 cwd，覆盖率文件用纯文件名——
    // Verilated 运行时（mingw/ANSI fopen）同样无法处理非 ASCII 绝对路径
    rtlCoverage ? [`+verilator+coverage+file+${basename(coverageDataPath)}`] : [],
    verilatorEnv,
    signal,
    resultDir,
    0
  )
  // 外部 TB 只监控不干预：收尾采样也回调，捕捉最后间隔内的超限
  waveformMonitor?.stop(true)

  const log = [runOut, runErr].filter(Boolean).join('\n')
  // TB 内熔断触发时会在日志打印停止令牌；据此在 result.json 留痕，PASS/FAIL 语义不变。
  const waveformAborted = tbHasWaveformGuard && log.includes(WAVEFORM_GUARD_STOP_TOKEN)
  writeFileSync(
    simulationLogPath,
    [`[executable] ${binExe}`, `[exitCode] ${runCode}`, '', runOut, runErr].join('\n'),
    'utf-8'
  )
  const vcdPath = trace ? join(resultDir, `${topModule}.vcd`) : null
  const resolvedVcd = vcdPath && existsSync(vcdPath) ? vcdPath : null
  const passed = runCode === 0 || runCode === null
  const coverage = rtlCoverage && existsSync(coverageDataPath) && statSync(coverageDataPath).mtimeMs > coverageMtimeBefore
    ? parseVerilatorCoverage(coverageDataPath)
    : {}
  const freshCoverageData = Object.values(coverage).some((value) => typeof value === 'number')
  const previous = readResult(resultPath)
  const rtlInputHash = hashRtlInputs(rtlFiles)
  // 陈旧 PASS 污染防线：与 cocotb 路径同口径——旧覆盖率与旧功能通道结论只在
  // 同一 RTL 输入（rtlInputHash 一致）时继承；RTL 变更后丢弃，强制功能通道重跑
  const previousIsCurrentRtl = typeof previous.rtlInputHash === 'string' && previous.rtlInputHash === rtlInputHash
  const previousCoverage = (previousIsCurrentRtl ? previous.coverage ?? {} : {}) as CoverageSummary
  const mergedCoverage = { ...previousCoverage, ...Object.fromEntries(Object.entries(coverage).filter(([, value]) => value !== undefined)) }
  const hasMergedCoverage = Object.values(mergedCoverage).some((value) => typeof value === 'number')
  const coverageReportPath = hasMergedCoverage ? writeCoverageReport(resultDir, mergedCoverage, freshCoverageData ? coverageDataPath : undefined) : undefined
  const functionalPassed = previousIsCurrentRtl ? previous.functionalPassed ?? previous.passed : undefined
  const overallPassed = functionalPassed === undefined ? passed : functionalPassed === true && passed
  // 缺陷 DEFECT-PACK-001#17：失败结果不得直接覆盖既有成功证据
  const archivedResultPath = overallPassed ? null : archivePassedResult(resultPath, previous)
  writeFileSync(resultPath, JSON.stringify({
    ...previous,
    passed: overallPassed,
    rtlCoveragePassed: passed,
    topModule,
    compileExitCode: ccCode,
    runExitCode: runCode,
    waveformPath: resolvedVcd,
    maxWaveformGB: trace ? maxWaveformGB : null,
    waveformAborted,
    waveformAbortedReason: waveformAborted ? 'size-limit' : null,
    waveformOverLimitUncontrolled,
    compileLogPath,
    simulationLogPath,
    rtlCompileLogPath: compileLogPath,
    rtlSimulationLogPath: simulationLogPath,
    coverage: hasMergedCoverage ? mergedCoverage : undefined,
    lineCoverage: mergedCoverage.lineCoverage,
    branchCoverage: mergedCoverage.branchCoverage,
    functionalCoverage: mergedCoverage.functionalCoverage,
    rtlInputHash,
    coverageDataPath: freshCoverageData ? coverageDataPath : previousIsCurrentRtl ? previous.coverageDataPath ?? null : null,
    coverageReportPath: coverageReportPath ?? null,
    finishedAt: new Date().toISOString()
  }, null, 2), 'utf-8')

  return {
    passed: overallPassed,
    log: log.slice(0, 4000) || '(无输出)',
    vcdPath: resolvedVcd,
    compileLogPath,
    simulationLogPath,
    resultPath,
    maxWaveformGB: trace ? maxWaveformGB : undefined,
    waveformAborted: waveformAborted || undefined,
    waveformAbortedReason: waveformAborted ? 'size-limit' : undefined,
    waveformOverLimitUncontrolled: waveformOverLimitUncontrolled || undefined,
    coverage: hasMergedCoverage ? mergedCoverage : undefined,
    coverageDataPath: freshCoverageData ? coverageDataPath : undefined,
    coverageReportPath,
    ...(archivedResultPath ? { archivedResultPath } : {})
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
