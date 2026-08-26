import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type {
  Confidence,
  IntelligenceArtifacts,
  RequirementFact,
  RequirementModel,
  RiskMarker,
  ScenarioStatus,
  StructuralFact,
  StructuralModel,
  VerificationScenario,
  VerificationStateModel,
  FeatureInteractionGraph,
  ScenarioExecutionPlan,
  VerificationHypothesis,
  SpecGap,
  BoundaryCondition,
  VerificationIntent,
  CoverageHole
} from './types.ts'
import { analyzeStructure } from './structural-analyzer.ts'

interface RiskRule {
  taxonomyId: string
  title: string
  features: string[]
  patterns: RegExp[]
  trigger: string[]
  expected: string[]
  method: VerificationScenario['method']
  temporalDepth: number
  concurrency: number
}

const FEATURE_PATTERNS: Array<[string, RegExp]> = [
  ['abort', /\babort(?:ed)?\b/i], ['timeout', /\btime(?:out|r)|watchdog\b/i],
  ['response', /\b(?:bvalid|rvalid|response|resp)\b/i], ['outstanding', /\boutstanding|pending_(?:req|txn)|inflight\b/i],
  ['backpressure', /\bready\b.*\bvalid\b|\bvalid\b.*\bready\b/i], ['reset', /\b(?:rst|reset)(?:_n)?\b/i],
  ['interrupt', /\b(?:irq|interrupt|intr_)\w*\b/i], ['error', /\b(?:err|error|fault|bresp|rresp)\w*\b/i],
  ['fifo', /\bfifo|full|empty\b/i], ['counter', /\b(?:cnt|count|counter|ptr)\w*\b/i],
  ['configuration', /\b(?:cfg|config|control|ctrl)_\w+\b/i], ['busy', /\bbusy\b/i],
  ['arbitration', /\b(?:arb|grant|requester|master|channel)\w*\b/i], ['cdc', /\b(?:sync|async|cdc|clock domain)\w*\b/i],
  ['ecc', /\becc|parity|correctable|uncorrectable\b/i], ['burst', /\bburst|awlen|arlen\b/i],
  ['alignment', /\bunalign|align|strobe|wstrb\b/i], ['ordering', /\border|reorder|sequence\b/i]
]

const RISK_RULES: RiskRule[] = [
  { taxonomyId: 'R01', title: 'Event Collision', features: ['abort', 'timeout', 'response'], patterns: [/abort/i, /time(?:out|r)/i, /(?:bvalid|rvalid|resp)/i], trigger: ['abort', 'timeout', 'response'], expected: ['事件优先级和最终状态符合规格'], method: 'simulation', temporalDepth: 0.8, concurrency: 1 },
  { taxonomyId: 'R02', title: 'Priority Dependency', features: ['priority', 'arbitration'], patterns: [/\bif\s*\(/i, /\belse\s+if\s*\(|\bpriority\b|\barb/i], trigger: ['两个或多个控制条件同周期成立'], expected: ['优先级、饥饿和公平性符合规格'], method: 'formal-candidate', temporalDepth: 0.5, concurrency: 0.8 },
  { taxonomyId: 'R04', title: 'Outstanding Dependency', features: ['outstanding', 'response'], patterns: [/outstanding|inflight|pending_(?:req|txn)/i, /(?:bvalid|rvalid|resp)/i], trigger: ['存在未完成事务', '响应或控制事件到达'], expected: ['计数、完成和顺序保持一致'], method: 'simulation', temporalDepth: 1, concurrency: 0.8 },
  { taxonomyId: 'R05', title: 'Counter Boundary', features: ['counter'], patterns: [/(?:cnt|count|counter|ptr)\w*/i, /(?:==|>=|<=|\+\s*1|-\s*1|full|empty)/i], trigger: ['计数器为 0', '计数器为最大值', '递增或递减越界'], expected: ['无上溢、下溢或错误 wrap'], method: 'formal-candidate', temporalDepth: 0.5, concurrency: 0.4 },
  { taxonomyId: 'R07', title: 'Error/Normal Collision', features: ['error', 'response'], patterns: [/(?:err|error|fault|bresp|rresp)/i, /(?:done|complete|valid|ready)/i], trigger: ['错误与正常完成同周期或相邻周期'], expected: ['错误状态、返回值和完成通知唯一且一致'], method: 'simulation', temporalDepth: 0.7, concurrency: 0.9 },
  { taxonomyId: 'R08', title: 'Reset/Transaction Collision', features: ['reset', 'response'], patterns: [/(?:rst|reset)(?:_n)?/i, /(?:valid|ready|busy|outstanding|pending)/i], trigger: ['事务进行中', '复位到达'], expected: ['接口和内部状态回到规格定义状态'], method: 'simulation', temporalDepth: 0.7, concurrency: 0.8 },
  { taxonomyId: 'R09', title: 'SW/HW Collision', features: ['configuration', 'busy'], patterns: [/(?:cfg|config|control|ctrl)_\w+/i, /(?:busy|hw_|status|state)/i], trigger: ['软件写配置', '硬件同周期更新相关状态'], expected: ['写入、硬件更新和状态清除优先级明确'], method: 'simulation', temporalDepth: 0.5, concurrency: 0.9 },
  { taxonomyId: 'R10', title: 'CDC Interaction', features: ['cdc'], patterns: [/(?:sync|async|cdc|clk_[a-z0-9_]+).*?(?:sync|clk_[a-z0-9_]+)/is], trigger: ['源时钟域数据变化', '目标时钟域采样'], expected: ['同步策略明确且无脉冲丢失/重复'], method: 'static', temporalDepth: 1, concurrency: 0.8 },
  { taxonomyId: 'R11', title: 'Timeout/Late Response', features: ['timeout', 'response'], patterns: [/time(?:out|r)/i, /(?:bvalid|rvalid|response|resp)/i], trigger: ['timeout 已发生', '迟到响应随后到达'], expected: ['迟到响应不会重复完成或破坏计数'], method: 'simulation', temporalDepth: 1, concurrency: 0.9 },
  { taxonomyId: 'R12', title: 'Backpressure', features: ['backpressure'], patterns: [/\bvalid\w*\b/i, /\bready\w*\b/i], trigger: ['valid 保持', 'ready 长期拉低'], expected: ['数据与控制保持稳定且无丢失'], method: 'simulation', temporalDepth: 0.8, concurrency: 0.6 },
  { taxonomyId: 'R13', title: 'Resource Exhaustion', features: ['fifo', 'outstanding'], patterns: [/(?:fifo|full|outstanding|credit)/i, /(?:max|depth|limit|>=|==)/i], trigger: ['资源达到容量上限', '继续到达请求'], expected: ['正确 backpressure，无覆盖或计数错误'], method: 'simulation', temporalDepth: 0.7, concurrency: 0.9 },
  { taxonomyId: 'R15', title: 'Recovery Path', features: ['error', 'reset'], patterns: [/(?:err|error|fault)/i, /(?:recover|retry|clear|reset|idle)/i], trigger: ['进入错误状态', '执行恢复', '恢复后重新发起事务'], expected: ['恢复后状态和接口可继续工作'], method: 'simulation', temporalDepth: 1, concurrency: 0.5 },
  { taxonomyId: 'R16', title: 'Configuration Change During Busy', features: ['configuration', 'busy'], patterns: [/(?:cfg|config|control|ctrl)_\w+/i, /\bbusy\b/i], trigger: ['模块 busy', '配置发生变化'], expected: ['配置更新策略符合规格且不破坏在途事务'], method: 'simulation', temporalDepth: 0.8, concurrency: 0.7 },
  { taxonomyId: 'R19', title: 'Interrupt Mask/Pending/Clear Collision', features: ['interrupt'], patterns: [/(?:irq|interrupt|intr_)\w*/i, /(?:mask|pending|clear|status)/i], trigger: ['中断置位', 'mask/clear 同周期变化'], expected: ['pending、mask 和外部中断输出一致'], method: 'formal-candidate', temporalDepth: 0.6, concurrency: 0.9 }
]

function walk(dir: string, accept: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'obj_dir', 'sim_build', 'results'].includes(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full, accept))
    else if (accept(full)) files.push(full)
  }
  return files.sort()
}

