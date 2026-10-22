/**
 * 验证失败诊断与修复可视化（方案 C）渲染端视图类型与缺字段归一化 helper。
 *
 * 镜像主进程落盘 JSON 的 schema（渲染端禁止 import src/main 或引擎包，类型在此镜像定义；
 * 外层循环账本 VerifRunLoopLedger 等类型 shared 已定义，直接复用）：
 * - verification/results/run-loop.json             外层循环账本（覆盖式，VERIF-RUN-LOOP §9.1）
 * - verification/results/decision-ledger.json      决策账本（追加式 ≤100，新在前，§9.2）
 * - verification/results/verif-batch-loop.json     批次循环状态（覆盖式）
 * - verification/results/rtl-fix-outcomes.json     修复判定账本（新记录在前）
 * - verification/results/rtl-fix-in-progress.json  修复窗口标志（存在即修复中）
 * - verification/results/rtl-fix-audit-<RC>.json   修复窗口审计（rtl/ 快照 diff）
 * - verification/results/root-causes.json          根因链记录
 * - verification/results/diagnostic-control.json   诊断账本（attempts 新在后，滚动 ≤40）
 *
 * 所有 normalize* 入口接受 JSON.parse 产出的 unknown，缺字段/坏类型一律归一为默认值
 * （与主进程读取方的归一口径一致，version 演进预留）。
 */

// ============================================================
// 外层循环账本（run-loop.json，§9.1）与决策账本（decision-ledger.json，§9.2）
// ============================================================

import type {
  RunLoopForecast,
  VerifRunClosurePlan,
  VerifRunLoopBeatEntry,
  VerifRunLoopBudget,
  VerifRunLoopCurrent,
  VerifRunLoopLedger,
  VerifRunLoopState,
  VerifRunWave
} from '@shared/types'

/** 渲染端预算默认值：与主进程 verif-run-loop.ts 的 DEFAULT_* 同源（§6/§13 待决策 2） */
export const RUN_LOOP_DEFAULT_MAX_BEATS = 50
export const RUN_LOOP_DEFAULT_MAX_TOKENS = 5_000_000
export const RUN_LOOP_DEFAULT_MAX_WALL_MINUTES = 240

export type VerifRunDecisionSource = 'rule' | 'llm' | 'human'
export type VerifRunDecisionStatus = 'proposed' | 'approved' | 'rejected' | 'executed' | 'superseded'
export type VerifRunDecisionOutcome = 'advanced' | 'no-progress' | 'failed'

/** 决策账本条目的动作载荷（§9.2 action） */
export interface VerifRunDecisionActionView {
  kind: 'derived' | 'custom'
  actionId: string | null
  prompt: string
  expectedOutput: string
  stopCriteria: string
}

/** 决策账本条目视图（§9.2；账本新在前，滚动 ≤100 条） */
export interface VerifRunDecisionEntryView {
  id: string
  createdAt: string
  source: VerifRunDecisionSource
  trigger: string
  action: VerifRunDecisionActionView
  rationale: string
  evidenceRefs: string[]
  status: VerifRunDecisionStatus
  outcome: VerifRunDecisionOutcome | null
}

/** 决策账本滚动上限（§9.2：≤100 条） */
export const VERIF_RUN_DECISIONS_LIMIT = 100

const RUN_LOOP_STATES: readonly VerifRunLoopState[] = [
  'idle', 'planning', 'running', 'judging', 'repairing',
  'paused-human', 'paused-breaker', 'signoff-review', 'gate-check',
  'completed', 'stopped'
]

function normalizeRunLoopState(value: unknown): VerifRunLoopState {
  return RUN_LOOP_STATES.includes(value as VerifRunLoopState) ? value as VerifRunLoopState : 'idle'
}

function normalizeRunLoopWave(value: unknown): VerifRunWave | null {
  return value === 'W0' || value === 'W1' || value === 'W2' || value === 'W3' ? value : null
}

