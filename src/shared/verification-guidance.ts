/**
 * 验证行动推导内核（VERIF-RUN-LOOP 批 1：自渲染端 verification-guidance 下沉 shared）。
 *
 * 本模块承载全部纯推导逻辑（行动/步骤/Top 风险推导、态势归一化），渲染端与主进程
 * 验证运行循环共用同一份实现（设计文档 §3.1）：用户看到的“主行动”与机器自动执行的
 * “下一拍”永远一致。
 *
 * i18n 分层：本模块不依赖任何 i18n 实现，推导过程只产出文案 key 与插值参数，
 * 由调用方注入 GuidanceTranslate 完成解析（渲染端薄壳注入 i18n 的 t()；
 * 主进程运行循环注入自己的解析实现）。
 */
import type { SpecMapping, WaveProgressEntry } from '@shared/types'

/** 推导过程用到的全部界面文案 key（渲染端注入的 t() 必须能解析每个 key，否则 typecheck 报错） */
export type GuidanceMessageKey =
  | 'verification.topicExplanations.concurrencyCollision'
  | 'verification.topicExplanations.priorityArbitration'
  | 'verification.topicExplanations.inflightConsistency'
  | 'verification.topicExplanations.counterBoundary'
  | 'verification.topicExplanations.errorInjection'
  | 'verification.topicExplanations.resetCollision'
  | 'verification.topicExplanations.swHwConcurrency'
  | 'verification.topicExplanations.cdc'
  | 'verification.topicExplanations.timeout'
  | 'verification.topicExplanations.backpressure'
  | 'verification.topicExplanations.resourceExhaustion'
  | 'verification.topicExplanations.errorRecovery'
  | 'verification.topicExplanations.busyConfigChange'
  | 'verification.topicExplanations.interruptConcurrency'
  | 'verification.topicExplanations.boundary'
  | 'verification.topicExplanations.performance'
  | 'verification.topicExplanations.default'
  | 'verification.impacts.reset'
  | 'verification.impacts.fifo'
  | 'verification.impacts.timeout'
  | 'verification.impacts.interrupt'
  | 'verification.impacts.counter'
  | 'verification.impacts.cdc'
  | 'verification.impacts.error'
  | 'verification.impacts.default'
  | 'verification.guidance.moduleHintMore'
  | 'verification.guidance.moduleHint'
  | 'verification.guidance.listJoin'
  | 'verification.guidance.clauseJoin'
  | 'verification.actionTexts.continueW1Title'
  | 'verification.actionTexts.continueW1Detail'
  | 'verification.actionTexts.continueW2Title'
  | 'verification.actionTexts.continueW2Topics'
  | 'verification.actionTexts.continueW2Default'
  | 'verification.actionTexts.w3Title'
  | 'verification.actionTexts.w3Detail'
  | 'verification.actionTexts.clarifySpecTitle'
  | 'verification.actionTexts.clarifySpecDetail'
  | 'verification.actionTexts.clarifySpecDocsTitle'
  | 'verification.actionTexts.clarifySpecDocsDetail'
  | 'verification.actionTexts.fixRegressionsTitle'
  | 'verification.actionTexts.fixRegressionsDetail'
  | 'verification.actionTexts.fixFormalTitle'
  | 'verification.actionTexts.fixFormalDetail'
  | 'verification.actionTexts.addCheckersTitle'
  | 'verification.actionTexts.addCheckersDetail'
  | 'verification.actionTexts.runBatchTitle'
  | 'verification.actionTexts.runBatchDetail'
  | 'verification.actionTexts.runNextBatchTitle'
  | 'verification.actionTexts.runNextBatchDetail'
  | 'verification.actionTexts.changeImpactTitle'
  | 'verification.actionTexts.changeImpactDetail'
  | 'verification.actionTexts.oracleConflictsTitle'
  | 'verification.actionTexts.oracleConflictsDetail'
  | 'verification.actionTexts.completeOracleTitle'
  | 'verification.actionTexts.completeOracleDetail'
  | 'verification.actionTexts.escapeStallTitle'
  | 'verification.actionTexts.escapeStallDetail'
  | 'verification.actionTexts.mutationKillTitle'
  | 'verification.actionTexts.mutationRunTitle'
  | 'verification.actionTexts.mutationDetail'
  | 'verification.actionTexts.mutationNoResult'
  | 'verification.actionTexts.residualTitle'
  | 'verification.actionTexts.residualDetail'
  | 'verification.actionTexts.formalCompatTitle'
  | 'verification.actionTexts.formalCompatDetail'
  | 'verification.actionTexts.continueClosureTitle'
  | 'verification.actionTexts.continueClosureDetail'
  | 'verification.actionTexts.signoffReviewTitle'
  | 'verification.actionTexts.signoffReviewDetail'
  | 'verification.topRisks.intentsOpen'
  | 'verification.topRisks.noLink'
  | 'verification.topRisks.verifyFocus'
  | 'verification.topRisks.defaultEffect'
  | 'verification.topRisks.keepEvidence'
  | 'verification.topRisks.runScenarios'
  | 'verification.stepLabels.planning'
  | 'verification.stepLabels.environment'
  | 'verification.stepLabels.regression'
  | 'verification.stepLabels.risk'
  | 'verification.stepLabels.coverage'
  | 'verification.stepLabels.formal'
  | 'verification.stepLabels.signoff'
  | 'verification.stepDetails.noState'
  | 'verification.stepDetails.waitPrevious'
  | 'verification.stepDetails.intentCount'
  | 'verification.stepDetails.waitIntents'
  | 'verification.stepDetails.envReady'
  | 'verification.stepDetails.envWaiting'
  | 'verification.stepDetails.regressionPassed'
  | 'verification.stepDetails.regressionFailed'
  | 'verification.stepDetails.notExecuted'
  | 'verification.stepDetails.intentClosure'
  | 'verification.stepDetails.blocking'
  | 'verification.stepDetails.noBlocking'
  | 'verification.stepDetails.formalFailed'
  | 'verification.stepDetails.formalToolLimited'
  | 'verification.stepDetails.formalEvidence'
  | 'verification.stepDetails.formalRun'
  | 'verification.stepDetails.waitReview'
  | 'verification.stepDetails.waitClosure'
  | 'verification.stepDetails.clausesPassed'
  | 'verification.stepDetails.clausesPassedStale'
  | 'verification.stepDetails.waves'
  | 'verification.stepDetails.passed'

