/**
 * 仿真器封装（骨架桩）
 *
 * TODO(Phase 4): 调用 Verilator/VCS 运行仿真，收集日志、覆盖率与波形路径。
 */

export type SimulatorKind = 'verilator' | 'vcs' | 'xcelium'

export interface SimulationOptions {
  topModule: string
  testbench: string
  simulator?: SimulatorKind
  timeoutSec?: number
}

export interface CoverageSummary {
  lineCoverage?: number
  branchCoverage?: number
  toggleCoverage?: number
}

export interface SimulationResult {
  passed: boolean
  logPath: string
  coverage?: CoverageSummary
  waveformPath?: string
}

export async function runSimulation(_options: SimulationOptions): Promise<SimulationResult> {
  throw new Error('NotImplemented: runSimulation 将在 Phase 4（芯片专用工具集）实现')
}
