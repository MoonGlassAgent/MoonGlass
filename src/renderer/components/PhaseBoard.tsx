/**
 * 阶段看板（规格书 §5.4）
 *
 * 6 个阶段节点横向排列，阶段节点支持双击进入；上游变更会在后续阶段显示黄色感叹号。
 *   locked(灰) / active(蓝) / completed(绿) / blocked(红) / change-pending(黄)
 * 推进/回退按钮 + 门禁检查结果展示（Phase 3：Error 级失败阻断推进）。
 */

import {
  PHASE_ORDER,
  type ChipProject,
  type GateCheckResult,
  type Phase,
  type PhaseStatus
} from '@shared/types'
import { RotateCcw, Trash2 } from 'lucide-react'
import { useTranslation, phaseLabel } from '../i18n'

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
  /** true 表示门禁未全过但用户确认强制推进 */
  forced?: boolean
}

interface PhaseBoardProps {
  project: ChipProject
  onEnterPhase?: (to: Phase) => void
  onAdvance?: (to: Phase) => void
  onRollback?: (to: Phase) => void
  onFastTrackSynthesis?: () => void
  onCompleteProject?: () => void
  onFixGateIssues?: (phase: Phase, results: GateCheckResult[]) => void
  onRespondChange?: (phase: Phase) => void
  onResetPhase?: (phase: Phase, mode: 'archive' | 'purge') => void
  /** 切走后仍有 Agent 在后台执行的阶段（显示运行标记） */
  backgroundRunningPhases?: Phase[]
  /** 最近一次推进尝试的门禁结果（含被阻断的情况） */
  gate?: GatePanelData | null
}

