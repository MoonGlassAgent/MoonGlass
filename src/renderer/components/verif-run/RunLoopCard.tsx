/**
 * 外层循环卡（VERIF-RUN-LOOP 批 4，设计文档 §7.1/§9.1/§9.2）。
 *
 * 单卡承载"看状态 + 做控制 + 收请示"：
 * - 状态区：11 态徽标 + 当前波段 + 第 n 拍 + 当前动作（来源徽标 规则=蓝 / LLM=紫 / 人工=绿）
 *   + 预算水位条（拍数/token/墙钟）+ 暂停原因卡（human/breaker + pendingItems）+
 *   lastBeats 迷你时间线（advanced 绿点 / no-progress 灰点）。
 * - 控制区：未运行 → "启动自动验证"（预算对话框 start 模式：四项预算 + 默认值 + 预设 chip +
 *   说明）；运行中 → 暂停/停止；暂停 → 继续（预算对话框 resume 模式：预填账本当前上限、
 *   可抬高后继续，顶部琥珀行显示当前消耗）/停止。按钮经集成方回调走 IPC，失败以卡内错误条提示。
 * - 决策区：decision-ledger 中 status='proposed' 的请示卡片（批准/否决），
 *   已执行决策历史（来源徽标 + outcome 徽标，折叠）。
 *
 * 纯数据 + 回调组件：不自己发 IPC，账本数据由集成方读取落盘 JSON 归一化后传入。
 */

import { useEffect, useState } from 'react'
import { OctagonPause, Play, Repeat, Square } from 'lucide-react'
import type { VerifRunLoopLedger, VerifRunLoopStartOptions, VerifRunLoopState } from '@shared/types'
import {
  buildRunSummary,
  computeBudgetWarning,
  type RunBudgetDimension,
  type RunLoopForecast,
  type RunSummaryTone,
  type RunSummaryTranslate
} from '@shared/run-summary'
import { useTranslation, type MessageKey } from '../../i18n'
import { DECISION_SOURCE_META, ProposedDecisionCard } from './ProposedDecisionCard'
import {
  RUN_LOOP_DEFAULT_MAX_BEATS,
  RUN_LOOP_DEFAULT_MAX_TOKENS,
  RUN_LOOP_DEFAULT_MAX_WALL_MINUTES,
  formatVerifTimestamp,
  type VerifRunDecisionEntryView,
  type VerifRunDecisionOutcome
} from './types'

export interface RunLoopCardProps {
  /** 外层循环账本（run-loop.json 归一化结果；null=无循环记录/未加载；closurePlan 随账本透传） */
  runLoop: VerifRunLoopLedger | null
  /** 决策账本条目（decision-ledger.json 归一化结果，新在前） */
  decisions: VerifRunDecisionEntryView[]
  /**
   * 预测（战略层摘要输入；主进程产出，本批渲染端只接 prop 缺省 null）。
   * 数值字段均可 null/缺省，摘要生成器负责归一。
   */
  forecast?: RunLoopForecast | null
  /** 启动循环（四项预算均可选；缺省走主进程默认值） */
  onStart: (options: VerifRunLoopStartOptions) => Promise<void>
  /** 暂停循环（当前拍完成后转 paused） */
  onPause: () => Promise<void>
  /** 恢复循环（可带抬高后的预算上限；墙钟从继续时刻重新开窗） */
  onResume: (options?: VerifRunLoopStartOptions) => Promise<void>
  /** 停止循环（终态） */
  onStop: () => Promise<void>
  /** 裁决决策提案（批准/否决；editedPrompt 批 3 决策层接入后支持改写） */
  onDecide: (decisionId: string, verdict: 'approved' | 'rejected') => Promise<void>
}

