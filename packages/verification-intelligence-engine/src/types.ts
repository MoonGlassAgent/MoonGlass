export type FactKind = 'SPEC_FACT' | 'RTL_FACT' | 'INFERENCE' | 'UNKNOWN'
export type Confidence = 'high' | 'medium' | 'low'
export type ScenarioStatus =
  | 'DISCOVERED'
  | 'PLANNED'
  | 'IMPLEMENTED'
  | 'NOT_REACHED'
  | 'REACHED'
  | 'VERIFIED'
  | 'FAILED'
  | 'PARTIAL'
  | 'WAIVED'
  | 'BLOCKED_BY_SPEC'
  | 'FORMAL_PROVED'
  | 'FORMAL_UNREACHABLE'

export interface ScenarioState {
  lifecycle: 'DISCOVERED' | 'PLANNED' | 'EXECUTED'
  reach: 'UNKNOWN' | 'REACHED' | 'NOT_REACHED' | 'PROVEN_UNREACHABLE'
  judgment: 'UNKNOWN' | 'PASS' | 'FAIL' | 'CONFLICT'
  evidence: 'MISSING' | 'PARTIAL' | 'COMPLETE'
  freshness: 'CURRENT' | 'STALE' | 'IMPACT_UNKNOWN'
  closure: 'OPEN' | 'VERIFIED' | 'EXCLUDED' | 'WAIVED'
}

export type FormalOutcome =
  | 'PROVEN'
  | 'COUNTEREXAMPLE'
  | 'COVERED'
  | 'PROVEN_UNREACHABLE'
  | 'BOUND_EXHAUSTED'
  | 'INCONCLUSIVE'
  | 'TOOL_ERROR'
  | 'ASSUMPTION_DEPENDENT'

export interface FormalResult {
  resultFile: string
  status: 'PASS' | 'FAIL' | 'UNKNOWN' | 'ERROR'
  outcome: FormalOutcome
  mode: string
  scenarioId?: string
  rtlHash?: string
  obligation: 'required' | 'supplemental'
  classification?: string
  propertyFiles: string[]
  traces: string[]
}

export interface ClosureAssessment {
  status: 'NOT_READY' | 'CONDITIONALLY_READY' | 'READY_FOR_HUMAN_SIGNOFF'
  generatedAt: string
  blockers: string[]
  warnings: string[]
  residualRisks: string[]
  nextActions: string[]
  metrics: {
    criticalTotal: number
    criticalClosed: number
    criticalClosurePercent: number
    regressionsPassed: boolean
    blockingCoverageHoles: number
    formalToolErrors: number
    impactUnknown: number
    explorationSaturation: ExplorationHistory['saturation']['status']
    mutationScore: number | null
  }
}

export interface ScenarioCoordinates {
  feature: string[]
  boundary: Array<{ object: string; values: string[] }>
  interaction: Array<{ type: string; object: string }>
  temporal: Array<{ relation: 'BEFORE' | 'SAME_CYCLE' | 'AFTER' | 'WITHIN_N_CYCLES'; events: string[] }>
  systemState: string[]
}

export interface NegativeSpaceEntry {
  id: string
  scenarioId: string
  classification: 'ARCHITECTURALLY_INVALID' | 'PROTOCOL_ILLEGAL' | 'PROVEN_UNREACHABLE' | 'SPEC_UNDEFINED' | 'OVER_BUDGET'
  reason: string
  evidence: string[]
  approved: boolean
}

/**
 * 根因结论落盘记录（VERIF 上下文治理第 2 批，契约 §2.1）。
 * 写/合并到 verification/results/root-causes.json（证据区，不进 intelligence/ 引擎产物区）；
 * 同 scenarioId 多条共存成链，refutedHypotheses 引用先前记录 id 实现链式追溯。
 * rootCause ≤200 字、fix ≤120 字，由 recordRootCause 与 record_root_cause 工具 schema 双层强制。
 */
