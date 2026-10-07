/**
 * VERIF 验证长程循环"战略层"数据面（设计哲学：规则算战略、LLM 执行、证据裁决）。
 *
 * 全部为确定性纯函数：LLM 不参与任何计算，预测/策略/收口判据只由账本与态势证据推导，
 * 不引入 electron / node:fs（不直接读写磁盘，证据由调用方读取后传入），
 * 可由 scripts/run-loop-forecast-smoke.mjs / run-loop-strategy-smoke.mjs 直接转译测试
 * （与 verif-run-loop.ts / decision-ledger.ts 同口径）。
 *
 * 本模块包含三块：
 * 1. 运行预测 computeRunLoopForecast（速率/ETA/预算投影/约束判定/置信度）；
 * 2. 运行策略评估 evaluateRunLoopStrategy（确定性触发器，同策略不重复切换由调用方保证）；
 * 3. 收口计划 computeClosurePlan（W1 四判据，证据不足一律 false）。
 */

import type { RunLoopForecast, VerifRunClosurePlan, VerifRunLoopLedger, VerifRunWave } from '@shared/types'
import type { GuidanceState } from '@shared/verification-guidance'

// ==================== 运行策略（确定性触发器） ====================

/** 运行策略四态；deep-dive 的具体攻坚派发本期不实现，只留策略标记与账本 */
export type RunLoopStrategy = 'normal' | 'converge-first' | 'deep-dive' | 'steady-regression'

export interface RunLoopStrategyInput {
  /** 近 10 条修复判定（新在前；rtl-fix-outcomes 账本口径） */
  fixOutcomes: ReadonlyArray<{ judgment: 'FIXED' | 'STILL_FAIL' | 'UNKNOWN' }>
  /** 最近拍摘要（新在前；近 5 步 advanced 口径取前 5 条） */
  lastBeats: ReadonlyArray<{ advanced: boolean }>
  /** 陈旧通过条款数（证据作废频繁度；specMapping/W1 waveProgress 透出） */
  stalePassedCount: number
  /** 当前策略（同策略不重复切换；deep-dive 条件不满足时回落 normal） */
  current: RunLoopStrategy
}

/** converge-first 触发：近 10 条修复判定中 STILL_FAIL+UNKNOWN 占比 > 0.5，或近 5 条 ≥3 条非 FIXED。 */
function convergeFirstFired(input: RunLoopStrategyInput): boolean {
  const recent = input.fixOutcomes.slice(0, 10)
  const nonFixed = recent.filter((outcome) => outcome.judgment !== 'FIXED').length
  const ratio = recent.length > 0 ? nonFixed / recent.length : 0
  const last5NonFixed = input.fixOutcomes.slice(0, 5).filter((outcome) => outcome.judgment !== 'FIXED').length
  return ratio > 0.5 || last5NonFixed >= 3
}

/** steady-regression 触发：证据作废频繁（stalePassedCount > 0）且近 5 步 advanced=true 数 ≤1（回归不动）。 */
function steadyRegressionFired(input: RunLoopStrategyInput): boolean {
  const recent5 = input.lastBeats.slice(0, 5)
  const advancedCount = recent5.filter((beat) => beat.advanced).length
  return input.stalePassedCount > 0 && advancedCount <= 1
}

/**
 * 策略评估（规则算战略）：converge-first > steady-regression > deep-dive 回落 > normal。
 * 触发条件是纯状态函数——条件不再成立即回落 normal（退出条件与触发条件同口径，天然无迟滞）。
 * deep-dive 不由本函数进入（攻坚派发本期不实现）；当前已是 deep-dive 且条件不满足时回落 normal。
 */
export function evaluateRunLoopStrategy(input: RunLoopStrategyInput): RunLoopStrategy {
  if (convergeFirstFired(input)) return 'converge-first'
  if (steadyRegressionFired(input)) return 'steady-regression'
  return 'normal'
}

