/**
 * 验证运行面板（方案 C 批 2，设计文档 §4.1）。
 *
 * 两张卡：
 * - 批次进度卡：循环状态徽标 + 当前批（第 n 批 · 场景列表 · phase）+ 等修复暂停提示 +
 *   熔断原因结构化展示（含"在对话中继续"）+ 历史批次绿/红列表 + 空态（"开始基础验证"）。
 * - 修复卡列表：修复窗口进行中卡（脉冲）+ 每条修复判定一张卡（FIXED 绿 / STILL_FAIL 红 /
 *   UNKNOWN 灰 + 判定依据；L2 展开审计 diff 统计与写保护拦截次数；STILL_FAIL/UNKNOWN 带
 *   "继续诊断"按钮，UNKNOWN 另带"去重跑回归"按钮）。
 *
 * 纯数据 + 回调组件：不自己发 IPC，数据由集成方读取落盘 JSON 并经 types.ts 归一化后传入。
 */

import { useMemo, useRef } from 'react'
import { CheckCircle2, Hammer, ListTree, MessageSquare, Play, Wrench, XCircle } from 'lucide-react'
import { useTranslation, type MessageKey } from '../../i18n'
import {
  formatVerifTimestamp,
  type RootCauseRecordView,
  type RtlFixAuditView,
  type RtlFixInProgressView,
  type RtlFixJudgment,
  type RtlFixOutcomeView,
  type VerifBatchLoopView,
  type VerifLoopState,
  type VerifScenarioLabelView
} from './types'

export interface VerifRunPanelProps {
  /** 批次循环状态（verif-batch-loop.json 归一化结果；null=无循环记录/未加载 → 空态） */
  batchLoop: VerifBatchLoopView | null
  /** 修复判定账本 outcomes（rtl-fix-outcomes.json，新记录在前） */
  fixOutcomes: RtlFixOutcomeView[]
  /** 修复窗口标志（rtl-fix-in-progress.json；null=当前无修复窗口） */
  fixInProgress: RtlFixInProgressView | null
  /** 根因记录（root-causes.json records；修复卡按 rootCauseId 联查一句话根因与修复指令） */
  rootCauses: RootCauseRecordView[]
  /** 已加载的修复窗口审计（rtl-fix-audit-<RC>.json，按 rootCauseId 索引） */
  fixAudits?: Record<string, RtlFixAuditView | null>
  /** L2 展开且审计未加载时回调（集成方读取 auditPath 后回填 fixAudits） */
  onLoadFixAudit?: (rootCauseId: string, auditPath: string) => void
  /** 批次空态"开始基础验证"按钮（沿用现有波段 prompt，由集成方发送） */
  onStartBasicVerification?: () => void
  /** 熔断卡"在对话中继续"按钮（集成方把熔断原因与建议动作拼成 prompt 发给阶段会话） */
  onContinueInChat?: (breaker: { reason: string; detail: string }) => void
  /** STILL_FAIL/UNKNOWN 修复卡"继续诊断"按钮（引导回诊断循环开新假设链） */
  onContinueDiagnosis?: (outcome: RtlFixOutcomeView) => void
  /** UNKNOWN 修复卡"去重跑回归"按钮 */
  onRerunRegression?: (outcome: RtlFixOutcomeView) => void
}

/** 循环状态徽标配色（蓝=进行、琥珀=等待、红=熔断、绿=闭环、灰=空闲/停止） */
const LOOP_STATE_META: Record<VerifLoopState, { labelKey: MessageKey; cls: string }> = {
  idle: { labelKey: 'verifRun.batch.state.idle', cls: 'bg-zinc-100 text-zinc-600' },
  running: { labelKey: 'verifRun.batch.state.running', cls: 'bg-sky-100 text-sky-700' },
  'awaiting-rtl-fix': { labelKey: 'verifRun.batch.state.awaiting-rtl-fix', cls: 'bg-amber-100 text-amber-700' },
  'circuit-broken': { labelKey: 'verifRun.batch.state.circuit-broken', cls: 'bg-red-100 text-red-700' },
  completed: { labelKey: 'verifRun.batch.state.completed', cls: 'bg-emerald-100 text-emerald-700' },
  stopped: { labelKey: 'verifRun.batch.state.stopped', cls: 'bg-zinc-100 text-zinc-600' }
}