function normalizeRunLoopCurrent(value: unknown): VerifRunLoopCurrent | null {
  const current = asRecord(value)
  if (!current) return null
  return {
    kind: asString(current.kind),
    actionId: typeof current.actionId === 'string' ? current.actionId : null,
    sessionName: asString(current.sessionName),
    dispatchedAt: asString(current.dispatchedAt),
    source: current.source === 'llm' || current.source === 'human' ? current.source : 'rule',
    decisionId: asString(current.decisionId)
  }
}

function normalizeRunLoopPause(value: unknown): VerifRunLoopLedger['pause'] {
  const pause = asRecord(value)
  if (!pause) return null
  return {
    kind: pause.kind === 'breaker' ? 'breaker' : 'human',
    reason: asString(pause.reason),
    detail: asString(pause.detail),
    pendingItems: asStringArray(pause.pendingItems),
    since: asString(pause.since)
  }
}

function normalizeRunLoopBudget(value: unknown): VerifRunLoopBudget {
  const budget = asRecord(value) ?? {}
  const numberOf = (field: unknown, fallback: number): number => {
    const parsed = Number(field)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
  }
  return {
    beats: numberOf(budget.beats, 0),
    maxBeats: numberOf(budget.maxBeats, RUN_LOOP_DEFAULT_MAX_BEATS),
    tokensUsed: numberOf(budget.tokensUsed, 0),
    maxTokens: numberOf(budget.maxTokens, RUN_LOOP_DEFAULT_MAX_TOKENS),
    startedAt: asString(budget.startedAt),
    maxWallMinutes: numberOf(budget.maxWallMinutes, RUN_LOOP_DEFAULT_MAX_WALL_MINUTES)
  }
}

function normalizeRunLoopBeatEntries(value: unknown): VerifRunLoopBeatEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      beat: asNumber(item.beat),
      summary: asString(item.summary),
      decisionId: asString(item.decisionId),
      verdict: asString(item.verdict),
      advanced: asBoolean(item.advanced)
    }))
    .slice(0, 20)
}

/** closurePlan（战略层）归一化：缺失/损坏返回 null；criteria 坏条目丢弃，非法策略归一为 normal。 */
function normalizeRunLoopClosurePlan(value: unknown): VerifRunClosurePlan | null {
  const plan = asRecord(value)
  if (!plan) return null
  const criteria = (Array.isArray(plan.criteria) ? plan.criteria : [])
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({ id: asString(item.id), met: item.met === true }))
  return {
    wave: asString(plan.wave),
    strategy: plan.strategy === 'converge-first' || plan.strategy === 'deep-dive' || plan.strategy === 'steady-regression' ? plan.strategy : 'normal',
    strategySince: asString(plan.strategySince),
    criteria,
    metCount: asNumber(plan.metCount),
    totalCount: asNumber(plan.totalCount)
  }
}

/** run-loop.json 归一化；非对象返回 null（按无循环记录处理，与主进程读取方同口径）。 */
export function normalizeRunLoopLedger(raw: unknown): VerifRunLoopLedger | null {
  const data = asRecord(raw)
  if (!data) return null
  return {
    version: 1,
    updatedAt: asString(data.updatedAt),
    loopId: asString(data.loopId),
    state: normalizeRunLoopState(data.state),
    wave: normalizeRunLoopWave(data.wave),
    beat: asNumber(data.beat),
    current: normalizeRunLoopCurrent(data.current),
    pause: normalizeRunLoopPause(data.pause),
    budget: normalizeRunLoopBudget(data.budget),
    lastBeats: normalizeRunLoopBeatEntries(data.lastBeats),
    // 战略层 closurePlan（可选字段）：无计划/损坏归一为 undefined（shared 类型口径），读取处 ?? null
    closurePlan: normalizeRunLoopClosurePlan(data.closurePlan) ?? undefined,
    // 战略层进展预测（可选字段）：结构由 shared RunLoopForecast 约束，缺省/损坏归一为 undefined
    forecast: normalizeRunLoopForecast(data.forecast) ?? undefined
  }
}

