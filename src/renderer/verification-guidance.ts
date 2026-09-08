import type { SpecMapping, WaveProgressEntry } from '@shared/types'

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
  criticalOpen?: string[]
  verificationIntents?: GuidanceIntent[]
  specGaps?: Array<{ id: string; title: string; action: string; confidence: string }>
  coverageHoles?: GuidanceHole[]
  regressions?: Array<{ passed: boolean; testsTotal: number; coverage: Record<string, number> }>
  formalResults?: Array<{ status: string; mode: string; scenarioId?: string; obligation?: 'required' | 'supplemental'; classification?: string }>
  closureAssessment?: { status: string; blockers: string[]; warnings: string[]; residualRisks: string[]; nextActions: string[]; metrics: { impactUnknown: number } }
  multiOracle?: { criticalInsufficient: string[]; conflicts: string[] }
  explorationHistory?: { saturation: { status: string; completedRounds: number; noProgressStreak: number; explanation: string } }
  mutationAssessment?: { status: string; weightedScore: number | null; threshold: number; blockingSurvivors: string[] }
  residualRiskRegister?: Array<{ id: string; title: string; approved: boolean; approvalRequired: boolean }>
  /** 波段进度（W0-W3，展示层契约；缺失时回退旧线性七步） */
  waveProgress?: WaveProgressEntry[]
  /** 规格映射完备性矩阵（展示层契约） */
  specMapping?: SpecMapping
}

/** 归一化后数组字段均非空的态势。 */
type NormalizedGuidanceState = Omit<GuidanceState, 'criticalOpen' | 'verificationIntents' | 'specGaps' | 'coverageHoles' | 'regressions' | 'formalResults'> & {
  criticalOpen: string[]
  verificationIntents: GuidanceIntent[]
  specGaps: Array<{ id: string; title: string; action: string; confidence: string }>
  coverageHoles: GuidanceHole[]
  regressions: Array<{ passed: boolean; testsTotal: number; coverage: Record<string, number> }>
  formalResults: Array<{ status: string; mode: string; scenarioId?: string; obligation?: 'required' | 'supplemental'; classification?: string }>
}

/** 把可能缺失的数组字段归一化为空数组，避免旧版/部分态势 JSON 导致 .filter 崩溃。 */
function normalizeGuidanceState(state: GuidanceState): NormalizedGuidanceState {
  return {
    ...state,
    criticalOpen: state.criticalOpen ?? [],
    verificationIntents: state.verificationIntents ?? [],
    specGaps: state.specGaps ?? [],
    coverageHoles: state.coverageHoles ?? [],
    regressions: state.regressions ?? [],
    formalResults: state.formalResults ?? []
  }
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

/** 从 Intent/Hole 里提取具体模块名，让“下一步”落到具体对象而不是只有数量。 */
function moduleNames(state: NormalizedGuidanceState): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  const push = (name: string): void => {
    if (name && /^[a-zA-Z_]\w*$/.test(name) && !seen.has(name) && !/^(test|dut|rtl|intent|scenario)$/i.test(name)) {
      seen.add(name)
      names.push(name)
    }
  }
  for (const hole of state.coverageHoles) {
    const m = /^([a-zA-Z_]\w*)\b/.exec(hole.missingTarget ?? '')
    if (m) push(m[1])
  }
  for (const intent of state.verificationIntents) {
    const m = /验证\s+([a-zA-Z_]\w*)\b/.exec(intent.objective)
    if (m) push(m[1])
  }
  return names.slice(0, 4)
}

/** 生成给 Agent 看的、可直接复用的“下一步”提示。 */
function nextStepPrompt(title: string, scenarioIds: string[], detail: string): string {
  const ids = scenarioIds.slice(0, 3).join('、')
  return `请执行“${title}”：${detail}${ids ? `\n相关场景：${ids}。` : ''}\n读取对应 RTL、VI/SCN 与原始证据；场景执行一律用 run_simulation(scenarioIds=...) 绑定场景，命中登记与态势刷新由工具自动完成，禁止手写 scenario_hits.json 或宣布执行派生状态。`
}

