/**
 * 7 阶段流程引擎（状态机 + 门禁规则）
 *
 * 依据规格书 §3.1 的阶段跳转规则定义。骨架阶段：
 * - 提供状态机推进/回退逻辑（含门禁规则查询）
 * - 门禁自动检查项暂以「未实现」占位返回，后续接入 EDA 检查
 */

import {
  PHASE_ORDER,
  type ChipProject,
  type GateCheckResult,
  type GateRule,
  type Phase,
  type PhaseState
} from '@shared/types'
import type { MoonGlassService } from '../core/lifecycle'

/** 阶段跳转门禁规则表（规格书 §3.1） */
export const GATE_RULES: readonly GateRule[] = [
  { from: 'REQ', to: 'SPEC', precondition: '需求文档 ≥1 份', autoChecks: ['doc-completeness', 'rtm-exists'] },
  { from: 'SPEC', to: 'ARCH', precondition: '模块规格书 + 接口定义', autoChecks: ['interface-signals-nonempty', 'module-partition-sane'] },
  { from: 'ARCH', to: 'RTL', precondition: '架构框图 + 信号清单', autoChecks: ['block-diagram-parsable', 'clock-reset-defined'] },
  { from: 'RTL', to: 'VERIF', precondition: '可编译 RTL + 端口提取通过', autoChecks: ['verible-lint-zero-error', 'port-consistency'] },
  { from: 'VERIF', to: 'QA', precondition: '覆盖率报告', autoChecks: ['line-coverage-gte-90', 'func-coverage-gte-80', 'sim-passed'] },
  { from: 'QA', to: 'SYNTH', precondition: 'Lint/CDC/代码审查通过', autoChecks: ['verible-zero-error', 'yosys-synthesizable', 'cdc-passed'] }
] as const

export function createInitialPhases(): Record<Phase, PhaseState> {
  const blank = (): PhaseState => ({
    status: 'locked',
    deliverables: [],
    agentContext: { messageCount: 0 },
    reviewStatus: 'pending',
    gateCheckResults: []
  })
  const phases = Object.fromEntries(PHASE_ORDER.map((p) => [p, blank()])) as Record<Phase, PhaseState>
  phases.REQ.status = 'active'
  phases.REQ.startedAt = new Date().toISOString()
  return phases
}

export class PhaseEngine implements MoonGlassService {
  readonly name = 'phase-engine'

  start(): void {
    // 无外部资源
  }

  stop(): void {
    // 无外部资源
  }

  /** 查询两个相邻阶段间的门禁规则 */
  getGateRule(from: Phase, to: Phase): GateRule | undefined {
    return GATE_RULES.find((r) => r.from === from && r.to === to)
  }

  /**
   * 运行门禁自动检查（骨架：全部返回「未实现」级别的 info，不阻塞流转）
   * TODO(Phase 3): 接入真实检查（文档完整性 / Verible / 覆盖率 / Yosys / CDC）
   */
  runGateChecks(project: ChipProject, to: Phase): GateCheckResult[] {
    const rule = this.getGateRule(project.currentPhase, to)
    if (!rule) return []
    return rule.autoChecks.map((checkId) => ({
      checkId,
      checkName: checkId,
      passed: true,
      severity: 'info' as const,
      message: '骨架阶段：门禁自动检查未接入，默认放行',
      autoFixable: false
    }))
  }

  /** 判断 to 是否为 currentPhase 的下一相邻阶段 */
  canAdvance(project: ChipProject, to: Phase): boolean {
    const cur = PHASE_ORDER.indexOf(project.currentPhase)
    return PHASE_ORDER.indexOf(to) === cur + 1
  }

  /** 推进到下一阶段（就地修改 project，由调用方持久化） */
  advance(project: ChipProject, to: Phase): ChipProject {
    if (!this.canAdvance(project, to)) {
      throw new Error(`[phase-engine] 非法阶段跳转: ${project.currentPhase} → ${to}（仅支持逐阶段推进）`)
    }
    const now = new Date().toISOString()
    project.phases[project.currentPhase].status = 'completed'
    project.phases[project.currentPhase].completedAt = now
    project.currentPhase = to
    project.phases[to].status = 'active'
    project.phases[to].startedAt = project.phases[to].startedAt ?? now
    project.updatedAt = now
    return project
  }

  /** 回退到之前的任一阶段（后续阶段产出标记为废弃的语义由调用方处理） */
  rollback(project: ChipProject, to: Phase): ChipProject {
    const cur = PHASE_ORDER.indexOf(project.currentPhase)
    const target = PHASE_ORDER.indexOf(to)
    if (target >= cur) {
      throw new Error(`[phase-engine] 非法回退: ${project.currentPhase} → ${to}`)
    }
    const now = new Date().toISOString()
    for (let i = target + 1; i < PHASE_ORDER.length; i++) {
      const p = PHASE_ORDER[i]
      project.phases[p].status = 'locked'
      project.phases[p].completedAt = undefined
    }
    project.currentPhase = to
    project.phases[to].status = 'active'
    project.phases[to].completedAt = undefined
    project.updatedAt = now
    return project
  }
}
