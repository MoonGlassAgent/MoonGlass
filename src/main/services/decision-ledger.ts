/**
 * VERIF 验证运行循环决策账本（VERIF-RUN-LOOP 批 3，设计文档 §3.2/§3.3/§9.2）。
 *
 * 纯函数模块：仅依赖 node:fs / node:path / node:crypto 与 shared 推导内核白名单，
 * 不引入 electron，供 AgentService 循环驱动与 decide IPC 调用，
 * 并可由 scripts/decision-ledger-smoke.mjs 直接转译测试
 * （与 verif-run-loop.ts / verif-loop-ledger.ts 同口径）。
 *
 * 追加式决策账本：verification/results/decision-ledger.json（§9.2），
 * 规则/LLM/工程师三源决策序列化为同一份记录（设计原则 2），新在前、滚动 ≤100 条、
 * 原子写 + 缺字段归一。LLM 经 pi 工具 propose_run_decision 登记（pi-bridge 侧自带
 * 同 schema 的落盘实现——桥接目录无法 import 本模块，读写口径以本文件为准）；
 * 工程师在会话中明确指示改方向时同工具转写为 source:'human' 且直接 approved（§3.3）。
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { VerifRunDecision, VerifRunDecisionAction, VerifRunDecisionLedger, VerifRunDecisionOutcome, VerifRunDecisionStatus, VerifRunLoopBudget } from '@shared/types'
import { VERIFICATION_DERIVED_ACTION_IDS } from '@shared/verification-guidance'

/** 账本滚动上限（§9.2：≤100 条，新在前） */
export const DECISION_LEDGER_LIMIT = 100
/** rationale 长度上限（§9.2：≤200 字） */
export const DECISION_RATIONALE_MAX = 200
/** 决策动作 prompt 长度上限（批 3 合法性校验：≤4000 字） */
export const DECISION_PROMPT_MAX = 4000
/** 决策 ID 形态：DEC-<8hex>（§9.2） */
export const DECISION_ID_PATTERN = /^DEC-[0-9A-F]{8}$/

const LEDGER_RELATIVE_PATH = join('verification', 'results', 'decision-ledger.json')

export function decisionLedgerPath(workspace: string): string {
  return join(workspace, LEDGER_RELATIVE_PATH)
}

/** 生成 DEC-<8hex> id；与现存条目撞号时重掷（16^8 空间，实际几乎不可能发生）。 */
function generateDecisionId(existing: ReadonlySet<string>): string {
  for (;;) {
    const id = `DEC-${randomBytes(4).toString('hex').toUpperCase()}`
    if (!existing.has(id)) return id
  }
}

// ==================== 账本读写（原子写 + 缺字段归一，与 verif-loop-ledger 同风格） ====================

function normalizeAction(value: unknown): VerifRunDecisionAction {
  const action = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  return {
    kind: action.kind === 'custom' ? 'custom' : 'derived',
    actionId: typeof action.actionId === 'string' ? action.actionId : null,
    prompt: String(action.prompt ?? ''),
    expectedOutput: String(action.expectedOutput ?? ''),
    stopCriteria: String(action.stopCriteria ?? '')
  }
}

function normalizeOutcome(value: unknown): VerifRunDecisionOutcome {
  return value === 'advanced' || value === 'no-progress' || value === 'failed' ? value : null
}

function normalizeDecision(value: unknown): VerifRunDecision | null {
  if (typeof value !== 'object' || value === null) return null
  const item = value as Record<string, unknown>
  const status: VerifRunDecisionStatus =
    item.status === 'proposed' || item.status === 'approved' || item.status === 'rejected' ||
    item.status === 'executed' || item.status === 'superseded' ? item.status : 'rejected'
  const source = item.source === 'llm' || item.source === 'human' ? item.source : 'rule'
  return {
    id: String(item.id ?? ''),
    createdAt: String(item.createdAt ?? ''),
    source,
    trigger: String(item.trigger ?? ''),
    action: normalizeAction(item.action),
    rationale: String(item.rationale ?? ''),
    evidenceRefs: Array.isArray(item.evidenceRefs) ? item.evidenceRefs.map(String) : [],
    status,
    outcome: normalizeOutcome(item.outcome)
  }
}

/** 读取决策账本；不存在/损坏返回 null（调用方按无账本处理）。缺字段归一（version 演进预留）。 */
export function readDecisionLedger(workspace: string): VerifRunDecisionLedger | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(decisionLedgerPath(workspace), 'utf-8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const data = raw as Record<string, unknown>
  const decisions = Array.isArray(data.decisions)
    ? data.decisions.map(normalizeDecision).filter((item): item is VerifRunDecision => item !== null)
    : []
  return { version: 1, decisions: decisions.slice(0, DECISION_LEDGER_LIMIT) }
}

