/**
 * Yosys 可综合性检查与逻辑综合封装（骨架桩）
 *
 * TODO(Phase 4): 调用 yosys 子进程执行 read_verilog → hierarchy → check，
 * 解析报告为结构化结果。
 */

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
  topModule: string
}

export async function checkSynthesizability(
  _options: SynthCheckOptions
): Promise<SynthesizabilityResult> {
  throw new Error('NotImplemented: checkSynthesizability 将在 Phase 4（芯片专用工具集）实现')
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
  throw new Error('NotImplemented: runLogicSynthesis 将在 Phase 4（芯片专用工具集）实现')
}