function featuresOf(text: string): string[] {
  return FEATURE_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([feature]) => feature)
}

function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf-8')
  renameSync(temporary, path)
}

function sourceLine(text: string, pattern: RegExp): number {
  const match = pattern.exec(text)
  return match ? text.slice(0, match.index).split(/\r?\n/).length : 1
}

function requirementModel(workspace: string): RequirementModel {
  const files = walk(join(workspace, 'docs'), (file) => /\.(?:md|txt)$/i.test(file) && /(?:02_requirements|03_design)/i.test(file))
  const requirements: RequirementFact[] = []
  const unknowns: RequirementModel['unknowns'] = []
  const seen = new Set<string>()
  for (const file of files) {
    const text = readFileSync(file, 'utf-8')
    for (const [index, line] of text.split(/\r?\n/).entries()) {
      const ids = line.match(/\b(?:REQ|SPEC)-[A-Z0-9_-]+\b/g) ?? []
      for (const id of ids) {
        if (seen.has(id)) continue
        seen.add(id)
        requirements.push({ id, text: line.replace(/^\s*[-|#]+\s*/, '').trim().slice(0, 500), features: featuresOf(line), priority: /\bP[012]\b/.exec(line)?.[0] as RequirementFact['priority'], kind: 'SPEC_FACT', source: { file: relative(workspace, file), line: index + 1 } })
      }
      if (/\b(?:TBD|TODO|待定|未定义|待确认)\b/i.test(line)) unknowns.push({ id: `UNK-${unknowns.length + 1}`, text: line.trim().slice(0, 500), source: { file: relative(workspace, file), line: index + 1 } })
    }
  }
  return { version: 1, generatedAt: new Date().toISOString(), requirements, unknowns, sourceFiles: files.map((file) => relative(workspace, file)) }
}

function structuralModel(workspace: string): StructuralModel {
  const files = walk(join(workspace, 'rtl'), (file) => /\.(?:v|sv)$/i.test(file))
  const hash = createHash('sha256')
  for (const file of files) {
    const text = readFileSync(file, 'utf-8')
    hash.update(relative(workspace, file)).update('\0').update(text).update('\0')
  }
  return analyzeStructure({ workspace, files, rtlHash: hash.digest('hex'), featuresOf })
}

function deriveRisks(workspace: string, structure: StructuralModel): RiskMarker[] {
  const risks: RiskMarker[] = []
  for (const file of structure.sourceFiles) {
    const absolute = resolve(workspace, file)
    const text = readFileSync(absolute, 'utf-8')
    const moduleName = /\bmodule\s+([A-Za-z_$][\w$]*)/.exec(text)?.[1] ?? basename(file)
    for (const rule of RISK_RULES) {
      if (!rule.patterns.every((pattern) => pattern.test(text))) continue
      const features = [...new Set([...rule.features, ...featuresOf(text).filter((feature) => rule.features.includes(feature))])]
      const structuralComplexity = Math.min(1, 0.35 + (text.match(/\b(?:if|case|always|assign)\b/g)?.length ?? 0) / 120)
      const interaction = Math.min(1, 0.35 + features.length * 0.14)
      const riskScore = Number((0.3 * structuralComplexity + 0.3 * interaction + 0.2 * rule.temporalDepth + 0.2 * rule.concurrency).toFixed(3))
      risks.push({ id: `RISK-${String(risks.length + 1).padStart(4, '0')}`, taxonomyId: rule.taxonomyId, title: rule.title, object: moduleName, features, structuralComplexity, interaction, temporalDepth: rule.temporalDepth, concurrency: rule.concurrency, riskScore, confidence: 'medium', facts: structure.facts.filter((fact) => fact.module === moduleName).map((fact) => fact.id), source: { file, line: Math.min(...rule.patterns.map((pattern) => sourceLine(text, pattern))) } })
    }
  }
  for (const cone of structure.conesOfInfluence.filter((item) => item.directSources.length >= 3)) {
    const [module, ...sinkParts] = cone.sink.split('.'); const sink = sinkParts.join('.')
    const dependency = structure.temporalDependencies.find((item) => item.module === module && item.to === sink)
    if (!dependency) continue
    const features = [...new Set(cone.directSources.flatMap((item) => featuresOf(item)))]
    const concurrency = Math.min(1, 0.45 + cone.directSources.length * 0.1); const interaction = Math.min(1, 0.4 + cone.transitiveSources.length * 0.06)
    const structuralComplexity = Math.min(1, 0.35 + structure.controlFlow.nodes.filter((item) => item.module === module).length / 80)
    const riskScore = Number((0.3 * structuralComplexity + 0.3 * interaction + 0.2 * Math.min(1, cone.depth / 4) + 0.2 * concurrency).toFixed(3))
    risks.push({ id: `RISK-${String(risks.length + 1).padStart(4, '0')}`, taxonomyId: 'R01', title: 'N-way Shared State Interaction', object: module, features: features.length ? features : cone.directSources.slice(0, 5).map((item) => item.split('.').at(-1)!), structuralComplexity, interaction, temporalDepth: Math.min(1, cone.depth / 4), concurrency, riskScore, confidence: structure.analyzer.engine === 'slang-ast' ? 'high' : 'medium', facts: structure.facts.filter((item) => item.module === module && item.object === sink).map((item) => item.id), source: dependency.source })
  }
  return risks.sort((a, b) => b.riskScore - a.riskScore)
}

function buildInteractionGraph(requirements: RequirementModel, structure: StructuralModel, scenarios: VerificationScenario[]): FeatureInteractionGraph {
  const nodes: FeatureInteractionGraph['nodes'] = []
  const edges: FeatureInteractionGraph['edges'] = []
  const addNode = (id: string, kind: FeatureInteractionGraph['nodes'][number]['kind'], label: string, source?: FeatureInteractionGraph['nodes'][number]['source']): void => {
    if (!nodes.some((item) => item.id === id)) nodes.push({ id, kind, label, source })
  }
  const addEdge = (from: string, to: string, type: FeatureInteractionGraph['edges'][number]['type'], factIds: string[], confidence: Confidence): void => {
    if (!edges.some((item) => item.from === from && item.to === to && item.type === type)) edges.push({ id: `EDGE-${edges.length + 1}`, from, to, type, factIds, confidence })
  }
  for (const requirement of requirements.requirements) {
    addNode(requirement.id, 'requirement', requirement.text, requirement.source)
    for (const feature of requirement.features) { const id = `FEATURE:${feature}`; addNode(id, 'feature', feature); addEdge(requirement.id, id, 'CONTROLS', [], 'medium') }
  }
  for (const fact of structure.facts) {
    const object = `RTL:${fact.module}.${fact.object ?? fact.module}`; addNode(object, 'rtl-object', fact.object ?? fact.module, fact.source)
    for (const feature of fact.features) { const id = `FEATURE:${feature}`; addNode(id, 'feature', feature); addEdge(id, object, fact.factType === 'REGISTER_WRITER' ? 'WRITES' : 'CONTROLS', [fact.id], fact.confidence) }
  }
  for (const dependency of structure.temporalDependencies) {
    const from = `RTL:${dependency.module}.${dependency.from}`; const to = `RTL:${dependency.module}.${dependency.to}`
    addNode(from, 'rtl-object', dependency.from, dependency.source); addNode(to, 'rtl-object', dependency.to, dependency.source)
    addEdge(from, to, dependency.relation, [], 'medium')
  }
  for (const cone of structure.conesOfInfluence.filter((item) => item.directSources.length > 1)) {
    for (let left = 0; left < Math.min(cone.directSources.length, 12); left++) for (let right = left + 1; right < Math.min(cone.directSources.length, 12); right++) {
      const from = `RTL:${cone.directSources[left]}`; const to = `RTL:${cone.directSources[right]}`
      addNode(from, 'rtl-object', cone.directSources[left]); addNode(to, 'rtl-object', cone.directSources[right]); addEdge(from, to, 'SHARES_STATE', [], structure.analyzer.engine === 'slang-ast' ? 'high' : 'medium')
    }
  }
  for (const domain of structure.clockResetDomains) {
    const domainId = `CLOCK:${domain.module}.${domain.clock}`; addNode(domainId, 'clock-domain', domain.clock, domain.source)
    for (const register of domain.registers) { const object = `RTL:${domain.module}.${register}`; addNode(object, 'rtl-object', register, domain.source); addEdge(domainId, object, 'CONTROLS', [], 'high') }
  }
  for (const scenario of scenarios) {
    addNode(scenario.id, 'scenario', scenario.title)
    for (const object of scenario.rtlObjects) {
      const candidates = nodes.filter((item) => item.kind === 'rtl-object' && item.id.startsWith(`RTL:${object}.`))
      for (const candidate of candidates.slice(0, 8)) addEdge(candidate.id, scenario.id, 'COVERS', scenario.riskIds, 'medium')
    }
  }
  return { version: 1, generatedAt: new Date().toISOString(), nodes, edges }
}

function readHypotheses(path: string): VerificationHypothesis[] {
  if (!existsSync(path)) return []
  try { return (JSON.parse(readFileSync(path, 'utf-8')) as { hypotheses?: VerificationHypothesis[] }).hypotheses ?? [] } catch { return [] }
}

function buildExecutionPlan(scenarios: VerificationScenario[], regressions: VerificationStateModel['regressions']): ScenarioExecutionPlan[] {
  const values = regressions.flatMap((item) => Object.values(item.coverage))
  const baseline = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
  return scenarios.filter((item) => !['VERIFIED', 'FORMAL_PROVED', 'FORMAL_UNREACHABLE', 'WAIVED'].includes(item.status)).slice(0, 24).map((item, index) => ({
    scenarioId: item.id,
    sequence: item.method === 'formal-candidate' ? 'formal_harness' : item.features.includes('backpressure') ? 'backpressure_sequence' : item.features.includes('reset') ? 'reset_during_traffic_sequence' : item.features.includes('error') ? 'error_injection_sequence' : 'directed_random_sequence',
    constraints: (item.method === 'formal-candidate' ? { formalMode: 'bmc_then_cover_then_prove', assumptionReviewRequired: true } : { seedClass: index < 4 ? 'focused' : 'diverse', preserveProtocolLegality: true }) as Record<string, string | number | boolean>,
    temporalConstraints: item.trigger,
    iterations: Math.max(10, Math.round(20 + item.priority * 180)),
    budgetSeconds: Math.max(30, Math.round(60 + item.costFactor * 240)),
    expected: item.expected,
    checkers: item.method === 'formal-candidate' ? ['assert', 'cover', 'assumption_review'] : ['scoreboard', 'protocol_assertions', 'scenario_hit_recorder'],
    priority: Number((item.priority * (baseline > 90 ? 0.85 : 1) * (Object.values(item.coverageDelta).some((value) => value > 0) ? 0.8 : 1)).toFixed(3)),
    reason: `${item.reason} 当前状态 ${item.status}；到达 ${item.reachCount} 次；覆盖反馈均值 ${baseline.toFixed(1)}%；Scenario 覆盖增量 ${JSON.stringify(item.coverageDelta)}。`
  })).sort((a, b) => b.priority - a.priority)
}

function collectResults(workspace: string): VerificationStateModel['regressions'] {
  return walk(join(workspace, 'verification', 'results'), (file) => basename(file) === 'result.json').map((file) => {
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
      const rawCoverage = (data.coverage ?? {}) as Record<string, unknown>
      const coverage = Object.fromEntries(Object.entries(rawCoverage).filter(([, value]) => typeof value === 'number')) as Record<string, number>
      return { resultFile: relative(workspace, file), passed: data.passed === true, testsTotal: Number(data.testsTotal ?? 0), coverage }
    } catch { return { resultFile: relative(workspace, file), passed: false, testsTotal: 0, coverage: {} } }
  })
}

function collectFormalResults(workspace: string): VerificationStateModel['formalResults'] {
  return walk(join(workspace, 'verification', 'formal', 'results'), (file) => basename(file) === 'formal-result.json').map((file) => {
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
      const status = ['PASS', 'FAIL', 'UNKNOWN', 'ERROR'].includes(String(data.status)) ? data.status as 'PASS' | 'FAIL' | 'UNKNOWN' | 'ERROR' : 'ERROR'
      return { resultFile: relative(workspace, file), status, mode: String(data.mode ?? 'unknown'), scenarioId: typeof data.scenarioId === 'string' ? data.scenarioId : undefined, propertyFiles: Array.isArray(data.propertyFiles) ? data.propertyFiles.map(String) : [], traces: Array.isArray(data.traces) ? data.traces.map(String) : [] }
    } catch { return { resultFile: relative(workspace, file), status: 'ERROR' as const, mode: 'unknown', propertyFiles: [], traces: [] } }
  })
}

function scenarioHits(workspace: string): Map<string, { status: ScenarioStatus; evidence: string[]; reachCount: number; assertionPassed?: boolean; coverageDelta: Record<string, number> }> {
  const hits = new Map<string, { status: ScenarioStatus; evidence: string[]; reachCount: number; assertionPassed?: boolean; coverageDelta: Record<string, number> }>()
  for (const file of walk(join(workspace, 'verification', 'results'), (path) => basename(path) === 'scenario_hits.json')) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as { scenarios?: Array<{ id?: string; status?: ScenarioStatus; reached?: boolean; passed?: boolean; assertionPassed?: boolean; reachCount?: number; coverageDelta?: Record<string, number>; evidence?: string[] }> }
      for (const item of data.scenarios ?? []) {
        if (!item.id) continue
        const evidence = (item.evidence ?? []).map((path) => resolve(dirname(file), path))
        const validEvidence = evidence.filter((path) => existsSync(path) && statSync(path).isFile() && statSync(path).size > 0)
        const requestedStatus = item.status ?? (item.reached ? (item.passed ? 'VERIFIED' : 'FAILED') : 'NOT_REACHED')
        const status = ['VERIFIED', 'FORMAL_PROVED', 'FORMAL_UNREACHABLE'].includes(requestedStatus) && validEvidence.length === 0
          ? 'PARTIAL'
          : requestedStatus
        hits.set(item.id, { status, evidence: [relative(workspace, file), ...validEvidence.map((path) => relative(workspace, path))], reachCount: Number(item.reachCount ?? (item.reached ? 1 : 0)), assertionPassed: item.assertionPassed ?? item.passed, coverageDelta: Object.fromEntries(Object.entries(item.coverageDelta ?? {}).filter(([, value]) => typeof value === 'number')) })
      }
    } catch { /* 无效反馈由证据审查报告处理 */ }
  }
  for (const result of collectFormalResults(workspace)) {
    if (!result.scenarioId) continue
    const status: ScenarioStatus = result.status === 'FAIL' ? 'FAILED' : result.status !== 'PASS' ? 'PARTIAL' : result.mode === 'prove' ? 'FORMAL_PROVED' : result.mode === 'cover' ? 'REACHED' : 'PARTIAL'
    hits.set(result.scenarioId, { status, evidence: [result.resultFile, ...result.propertyFiles, ...result.traces], reachCount: result.status === 'PASS' ? 1 : 0, assertionPassed: result.status === 'PASS', coverageDelta: {} })
  }
  return hits
}

