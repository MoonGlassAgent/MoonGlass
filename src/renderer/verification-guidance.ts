export const CLOSED_VERIFICATION_STATUSES = new Set(['VERIFIED', 'FORMAL_PROVED', 'FORMAL_UNREACHABLE', 'WAIVED'])

export interface GuidanceRisk {
  id: string
  taxonomyId?: string
  title: string
  riskStatement?: string
  rationale?: string
  failureModes?: string[]
  observableEffects?: string[]
  object: string
  features: string[]
  riskScore: number
  confidence: string
  source: { file: string; line?: number }
}

export interface GuidanceIntent {
  id: string
  scenarioId: string
  objective: string
  rationale?: string
  failureMode?: string
  sourceIds?: string[]
  status: string
  priority: number
  recommendedMethods: string[]
  preconditions?: string[]
  stimulusProcedure?: string[]
  observationPoints?: string[]
  expectedResults?: string[]
  passCriteria?: string[]
  evidence: string[]
}

export interface GuidanceHole {
  scenarioId: string
  classification: string
  scenarioTitle?: string
  reason: string
  missingTarget?: string
  requiredStimulus?: string[]
  requiredObservation?: string[]
  closureEvidence?: string[]
  recommendedAction: string
  blocking: boolean
}

export interface GuidanceState {
  criticalOpen: string[]
  verificationIntents: GuidanceIntent[]
  specGaps: Array<{ id: string; title: string; action: string; confidence: string }>
  coverageHoles: GuidanceHole[]
  regressions: Array<{ passed: boolean; testsTotal: number; coverage: Record<string, number> }>
  formalResults: Array<{ status: string; mode: string; scenarioId?: string; obligation?: 'required' | 'supplemental'; classification?: string }>
  closureAssessment?: { status: string; blockers: string[]; warnings: string[]; residualRisks: string[]; nextActions: string[]; metrics: { impactUnknown: number } }
  multiOracle?: { criticalInsufficient: string[]; conflicts: string[] }
  explorationHistory?: { saturation: { status: string; completedRounds: number; noProgressStreak: number; explanation: string } }
  mutationAssessment?: { status: string; weightedScore: number | null; threshold: number; blockingSurvivors: string[] }
  residualRiskRegister?: Array<{ id: string; title: string; approved: boolean; approvalRequired: boolean }>
}

export interface VerificationAction {
  id: string
  priority: 'P0' | 'P1' | 'P2'
  title: string
  detail: string
  count: number
  prompt: string
}

export interface ExplainedRisk {
  risk: GuidanceRisk
  level: '已确认问题' | '高风险待验证' | '验证基础设施缺口' | '规格缺口' | '已接受风险'
  relatedIntents: GuidanceIntent[]
  gap: string
  impact: string
  recommendation: string
  prompt: string
}

export interface VerificationStep {
  id: string
  label: string
  status: 'pending' | 'running' | 'blocked' | 'completed'
  detail: string
}

const IMPACTS: Array<[RegExp, string]> = [
  [/reset|复位/i, '可能导致在途事务丢失、重复完成或状态机无法恢复。'],
  [/fifo|backpressure|反压/i, '可能导致数据覆盖、丢失、乱序或接口停滞。'],
  [/timeout|response|响应/i, '可能造成迟到响应被重复接收、错误计数或错误完成。'],
  [/interrupt|中断/i, '可能造成中断漏报、重复上报或软件无法清除状态。'],
  [/counter|计数|outstanding/i, '可能在容量边界发生上溢、下溢或资源统计失配。'],
  [/cdc|clock|时钟/i, '可能产生跨时钟域脉冲丢失、亚稳态或多比特数据不一致。'],
  [/error|fault|错误/i, '可能使错误路径与正常完成路径产生冲突，影响外部可见结果。']
]

function impactOf(risk: GuidanceRisk): string {
  const text = `${risk.title} ${risk.features.join(' ')}`
  return IMPACTS.find(([pattern]) => pattern.test(text))?.[1] ?? '可能影响外部可见行为、边界条件或异常恢复，需要以原始证据裁决。'
}