/** 原子写决策账本（临时文件 + rename，避免 UI 读到半截 JSON）。 */
export function writeDecisionLedger(workspace: string, ledger: VerifRunDecisionLedger): void {
  const path = decisionLedgerPath(workspace)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, JSON.stringify({ ...ledger, version: 1 }, null, 2), 'utf-8')
  renameSync(temporary, path)
}

/** 读取-变更-原子写的一站式入口；文件缺失时空账本起步；每次写入强制滚动上限。 */
export function updateDecisionLedger(workspace: string, mutate: (ledger: VerifRunDecisionLedger) => void): VerifRunDecisionLedger {
  const ledger = readDecisionLedger(workspace) ?? { version: 1 as const, decisions: [] }
  mutate(ledger)
  ledger.decisions = ledger.decisions.slice(0, DECISION_LEDGER_LIMIT)
  writeDecisionLedger(workspace, ledger)
  return ledger
}

// ==================== 登记 / 状态迁移 / 结果回填（驱动与 smoke 共用） ====================

/**
 * 规则层自动决策记账（§4.2：有动作 → 记录决策 source:'rule'）：
 * 每拍派发的规则动作登记为 trigger='rule-auto'、status='executed'；
 * 拍判定后由 recordDecisionOutcome 回填 outcome。规则自动记录不参与批准前合法性校验。
 */
export function appendRunLoopRuleDecision(
  workspace: string,
  input: { actionId: string | null; prompt: string; expectedOutput?: string; stopCriteria?: string; rationale?: string },
  now: string = new Date().toISOString()
): VerifRunDecision {
  const existingIds = new Set((readDecisionLedger(workspace)?.decisions ?? []).map((item) => item.id))
  const record: VerifRunDecision = {
    id: generateDecisionId(existingIds),
    createdAt: now,
    source: 'rule',
    trigger: 'rule-auto',
    action: {
      kind: 'derived',
      actionId: input.actionId,
      prompt: input.prompt,
      expectedOutput: input.expectedOutput ?? '',
      stopCriteria: input.stopCriteria ?? ''
    },
    rationale: input.rationale ?? '',
    evidenceRefs: [],
    status: 'executed',
    outcome: null
  }
  updateDecisionLedger(workspace, (ledger) => {
    ledger.decisions.unshift(record)
  })
  return record
}

/**
 * 决策状态迁移（decide IPC 批准/否决；approved 可附 editedPrompt 覆盖 action.prompt）。
 * 决策不存在返回 null（调用方按 404 处理）；状态已非 proposed 时返回 null（调用方按冲突处理）。
 */
export function markDecisionStatus(
  workspace: string,
  decisionId: string,
  status: VerifRunDecisionStatus,
  patch?: { prompt?: string }
): VerifRunDecision | null {
  let updated: VerifRunDecision | null = null
  updateDecisionLedger(workspace, (ledger) => {
    const decision = ledger.decisions.find((item) => item.id === decisionId)
    if (!decision || decision.status !== 'proposed') return
    decision.status = status
    if (patch?.prompt !== undefined) decision.action.prompt = patch.prompt
    updated = decision
  })
  return updated
}

/** 执行结果回填（拍判定 advanced/no-progress，或会话异常 failed）；决策不存在静默跳过。 */
export function recordDecisionOutcome(workspace: string, decisionId: string, outcome: Exclude<VerifRunDecisionOutcome, null>): void {
  if (!decisionId) return
  updateDecisionLedger(workspace, (ledger) => {
    const decision = ledger.decisions.find((item) => item.id === decisionId)
    if (decision) decision.outcome = outcome
  })
}

/** 下一拍待执行的已批准决策：status='approved' 且 outcome=null（新在前，取第一条）。 */
export function nextRunnableDecision(workspace: string): VerifRunDecision | null {
  const ledger = readDecisionLedger(workspace)
  if (!ledger) return null
  return ledger.decisions.find((item) => item.status === 'approved' && item.outcome === null) ?? null
}

/**
 * 升级会话 settle 后的新提案集合：after 中 status='proposed' 且 id 不在 before 内的条目。
 * before 传升级派发前读到的 decisions（AgentService 持有），防历史提案被重复计数。
 */
export function findNewProposedDecisions(before: readonly VerifRunDecision[], after: readonly VerifRunDecision[]): VerifRunDecision[] {
  const beforeIds = new Set(before.map((item) => item.id))
  return after.filter((item) => item.status === 'proposed' && !beforeIds.has(item.id))
}