/** 修复判定徽标配色（FIXED 绿 / STILL_FAIL 红 / UNKNOWN 灰） */
const JUDGMENT_META: Record<RtlFixJudgment, { labelKey: MessageKey; cls: string }> = {
  FIXED: { labelKey: 'verifRun.fix.judgment.FIXED', cls: 'bg-emerald-100 text-emerald-700' },
  STILL_FAIL: { labelKey: 'verifRun.fix.judgment.STILL_FAIL', cls: 'bg-red-100 text-red-700' },
  UNKNOWN: { labelKey: 'verifRun.fix.judgment.UNKNOWN', cls: 'bg-zinc-100 text-zinc-600' }
}

/**
 * 批次场景的语义标签列表（可读性，2026-10-05）：把 `SCN-XXXXXXXX` 换成人能读懂的一句话。
 *
 * 口径：标签是**派发时快照**（主进程随账本落盘），因此这里只显示快照本身，
 * 绝不用当前注册表回填历史批次的语义——旧账本缺快照时明确说明并只显示场景 ID。
 */
function ScenarioLabelList({ labels, scenarioIds }: {
  labels?: VerifScenarioLabelView[]
  scenarioIds: string[]
}): React.JSX.Element {
  const { t } = useTranslation()
  if (!labels?.length) return <div className="mt-1.5 rounded border border-dashed border-zinc-200 px-2 py-1">
    <div className="text-[11px] text-amber-700">{t('verifRun.batch.legacyNoLabels')}</div>
    <div className="mt-0.5 font-mono text-[11px] text-zinc-500">{scenarioIds.join(' / ') || '—'}</div>
  </div>
  return <ul className="mt-1.5 space-y-0.5">
    {labels.map((label) => <li key={label.id} className="flex items-baseline gap-2">
      <span className="min-w-0 flex-1 text-xs text-zinc-700">{label.title || <span className="text-zinc-400">{t('verifRun.batch.scenarioUntitled')}</span>}</span>
      {/* 标题已含条款 ID 时不再重复挂 chip（CLAUSE_DERIVED 的标题形如「基础功能（REQ-X#a）：…」） */}
      {label.requirementIds.filter((id) => !label.title.includes(id)).map((id) => (
        <span key={id} className="shrink-0 rounded bg-zinc-100 px-1 font-mono text-[10px] text-zinc-600">{id}</span>
      ))}
      <span className="shrink-0 font-mono text-[10px] text-zinc-400" title={label.id}>{label.id}</span>
    </li>)}
  </ul>
}

/** 历史批次的可读摘要：标题为主（截断 + tooltip），场景 ID 退到 tooltip。 */
function historySummary(labels: VerifScenarioLabelView[] | undefined, scenarioIds: string[]): { text: string; title: string } {
  if (!labels?.length) return { text: scenarioIds.join(' / ') || '—', title: scenarioIds.join(' / ') }
  const parts = labels.map((label) => label.title || label.id)
  return { text: parts.join('；'), title: parts.join('\n') }
}