export interface RootCauseRecord {
  /** 稳定 id：RC-<sha1前8位大写>，由 scenarioId/hypothesis/verdict 派生 */
  id: string
  scenarioId: string
  hypothesis: string
  verdict: 'confirmed' | 'refuted' | 'open'
  /** 本条证伪的先前根因记录 id（链式追溯） */
  refutedHypotheses: string[]
  /** 关联 diagnostic-control 失败指纹 */
  failureSignature: string
  /** ≤200 字，一句话确认根因；open/refuted 可为空 */
  rootCause: string
  /** ≤120 字，动作级修复描述 */
  fix: string
  /** 证据路径（日志/波形/result.json），不是内容 */
  evidence: string[]
  createdAt: string
}

export interface VerificationSpaceSnapshot {
  version: 1
  snapshotId: string
  generatedAt: string
  rtlHash: string
  specHash: string
  scenarioIds: string[]
  candidateCount: number
  positiveCount: number
  negativeCount: number
  dimensions: { features: number; boundaries: number; interactions: number; temporalRelations: number; systemStates: number }
  negativeSpace: NegativeSpaceEntry[]
}

export interface ExplorationRound {
  version: 1
  roundId: string
  snapshotId: string
  generatedAt: string
  selectedScenarioIds: string[]
  expectedCostSeconds: number
  candidateCount: number
  uncoveredCritical: number
  rationale: string[]
  baselineClosedScenarioIds: string[]
  completedAt?: string
  newlyClosedScenarioIds: string[]
  noveltyScore: number
  result: 'PENDING' | 'PROGRESS' | 'NO_PROGRESS'
}

export interface ExplorationHistory {
  version: 1
  updatedAt: string
  rounds: ExplorationRound[]
  saturation: {
    status: 'NOT_ENOUGH_ROUNDS' | 'PROGRESSING' | 'EMPIRICALLY_SATURATED' | 'STALLED'
    window: number
    epsilon: number
    completedRounds: number
    noProgressStreak: number
    explanation: string
  }
}

export type OracleType = 'REFERENCE_MODEL' | 'INVARIANT' | 'PROTOCOL' | 'FORMAL' | 'METAMORPHIC' | 'END_TO_END'
export interface OracleDefinition {
  id: string
  type: OracleType
  name: string
  independenceLevel: 1 | 2 | 3
  independenceDomain: string
  implementation: string
  sharedAssumptions: string[]
}

export interface OracleVerdict {
  scenarioId: string
  oracleId: string
  verdict: 'PASS' | 'FAIL' | 'UNKNOWN' | 'ERROR'
  evidence: string[]
  rtlHash?: string
  generatedAt?: string
}

export interface ScenarioOracleAssessment {
  scenarioId: string
  requiredIndependentPasses: number
  independentPassDomains: string[]
  passOracleIds: string[]
  failOracleIds: string[]
  invalidOracleIds: string[]
  status: 'INSUFFICIENT' | 'PASS' | 'FAIL' | 'CONFLICT'
  explanation: string
}

export interface MultiOracleEvaluation {
  version: 1
  generatedAt: string
  rtlHash: string
  definitions: OracleDefinition[]
  verdicts: OracleVerdict[]
  assessments: ScenarioOracleAssessment[]
  criticalInsufficient: string[]
  conflicts: string[]
}

export interface MutationRecord {
  id: string
  scenarioId?: string
  operator: string
  weight: number
  status: 'KILLED' | 'SURVIVED' | 'INVALID' | 'EQUIVALENT' | 'EQUIVALENCE_UNKNOWN'
  evidence: string[]
  rtlHash?: string
  review?: { approved: boolean; reviewer: string; rationale: string; reviewedAt: string }
}