/** forecast（战略层）归一化：缺失/损坏返回 null；数值字段非法一律 null，非法 binding/confidence 回落。 */
function normalizeRunLoopForecast(value: unknown): RunLoopForecast | null {
  const forecast = asRecord(value)
  if (!forecast) return null
  const num = (field: unknown): number | null => {
    const parsed = Number(field)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
  }
  const eta = asRecord(forecast.etaHours)
  const projection = asRecord(forecast.budgetProjection)
  const projectionOf = (key: 'steps' | 'tokens' | 'wallMinutes'): { projectedClauses: number } | null => {
    const entry = asRecord(projection?.[key])
    const value = num(entry?.projectedClauses)
    return entry && value !== null ? { projectedClauses: value } : null
  }
  const steps = projectionOf('steps')
  const tokens = projectionOf('tokens')
  const wallMinutes = projectionOf('wallMinutes')
  const binding = forecast.binding
  const confidence = forecast.confidence
  return {
    covered: num(forecast.covered),
    total: num(forecast.total),
    ratePerHour: num(forecast.ratePerHour),
    recentAdvanceRatio: num(forecast.recentAdvanceRatio) ?? 0,
    etaHours: eta ? { low: num(eta.low) ?? 0, high: num(eta.high) ?? 0 } : null,
    budgetProjection: projection && steps && tokens && wallMinutes ? { steps, tokens, wallMinutes } : null,
    binding: binding === 'sufficient' || binding === 'tight' || binding === 'insufficient' ? binding : 'unknown',
    confidence: confidence === 'medium' ? 'medium' : 'low'
  }
}

function normalizeDecisionSource(value: unknown): VerifRunDecisionSource {
  return value === 'llm' || value === 'human' ? value : 'rule'
}

function normalizeDecisionStatus(value: unknown): VerifRunDecisionStatus {
  return value === 'proposed' || value === 'approved' || value === 'rejected' || value === 'executed' || value === 'superseded'
    ? value
    : 'proposed'
}

function normalizeDecisionOutcome(value: unknown): VerifRunDecisionOutcome | null {
  return value === 'advanced' || value === 'no-progress' || value === 'failed' ? value : null
}

function normalizeDecisionAction(value: unknown): VerifRunDecisionActionView {
  const action = asRecord(value) ?? {}
  return {
    kind: action.kind === 'custom' ? 'custom' : 'derived',
    actionId: typeof action.actionId === 'string' ? action.actionId : null,
    prompt: asString(action.prompt),
    expectedOutput: asString(action.expectedOutput),
    stopCriteria: asString(action.stopCriteria)
  }
}

/** decision-ledger.json 归一化；接受账本对象或裸 decisions 数组，坏条目丢弃，滚动 ≤100 条。 */
export function normalizeDecisionLedger(raw: unknown): VerifRunDecisionEntryView[] {
  const list = Array.isArray(raw) ? raw : (Array.isArray(asRecord(raw)?.decisions) ? asRecord(raw)?.decisions as unknown[] : [])
  return list
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      id: asString(item.id),
      createdAt: asString(item.createdAt),
      source: normalizeDecisionSource(item.source),
      trigger: asString(item.trigger),
      action: normalizeDecisionAction(item.action),
      rationale: asString(item.rationale),
      evidenceRefs: asStringArray(item.evidenceRefs),
      status: normalizeDecisionStatus(item.status),
      outcome: normalizeDecisionOutcome(item.outcome)
    }))
    .slice(0, VERIF_RUN_DECISIONS_LIMIT)
}

// ============================================================
// 批次循环状态（verif-batch-loop.json）
// ============================================================

export type VerifLoopState = 'idle' | 'running' | 'awaiting-rtl-fix' | 'circuit-broken' | 'completed' | 'stopped'

/**
 * 批次语义标签视图：批次里每个场景在验证什么的**派发时快照**（主进程写入，见
 * `src/main/services/verif-loop-ledger.ts` 的 readScenarioLabels）。
 * 旧账本无此字段，界面按"无标题快照"显示场景 ID，不用当前注册表回填历史语义。
 */
export interface VerifScenarioLabelView {
  id: string
  /** 场景标题；空串表示快照缺失（注册表当时不可读或 ID 未命中） */
  title: string
  /** 锚定的规格条款 ID（如 REQ-FUNC-002#d） */
  requirementIds: string[]
}

