import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Circle, FileSearch, Play, RefreshCw, ShieldCheck, Wrench, XCircle } from 'lucide-react'
import type { ChipProject, SpecMapping, VerificationRunStatus, WaveProgressEntry } from '@shared/types'
import { useChatStore } from '../store/chatStore'
import { deriveTopRisks, deriveVerificationActions, deriveVerificationSteps, type ExplainedRisk } from '../verification-guidance'
import { useTranslation, type MessageKey } from '../i18n'

interface RiskMarker { id: string; taxonomyId?: string; title: string; riskStatement?: string; rationale?: string; failureModes?: string[]; observableEffects?: string[]; object: string; features: string[]; structuralComplexity: number; interaction: number; riskScore: number; confidence: string; source: { file: string; line?: number } }
interface SpecGap { id: string; category: string; title: string; description?: string; impact: string; action: string; confidence: string; requirementIds: string[]; rtlObjects: string[]; sources?: Array<{ file: string; line?: number }> }
interface Intent { id: string; scenarioId: string; objective: string; rationale?: string; failureMode?: string; sourceIds?: string[]; status: string; priority: number; recommendedMethods: string[]; preconditions?: string[]; stimulusProcedure?: string[]; observationPoints?: string[]; expectedResults?: string[]; passCriteria?: string[]; boundaries: Array<{ object: string; values: string[] }>; evidence: string[] }
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
  specMapping?: SpecMapping
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
const RISK_LEVEL_LABELS: Record<ExplainedRisk['level'], MessageKey> = {
  confirmed: 'verification.riskLevels.confirmed',
  highRisk: 'verification.riskLevels.highRisk',
  infraGap: 'verification.riskLevels.infraGap',
  specGap: 'verification.riskLevels.specGap',
  accepted: 'verification.riskLevels.accepted'
}
const HEAT_LEVEL_KEYS: MessageKey[] = ['verification.heatLevels.low', 'verification.heatLevels.lower', 'verification.heatLevels.mid', 'verification.heatLevels.higher', 'verification.heatLevels.high']