function buildScenarios(requirements: RequirementModel, structure: StructuralModel, risks: RiskMarker[], previous: VerificationScenario[], workspace: string): VerificationScenario[] {
  const previousById = new Map(previous.map((item) => [item.id, item]))
  const hits = scenarioHits(workspace)
  return risks.map((risk) => {
    const rule = RISK_RULES.find((item) => item.taxonomyId === risk.taxonomyId)!
    const nway = risk.title.startsWith('N-way')
    const stableKey = `${risk.taxonomyId}\0${risk.object}\0${risk.features.sort().join(',')}`
    const id = `SCN-${createHash('sha1').update(stableKey).digest('hex').slice(0, 8).toUpperCase()}`
    const previousItem = previousById.get(id)
    const hit = hits.get(id)
    const requirementIds = requirements.requirements.filter((item) => item.features.some((feature) => risk.features.includes(feature))).map((item) => item.id)
    const criticality = requirements.requirements.some((item) => requirementIds.includes(item.id) && item.priority === 'P0') ? 1 : requirementIds.length > 0 ? 0.8 : 0.6
    const status = hit?.status ?? previousItem?.status ?? (requirementIds.length === 0 ? 'BLOCKED_BY_SPEC' : 'DISCOVERED')
    const closed = ['VERIFIED', 'FORMAL_PROVED', 'FORMAL_UNREACHABLE', 'WAIVED'].includes(status)
    const coverageGap = closed ? 0 : status === 'PARTIAL' ? 0.5 : 1
    const confidenceFactor = risk.confidence === 'high' ? 1 : risk.confidence === 'medium' ? 0.85 : 0.65
    const costFactor = rule.method === 'static' ? 1 : rule.method === 'formal-candidate' ? 0.8 : 0.9
    const priority = Number((criticality * risk.riskScore * risk.interaction * coverageGap * confidenceFactor * costFactor).toFixed(3))
    return { id, title: `${risk.title}: ${risk.features.join(' × ')}`, riskIds: [risk.id], requirementIds, rtlObjects: [risk.object], features: risk.features, trigger: nway ? risk.features.map((item) => `${item} 在同周期或相邻周期有效`) : rule.trigger, expected: nway ? ['共享状态的优先级、更新次数和外部可见结果符合规格'] : rule.expected, method: nway ? 'formal-candidate' : rule.method, status, risk: risk.riskScore, interaction: risk.interaction, coverageGap, criticality, confidenceFactor, costFactor, priority, reason: `结构规则 ${risk.taxonomyId} 命中 ${risk.object}；${risk.features.join('、')} 共享控制或时序语义。`, evidence: [...new Set([risk.source.file, ...(hit?.evidence ?? previousItem?.evidence ?? [])])], reachCount: hit?.reachCount ?? previousItem?.reachCount ?? 0, assertionPassed: hit?.assertionPassed ?? previousItem?.assertionPassed, coverageDelta: hit?.coverageDelta ?? previousItem?.coverageDelta ?? {}, updatedAt: new Date().toISOString() }
  }).sort((a, b) => b.priority - a.priority)
}

