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

export interface RequirementFact {
  id: string
  text: string
  features: string[]
  priority?: 'P0' | 'P1' | 'P2'
  kind: 'SPEC_FACT'
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
  analyzer: { engine: 'slang-ast' | 'moonglass-structural-fallback'; version?: string; astPath?: string; limitations: string[] }
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
export interface ScenarioExecutionPlan { scenarioId: string; sequence: string; constraints: Record<string, string | number | boolean>; temporalConstraints: string[]; iterations: number; budgetSeconds: number; expected: string[]; checkers: string[]; priority: number; mandatory: boolean; reason: string }

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
  version: 5
  generatedAt: string
  rtlHash: string
  scenarioCount: number
  statusCounts: Partial<Record<ScenarioStatus, number>>
  criticalOpen: string[]
  scenarios: VerificationScenario[]
  regressions: Array<{ resultFile: string; passed: boolean; testsTotal: number; coverage: Record<string, number> }>
  analyzer: StructuralModel['analyzer']
  interactionGraph: FeatureInteractionGraph
  executionPlan: ScenarioExecutionPlan[]
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
  }
}
