/**
 * 阶段看板（规格书 §5.4）
 *
 * 7 个阶段节点横向排列，四态样式：
 *   locked(灰) / active(蓝) / completed(绿) / blocked(红)
 * 推进/回退按钮 + 门禁检查结果展示（Phase 3：Error 级失败阻断推进）。
 */

import {
  PHASE_LABELS,
  PHASE_ORDER,
  type ChipProject,
  type GateCheckResult,
  type Phase,
  type PhaseStatus
} from '@shared/types'

const STATUS_STYLES: Record<PhaseStatus, string> = {
  locked: 'border-zinc-300 bg-zinc-100 text-zinc-400',
  active: 'border-blue-500 bg-blue-50 text-blue-700',
  completed: 'border-emerald-500 bg-emerald-50 text-emerald-700',
  blocked: 'border-red-500 bg-red-50 text-red-700',
  skipped: 'border-amber-400 bg-amber-50 text-amber-700'
}

const STATUS_DOTS: Record<PhaseStatus, string> = {
  locked: 'bg-zinc-400',
  active: 'bg-blue-500',
  completed: 'bg-emerald-500',
  blocked: 'bg-red-500',
  skipped: 'bg-amber-500'
}

export interface GatePanelData {
  blocked: boolean
  results: GateCheckResult[]
}

interface PhaseBoardProps {
  project: ChipProject
  onAdvance?: (to: Phase) => void
  onRollback?: (to: Phase) => void
  onFastTrackSynthesis?: () => void
  onCompleteProject?: () => void
  /** 最近一次推进尝试的门禁结果（含被阻断的情况） */
  gate?: GatePanelData | null
}

export function PhaseBoard({
  project,
  onAdvance,
  onRollback,
  onFastTrackSynthesis,
  onCompleteProject,
  gate
}: PhaseBoardProps): React.JSX.Element {
  const currentIdx = PHASE_ORDER.indexOf(project.currentPhase)
  const nextPhase = PHASE_ORDER[currentIdx + 1] as Phase | undefined
  const prevPhase = PHASE_ORDER[currentIdx - 1] as Phase | undefined

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        {PHASE_ORDER.map((phase, idx) => {
          const status = project.phases[phase].status
          const isCurrent = phase === project.currentPhase
          const unresolved = project.phases[phase].gateCheckResults.filter((result) => !result.passed)
          return (
            <div key={phase} className="flex items-center gap-1">
              {idx > 0 && <span className="text-zinc-400">→</span>}
              <div
                title={`${PHASE_LABELS[phase]} — ${status}\n交付物: ${project.phases[phase].deliverables.length} 项`}
                className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors ${STATUS_STYLES[status]} ${
                  isCurrent ? `ring-1 ${status === 'completed' ? 'ring-emerald-400' : 'ring-blue-400'}` : ''
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${STATUS_DOTS[status]}`} />
                <span className="font-medium">{phase}</span>
                <span className="text-xs opacity-70">{PHASE_LABELS[phase]}</span>
                {unresolved.length > 0 && (
                  <span className="group/issues relative">
                    <button
                      type="button"
                      aria-label={`${PHASE_LABELS[phase]}有 ${unresolved.length} 项遗留问题`}
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-600 text-[11px] font-bold leading-none text-white outline-none ring-red-300 focus:ring-2"
                    >
                      !
                    </button>
                    <span
                      role="tooltip"
                      className={`pointer-events-none invisible absolute top-full z-50 w-96 max-w-[calc(100vw-2rem)] pt-2 opacity-0 transition-opacity group-hover/issues:pointer-events-auto group-hover/issues:visible group-hover/issues:opacity-100 group-focus-within/issues:pointer-events-auto group-focus-within/issues:visible group-focus-within/issues:opacity-100 ${
                        idx < PHASE_ORDER.length / 2 ? 'left-0' : 'right-0'
                      }`}
                    >
                      <span className="block max-h-72 overflow-auto rounded-md border border-red-200 bg-white p-3 text-left text-xs text-zinc-700 shadow-lg select-text">
                        <span className="mb-2 block font-semibold text-red-700">
                          {PHASE_LABELS[phase]}遗留问题（{unresolved.length}）
                        </span>
                        <span className="block space-y-2">
                          {unresolved.map((result) => (
                            <span key={result.checkId} className="block border-l-2 border-red-400 pl-2">
                              <span className="block font-medium text-zinc-900">{result.checkName}</span>
                              <span className="mt-0.5 block whitespace-pre-wrap leading-5">{result.message}</span>
                            </span>
                          ))}
                        </span>
                        <span className="mt-2 block border-t border-zinc-100 pt-2 text-zinc-400">
                          浮层内文字可选择；点击感叹号可保持显示。
                        </span>
                      </span>
                    </span>
                  </span>
                )}
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
        {project.currentPhase === 'RTL' && onFastTrackSynthesis && (
          <button
            onClick={onFastTrackSynthesis}
            className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-700 hover:bg-amber-100"
          >
            跳过 VERIF/QA，快速评估面积
          </button>
        )}
        {project.currentPhase === 'SYNTH' &&
          project.phases.SYNTH.status === 'active' &&
          onCompleteProject && (
            <button
              onClick={onCompleteProject}
              className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 font-medium text-emerald-700 hover:bg-emerald-100"
            >
              完成综合并结束项目
            </button>
          )}
        {project.phases.SYNTH.status === 'completed' && (
          <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 font-medium text-emerald-700">
            项目已完成
          </span>
        )}
      </div>

      {gate && gate.results.length > 0 && (
        <div
          className={`rounded-md border px-3 py-2 text-xs ${
            gate.blocked ? 'border-red-300 bg-red-50' : 'border-zinc-200 bg-zinc-50'
          }`}
        >
          {gate.blocked && (
            <p className="mb-1 font-medium text-red-700">门禁未通过，已阻止推进。修复后请重试。</p>
          )}
          {!gate.blocked && gate.results.some((result) => !result.passed) && (
            <p className="mb-1 font-medium text-amber-700">已允许推进，以下问题已记录为遗留事项。</p>
          )}
          <ul className="space-y-0.5">
            {gate.results.map((r) => (
              <li key={r.checkId} className="flex gap-1.5">
                <span className="shrink-0">
                  {r.severity === 'info' ? '○' : r.passed ? '✓' : '✗'}
                </span>
                <span
                  className={`whitespace-pre-wrap ${
                    r.severity === 'error' && !r.passed
                      ? 'text-red-700'
                      : r.severity === 'warning' && !r.passed
                        ? 'text-amber-700'
                      : r.severity === 'info'
                        ? 'text-zinc-500'
                        : 'text-emerald-700'
                  }`}
                >
                  {r.checkName} — {r.message}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