export function deriveVerificationActions(state: GuidanceState): VerificationAction[] {
  const actions: VerificationAction[] = []
  const failedRegressions = state.regressions.filter((item) => !item.passed).length
  const failedFormal = state.formalResults.filter((item) => item.status === 'FAIL' || (item.obligation === 'required' && ['ERROR', 'UNKNOWN'].includes(item.status))).length
  const supplementalFormalErrors = state.formalResults.filter((item) => item.obligation !== 'required' && ['ERROR', 'UNKNOWN'].includes(item.status)).length
  const observation = state.coverageHoles.filter((item) => item.classification === 'C4_OBSERVATION_MISSING' && item.blocking).length
  const stimulus = state.coverageHoles.filter((item) => ['C2_CONSTRAINT_BLOCKED', 'C3_STIMULUS_MISSING'].includes(item.classification) && item.blocking).length
  const instrumentation = state.coverageHoles.filter((item) => item.classification === 'C6_TOOL_INSTRUMENTATION' && item.blocking).length
  const spec = state.specGaps.filter((item) => item.confidence === 'high').length
  const open = state.verificationIntents.filter((item) => !CLOSED_VERIFICATION_STATUSES.has(item.status)).length
  const impactUnknown = state.closureAssessment?.metrics.impactUnknown ?? 0
  const oracleConflicts = state.multiOracle?.conflicts.length ?? 0
  const oracleInsufficient = state.multiOracle?.criticalInsufficient.length ?? 0
  const saturation = state.explorationHistory?.saturation
  const mutation = state.mutationAssessment
  const unapprovedResidual = state.residualRiskRegister?.filter((item) => item.approvalRequired && !item.approved) ?? []

  if (impactUnknown > 0) actions.push({ id: 'refresh-change-impact', priority: 'P0', title: '处理 RTL 变更影响', detail: `${impactUnknown} 个 Scenario 的旧证据已失效或影响未知`, count: impactUnknown, prompt: '请读取 closure-assessment.json 和 Scenario 多轴状态，针对 freshness=IMPACT_UNKNOWN 的场景执行保守影响分析。能够证明无关的记录结构证据；其余执行受影响回归并让 scenario_hits.json 携带当前 rtlHash。禁止继续沿用旧 RTL 的验证证据。' })
  if (oracleConflicts > 0) actions.push({ id: 'resolve-oracle-conflicts', priority: 'P0', title: '仲裁 Oracle 冲突', detail: `${oracleConflicts} 个 Scenario 存在独立判定冲突`, count: oracleConflicts, prompt: '请读取 oracle-evaluation.json 及每个冲突 Oracle 的原始证据。分别检查适用命题、输入、共享 assumptions、Checker/Reference Model 实现和 RTL 行为；不得按固定优先级覆盖任一结论。修复 Oracle 或 RTL 后重新执行并发布绑定当前 rtlHash 的 verdict。' })
  else if (oracleInsufficient > 0) actions.push({ id: 'complete-oracle-evidence', priority: 'P1', title: '补齐独立 Oracle', detail: `${oracleInsufficient} 个关键 Scenario 不足两个独立判定域`, count: oracleInsufficient, prompt: '请读取 oracle-registry.json 和 oracle-evaluation.json，为关键 Scenario 补充不同 independenceDomain 的有效 Oracle。优先组合 Scoreboard、Architecture Invariant/Assertion、Protocol Checker 或有效 Formal Property；将 verdict、证据路径与当前 rtlHash 写入 oracle_verdicts.json。' })
  if (saturation?.status === 'STALLED') actions.push({ id: 'escape-exploration-stall', priority: 'P0', title: '退出重复探索', detail: `连续 ${saturation.noProgressStreak} 轮没有语义新增且仍有关键缺口`, count: saturation.noProgressStreak, prompt: 'Explorer 已进入 STALLED。停止重复相同 testcase/seed 和盲改 RTL；读取 exploration-history.json 比较最近批次，优先增强阶段性 Checker/Assertion、扩大合法激励、增加观测点或修正 Verification Space。形成不同策略后再开启下一轮。' })
  else if (state.criticalOpen.length === 0 && saturation?.status !== 'EMPIRICALLY_SATURATED') actions.push({ id: 'continue-attack-exploration', priority: 'P1', title: '继续独立攻击探索', detail: saturation?.explanation ?? '尚无足够 Exploration Round', count: Math.max(1, 3 - (saturation?.completedRounds ?? 0)), prompt: '关键证据已闭环，但尚未获得经验性 Novelty Saturation。使用不同随机种子、边界组合或探索策略调用 select_next_verification_batch，真实执行并回灌证据；不得通过反复刷新态势伪造探索轮次。' })
  if (!mutation || mutation.status !== 'PASS') actions.push({ id: 'run-risk-mutation', priority: mutation?.status === 'BLOCKED_BY_SURVIVOR' ? 'P0' : 'P1', title: mutation?.status === 'BLOCKED_BY_SURVIVOR' ? '杀死或审查 Mutation survivor' : '执行风险加权 Mutation', detail: mutation ? `状态 ${mutation.status} · Score ${mutation.weightedScore ?? '-'} / ${mutation.threshold}` : '尚无绑定当前 RTL 的 Mutation 结果', count: Math.max(1, mutation?.blockingSurvivors.length ?? 0), prompt: '请根据 risk-register.json 对控制优先级、事务计数、边界和错误路径执行风险加权 Mutation，产出 mutation-results.json。增强 Checker/Assertion/激励以杀死 survivor；INVALID 不计分，EQUIVALENT 必须具名审查，EQUIVALENCE_UNKNOWN 不得自动排除。' })
  if (unapprovedResidual.length) actions.push({ id: 'resolve-residual-risks', priority: 'P1', title: '关闭或审批 Residual Risk', detail: `${unapprovedResidual.length} 项剩余风险尚未批准`, count: unapprovedResidual.length, prompt: '请读取 residual-risk-register.json。优先用新增证据关闭风险；确需接受时，由具名审批人在 signoff-approvals.json 写入 riskId、approver、rationale、approvedAt。Agent 不得代替用户或责任人伪造审批。' })
  if (failedRegressions + failedFormal > 0) actions.push({ id: 'fix-failures', priority: 'P0', title: '定位并修复失败证据', detail: `${failedRegressions} 项回归失败，${failedFormal} 项 Formal 失败/错误`, count: failedRegressions + failedFormal, prompt: '请优先处理验证态势中的失败回归和 Formal FAIL/ERROR。读取原始日志、JUnit、波形、property 和 trace，定位根因；按 L1-L4 影响分级修复，完成定向复现、受影响回归、全量回归并更新验证态势。' })
  if (supplementalFormalErrors > 0) actions.push({ id: 'repair-formal-compatibility', priority: 'P1', title: '修复补强 Formal 兼容性', detail: `${supplementalFormalErrors} 项补强 Formal 未产生求解结论`, count: supplementalFormalErrors, prompt: '请处理补强 Formal 的 ERROR/UNKNOWN。先读取 formal-result.json 的 classification 和 compatibilityIssues；Yosys 前端不兼容时改用 always @(posedge clk) 内的 immediate assert/assume/cover、$past 和监控计数器。Liveness 必须为 ready/response 等环境输入写出有规格依据的最小 assume。补强 Formal 不得覆盖已有仿真结论，也不得把解析错误称为 RTL 缺陷。' })
  if (observation > 0) actions.push({ id: 'add-checkers', priority: 'P0', title: '补充 Checker 与观察点', detail: `${observation} 个场景已到达但无法裁决`, count: observation, prompt: '请处理验证态势中 C4 观察缺失项。为已到达 Scenario 补充 scoreboard、assertion、协议检查和功能覆盖观察点，禁止修改正确预期来迎合 RTL；运行定向回归并记录 assertionPassed 与原始证据。' })
  if (instrumentation > 0) actions.push({ id: 'repair-instrumentation', priority: 'P0', title: '修复验证工具与插桩', detail: `${instrumentation} 项缺少结构化结果或覆盖率证据`, count: instrumentation, prompt: '请处理 C6 工具/插桩问题，检查仿真命令、result.json、JUnit、scenario_hits.json、覆盖率和波形是否真实落盘。修复工具链后重跑，不得用手工总结替代证据。' })
  if (stimulus > 0) actions.push({ id: 'run-risk-batch', priority: 'P1', title: '执行下一批高风险场景', detail: `${stimulus} 个场景缺少有效激励或受约束阻断`, count: stimulus, prompt: '请调用 select_next_verification_batch，优先执行验证态势中的 C2/C3 高风险 Scenario。审查协议合法约束，生成定向激励、时间交互和边界序列，运行真实回归并更新 Scenario hit、Coverage Delta 和证据。' })
  if (spec > 0) actions.push({ id: 'resolve-spec-gaps', priority: 'P1', title: '关闭高置信度 Spec Gap', detail: `${spec} 项规格语义阻断验证裁决`, count: spec, prompt: '请审查验证态势中的高置信度 Spec Gap，关联需求、规格、RTL 对象和受阻 Scenario。能从已批准文档裁决的直接更新追踪；涉及外部可见语义或优先级变化时发起 L4 用户决策，不得自行猜测。' })
  if (open > 0 && actions.length === 0) actions.push({ id: 'continue-closure', priority: 'P1', title: '继续 Verification Intent 闭环', detail: `${open} 个 Intent 尚未闭环`, count: open, prompt: '请基于验证态势继续 Verification Intent 闭环。选择最高优先级未闭环 Intent，执行适合的 Simulation、Assertion、Formal 或 Static 方法，保存原始证据并重新生成态势。' })
  if (open === 0 && failedRegressions + failedFormal === 0) actions.push({ id: 'signoff-review', priority: 'P2', title: '执行独立证据审查与签核', detail: '关键 Intent 已闭环，进入最终签核检查', count: 1, prompt: '请执行最终验证签核：调用 review_verification_scenarios 与 review_verification_evidence，独立读取测试、日志、JUnit、覆盖率、Formal 和 RTL 原始证据，更新 verification_signoff_plan.md 与验证报告，明确是否具备签核条件。' })
  const order = { P0: 0, P1: 1, P2: 2 } as const
  return actions.sort((a, b) => order[a.priority] - order[b.priority])
}