export interface MutationAssessment {
  version: 1
  generatedAt: string
  rtlHash: string
  threshold: number
  weightedScore: number | null
  records: MutationRecord[]
  validCount: number
  killedCount: number
  blockingSurvivors: string[]
  invalidOrStale: string[]
  status: 'MISSING' | 'BELOW_THRESHOLD' | 'BLOCKED_BY_SURVIVOR' | 'PASS'
  /** 缺陷 DEFECT-PACK-001#15：schema 不符/记录缺字段的显式告警（不再静默 MISSING） */
  warnings: string[]
}

export interface ResidualRisk {
  id: string
  category: 'FORMAL_LIMITATION' | 'MUTATION_SURVIVOR' | 'NEGATIVE_SPACE' | 'WAIVER' | 'TOOL_LIMITATION'
  title: string
  impact: string
  evidence: string[]
  approvalRequired: boolean
  approved: boolean
  approval?: { approver: string; rationale: string; approvedAt: string }
}

export interface SignoffPackage {
  version: 1
  packageId: string
  generatedAt: string
  rtlHash: string
  verificationSpaceSnapshotId: string
  status: ClosureAssessment['status']
  summary: string
  blockers: string[]
  warnings: string[]
  residualRisks: ResidualRisk[]
  evidenceFiles: string[]
}

export type ModuleVerificationLevel = 'STATIC_ONLY' | 'UNIT_SMOKE' | 'UNIT_FOCUSED' | 'IP_SIGNOFF'
export type ModuleOracleStrategy = 'ASSERTION' | 'PROTOCOL_CHECKER' | 'REFERENCE_MODEL' | 'METAMORPHIC' | 'FORMAL' | 'END_TO_END'

export interface ModuleVerificationPlan {
  module: string
  role: 'IP_TOP' | 'INTEGRATION' | 'CONTROL' | 'DATAPATH' | 'PROTOCOL_ADAPTER' | 'CDC_RESET' | 'UTILITY'
  level: ModuleVerificationLevel
  riskScore: number
  reasons: string[]
  oracleStrategies: ModuleOracleStrategy[]
  goldenModel: {
    recommendation: 'RECOMMENDED' | 'OPTIONAL' | 'NOT_NEEDED'
    rationale: string
  }
  requiredChecks: string[]
  standaloneTestbench: boolean
}

export interface ModuleVerificationStrategy {
  version: 1
  generatedAt: string
  rtlHash: string
  topModules: string[]
  modules: ModuleVerificationPlan[]
  summary: Record<ModuleVerificationLevel, number>
  policy: string[]
}

export interface SourceReference { file: string; line?: number; section?: string }

/** 规格条款类别（v0.8.6 断言级条款）：documentary 为文档性条款（文件头/命名/版权/交付物等），不进映射矩阵分母。 */
export type SpecClauseKind = 'verifiable' | 'documentary'

/**
 * 条款验收通道（channel，2026-09-02 契约"PPA 条款混入 VERIF 完备性分母"）：
 * verifiable 条款按验收手段分通道——simulation/static 由 VERIF 闭环，synthesis（PPA 数值目标）由 SYNTH 闭环。
 * 确定性规则分类（classifyClause），宁漏勿冤：拿不准归 simulation，由人工裁决纠偏。
 */
export type SpecClauseChannel = 'simulation' | 'static' | 'synthesis'

export interface RequirementFact {
  id: string
  text: string
  features: string[]
  priority?: 'P0' | 'P1' | 'P2'
  kind: 'SPEC_FACT'
  /** 条款类别；旧数据无此字段按 verifiable 处理 */
  clauseKind?: SpecClauseKind
  /** 验收通道（仅 verifiable 条款有意义；旧数据无此字段按 simulation 处理） */
  channel?: SpecClauseChannel
  /** 断言级拆分时指向母条款 id（如 SPEC-ERR-001#a 的 parentId 为 SPEC-ERR-001）；单条款无此字段 */
  parentId?: string
  /** 条款分类理由（documentary 命中说明 / verifiable 的 channel 分类说明，确定性规则命中理由） */
  classificationReason?: string
  source: SourceReference
}

