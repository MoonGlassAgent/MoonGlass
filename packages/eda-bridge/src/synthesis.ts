/**
 * Yosys 可综合性检查与逻辑综合封装
 *
 * checkSynthesizability（Phase 3 真实现）：
 *   yosys -p 'read_verilog -sv <files...>; hierarchy -auto-top; check; stat'
 *   解析 ERROR / Warning 行与 stat 统计为结构化结果。
 * runLogicSynthesis 仍为桩（Phase 6 范畴）。
 */

import { delimiter, dirname, join } from 'node:path'
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

  const readCmd = `read_verilog -sv ${options.rtlFiles.map((f) => `"${f}"`).join(' ')}`
  const topCmd = options.topModule ? `hierarchy -top ${options.topModule}` : 'hierarchy -auto-top'
  const script = `${readCmd}; ${topCmd}; check; stat`

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
  sdcFile?: string
  targetLibrary?: string
  effort?: 'low' | 'medium' | 'high'
}

export interface LogicSynthesisResult {
  netlistPath: string
  area?: number
  timingSummary?: string
  powerSummary?: string
}

export async function runLogicSynthesis(
  _options: LogicSynthesisOptions
): Promise<LogicSynthesisResult> {
  throw new Error('NotImplemented: runLogicSynthesis 将在 Phase 6（EDA 深度集成）实现')
}