/** 文案解析回调：由调用方注入（渲染端为 i18n 的 t()），shared 不绑定任何 i18n 实现 */
export type GuidanceTranslate = (key: GuidanceMessageKey, params?: Record<string, string | number>) => string

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
  /** 波段进度（W1-W3，展示层契约；缺失时回退旧线性七步；旧快照可能仍含 W0 条目） */
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

/**
 * 推导内核已知动作 id 全集（VERIF-RUN-LOOP 批 3 §3.2 合法性校验白名单）：
 * deriveVerificationActions 可能产出的全部动作 id，与下方各规则的 push 一一对应。
 * 规则层校验 LLM/工程师提案时，derived 类决策的 actionId 必须命中本表（幻觉动作一律拒绝）；
 * 新增推导规则时必须同步维护本表。
 */
export const VERIFICATION_DERIVED_ACTION_IDS: readonly string[] = [
  'wave-w1',
  'wave-w2',
  'wave-w3',
  'clarify-spec',
  'clarify-spec-docs',
  'fix-regressions',
  'fix-formal',
  'add-checkers',
  'run-batch',
  'refresh-change-impact',
  'resolve-oracle-conflicts',
  'complete-oracle-evidence',
  'escape-exploration-stall',
  'run-risk-mutation',
  'resolve-residual-risks',
  'repair-formal-compatibility',
  'continue-closure',
  'signoff-review'
]

