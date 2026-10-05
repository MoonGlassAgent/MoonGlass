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
  /模型服务限流/
]

/** 错误文本是否为瞬时供应商/网络故障（可重试）；空/null 不算。 */
export function isTransientSessionError(errorMessage: string | null | undefined): boolean {
  const text = (errorMessage ?? '').trim()
  return text.length > 0 && TRANSIENT_SESSION_ERROR_PATTERNS.some((pattern) => pattern.test(text))
}