export function deriveVerificationActions(state: GuidanceState): VerificationAction[] {
  const s = normalizeGuidanceState(state)
  const actions: VerificationAction[] = []
  const modules = moduleNames(s)
  const moduleHint = modules.length ? `（${modules.slice(0, 3).join('、')}${modules.length > 3 ? ' 等' : ''}）` : ''

  const highSpecGaps = s.specGaps.filter((item) => item.confidence === 'high')
  const specUndefined = s.coverageHoles.filter((item) => item.classification === 'C5_SPEC_UNDEFINED' && item.blocking)
  const notRun = s.coverageHoles.filter((item) => item.classification === 'C6_TOOL_INSTRUMENTATION' && item.blocking)
  const observation = s.coverageHoles.filter((item) => item.classification === 'C4_OBSERVATION_MISSING' && item.blocking)
  const stimulus = s.coverageHoles.filter((item) => ['C2_CONSTRAINT_BLOCKED', 'C3_STIMULUS_MISSING'].includes(item.classification) && item.blocking)
  const open = s.verificationIntents.filter((item) => !CLOSED_VERIFICATION_STATUSES.has(item.status)).length
  const failedRegressions = s.regressions.filter((item) => !item.passed).length
  const failedFormal = s.formalResults.filter((item) => item.status === 'FAIL' || (item.obligation === 'required' && ['ERROR', 'UNKNOWN'].includes(item.status))).length
  const supplementalFormalErrors = s.formalResults.filter((item) => item.obligation !== 'required' && ['ERROR', 'UNKNOWN'].includes(item.status)).length
  const impactUnknown = s.closureAssessment?.metrics.impactUnknown ?? 0
  const oracleConflicts = s.multiOracle?.conflicts.length ?? 0
  const oracleInsufficient = s.multiOracle?.criticalInsufficient.length ?? 0
  const saturation = s.explorationHistory?.saturation
  const mutation = s.mutationAssessment
  const unapprovedResidual = s.residualRiskRegister?.filter((item) => item.approvalRequired && !item.approved) ?? []

  // 波段感知主行动（展示层契约）：waveProgress 存在时，按 W1→W2→W3 波段状态给出主行动，
  // 避免被“文档级 TBD 清理”这类低价值动作长期占住“下一步”。
  if (s.waveProgress?.length) {
    const w1 = s.waveProgress.find((w) => w.id === 'W1')
    const w2 = s.waveProgress.find((w) => w.id === 'W2')
    const w3 = s.waveProgress.find((w) => w.id === 'W3')
    if (w1 && w1.status === 'in-progress' && (w1.specClauseTotal ?? 0) > (w1.specClauseCovered ?? 0)) {
      actions.push({
        id: 'wave-w1',
        priority: 'P0',
        title: '继续基础功能验证',
        detail: `规格映射矩阵 ${w1.specClauseCovered}/${w1.specClauseTotal} 条款已覆盖，补齐剩余可验证规格的 happy path`,
        count: (w1.specClauseTotal ?? 0) - (w1.specClauseCovered ?? 0),
        prompt: '继续 W1 基础功能：为规格映射矩阵中尚未覆盖的可验证规格条款补充验证 Intent 与 testcase（每条条款至少一条 happy path），用 register_verification_intents 登记（wave=basic），run_simulation 绑定 scenarioIds 执行。'
      })
    } else if (w2 && w2.status === 'in-progress') {
      actions.push({
        id: 'wave-w2',
        priority: 'P0',
        title: '执行下一增补波',
        detail: w2.topics?.length ? `增补波：${w2.topics.map((t) => t.name).join('、')}` : '继续 W2 增补验证',
        count: Math.max(0, (w2.scenarioCount ?? 0) - (w2.passedCount ?? 0)),
        prompt: '继续 W2 增补：按主题波执行剩余场景（wave=corner + topic），同组聚类一次 authoring 多条 testcase，run_simulation 绑定多个 scenarioIds。'
      })
    } else if (w3 && w3.status === 'in-progress') {
      actions.push({
        id: 'wave-w3',
        priority: 'P0',
        title: '推进签核门禁',
        detail: 'W2 增补已完成，处理覆盖率/Formal/Mutation/残余风险等签核门禁',
        count: 1,
        prompt: '推进 W3 签核：执行覆盖率闭合、Formal、Mutation、全量回归，处理残余风险审批，完成后 review_verification_evidence。'
      })
    }
  }

  // P0：C5 规格未定义是最大阻断——不澄清就无法裁决
  if (specUndefined.length > 0) {
    actions.push({
      id: 'clarify-spec',
      priority: 'P0',
      title: '先澄清规格缺口',
      detail: `${specUndefined.length} 个场景被“规格未定义”阻断无法裁决${moduleHint}`,
      count: specUndefined.length,
      prompt: nextStepPrompt('先澄清规格缺口', specUndefined.map((h) => h.scenarioId), `逐条关联需求、规格与 RTL 对象，澄清被阻场景的判定语义${moduleHint}；能从已批准文档裁决的直接更新追踪，涉及外部可见语义变化的发起用户决策，不要自行猜测。`)
    })
  } else if (highSpecGaps.length > 0) {
    // 文档级规格缺口（TBD 待定稿），不阻断当前场景执行，优先级低于真实验证工作
    actions.push({
      id: 'clarify-spec-docs',
      priority: 'P2',
      title: '澄清剩余规格缺口（文档级 TBD）',
      detail: `${highSpecGaps.length} 项高置信度规格缺口待定稿`,
      count: highSpecGaps.length,
      prompt: '读取 spec-gap-register.json，对高置信度规格缺口逐条定稿并更新追踪关系；涉及外部可见语义变化的发起用户决策。'
    })
  }

  // P0：真实回归失败（RTL/测试问题）
  if (failedRegressions > 0) {
    actions.push({
      id: 'fix-regressions',
      priority: 'P0',
      title: '定位并修复失败回归',
      detail: `${failedRegressions} 项回归失败`,
      count: failedRegressions,
      prompt: '读取失败回归的日志/JUnit/波形，定位根因并按 L1-L4 影响分级修复，完成后定向复现、受影响回归、全量回归并更新证据。'
    })
  }
  // P0：Formal 阻断（反例/强制证明未完成）——阻断签核
  if (failedFormal > 0) {
    actions.push({
      id: 'fix-formal',
      priority: 'P0',
      title: '修复 Formal 阻断',
      detail: `${failedFormal} 项 Formal 反例或强制证明未完成（阻断签核）`,
      count: failedFormal,
      prompt: '处理 Formal FAIL（反例=真实缺陷，按 L1-L4 修复）与 required ERROR（工具/环境限制：配置工具链或经批准调整验证义务）；不得把工具限制当 RTL 缺陷，也不得把反例当工具限制。'
    })
  }

  // P0：已到达但无法观察裁决 → 补 Checker/断言
  if (observation.length > 0) {
    actions.push({
      id: 'add-checkers',
      priority: 'P0',
      title: '补充观察点/Checker，让已到达场景可裁决',
      detail: `${observation.length} 个场景已触发但无法判断通过/失败${moduleHint}`,
      count: observation.length,
      prompt: nextStepPrompt('补充观察点/Checker', observation.map((h) => h.scenarioId), `${observation.length} 个场景已到达但无法裁决${moduleHint}；补充 scoreboard/断言/协议检查，运行定向回归记录 assertionPassed 与证据，不要修改正确预期迎合 RTL。`)
    })
  }

  // P0：缺工具证据（场景还没真正跑）
  if (notRun.length > 0) {
    actions.push({
      id: 'run-batch',
      priority: 'P0',
      title: '运行第一批高风险场景',
      detail: `${notRun.length} 个场景尚未真正执行，缺少仿真/覆盖率证据${moduleHint}`,
      count: notRun.length,
      prompt: nextStepPrompt('运行第一批高风险场景', notRun.map((h) => h.scenarioId), `调用 select_next_verification_batch 选最高优先级场景${moduleHint}，用现有 Cocotb 环境执行真实回归，把 hit/verdict/证据写回 scenario_hits.json 与结果目录。`)
    })
  }

  if (stimulus.length > 0) {
    actions.push({
      id: 'run-batch',
      priority: 'P0',
      title: '执行下一批高风险场景',
      detail: `${stimulus.length} 个场景缺定向激励，选最高优先级逐个执行并记录 hit${moduleHint}`,
      count: stimulus.length,
      prompt: nextStepPrompt('执行下一批高风险场景', stimulus.map((h) => h.scenarioId), `调用 select_next_verification_batch 选最高优先级场景${moduleHint}，用现有 Cocotb 环境生成定向激励、run_simulation、记录 scenario_hits/波形，关闭 C3 激励缺失 hole。`)
    })
  }

  if (impactUnknown > 0) {
    actions.push({
      id: 'refresh-change-impact',
      priority: 'P0',
      title: '处理 RTL 变更影响',
      detail: `${impactUnknown} 个 Scenario 的旧证据已失效或影响未知`,
      count: impactUnknown,
      prompt: '读取 closure-assessment.json，对 freshness=IMPACT_UNKNOWN 的场景执行保守影响分析；证明无关的记录结构证据，其余用 run_simulation(scenarioIds=...) 执行受影响回归，rtlHash 由工具自动绑定当前值。'
    })
  }

  if (oracleConflicts > 0) {
    actions.push({
      id: 'resolve-oracle-conflicts',
      priority: 'P0',
      title: '仲裁 Oracle 冲突',
      detail: `${oracleConflicts} 个 Scenario 存在独立判定冲突`,
      count: oracleConflicts,
      prompt: '读取 oracle-evaluation.json 及每个冲突 Oracle 的原始证据，分别检查命题、输入、共享 assumptions、Checker/Reference Model 与 RTL 行为；修复后重跑并发布绑定当前 rtlHash 的 verdict。'
    })
  } else if (oracleInsufficient > 0) {
    actions.push({
      id: 'complete-oracle-evidence',
      priority: 'P1',
      title: '补齐独立 Oracle',
      detail: `${oracleInsufficient} 个关键 Scenario 不足两个独立判定域`,
      count: oracleInsufficient,
      prompt: '为关键 Scenario 补充不同 independenceDomain 的有效 Oracle（Scoreboard、Architecture Assertion、Protocol Checker 或 Formal），把 verdict、证据路径与 rtlHash 写入 oracle_verdicts.json。'
    })
  }

  if (saturation?.status === 'STALLED') {
    actions.push({
      id: 'escape-exploration-stall',
      priority: 'P0',
      title: '退出重复探索',
      detail: `连续 ${saturation.noProgressStreak} 轮没有语义新增且仍有关键缺口`,
      count: saturation.noProgressStreak,
      prompt: '停止重复相同 testcase/seed 和盲改 RTL；比较最近批次，优先增强 Checker/Assertion、扩大合法激励、增加观测点，再开下一轮。'
    })
  }

  if (!mutation || mutation.status !== 'PASS') {
    actions.push({
      id: 'run-risk-mutation',
      priority: mutation?.status === 'BLOCKED_BY_SURVIVOR' ? 'P0' : 'P1',
      title: mutation?.status === 'BLOCKED_BY_SURVIVOR' ? '杀死或审查 Mutation survivor' : '执行风险加权 Mutation',
      detail: mutation ? `状态 ${mutation.status} · Score ${mutation.weightedScore ?? '-'} / ${mutation.threshold}` : '尚无绑定当前 RTL 的 Mutation 结果',
      count: Math.max(1, mutation?.blockingSurvivors.length ?? 0),
      prompt: '按 risk-register.json 对控制优先级、事务计数、边界和错误路径执行风险加权 Mutation；INVALID 不计分，EQUIVALENT 必须具名审查。'
    })
  }

  if (unapprovedResidual.length) {
    actions.push({
      id: 'resolve-residual-risks',
      priority: 'P1',
      title: '关闭或审批剩余风险',
      detail: `${unapprovedResidual.length} 项剩余风险尚未批准`,
      count: unapprovedResidual.length,
      prompt: '读取 residual-risk-register.json；优先用新增证据关闭风险，确需接受时由具名审批人写入 signoff-approvals.json。'
    })
  }

  if (supplementalFormalErrors > 0) {
    actions.push({
      id: 'repair-formal-compatibility',
      priority: 'P1',
      title: '修复补强 Formal 兼容性',
      detail: `${supplementalFormalErrors} 项补强 Formal 未产生求解结论`,
      count: supplementalFormalErrors,
      prompt: '处理补强 Formal 的 ERROR/UNKNOWN；Yosys 前端不兼容时改用 immediate assert/assume/cover、$past 和监控计数器，Liveness 写出有规格依据的最小 assume。'
    })
  }

  if (open > 0 && actions.length === 0) {
    actions.push({
      id: 'continue-closure',
      priority: 'P1',
      title: '继续 Verification Intent 闭环',
      detail: `${open} 个 Intent 尚未闭环`,
      count: open,
      prompt: '选择最高优先级未闭环 Intent，执行适合的 Simulation、Assertion、Formal 或 Static 方法，保存原始证据并重新生成态势。'
    })
  }
  if (open === 0 && failedRegressions + failedFormal === 0) {
    actions.push({
      id: 'signoff-review',
      priority: 'P2',
      title: '执行独立证据审查与签核',
      detail: '关键 Intent 已闭环，进入最终签核检查',
      count: 1,
      prompt: '调用 review_verification_scenarios 与 review_verification_evidence，独立读取测试、日志、JUnit、覆盖率、Formal 与 RTL 原始证据，明确是否具备签核条件。'
    })
  }
  const order = { P0: 0, P1: 1, P2: 2 } as const
  return actions.sort((a, b) => order[a.priority] - order[b.priority])
}

