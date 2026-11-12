/**
 * 流程看板页（BOARD-AND-REVIEW-CLOSED-LOOP 片 C，设计文档 §4）
 *
 * 只读 DAG 视图：六阶段列（REQ_SPEC→SYNTH）× 任务卡 × 尝试记录。
 * 数据全部来自 window.moonglass.board.getBoardModel（主进程归一，片 B），
 * 本页不做写操作、不与编排耦合；决策待批卡仅提示待人工处置（无决策卡入口）。
 * 头部项目名经 window.moonglass.project.get 辅助读取，仅用于标题展示，失败静默回退。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronRight, Clock, Inbox, Loader2, RefreshCw } from 'lucide-react'
import type { BoardAttempt, BoardAttemptVerdict, BoardModel, BoardTask, BoardTaskKind, BoardTaskStatus } from '@shared/ipc-contract'
import { PHASE_ORDER, type Phase } from '@shared/types'
import { phaseLabel, useTranslation, type MessageKey } from '../i18n'

/** 字号阶梯：正文 text-xs(12px) / 辅助 text-[11px] / 弱化 text-[10px]，行距 leading-normal(1.5) */
const STATUS_META: Record<BoardTaskStatus, { labelKey: MessageKey; badgeCls: string; barCls: string }> = {
  success: { labelKey: 'board.status.success', badgeCls: 'bg-emerald-50 text-emerald-700 ring-emerald-200', barCls: 'border-l-emerald-500' },
  running: { labelKey: 'board.status.running', badgeCls: 'bg-sky-50 text-sky-700 ring-sky-200', barCls: 'border-l-sky-500' },
  'needs-fix': { labelKey: 'board.status.needsFix', badgeCls: 'bg-red-50 text-red-700 ring-red-200', barCls: 'border-l-red-500' },
  'pending-human': { labelKey: 'board.status.pendingHuman', badgeCls: 'bg-amber-50 text-amber-700 ring-amber-200', barCls: 'border-l-amber-400' },
  'not-started': { labelKey: 'board.status.notStarted', badgeCls: 'bg-zinc-50 text-zinc-500 ring-zinc-200', barCls: 'border-l-zinc-300' }
}

const KIND_META: Record<BoardTaskKind, { labelKey: MessageKey; badgeCls: string }> = {
  batch: { labelKey: 'board.kind.batch', badgeCls: 'bg-blue-50 text-blue-700 ring-blue-200' },
  'rtl-fix': { labelKey: 'board.kind.rtlFix', badgeCls: 'bg-orange-50 text-orange-700 ring-orange-200' },
  'design-review': { labelKey: 'board.kind.designReview', badgeCls: 'bg-purple-50 text-purple-700 ring-purple-200' },
  'module-ut': { labelKey: 'board.kind.moduleUt', badgeCls: 'bg-cyan-50 text-cyan-700 ring-cyan-200' },
  decision: { labelKey: 'board.kind.decision', badgeCls: 'bg-pink-50 text-pink-700 ring-pink-200' },
  'run-loop': { labelKey: 'board.kind.runLoop', badgeCls: 'bg-zinc-50 text-zinc-600 ring-zinc-200' }
}

const VERDICT_META: Record<BoardAttemptVerdict, { labelKey: MessageKey; badgeCls: string; dotCls: string }> = {
  success: { labelKey: 'board.verdict.success', badgeCls: 'bg-emerald-50 text-emerald-700 ring-emerald-200', dotCls: 'bg-emerald-500' },
  failed: { labelKey: 'board.verdict.failed', badgeCls: 'bg-red-50 text-red-700 ring-red-200', dotCls: 'bg-red-500' },
  'no-evidence': { labelKey: 'board.verdict.noEvidence', badgeCls: 'bg-amber-50 text-amber-700 ring-amber-200', dotCls: 'bg-amber-400' },
  'circuit-broken': { labelKey: 'board.verdict.circuitBroken', badgeCls: 'bg-red-50 text-red-800 ring-red-300', dotCls: 'bg-red-600' },
  error: { labelKey: 'board.verdict.error', badgeCls: 'bg-red-50 text-red-600 ring-red-200', dotCls: 'bg-red-400' },
  running: { labelKey: 'board.verdict.running', badgeCls: 'bg-sky-50 text-sky-700 ring-sky-200', dotCls: 'bg-sky-400' }
}