export function deriveTopRisks(state: GuidanceState, risks: GuidanceRisk[]): ExplainedRisk[] {
  const ranked = [...risks].sort((a, b) => b.riskScore - a.riskScore)
  const selected: GuidanceRisk[] = []
  const categories = new Set<string>()
  for (const risk of ranked) {
    const category = risk.taxonomyId ?? risk.title
    if (categories.has(category)) continue
    categories.add(category)
    selected.push(risk)
    if (selected.length === 5) break
  }
  for (const risk of ranked) {
    if (selected.length === 5) break
    if (!selected.includes(risk)) selected.push(risk)
  }
  return selected.map((risk) => {
    const relatedIntents = state.verificationIntents.filter((intent) => intent.sourceIds?.includes(risk.id))
    const relatedScenarioIds = new Set(relatedIntents.map((item) => item.scenarioId))
    const holes = state.coverageHoles.filter((item) => relatedScenarioIds.has(item.scenarioId))
    const failed = relatedIntents.some((item) => item.status === 'FAILED')
    const specBlocked = relatedIntents.some((item) => item.status === 'BLOCKED_BY_SPEC') || holes.some((item) => item.classification === 'C5_SPEC_UNDEFINED')
    const infrastructure = holes.some((item) => ['C4_OBSERVATION_MISSING', 'C6_TOOL_INSTRUMENTATION'].includes(item.classification))
    const closed = relatedIntents.length > 0 && relatedIntents.every((item) => CLOSED_VERIFICATION_STATUSES.has(item.status))
    const level: ExplainedRisk['level'] = failed ? '已确认问题' : specBlocked ? '规格缺口' : infrastructure ? '验证基础设施缺口' : closed ? '已接受风险' : '高风险待验证'
    const firstHole = holes[0]
    const gap = firstHole?.missingTarget ?? firstHole?.reason ?? (relatedIntents.length ? `${relatedIntents.filter((item) => !CLOSED_VERIFICATION_STATUSES.has(item.status)).length}/${relatedIntents.length} 个关联 Intent 尚未闭环。` : '旧版快照尚无 Risk → Intent 精确关联；需重新生成 AIGV 态势。')
    const recommendation = firstHole?.recommendedAction ?? (closed ? '保留现有证据并纳入签核审查。' : '执行关联高优先级 Scenario，并补齐 Checker、Coverage 与原始证据。')
    const impact = risk.observableEffects?.join('；') || impactOf(risk)
    return { risk, level, relatedIntents, gap, impact, recommendation, prompt: `请处理验证风险 ${risk.id}。风险语义：${risk.riskStatement ?? `${risk.title}，对象 ${risk.object}`} 当前缺口：${gap} 可能影响：${impact} 建议：${recommendation} 请读取关联 RTL、VI/SCN 和原始证据，按 Intent 中的激励步骤、观察点和通过标准执行定向仿真、Assertion 或 Formal，完成后重新生成验证态势。` }
  })
}

