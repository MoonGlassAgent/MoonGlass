import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, ChevronRight, Circle, FileSearch, Play, RefreshCw, ShieldCheck, Wrench, XCircle } from 'lucide-react'
import type { ChipProject, SpecMapping, VerificationRunStatus, WaveProgressEntry } from '@shared/types'
import { useChatStore } from '../store/chatStore'
import { deriveTopRisks, deriveVerificationActions, deriveVerificationSteps, topicExplanation, type ExplainedRisk } from '../verification-guidance'
import { useTranslation, type MessageKey } from '../i18n'
import { CoverageDetailPanel } from '../components/CoverageDetailPanel'

interface RiskMarker { id: string; taxonomyId?: string; title: string; riskStatement?: string; rationale?: string; failureModes?: string[]; observableEffects?: string[]; object: string; features: string[]; structuralComplexity: number; interaction: number; riskScore: number; confidence: string; source: { file: string; line?: number } }
interface SpecGap { id: string; category: string; title: string; description?: string; impact: string; action: string; confidence: string; requirementIds: string[]; rtlObjects: string[]; sources?: Array<{ file: string; line?: number }> }
interface Intent { id: string; scenarioId: string; objective: string; rationale?: string; failureMode?: string; sourceIds?: string[]; status: string; priority: number; recommendedMethods: string[]; preconditions?: string[]; stimulusProcedure?: string[]; observationPoints?: string[]; expectedResults?: string[]; passCriteria?: string[]; boundaries: Array<{ object: string; values: string[] }>; evidence: string[]; wave?: string; topic?: string }
/** 用例全景行数据源：scenario-registry.json 的场景条目（posture 精简快照不含 scenarios，单独读取） */
interface PanoramaScenario { id: string; title?: string; wave?: string; topic?: string; status?: string; state?: { closure?: string } }
interface CoverageHole { id: string; scenarioId: string; scenarioTitle?: string; classification: string; confidence: string; reason: string; missingTarget?: string; requiredStimulus?: string[]; requiredObservation?: string[]; closureEvidence?: string[]; recommendedAction: string; blocking: boolean }
interface VerificationState {
  generatedAt: string
  rtlHash: string
  scenarioCount: number
  criticalOpen: string[]
  verificationIntents: Intent[]
  specGaps: SpecGap[]
  coverageHoles: CoverageHole[]
  regressions: Array<{ resultFile: string; passed: boolean; testsTotal: number; coverage: Record<string, number> }>
  formalResults: Array<{ resultFile: string; status: string; outcome?: string; mode: string; scenarioId?: string; traces: string[] }>
  closureAssessment?: {
    status: 'NOT_READY' | 'CONDITIONALLY_READY' | 'READY_FOR_HUMAN_SIGNOFF'
    blockers: string[]
    warnings: string[]
    residualRisks: string[]
    nextActions: string[]
    metrics: { criticalTotal: number; criticalClosed: number; criticalClosurePercent: number; regressionsPassed: boolean; blockingCoverageHoles: number; formalToolErrors: number; impactUnknown: number }
  }
  verificationSpace?: { snapshotId: string; candidateCount: number; positiveCount: number; negativeCount: number; dimensions: { features: number; boundaries: number; interactions: number; temporalRelations: number; systemStates: number } }
  explorationRound?: { roundId: string; selectedScenarioIds: string[]; expectedCostSeconds: number; candidateCount: number; uncoveredCritical: number }
  explorationHistory?: { saturation: { status: 'NOT_ENOUGH_ROUNDS' | 'PROGRESSING' | 'EMPIRICALLY_SATURATED' | 'STALLED'; completedRounds: number; noProgressStreak: number; explanation: string } }
  multiOracle?: { assessments: Array<{ scenarioId: string; requiredIndependentPasses: number; independentPassDomains: string[]; passOracleIds: string[]; failOracleIds: string[]; invalidOracleIds: string[]; status: 'INSUFFICIENT' | 'PASS' | 'FAIL' | 'CONFLICT'; explanation: string }>; criticalInsufficient: string[]; conflicts: string[] }
  mutationAssessment?: { status: 'MISSING' | 'BELOW_THRESHOLD' | 'BLOCKED_BY_SURVIVOR' | 'PASS'; threshold: number; weightedScore: number | null; validCount: number; killedCount: number; blockingSurvivors: string[]; invalidOrStale: string[] }
  residualRiskRegister?: Array<{ id: string; category: string; title: string; impact: string; approved: boolean; approvalRequired: boolean; approval?: { approver: string; rationale: string; approvedAt: string } }>
  signoffPackage?: { packageId: string; status: string; summary: string; blockers: string[]; warnings: string[]; evidenceFiles: string[] }
  moduleVerificationStrategy?: ModuleVerificationStrategy
  structuralSummary?: { fsm: number; cfgNodes: number; dependencies: number; cones: number; protocols: Array<{ protocol: string; module: string }> }
  analyzer?: { engine: string; version?: string; limitations: string[] }
  waveProgress?: WaveProgressEntry[]
  /** 执行批分组（posture 快照含；批次顺序用于“什么时候执行”推导） */
  executionClusters?: Array<{ clusterId: string; wave?: string; topic?: string; scenarioIds: string[]; executionBatches: string[][] }>
  /** 全量执行计划（仅 verification-state.json 含；无 clusters 时按顺序 3 个一批粗推） */
  executionPlan?: Array<{ scenarioId: string }>
  /** blockedBySpecCount 由引擎写入 specMapping（共享类型未声明，页面本地扩展） */
  specMapping?: SpecMapping & { blockedBySpecCount?: number }
}
interface DiagnosticControl { mode: 'NORMAL_DEBUG' | 'DIAGNOSTIC_ENHANCEMENT' | 'CLOSED'; activeCase: string; recommendation: string; attempts: Array<{ diagnosticLevel: string; passed: boolean; createdAt: string; observations: string[] }> }
interface ModuleVerificationStrategy {
  topModules: string[]
  summary: { STATIC_ONLY: number; UNIT_SMOKE: number; UNIT_FOCUSED: number; IP_SIGNOFF: number }
  modules: Array<{
    module: string
    role: string
    level: 'STATIC_ONLY' | 'UNIT_SMOKE' | 'UNIT_FOCUSED' | 'IP_SIGNOFF'
    riskScore: number
    reasons: string[]
    oracleStrategies: string[]
    goldenModel: { recommendation: 'RECOMMENDED' | 'OPTIONAL' | 'NOT_NEEDED'; rationale: string }
    requiredChecks: string[]
    standaloneTestbench: boolean
  }>
}

const CLOSED = new Set(['VERIFIED', 'FORMAL_PROVED', 'FORMAL_UNREACHABLE', 'WAIVED'])
const SPEC_GAP_CATEGORY_LABELS: Record<string, MessageKey> = {
  SPEC_WITHOUT_RTL: 'verification.specGapCategories.SPEC_WITHOUT_RTL', RTL_WITHOUT_SPEC: 'verification.specGapCategories.RTL_WITHOUT_SPEC', SPEC_UNDEFINED: 'verification.specGapCategories.SPEC_UNDEFINED', TEMPORAL_UNDEFINED: 'verification.specGapCategories.TEMPORAL_UNDEFINED'
}
const CLAUSE_STATUS_LABELS: Record<string, { labelKey: MessageKey; cls: string }> = {
  UNMAPPED: { labelKey: 'verification.clauseStatuses.UNMAPPED', cls: 'bg-amber-100 text-amber-700' },
  MAPPED_UNTESTED: { labelKey: 'verification.clauseStatuses.MAPPED_UNTESTED', cls: 'bg-zinc-100 text-zinc-600' },
  PASSED: { labelKey: 'verification.clauseStatuses.PASSED', cls: 'bg-emerald-100 text-emerald-700' },
  FAILED: { labelKey: 'verification.clauseStatuses.FAILED', cls: 'bg-red-100 text-red-700' },
  WAIVED: { labelKey: 'verification.clauseStatuses.WAIVED', cls: 'bg-zinc-100 text-zinc-600' }
}
/** 识别被误当为 Spec Gap 的 markdown 版本历史表格行等垃圾数据。 */
const looksLikeGarbage = (text: string): boolean => /\|\s*\d+\.\d+\s*\|/.test(text) || /版本历史|变更描述|日期|作者/.test(text)
const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, milliseconds))
const HOLE_LABELS: Record<string, MessageKey> = {
  C1_UNREACHABLE: 'verification.holeLabels.C1_UNREACHABLE', C2_CONSTRAINT_BLOCKED: 'verification.holeLabels.C2_CONSTRAINT_BLOCKED', C3_STIMULUS_MISSING: 'verification.holeLabels.C3_STIMULUS_MISSING',
  C4_OBSERVATION_MISSING: 'verification.holeLabels.C4_OBSERVATION_MISSING', C5_SPEC_UNDEFINED: 'verification.holeLabels.C5_SPEC_UNDEFINED', C6_TOOL_INSTRUMENTATION: 'verification.holeLabels.C6_TOOL_INSTRUMENTATION'
}
/** 覆盖缺口分类的工程师语言解释（tooltip 术语翻译层） */
const HOLE_EXPLANATIONS: Record<string, MessageKey> = {
  C1_UNREACHABLE: 'verification.holeExplanations.C1_UNREACHABLE', C2_CONSTRAINT_BLOCKED: 'verification.holeExplanations.C2_CONSTRAINT_BLOCKED', C3_STIMULUS_MISSING: 'verification.holeExplanations.C3_STIMULUS_MISSING',
  C4_OBSERVATION_MISSING: 'verification.holeExplanations.C4_OBSERVATION_MISSING', C5_SPEC_UNDEFINED: 'verification.holeExplanations.C5_SPEC_UNDEFINED', C6_TOOL_INSTRUMENTATION: 'verification.holeExplanations.C6_TOOL_INSTRUMENTATION'
}
const RISK_LEVEL_LABELS: Record<ExplainedRisk['level'], MessageKey> = {
  confirmed: 'verification.riskLevels.confirmed',
  highRisk: 'verification.riskLevels.highRisk',
  infraGap: 'verification.riskLevels.infraGap',
  specGap: 'verification.riskLevels.specGap',
  accepted: 'verification.riskLevels.accepted'
}
const HEAT_LEVEL_KEYS: MessageKey[] = ['verification.heatLevels.low', 'verification.heatLevels.lower', 'verification.heatLevels.mid', 'verification.heatLevels.higher', 'verification.heatLevels.high']