export interface RequirementModel {
  version: 1
  generatedAt: string
  requirements: RequirementFact[]
  unknowns: Array<{ id: string; text: string; source: SourceReference }>
  sourceFiles: string[]
}

export interface StructuralFact {
  id: string
  module: string
  object?: string
  factType: string
  features: string[]
  evidence: string
  kind: 'RTL_FACT'
  confidence: Confidence
  source: SourceReference
}

export interface StructuralModel {
  version: 2
  generatedAt: string
  rtlHash: string
  sourceFiles: string[]
  facts: StructuralFact[]
  analyzer: {
    engine: 'slang-ast' | 'moonglass-structural-fallback'
    version?: string
    /** Slang AST 为系统临时目录中间产物，正常解析消费后即删除；仅 elaboration 失败或超限时保留，此字段记录其绝对路径供调试 */
    astPath?: string
    limitations: string[]
  }
  stateMachines: StateMachine[]
  registerWriters: RegisterWriter[]
  clockResetDomains: ClockResetDomain[]
  temporalDependencies: TemporalDependency[]
  controlFlow: { nodes: ControlFlowNode[]; edges: ControlFlowEdge[] }
  conesOfInfluence: ConeOfInfluence[]
  protocols: ProtocolStructure[]
}

export interface StateMachine { id: string; module: string; stateObject: string; states: string[]; source: SourceReference }
export interface RegisterWriter { id: string; module: string; register: string; conditions: string[]; priority: number; clock?: string; reset?: string; source: SourceReference }
export interface ClockResetDomain { id: string; module: string; clock: string; reset?: string; edge: string; registers: string[]; source: SourceReference }
export interface TemporalDependency { id: string; module: string; from: string; to: string; relation: 'PRECEDES' | 'CONTROLS' | 'DEPENDS_ON'; source: SourceReference }
export interface ControlFlowNode { id: string; module: string; kind: 'ENTRY' | 'CONDITION' | 'CASE' | 'ASSIGNMENT'; label: string; source: SourceReference }
export interface ControlFlowEdge { from: string; to: string; relation: 'NEXT' | 'TRUE' | 'FALSE' | 'CASE_ITEM' }
export interface ConeOfInfluence { sink: string; directSources: string[]; transitiveSources: string[]; depth: number }
export interface ProtocolStructure { id: string; module: string; protocol: 'AXI' | 'AHB' | 'APB' | 'READY_VALID' | 'FIFO' | 'UNKNOWN'; signals: string[]; rules: string[]; source: SourceReference }
export type InteractionEdgeType = 'READS' | 'WRITES' | 'CONTROLS' | 'DEPENDS_ON' | 'SHARES_STATE' | 'PRECEDES' | 'CROSSES_CLOCK' | 'RECOVERS_FROM' | 'COVERS' | 'VERIFIED_BY'
export interface InteractionNode { id: string; kind: 'requirement' | 'feature' | 'rtl-object' | 'state' | 'clock-domain' | 'scenario'; label: string; source?: SourceReference }
export interface InteractionEdge { id: string; from: string; to: string; type: InteractionEdgeType; factIds: string[]; confidence: Confidence }
export interface FeatureInteractionGraph { version: 1; generatedAt: string; nodes: InteractionNode[]; edges: InteractionEdge[] }
export interface ReasoningClaim { kind: FactKind; text: string; references: string[] }
export interface VerificationHypothesis { id: string; title: string; riskIds: string[]; rtlObjectIds: string[]; interactionEdgeIds: string[]; claims: ReasoningClaim[]; status: 'ACCEPTED' | 'REJECTED'; rejectionReasons: string[]; createdAt: string }