/**
 * 触发条件一句话（决策账本 rationale 用；未触发返回 null）。
 * 与 evaluateRunLoopStrategy 共用同一组条件函数，保证"记下的就是算出的"。
 */
export function runLoopStrategyTriggerNote(input: RunLoopStrategyInput): string | null {
  if (convergeFirstFired(input)) {
    const recent = input.fixOutcomes.slice(0, 10)
    const nonFixed = recent.filter((outcome) => outcome.judgment !== 'FIXED').length
    const ratio = recent.length > 0 ? nonFixed / recent.length : 0
    if (recent.length > 0 && ratio > 0.5) {
      return `触发 converge-first：近 ${recent.length} 条修复判定 ${nonFixed} 条非 FIXED（占比 ${ratio.toFixed(2)} > 0.5）`
    }
    const last5NonFixed = input.fixOutcomes.slice(0, 5).filter((outcome) => outcome.judgment !== 'FIXED').length
    return `触发 converge-first：近 5 条修复判定 ${last5NonFixed} 条非 FIXED（≥3）`
  }
  if (steadyRegressionFired(input)) {
    const advancedCount = input.lastBeats.slice(0, 5).filter((beat) => beat.advanced).length
    return `触发 steady-regression：陈旧通过条款 ${input.stalePassedCount} 条且近 5 步进展 ${advancedCount} 步（≤1，证据作废频繁且回归不动）`
  }
  return null
}

// ==================== 态势运行时超集字段（引擎透出，GuidanceState 未声明，防御性读取） ====================

interface PostureRuntimeScenario {
  status?: unknown
  rtlHash?: unknown
}

/** posture 即引擎 VerificationStateModel 的 GuidanceState 视图，运行时额外携带 rtlHash/scenarios 等字段。 */
interface PostureRuntimeExtras {
  rtlHash?: unknown
  scenarios?: unknown
}

function postureExtras(posture: GuidanceState | null): PostureRuntimeExtras {
  return (posture ?? {}) as PostureRuntimeExtras
}

/** 当前 RTL 版本：posture 运行时 rtlHash 字段（缺失/空串视为未知 → 证据不足口径一律 false）。 */
export function postureRtlHashOf(posture: GuidanceState | null): string | null {
  const rtlHash = postureExtras(posture).rtlHash
  return typeof rtlHash === 'string' && rtlHash !== '' ? rtlHash : null
}

/** 收口回归证据：逐场景"是否通过 + 绑定 rtlHash"（signoff-regression 判据的输入；无场景列表 → 空 = 证据不足）。 */
export interface ClosureRegressionEvidence {
  passed: boolean
  rtlHash: string | null
}

/** 场景"回归通过"状态集合：VERIFIED/FORMAL_PROVED/FORMAL_UNREACHABLE；WAIVED 是豁免不是回归通过，不计入。 */
const SIGNOFF_PASSING_SCENARIO_STATUSES = new Set(['VERIFIED', 'FORMAL_PROVED', 'FORMAL_UNREACHABLE'])

export function closureRegressionsOf(posture: GuidanceState | null): ClosureRegressionEvidence[] {
  const scenarios = postureExtras(posture).scenarios
  if (!Array.isArray(scenarios)) return []
  return scenarios
    .filter((item): item is PostureRuntimeScenario => typeof item === 'object' && item !== null)
    .map((scenario) => ({
      passed: typeof scenario.status === 'string' && SIGNOFF_PASSING_SCENARIO_STATUSES.has(scenario.status),
      rtlHash: typeof scenario.rtlHash === 'string' && scenario.rtlHash !== '' ? scenario.rtlHash : null
    }))
}