/** 阶段列头圆点配色（与卡片徽标配色体系分离，避免与任务类型色混淆） */
const PHASE_META: Record<Phase, { dotCls: string }> = {
  REQ_SPEC: { dotCls: 'bg-sky-500' },
  ARCH: { dotCls: 'bg-violet-500' },
  RTL: { dotCls: 'bg-blue-600' },
  VERIF: { dotCls: 'bg-emerald-500' },
  QA: { dotCls: 'bg-amber-500' },
  SYNTH: { dotCls: 'bg-fuchsia-500' }
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

/** 阶段列：阶段色圆点 + 阶段名 + 任务数胶囊；空列给淡出占位 */
function PhaseColumn({ phase, tasks }: { phase: Phase; tasks: BoardTask[] }): React.JSX.Element {
  const { t } = useTranslation()
  const meta = PHASE_META[phase]
  return (
    <section className="flex w-72 shrink-0 flex-col rounded-xl border border-zinc-200 bg-zinc-100/70">
      <header className="flex items-center gap-2 border-b border-zinc-200 bg-white px-3 py-2.5">
        <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dotCls}`} />
        <h2 className="truncate text-xs font-semibold text-zinc-800">{phaseLabel(phase)}</h2>
        <span className="ml-auto shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500">{t('board.taskCount', { count: tasks.length })}</span>
      </header>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-2.5">
        {tasks.length === 0
          ? <div className="mt-4 rounded-lg border border-dashed border-zinc-200 py-6 text-center text-[11px] text-zinc-400">{t('board.columnEmpty')}</div>
          : tasks.map((task) => <BoardTaskCard key={task.id} task={task} />)}
      </div>
    </section>
  )
}

function BoardTaskCard({ task }: { task: BoardTask }): React.JSX.Element {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const status = STATUS_META[task.status]
  const kind = KIND_META[task.kind]
  const lastAttempt = task.attempts[task.attempts.length - 1]
  return (
    <div className={`overflow-hidden rounded-lg border bg-white shadow-sm transition-all duration-150 border-l-2 ${status.barCls} ${expanded ? 'border-zinc-300' : 'border-zinc-200 hover:-translate-y-0.5 hover:border-zinc-300 hover:shadow-md'}`}>
      <button type="button" onClick={() => setExpanded((value) => !value)} className="block w-full px-3 py-2.5 text-left">
        <div className="flex items-center gap-1.5">
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${kind.badgeCls}`}>{t(kind.labelKey)}</span>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${status.badgeCls}`}>{t(status.labelKey)}</span>
          {task.attempts.length > 0 && <span className="ml-auto shrink-0 text-[10px] text-zinc-400">{t('board.attemptCount', { count: task.attempts.length })}</span>}
          {expanded ? <ChevronDown size={13} className="shrink-0 text-zinc-400" /> : <ChevronRight size={13} className="shrink-0 text-zinc-400" />}
        </div>
        <div className="mt-1.5 line-clamp-2 text-xs font-medium leading-normal text-zinc-800" title={task.title}>{task.title}</div>
        <div className="mt-1 truncate font-mono text-[10px] text-zinc-400">{task.id}</div>
        {lastAttempt && <div className="mt-1 truncate text-[11px] leading-normal text-zinc-500" title={lastAttempt.note ?? undefined}>
          {t('board.attempts.indexLabel', { index: lastAttempt.index })} · {(lastAttempt.model || t('board.attempts.unknownModel'))} · {t(VERDICT_META[lastAttempt.verdict].labelKey)}
        </div>}
        {task.status === 'pending-human' && <div className="mt-2 flex items-center gap-1.5 rounded-md bg-amber-50 px-2 py-1 text-[11px] font-medium leading-normal text-amber-700 ring-1 ring-inset ring-amber-200"><AlertTriangle size={12} className="shrink-0" />{t('board.pendingHuman')}</div>}
      </button>
      {expanded && (
        <div className="border-t border-zinc-100 bg-zinc-50/60 px-3 py-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">{t('board.attempts.title')}</div>
          {task.attempts.length === 0
            ? <div className="mt-2 text-[11px] text-zinc-400">{t('board.attempts.empty')}</div>
            : <ol className="mt-2 ml-1 border-l border-zinc-200">
                {[...task.attempts].reverse().map((attempt) => <AttemptItem key={attempt.index} attempt={attempt} />)}
              </ol>}
        </div>
      )}
    </div>
  )
}

/** 尝试记录时间线条目：左侧竖线节点（判定色圆点）+ 右侧序号/模型/判定胶囊/起止/耗时/note */
function AttemptItem({ attempt }: { attempt: BoardAttempt }): React.JSX.Element {
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
    <li className="relative pb-3 pl-5 last:pb-0">
      <span className={`absolute -left-[25px] top-1 h-2 w-2 rounded-full ring-2 ring-white ${verdict.dotCls}`} />
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-normal">
        <span className="shrink-0 font-mono font-medium text-zinc-500">#{attempt.index}</span>
        <span className="min-w-0 truncate font-mono text-zinc-600" title={attempt.model}>{attempt.model || t('board.attempts.unknownModel')}</span>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${verdict.badgeCls}`}>{t(verdict.labelKey)}</span>
        <span className="ml-auto shrink-0 text-[10px] text-zinc-400" title={t('board.attempts.colDuration')}>{duration}</span>
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-zinc-400">
        <span>{t('board.attempts.colStartedAt')} {formatTime(attempt.startedAt)}</span>
        <span>{t('board.attempts.colSettledAt')} {formatTime(attempt.settledAt)}</span>
      </div>
      {attempt.note && <div className="mt-1 text-[11px] leading-normal text-zinc-600">{attempt.note}</div>}
    </li>
  )
}