/** 风险等级标识（界面显示经 verification.riskLevels 映射为文案） */
export type RiskLevel = 'confirmed' | 'highRisk' | 'infraGap' | 'specGap' | 'accepted'

export interface ExplainedRisk {
  risk: GuidanceRisk
  level: RiskLevel
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
  /** 悬浮提示（如 W2 主题波的“为什么验这个”说明）；缺省时展示层回退 detail */
  title?: string
}

/** W2 增补主题 → 说明文案 key（展示层映射表；主题名为引擎 TAXONOMY_TOPICS 与提示词示例的归一化形式） */
const TOPIC_EXPLANATION_KEYS: Record<string, GuidanceMessageKey> = {
  并发碰撞: 'verification.topicExplanations.concurrencyCollision',
  优先级仲裁: 'verification.topicExplanations.priorityArbitration',
  在途事务一致性: 'verification.topicExplanations.inflightConsistency',
  计数器边界: 'verification.topicExplanations.counterBoundary',
  错误注入: 'verification.topicExplanations.errorInjection',
  复位碰撞: 'verification.topicExplanations.resetCollision',
  软硬件并发: 'verification.topicExplanations.swHwConcurrency',
  跨时钟域: 'verification.topicExplanations.cdc',
  超时处理: 'verification.topicExplanations.timeout',
  反压: 'verification.topicExplanations.backpressure',
  资源耗尽: 'verification.topicExplanations.resourceExhaustion',
  错误恢复: 'verification.topicExplanations.errorRecovery',
  忙时配置变更: 'verification.topicExplanations.busyConfigChange',
  中断并发: 'verification.topicExplanations.interruptConcurrency',
  边界: 'verification.topicExplanations.boundary',
  性能: 'verification.topicExplanations.performance'
}

/** W2 主题“为什么验这个”说明：与引擎 normalizeTopic 同口径归一后查表，未知主题用通用句式。 */
export function topicExplanation(topic: string, tr: GuidanceTranslate): string {
  const normalized = topic.trim().toLowerCase().replace(/\s+/g, ' ')
  const key = TOPIC_EXPLANATION_KEYS[normalized]
  return key ? tr(key) : tr('verification.topicExplanations.default')
}

const IMPACTS: Array<[RegExp, GuidanceMessageKey]> = [
  [/reset|复位/i, 'verification.impacts.reset'],
  [/fifo|backpressure|反压/i, 'verification.impacts.fifo'],
  [/timeout|response|响应/i, 'verification.impacts.timeout'],
  [/interrupt|中断/i, 'verification.impacts.interrupt'],
  [/counter|计数|outstanding/i, 'verification.impacts.counter'],
  [/cdc|clock|时钟/i, 'verification.impacts.cdc'],
  [/error|fault|错误/i, 'verification.impacts.error']
]