/** 批次进度卡。 */
function BatchProgressCard({ loop, onStartBasicVerification, onContinueInChat }: {
  loop: VerifBatchLoopView | null
  onStartBasicVerification?: () => void
  onContinueInChat?: (breaker: { reason: string; detail: string }) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const stateMeta = LOOP_STATE_META[loop?.state ?? 'idle']
  return <section className="rounded border border-zinc-200 bg-white p-4">
    <div className="flex items-center gap-2">
      <ListTree size={15} className="text-zinc-400" />
      <h3 className="text-sm font-semibold">{t('verifRun.batch.title')}</h3>
      {loop && <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${stateMeta.cls}`}>{t(stateMeta.labelKey)}</span>}
      {loop?.updatedAt && <span className="ml-auto text-[10px] text-zinc-400">{t('verifRun.batch.updatedAt', { time: formatVerifTimestamp(loop.updatedAt) })}</span>}
    </div>

    {!loop ? <div className="mt-3 rounded border border-dashed border-zinc-300 p-6 text-center">
      <p className="text-xs text-zinc-500">{t('verifRun.batch.empty')}</p>
      {onStartBasicVerification && <button type="button" onClick={onStartBasicVerification} className="mt-3 inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500">
        <Play size={13} />{t('verifRun.batch.startBasic')}
      </button>}
    </div> : <>
      {loop.currentBatch && <div className="mt-3">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <strong className="text-zinc-800">{t('verifRun.batch.currentBatch', { index: loop.currentBatch.index })}</strong>
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${loop.currentBatch.phase === 'settling' ? 'bg-amber-100 text-amber-700' : 'bg-sky-100 text-sky-700'}`}>
            {t(loop.currentBatch.phase === 'settling' ? 'verifRun.batch.phaseSettling' : 'verifRun.batch.phaseDispatched')}
          </span>
          {loop.currentBatch.sessionName && <span className="font-mono text-[10px] text-zinc-400">{loop.currentBatch.sessionName}</span>}
          {loop.currentBatch.dispatchedAt && <span className="text-[10px] text-zinc-400">{t('verifRun.batch.dispatchedAt', { time: formatVerifTimestamp(loop.currentBatch.dispatchedAt) })}</span>}
        </div>
        <ScenarioLabelList labels={loop.currentBatch.scenarios} scenarioIds={loop.currentBatch.scenarioIds} />
      </div>}

      {loop.state === 'awaiting-rtl-fix' && loop.rtlFixWait && <div className="mt-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
        {t('verifRun.batch.waitingFix', { rootCauseId: loop.rtlFixWait.rootCauseId, time: formatVerifTimestamp(loop.rtlFixWait.since) })}
      </div>}

      {loop.state === 'circuit-broken' && loop.circuitBreaker && <div className="mt-3 rounded border border-red-200 bg-red-50 p-3">
        <div className="text-[11px] font-medium text-red-700">{t('verifRun.batch.breakerTitle')}</div>
        <p className="mt-1 text-xs font-semibold text-red-800">{loop.circuitBreaker.reason}</p>
        {loop.circuitBreaker.detail && <p className="mt-1 text-xs text-red-700">{loop.circuitBreaker.detail}</p>}
        {onContinueInChat && <button type="button" onClick={() => onContinueInChat({ reason: loop.circuitBreaker?.reason ?? '', detail: loop.circuitBreaker?.detail ?? '' })} className="mt-2 inline-flex items-center gap-1 rounded border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:border-red-500 hover:bg-red-100">
          <MessageSquare size={12} />{t('verifRun.batch.continueInChat')}
        </button>}
      </div>}

      {loop.history.length > 0 && <div className="mt-3">
        <div className="text-[11px] font-medium text-zinc-500">{t('verifRun.batch.historyTitle')}</div>
        <div className="mt-1 divide-y divide-zinc-100 border-y border-zinc-200">
          {loop.history.map((entry) => {
            const summary = historySummary(entry.scenarios, entry.scenarioIds)
            return <div key={`${entry.index}-${entry.settledAt}`} className="py-1.5 text-xs">
              <div className="flex items-center gap-2">
                {entry.verdict === 'completed'
                  ? <CheckCircle2 size={13} className="shrink-0 text-emerald-600" />
                  : <XCircle size={13} className="shrink-0 text-red-600" />}
                <span className="shrink-0 font-medium text-zinc-700">{t('verifRun.batch.currentBatch', { index: entry.index })}</span>
                {/* 已验证内容为主位；场景 ID 与"如何判定"退到 tooltip */}
                <span className="min-w-0 flex-1 truncate text-zinc-600" title={summary.title}>{summary.text}</span>
                <span className="shrink-0 text-[10px] text-zinc-400" title={`${entry.scenarioIds.join(' / ')}\n${entry.reason}`}>{formatVerifTimestamp(entry.settledAt)}</span>
              </div>
              {/* 熔断批次的 reason 是失败原因，必须可见；completed 的 reason 只是判定依据（多为
                  "证据齐全：scenario_hits 已登记且 posture 已重建"），不占主视觉，收进 tooltip */}
              {entry.verdict !== 'completed' && entry.reason && <p className="mt-0.5 pl-5 text-[11px] text-red-700">{entry.reason}</p>}
            </div>
          })}
        </div>
      </div>}
    </>}
  </section>
}

