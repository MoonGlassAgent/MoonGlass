/**
 * RTL 修复判定账本落盘（失败诊断与修复可视化方案 C 批 1，设计文档 §3.1）。
 *
 * 纯函数模块：仅依赖 node:fs / node:path，不引入 electron，
 * 供 AgentService 修复会话编排调用，并可由 smoke 直接转译测试
 * （与 rtl-fix-verdict.ts / rtl-fix-audit.ts 同口径）。
 *
 * 追加式账本：verification/results/rtl-fix-outcomes.json，
 * 新记录 unshift（最新在前），上限 RTL_FIX_OUTCOME_LIMIT 条，原子写。
 * 判定来源：deliverRtlFixOutcome 送达 judgeRtlFixOutcome 判定时写入。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type RtlFixOutcomeJudgment = 'FIXED' | 'STILL_FAIL' | 'UNKNOWN'

/** 单条修复判定记录（deliverRtlFixOutcome 送达判定时写入） */
export interface RtlFixOutcomeRecord {
  /** 根因记录 ID（RC-*） */
  rootCauseId: string
  /** 关联场景 ID（SCN-*） */
  scenarioId: string
  fixSessionName: string
  judgment: RtlFixOutcomeJudgment
  /** judgeRtlFixOutcome 的判定依据一句话 */
  reason: string
  /** 修复会话派发时刻（fixStartedAt，判定基线） */
  startedAt: string
  settledAt: string
  /** 窗口审计文件相对路径（rtl-fix-audit-<RC>.json，改了哪些文件） */
  auditPath: string
  /** 窗口内写保护拦截次数（取自窗口收尾审计统计） */
  blockedAttempts: number
}

export interface RtlFixOutcomeLedger {
  version: 1
  outcomes: RtlFixOutcomeRecord[]
}

export const RTL_FIX_OUTCOME_LIMIT = 50

const LEDGER_RELATIVE_PATH = join('verification', 'results', 'rtl-fix-outcomes.json')

export function rtlFixOutcomeLedgerPath(workspace: string): string {
  return join(workspace, LEDGER_RELATIVE_PATH)
}

function normalizeJudgment(value: unknown): RtlFixOutcomeJudgment {
  return value === 'FIXED' || value === 'STILL_FAIL' ? value : 'UNKNOWN'
}

/** 读取账本；不存在/损坏按空账本处理（缺字段归一，version 演进预留）。 */
export function readRtlFixOutcomeLedger(workspace: string): RtlFixOutcomeLedger {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(rtlFixOutcomeLedgerPath(workspace), 'utf-8'))
  } catch {
    return { version: 1, outcomes: [] }
  }
  const data = (typeof raw === 'object' && raw !== null ? raw : {}) as { outcomes?: unknown }
  const outcomes = (Array.isArray(data.outcomes) ? data.outcomes : [])
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      rootCauseId: String(item.rootCauseId ?? ''),
      scenarioId: String(item.scenarioId ?? ''),
      fixSessionName: String(item.fixSessionName ?? ''),
      judgment: normalizeJudgment(item.judgment),
      reason: String(item.reason ?? ''),
      startedAt: String(item.startedAt ?? ''),
      settledAt: String(item.settledAt ?? ''),
      auditPath: String(item.auditPath ?? ''),
      blockedAttempts: Number(item.blockedAttempts ?? 0) || 0
    }))
  return { version: 1, outcomes }
}

/** 追加一条判定记录（unshift 最新在前，滚动上限 50 条），原子写，返回写入后的账本。 */
export function appendRtlFixOutcome(workspace: string, record: RtlFixOutcomeRecord): RtlFixOutcomeLedger {
  const ledger = readRtlFixOutcomeLedger(workspace)
  ledger.outcomes.unshift(record)
  ledger.outcomes = ledger.outcomes.slice(0, RTL_FIX_OUTCOME_LIMIT)
  const path = rtlFixOutcomeLedgerPath(workspace)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, JSON.stringify(ledger, null, 2), 'utf-8')
  renameSync(temporary, path)
  return ledger
}