/** 11 态徽标配色（蓝=执行、紫=审查、琥珀=等待/修复、红=熔断、绿=闭环、灰=空闲/停止） */
const STATE_META: Record<VerifRunLoopState, { labelKey: MessageKey; cls: string }> = {
  idle: { labelKey: 'verifRun.loop.state.idle', cls: 'bg-zinc-100 text-zinc-600' },
  planning: { labelKey: 'verifRun.loop.state.planning', cls: 'bg-sky-100 text-sky-700' },
  running: { labelKey: 'verifRun.loop.state.running', cls: 'bg-sky-100 text-sky-700' },
  judging: { labelKey: 'verifRun.loop.state.judging', cls: 'bg-sky-100 text-sky-700' },
  repairing: { labelKey: 'verifRun.loop.state.repairing', cls: 'bg-amber-100 text-amber-700' },
  'paused-human': { labelKey: 'verifRun.loop.state.paused-human', cls: 'bg-amber-100 text-amber-700' },
  'paused-breaker': { labelKey: 'verifRun.loop.state.paused-breaker', cls: 'bg-red-100 text-red-700' },
  'signoff-review': { labelKey: 'verifRun.loop.state.signoff-review', cls: 'bg-violet-100 text-violet-700' },
  'gate-check': { labelKey: 'verifRun.loop.state.gate-check', cls: 'bg-violet-100 text-violet-700' },
  completed: { labelKey: 'verifRun.loop.state.completed', cls: 'bg-emerald-100 text-emerald-700' },
  stopped: { labelKey: 'verifRun.loop.state.stopped', cls: 'bg-zinc-100 text-zinc-600' }
}

/** outcome 徽标（advanced 绿 / no-progress 灰 / failed 红；未回填用状态徽标灰） */
const OUTCOME_META: Record<VerifRunDecisionOutcome, { labelKey: MessageKey; cls: string }> = {
  advanced: { labelKey: 'verifRun.loop.outcome.advanced', cls: 'bg-emerald-100 text-emerald-700' },
  'no-progress': { labelKey: 'verifRun.loop.outcome.no-progress', cls: 'bg-zinc-100 text-zinc-600' },
  failed: { labelKey: 'verifRun.loop.outcome.failed', cls: 'bg-red-100 text-red-700' }
}

/** 摘要语气着色（normal 灰 / strategy 蓝 / warning 琥珀 / blocked 红） */
const SUMMARY_TONE_CLS: Record<RunSummaryTone, string> = {
  normal: 'text-zinc-600',
  strategy: 'text-sky-700',
  warning: 'text-amber-700',
  blocked: 'text-red-700'
}

/** 预算琥珀警示的维度名 key */
const BUDGET_DIM_LABEL_KEYS: Record<RunBudgetDimension, MessageKey> = {
  steps: 'verifRun.loop.summary.dimSteps',
  tokens: 'verifRun.loop.summary.dimTokens',
  wall: 'verifRun.loop.summary.dimWall'
}

/** 单条预算水位条：≥100% 红、≥85% 琥珀、其余 emerald；max<=0 时按 0% 渲染 */
function BudgetBar({ label, used, max, suffix }: { label: string; used: number; max: number; suffix?: string }): React.JSX.Element {
  const pct = max > 0 ? Math.min(100, (used / max) * 100) : 0
  const cls = pct >= 100 ? 'bg-red-500' : pct >= 85 ? 'bg-amber-500' : 'bg-emerald-500'
  return <div>
    <div className="flex items-baseline justify-between text-[11px]">
      <span className="font-medium text-zinc-600">{label}</span>
      <span className="font-mono text-[10px] text-zinc-500">{used.toLocaleString()} / {max.toLocaleString()}{suffix ?? ''}</span>
    </div>
    <div className="mt-0.5 h-1.5 overflow-hidden rounded bg-zinc-100">
      <div className={`h-full rounded ${cls}`} style={{ width: `${pct}%` }} />
    </div>
  </div>
}