/** 陈旧通过条款数：specMapping.stalePassedCount 优先，缺省回退 W1 waveProgress（引擎两处透出同口径）。 */
export function stalePassedCountOf(posture: GuidanceState | null): number {
  const fromMapping = posture?.specMapping?.stalePassedCount
  if (typeof fromMapping === 'number' && Number.isFinite(fromMapping) && fromMapping > 0) return Math.trunc(fromMapping)
  const w1 = posture?.waveProgress?.find((wave) => wave.id === 'W1')
  const fromW1 = w1?.stalePassedCount
  return typeof fromW1 === 'number' && Number.isFinite(fromW1) && fromW1 > 0 ? Math.trunc(fromW1) : 0
}

// ==================== 收口计划（W1 四判据；纯函数，证据不足一律 false） ====================

/** computeClosurePlan 返回值：收口判据部分（策略/生效时刻由调用方按"同策略不重复切换"合并）。 */
export type RunLoopClosureCriteria = Pick<VerifRunClosurePlan, 'wave' | 'criteria' | 'metCount' | 'totalCount'>

/** W1 收口判据 id 全集（顺序固定，便于 UI 与 smoke 对齐）。 */
export const RUN_LOOP_CLOSURE_CRITERIA_IDS = ['clauses-covered', 'no-open-failures', 'no-pending-repairs', 'signoff-regression'] as const

interface ClosureClauseItem {
  status?: unknown
  channel?: unknown
  stalePassed?: unknown
  clauseKind?: unknown
}

/**
 * 收口计划推导（每拍重算）：
 * - 目标波段：wave ?? 'W1'（无在跑波段时按 W1 收口口径预估，W1 是条款收口波）；
 *   非 W1 波段本期只留 wave 与空 criteria（totalCount 0），不展开。
 * - W1 四判据（证据不足一律 false）：
 *   clauses-covered：可验证条款（排除 documentary/synthesis）全 PASSED+WAIVED、明细与 clauseTotal 对账一致、
 *     无 stalePassed、且态势 rtlHash 已知（CURRENT = 无陈旧标记且版本可确认）；
 *   no-open-failures：场景无 FAILED（运行时 scenarios）且条款无 FAILED 且回归全部 passed；
 *   no-pending-repairs：修复判定无 STILL_FAIL/UNKNOWN；
 *   signoff-regression：收口回归证据非空、全部通过、且全部绑定当前 rtlHash（当前 rtlHash 下全部场景回归通过）。
 */
export function computeClosurePlan(
  posture: GuidanceState | null,
  fixOutcomes: ReadonlyArray<{ judgment: 'FIXED' | 'STILL_FAIL' | 'UNKNOWN' }>,
  regressions: ReadonlyArray<ClosureRegressionEvidence>,
  wave: VerifRunWave | null
): RunLoopClosureCriteria {
  const planWave = wave ?? 'W1'
  if (planWave !== 'W1') {
    return { wave: planWave, criteria: [], metCount: 0, totalCount: 0 }
  }
  const currentRtlHash = postureRtlHashOf(posture)
  const clauses = ((posture?.specMapping?.clauses ?? []) as ClosureClauseItem[])
  // 与 workbench 同口径：documentary（clauseKind/status）与 synthesis 通道条款不参与 VERIF 完备性
  const relevantClauses = clauses.filter((clause) =>
    clause.channel !== 'synthesis' && clause.status !== 'DOCUMENTARY' && clause.clauseKind !== 'documentary')
  const clauseTotal = posture?.specMapping?.clauseTotal
  const clausesCovered = relevantClauses.length > 0 &&
    (typeof clauseTotal === 'number' && Number.isInteger(clauseTotal) ? relevantClauses.length === clauseTotal : true) &&
    relevantClauses.every((clause) => clause.status === 'PASSED' || clause.status === 'WAIVED') &&
    !relevantClauses.some((clause) => clause.stalePassed === true) &&
    currentRtlHash !== null
  const scenarios = postureExtras(posture).scenarios
  const scenarioList = Array.isArray(scenarios)
    ? scenarios.filter((item): item is PostureRuntimeScenario => typeof item === 'object' && item !== null)
    : []
  const noOpenFailures = !scenarioList.some((scenario) => scenario.status === 'FAILED') &&
    !relevantClauses.some((clause) => clause.status === 'FAILED') &&
    !(posture?.regressions ?? []).some((regression) => !regression.passed)
  const noPendingRepairs = !fixOutcomes.some((outcome) => outcome.judgment === 'STILL_FAIL' || outcome.judgment === 'UNKNOWN')
  const signoffRegression = currentRtlHash !== null &&
    regressions.length > 0 &&
    regressions.every((regression) => regression.passed) &&
    regressions.every((regression) => regression.rtlHash !== null && regression.rtlHash === currentRtlHash)
  const criteria: Array<{ id: string; met: boolean }> = [
    { id: 'clauses-covered', met: clausesCovered },
    { id: 'no-open-failures', met: noOpenFailures },
    { id: 'no-pending-repairs', met: noPendingRepairs },
    { id: 'signoff-regression', met: signoffRegression }
  ]
  return { wave: planWave, criteria, metCount: criteria.filter((item) => item.met).length, totalCount: criteria.length }
}