function readPrevious(path: string): VerificationScenario[] {
  if (!existsSync(path)) return []
  try { return (JSON.parse(readFileSync(path, 'utf-8')) as { scenarios?: VerificationScenario[] }).scenarios ?? [] } catch { return [] }
}

function deriveSpecGaps(requirements: RequirementModel, structure: StructuralModel, risks: RiskMarker[]): SpecGap[] {
  const gaps: SpecGap[] = requirements.unknowns.map((item, index) => ({
    id: `SPEC-GAP-${String(index + 1).padStart(4, '0')}`,
    category: 'SPEC_UNDEFINED', title: item.text.slice(0, 120), requirementIds: [], rtlObjects: [],
    description: item.text, impact: '规格语义未闭合，相关验证结论可能无法裁决。', action: '由规格或架构负责人澄清并更新追踪关系。', confidence: 'high', sources: [item.source]
  }))
  const add = (gap: Omit<SpecGap, 'id'>): void => gaps.push({ id: `SPEC-GAP-${String(gaps.length + 1).padStart(4, '0')}`, ...gap })
  for (const requirement of requirements.requirements) {
    if (requirement.features.length === 0) continue
    const facts = structure.facts.filter((fact) => fact.features.some((feature) => requirement.features.includes(feature)))
    if (facts.length === 0) add({ category: 'SPEC_WITHOUT_RTL', title: `${requirement.id} 尚无 RTL 结构映射`, requirementIds: [requirement.id], rtlObjects: [], description: requirement.text, impact: '需求可能尚未实现，或结构分析无法建立映射。', action: '检查实现、命名映射与 RTL 结构证据。', confidence: 'medium', sources: [requirement.source] })
  }
  const specified = new Set(requirements.requirements.flatMap((item) => item.features))
  for (const feature of [...new Set(structure.facts.flatMap((fact) => fact.features))].filter((item) => !specified.has(item)).slice(0, 20)) {
    const facts = structure.facts.filter((fact) => fact.features.includes(feature))
    add({ category: 'RTL_WITHOUT_SPEC', title: `RTL 特征 ${feature} 缺少规格映射`, requirementIds: [], rtlObjects: [...new Set(facts.map((fact) => `${fact.module}.${fact.object ?? fact.module}`))], description: `RTL 结构中识别到 ${feature} 行为，但需求/规格未建立对应语义。`, impact: '外部可见行为可能未被规格和验证计划约束。', action: '确认该行为是实现细节还是需要补充规格。', confidence: 'medium', sources: facts.slice(0, 4).map((fact) => fact.source) })
  }
  for (const risk of risks.filter((item) => item.features.length >= 2).slice(0, 24)) {
    const covered = requirements.requirements.some((requirement) => risk.features.every((feature) => requirement.features.includes(feature)) && /同时|同周期|相邻|优先|before|after|concurrent|priority/i.test(requirement.text))
    if (!covered) add({ category: 'TEMPORAL_UNDEFINED', title: `${risk.features.join(' × ')} 时间/优先级语义未定义`, requirementIds: requirements.requirements.filter((item) => item.features.some((feature) => risk.features.includes(feature))).map((item) => item.id), rtlObjects: [risk.object], description: `RTL 风险 ${risk.id} 表明这些事件可能交互，但规格未明确同时或相邻周期的裁决关系。`, impact: '不同实现与验证预期可能产生合理但不一致的解释。', action: '补充 BEFORE/SAME_CYCLE/AFTER 行为及优先级。', confidence: risk.confidence, sources: [risk.source] })
  }
  return gaps
}

