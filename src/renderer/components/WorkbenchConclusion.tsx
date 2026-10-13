import { useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, ShieldCheck } from 'lucide-react'
import type { VerificationWorkbenchSnapshot } from '@shared/verification-workbench'
import { useTranslation, type MessageKey } from '../i18n'

/**
 * 验证结论卡（P1，2026-10-05）
 *
 * 只读展示工作台结论快照，作为「验证完成多少 / 证据是否仍有效 / 签核还缺什么」的单一入口。
 *
 * 三条展示纪律（对应"界面结论不可信"缺陷）：
 * 1. **记录通过**与**当前有效通过**分开呈现，历史通过不得冒充当前有效；
 * 2. 缺评估、缺版本、证据过期时明确显示"未确认"，绝不显示绿色就绪；
 * 3. 无可读态势时显示"尚未生成"，**不显示零值统计**——零值容易被误读成"已完成"。
 */

const ISSUE_KEYS: Record<VerificationWorkbenchSnapshot['issues'][number], MessageKey> = {
  'no-data': 'verification.workbench.issueNoData',
  'mapping-incomplete': 'verification.workbench.issueMappingIncomplete',
  'version-unknown': 'verification.workbench.issueVersionUnknown',
  'snapshot-stale': 'verification.workbench.issueSnapshotStale',
  'evidence-missing': 'verification.workbench.issueEvidenceMissing',
  'evidence-stale': 'verification.workbench.issueEvidenceStale',
  'evidence-unconfirmed': 'verification.workbench.issueEvidenceUnconfirmed',
  'evidence-newer': 'verification.workbench.issueEvidenceNewer'
}

const EVIDENCE_KEYS: Record<VerificationWorkbenchSnapshot['evidence']['status'], MessageKey> = {
  current: 'verification.workbench.evidenceCurrent',
  stale: 'verification.workbench.evidenceStale',
  missing: 'verification.workbench.evidenceMissing',
  unknown: 'verification.workbench.evidenceUnknown'
}

const SIGNOFF_KEYS: Record<VerificationWorkbenchSnapshot['signoff']['status'], MessageKey> = {
  'not-ready': 'verification.workbench.signoffNotReady',
  conditional: 'verification.workbench.signoffConditional',
  review: 'verification.workbench.signoffReview',
  unknown: 'verification.workbench.signoffUnknown'
}

/** 证据清单只显示前几条，避免长清单把结论挤出视野 */
const REF_PREVIEW_LIMIT = 3

function refs(list: string[]): string {
  const shown = list.slice(0, REF_PREVIEW_LIMIT)
  const more = list.length > REF_PREVIEW_LIMIT ? ` 等 ${list.length} 项` : ''
  return `${shown.join('、')}${more}`
}

