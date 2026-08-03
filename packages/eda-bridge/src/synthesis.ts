/**
 * Yosys 可综合性检查与逻辑综合封装
 *
 * checkSynthesizability（Phase 3 真实现）：
 *   yosys -p 'read_verilog -sv <files...>; hierarchy -auto-top; check; stat'
 *   解析 ERROR / Warning 行与 stat 统计为结构化结果。
 * Phase 6：
 *   - generateSdc：生成基础时钟与 I/O 约束。
 *   - runLogicSynthesis：输出 Yosys 网表、JSON、日志和结构化综合报告。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { locateTool, run, toolEnv, YOSYS_CANDIDATES } from './tool-runner'

export interface SynthesisIssue {
  severity: 'error' | 'warning'
  module?: string
  message: string
}

export interface ResourceEstimate {
  cells?: number
  wires?: number
  memories?: number
}

export interface SynthesizabilityResult {
  synthesizable: boolean
  issues: SynthesisIssue[]
  resourceEstimate: ResourceEstimate
}

export interface SynthCheckOptions {
  rtlFiles: string[]
  /** 仅声明端口的宏/库 Verilog，以 read_verilog -lib 读入。 */
  libraryFiles?: string[]
  /** 预留：指定顶层模块；缺省时 hierarchy -auto-top 自动识别 */
  topModule?: string
}

const YOSYS_ERROR = /^ERROR:\s*(.+)$/
const YOSYS_WARNING = /^Warning:\s*(.+)$/
// yosys 0.67 stat 表格式："        6 wires" / "        2 cells"
const STAT_NUMBER = /^\s*(\d+)\s+(wires|cells|memories)\s*$/

export async function checkSynthesizability(
  options: SynthCheckOptions
): Promise<SynthesizabilityResult> {
  const yosysPath = await locateTool(YOSYS_CANDIDATES)
  if (!yosysPath) throw new Error('工具未找到: yosys')

  const libraryCmd = options.libraryFiles?.length
    ? `read_verilog -sv -lib ${options.libraryFiles.map((f) => `"${f}"`).join(' ')}; `
    : ''
  const readCmd = `read_verilog -sv ${options.rtlFiles.map((f) => `"${f}"`).join(' ')}`
  const topCmd = options.topModule ? `hierarchy -top ${options.topModule}` : 'hierarchy -auto-top'
  const script = `${libraryCmd}${readCmd}; ${topCmd}; check; stat`

  const { stdout, stderr, code } = await run(yosysPath, ['-p', script], toolEnv(yosysPath))

  const issues: SynthesisIssue[] = []
  const resourceEstimate: ResourceEstimate = {}

  for (const raw of (stdout + '\n' + stderr).split(/\r?\n/)) {
    const line = raw.trim()
    const errMatch = YOSYS_ERROR.exec(line)
    if (errMatch) {
      issues.push({ severity: 'error', message: errMatch[1] })
      continue
    }
    const warnMatch = YOSYS_WARNING.exec(line)
    if (warnMatch) {
      issues.push({ severity: 'warning', message: warnMatch[1] })
      continue
    }
    const statMatch = STAT_NUMBER.exec(line)
    if (statMatch) {
      const value = Number(statMatch[1])
      if (statMatch[2] === 'cells') resourceEstimate.cells = value
      else if (statMatch[2] === 'wires') resourceEstimate.wires = value
      else if (statMatch[2] === 'memories') resourceEstimate.memories = value
    }
  }

  // 非零退出但未解析到 ERROR 行时，兜底为通用错误（防止加载失败被误判为可综合）
  const hasParsedError = issues.some((i) => i.severity === 'error')
  if (code !== null && code !== 0 && !hasParsedError) {
    issues.push({
      severity: 'error',
      message: `yosys 异常退出 (code=${code}): ${stderr.trim().split(/\r?\n/).pop() ?? ''}`
    })
  }

  return {
    synthesizable: !issues.some((i) => i.severity === 'error') && code === 0,
    issues,
    resourceEstimate
  }
}

export interface LogicSynthesisOptions {
  rtlFiles: string[]
  /** SRAM/ROM 等 blackbox 声明文件，不展开为逻辑。 */
  libraryFiles?: string[]
  topModule: string
  outputDir: string
  sdcFile?: string
  targetLibrary?: string
  effort?: 'low' | 'medium' | 'high'
  outputName?: string
}

export interface ClockConstraint {
  name: string
  port: string
  periodNs: number
  dutyCycle?: number
  uncertaintyNs?: number
}

