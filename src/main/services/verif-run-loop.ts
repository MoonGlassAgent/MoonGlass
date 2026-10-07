/**
 * VERIF 验证运行循环纯函数核心（VERIF-RUN-LOOP 批 2/批 3，设计文档 §3.2/§4 状态机 / §5 暂停恢复 / §6 预算熔断 / §9.1 账本）。
 *
 * 纯函数模块：仅依赖 node:fs / node:path 与 shared 推导内核，不引入 electron，
 * 供 AgentService 外层循环驱动调用，并可由 scripts/verif-run-loop-smoke.mjs
 * 直接转译测试（与 verif-loop-ledger.ts / decision-ledger.ts 同口径）。
 *
 * 覆盖式循环账本：verification/results/run-loop.json（§9.1），
 * 状态全落盘（设计原则 5），应用重启后由 reconcileRunLoopAfterRestart 对账，
 * 不自动续跑（§11）。决策账本（§9.2）见 decision-ledger.ts，本模块只承载
 * 决策层升级触发与 decide 迁移的纯函数部分。
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, type Dirent } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import type {
  VerifRunClosurePlan,
  VerifRunLoopBeatEntry,
  VerifRunLoopBudget,
  VerifRunLoopCurrent,
  VerifRunLoopLedger,
  VerifRunLoopPause,
  VerifRunLoopStartOptions,
  VerifRunLoopState,
  VerifRunWave
} from '@shared/types'
import {
  CLOSED_VERIFICATION_STATUSES,
  deriveVerificationActions,
  type GuidanceState,
  type GuidanceTranslate,
  type VerificationAction
} from '@shared/verification-guidance'
import type { RunLoopStrategy } from './verif-run-forecast.ts'
// 主进程侧 tr 注入的最小依赖：循环侧提示词与日志固定中文口径（AGENTS.md：发给 Agent 的
// 提示词不经 i18n），直接复用渲染端 zh-CN verification 文案数据（纯数据、无运行时依赖），
// 按键路径查表 + {param} 插值；UI 侧仍走渲染端 i18n，本解析器只服务推导内核与循环日志。
import { verification as verificationZhCN } from '../../renderer/i18n/locales/zh-CN/verification.ts'

// ==================== 预算默认值（§13 待决策 2：拍数 50 / 墙钟 240 分钟 / 无进展 3 拍） ====================

/** 默认拍数上限（§13 待决策 2，实测后调；启动对话框批 4 接入后可覆盖） */
export const DEFAULT_MAX_BEATS = 50
/** 默认 token 上限：按"中型项目 VERIF 全程无人值守"量级给的保守上限（§6 随模型档位可调，批 4 启动对话框暴露） */
export const DEFAULT_MAX_TOKENS = 5_000_000
/** 默认墙钟上限（分钟，§13 待决策 2 的 4 小时） */
export const DEFAULT_MAX_WALL_MINUTES = 240
/** 默认连续无进展拍数上限（§3.2 规则空转升级阈值） */
export const DEFAULT_NO_PROGRESS_LIMIT = 3

/** lastBeats 滚动上限（§9.1：≤20，新在前） */
export const VERIF_RUN_LOOP_LAST_BEATS_LIMIT = 20

const LEDGER_RELATIVE_PATH = join('verification', 'results', 'run-loop.json')

export function verifRunLoopLedgerPath(workspace: string): string {
  return join(workspace, LEDGER_RELATIVE_PATH)
}

// ==================== 账本读写（原子写 + 缺字段归一，与 verif-loop-ledger 同风格） ====================

const RUN_LOOP_STATES: readonly VerifRunLoopState[] = [
  'idle', 'planning', 'running', 'judging', 'repairing',
  'paused-human', 'paused-breaker', 'signoff-review', 'gate-check',
  'completed', 'stopped'
]

function normalizeState(value: unknown): VerifRunLoopState {
  return RUN_LOOP_STATES.includes(value as VerifRunLoopState) ? value as VerifRunLoopState : 'idle'
}

function normalizeWave(value: unknown): VerifRunWave | null {
  return value === 'W0' || value === 'W1' || value === 'W2' || value === 'W3' ? value : null
}

function normalizeCurrent(value: unknown): VerifRunLoopCurrent | null {
  if (typeof value !== 'object' || value === null) return null
  const current = value as Record<string, unknown>
  return {
    kind: String(current.kind ?? ''),
    actionId: typeof current.actionId === 'string' ? current.actionId : null,
    sessionName: String(current.sessionName ?? ''),
    dispatchedAt: String(current.dispatchedAt ?? ''),
    source: current.source === 'llm' || current.source === 'human' ? current.source : 'rule',
    decisionId: String(current.decisionId ?? '')
  }
}

