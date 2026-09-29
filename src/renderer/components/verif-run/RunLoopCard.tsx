/**
 * 外层循环卡（VERIF-RUN-LOOP 批 4，设计文档 §7.1/§9.1/§9.2）。
 *
 * 单卡承载"看状态 + 做控制 + 收请示"：
 * - 状态区：11 态徽标 + 当前波段 + 第 n 拍 + 当前动作（来源徽标 规则=蓝 / LLM=紫 / 人工=绿）
 *   + 预算水位条（拍数/token/墙钟）+ 暂停原因卡（human/breaker + pendingItems）+
 *   lastBeats 迷你时间线（advanced 绿点 / no-progress 灰点）。
 * - 控制区：未运行 → "启动自动验证"（启动对话框：四项预算 + 默认值 + 说明）；运行中 →
 *   暂停/停止；暂停 → 继续/停止。按钮经集成方回调走 IPC，失败以卡内错误条提示。
 * - 决策区：decision-ledger 中 status='proposed' 的请示卡片（批准/否决），
 *   已执行决策历史（来源徽标 + outcome 徽标，折叠）。
 *
 * 纯数据 + 回调组件：不自己发 IPC，账本数据由集成方读取落盘 JSON 归一化后传入。
 */

import { useEffect, useState } from 'react'
import { Check, OctagonPause, Play, Repeat, Square, X } from 'lucide-react'
import type { VerifRunLoopLedger, VerifRunLoopStartOptions, VerifRunLoopState } from '@shared/types'
import { useTranslation, type MessageKey } from '../../i18n'
import {
  RUN_LOOP_DEFAULT_MAX_BEATS,
  RUN_LOOP_DEFAULT_MAX_TOKENS,
  RUN_LOOP_DEFAULT_MAX_WALL_MINUTES,
  formatVerifTimestamp,
  type VerifRunDecisionEntryView,
  type VerifRunDecisionOutcome,
  type VerifRunDecisionSource
} from './types'

