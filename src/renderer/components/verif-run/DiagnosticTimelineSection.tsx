/**
 * 诊断账本时间线（方案 C 批 3，设计文档 §4.3）。
 *
 * 摘要行（mode 徽标 + activeCase + recommendation + 最新等级 + 尝试数）常驻，
 * 点击展开时间线：
 * - 当前失败指纹 + 同指纹次数；
 * - L 等级爬升阶梯点图（L0→L5 纯序号 SVG 简图，PASS 绿点 / FAIL 红点，进入增强诊断点紫圈）；
 * - attempts 列表（时间 / testcase / PASS-FAIL / L 等级 / 耗时 / 证据路径可点击）；
 * - 进入 DIAGNOSTIC_ENHANCEMENT 的那次尝试高亮，并按 attempts 重放推导显示触发条件
 *   （同指纹 ≥2 次 / ≥3 次尝试且等级未爬升，与 moonglass-tools 落账口径一致）。
 *
 * 纯数据 + 回调组件：证据路径点击经 onOpenEvidence 交给集成方（fs.openExternal 或文件预览）。
 */

import { useMemo } from 'react'
import { Flag } from 'lucide-react'
import { useTranslation } from '../../i18n'
import {
  deriveDiagnosticReplay,
  formatVerifTimestamp,
  type DiagnosticControlView,
  type DiagnosticMode,
  type DiagnosticReplayEntry
} from './types'

export interface UtEscalationTimelineEvent {
  id: string
  module: string
  reason: string
  createdAt: string
  status: 'active' | 'retired'
  /** 关联根因记录（RC-*）；可为空 */
  rootCauseId?: string | null
}

export interface DiagnosticTimelineSectionProps {
  /** 诊断账本（diagnostic-control.json 归一化结果；null=无账本，不渲染） */
  diagnostic: DiagnosticControlView | null
  /** 证据路径点击回调（日志/波形/result.json，由集成方接 fs.openExternal 或文件预览） */
  onOpenEvidence?: (path: string) => void
  /** UT 例外登记事件点（AIGV 修订 §7.4）：叠加在时间线上；缺省不渲染，不影响既有调用方 */
  utEscalations?: UtEscalationTimelineEvent[]
}

/** mode 区块配色（沿用态势页诊断横幅：增强=紫、闭环=绿、常规=蓝） */
const MODE_TONE: Record<DiagnosticMode, string> = {
  NORMAL_DEBUG: 'border-sky-200 bg-sky-50',
  DIAGNOSTIC_ENHANCEMENT: 'border-violet-200 bg-violet-50',
  CLOSED: 'border-emerald-200 bg-emerald-50'
}

/** L 等级爬升阶梯点图：x=尝试序号，y=L0..L5。 */
function LevelLadder({ entries }: { entries: DiagnosticReplayEntry[] }): React.JSX.Element {
  const width = Math.max(240, entries.length * 30 + 60)
  const height = 128
  const xOf = (index: number): number => 44 + index * 30
  const yOf = (level: number): number => 112 - level * 20
  const points = entries.map((entry) => `${xOf(entry.index)},${yOf(Number(entry.attempt.diagnosticLevel.slice(1)))}`).join(' ')
  return <svg viewBox={`0 0 ${width} ${height}`} className="mt-2 w-full" role="img">
    {[0, 1, 2, 3, 4, 5].map((level) => <g key={level}>
      <line x1={28} y1={yOf(level)} x2={width - 8} y2={yOf(level)} stroke="#e4e4e7" strokeWidth={1} />
      <text x={4} y={yOf(level) + 3} fontSize={9} fill="#a1a1aa">L{level}</text>
    </g>)}
    {entries.length > 1 && <polyline points={points} fill="none" stroke="#a1a1aa" strokeWidth={1.5} />}
    {entries.map((entry) => {
      const level = Number(entry.attempt.diagnosticLevel.slice(1))
      const x = xOf(entry.index)
      const y = yOf(level)
      return <g key={entry.attempt.id || entry.index}>
        <circle cx={x} cy={y} r={3.5} fill={entry.attempt.passed ? '#10b981' : '#ef4444'}>
          <title>{`${entry.attempt.topModule}::${entry.attempt.testcase} L${level}`}</title>
        </circle>
        {entry.isEnhancementEntry && <circle cx={x} cy={y} r={7} fill="none" stroke="#7c3aed" strokeWidth={2} />}
      </g>
    })}
  </svg>
}