function impactOf(risk: GuidanceRisk, tr: GuidanceTranslate): string {
  const text = `${risk.title} ${risk.features.join(' ')}`
  const key = IMPACTS.find(([pattern]) => pattern.test(text))?.[1]
  return key ? tr(key) : tr('verification.impacts.default')
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

export function deriveVerificationActions(state: GuidanceState, tr: GuidanceTranslate): VerificationAction[] {
  const s = normalizeGuidanceState(state)
  const actions: VerificationAction[] = []
  const modules = moduleNames(s)
  // 模块名提示：界面详情与 Agent 提示词共用，随界面语言本地化
  const moduleHint = modules.length
    ? tr(modules.length > 3 ? 'verification.guidance.moduleHintMore' : 'verification.guidance.moduleHint', { modules: modules.slice(0, 3).join(tr('verification.guidance.listJoin')) })
    : ''

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
    // 缺陷 DEFECT-PACK-001#12：W1 覆盖口径 = PASSED + WAIVED（读 specMapping 条款状态；
    // synthesis 通道条款本就不在分母，保持一致）。差值全为已具名豁免条款时不再生成
    // 永不可消除的 P0 卡片，主行动顺延到 W2/W3 门禁与移交类提示。
    const w1Waived = s.specMapping?.clauses?.filter((clause) => clause.status === 'WAIVED' && (clause.channel ?? 'simulation') !== 'synthesis').length ?? 0
    const w1Covered = (w1?.specClauseCovered ?? 0) + w1Waived
    if (w1 && w1.status === 'in-progress' && (w1.specClauseTotal ?? 0) > w1Covered) {
      actions.push({
        id: 'wave-w1',
        priority: 'P0',
        title: tr('verification.actionTexts.continueW1Title'),
        detail: tr('verification.actionTexts.continueW1Detail', { covered: w1Covered, total: w1.specClauseTotal ?? 0 }),
        count: (w1.specClauseTotal ?? 0) - w1Covered,
        prompt: '继续 W1 基础功能：为规格映射矩阵中尚未覆盖的可验证规格条款补充验证 Intent 与 testcase（每条条款至少一条 happy path），用 register_verification_intents 登记（wave=basic），run_simulation 绑定 scenarioIds 执行；本波结束后读取返回的未覆盖点定位与 coverage-detail.json，把未覆盖行/分支作为 W2 定向激励输入。'
      })
    } else if (w2 && w2.status === 'in-progress') {
      actions.push({
        id: 'wave-w2',
        priority: 'P0',
        title: tr('verification.actionTexts.continueW2Title'),
        detail: w2.topics?.length ? tr('verification.actionTexts.continueW2Topics', { topics: w2.topics.map((topic) => topic.name).join(tr('verification.guidance.listJoin')) }) : tr('verification.actionTexts.continueW2Default'),
        count: Math.max(0, (w2.scenarioCount ?? 0) - (w2.passedCount ?? 0)),
        prompt: '继续 W2 增补：按主题波执行剩余场景（wave=corner + topic），同组聚类一次 authoring 多条 testcase，run_simulation 绑定多个 scenarioIds；每波结束采集轻量覆盖率（rtlCoverage 缺省开启），按未覆盖点定位分类 C1-C6 并优先安排定向激励，禁止只靠增加随机 seed。'
      })
    } else if (w3 && w3.status === 'in-progress') {
      actions.push({
        id: 'wave-w3',
        priority: 'P0',
        title: tr('verification.actionTexts.w3Title'),
        detail: tr('verification.actionTexts.w3Detail'),
        count: 1,
        prompt: '推进 W3 签核：RTL 变更后先重新采集覆盖率（旧 rtlHash 数据门禁不采信），再执行覆盖率闭合、Formal、Mutation、全量回归，处理残余风险审批，完成后 review_verification_evidence。'
      })
    }
  }

  // P0：C5 规格未定义是最大阻断——不澄清就无法裁决
  if (specUndefined.length > 0) {
    actions.push({
      id: 'clarify-spec',
      priority: 'P0',
      title: tr('verification.actionTexts.clarifySpecTitle'),
      detail: tr('verification.actionTexts.clarifySpecDetail', { count: specUndefined.length, moduleHint }),
      count: specUndefined.length,
      prompt: nextStepPrompt(tr('verification.actionTexts.clarifySpecTitle'), specUndefined.map((h) => h.scenarioId), `逐条关联需求、规格与 RTL 对象，澄清被阻场景的判定语义${moduleHint}；能从已批准文档裁决的直接更新追踪，涉及外部可见语义变化的发起用户决策，不要自行猜测。`)
    })
  } else if (highSpecGaps.length > 0) {
    // 文档级规格缺口（TBD 待定稿），不阻断当前场景执行，优先级低于真实验证工作
    actions.push({
      id: 'clarify-spec-docs',
      priority: 'P2',
      title: tr('verification.actionTexts.clarifySpecDocsTitle'),
      detail: tr('verification.actionTexts.clarifySpecDocsDetail', { count: highSpecGaps.length }),
      count: highSpecGaps.length,
      prompt: '读取 spec-gap-register.json，对高置信度规格缺口逐条定稿并更新追踪关系；涉及外部可见语义变化的发起用户决策。'
    })
  }

  // P0：真实回归失败（RTL/测试问题）
  if (failedRegressions > 0) {
    actions.push({
      id: 'fix-regressions',
      priority: 'P0',
      title: tr('verification.actionTexts.fixRegressionsTitle'),
      detail: tr('verification.actionTexts.fixRegressionsDetail', { count: failedRegressions }),
      count: failedRegressions,
      prompt: '读取失败回归的日志/JUnit/波形，定位根因并按 L1-L4 影响分级修复，完成后定向复现、受影响回归、全量回归并更新证据。'
    })
  }
  // P0：Formal 阻断（反例/强制证明未完成）——阻断签核
  if (failedFormal > 0) {
    actions.push({
      id: 'fix-formal',
      priority: 'P0',
      title: tr('verification.actionTexts.fixFormalTitle'),
      detail: tr('verification.actionTexts.fixFormalDetail', { count: failedFormal }),
      count: failedFormal,
      prompt: '处理 Formal FAIL（反例=真实缺陷，按 L1-L4 修复）与 required ERROR（工具/环境限制：配置工具链或经批准调整验证义务）；不得把工具限制当 RTL 缺陷，也不得把反例当工具限制。'
    })
  }

  // P0：已到达但无法观察裁决 → 补 Checker/断言
  if (observation.length > 0) {
    actions.push({
      id: 'add-checkers',
      priority: 'P0',
      title: tr('verification.actionTexts.addCheckersTitle'),
      detail: tr('verification.actionTexts.addCheckersDetail', { count: observation.length, moduleHint }),
      count: observation.length,
      prompt: nextStepPrompt(tr('verification.actionTexts.addCheckersTitle'), observation.map((h) => h.scenarioId), `${observation.length} 个场景已到达但无法裁决${moduleHint}；补充 scoreboard/断言/协议检查，运行定向回归记录 assertionPassed 与证据，不要修改正确预期迎合 RTL。`)
    })
  }

  // P0：缺工具证据（场景还没真正跑）
  if (notRun.length > 0) {
    actions.push({
      id: 'run-batch',
      priority: 'P0',
      title: tr('verification.actionTexts.runBatchTitle'),
      detail: tr('verification.actionTexts.runBatchDetail', { count: notRun.length, moduleHint }),
      count: notRun.length,
      prompt: nextStepPrompt(tr('verification.actionTexts.runBatchTitle'), notRun.map((h) => h.scenarioId), `调用 select_next_verification_batch 选最高优先级场景${moduleHint}，用现有 Cocotb 环境执行真实回归，把 hit/verdict/证据写回 scenario_hits.json 与结果目录。`)
    })
  }

  if (stimulus.length > 0) {
    actions.push({
      id: 'run-batch',
      priority: 'P0',
      title: tr('verification.actionTexts.runNextBatchTitle'),
      detail: tr('verification.actionTexts.runNextBatchDetail', { count: stimulus.length, moduleHint }),
      count: stimulus.length,
      prompt: nextStepPrompt(tr('verification.actionTexts.runNextBatchTitle'), stimulus.map((h) => h.scenarioId), `调用 select_next_verification_batch 选最高优先级场景${moduleHint}，用现有 Cocotb 环境生成定向激励、run_simulation、记录 scenario_hits/波形，关闭 C3 激励缺失 hole。`)
    })
  }

  if (impactUnknown > 0) {
    actions.push({
      id: 'refresh-change-impact',
      priority: 'P0',
      title: tr('verification.actionTexts.changeImpactTitle'),
      detail: tr('verification.actionTexts.changeImpactDetail', { count: impactUnknown }),
      count: impactUnknown,
      prompt: '读取 closure-assessment.json，对 freshness=IMPACT_UNKNOWN 的场景执行保守影响分析；证明无关的记录结构证据，其余用 run_simulation(scenarioIds=...) 执行受影响回归，rtlHash 由工具自动绑定当前值。'
    })
  }

  if (oracleConflicts > 0) {
    actions.push({
      id: 'resolve-oracle-conflicts',
      priority: 'P0',
      title: tr('verification.actionTexts.oracleConflictsTitle'),
      detail: tr('verification.actionTexts.oracleConflictsDetail', { count: oracleConflicts }),
      count: oracleConflicts,
      prompt: '读取 oracle-evaluation.json 及每个冲突 Oracle 的原始证据，分别检查命题、输入、共享 assumptions、Checker/Reference Model 与 RTL 行为；修复后重跑并发布绑定当前 rtlHash 的 verdict。'
    })
  } else if (oracleInsufficient > 0) {
    actions.push({
      id: 'complete-oracle-evidence',
      priority: 'P1',
      title: tr('verification.actionTexts.completeOracleTitle'),
      detail: tr('verification.actionTexts.completeOracleDetail', { count: oracleInsufficient }),
      count: oracleInsufficient,
      prompt: '为关键 Scenario 补充不同 independenceDomain 的有效 Oracle（Scoreboard、Architecture Assertion、Protocol Checker 或 Formal），把 verdict、证据路径与 rtlHash 写入 oracle_verdicts.json。'
    })
  }

  if (saturation?.status === 'STALLED') {
    actions.push({
      id: 'escape-exploration-stall',
      priority: 'P0',
      title: tr('verification.actionTexts.escapeStallTitle'),
      detail: tr('verification.actionTexts.escapeStallDetail', { count: saturation.noProgressStreak }),
      count: saturation.noProgressStreak,
      prompt: '停止重复相同 testcase/seed 和盲改 RTL；比较最近批次，优先增强 Checker/Assertion、扩大合法激励、增加观测点，再开下一轮。'
    })
  }

  if (!mutation || mutation.status !== 'PASS') {
    actions.push({
      id: 'run-risk-mutation',
      priority: mutation?.status === 'BLOCKED_BY_SURVIVOR' ? 'P0' : 'P1',
      title: mutation?.status === 'BLOCKED_BY_SURVIVOR' ? tr('verification.actionTexts.mutationKillTitle') : tr('verification.actionTexts.mutationRunTitle'),
      detail: mutation ? tr('verification.actionTexts.mutationDetail', { status: mutation.status, score: mutation.weightedScore ?? '-', threshold: mutation.threshold }) : tr('verification.actionTexts.mutationNoResult'),
      count: Math.max(1, mutation?.blockingSurvivors.length ?? 0),
      prompt: '按 risk-register.json 对控制优先级、事务计数、边界和错误路径执行风险加权 Mutation；INVALID 不计分，EQUIVALENT 必须具名审查。'
    })
  }

  if (unapprovedResidual.length) {
    actions.push({
      id: 'resolve-residual-risks',
      priority: 'P1',
      title: tr('verification.actionTexts.residualTitle'),
      detail: tr('verification.actionTexts.residualDetail', { count: unapprovedResidual.length }),
      count: unapprovedResidual.length,
      prompt: '读取 residual-risk-register.json；优先用新增证据关闭风险，确需接受时由具名审批人写入 signoff-approvals.json。'
    })
  }

  if (supplementalFormalErrors > 0) {
    actions.push({
      id: 'repair-formal-compatibility',
      priority: 'P1',
      title: tr('verification.actionTexts.formalCompatTitle'),
      detail: tr('verification.actionTexts.formalCompatDetail', { count: supplementalFormalErrors }),
      count: supplementalFormalErrors,
      prompt: '处理补强 Formal 的 ERROR/UNKNOWN；Yosys 前端不兼容时改用 immediate assert/assume/cover、$past 和监控计数器，Liveness 写出有规格依据的最小 assume。'
    })
  }

  if (open > 0 && actions.length === 0) {
    actions.push({
      id: 'continue-closure',
      priority: 'P1',
      title: tr('verification.actionTexts.continueClosureTitle'),
      detail: tr('verification.actionTexts.continueClosureDetail', { count: open }),
      count: open,
      prompt: '选择最高优先级未闭环 Intent，执行适合的 Simulation、Assertion、Formal 或 Static 方法，保存原始证据并重新生成态势。'
    })
  }
  if (open === 0 && failedRegressions + failedFormal === 0) {
    actions.push({
      id: 'signoff-review',
      priority: 'P2',
      title: tr('verification.actionTexts.signoffReviewTitle'),
      detail: tr('verification.actionTexts.signoffReviewDetail'),
      count: 1,
      prompt: '调用 review_verification_scenarios 与 review_verification_evidence，独立读取测试、日志、JUnit、覆盖率、Formal 与 RTL 原始证据，明确是否具备签核条件。'
    })
  }
  const order = { P0: 0, P1: 1, P2: 2 } as const
  return actions.sort((a, b) => order[a.priority] - order[b.priority])
}