function normalizePause(value: unknown): VerifRunLoopPause | null {
  if (typeof value !== 'object' || value === null) return null
  const pause = value as Record<string, unknown>
  return {
    kind: pause.kind === 'breaker' ? 'breaker' : 'human',
    reason: String(pause.reason ?? ''),
    detail: String(pause.detail ?? ''),
    pendingItems: Array.isArray(pause.pendingItems) ? pause.pendingItems.map(String) : [],
    since: String(pause.since ?? '')
  }
}

function normalizeBudget(value: unknown): VerifRunLoopBudget {
  const budget = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
  const numberOf = (field: unknown, fallback: number): number => {
    const parsed = Number(field)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
  }
  return {
    beats: numberOf(budget.beats, 0),
    maxBeats: numberOf(budget.maxBeats, DEFAULT_MAX_BEATS),
    tokensUsed: numberOf(budget.tokensUsed, 0),
    maxTokens: numberOf(budget.maxTokens, DEFAULT_MAX_TOKENS),
    startedAt: typeof budget.startedAt === 'string' ? budget.startedAt : '',
    maxWallMinutes: numberOf(budget.maxWallMinutes, DEFAULT_MAX_WALL_MINUTES),
    noProgressLimit: numberOf(budget.noProgressLimit, DEFAULT_NO_PROGRESS_LIMIT),
    wallResetBase: numberOf(budget.wallResetBase, 0)
  }
}

function normalizeLastBeats(value: unknown): VerifRunLoopBeatEntry[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map((item) => ({
      beat: Number(item.beat ?? 0) || 0,
      summary: String(item.summary ?? ''),
      decisionId: String(item.decisionId ?? ''),
      verdict: String(item.verdict ?? ''),
      advanced: Boolean(item.advanced)
    }))
    .slice(0, VERIF_RUN_LOOP_LAST_BEATS_LIMIT)
}

/** 收口计划归一：缺失/损坏 → undefined（旧账本按无计划处理）；策略非法 → normal，计数与 criteria 对账。 */
function normalizeClosurePlan(value: unknown): VerifRunClosurePlan | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const plan = value as Record<string, unknown>
  const strategy = plan.strategy === 'converge-first' || plan.strategy === 'deep-dive' || plan.strategy === 'steady-regression'
    ? plan.strategy
    : 'normal'
  const criteria = Array.isArray(plan.criteria)
    ? plan.criteria
        .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
        .map((item) => ({ id: String(item.id ?? ''), met: Boolean(item.met) }))
    : []
  const derivedMet = criteria.filter((item) => item.met).length
  return {
    wave: String(plan.wave ?? 'W1'),
    strategy,
    strategySince: String(plan.strategySince ?? ''),
    criteria,
    metCount: Number.isFinite(Number(plan.metCount)) ? Number(plan.metCount) : derivedMet,
    totalCount: Number.isFinite(Number(plan.totalCount)) ? Number(plan.totalCount) : criteria.length
  }
}

/** 读取循环账本；不存在/损坏返回 null（调用方按无循环记录处理）。缺字段归一（version 演进预留）。 */
export function readVerifRunLoopLedger(workspace: string): VerifRunLoopLedger | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(verifRunLoopLedgerPath(workspace), 'utf-8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const data = raw as Record<string, unknown>
  return {
    version: 1,
    updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : '',
    loopId: typeof data.loopId === 'string' ? data.loopId : '',
    state: normalizeState(data.state),
    wave: normalizeWave(data.wave),
    beat: Number(data.beat ?? 0) || 0,
    current: normalizeCurrent(data.current),
    pause: normalizePause(data.pause),
    budget: normalizeBudget(data.budget),
    lastBeats: normalizeLastBeats(data.lastBeats),
    closurePlan: normalizeClosurePlan(data.closurePlan)
  }
}

/** 原子写循环账本（临时文件 + rename，避免 UI 读到半截 JSON）；写入时刷新 updatedAt。 */
export function writeVerifRunLoopLedger(workspace: string, ledger: VerifRunLoopLedger): void {
  const path = verifRunLoopLedgerPath(workspace)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, JSON.stringify({ ...ledger, version: 1, updatedAt: new Date().toISOString() }, null, 2), 'utf-8')
  renameSync(temporary, path)
}

// ==================== 代际守卫（僵尸循环：内存句柄活着但账本被删/终态/被新循环取代） ====================

/** 僵尸循环被新循环取代时抛出的内部信号（拍循环捕获后静默退出，不落熔断）。 */
export class RunLoopSupersededError extends Error {
  constructor() {
    super('验证运行循环已被新实例取代（loopId 代际不符）')
    this.name = 'RunLoopSupersededError'
  }
}

