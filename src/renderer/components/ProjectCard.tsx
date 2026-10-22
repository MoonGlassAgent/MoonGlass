/**
 * 项目卡片（规格书 §5.2）
 *
 * 显示：项目名称 + 当前阶段标签 + 会话活动徽标（进行中/上轮中断/空闲）+ 6 阶段进度条 + 更新时间。
 */

import { Link } from '@tanstack/react-router'
import { BellRing, Folder, FolderInput, Pencil, Trash2 } from 'lucide-react'
import { PHASE_ORDER, type ChipProject, type ProjectSessionActivity } from '@shared/types'
import { phaseLabel, useTranslation } from '../i18n'
import type { ManagedRunInfo } from '../store/managedStore'

interface ProjectCardProps {
  project: ChipProject
  /** 项目会话活动聚合（无存活会话且无中断标记时为 undefined，不显示徽标） */
  activity?: ProjectSessionActivity
  /** 一键托管运行状态（running 时优先于会话徽标显示「托管中」） */
  managed?: ManagedRunInfo
  onDelete?: (id: string) => void
  onMigrate?: (project: ChipProject) => void
  onEdit?: (project: ChipProject) => void
}

export function ProjectCard({ project, activity, managed, onDelete, onMigrate, onEdit }: ProjectCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const resolvedCount = PHASE_ORDER.filter((p) =>
    ['completed', 'skipped'].includes(project.phases[p].status)
  ).length
  const projectCompleted = project.phases.SYNTH.status === 'completed'
  const progress = Math.round((resolvedCount / PHASE_ORDER.length) * 100)

  return (
    <div className="project-card group relative rounded-lg border border-zinc-200 bg-white p-4 hover:border-zinc-400">
      <Link to="/workspace/$projectId" params={{ projectId: project.id }} className="block">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold text-zinc-900">{project.name}</h3>
          <div className="flex shrink-0 items-center gap-1.5">
            {/* 待人处理徽标（待确认决策/待裁决提案）："需要用户"是最高优先级信号，置于状态徽标之前 */}
            {activity?.pendingActions && activity.pendingActions.decisionRequests + activity.pendingActions.loopDecisions > 0 && (
              <span
                className="inline-flex items-center gap-1 rounded border border-orange-300 bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-700"
                title={t('projects.pendingActionsTooltip', { titles: activity.pendingActions.titles.join('\n') })}
              >
                <BellRing size={11} />
                {t('projects.pendingActions', { count: activity.pendingActions.decisionRequests + activity.pendingActions.loopDecisions })}
              </span>
            )}
            {managed?.running ? (
              <span
                className="inline-flex items-center gap-1.5 rounded border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs text-sky-700"
                title={t('projects.managedRunningTooltip', {
                  phase: managed.phase ? phaseLabel(managed.phase) : '…',
                  target: phaseLabel(managed.targetPhase),
                  since: new Date(managed.startedAt).toLocaleString()
                })}
              >
                <span className="size-1.5 animate-pulse rounded-full bg-sky-500" />
                {t('projects.managedRunning', { phase: managed.phase ? phaseLabel(managed.phase) : '…' })}
              </span>
            ) : activity?.running ? (
              <span
                className="inline-flex items-center gap-1.5 rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700"
                title={t('projects.sessionRunningTooltip', { sessions: activity.runningSessions.join('、') })}
              >
                <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
                {t('projects.sessionRunning')}
              </span>
            ) : activity?.interrupted && activity.interrupted.length > 0 ? (
              <span
                className="inline-flex items-center gap-1.5 rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700"
                title={t('projects.sessionInterruptedTooltip', { sessions: activity.interrupted.join('、') })}
              >
                <span className="size-1.5 rounded-full bg-amber-500" />
                {t('projects.sessionInterrupted')}
              </span>
            ) : activity?.hasSession ? (
              <span
                className="inline-flex items-center gap-1.5 rounded border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-xs text-zinc-500"
                title={t('projects.sessionIdleTooltip')}
              >
                <span className="size-1.5 rounded-full bg-zinc-400" />
                {t('projects.sessionIdle')}
              </span>
            ) : null}
            <span className={`rounded border px-2 py-0.5 text-xs ${
              projectCompleted
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border-blue-200 bg-blue-50 text-blue-700'
            }`}>
              {projectCompleted ? t('projects.completed') : `${project.currentPhase} · ${phaseLabel(project.currentPhase)}`}
            </span>
          </div>
        </div>
        {project.description && (
          <p className="mb-3 line-clamp-2 text-sm text-zinc-600">{project.description}</p>
        )}
        <div
          className="mb-3 flex min-w-0 items-center gap-1.5 text-xs text-zinc-500"
          title={project.workspacePath ?? t('projects.defaultDirectory')}
        >
          <Folder size={13} className="shrink-0" />
          <span className="truncate">{project.workspacePath ?? t('projects.defaultDirectory')}</span>
        </div>
        <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-zinc-200">
          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${progress}%` }} />
        </div>
        <div className="flex justify-between text-xs text-zinc-500">
          <span>{t('projects.progress', { resolved: resolvedCount, total: PHASE_ORDER.length, percent: progress })}</span>
          <span>{t('projects.updatedAt', { time: new Date(project.updatedAt).toLocaleString() })}</span>
        </div>
      </Link>
      {onEdit && (
        <button
          onClick={(event) => { event.preventDefault(); onEdit(project) }}
          className="absolute right-[4.5rem] top-2 hidden size-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-blue-600 group-hover:flex"
          title={t('projects.editTitle')}
        >
          <Pencil size={14} />
        </button>
      )}
      {onMigrate && (
        <button
          onClick={(event) => {
            event.preventDefault()
            onMigrate(project)
          }}
          className="absolute right-10 top-2 hidden size-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-blue-600 group-hover:flex"
          title={t('projects.migrateTitle')}
        >
          <FolderInput size={14} />
        </button>
      )}
      {onDelete && (
        <button
          onClick={(e) => {
            e.preventDefault()
            if (window.confirm(t('projects.deleteConfirm', { name: project.name }))) onDelete(project.id)
          }}
          className="absolute right-2 top-2 hidden size-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-red-600 group-hover:flex"
          title={t('projects.deleteTitle')}
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  )
}