export function BoardPage(): React.JSX.Element {
  const { projectId } = useParams({ from: '/board/$projectId' })
  const { t } = useTranslation()
  const [model, setModel] = useState<BoardModel | null>(null)
  const [projectName, setProjectName] = useState('')
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

  // 头部项目名仅作标题展示，读取失败静默回退为看板标题（不影响看板数据链路）
  useEffect(() => {
    let alive = true
    void window.moonglass.project.get(projectId)
      .then((project) => { if (alive && project) setProjectName(project.name) })
      .catch(() => {})
    return () => { alive = false }
  }, [projectId])

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
        <Link to="/workspace/$projectId" params={{ projectId }} className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-3 text-xs text-zinc-500 transition-colors hover:border-emerald-500 hover:text-emerald-700"><ArrowLeft size={14} /> {t('board.navWorkspace')}</Link>
        <div className="h-8 w-px bg-zinc-200" />
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold leading-normal text-zinc-900">{projectName || t('board.title')}</h1>
          <p className="truncate text-[11px] leading-normal text-zinc-500">{t('board.subtitle')}</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {model && model.updatedAt !== '' && <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-zinc-400"><Clock size={12} />{t('board.updatedAt', { time: formatTime(model.updatedAt) })}</span>}
          <button onClick={() => void load()} disabled={loading} className="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-xs text-zinc-600 transition-colors hover:border-emerald-500 hover:text-emerald-700 disabled:opacity-50" title={t('board.refresh')}><RefreshCw size={13} className={loading ? 'animate-spin' : ''} />{t('board.refresh')}</button>
        </div>
      </header>

      {error ? <div className="flex min-h-64 flex-1 items-center justify-center p-8"><div className="w-full max-w-lg rounded-xl border border-red-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-red-50"><AlertTriangle className="text-red-500" size={18} /></div>
        <h2 className="mt-3 text-sm font-semibold text-zinc-900">{t('board.error.title')}</h2>
        <p className="mt-1.5 text-[11px] leading-normal text-zinc-500">{t('board.error.hint', { message: error })}</p>
        <button onClick={() => void load()} className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-300 bg-white px-3 text-xs text-zinc-700 transition-colors hover:border-emerald-500 hover:text-emerald-700">{t('board.reload')}</button>
      </div></div> : loading && !model ? <div className="flex min-h-64 flex-1 items-center justify-center p-8"><div className="flex w-full max-w-lg flex-col items-center rounded-xl border border-zinc-200 bg-white p-10 shadow-sm">
        <Loader2 size={24} className="animate-spin text-emerald-600" />
        <p className="mt-3 text-xs leading-normal text-zinc-500">{t('board.loading')}</p>
      </div></div>
        : totalTasks === 0 ? <div className="flex min-h-64 flex-1 items-center justify-center p-8"><div className="w-full max-w-lg rounded-xl border border-dashed border-zinc-300 bg-white p-10 text-center">
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-zinc-100"><Inbox size={18} className="text-zinc-400" /></div>
          <h2 className="mt-3 text-sm font-semibold text-zinc-800">{t('board.empty.title')}</h2>
          <p className="mt-1.5 text-[11px] leading-normal text-zinc-500">{t('board.empty.hint')}</p>
        </div></div> : (
          <main className="min-h-0 flex-1 overflow-x-auto p-4">
            <div className="flex h-full min-w-max items-stretch gap-4">
              {columns.map((column) => <PhaseColumn key={column.phase} phase={column.phase} tasks={column.tasks} />)}
            </div>
          </main>
        )}
    </div>
  )
}