export function deriveVerificationSteps(state: GuidanceState | null): VerificationStep[] {
  if (!state) return [
    { id: 'planning', label: '验证规划', status: 'running', detail: '尚未生成 AIGV 状态' },
    ...['环境就绪', '基础回归', '风险场景', '覆盖闭环', 'Formal 补强', '验证签核'].map((label, index) => ({ id: `pending-${index}`, label, status: 'pending' as const, detail: '等待前序步骤' }))
  ]
  const intents = state.verificationIntents
  const closed = intents.filter((item) => CLOSED_VERIFICATION_STATUSES.has(item.status)).length
  const closure = intents.length ? Math.round(closed * 100 / intents.length) : 0
  const regressionsPassed = state.regressions.length > 0 && state.regressions.every((item) => item.passed)
  const blockingHoles = state.coverageHoles.filter((item) => item.blocking).length
  const formalFailed = state.formalResults.filter((item) => item.status === 'FAIL' || (item.obligation === 'required' && ['ERROR', 'UNKNOWN'].includes(item.status))).length
  const supplementalFormalErrors = state.formalResults.filter((item) => item.obligation !== 'required' && ['ERROR', 'UNKNOWN'].includes(item.status)).length
  const steps: VerificationStep[] = [
    { id: 'planning', label: '验证规划', status: intents.length ? 'completed' : 'running', detail: intents.length ? `${intents.length} 个 Intent` : '等待生成 Intent' },
    { id: 'environment', label: '环境就绪', status: state.regressions.length ? 'completed' : 'running', detail: state.regressions.length ? '已有结构化回归结果' : '等待仿真环境与结果' },
    { id: 'regression', label: '基础回归', status: regressionsPassed ? 'completed' : state.regressions.length ? 'blocked' : 'pending', detail: state.regressions.length ? (regressionsPassed ? '回归通过' : '存在失败回归') : '尚未执行' },
    { id: 'risk', label: '风险场景', status: closure === 100 ? 'completed' : intents.length ? 'running' : 'pending', detail: `${closed}/${intents.length} Intent 闭环` },
    { id: 'coverage', label: '覆盖闭环', status: blockingHoles === 0 && intents.length ? 'completed' : blockingHoles ? 'blocked' : 'pending', detail: blockingHoles ? `${blockingHoles} 项阻断` : '无阻断 Coverage Hole' },
    { id: 'formal', label: 'Formal 补强', status: formalFailed ? 'blocked' : supplementalFormalErrors ? 'running' : state.formalResults.length ? 'completed' : 'pending', detail: formalFailed ? `${formalFailed} 项强制失败/错误` : supplementalFormalErrors ? `${supplementalFormalErrors} 项补强工具限制` : state.formalResults.length ? `${state.formalResults.length} 项证据` : '按候选场景执行' },
    { id: 'signoff', label: '验证签核', status: closure === 100 && regressionsPassed && blockingHoles === 0 && formalFailed === 0 ? 'completed' : 'pending', detail: closure === 100 && blockingHoles === 0 ? '等待独立证据审查' : '等待前序闭环' }
  ]
  return steps
}
