/**
 * 阶段看板（规格书 §5.4）
 *
 * 7 个阶段节点横向排列，四态样式：
 *   locked(灰) / active(蓝) / completed(绿) / blocked(红)
 * 骨架阶段：展示状态 + 推进/回退按钮，门禁提示悬停展示。
 */

import { PHASE_LABELS, PHASE_ORDER, type ChipProject, type Phase, type PhaseStatus } from '@shared/types'

const STATUS_STYLES: Record<PhaseStatus, string> = {
  locked: 'border-zinc-300 bg-zinc-100 text-zinc-400',
  active: 'border-blue-500 bg-blue-50 text-blue-700',
  completed: 'border-emerald-500 bg-emerald-50 text-emerald-700',
  blocked: 'border-red-500 bg-red-50 text-red-700'
}

const STATUS_DOTS: Record<PhaseStatus, string> = {
  locked: 'bg-zinc-400',
  active: 'bg-blue-500',
  completed: 'bg-emerald-500',
  blocked: 'bg-red-500'
}

interface PhaseBoardProps {
  project: ChipProject
  onAdvance?: (to: Phase) => void
  onRollback?: (to: Phase) => void
}

export function PhaseBoard({ project, onAdvance, onRollback }: PhaseBoardProps): React.JSX.Element {
  const currentIdx = PHASE_ORDER.indexOf(project.currentPhase)
  const nextPhase = PHASE_ORDER[currentIdx + 1] as Phase | undefined
  const prevPhase = PHASE_ORDER[currentIdx - 1] as Phase | undefined

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        {PHASE_ORDER.map((phase, idx) => {
          const status = project.phases[phase].status
          const isCurrent = phase === project.currentPhase
          return (
            <div key={phase} className="flex items-center gap-1">
              {idx > 0 && <span className="text-zinc-400">→</span>}
              <div
                title={`${PHASE_LABELS[phase]} — ${status}\n交付物: ${project.phases[phase].deliverables.length} 项`}
                className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors ${STATUS_STYLES[status]} ${
                  isCurrent ? 'ring-1 ring-blue-400' : ''
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${STATUS_DOTS[status]}`} />
                <span className="font-medium">{phase}</span>
                <span className="text-xs opacity-70">{PHASE_LABELS[phase]}</span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex gap-2 text-xs">
        {nextPhase && onAdvance && (
          <button
            onClick={() => onAdvance(nextPhase)}
            className="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-blue-700 hover:bg-blue-100"
          >
            推进到 {nextPhase} →
          </button>
        )}
        {prevPhase && onRollback && (
          <button
            onClick={() => onRollback(prevPhase)}
            className="rounded border border-zinc-300 bg-zinc-100 px-2 py-1 text-zinc-600 hover:bg-zinc-200"
          >
            ← 回退到 {prevPhase}
          </button>
        )}
      </div>
    </div>
  )
}
