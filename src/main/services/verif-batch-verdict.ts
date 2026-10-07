/**
 * VERIF 批次完成判定（上下文治理第 3 批，决策 4/7）。
 *
 * 纯函数模块：仅依赖 node:fs / node:path，不引入 electron，
 * 供 AgentService 批次编排调用，并由 scripts/verif-batch-verdict-smoke.mjs 直接转译测试。
 *
 * 判定绑定工具登记证据（scenario_hits 登记 + posture 重建时间戳），不读会话文本。
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import type { VerifBatchVerdict } from '@shared/types'

/**
 * 读取 verification/results/&#42;&#42;/scenario_hits.json：场景 ID（统一大写）→ 最近一次登记所在
 * 文件的落盘时间（毫秒）。同一场景在多个文件中登记时取最新的一份——"本批是否取得新增证据"
 * 取决于最新的那次登记，而不是历史上任意一次。
 */
export function readScenarioRegistrationTimes(workspaceDir: string): Map<string, number> {
  const registeredAt = new Map<string, number>()
  const walk = (dir: string): void => {
    let entries: Dirent[] = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (entry.name !== 'scenario_hits.json') continue
      let modifiedAt = 0
      try {
        modifiedAt = statSync(path).mtimeMs
      } catch {
        continue
      }
      try {
        const data = JSON.parse(readFileSync(path, 'utf-8')) as { scenarios?: Array<{ id?: unknown }> }
        for (const scenario of data.scenarios ?? []) {
          if (typeof scenario.id !== 'string') continue
          const id = scenario.id.toUpperCase()
          registeredAt.set(id, Math.max(registeredAt.get(id) ?? 0, modifiedAt))
        }
      } catch { /* 忽略损坏的登记文件 */ }
    }
  }
  walk(join(workspaceDir, 'verification', 'results'))
  return registeredAt
}

/** 兼容入口：仅关心"是否登记过"的调用方使用。 */
export function readRegisteredScenarioIds(workspaceDir: string): Set<string> {
  return new Set(readScenarioRegistrationTimes(workspaceDir).keys())
}

/** 登记与派发之间存在毫秒级时差，容忍 1 秒，避免把本批自己的登记误判为历史重放。 */
const REGISTRATION_FRESHNESS_GRACE_MS = 1000

/**
 * 批次完成判定（决策 4）：批次 settle 后校验——
 * 1. 每个 scenarioId 都在 verification/results/&#42;&#42;/scenario_hits.json 中有登记记录；
 * 2. verification/intelligence/verification-posture.json 的 generatedAt 晚于批次开始时间。
 * 全齐 → complete=true；缺一 → complete=false，reasons 结构化说明缺哪些。
 *
 * 口径分离（2026-10-05）：complete 只表示**批次会话契约**完成，不等于场景通过、验证进展或签核。
 * 因此额外给出 freshScenarioIds / replayedScenarioIds：仅有历史登记（登记文件落盘早于本批开始）
 * 说明本批没有取得新增执行证据，只是重放了旧登记。该信号不改变 complete（诊断类批次按约定
 * 交付登记与态势即为完成），但必须可观测——它是"空转批次"的唯一结构化线索。
 */