function boundaryConditions(structure: StructuralModel, scenario: VerificationScenario): BoundaryCondition[] {
  const relevant = structure.registerWriters.filter((item) => item.module === scenario.rtlObjects[0] && /cnt|count|counter|ptr|outstanding|depth|len|size|addr|id/i.test(item.register))
  const boundaries = relevant.slice(0, 8).map((item) => ({ object: `${item.module}.${item.register}`, values: ['0', '1', 'MAX-1', 'MAX', 'overflow/wrap'], rationale: '由计数器、指针或容量相关 RTL 对象生成。', source: item.source }))
  if (scenario.features.includes('fifo')) boundaries.push({ object: 'FIFO occupancy', values: ['EMPTY', '1', 'ALMOST_FULL', 'FULL'], rationale: '覆盖 FIFO 空、满和反压边界。' })
  if (scenario.features.includes('outstanding')) boundaries.push({ object: 'outstanding', values: ['0', '1', 'MAX-1', 'MAX'], rationale: '覆盖在途事务容量边界。' })
  return boundaries
}

function buildVerificationIntents(structure: StructuralModel, scenarios: VerificationScenario[]): VerificationIntent[] {
  return scenarios.map((scenario) => {
    const events = scenario.features.slice(0, 4)
    const temporalInteractions = events.length >= 2 ? [
      { relation: 'BEFORE' as const, offsetCycles: -1, events },
      { relation: 'SAME_CYCLE' as const, offsetCycles: 0, events },
      { relation: 'AFTER' as const, offsetCycles: 1, events },
      { relation: 'WITHIN_N_CYCLES' as const, offsetCycles: '[-2,+2]', events }
    ] : []
    const methods: VerificationIntent['recommendedMethods'] = scenario.method === 'formal-candidate' ? ['formal', 'assertion', 'simulation'] : scenario.method === 'static' ? ['static', 'assertion'] : ['simulation', 'assertion']
    return { id: `VI-${scenario.id.slice(4)}`, scenarioId: scenario.id, objective: scenario.title, sourceIds: [...scenario.requirementIds, ...scenario.riskIds], preconditions: scenario.trigger, stimulus: { events, temporalInteractions }, observations: scenario.rtlObjects, expectedResults: scenario.expected, boundaries: boundaryConditions(structure, scenario), recommendedMethods: methods, evidence: scenario.evidence, status: scenario.status, priority: scenario.priority }
  })
}

