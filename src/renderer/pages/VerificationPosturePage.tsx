import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { AlertTriangle, ArrowLeft, CheckCircle2, FileSearch, RefreshCw, ShieldCheck, XCircle } from 'lucide-react'
import type { ChipProject } from '@shared/types'

interface RiskMarker { id: string; title: string; object: string; features: string[]; structuralComplexity: number; interaction: number; riskScore: number; confidence: string; source: { file: string; line?: number } }
interface SpecGap { id: string; category: string; title: string; impact: string; action: string; confidence: string; requirementIds: string[]; rtlObjects: string[] }
interface Intent { id: string; scenarioId: string; objective: string; status: string; priority: number; recommendedMethods: string[]; boundaries: Array<{ object: string; values: string[] }>; evidence: string[] }
interface CoverageHole { id: string; scenarioId: string; classification: string; confidence: string; reason: string; recommendedAction: string; blocking: boolean }
interface VerificationState {
  generatedAt: string
  rtlHash: string
  scenarioCount: number
  criticalOpen: string[]
  verificationIntents: Intent[]
  specGaps: SpecGap[]
  coverageHoles: CoverageHole[]
  regressions: Array<{ resultFile: string; passed: boolean; testsTotal: number; coverage: Record<string, number> }>
  formalResults: Array<{ resultFile: string; status: string; mode: string; scenarioId?: string; traces: string[] }>
  structuralSummary?: { fsm: number; cfgNodes: number; dependencies: number; cones: number; protocols: Array<{ protocol: string; module: string }> }
  analyzer?: { engine: string; version?: string; limitations: string[] }
}

const CLOSED = new Set(['VERIFIED', 'FORMAL_PROVED', 'FORMAL_UNREACHABLE', 'WAIVED'])
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

