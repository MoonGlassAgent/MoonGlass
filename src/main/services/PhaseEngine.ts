/**
 * 7 阶段流程引擎（状态机 + 门禁规则）
 *
 * 依据规格书 §3.1 的阶段跳转规则定义。
 * Phase 3：门禁自动检查接入真实 EDA 工具（lint / yosys 可综合性），
 * Error 级检查失败阻断推进；文档类/覆盖率类检查保持「未接入」占位（不阻塞）。
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runLint, checkSynthesizability } from '@moonglass/eda-bridge'
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

/** 检查项中文名 */
const CHECK_NAMES: Record<string, string> = {
  'doc-completeness': '文档完整性',
  'rtm-exists': '需求追溯矩阵（RTM）存在',
  'interface-signals-nonempty': '接口信号清单非空',
  'module-partition-sane': '模块划分合理性',
  'block-diagram-parsable': '架构框图可解析',
  'clock-reset-defined': '时钟/复位方案定义',
  'verible-lint-zero-error': 'Lint 零 Error',
  'port-consistency': '端口一致性检查',
  'line-coverage-gte-90': '行覆盖率 ≥90%',
  'func-coverage-gte-80': '功能覆盖率 ≥80%',
  'sim-passed': '仿真通过',
  'verible-zero-error': 'Lint 零 Error',
  'yosys-synthesizable': 'Yosys 可综合性',
  'cdc-passed': 'CDC 检查通过'
}

/** 门禁检查执行上下文（由调用方注入，避免本模块依赖 Electron） */
export interface GateCheckContext {
  /** 项目工作目录（pi 会话 cwd，Agent 产出 RTL 的位置） */
  workspaceDir: string
}

type GateChecker = (ctx: GateCheckContext) => Promise<GateCheckResult>

const MAX_ISSUES_IN_MESSAGE = 3

/** 递归收集工作区 RTL 文件（跳过 .pi 等隐藏目录与 node_modules） */
function collectRtlFiles(dir: string): string[] {
  const out: string[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue
    const full = join(dir, e.name)
    if (e.isDirectory()) out.push(...collectRtlFiles(full))
    else if (/\.(v|sv)$/i.test(e.name)) out.push(full)
  }
  return out
}

function makeResult(
  checkId: string,
  passed: boolean,
  severity: GateCheckResult['severity'],
  message: string
): GateCheckResult {
  return { checkId, checkName: CHECK_NAMES[checkId] ?? checkId, passed, severity, message, autoFixable: false }
}

/** Lint 零 Error：逐文件 runLint（verible 优先，verilator 回退），任一 Error 即失败 */
async function lintZeroError(ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> {
  const files = collectRtlFiles(ctx.workspaceDir)
  if (files.length === 0) {
    return makeResult(checkId, false, 'error', '工作区暂无 RTL 文件（*.v/*.sv），无法执行 Lint')
  }

  let engine = ''
  const errors: string[] = []
  let warningCount = 0
  for (const file of files) {
    const result = await runLint({ filePath: file })
    engine = result.engine
    warningCount += result.warnings.length
    for (const e of result.errors) {
      errors.push(`${file}:${e.line}:${e.column} ${e.message}`)
    }
  }

  if (errors.length > 0) {
    const shown = errors.slice(0, MAX_ISSUES_IN_MESSAGE).join('；')
    const more = errors.length > MAX_ISSUES_IN_MESSAGE ? ` 等 ${errors.length} 条` : ''
    return makeResult(checkId, false, 'error', `${errors.length} 条 Error（${engine}）：${shown}${more}`)
  }
  const warn = warningCount > 0 ? `，${warningCount} 条 Warning 待评审` : ''
  return makeResult(checkId, true, 'error', `通过（${engine}，${files.length} 个文件${warn}）`)
}

/** Yosys 可综合性：全部 RTL 文件一次检查 */
async function yosysSynthesizable(ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> {
  const files = collectRtlFiles(ctx.workspaceDir)
  if (files.length === 0) {
    return makeResult(checkId, false, 'error', '工作区暂无 RTL 文件（*.v/*.sv），无法执行综合检查')
  }

  const result = await checkSynthesizability({ rtlFiles: files })
  if (!result.synthesizable) {
    const errs = result.issues.filter((i) => i.severity === 'error')
    const shown = errs.slice(0, MAX_ISSUES_IN_MESSAGE).map((e) => e.message).join('；')
    const more = errs.length > MAX_ISSUES_IN_MESSAGE ? ` 等 ${errs.length} 条` : ''
    return makeResult(checkId, false, 'error', `不可综合：${shown}${more}`)
  }
  const est = result.resourceEstimate
  const estText = est.cells !== undefined ? `，约 ${est.cells} cells / ${est.wires} wires` : ''
  return makeResult(checkId, true, 'error', `可综合（${files.length} 个文件${estText}）`)
}

/** 检查器注册表：checkId → 真实检查实现；未注册的走「未接入」占位 */
const CHECKERS: Record<string, (ctx: GateCheckContext, checkId: string) => Promise<GateCheckResult>> = {
  'verible-lint-zero-error': lintZeroError,
  'verible-zero-error': lintZeroError,
  'yosys-synthesizable': yosysSynthesizable
}

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
   * 运行门禁自动检查。
   * 已注册检查器（lint / yosys）真实执行；未接入检查项返回 info 占位（不阻塞）。
   */
  async runGateChecks(project: ChipProject, to: Phase, ctx: GateCheckContext): Promise<GateCheckResult[]> {
    const rule = this.getGateRule(project.currentPhase, to)
    if (!rule) return []
    return Promise.all(
      rule.autoChecks.map(async (checkId) => {
        const checker = CHECKERS[checkId]
        if (!checker) {
          return makeResult(checkId, true, 'info', '未接入（待后续阶段），不阻塞流转')
        }
        try {
          return await checker(ctx, checkId)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return makeResult(checkId, false, 'error', `检查执行失败：${msg}`)
        }
      })
    )
  }

  /** 是否存在阻断项（Error 级检查未通过） */
  isBlocked(results: GateCheckResult[]): boolean {
    return results.some((r) => r.severity === 'error' && !r.passed)
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