export function PhaseBoard({
  project,
  onEnterPhase,
  onAdvance,
  onRollback,
  onFastTrackSynthesis,
  onCompleteProject,
  onFixGateIssues,
  onRespondChange,
  onResetPhase,
  backgroundRunningPhases,
  gate
}: PhaseBoardProps): React.JSX.Element {
  const { t } = useTranslation()
  const currentIdx = PHASE_ORDER.indexOf(project.currentPhase)
  const nextPhase = PHASE_ORDER[currentIdx + 1] as Phase | undefined
  const prevPhase = PHASE_ORDER[currentIdx - 1] as Phase | undefined

  return (
    <div className="relative z-40 flex flex-col gap-2">
      <div className="flex items-center gap-1">
        {PHASE_ORDER.map((phase, idx) => {
          const phaseState = project.phases[phase]
          const status = phaseState.status
          const isCurrent = phase === project.currentPhase
          const unresolved = phaseState.gateCheckResults.filter((result) => !result.passed)
          const changePending = phaseState.changeNotice?.status === 'pending'
          const changeNotice = phaseState.changeNotice
          return (
            <div key={phase} className="flex items-center gap-1">
              {idx > 0 && <span className="text-zinc-400">→</span>}
              <div
                title={t('phaseBoard.nodeTitle', { phase: phaseLabel(phase), status, count: phaseState.deliverables.length })}
                onDoubleClick={() => onEnterPhase?.(phase)}
                className={`group flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  changePending ? 'border-yellow-400 bg-yellow-50 text-yellow-800' : STATUS_STYLES[status]
                } ${
                  isCurrent ? `ring-1 ${status === 'completed' ? 'ring-emerald-400' : 'ring-blue-400'}` : ''
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${changePending ? 'bg-yellow-500' : STATUS_DOTS[status]}`} />
                <span className="font-medium">{phase}</span>
                <span className="text-xs opacity-70">{phaseLabel(phase)}</span>
                {backgroundRunningPhases?.includes(phase) && (
                  <span
                    title={t('phaseBoard.backgroundRunningTitle', { phase: phaseLabel(phase) })}
                    aria-label={t('phaseBoard.backgroundRunningAria', { phase: phaseLabel(phase) })}
                    className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-blue-500"
                  />
                )}
                {changePending && changeNotice && (
                  <button
                    type="button"
                    aria-label={t('phaseBoard.changePendingAria', { phase: phaseLabel(phase), source: phaseLabel(changeNotice.sourcePhase) })}
                    title={t('phaseBoard.changePendingTitle', { source: phaseLabel(changeNotice.sourcePhase), reason: changeNotice.reason })}
                    onClick={(event) => {
                      event.stopPropagation()
                      onRespondChange?.(phase)
                    }}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-yellow-400 text-[11px] font-bold leading-none text-yellow-950 outline-none ring-yellow-500 focus:ring-2"
                  >
                    !
                  </button>
                )}
                {unresolved.length > 0 && (
                  <span className="group/issues relative">
                    <button
                      type="button"
                      aria-label={t('phaseBoard.issuesAria', { phase: phaseLabel(phase), count: unresolved.length })}
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-600 text-[11px] font-bold leading-none text-white outline-none ring-red-300 focus:ring-2"
                    >
                      !
                    </button>
                    <span
                      role="tooltip"
                      className={`pointer-events-none invisible absolute top-full z-[100] w-96 max-w-[calc(100vw-2rem)] pt-2 opacity-0 transition-opacity group-hover/issues:pointer-events-auto group-hover/issues:visible group-hover/issues:opacity-100 group-focus-within/issues:pointer-events-auto group-focus-within/issues:visible group-focus-within/issues:opacity-100 ${
                        idx < PHASE_ORDER.length / 2 ? 'left-0' : 'right-0'
                      }`}
                    >
                      <span className="block max-h-72 overflow-auto rounded-md border border-red-200 bg-white p-3 text-left text-xs text-zinc-700 shadow-lg select-text">
                        <span className="mb-2 block font-semibold text-red-700">
                          {t('phaseBoard.issuesTitle', { phase: phaseLabel(phase), count: unresolved.length })}
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
                          {t('phaseBoard.issuesHint')}
                        </span>
                        {onFixGateIssues && (
                          <button
                            type="button"
                            onClick={() => onFixGateIssues(phase, unresolved)}
                            className="mt-2 rounded border border-red-300 bg-red-50 px-2 py-1 font-medium text-red-700 hover:bg-red-100"
                          >
                            {t('phaseBoard.fixInChat')}
                          </button>
                        )}
                      </span>
                    </span>
                  </span>
                )}
                {onResetPhase && (
                  <span className="ml-1 hidden items-center gap-0.5 group-hover:flex">
                    <button type="button" title={t('phaseBoard.resetArchiveTitle')} aria-label={t('phaseBoard.resetArchiveAria')} onClick={(event) => { event.stopPropagation(); onResetPhase(phase, 'archive') }} className="rounded p-0.5 hover:bg-black/10"><RotateCcw size={13} /></button>
                    <button type="button" title={t('phaseBoard.resetPurgeTitle')} aria-label={t('phaseBoard.resetPurgeAria')} onClick={(event) => { event.stopPropagation(); onResetPhase(phase, 'purge') }} className="rounded p-0.5 text-red-600 hover:bg-red-100"><Trash2 size={13} /></button>
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
            {t('phaseBoard.advanceTo', { phase: nextPhase })}
          </button>
        )}
        {prevPhase && onRollback && (
          <button
            onClick={() => onRollback(prevPhase)}
            className="rounded border border-zinc-300 bg-zinc-100 px-2 py-1 text-zinc-600 hover:bg-zinc-200"
          >
            {t('phaseBoard.rollbackTo', { phase: prevPhase })}
          </button>
        )}
        {project.currentPhase === 'RTL' && onFastTrackSynthesis && (
          <button
            onClick={onFastTrackSynthesis}
            className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-700 hover:bg-amber-100"
          >
            {t('phaseBoard.fastTrackSynthesis')}
          </button>
        )}
        {project.currentPhase === 'SYNTH' &&
          project.phases.SYNTH.status === 'active' &&
          onCompleteProject && (
            <button
              onClick={onCompleteProject}
              className="rounded border border-emerald-300 bg-emerald-50 px-2 py-1 font-medium text-emerald-700 hover:bg-emerald-100"
            >
              {t('phaseBoard.completeProject')}
            </button>
          )}
        {project.phases.SYNTH.status === 'completed' && (
          <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1 font-medium text-emerald-700">
            {t('phaseBoard.projectCompleted')}
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
            <p className="mb-1 font-medium text-red-700">
              {t('phaseBoard.gateBlocked')}
            </p>
          )}
          {!gate.blocked && gate.forced && gate.results.some((result) => !result.passed) && (
            <p className="mb-1 font-medium text-amber-700">
              {t('phaseBoard.gateForced')}
            </p>
          )}
          {!gate.blocked && !gate.forced && gate.results.some((result) => !result.passed) && (
            <p className="mb-1 font-medium text-amber-700">{t('phaseBoard.gateAllowed')}</p>
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
          {gate.results.some((result) => !result.passed) && onFixGateIssues && (
            <button
              type="button"
              onClick={() =>
                onFixGateIssues(
                  project.currentPhase,
                  gate.results.filter((result) => !result.passed)
                )
              }
              className="mt-2 rounded border border-red-300 bg-white px-2 py-1 font-medium text-red-700 hover:bg-red-100"
            >
              {t('phaseBoard.fixInChat')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