export function deriveTopRisks(state: GuidanceState, risks: GuidanceRisk[], tr: GuidanceTranslate): ExplainedRisk[] {
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
    const level: RiskLevel = failed ? 'confirmed' : specBlocked ? 'specGap' : infrastructure ? 'infraGap' : closed ? 'accepted' : 'highRisk'
    const firstHole = holes[0]
    const gap = firstHole?.missingTarget ?? firstHole?.reason ?? (relatedIntents.length ? tr('verification.topRisks.intentsOpen', { open: relatedIntents.filter((item) => !CLOSED_VERIFICATION_STATUSES.has(item.status)).length, total: relatedIntents.length }) : tr('verification.topRisks.noLink'))
    const recommendation = risk.failureModes?.length
      ? tr('verification.topRisks.verifyFocus', { object: risk.object, failureMode: risk.failureModes[0], effect: risk.observableEffects?.[0] ?? tr('verification.topRisks.defaultEffect') })
      : (firstHole?.recommendedAction ?? (closed ? tr('verification.topRisks.keepEvidence') : tr('verification.topRisks.runScenarios')))
    const impact = (risk.failureModes?.join(tr('verification.guidance.clauseJoin')) ?? '') || risk.observableEffects?.join(tr('verification.guidance.clauseJoin')) || impactOf(risk, tr)
    return { risk, level, relatedIntents, gap, impact, recommendation, prompt: `请处理验证风险 ${risk.id}。风险语义：${risk.riskStatement ?? `${risk.title}，对象 ${risk.object}`} 当前缺口：${gap} 可能影响：${impact} 建议：${recommendation} 请读取关联 RTL、VI/SCN 和原始证据，按 Intent 中的激励步骤、观察点和通过标准执行定向仿真、Assertion 或 Formal，完成后重新生成验证态势。` }
  })
}

