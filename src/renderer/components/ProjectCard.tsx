/**
 * 项目卡片（规格书 §5.2）
 *
 * 显示：项目名称 + 当前阶段标签 + 6 阶段进度条 + 更新时间。
 */

import { Link } from '@tanstack/react-router'
import { Folder, Trash2 } from 'lucide-react'
import { PHASE_LABELS, PHASE_ORDER, type ChipProject } from '@shared/types'

interface ProjectCardProps {
  project: ChipProject
  onDelete?: (id: string) => void
}

export function ProjectCard({ project, onDelete }: ProjectCardProps): React.JSX.Element {
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
          <span className={`rounded border px-2 py-0.5 text-xs ${
            projectCompleted
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-blue-200 bg-blue-50 text-blue-700'
          }`}>
            {projectCompleted ? '项目完成' : `${project.currentPhase} · ${PHASE_LABELS[project.currentPhase]}`}
          </span>
        </div>
        {project.description && (
          <p className="mb-3 line-clamp-2 text-sm text-zinc-600">{project.description}</p>
        )}
        <div
          className="mb-3 flex min-w-0 items-center gap-1.5 text-xs text-zinc-500"
          title={project.workspacePath ?? 'MoonGlass 默认项目目录'}
        >
          <Folder size={13} className="shrink-0" />
          <span className="truncate">{project.workspacePath ?? 'MoonGlass 默认项目目录'}</span>
        </div>
        <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-zinc-200">
          <div className="h-full rounded-full bg-emerald-500" style={{ width: `${progress}%` }} />
        </div>
        <div className="flex justify-between text-xs text-zinc-500">
          <span>进度 {resolvedCount}/{PHASE_ORDER.length}（{progress}%）</span>
          <span>更新于 {new Date(project.updatedAt).toLocaleString()}</span>
        </div>
      </Link>
      {onDelete && (
        <button
          onClick={(e) => {
            e.preventDefault()
            if (window.confirm(`确认删除项目「${project.name}」？`)) onDelete(project.id)
          }}
          className="absolute right-2 top-2 hidden size-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-red-600 group-hover:flex"
          title="删除项目"
        >
          <Trash2 size={14} />
        </button>
      )}
    </div>
  )
}