// ==================== 规则层合法性校验（§3.2 守门：批准前校验，不过 → rejected 带原因） ====================

export interface DecisionApprovalCheck {
  ok: boolean
  /** ok=false 时的拒绝原因（decide IPC 记入异常消息；账本记录保持 schema 纯净不落原因字段） */
  reason: string
}

/**
 * 决策批准前合法性校验（设计原则 2：复数来源过同一道校验）：
 * 停止条件/期望产出非空、prompt 非空且 ≤4000 字、rationale ≤200 字、
 * derived 类 actionId 必须命中推导内核白名单（custom 类 actionId 必须为 null）、预算未超限。
 * budget 传 null（循环账本缺失）时跳过预算维度。
 */
/**
 * 校验失败是否属"环境类"（预算超限）：提案本身合法、只是环境暂不满足——
 * 不应记 rejected（保持提案待裁决可重试）；结构类失败（缺字段/超长/幻觉 actionId）才终结提案。
 */
export function isBudgetExceededRejection(reason: string): boolean {
  return /预算已超限/.test(reason)
}

export function validateDecisionForApproval(
  decision: VerifRunDecision,
  budget: VerifRunLoopBudget | null,
  nowIso: string
): DecisionApprovalCheck {
  const action = decision.action
  if (!action.stopCriteria.trim()) return { ok: false, reason: '停止条件（stopCriteria）为空' }
  if (!action.expectedOutput.trim()) return { ok: false, reason: '期望产出（expectedOutput）为空' }
  if (!action.prompt.trim()) return { ok: false, reason: '动作指令（prompt）为空' }
  if (action.prompt.length > DECISION_PROMPT_MAX) return { ok: false, reason: `动作指令超过 ${DECISION_PROMPT_MAX} 字（当前 ${action.prompt.length} 字）` }
  if (decision.rationale.length > DECISION_RATIONALE_MAX) return { ok: false, reason: `决策理由超过 ${DECISION_RATIONALE_MAX} 字（当前 ${decision.rationale.length} 字）` }
  if (action.kind === 'derived') {
    if (!action.actionId || !VERIFICATION_DERIVED_ACTION_IDS.includes(action.actionId)) {
      return { ok: false, reason: `derived 类动作 id 不在推导内核白名单：${action.actionId ?? '(空)'}` }
    }
  } else if (action.actionId !== null) {
    return { ok: false, reason: `custom 类动作 actionId 必须为 null（当前 ${action.actionId}）` }
  }
  if (budget) {
    if (budget.beats >= budget.maxBeats) return { ok: false, reason: `循环步数预算已超限（${budget.beats}/${budget.maxBeats}）` }
    if (budget.tokensUsed >= budget.maxTokens) return { ok: false, reason: `token 预算已超限（${budget.tokensUsed}/${budget.maxTokens}）` }
    const startedAt = Date.parse(budget.startedAt)
    if (Number.isFinite(startedAt)) {
      const elapsedMinutes = Math.floor((Date.parse(nowIso) - startedAt) / 60_000)
      if (elapsedMinutes >= budget.maxWallMinutes) {
        return { ok: false, reason: `墙钟预算已超限（${elapsedMinutes}/${budget.maxWallMinutes} 分钟）` }
      }
    }
  }
  return { ok: true, reason: '' }
}

// ==================== pi 工具事件提取（tool_execution_end → 决策提案，聊天面板可见性） ====================

export interface RunLoopDecisionProposal {
  id: string
  source: string
  trigger: string
  status: string
  rationale: string
}

/**
 * 从 pi tool_execution_end 事件提取 propose_run_decision 登记结果（主进程侧唯一入口，
 * 与 rtl-fix-verdict.extractConfirmedRtlFix 同模式）：工具出错或缺 details.record 返回 null。
 */
export function extractRunLoopDecisionProposal(event: Record<string, unknown>): RunLoopDecisionProposal | null {
  if (event.type !== 'tool_execution_end') return null
  if (Boolean(event.isError)) return null
  if (String(event.toolName ?? '') !== 'propose_run_decision') return null
  const result = (event.result ?? {}) as { details?: { record?: Record<string, unknown> } }
  const record = result.details?.record
  if (!record || typeof record.id !== 'string' || !record.id) return null
  return {
    id: record.id,
    source: String(record.source ?? ''),
    trigger: String(record.trigger ?? ''),
    status: String(record.status ?? ''),
    rationale: String(record.rationale ?? '')
  }
}