// ==================== 运行预测（速率/ETA/预算投影/约束判定/置信度） ====================

// RunLoopForecast 类型契约统一定义在 @shared/types（账本/渲染端共用）；此处再导出保持既有引用兼容
export type { RunLoopForecast } from '@shared/types'

/** 速率有效性门槛：运行不足 0.5 小时不给速率（启动初期样本噪声大）。 */
const RATE_MIN_HOURS = 0.5
/** binding tight 的余量阈值：min(投影) 超出剩余条款不足 20% 即算紧张。 */
const BINDING_TIGHT_MARGIN = 0.2

/** 非负有限数归一（条款计数等），非法值返回 null。 */
function nonNegativeNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** 自循环启动起算的总运行分钟数（含手动继续开窗重置前滚入的 wallResetBase）。 */
function elapsedMinutesSinceStart(ledger: VerifRunLoopLedger, nowIso: string): number | null {
  const startedMs = Date.parse(ledger.budget.startedAt)
  const nowMs = Date.parse(nowIso)
  if (!Number.isFinite(startedMs) || !Number.isFinite(nowMs)) return null
  const windowMinutes = Math.max(0, (nowMs - startedMs) / 60_000)
  return (ledger.budget.wallResetBase ?? 0) + windowMinutes
}

/**
 * 运行预测（纯函数，规则算战略）：
 * - covered/total 取 posture（specMapping.coveredClause/clauseTotal，缺省回退 W1 waveProgress 的
 *   specClauseCovered/specClauseTotal），都无 → null；
 * - ratePerHour = covered / 自启动小时数（>0.5h 才给值；covered=0 时给 0，eta/budget 按速率 0/无数据处理）；
 * - etaHours：速率有效（>0）时 low=剩余/rate×1.2、high=剩余/rate×（近 ≤10 步进展比例 <0.5 ? 3 : 2）；
 * - budgetProjection：steps=剩余拍数×平均每拍闭环条款；tokens=剩余 token/单位条款成本（tokensUsed/covered，
 *   covered=0 无成本数据 → 整体 null）；wallMinutes=剩余墙钟小时×ratePerHour（速率数据无效 → 整体 null）；
 * - binding：无速率/预算数据 → unknown；否则 min(三维投影) 与剩余条款比较（< 不足，余量 <20% 紧张，其余充足）；
 * - confidence：拍数 ≥5 且近 ≤10 步有进展 → medium，否则 low。
 */
