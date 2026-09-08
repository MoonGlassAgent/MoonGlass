import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { AlertTriangle, ArrowLeft, ArrowRight, CheckCircle2, Circle, FileSearch, Play, RefreshCw, ShieldCheck, Wrench, XCircle } from 'lucide-react'
import type { ChipProject, SpecMapping, VerificationRunStatus, WaveProgressEntry } from '@shared/types'
import { useChatStore } from '../store/chatStore'
import { deriveTopRisks, deriveVerificationActions, deriveVerificationSteps } from '../verification-guidance'

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
const SPEC_GAP_CATEGORY_LABELS: Record<string, string> = {
  SPEC_WITHOUT_RTL: '有规格无 RTL', RTL_WITHOUT_SPEC: '有 RTL 无规格', SPEC_UNDEFINED: '规格未定义', TEMPORAL_UNDEFINED: '时序语义未定义'
}
const CLAUSE_STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  UNMAPPED: { label: '未映射', cls: 'bg-amber-100 text-amber-700' },
  MAPPED_UNTESTED: { label: '已映射未测', cls: 'bg-zinc-100 text-zinc-600' },
  PASSED: { label: '通过', cls: 'bg-emerald-100 text-emerald-700' },
  FAILED: { label: '失败', cls: 'bg-red-100 text-red-700' },
  WAIVED: { label: '豁免', cls: 'bg-zinc-100 text-zinc-600' }
}
/** 识别被误当为 Spec Gap 的 markdown 版本历史表格行等垃圾数据。 */
const looksLikeGarbage = (text: string): boolean => /\|\s*\d+\.\d+\s*\|/.test(text) || /版本历史|变更描述|日期|作者/.test(text)
const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, milliseconds))
const HOLE_LABELS: Record<string, string> = {
  C1_UNREACHABLE: '不可达', C2_CONSTRAINT_BLOCKED: '约束阻断', C3_STIMULUS_MISSING: '激励缺失',
  C4_OBSERVATION_MISSING: '观察缺失', C5_SPEC_UNDEFINED: '规格未定义', C6_TOOL_INSTRUMENTATION: '工具/插桩'
}

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
  if (!status) return null
  const { environment, planned, executed, summary } = status
  const executedByTestId = new Map(executed.filter((e) => e.testId).map((e) => [e.testId, e]))
  const orphanExecuted = executed.filter((e) => !e.testId || !planned.some((p) => p.testId === e.testId))
  const badge = (ex: VerificationRunStatus['executed'][number] | undefined): { label: string; cls: string; icon: React.JSX.Element } => {
    if (ex?.status === 'PASS') return { label: 'PASS', cls: 'bg-emerald-100 text-emerald-700', icon: <CheckCircle2 size={12} /> }
    if (ex?.status === 'FAIL') return { label: 'FAIL', cls: 'bg-red-100 text-red-700', icon: <XCircle size={12} /> }
    return { label: '未执行', cls: 'bg-zinc-100 text-zinc-500', icon: <Circle size={12} /> }
  }
  return <section className="border-b border-zinc-200 bg-white p-5">
    <div className="mb-4 flex items-end justify-between gap-3">
      <div><h2 className="text-sm font-semibold">验证环境与用例执行</h2><p className="mt-1 text-xs text-zinc-500">操作级视图：环境搭建、已执行用例的通过/失败与发现的问题、尚未完成的用例</p></div>
      <span className="shrink-0 text-[11px] text-zinc-400">规划 {summary.planned} · 已执行 {summary.executed} · 通过 {summary.passed} · 失败 {summary.failed} · 未完成 {summary.notRun}{summary.bugsFound > 0 ? ` · 疑似 Bug ${summary.bugsFound}` : ''}</span>
    </div>
    <div className="mb-4 flex flex-wrap items-stretch gap-3">
      <div className={`min-w-64 rounded border px-4 py-3 ${environment.ready ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
        <div className="text-[11px] font-medium uppercase text-zinc-500">验证环境</div>
        <div className={`mt-1 text-lg font-semibold ${environment.ready ? 'text-emerald-700' : 'text-amber-700'}`}>{environment.ready ? '✅ 已搭建' : '⚠ 未搭建'}</div>
        <div className="mt-1 text-[11px] text-zinc-500">{environment.testbenches.length > 0 ? environment.testbenches.join('、') : environment.missing.join('；') || '待搭建 Cocotb 验证环境'}</div>
      </div>
      <div className="flex flex-1 flex-wrap items-center gap-3">
        <MiniStat label="规划用例" value={summary.planned} />
        <MiniStat label="已执行" value={summary.executed} />
        <MiniStat label="通过" value={summary.passed} tone="good" />
        <MiniStat label="失败/疑似Bug" value={summary.bugsFound} tone={summary.bugsFound ? 'bad' : 'good'} />
        <MiniStat label="未完成" value={summary.notRun} tone={summary.notRun ? 'warn' : 'good'} />
      </div>
    </div>
    <div className="max-h-96 overflow-auto border-y border-zinc-200">
      <table className="w-full table-fixed text-left text-[11px]">
        <thead className="sticky top-0 bg-zinc-50 text-zinc-500"><tr>
          <th className="w-36 px-2 py-2 font-medium">TEST ID</th>
          <th className="w-40 px-2 py-2 font-medium">用例名称</th>
          <th className="w-16 px-2 py-2 font-medium">优先级</th>
          <th className="w-28 px-2 py-2 font-medium">环境</th>
          <th className="w-20 px-2 py-2 font-medium">状态</th>
          <th className="px-2 py-2 font-medium">结果 / 发现的问题</th>
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
              <td className="px-2 py-2"><span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold ${b.cls}`}>{b.icon}{b.label}</span></td>
              <td className="px-2 py-2 text-zinc-500">{ex?.status === 'FAIL' ? <span className="text-red-700">{ex.blocker && <span className="mr-1 rounded bg-red-50 px-1 py-0.5 font-mono text-[10px] text-red-600">{ex.blocker}</span>}{ex.errorMessage || '失败'}</span> : ex?.status === 'PASS' ? <span className="text-emerald-700">通过</span> : <span className="text-zinc-400">尚未执行</span>}</td>
            </tr>
          })}
          {orphanExecuted.map((ex) => <tr key={ex.testName} className="border-t border-zinc-100 align-top">
            <td className="px-2 py-2 font-mono text-zinc-400">{ex.testId || '（未映射）'}</td>
            <td className="px-2 py-2 text-zinc-700">{ex.testName}</td>
            <td className="px-2 py-2 text-zinc-400">—</td>
            <td className="px-2 py-2 font-mono text-zinc-500">{ex.module}</td>
            <td className="px-2 py-2"><span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold ${ex.status === 'PASS' ? 'bg-emerald-100 text-emerald-700' : ex.status === 'FAIL' ? 'bg-red-100 text-red-700' : 'bg-zinc-100 text-zinc-500'}`}>{ex.status}</span></td>
            <td className="px-2 py-2 text-zinc-500">{ex.status === 'FAIL' ? <span className="text-red-700">{ex.blocker && <span className="mr-1 rounded bg-red-50 px-1 py-0.5 font-mono text-[10px] text-red-600">{ex.blocker}</span>}{ex.errorMessage || '失败'}</span> : ex.errorMessage || '—'}</td>
          </tr>)}
          {planned.length === 0 && executed.length === 0 && <tr><td colSpan={6} className="px-2 py-6 text-center text-zinc-400">尚未发现验证规划或执行结果。请在验证阶段先搭建环境并运行用例。</td></tr>}
        </tbody>
      </table>
    </div>
  </section>
}

export function VerificationPosturePage(): React.JSX.Element {
  const { projectId } = useParams({ from: '/verification-posture/$projectId' })
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
      if (!parsed) throw parseError instanceof Error ? parseError : new Error('验证态势数据读取失败')
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

  const signoff = !state ? { label: '数据未就绪', detail: '需要生成 AIGV 验证智能模型', tone: 'warn' as const }
    : state.closureAssessment?.status === 'READY_FOR_HUMAN_SIGNOFF' ? { label: '等待人工签核', detail: 'AIGV 2.0 机器闭环条件已满足', tone: 'good' as const }
      : state.closureAssessment?.status === 'CONDITIONALLY_READY' ? { label: '有条件就绪', detail: `${state.closureAssessment.residualRisks.length + state.closureAssessment.warnings.length} 项残余风险需要确认`, tone: 'warn' as const }
        : state.closureAssessment?.status === 'NOT_READY' ? { label: '尚不具备签核条件', detail: `${state.closureAssessment.blockers.length} 项机器签核阻断`, tone: 'bad' as const }
    : summary.intents === 0 ? { label: '模型需要更新', detail: '尚无 Verification Intent，不能评价签核状态', tone: 'warn' as const }
      : summary.blockers === 0 ? { label: '具备签核条件', detail: '关键 Intent 已闭环，未发现阻断证据', tone: 'good' as const }
      : { label: '尚不具备签核条件', detail: `${summary.blockers} 项阻断证据需要处置`, tone: 'bad' as const }

  const actions = useMemo(() => state ? deriveVerificationActions(state) : [], [state])
  const topRisks = useMemo(() => state ? deriveTopRisks(state, risks) : [], [state, risks])
  const steps = useMemo(() => deriveVerificationSteps(state), [state])
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
    setRunningAction(id); setActionMessage('正在连接主 Agent…')
    try {
      await ensureAgent(projectId)
      setActionMessage('主 Agent 正在执行，完成后将自动更新会话。')
      await sendAgentPrompt(prompt)
      setActionMessage('任务已完成，请重新生成或刷新验证态势。')
      await load()
    } catch (caught) {
      setActionMessage(`执行失败：${caught instanceof Error ? caught.message : String(caught)}`)
    } finally { setRunningAction(null) }
  }, [ensureAgent, load, projectId, sendAgentPrompt])

  const heat = useMemo(() => Array.from({ length: 25 }, (_, index) => {
    const row = 4 - Math.floor(index / 5); const column = index % 5
    const items = risks.filter((risk) => Math.min(4, Math.floor(risk.structuralComplexity * 5)) === column && Math.min(4, Math.floor(risk.interaction * 5)) === row)
    return { row, column, items }
  }), [risks])

  return <div className="flex h-full min-h-0 flex-col bg-zinc-50 text-zinc-900">
    <header className="flex h-16 shrink-0 items-center gap-4 border-b border-zinc-200 bg-white px-5">
      <Link to="/workspace/$projectId" params={{ projectId }} className="flex items-center gap-1 text-sm text-zinc-500 hover:text-emerald-700"><ArrowLeft size={16} /> 工作区</Link>
      <div className="h-6 w-px bg-zinc-200" />
      <div className="min-w-0"><h1 className="truncate text-base font-semibold">验证态势</h1><p className="truncate text-xs text-zinc-500">{project?.name ?? projectId} · AIGV Verification Digital Twin</p></div>
      <div className={`ml-auto flex items-center gap-2 text-sm font-medium ${signoff.tone === 'good' ? 'text-emerald-700' : signoff.tone === 'bad' ? 'text-red-700' : 'text-amber-700'}`}>
        {signoff.tone === 'good' ? <ShieldCheck size={18} /> : <AlertTriangle size={18} />} {signoff.label}
        <span className="text-xs font-normal text-zinc-400">{signoff.detail}</span>
      </div>
      <button onClick={() => void load()} disabled={loading} className="flex h-8 w-8 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-600 hover:border-emerald-500 hover:text-emerald-700" title="刷新验证态势"><RefreshCw size={15} className={loading ? 'animate-spin' : ''} /></button>
    </header>

    <main className="min-h-0 flex-1 overflow-auto">
    <VerificationRunSection status={runStatus} />
    {!state ? <div className="flex min-h-64 items-center justify-center p-8"><div className="max-w-lg border border-dashed border-zinc-300 bg-white p-8 text-center">
      <FileSearch className="mx-auto text-zinc-400" size={30} /><h2 className="mt-3 text-base font-semibold">尚未生成验证态势数据</h2>
      <p className="mt-2 text-sm text-zinc-500">{error || '在项目主会话中调用 build_verification_intelligence 后，此页面会展示完整 AIGV 状态。'}</p>
      <div className="mt-4 flex justify-center gap-2"><button onClick={() => void load()} className="rounded border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700 hover:border-emerald-500">重新读取</button><Link to="/workspace/$projectId" params={{ projectId }} className="inline-flex rounded bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-500">返回工作区生成</Link></div>
    </div></div> : <>
      {diagnostic && <section className={`border-b px-5 py-3 ${diagnostic.mode === 'DIAGNOSTIC_ENHANCEMENT' ? 'border-violet-200 bg-violet-50' : diagnostic.mode === 'CLOSED' ? 'border-emerald-200 bg-emerald-50' : 'border-sky-200 bg-sky-50'}`}><div className="flex items-start gap-4"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><strong className="text-sm">渐进式诊断控制</strong><span className="bg-white px-2 py-0.5 font-mono text-[10px] text-zinc-600">{diagnostic.mode}</span><span className="font-mono text-[10px] text-zinc-500">{diagnostic.activeCase}</span></div><p className="mt-1 text-xs text-zinc-600">{diagnostic.recommendation}</p></div><div className="shrink-0 text-right"><div className="text-lg font-semibold text-violet-700">{diagnostic.attempts.at(-1)?.diagnosticLevel ?? 'L0'}</div><div className="text-[10px] text-zinc-500">当前诊断等级 · {diagnostic.attempts.length} 次记录</div></div></div></section>}
      <section className={`border-b px-5 py-4 ${signoff.tone === 'good' ? 'border-emerald-200 bg-emerald-50' : signoff.tone === 'bad' ? 'border-red-200 bg-red-50' : 'border-amber-200 bg-amber-50'}`}>
        <div className="flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="text-[11px] font-medium uppercase text-zinc-500">当前验证进展</div>
            <p className="mt-1 text-sm text-zinc-700">
              {summary.intents === 0
                ? '尚未生成验证规划（Verification Intent）。'
                : `场景闭环 ${summary.closed}/${summary.intents}（${summary.closure}%），关键闭环 ${state.closureAssessment ? `${state.closureAssessment.metrics.criticalClosed}/${state.closureAssessment.metrics.criticalTotal}` : summary.closed}；`}
              <span className={summary.failedRegression + summary.failedFormal > 0 ? 'text-red-700' : 'text-emerald-700'}>{summary.failedRegression + summary.failedFormal > 0 ? ` ${summary.failedRegression + summary.failedFormal} 项失败证据。` : ' 无失败回归/Formal。'}</span>
              <span className="text-zinc-500">{summary.highGaps ? ` 规格缺口 ${summary.highGaps} 项；` : ''}{summary.blockingHoles ? ` 覆盖阻断 ${summary.blockingHoles} 项；` : ''}</span>
            </p>
            <p className="mt-1 text-sm text-zinc-600">下一步：<b>{primaryAction?.title ?? '生成 AIGV 验证规划'}</b>{primaryAction ? ` —— ${primaryAction.detail}` : ''}</p>
          </div>
          {primaryAction && <button disabled={runningAction !== null} onClick={() => void runAction(primaryAction.id, primaryAction.prompt)} className="inline-flex h-10 shrink-0 items-center gap-2 rounded bg-zinc-900 px-4 text-sm font-medium text-white hover:bg-zinc-700 disabled:opacity-50"><Play size={16} />{runningAction === primaryAction.id ? 'Agent 执行中…' : primaryAction.title}<ArrowRight size={15} /></button>}
        </div>
        {actionMessage && <div className="mt-3 border-t border-black/10 pt-2 text-xs text-zinc-600">{actionMessage}</div>}
        {state.closureAssessment && <div className="mt-3 grid grid-cols-2 gap-4 border-t border-black/10 pt-3 text-xs"><div><b className="text-zinc-700">机器签核阻断</b><div className="mt-1 space-y-1 text-zinc-600">{state.closureAssessment.blockers.slice(0, 4).map((item) => <div key={item}>• {item}</div>)}{state.closureAssessment.blockers.length === 0 && <div className="text-emerald-700">没有机器签核阻断项</div>}</div></div><div><b className="text-zinc-700">AIGV 2.0 下一步</b><div className="mt-1 space-y-1 text-zinc-600">{state.closureAssessment.nextActions.slice(0, 4).map((item) => <div key={item}>→ {item}</div>)}</div></div></div>}
      </section>

      <section className="border-b border-zinc-200 bg-white px-5 py-4"><div className="mb-3 flex items-end justify-between"><div><h2 className="text-sm font-semibold">{state.waveProgress ? '验证波段' : 'VERIF 交付路径'}</h2><p className="mt-1 text-xs text-zinc-500">{state.waveProgress ? 'W0 冒烟 → W1 基础功能 → W2 增补 → W3 签核；完备性看规格映射表，不是风险队列深度' : '从规划到签核的当前状态与阻断位置'}</p></div><span className="text-xs text-zinc-400">下一步：{primaryAction?.title ?? '保持证据并完成签核'}</span></div><div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>{steps.map((step, index) => <div key={step.id} className="relative min-w-0 border-t-2 pt-2" style={{ borderColor: step.status === 'completed' ? '#10b981' : step.status === 'blocked' ? '#ef4444' : step.status === 'running' ? '#f59e0b' : '#d4d4d8' }}><div className="flex items-center gap-1.5"><span className={`h-2 w-2 shrink-0 rounded-full ${step.status === 'completed' ? 'bg-emerald-500' : step.status === 'blocked' ? 'bg-red-500' : step.status === 'running' ? 'bg-amber-500' : 'bg-zinc-300'}`} /><strong className="truncate text-xs">{step.label}</strong>{index < steps.length - 1 && <ArrowRight size={12} className="ml-auto text-zinc-300" />}</div><div className="mt-1 truncate text-[10px] text-zinc-500" title={step.detail}>{step.detail}</div></div>)}</div></section>
      {state.specMapping && <section className="border-b border-zinc-200 bg-white px-5 py-4"><div className="mb-3 flex items-end justify-between"><div><h2 className="text-sm font-semibold">规格映射矩阵</h2><p className="mt-1 text-xs text-zinc-500">可验证规格条款 → Intent → PASS 证据；未映射为完备性缺口（warning 不阻断）</p></div><span className={`text-sm font-semibold ${state.specMapping.coveredClause === state.specMapping.clauseTotal ? 'text-emerald-700' : 'text-amber-700'}`}>完备性 {state.specMapping.coveredClause}/{state.specMapping.clauseTotal}{typeof state.specMapping.documentaryCount === 'number' ? ` · 文档性 ${state.specMapping.documentaryCount}` : ''}</span></div>{clauseRows.length > 0 ? <div className="max-h-[28rem] overflow-auto border-y border-zinc-200"><table className="w-full table-fixed text-left text-xs"><thead className="sticky top-0 bg-zinc-50 text-zinc-500"><tr><th className="w-24 px-2 py-2 font-medium">状态</th><th className="w-44 px-2 py-2 font-medium">条款 ID</th><th className="px-2 py-2 font-medium">条款内容</th></tr></thead><tbody>{clauseRows.map((clause) => { const badge = CLAUSE_STATUS_LABELS[clause.status] ?? { label: clause.status, cls: 'bg-zinc-100 text-zinc-600' }; return <tr key={clause.specId} className="border-t border-zinc-100 align-top"><td className="px-2 py-1.5"><span className={`inline-block px-1.5 py-0.5 text-[10px] font-semibold ${badge.cls}`}>{badge.label}</span></td><td className="px-2 py-1.5 font-mono text-zinc-700">{clause.specId}</td><td className="px-2 py-1.5 text-zinc-600" title={clause.clause}>{clause.clause}</td></tr>})}</tbody></table></div> : <div className="flex items-center gap-2 px-2 py-4 text-sm text-emerald-700"><CheckCircle2 size={16} />所有可验证规格条款均已有验证映射。</div>}</section>}

      {state.verificationSpace && <section className="grid grid-cols-[1.3fr_repeat(6,minmax(80px,0.7fr))] border-b border-zinc-200 bg-zinc-900 px-5 py-3 text-white"><div className="min-w-0"><div className="text-[10px] text-zinc-400">Verification Space Snapshot</div><div className="truncate font-mono text-xs text-emerald-300">{state.verificationSpace.snapshotId}</div><div className="mt-1 text-[10px] text-zinc-400">本轮 {state.explorationRound?.roundId ?? '-'} · 选择 {state.explorationRound?.selectedScenarioIds.length ?? 0} 项 · 预计 {state.explorationRound?.expectedCostSeconds ?? 0}s</div><div className={`mt-1 text-[10px] ${state.explorationHistory?.saturation.status === 'STALLED' ? 'text-red-300' : state.explorationHistory?.saturation.status === 'EMPIRICALLY_SATURATED' ? 'text-emerald-300' : 'text-amber-300'}`}>探索：{state.explorationHistory?.saturation.status ?? '尚未记录'} · {state.explorationHistory?.saturation.explanation ?? '调用下一批验证任务后开始累计真实探索轮次'}</div></div>{[['候选', state.verificationSpace.candidateCount], ['Negative', state.verificationSpace.negativeCount], ['Feature', state.verificationSpace.dimensions.features], ['Boundary', state.verificationSpace.dimensions.boundaries], ['Interaction', state.verificationSpace.dimensions.interactions], ['State', state.verificationSpace.dimensions.systemStates]].map(([label, value]) => <div key={String(label)} className="border-l border-zinc-700 px-3"><div className="text-[10px] text-zinc-400">{label}</div><div className="mt-1 text-lg font-semibold">{value}</div></div>)}</section>}

      <div className="grid grid-cols-[minmax(520px,1.25fr)_minmax(360px,0.75fr)] gap-px border-b border-zinc-200 bg-zinc-200">
        <section className="bg-white p-5"><div className="mb-3"><h2 className="text-sm font-semibold">当前 Top 风险</h2><p className="mt-1 text-xs text-zinc-500">每项回答“哪里、何时、可能怎样失效、影响什么”；风险标记不等同于已确认 RTL Bug</p></div><div className="divide-y divide-zinc-100 border-y border-zinc-200">{topRisks.map((item, index) => <div key={item.risk.id} className="grid grid-cols-[28px_minmax(0,1fr)_auto] gap-3 py-3"><div className={`flex h-6 w-6 items-center justify-center text-xs font-semibold text-white ${item.level === '已确认问题' ? 'bg-red-600' : item.level === '规格缺口' ? 'bg-amber-600' : item.level === '已接受风险' ? 'bg-emerald-600' : 'bg-zinc-700'}`}>{index + 1}</div><div className="min-w-0"><div className="flex items-center gap-2"><strong className="text-sm">{item.risk.title}</strong><span className="shrink-0 bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-600">{item.level}</span><span className="font-mono text-[10px] text-zinc-400">{item.risk.id}</span></div><p className="mt-1 text-xs text-zinc-700"><b>风险：</b>{item.risk.riskStatement}</p><div className="mt-1 text-[11px] text-zinc-500"><b>对象：</b><span className="font-mono">{item.risk.object}</span>{item.risk.source?.file ? <span className="ml-1 text-zinc-400">（{item.risk.source.file}{item.risk.source.line ? `:${item.risk.source.line}` : ''}）</span> : null}</div><div className="mt-1 text-xs text-zinc-600"><b>待验证点：</b>{item.gap}</div><div className="mt-1 text-xs text-red-700"><b>可能影响：</b>{item.impact}</div><div className="mt-1 text-xs text-emerald-700"><b>怎么做：</b>{item.recommendation}</div></div><button disabled={runningAction !== null} onClick={() => void runAction(item.risk.id, item.prompt)} className="self-center rounded border border-zinc-300 p-2 text-zinc-500 hover:border-emerald-500 hover:text-emerald-700 disabled:opacity-40" title="交给主 Agent 处理"><Wrench size={15} /></button></div>)}{topRisks.length === 0 && <div className="py-8 text-center text-sm text-zinc-400">暂无可排序的风险数据，请重新生成 AIGV 态势。</div>}</div></section>
        <section className="bg-white p-5"><div className="mb-3"><h2 className="text-sm font-semibold">推荐下一步</h2><p className="mt-1 text-xs text-zinc-500">按阻断程度排序，可直接交给主 Agent</p></div><div className="divide-y divide-zinc-100 border-y border-zinc-200">{actions.map((action) => <button key={action.id} disabled={runningAction !== null} onClick={() => void runAction(action.id, action.prompt)} className="flex w-full items-start gap-3 py-3 text-left hover:bg-zinc-50 disabled:opacity-50"><span className={`mt-0.5 px-1.5 py-0.5 text-[10px] font-semibold ${action.priority === 'P0' ? 'bg-red-100 text-red-700' : action.priority === 'P1' ? 'bg-amber-100 text-amber-700' : 'bg-zinc-100 text-zinc-600'}`}>{action.priority}</span><span className="min-w-0 flex-1"><strong className="block text-xs text-zinc-800">{action.title}</strong><span className="mt-1 block text-[11px] text-zinc-500">{action.detail}</span></span><ArrowRight size={14} className="mt-1 shrink-0 text-zinc-400" /></button>)}</div></section>
      </div>

      <section className="grid grid-cols-9 border-b border-zinc-200 bg-white py-4">
        <Metric label="总体结论" value={signoff.label} detail={signoff.detail} tone={signoff.tone} />
        <Metric label="Intent 闭环率" value={`${summary.closure}%`} detail={`${summary.closed}/${summary.intents} 已闭环`} tone={summary.closure === 100 ? 'good' : summary.closure >= 80 ? 'warn' : 'bad'} />
        <Metric label="关键闭环率" value={state.closureAssessment ? `${state.closureAssessment.metrics.criticalClosurePercent}%` : state.criticalOpen.length} detail={state.closureAssessment ? `${state.closureAssessment.metrics.criticalClosed}/${state.closureAssessment.metrics.criticalTotal} P0/P1 Scenario` : '高优先级 Scenario'} tone={state.closureAssessment ? (state.closureAssessment.metrics.criticalClosurePercent === 100 ? 'good' : 'bad') : state.criticalOpen.length ? 'bad' : 'good'} />
        <Metric label="Spec Gap" value={state.specGaps.length} detail={`${summary.highGaps} 项高置信度`} tone={summary.highGaps ? 'warn' : 'good'} />
        <Metric label="Coverage Hole" value={state.coverageHoles.length} detail={`${summary.blockingHoles} 项阻断`} tone={summary.blockingHoles ? 'bad' : 'good'} />
        <Metric label="Multi-Oracle" value={state.multiOracle ? `${state.multiOracle.assessments.filter((item) => item.status === 'PASS').length}/${state.multiOracle.assessments.length}` : '-'} detail={state.multiOracle ? `${state.multiOracle.criticalInsufficient.length} 项不足 · ${state.multiOracle.conflicts.length} 项冲突` : '旧版状态'} tone={state.multiOracle && state.multiOracle.criticalInsufficient.length === 0 && state.multiOracle.conflicts.length === 0 ? 'good' : 'bad'} />
        <Metric label="Mutation" value={state.mutationAssessment?.weightedScore == null ? '-' : `${Math.round(state.mutationAssessment.weightedScore * 100)}%`} detail={state.mutationAssessment ? `${state.mutationAssessment.killedCount}/${state.mutationAssessment.validCount} killed · ${state.mutationAssessment.status}` : '尚无结果'} tone={state.mutationAssessment?.status === 'PASS' ? 'good' : 'bad'} />
        <Metric label="Formal" value={state.formalResults.length} detail={`${summary.failedFormal} 项失败/错误`} tone={summary.failedFormal ? 'bad' : 'good'} />
        <Metric label="回归" value={state.regressions.length} detail={`${summary.failedRegression} 项失败`} tone={summary.failedRegression ? 'bad' : 'good'} />
      </section>

      {state.moduleVerificationStrategy && <section className="border-b border-zinc-200 bg-white p-5">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3"><div><h2 className="text-sm font-semibold">模块分层验证策略</h2><p className="mt-1 text-xs text-zinc-500">顶层完整签核，高风险子模块专项验证，普通子模块静态检查或轻量 Smoke；Oracle 与验证深度独立决策</p></div><div className="flex gap-4 text-[11px]"><span>签核 <b className="text-emerald-700">{state.moduleVerificationStrategy.summary.IP_SIGNOFF}</b></span><span>专项 <b className="text-red-700">{state.moduleVerificationStrategy.summary.UNIT_FOCUSED}</b></span><span>Smoke <b className="text-amber-700">{state.moduleVerificationStrategy.summary.UNIT_SMOKE}</b></span><span>静态 <b className="text-zinc-700">{state.moduleVerificationStrategy.summary.STATIC_ONLY}</b></span></div></div>
        <div className="max-h-96 overflow-auto border-y border-zinc-200"><table className="w-full table-fixed text-left text-[11px]"><thead className="sticky top-0 bg-zinc-50 text-zinc-500"><tr><th className="w-44 px-2 py-2 font-medium">模块</th><th className="w-28 px-2 py-2 font-medium">验证等级</th><th className="w-28 px-2 py-2 font-medium">角色/风险</th><th className="w-60 px-2 py-2 font-medium">Oracle 策略</th><th className="px-2 py-2 font-medium">Golden Model 与工程依据</th></tr></thead><tbody>{state.moduleVerificationStrategy.modules.map((plan) => <tr key={plan.module} className="border-t border-zinc-100 align-top"><td className="px-2 py-2"><strong className="font-mono text-zinc-800">{plan.module}</strong><div className="mt-1 text-[10px] text-zinc-400">{plan.standaloneTestbench ? '独立 Testbench' : '复用顶层/静态证据'}</div></td><td className="px-2 py-2"><span className={`px-1.5 py-0.5 font-semibold ${plan.level === 'IP_SIGNOFF' ? 'bg-emerald-100 text-emerald-700' : plan.level === 'UNIT_FOCUSED' ? 'bg-red-100 text-red-700' : plan.level === 'UNIT_SMOKE' ? 'bg-amber-100 text-amber-700' : 'bg-zinc-100 text-zinc-600'}`}>{plan.level}</span></td><td className="px-2 py-2 text-zinc-600"><div>{plan.role}</div><div className="mt-1 font-mono text-zinc-400">{plan.riskScore.toFixed(3)}</div></td><td className="px-2 py-2 text-zinc-600">{plan.oracleStrategies.length ? plan.oracleStrategies.join(' + ') : '静态规则'}</td><td className="px-2 py-2"><div className={plan.goldenModel.recommendation === 'RECOMMENDED' ? 'font-semibold text-emerald-700' : plan.goldenModel.recommendation === 'OPTIONAL' ? 'font-medium text-amber-700' : 'text-zinc-500'}>{plan.goldenModel.recommendation}</div><div className="mt-1 text-zinc-500">{plan.goldenModel.rationale}</div><div className="mt-1 text-[10px] text-zinc-400">{plan.reasons.join(' ')}</div></td></tr>)}</tbody></table></div>
      </section>}

      <div className="grid grid-cols-[minmax(420px,1.1fr)_minmax(420px,1fr)] gap-px bg-zinc-200">
        <section className="bg-white p-5"><div className="mb-4 flex items-end justify-between"><div><h2 className="text-sm font-semibold">风险热区</h2><p className="mt-1 text-xs text-zinc-500">纵轴交互强度，横轴结构复杂度；颜色越深风险越集中</p></div><span className="text-xs text-zinc-400">{risks.length} 项风险</span></div>
          <div className="grid grid-cols-[52px_repeat(5,minmax(54px,1fr))] gap-1 text-center text-[10px]">
            <div />{['低', '较低', '中', '较高', '高'].map((item) => <div key={item} className="pb-1 text-zinc-400">{item}</div>)}
            {heat.map((cell, index) => <div key={index} className="contents">
              {cell.column === 0 && <div className="flex items-center justify-end pr-2 text-zinc-400">{['低', '较低', '中', '较高', '高'][cell.row]}</div>}
              <div title={cell.items.map((item) => `${item.id} ${item.title} ${item.object}`).join('\n') || '无风险'} className={`flex h-12 items-center justify-center border ${cell.items.length === 0 ? 'border-zinc-100 bg-zinc-50 text-zinc-300' : cell.items.length >= 4 ? 'border-red-500 bg-red-500 text-white' : cell.items.length >= 2 ? 'border-amber-400 bg-amber-300 text-amber-950' : 'border-emerald-300 bg-emerald-100 text-emerald-800'}`}>{cell.items.length}</div>
            </div>)}
          </div>
        </section>

        <section className="bg-white p-5"><h2 className="text-sm font-semibold">总体签核阻断项</h2><p className="mt-1 text-xs text-zinc-500">所有结论来自结构化回归、Formal、Coverage Hole 和 Intent 状态</p>
          <div className="mt-4 max-h-72 overflow-auto border-y border-zinc-200">
            {state.criticalOpen.map((id) => <div key={id} className="flex items-center gap-2 border-b border-zinc-100 px-2 py-2 text-xs"><XCircle size={14} className="text-red-500" /><strong className="font-mono text-red-700">{id}</strong><span className="text-zinc-500">关键 Scenario 未闭环</span></div>)}
            {state.coverageHoles.filter((item) => item.blocking).map((hole) => <div key={hole.id} className="flex items-center gap-2 border-b border-zinc-100 px-2 py-2 text-xs"><AlertTriangle size={14} className="text-amber-500" /><strong className="font-mono text-amber-700">{HOLE_LABELS[hole.classification] ?? hole.classification}</strong><span className="min-w-0 flex-1 truncate text-zinc-500" title={hole.reason}>{hole.scenarioId} · {hole.reason}</span></div>)}
            {(state.residualRiskRegister ?? []).filter((item) => item.approvalRequired && !item.approved).map((risk) => <div key={risk.id} className="flex items-center gap-2 border-b border-zinc-100 px-2 py-2 text-xs"><AlertTriangle size={14} className="text-violet-500" /><strong className="font-mono text-violet-700">{risk.id}</strong><span className="min-w-0 flex-1 truncate text-zinc-500" title={risk.impact}>{risk.title} · 尚未批准</span></div>)}
            {summary.blockers === 0 && <div className="flex items-center gap-2 px-2 py-6 text-sm text-emerald-700"><CheckCircle2 size={16} />当前没有阻断签核的 AIGV 证据。</div>}
          </div>
        </section>
      </div>

      <section className="border-t border-zinc-200 bg-white p-5"><div className="mb-3 flex items-end justify-between"><div><h2 className="text-sm font-semibold">Verification Intent 闭环</h2><p className="mt-1 text-xs text-zinc-500">每个 Intent 都是可执行、可观察、可判定、可追踪证据的工程目标</p></div><span className="text-xs text-zinc-400">{state.verificationIntents.length > 15 ? `共 ${state.verificationIntents.length} 个 · 展示前 15` : `${state.verificationIntents.length} 个`} · RTL {state.rtlHash.slice(0, 10)}</span></div>
        <div className="max-h-[620px] overflow-auto border-y border-zinc-200">{topIntents.map((intent) => <article key={intent.id} className="border-b border-zinc-100 p-4"><div className="flex items-start gap-3"><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><strong className="font-mono text-xs text-emerald-700">{intent.id}</strong><span className="font-mono text-[10px] text-zinc-400">{intent.scenarioId}</span><span className={`px-2 py-0.5 text-[10px] ${statusTone(intent.status)}`}>{intent.status}</span><span className="text-[10px] text-sky-700">{intent.recommendedMethods.join(' + ')}</span></div><h3 className="mt-2 text-sm font-semibold leading-6 text-zinc-800">{intent.objective}</h3>{intent.failureMode && <p className="mt-1 text-xs text-red-700"><b>要排除的失效：</b>{intent.failureMode}</p>}</div><span className="font-mono text-xs text-zinc-500">P={intent.priority.toFixed(3)}</span></div><div className="mt-3 grid grid-cols-3 gap-4 text-[11px]"><div><b className="text-zinc-700">如何激励</b><ol className="mt-1 list-decimal space-y-1 pl-4 text-zinc-500">{(intent.stimulusProcedure ?? intent.preconditions ?? []).map((item) => <li key={item}>{item}</li>)}</ol></div><div><b className="text-zinc-700">观察什么</b><ul className="mt-1 list-disc space-y-1 pl-4 text-zinc-500">{(intent.observationPoints ?? []).map((item) => <li key={item}>{item}</li>)}</ul></div><div><b className="text-zinc-700">怎样算通过</b><ul className="mt-1 list-disc space-y-1 pl-4 text-zinc-500">{(intent.passCriteria ?? intent.expectedResults ?? []).map((item) => <li key={item}>{item}</li>)}</ul></div></div><div className="mt-3 text-[10px] text-zinc-400">边界 {intent.boundaries?.length ?? 0} · 证据 {intent.evidence.length} · 来源 {(intent.sourceIds ?? []).join(', ') || '待建立'}</div></article>)}</div>
      </section>

      <div className="grid grid-cols-2 gap-px border-t border-zinc-200 bg-zinc-200">
        <section className="bg-white p-5"><h2 className="text-sm font-semibold">规格缺口（Spec Gap）</h2><p className="mt-1 text-xs text-zinc-500">规格语义不闭合会导致对应场景无法裁决通过/失败</p><div className="mt-3 max-h-80 overflow-auto border-y border-zinc-200">{specGaps.map((gap) => <div key={gap.id} className="border-b border-zinc-100 px-2 py-3"><div className="flex items-center gap-2"><strong className="font-mono text-xs text-amber-700">{gap.id}</strong><span className="bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">{SPEC_GAP_CATEGORY_LABELS[gap.category] ?? gap.category}</span><span className="ml-auto text-[10px] text-zinc-400">{gap.confidence}</span></div><div className="mt-1 text-xs font-medium text-zinc-700">{gap.title}</div><div className="mt-1 text-[11px] text-zinc-500">影响：{gap.impact}</div><div className="mt-1 text-[11px] text-emerald-700">处置：{gap.action}</div>{gap.sources?.[0] && <div className="mt-1 font-mono text-[10px] text-zinc-400">{gap.sources[0].file}{gap.sources[0].line ? `:${gap.sources[0].line}` : ''}</div>}</div>)}{specGaps.length === 0 && <div className="p-6 text-sm text-emerald-700">当前未识别到有效规格缺口。</div>}</div></section>
        <section className="bg-white p-5"><h2 className="text-sm font-semibold">Coverage Hole</h2><p className="mt-1 text-xs text-zinc-500">Coverage Hole 是具体场景的闭环缺口，不只是覆盖率数字未达标{state.coverageHoles.length > 20 ? `（共 ${state.coverageHoles.length} 个，阻断优先展示前 20）` : ''}</p><div className="mt-3 max-h-[520px] overflow-auto border-y border-zinc-200">{topHoles.map((hole) => <div key={hole.id} className="border-b border-zinc-100 px-2 py-3"><div className="flex items-center gap-2"><strong className={`text-xs ${hole.blocking ? 'text-red-700' : 'text-amber-700'}`}>{HOLE_LABELS[hole.classification] ?? hole.classification}</strong><span className="font-mono text-[10px] text-zinc-400">{hole.scenarioId}</span><span className="ml-auto text-[10px] text-zinc-400">{hole.confidence}</span></div><div className="mt-1 text-xs font-medium text-zinc-700">{hole.missingTarget ?? hole.scenarioTitle ?? hole.reason}</div><div className="mt-2 text-[11px] text-zinc-500"><b>需要的激励：</b>{hole.requiredStimulus?.join('；') ?? hole.recommendedAction}</div><div className="mt-1 text-[11px] text-zinc-500"><b>需要的观察：</b>{hole.requiredObservation?.join('；') ?? '按关联 Intent 补充 Checker/Assertion'}</div><div className="mt-1 text-[11px] text-emerald-700"><b>关闭证据：</b>{hole.closureEvidence?.join('；') ?? 'Scenario hit、裁决结果与原始证据'}</div></div>)}{state.coverageHoles.length === 0 && <div className="p-6 text-sm text-emerald-700">当前没有待处理的 Coverage Hole。</div>}</div></section>
      </div>

      <footer className="flex items-center gap-5 border-t border-zinc-200 bg-zinc-100 px-5 py-2 text-[10px] text-zinc-500"><span>生成时间：{new Date(state.generatedAt).toLocaleString()}</span><span>分析器：{state.analyzer?.engine ?? '旧版/未知'} {state.analyzer?.version ?? ''}</span><span>FSM {state.structuralSummary?.fsm ?? 0}</span><span>CFG {state.structuralSummary?.cfgNodes ?? 0}</span><span>COI {state.structuralSummary?.cones ?? 0}</span>{state.signoffPackage && <span className="font-mono text-emerald-700">{state.signoffPackage.packageId}</span>}{state.verificationIntents.length === 0 && <span className="text-amber-600">旧版模型，请重新生成 AIGV 态势</span>}</footer>
    </>}
    </main>
  </div>
}