/** Agent 主导登记的验证意图输入（B 方向：LLM 主导验证规划，引擎负责校验锚点真实性）。 */
export interface AgentIntentInput {
  title: string
  objective: string
  failureMode: string
  passCriteria: string[]
  anchors: { riskIds: string[]; requirementIds: string[]; rtlSignals: string[] }
  recommendedMethod: 'simulation' | 'formal-candidate' | 'static'
  preconditions?: string[]
  observationPoints?: string[]
  /** 波段标签（v0.8.6 契约 Q1：LLM 声明 + 引擎校验一致性）；缺省按 basic 处理 */
  wave?: VerificationWave
  /** W2 增补批主题（corner 波段必填或可由锚定风险推导）；引擎做归一化去重聚合 */
  topic?: string
}

/** 波段（v0.8.6 波段化契约 §四）：W1 基础功能 / W2 增补 / W3 签核。'smoke'（W0）已废弃，保留仅为向后兼容，派生/聚合处一律归一为 basic。 */
export type VerificationWave = 'smoke' | 'basic' | 'corner' | 'signoff'

/** 波段进度条目（展示层契约 B.1，execution-summary / posture 按此生产）。 */
export interface WaveProgressItem {
  /** W0 已不再产出（冒烟波段废弃，归一进 W1），保留在联合类型中以兼容旧快照 */
  id: 'W0' | 'W1' | 'W2' | 'W3'
  wave: VerificationWave
  label: string
  status: 'done' | 'in-progress' | 'pending'
  scenarioCount: number
  passedCount: number
  /** 仅 W1：可验证规格条款总数（断言级，已排除文档性条款） */
  specClauseTotal?: number
  /** 仅 W1：有 PASS 证据的条款数 */
  specClauseCovered?: number
  /** 仅 W2：按归一化主题聚合的增补批进度 */
  topics?: Array<{ name: string; scenarioCount: number; passedCount: number }>
}

/** 规格条款映射状态机（v0.8.6 契约 §2，闭集完备性）。 */
export type SpecClauseStatus = 'UNMAPPED' | 'MAPPED_UNTESTED' | 'PASSED' | 'FAILED' | 'WAIVED'

export interface SpecClauseMapping {
  clauseId: string
  parentId: string
  text: string
  status: SpecClauseStatus
  /** 验收通道；旧数据无此字段按 simulation 处理。synthesis 条款标注 SYNTH 阶段验收，不进 VERIF 完备性分母 */
  channel?: SpecClauseChannel
  /** synthesis 通道条款的验收阶段标注（展示层直接消费） */
  acceptancePhase?: 'SYNTH'
  intentIds: string[]
  scenarioIds: string[]
  evidence: string[]
}

/** 规格映射矩阵（闭集完备性视图；UNMAPPED 仅进 warnings，Q2：先 warning 一个版本）。 */
export interface SpecMappingMatrix {
  version: 1
  generatedAt: string
  /** VERIF 通道（simulation+static）可验证条款总数——VERIF 完备性分母；synthesis 通道条款不计入 */
  clauseTotal: number
  /** 文档性条款数（不参与完备性分母） */
  documentaryCount: number
  /** VERIF 通道中有 PASS 证据的条款数 */
  coveredClause: number
  /** 按验收通道的可验证条款分布（全矩阵口径） */
  channels: Record<SpecClauseChannel, number>
  /** synthesis 通道条款总数（SYNTH 阶段验收，单列，不进 VERIF 分母） */
  synthesisClauseTotal: number
  /** synthesis 通道已闭环（PASSED/WAIVED）条款数 */
  synthesisClauseClosed: number
  statusCounts: Record<SpecClauseStatus, number>
  /** BLOCKED_BY_SPEC 场景计数（含低优先级；规格缺口可见性，不隐形不阻断） */
  blockedBySpecCount: number
  clauses: SpecClauseMapping[]
}

/** 聚类组（v0.8.6 契约 Q4：模块 × 方法 × Oracle 域（+ corner 同主题），authoring 上限 8 场景）。 */
export interface ScenarioCluster {
  clusterId: string
  wave: VerificationWave
  module: string
  method: VerificationScenario['method']
  oracleDomain: string
  topic?: string
  scenarioIds: string[]
  /** 执行批（一次 run_simulation 绑定 2-3 个 scenarioIds） */
  executionBatches: string[][]
}