function classifyCoverageHoles(scenarios: VerificationScenario[], regressions: VerificationStateModel['regressions']): CoverageHole[] {
  return scenarios.filter((item) => !['VERIFIED', 'FORMAL_PROVED', 'WAIVED'].includes(item.status)).map((scenario) => {
    let classification: CoverageHole['classification'] = 'C3_STIMULUS_MISSING'
    let reason = '场景尚未被有效激励到达。'; let action = '生成定向激励，并记录 Scenario hit 与波形证据。'; let confidence: Confidence = 'medium'
    if (scenario.status === 'FORMAL_UNREACHABLE') { classification = 'C1_UNREACHABLE'; reason = 'Formal 证据表明目标不可达。'; action = '审查 assumptions 后将不可达证据纳入签核。'; confidence = 'high' }
    else if (scenario.status === 'BLOCKED_BY_SPEC') { classification = 'C5_SPEC_UNDEFINED'; reason = '缺少可裁决的规格语义。'; action = '先关闭关联 Spec Gap，再生成验证预期。'; confidence = 'high' }
    else if (scenario.reachCount > 0 && scenario.assertionPassed === undefined) { classification = 'C4_OBSERVATION_MISSING'; reason = '场景已经到达，但缺少 Checker/Assertion 裁决。'; action = '增加 Checker、Assertion 或功能覆盖观察点。'; confidence = 'high' }
    else if (regressions.length === 0) { classification = 'C6_TOOL_INSTRUMENTATION'; reason = '尚无可读取的结构化回归与覆盖率结果。'; action = '检查仿真、覆盖率插桩及 result.json 落盘。'; confidence = 'high' }
    else if (/constraint/i.test(scenario.reason)) { classification = 'C2_CONSTRAINT_BLOCKED'; reason = '现有约束可能阻断场景到达。'; action = '审查环境约束与协议合法性，避免过约束。' }
    return { id: `HOLE-${scenario.id.slice(4)}`, scenarioId: scenario.id, classification, confidence, evidence: scenario.evidence, reason, recommendedAction: action, blocking: scenario.priority >= 0.2 }
  })
}