/** 当前批次（循环内正在执行的批次；无则为 null） */
export interface VerifLoopCurrentBatch {
  /** 第 n 批（本次循环序号） */
  index: number
  sessionName: string
  scenarioIds: string[]
  dispatchedAt: string
  /** dispatched=批次会话已派发、执行中；settling=会话已结束、完成判定进行中 */
  phase: 'dispatched' | 'settling'
  /** 语义标签快照（旧账本缺失） */
  scenarios?: VerifScenarioLabelView[]
}

/** 本次循环已完成批次的历史条目（新记录在前，≤20 条） */
export interface VerifLoopHistoryEntry {
  index: number
  scenarioIds: string[]
  verdict: 'completed' | 'circuit-broken'
  /** 完成判定细节（缺哪个 scenario 登记）或熔断原因 */
  reason: string
  settledAt: string
  /** 语义标签快照（旧账本缺失） */
  scenarios?: VerifScenarioLabelView[]
}

/** 批次循环状态视图（verif-batch-loop.json） */
export interface VerifBatchLoopView {
  updatedAt: string
  state: VerifLoopState
  currentBatch: VerifLoopCurrentBatch | null
  /** 熔断原因结构化（state=circuit-broken 时有值） */
  circuitBreaker: { reason: string; detail: string } | null
  /** 等修复暂停（state=awaiting-rtl-fix 时有值） */
  rtlFixWait: { rootCauseId: string; since: string } | null
  history: VerifLoopHistoryEntry[]
}

// ============================================================
// 修复判定账本（rtl-fix-outcomes.json）与窗口标志/审计
// ============================================================

export type RtlFixJudgment = 'FIXED' | 'STILL_FAIL' | 'UNKNOWN'

/** 单条修复判定记录（账本新记录在前） */
export interface RtlFixOutcomeView {
  rootCauseId: string
  scenarioId: string
  fixSessionName: string
  judgment: RtlFixJudgment
  /** judgeRtlFixOutcome 的判定依据一句话 */
  reason: string
  startedAt: string
  settledAt: string
  /** 窗口审计文件相对路径（rtl-fix-audit-<RC>.json） */
  auditPath: string
  /** 窗口内写保护拦截次数 */
  blockedAttempts: number
}

/** 修复窗口标志（rtl-fix-in-progress.json，存在即修复中） */
export interface RtlFixInProgressView {
  rootCauseId: string
  scenarioId: string
  fixSessionName: string
  startedAt: string
}

/** 修复窗口审计记录（rtl-fix-audit-<RC>.json） */
export interface RtlFixAuditView {
  rootCauseId: string
  scenarioId: string
  fixSessionName: string
  startedAt: string
  settledAt: string
  changed: string[]
  created: string[]
  deleted: string[]
  blockedAttempts: number
}

// ============================================================
// 根因链（root-causes.json）
// ============================================================

export type RootCauseVerdict = 'confirmed' | 'refuted' | 'open'

/** 根因结论记录（同 scenarioId 多条共存成链，refutedHypotheses 链式追溯） */
export interface RootCauseRecordView {
  /** 稳定 id：RC-<sha1前8位大写> */
  id: string
  scenarioId: string
  hypothesis: string
  verdict: RootCauseVerdict
  /** 本条证伪的先前根因记录 id */
  refutedHypotheses: string[]
  failureSignature: string
  /** 一句话确认根因（≤200 字；open/refuted 可为空） */
  rootCause: string
  /** 动作级修复描述（≤120 字） */
  fix: string
  evidence: string[]
  createdAt: string
}

// ============================================================
// 诊断账本（diagnostic-control.json）
// ============================================================

export type DiagnosticLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5'
export type DiagnosticMode = 'NORMAL_DEBUG' | 'DIAGNOSTIC_ENHANCEMENT' | 'CLOSED'

/** 单次仿真/调试尝试（attempts 新在后，滚动 ≤40 条） */
export interface DiagnosticAttemptView {
  id: string
  topModule: string
  testcase: string
  passed: boolean
  createdAt: string
  durationMs: number
  failureSignature: string
  rtlHash: string
  testbenchHash: string
  diagnosticLevel: DiagnosticLevel
  observations: string[]
  evidence: string[]
}

