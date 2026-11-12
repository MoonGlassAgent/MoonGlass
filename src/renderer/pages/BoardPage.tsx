/**
 * 流程看板页（BOARD-AND-REVIEW-CLOSED-LOOP 片 C，设计文档 §4）
 *
 * 只读 DAG 视图：六阶段列（REQ_SPEC→SYNTH）× 任务卡 × 尝试记录。
 * 数据全部来自 window.moonglass.board.getBoardModel（主进程归一，片 B），
 * 本页不做写操作、不与编排耦合；决策待批卡仅提示待人工处置（无决策卡入口）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronRight, RefreshCw } from 'lucide-react'
import type { BoardAttempt, BoardAttemptVerdict, BoardModel, BoardTask, BoardTaskKind, BoardTaskStatus } from '@shared/ipc-contract'
import { PHASE_ORDER } from '@shared/types'
import { phaseLabel, useTranslation, type MessageKey } from '../i18n'

const STATUS_META: Record<BoardTaskStatus, { labelKey: MessageKey; badgeCls: string; barCls: string }> = {
  success: { labelKey: 'board.status.success', badgeCls: 'bg-emerald-100 text-emerald-700', barCls: 'bg-emerald-500' },
  running: { labelKey: 'board.status.running', badgeCls: 'bg-sky-100 text-sky-700', barCls: 'bg-sky-500' },
  'needs-fix': { labelKey: 'board.status.needsFix', badgeCls: 'bg-red-100 text-red-700', barCls: 'bg-red-500' },
  'pending-human': { labelKey: 'board.status.pendingHuman', badgeCls: 'bg-amber-100 text-amber-700', barCls: 'bg-amber-400' },
  'not-started': { labelKey: 'board.status.notStarted', badgeCls: 'bg-zinc-100 text-zinc-600', barCls: 'bg-zinc-400' }
}

const KIND_META: Record<BoardTaskKind, { labelKey: MessageKey; badgeCls: string }> = {
  batch: { labelKey: 'board.kind.batch', badgeCls: 'bg-indigo-100 text-indigo-700' },
  'rtl-fix': { labelKey: 'board.kind.rtlFix', badgeCls: 'bg-violet-100 text-violet-700' },
  'design-review': { labelKey: 'board.kind.designReview', badgeCls: 'bg-cyan-100 text-cyan-700' },
  'module-ut': { labelKey: 'board.kind.moduleUt', badgeCls: 'bg-teal-100 text-teal-700' },
  decision: { labelKey: 'board.kind.decision', badgeCls: 'bg-fuchsia-100 text-fuchsia-700' },
  'run-loop': { labelKey: 'board.kind.runLoop', badgeCls: 'bg-orange-100 text-orange-700' }
}

const VERDICT_META: Record<BoardAttemptVerdict, { labelKey: MessageKey; badgeCls: string }> = {
  success: { labelKey: 'board.verdict.success', badgeCls: 'bg-emerald-100 text-emerald-700' },
  failed: { labelKey: 'board.verdict.failed', badgeCls: 'bg-red-100 text-red-700' },
  'no-evidence': { labelKey: 'board.verdict.noEvidence', badgeCls: 'bg-amber-100 text-amber-700' },
  'circuit-broken': { labelKey: 'board.verdict.circuitBroken', badgeCls: 'bg-red-100 text-red-800' },
  error: { labelKey: 'board.verdict.error', badgeCls: 'bg-red-50 text-red-600' },
  running: { labelKey: 'board.verdict.running', badgeCls: 'bg-sky-100 text-sky-700' }
}

/** 任务最近活动时间：全部尝试起止里的最大有效时间戳（无有效时间回退 0） */
function lastActivityOf(task: BoardTask): number {
  let latest = 0
  for (const attempt of task.attempts) {
    for (const iso of [attempt.startedAt, attempt.settledAt ?? '']) {
      const time = Date.parse(iso)
      if (Number.isFinite(time) && time > latest) latest = time
    }
  }
  return latest
}

/** ISO 时间显示为 YYYY-MM-DD HH:mm:ss（去掉毫秒与时区标记），空值回退占位符 */
function formatTime(iso: string | undefined): string {
  if (!iso) return '—'
  return iso.replace('T', ' ').replace(/\.\d+Z$/, '')
}