function Metric({ label, value, detail, tone = 'neutral' }: { label: string; value: string | number; detail: string; tone?: 'neutral' | 'good' | 'warn' | 'bad' }): React.JSX.Element {
  const color = tone === 'good' ? 'text-emerald-600' : tone === 'warn' ? 'text-amber-600' : tone === 'bad' ? 'text-red-600' : 'text-zinc-900'
  return <div className="min-w-0 border-r border-zinc-200 px-4 last:border-r-0">
    <div className="text-xs text-zinc-500">{label}</div>
    <div className={`mt-1 text-2xl font-semibold ${color}`}>{value}</div>
    <div className="mt-1 truncate text-[11px] text-zinc-400" title={detail}>{detail}</div>
  </div>
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
            <td className="px-2 py-2 font-mono text-zinc-400" title={bindingHint}>{ex.testId || t('verification.run.unmapped')}</td>
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [runningAction, setRunningAction] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState('')
  const ensureAgent = useChatStore((store) => store.ensure)
  const sendAgentPrompt = useChatStore((store) => store.sendAndWait)

  const load = useCallback(async () => {
    setLoading(true); setError('')
    // 操作级验证状态独立加载，不因 AIGV 态势缺失而失败
    try {
      setRunStatus(await window.moonglass.fs.verificationStatus(projectId))
    } catch { setRunStatus(null) }
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
        regressions: parsed.regressions ?? [], formalResults: parsed.formalResults ?? [], closureAssessment: parsed.closureAssessment, verificationSpace: parsed.verificationSpace, explorationRound: parsed.explorationRound, explorationHistory: parsed.explorationHistory, multiOracle: parsed.multiOracle, mutationAssessment: parsed.mutationAssessment, residualRiskRegister: parsed.residualRiskRegister, signoffPackage: parsed.signoffPackage, moduleVerificationStrategy: parsed.moduleVerificationStrategy, structuralSummary: parsed.structuralSummary, analyzer: parsed.analyzer, waveProgress: parsed.waveProgress, specMapping: parsed.specMapping
      })
      try {
        const riskFile = await window.moonglass.fs.readJson(projectId, 'verification/intelligence/risk-register.json') as { risks?: RiskMarker[] } | null
        setRisks(riskFile?.risks ?? [])
      } catch { setRisks([]) }
      try {
        setDiagnostic(await window.moonglass.fs.readJson(projectId, 'verification/results/diagnostic-control.json') as DiagnosticControl)
      } catch { setDiagnostic(null) }
    } catch (caught) {
      setState(null); setRisks([]); setDiagnostic(null)
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

      <section className="border-b border-zinc-200 bg-white px-5 py-4"><div className="mb-3 flex items-end justify-between"><div><h2 className="text-sm font-semibold">{state.waveProgress ? t('verification.steps.titleWaves') : t('verification.steps.titleLegacy')}</h2><p className="mt-1 text-xs text-zinc-500">{state.waveProgress ? t('verification.steps.subtitleWaves') : t('verification.steps.subtitleLegacy')}</p></div><span className="text-xs text-zinc-400">{t('verification.progress.nextStep')}{primaryAction?.title ?? t('verification.steps.keepEvidence')}</span></div><div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>{steps.map((step, index) => <div key={step.id} className="relative min-w-0 border-t-2 pt-2" style={{ borderColor: step.status === 'completed' ? '#10b981' : step.status === 'blocked' ? '#ef4444' : step.status === 'running' ? '#f59e0b' : '#d4d4d8' }}><div className="flex items-center gap-1.5"><span className={`h-2 w-2 shrink-0 rounded-full ${step.status === 'completed' ? 'bg-emerald-500' : step.status === 'blocked' ? 'bg-red-500' : step.status === 'running' ? 'bg-amber-500' : 'bg-zinc-300'}`} /><strong className="truncate text-xs">{step.label}</strong>{index < steps.length - 1 && <ArrowRight size={12} className="ml-auto text-zinc-300" />}</div><div className="mt-1 truncate text-[10px] text-zinc-500" title={step.detail}>{step.detail}</div></div>)}</div></section>
      {state.specMapping && <section className="border-b border-zinc-200 bg-white px-5 py-4"><div className="mb-3 flex items-end justify-between"><div><h2 className="text-sm font-semibold">{t('verification.mapping.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.mapping.subtitle')}</p></div><span className={`text-sm font-semibold ${state.specMapping.coveredClause === state.specMapping.clauseTotal ? 'text-emerald-700' : 'text-amber-700'}`}>{t('verification.mapping.completeness', { covered: state.specMapping.coveredClause, total: state.specMapping.clauseTotal })}{typeof state.specMapping.documentaryCount === 'number' ? ` · ${t('verification.mapping.documentary', { count: state.specMapping.documentaryCount })}` : ''}</span></div>{clauseRows.length > 0 ? <div className="max-h-[28rem] overflow-auto border-y border-zinc-200"><table className="w-full table-fixed text-left text-xs"><thead className="sticky top-0 bg-zinc-50 text-zinc-500"><tr><th className="w-24 px-2 py-2 font-medium">{t('verification.mapping.colStatus')}</th><th className="w-44 px-2 py-2 font-medium">{t('verification.mapping.colClauseId')}</th><th className="px-2 py-2 font-medium">{t('verification.mapping.colClause')}</th></tr></thead><tbody>{clauseRows.map((clause) => { const badge = CLAUSE_STATUS_LABELS[clause.status]; return <tr key={clause.specId} className="border-t border-zinc-100 align-top"><td className="px-2 py-1.5"><span className={`inline-block px-1.5 py-0.5 text-[10px] font-semibold ${badge?.cls ?? 'bg-zinc-100 text-zinc-600'}`}>{badge ? t(badge.labelKey) : clause.status}</span></td><td className="px-2 py-1.5 font-mono text-zinc-700">{clause.specId}</td><td className="px-2 py-1.5 text-zinc-600" title={clause.clause}>{clause.clause}</td></tr>})}</tbody></table></div> : <div className="flex items-center gap-2 px-2 py-4 text-sm text-emerald-700"><CheckCircle2 size={16} />{t('verification.mapping.allMapped')}</div>}</section>}

      {state.verificationSpace && <section className="grid grid-cols-[1.3fr_repeat(6,minmax(80px,0.7fr))] border-b border-zinc-200 bg-zinc-900 px-5 py-3 text-white"><div className="min-w-0"><div className="text-[10px] text-zinc-400">Verification Space Snapshot</div><div className="truncate font-mono text-xs text-emerald-300">{state.verificationSpace.snapshotId}</div><div className="mt-1 text-[10px] text-zinc-400">{t('verification.space.round', { round: state.explorationRound?.roundId ?? '-', selected: state.explorationRound?.selectedScenarioIds.length ?? 0, cost: state.explorationRound?.expectedCostSeconds ?? 0 })}</div><div className={`mt-1 text-[10px] ${state.explorationHistory?.saturation.status === 'STALLED' ? 'text-red-300' : state.explorationHistory?.saturation.status === 'EMPIRICALLY_SATURATED' ? 'text-emerald-300' : 'text-amber-300'}`}>{t('verification.space.exploration', { status: state.explorationHistory?.saturation.status ?? t('verification.space.statusNone'), explanation: state.explorationHistory?.saturation.explanation ?? t('verification.space.explanationNone') })}</div></div>{[[t('verification.space.candidates'), state.verificationSpace.candidateCount], ['Negative', state.verificationSpace.negativeCount], ['Feature', state.verificationSpace.dimensions.features], ['Boundary', state.verificationSpace.dimensions.boundaries], ['Interaction', state.verificationSpace.dimensions.interactions], ['State', state.verificationSpace.dimensions.systemStates]].map(([label, value]) => <div key={String(label)} className="border-l border-zinc-700 px-3"><div className="text-[10px] text-zinc-400">{label}</div><div className="mt-1 text-lg font-semibold">{value}</div></div>)}</section>}

      <div className="grid grid-cols-[minmax(520px,1.25fr)_minmax(360px,0.75fr)] gap-px border-b border-zinc-200 bg-zinc-200">
        <section className="bg-white p-5"><div className="mb-3"><h2 className="text-sm font-semibold">{t('verification.risks.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.risks.subtitle')}</p></div><div className="divide-y divide-zinc-100 border-y border-zinc-200">{topRisks.map((item, index) => <div key={item.risk.id} className="grid grid-cols-[28px_minmax(0,1fr)_auto] gap-3 py-3"><div className={`flex h-6 w-6 items-center justify-center text-xs font-semibold text-white ${item.level === 'confirmed' ? 'bg-red-600' : item.level === 'specGap' ? 'bg-amber-600' : item.level === 'accepted' ? 'bg-emerald-600' : 'bg-zinc-700'}`}>{index + 1}</div><div className="min-w-0"><div className="flex items-center gap-2"><strong className="text-sm">{item.risk.title}</strong><span className="shrink-0 bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600">{t(RISK_LEVEL_LABELS[item.level])}</span><span className="font-mono text-[10px] text-zinc-400">{item.risk.id}</span></div><p className="mt-1 text-xs text-zinc-700"><b>{t('verification.risks.risk')}</b>{item.risk.riskStatement}</p><div className="mt-1 text-[11px] text-zinc-500"><b>{t('verification.risks.object')}</b><span className="font-mono">{item.risk.object}</span>{item.risk.source?.file ? <span className="ml-1 text-zinc-400">（{item.risk.source.file}{item.risk.source.line ? `:${item.risk.source.line}` : ''}）</span> : null}</div><div className="mt-1 text-xs text-zinc-600"><b>{t('verification.risks.gap')}</b>{item.gap}</div><div className="mt-1 text-xs text-red-700"><b>{t('verification.risks.impact')}</b>{item.impact}</div><div className="mt-1 text-xs text-emerald-700"><b>{t('verification.risks.recommendation')}</b>{item.recommendation}</div></div><button disabled={runningAction !== null} onClick={() => void runAction(item.risk.id, item.prompt)} className="self-center rounded border border-zinc-300 p-2 text-zinc-500 hover:border-emerald-500 hover:text-emerald-700 disabled:opacity-40" title={t('verification.risks.handoff')}><Wrench size={15} /></button></div>)}{topRisks.length === 0 && <div className="py-8 text-center text-sm text-zinc-400">{t('verification.risks.empty')}</div>}</div></section>
        <section className="bg-white p-5"><div className="mb-3"><h2 className="text-sm font-semibold">{t('verification.actions.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.actions.subtitle')}</p></div><div className="divide-y divide-zinc-100 border-y border-zinc-200">{actions.map((action) => <button key={action.id} disabled={runningAction !== null} onClick={() => void runAction(action.id, action.prompt)} className="flex w-full items-start gap-3 py-3 text-left hover:bg-zinc-50 disabled:opacity-50"><span className={`mt-0.5 px-1.5 py-0.5 text-[10px] font-semibold ${action.priority === 'P0' ? 'bg-red-100 text-red-700' : action.priority === 'P1' ? 'bg-amber-100 text-amber-700' : 'bg-zinc-100 text-zinc-600'}`}>{action.priority}</span><span className="min-w-0 flex-1"><strong className="block text-xs text-zinc-800">{action.title}</strong><span className="mt-1 block text-[11px] text-zinc-500">{action.detail}</span></span><ArrowRight size={14} className="mt-1 shrink-0 text-zinc-400" /></button>)}</div></section>
      </div>

      <section className="grid grid-cols-9 border-b border-zinc-200 bg-white py-4">
        <Metric label={t('verification.metrics.overall')} value={signoff.label} detail={signoff.detail} tone={signoff.tone} />
        <Metric label={t('verification.metrics.intentClosure')} value={`${summary.closure}%`} detail={t('verification.metrics.intentClosureDetail', { closed: summary.closed, intents: summary.intents })} tone={summary.closure === 100 ? 'good' : summary.closure >= 80 ? 'warn' : 'bad'} />
        <Metric label={t('verification.metrics.criticalClosure')} value={state.closureAssessment ? `${state.closureAssessment.metrics.criticalClosurePercent}%` : state.criticalOpen.length} detail={state.closureAssessment ? t('verification.metrics.criticalDetail', { closed: state.closureAssessment.metrics.criticalClosed, total: state.closureAssessment.metrics.criticalTotal }) : t('verification.metrics.criticalOpen')} tone={state.closureAssessment ? (state.closureAssessment.metrics.criticalClosurePercent === 100 ? 'good' : 'bad') : state.criticalOpen.length ? 'bad' : 'good'} />
        <Metric label={t('verification.metrics.specGap')} value={state.specGaps.length} detail={t('verification.metrics.highConfidence', { count: summary.highGaps })} tone={summary.highGaps ? 'warn' : 'good'} />
        <Metric label={t('verification.metrics.coverageHole')} value={state.coverageHoles.length} detail={t('verification.metrics.blocking', { count: summary.blockingHoles })} tone={summary.blockingHoles ? 'bad' : 'good'} />
        <Metric label={t('verification.metrics.multiOracle')} value={state.multiOracle ? `${state.multiOracle.assessments.filter((item) => item.status === 'PASS').length}/${state.multiOracle.assessments.length}` : '-'} detail={state.multiOracle ? t('verification.metrics.oracleDetail', { insufficient: state.multiOracle.criticalInsufficient.length, conflicts: state.multiOracle.conflicts.length }) : t('verification.metrics.legacy')} tone={state.multiOracle && state.multiOracle.criticalInsufficient.length === 0 && state.multiOracle.conflicts.length === 0 ? 'good' : 'bad'} />
        <Metric label={t('verification.metrics.mutation')} value={state.mutationAssessment?.weightedScore == null ? '-' : `${Math.round(state.mutationAssessment.weightedScore * 100)}%`} detail={state.mutationAssessment ? t('verification.metrics.mutationDetail', { killed: state.mutationAssessment.killedCount, valid: state.mutationAssessment.validCount, status: state.mutationAssessment.status }) : t('verification.metrics.noResult')} tone={state.mutationAssessment?.status === 'PASS' ? 'good' : 'bad'} />
        <Metric label={t('verification.metrics.formal')} value={state.formalResults.length} detail={t('verification.metrics.formalFailed', { count: summary.failedFormal })} tone={summary.failedFormal ? 'bad' : 'good'} />
        <Metric label={t('verification.metrics.regression')} value={state.regressions.length} detail={t('verification.metrics.regressionFailed', { count: summary.failedRegression })} tone={summary.failedRegression ? 'bad' : 'good'} />
      </section>

      {state.moduleVerificationStrategy && <section className="border-b border-zinc-200 bg-white p-5">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-sm font-semibold">{t('verification.strategy.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.strategy.subtitle')}</p></div><div className="flex gap-4 text-[11px]"><span>{t('verification.strategy.signoff')} <b className="text-emerald-700">{state.moduleVerificationStrategy.summary.IP_SIGNOFF}</b></span><span>{t('verification.strategy.focused')} <b className="text-red-700">{state.moduleVerificationStrategy.summary.UNIT_FOCUSED}</b></span><span>{t('verification.strategy.smoke')} <b className="text-amber-700">{state.moduleVerificationStrategy.summary.UNIT_SMOKE}</b></span><span>{t('verification.strategy.static')} <b className="text-zinc-700">{state.moduleVerificationStrategy.summary.STATIC_ONLY}</b></span></div></div>
        <div className="max-h-96 overflow-auto border-y border-zinc-200"><table className="w-full table-fixed text-left text-[11px]"><thead className="sticky top-0 bg-zinc-50 text-zinc-500"><tr><th className="w-44 px-2 py-2 font-medium">{t('verification.strategy.colModule')}</th><th className="w-28 px-2 py-2 font-medium">{t('verification.strategy.colLevel')}</th><th className="w-28 px-2 py-2 font-medium">{t('verification.strategy.colRole')}</th><th className="w-60 px-2 py-2 font-medium">{t('verification.strategy.colOracle')}</th><th className="px-2 py-2 font-medium">{t('verification.strategy.colGolden')}</th></tr></thead><tbody>{state.moduleVerificationStrategy.modules.map((plan) => <tr key={plan.module} className="border-t border-zinc-100 align-top"><td className="px-2 py-2"><strong className="font-mono text-zinc-800">{plan.module}</strong><div className="mt-1 text-[10px] text-zinc-400">{plan.standaloneTestbench ? t('verification.strategy.standaloneTb') : t('verification.strategy.reuseTop')}</div></td><td className="px-2 py-2"><span className={`px-1.5 py-0.5 font-semibold ${plan.level === 'IP_SIGNOFF' ? 'bg-emerald-100 text-emerald-700' : plan.level === 'UNIT_FOCUSED' ? 'bg-red-100 text-red-700' : plan.level === 'UNIT_SMOKE' ? 'bg-amber-100 text-amber-700' : 'bg-zinc-100 text-zinc-600'}`}>{plan.level}</span></td><td className="px-2 py-2 text-zinc-600"><div>{plan.role}</div><div className="mt-1 font-mono text-zinc-400">{plan.riskScore.toFixed(3)}</div></td><td className="px-2 py-2 text-zinc-600">{plan.oracleStrategies.length ? plan.oracleStrategies.join(' + ') : t('verification.strategy.staticRules')}</td><td className="px-2 py-2"><div className={plan.goldenModel.recommendation === 'RECOMMENDED' ? 'font-semibold text-emerald-700' : plan.goldenModel.recommendation === 'OPTIONAL' ? 'font-medium text-amber-700' : 'text-zinc-500'}>{plan.goldenModel.recommendation}</div><div className="mt-1 text-zinc-500">{plan.goldenModel.rationale}</div><div className="mt-1 text-[10px] text-zinc-400">{plan.reasons.join(' ')}</div></td></tr>)}</tbody></table></div>
      </section>}

      <div className="grid grid-cols-[minmax(420px,1.1fr)_minmax(420px,1fr)] gap-px bg-zinc-200">
        <section className="bg-white p-5"><div className="mb-4 flex items-end justify-between"><div><h2 className="text-sm font-semibold">{t('verification.heat.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.heat.subtitle')}</p></div><span className="text-xs text-zinc-400">{t('verification.heat.count', { count: risks.length })}</span></div>
          <div className="grid grid-cols-[52px_repeat(5,minmax(54px,1fr))] gap-1 text-center text-[10px]">
            <div />{HEAT_LEVEL_KEYS.map((key) => <div key={key} className="pb-1 text-zinc-400">{t(key)}</div>)}
            {heat.map((cell, index) => <div key={index} className="contents">
              {cell.column === 0 && <div className="flex items-center justify-end pr-2 text-zinc-400">{t(HEAT_LEVEL_KEYS[cell.row])}</div>}
              <div title={cell.items.map((item) => `${item.id} ${item.title} ${item.object}`).join('\n') || t('verification.heat.none')} className={`flex h-12 items-center justify-center border ${cell.items.length === 0 ? 'border-zinc-100 bg-zinc-50 text-zinc-300' : cell.items.length >= 4 ? 'border-red-500 bg-red-500 text-white' : cell.items.length >= 2 ? 'border-amber-400 bg-amber-300 text-amber-950' : 'border-emerald-300 bg-emerald-100 text-emerald-800'}`}>{cell.items.length}</div>
            </div>)}
          </div>
        </section>

        <section className="bg-white p-5"><h2 className="text-sm font-semibold">{t('verification.blockers.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.blockers.subtitle')}</p>
          <div className="mt-4 max-h-72 overflow-auto border-y border-zinc-200">
            {state.criticalOpen.map((id) => <div key={id} className="flex items-center gap-2 border-b border-zinc-100 px-2 py-2 text-xs"><XCircle size={14} className="text-red-500" /><strong className="font-mono text-red-700">{id}</strong><span className="text-zinc-500">{t('verification.blockers.criticalOpen')}</span></div>)}
            {state.coverageHoles.filter((item) => item.blocking).map((hole) => <div key={hole.id} className="flex items-center gap-2 border-b border-zinc-100 px-2 py-2 text-xs"><AlertTriangle size={14} className="text-amber-500" /><strong className="font-mono text-amber-700">{HOLE_LABELS[hole.classification] ? t(HOLE_LABELS[hole.classification]) : hole.classification}</strong><span className="min-w-0 flex-1 truncate text-zinc-500" title={hole.reason}>{hole.scenarioId} · {hole.reason}</span></div>)}
            {(state.residualRiskRegister ?? []).filter((item) => item.approvalRequired && !item.approved).map((risk) => <div key={risk.id} className="flex items-center gap-2 border-b border-zinc-100 px-2 py-2 text-xs"><AlertTriangle size={14} className="text-violet-500" /><strong className="font-mono text-violet-700">{risk.id}</strong><span className="min-w-0 flex-1 truncate text-zinc-500" title={risk.impact}>{risk.title} · {t('verification.blockers.notApproved')}</span></div>)}
            {summary.blockers === 0 && <div className="flex items-center gap-2 px-2 py-6 text-sm text-emerald-700"><CheckCircle2 size={16} />{t('verification.blockers.empty')}</div>}
          </div>
        </section>
      </div>

      <section className="border-t border-zinc-200 bg-white p-5"><div className="mb-3 flex items-end justify-between"><div><h2 className="text-sm font-semibold">{t('verification.intents.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.intents.subtitle')}</p></div><span className="text-xs text-zinc-400">{state.verificationIntents.length > 15 ? t('verification.intents.showing', { total: state.verificationIntents.length }) : t('verification.intents.count', { total: state.verificationIntents.length })} · RTL {state.rtlHash.slice(0, 10)}</span></div>
        <div className="max-h-[620px] overflow-auto border-y border-zinc-200">{topIntents.map((intent) => <article key={intent.id} className="border-b border-zinc-100 p-4"><div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><strong className="font-mono text-xs text-emerald-700">{intent.id}</strong><span className="font-mono text-[10px] text-zinc-400">{intent.scenarioId}</span><span className={`px-2 py-0.5 text-[10px] ${statusTone(intent.status)}`}>{intent.status}</span><span className="text-[10px] text-sky-700">{intent.recommendedMethods.join(' + ')}</span></div><h3 className="mt-2 text-sm font-semibold leading-6 text-zinc-800">{intent.objective}</h3>{intent.failureMode && <p className="mt-1 text-xs text-red-700"><b>{t('verification.intents.failureMode')}</b>{intent.failureMode}</p>}</div><span className="font-mono text-xs text-zinc-500">P={intent.priority.toFixed(3)}</span></div><div className="mt-3 grid grid-cols-3 gap-4 text-[11px]"><div><b className="text-zinc-700">{t('verification.intents.stimulus')}</b><ol className="mt-1 list-decimal space-y-1 pl-4 text-zinc-500">{(intent.stimulusProcedure ?? intent.preconditions ?? []).map((item) => <li key={item}>{item}</li>)}</ol></div><div><b className="text-zinc-700">{t('verification.intents.observation')}</b><ul className="mt-1 list-disc space-y-1 pl-4 text-zinc-500">{(intent.observationPoints ?? []).map((item) => <li key={item}>{item}</li>)}</ul></div><div><b className="text-zinc-700">{t('verification.intents.passCriteria')}</b><ul className="mt-1 list-disc space-y-1 pl-4 text-zinc-500">{(intent.passCriteria ?? intent.expectedResults ?? []).map((item) => <li key={item}>{item}</li>)}</ul></div></div><div className="mt-3 text-[10px] text-zinc-400">{t('verification.intents.footer', { boundaries: intent.boundaries?.length ?? 0, evidence: intent.evidence.length, sources: (intent.sourceIds ?? []).join(', ') || t('verification.intents.sourcesNone') })}</div></article>)}</div>
      </section>

      <div className="grid grid-cols-2 gap-px border-t border-zinc-200 bg-zinc-200">
        <section className="bg-white p-5"><h2 className="text-sm font-semibold">{t('verification.gaps.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.gaps.subtitle')}</p><div className="mt-3 max-h-80 overflow-auto border-y border-zinc-200">{specGaps.map((gap) => <div key={gap.id} className="border-b border-zinc-100 px-2 py-3"><div className="flex items-center gap-2"><strong className="font-mono text-xs text-amber-700">{gap.id}</strong><span className="bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">{SPEC_GAP_CATEGORY_LABELS[gap.category] ? t(SPEC_GAP_CATEGORY_LABELS[gap.category]) : gap.category}</span><span className="ml-auto text-[10px] text-zinc-400">{gap.confidence}</span></div><div className="mt-1 text-xs font-medium text-zinc-700">{gap.title}</div><div className="mt-1 text-[11px] text-zinc-500">{t('verification.gaps.impact')}{gap.impact}</div><div className="mt-1 text-[11px] text-emerald-700">{t('verification.gaps.action')}{gap.action}</div>{gap.sources?.[0] && <div className="mt-1 font-mono text-[10px] text-zinc-400">{gap.sources[0].file}{gap.sources[0].line ? `:${gap.sources[0].line}` : ''}</div>}</div>)}{specGaps.length === 0 && <div className="p-6 text-sm text-emerald-700">{t('verification.gaps.empty')}</div>}</div></section>
        <section className="bg-white p-5"><h2 className="text-sm font-semibold">{t('verification.holes.title')}</h2><p className="mt-1 text-xs text-zinc-500">{t('verification.holes.subtitle')}{state.coverageHoles.length > 20 ? t('verification.holes.showingFirst', { total: state.coverageHoles.length }) : ''}</p><div className="mt-3 max-h-[520px] overflow-auto border-y border-zinc-200">{topHoles.map((hole) => <div key={hole.id} className="border-b border-zinc-100 px-2 py-3"><div className="flex items-center gap-2"><strong className={`text-xs ${hole.blocking ? 'text-red-700' : 'text-amber-700'}`}>{HOLE_LABELS[hole.classification] ? t(HOLE_LABELS[hole.classification]) : hole.classification}</strong><span className="font-mono text-[10px] text-zinc-400">{hole.scenarioId}</span><span className="ml-auto text-[10px] text-zinc-400">{hole.confidence}</span></div><div className="mt-1 text-xs font-medium text-zinc-700">{hole.missingTarget ?? hole.scenarioTitle ?? hole.reason}</div><div className="mt-2 text-[11px] text-zinc-500"><b>{t('verification.holes.stimulus')}</b>{hole.requiredStimulus?.join(t('verification.guidance.clauseJoin')) ?? hole.recommendedAction}</div><div className="mt-1 text-[11px] text-zinc-500"><b>{t('verification.holes.observation')}</b>{hole.requiredObservation?.join(t('verification.guidance.clauseJoin')) ?? t('verification.holes.observationFallback')}</div><div className="mt-1 text-[11px] text-emerald-700"><b>{t('verification.holes.closure')}</b>{hole.closureEvidence?.join(t('verification.guidance.clauseJoin')) ?? t('verification.holes.closureFallback')}</div></div>)}{state.coverageHoles.length === 0 && <div className="p-6 text-sm text-emerald-700">{t('verification.holes.empty')}</div>}</div></section>
      </div>

      <footer className="flex items-center gap-5 border-t border-zinc-200 bg-zinc-100 px-5 py-2 text-[10px] text-zinc-500"><span>{t('verification.footer.generatedAt')}{new Date(state.generatedAt).toLocaleString()}</span><span>{t('verification.footer.analyzer')}{state.analyzer?.engine ?? t('verification.footer.analyzerUnknown')} {state.analyzer?.version ?? ''}</span><span>FSM {state.structuralSummary?.fsm ?? 0}</span><span>CFG {state.structuralSummary?.cfgNodes ?? 0}</span><span>COI {state.structuralSummary?.cones ?? 0}</span>{state.signoffPackage && <span className="font-mono text-emerald-700">{state.signoffPackage.packageId}</span>}{state.verificationIntents.length === 0 && <span className="text-amber-600">{t('verification.footer.legacyModel')}</span>}</footer>
    </>}
    </main>
  </div>
}