export function judgeBatchCompletion(workspaceDir: string, scenarioIds: string[], batchStartedAt: string): VerifBatchVerdict {
  const registeredAt = readScenarioRegistrationTimes(workspaceDir)
  const batchStartMs = Date.parse(batchStartedAt)
  const freshnessFloor = Number.isFinite(batchStartMs) ? batchStartMs - REGISTRATION_FRESHNESS_GRACE_MS : Number.NEGATIVE_INFINITY
  const normalized = scenarioIds.map((id) => id.toUpperCase())
  const missingScenarioIds = normalized.filter((id) => !registeredAt.has(id))
  const replayedScenarioIds = normalized.filter((id) => {
    const at = registeredAt.get(id)
    return at !== undefined && at < freshnessFloor
  })
  const freshScenarioIds = normalized.filter((id) => {
    const at = registeredAt.get(id)
    return at !== undefined && at >= freshnessFloor
  })
  const posturePath = join(workspaceDir, 'verification', 'intelligence', 'verification-posture.json')
  let postureGeneratedAt: string | null = null
  if (existsSync(posturePath)) {
    try {
      const data = JSON.parse(readFileSync(posturePath, 'utf-8')) as { generatedAt?: unknown }
      if (typeof data.generatedAt === 'string') postureGeneratedAt = data.generatedAt
    } catch { /* 不可解析视为缺失 */ }
  }
  const postureFresh = postureGeneratedAt !== null && postureGeneratedAt > batchStartedAt
  const reasons: string[] = []
  if (missingScenarioIds.length > 0) reasons.push(`场景未登记 scenario_hits：${missingScenarioIds.join('、')}`)
  if (!postureFresh) {
    reasons.push(
      postureGeneratedAt
        ? `verification-posture.json 未在批次开始后重建（generatedAt=${postureGeneratedAt}，批次开始=${batchStartedAt}）`
        : 'verification-posture.json 不存在或不可解析'
    )
  }
  if (replayedScenarioIds.length > 0) {
    reasons.push(
      freshScenarioIds.length === 0
        ? `本批未取得新增执行证据，涉及场景仅有历史登记：${replayedScenarioIds.join('、')}（complete 表示批次会话契约完成，不等于场景通过或验证进展）`
        : `以下场景仅有历史登记、本批未取得新增证据：${replayedScenarioIds.join('、')}`
    )
  }
  return { complete: missingScenarioIds.length === 0 && postureFresh, missingScenarioIds, freshScenarioIds, replayedScenarioIds, postureGeneratedAt, postureFresh, reasons }
}

/** diagnostic-control.json 的最小形状（只取判定所需字段）。 */
export interface DiagnosticControlSnapshot {
  mode?: string
  attempts?: Array<{ diagnosticLevel?: string; passed?: boolean }>
}

/** 读取 verification/results/diagnostic-control.json；不存在或不可解析返回 null。 */
export function readDiagnosticControl(workspaceDir: string): DiagnosticControlSnapshot | null {
  try {
    return JSON.parse(readFileSync(join(workspaceDir, 'verification', 'results', 'diagnostic-control.json'), 'utf-8')) as DiagnosticControlSnapshot
  } catch {
    return null
  }
}

/**
 * 决策 7 的第二终止条件：diagnostic-control 进入 DIAGNOSTIC_ENHANCEMENT 且本批无进展。
 * “有进展”定义：本批新增尝试中有 PASS，或诊断等级（L0-L5）较基线有爬升。
 * 本批没有新尝试不算本批的熔断条件（该情形由证据缺失判定兜底）。
 */
export function isDiagnosticStalled(before: DiagnosticControlSnapshot | null, after: DiagnosticControlSnapshot | null): boolean {
  if (after?.mode !== 'DIAGNOSTIC_ENHANCEMENT') return false
  const prevAttempts = before?.attempts ?? []
  const allAttempts = after.attempts ?? []
  const fresh = allAttempts.slice(Math.min(prevAttempts.length, allAttempts.length))
  if (fresh.length === 0) return false
  if (fresh.some((attempt) => attempt.passed === true)) return false
  const levelOf = (attempt: { diagnosticLevel?: string }): number => {
    const match = /(\d+)/.exec(attempt.diagnosticLevel ?? '')
    return match ? Number(match[1]) : 0
  }
  const prevMax = Math.max(-1, ...prevAttempts.map(levelOf))
  // 无有效批次前快照时，首个新尝试只建立起点，爬升是相对它之后的尝试而言
  const baseline = prevAttempts.length > 0 ? prevMax : Math.max(prevMax, levelOf(fresh[0]!))
  return Math.max(...fresh.map(levelOf)) <= baseline
}

/**
 * 主进程侧的批次选择：读取 scenario-execution-plan.json 的前 limit 个计划场景。
 * 与 pi 工具 select_next_verification_batch 的默认路径对齐（无显式 budget/refresh 时
 * 复用已生成计划）；文件缺失或损坏返回 null，由调用方重建引擎产物后重读。
 */
