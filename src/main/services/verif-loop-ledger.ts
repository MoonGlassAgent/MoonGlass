/**
 * VERIF 批次循环状态落盘（失败诊断与修复可视化方案 C 批 1，设计文档 §3.2）。
 *
 * 纯函数模块：仅依赖 node:fs / node:path，不引入 electron，
 * 供 AgentService 批次编排调用，并可由 smoke 直接转译测试
 * （与 verif-batch-verdict.ts / rtl-fix-audit.ts 同口径）。
 *
 * 覆盖式状态文件（非追加账本）：verification/results/verif-batch-loop.json，
 * runVerifBatches 各状态转换点原子更新；循环结束（completed/circuit-broken/stopped）
 * 保留终态，下次循环开始（running）覆盖。读取方一律做缺字段归一（version 演进预留）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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

/** 本次循环已完成批次的历史条目（新记录在前，滚动 ≤ VERIF_LOOP_HISTORY_LIMIT 条） */
export interface VerifLoopHistoryEntry {
  index: number
  scenarioIds: string[]
  /** 批次 error 状态按熔断类归并（与 runVerifBatches 的停止口径一致） */
  verdict: 'completed' | 'circuit-broken'
  /** 完成判定细节（缺哪个 scenario 登记）或熔断原因 */
  reason: string
  settledAt: string
}

export type VerifLoopState = 'idle' | 'running' | 'awaiting-rtl-fix' | 'circuit-broken' | 'completed' | 'stopped'

/** 批次循环状态文件（verification/results/verif-batch-loop.json，覆盖式） */
export interface VerifBatchLoopLedger {
  version: 1
  updatedAt: string
  state: VerifLoopState
  currentBatch: VerifLoopCurrentBatch | null
  /** 熔断原因结构化（state=circuit-broken 时有值） */
  circuitBreaker: { reason: string; detail: string } | null
  /** 等修复暂停（state=awaiting-rtl-fix 时有值） */
  rtlFixWait: { rootCauseId: string; since: string } | null
  history: VerifLoopHistoryEntry[]
}

export const VERIF_LOOP_HISTORY_LIMIT = 20

const LEDGER_RELATIVE_PATH = join('verification', 'results', 'verif-batch-loop.json')

export function verifLoopLedgerPath(workspace: string): string {
  return join(workspace, LEDGER_RELATIVE_PATH)
}

/** 状态枚举归一：未知/缺失按 idle 处理（version 演进预留）。 */
function normalizeState(value: unknown): VerifLoopState {
  return value === 'running' || value === 'awaiting-rtl-fix' || value === 'circuit-broken' || value === 'completed' || value === 'stopped' ? value : 'idle'
}

function normalizeCurrentBatch(value: unknown): VerifLoopCurrentBatch | null {
  if (typeof value !== 'object' || value === null) return null
  const batch = value as Record<string, unknown>
  return {
    index: Number(batch.index ?? 0) || 0,
    sessionName: String(batch.sessionName ?? ''),
    scenarioIds: Array.isArray(batch.scenarioIds) ? batch.scenarioIds.map(String) : [],
    dispatchedAt: String(batch.dispatchedAt ?? ''),
    phase: batch.phase === 'settling' ? 'settling' : 'dispatched'
  }
}

function normalizeHistory(value: unknown): VerifLoopHistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      index: Number(item.index ?? 0) || 0,
      scenarioIds: Array.isArray(item.scenarioIds) ? item.scenarioIds.map(String) : [],
      verdict: item.verdict === 'completed' ? 'completed' as const : 'circuit-broken' as const,
      reason: String(item.reason ?? ''),
      settledAt: String(item.settledAt ?? '')
    }))
    .slice(0, VERIF_LOOP_HISTORY_LIMIT)
}

/** 读取状态文件；不存在/损坏返回 null（调用方按无循环记录处理）。缺字段归一为默认值。 */
export function readVerifLoopLedger(workspace: string): VerifBatchLoopLedger | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(verifLoopLedgerPath(workspace), 'utf-8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const data = raw as Record<string, unknown>
  const breaker = typeof data.circuitBreaker === 'object' && data.circuitBreaker !== null ? data.circuitBreaker as Record<string, unknown> : null
  const wait = typeof data.rtlFixWait === 'object' && data.rtlFixWait !== null ? data.rtlFixWait as Record<string, unknown> : null
  return {
    version: 1,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
    state: normalizeState(data.state),
    currentBatch: normalizeCurrentBatch(data.currentBatch),
    circuitBreaker: breaker ? { reason: String(breaker.reason ?? ''), detail: String(breaker.detail ?? '') } : null,
    rtlFixWait: wait ? { rootCauseId: String(wait.rootCauseId ?? ''), since: String(wait.since ?? '') } : null,
    history: normalizeHistory(data.history)
  }
}

/** 原子写状态文件（临时文件 + rename，避免 UI 读到半截 JSON）；写入时刷新 updatedAt。 */
export function writeVerifLoopLedger(workspace: string, ledger: VerifBatchLoopLedger): void {
  const path = verifLoopLedgerPath(workspace)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, JSON.stringify({ ...ledger, version: 1, updatedAt: new Date().toISOString() }, null, 2), 'utf-8')
  renameSync(temporary, path)
}

/**
 * 读取-变更-原子写的一站式入口（AgentService 各转换点调用）：
 * 文件缺失时从 idle 初值起步；每次写入强制 history 滚动上限。
 */
export function updateVerifLoopLedger(workspace: string, mutate: (ledger: VerifBatchLoopLedger) => void): VerifBatchLoopLedger {
  const ledger = readVerifLoopLedger(workspace) ?? { version: 1 as const, updatedAt: '', state: 'idle' as const, currentBatch: null, circuitBreaker: null, rtlFixWait: null, history: [] }
  mutate(ledger)
  ledger.history = ledger.history.slice(0, VERIF_LOOP_HISTORY_LIMIT)
  writeVerifLoopLedger(workspace, ledger)
  return ledger
}