function writeReport(path: string, state: VerificationStateModel, risks: RiskMarker[]): void {
  const rows = state.scenarios.slice(0, 50).map((item) => `| ${item.id} | ${item.title} | ${item.priority} | ${item.method} | ${item.status} |`).join('\n')
  writeFileSync(path, `# Verification Intelligence Report\n\n- RTL Hash: \`${state.rtlHash}\`\n- 风险标记：${risks.length}\n- Scenario：${state.scenarioCount}\n- Verification Intent：${state.verificationIntents.length}\n- Spec Gap：${state.specGaps.length}\n- Coverage Hole：${state.coverageHoles.length}\n- Critical Open：${state.criticalOpen.length}\n\n## 高优先级 Scenario\n\n| Scenario | 交互 | 优先级 | 方法 | 状态 |\n|---|---|---:|---|---|\n${rows || '| - | 暂无 | - | - | - |'}\n\n> 风险标记用于验证规划，不等同于已发现 RTL Bug。Scenario 必须由仿真、Formal 或静态证据裁决。\n`, 'utf-8')
}

export function buildVerificationIntelligence(workspaceDir: string): IntelligenceArtifacts {
  const workspace = resolve(workspaceDir)
  const outputDir = join(workspace, 'verification', 'intelligence')
  mkdirSync(outputDir, { recursive: true })
  const paths = { requirementModel: join(outputDir, 'requirement-model.json'), structuralModel: join(outputDir, 'structural-model.json'), riskRegister: join(outputDir, 'risk-register.json'), scenarioRegistry: join(outputDir, 'scenario-registry.json'), verificationState: join(outputDir, 'verification-state.json'), report: join(outputDir, 'verification-intelligence-report.md'), interactionGraph: join(outputDir, 'feature-interaction-graph.json'), executionPlan: join(outputDir, 'scenario-execution-plan.json'), hypotheses: join(outputDir, 'verification-hypotheses.json'), specGaps: join(outputDir, 'spec-gap-register.json'), verificationIntents: join(outputDir, 'verification-intent-registry.json'), coverageHoles: join(outputDir, 'coverage-hole-register.json') }
  const requirements = requirementModel(workspace)
  const structure = structuralModel(workspace)
  const risks = deriveRisks(workspace, structure)
  const scenarios = buildScenarios(requirements, structure, risks, readPrevious(paths.scenarioRegistry), workspace)
  const regressions = collectResults(workspace)
  const formalResults = collectFormalResults(workspace)
  const interactionGraph = buildInteractionGraph(requirements, structure, scenarios)
  const executionPlan = buildExecutionPlan(scenarios, regressions)
  const hypotheses = readHypotheses(paths.hypotheses)
  const specGaps = deriveSpecGaps(requirements, structure, risks)
  const verificationIntents = buildVerificationIntents(structure, scenarios)
  const coverageHoles = classifyCoverageHoles(scenarios, regressions)
  const statusCounts: VerificationStateModel['statusCounts'] = {}
  for (const scenario of scenarios) statusCounts[scenario.status] = (statusCounts[scenario.status] ?? 0) + 1
  const criticalOpen = scenarios.filter((item) => item.priority >= 0.2 && !['VERIFIED', 'FORMAL_PROVED', 'FORMAL_UNREACHABLE', 'WAIVED'].includes(item.status)).map((item) => item.id)
  const structuralSummary = { fsm: structure.stateMachines.length, cfgNodes: structure.controlFlow.nodes.length, dependencies: structure.temporalDependencies.length, cones: structure.conesOfInfluence.length, protocols: structure.protocols.map((item) => ({ protocol: item.protocol, module: item.module })) }
  const verificationState: VerificationStateModel = { version: 3, generatedAt: new Date().toISOString(), rtlHash: structure.rtlHash, scenarioCount: scenarios.length, statusCounts, criticalOpen, scenarios, regressions, analyzer: structure.analyzer, interactionGraph, executionPlan, hypotheses, formalResults, specGaps, verificationIntents, coverageHoles, structuralSummary }
  writeJsonAtomic(paths.requirementModel, requirements)
  writeJsonAtomic(paths.structuralModel, structure)
  writeJsonAtomic(paths.riskRegister, { version: 1, generatedAt: new Date().toISOString(), risks })
  writeJsonAtomic(paths.scenarioRegistry, { version: 1, generatedAt: new Date().toISOString(), rtlHash: structure.rtlHash, scenarios })
  writeJsonAtomic(paths.verificationState, verificationState)
  writeJsonAtomic(paths.interactionGraph, interactionGraph)
  writeJsonAtomic(paths.executionPlan, { version: 1, generatedAt: new Date().toISOString(), plans: executionPlan })
  writeJsonAtomic(paths.specGaps, { version: 1, generatedAt: new Date().toISOString(), gaps: specGaps })
  writeJsonAtomic(paths.verificationIntents, { version: 1, generatedAt: new Date().toISOString(), intents: verificationIntents })
  writeJsonAtomic(paths.coverageHoles, { version: 1, generatedAt: new Date().toISOString(), holes: coverageHoles })
  if (!existsSync(paths.hypotheses)) writeJsonAtomic(paths.hypotheses, { version: 1, hypotheses: [] })
  writeReport(paths.report, verificationState, risks)
  return { requirementModel: requirements, structuralModel: structure, risks, verificationState, paths }
}