export function readExecutionPlanBatch(workspaceDir: string, limit: number): string[] | null {
  const planPath = join(workspaceDir, 'verification', 'intelligence', 'scenario-execution-plan.json')
  try {
    const data = JSON.parse(readFileSync(planPath, 'utf-8')) as { plans?: Array<{ scenarioId?: unknown }> }
    if (!Array.isArray(data.plans)) return null
    return data.plans
      .slice(0, Math.max(1, limit))
      .map((plan) => String(plan.scenarioId ?? ''))
      .filter(Boolean)
  } catch {
    return null
  }
}

/**
 * 瞬时供应商/网络故障判定（批次编排自动重试的唯一放行类别，实测案例：PSRAM_CTRL 批次 7
 * 遇 openrouter 空响应 settle，无证据产出被熔断）。覆盖原始错误与 llm-resilience
 * humanizeLlmError 的中文语义化文案。watchdog 熔断/诊断停滞/用户停止不在此列。
 */
const TRANSIENT_SESSION_ERROR_PATTERNS: RegExp[] = [
  /empty response/i,
  /\b429\b/,
  /\b5\d\d\b/,
  /rate.?limit|overloaded|temporarily unavailable|service unavailable|bad gateway|gateway/i,
  /timed?\s*out|etimedout|esockettimedout|econnreset|econnrefused|socket hang up|fetch failed|network error/i,
  /模型服务暂时不可用/,
  /模型服务限流/,
  // pi-rpc 等待挂起类中文口径（实测：'[pi-rpc] 等待 Agent 事件超时' 曾不被识别为瞬时故障，
  // 批次挂起 60 分钟不重试）。只作用于会话级 errorMessage，不经工具日志文本
  /等待\s*Agent\s*事件/,
  /超时/,
  /无响应/
]

/** 错误文本是否为瞬时供应商/网络故障（可重试）；空/null 不算。 */
export function isTransientSessionError(errorMessage: string | null | undefined): boolean {
  const text = (errorMessage ?? '').trim()
  return text.length > 0 && TRANSIENT_SESSION_ERROR_PATTERNS.some((pattern) => pattern.test(text))
}

// ==================== 批次选择避让（实测 DEC_Visinex：同一对场景 novelty=0 连续 4 轮选中→失败→熔断→再选） ====================

/** 避让推导所需的最小 history 条目形状（与 verif-loop-ledger 的 VerifLoopHistoryEntry 结构兼容）。 */
export interface ScenarioAvoidanceHistoryEntry {
  scenarioIds: readonly string[]
  verdict: string
}

/** 连续熔断回避阈值：同一场景最近连续熔断/无证据 ≥2 次才降级避让（单次失败不给避让，避免抖动误伤）。 */
export const SCENARIO_AVOIDANCE_STREAK_THRESHOLD = 2

/**
 * 场景的"最近连续熔断次数"：自最新 history 条目向旧遍历（history 新在前），
 * 只统计涉及该场景的条目——circuit-broken / no-evidence 各计 1 次；
 * 遇 completed（同 id 批次证据齐）清零并停止（更老历史已被本次闭环隔断）；
 * 不涉及该场景的条目不影响该场景的连续计数。场景 ID 大小写归一比较。
 */
export function consecutiveCircuitBreakCount(
  history: readonly ScenarioAvoidanceHistoryEntry[],
  scenarioId: string
): number {
  const id = scenarioId.trim().toUpperCase()
  if (!id) return 0
  let streak = 0
  for (const entry of history) {
    const involves = entry.scenarioIds.some((item) => item.trim().toUpperCase() === id)
    if (!involves) continue
    if (entry.verdict === 'completed') break
    if (entry.verdict === 'circuit-broken' || entry.verdict === 'no-evidence') streak += 1
  }
  return streak
}

/**
 * 批次选择避让（聚类批内执行，不跨批拼凑）：对选批结果应用 history 推导的连续熔断降级——
 * - 连续熔断/无证据 ≥2 的场景排后：本批只取未熔断/低熔断场景（保持原相对顺序）；
 * - 取不足（本批全部被熔断场景占满）时回补原样返回，交给外层 rule-stall 升级；
 * - 无熔断场景时原样返回。
 * 输出恒为输入子集（保持聚类归属语义：同批仍同模块/同 Oracle 域），只减不增。
 */