export function WorkbenchConclusion({ snapshot }: { snapshot: VerificationWorkbenchSnapshot | null }): React.JSX.Element {
  const { t } = useTranslation()
  const [showClauses, setShowClauses] = useState(false)
  /** 结论卡默认折叠为一行摘要（把垂直空间还给工作区），展开后看完整证据与条款明细 */
  const [expanded, setExpanded] = useState(false)
  if (!snapshot) return <p className="mt-2 text-xs text-amber-700">{t('verification.workbench.unavailable')}</p>
  // 未规划或产物被清空：明确引导去规划，而不是展示一堆零值
  if (snapshot.issues.includes('no-data')) {
    return <div className="mt-3 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs leading-5 text-blue-800">
      <p className="font-semibold">{t('verification.workbench.title')}</p>
      <p>{t('verification.workbench.noPlan')}</p>
    </div>
  }
  const c = snapshot.clauses
  const value = (n: number | null): string => (n === null ? t('verification.workbench.unknown') : String(n))
  const metrics: Array<[MessageKey, string]> = [
    ['verification.workbench.clauseTotal', value(c.total)],
    ['verification.workbench.validPassed', String(c.validPassed)],
    ['verification.workbench.needsRevalidation', String(c.needsRevalidation)],
    ['verification.workbench.unmapped', String(c.unmapped)],
    ['verification.workbench.mappedUntested', String(c.mappedUntested)],
    ['verification.workbench.failed', String(c.failed)],
    ['verification.workbench.passed', String(c.passed)],
    ['verification.workbench.waived', String(c.waived)],
    ['verification.workbench.unknown', String(c.unknown)]
  ]
  const signoffTone = snapshot.signoff.status === 'not-ready' ? 'text-red-700'
    : snapshot.signoff.status === 'unknown' ? 'text-zinc-500' : 'text-amber-700'
  const evidenceTone = snapshot.evidence.status === 'current' ? 'text-emerald-700'
    : snapshot.evidence.status === 'unknown' ? 'text-zinc-500' : 'text-red-700'
  return <div className="mt-2 rounded border border-zinc-200 bg-white px-3 py-1.5">
    {/* 摘要行：签核状态 + 关键计数 + 证据状态，一行读完健康度 */}
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      <span className="text-xs font-medium text-zinc-700">{t('verification.workbench.title')}</span>
      {snapshot.source && <span className="text-[10px] text-zinc-400">{t('verification.workbench.source', { source: snapshot.source })}</span>}
      <span className="text-zinc-600">{t('verification.workbench.clauseTotal')} {value(c.total)}</span>
      <span className="font-semibold text-emerald-700">{t('verification.workbench.validPassed')} {c.validPassed}</span>
      {c.needsRevalidation > 0 && <span className="font-semibold text-amber-700">{t('verification.workbench.needsRevalidation')} {c.needsRevalidation}</span>}
      {c.mappedUntested > 0 && <span className="text-zinc-600">{t('verification.workbench.mappedUntested')} {c.mappedUntested}</span>}
      {c.failed > 0 && <span className="font-semibold text-red-700">{t('verification.workbench.failed')} {c.failed}</span>}
      <span className={evidenceTone}>{t(EVIDENCE_KEYS[snapshot.evidence.status])}</span>
      {snapshot.issues.length > 0 && snapshot.issues.map((issue) => (
        <span key={issue} className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">{t(ISSUE_KEYS[issue])}</span>
      ))}
      <span className={`ml-auto flex items-center gap-1 text-xs font-medium ${signoffTone}`}>
        {snapshot.signoff.status === 'review' || snapshot.signoff.status === 'conditional' ? <ShieldCheck size={13} /> : <AlertTriangle size={13} />}
        {t(SIGNOFF_KEYS[snapshot.signoff.status])}
        {snapshot.signoff.blockers.length > 0 && <span className="font-normal text-zinc-400">{t('verification.workbench.blockerCount', { count: snapshot.signoff.blockers.length })}</span>}
      </span>
      <button type="button" onClick={() => setExpanded((open) => !open)} className="inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-700">
        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {t(expanded ? 'verification.workbench.collapseCard' : 'verification.workbench.expandCard')}
      </button>
    </div>
    {expanded && <>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-100 pt-2 text-[11px] text-zinc-600">
        <span className="font-medium text-zinc-500">{t('verification.workbench.clausesTitle')}</span>
        {metrics.map(([key, text], index) => <span key={key} className={index === 1 ? 'font-semibold text-emerald-700' : index === 2 && c.needsRevalidation > 0 ? 'font-semibold text-amber-700' : ''}>
          {t(key)} {text}
        </span>)}
        {c.documentary !== null && <span>{t('verification.workbench.documentary')} {c.documentary}</span>}
        {c.synthesis > 0 && <span>{t('verification.workbench.synthesis')} {c.synthesis}</span>}
      </div>
      {c.total === null && <p className="mt-1 text-[10px] text-amber-700">{t('verification.workbench.denominatorUnreliable')}</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
        <span className="font-medium text-zinc-500">{t('verification.workbench.evidenceTitle')}</span>
        <span className={evidenceTone}>{t(EVIDENCE_KEYS[snapshot.evidence.status])}</span>
        {snapshot.evidence.missing.length > 0 && <span className="text-red-700">{t('verification.workbench.evidenceMissingList', { list: refs(snapshot.evidence.missing) })}</span>}
        {snapshot.evidence.stale.length > 0 && <span className="text-amber-700">{t('verification.workbench.evidenceStaleList', { list: refs(snapshot.evidence.stale) })}</span>}
      </div>
      {(snapshot.clauseDetails?.length ?? 0) > 0 && <>
        <button type="button" onClick={() => setShowClauses((open) => !open)} className="mt-2 inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-700">
          {showClauses ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          {t(showClauses ? 'verification.workbench.hideDetails' : 'verification.workbench.showDetails')}
        </button>
        {showClauses && <div className="mt-1.5 max-h-64 overflow-y-auto rounded border border-zinc-100">
          {snapshot.clauseDetails?.map((clause) => <div key={`${clause.id ?? 'unknown'}`} className="flex items-start gap-2 border-b border-zinc-100 px-2 py-1 text-[10px] last:border-b-0">
            <span className="w-40 shrink-0 truncate font-mono text-zinc-500" title={clause.id ?? ''}>{clause.id ?? '—'}</span>
            <span className={`shrink-0 ${clause.status === 'passed' && clause.validPassed ? 'text-emerald-700' : clause.status === 'failed' ? 'text-red-700' : 'text-zinc-500'}`}>
              {t(clause.status === 'passed' ? (clause.validPassed ? 'verification.workbench.validPassed' : 'verification.workbench.needsRevalidation')
                : clause.status === 'unmapped' ? 'verification.workbench.unmapped'
                  : clause.status === 'mappedUntested' ? 'verification.workbench.mappedUntested'
                    : clause.status === 'failed' ? 'verification.workbench.failed'
                      : clause.status === 'waived' ? 'verification.workbench.waived' : 'verification.workbench.unknown')}
            </span>
            <span className="min-w-0 flex-1 text-zinc-600">{clause.text ?? ''}</span>
          </div>)}
        </div>}
      </>}
    </>}
  </div>
}