/** 代际不符判定：账本带 loopId 且与当前循环不一致 → 当前循环是残留僵尸。 */
export function isRunLoopSuperseded(ledger: VerifRunLoopLedger | null, loopId: string): boolean {
  return Boolean(ledger && ledger.loopId && loopId && ledger.loopId !== loopId)
}

/**
 * 启动守卫对账：内存句柄与磁盘账本交叉验证。
 * - 无句柄 → 放行；
 * - 有句柄且账本为活跃态 → 真实在跑，拒绝（UI 应显示暂停/停止入口）；
 * - 有句柄但账本缺失/终态/idle → 僵尸（典型来源：账本随 verification/ 被删、或长 await 卡住期间账本丢失），
 *   调用方做清场（停止标记+打断修复等待+移除句柄）后放行启动。
 */
export function classifyRunLoopStartGuard(hasHandle: boolean, ledger: VerifRunLoopLedger | null): 'ok' | 'reject-running' | 'zombie-cleanup' {
  if (!hasHandle) return 'ok'
  const active = ledger !== null && ledger.state !== 'idle' && ledger.state !== 'stopped' && ledger.state !== 'completed'
  return active ? 'reject-running' : 'zombie-cleanup'
}

/** 读取-变更-原子写的一站式入口；文件缺失时从默认初值起步；每次写入强制 lastBeats 滚动上限。 */
export function updateVerifRunLoopLedger(workspace: string, mutate: (ledger: VerifRunLoopLedger) => void): VerifRunLoopLedger {
  const ledger = readVerifRunLoopLedger(workspace)
    ?? createRunLoopLedger(resolveRunLoopStartOptions(), new Date().toISOString(), false)
  mutate(ledger)
  ledger.lastBeats = ledger.lastBeats.slice(0, VERIF_RUN_LOOP_LAST_BEATS_LIMIT)
  writeVerifRunLoopLedger(workspace, ledger)
  return ledger
}

// ==================== 启动选项与账本初值 ====================

export interface ResolvedRunLoopOptions {
  maxBeats: number
  maxTokens: number
  maxWallMinutes: number
  noProgressLimit: number
}

/** 启动选项归一：非正数/非有限值一律回落默认值（§13 待决策 2）。 */
export function resolveRunLoopStartOptions(options?: VerifRunLoopStartOptions): ResolvedRunLoopOptions {
  const positive = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback
  return {
    maxBeats: positive(options?.maxBeats, DEFAULT_MAX_BEATS),
    maxTokens: positive(options?.maxTokens, DEFAULT_MAX_TOKENS),
    maxWallMinutes: positive(options?.maxWallMinutes, DEFAULT_MAX_WALL_MINUTES),
    noProgressLimit: positive(options?.noProgressLimit, DEFAULT_NO_PROGRESS_LIMIT)
  }
}