export interface RunLoopCardProps {
  /** 外层循环账本（run-loop.json 归一化结果；null=无循环记录/未加载） */
  runLoop: VerifRunLoopLedger | null
  /** 决策账本条目（decision-ledger.json 归一化结果，新在前） */
  decisions: VerifRunDecisionEntryView[]
  /** 启动循环（四项预算均可选；缺省走主进程默认值） */
  onStart: (options: VerifRunLoopStartOptions) => Promise<void>
  /** 暂停循环（当前拍完成后转 paused） */
  onPause: () => Promise<void>
  /** 恢复循环（清暂停重新推导下一拍） */
  onResume: () => Promise<void>
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

/** 决策来源徽标（规则=蓝 / LLM=紫 / 人工=绿，§7.1 动作来源徽标同口径） */
const SOURCE_META: Record<VerifRunDecisionSource, { labelKey: MessageKey; cls: string }> = {
  rule: { labelKey: 'verifRun.loop.source.rule', cls: 'bg-sky-100 text-sky-700' },
  llm: { labelKey: 'verifRun.loop.source.llm', cls: 'bg-violet-100 text-violet-700' },
  human: { labelKey: 'verifRun.loop.source.human', cls: 'bg-emerald-100 text-emerald-700' }
}

/** outcome 徽标（advanced 绿 / no-progress 灰 / failed 红；未回填用状态徽标灰） */
const OUTCOME_META: Record<VerifRunDecisionOutcome, { labelKey: MessageKey; cls: string }> = {
  advanced: { labelKey: 'verifRun.loop.outcome.advanced', cls: 'bg-emerald-100 text-emerald-700' },
  'no-progress': { labelKey: 'verifRun.loop.outcome.no-progress', cls: 'bg-zinc-100 text-zinc-600' },
  failed: { labelKey: 'verifRun.loop.outcome.failed', cls: 'bg-red-100 text-red-700' }
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

/** 启动对话框：四项预算输入（留空/非法回落主进程默认值）。 */
function StartDialog({ onSubmit, onClose }: { onSubmit: (options: VerifRunLoopStartOptions) => Promise<void>; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [maxBeats, setMaxBeats] = useState(String(RUN_LOOP_DEFAULT_MAX_BEATS))
  const [maxTokens, setMaxTokens] = useState(String(RUN_LOOP_DEFAULT_MAX_TOKENS))
  const [maxWallMinutes, setMaxWallMinutes] = useState(String(RUN_LOOP_DEFAULT_MAX_WALL_MINUTES))
  const [noProgressLimit, setNoProgressLimit] = useState(String(3))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 正整数解析；留空/非法一律省略该字段，由主进程回落默认值（§6）
  const positive = (text: string): number | undefined => {
    const parsed = Number(text)
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined
  }
  const fields: Array<{ key: MessageKey; hintKey: MessageKey; value: string; set: (text: string) => void }> = [
    { key: 'verifRun.loop.startDialog.maxBeats', hintKey: 'verifRun.loop.startDialog.maxBeatsHint', value: maxBeats, set: setMaxBeats },
    { key: 'verifRun.loop.startDialog.maxTokens', hintKey: 'verifRun.loop.startDialog.maxTokensHint', value: maxTokens, set: setMaxTokens },
    { key: 'verifRun.loop.startDialog.maxWallMinutes', hintKey: 'verifRun.loop.startDialog.maxWallMinutesHint', value: maxWallMinutes, set: setMaxWallMinutes },
    { key: 'verifRun.loop.startDialog.noProgressLimit', hintKey: 'verifRun.loop.startDialog.noProgressLimitHint', value: noProgressLimit, set: setNoProgressLimit }
  ]
  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await onSubmit({
        maxBeats: positive(maxBeats),
        maxTokens: positive(maxTokens),
        maxWallMinutes: positive(maxWallMinutes),
        noProgressLimit: positive(noProgressLimit)
      })
      onClose()
    } catch (err) {
      setError(t('verifRun.loop.actionFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }
  return <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-6">
    <section className="w-full max-w-lg rounded-md border border-zinc-300 bg-white shadow-2xl">
      <header className="border-b border-zinc-200 px-5 py-4">
        <h2 className="text-base font-semibold text-zinc-900">{t('verifRun.loop.startDialog.title')}</h2>
        <p className="mt-1 text-xs leading-5 text-zinc-500">{t('verifRun.loop.startDialog.description')}</p>
      </header>
      <div className="grid grid-cols-2 gap-4 p-5">
        {fields.map((field) => <label key={field.key} className="block text-xs font-medium text-zinc-700">
          {t(field.key)}
          <input
            type="number"
            min={1}
            value={field.value}
            onChange={(event) => field.set(event.target.value)}
            className="mt-1 w-full rounded border border-zinc-300 bg-white px-3 py-2 font-mono text-sm"
          />
          <span className="mt-1 block text-[10px] font-normal leading-4 text-zinc-400">{t(field.hintKey)}</span>
        </label>)}
      </div>
      {error && <p className="mx-5 mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      <footer className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3">
        <button type="button" onClick={onClose} disabled={busy} className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 disabled:opacity-50">{t('common.cancel')}</button>
        <button type="button" onClick={() => void submit()} disabled={busy} className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50">
          <Play size={12} />{busy ? t('verifRun.loop.deciding') : t('verifRun.loop.startDialog.confirm')}
        </button>
      </footer>
    </section>
  </div>
}

/** 决策请示卡片（status='proposed'）：rationale / prompt 摘要 / 预期产出 / 停止条件 / 证据数 + 批准否决。 */
function ProposedDecisionCard({ decision, onDecide }: { decision: VerifRunDecisionEntryView; onDecide: RunLoopCardProps['onDecide'] }): React.JSX.Element {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const source = SOURCE_META[decision.source]
  const decide = async (verdict: 'approved' | 'rejected'): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await onDecide(decision.id, verdict)
    } catch (err) {
      setError(t('verifRun.loop.actionFailed', { error: err instanceof Error ? err.message : String(err) }))
    } finally {
      setBusy(false)
    }
  }
  return <div className="rounded border border-violet-200 bg-violet-50/50 p-3">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-mono text-[11px] font-semibold text-zinc-700">{decision.id || '—'}</span>
      <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${source.cls}`}>{t(source.labelKey)}</span>
      {decision.action.actionId && <span className="font-mono text-[10px] text-zinc-500">{decision.action.actionId}</span>}
      {decision.createdAt && <span className="ml-auto text-[10px] text-zinc-400">{formatVerifTimestamp(decision.createdAt)}</span>}
    </div>
    {decision.rationale && <p className="mt-1.5 text-xs text-zinc-700">{decision.rationale}</p>}
    {decision.action.prompt && <p className="mt-1 truncate font-mono text-[10px] text-zinc-500" title={decision.action.prompt}>{t('verifRun.loop.promptLabel')}：{decision.action.prompt}</p>}
    <div className="mt-1.5 grid gap-x-4 gap-y-0.5 text-[11px] text-zinc-600 sm:grid-cols-2">
      {decision.action.expectedOutput && <span className="truncate" title={decision.action.expectedOutput}>{t('verifRun.loop.expectedLabel')}：{decision.action.expectedOutput}</span>}
      {decision.action.stopCriteria && <span className="truncate" title={decision.action.stopCriteria}>{t('verifRun.loop.stopCriteriaLabel')}：{decision.action.stopCriteria}</span>}
    </div>
    <div className="mt-2 flex items-center gap-2">
      <span className="text-[10px] text-zinc-400">{t('verifRun.loop.evidenceCount', { count: decision.evidenceRefs.length })}</span>
      <div className="ml-auto flex gap-2">
        <button type="button" onClick={() => void decide('approved')} disabled={busy} className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-white px-2.5 py-1 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
          <Check size={12} />{t('verifRun.loop.approve')}
        </button>
        <button type="button" onClick={() => void decide('rejected')} disabled={busy} className="inline-flex items-center gap-1 rounded border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50">
          <X size={12} />{t('verifRun.loop.reject')}
        </button>
      </div>
    </div>
    {error && <p className="mt-2 rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-[11px] text-red-700">{error}</p>}
  </div>
}

/** 外层循环卡（§7.1 看状态/做控制/收请示 三合一）。 */
export function RunLoopCard({ runLoop, decisions, onStart, onPause, onResume, onStop, onDecide }: RunLoopCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [startDialogOpen, setStartDialogOpen] = useState(false)
  const [busy, setBusy] = useState<null | 'pause' | 'resume' | 'stop'>(null)
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
  // 未运行（无账本或 idle 初态）→ 启动入口；执行中各态 → 暂停/停止；暂停态 → 继续/停止（§7.2 方向盘唯一）
  const startable = !runLoop || state === 'idle'
  const pausable = state === 'planning' || state === 'running' || state === 'judging' || state === 'repairing' || state === 'signoff-review' || state === 'gate-check'
  const resumable = state === 'paused-human' || state === 'paused-breaker'
  const proposed = decisions.filter((decision) => decision.status === 'proposed')
  const history = decisions.filter((decision) => decision.status !== 'proposed')

  const run = async (key: 'pause' | 'resume' | 'stop', action: () => Promise<void>): Promise<void> => {
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
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${SOURCE_META[runLoop.current.source].cls}`}>{t(SOURCE_META[runLoop.current.source].labelKey)}</span>
          {runLoop.current.sessionName && <span className="font-mono text-[10px] text-zinc-400">{t('verifRun.loop.sessionLabel', { name: runLoop.current.sessionName })}</span>}
          {runLoop.current.dispatchedAt && <span className="text-[10px] text-zinc-400">{t('verifRun.batch.dispatchedAt', { time: formatVerifTimestamp(runLoop.current.dispatchedAt) })}</span>}
        </div> : <p className="mt-1 text-[11px] text-zinc-400">{t('verifRun.loop.noCurrent')}</p>}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <BudgetBar label={t('verifRun.loop.beatsBudget')} used={runLoop.budget.beats} max={runLoop.budget.maxBeats} />
        <BudgetBar label={t('verifRun.loop.tokensBudget')} used={Math.round(runLoop.budget.tokensUsed)} max={runLoop.budget.maxTokens} />
        <BudgetBar label={t('verifRun.loop.wallBudget')} used={wallUsed} max={runLoop.budget.maxWallMinutes} suffix={t('verifRun.loop.minutesSuffix')} />
      </div>

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
      {startable && <button type="button" onClick={() => setStartDialogOpen(true)} className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500">
        <Play size={13} />{t('verifRun.loop.start')}
      </button>}
      {pausable && <button type="button" onClick={() => void run('pause', onPause)} disabled={busy !== null} className="inline-flex items-center gap-1.5 rounded border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-50">
        <OctagonPause size={13} />{t('verifRun.loop.pause')}
      </button>}
      {resumable && <button type="button" onClick={() => void run('resume', onResume)} disabled={busy !== null} className="inline-flex items-center gap-1.5 rounded border border-emerald-300 bg-white px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">
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
            const source = SOURCE_META[decision.source]
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

    {startDialogOpen && <StartDialog onSubmit={onStart} onClose={() => setStartDialogOpen(false)} />}
  </section>
}