/** 诊断账本区块：摘要行常驻，点击展开时间线。 */
export function DiagnosticTimelineSection({ diagnostic, onOpenEvidence, utEscalations }: DiagnosticTimelineSectionProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const attempts = diagnostic?.attempts ?? []
  // 重放推导：mode 演化 + 首次进入 DIAGNOSTIC_ENHANCEMENT 的触发点
  const replay = useMemo(() => deriveDiagnosticReplay(attempts), [attempts])
  const enhancementEntry = replay.find((entry) => entry.isEnhancementEntry)
  // 当前失败指纹：最近一次失败尝试；同指纹次数按同用例（topModule::testcase）统计，与落账口径一致
  const fingerprint = useMemo(() => {
    const lastFail = [...attempts].reverse().find((attempt) => !attempt.passed)
    if (!lastFail) return null
    const caseKey = `${lastFail.topModule}::${lastFail.testcase}`
    const sameCount = attempts.filter((attempt) => !attempt.passed && attempt.failureSignature === lastFail.failureSignature && `${attempt.topModule}::${attempt.testcase}` === caseKey).length
    return { signature: lastFail.failureSignature, sameCount }
  }, [attempts])
  if (!diagnostic) return null
  const latestLevel = attempts.at(-1)?.diagnosticLevel ?? 'L0'
  return <details className={`rounded border ${MODE_TONE[diagnostic.mode]}`}>
    <summary className="flex cursor-pointer items-start gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <strong className="text-sm">{t('verifRun.diagnostic.title')}</strong>
          <span className="rounded bg-white px-2 py-0.5 font-mono text-[10px] text-zinc-600">{diagnostic.mode}</span>
          <span className="font-mono text-[10px] text-zinc-500">{diagnostic.activeCase}</span>
        </div>
        <p className="mt-1 text-xs text-zinc-600">{diagnostic.recommendation}</p>
      </div>
      <div className="shrink-0 text-right">
        <div className="text-lg font-semibold text-violet-700">{latestLevel}</div>
        <div className="text-[10px] text-zinc-500">{t('verifRun.diagnostic.attemptCount', { count: attempts.length })}</div>
      </div>
    </summary>

    <div className="border-t border-black/10 px-4 py-3">
      {attempts.length === 0 ? <p className="text-xs text-zinc-400">{t('verifRun.diagnostic.empty')}</p> : <>
        {fingerprint && <p className="text-[11px] text-zinc-600">
          {t('verifRun.diagnostic.fingerprint', { signature: fingerprint.signature })} · {t('verifRun.diagnostic.sameFingerprint', { count: fingerprint.sameCount })}
        </p>}

        <div className="mt-2 text-[11px] font-medium text-zinc-500">{t('verifRun.diagnostic.ladderTitle')}</div>
        <LevelLadder entries={replay} />

        {enhancementEntry && <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-violet-200 bg-violet-50 px-2.5 py-1.5 text-[11px] text-violet-800">
          <Flag size={12} className="shrink-0" />
          <span className="font-medium">{t('verifRun.diagnostic.enhancementEntered')}</span>
          <span className="font-mono text-[10px]">{enhancementEntry.attempt.id}</span>
          <span>{enhancementEntry.trigger === 'same-fingerprint' ? t('verifRun.diagnostic.triggerSameFingerprint') : t('verifRun.diagnostic.triggerStalled')}</span>
        </div>}

        <div className="mt-3 text-[11px] font-medium text-zinc-500">{t('verifRun.diagnostic.timelineTitle')}</div>
        <div className="mt-1 max-h-72 overflow-auto border-y border-zinc-200 bg-white">
          <table className="w-full table-fixed text-left text-[11px]">
            <thead className="sticky top-0 bg-zinc-50 text-zinc-500"><tr>
              <th className="w-36 px-2 py-1.5 font-medium">{t('verifRun.diagnostic.colTime')}</th>
              <th className="px-2 py-1.5 font-medium">{t('verifRun.diagnostic.colTestcase')}</th>
              <th className="w-14 px-2 py-1.5 font-medium">{t('verifRun.diagnostic.colResult')}</th>
              <th className="w-12 px-2 py-1.5 font-medium">{t('verifRun.diagnostic.colLevel')}</th>
              <th className="w-20 px-2 py-1.5 font-medium">{t('verifRun.diagnostic.colDuration')}</th>
              <th className="w-64 px-2 py-1.5 font-medium">{t('verifRun.diagnostic.colEvidence')}</th>
            </tr></thead>
            <tbody>
              {replay.map((entry) => <tr key={entry.attempt.id || entry.index} className={`border-t border-zinc-100 align-top ${entry.isEnhancementEntry ? 'bg-violet-50' : ''}`}>
                <td className="px-2 py-1.5 text-zinc-500">{formatVerifTimestamp(entry.attempt.createdAt)}</td>
                <td className="px-2 py-1.5"><span className="block truncate font-mono text-[10px] text-zinc-700" title={`${entry.attempt.topModule}::${entry.attempt.testcase}`}>{entry.attempt.topModule}::{entry.attempt.testcase}</span></td>
                <td className={`px-2 py-1.5 font-semibold ${entry.attempt.passed ? 'text-emerald-700' : 'text-red-700'}`}>{t(entry.attempt.passed ? 'verifRun.diagnostic.passed' : 'verifRun.diagnostic.failed')}</td>
                <td className="px-2 py-1.5 font-mono text-zinc-700">{entry.attempt.diagnosticLevel}</td>
                <td className="px-2 py-1.5 text-zinc-500">{t('verifRun.diagnostic.duration', { ms: entry.attempt.durationMs })}</td>
                <td className="px-2 py-1.5">
                  {entry.attempt.evidence.length > 0 ? entry.attempt.evidence.map((path) => onOpenEvidence
                    ? <button key={path} type="button" onClick={() => onOpenEvidence(path)} title={t('verifRun.diagnostic.openEvidence')} className="block max-w-full truncate text-left font-mono text-[10px] text-sky-700 hover:underline">{path}</button>
                    : <span key={path} className="block max-w-full truncate font-mono text-[10px] text-zinc-500" title={path}>{path}</span>) : '—'}
                </td>
              </tr>)}
            </tbody>
          </table>
        </div>
      </>}
    </div>
  </details>
}