export function deriveTopRisks(state: GuidanceState, risks: GuidanceRisk[]): ExplainedRisk[] {
  const s = normalizeGuidanceState(state)
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
    const relatedIntents = s.verificationIntents.filter((intent) => intent.sourceIds?.includes(risk.id))
    const relatedScenarioIds = new Set(relatedIntents.map((item) => item.scenarioId))
    const holes = s.coverageHoles.filter((item) => relatedScenarioIds.has(item.scenarioId))
    const failed = relatedIntents.some((item) => item.status === 'FAILED')
    const specBlocked = relatedIntents.some((item) => item.status === 'BLOCKED_BY_SPEC') || holes.some((item) => item.classification === 'C5_SPEC_UNDEFINED')
    const infrastructure = holes.some((item) => ['C4_OBSERVATION_MISSING', 'C6_TOOL_INSTRUMENTATION'].includes(item.classification))
    const closed = relatedIntents.length > 0 && relatedIntents.every((item) => CLOSED_VERIFICATION_STATUSES.has(item.status))
    const level: ExplainedRisk['level'] = failed ? '已确认问题' : specBlocked ? '规格缺口' : infrastructure ? '验证基础设施缺口' : closed ? '已接受风险' : '高风险待验证'
    const firstHole = holes[0]
    const gap = firstHole?.missingTarget ?? firstHole?.reason ?? (relatedIntents.length ? `${relatedIntents.filter((item) => !CLOSED_VERIFICATION_STATUSES.has(item.status)).length}/${relatedIntents.length} 个关联 Intent 尚未闭环。` : '旧版快照尚无 Risk → Intent 精确关联；需重新生成 AIGV 态势。')
    const recommendation = risk.failureModes?.length
      ? `重点验证：${risk.object} 是否出现「${risk.failureModes[0]}」，以 ${risk.observableEffects?.[0] ?? '外部可见结果'} 作为通过/失败判定。`
      : (firstHole?.recommendedAction ?? (closed ? '保留现有证据并纳入签核审查。' : '执行关联高优先级 Scenario，并补齐 Checker、Coverage 与原始证据。'))
    const impact = (risk.failureModes?.join('；') ?? '') || risk.observableEffects?.join('；') || impactOf(risk)
    return { risk, level, relatedIntents, gap, impact, recommendation, prompt: `请处理验证风险 ${risk.id}。风险语义：${risk.riskStatement ?? `${risk.title}，对象 ${risk.object}`} 当前缺口：${gap} 可能影响：${impact} 建议：${recommendation} 请读取关联 RTL、VI/SCN 和原始证据，按 Intent 中的激励步骤、观察点和通过标准执行定向仿真、Assertion 或 Formal，完成后重新生成验证态势。` }
  })
}

