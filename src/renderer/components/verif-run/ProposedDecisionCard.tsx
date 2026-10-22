/**
 * 循环决策请示卡（VERIF-RUN-LOOP 批 3/批 4，设计文档 §3.2/§7.1）。
 *
 * 渲染 decision-ledger 中 status='proposed' 的提案。决策语言人性化改版
 * （DECISION-LANGUAGE-UI-GUIDANCE）：humanSummary（IP 行为语言的工程师摘要）为
 * 主视觉完整显示；rationale/prompt/预期产出/停止条件/证据数收进「技术细节」折叠区
 * （默认收起）；旧提案无 humanSummary 时回退 rationale 主视觉。批准与否决经集成方
 * 回调走 `agent:decide-verif-run-decision` IPC，供 RunLoopCard（验证运行页签）与
 * ChatPanel（会话底部集中请示区）两处复用。
 */

import { useState } from 'react'
import { Check, ChevronDown, ChevronRight, X } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { formatVerifTimestamp, type VerifRunDecisionEntryView, type VerifRunDecisionSource } from './types'

/** 决策来源徽标（规则=蓝 / LLM=紫 / 人工=绿，§7.1 动作来源徽标同口径） */
export const DECISION_SOURCE_META: Record<VerifRunDecisionSource, { labelKey: 'verifRun.loop.source.rule' | 'verifRun.loop.source.llm' | 'verifRun.loop.source.human'; cls: string }> = {
  rule: { labelKey: 'verifRun.loop.source.rule', cls: 'bg-sky-100 text-sky-700' },
  llm: { labelKey: 'verifRun.loop.source.llm', cls: 'bg-violet-100 text-violet-700' },
  human: { labelKey: 'verifRun.loop.source.human', cls: 'bg-emerald-100 text-emerald-700' }
}

export interface ProposedDecisionCardProps {
  decision: VerifRunDecisionEntryView
  onDecide: (decisionId: string, verdict: 'approved' | 'rejected') => Promise<void>
}

/** 决策请示卡片（status='proposed'）：humanSummary 主视觉 + 技术细节折叠 + 批准否决。 */
export function ProposedDecisionCard({ decision, onDecide }: ProposedDecisionCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const source = DECISION_SOURCE_META[decision.source]
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
    {/* 主视觉：humanSummary（IP 行为语言，完整显示不截断）；旧提案回退 rationale */}
    <div className="mt-1.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400">{t('verifRun.loop.humanSummary')}</div>
    <p className="mt-0.5 text-xs leading-5 text-zinc-800">{decision.humanSummary || decision.rationale}</p>
    {/* 技术细节折叠区（默认收起）：有 humanSummary 时 rationale 也收进来 */}
    <button
      type="button"
      onClick={() => setDetailsOpen((open) => !open)}
      aria-expanded={detailsOpen}
      className="mt-1.5 inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-800"
    >
      {detailsOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{t('verifRun.loop.techDetails')}
    </button>
    {detailsOpen && <div className="mt-1.5 space-y-1 border-t border-violet-100 pt-2">
      {decision.humanSummary && decision.rationale && <p className="text-[11px] leading-4 text-zinc-600">{t('verifRun.loop.rationaleLabel')}：{decision.rationale}</p>}
      {decision.action.prompt && <p className="font-mono text-[10px] text-zinc-500">{t('verifRun.loop.promptLabel')}：{decision.action.prompt}</p>}
      <div className="grid gap-x-4 gap-y-0.5 text-[11px] text-zinc-600 sm:grid-cols-2">
        {decision.action.expectedOutput && <span>{t('verifRun.loop.expectedLabel')}：{decision.action.expectedOutput}</span>}
        {decision.action.stopCriteria && <span>{t('verifRun.loop.stopCriteriaLabel')}：{decision.action.stopCriteria}</span>}
      </div>
      <span className="block text-[10px] text-zinc-400">{t('verifRun.loop.evidenceCount', { count: decision.evidenceRefs.length })}</span>
    </div>}
    <div className="mt-2 flex items-center gap-2">
      {!detailsOpen && <span className="text-[10px] text-zinc-400">{t('verifRun.loop.evidenceCount', { count: decision.evidenceRefs.length })}</span>}
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