export function deriveVerificationSteps(state: GuidanceState | null, tr: GuidanceTranslate): VerificationStep[] {
  if (!state) return [
    { id: 'planning', label: tr('verification.stepLabels.planning'), status: 'running', detail: tr('verification.stepDetails.noState') },
    ...(['environment', 'regression', 'risk', 'coverage', 'formal', 'signoff'] as const).map((stepId, index) => ({ id: `pending-${index}`, label: tr(`verification.stepLabels.${stepId}`), status: 'pending' as const, detail: tr('verification.stepDetails.waitPrevious') }))
  ]
  const s = normalizeGuidanceState(state)
  // 波段化（展示层契约）：有 waveProgress 时用 W1-W3 波段视图（W0 冒烟已废弃）
  if (s.waveProgress?.length) {
    return s.waveProgress.map((wave) => ({
      id: wave.id,
      label: wave.label,
      status: wave.status === 'done' ? 'completed' as const : wave.status === 'in-progress' ? 'running' as const : 'pending' as const,
      detail: waveDetail(wave, tr),
      // W2 主题波悬浮提示：逐主题给出“为什么验这个”说明
      title: wave.id === 'W2' && wave.topics?.length ? wave.topics.map((topic) => `${topic.name}：${topicExplanation(topic.name, tr)}`).join('\n') : undefined
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
    { id: 'planning', label: tr('verification.stepLabels.planning'), status: intents.length ? 'completed' : 'running', detail: intents.length ? tr('verification.stepDetails.intentCount', { count: intents.length }) : tr('verification.stepDetails.waitIntents') },
    { id: 'environment', label: tr('verification.stepLabels.environment'), status: s.regressions.length ? 'completed' : 'running', detail: s.regressions.length ? tr('verification.stepDetails.envReady') : tr('verification.stepDetails.envWaiting') },
    { id: 'regression', label: tr('verification.stepLabels.regression'), status: regressionsPassed ? 'completed' : s.regressions.length ? 'blocked' : 'pending', detail: s.regressions.length ? (regressionsPassed ? tr('verification.stepDetails.regressionPassed') : tr('verification.stepDetails.regressionFailed')) : tr('verification.stepDetails.notExecuted') },
    { id: 'risk', label: tr('verification.stepLabels.risk'), status: closure === 100 ? 'completed' : intents.length ? 'running' : 'pending', detail: tr('verification.stepDetails.intentClosure', { closed, total: intents.length }) },
    { id: 'coverage', label: tr('verification.stepLabels.coverage'), status: blockingHoles === 0 && intents.length ? 'completed' : blockingHoles ? 'blocked' : 'pending', detail: blockingHoles ? tr('verification.stepDetails.blocking', { count: blockingHoles }) : tr('verification.stepDetails.noBlocking') },
    { id: 'formal', label: tr('verification.stepLabels.formal'), status: formalFailed ? 'blocked' : supplementalFormalErrors ? 'running' : s.formalResults.length ? 'completed' : 'pending', detail: formalFailed ? tr('verification.stepDetails.formalFailed', { count: formalFailed }) : supplementalFormalErrors ? tr('verification.stepDetails.formalToolLimited', { count: supplementalFormalErrors }) : s.formalResults.length ? tr('verification.stepDetails.formalEvidence', { count: s.formalResults.length }) : tr('verification.stepDetails.formalRun') },
    // 签核步骤只有"人已签核"才算 completed。闭环条件满足只意味着可以进入人工审查，
    // 因此状态是 running（等待审查），不是 completed——旧实现把它标成 completed 而 detail
    // 同时写"等待审查"，等于在没有签核的情况下显示"签核已完成"（界面结论不可信来源之一）。
    { id: 'signoff', label: tr('verification.stepLabels.signoff'), status: closure === 100 && regressionsPassed && blockingHoles === 0 && formalFailed === 0 ? 'running' : 'pending', detail: closure === 100 && blockingHoles === 0 ? tr('verification.stepDetails.waitReview') : tr('verification.stepDetails.waitClosure') }
  ]
  return steps
}

/** 波段步骤详情：W1 用规格条款（含剩余数），W2 用主题波，其余用通过数。 */
function waveDetail(wave: WaveProgressEntry, tr: GuidanceTranslate): string {
  if (wave.id === 'W1' && wave.specClauseTotal !== undefined) {
    const covered = wave.specClauseCovered ?? 0
    const stale = wave.stalePassedCount ?? 0
    const remaining = Math.max(0, wave.specClauseTotal - covered)
    // 陈旧通过透出（RTL 修复致证据过期降级时）：明确"待回归"而非看起来像归零
    if (stale > 0) return tr('verification.stepDetails.clausesPassedStale', { covered, total: wave.specClauseTotal, remaining, stale })
    return tr('verification.stepDetails.clausesPassed', { covered, total: wave.specClauseTotal, remaining })
  }
  if (wave.id === 'W2' && wave.topics?.length) {
    return tr('verification.stepDetails.waves', { count: wave.topics.length, topics: wave.topics.map((topic) => `${topic.name} ${topic.passedCount}/${topic.scenarioCount}`).join(tr('verification.guidance.listJoin')) })
  }
  return tr('verification.stepDetails.passed', { passed: wave.passedCount, total: wave.scenarioCount })
}