export function deriveVerificationSteps(state: GuidanceState | null): VerificationStep[] {
  if (!state) return [
    { id: 'planning', label: '验证规划', status: 'running', detail: '尚未生成 AIGV 状态' },
    ...['环境就绪', '基础回归', '风险场景', '覆盖闭环', 'Formal 补强', '验证签核'].map((label, index) => ({ id: `pending-${index}`, label, status: 'pending' as const, detail: '等待前序步骤' }))
  ]
  const s = normalizeGuidanceState(state)
  // 波段化（展示层契约）：有 waveProgress 时用 W0-W3 波段视图
  if (s.waveProgress?.length) {
    return s.waveProgress.map((wave) => ({
      id: wave.id,
      label: wave.label,
      status: wave.status === 'done' ? 'completed' as const : wave.status === 'in-progress' ? 'running' as const : 'pending' as const,
      detail: waveDetail(wave)
    }))
  }
  // 旧线性七步（引擎侧未产出 waveProgress 时回退）
  const intents = s.verificationIntents
  const closed = intents.filter((item) => CLOSED_VERIFICATION_STATUSES.has(item.status)).length
  const closure = intents.length ? Math.round(closed * 100 / intents.length) : 0
  const regressionsPassed = s.regressions.length > 0 && s.regressions.every((item) => item.passed)
  const blockingHoles = s.coverageHoles.filter((item) => item.blocking).length
  const formalFailed = s.formalResults.filter((item) => item.status === 'FAIL' || (item.obligation === 'required' && ['ERROR', 'UNKNOWN'].includes(item.status))).length
  const supplementalFormalErrors = s.formalResults.filter((item) => item.obligation !== 'required' && ['ERROR', 'UNKNOWN'].includes(item.status)).length
  const steps: VerificationStep[] = [
    { id: 'planning', label: '验证规划', status: intents.length ? 'completed' : 'running', detail: intents.length ? `${intents.length} 个 Intent` : '等待生成 Intent' },
    { id: 'environment', label: '环境就绪', status: s.regressions.length ? 'completed' : 'running', detail: s.regressions.length ? '已有结构化回归结果' : '等待仿真环境与结果' },
    { id: 'regression', label: '基础回归', status: regressionsPassed ? 'completed' : s.regressions.length ? 'blocked' : 'pending', detail: s.regressions.length ? (regressionsPassed ? '回归通过' : '存在失败回归') : '尚未执行' },
    { id: 'risk', label: '风险场景', status: closure === 100 ? 'completed' : intents.length ? 'running' : 'pending', detail: `${closed}/${intents.length} Intent 闭环` },
    { id: 'coverage', label: '覆盖闭环', status: blockingHoles === 0 && intents.length ? 'completed' : blockingHoles ? 'blocked' : 'pending', detail: blockingHoles ? `${blockingHoles} 项阻断` : '无阻断 Coverage Hole' },
    { id: 'formal', label: 'Formal 补强', status: formalFailed ? 'blocked' : supplementalFormalErrors ? 'running' : s.formalResults.length ? 'completed' : 'pending', detail: formalFailed ? `${formalFailed} 项强制失败/错误` : supplementalFormalErrors ? `${supplementalFormalErrors} 项补强工具限制` : s.formalResults.length ? `${s.formalResults.length} 项证据` : '按候选场景执行' },
    { id: 'signoff', label: '验证签核', status: closure === 100 && regressionsPassed && blockingHoles === 0 && formalFailed === 0 ? 'completed' : 'pending', detail: closure === 100 && blockingHoles === 0 ? '等待独立证据审查' : '等待前序闭环' }
  ]
  return steps
}

/** 波段步骤详情：W1 用规格条款，W2 用主题波，其余用通过数。 */
function waveDetail(wave: WaveProgressEntry): string {
  if (wave.id === 'W1' && wave.specClauseTotal !== undefined) {
    return `${wave.specClauseCovered ?? 0}/${wave.specClauseTotal} 条款通过`
  }
  if (wave.id === 'W2' && wave.topics?.length) {
    return `${wave.topics.length} 波：${wave.topics.map((topic) => `${topic.name} ${topic.passedCount}/${topic.scenarioCount}`).join('、')}`
  }
  return `${wave.passedCount}/${wave.scenarioCount} 通过`
}
