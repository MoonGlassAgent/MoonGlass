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

/**
 * 批次语义标签：批次里每个场景"在验证什么"的**派发时快照**。
 *
 * 为什么快照而不是渲染时现查注册表：
 * 1. 历史正确性——场景标题由条款文本派生，规格改写后会变；把当前标题贴到历史批次上，
 *    等于用今天的语义解释当时的执行（违反"不将当前场景说明当作历史预期快照"的既有口径）；
 * 2. 账本自描述——场景闭环后会移出执行计划，注册表里仍可查但语义上下文已变，
 *    快照保证历史批次永久可读；
 * 3. 开销——注册表随项目规模增长（实测 318 场景 ≈ 517 KB），渲染端每次 verification
 *    变更都拉整份不可取；派发时按需取 3~12 条即可。
 */
export interface VerifScenarioLabel {
  id: string
  /** 场景标题（注册表 title）；取不到时为空串，界面按"无标题快照"处理，不静默隐藏 */
  title: string
  /** 锚定的规格条款 ID（如 REQ-FUNC-002#d），供追溯 */
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
  /** 语义标签快照（派发时写入；旧账本无此字段） */
  scenarios?: VerifScenarioLabel[]
}

/** 本次循环已完成批次的历史条目（新记录在前，滚动 ≤ VERIF_LOOP_HISTORY_LIMIT 条） */
export interface VerifLoopHistoryEntry {
  index: number
  scenarioIds: string[]
  /**
   * 批次状态按结果归并（与 runVerifBatches 的停止口径一致）：
   * completed=证据齐；circuit-broken=熔断类（会话异常/watchdog/证据缺失/诊断停滞）；
   * no-evidence=会话正常 settle 但无执行证据（合法出口，循环内延后重选，不停止循环）
   */
  verdict: 'completed' | 'circuit-broken' | 'no-evidence'
  /** 完成判定细节（缺哪个 scenario 登记）、无证据说明或熔断原因 */
  reason: string
  settledAt: string
  /** 语义标签快照（沿用派发时的那一份，保证历史解释与执行时一致；旧账本无此字段） */
  scenarios?: VerifScenarioLabel[]
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
  /**
   * 本循环内"无执行证据"（no-evidence）批次延后、不再参与选批的场景 ID（大写去重）。
   * 合法出口而非故障：循环继续派发其他批次；新循环开始（running 重置）时清空。
   * 旧账本无此字段，读取归一为 undefined（不因此产生空数组噪声）。
   */
  deferredScenarioIds?: string[]
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

/** 标题长度上限：正常标题由条款文本派生（引擎侧已截断至 500），此处再加一道防御 */
export const VERIF_SCENARIO_TITLE_MAX = 300

/** 语义标签归一：缺失/空数组返回 undefined（旧账本不因此产生空数组噪声）。 */
function normalizeScenarioLabels(value: unknown): VerifScenarioLabel[] | undefined {
  if (!Array.isArray(value)) return undefined
  const labels = value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      id: String(item.id ?? ''),
      title: String(item.title ?? '').trim().slice(0, VERIF_SCENARIO_TITLE_MAX),
      requirementIds: Array.isArray(item.requirementIds) ? item.requirementIds.map(String).filter(Boolean) : []
    }))
    .filter((label) => label.id)
  return labels.length > 0 ? labels : undefined
}

/**
 * 读取指定场景的语义标签快照（批次派发时调用一次，随账本落盘）。
 *
 * 只为账本可读性服务，因此**只读、失败降级**：注册表缺失/损坏/ID 未命中一律不抛错——
 * 批次派发不能因为"标签没取到"而失败。未命中的 ID 仍返回条目（title 为空串），
 * 界面据此显示"无标题快照"，而不是让场景从列表里静默消失。
 */
export function readScenarioLabels(workspace: string, ids: readonly string[]): VerifScenarioLabel[] {
  const byId = new Map<string, { title: string; requirementIds: string[] }>()
  try {
    const data = JSON.parse(readFileSync(join(workspace, 'verification', 'intelligence', 'scenario-registry.json'), 'utf-8')) as { scenarios?: unknown }
    if (Array.isArray(data.scenarios)) {
      for (const item of data.scenarios) {
        if (typeof item !== 'object' || item === null) continue
        const scenario = item as Record<string, unknown>
        const id = typeof scenario.id === 'string' ? scenario.id : ''
        if (!id) continue
        byId.set(id, {
          title: typeof scenario.title === 'string' ? scenario.title.trim().slice(0, VERIF_SCENARIO_TITLE_MAX) : '',
          requirementIds: Array.isArray(scenario.requirementIds) ? scenario.requirementIds.map(String).filter(Boolean) : []
        })
      }
    }
  } catch { /* 注册表不可读：全部按无标题快照处理 */ }
  return ids.map((id) => ({ id, title: byId.get(id)?.title ?? '', requirementIds: byId.get(id)?.requirementIds ?? [] }))
}

function normalizeCurrentBatch(value: unknown): VerifLoopCurrentBatch | null {
  if (typeof value !== 'object' || value === null) return null
  const batch = value as Record<string, unknown>
  const scenarios = normalizeScenarioLabels(batch.scenarios)
  return {
    index: Number(batch.index ?? 0) || 0,
    sessionName: String(batch.sessionName ?? ''),
    scenarioIds: Array.isArray(batch.scenarioIds) ? batch.scenarioIds.map(String) : [],
    dispatchedAt: String(batch.dispatchedAt ?? ''),
    phase: batch.phase === 'settling' ? 'settling' : 'dispatched',
    ...(scenarios ? { scenarios } : {})
  }
}

function normalizeHistoryVerdict(value: unknown): VerifLoopHistoryEntry['verdict'] {
  return value === 'completed' ? 'completed' as const : value === 'no-evidence' ? 'no-evidence' as const : 'circuit-broken' as const
}

function normalizeHistory(value: unknown): VerifLoopHistoryEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => {
      const scenarios = normalizeScenarioLabels(item.scenarios)
      return {
        index: Number(item.index ?? 0) || 0,
        scenarioIds: Array.isArray(item.scenarioIds) ? item.scenarioIds.map(String) : [],
        verdict: normalizeHistoryVerdict(item.verdict),
        reason: String(item.reason ?? ''),
        settledAt: String(item.settledAt ?? ''),
        ...(scenarios ? { scenarios } : {})
      }
    })
    .slice(0, VERIF_LOOP_HISTORY_LIMIT)
}

/** 延后场景归一：大写去重去空；缺失/空数组返回 undefined（旧账本不因此产生空数组噪声）。 */
function normalizeDeferredScenarioIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ids = [...new Set(value.map((id) => String(id).trim().toUpperCase()).filter(Boolean))]
  return ids.length > 0 ? ids : undefined
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
  const deferredScenarioIds = normalizeDeferredScenarioIds(data.deferredScenarioIds)
  return {
    version: 1,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
    state: normalizeState(data.state),
    currentBatch: normalizeCurrentBatch(data.currentBatch),
    circuitBreaker: breaker ? { reason: String(breaker.reason ?? ''), detail: String(breaker.detail ?? '') } : null,
    rtlFixWait: wait ? { rootCauseId: String(wait.rootCauseId ?? ''), since: String(wait.since ?? '') } : null,
    history: normalizeHistory(data.history),
    ...(deferredScenarioIds ? { deferredScenarioIds } : {})
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
