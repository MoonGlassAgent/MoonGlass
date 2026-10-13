/**
 * 根因链视图（方案 C 批 3，设计文档 §4.2）。
 *
 * 读 root-causes.json，按 scenarioId 分组渲染假设链：
 * - open（蓝）/ refuted（灰，假设划线）/ confirmed（绿）徽标 + 假设一句话；
 * - refutedHypotheses 链式追溯以缩进 + 箭头呈现（"假设 B 证伪了假设 A"）；
 * - confirmed 条目显示根因 + fix + 修复判定徽标（联 rtl-fix-outcomes.json，props 传入）；
 * - 无记录时空态"尚无根因记录"。
 *
 * 纯数据组件：不自己发 IPC。
 */

import { useMemo } from 'react'
import { CornerDownRight, Stethoscope } from 'lucide-react'
import { useTranslation, type MessageKey } from '../../i18n'
import {
  formatVerifTimestamp,
  latestOutcomesByRootCause,
  type RootCauseRecordView,
  type RootCauseVerdict,
  type RtlFixJudgment,
  type RtlFixOutcomeView
} from './types'

export interface RootCauseChainSectionProps {
  /** 根因记录（root-causes.json records 归一化结果） */
  records: RootCauseRecordView[]
  /** 修复判定账本 outcomes（rtl-fix-outcomes.json；confirmed 条目联查修复判定徽标） */
  fixOutcomes?: RtlFixOutcomeView[]
}

/** 裁决徽标配色（open 蓝 / refuted 灰 / confirmed 绿） */
const VERDICT_META: Record<RootCauseVerdict, { labelKey: MessageKey; cls: string }> = {
  open: { labelKey: 'verifRun.rootCause.verdict.open', cls: 'bg-sky-100 text-sky-700' },
  refuted: { labelKey: 'verifRun.rootCause.verdict.refuted', cls: 'bg-zinc-100 text-zinc-500' },
  confirmed: { labelKey: 'verifRun.rootCause.verdict.confirmed', cls: 'bg-emerald-100 text-emerald-700' }
}

/** 修复判定徽标配色（与修复卡同口径） */
const FIX_JUDGMENT_META: Record<RtlFixJudgment, { labelKey: MessageKey; cls: string }> = {
  FIXED: { labelKey: 'verifRun.fix.judgment.FIXED', cls: 'bg-emerald-100 text-emerald-700' },
  STILL_FAIL: { labelKey: 'verifRun.fix.judgment.STILL_FAIL', cls: 'bg-red-100 text-red-700' },
  UNKNOWN: { labelKey: 'verifRun.fix.judgment.UNKNOWN', cls: 'bg-zinc-100 text-zinc-600' }
}

/** 单条根因记录行。 */
function RootCauseRecordRow({ record, outcome }: { record: RootCauseRecordView; outcome: RtlFixOutcomeView | undefined }): React.JSX.Element {
  const { t } = useTranslation()
  const meta = VERDICT_META[record.verdict]
  const refuted = record.verdict === 'refuted'
  return <div className="text-xs">
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${meta.cls}`}>{t(meta.labelKey)}</span>
      <span className={`min-w-0 ${refuted ? 'text-zinc-400 line-through' : 'text-zinc-700'}`} title={record.hypothesis}>{record.hypothesis}</span>
      <span className="ml-auto shrink-0 font-mono text-[10px] text-zinc-400">{record.id}</span>
      {record.createdAt && <span className="shrink-0 text-[10px] text-zinc-400">{t('verifRun.rootCause.recordedAt', { time: formatVerifTimestamp(record.createdAt) })}</span>}
    </div>
    {record.refutedHypotheses.length > 0 && <div className="mt-0.5 flex items-center gap-1 pl-4 text-[11px] text-zinc-400">
      <CornerDownRight size={11} className="shrink-0" />
      <span>{t('verifRun.rootCause.refutedBy', { ids: record.refutedHypotheses.join('、') })}</span>
    </div>}
    {record.verdict === 'confirmed' && <div className="mt-1 pl-4">
      {record.rootCause && <p className="font-medium text-zinc-800">{record.rootCause}</p>}
      {record.fix && <p className="mt-0.5 text-zinc-500">{t('verifRun.rootCause.fixLabel', { fix: record.fix })}</p>}
      {outcome && <span className={`mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${FIX_JUDGMENT_META[outcome.judgment].cls}`} title={outcome.reason}>{t(FIX_JUDGMENT_META[outcome.judgment].labelKey)}</span>}
    </div>}
  </div>
}

/** 根因链区块：按 scenarioId 分组，组内按登记时间升序成链。 */
export function RootCauseChainSection({ records, fixOutcomes = [] }: RootCauseChainSectionProps): React.JSX.Element {
  const { t } = useTranslation()
  const groups = useMemo(() => {
    const byScenario = new Map<string, RootCauseRecordView[]>()
    for (const record of records) {
      const list = byScenario.get(record.scenarioId) ?? []
      list.push(record)
      byScenario.set(record.scenarioId, list)
    }
    return [...byScenario.entries()].map(([scenarioId, items]) => ({
      scenarioId,
      items: [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    }))
  }, [records])
  const latestOutcome = useMemo(() => latestOutcomesByRootCause(fixOutcomes), [fixOutcomes])
  return <section className="rounded border border-zinc-200 bg-white p-4">
    <div className="flex items-center gap-2">
      <Stethoscope size={15} className="text-zinc-400" />
      <h3 className="text-sm font-semibold">{t('verifRun.rootCause.title')}</h3>
      {records.length > 0 && <span className="ml-auto text-xs text-zinc-400">{t('verifRun.rootCause.count', { count: records.length })}</span>}
    </div>
    {records.length === 0 ? <p className="mt-3 rounded border border-dashed border-zinc-300 p-4 text-center text-xs text-zinc-400">{t('verifRun.rootCause.empty')}</p>
      : <div className="mt-3 space-y-3">
        {groups.map((group) => <div key={group.scenarioId}>
          <div className="font-mono text-xs font-semibold text-zinc-800">{group.scenarioId}</div>
          <div className="mt-1.5 space-y-2.5 border-l-2 border-zinc-200 pl-3">
            {group.items.map((record) => <RootCauseRecordRow key={record.id} record={record} outcome={latestOutcome.get(record.id)} />)}
          </div>
        </div>)}
      </div>}
  </section>
}