/** 预算对话框：start=启动（四项预算，留空/非法回落主进程默认值）；"已在运行"错误给强制停止重启逃生门；
 * resume=预填账本当前上限、可抬高后继续（主进程校验上限须严格大于当前消耗），顶部琥珀行显示当前消耗。 */
function BudgetDialog({ mode, initial, consumption, onSubmit, onStop, onClose }: {
  mode: 'start' | 'resume'
  initial?: { maxBeats?: number; maxTokens?: number; maxWallMinutes?: number; noProgressLimit?: number }
  consumption?: { beats: number; tokensUsed: number; elapsedMinutes: number } | null
  onSubmit: (options: VerifRunLoopStartOptions) => Promise<void>
  onStop: () => Promise<void>
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // resume 模式预填账本当前上限；缺省/非法回落启动默认值
  const initialText = (value: number | undefined, fallback: number): string =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? String(Math.trunc(value)) : String(fallback)
  const [maxBeats, setMaxBeats] = useState(() => initialText(initial?.maxBeats, RUN_LOOP_DEFAULT_MAX_BEATS))
  const [maxTokens, setMaxTokens] = useState(() => initialText(initial?.maxTokens, RUN_LOOP_DEFAULT_MAX_TOKENS))
  const [maxWallMinutes, setMaxWallMinutes] = useState(() => initialText(initial?.maxWallMinutes, RUN_LOOP_DEFAULT_MAX_WALL_MINUTES))
  const [noProgressLimit, setNoProgressLimit] = useState(() => initialText(initial?.noProgressLimit, 3))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 正整数解析；留空/非法一律省略该字段，由主进程回落默认值（§6）
  const positive = (text: string): number | undefined => {
    const parsed = Number(text)
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined
  }
  const buildOptions = (): VerifRunLoopStartOptions => ({
    maxBeats: positive(maxBeats),
    maxTokens: positive(maxTokens),
    maxWallMinutes: positive(maxWallMinutes),
    noProgressLimit: positive(noProgressLimit)
  })
  const fields: Array<{ key: MessageKey; hintKey: MessageKey; value: string; set: (text: string) => void; presets: Array<{ label: string; value: number }> }> = [
    {
      key: 'verifRun.loop.startDialog.maxBeats', hintKey: 'verifRun.loop.startDialog.maxBeatsHint', value: maxBeats, set: setMaxBeats,
      presets: [50, 100, 200, 500].map((n) => ({ label: String(n), value: n }))
    },
    {
      key: 'verifRun.loop.startDialog.maxTokens', hintKey: 'verifRun.loop.startDialog.maxTokensHint', value: maxTokens, set: setMaxTokens,
      presets: [5, 10, 20, 50].map((n) => ({ label: `${n}M`, value: n * 1_000_000 }))
    },
    {
      key: 'verifRun.loop.startDialog.maxWallMinutes', hintKey: 'verifRun.loop.startDialog.maxWallMinutesHint', value: maxWallMinutes, set: setMaxWallMinutes,
      presets: [120, 240, 480, 720].map((min) => ({ label: t('verifRun.loop.presetHours', { n: min / 60 }), value: min }))
    },
    {
      key: 'verifRun.loop.startDialog.noProgressLimit', hintKey: 'verifRun.loop.startDialog.noProgressLimitHint', value: noProgressLimit, set: setNoProgressLimit,
      presets: [3, 5, 10].map((n) => ({ label: String(n), value: n }))
    }
  ]
  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await onSubmit(buildOptions())
      onClose()
    } catch (err) {
      setError(t('verifRun.loop.actionFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }
  // 逃生门：主进程报"已在运行"（残留句柄，账本缺失/终态）→ 先停止再重启（仅 start 模式）
  const forceRestart = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await onStop()
      await onSubmit(buildOptions())
      onClose()
    } catch (err) {
      setError(t('verifRun.loop.actionFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }
  const resume = mode === 'resume'
  const titleKey: MessageKey = resume ? 'verifRun.loop.resumeDialog.title' : 'verifRun.loop.startDialog.title'
  const descKey: MessageKey = resume ? 'verifRun.loop.resumeDialog.description' : 'verifRun.loop.startDialog.description'
  const confirmKey: MessageKey = resume ? 'verifRun.loop.resumeDialog.confirm' : 'verifRun.loop.startDialog.confirm'
  return <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-6">
    <section className="w-full max-w-lg rounded-md border border-zinc-300 bg-white shadow-2xl">
      <header className="border-b border-zinc-200 px-5 py-4">
        <h2 className="text-base font-semibold text-zinc-900">{t(titleKey)}</h2>
        <p className="mt-1 text-xs leading-5 text-zinc-500">{t(descKey)}</p>
      </header>
      {resume && consumption && <div className="mx-5 mt-4 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
        {t('verifRun.loop.consumption', { beats: consumption.beats, tokens: consumption.tokensUsed, minutes: consumption.elapsedMinutes })}
      </div>}
      <div className="grid grid-cols-2 gap-4 p-5">
        {fields.map((field) => <label key={field.key} className="block text-xs font-medium text-zinc-700">
          {t(field.key)}
          <input
            type="number"
            min={1}
            inputMode="numeric"
            value={field.value}
            onChange={(event) => field.set(event.target.value)}
            className="mt-1 w-full rounded border border-zinc-300 bg-white px-3 py-2 font-mono text-sm"
          />
          <span className="mt-1 flex flex-wrap gap-1">
            {field.presets.map((preset) => <button
              key={`${field.key}-${preset.value}`}
              type="button"
              onClick={() => field.set(String(preset.value))}
              className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] font-mono text-zinc-600 hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700"
            >
              {preset.label}
            </button>)}
          </span>
          <span className="mt-1 block text-[10px] font-normal leading-4 text-zinc-400">{t(field.hintKey)}</span>
        </label>)}
      </div>
      {error && <div className="mx-5 mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
        <p>{error}</p>
        {!resume && error.includes('已在运行') && <button type="button" onClick={() => void forceRestart()} disabled={busy} className="mt-2 inline-flex items-center gap-1.5 rounded border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 disabled:opacity-50">
          {t('verifRun.loop.forceRestart')}
        </button>}
      </div>}
      <footer className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3">
        <button type="button" onClick={onClose} disabled={busy} className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 disabled:opacity-50">{t('common.cancel')}</button>
        <button type="button" onClick={() => void submit()} disabled={busy} className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
          <Play size={12} />{busy ? t('verifRun.loop.deciding') : t(confirmKey)}
        </button>
      </footer>
    </section>
  </div>
}

/** 外层循环卡（§7.1 看状态/做控制/收请示 三合一）。 */
export function RunLoopCard({ runLoop, decisions, forecast = null, onStart, onPause, onResume, onStop, onDecide }: RunLoopCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [dialogMode, setDialogMode] = useState<null | 'start' | 'resume'>(null)
  const [busy, setBusy] = useState<null | 'pause' | 'stop'>(null)
  const [error, setError] = useState<string | null>(null)
  // 墙钟水位随时间推进：30s 自刷新（账本文件变化时集成方也会触发重载）
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const state = runLoop?.state ?? 'idle'
  const stateMeta = STATE_META[state]
  const startedAtMs = runLoop ? Date.parse(runLoop.budget.startedAt) : NaN
  const wallUsed = Number.isFinite(startedAtMs) ? Math.max(0, Math.floor((now - startedAtMs) / 60_000)) : 0
  // 未运行（无账本或 idle 初态）→ 启动入口；终态（已停止/已完成）→ 重新启动入口（预填上轮预算）；
  // 执行中各态 → 暂停/停止；暂停态 → 继续/停止（§7.2 方向盘唯一）
  const startable = !runLoop || state === 'idle'
  const restartable = state === 'stopped' || state === 'completed'
  const pausable = state === 'planning' || state === 'running' || state === 'judging' || state === 'repairing' || state === 'signoff-review' || state === 'gate-check'
  const resumable = state === 'paused-human' || state === 'paused-breaker'
  const proposed = decisions.filter((decision) => decision.status === 'proposed')
  const history = decisions.filter((decision) => decision.status !== 'proposed')

  // 战略层摘要（一个数 + 一句话）：纯函数内核 + 渲染端 t() 注入（与 verification-guidance 薄壳同口径）。
  // pendingHumanSummary 本批由待人工暂停的 detail 派生；主进程后续批次可在账本内提供专用字段。
  const summaryTr: RunSummaryTranslate = (key, params) => t(key, params)
  const summary = runLoop ? buildRunSummary({
    wave: runLoop.wave,
    covered: runLoop.closurePlan?.metCount ?? null,
    total: runLoop.closurePlan?.totalCount ?? null,
    stale: null,
    forecast: forecast ?? null,
    closurePlan: runLoop.closurePlan ?? null,
    loopState: runLoop.state,
    pendingHumanSummary: runLoop.pause?.kind === 'human' ? runLoop.pause.detail.trim() || null : null,
    budgetWarning: null
  }, summaryTr) : null
  // 预算琥珀警示：平时隐藏，任一维度 used/max > 80% 才浮现（computeBudgetWarning 取最严重维度）；
  // 与预算三水位条并存（产品暂不要求隐藏水位条），"预计够/不够"由 forecast.binding 裁决。
  const budgetWarning = runLoop ? computeBudgetWarning(runLoop.budget, forecast ?? null, now) : null

  const run = async (key: 'pause' | 'stop', action: () => Promise<void>): Promise<void> => {
    setBusy(key)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(t('verifRun.loop.actionFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(null)
    }
  }

  return <section className="rounded border border-zinc-200 bg-white p-4">
    <div className="flex items-center gap-2">
      <Repeat size={15} className="text-zinc-400" />
      <h3 className="text-sm font-semibold">{t('verifRun.loop.title')}</h3>
      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${stateMeta.cls}`}>{t(stateMeta.labelKey)}</span>
      {runLoop?.updatedAt && <span className="ml-auto text-[10px] text-zinc-400">{t('verifRun.batch.updatedAt', { time: formatVerifTimestamp(runLoop.updatedAt) })}</span>}
    </div>

    {!runLoop ? <p className="mt-3 rounded border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-400">{t('verifRun.loop.empty')}</p> : <>
      {summary && <div className="mt-3 rounded border border-zinc-100 bg-zinc-50/60 px-3 py-2">
        <div className="text-sm font-semibold text-zinc-800">{summary.coverageText}</div>
        <p className={`mt-0.5 text-xs leading-5 ${SUMMARY_TONE_CLS[summary.tone]}`}>{summary.headline}</p>
        {summary.forecastNote && <p className="mt-0.5 text-[10px] text-zinc-400">{summary.forecastNote}</p>}
      </div>}

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <span className="font-medium text-zinc-700">
          {runLoop.wave ? t('verifRun.loop.wave', { wave: runLoop.wave }) : t('verifRun.loop.waveNone')}
        </span>
        <span className="text-zinc-600">{t('verifRun.loop.beat', { n: runLoop.beat })}</span>
      </div>

      <div className="mt-2">
        <div className="text-[11px] font-medium text-zinc-500">{t('verifRun.loop.currentTitle')}</div>
        {runLoop.current ? <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="font-mono text-zinc-800">{runLoop.current.kind || '—'}</span>
          {runLoop.current.actionId && <span className="font-mono text-[11px] text-zinc-500">{runLoop.current.actionId}</span>}
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${DECISION_SOURCE_META[runLoop.current.source].cls}`}>{t(DECISION_SOURCE_META[runLoop.current.source].labelKey)}</span>
          {runLoop.current.sessionName && <span className="font-mono text-[10px] text-zinc-400">{t('verifRun.loop.sessionLabel', { name: runLoop.current.sessionName })}</span>}
          {runLoop.current.dispatchedAt && <span className="text-[10px] text-zinc-400">{t('verifRun.batch.dispatchedAt', { time: formatVerifTimestamp(runLoop.current.dispatchedAt) })}</span>}
        </div> : <p className="mt-1 text-[11px] text-zinc-400">{t('verifRun.loop.noCurrent')}</p>}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <BudgetBar label={t('verifRun.loop.beatsBudget')} used={runLoop.budget.beats} max={runLoop.budget.maxBeats} />
        <BudgetBar label={t('verifRun.loop.tokensBudget')} used={Math.round(runLoop.budget.tokensUsed)} max={runLoop.budget.maxTokens} />
        <BudgetBar label={t('verifRun.loop.wallBudget')} used={wallUsed} max={runLoop.budget.maxWallMinutes} suffix={t('verifRun.loop.minutesSuffix')} />
      </div>

      {budgetWarning && <div className="mt-2 rounded border border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-700">
        {t('verifRun.loop.summary.budgetWarning', {
          dimension: t(BUDGET_DIM_LABEL_KEYS[budgetWarning.dimension]),
          percent: budgetWarning.max > 0 ? Math.round((budgetWarning.used / budgetWarning.max) * 100) : 0,
          used: Math.round(budgetWarning.used).toLocaleString(),
          max: Math.round(budgetWarning.max).toLocaleString(),
          verdict: t((forecast?.binding ?? 'unknown') === 'insufficient' ? 'verifRun.loop.summary.budgetShort' : 'verifRun.loop.summary.budgetEnough')
        })}
      </div>}

      {runLoop.pause && <div className={`mt-3 rounded border p-3 ${runLoop.pause.kind === 'breaker' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}>
        <div className={`text-[11px] font-semibold ${runLoop.pause.kind === 'breaker' ? 'text-red-700' : 'text-amber-700'}`}>
          {runLoop.pause.kind === 'breaker' ? t('verifRun.loop.pauseBreakerTitle') : t('verifRun.loop.pauseHumanTitle')}
          {runLoop.pause.reason && <span className="ml-2 font-mono font-normal">{runLoop.pause.reason}</span>}
        </div>
        {runLoop.pause.detail && <p className="mt-1 text-xs text-zinc-700">{runLoop.pause.detail}</p>}
        {runLoop.pause.pendingItems.length > 0 && <div className="mt-1.5">
          <div className="text-[10px] font-medium text-zinc-500">{t('verifRun.loop.pendingTitle')}</div>
          <ul className="mt-0.5 list-disc space-y-0.5 pl-4 text-[11px] text-zinc-600">
            {runLoop.pause.pendingItems.map((item, index) => <li key={index}>{item}</li>)}
          </ul>
        </div>}
        {runLoop.pause.since && <p className="mt-1 text-[10px] text-zinc-400">{t('verifRun.loop.pauseSince', { time: formatVerifTimestamp(runLoop.pause.since) })}</p>}
      </div>}

      {runLoop.lastBeats.length > 0 && <div className="mt-3">
        <div className="text-[11px] font-medium text-zinc-500">{t('verifRun.loop.beatsTitle')}</div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {runLoop.lastBeats.map((entry, index) => <span
            key={`${entry.beat}-${index}`}
            title={`#${entry.beat} ${entry.summary}${entry.verdict ? ` · ${entry.verdict}` : ''}`}
            className="inline-flex items-center gap-1 rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] text-zinc-600"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${entry.advanced ? 'bg-emerald-500' : 'bg-zinc-300'}`} />
            #{entry.beat}
          </span>)}
        </div>
      </div>}
    </>}

    <div className="mt-3 flex flex-wrap gap-2 border-t border-zinc-100 pt-3">
      {startable && <button type="button" onClick={() => setDialogMode('start')} className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500">
        <Play size={13} />{t('verifRun.loop.start')}
      </button>}
      {restartable && <button type="button" onClick={() => setDialogMode('start')} className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500">
        <Play size={13} />{t('verifRun.loop.restart')}
      </button>}
      {pausable && <button type="button" onClick={() => void run('pause', onPause)} disabled={busy !== null} className="inline-flex items-center gap-1.5 rounded border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50">
        <OctagonPause size={13} />{t('verifRun.loop.pause')}
      </button>}
      {resumable && <button type="button" onClick={() => setDialogMode('resume')} disabled={busy !== null} className="inline-flex items-center gap-1.5 rounded border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
        <Play size={13} />{t('verifRun.loop.resume')}
      </button>}
      {(pausable || resumable) && <button type="button" onClick={() => void run('stop', onStop)} disabled={busy !== null} className="inline-flex items-center gap-1.5 rounded border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">
        <Square size={13} />{t('verifRun.loop.stop')}
      </button>}
    </div>
    {error && <p className="mt-2 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

    <div className="mt-3 border-t border-zinc-100 pt-3">
      <div className="text-[11px] font-medium text-zinc-500">{t('verifRun.loop.decisionsTitle')}</div>
      <div className="mt-1.5 space-y-2">
        {proposed.map((decision) => <ProposedDecisionCard key={decision.id || `${decision.createdAt}-${decision.action.prompt}`} decision={decision} onDecide={onDecide} />)}
        {proposed.length === 0 && <p className="rounded border border-dashed border-zinc-300 px-3 py-2 text-center text-[11px] text-zinc-400">{t('verifRun.loop.proposedEmpty')}</p>}
      </div>
      {history.length > 0 && <details className="mt-2 rounded border border-zinc-200 bg-zinc-50/60">
        <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50">{t('verifRun.loop.historyTitle', { count: history.length })}</summary>
        <div className="divide-y divide-zinc-100 border-t border-zinc-200">
          {history.map((decision) => {
            const source = DECISION_SOURCE_META[decision.source]
            return <div key={decision.id || `${decision.createdAt}-${decision.action.prompt}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5 text-[11px]">
              <span className="font-mono text-zinc-600">{decision.id || '—'}</span>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${source.cls}`}>{t(source.labelKey)}</span>
              {decision.action.actionId && <span className="font-mono text-[10px] text-zinc-500">{decision.action.actionId}</span>}
              {decision.outcome
                ? <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${OUTCOME_META[decision.outcome].cls}`}>{t(OUTCOME_META[decision.outcome].labelKey)}</span>
                : <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-500">{t('verifRun.loop.outcome.none')}</span>}
              <span className="min-w-0 flex-1 truncate text-zinc-400" title={decision.rationale || decision.action.prompt}>{decision.rationale || decision.action.prompt}</span>
              {decision.createdAt && <span className="shrink-0 text-[10px] text-zinc-400">{formatVerifTimestamp(decision.createdAt)}</span>}
            </div>
          })}
        </div>
      </details>}
    </div>

    {dialogMode !== null && <BudgetDialog
      mode={dialogMode}
      initial={runLoop ? {
        maxBeats: runLoop.budget.maxBeats,
        maxTokens: runLoop.budget.maxTokens,
        maxWallMinutes: runLoop.budget.maxWallMinutes,
        noProgressLimit: runLoop.budget.noProgressLimit
      } : undefined}
      consumption={dialogMode === 'resume' && runLoop ? {
        beats: runLoop.budget.beats,
        tokensUsed: Math.round(runLoop.budget.tokensUsed),
        elapsedMinutes: wallUsed
      } : null}
      onSubmit={dialogMode === 'resume' ? onResume : onStart}
      onStop={onStop}
      onClose={() => setDialogMode(null)}
    />}
  </section>
}