/** 循环账本初值：有态势 → running（首拍直接推导），无态势 → planning（W0 规划拍）。 */
export function createRunLoopLedger(options: ResolvedRunLoopOptions, now: string, hasPosture: boolean): VerifRunLoopLedger {
  return {
    version: 1,
    updatedAt: now,
    // 代际标记：残留循环（内存句柄活着但账本被删/终态）苏醒时据此判 superseded
    loopId: `LOOP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    state: hasPosture ? 'running' : 'planning',
    wave: hasPosture ? null : 'W0',
    beat: 0,
    current: null,
    pause: null,
    budget: {
      beats: 0,
      maxBeats: options.maxBeats,
      tokensUsed: 0,
      maxTokens: options.maxTokens,
      startedAt: now,
      maxWallMinutes: options.maxWallMinutes,
      noProgressLimit: options.noProgressLimit,
      wallResetBase: 0
    },
    lastBeats: []
  }
}

/**
 * 手动继续时的墙钟开窗重置（实测反馈口径：墙钟预算是"无人值守时长"上限，
 * 用户点继续本身就是值守行为 → 重置开窗；累计已运行时间滚入 wallResetBase 保留，
 * 步数/token 是资源消耗不归零）。证据触发的自动续跑不调用本函数（非人工值守）。
 */
export function resetRunLoopWallClock(ledger: VerifRunLoopLedger, now: string): void {
  const startedMs = Date.parse(ledger.budget.startedAt)
  const nowMs = Date.parse(now)
  const elapsedMinutes = Number.isFinite(startedMs) && Number.isFinite(nowMs)
    ? Math.max(0, Math.floor((nowMs - startedMs) / 60_000))
    : 0
  ledger.budget.wallResetBase = (ledger.budget.wallResetBase ?? 0) + elapsedMinutes
  ledger.budget.startedAt = now
}

/** 账本已消耗量（继续时抬高上限的校验基线；墙钟按当前窗口折算分钟）。 */
export interface RunLoopConsumption {
  beats: number
  tokensUsed: number
  elapsedMinutes: number
}

export function runLoopConsumption(ledger: VerifRunLoopLedger, now: string): RunLoopConsumption {
  const startedMs = Date.parse(ledger.budget.startedAt)
  const nowMs = Date.parse(now)
  const elapsedMinutes = Number.isFinite(startedMs) && Number.isFinite(nowMs)
    ? Math.max(0, Math.floor((nowMs - startedMs) / 60_000))
    : 0
  return { beats: ledger.budget.beats, tokensUsed: Math.round(ledger.budget.tokensUsed), elapsedMinutes }
}

/**
 * 继续时抬高预算上限的校验：提供的步数/token 维度必须严格大于当前消耗（资源消耗不归零，
 * 否则会立即再次熔断）；墙钟维度在手动继续时已开窗重置，校验调用方应传重置后的账本。
 * 未提供的维度不校验（沿用账本原值）。返回 ok=false 时 reason 已含当前消耗数字，可直接展示。
 */
export function validateRunLoopBudgetOverrides(
  ledger: VerifRunLoopLedger,
  overrides: VerifRunLoopStartOptions | undefined,
  now: string
): { ok: true } | { ok: false; reason: string } {
  const provided = (value: number | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null
  const consumption = runLoopConsumption(ledger, now)
  const beats = provided(overrides?.maxBeats)
  if (beats !== null && beats <= consumption.beats) {
    return { ok: false, reason: `循环步数上限 ${beats} 未超过当前消耗 ${consumption.beats} 步，继续后会立即再次熔断；请调大步数上限` }
  }
  const tokens = provided(overrides?.maxTokens)
  if (tokens !== null && tokens <= consumption.tokensUsed) {
    return { ok: false, reason: `token 上限 ${tokens} 未超过当前消耗 ${consumption.tokensUsed}，继续后会立即再次熔断；请调大 token 上限` }
  }
  const wallMinutes = provided(overrides?.maxWallMinutes)
  if (wallMinutes !== null && wallMinutes <= consumption.elapsedMinutes) {
    return { ok: false, reason: `墙钟上限 ${wallMinutes} 分钟未超过当前窗口已运行 ${consumption.elapsedMinutes} 分钟，继续后会立即再次熔断；请调大墙钟上限` }
  }
  return { ok: true }
}

/** 把通过校验的上限写回账本（含 noProgressLimit；未提供的字段保持原值；计数不归零）。 */
export function applyRunLoopBudgetOverrides(ledger: VerifRunLoopLedger, overrides: VerifRunLoopStartOptions | undefined): void {
  const provided = (value: number | undefined): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : null
  const beats = provided(overrides?.maxBeats)
  if (beats !== null) ledger.budget.maxBeats = beats
  const tokens = provided(overrides?.maxTokens)
  if (tokens !== null) ledger.budget.maxTokens = tokens
  const wallMinutes = provided(overrides?.maxWallMinutes)
  if (wallMinutes !== null) ledger.budget.maxWallMinutes = wallMinutes
  const noProgress = provided(overrides?.noProgressLimit)
  if (noProgress !== null) ledger.budget.noProgressLimit = noProgress
}

// ==================== 态势读取（渲染端同源口径：posture 优先，缺 verificationIntents 回退 state.json） ====================

export interface RunLoopPosture {
  /** GuidanceState 形态（posture 文件即 GuidanceState 超集，含 generatedAt/rtlHash 等额外字段） */
  state: GuidanceState | null
  generatedAt: string | null
}

const POSTURE_RELATIVE_PATH = join('verification', 'intelligence', 'verification-posture.json')
const VERIFICATION_STATE_RELATIVE_PATH = join('verification', 'intelligence', 'verification-state.json')

/** 读取验证态势；不存在/损坏/缺 verificationIntents（被 Agent 覆盖成摘要）返回 null。 */
export function readRunLoopPosture(workspace: string): RunLoopPosture {
  const read = (relativePath: string): RunLoopPosture | null => {
    try {
      const data = JSON.parse(readFileSync(join(workspace, relativePath), 'utf-8')) as Record<string, unknown>
      if (typeof data !== 'object' || data === null || !Array.isArray(data.verificationIntents)) return null
      return {
        state: data as unknown as GuidanceState,
        generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : null
      }
    } catch {
      return null
    }
  }
  return read(POSTURE_RELATIVE_PATH) ?? read(VERIFICATION_STATE_RELATIVE_PATH) ?? { state: null, generatedAt: null }
}

// ==================== 主进程侧 tr 注入（zh-CN 文案查表 + {param} 插值，缺键回退 key） ====================

type LocaleTable = Record<string, unknown>

/** 按点分键查嵌套文案表（键含 'verification.' 前缀，表为 verification 命名空间本体）。 */
function lookupLocaleText(table: LocaleTable, dottedKey: string): string | null {
  const segments = dottedKey.split('.')
  const path = segments[0] === 'verification' ? segments.slice(1) : segments
  let node: unknown = table
  for (const segment of path) {
    if (typeof node !== 'object' || node === null) return null
    node = (node as LocaleTable)[segment]
  }
  return typeof node === 'string' ? node : null
}

/** 循环侧固定中文口径的 GuidanceTranslate 实现：查 zh-CN verification 资源，缺键回退 key。 */
export const runLoopTranslate: GuidanceTranslate = (key, params) => {
  const template = lookupLocaleText(verificationZhCN as LocaleTable, key) ?? key
  return template.replace(/\{(\w+)\}/g, (matched, name: string) =>
    params && name in params ? String(params[name]) : matched)
}

// ==================== 拍决策（规则层；LLM 决策层挂点见 AgentService 驱动注释） ====================

/** 一拍的标准决策结果（§4.2）：planning=无态势先规划，derive=取最高优先级动作，no-action=规则无答案（罕见，防御性兜底） */
export type RunLoopBeatPlan =
  | { kind: 'planning' }
  | { kind: 'derive'; action: VerificationAction }
  | { kind: 'no-action' }

/**
 * converge-first 优先动作白名单（fix-regressions/根因/诊断类）：
 * 策略为 converge-first 且规则首选是 wave 批次类动作时，让位给列表中存在的这些动作
 * （修复收口优先于开新批次；规则降权，确定性，LLM 不参与）。
 */
const CONVERGE_FIRST_PREFERRED_ACTION_IDS: readonly string[] = [
  'fix-regressions',
  'fix-formal',
  'repair-formal-compatibility',
  'add-checkers',
  'refresh-change-impact',
  'resolve-oracle-conflicts',
  'escape-exploration-stall',
  'clarify-spec'
]

/**
 * 拍决策推导。strategy 为战略层当前运行策略（ledger.closurePlan.strategy，缺省 normal）：
 * 仅 converge-first 改变动作选择——首选为 wave 批次类（wave-w1/wave-w2/run-batch）且
 * 动作列表中存在修复/根因/诊断类动作时改派之；其余策略（含 normal/deep-dive/steady-regression）
 * 本期完全现状，只入账不改派。
 */
export function planRunLoopBeat(posture: RunLoopPosture, tr: GuidanceTranslate = runLoopTranslate, strategy: RunLoopStrategy = 'normal'): RunLoopBeatPlan {
  if (!posture.state) return { kind: 'planning' }
  const actions = deriveVerificationActions(posture.state, tr)
  if (actions.length === 0) return { kind: 'no-action' }
  const first = actions[0]!
  if (strategy === 'converge-first' && classifyRunLoopAction(first.id) === 'batch-loop') {
    const preferred = actions.find((action) => CONVERGE_FIRST_PREFERRED_ACTION_IDS.includes(action.id))
    if (preferred) return { kind: 'derive', action: preferred }
  }
  return { kind: 'derive', action: first }
}

/** 动作派发映射（批 2 委托口径）：批次类走既有 runVerifBatches 内层循环；signoff-review 独立出口（settle 后再推导 → gate-check）；其余派任务会话。 */
export type RunLoopActionKind = 'batch-loop' | 'task-session' | 'signoff-review'

export function classifyRunLoopAction(actionId: string): RunLoopActionKind {
  if (actionId === 'run-batch' || actionId === 'wave-w1' || actionId === 'wave-w2') return 'batch-loop'
  if (actionId === 'signoff-review') return 'signoff-review'
  return 'task-session'
}

/** 当前波段：waveProgress 首个 in-progress 条目（无 waveProgress 或无在跑波段 → null）。 */
export function deriveRunLoopWave(state: GuidanceState | null): VerifRunWave | null {
  const active = state?.waveProgress?.find((wave) => wave.status === 'in-progress')
  return active ? normalizeWave(active.id) : null
}

// ==================== 推进判定（闭环计数对比，多信号防误判 §11） ====================

/** 闭环计数快照：open intents / 阻断 holes / 条款覆盖 / 回归失败（§4.2 证据裁决口径）。 */
export interface RunLoopClosureCounts {
  openIntents: number
  blockingHoles: number
  coveredClauses: number
  failedRegressions: number
}

export function closureCountsOf(state: GuidanceState | null): RunLoopClosureCounts {
  if (!state) return { openIntents: 0, blockingHoles: 0, coveredClauses: 0, failedRegressions: 0 }
  return {
    openIntents: (state.verificationIntents ?? []).filter((intent) => !CLOSED_VERIFICATION_STATUSES.has(intent.status)).length,
    blockingHoles: (state.coverageHoles ?? []).filter((hole) => hole.blocking).length,
    coveredClauses: state.specMapping?.coveredClause ?? 0,
    failedRegressions: (state.regressions ?? []).filter((regression) => !regression.passed).length
  }
}

/**
 * 推进判定：比较派发前后闭环计数，任一信号改善即 advanced。
 * 态势从无到有（规划拍产出 posture）视为推进；有到无（posture 丢失）视为无进展。
 */
export function judgeRunLoopAdvanced(before: GuidanceState | null, after: GuidanceState | null): boolean {
  if (!before || !after) return before === null && after !== null
  const previous = closureCountsOf(before)
  const current = closureCountsOf(after)
  return current.openIntents < previous.openIntents ||
    current.blockingHoles < previous.blockingHoles ||
    current.coveredClauses > previous.coveredClauses ||
    current.failedRegressions < previous.failedRegressions
}

// ==================== 预算熔断（§6：连续无进展 / 拍数 / token / 墙钟） ====================

export type RunLoopBreakerReason = 'rule-stall' | 'max-beats' | 'max-tokens' | 'max-wall'

export interface RunLoopBudgetStatus {
  exceeded: boolean
  reason: RunLoopBreakerReason | null
  detail: string
}

/** 连续无进展拍数：lastBeats 前导 advanced=false 条目计数（新在前，天然滚动）。 */
export function noProgressStreak(lastBeats: VerifRunLoopBeatEntry[]): number {
  let streak = 0
  for (const entry of lastBeats) {
    if (entry.advanced) break
    streak += 1
  }
  return streak
}

/** 拍开始前预算校验；命中即 paused-breaker 指名原因，不静默烧钱。startedAt 不可解析时跳过墙钟维度。 */
export function checkRunLoopBudget(ledger: VerifRunLoopLedger, noProgressLimit: number, nowIso: string): RunLoopBudgetStatus {
  const streak = noProgressStreak(ledger.lastBeats)
  if (streak >= noProgressLimit) {
    return { exceeded: true, reason: 'rule-stall', detail: `连续 ${streak} 步无进展（上限 ${noProgressLimit} 步）` }
  }
  const budget = ledger.budget
  if (budget.beats >= budget.maxBeats) {
    return { exceeded: true, reason: 'max-beats', detail: `循环步数 ${budget.beats}/${budget.maxBeats}` }
  }
  if (budget.tokensUsed >= budget.maxTokens) {
    return { exceeded: true, reason: 'max-tokens', detail: `token ${budget.tokensUsed}/${budget.maxTokens}` }
  }
  const startedAt = Date.parse(budget.startedAt)
  if (Number.isFinite(startedAt)) {
    const elapsedMinutes = Math.floor((Date.parse(nowIso) - startedAt) / 60_000)
    if (elapsedMinutes >= budget.maxWallMinutes) {
      return { exceeded: true, reason: 'max-wall', detail: `墙钟 ${elapsedMinutes}/${budget.maxWallMinutes} 分钟` }
    }
  }
  return { exceeded: false, reason: null, detail: '' }
}

// ==================== 状态迁移助手（暂停/恢复/记账，驱动与 smoke 共用） ====================

/** 进入暂停态（§5.1 暂停即落盘）：human → paused-human，breaker → paused-breaker；清空当前拍。 */
/** 恢复时的墙钟开窗（只开新窗、不累计等待段）：人工等待的时间不计费（实测口径）。 */
export function resumeRunLoopWallWindow(ledger: VerifRunLoopLedger, now: string): void {
  ledger.budget.startedAt = now
}

export function applyRunLoopPause(
  ledger: VerifRunLoopLedger,
  pause: { kind: 'human' | 'breaker'; reason: string; detail: string; pendingItems?: string[]; since: string }
): void {
  // 等待不计费：进入暂停（含熔断待人）即把当前活跃段滚入 wallResetBase 并冻结窗口；
  // 恢复时由 resumeRunLoopWallWindow 直接开新窗，等待段既不进窗口也不进预算
  resetRunLoopWallClock(ledger, pause.since)
  ledger.state = pause.kind === 'human' ? 'paused-human' : 'paused-breaker'
  ledger.current = null
  ledger.pause = { kind: pause.kind, reason: pause.reason, detail: pause.detail, pendingItems: pause.pendingItems ?? [], since: pause.since }
}

/** 恢复：清暂停回 running；下一拍重新读态势推导（显式 resume 与证据触发恢复同口径）。 */
export function applyRunLoopResume(ledger: VerifRunLoopLedger): void {
  ledger.state = 'running'
  ledger.pause = null
}

/** 拍回填：拍数/预算 token 累加 + lastBeats 记账（新在前，截断 ≤20）。 */
export function recordRunLoopBeat(ledger: VerifRunLoopLedger, beat: VerifRunLoopBeatEntry, tokensUsed: number): void {
  ledger.beat = beat.beat
  ledger.budget.beats += 1
  ledger.budget.tokensUsed += Math.max(0, Math.trunc(tokensUsed) || 0)
  ledger.lastBeats.unshift(beat)
  ledger.lastBeats = ledger.lastBeats.slice(0, VERIF_RUN_LOOP_LAST_BEATS_LIMIT)
  ledger.current = null
}

// ==================== 重启对账（§11：账本覆盖式落盘 + 启动对账，不自动续跑） ====================

/** 应用重启时需对账的循环态（执行中各态会话进程已不存在，不能假装还在跑）。 */
const RESTART_RECONCILE_STATES: readonly VerifRunLoopState[] = ['running', 'judging', 'repairing', 'planning', 'signoff-review', 'gate-check']

/**
 * 启动对账：running/judging/repairing/planning/signoff-review/gate-check → paused-breaker
 * （reason='app-restart'，detail 提示待人确认）；终态与已暂停态原样保留。
 * 无账本返回 null。返回（可能未变更的）账本供调用方记录日志。
 */
export function reconcileRunLoopAfterRestart(workspace: string): VerifRunLoopLedger | null {
  const ledger = readVerifRunLoopLedger(workspace)
  if (!ledger) return null
  if (!RESTART_RECONCILE_STATES.includes(ledger.state)) return ledger
  const pendingItems: string[] = []
  if (ledger.current) {
    pendingItems.push(`中断动作：${ledger.current.kind}${ledger.current.actionId ? `（${ledger.current.actionId}）` : ''}，派发于 ${ledger.current.dispatchedAt}`)
  }
  applyRunLoopPause(ledger, {
    kind: 'breaker',
    reason: 'app-restart',
    detail: '应用重启，请确认后继续（循环不会自动续跑；确认现场后请恢复循环）',
    pendingItems,
    since: new Date().toISOString()
  })
  writeVerifRunLoopLedger(workspace, ledger)
  return ledger
}

// ==================== 证据指纹（暂停待人期间 15s 轮询 mtime，变化即重新推导续跑） ====================

/** 指纹扫描文件数上限（防御超大工作目录；verification/ 下 JSON 产物量级远低于此） */
const EVIDENCE_FINGERPRINT_MAX_FILES = 2000

/**
 * verification/ 下全部 .json 的 mtime 指纹（路径:mtimeMs 排序拼接）。
 * 循环账本 run-loop.json 由循环自身写入，排除避免自我触发恢复；
 * 规划/签核等待期间的用户答复、豁免审批、裁决登记都会改证据文件 → 指纹变化。
 */
export function evidenceFingerprint(workspace: string): string {
  const pairs: string[] = []
  const walk = (dir: string): void => {
    if (pairs.length >= EVIDENCE_FINGERPRINT_MAX_FILES) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (pairs.length >= EVIDENCE_FINGERPRINT_MAX_FILES) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.json')) continue
      const rel = relative(workspace, path).split(sep).join('/')
      if (rel === 'verification/results/run-loop.json') continue
      try {
        pairs.push(`${rel}:${statSync(path).mtimeMs}`)
      } catch { /* 并发删除时按不存在处理 */ }
    }
  }
  walk(join(workspace, 'verification'))
  return pairs.sort().join('|')
}

// ==================== W0 规划拍 prompt ====================

/**
 * planning 态（首拍无可用态势）派发的规划会话 prompt。
 * 批 4 起一键托管 VERIF 已切换到本循环，渲染端不再持有同源 prompt 常量；
 * 提示词保持中文、不经 i18n（AGENTS.md 口径）。
 */
export const VERIF_RUN_LOOP_PLANNING_PROMPT =
  '完成验证规划与环境准备：更新验证计划和覆盖率计划，搭建或修复验证环境（TOP 优先：只搭一套 TOP cocotb 环境，verification/<topModule>_tb/，总线 VIP 挂接寄存器配置，driver/monitor/scoreboard/golden model 面向顶层接口；不按模块分级多套；只做编译/展开级别的可用性检查）；' +
  '规格含寄存器/配置章节时经 register_config_space 登记配置空间账本（规格缺寄存器章节转 Spec Gap 阻断，不得编造寄存器）；' +
  '调用 build_verification_intelligence 生成风险候选与结构事实，圈定真实验证点并用 register_verification_intents 登记（锚定真实 riskIds/requirementIds/rtlSignals）。' +
  '本会话只做规划与意图登记：禁止运行仿真/Formal 回归（场景执行由 MoonGlass 主进程编排的后续批次会话承担）；' +
  '若发现疑似 RTL bug，只在 root-causes.json 记录为假设（hypothesis），禁止登记 confirmed 根因' +
  '（confirmed 登记会立即触发 RTL 修复会话派发，应由批次执行/诊断循环触发）。'

// ==================== 决策层升级（VERIF-RUN-LOOP 批 3 §3.2：规则空转 / 熔断恢复触发，提案经决策账本待人审批） ====================

/** 决策升级会话派发的触发（LLM 提案的 trigger 口径，§9.2） */
export type RunLoopEscalationTrigger = 'rule-stall' | 'breaker-recovery'

/** 决策升级会话标题（任务会话 slug 用） */
export function runLoopEscalationTitle(trigger: RunLoopEscalationTrigger): string {
  return trigger === 'rule-stall' ? '验证循环决策升级（规则空转）' : '验证循环决策升级（熔断恢复）'
}

/**
 * 决策升级会话 prompt（§3.2：LLM 读压缩态势做结构化归因，经 propose_run_decision 登记提案；
 * 顾问模式默认——提案只登记不执行，批准权在工程师）。
 */
export function buildRunLoopEscalationPrompt(trigger: RunLoopEscalationTrigger, detail: string): string {
  const background = trigger === 'rule-stall'
    ? '规则层已连续多步无进展（规则空转），循环升级至决策层，请你归因停滞原因并提出下一步方向。'
    : '循环已熔断暂停，升级至决策层，请你归因熔断原因并提出恢复方案。'
  return [
    '你是 MoonGlass 验证运行循环的决策升级会话：只做归因与提案，不执行验证工作（仿真/Formal/批次由批次会话承担，禁止代跑）。',
    `背景：${background}触发详情：${detail}`,
    '',
    '请严格按以下步骤工作：',
    '1. 读取压缩态势：verification/intelligence/execution-summary.json、verification/results/run-loop.json、verification/results/decision-ledger.json、verification/results/diagnostic-control.json（后两者可能不存在，按空账本处理），归因停滞/熔断的真实原因；',
    `2. 给出下一步行动提案并调用 propose_run_decision 登记：trigger 必须传 '${trigger}'；action 需含 kind（derived 引用推导内核已知动作 id，或 custom 自由指令）、prompt（具体可执行指令）、expectedOutput（必填非空）、stopCriteria（必填非空）；rationale ≤200 字；evidenceRefs 填你实际读取的证据文件路径；`,
    '3. 提案登记后循环会以决策卡片呈给工程师审批（顾问模式，默认不自动执行）；登记完即可结束本会话，不要重复提交相同提案。'
  ].join('\n')
}

/** paused-human 等待 LLM 决策审批的暂停原因（§4.1 paused-human 枚举） */
export const RUN_LOOP_DECISION_PENDING_REASON = 'llm-decision-pending'

/**
 * 熔断原因是否直接进入 paused-breaker 待人处置（不派发决策升级会话）：
 * app-restart（重启对账，现场待确认）/ manual-override（手动接管，批 4）/ 预算类
 * （max-beats/max-tokens/max-wall，调预算或重启是人自己的决定，LLM 无权替人花钱，§6）。
 */
export function isDirectBreakerReason(reason: string): boolean {
  return reason === 'app-restart' || reason === 'manual-override' ||
    reason === 'max-beats' || reason === 'max-tokens' || reason === 'max-wall'
}

// ==================== decide 迁移（decide IPC 批准/否决后的循环去向，纯函数供 smoke 直测） ====================

export type DecideRunLoopTransition =
  /** 批准且循环正停在 llm-decision-pending：清暂停恢复，下一拍执行该决策动作 */
  | { kind: 'approve-and-resume' }
  /** 批准但循环不在等待（运行中/其他暂停/无账本）：只记账，拍循环顶部自然拾取执行 */
  | { kind: 'approve-record-only' }
  /** 否决且循环正停在 llm-decision-pending：转 paused-breaker（decision-rejected） */
  | { kind: 'reject-and-breaker' }
  /** 否决但循环不在等待：只记账 */
  | { kind: 'reject-record-only' }

/** decide 迁移推导：等待态 = 循环账本 paused-human 且 pause.reason='llm-decision-pending'。 */
export function planDecideRunLoopTransition(
  ledger: Pick<VerifRunLoopLedger, 'state' | 'pause'> | null,
  verdict: 'approved' | 'rejected'
): DecideRunLoopTransition {
  const waitingForDecision = ledger !== null &&
    ledger.state === 'paused-human' && ledger.pause?.reason === RUN_LOOP_DECISION_PENDING_REASON
  if (verdict === 'approved') return waitingForDecision ? { kind: 'approve-and-resume' } : { kind: 'approve-record-only' }
  return waitingForDecision ? { kind: 'reject-and-breaker' } : { kind: 'reject-record-only' }
}