/** 用例全景：波段标签（smoke 已废弃，与引擎归一口径一致按 W1 显示；basic/corner/signoff → W1-W3） */
const PANORAMA_WAVE_LABELS: Record<string, string> = { smoke: 'W1', basic: 'W1', corner: 'W2', signoff: 'W3' }
type PanoramaCategory = 'failed' | 'specBlocked' | 'planned' | 'unplanned' | 'verified' | 'waived'
type PanoramaFilter = 'all' | 'failing' | 'pending' | 'unplanned'
interface PanoramaRow { id: string; what: string; waveLabel: string; topic?: string; topicWhy?: string; tests: Array<{ label: string; status?: string }>; category: PanoramaCategory; why: string; whyTitle?: string; when: string; planOrder: number }
const PANORAMA_STATUS_META: Record<PanoramaCategory, { labelKey: MessageKey; cls: string }> = {
  failed: { labelKey: 'verification.panorama.statusFailed', cls: 'bg-red-100 text-red-700' },
  specBlocked: { labelKey: 'verification.panorama.statusSpecBlocked', cls: 'bg-orange-100 text-orange-700' },
  planned: { labelKey: 'verification.panorama.statusPlanned', cls: 'bg-amber-100 text-amber-700' },
  unplanned: { labelKey: 'verification.panorama.statusUnplanned', cls: 'bg-zinc-100 text-zinc-600' },
  verified: { labelKey: 'verification.panorama.statusVerified', cls: 'bg-emerald-100 text-emerald-700' },
  waived: { labelKey: 'verification.panorama.statusWaived', cls: 'bg-zinc-100 text-zinc-600' }
}
/** 默认排序：失败 → 规格未澄清 → 已规划未执行（按计划批次顺序）→ 未规划 → 已验证 → 豁免 */
const PANORAMA_CATEGORY_RANK: Record<PanoramaCategory, number> = { failed: 0, specBlocked: 1, planned: 2, unplanned: 3, verified: 4, waived: 5 }
const PANORAMA_FILTERS: Array<{ id: PanoramaFilter; labelKey: MessageKey; match: (row: PanoramaRow) => boolean }> = [
  { id: 'all', labelKey: 'verification.panorama.filterAll', match: () => true },
  { id: 'failing', labelKey: 'verification.panorama.filterFailing', match: (row) => row.category === 'failed' || row.category === 'specBlocked' },
  { id: 'pending', labelKey: 'verification.panorama.filterPending', match: (row) => row.category === 'planned' },
  { id: 'unplanned', labelKey: 'verification.panorama.filterUnplanned', match: (row) => row.category === 'unplanned' }
]
const PANORAMA_COLLAPSE_LIMIT = 30

type PanoramaTranslate = (key: MessageKey, params?: Record<string, string | number>) => string

/** 行模型：全部 scenarios + specMapping 中 UNMAPPED 条款（无场景的验证点）。 */
function buildPanoramaRows(state: VerificationState, scenarios: PanoramaScenario[], runStatus: VerificationRunStatus | null, t: PanoramaTranslate): PanoramaRow[] {
  const intentByScenario = new Map<string, Intent>()
  for (const intent of state.verificationIntents) if (!intentByScenario.has(intent.scenarioId)) intentByScenario.set(intent.scenarioId, intent)
  // posture 精简快照不含 scenarios 且 registry 不可读时，由 Intent 退化合成行集合
  const scenarioList: PanoramaScenario[] = scenarios.length > 0 ? scenarios
    : state.verificationIntents.map((intent) => ({ id: intent.scenarioId, title: intent.objective, wave: intent.wave, topic: intent.topic, status: intent.status }))
  // 执行批顺序：executionClusters 批次扁平化；仅有 executionPlan 时按顺序 3 个一批粗推
  const batchOf = new Map<string, number>()
  if (state.executionClusters?.length) {
    let batch = 0
    for (const cluster of state.executionClusters) for (const group of cluster.executionBatches ?? []) {
      for (const id of group) if (!batchOf.has(id)) batchOf.set(id, batch)
      batch += 1
    }
  } else if (state.executionPlan?.length) {
    state.executionPlan.forEach((plan, index) => { if (!batchOf.has(plan.scenarioId)) batchOf.set(plan.scenarioId, Math.floor(index / 3)) })
  }
  // 波段门：W1 基础功能未闭环时，corner/signoff 波段的未执行场景要等 W1
  const w1 = state.waveProgress?.find((wave) => wave.id === 'W1')
  const isOpen = (item: PanoramaScenario): boolean => item.state ? item.state.closure === 'OPEN' : !CLOSED.has(item.status ?? '')
  const basicDone = w1 ? w1.status === 'done' : !scenarioList.some((item) => (item.wave ?? 'basic') === 'basic' && isOpen(item))
  const holesByScenario = new Map<string, CoverageHole[]>()
  for (const hole of state.coverageHoles) {
    const list = holesByScenario.get(hole.scenarioId) ?? []
    list.push(hole)
    holesByScenario.set(hole.scenarioId, list)
  }
  // 场景↔用例绑定：cocotb 测试函数名内嵌 scn_<8hex> 对应 SCN-XXXXXXXX
  const boundTests = (scenarioId: string): Array<{ label: string; status?: string }> => {
    const hex = scenarioId.replace(/^SCN-/i, '').toLowerCase()
    if (!hex) return []
    const token = `scn_${hex}`
    const byLabel = new Map<string, { label: string; status?: string }>()
    for (const plannedCase of runStatus?.planned ?? []) if (plannedCase.name?.toLowerCase().includes(token)) byLabel.set(plannedCase.testId || plannedCase.name, { label: plannedCase.testId || plannedCase.name })
    for (const executedCase of runStatus?.executed ?? []) if (executedCase.testName?.toLowerCase().includes(token)) byLabel.set(executedCase.testId || executedCase.testName, { label: executedCase.testId || executedCase.testName, status: executedCase.status })
    return [...byLabel.values()]
  }
  const categoryOf = (status: string): PanoramaCategory =>
    status === 'VERIFIED' || status === 'FORMAL_PROVED' ? 'verified'
      : status === 'FAILED' ? 'failed'
        : status === 'WAIVED' || status === 'FORMAL_UNREACHABLE' ? 'waived'
          : status === 'BLOCKED_BY_SPEC' ? 'specBlocked'
            : 'planned'
  const rows: PanoramaRow[] = scenarioList.map((scenario) => {
    const intent = intentByScenario.get(scenario.id)
    const category = categoryOf(scenario.status ?? intent?.status ?? '')
    const waveKey = scenario.wave ?? intent?.wave ?? ''
    const batchIndex = batchOf.get(scenario.id)
    const waveGated = category === 'planned' && batchIndex === undefined && (waveKey === 'corner' || waveKey === 'signoff') && !basicDone
    let why = t('verification.panorama.whyNone')
    let whyTitle: string | undefined
    if (category === 'specBlocked') why = t('verification.panorama.whySpecBlocked')
    else if (category === 'planned') {
      const hole = (holesByScenario.get(scenario.id) ?? []).sort((a, b) => Number(b.blocking) - Number(a.blocking))[0]
      if (hole && HOLE_EXPLANATIONS[hole.classification]) { why = t(HOLE_EXPLANATIONS[hole.classification]); whyTitle = hole.reason }
      else if (waveGated) why = t('verification.panorama.whyWaveGate')
      else if (batchIndex !== undefined) why = t('verification.panorama.whyInPlan')
      else why = t('verification.panorama.whyOutOfPlan')
    }
    const when = category !== 'planned' ? t('verification.panorama.whenNone')
      : batchIndex !== undefined ? (batchIndex === 0 ? t('verification.panorama.whenNextBatch') : t('verification.panorama.whenBatchN', { n: batchIndex + 1 }))
        : waveGated ? t('verification.panorama.whenWaveGate')
          : t('verification.panorama.whenNone')
    const rowTopic = scenario.topic ?? intent?.topic
    return { id: scenario.id, what: intent?.objective || scenario.title || scenario.id, waveLabel: PANORAMA_WAVE_LABELS[waveKey] ?? '—', topic: rowTopic, topicWhy: waveKey === 'corner' && rowTopic ? topicExplanation(rowTopic) : undefined, tests: boundTests(scenario.id), category, why, whyTitle, when, planOrder: batchIndex ?? Number.MAX_SAFE_INTEGER }
  })
  // 无场景的验证点：UNMAPPED 规格条款
  const unmappedClauses = state.specMapping?.clauses?.length
    ? state.specMapping.clauses.filter((clause) => clause.status === 'UNMAPPED').map((clause) => ({ id: clause.clauseId, text: clause.text }))
    : (state.specMapping?.unmappedClause ?? []).map((clause) => ({ id: clause.specId, text: clause.clause }))
  for (const clause of unmappedClauses) {
    rows.push({ id: clause.id, what: clause.text, waveLabel: '—', tests: [], category: 'unplanned', why: t('verification.panorama.whyUnplanned'), when: t('verification.panorama.whenNeedRegister'), planOrder: Number.MAX_SAFE_INTEGER })
  }
  return rows.sort((a, b) => PANORAMA_CATEGORY_RANK[a.category] - PANORAMA_CATEGORY_RANK[b.category] || a.planOrder - b.planOrder || a.id.localeCompare(b.id))
}

