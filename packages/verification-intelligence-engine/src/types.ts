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
}

export interface StateMachine { id: string; module: string; stateObject: string; states: string[]; source: SourceReference }
export interface RegisterWriter { id: string; module: string; register: string; conditions: string[]; priority: number; clock?: string; reset?: string; source: SourceReference }
export interface ClockResetDomain { id: string; module: string; clock: string; reset?: string; edge: string; registers: string[]; source: SourceReference }
export interface TemporalDependency { id: string; module: string; from: string; to: string; relation: 'PRECEDES' | 'CONTROLS' | 'DEPENDS_ON'; source: SourceReference }
export type InteractionEdgeType = 'READS' | 'WRITES' | 'CONTROLS' | 'DEPENDS_ON' | 'SHARES_STATE' | 'PRECEDES' | 'CROSSES_CLOCK' | 'RECOVERS_FROM' | 'COVERS' | 'VERIFIED_BY'
export interface InteractionNode { id: string; kind: 'requirement' | 'feature' | 'rtl-object' | 'state' | 'clock-domain' | 'scenario'; label: string; source?: SourceReference }
export interface InteractionEdge { id: string; from: string; to: string; type: InteractionEdgeType; factIds: string[]; confidence: Confidence }
export interface FeatureInteractionGraph { version: 1; generatedAt: string; nodes: InteractionNode[]; edges: InteractionEdge[] }
export interface ReasoningClaim { kind: FactKind; text: string; references: string[] }
export interface VerificationHypothesis { id: string; title: string; riskIds: string[]; rtlObjectIds: string[]; interactionEdgeIds: string[]; claims: ReasoningClaim[]; status: 'ACCEPTED' | 'REJECTED'; rejectionReasons: string[]; createdAt: string }
export interface ScenarioExecutionPlan { scenarioId: string; sequence: string; constraints: Record<string, string | number | boolean>; temporalConstraints: string[]; iterations: number; budgetSeconds: number; expected: string[]; checkers: string[]; priority: number; reason: string }

export interface RiskMarker {
  id: string
  taxonomyId: string
  title: string
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
  risk: number
  interaction: number
  coverageGap: number
  criticality: number
  confidenceFactor: number
  costFactor: number
  priority: number
  reason: string
  evidence: string[]
  updatedAt: string
}

export interface VerificationStateModel {
  version: 2
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
    report: string
    interactionGraph: string
    executionPlan: string
    hypotheses: string
  }
}