/** 诊断账本视图（diagnostic-control.json） */
export interface DiagnosticControlView {
  updatedAt: string
  mode: DiagnosticMode
  /** 当前活跃用例：<topModule>::<testcase> */
  activeCase: string
  attempts: DiagnosticAttemptView[]
  recommendation: string
}

/** 诊断账本逐条重放条目（推导 mode 演化与进入增强诊断的触发点） */
export interface DiagnosticReplayEntry {
  /** attempts 内序号（时间升序） */
  index: number
  attempt: DiagnosticAttemptView
  /** 该次尝试落账后推导出的 mode（与 moonglass-tools 的推导口径一致） */
  mode: DiagnosticMode
  /** 是否为首次进入 DIAGNOSTIC_ENHANCEMENT 的那次尝试 */
  isEnhancementEntry: boolean
  /** 进入增强诊断的触发条件（仅 isEnhancementEntry 时有值） */
  trigger: 'same-fingerprint' | 'stalled' | null
}

// ============================================================
// 归一化 helper
// ============================================================

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
const asString = (value: unknown): string => typeof value === 'string' ? value : ''
const asStringArray = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : []
const asNumber = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
const asBoolean = (value: unknown): boolean => value === true

function normalizeLoopState(value: unknown): VerifLoopState {
  return value === 'running' || value === 'awaiting-rtl-fix' || value === 'circuit-broken' || value === 'completed' || value === 'stopped' ? value : 'idle'
}

function normalizeFixJudgment(value: unknown): RtlFixJudgment {
  return value === 'FIXED' || value === 'STILL_FAIL' ? value : 'UNKNOWN'
}

function normalizeRootCauseVerdict(value: unknown): RootCauseVerdict {
  return value === 'confirmed' || value === 'refuted' ? value : 'open'
}

function normalizeDiagnosticMode(value: unknown): DiagnosticMode {
  return value === 'DIAGNOSTIC_ENHANCEMENT' || value === 'CLOSED' ? value : 'NORMAL_DEBUG'
}

/** verif-batch-loop.json 归一化；非对象返回 null（按无循环记录处理）。 */
export function normalizeVerifBatchLoop(raw: unknown): VerifBatchLoopView | null {
  const data = asRecord(raw)
  if (!data) return null
  const batch = asRecord(data.currentBatch)
  const breaker = asRecord(data.circuitBreaker)
  const wait = asRecord(data.rtlFixWait)
  const labelsOf = (value: unknown): VerifScenarioLabelView[] | undefined => {
    if (!Array.isArray(value)) return undefined
    const labels = value
      .map(asRecord)
      .filter((item): item is Record<string, unknown> => item !== null)
      .map((item) => ({
        id: asString(item.id),
        title: asString(item.title),
        requirementIds: asStringArray(item.requirementIds)
      }))
      .filter((label) => label.id)
    return labels.length > 0 ? labels : undefined
  }
  const history = (Array.isArray(data.history) ? data.history : [])
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => {
      const scenarios = labelsOf(item.scenarios)
      return {
        index: asNumber(item.index),
        scenarioIds: asStringArray(item.scenarioIds),
        verdict: item.verdict === 'completed' ? 'completed' as const : 'circuit-broken' as const,
        reason: asString(item.reason),
        settledAt: asString(item.settledAt),
        ...(scenarios ? { scenarios } : {})
      }
    })
    .slice(0, 20)
  const currentScenarios = batch ? labelsOf(batch.scenarios) : undefined
  return {
    updatedAt: asString(data.updatedAt),
    state: normalizeLoopState(data.state),
    currentBatch: batch ? {
      index: asNumber(batch.index),
      sessionName: asString(batch.sessionName),
      scenarioIds: asStringArray(batch.scenarioIds),
      dispatchedAt: asString(batch.dispatchedAt),
      phase: batch.phase === 'settling' ? 'settling' : 'dispatched',
      ...(currentScenarios ? { scenarios: currentScenarios } : {})
    } : null,
    circuitBreaker: breaker ? { reason: asString(breaker.reason), detail: asString(breaker.detail) } : null,
    rtlFixWait: wait ? { rootCauseId: asString(wait.rootCauseId), since: asString(wait.since) } : null,
    history
  }
}