/** 用例全景区块：每个验证点一行，回答“验什么、用哪些用例、状态、为什么没执行、什么时候执行”。 */
function CasePanoramaSection({ state, scenarios, runStatus }: { state: VerificationState; scenarios: PanoramaScenario[]; runStatus: VerificationRunStatus | null }): React.JSX.Element {
  const { t, locale } = useTranslation()
  const [filter, setFilter] = useState<PanoramaFilter>('all')
  const [expanded, setExpanded] = useState(false)
  // locale 变化时行内文案需重新推导（t 读取当前语言）
  const rows = useMemo(() => buildPanoramaRows(state, scenarios, runStatus, t), [state, scenarios, runStatus, locale])
  const activeFilter = PANORAMA_FILTERS.find((item) => item.id === filter) ?? PANORAMA_FILTERS[0]
  const filtered = rows.filter(activeFilter.match)
  const collapsed = !expanded && filtered.length > PANORAMA_COLLAPSE_LIMIT
  const visible = collapsed ? filtered.slice(0, PANORAMA_COLLAPSE_LIMIT) : filtered
  return <section className="border-b border-zinc-200 bg-white p-5">
    <div className="mb-3 flex items-end justify-between gap-3">
      <div><h2 className="text-sm font-semibold">{t('verification.panorama.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.panorama.subtitle')}</p></div>
      <span className="shrink-0 text-xs text-zinc-400">{t('verification.panorama.count', { count: rows.length })}</span>
    </div>
    <div className="mb-3 flex flex-wrap gap-2">
      {PANORAMA_FILTERS.map((item) => <button key={item.id} type="button" onClick={() => { setFilter(item.id); setExpanded(false) }} className={`rounded-full border px-3 py-1 text-xs ${filter === item.id ? 'border-zinc-900 bg-zinc-900 text-white' : 'border-zinc-300 bg-white text-zinc-600 hover:border-zinc-500'}`}>{t(item.labelKey)} {rows.filter(item.match).length}</button>)}
    </div>
    <div className="max-h-[32rem] overflow-auto border-y border-zinc-200">
      <table className="w-full table-fixed text-left text-[11px]">
        <thead className="sticky top-0 bg-zinc-50 text-zinc-500"><tr>
          <th className="px-2 py-2 font-medium">{t('verification.panorama.colWhat')}</th>
          <th className="w-24 px-2 py-2 font-medium">{t('verification.panorama.colWave')}</th>
          <th className="w-44 px-2 py-2 font-medium">{t('verification.panorama.colTests')}</th>
          <th className="w-32 px-2 py-2 font-medium">{t('verification.panorama.colStatus')}</th>
          <th className="w-48 px-2 py-2 font-medium">{t('verification.panorama.colWhy')}</th>
          <th className="w-28 px-2 py-2 font-medium">{t('verification.panorama.colWhen')}</th>
        </tr></thead>
        <tbody>
          {visible.map((row) => { const meta = PANORAMA_STATUS_META[row.category]; return <tr key={row.id} className="border-t border-zinc-100 align-top">
            <td className="px-2 py-2"><div className="truncate text-zinc-800" title={row.what}>{row.what}</div><div className="mt-0.5 truncate font-mono text-[10px] text-zinc-400">{row.id}</div></td>
            <td className="px-2 py-2 text-zinc-600" title={row.topicWhy ?? row.topic}>{row.waveLabel}{row.topic ? ` · ${row.topic}` : ''}</td>
            <td className="px-2 py-2">{row.tests.length > 0 ? <div className="flex flex-wrap gap-1">{row.tests.map((test) => <span key={test.label} className={`inline-block max-w-full truncate px-1 py-0.5 font-mono text-[10px] ${test.status === 'PASS' ? 'bg-emerald-50 text-emerald-700' : test.status === 'FAIL' || test.status === 'ERROR' ? 'bg-red-50 text-red-700' : 'bg-zinc-100 text-zinc-600'}`} title={test.label}>{test.label}</span>)}</div> : <span className="text-zinc-400" title={t('verification.run.unmappedHint')}>{t('verification.panorama.noTests')}</span>}</td>
            <td className="px-2 py-2"><span className={`inline-block px-1.5 py-0.5 text-[10px] font-semibold ${meta.cls}`}>{t(meta.labelKey)}</span></td>
            <td className="px-2 py-2 text-zinc-600" title={row.whyTitle}>{row.why === '—' ? <span className="text-zinc-300">—</span> : row.why}</td>
            <td className="px-2 py-2 text-zinc-600">{row.when === '—' ? <span className="text-zinc-300">—</span> : row.when}</td>
          </tr> })}
          {visible.length === 0 && <tr><td colSpan={6} className="px-2 py-6 text-center text-zinc-400">{t('verification.panorama.empty')}</td></tr>}
        </tbody>
      </table>
    </div>
    {filtered.length > PANORAMA_COLLAPSE_LIMIT && <button type="button" onClick={() => setExpanded((value) => !value)} className="mt-2 text-xs text-emerald-700 hover:underline">{collapsed ? t('verification.panorama.expandAll', { count: filtered.length }) : t('verification.panorama.collapse')}</button>}
  </section>
}

function Metric({ label, value, detail, tone = 'neutral', hint }: { label: string; value: string | number; detail: string; tone?: 'neutral' | 'good' | 'warn' | 'bad'; hint?: string }): React.JSX.Element {
  const color = tone === 'good' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : tone === 'bad' ? 'text-red-600' : 'text-zinc-900'
  return <div className="min-w-0 border-r border-zinc-200 px-4 last:border-r-0">
    <div className="text-xs text-zinc-500" title={hint}>{label}</div>
    <div className={`mt-1 text-2xl font-semibold ${color}`}>{value}</div>
    <div className="mt-1 truncate text-[11px] text-zinc-400" title={detail}>{detail}</div>
  </div>
}

/** 引擎账本折叠区块：默认收起，标题栏点击展开，统一带“技术细节”小字标识。 */
function CollapsibleSection({ title, subtitle, aside, children }: { title: string; subtitle?: string; aside?: React.ReactNode; children: React.ReactNode }): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return <section className="border-b border-zinc-200 bg-white">
    <button type="button" onClick={() => setOpen((value) => !value)} title={t(open ? 'verification.collapsible.collapse' : 'verification.collapsible.expand')} className="flex w-full items-center gap-2 px-5 py-3 text-left hover:bg-zinc-50">
      {open ? <ChevronDown size={15} className="shrink-0 text-zinc-400" /> : <ChevronRight size={15} className="shrink-0 text-zinc-400" />}
      <span className="text-sm font-semibold">{title}</span>
      <span className="shrink-0 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500">{t('verification.collapsible.technicalDetails')}</span>
      {subtitle && <span className="min-w-0 truncate text-xs text-zinc-400">{subtitle}</span>}
      {aside && <span className="ml-auto shrink-0">{aside}</span>}
    </button>
    {open && <div className="border-t border-zinc-100">{children}</div>}
  </section>
}

function statusTone(status: string): string {
  return CLOSED.has(status) ? 'bg-emerald-100 text-emerald-700' : status === 'FAILED' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'
}

function MiniStat({ label, value, tone = 'neutral' }: { label: string; value: number; tone?: 'neutral' | 'good' | 'warn' | 'bad' }): React.JSX.Element {
  const color = tone === 'good' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : tone === 'bad' ? 'text-red-600' : 'text-zinc-900'
  return <div className="min-w-24 rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-center">
    <div className={`text-lg font-semibold ${color}`}>{value}</div>
    <div className="text-[10px] text-zinc-500">{label}</div>
  </div>
}