/** 再聚类建议（两段式第二段：首轮失败后按失败指纹建议分裂/合并，不自动执行）。 */
export interface ReclusterSuggestion {
  type: 'split' | 'merge'
  clusterIds: string[]
  scenarioIds: string[]
  failureSignature: string
  reason: string
}

export interface ScenarioExecutionPlan { scenarioId: string; sequence: string; constraints: Record<string, string | number | boolean>; temporalConstraints: string[]; iterations: number; budgetSeconds: number; expected: string[]; checkers: string[]; priority: number; mandatory: boolean; reason: string; wave?: VerificationWave; clusterId?: string }

export type SpecGapCategory = 'SPEC_WITHOUT_RTL' | 'RTL_WITHOUT_SPEC' | 'SPEC_UNDEFINED' | 'TEMPORAL_UNDEFINED'
export interface SpecGap { id: string; category: SpecGapCategory; title: string; requirementIds: string[]; rtlObjects: string[]; description: string; impact: string; action: string; confidence: Confidence; sources: SourceReference[] }
export interface BoundaryCondition { object: string; values: string[]; rationale: string; source?: SourceReference }
export interface TemporalInteraction { relation: 'BEFORE' | 'SAME_CYCLE' | 'AFTER' | 'WITHIN_N_CYCLES'; offsetCycles: number | string; events: string[] }
export interface VerificationIntent {
  id: string
  scenarioId: string
  objective: string
  rationale: string
  failureMode: string
  sourceIds: string[]
  preconditions: string[]
  stimulus: { events: string[]; temporalInteractions: TemporalInteraction[] }
  observations: string[]
  stimulusProcedure: string[]
  observationPoints: string[]
  expectedResults: string[]
  passCriteria: string[]
  boundaries: BoundaryCondition[]
  recommendedMethods: Array<'simulation' | 'assertion' | 'formal' | 'static'>
  evidence: string[]
  status: ScenarioStatus
  priority: number
  /** 波段标签（v0.8.6）；旧数据无此字段按场景来源推导（AGENT_INTENT→basic，ENGINE_CANDIDATE→按 taxonomyId） */
  wave?: VerificationWave
  /** W2 增补批归一化主题（corner 波段） */
  topic?: string
}
export type CoverageHoleClass = 'C1_UNREACHABLE' | 'C2_CONSTRAINT_BLOCKED' | 'C3_STIMULUS_MISSING' | 'C4_OBSERVATION_MISSING' | 'C5_SPEC_UNDEFINED' | 'C6_TOOL_INSTRUMENTATION'
export interface CoverageHole {
  id: string
  scenarioId: string
  scenarioTitle: string
  classification: CoverageHoleClass
  confidence: Confidence
  evidence: string[]
  reason: string
  missingTarget: string
  requiredStimulus: string[]
  requiredObservation: string[]
  closureEvidence: string[]
  recommendedAction: string
  blocking: boolean
}

export interface RiskMarker {
  id: string
  taxonomyId: string
  title: string
  riskStatement: string
  rationale: string
  failureModes: string[]
  observableEffects: string[]
  object: string
  features: string[]
  structuralComplexity: number
  interaction: number
  temporalDepth: number
  concurrency: number
  riskScore: number
  confidence: Confidence
  facts: string[]
  source: SourceReference
}