export interface IoDelayConstraint {
  direction: 'input' | 'output'
  ports: string[]
  delayNs: number
  clockName: string
}

export interface SdcGenerationOptions {
  clocks: ClockConstraint[]
  ioDelays?: IoDelayConstraint[]
  outputPath?: string
}

export interface SdcGenerationResult {
  content: string
  filePath?: string
  warnings: string[]
}

export interface CellUsage {
  type: string
  count: number
}

export interface TimingEstimate {
  available: boolean
  delayNs?: number
  clockPeriodNs?: number
  slackNs?: number
  source: 'abc' | 'unavailable'
  message: string
}

export interface AreaEstimate {
  mode: 'liberty' | 'generic'
  value?: number
  cells: number
  cellUsage: CellUsage[]
  message: string
}

export interface LogicSynthesisResult {
  success: boolean
  netlistPath: string
  jsonPath: string
  logPath: string
  reportPath: string
  topModule: string
  targetLibrary?: string
  area: AreaEstimate
  timing: TimingEstimate
  warnings: string[]
}

export const DEFAULT_NANGATE45_LIBERTY =
  'D:/Projects/rtl_lib/Library/OpenROAD-flow-scripts/flow/platforms/nangate45/lib/NangateOpenCellLibrary_typical.lib'

function selectTargetLibrary(explicit?: string): string | undefined {
  if (explicit) {
    const selected = resolve(explicit)
    return existsSync(selected) ? selected : undefined
  }
  const configured = process.env.MOONGLASS_DEFAULT_LIBERTY?.trim()
  if (configured && existsSync(configured)) return resolve(configured)
  return existsSync(DEFAULT_NANGATE45_LIBERTY) ? resolve(DEFAULT_NANGATE45_LIBERTY) : undefined
}

function sdcNumber(value: number, label: string): string {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label}必须是非负有限数值`)
  return Number(value.toFixed(6)).toString()
}

function sdcPortList(ports: string[]): string {
  if (ports.length === 0) throw new Error('I/O 约束的 ports 不能为空')
  return ports.map((port) => port.replace(/[{}[\]]/g, '')).join(' ')
}

export function generateSdc(options: SdcGenerationOptions): SdcGenerationResult {
  if (options.clocks.length === 0) throw new Error('至少需要定义一个时钟')

  const warnings: string[] = []
  const lines = [
    '# Generated by MoonGlass',
    '# Units: ns',
    ''
  ]

  for (const clock of options.clocks) {
    if (!clock.name.trim() || !clock.port.trim()) throw new Error('时钟名称和端口不能为空')
    const period = sdcNumber(clock.periodNs, `时钟 ${clock.name} 的周期`)
    if (clock.periodNs === 0) throw new Error(`时钟 ${clock.name} 的周期必须大于 0`)
    const dutyCycle = clock.dutyCycle ?? 0.5
    if (dutyCycle <= 0 || dutyCycle >= 1) throw new Error(`时钟 ${clock.name} 的占空比必须在 0 到 1 之间`)
    const rise = 0
    const fall = sdcNumber(clock.periodNs * dutyCycle, `时钟 ${clock.name} 的下降沿`)
    lines.push(
      `create_clock -name ${clock.name} -period ${period} -waveform {${rise} ${fall}} [get_ports {${clock.port}}]`
    )
    if (clock.uncertaintyNs !== undefined) {
      lines.push(
        `set_clock_uncertainty ${sdcNumber(clock.uncertaintyNs, `时钟 ${clock.name} 的不确定度`)} [get_clocks {${clock.name}}]`
      )
    }
  }

  for (const delay of options.ioDelays ?? []) {
    const command = delay.direction === 'input' ? 'set_input_delay' : 'set_output_delay'
    lines.push(
      `${command} ${sdcNumber(delay.delayNs, `${delay.direction} 延迟`)} -clock [get_clocks {${delay.clockName}}] [get_ports {${sdcPortList(delay.ports)}}]`
    )
  }

  if ((options.ioDelays ?? []).length === 0) {
    warnings.push('未定义 I/O delay；当前 SDC 仅包含时钟约束')
  }

  lines.push('')
  const content = lines.join('\n')
  if (options.outputPath) {
    const outputPath = resolve(options.outputPath)
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, content, 'utf-8')
    return { content, filePath: outputPath, warnings }
  }
  return { content, warnings }
}

function yosysQuote(value: string): string {
  return `"${resolve(value).replace(/\\/g, '/').replace(/"/g, '\\"')}"`
}