/** rtl-fix-outcomes.json 归一化；接受账本对象或裸 outcomes 数组，坏条目丢弃。 */
export function normalizeRtlFixOutcomes(raw: unknown): RtlFixOutcomeView[] {
  const list = Array.isArray(raw) ? raw : (Array.isArray(asRecord(raw)?.outcomes) ? asRecord(raw)?.outcomes as unknown[] : [])
  return list
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      rootCauseId: asString(item.rootCauseId),
      scenarioId: asString(item.scenarioId),
      fixSessionName: asString(item.fixSessionName),
      judgment: normalizeFixJudgment(item.judgment),
      reason: asString(item.reason),
      startedAt: asString(item.startedAt),
      settledAt: asString(item.settledAt),
      auditPath: asString(item.auditPath),
      blockedAttempts: asNumber(item.blockedAttempts)
    }))
    .slice(0, 50)
}

/** rtl-fix-in-progress.json 归一化；缺失/损坏/无 rootCauseId 返回 null（无修复窗口）。 */
export function normalizeRtlFixInProgress(raw: unknown): RtlFixInProgressView | null {
  const data = asRecord(raw)
  if (!data) return null
  const rootCauseId = asString(data.rootCauseId)
  if (!rootCauseId) return null
  return {
    rootCauseId,
    scenarioId: asString(data.scenarioId),
    fixSessionName: asString(data.fixSessionName),
    startedAt: asString(data.startedAt)
  }
}

/** rtl-fix-audit-<RC>.json 归一化；非对象返回 null（审计尚未加载/落盘）。 */
export function normalizeRtlFixAudit(raw: unknown): RtlFixAuditView | null {
  const data = asRecord(raw)
  if (!data) return null
  return {
    rootCauseId: asString(data.rootCauseId),
    scenarioId: asString(data.scenarioId),
    fixSessionName: asString(data.fixSessionName),
    startedAt: asString(data.startedAt),
    settledAt: asString(data.settledAt),
    changed: asStringArray(data.changed),
    created: asStringArray(data.created),
    deleted: asStringArray(data.deleted),
    blockedAttempts: asNumber(data.blockedAttempts)
  }
}

/** root-causes.json 归一化；接受文件对象或裸 records 数组，坏条目丢弃。 */
export function normalizeRootCauseRecords(raw: unknown): RootCauseRecordView[] {
  const list = Array.isArray(raw) ? raw : (Array.isArray(asRecord(raw)?.records) ? asRecord(raw)?.records as unknown[] : [])
  return list
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      id: asString(item.id),
      scenarioId: asString(item.scenarioId),
      hypothesis: asString(item.hypothesis),
      verdict: normalizeRootCauseVerdict(item.verdict),
      refutedHypotheses: asStringArray(item.refutedHypotheses),
      failureSignature: asString(item.failureSignature),
      rootCause: asString(item.rootCause),
      fix: asString(item.fix),
      evidence: asStringArray(item.evidence),
      createdAt: asString(item.createdAt)
    }))
}

const DIAGNOSTIC_LEVELS: readonly DiagnosticLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5']

function normalizeDiagnosticLevel(value: unknown): DiagnosticLevel {
  return DIAGNOSTIC_LEVELS.includes(value as DiagnosticLevel) ? value as DiagnosticLevel : 'L0'
}

/** diagnostic-control.json 归一化；非对象返回 null（按无诊断账本处理）。 */
export function normalizeDiagnosticControl(raw: unknown): DiagnosticControlView | null {
  const data = asRecord(raw)
  if (!data) return null
  const attempts = (Array.isArray(data.attempts) ? data.attempts : [])
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      id: asString(item.id),
      topModule: asString(item.topModule),
      testcase: asString(item.testcase),
      passed: asBoolean(item.passed),
      createdAt: asString(item.createdAt),
      durationMs: asNumber(item.durationMs),
      failureSignature: asString(item.failureSignature),
      rtlHash: asString(item.rtlHash),
      testbenchHash: asString(item.testbenchHash),
      diagnosticLevel: normalizeDiagnosticLevel(item.diagnosticLevel),
      observations: asStringArray(item.observations),
      evidence: asStringArray(item.evidence)
    }))
    .slice(-40)
  return {
    updatedAt: asString(data.updatedAt),
    mode: normalizeDiagnosticMode(data.mode),
    activeCase: asString(data.activeCase),
    attempts,
    recommendation: asString(data.recommendation)
  }
}