/** 验证环境与用例执行（操作级视图）：独立于 AIGV 态势，缺少 AIGV 数据时也能查看。 */
function VerificationRunSection({ status }: { status: VerificationRunStatus | null }): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!status) return null
  const { environment, planned, executed, summary, headerWarning } = status
  const executedByTestId = new Map(executed.filter((e) => e.testId).map((e) => [e.testId, e]))
  const orphanExecuted = executed.filter((e) => !e.testId || !planned.some((p) => p.testId === e.testId))
  // 未执行/未映射的统一指引：如何建立 TEST ID 绑定
  const bindingHint = t('verification.run.bindingHint')
  const badge = (ex: VerificationRunStatus['executed'][number] | undefined): { label: string; cls: string; icon: React.JSX.Element } => {
    if (ex?.status === 'PASS') return { label: 'PASS', cls: 'bg-emerald-100 text-emerald-700', icon: <CheckCircle2 size={12} /> }
    if (ex?.status === 'FAIL') return { label: 'FAIL', cls: 'bg-red-100 text-red-700', icon: <XCircle size={12} /> }
    return { label: t('verification.run.notExecuted'), cls: 'bg-zinc-100 text-zinc-500', icon: <Circle size={12} /> }
  }
  return <section className="border-b border-zinc-200 bg-white p-5">
    <div className="mb-4 flex items-end justify-between gap-3">
      <div><h2 className="text-sm font-semibold">{t('verification.run.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.run.subtitle')}</p></div>
      <span className="shrink-0 text-[11px] text-zinc-400">{t('verification.run.summary', { planned: summary.planned, executed: summary.executed, passed: summary.passed, failed: summary.failed, notRun: summary.notRun })}{summary.bugsFound > 0 ? ` · ${t('verification.run.summaryBugs', { count: summary.bugsFound })}` : ''}</span>
    </div>
    <div className="mb-4 flex flex-wrap items-stretch gap-3">
      <div className={`min-w-64 rounded border px-4 py-3 ${environment.ready ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
        <div className="text-[11px] font-medium uppercase text-zinc-500">{t('verification.run.environment')}</div>
        <div className={`mt-1 text-lg font-semibold ${environment.ready ? 'text-emerald-700' : 'text-amber-700'}`}>{environment.ready ? t('verification.run.envReady') : t('verification.run.envNotReady')}</div>
        <div className="mt-1 text-[11px] text-zinc-500">{environment.testbenches.length > 0 ? environment.testbenches.join(t('verification.guidance.listJoin')) : environment.missing.join(t('verification.guidance.clauseJoin')) || t('verification.run.envPending')}</div>
      </div>
      <div className="flex flex-1 flex-wrap items-center gap-3">
        <MiniStat label={t('verification.run.planned')} value={summary.planned} />
        <MiniStat label={t('verification.run.executed')} value={summary.executed} />
        <MiniStat label={t('verification.run.passed')} value={summary.passed} tone="good" />
        <MiniStat label={t('verification.run.bugs')} value={summary.bugsFound} tone={summary.bugsFound ? 'bad' : 'good'} />
        <MiniStat label={t('verification.run.notRun')} value={summary.notRun} tone={summary.notRun ? 'warn' : 'good'} />
      </div>
    </div>
    <div className="max-h-96 overflow-auto border-y border-zinc-200">
      {headerWarning && <div className="border-b border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700">⚠ {headerWarning}</div>}
      <table className="w-full table-fixed text-left text-[11px]">
        <thead className="sticky top-0 bg-zinc-50 text-zinc-500"><tr>
          <th className="w-36 px-2 py-2 font-medium">TEST ID</th>
          <th className="w-40 px-2 py-2 font-medium">{t('verification.run.colTestName')}</th>
          <th className="w-16 px-2 py-2 font-medium">{t('verification.run.colPriority')}</th>
          <th className="w-28 px-2 py-2 font-medium">{t('verification.run.colEnvironment')}</th>
          <th className="w-20 px-2 py-2 font-medium">{t('verification.run.colStatus')}</th>
          <th className="px-2 py-2 font-medium">{t('verification.run.colResult')}</th>
        </tr></thead>
        <tbody>
          {planned.map((p) => {
            const ex = executedByTestId.get(p.testId)
            const b = badge(ex)
            return <tr key={p.testId} className="border-t border-zinc-100 align-top">
              <td className="px-2 py-2 font-mono text-zinc-700">{p.testId}</td>
              <td className="px-2 py-2 text-zinc-700">{p.name || '—'}</td>
              <td className="px-2 py-2 text-zinc-500">{p.priority || '—'}</td>
              <td className="px-2 py-2 font-mono text-zinc-500">{p.environment || '—'}</td>
              <td className="px-2 py-2" title={ex ? undefined : bindingHint}><span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold ${b.cls}`}>{b.icon}{b.label}</span></td>
              <td className="px-2 py-2 text-zinc-500">{ex?.status === 'FAIL' ? <span className="text-red-700">{ex.blocker && <span className="mr-1 rounded bg-red-50 px-1 py-0.5 font-mono text-[10px] text-red-600">{ex.blocker}</span>}{ex.errorMessage || t('verification.run.failed')}</span> : ex?.status === 'PASS' ? <span className="text-emerald-700">{t('verification.run.passed')}</span> : <span className="text-zinc-400" title={bindingHint}>{t('verification.run.notRunYet')}</span>}</td>
            </tr>
          })}
          {orphanExecuted.length > 0 && <tr className="border-t border-amber-100 bg-amber-50/60">
            <td colSpan={6} className="px-2 py-1.5 text-[10px] text-amber-700">{t('verification.run.orphanSummary', { count: orphanExecuted.length, hint: bindingHint })}</td>
          </tr>}
          {orphanExecuted.map((ex) => <tr key={ex.testName} className="border-t border-zinc-100 align-top">
            <td className="px-2 py-2 font-mono text-zinc-400" title={ex.testId ? bindingHint : t('verification.run.unmappedHint')}>{ex.testId || t('verification.run.unmapped')}</td>
            <td className="px-2 py-2 text-zinc-700">{ex.testName}</td>
            <td className="px-2 py-2 text-zinc-400">—</td>
            <td className="px-2 py-2 font-mono text-zinc-500">{ex.module}</td>
            <td className="px-2 py-2"><span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold ${ex.status === 'PASS' ? 'bg-emerald-100 text-emerald-700' : ex.status === 'FAIL' ? 'bg-red-100 text-red-700' : 'bg-zinc-100 text-zinc-500'}`}>{ex.status}</span></td>
            <td className="px-2 py-2 text-zinc-500">{ex.status === 'FAIL' ? <span className="text-red-700">{ex.blocker && <span className="mr-1 rounded bg-red-50 px-1 py-0.5 font-mono text-[10px] text-red-600">{ex.blocker}</span>}{ex.errorMessage || t('verification.run.failed')}</span> : ex.errorMessage || '—'}</td>
          </tr>)}
          {planned.length === 0 && executed.length === 0 && <tr><td colSpan={6} className="px-2 py-6 text-center text-zinc-400">{t('verification.run.empty')}</td></tr>}
        </tbody>
      </table>
    </div>
  </section>
}

export function VerificationPosturePage(): React.JSX.Element {
  const { projectId } = useParams({ from: '/verification-posture/$projectId' })
  const { t, locale } = useTranslation()
  const [project, setProject] = useState<ChipProject | null>(null)
  const [state, setState] = useState<VerificationState | null>(null)
  const [risks, setRisks] = useState<RiskMarker[]>([])
  const [diagnostic, setDiagnostic] = useState<DiagnosticControl | null>(null)
  const [runStatus, setRunStatus] = useState<VerificationRunStatus | null>(null)
  const [scenarioRows, setScenarioRows] = useState<PanoramaScenario[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [runningAction, setRunningAction] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState('')
  const [expandedModuleRisk, setExpandedModuleRisk] = useState<string | null>(null)
  const ensureAgent = useChatStore((store) => store.ensure)
  const sendAgentPrompt = useChatStore((store) => store.sendAndWait)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    // 操作级验证状态独立加载，不因 AIGV 态势缺失而失败
    try {
      setRunStatus(await window.moonglass.fs.verificationStatus(projectId))
    } catch { setRunStatus(null) }
    // 用例全景的场景数据源：posture 精简快照不含 scenarios，单独读 scenario-registry.json
    try {
      const registry = await window.moonglass.fs.readJson(projectId, 'verification/intelligence/scenario-registry.json') as { scenarios?: PanoramaScenario[] } | null
      setScenarioRows(Array.isArray(registry?.scenarios) ? registry.scenarios : [])
    } catch { setScenarioRows([]) }
    try {
      const current = await window.moonglass.project.get(projectId)
      setProject(current)
      let parsed: Partial<VerificationState> | null = null
      let parseError: unknown
      for (const statePath of ['verification/intelligence/verification-posture.json', 'verification/intelligence/verification-state.json']) {
        for (let attempt = 0; attempt < 5 && !parsed; attempt += 1) {
          try {
            parsed = await window.moonglass.fs.readJson(projectId, statePath) as Partial<VerificationState> | null
          } catch (caught) {
            parseError = caught
            if (attempt < 4) await pause(250 * (attempt + 1))
          }
        }
        // posture 是机器可读快照；被 Agent 手工覆盖成摘要时会缺失 verificationIntents，回退到完整 state.json
        if (parsed && Array.isArray(parsed.verificationIntents)) break
        parsed = null
      }
      if (!parsed) throw parseError instanceof Error ? parseError : new Error(t('verification.loadFailed'))
      setState({
        generatedAt: parsed.generatedAt ?? new Date(0).toISOString(), rtlHash: parsed.rtlHash ?? '', scenarioCount: parsed.scenarioCount ?? 0,
        criticalOpen: parsed.criticalOpen ?? [], verificationIntents: parsed.verificationIntents ?? [], specGaps: parsed.specGaps ?? [], coverageHoles: parsed.coverageHoles ?? [],
        regressions: parsed.regressions ?? [], formalResults: parsed.formalResults ?? [], closureAssessment: parsed.closureAssessment, verificationSpace: parsed.verificationSpace, explorationRound: parsed.explorationRound, explorationHistory: parsed.explorationHistory, multiOracle: parsed.multiOracle, mutationAssessment: parsed.mutationAssessment, residualRiskRegister: parsed.residualRiskRegister, signoffPackage: parsed.signoffPackage, moduleVerificationStrategy: parsed.moduleVerificationStrategy, structuralSummary: parsed.structuralSummary, analyzer: parsed.analyzer, waveProgress: parsed.waveProgress, executionClusters: parsed.executionClusters, executionPlan: parsed.executionPlan, specMapping: parsed.specMapping
      })
      try {
        const riskFile = await window.moonglass.fs.readJson(projectId, 'verification/intelligence/risk-register.json') as { risks?: RiskMarker[] } | null
        setRisks(riskFile?.risks ?? [])
      } catch { setRisks([]) }
      try {
        setDiagnostic(await window.moonglass.fs.readJson(projectId, 'verification/results/diagnostic-control.json') as DiagnosticControl)
      } catch { setDiagnostic(null) }
    } catch (caught) {
      setState(null); setRisks([]); setDiagnostic(null); setScenarioRows([])
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally { setLoading(false) }
  }, [projectId])

  useEffect(() => { void load() }, [load])

  const summary = useMemo(() => {
    const intents = state?.verificationIntents ?? []
    const closed = intents.filter((item) => CLOSED.has(item.status)).length
    const failedFormal = state?.formalResults?.filter((item) => item.status === 'FAIL' || item.status === 'ERROR').length ?? 0
    const failedRegression = state?.regressions?.filter((item) => !item.passed).length ?? 0
    const blockingHoles = state?.coverageHoles?.filter((item) => item.blocking).length ?? 0
    const highGaps = state?.specGaps?.filter((item) => item.confidence === 'high').length ?? 0
    const mutationBlocked = state?.mutationAssessment && state.mutationAssessment.status !== 'PASS' ? 1 : 0
    const residualBlocked = state?.residualRiskRegister?.filter((item) => item.approvalRequired && !item.approved).length ?? 0
    const blockers = (state?.criticalOpen.length ?? 0) + failedFormal + failedRegression + blockingHoles + mutationBlocked + residualBlocked
    return { intents: intents.length, closed, closure: intents.length ? Math.round(closed * 100 / intents.length) : 0, failedFormal, failedRegression, blockingHoles, highGaps, blockers }
  }, [state])

  const signoff = !state ? { label: t('verification.signoff.noDataLabel'), detail: t('verification.signoff.noDataDetail'), tone: 'warn' as const }
    : state.closureAssessment?.status === 'READY_FOR_HUMAN_SIGNOFF' ? { label: t('verification.signoff.awaitingHumanLabel'), detail: t('verification.signoff.awaitingHumanDetail'), tone: 'good' as const }
      : state.closureAssessment?.status === 'CONDITIONALLY_READY' ? { label: t('verification.signoff.conditionalLabel'), detail: t('verification.signoff.conditionalDetail', { count: state.closureAssessment.residualRisks.length + state.closureAssessment.warnings.length }), tone: 'warn' as const }
        : state.closureAssessment?.status === 'NOT_READY' ? { label: t('verification.signoff.notReadyLabel'), detail: t('verification.signoff.notReadyDetail', { count: state.closureAssessment.blockers.length }), tone: 'bad' as const }
    : summary.intents === 0 ? { label: t('verification.signoff.staleModelLabel'), detail: t('verification.signoff.staleModelDetail'), tone: 'warn' as const }
      : summary.blockers === 0 ? { label: t('verification.signoff.readyLabel'), detail: t('verification.signoff.readyDetail'), tone: 'good' as const }
      : { label: t('verification.signoff.notReadyLabel'), detail: t('verification.signoff.blockedDetail', { count: summary.blockers }), tone: 'bad' as const }

  // locale 变化时引导文案需重新推导（t 读取当前语言）
  const actions = useMemo(() => state ? deriveVerificationActions(state) : [], [state, locale])
  const topRisks = useMemo(() => state ? deriveTopRisks(state, risks) : [], [state, risks, locale])
  // Top 风险分组（易用性 Pack 2）：未处理风险按权重降序置顶；已接受（accepted）移入底部折叠区。
  // deriveTopRisks 输出本身按 riskScore 降序选取，分组保持该顺序，只改展示不改数据
  const openTopRisks = useMemo(() => topRisks.filter((item) => item.level !== 'accepted'), [topRisks])
  const acceptedTopRisks = useMemo(() => topRisks.filter((item) => item.level === 'accepted'), [topRisks])
  const steps = useMemo(() => deriveVerificationSteps(state), [state, locale])
  const primaryAction = actions[0]
  const specGaps = useMemo(() => (state?.specGaps ?? []).filter((gap) => !looksLikeGarbage(gap.title ?? '')), [state])
  const topIntents = useMemo(() => (state?.verificationIntents ?? []).slice(0, 15), [state])
  const topHoles = useMemo(() => {
    const holes = state?.coverageHoles ?? []
    return [...holes.filter((h) => h.blocking), ...holes.filter((h) => !h.blocking)].slice(0, 20)
  }, [state])
  const clauseRows = useMemo(() => {
    const sm = state?.specMapping
    if (!sm) return []
    const rows = sm.clauses?.length
      ? sm.clauses.map((c) => ({ specId: c.clauseId, clause: c.text, status: c.status }))
      : (sm.unmappedClause ?? []).map((c) => ({ specId: c.specId, clause: c.clause, status: 'UNMAPPED' as const }))
    // 未映射置顶，其余按 ID 排序
    return rows.sort((a, b) => (a.status === 'UNMAPPED' ? -1 : b.status === 'UNMAPPED' ? 1 : a.specId.localeCompare(b.specId)))
  }, [state])

  // L0 头条答案卡：一句话状态 + 等用户处理的事（规格澄清 / 残余风险审批）
  // 0 场景的波段视为"不适用"：后续波段已推进时，不能报"冒烟进行中"之类的误导 headline
  const waves = state?.waveProgress
  const wavesWithScenarios = waves?.some((wave) => (wave.scenarioCount ?? 0) > 0) ?? false
  const currentWave = wavesWithScenarios
    ? waves?.find((wave) => (wave.scenarioCount ?? 0) > 0 && wave.status !== 'done') ?? waves?.find((wave) => wave.status !== 'done')
    : waves?.find((wave) => wave.status !== 'done')
  // W1 多轮进度显式化：批次信息从 executionClusters + 场景闭环状态推导，不可得时只显示剩余数
  const w1Batch = useMemo(() => {
    if (!state?.executionClusters?.length || scenarioRows.length === 0) return null
    const closureOf = new Map(scenarioRows.map((item) => [item.id, item.state?.closure ?? 'OPEN']))
    const batches = state.executionClusters.filter((cluster) => (cluster.wave === 'smoke' ? 'basic' : cluster.wave ?? 'basic') === 'basic').flatMap((cluster) => cluster.executionBatches ?? [])
    if (batches.length === 0) return null
    const currentIndex = batches.findIndex((batch) => batch.some((id) => closureOf.get(id) === 'OPEN'))
    return { current: currentIndex === -1 ? batches.length : currentIndex + 1, total: batches.length }
  }, [state, scenarioRows])
  const l0Headline = currentWave && state?.specMapping
    ? currentWave.id === 'W1' && state.specMapping.clauseTotal > state.specMapping.coveredClause
      ? t('verification.l0.headlineW1', { wave: currentWave.label, covered: state.specMapping.coveredClause, total: state.specMapping.clauseTotal, remaining: state.specMapping.clauseTotal - state.specMapping.coveredClause, batch: w1Batch ? t('verification.l0.headlineW1Batch', { current: w1Batch.current, total: w1Batch.total }) : '' })
      : t('verification.l0.headline', { wave: currentWave.label, covered: state.specMapping.coveredClause, total: state.specMapping.clauseTotal })
    : `${signoff.label}：${signoff.detail}`
  const l0Pending = useMemo(() => {
    if (!state) return []
    const items: Array<{ id: string; label: string; hint: string; prompt: string }> = []
    // 规格待澄清 = 高置信度 Spec Gap（文档级 TBD）+ BLOCKED_BY_SPEC 场景（specMapping.blockedBySpecCount）
    const clarifyCount = specGaps.filter((gap) => gap.confidence === 'high').length + (state.specMapping?.blockedBySpecCount ?? 0)
    if (clarifyCount > 0) {
      items.push({
        id: 'l0-clarify-spec',
        label: t('verification.l0.clarifySpec', { count: clarifyCount }),
        hint: t('verification.l0.clarifySpecHint'),
        prompt: '请协助澄清规格：读取 verification/intelligence/spec-gap-register.json 中的高置信度规格缺口，以及 scenario-registry.json 中状态为 BLOCKED_BY_SPEC 的场景，逐条列出需要我决策的规格语义问题（给出可选答案与你的建议），等我逐条回答后更新追踪关系并重新生成验证态势；涉及外部可见语义变化的必须由我决策，不要自行猜测。'
      })
    }
    // 豁免待审批 = 残余风险登记册中 approvalRequired 且未批准项
    const residualPending = (state.residualRiskRegister ?? []).filter((item) => item.approvalRequired && !item.approved).length
    if (residualPending > 0) {
      items.push({
        id: 'l0-approve-residual',
        label: t('verification.l0.approveResidual', { count: residualPending }),
        hint: t('verification.terms.residualPending'),
        prompt: '请读取 residual-risk-register.json，列出所有待审批的残余风险（approvalRequired 且未批准），逐项说明风险点、影响与你的建议（补证据关闭或接受豁免），等我逐项决定；我确认接受的由具名审批人写入 signoff-approvals.json，然后重新生成验证态势。'
      })
    }
    return items
    // locale 变化时文案需重新推导
  }, [state, specGaps, locale])

  const runAction = useCallback(async (id: string, prompt: string) => {
    setRunningAction(id); setActionMessage(t('verification.action.connecting'))
    try {
      await ensureAgent(projectId)
      setActionMessage(t('verification.action.running'))
      await sendAgentPrompt(prompt)
      setActionMessage(t('verification.action.done'))
      await load()
    } catch (caught) {
      setActionMessage(t('verification.action.failed', { message: caught instanceof Error ? caught.message : String(caught) }))
    } finally { setRunningAction(null) }
  }, [ensureAgent, load, projectId, sendAgentPrompt, t])

  const heat = useMemo(() => Array.from({ length: 25 }, (_, index) => {
    const row = 4 - Math.floor(index / 5); const column = index % 5
    const items = risks.filter((risk) => Math.min(4, Math.floor(risk.structuralComplexity * 5)) === column && Math.min(4, Math.floor(risk.interaction * 5)) === row)
    return { row, column, items }
  }), [risks])

  // 模块风险分布：按 risk.object 分组，组内风险数降序（同数按组内最高 riskScore）取前 8，其余合并为一行
  const moduleRiskView = useMemo(() => {
    const byModule = new Map<string, RiskMarker[]>()
    for (const risk of risks) {
      const key = risk.object || t('verification.moduleRisks.unknownModule')
      const list = byModule.get(key) ?? []
      list.push(risk)
      byModule.set(key, list)
    }
    const groups = [...byModule.entries()].map(([module, items]) => ({
      key: module, module, items: [...items].sort((a, b) => b.riskScore - a.riskScore),
      maxScore: Math.max(...items.map((item) => item.riskScore))
    }))
    groups.sort((a, b) => b.items.length - a.items.length || b.maxScore - a.maxScore)
    const top = groups.slice(0, 8)
    const rest = groups.slice(8)
    const rows = rest.length > 0
      ? [...top, { key: '__rest__', module: t('verification.moduleRisks.rest', { modules: rest.length, count: rest.reduce((sum, group) => sum + group.items.length, 0) }), items: rest.flatMap((group) => group.items).sort((a, b) => b.riskScore - a.riskScore), maxScore: Math.max(...rest.map((group) => group.maxScore)) }]
      : top
    return { rows, maxCount: rows.reduce((max, row) => Math.max(max, row.items.length), 1) }
    // locale 变化时“其余/未标注”文案需重新推导
  }, [risks, locale])

  /** 模块风险清单内单条风险的 Agent 交接 prompt（与 deriveTopRisks 同一构造口径的精简版）。 */
  const moduleRiskPrompt = (risk: RiskMarker): string => `请处理验证风险 ${risk.id}。风险语义：${risk.riskStatement ?? `${risk.title}，对象 ${risk.object}`} 请读取关联 RTL、VI/SCN 和原始证据，执行定向仿真、Assertion 或 Formal，完成后重新生成验证态势。`

  /** Top 风险行（未处理列表与已接受折叠区共用）。 */
  const renderRiskRow = (item: ExplainedRisk, index: number): React.JSX.Element => <div key={item.risk.id} className="grid grid-cols-[28px_minmax(0,1fr)_auto] gap-3 py-3"><div className={`flex h-6 w-6 items-center justify-center text-xs font-semibold text-white ${item.level === 'confirmed' ? 'bg-red-600' : item.level === 'specGap' ? 'bg-amber-600' : item.level === 'accepted' ? 'bg-emerald-600' : 'bg-zinc-700'}`}>{index + 1}</div><div className="min-w-0"><div className="flex items-center gap-2"><strong className="text-sm">{item.risk.title}</strong><span className="shrink-0 bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600">{t(RISK_LEVEL_LABELS[item.level])}</span><span className="font-mono text-[10px] text-zinc-400">{item.risk.id}</span></div><p className="mt-1 text-xs text-zinc-700"><b>{t('verification.risks.risk')}</b>{item.risk.riskStatement}</p><div className="mt-1 text-[11px] text-zinc-500"><b>{t('verification.risks.object')}</b><span className="font-mono">{item.risk.object}</span>{item.risk.source?.file ? <span className="ml-1 text-zinc-400">（{item.risk.source.file}{item.risk.source.line ? `:${item.risk.source.line}` : ''}）</span> : null}</div><div className="mt-1 text-xs text-zinc-600"><b>{t('verification.risks.gap')}</b>{item.gap}</div><div className="mt-1 text-xs text-red-700"><b>{t('verification.risks.impact')}</b>{item.impact}</div><div className="mt-1 text-xs text-emerald-700"><b>{t('verification.risks.recommendation')}</b>{item.recommendation}</div></div><button disabled={runningAction !== null} onClick={() => void runAction(item.risk.id, item.prompt)} className="self-center rounded border border-zinc-300 p-2 text-zinc-500 hover:border-emerald-500 hover:text-emerald-700 disabled:opacity-40" title={t('verification.risks.handoff')}><Wrench size={15} /></button></div>

  return <div className="flex h-full min-h-0 flex-col bg-zinc-50 text-zinc-900">
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-zinc-200 bg-white px-5">
      <Link to="/workspace/$projectId" params={{ projectId }} className="flex items-center gap-1 text-sm text-zinc-500 hover:text-emerald-700"><ArrowLeft size={16} /> {t('verification.navWorkspace')}</Link>
      <div className="h-6 w-px bg-zinc-200" />
      <div className="min-w-0"><h1 className="truncate text-base font-semibold">{t('verification.title')}</h1><p className="truncate text-xs text-zinc-500">{project?.name ?? projectId} · AIGV Verification Digital Twin</p></div>
      <div className={`ml-auto flex items-center gap-2 text-sm font-medium ${signoff.tone === 'good' ? 'text-emerald-700' : signoff.tone === 'bad' ? 'text-red-700' : 'text-amber-700'}`}>
        {signoff.tone === 'good' ? <ShieldCheck size={18} /> : <AlertTriangle size={18} />} {signoff.label}
        <span className="text-xs font-normal text-zinc-400">{signoff.detail}</span>
      </div>
      <button onClick={() => void load()} disabled={loading} className="flex h-8 w-8 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-600 hover:border-emerald-500 hover:text-emerald-700" title={t('verification.refresh')}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
    </header>

    <main className="min-h-0 flex-1 overflow-auto">
    {state && <section className="border-b border-zinc-200 bg-white p-5">
        <div className="space-y-3 rounded border border-zinc-200 bg-zinc-50/60 p-4">
          <p className="text-base font-semibold text-zinc-900">{l0Headline}</p>
          <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2">
            <div className="text-xs font-semibold text-amber-800">{t('verification.l0.needYou')}</div>
            {l0Pending.length > 0 ? <div className="mt-1.5 flex flex-wrap gap-2">
              {l0Pending.map((item) => <button key={item.id} type="button" disabled={runningAction !== null} onClick={() => void runAction(item.id, item.prompt)} title={item.hint} className="inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 hover:border-amber-500 hover:bg-amber-100 disabled:opacity-50">{item.label}<ArrowRight size={12} /></button>)}
            </div> : <p className="mt-1 text-xs text-amber-700">{t('verification.l0.nothingForYou')}</p>}
          </div>
          <p className="text-xs text-zinc-600"><b className="text-zinc-700">{t('verification.l0.machineDoing')}</b>{primaryAction ? `${primaryAction.title} —— ${primaryAction.detail}` : t('verification.l0.machineIdle')}</p>
        </div>
      </section>}
    {state && <CasePanoramaSection state={state} scenarios={scenarioRows} runStatus={runStatus} />}
    <VerificationRunSection status={runStatus} />
    {!state ? <div className="flex min-h-64 items-center justify-center p-8"><div className="max-w-lg border border-dashed border-zinc-300 bg-white p-8 text-center">
      <FileSearch className="mx-auto text-zinc-400" size={30} /><h2 className="mt-3 text-base font-semibold">{t('verification.emptyTitle')}</h2>
      <p className="mt-2 text-sm text-zinc-500">{error || t('verification.emptyHint')}</p>
      <div className="mt-4 flex justify-center gap-2"><button onClick={() => void load()} className="rounded border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700 hover:border-emerald-500">{t('verification.reload')}</button><Link to="/workspace/$projectId" params={{ projectId }} className="inline-flex rounded bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-500">{t('verification.backToWorkspace')}</Link></div>
    </div></div> : <>
      {diagnostic && <section className={`border-b px-5 py-3 ${diagnostic.mode === 'DIAGNOSTIC_ENHANCEMENT' ? 'border-violet-200 bg-violet-50' : diagnostic.mode === 'CLOSED' ? 'border-emerald-200 bg-emerald-50' : 'border-sky-200 bg-sky-50'}`}><div className="flex items-start gap-4"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><strong className="text-sm">{t('verification.diagnostic.title')}</strong><span className="bg-white px-2 py-0.5 font-mono text-[10px] text-zinc-600">{diagnostic.mode}</span><span className="font-mono text-[10px] text-zinc-500">{diagnostic.activeCase}</span></div><p className="mt-1 text-xs text-zinc-600">{diagnostic.recommendation}</p></div><div className="shrink-0 text-right"><div className="text-lg font-semibold text-violet-700">{diagnostic.attempts.at(-1)?.diagnosticLevel ?? 'L0'}</div><div className="text-[10px] text-zinc-500">{t('verification.diagnostic.records', { count: diagnostic.attempts.length })}</div></div></div></section>}
      <section className={`border-b px-5 py-4 ${signoff.tone === 'good' ? 'border-emerald-200 bg-emerald-50' : signoff.tone === 'bad' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}>
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium uppercase text-zinc-500">{t('verification.progress.title')}</div>
            <p className="mt-1 text-sm text-zinc-700">
              {summary.intents === 0
                ? t('verification.progress.noIntents')
                : t('verification.progress.summary', { closed: summary.closed, intents: summary.intents, percent: summary.closure, critical: state.closureAssessment ? `${state.closureAssessment.metrics.criticalClosed}/${state.closureAssessment.metrics.criticalTotal}` : summary.closed })}
              <span className={summary.failedRegression + summary.failedFormal > 0 ? 'text-red-700' : 'text-emerald-700'}>{summary.failedRegression + summary.failedFormal > 0 ? ` ${t('verification.progress.failures', { count: summary.failedRegression + summary.failedFormal })}` : ` ${t('verification.progress.noFailures')}`}</span>
              <span className="text-zinc-500">{summary.highGaps ? ` ${t('verification.progress.specGaps', { count: summary.highGaps })}` : ''}{summary.blockingHoles ? ` ${t('verification.progress.blockingHoles', { count: summary.blockingHoles })}` : ''}</span>
            </p>
            <p className="mt-1 text-sm text-zinc-600">{t('verification.progress.nextStep')}<b>{primaryAction?.title ?? t('verification.progress.generatePlan')}</b>{primaryAction ? ` —— ${primaryAction.detail}` : ''}</p>
          </div>
          {primaryAction && <button disabled={runningAction !== null} onClick={() => void runAction(primaryAction.id, primaryAction.prompt)} className="inline-flex h-10 shrink-0 items-center gap-2 rounded bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"><Play size={16} />{runningAction === primaryAction.id ? t('verification.agentRunning') : primaryAction.title}<ArrowRight size={15} /></button>}
        </div>
        {actionMessage && <div className="mt-3 border-t border-black/10 pt-2 text-xs text-zinc-600">{actionMessage}</div>}
        {state.closureAssessment && <div className="mt-3 grid grid-cols-2 gap-4 border-t border-black/10 pt-3 text-xs"><div><b className="text-zinc-700">{t('verification.progress.machineBlockers')}</b><div className="mt-1 space-y-1 text-zinc-600">{state.closureAssessment.blockers.slice(0, 4).map((item) => <div key={item}>• {item}</div>)}{state.closureAssessment.blockers.length === 0 && <div className="text-emerald-700">{t('verification.progress.noMachineBlockers')}</div>}</div></div><div><b className="text-zinc-700">{t('verification.progress.aigvNext')}</b><div className="mt-1 space-y-1 text-zinc-600">{state.closureAssessment.nextActions.slice(0, 4).map((item) => <div key={item}>→ {item}</div>)}</div></div></div>}
      </section>

      <section className="border-b border-zinc-200 bg-white px-5 py-4"><div className="mb-3 flex items-end justify-between"><div><h2 className="text-sm font-semibold">{state.waveProgress ? t('verification.steps.titleWaves') : t('verification.steps.titleLegacy')}</h2><p className="mt-1 text-xs text-zinc-500">{state.waveProgress ? t('verification.steps.subtitleWaves') : t('verification.steps.subtitleLegacy')}</p></div><span className="text-xs text-zinc-400">{t('verification.progress.nextStep')}{primaryAction?.title ?? t('verification.steps.keepEvidence')}</span></div><div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>{steps.map((step, index) => <div key={step.id} className="relative min-w-0 border-t-2 pt-2" style={{ borderColor: step.status === 'completed' ? '#10b981' : step.status === 'blocked' ? '#ef4444' : step.status === 'running' ? '#f59e0b' : '#d4d4d8' }}><div className="flex items-center gap-1.5"><span className={`h-2 w-2 shrink-0 rounded-full ${step.status === 'completed' ? 'bg-emerald-500' : step.status === 'blocked' ? 'bg-red-500' : step.status === 'running' ? 'bg-amber-500' : 'bg-zinc-300'}`} /><strong className="truncate text-xs">{step.label}</strong>{index < steps.length - 1 && <ArrowRight size={12} className="ml-auto text-zinc-300" />}</div><div className="mt-1 truncate text-[10px] text-zinc-500" title={step.title ?? step.detail}>{step.detail}</div></div>)}</div></section>
      {state.specMapping && <section className="border-b border-zinc-200 bg-white px-5 py-4"><div className="mb-3 flex items-end justify-between"><div><h2 className="text-sm font-semibold">{t('verification.mapping.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.mapping.subtitle')}</p></div><span className={`text-sm font-semibold ${state.specMapping.coveredClause === state.specMapping.clauseTotal ? 'text-emerald-700' : 'text-amber-700'}`}>{t('verification.mapping.completeness', { covered: state.specMapping.coveredClause, total: state.specMapping.clauseTotal })}{typeof state.specMapping.documentaryCount === 'number' ? ` · ${t('verification.mapping.documentary', { count: state.specMapping.documentaryCount })}` : ''}</span></div>{clauseRows.length > 0 ? <div className="max-h-[28rem] overflow-auto border-y border-zinc-200"><table className="w-full table-fixed text-left text-xs"><thead className="sticky top-0 bg-zinc-50 text-zinc-500"><tr><th className="w-24 px-2 py-2 font-medium">{t('verification.mapping.colStatus')}</th><th className="w-44 px-2 py-2 font-medium">{t('verification.mapping.colClauseId')}</th><th className="px-2 py-2 font-medium">{t('verification.mapping.colClause')}</th></tr></thead><tbody>{clauseRows.map((clause) => { const badge = CLAUSE_STATUS_LABELS[clause.status]; return <tr key={clause.specId} className="border-t border-zinc-100 align-top"><td className="px-2 py-1.5"><span className={`inline-block px-1.5 py-0.5 text-[10px] font-semibold ${badge?.cls ?? 'bg-zinc-100 text-zinc-600'}`}>{badge ? t(badge.labelKey) : clause.status}</span></td><td className="px-2 py-1.5 font-mono text-zinc-700">{clause.specId}</td><td className="px-2 py-1.5 text-zinc-600" title={clause.clause}>{clause.clause}</td></tr>})}</tbody></table></div> : <div className="flex items-center gap-2 px-2 py-4 text-sm text-emerald-700"><CheckCircle2 size={16} />{t('verification.mapping.allMapped')}</div>}</section>}

      {state.verificationSpace && <CollapsibleSection title={t('verification.space.title')} aside={<span className="font-mono text-[10px] text-zinc-400">{state.verificationSpace.snapshotId}</span>}>
        <div className="grid grid-cols-[1.3fr_repeat(6,minmax(80px,0.7fr))] bg-zinc-900 px-5 py-3 text-white"><div className="min-w-0"><div className="text-[10px] text-zinc-400">Verification Space Snapshot</div><div className="truncate font-mono text-xs text-emerald-300">{state.verificationSpace.snapshotId}</div><div className="mt-1 text-[10px] text-zinc-400">{t('verification.space.round', { round: state.explorationRound?.roundId ?? '-', selected: state.explorationRound?.selectedScenarioIds.length ?? 0, cost: state.explorationRound?.expectedCostSeconds ?? 0 })}</div><div title={state.explorationHistory?.saturation.status === 'EMPIRICALLY_SATURATED' ? t('verification.terms.explorationSaturated') : undefined} className={`mt-1 text-[10px] ${state.explorationHistory?.saturation.status === 'STALLED' ? 'text-red-300' : state.explorationHistory?.saturation.status === 'EMPIRICALLY_SATURATED' ? 'text-emerald-300' : 'text-amber-300'}`}>{t('verification.space.exploration', { status: state.explorationHistory?.saturation.status ?? t('verification.space.statusNone'), explanation: state.explorationHistory?.saturation.explanation ?? t('verification.space.explanationNone') })}</div></div>{[[t('verification.space.candidates'), state.verificationSpace.candidateCount], ['Negative', state.verificationSpace.negativeCount], ['Feature', state.verificationSpace.dimensions.features], ['Boundary', state.verificationSpace.dimensions.boundaries], ['Interaction', state.verificationSpace.dimensions.interactions], ['State', state.verificationSpace.dimensions.systemStates]].map(([label, value]) => <div key={String(label)} className="border-l border-zinc-700 px-3"><div className="text-[10px] text-zinc-400">{label}</div><div className="mt-1 text-lg font-semibold">{value}</div></div>)}</div>
      </CollapsibleSection>}

      <div className="grid grid-cols-[minmax(520px,1.25fr)_minmax(360px,0.75fr)] gap-px border-b border-zinc-200 bg-zinc-200">
        <section className="bg-white p-5"><div className="mb-3"><h2 className="text-sm font-semibold">{t('verification.risks.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.risks.subtitle')}</p></div><div className="divide-y divide-zinc-100 border-y border-zinc-200">{openTopRisks.map(renderRiskRow)}{openTopRisks.length === 0 && <div className="py-8 text-center text-sm text-zinc-400">{acceptedTopRisks.length > 0 ? t('verification.risks.allAccepted') : t('verification.risks.empty')}</div>}</div>{acceptedTopRisks.length > 0 && <details className="mt-3 rounded border border-zinc-200"><summary className="cursor-pointer px-3 py-2 text-xs font-medium text-zinc-600 hover:bg-zinc-50">{t('verification.risks.acceptedTitle', { count: acceptedTopRisks.length })}</summary><div className="divide-y divide-zinc-100 border-t border-zinc-200 px-3">{acceptedTopRisks.map(renderRiskRow)}</div></details>}</section>
        <section className="bg-white p-5"><div className="mb-3"><h2 className="text-sm font-semibold">{t('verification.actions.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.actions.subtitle')}</p></div><div className="divide-y divide-zinc-100 border-y border-zinc-200">{actions.map((action) => <button key={action.id} disabled={runningAction !== null} onClick={() => void runAction(action.id, action.prompt)} className="flex w-full items-start gap-3 py-3 text-left hover:bg-zinc-50 disabled:opacity-50"><span className={`mt-0.5 px-1.5 py-0.5 text-[10px] font-semibold ${action.priority === 'P0' ? 'bg-red-100 text-red-700' : action.priority === 'P1' ? 'bg-amber-100 text-amber-700' : 'bg-zinc-100 text-zinc-600'}`}>{action.priority}</span><span className="min-w-0 flex-1"><strong className="block text-xs text-zinc-800">{action.title}</strong><span className="mt-1 block text-[11px] text-zinc-500">{action.detail}</span></span><ArrowRight size={14} className="mt-1 shrink-0 text-zinc-400" /></button>)}</div></section>
      </div>

      <section className="grid grid-cols-9 border-b border-zinc-200 bg-white py-4">
        <Metric label={t('verification.metrics.overall')} value={signoff.label} detail={signoff.detail} tone={signoff.tone} />
        <Metric label={t('verification.metrics.intentClosure')} value={`${summary.closure}%`} detail={t('verification.metrics.intentClosureDetail', { closed: summary.closed, intents: summary.intents })} tone={summary.closure === 100 ? 'good' : summary.closure >= 80 ? 'warn' : 'bad'} />
        <Metric label={t('verification.metrics.criticalClosure')} hint={t('verification.terms.impactUnknown')} value={state.closureAssessment ? `${state.closureAssessment.metrics.criticalClosurePercent}%` : state.criticalOpen.length} detail={state.closureAssessment ? t('verification.metrics.criticalDetail', { closed: state.closureAssessment.metrics.criticalClosed, total: state.closureAssessment.metrics.criticalTotal }) : t('verification.metrics.criticalOpen')} tone={state.closureAssessment ? (state.closureAssessment.metrics.criticalClosurePercent === 100 ? 'good' : 'bad') : state.criticalOpen.length ? 'bad' : 'good'} />
        <Metric label={t('verification.metrics.specGap')} value={state.specGaps.length} detail={t('verification.metrics.highConfidence', { count: summary.highGaps })} tone={summary.highGaps ? 'warn' : 'good'} />
        <Metric label={t('verification.metrics.coverageHole')} value={state.coverageHoles.length} detail={t('verification.metrics.blocking', { count: summary.blockingHoles })} tone={summary.blockingHoles ? 'bad' : 'good'} />
        <Metric label={t('verification.metrics.multiOracle')} value={state.multiOracle ? `${state.multiOracle.assessments.filter((item) => item.status === 'PASS').length}/${state.multiOracle.assessments.length}` : '-'} detail={state.multiOracle ? t('verification.metrics.oracleDetail', { insufficient: state.multiOracle.criticalInsufficient.length, conflicts: state.multiOracle.conflicts.length }) : t('verification.metrics.legacy')} tone={state.multiOracle && state.multiOracle.criticalInsufficient.length === 0 && state.multiOracle.conflicts.length === 0 ? 'good' : 'bad'} />
        <Metric label={t('verification.metrics.mutation')} hint={t('verification.terms.mutationSurvived')} value={state.mutationAssessment?.weightedScore == null ? '-' : `${Math.round(state.mutationAssessment.weightedScore * 100)}%`} detail={state.mutationAssessment ? t('verification.metrics.mutationDetail', { killed: state.mutationAssessment.killedCount, valid: state.mutationAssessment.validCount, status: state.mutationAssessment.status }) : t('verification.metrics.noResult')} tone={state.mutationAssessment?.status === 'PASS' ? 'good' : 'bad'} />
        <Metric label={t('verification.metrics.formal')} value={state.formalResults.length} detail={t('verification.metrics.formalFailed', { count: summary.failedFormal })} tone={summary.failedFormal ? 'bad' : 'good'} />
        <Metric label={t('verification.metrics.regression')} value={state.regressions.length} detail={t('verification.metrics.regressionFailed', { count: summary.failedRegression })} tone={summary.failedRegression ? 'bad' : 'good'} />
      </section>

      {state.moduleVerificationStrategy && <CollapsibleSection title={t('verification.strategy.title')} subtitle={t('verification.strategy.subtitle')} aside={<span className="flex gap-4 text-[11px]"><span>{t('verification.strategy.signoff')} <b className="text-emerald-700">{state.moduleVerificationStrategy.summary.IP_SIGNOFF}</b></span><span>{t('verification.strategy.focused')} <b className="text-red-700">{state.moduleVerificationStrategy.summary.UNIT_FOCUSED}</b></span><span>{t('verification.strategy.smoke')} <b className="text-amber-700">{state.moduleVerificationStrategy.summary.UNIT_SMOKE}</b></span><span>{t('verification.strategy.static')} <b className="text-zinc-700">{state.moduleVerificationStrategy.summary.STATIC_ONLY}</b></span></span>}>
        <div className="p-5 pt-4"><div className="max-h-96 overflow-auto border-y border-zinc-200"><table className="w-full table-fixed text-left text-[11px]"><thead className="sticky top-0 bg-zinc-50 text-zinc-500"><tr><th className="w-44 px-2 py-2 font-medium">{t('verification.strategy.colModule')}</th><th className="w-28 px-2 py-2 font-medium">{t('verification.strategy.colLevel')}</th><th className="w-28 px-2 py-2 font-medium">{t('verification.strategy.colRole')}</th><th className="w-60 px-2 py-2 font-medium">{t('verification.strategy.colOracle')}</th><th className="px-2 py-2 font-medium">{t('verification.strategy.colGolden')}</th></tr></thead><tbody>{state.moduleVerificationStrategy.modules.map((plan) => <tr key={plan.module} className="border-t border-zinc-100 align-top"><td className="px-2 py-2"><strong className="font-mono text-zinc-800">{plan.module}</strong><div className="mt-1 text-[10px] text-zinc-400">{plan.standaloneTestbench ? t('verification.strategy.standaloneTb') : t('verification.strategy.reuseTop')}</div></td><td className="px-2 py-2"><span className={`px-1.5 py-0.5 font-semibold ${plan.level === 'IP_SIGNOFF' ? 'bg-emerald-100 text-emerald-700' : plan.level === 'UNIT_FOCUSED' ? 'bg-red-100 text-red-700' : plan.level === 'UNIT_SMOKE' ? 'bg-amber-100 text-amber-700' : 'bg-zinc-100 text-zinc-600'}`}>{plan.level}</span></td><td className="px-2 py-2 text-zinc-600"><div>{plan.role}</div><div className="mt-1 font-mono text-zinc-400">{plan.riskScore.toFixed(3)}</div></td><td className="px-2 py-2 text-zinc-600">{plan.oracleStrategies.length ? plan.oracleStrategies.join(' + ') : t('verification.strategy.staticRules')}</td><td className="px-2 py-2"><div className={plan.goldenModel.recommendation === 'RECOMMENDED' ? 'font-semibold text-emerald-700' : plan.goldenModel.recommendation === 'OPTIONAL' ? 'font-medium text-amber-700' : 'text-zinc-500'}>{plan.goldenModel.recommendation}</div><div className="mt-1 text-zinc-500">{plan.goldenModel.rationale}</div><div className="mt-1 text-[10px] text-zinc-400">{plan.reasons.join(' ')}</div></td></tr>)}</tbody></table></div></div>
      </CollapsibleSection>}

      <section className="border-b border-zinc-200 bg-white p-5">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div><h2 className="text-sm font-semibold">{t('verification.moduleRisks.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.moduleRisks.subtitle')}</p></div>
          <span className="shrink-0 text-xs text-zinc-400">{t('verification.heat.count', { count: risks.length })}</span>
        </div>
        {moduleRiskView.rows.length === 0 ? <div className="border border-dashed border-zinc-200 py-8 text-center text-sm text-zinc-400">{t('verification.moduleRisks.empty')}</div> : <div className="divide-y divide-zinc-100 border-y border-zinc-200">
          {moduleRiskView.rows.map((row) => {
            const expanded = expandedModuleRisk === row.key
            const topRisk = row.items[0]
            const barCls = row.maxScore >= 0.7 ? 'bg-red-500' : row.maxScore >= 0.4 ? 'bg-amber-400' : 'bg-zinc-300'
            return <div key={row.key}>
              <button type="button" onClick={() => setExpandedModuleRisk(expanded ? null : row.key)} title={t(expanded ? 'verification.moduleRisks.collapse' : 'verification.moduleRisks.expand')} className="flex w-full items-center gap-3 py-2 text-left hover:bg-zinc-50">
                <span className="w-44 shrink-0 truncate font-mono text-xs text-zinc-800" title={row.module}>{row.module}</span>
                <span className="flex h-3 min-w-0 flex-1 items-center"><span className={`h-3 rounded-sm ${barCls}`} style={{ width: `${Math.max(3, Math.round(row.items.length * 100 / moduleRiskView.maxCount))}%` }} /></span>
                <span className="w-8 shrink-0 text-right text-xs text-zinc-600">{row.items.length}</span>
                <span className="w-64 shrink-0 truncate text-xs text-zinc-500" title={topRisk?.title}>{topRisk?.title}</span>
                {expanded ? <ChevronDown size={14} className="shrink-0 text-zinc-400" /> : <ChevronRight size={14} className="shrink-0 text-zinc-400" />}
              </button>
              {expanded && <div className="divide-y divide-zinc-100 border-t border-zinc-100 bg-zinc-50/50 px-3">
                {row.items.map((risk) => <div key={risk.id} className="flex items-center gap-3 py-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-zinc-700" title={risk.title}>{risk.title}</span>
                  <span className="shrink-0 font-mono text-[10px] text-zinc-400">{risk.id}</span>
                  <span className={`shrink-0 font-mono text-[11px] ${risk.riskScore >= 0.7 ? 'text-red-600' : risk.riskScore >= 0.4 ? 'text-amber-600' : 'text-zinc-500'}`}>{risk.riskScore.toFixed(3)}</span>
                  <button type="button" disabled={runningAction !== null} onClick={() => void runAction(risk.id, moduleRiskPrompt(risk))} className="shrink-0 rounded border border-zinc-300 p-1.5 text-zinc-500 hover:border-emerald-500 hover:text-emerald-700 disabled:opacity-40" title={t('verification.risks.handoff')}><Wrench size={13} /></button>
                </div>)}
              </div>}
            </div>
          })}
        </div>}
      </section>

      <CollapsibleSection title={t('verification.heat.title')} subtitle={t('verification.heat.subtitle')} aside={<span className="text-xs text-zinc-400">{t('verification.heat.count', { count: risks.length })}</span>}>
        <div className="p-5 pt-4">
          {risks.length === 0 ? <div className="py-4 text-center text-sm text-zinc-400">{t('verification.moduleRisks.empty')}</div> : <div title={t('verification.heat.axesHint')} className="grid max-w-2xl grid-cols-[52px_repeat(5,minmax(54px,1fr))] gap-1 text-center text-[10px]">
            <div />{HEAT_LEVEL_KEYS.map((key) => <div key={key} className="pb-1 text-zinc-400">{t(key)}</div>)}
            {heat.map((cell, index) => <div key={index} className="contents">
              {cell.column === 0 && <div className="flex items-center justify-end pr-2 text-zinc-400">{t(HEAT_LEVEL_KEYS[cell.row])}</div>}
              <div title={cell.items.map((item) => `${item.id} ${item.title} ${item.object}`).join('\n') || t('verification.heat.none')} className={`flex h-12 items-center justify-center border ${cell.items.length === 0 ? 'border-zinc-100 bg-zinc-50 text-zinc-300' : cell.items.length >= 4 ? 'border-red-500 bg-red-500 text-white' : cell.items.length >= 2 ? 'border-amber-400 bg-amber-300 text-amber-950' : 'border-emerald-300 bg-emerald-100 text-emerald-800'}`}>{cell.items.length}</div>
            </div>)}
          </div>}
        </div>
      </CollapsibleSection>

      <section className="border-b border-zinc-200 bg-white p-5"><h2 className="text-sm font-semibold">{t('verification.blockers.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.blockers.subtitle')}</p>
        <div className="mt-4 max-h-72 overflow-auto border-y border-zinc-200">
          {state.criticalOpen.map((id) => <div key={id} className="flex items-center gap-2 border-b border-zinc-100 px-2 py-2 text-xs"><XCircle size={14} className="text-red-500" /><strong className="font-mono text-red-700">{id}</strong><span className="text-zinc-500">{t('verification.blockers.criticalOpen')}</span></div>)}
          {state.coverageHoles.filter((item) => item.blocking).map((hole) => <div key={hole.id} className="flex items-center gap-2 border-b border-zinc-100 px-2 py-2 text-xs"><AlertTriangle size={14} className="text-amber-500" /><strong className="font-mono text-amber-700" title={HOLE_EXPLANATIONS[hole.classification] ? t(HOLE_EXPLANATIONS[hole.classification]) : undefined}>{HOLE_LABELS[hole.classification] ? t(HOLE_LABELS[hole.classification]) : hole.classification}</strong><span className="min-w-0 flex-1 truncate text-zinc-500" title={hole.reason}>{hole.scenarioId} · {hole.reason}</span></div>)}
          {(state.residualRiskRegister ?? []).filter((item) => item.approvalRequired && !item.approved).map((risk) => <div key={risk.id} className="flex items-center gap-2 border-b border-zinc-100 px-2 py-2 text-xs" title={t('verification.terms.residualPending')}><AlertTriangle size={14} className="text-violet-500" /><strong className="font-mono text-violet-700">{risk.id}</strong><span className="min-w-0 flex-1 truncate text-zinc-500" title={risk.impact}>{risk.title} · {t('verification.blockers.notApproved')}</span></div>)}
          {summary.blockers === 0 && <div className="flex items-center gap-2 px-2 py-6 text-sm text-emerald-700"><CheckCircle2 size={16} />{t('verification.blockers.empty')}</div>}
        </div>
      </section>

      <section className="bg-white p-5"><div className="mb-3 flex items-end justify-between"><div><h2 className="text-sm font-semibold">{t('verification.intents.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.intents.subtitle')}</p></div><span className="text-xs text-zinc-400">{state.verificationIntents.length > 15 ? t('verification.intents.showing', { total: state.verificationIntents.length }) : t('verification.intents.count', { total: state.verificationIntents.length })} · RTL {state.rtlHash.slice(0, 10)}</span></div>
        <div className="max-h-[620px] overflow-auto border-y border-zinc-200">{topIntents.map((intent) => <article key={intent.id} className="border-b border-zinc-100 p-4"><div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><strong className="font-mono text-xs text-emerald-700">{intent.id}</strong><span className="font-mono text-[10px] text-zinc-400">{intent.scenarioId}</span><span className={`px-2 py-0.5 text-[10px] ${statusTone(intent.status)}`} title={intent.status === 'BLOCKED_BY_SPEC' ? t('verification.terms.blockedBySpec') : undefined}>{intent.status}</span><span className="text-[10px] text-sky-700">{intent.recommendedMethods.join(' + ')}</span></div><h3 className="mt-2 text-sm font-semibold leading-6 text-zinc-800">{intent.objective}</h3>{intent.failureMode && <p className="mt-1 text-xs text-red-700"><b>{t('verification.intents.failureMode')}</b>{intent.failureMode}</p>}</div><span className="font-mono text-xs text-zinc-500">P={intent.priority.toFixed(3)}</span></div><div className="mt-3 grid grid-cols-3 gap-4 text-[11px]"><div><b className="text-zinc-700">{t('verification.intents.stimulus')}</b><ol className="mt-1 list-decimal space-y-1 pl-4 text-zinc-500">{(intent.stimulusProcedure ?? intent.preconditions ?? []).map((item) => <li key={item}>{item}</li>)}</ol></div><div><b className="text-zinc-700">{t('verification.intents.observation')}</b><ul className="mt-1 list-disc space-y-1 pl-4 text-zinc-500">{(intent.observationPoints ?? []).map((item) => <li key={item}>{item}</li>)}</ul></div><div><b className="text-zinc-700">{t('verification.intents.passCriteria')}</b><ul className="mt-1 list-disc space-y-1 pl-4 text-zinc-500">{(intent.passCriteria ?? intent.expectedResults ?? []).map((item) => <li key={item}>{item}</li>)}</ul></div></div><div className="mt-3 text-[10px] text-zinc-400">{t('verification.intents.footer', { boundaries: intent.boundaries?.length ?? 0, evidence: intent.evidence.length, sources: (intent.sourceIds ?? []).join(', ') || t('verification.intents.sourcesNone') })}</div></article>)}</div>
      </section>

      <div className="grid grid-cols-2 gap-px border-t border-zinc-200 bg-zinc-200">
        <section className="bg-white p-5"><h2 className="text-sm font-semibold">{t('verification.gaps.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.gaps.subtitle')}</p><div className="mt-3 max-h-80 overflow-auto border-y border-zinc-200">{specGaps.map((gap) => <div key={gap.id} className="border-b border-zinc-100 px-2 py-3"><div className="flex items-center gap-2"><strong className="font-mono text-xs text-amber-700">{gap.id}</strong><span className="bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">{SPEC_GAP_CATEGORY_LABELS[gap.category] ? t(SPEC_GAP_CATEGORY_LABELS[gap.category]) : gap.category}</span><span className="ml-auto text-[10px] text-zinc-400">{gap.confidence}</span></div><div className="mt-1 text-xs font-medium text-zinc-700">{gap.title}</div><div className="mt-1 text-[11px] text-zinc-500">{t('verification.gaps.impact')}{gap.impact}</div><div className="mt-1 text-[11px] text-emerald-700">{t('verification.gaps.action')}{gap.action}</div>{gap.sources?.[0] && <div className="mt-1 font-mono text-[10px] text-zinc-400">{gap.sources[0].file}{gap.sources[0].line ? `:${gap.sources[0].line}` : ''}</div>}</div>)}{specGaps.length === 0 && <div className="p-6 text-sm text-emerald-700">{t('verification.gaps.empty')}</div>}</div></section>
        <section className="bg-white p-5"><h2 className="text-sm font-semibold">{t('verification.holes.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.holes.subtitle')}{state.coverageHoles.length > 20 ? t('verification.holes.showingFirst', { total: state.coverageHoles.length }) : ''}</p><div className="mt-3 max-h-[520px] overflow-auto border-y border-zinc-200">{topHoles.map((hole) => <div key={hole.id} className="border-b border-zinc-100 px-2 py-3"><div className="flex items-center gap-2"><strong className={`text-xs ${hole.blocking ? 'text-red-700' : 'text-amber-700'}`} title={HOLE_EXPLANATIONS[hole.classification] ? t(HOLE_EXPLANATIONS[hole.classification]) : undefined}>{HOLE_LABELS[hole.classification] ? t(HOLE_LABELS[hole.classification]) : hole.classification}</strong><span className="font-mono text-[10px] text-zinc-400">{hole.scenarioId}</span><span className="ml-auto text-[10px] text-zinc-400">{hole.confidence}</span></div><div className="mt-1 text-xs font-medium text-zinc-700">{hole.missingTarget ?? hole.scenarioTitle ?? hole.reason}</div><div className="mt-2 text-[11px] text-zinc-500"><b>{t('verification.holes.stimulus')}</b>{hole.requiredStimulus?.join(t('verification.guidance.clauseJoin')) ?? hole.recommendedAction}</div><div className="mt-1 text-[11px] text-zinc-500"><b>{t('verification.holes.observation')}</b>{hole.requiredObservation?.join(t('verification.guidance.clauseJoin')) ?? t('verification.holes.observationFallback')}</div><div className="mt-1 text-[11px] text-emerald-700"><b>{t('verification.holes.closure')}</b>{hole.closureEvidence?.join(t('verification.guidance.clauseJoin')) ?? t('verification.holes.closureFallback')}</div></div>)}{state.coverageHoles.length === 0 && <div className="p-6 text-sm text-emerald-700">{t('verification.holes.empty')}</div>}</div></section>
      </div>

      <CoverageDetailPanel projectId={projectId} regressions={state.regressions} />

      <footer className="flex items-center gap-5 border-t border-zinc-200 bg-zinc-100 px-5 py-2 text-[10px] text-zinc-500"><span>{t('verification.footer.generatedAt')}{new Date(state.generatedAt).toLocaleString()}</span><span>{t('verification.footer.analyzer')}{state.analyzer?.engine ?? t('verification.footer.analyzerUnknown')} {state.analyzer?.version ?? ''}</span><span>FSM {state.structuralSummary?.fsm ?? 0}</span><span>CFG {state.structuralSummary?.cfgNodes ?? 0}</span><span>COI {state.structuralSummary?.cones ?? 0}</span>{state.signoffPackage && <span className="font-mono text-emerald-700">{state.signoffPackage.packageId}</span>}{state.verificationIntents.length === 0 && <span className="text-amber-600">{t('verification.footer.legacyModel')}</span>}</footer>
    </>}
    </main>
  </div>
}