/** 修复窗口审计 L2 区块（diff 统计 + 文件清单 + 写保护拦截次数）。 */
function FixAuditDetails({ outcome, audit, onLoadAudit }: {
  outcome: RtlFixOutcomeView
  audit: RtlFixAuditView | null | undefined
  onLoadAudit?: (rootCauseId: string, auditPath: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // 同一根因只请求一次审计加载，避免反复展开触发重复 IPC
  const requested = useRef(false)
  const groups: Array<{ labelKey: MessageKey; files: string[] }> = audit ? [
    { labelKey: 'verifRun.fix.auditChanged', files: audit.changed },
    { labelKey: 'verifRun.fix.auditCreated', files: audit.created },
    { labelKey: 'verifRun.fix.auditDeleted', files: audit.deleted }
  ] : []
  const noFileChanges = audit !== null && audit !== undefined && groups.every((group) => group.files.length === 0)
  return <details className="mt-2 rounded border border-zinc-200 bg-zinc-50/60" onToggle={(event) => {
    if (event.currentTarget.open && !audit && !requested.current) {
      requested.current = true
      onLoadAudit?.(outcome.rootCauseId, outcome.auditPath)
    }
  }}>
    <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] font-medium text-zinc-600 hover:bg-zinc-50">{t('verifRun.fix.auditToggle')}</summary>
    <div className="border-t border-zinc-200 px-2.5 py-2 text-[11px] text-zinc-600">
      <div className="font-medium text-zinc-500">{t('verifRun.fix.blockedAttempts', { count: audit?.blockedAttempts ?? outcome.blockedAttempts })}</div>
      {audit ? (noFileChanges ? <p className="mt-1 text-zinc-400">{t('verifRun.fix.noFileChanges')}</p> : <div className="mt-1.5 space-y-1.5">
        {groups.filter((group) => group.files.length > 0).map((group) => <div key={group.labelKey}>
          <span className="font-medium text-zinc-700">{t(group.labelKey)} {group.files.length}</span>
          <div className="mt-0.5 space-y-0.5">
            {group.files.map((file) => <div key={file} className="truncate font-mono text-[10px] text-zinc-500" title={file}>· {file}</div>)}
          </div>
        </div>)}
      </div>) : <p className="mt-1 text-zinc-400">{t('verifRun.fix.auditMissing')}</p>}
    </div>
  </details>
}

/** 修复卡共用头部（根因 ID / 场景 / 会话 / 状态徽标 / 时间）。 */
function FixCardHeader({ rootCauseId, scenarioId, fixSessionName, badge, timeText }: {
  rootCauseId: string
  scenarioId: string
  fixSessionName: string
  badge: React.ReactNode
  timeText: string
}): React.JSX.Element {
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
    <span className="font-mono text-xs font-semibold text-zinc-800">{rootCauseId}</span>
    <span className="font-mono text-[11px] text-zinc-500">{scenarioId}</span>
    {fixSessionName && <span className="font-mono text-[10px] text-zinc-400">{fixSessionName}</span>}
    {badge}
    {timeText && <span className="ml-auto text-[10px] text-zinc-400">{timeText}</span>}
  </div>
}

/** 修复卡列表（进行中卡 + 判定卡）。 */
function FixCardList({ outcomes, inProgress, rootCauses, audits, onLoadFixAudit, onContinueDiagnosis, onRerunRegression }: {
  outcomes: RtlFixOutcomeView[]
  inProgress: RtlFixInProgressView | null
  rootCauses: RootCauseRecordView[]
  audits: Record<string, RtlFixAuditView | null> | undefined
  onLoadFixAudit?: (rootCauseId: string, auditPath: string) => void
  onContinueDiagnosis?: (outcome: RtlFixOutcomeView) => void
  onRerunRegression?: (outcome: RtlFixOutcomeView) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // 根因记录联查：修复卡展示一句话根因与修复指令
  const recordById = useMemo(() => new Map(rootCauses.map((record) => [record.id, record])), [rootCauses])
  const renderRootCauseLines = (rootCauseId: string): React.JSX.Element => {
    const record = recordById.get(rootCauseId)
    return <>
      <p className="mt-1.5 text-xs text-zinc-700">{record ? (record.rootCause || record.hypothesis) : t('verifRun.fix.recordMissing')}</p>
      {record?.fix && <p className="mt-1 text-xs text-zinc-500">{t('verifRun.rootCause.fixLabel', { fix: record.fix })}</p>}
    </>
  }
  return <section className="rounded border border-zinc-200 bg-white p-4">
    <div className="flex items-center gap-2">
      <Hammer size={15} className="text-zinc-400" />
      <h3 className="text-sm font-semibold">{t('verifRun.fix.title')}</h3>
    </div>
    <div className="mt-3 space-y-2">
      {inProgress && <div className="rounded border border-sky-200 bg-sky-50/60 p-3">
        <FixCardHeader
          rootCauseId={inProgress.rootCauseId}
          scenarioId={inProgress.scenarioId}
          fixSessionName={inProgress.fixSessionName}
          badge={<span className="inline-flex items-center gap-1 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />{t('verifRun.fix.stateFixing')}
          </span>}
          timeText={inProgress.startedAt ? t('verifRun.fix.startedAt', { time: formatVerifTimestamp(inProgress.startedAt) }) : ''}
        />
        {renderRootCauseLines(inProgress.rootCauseId)}
      </div>}

      {outcomes.map((outcome) => {
        const meta = JUDGMENT_META[outcome.judgment]
        const reason = outcome.reason || (outcome.judgment === 'UNKNOWN' ? t('verifRun.fix.unknownReason') : '')
        return <div key={`${outcome.rootCauseId}-${outcome.settledAt}`} className="rounded border border-zinc-200 p-3">
          <FixCardHeader
            rootCauseId={outcome.rootCauseId}
            scenarioId={outcome.scenarioId}
            fixSessionName={outcome.fixSessionName}
            badge={<span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${meta.cls}`}>{t(meta.labelKey)}</span>}
            timeText={outcome.settledAt ? t('verifRun.fix.settledAt', { time: formatVerifTimestamp(outcome.settledAt) }) : ''}
          />
          {renderRootCauseLines(outcome.rootCauseId)}
          {reason && <p className="mt-1 text-xs text-zinc-600">{reason}</p>}
          {(outcome.judgment === 'STILL_FAIL' || outcome.judgment === 'UNKNOWN') && (onContinueDiagnosis || (outcome.judgment === 'UNKNOWN' && onRerunRegression)) && <div className="mt-2 flex flex-wrap gap-2">
            {onContinueDiagnosis && <button type="button" onClick={() => onContinueDiagnosis(outcome)} className="inline-flex items-center gap-1 rounded border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:border-emerald-500 hover:text-emerald-700">
              <Wrench size={12} />{t('verifRun.fix.continueDiagnosis')}
            </button>}
            {outcome.judgment === 'UNKNOWN' && onRerunRegression && <button type="button" onClick={() => onRerunRegression(outcome)} className="inline-flex items-center gap-1 rounded border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:border-emerald-500 hover:text-emerald-700">
              <Play size={12} />{t('verifRun.fix.rerunRegression')}
            </button>}
          </div>}
          <FixAuditDetails outcome={outcome} audit={audits?.[outcome.rootCauseId]} onLoadAudit={onLoadFixAudit} />
        </div>
      })}

      {!inProgress && outcomes.length === 0 && <p className="rounded border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-400">{t('verifRun.fix.empty')}</p>}
    </div>
  </section>
}

/** 验证运行面板：批次进度卡 + 修复卡列表（垂直堆叠，容器尺寸由集成方决定）。 */
export function VerifRunPanel({ batchLoop, fixOutcomes, fixInProgress, rootCauses, fixAudits, onLoadFixAudit, onStartBasicVerification, onContinueInChat, onContinueDiagnosis, onRerunRegression }: VerifRunPanelProps): React.JSX.Element {
  return <div className="space-y-3">
    <BatchProgressCard loop={batchLoop} onStartBasicVerification={onStartBasicVerification} onContinueInChat={onContinueInChat} />
    <FixCardList
      outcomes={fixOutcomes}
      inProgress={fixInProgress}
      rootCauses={rootCauses}
      audits={fixAudits}
      onLoadFixAudit={onLoadFixAudit}
      onContinueDiagnosis={onContinueDiagnosis}
      onRerunRegression={onRerunRegression}
    />
  </div>
}
