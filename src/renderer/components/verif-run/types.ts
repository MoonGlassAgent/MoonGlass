/**
 * 验证失败诊断与修复可视化（方案 C）渲染端视图类型与缺字段归一化 helper。
 *
 * 镜像主进程落盘 JSON 的 schema（渲染端禁止 import src/main 或引擎包，类型在此镜像定义）：
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
// 批次循环状态（verif-batch-loop.json）
// ============================================================

export type VerifLoopState = 'idle' | 'running' | 'awaiting-rtl-fix' | 'circuit-broken' | 'completed' | 'stopped'

/** 当前批次（循环内正在执行的批次；无则为 null） */
export interface VerifLoopCurrentBatch {
  /** 第 n 批（本次循环序号） */
  index: number
  sessionName: string
  scenarioIds: string[]
  dispatchedAt: string
  /** dispatched=批次会话已派发、执行中；settling=会话已结束、完成判定进行中 */
  phase: 'dispatched' | 'settling'
}

/** 本次循环已完成批次的历史条目（新记录在前，≤20 条） */
export interface VerifLoopHistoryEntry {
  index: number
  scenarioIds: string[]
  verdict: 'completed' | 'circuit-broken'
  /** 完成判定细节（缺哪个 scenario 登记）或熔断原因 */
  reason: string
  settledAt: string
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
  const history = (Array.isArray(data.history) ? data.history : [])
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => ({
      index: asNumber(item.index),
      scenarioIds: asStringArray(item.scenarioIds),
      verdict: item.verdict === 'completed' ? 'completed' as const : 'circuit-broken' as const,
      reason: asString(item.reason),
      settledAt: asString(item.settledAt)
    }))
    .slice(0, 20)
  return {
    updatedAt: asString(data.updatedAt),
    state: normalizeLoopState(data.state),
    currentBatch: batch ? {
      index: asNumber(batch.index),
      sessionName: asString(batch.sessionName),
      scenarioIds: asStringArray(batch.scenarioIds),
      dispatchedAt: asString(batch.dispatchedAt),
      phase: batch.phase === 'settling' ? 'settling' : 'dispatched'
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

/** 时间戳显示：ISO → 本地化字符串；非法/空值原样返回（页面既有惯例 new Date(...).toLocaleString()）。 */
export function formatVerifTimestamp(iso: string): string {
  if (!iso) return ''
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}