export function computeRunLoopForecast(ledger: VerifRunLoopLedger, posture: GuidanceState | null, nowIso: string): RunLoopForecast {
  const w1 = posture?.waveProgress?.find((wave) => wave.id === 'W1')
  const covered = nonNegativeNumber(posture?.specMapping?.coveredClause) ?? nonNegativeNumber(w1?.specClauseCovered)
  const total = nonNegativeNumber(posture?.specMapping?.clauseTotal) ?? nonNegativeNumber(w1?.specClauseTotal)
  const elapsedMinutes = elapsedMinutesSinceStart(ledger, nowIso)
  const hours = elapsedMinutes !== null ? elapsedMinutes / 60 : null
  const ratePerHour = covered !== null && hours !== null && hours > RATE_MIN_HOURS ? covered / hours : null

  const recentBeats = ledger.lastBeats.slice(0, 10)
  const recentAdvanceRatio = recentBeats.length > 0
    ? recentBeats.filter((beat) => beat.advanced).length / recentBeats.length
    : 0

  const remaining = covered !== null && total !== null ? Math.max(0, total - covered) : null
  let etaHours: RunLoopForecast['etaHours'] = null
  if (ratePerHour !== null && ratePerHour > 0 && remaining !== null) {
    etaHours = {
      low: (remaining / ratePerHour) * 1.2,
      high: (remaining / ratePerHour) * (recentAdvanceRatio < 0.5 ? 3 : 2)
    }
  }

  // 预算投影：任一度量数据不足 → 整体 null（无速率数据 → binding 走 unknown 口径）
  let budgetProjection: RunLoopForecast['budgetProjection'] = null
  if (covered !== null && remaining !== null && hours !== null && ratePerHour !== null) {
    const remainingBeats = Math.max(0, ledger.budget.maxBeats - ledger.budget.beats)
    const stepsProjection = ledger.budget.beats > 0
      ? Math.floor(remainingBeats * (covered / ledger.budget.beats))
      : null
    const tokenUnitCost = covered > 0 ? ledger.budget.tokensUsed / covered : null
    const remainingTokens = Math.max(0, ledger.budget.maxTokens - ledger.budget.tokensUsed)
    const tokensProjection = tokenUnitCost !== null && tokenUnitCost > 0
      ? Math.floor(remainingTokens / tokenUnitCost)
      : null
    const windowMinutes = (() => {
      const startedMs = Date.parse(ledger.budget.startedAt)
      const nowMs = Date.parse(nowIso)
      return Number.isFinite(startedMs) && Number.isFinite(nowMs) ? Math.max(0, (nowMs - startedMs) / 60_000) : null
    })()
    // 墙钟剩余按当前窗口折算（与 checkRunLoopBudget 熔断口径一致：手动继续开窗重置后重新计窗）
    const wallProjection = windowMinutes !== null
      ? Math.floor((Math.max(0, ledger.budget.maxWallMinutes - windowMinutes) / 60) * ratePerHour)
      : null
    if (stepsProjection !== null && tokensProjection !== null && wallProjection !== null) {
      budgetProjection = {
        steps: { projectedClauses: stepsProjection },
        tokens: { projectedClauses: tokensProjection },
        wallMinutes: { projectedClauses: wallProjection }
      }
    }
  }

  let binding: RunLoopForecast['binding'] = 'unknown'
  if (budgetProjection !== null && remaining !== null) {
    if (remaining === 0) {
      binding = 'sufficient'
    } else {
      const minProjected = Math.min(
        budgetProjection.steps.projectedClauses,
        budgetProjection.tokens.projectedClauses,
        budgetProjection.wallMinutes.projectedClauses
      )
      if (minProjected < remaining) binding = 'insufficient'
      else if ((minProjected - remaining) / remaining < BINDING_TIGHT_MARGIN) binding = 'tight'
      else binding = 'sufficient'
    }
  }

  const confidence: RunLoopForecast['confidence'] =
    ledger.budget.beats >= 5 && recentAdvanceRatio > 0 ? 'medium' : 'low'

  return { covered, total, ratePerHour, recentAdvanceRatio, etaHours, budgetProjection, binding, confidence }
}