export function VerificationPosturePage(): React.JSX.Element {
  const { projectId } = useParams({ from: '/verification-posture/$projectId' })
  const [project, setProject] = useState<ChipProject | null>(null)
  const [state, setState] = useState<VerificationState | null>(null)
  const [risks, setRisks] = useState<RiskMarker[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const current = await window.moonglass.project.get(projectId)
      setProject(current)
      let parsed: Partial<VerificationState> | null = null
      let parseError: unknown
      for (let attempt = 0; attempt < 4 && !parsed; attempt += 1) {
        try {
          const stateFile = await window.moonglass.fs.readFile(projectId, 'verification/intelligence/verification-state.json')
          parsed = JSON.parse(stateFile.content) as Partial<VerificationState>
        } catch (caught) {
          parseError = caught
          if (attempt < 3) await pause(200 * (attempt + 1))
        }
      }
      if (!parsed) throw parseError instanceof Error ? parseError : new Error('验证态势数据读取失败')
      setState({
        generatedAt: parsed.generatedAt ?? new Date(0).toISOString(), rtlHash: parsed.rtlHash ?? '', scenarioCount: parsed.scenarioCount ?? 0,
        criticalOpen: parsed.criticalOpen ?? [], verificationIntents: parsed.verificationIntents ?? [], specGaps: parsed.specGaps ?? [], coverageHoles: parsed.coverageHoles ?? [],
        regressions: parsed.regressions ?? [], formalResults: parsed.formalResults ?? [], structuralSummary: parsed.structuralSummary, analyzer: parsed.analyzer
      })
      try {
        const riskFile = await window.moonglass.fs.readFile(projectId, 'verification/intelligence/risk-register.json')
        setRisks((JSON.parse(riskFile.content) as { risks?: RiskMarker[] }).risks ?? [])
      } catch { setRisks([]) }
    } catch (caught) {
      setState(null); setRisks([])
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
    const blockers = (state?.criticalOpen.length ?? 0) + failedFormal + failedRegression + blockingHoles
    return { intents: intents.length, closed, closure: intents.length ? Math.round(closed * 100 / intents.length) : 0, failedFormal, failedRegression, blockingHoles, highGaps, blockers }
  }, [state])

  const signoff = !state ? { label: '数据未就绪', detail: '需要生成 AIGV 验证智能模型', tone: 'warn' as const }
    : summary.intents === 0 ? { label: '模型需要更新', detail: '尚无 Verification Intent，不能评价签核状态', tone: 'warn' as const }
      : summary.blockers === 0 ? { label: '具备签核条件', detail: '关键 Intent 已闭环，未发现阻断证据', tone: 'good' as const }
      : { label: '尚不具备签核条件', detail: `${summary.blockers} 项阻断证据需要处置`, tone: 'bad' as const }

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

    {!state ? <div className="flex flex-1 items-center justify-center p-8"><div className="max-w-lg border border-dashed border-zinc-300 bg-white p-8 text-center">
      <FileSearch className="mx-auto text-zinc-400" size={30} /><h2 className="mt-3 text-base font-semibold">尚未生成验证态势数据</h2>
      <p className="mt-2 text-sm text-zinc-500">{error || '在项目主会话中调用 build_verification_intelligence 后，此页面会展示完整 AIGV 状态。'}</p>
      <div className="mt-4 flex justify-center gap-2"><button onClick={() => void load()} className="rounded border border-zinc-300 bg-white px-4 py-2 text-sm text-zinc-700 hover:border-emerald-500">重新读取</button><Link to="/workspace/$projectId" params={{ projectId }} className="inline-flex rounded bg-emerald-600 px-4 py-2 text-sm text-white hover:bg-emerald-500">返回工作区生成</Link></div>
    </div></div> : <main className="min-h-0 flex-1 overflow-auto">
      <section className="grid grid-cols-7 border-b border-zinc-200 bg-white py-4">
        <Metric label="总体结论" value={signoff.label} detail={signoff.detail} tone={signoff.tone} />
        <Metric label="Intent 闭环率" value={`${summary.closure}%`} detail={`${summary.closed}/${summary.intents} 已闭环`} tone={summary.closure === 100 ? 'good' : summary.closure >= 80 ? 'warn' : 'bad'} />
        <Metric label="关键未闭环" value={state.criticalOpen.length} detail="高优先级 Scenario" tone={state.criticalOpen.length ? 'bad' : 'good'} />
        <Metric label="Spec Gap" value={state.specGaps.length} detail={`${summary.highGaps} 项高置信度`} tone={summary.highGaps ? 'warn' : 'good'} />
        <Metric label="Coverage Hole" value={state.coverageHoles.length} detail={`${summary.blockingHoles} 项阻断`} tone={summary.blockingHoles ? 'bad' : 'good'} />
        <Metric label="Formal" value={state.formalResults.length} detail={`${summary.failedFormal} 项失败/错误`} tone={summary.failedFormal ? 'bad' : 'good'} />
        <Metric label="回归" value={state.regressions.length} detail={`${summary.failedRegression} 项失败`} tone={summary.failedRegression ? 'bad' : 'good'} />
      </section>

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
            {summary.blockers === 0 && <div className="flex items-center gap-2 px-2 py-6 text-sm text-emerald-700"><CheckCircle2 size={16} />当前没有阻断签核的 AIGV 证据。</div>}
          </div>
        </section>
      </div>

      <section className="border-t border-zinc-200 bg-white p-5"><div className="mb-3 flex items-end justify-between"><div><h2 className="text-sm font-semibold">Verification Intent 闭环</h2><p className="mt-1 text-xs text-zinc-500">Requirement / Risk → Intent → Simulation / Assertion / Formal / Static → Evidence</p></div><span className="text-xs text-zinc-400">RTL {state.rtlHash.slice(0, 10)}</span></div>
        <div className="overflow-auto border border-zinc-200"><table className="w-full min-w-[900px] text-left text-xs"><thead className="bg-zinc-100 text-zinc-500"><tr><th className="px-3 py-2">Intent</th><th className="px-3 py-2">验证目标</th><th className="px-3 py-2">方法</th><th className="px-3 py-2">边界</th><th className="px-3 py-2">优先级</th><th className="px-3 py-2">状态</th><th className="px-3 py-2">证据</th></tr></thead><tbody>
          {state.verificationIntents.map((intent) => <tr key={intent.id} className="border-t border-zinc-100"><td className="px-3 py-2 font-mono font-medium text-emerald-700">{intent.id}</td><td className="max-w-md truncate px-3 py-2" title={intent.objective}>{intent.objective}</td><td className="px-3 py-2 text-sky-700">{intent.recommendedMethods.join(' + ')}</td><td className="px-3 py-2">{intent.boundaries.length}</td><td className="px-3 py-2 font-mono">{intent.priority.toFixed(3)}</td><td className="px-3 py-2"><span className={`px-2 py-1 ${statusTone(intent.status)}`}>{intent.status}</span></td><td className="px-3 py-2">{intent.evidence.length}</td></tr>)}
        </tbody></table></div>
      </section>

      <div className="grid grid-cols-2 gap-px border-t border-zinc-200 bg-zinc-200">
        <section className="bg-white p-5"><h2 className="text-sm font-semibold">Spec Gap</h2><div className="mt-3 max-h-80 overflow-auto border-y border-zinc-200">{state.specGaps.map((gap) => <div key={gap.id} className="border-b border-zinc-100 px-2 py-3"><div className="flex items-center gap-2"><strong className="font-mono text-xs text-amber-700">{gap.id}</strong><span className="bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700">{gap.category}</span><span className="ml-auto text-[10px] text-zinc-400">{gap.confidence}</span></div><div className="mt-1 text-xs font-medium text-zinc-700">{gap.title}</div><div className="mt-1 text-[11px] text-zinc-500">处置：{gap.action}</div></div>)}{state.specGaps.length === 0 && <div className="p-6 text-sm text-emerald-700">当前未识别到 Spec Gap。</div>}</div></section>
        <section className="bg-white p-5"><h2 className="text-sm font-semibold">Coverage Hole</h2><div className="mt-3 max-h-80 overflow-auto border-y border-zinc-200">{state.coverageHoles.map((hole) => <div key={hole.id} className="border-b border-zinc-100 px-2 py-3"><div className="flex items-center gap-2"><strong className={`font-mono text-xs ${hole.blocking ? 'text-red-700' : 'text-amber-700'}`}>{HOLE_LABELS[hole.classification] ?? hole.classification}</strong><span className="font-mono text-[10px] text-zinc-400">{hole.scenarioId}</span><span className="ml-auto text-[10px] text-zinc-400">{hole.confidence}</span></div><div className="mt-1 text-xs text-zinc-600">{hole.reason}</div><div className="mt-1 text-[11px] text-zinc-500">建议：{hole.recommendedAction}</div></div>)}{state.coverageHoles.length === 0 && <div className="p-6 text-sm text-emerald-700">当前没有待处理的 Coverage Hole。</div>}</div></section>
      </div>

      <footer className="flex items-center gap-5 border-t border-zinc-200 bg-zinc-100 px-5 py-2 text-[10px] text-zinc-500"><span>生成时间：{new Date(state.generatedAt).toLocaleString()}</span><span>分析器：{state.analyzer?.engine ?? '旧版/未知'} {state.analyzer?.version ?? ''}</span><span>FSM {state.structuralSummary?.fsm ?? 0}</span><span>CFG {state.structuralSummary?.cfgNodes ?? 0}</span><span>COI {state.structuralSummary?.cones ?? 0}</span>{state.verificationIntents.length === 0 && <span className="text-amber-600">旧版模型，请重新生成 AIGV 态势</span>}</footer>
    </main>}
  </div>
}