function parseClockPeriod(sdcFile?: string): number | undefined {
  if (!sdcFile || !existsSync(sdcFile)) return undefined
  const content = readFileSync(sdcFile, 'utf-8')
  const match = /create_clock\b[^\r\n]*?-period\s+([0-9]+(?:\.[0-9]+)?)/i.exec(content)
  return match ? Number(match[1]) : undefined
}

function parseSynthesisStats(output: string): {
  cells: number
  cellUsage: CellUsage[]
  libertyArea?: number
  delayNs?: number
  warnings: string[]
} {
  let cells = 0
  let libertyArea: number | undefined
  let delayNs: number | undefined
  const usage = new Map<string, number>()
  const warnings: string[] = []

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    const cellsMatch = /^Number of cells:\s+(\d+)/i.exec(line) ?? /^(\d+)\s+cells$/i.exec(line)
    if (cellsMatch) cells = Number(cellsMatch[1])

    const usageMatch = /^(\S+)\s+(\d+)$/.exec(line)
    if (usageMatch && (/^\$_/.test(usageMatch[1]) || /^[A-Za-z][A-Za-z0-9_$.[\]-]*$/.test(usageMatch[1]))) {
      usage.set(usageMatch[1], Number(usageMatch[2]))
    }

    const areaMatch = /Chip area for (?:top )?module ['\\]*[^:]+:\s*([0-9]+(?:\.[0-9]+)?)/i.exec(line)
    if (areaMatch) libertyArea = Number(areaMatch[1])

    const delayMatch = /\bdelay\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*(ps|ns)?/i.exec(line)
    if (delayMatch) {
      const value = Number(delayMatch[1])
      delayNs = delayMatch[2]?.toLowerCase() === 'ps' ? value / 1000 : value
    }

    const warningMatch = /^Warning:\s*(.+)$/i.exec(line)
    if (warningMatch) warnings.push(warningMatch[1])
  }

  return {
    cells,
    cellUsage: [...usage.entries()]
      .map(([type, count]) => ({ type, count }))
      .sort((a, b) => b.count - a.count),
    libertyArea,
    delayNs,
    warnings
  }
}