// ============================================================
// 派生 helper
// ============================================================

/**
 * 修复判定账本按 rootCauseId 取最新一条（账本本身新记录在前，首次出现即最新）。
 * 供修复卡/根因链联查修复判定徽标。
 */
export function latestOutcomesByRootCause(outcomes: RtlFixOutcomeView[]): Map<string, RtlFixOutcomeView> {
  const latest = new Map<string, RtlFixOutcomeView>()
  for (const outcome of outcomes) {
    if (!latest.has(outcome.rootCauseId)) latest.set(outcome.rootCauseId, outcome)
  }
  return latest
}

/**
 * 诊断账本逐条重放：按 moonglass-tools 的落账口径推导每次尝试后的 mode，
 * 标出首次进入 DIAGNOSTIC_ENHANCEMENT 的尝试与触发条件
 * （同指纹失败 ≥2 次 / ≥3 次尝试且诊断等级未爬升）。
 */
export function deriveDiagnosticReplay(attempts: DiagnosticAttemptView[]): DiagnosticReplayEntry[] {
  const entries: DiagnosticReplayEntry[] = []
  let enhancementEntered = false
  attempts.forEach((attempt, index) => {
    const caseKey = `${attempt.topModule}::${attempt.testcase}`
    const related = attempts.slice(0, index + 1).filter((item) => `${item.topModule}::${item.testcase}` === caseKey)
    const sameFailure = related.filter((item) => !item.passed && item.failureSignature === attempt.failureSignature)
    const maxEarlierLevel = Math.max(-1, ...related.slice(0, -1).map((item) => Number(item.diagnosticLevel.slice(1))))
    const noProgress = !attempt.passed && Number(attempt.diagnosticLevel.slice(1)) <= maxEarlierLevel
    const repeated = !attempt.passed && (sameFailure.length >= 2 || (related.length >= 3 && noProgress))
    const mode: DiagnosticMode = attempt.passed ? 'CLOSED' : repeated ? 'DIAGNOSTIC_ENHANCEMENT' : 'NORMAL_DEBUG'
    const isEnhancementEntry = !enhancementEntered && mode === 'DIAGNOSTIC_ENHANCEMENT'
    if (isEnhancementEntry) enhancementEntered = true
    entries.push({
      index,
      attempt,
      mode,
      isEnhancementEntry,
      trigger: isEnhancementEntry ? (sameFailure.length >= 2 ? 'same-fingerprint' : 'stalled') : null
    })
  })
  return entries
}


/** 模块 UT 会话账本视图（verification/results/ut-sessions.json；主进程契约落地前按宽松形状解析） */
export interface UtSessionsView {
  /** 进行中的 UT 数（活跃计数制：多模块可并行，全部结束才归零） */
  active: number
  /** 进行中的模块名列表（账本条目可解析出模块名时给出） */
  modules: string[]
}

/** ut-sessions.json 归一化；非对象返回 null。active 优先取显式计数，否则按活跃条目数推导。 */
export function normalizeUtSessions(raw: unknown): UtSessionsView | null {
  const data = asRecord(raw)
  if (!data) return null
  const sessions = Array.isArray(data.sessions) ? data.sessions : []
  const activeEntries = sessions.filter((entry) => {
    const record = asRecord(entry)
    if (!record) return false
    return record.state === 'active' || record.state === 'running' || record.active === true
  })
  const modules = activeEntries
    .map((entry) => {
      const record = asRecord(entry)
      return record ? asString(record.module ?? record.moduleName ?? record.name) : ''
    })
    .filter(Boolean)
  const active = typeof data.active === 'number' && Number.isFinite(data.active) ? data.active : activeEntries.length
  return { active, modules }
}

/** 时间戳显示：ISO → 本地化字符串；非法/空值原样返回（页面既有惯例 new Date(...).toLocaleString()）。 */
export function formatVerifTimestamp(iso: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}
