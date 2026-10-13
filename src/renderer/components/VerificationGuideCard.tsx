/**
 * 验证向导卡（VerificationGuideCard）
 *
 * 把 deriveVerificationActions 的 actions[0] 从"列表第一项"升级为引导式呈现：
 * 当前目标（当前波段一句话目标）→ 进展（波段步骤计数）→ 主行动大按钮
 * （title + "为什么现在做这个" + 预期产出）→ 次要行动折叠 → 专家操作折叠。
 * 推导规则保持 verification-guidance 不变；执行中态由 chatStore streaming 驱动，
 * 态势自动刷新后向导卡自然切到下一步。
 */

import { useState } from 'react'
import { ChevronDown, ChevronRight, Play, RefreshCw } from 'lucide-react'
import type { VerificationAction, VerificationStep } from '../verification-guidance'
import { useTranslation, type MessageKey } from '../i18n'

/** 当前目标一句话：按当前步骤 id 映射（旧线性步骤与未知 id 回退通用句） */
const GOAL_KEYS: Record<string, MessageKey> = {
  W1: 'verification.guide.goalW1',
  W2: 'verification.guide.goalW2',
  W3: 'verification.guide.goalW3'
}

/** 预期产出：按行动 id 映射（与 deriveVerificationActions 的 action.id 一一对应）；未知 id 回退通用句 */
const OUTCOME_KEYS: Record<string, MessageKey> = {
  'wave-w1': 'verification.guide.outcomes.wave-w1',
  'wave-w2': 'verification.guide.outcomes.wave-w2',
  'wave-w3': 'verification.guide.outcomes.wave-w3',
  'clarify-spec': 'verification.guide.outcomes.clarify-spec',
  'clarify-spec-docs': 'verification.guide.outcomes.clarify-spec-docs',
  'fix-regressions': 'verification.guide.outcomes.fix-regressions',
  'fix-formal': 'verification.guide.outcomes.fix-formal',
  'add-checkers': 'verification.guide.outcomes.add-checkers',
  'run-batch': 'verification.guide.outcomes.run-batch',
  'refresh-change-impact': 'verification.guide.outcomes.refresh-change-impact',
  'resolve-oracle-conflicts': 'verification.guide.outcomes.resolve-oracle-conflicts',
  'complete-oracle-evidence': 'verification.guide.outcomes.complete-oracle-evidence',
  'escape-exploration-stall': 'verification.guide.outcomes.escape-exploration-stall',
  'run-risk-mutation': 'verification.guide.outcomes.run-risk-mutation',
  'resolve-residual-risks': 'verification.guide.outcomes.resolve-residual-risks',
  'repair-formal-compatibility': 'verification.guide.outcomes.repair-formal-compatibility',
  'continue-closure': 'verification.guide.outcomes.continue-closure',
  'signoff-review': 'verification.guide.outcomes.signoff-review'
}

interface VerificationGuideCardProps {
  steps: VerificationStep[]
  actions: VerificationAction[]
  /** chatStore.streaming：执行中禁用按钮并显示执行中指示 */
  streaming: boolean
  onAction: (prompt: string) => void
  /** 专家操作区内容（波段按钮组）与折叠标题，由调用方注入以保持 prompt 与发送逻辑不变 */
  expertActions?: React.ReactNode
  expertLabel?: string
  expertHint?: string
}

export function VerificationGuideCard({ steps, actions, streaming, onAction, expertActions, expertLabel, expertHint }: VerificationGuideCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [othersOpen, setOthersOpen] = useState(false)
  const [expertOpen, setExpertOpen] = useState(false)
  const primary = actions[0]
  const secondary = actions.slice(1)
  // 当前步推导与 VerifStatusBar 原口径一致：阻断优先，其次进行中，最后取末步
  const current = steps.find((step) => step.status === 'blocked') ?? steps.find((step) => step.status === 'running') ?? steps.at(-1)
  const goalKey = current ? GOAL_KEYS[current.id] : undefined
  const goal = goalKey ? t(goalKey) : t('verification.guide.goalFallback')
  const outcomeKey = primary ? OUTCOME_KEYS[primary.id] : undefined
  const outcome = outcomeKey ? t(outcomeKey) : t('verification.guide.outcomeDefault')
  // 紧凑态：单行状态带（目标截断 + 主行动右置 + 次要/专家折叠），把垂直空间还给工作区
  return <div className="mt-2 rounded border border-zinc-200 bg-white px-3 py-1.5">
    <div className="flex items-center gap-3">
      <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-zinc-400">{t('verification.guide.goalLabel')}</span>
      <span className="min-w-0 truncate text-xs font-medium text-zinc-800" title={current ? `${current.label} · ${goal}\n${current.detail ?? ''}` : goal}>{current ? `${current.label} · ${goal}` : goal}</span>
      {current?.detail && <span className="min-w-0 shrink truncate text-[11px] text-zinc-500" title={current.title ?? current.detail}>{current.detail}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {primary ? (
          <button
            type="button"
            disabled={streaming}
            onClick={() => onAction(primary.prompt)}
            title={`${primary.detail}\n${t('verification.guide.expectedLabel')}${outcome}`}
            className="flex items-center gap-1.5 rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50"
          >
            <Play size={12} />{primary.title}
          </button>
        ) : <span className="text-[11px] text-zinc-400">{t('verification.guide.noAction')}</span>}
        {secondary.length > 0 && (
          <button type="button" onClick={() => setOthersOpen((value) => !value)} className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-800">
            {othersOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{t('verification.guide.otherActions', { count: secondary.length })}
          </button>
        )}
        {expertActions && (
          <button type="button" onClick={() => setExpertOpen((value) => !value)} title={expertHint} className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-800">
            {expertOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{expertLabel}
          </button>
        )}
      </span>
    </div>
    {streaming && <div className="mt-1.5 flex items-center gap-1.5 border-t border-zinc-100 pt-1.5 text-[11px] text-amber-700"><RefreshCw size={11} className="animate-spin" />{t('verification.guide.running')}</div>}
    {othersOpen && secondary.length > 0 && <div className="mt-1.5 grid grid-cols-2 gap-1 border-t border-zinc-100 pt-1.5">
      {secondary.map((action) => <button key={action.id} type="button" disabled={streaming} onClick={() => onAction(action.prompt)} title={action.detail} className="flex items-center gap-2 rounded border border-zinc-200 px-2 py-1 text-left text-[11px] text-zinc-700 hover:border-zinc-400 hover:bg-zinc-50 disabled:opacity-50">
        <span className={`shrink-0 px-1 text-[9px] font-semibold ${action.priority === 'P0' ? 'bg-red-100 text-red-700' : action.priority === 'P1' ? 'bg-amber-100 text-amber-700' : 'bg-zinc-100 text-zinc-600'}`}>{action.priority}</span>
        <span className="min-w-0 flex-1 truncate">{action.title}</span>
      </button>)}
    </div>}
    {expertOpen && expertActions && <div className="mt-1.5 border-t border-zinc-100 pt-1.5">{expertActions}</div>}
  </div>
}