export function applyScenarioAvoidance(
  ids: readonly string[],
  history: readonly ScenarioAvoidanceHistoryEntry[]
): string[] {
  const unique = [...new Set(ids.map((id) => id.trim().toUpperCase()).filter(Boolean))]
  if (unique.length === 0) return []
  const broken = unique.filter((id) => consecutiveCircuitBreakCount(history, id) >= SCENARIO_AVOIDANCE_STREAK_THRESHOLD)
  // 无避让对象 / 全部被熔断场景占满（取不足再回补）：原样返回
  if (broken.length === 0 || broken.length === unique.length) return unique
  const brokenSet = new Set(broken)
  return unique.filter((id) => !brokenSet.has(id))
}

// ==================== 批次运行状态归类（决策 4 熔断口径 + 4b 无执行批次合法出口的单一事实） ====================

/** 批次 settle 后的会话事实输入（证据判定的结构化结果，不读会话文本）。 */
export interface BatchBreakerInput {
  /** judgeBatchCompletion 的 complete：登记 + posture 重建时间戳全齐 */
  evidenceComplete: boolean
  /** 证据缺失的结构化说明（verdict.reasons），仅用于熔断消息拼接 */
  evidenceReasons: readonly string[]
  /** 批次会话级异常消息（null=正常 settle） */
  errorMessage: string | null
  /** isTransientSessionError(errorMessage)：瞬时故障不推翻证据，且触发自动重试 */
  transientSessionError: boolean
  /** watchdog 熔断原因（null=未熔断） */
  watchdogAbort: string | null
  /** 用户停止托管 */
  userStopped: boolean
  /** isDiagnosticStalled：DIAGNOSTIC_ENHANCEMENT 且本批诊断等级无进展 */
  diagnosticStalled: boolean
}

export interface BatchBreakerVerdict {
  /**
   * completed=证据齐（尾随瞬时故障不推翻证据）；circuit-broken=熔断类；
   * no-evidence=会话正常 settle（无异常/watchdog/用户停止/诊断停滞）但证据缺失——
   * 场景无需执行/会话纯分析是合法结果（三重闩锁之二实测），不熔断，循环内延后重选
   */
  status: 'completed' | 'circuit-broken' | 'no-evidence'
  /** circuit-broken 时的熔断原因串（'；'连接）；其余状态为 null */
  circuitBreaker: string | null
}

/**
 * 批次 settle 后的状态归类：先按决策 4/7 口径组熔断原因（与历史实现逐条一致），
 * 再在熔断分支前区分 no-evidence 合法出口——只豁免"会话正常结束 + 证据缺失"这一组合，
 * 其余熔断条件（会话异常/watchdog/用户停止/诊断停滞）一律不动，证据绑定哲学不变。
 */
export function judgeBatchBreakers(input: BatchBreakerInput): BatchBreakerVerdict {
  const breakers: string[] = []
  if (input.errorMessage && !(input.evidenceComplete && input.transientSessionError)) breakers.push(`批次会话异常：${input.errorMessage}`)
  if (input.watchdogAbort) breakers.push(`watchdog 熔断：${input.watchdogAbort}`)
  if (input.userStopped) breakers.push('用户停止托管')
  if (!input.evidenceComplete) breakers.push(`证据缺失：${input.evidenceReasons.join('；')}`)
  if (input.diagnosticStalled) breakers.push('diagnostic-control 进入 DIAGNOSTIC_ENHANCEMENT 且本批诊断等级无进展')
  if (breakers.length === 0) return { status: 'completed', circuitBreaker: null }
  const settledCleanly = !input.errorMessage && !input.watchdogAbort && !input.userStopped && !input.diagnosticStalled
  if (!input.evidenceComplete && settledCleanly) return { status: 'no-evidence', circuitBreaker: null }
  return { status: 'circuit-broken', circuitBreaker: breakers.join('；') }
}