export async function runLogicSynthesis(
  options: LogicSynthesisOptions
): Promise<LogicSynthesisResult> {
  if (options.rtlFiles.length === 0) throw new Error('rtlFiles 不能为空')
  if (!options.topModule.trim()) throw new Error('topModule 不能为空')
  for (const file of options.rtlFiles) {
    if (!existsSync(file)) throw new Error(`RTL 文件不存在: ${file}`)
  }
  for (const file of options.libraryFiles ?? []) {
    if (!existsSync(file)) throw new Error(`宏/库 Verilog 文件不存在: ${file}`)
  }
  if (options.sdcFile && !existsSync(options.sdcFile)) throw new Error(`SDC 文件不存在: ${options.sdcFile}`)
  const targetLibrary = selectTargetLibrary(options.targetLibrary)
  if (options.targetLibrary && !targetLibrary) {
    throw new Error(`Liberty 工艺库不存在: ${options.targetLibrary}`)
  }

  const yosysPath = await locateTool(YOSYS_CANDIDATES)
  if (!yosysPath) throw new Error('工具未找到: yosys')

  const outputDir = resolve(options.outputDir)
  mkdirSync(outputDir, { recursive: true })
  const outputName = options.outputName?.trim() || options.topModule
  const netlistPath = join(outputDir, `${outputName}_netlist.v`)
  const jsonPath = join(outputDir, `${outputName}.json`)
  const logPath = join(outputDir, `${outputName}_synthesis.log`)
  const reportPath = join(outputDir, `${outputName}_synthesis.md`)
  const clockPeriodNs = parseClockPeriod(options.sdcFile)

  const commands = [
    ...(options.libraryFiles?.length
      ? [`read_verilog -sv -lib ${options.libraryFiles.map(yosysQuote).join(' ')}`]
      : []),
    `read_verilog -sv ${options.rtlFiles.map(yosysQuote).join(' ')}`,
    `hierarchy -check -top ${options.topModule}`,
    'proc',
    'opt',
    'memory',
    'opt',
    `synth -top ${options.topModule}`
  ]

  if (targetLibrary) {
    commands.push(`dfflibmap -liberty ${yosysQuote(targetLibrary)}`)
    const delayTarget = clockPeriodNs ? ` -D ${Math.max(1, Math.round(clockPeriodNs * 1000))}` : ''
    commands.push(`abc -liberty ${yosysQuote(targetLibrary)}${delayTarget}`)
    commands.push('clean')
    commands.push(`stat -liberty ${yosysQuote(targetLibrary)}`)
  } else {
    commands.push('stat')
  }
  commands.push(`write_verilog -noattr ${yosysQuote(netlistPath)}`)
  commands.push(`write_json ${yosysQuote(jsonPath)}`)

  const result = await run(yosysPath, ['-p', commands.join('; ')], toolEnv(yosysPath))
  const combinedOutput = `${result.stdout}\n${result.stderr}`
  writeFileSync(logPath, combinedOutput, 'utf-8')

  if (result.code !== 0 || !existsSync(netlistPath)) {
    const tail = combinedOutput.trim().split(/\r?\n/).slice(-10).join('\n')
    throw new Error(`Yosys 综合失败 (code=${result.code})，日志: ${logPath}\n${tail}`)
  }

  const stats = parseSynthesisStats(combinedOutput)
  const timing: TimingEstimate = stats.delayNs !== undefined
    ? {
        available: true,
        delayNs: stats.delayNs,
        clockPeriodNs,
        slackNs: clockPeriodNs !== undefined ? clockPeriodNs - stats.delayNs : undefined,
        source: 'abc',
        message: clockPeriodNs !== undefined
          ? 'ABC 映射延迟估算；用于早期评估，不替代 STA 签核'
          : 'ABC 映射延迟估算；未提供有效时钟周期，无法计算 slack'
      }
    : {
        available: false,
        clockPeriodNs,
        source: 'unavailable',
        message: targetLibrary
          ? 'Yosys/ABC 未返回可解析延迟；请检查 Liberty 与综合日志'
          : '未提供 Liberty 工艺库，无法生成有意义的时序估算'
      }

  const area: AreaEstimate = targetLibrary
    ? {
        mode: 'liberty',
        value: stats.libertyArea,
        cells: stats.cells,
        cellUsage: stats.cellUsage,
        message: stats.libertyArea !== undefined
          ? `基于 ${basename(targetLibrary)} 的映射面积`
          : '已使用 Liberty 映射，但 Yosys 未返回可解析的面积值'
      }
    : {
        mode: 'generic',
        cells: stats.cells,
        cellUsage: stats.cellUsage,
        message: '通用 Yosys 单元数量，不代表具体工艺面积'
      }

  const report = [
    '# MoonGlass 逻辑综合报告',
    '',
    `- 顶层模块：\`${options.topModule}\``,
    `- RTL 文件：${options.rtlFiles.length} 个`,
    `- Blackbox 宏视图：${options.libraryFiles?.length ?? 0} 个`,
    `- SDC：${options.sdcFile ? `\`${resolve(options.sdcFile)}\`` : '未提供'}`,
    `- Liberty：${targetLibrary ? `\`${targetLibrary}\`` : '未提供（默认 Nangate45 库不可用）'}`,
    `- 网表：\`${netlistPath}\``,
    '',
    '## 面积',
    '',
    `- 单元数量：${area.cells}`,
    `- 映射面积：${area.value ?? '不可用'}`,
    `- 说明：${area.message}`,
    '- SRAM/ROM 宏面积与功耗：不包含在上述 Yosys 标准单元结果中，须按架构估算或宏数据手册分项合并',
    '',
    '## 时序',
    '',
    `- 估算延迟：${timing.delayNs !== undefined ? `${timing.delayNs} ns` : '不可用'}`,
    `- 时钟周期：${timing.clockPeriodNs !== undefined ? `${timing.clockPeriodNs} ns` : '未定义'}`,
    `- 估算 Slack：${timing.slackNs !== undefined ? `${timing.slackNs} ns` : '不可用'}`,
    `- 说明：${timing.message}`,
    '',
    '## 单元分布',
    '',
    ...(area.cellUsage.length > 0
      ? area.cellUsage.map((cell) => `- \`${cell.type}\`: ${cell.count}`)
      : ['- 无可解析单元分布']),
    '',
    '## 警告',
    '',
    ...(stats.warnings.length > 0 ? stats.warnings.map((warning) => `- ${warning}`) : ['- 无']),
    ''
  ].join('\n')
  writeFileSync(reportPath, report, 'utf-8')

  return {
    success: true,
    netlistPath,
    jsonPath,
    logPath,
    reportPath,
    topModule: options.topModule,
    targetLibrary,
    area,
    timing,
    warnings: stats.warnings
  }
}