function BoardTaskCard({ task }: { task: BoardTask }): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const status = STATUS_META[task.status]
  const kind = KIND_META[task.kind]
  const lastAttempt = task.attempts[task.attempts.length - 1]
  return (
    <div className={`overflow-hidden rounded border border-zinc-200 bg-white ${expanded ? '' : 'hover:border-zinc-300'}`}>
      <div className={`h-1 ${status.barCls}`} />
      <button type="button" onClick={() => setExpanded((value) => !value)} className="block w-full px-3 py-2 text-left">
        <div className="flex items-center gap-1.5">
          <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-semibold ${kind.badgeCls}`}>{t(kind.labelKey)}</span>
          <span className={`shrink-0 px-1.5 py-0.5 text-[10px] font-semibold ${status.badgeCls}`}>{t(status.labelKey)}</span>
          {task.attempts.length > 0 && <span className="ml-auto shrink-0 text-[10px] text-zinc-400">{t('board.attempts.indexLabel', { index: task.attempts.length })}</span>}
          {expanded ? <ChevronDown size={13} className="shrink-0 text-zinc-400" /> : <ChevronRight size={13} className="shrink-0 text-zinc-400" />}
        </div>
        <div className="mt-1.5 line-clamp-2 text-xs font-medium text-zinc-800" title={task.title}>{task.title}</div>
        <div className="mt-1 truncate font-mono text-[10px] text-zinc-400">{task.id}</div>
        {lastAttempt && <div className="mt-1 truncate text-[11px] text-zinc-500" title={lastAttempt.note ?? undefined}>
          {t('board.attempts.indexLabel', { index: lastAttempt.index })} · {(lastAttempt.model || t('board.attempts.unknownModel'))} · {t(VERDICT_META[lastAttempt.verdict].labelKey)}
        </div>}
        {task.status === 'pending-human' && <div className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-amber-700"><AlertTriangle size={12} className="shrink-0" />{t('board.pendingHuman')}</div>}
      </button>
      {expanded && (
        <div className="border-t border-zinc-100 px-3 py-2">
          <div className="text-[10px] font-medium uppercase text-zinc-400">{t('board.attempts.title')}</div>
          {task.attempts.length === 0 && <div className="mt-1 text-[11px] text-zinc-400">{t('board.attempts.empty')}</div>}
          <div className="mt-1 space-y-1.5">
            {[...task.attempts].reverse().map((attempt) => <AttemptRow key={attempt.index} attempt={attempt} />)}
          </div>
        </div>
      )}
    </div>
  )
}

function AttemptRow({ attempt }: { attempt: BoardAttempt }): React.JSX.Element {
  const { t } = useTranslation()
  const verdict = VERDICT_META[attempt.verdict]
  const startedMs = Date.parse(attempt.startedAt)
  const settledMs = attempt.settledAt ? Date.parse(attempt.settledAt) : NaN
  const durationMs = Number.isFinite(startedMs) && Number.isFinite(settledMs) && settledMs >= startedMs ? settledMs - startedMs : null
  const duration = durationMs === null
    ? '—'
    : durationMs >= 60_000
      ? t('board.attempts.durationMinutes', { minutes: Math.floor(durationMs / 60_000), seconds: Math.floor((durationMs % 60_000) / 1000) })
      : t('board.attempts.durationSeconds', { seconds: Math.max(1, Math.round(durationMs / 1000)) })
  return (
    <div className="rounded bg-zinc-50 px-2 py-1.5 text-[11px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-mono text-zinc-500">#{attempt.index}</span>
        <span className="min-w-0 truncate font-mono text-zinc-600" title={attempt.model}>{attempt.model || t('board.attempts.unknownModel')}</span>
        <span className={`px-1.5 py-0.5 text-[10px] font-semibold ${verdict.badgeCls}`}>{t(verdict.labelKey)}</span>
        <span className="ml-auto shrink-0 text-zinc-400" title={t('board.attempts.colDuration')}>{duration}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-zinc-400">
        <span>{t('board.attempts.colStartedAt')} {formatTime(attempt.startedAt)}</span>
        <span>{t('board.attempts.colSettledAt')} {formatTime(attempt.settledAt)}</span>
      </div>
      {attempt.note && <div className="mt-1 text-[11px] text-zinc-600">{attempt.note}</div>}
    </div>
  )
}

export function BoardPage(): React.JSX.Element {
  const { projectId } = useParams({ from: '/board/$projectId' })
  const { t } = useTranslation()
  const [model, setModel] = useState<BoardModel | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setModel(await window.moonglass.board.getBoardModel(projectId))
    } catch (caught) {
      setModel(null)
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { void load() }, [load])

  // 片 B 归一器已保证列内时间序；此处按最近活动时间新在前再兜底排一次，防未来数据源乱序
  const columns = useMemo(() => PHASE_ORDER.map((phase) => {
    const column = model?.phases.find((item) => item.phase === phase)
    const tasks = [...(column?.tasks ?? [])].sort((a, b) => lastActivityOf(b) - lastActivityOf(a))
    return { phase, tasks }
  }), [model])
  const totalTasks = columns.reduce((sum, column) => sum + column.tasks.length, 0)

  return (
    <div className="flex h-full min-h-0 flex-col bg-zinc-50 text-zinc-900">
      <header className="flex h-16 shrink-0 items-center gap-4 border-b border-zinc-200 bg-white px-5">
        <Link to="/workspace/$projectId" params={{ projectId }} className="flex items-center gap-1 text-sm text-zinc-500 hover:text-emerald-700"><ArrowLeft size={16} /> {t('board.navWorkspace')}</Link>
        <div className="h-6 w-px bg-zinc-200" />
        <div className="min-w-0"><h1 className="truncate text-base font-semibold">{t('board.title')}</h1><p className="truncate text-xs text-zinc-500">{t('board.subtitle')}</p></div>
        <div className="ml-auto flex items-center gap-3">
          {model && model.updatedAt !== '' && <span className="shrink-0 text-[11px] text-zinc-400">{t('board.updatedAt', { time: formatTime(model.updatedAt) })}</span>}
          <button onClick={() => void load()} disabled={loading} className="flex h-8 w-8 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-600 hover:border-emerald-500 hover:text-emerald-700 disabled:opacity-50" title={t('board.refresh')}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
        </div>
      </header>

      {error ? <div className="flex min-h-64 flex-1 items-center justify-center p-8"><div className="max-w-lg border border-red-200 bg-white p-8 text-center">
        <AlertTriangle className="mx-auto text-red-500" size={30} /><h2 className="mt-3 text-base font-semibold">{t('board.error.title')}</h2>
        <p className="mt-2 text-sm text-zinc-500">{t('board.error.hint', { message: error })}</p>
        <button onClick={() => void load()} className="mt-4 rounded border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700 hover:border-emerald-500">{t('board.reload')}</button>
      </div></div> : loading && !model ? <div className="flex flex-1 items-center justify-center text-sm text-zinc-400">{t('board.loading')}</div>
        : totalTasks === 0 ? <div className="flex min-h-64 flex-1 items-center justify-center p-8"><div className="max-w-lg border border-dashed border-zinc-300 bg-white p-8 text-center">
          <h2 className="text-base font-semibold">{t('board.empty.title')}</h2>
          <p className="mt-2 text-sm text-zinc-500">{t('board.empty.hint')}</p>
        </div></div> : (
          <main className="min-h-0 flex-1 overflow-x-auto p-4">
            <div className="flex h-full min-w-max items-stretch gap-3">
              {columns.map((column) => <section key={column.phase} className="flex w-64 shrink-0 flex-col rounded border border-zinc-200 bg-zinc-100/60">
                <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2">
                  <h2 className="truncate text-xs font-semibold">{phaseLabel(column.phase)}</h2>
                  <span className="ml-auto shrink-0 text-[10px] text-zinc-400">{t('board.taskCount', { count: column.tasks.length })}</span>
                </div>
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                  {column.tasks.map((task) => <BoardTaskCard key={task.id} task={task} />)}
                </div>
              </section>)}
            </div>
          </main>
        )}
    </div>
  )
}