export function registerVerificationHypotheses(workspaceDir: string, proposed: Array<Omit<VerificationHypothesis, 'id' | 'status' | 'rejectionReasons' | 'createdAt'>>): VerificationHypothesis[] {
  const artifacts = buildVerificationIntelligence(workspaceDir)
  const riskIds = new Set(artifacts.risks.map((item) => item.id))
  const objectIds = new Set(artifacts.verificationState.interactionGraph.nodes.filter((item) => item.kind === 'rtl-object').map((item) => item.id))
  const edgeIds = new Set(artifacts.verificationState.interactionGraph.edges.map((item) => item.id))
  const acceptedKinds = new Set(['SPEC_FACT', 'RTL_FACT', 'INFERENCE', 'UNKNOWN'])
  const validated = proposed.map((item, index): VerificationHypothesis => {
    const reasons: string[] = []
    if (!item.riskIds.length || item.riskIds.some((id) => !riskIds.has(id))) reasons.push('必须引用现有 Risk ID')
    if (!item.rtlObjectIds.length || item.rtlObjectIds.some((id) => !objectIds.has(id))) reasons.push('必须引用图中的 RTL Object ID')
    if (!item.interactionEdgeIds.length || item.interactionEdgeIds.some((id) => !edgeIds.has(id))) reasons.push('必须引用至少一条现有交互边')
    if (!item.claims.length || item.claims.some((claim) => !acceptedKinds.has(claim.kind))) reasons.push('每条 claim 必须标记 FACT/INFERENCE/UNKNOWN')
    if (item.claims.some((claim) => ['SPEC_FACT', 'RTL_FACT'].includes(claim.kind) && claim.references.length === 0)) reasons.push('事实 claim 必须提供引用')
    return { ...item, id: `HYP-${createHash('sha1').update(`${item.title}\0${index}`).digest('hex').slice(0, 8).toUpperCase()}`, status: reasons.length ? 'REJECTED' : 'ACCEPTED', rejectionReasons: reasons, createdAt: new Date().toISOString() }
  })
  writeJsonAtomic(artifacts.paths.hypotheses, { version: 1, hypotheses: validated })
  return validated
}

export function reviewScenarioClosure(workspaceDir: string): { passed: boolean; blockers: string[]; warnings: string[]; state?: VerificationStateModel } {
  const path = join(resolve(workspaceDir), 'verification', 'intelligence', 'verification-state.json')
  if (!existsSync(path)) return { passed: false, blockers: ['尚未生成 Verification State Model'], warnings: [] }
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8')) as VerificationStateModel
    const blockers: string[] = []
    const warnings: string[] = []
    if (state.criticalOpen.length > 0) blockers.push(`${state.criticalOpen.length} 个关键 Scenario 尚未闭环：${state.criticalOpen.slice(0, 8).join(', ')}`)
    if (state.scenarioCount === 0) warnings.push('未识别到 Scenario；简单设计允许人工确认，但需说明结构分析范围')
    if (state.regressions.length === 0) blockers.push('Verification State 中没有回归证据')
    if (state.regressions.some((item) => !item.passed)) blockers.push('Verification State 包含失败回归')
    if (state.formalResults?.some((item) => item.status === 'FAIL' || item.status === 'ERROR')) blockers.push('Verification State 包含 Formal 失败或执行错误')
    return { passed: blockers.length === 0, blockers, warnings, state }
  } catch { return { passed: false, blockers: ['verification-state.json 无法解析'], warnings: [] } }
}