export interface VerificationScenario {
  id: string
  title: string
  /** 场景来源：引擎穷举候选、Agent 登记的验证意图，或规格条款派生的 basic 候选；旧数据无此字段按 ENGINE_CANDIDATE 处理。 */
  origin?: 'ENGINE_CANDIDATE' | 'AGENT_INTENT' | 'CLAUSE_DERIVED'
  /** 波段标签（v0.8.6）；旧数据无此字段由 resolveWave 按来源/方法推导 */
  wave?: VerificationWave
  /** W2 增补批归一化主题 */
  topic?: string
  riskIds: string[]
  requirementIds: string[]
  rtlObjects: string[]
  features: string[]
  trigger: string[]
  expected: string[]
  method: 'simulation' | 'formal-candidate' | 'static'
  status: ScenarioStatus
  state: ScenarioState
  coordinates: ScenarioCoordinates
  rtlHash: string
  risk: number
  interaction: number
  coverageGap: number
  criticality: number
  confidenceFactor: number
  costFactor: number
  priority: number
  reason: string
  evidence: string[]
  reachCount: number
  assertionPassed?: boolean
  coverageDelta: Record<string, number>
  updatedAt: string
}

export interface VerificationStateModel {
  version: 6
  generatedAt: string
  rtlHash: string
  scenarioCount: number
  statusCounts: Partial<Record<ScenarioStatus, number>>
  criticalOpen: string[]
  /** 风险评分前 20% 且未被任何 AGENT_INTENT 场景锚定的高分风险候选（未覆盖兜底，仅告警不阻断）。 */
  uncoveredRiskCandidates: RiskMarker[]
  scenarios: VerificationScenario[]
  regressions: Array<{ resultFile: string; passed: boolean; testsTotal: number; coverage: Record<string, number> }>
  analyzer: StructuralModel['analyzer']
  interactionGraph: FeatureInteractionGraph
  executionPlan: ScenarioExecutionPlan[]
  /** 聚类视图（v0.8.6）：与 executionPlan 同一批 OPEN 场景的分组，选批按 cluster 取执行批 */
  executionClusters: ScenarioCluster[]
  /** 首轮失败后按失败指纹的再聚类建议（建议性质，不自动执行） */
  reclusterSuggestions: ReclusterSuggestion[]
  /** 波段进度（W1-W3，展示层契约 B.1；W0 已删除） */
  waveProgress: WaveProgressItem[]
  /** 规格映射矩阵（闭集完备性视图，展示层契约 B.2） */
  specMapping: SpecMappingMatrix
  hypotheses: VerificationHypothesis[]
  formalResults: FormalResult[]
  specGaps: SpecGap[]
  verificationIntents: VerificationIntent[]
  coverageHoles: CoverageHole[]
  closureAssessment: ClosureAssessment
  verificationSpace: VerificationSpaceSnapshot
  explorationRound: ExplorationRound
  explorationHistory: ExplorationHistory
  multiOracle: MultiOracleEvaluation
  mutationAssessment: MutationAssessment
  residualRiskRegister: ResidualRisk[]
  signoffPackage: SignoffPackage
  moduleVerificationStrategy: ModuleVerificationStrategy
  structuralSummary: { fsm: number; cfgNodes: number; dependencies: number; cones: number; protocols: Array<{ protocol: string; module: string }> }
}

export interface IntelligenceArtifacts {
  requirementModel: RequirementModel
  structuralModel: StructuralModel
  risks: RiskMarker[]
  verificationState: VerificationStateModel
  paths: {
    requirementModel: string
    structuralModel: string
    riskRegister: string
    scenarioRegistry: string
    verificationState: string
    verificationPosture: string
    report: string
    interactionGraph: string
    executionPlan: string
    hypotheses: string
    specGaps: string
    verificationIntents: string
    coverageHoles: string
    closureAssessment: string
    verificationSpace: string
    explorationRound: string
    explorationHistory: string
    oracleRegistry: string
    oracleEvaluation: string
    mutationAssessment: string
    residualRiskRegister: string
    signoffPackage: string
    signoffReport: string
    moduleVerificationStrategy: string
    /** Agent 日常状态读取唯一入口（≤10KB 摘要，VERIF 上下文治理第 2 批） */
    executionSummary: string
  }
}
