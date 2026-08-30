import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import type {
  Confidence,
  ClosureAssessment,
  ExplorationRound,
  ExplorationHistory,
  NegativeSpaceEntry,
  MultiOracleEvaluation,
  OracleDefinition,
  OracleVerdict,
  MutationAssessment,
  MutationRecord,
  ModuleOracleStrategy,
  ModuleVerificationPlan,
  ModuleVerificationStrategy,
  ResidualRisk,
  SignoffPackage,
  FormalOutcome,
  IntelligenceArtifacts,
  RequirementFact,
  RequirementModel,
  RiskMarker,
  ScenarioStatus,
  ScenarioState,
  ScenarioCoordinates,
  StructuralFact,
  StructuralModel,
  VerificationScenario,
  VerificationSpaceSnapshot,
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

function buildModuleVerificationStrategy(workspace: string, structure: StructuralModel, risks: RiskMarker[]): ModuleVerificationStrategy {
  const moduleFiles = new Map<string, string>()
  const sourceTexts = new Map<string, string>()
  for (const file of structure.sourceFiles) {
    const text = readFileSync(resolve(workspace, file), 'utf-8')
    sourceTexts.set(file, text)
    for (const match of text.matchAll(/\bmodule\s+([A-Za-z_$][\w$]*)/g)) moduleFiles.set(match[1], file)
  }
  const modules = [...moduleFiles.keys()].filter((module) => module !== '$design')
  const instantiated = new Set<string>()
  const childCount = new Map<string, number>()
  for (const [owner, file] of moduleFiles) {
    const text = sourceTexts.get(file) ?? ''
    let count = 0
    for (const candidate of modules) {
      if (candidate === owner) continue
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      if (new RegExp(`\\b${escaped}\\s*(?:#\\s*\\([\\s\\S]*?\\)\\s*)?[A-Za-z_$][\\w$]*\\s*\\(`).test(text)) {
        instantiated.add(candidate)
        count += 1
      }
    }
    childCount.set(owner, count)
  }
  let configuredTop: string | undefined
  const manifestPath = join(workspace, 'rtl', 'design.json')
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { topModule?: unknown }
      if (typeof manifest.topModule === 'string' && modules.includes(manifest.topModule)) configuredTop = manifest.topModule
    } catch { /* malformed manifests are handled by the normal RTL checks */ }
  }
  const inferredRoots = modules.filter((module) => !instantiated.has(module))
  const topModules = configuredTop ? [configuredTop] : inferredRoots.length ? inferredRoots : modules.slice(0, 1)
  const topSet = new Set(topModules)

  const plans: ModuleVerificationPlan[] = modules.map((module) => {
    const moduleRisks = risks.filter((risk) => risk.object === module || risk.object.startsWith(`${module}.`))
    const maxRisk = Math.max(0, ...moduleRisks.map((risk) => risk.riskScore))
    const protocols = structure.protocols.filter((item) => item.module === module)
    const fsms = structure.stateMachines.filter((item) => item.module === module)
    const writers = structure.registerWriters.filter((item) => item.module === module)
    const domains = structure.clockResetDomains.filter((item) => item.module === module)
    const text = sourceTexts.get(moduleFiles.get(module) ?? '') ?? ''
    const semanticName = `${module} ${moduleRisks.flatMap((item) => item.features).join(' ')}`
    const cdcReset = /(?:cdc|sync|async|reset|rst)/i.test(semanticName) || domains.length > 1
    const modelFriendly = /(?:crc|ecc|parity|addr|address|decode|encoder|arb|sched|parser|fifo|queue|width|convert|reorder|transform|filter|compute|alu|counter)/i.test(semanticName)
    const integration = (childCount.get(module) ?? 0) >= 2
    const role: ModuleVerificationPlan['role'] = topSet.has(module) ? 'IP_TOP'
      : cdcReset ? 'CDC_RESET'
        : protocols.length ? 'PROTOCOL_ADAPTER'
          : integration ? 'INTEGRATION'
            : fsms.length || /(?:ctrl|control|arb|sched|manager)/i.test(module) ? 'CONTROL'
              : modelFriendly || /(?:data|pipe|compute|core)/i.test(module) ? 'DATAPATH' : 'UTILITY'
    const inherentCriticalRole = cdcReset || /(?:ecc|parity)/i.test(semanticName)
    const interactionCriticalRole = /(?:arb|sched|parser|reorder|outstanding|credit|fifo)/i.test(semanticName) && maxRisk >= 0.62
    const level: ModuleVerificationPlan['level'] = topSet.has(module) ? 'IP_SIGNOFF'
      : maxRisk >= 0.68 || inherentCriticalRole || interactionCriticalRole ? 'UNIT_FOCUSED'
        : fsms.length > 0 || writers.length > 0 || protocols.length > 0 ? 'UNIT_SMOKE' : 'STATIC_ONLY'
    const goldenRecommended = modelFriendly && !/(?:sync|reset|rst)/i.test(semanticName)
    const goldenModel: ModuleVerificationPlan['goldenModel'] = goldenRecommended
      ? { recommendation: 'RECOMMENDED', rationale: '该模块具有可独立预测的数据变换、调度、容量或编码语义；参考模型有助于定位首个偏差并加速收敛。' }
      : level === 'IP_SIGNOFF' || role === 'INTEGRATION'
        ? { recommendation: 'OPTIONAL', rationale: '根据端到端行为是否可低成本独立预测决定；不得为了形式完整而复制 RTL 实现。' }
        : { recommendation: 'NOT_NEEDED', rationale: '当前结构更适合使用静态检查、局部 Assertion 或协议规则判定；后续出现观察缺口时可升级。' }
    const oracleStrategies = new Set<ModuleOracleStrategy>()
    if (level === 'IP_SIGNOFF') oracleStrategies.add('END_TO_END')
    if (protocols.length) oracleStrategies.add('PROTOCOL_CHECKER')
    if (fsms.length || writers.length || cdcReset) oracleStrategies.add('ASSERTION')
    if (goldenModel.recommendation === 'RECOMMENDED') oracleStrategies.add('REFERENCE_MODEL')
    if (level === 'UNIT_FOCUSED' && (cdcReset || fsms.length > 0)) oracleStrategies.add('FORMAL')
    if (oracleStrategies.size === 0 && level !== 'STATIC_ONLY') oracleStrategies.add('ASSERTION')
    const reasons = [
      topSet.has(module) ? '项目顶层，承担对外功能与最终签核。' : `子模块，最高结构风险 ${maxRisk.toFixed(3)}。`,
      protocols.length ? `识别到 ${[...new Set(protocols.map((item) => item.protocol))].join('/')} 协议。` : '',
      fsms.length ? `包含 ${fsms.length} 个状态机。` : '',
      cdcReset ? '包含时钟/复位域敏感语义。' : '',
      integration ? `实例化多个子模块，承担集成职责。` : ''
    ].filter(Boolean)
    const requiredChecks = level === 'STATIC_ONLY'
      ? ['编译/elaboration', 'Lint', '可综合性', '端口/参数/未驱动检查']
      : level === 'UNIT_SMOKE'
        ? ['全部静态检查', 'Reset/idle', '一个合法正常事务', '一个关键边界点', '必要局部 Assertion']
        : level === 'UNIT_FOCUSED'
          ? ['全部静态检查', '独立定向 Testbench', '模块风险 Scenario', '边界/异常/并发检查', 'Oracle 原始证据']
          : ['完整 AIGV Intent/Scenario', '端到端回归与覆盖率', 'Multi-Oracle', 'Mutation', 'Residual Risk 与 Sign-off Package']
    return { module, role, level, riskScore: Number(maxRisk.toFixed(3)), reasons, oracleStrategies: [...oracleStrategies], goldenModel, requiredChecks, standaloneTestbench: level === 'UNIT_FOCUSED' || level === 'IP_SIGNOFF' }
  }).sort((a, b) => ['IP_SIGNOFF', 'UNIT_FOCUSED', 'UNIT_SMOKE', 'STATIC_ONLY'].indexOf(a.level) - ['IP_SIGNOFF', 'UNIT_FOCUSED', 'UNIT_SMOKE', 'STATIC_ONLY'].indexOf(b.level) || b.riskScore - a.riskScore)
  const summary: ModuleVerificationStrategy['summary'] = { STATIC_ONLY: 0, UNIT_SMOKE: 0, UNIT_FOCUSED: 0, IP_SIGNOFF: 0 }
  for (const plan of plans) summary[plan.level] += 1
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    rtlHash: structure.rtlHash,
    topModules,
    modules: plans,
    summary,
    policy: [
      '顶层 IP 执行完整 AIGV 与最终签核。',
      '高风险子模块执行风险驱动专项验证，普通子模块仅做静态检查或轻量 smoke。',
      '验证深度由风险决定，Oracle 类型由模块语义决定。',
      'Golden Model 由独立判定、故障定位和收敛收益决定，不与模块大小或验证等级机械绑定。',
      '顶层证据已充分覆盖的子模块场景不得重复建设；观察不足或缺陷难定位时允许升级验证等级。'
    ]
  }
}

const FEATURE_LABELS: Record<string, string> = {
  abort: '撤销', timeout: '超时', response: '响应', outstanding: '在途事务', backpressure: '反压', reset: '复位',
  interrupt: '中断', error: '错误', fifo: 'FIFO 容量', counter: '计数器', configuration: '软件配置', busy: '硬件忙状态',
  arbitration: '仲裁请求', cdc: '跨时钟域传输', ecc: 'ECC/奇偶校验', burst: '突发传输', alignment: '地址/字节对齐', ordering: '事务顺序'
}

function featureLabel(feature: string): string { return FEATURE_LABELS[feature] ?? feature }

function riskSemantics(rule: RiskRule, object: string, features: string[]): Pick<RiskMarker, 'riskStatement' | 'rationale' | 'failureModes' | 'observableEffects'> {
  const events = features.map(featureLabel).join('、')
  const semantics: Record<string, { failure: string[]; effect: string[] }> = {
    R01: { failure: ['并发事件的优先级或状态更新次数错误'], effect: ['最终状态、完成次数或返回结果与规格不一致'] },
    R02: { failure: ['多个请求同时有效时仲裁优先级、轮转或公平性失效'], effect: ['请求饥饿、错误授权或服务顺序异常'] },
    R04: { failure: ['响应到达时在途计数、事务归属或完成顺序更新错误'], effect: ['计数失配、重复完成、漏完成或乱序'] },
    R05: { failure: ['计数器在 0/MAX 边界发生上溢、下溢或意外回卷'], effect: ['容量判断、地址选择或状态转换错误'] },
    R07: { failure: ['错误路径与正常完成路径同时生效，产生双重或错误裁决'], effect: ['错误状态、返回码与完成通知互相矛盾'] },
    R08: { failure: ['在途事务遇到复位时未被一致清除或隔离'], effect: ['复位后残留 valid/busy、重复完成或状态机无法恢复'] },
    R09: { failure: ['软件写配置与硬件状态更新发生写冲突'], effect: ['配置丢失、状态误清或软件读取到不一致状态'] },
    R10: { failure: ['跨时钟域脉冲丢失、重复采样或多比特数据撕裂'], effect: ['目标域事件计数或数据内容错误'] },
    R11: { failure: ['超时完成后迟到响应仍修改事务状态'], effect: ['同一事务重复完成、计数破坏或响应归属错误'] },
    R12: { failure: ['反压期间 payload/valid 不稳定或握手计数错误'], effect: ['数据丢失、覆盖、重复或接口停滞'] },
    R13: { failure: ['资源满时仍接收请求或容量计数越界'], effect: ['队列覆盖、事务丢失或错误 backpressure'] },
    R15: { failure: ['错误恢复没有清除完整状态或恢复后无法再次服务'], effect: ['模块永久 busy、重复报错或后续事务失败'] },
    R16: { failure: ['busy 期间配置更新错误影响在途事务'], effect: ['事务使用混合配置、结果不可重复或状态损坏'] },
    R19: { failure: ['pending、mask、clear 同周期更新的优先级错误'], effect: ['中断漏报、重复上报或无法清除'] }
  }
  const selected = semantics[rule.taxonomyId] ?? { failure: ['共享状态在并发控制下发生错误更新'], effect: ['外部可见结果或时序不符合规格'] }
  return {
    riskStatement: `${object} 中的${events}在同周期、相邻周期或边界状态下交互时，可能出现${selected.failure[0]}。`,
    rationale: `RTL 结构命中 ${rule.taxonomyId}，相关控制/状态对象同时受${events}影响；这是待验证风险，不是已确认 Bug。`,
    failureModes: selected.failure,
    observableEffects: selected.effect
  }
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
      risks.push({ id: `RISK-${String(risks.length + 1).padStart(4, '0')}`, taxonomyId: rule.taxonomyId, title: rule.title, ...riskSemantics(rule, moduleName, features), object: moduleName, features, structuralComplexity, interaction, temporalDepth: rule.temporalDepth, concurrency: rule.concurrency, riskScore, confidence: 'medium', facts: structure.facts.filter((fact) => fact.module === moduleName).map((fact) => fact.id), source: { file, line: Math.min(...rule.patterns.map((pattern) => sourceLine(text, pattern))) } })
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
    const resolvedFeatures = features.length ? features : cone.directSources.slice(0, 5).map((item) => item.split('.').at(-1)!)
    const rule = RISK_RULES[0]
    risks.push({ id: `RISK-${String(risks.length + 1).padStart(4, '0')}`, taxonomyId: 'R01', title: 'N-way Shared State Interaction', ...riskSemantics(rule, `${module}.${sink}`, resolvedFeatures), object: module, features: resolvedFeatures, structuralComplexity, interaction, temporalDepth: Math.min(1, cone.depth / 4), concurrency, riskScore, confidence: structure.analyzer.engine === 'slang-ast' ? 'high' : 'medium', facts: structure.facts.filter((item) => item.module === module && item.object === sink).map((item) => item.id), source: dependency.source })
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
  return scenarios.filter((item) => item.state.closure === 'OPEN').sort((a, b) => Number(b.criticality === 1) - Number(a.criticality === 1) || b.priority - a.priority || a.costFactor - b.costFactor).slice(0, 24).map((item, index) => ({
    scenarioId: item.id,
    sequence: item.method === 'formal-candidate' ? 'formal_harness' : item.features.includes('backpressure') ? 'backpressure_sequence' : item.features.includes('reset') ? 'reset_during_traffic_sequence' : item.features.includes('error') ? 'error_injection_sequence' : 'directed_random_sequence',
    constraints: (item.method === 'formal-candidate' ? { formalMode: 'bmc_then_cover_then_prove', assumptionReviewRequired: true } : { seedClass: index < 4 ? 'focused' : 'diverse', preserveProtocolLegality: true }) as Record<string, string | number | boolean>,
    temporalConstraints: item.trigger,
    iterations: Math.max(10, Math.round(20 + item.priority * 180)),
    budgetSeconds: Math.max(30, Math.round(60 + item.costFactor * 240)),
    expected: item.expected,
    checkers: item.method === 'formal-candidate' ? ['assert', 'cover', 'assumption_review'] : ['scoreboard', 'protocol_assertions', 'scenario_hit_recorder'],
    priority: Number(Math.max(item.criticality === 1 ? 0.001 : 0, item.priority * (baseline > 90 ? 0.85 : 1) * (Object.values(item.coverageDelta).some((value) => value > 0) ? 0.8 : 1)).toFixed(3)),
    mandatory: item.criticality === 1,
    reason: `${item.reason} 当前状态 ${item.status}；到达 ${item.reachCount} 次；覆盖反馈均值 ${baseline.toFixed(1)}%；Scenario 覆盖增量 ${JSON.stringify(item.coverageDelta)}。`
  })).sort((a, b) => b.priority - a.priority)
}

function coordinatesFor(structure: StructuralModel, scenario: VerificationScenario, risk: RiskMarker): ScenarioCoordinates {
  const temporal: ScenarioCoordinates['temporal'] = []
  if (scenario.trigger.some((item) => /同周期|same.?cycle/i.test(item))) temporal.push({ relation: 'SAME_CYCLE', events: scenario.features })
  if (scenario.trigger.some((item) => /随后|迟到|after/i.test(item))) temporal.push({ relation: 'AFTER', events: scenario.features })
  if (scenario.trigger.some((item) => /之前|before/i.test(item))) temporal.push({ relation: 'BEFORE', events: scenario.features })
  if (!temporal.length && scenario.features.length > 1) temporal.push({ relation: 'WITHIN_N_CYCLES', events: scenario.features })
  const objectModule = risk.object.split(/[.:]/)[0]
  const systemState = [...new Set(structure.stateMachines.filter((item) => risk.object.includes(item.module) || item.module === objectModule).flatMap((item) => item.states))].slice(0, 32)
  const interactionTypes = risk.taxonomyId === 'R02' ? ['PRIORITY_CHAIN'] : risk.taxonomyId === 'R10' ? ['CROSSES_CLOCK'] : risk.features.length > 1 ? ['SHARES_STATE'] : ['DIRECT']
  return { feature: [...scenario.features], boundary: boundaryConditions(structure, scenario).map((item) => ({ object: item.object, values: item.values })), interaction: interactionTypes.map((type) => ({ type, object: risk.object })), temporal, systemState }
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
      const obligation = data.obligation === 'required' ? 'required' as const : 'supplemental' as const
      const mode = String(data.mode ?? 'unknown')
      const declaredOutcome = String(data.outcome ?? '') as FormalOutcome
      const allowedOutcomes = new Set<FormalOutcome>(['PROVEN', 'COUNTEREXAMPLE', 'COVERED', 'PROVEN_UNREACHABLE', 'BOUND_EXHAUSTED', 'INCONCLUSIVE', 'TOOL_ERROR', 'ASSUMPTION_DEPENDENT'])
      const outcome: FormalOutcome = allowedOutcomes.has(declaredOutcome) ? declaredOutcome
        : status === 'ERROR' ? 'TOOL_ERROR'
          : status === 'UNKNOWN' ? 'INCONCLUSIVE'
            : status === 'FAIL' ? 'COUNTEREXAMPLE'
              : mode === 'prove' ? 'PROVEN'
                : mode === 'cover' ? 'COVERED'
                  : 'BOUND_EXHAUSTED'
      return { resultFile: relative(workspace, file), status, outcome, mode, scenarioId: typeof data.scenarioId === 'string' ? data.scenarioId : undefined, rtlHash: typeof data.rtlHash === 'string' ? data.rtlHash : undefined, obligation, classification: typeof data.classification === 'string' ? data.classification : undefined, propertyFiles: Array.isArray(data.propertyFiles) ? data.propertyFiles.map(String) : [], traces: Array.isArray(data.traces) ? data.traces.map(String) : [] }
    } catch { return { resultFile: relative(workspace, file), status: 'ERROR' as const, outcome: 'TOOL_ERROR' as const, mode: 'unknown', obligation: 'supplemental' as const, propertyFiles: [], traces: [] } }
  })
}

function scenarioState(status: ScenarioStatus, evidence: string[], reachCount: number, assertionPassed: boolean | undefined, freshness: ScenarioState['freshness']): ScenarioState {
  const lifecycle: ScenarioState['lifecycle'] = status === 'DISCOVERED' || status === 'BLOCKED_BY_SPEC' ? 'DISCOVERED' : status === 'PLANNED' || status === 'IMPLEMENTED' ? 'PLANNED' : 'EXECUTED'
  const reach: ScenarioState['reach'] = status === 'FORMAL_UNREACHABLE' ? 'PROVEN_UNREACHABLE' : status === 'NOT_REACHED' ? 'NOT_REACHED' : reachCount > 0 || ['REACHED', 'VERIFIED', 'FAILED', 'FORMAL_PROVED'].includes(status) ? 'REACHED' : 'UNKNOWN'
  const judgment: ScenarioState['judgment'] = status === 'FAILED' || assertionPassed === false ? 'FAIL' : ['VERIFIED', 'FORMAL_PROVED'].includes(status) || assertionPassed === true ? 'PASS' : 'UNKNOWN'
  const evidenceState: ScenarioState['evidence'] = evidence.length >= 2 ? 'COMPLETE' : evidence.length === 1 ? 'PARTIAL' : 'MISSING'
  const closure: ScenarioState['closure'] = status === 'WAIVED' ? 'WAIVED' : ['FORMAL_UNREACHABLE'].includes(status) ? 'EXCLUDED' : ['VERIFIED', 'FORMAL_PROVED'].includes(status) && freshness === 'CURRENT' && evidenceState === 'COMPLETE' ? 'VERIFIED' : 'OPEN'
  return { lifecycle, reach, judgment, evidence: evidenceState, freshness, closure }
}

function scenarioHits(workspace: string): Map<string, { status: ScenarioStatus; evidence: string[]; reachCount: number; assertionPassed?: boolean; coverageDelta: Record<string, number>; rtlHash?: string }> {
  const hits = new Map<string, { status: ScenarioStatus; evidence: string[]; reachCount: number; assertionPassed?: boolean; coverageDelta: Record<string, number>; rtlHash?: string }>()
  for (const file of walk(join(workspace, 'verification', 'results'), (path) => basename(path) === 'scenario_hits.json')) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as { rtlHash?: string; scenarios?: Array<{ id?: string; status?: ScenarioStatus; reached?: boolean; passed?: boolean; assertionPassed?: boolean; reachCount?: number; coverageDelta?: Record<string, number>; evidence?: string[]; rtlHash?: string }> }
      for (const item of data.scenarios ?? []) {
        if (!item.id) continue
        const evidence = (item.evidence ?? []).map((path) => resolve(dirname(file), path))
        const validEvidence = evidence.filter((path) => existsSync(path) && statSync(path).isFile() && statSync(path).size > 0)
        const requestedStatus = item.status ?? (item.reached ? (item.passed ? 'VERIFIED' : 'FAILED') : 'NOT_REACHED')
        const status = ['VERIFIED', 'FORMAL_PROVED', 'FORMAL_UNREACHABLE'].includes(requestedStatus) && validEvidence.length === 0
          ? 'PARTIAL'
          : requestedStatus
        hits.set(item.id, { status, evidence: [relative(workspace, file), ...validEvidence.map((path) => relative(workspace, path))], reachCount: Number(item.reachCount ?? (item.reached ? 1 : 0)), assertionPassed: item.assertionPassed ?? item.passed, coverageDelta: Object.fromEntries(Object.entries(item.coverageDelta ?? {}).filter(([, value]) => typeof value === 'number')), rtlHash: item.rtlHash ?? data.rtlHash })
      }
    } catch { /* 无效反馈由证据审查报告处理 */ }
  }
  for (const result of collectFormalResults(workspace)) {
    if (!result.scenarioId) continue
    const status: ScenarioStatus = result.outcome === 'COUNTEREXAMPLE' ? 'FAILED'
      : result.outcome === 'PROVEN' ? 'FORMAL_PROVED'
        : result.outcome === 'PROVEN_UNREACHABLE' ? 'FORMAL_UNREACHABLE'
          : result.outcome === 'COVERED' ? 'REACHED'
            : 'PARTIAL'
    const existing = hits.get(result.scenarioId)
    const decisive = ['COUNTEREXAMPLE', 'PROVEN', 'PROVEN_UNREACHABLE', 'COVERED'].includes(result.outcome)
    if (!decisive && existing) continue
    hits.set(result.scenarioId, { status, evidence: [...new Set([...(existing?.evidence ?? []), result.resultFile, ...result.propertyFiles, ...result.traces])], reachCount: result.outcome === 'COVERED' || result.outcome === 'PROVEN' ? Math.max(1, existing?.reachCount ?? 0) : existing?.reachCount ?? 0, assertionPassed: result.outcome === 'COUNTEREXAMPLE' ? false : result.outcome === 'PROVEN' ? true : existing?.assertionPassed, coverageDelta: existing?.coverageDelta ?? {}, rtlHash: result.rtlHash ?? existing?.rtlHash })
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
    let status = hit?.status ?? previousItem?.status ?? (requirementIds.length === 0 ? 'BLOCKED_BY_SPEC' : 'DISCOVERED')
    const rtlChanged = Boolean(previousItem?.rtlHash && previousItem.rtlHash !== structure.rtlHash)
    const currentEvidence = Boolean(hit && (hit.rtlHash ? hit.rtlHash === structure.rtlHash : !rtlChanged && previousItem?.state?.freshness !== 'IMPACT_UNKNOWN'))
    const freshness: ScenarioState['freshness'] = currentEvidence ? 'CURRENT' : rtlChanged ? 'IMPACT_UNKNOWN' : previousItem?.state?.freshness ?? 'CURRENT'
    if (freshness !== 'CURRENT' && ['VERIFIED', 'FORMAL_PROVED'].includes(status)) status = 'PARTIAL'
    const closed = ['VERIFIED', 'FORMAL_PROVED', 'FORMAL_UNREACHABLE', 'WAIVED'].includes(status)
    const coverageGap = closed ? 0 : status === 'PARTIAL' ? 0.5 : 1
    const confidenceFactor = risk.confidence === 'high' ? 1 : risk.confidence === 'medium' ? 0.85 : 0.65
    const costFactor = rule.method === 'static' ? 1 : rule.method === 'formal-candidate' ? 0.8 : 0.9
    const priority = Number((criticality * risk.riskScore * risk.interaction * coverageGap * confidenceFactor * costFactor).toFixed(3))
    const evidence = [...new Set([risk.source.file, ...(hit?.evidence ?? previousItem?.evidence ?? [])])]
    const reachCount = hit?.reachCount ?? previousItem?.reachCount ?? 0
    const assertionPassed = hit?.assertionPassed ?? previousItem?.assertionPassed
    const scenario = { id, title: `${risk.title}: ${risk.features.join(' × ')}`, riskIds: [risk.id], requirementIds, rtlObjects: [risk.object], features: risk.features, trigger: nway ? risk.features.map((item) => `${item} 在同周期或相邻周期有效`) : rule.trigger, expected: nway ? ['共享状态的优先级、更新次数和外部可见结果符合规格'] : rule.expected, method: nway ? 'formal-candidate' as const : rule.method, status, state: scenarioState(status, evidence, reachCount, assertionPassed, freshness), rtlHash: structure.rtlHash, risk: risk.riskScore, interaction: risk.interaction, coverageGap, criticality, confidenceFactor, costFactor, priority, reason: `结构规则 ${risk.taxonomyId} 命中 ${risk.object}；${risk.features.join('、')} 共享控制或时序语义。`, evidence, reachCount, assertionPassed, coverageDelta: hit?.coverageDelta ?? previousItem?.coverageDelta ?? {}, updatedAt: new Date().toISOString() } as VerificationScenario
    scenario.coordinates = coordinatesFor(structure, scenario, risk)
    return scenario
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
  const add = (gap: Omit<SpecGap, 'id'>): void => {
    gaps.push({ id: `SPEC-GAP-${String(gaps.length + 1).padStart(4, '0')}`, ...gap })
  }
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
  const boundaries: BoundaryCondition[] = relevant.slice(0, 8).map((item) => ({ object: `${item.module}.${item.register}`, values: ['0', '1', 'MAX-1', 'MAX', 'overflow/wrap'], rationale: '由计数器、指针或容量相关 RTL 对象生成。', source: item.source }))
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
    const eventText = events.map(featureLabel).join('、') || '目标控制事件'
    const objective = `验证 ${scenario.rtlObjects.join('、')} 在${eventText}发生指定时序交互及边界条件时，外部可见状态、响应和计数结果始终符合规格，且不会出现重复、丢失或错误裁决。`
    const stimulusProcedure = [
      `将 DUT 初始化到满足以下前置条件的状态：${scenario.trigger.join('；') || '正常可工作状态'}`,
      `分别构造 ${eventText} 的 BEFORE、SAME_CYCLE、AFTER 组合，并覆盖允许的相邻周期偏移。`,
      `在每种时间关系下遍历已列出的边界值，并保持协议激励合法。`,
      `记录 ${scenario.id} hit、输入事务、关键内部状态和输出响应。`
    ]
    const observationPoints = [...new Set([...scenario.rtlObjects, ...structure.registerWriters.filter((item) => scenario.rtlObjects.includes(item.module)).slice(0, 6).map((item) => `${item.module}.${item.register}`)])]
    const passCriteria = [
      ...scenario.expected.map((item) => `Checker/Assertion 必须证明：${item}`),
      '每个计划内时间关系和边界点均产生可追踪的 Scenario hit。',
      '无 assertion failure、scoreboard mismatch、协议违规或未知态传播。',
      '结果必须关联原始日志、结构化 result、覆盖率及必要波形。'
    ]
    return { id: `VI-${scenario.id.slice(4)}`, scenarioId: scenario.id, objective, rationale: scenario.reason, failureMode: `若该 Intent 不成立，可能出现：${scenario.expected.join('；')}的反例或外部可见不一致。`, sourceIds: [...scenario.requirementIds, ...scenario.riskIds], preconditions: scenario.trigger, stimulus: { events, temporalInteractions }, observations: scenario.rtlObjects, stimulusProcedure, observationPoints, expectedResults: scenario.expected, passCriteria, boundaries: boundaryConditions(structure, scenario), recommendedMethods: methods, evidence: scenario.evidence, status: scenario.status, priority: scenario.priority }
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
    const requiredStimulus = [
      `建立前置状态：${scenario.trigger.join('；') || 'DUT 正常可工作'}`,
      `定向产生 ${scenario.features.map(featureLabel).join('、')} 的同周期及相邻周期交互`,
      '覆盖该场景关联的 0/1/MAX-1/MAX 或协议边界，并写入 Scenario hit'
    ]
    const requiredObservation = [
      `观察 ${scenario.rtlObjects.join('、')} 的状态、计数和接口响应`,
      ...scenario.expected.map((item) => `检查：${item}`)
    ]
    const closureEvidence = ['scenario_hits.json 中该场景 reached=true 且 passed=true', 'Checker/Assertion 原始结果', '结构化回归结果与覆盖率增量', '失败时保留可定位波形；Formal 场景保留 property/result/trace']
    return { id: `HOLE-${scenario.id.slice(4)}`, scenarioId: scenario.id, scenarioTitle: scenario.title, classification, confidence, evidence: scenario.evidence, reason, missingTarget: `${scenario.rtlObjects.join('、')} 中 ${scenario.features.map(featureLabel).join('、')} 的时序交互尚未形成“到达 + 裁决 + 证据”闭环。`, requiredStimulus, requiredObservation, closureEvidence, recommendedAction: action, blocking: scenario.priority >= 0.2 }
  })
}

function writeReport(path: string, state: VerificationStateModel, risks: RiskMarker[]): void {
  const rows = state.verificationIntents.slice(0, 50).map((item) => `| ${item.id} | ${item.scenarioId} | ${item.objective.replace(/\|/g, '\\|')} | ${item.priority} | ${item.status} |`).join('\n')
  const holes = state.coverageHoles.slice(0, 50).map((item) => `### ${item.id} · ${item.scenarioId}\n\n- **具体缺口**：${item.missingTarget}\n- **原因分类**：${item.classification}，${item.reason}\n- **所需激励**：${item.requiredStimulus.join('；')}\n- **观察与判定**：${item.requiredObservation.join('；')}\n- **关闭证据**：${item.closureEvidence.join('；')}\n- **下一步**：${item.recommendedAction}`).join('\n\n')
  writeFileSync(path, `# Verification Intelligence Report\n\n- RTL Hash: \`${state.rtlHash}\`\n- 风险标记：${risks.length}\n- Scenario：${state.scenarioCount}\n- Verification Intent：${state.verificationIntents.length}\n- Spec Gap：${state.specGaps.length}\n- Coverage Hole：${state.coverageHoles.length}\n- Critical Open：${state.criticalOpen.length}\n\n## 可执行 Verification Intent\n\n| Intent | Scenario | 可证伪验证目标 | 优先级 | 状态 |\n|---|---|---|---:|---|\n${rows || '| - | - | 暂无 | - | - |'}\n\n## Coverage Hole 处置\n\n${holes || '当前没有待处置的 Coverage Hole。'}\n\n> 风险标记用于验证规划，不等同于已发现 RTL Bug。Intent 必须通过“到达、裁决、证据”三项闭环。\n`, 'utf-8')
}

function writeVerificationDocSnapshot(workspace: string, state: VerificationStateModel): void {
  const docsDir = join(workspace, 'docs', '04_verification')
  mkdirSync(docsDir, { recursive: true })
  const intentRows = state.verificationIntents.map((item) => `| ${item.id} | ${item.sourceIds.join(', ')} | ${item.scenarioId} | ${item.objective.replace(/\|/g, '\\|')} | ${item.status} | ${item.evidence.join('<br>')} |`).join('\n')
  const holeRows = state.coverageHoles.map((item) => `| ${item.id} | ${item.scenarioId} | ${item.classification} | ${item.missingTarget.replace(/\|/g, '\\|')} | ${item.recommendedAction.replace(/\|/g, '\\|')} |`).join('\n')
  const content = `# AIGV 执行与闭环快照\n\n> 本文件由 MoonGlass 根据机器可读 AIGV 产物自动生成，请勿手工维护。计划口径以 verification_plan.md、test_plan.md、coverage_plan.md 为准；本文件提供它们在当前 RTL 与证据版本上的统一执行视图。\n\n- 生成时间：${state.generatedAt}\n- RTL Hash：\`${state.rtlHash}\`\n- Intent：${state.verificationIntents.length}\n- 关键未闭环：${state.criticalOpen.length}\n\n## 统一追踪链\n\n\`REQ/SPEC → VI → SCN → TEST/COVER/PROPERTY → EVIDENCE → SIGNOFF\`\n\n## Verification Intent 状态\n\n| Intent | 来源 | Scenario | 可证伪验证目标 | 状态 | 原始证据 |\n|---|---|---|---|---|---|\n${intentRows || '| - | - | - | 暂无 | - | - |'}\n\n## Coverage Hole 处置\n\n| Hole | Scenario | 分类 | 具体缺口 | 下一步 |\n|---|---|---|---|---|\n${holeRows || '| - | - | - | 当前无 Coverage Hole | - |'}\n\n## 文档一致性规则\n\n- verification_plan.md 定义范围、方法分配、里程碑和签核准则。\n- test_plan.md 将 TEST-* 绑定到 VI-* / SCN-*，写清激励、Checker 和通过标准。\n- coverage_plan.md 将 COVER-* 绑定到 VI-* / SCN-*，管理覆盖目标、交叉覆盖和 C1-C6 处置。\n- 六份 AIGV 文档解释风险发现、执行批次和证据闭环，不得另建一套互相矛盾的测试清单。\n`
  writeFileSync(join(docsDir, 'aigv_execution_snapshot.md'), content, 'utf-8')
}

const ORACLE_DEFINITIONS: OracleDefinition[] = [
  { id: 'ORACLE-REFERENCE-SCOREBOARD', type: 'REFERENCE_MODEL', name: '独立参考模型 / Scoreboard', independenceLevel: 2, independenceDomain: 'reference-model', implementation: 'cocotb scoreboard or executable reference model', sharedAssumptions: ['输入事务和规格映射正确'] },
  { id: 'ORACLE-INVARIANT-ASSERTION', type: 'INVARIANT', name: '架构不变量 / Assertion', independenceLevel: 2, independenceDomain: 'architecture-invariant', implementation: 'temporal or immediate assertions', sharedAssumptions: ['不变量来自已批准架构规则'] },
  { id: 'ORACLE-PROTOCOL-CHECKER', type: 'PROTOCOL', name: '协议 Checker', independenceLevel: 3, independenceDomain: 'protocol-standard', implementation: 'independent protocol monitor or VIP', sharedAssumptions: ['接口协议识别正确'] },
  { id: 'ORACLE-FORMAL-PROPERTY', type: 'FORMAL', name: 'Formal Property', independenceLevel: 3, independenceDomain: 'formal-property', implementation: 'formal proof with reviewed assumptions', sharedAssumptions: ['property 与 assumptions 已审查'] },
  { id: 'ORACLE-METAMORPHIC', type: 'METAMORPHIC', name: 'Metamorphic Relation', independenceLevel: 2, independenceDomain: 'metamorphic-relation', implementation: 'input/output transformation relation', sharedAssumptions: ['变换关系适用于当前功能'] },
  { id: 'ORACLE-END-TO-END', type: 'END_TO_END', name: '端到端语义检查', independenceLevel: 1, independenceDomain: 'spec-semantic', implementation: 'independent semantic checker', sharedAssumptions: ['与 Reference Model 可能共享规格理解'] }
]

function collectMutationAssessment(workspace: string, rtlHash: string, threshold = 0.9): MutationAssessment {
  const records: MutationRecord[] = []
  for (const file of walk(join(workspace, 'verification', 'results'), (path) => basename(path) === 'mutation-results.json')) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as { rtlHash?: string; records?: MutationRecord[] }
      for (const raw of data.records ?? []) records.push({ ...raw, weight: Math.max(0, Number(raw.weight ?? 0)), evidence: [relative(workspace, file), ...(raw.evidence ?? [])], rtlHash: raw.rtlHash ?? data.rtlHash })
    } catch { /* malformed mutation files are represented by missing/invalid evidence */ }
  }
  const current = records.filter((item) => item.rtlHash === rtlHash && item.evidence.length > 0)
  const scored = current.filter((item) => item.status === 'KILLED' || item.status === 'SURVIVED' || item.status === 'EQUIVALENCE_UNKNOWN' || (item.status === 'EQUIVALENT' && !item.review?.approved))
  const denominator = scored.reduce((sum, item) => sum + item.weight, 0)
  const killedWeight = scored.filter((item) => item.status === 'KILLED').reduce((sum, item) => sum + item.weight, 0)
  const weightedScore = denominator > 0 ? Number((killedWeight / denominator).toFixed(4)) : null
  const blockingSurvivors = scored.filter((item) => item.status !== 'KILLED' && !item.review?.approved).map((item) => item.id)
  const invalidOrStale = records.filter((item) => item.status === 'INVALID' || item.rtlHash !== rtlHash).map((item) => item.id)
  const status: MutationAssessment['status'] = current.length === 0 || weightedScore === null ? 'MISSING' : blockingSurvivors.length ? 'BLOCKED_BY_SURVIVOR' : weightedScore < threshold ? 'BELOW_THRESHOLD' : 'PASS'
  return { version: 1, generatedAt: new Date().toISOString(), rtlHash, threshold, weightedScore, records, validCount: scored.length, killedCount: scored.filter((item) => item.status === 'KILLED').length, blockingSurvivors, invalidOrStale, status }
}

function readRiskApprovals(workspace: string): Map<string, ResidualRisk['approval']> {
  const path = join(workspace, 'verification', 'intelligence', 'signoff-approvals.json')
  if (!existsSync(path)) return new Map()
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as { approvals?: Array<{ riskId: string; approver: string; rationale: string; approvedAt: string }> }
    return new Map((data.approvals ?? []).filter((item) => item.riskId && item.approver && item.rationale && item.approvedAt).map((item) => [item.riskId, { approver: item.approver, rationale: item.rationale, approvedAt: item.approvedAt }]))
  } catch { return new Map() }
}

function buildResidualRisks(workspace: string, scenarios: VerificationScenario[], formalResults: VerificationStateModel['formalResults'], mutation: MutationAssessment, space: VerificationSpaceSnapshot): ResidualRisk[] {
  const approvals = readRiskApprovals(workspace)
  const risks: Array<Omit<ResidualRisk, 'approved' | 'approval'>> = []
  for (const result of formalResults.filter((item) => item.obligation === 'supplemental' && ['TOOL_ERROR', 'INCONCLUSIVE', 'BOUND_EXHAUSTED', 'ASSUMPTION_DEPENDENT'].includes(item.outcome))) risks.push({ id: `RR-FORMAL-${createHash('sha1').update(result.resultFile).digest('hex').slice(0, 8).toUpperCase()}`, category: result.outcome === 'TOOL_ERROR' ? 'TOOL_LIMITATION' : 'FORMAL_LIMITATION', title: `${result.mode} 未获得决定性 Formal 结论`, impact: '相关性质仅由其他验证方法支撑，Formal 不提供额外证明。', evidence: [result.resultFile], approvalRequired: true })
  for (const id of mutation.blockingSurvivors) risks.push({ id: `RR-MUT-${id}`, category: 'MUTATION_SURVIVOR', title: `Mutation ${id} 未被检测`, impact: '当前 Checker/激励可能无法感知对应缺陷，需增强验证或批准低影响处置。', evidence: mutation.records.find((item) => item.id === id)?.evidence ?? [], approvalRequired: true })
  for (const entry of space.negativeSpace.filter((item) => !item.approved)) risks.push({ id: `RR-NEG-${entry.scenarioId}`, category: 'NEGATIVE_SPACE', title: `${entry.scenarioId} 尚未批准进入 Negative Space`, impact: entry.reason, evidence: entry.evidence, approvalRequired: true })
  for (const scenario of scenarios.filter((item) => item.state.closure === 'WAIVED')) risks.push({ id: `RR-WAIVER-${scenario.id}`, category: 'WAIVER', title: `${scenario.id} 使用签核豁免`, impact: '该验证场景没有由执行证据关闭，项目需明确接受剩余风险。', evidence: scenario.evidence, approvalRequired: true })
  return risks.map((risk) => { const approval = approvals.get(risk.id); return { ...risk, approved: Boolean(approval), approval } })
}

function buildMultiOracle(workspace: string, rtlHash: string, scenarios: VerificationScenario[], formalResults: VerificationStateModel['formalResults']): MultiOracleEvaluation {
  const verdicts: OracleVerdict[] = []
  const addVerdict = (verdict: OracleVerdict): void => {
    const key = `${verdict.scenarioId}\0${verdict.oracleId}`
    const previous = verdicts.findIndex((item) => `${item.scenarioId}\0${item.oracleId}` === key)
    if (previous >= 0) verdicts.splice(previous, 1)
    verdicts.push(verdict)
  }
  for (const file of walk(join(workspace, 'verification', 'results'), (path) => basename(path) === 'scenario_hits.json' || basename(path) === 'oracle_verdicts.json')) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as { rtlHash?: string; scenarios?: Array<Record<string, unknown>>; verdicts?: OracleVerdict[] }
      for (const verdict of data.verdicts ?? []) if (ORACLE_DEFINITIONS.some((item) => item.id === verdict.oracleId)) addVerdict({ ...verdict, evidence: [relative(workspace, file), ...(verdict.evidence ?? [])], rtlHash: verdict.rtlHash ?? data.rtlHash })
      for (const raw of data.scenarios ?? []) {
        const scenarioId = typeof raw.id === 'string' ? raw.id : ''
        if (!scenarioId) continue
        const evidence = [relative(workspace, file), ...(Array.isArray(raw.evidence) ? raw.evidence.map(String) : [])]
        const base = { scenarioId, evidence, rtlHash: typeof raw.rtlHash === 'string' ? raw.rtlHash : data.rtlHash, generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : undefined }
        if (typeof raw.passed === 'boolean') addVerdict({ ...base, oracleId: 'ORACLE-REFERENCE-SCOREBOARD', verdict: raw.passed ? 'PASS' : 'FAIL' })
        if (typeof raw.assertionPassed === 'boolean') addVerdict({ ...base, oracleId: 'ORACLE-INVARIANT-ASSERTION', verdict: raw.assertionPassed ? 'PASS' : 'FAIL' })
        if (typeof raw.protocolPassed === 'boolean') addVerdict({ ...base, oracleId: 'ORACLE-PROTOCOL-CHECKER', verdict: raw.protocolPassed ? 'PASS' : 'FAIL' })
        if (typeof raw.metamorphicPassed === 'boolean') addVerdict({ ...base, oracleId: 'ORACLE-METAMORPHIC', verdict: raw.metamorphicPassed ? 'PASS' : 'FAIL' })
      }
    } catch { /* malformed verdict files are handled as missing Oracle evidence */ }
  }
  for (const result of formalResults) {
    if (!result.scenarioId) continue
    const verdict: OracleVerdict['verdict'] = result.outcome === 'PROVEN' ? 'PASS' : result.outcome === 'COUNTEREXAMPLE' ? 'FAIL' : result.outcome === 'TOOL_ERROR' ? 'ERROR' : 'UNKNOWN'
    addVerdict({ scenarioId: result.scenarioId, oracleId: 'ORACLE-FORMAL-PROPERTY', verdict, evidence: [result.resultFile, ...result.propertyFiles, ...result.traces], rtlHash: result.rtlHash })
  }
  const definitions = ORACLE_DEFINITIONS.map((item) => ({ ...item, sharedAssumptions: [...item.sharedAssumptions] }))
  const definitionsById = new Map(definitions.map((item) => [item.id, item]))
  const assessments = scenarios.map((scenario) => {
    const relevant = verdicts.filter((item) => item.scenarioId === scenario.id)
    const valid = relevant.filter((item) => item.rtlHash === rtlHash && item.evidence.length > 0 && definitionsById.has(item.oracleId))
    const passes = valid.filter((item) => item.verdict === 'PASS' && (definitionsById.get(item.oracleId)?.independenceLevel ?? 0) >= 2)
    const fails = valid.filter((item) => item.verdict === 'FAIL')
    const independentPassDomains = [...new Set(passes.map((item) => definitionsById.get(item.oracleId)!.independenceDomain))]
    const requiredIndependentPasses = scenario.criticality >= 0.8 ? 2 : 1
    const status = fails.length && passes.length ? 'CONFLICT' as const : fails.length ? 'FAIL' as const : independentPassDomains.length >= requiredIndependentPasses ? 'PASS' as const : 'INSUFFICIENT' as const
    const explanation = status === 'PASS' ? `${independentPassDomains.length} 个独立判定域通过` : status === 'CONFLICT' ? '有效 Oracle 之间存在 PASS/FAIL 冲突，禁止自动覆盖' : status === 'FAIL' ? `${fails.length} 个有效 Oracle 报告失败` : `仅 ${independentPassDomains.length}/${requiredIndependentPasses} 个独立判定域通过`
    return { scenarioId: scenario.id, requiredIndependentPasses, independentPassDomains, passOracleIds: passes.map((item) => item.oracleId), failOracleIds: fails.map((item) => item.oracleId), invalidOracleIds: relevant.filter((item) => !valid.includes(item)).map((item) => item.oracleId), status, explanation }
  })
  return { version: 1, generatedAt: new Date().toISOString(), rtlHash, definitions, verdicts, assessments, criticalInsufficient: assessments.filter((item) => item.requiredIndependentPasses === 2 && item.status === 'INSUFFICIENT').map((item) => item.scenarioId), conflicts: assessments.filter((item) => item.status === 'CONFLICT').map((item) => item.scenarioId) }
}

function assessClosure(scenarios: VerificationScenario[], regressions: VerificationStateModel['regressions'], formalResults: VerificationStateModel['formalResults'], coverageHoles: CoverageHole[], multiOracle: MultiOracleEvaluation, explorationHistory: ExplorationHistory, mutation: MutationAssessment, residualRiskRegister: ResidualRisk[]): ClosureAssessment {
  const blockers: string[] = []
  const warnings: string[] = []
  const residualRisks: string[] = []
  const nextActions: string[] = []
  const critical = scenarios.filter((item) => item.criticality >= 0.8)
  const criticalClosed = critical.filter((item) => item.state.closure === 'VERIFIED' || item.state.closure === 'EXCLUDED' || item.state.closure === 'WAIVED')
  const impactUnknown = scenarios.filter((item) => item.state.freshness === 'IMPACT_UNKNOWN').length
  const blockingCoverageHoles = coverageHoles.filter((item) => item.blocking).length
  const formalToolErrors = formalResults.filter((item) => item.outcome === 'TOOL_ERROR').length
  const requiredFormalBlocked = formalResults.filter((item) => item.obligation === 'required' && ['TOOL_ERROR', 'INCONCLUSIVE', 'BOUND_EXHAUSTED', 'ASSUMPTION_DEPENDENT'].includes(item.outcome)).length
  const formalFailures = formalResults.filter((item) => item.outcome === 'COUNTEREXAMPLE').length
  const regressionsPassed = regressions.length > 0 && regressions.every((item) => item.passed)

  if (criticalClosed.length !== critical.length) blockers.push(`${critical.length - criticalClosed.length} 个 P0/P1 Scenario 尚未形成完整闭环证据`)
  if (!regressions.length) blockers.push('尚无结构化回归证据')
  else if (!regressionsPassed) blockers.push('存在失败回归')
  if (blockingCoverageHoles) blockers.push(`${blockingCoverageHoles} 个阻断性 Coverage Hole 尚未关闭`)
  if (formalFailures) blockers.push(`${formalFailures} 项 Formal 产生反例或属性失败`)
  if (requiredFormalBlocked) blockers.push(`${requiredFormalBlocked} 项强制 Formal 未产生有效求解结论`)
  if (impactUnknown) blockers.push(`${impactUnknown} 个 Scenario 的 RTL 变更影响未知，必须执行影响回归`)
  if (multiOracle.criticalInsufficient.length) blockers.push(`${multiOracle.criticalInsufficient.length} 个关键 Scenario 尚未获得两个独立 Oracle 的有效 PASS`)
  if (multiOracle.conflicts.length) blockers.push(`${multiOracle.conflicts.length} 个 Scenario 存在 Oracle 冲突，必须仲裁而非自动覆盖`)
  if (explorationHistory.saturation.status === 'STALLED') blockers.push('Explorer 连续无新增且关键场景仍未闭环，已进入探索停滞')
  else if (criticalClosed.length === critical.length && explorationHistory.saturation.status !== 'EMPIRICALLY_SATURATED') blockers.push('关键证据已闭环，但尚未获得足够轮次的经验性 Novelty Saturation 证据')
  if (mutation.status === 'MISSING') blockers.push('尚无绑定当前 RTL 的风险加权 Mutation 结果')
  else if (mutation.status === 'BELOW_THRESHOLD') blockers.push(`风险加权 Mutation Score ${mutation.weightedScore} 低于阈值 ${mutation.threshold}`)
  else if (mutation.status === 'BLOCKED_BY_SURVIVOR') blockers.push(`${mutation.blockingSurvivors.length} 个 Mutation survivor/equivalence unknown 尚未处置`)
  const unapprovedResidual = residualRiskRegister.filter((item) => item.approvalRequired && !item.approved)
  if (unapprovedResidual.length) blockers.push(`${unapprovedResidual.length} 项 Residual Risk 尚未批准或关闭`)
  for (const risk of residualRiskRegister.filter((item) => item.approved)) residualRisks.push(`${risk.id}：${risk.title}（${risk.approval?.approver ?? '已批准'}）`)
  if (formalToolErrors) warnings.push(`${formalToolErrors} 项 Formal 工具错误仅记录为 C6，不得解释为不可达或 RTL 缺陷`)
  const supplementalUnknown = formalResults.filter((item) => item.obligation === 'supplemental' && ['INCONCLUSIVE', 'BOUND_EXHAUSTED', 'ASSUMPTION_DEPENDENT'].includes(item.outcome)).length
  if (supplementalUnknown) residualRisks.push(`${supplementalUnknown} 项补强 Formal 未获得决定性结论`)
  if (impactUnknown) nextActions.push('先执行 RTL 变更影响分析与受影响回归，更新 Scenario freshness')
  if (!regressionsPassed) nextActions.push('修复失败回归并重新发布结构化 result.json、JUnit 与波形证据')
  if (blockingCoverageHoles) nextActions.push('按 C1-C6 分类关闭阻断性 Coverage Hole')
  if (requiredFormalBlocked) nextActions.push('修复强制 Formal 工具/约束问题，或经批准调整验证义务')
  if (multiOracle.conflicts.length) nextActions.push('读取冲突 Oracle 的原始证据，检查适用范围、共享假设与 Checker 正确性')
  else if (multiOracle.criticalInsufficient.length) nextActions.push('为关键 Scenario 补充不同独立性域的 Oracle，并生成 oracle_verdicts.json')
  if (explorationHistory.saturation.status === 'STALLED') nextActions.push('停止重复相同批次，优先增强 Checker/Assertion、调整合法激励或重新审查空间模型')
  else if (criticalClosed.length === critical.length && explorationHistory.saturation.status !== 'EMPIRICALLY_SATURATED') nextActions.push('继续执行独立种子或不同策略的攻击探索，并记录至少三轮有效 Exploration Round')
  if (mutation.status !== 'PASS') nextActions.push('运行风险加权 Mutation，增强能够杀死 survivor 的 Checker/激励；INVALID 与等价变异必须分别审查')
  if (unapprovedResidual.length) nextActions.push('关闭 Residual Risk，或由具名审批人在 signoff-approvals.json 中记录依据与时间')
  if (!nextActions.length) nextActions.push('执行独立证据审查并提交人工签核')

  const status: ClosureAssessment['status'] = blockers.length ? 'NOT_READY' : residualRisks.length || warnings.length ? 'CONDITIONALLY_READY' : 'READY_FOR_HUMAN_SIGNOFF'
  return { status, generatedAt: new Date().toISOString(), blockers, warnings, residualRisks, nextActions, metrics: { criticalTotal: critical.length, criticalClosed: criticalClosed.length, criticalClosurePercent: critical.length ? Math.round(criticalClosed.length * 100 / critical.length) : 100, regressionsPassed, blockingCoverageHoles, formalToolErrors, impactUnknown, explorationSaturation: explorationHistory.saturation.status, mutationScore: mutation.weightedScore } }
}

function buildSignoffPackage(rtlHash: string, space: VerificationSpaceSnapshot, closure: ClosureAssessment, residualRisks: ResidualRisk[], scenarios: VerificationScenario[], regressions: VerificationStateModel['regressions'], formalResults: VerificationStateModel['formalResults'], mutation: MutationAssessment): SignoffPackage {
  const evidenceFiles = [...new Set([
    ...scenarios.flatMap((item) => item.evidence),
    ...regressions.map((item) => item.resultFile),
    ...formalResults.flatMap((item) => [item.resultFile, ...item.propertyFiles, ...item.traces]),
    ...mutation.records.flatMap((item) => item.evidence)
  ])].filter(Boolean)
  const packageId = `SIGNOFF-${createHash('sha256').update(`${rtlHash}\0${space.snapshotId}\0${closure.status}\0${closure.blockers.join('|')}\0${evidenceFiles.sort().join('|')}`).digest('hex').slice(0, 16).toUpperCase()}`
  const summary = closure.status === 'READY_FOR_HUMAN_SIGNOFF' ? '机器闭环条件已满足，等待具名工程审批。' : closure.status === 'CONDITIONALLY_READY' ? '核心条件满足，但仍有已批准残余风险需要在最终审批中确认。' : '存在未关闭的验证、工具、Mutation 或风险审批阻断。'
  return { version: 1, packageId, generatedAt: new Date().toISOString(), rtlHash, verificationSpaceSnapshotId: space.snapshotId, status: closure.status, summary, blockers: closure.blockers, warnings: closure.warnings, residualRisks, evidenceFiles }
}

function writeSignoffReport(path: string, pkg: SignoffPackage, mutation: MutationAssessment, multiOracle: MultiOracleEvaluation, history: ExplorationHistory): void {
  const blockers = pkg.blockers.map((item) => `- ${item}`).join('\n') || '- 无'
  const residual = pkg.residualRisks.map((item) => `| ${item.id} | ${item.category} | ${item.title.replace(/\|/g, '\\|')} | ${item.approved ? `已批准：${item.approval?.approver ?? '-'}` : '未批准'} |`).join('\n') || '| - | - | 无 | - |'
  const evidence = pkg.evidenceFiles.map((item) => `- \`${item}\``).join('\n') || '- 无'
  writeFileSync(path, `# MoonGlass AIGV 2.0 Verification Sign-off Package\n\n- Package ID：\`${pkg.packageId}\`\n- 生成时间：${pkg.generatedAt}\n- RTL Hash：\`${pkg.rtlHash}\`\n- Verification Space：\`${pkg.verificationSpaceSnapshotId}\`\n- 机器结论：**${pkg.status}**\n- 说明：${pkg.summary}\n\n## 签核阻断\n\n${blockers}\n\n## 关键评价\n\n- Multi-Oracle：${multiOracle.assessments.filter((item) => item.status === 'PASS').length}/${multiOracle.assessments.length} PASS；冲突 ${multiOracle.conflicts.length}；关键证据不足 ${multiOracle.criticalInsufficient.length}\n- Risk-weighted Mutation：${mutation.weightedScore == null ? '无有效结果' : `${(mutation.weightedScore * 100).toFixed(1)}%`}；阈值 ${(mutation.threshold * 100).toFixed(1)}%；状态 ${mutation.status}\n- Novelty Saturation：${history.saturation.status}；${history.saturation.explanation}\n\n## Residual Risk Register\n\n| ID | 分类 | 风险 | 审批 |\n|---|---|---|---|\n${residual}\n\n## Evidence Index\n\n${evidence}\n\n> 本报告是机器签核建议，不替代具名工程责任人的最终批准。所有结论仅对上述 RTL、规格空间快照、工具配置和证据集合有效。\n`, 'utf-8')
}

function buildVerificationSpace(requirements: RequirementModel, structure: StructuralModel, scenarios: VerificationScenario[]): VerificationSpaceSnapshot {
  const specHashBuilder = createHash('sha256')
  for (const requirement of [...requirements.requirements].sort((a, b) => a.id.localeCompare(b.id))) specHashBuilder.update(requirement.id).update('\0').update(requirement.text).update('\0')
  const specHash = specHashBuilder.digest('hex')
  const negativeSpace: NegativeSpaceEntry[] = []
  for (const scenario of scenarios) {
    if (scenario.status === 'FORMAL_UNREACHABLE' && scenario.state.reach === 'PROVEN_UNREACHABLE') negativeSpace.push({ id: `NEG-${scenario.id}`, scenarioId: scenario.id, classification: 'PROVEN_UNREACHABLE', reason: 'Formal 结果明确证明当前约束下不可达', evidence: scenario.evidence, approved: true })
    else if (scenario.status === 'BLOCKED_BY_SPEC') negativeSpace.push({ id: `NEG-${scenario.id}`, scenarioId: scenario.id, classification: 'SPEC_UNDEFINED', reason: '缺少能够定义唯一预期的规格映射', evidence: scenario.evidence, approved: false })
    else if (scenario.status === 'WAIVED') negativeSpace.push({ id: `NEG-${scenario.id}`, scenarioId: scenario.id, classification: 'OVER_BUDGET', reason: '场景使用风险接受或预算豁免，必须在 Sign-off Approval 中明确批准', evidence: scenario.evidence, approved: false })
  }
  const dimensionValues = {
    features: new Set(scenarios.flatMap((item) => item.coordinates.feature)).size,
    boundaries: new Set(scenarios.flatMap((item) => item.coordinates.boundary.flatMap((boundary) => boundary.values.map((value) => `${boundary.object}=${value}`)))).size,
    interactions: new Set(scenarios.flatMap((item) => item.coordinates.interaction.map((edge) => `${edge.type}:${edge.object}`))).size,
    temporalRelations: new Set(scenarios.flatMap((item) => item.coordinates.temporal.map((temporal) => `${temporal.relation}:${temporal.events.join('+')}`))).size,
    systemStates: new Set(scenarios.flatMap((item) => item.coordinates.systemState)).size
  }
  const snapshotId = `VSPACE-${createHash('sha1').update(`${specHash}\0${structure.rtlHash}\0${scenarios.map((item) => item.id).sort().join(',')}`).digest('hex').slice(0, 12).toUpperCase()}`
  return { version: 1, snapshotId, generatedAt: new Date().toISOString(), rtlHash: structure.rtlHash, specHash, scenarioIds: scenarios.map((item) => item.id), candidateCount: scenarios.length, positiveCount: scenarios.length - negativeSpace.length, negativeCount: negativeSpace.length, dimensions: dimensionValues, negativeSpace }
}

function buildExplorationRound(space: VerificationSpaceSnapshot, scenarios: VerificationScenario[], executionPlan: ScenarioExecutionPlan[]): ExplorationRound {
  const selected = executionPlan.slice(0, 3)
  return {
    version: 1,
    roundId: `ROUND-${createHash('sha1').update(`${space.snapshotId}\0${selected.map((item) => item.scenarioId).join(',')}`).digest('hex').slice(0, 10).toUpperCase()}`,
    snapshotId: space.snapshotId,
    generatedAt: new Date().toISOString(),
    selectedScenarioIds: selected.map((item) => item.scenarioId),
    expectedCostSeconds: selected.reduce((sum, item) => sum + item.budgetSeconds, 0),
    candidateCount: executionPlan.length,
    uncoveredCritical: scenarios.filter((item) => item.criticality >= 0.8 && item.state.closure === 'OPEN').length,
    rationale: selected.map((item) => `${item.scenarioId}: ${item.reason}`),
    baselineClosedScenarioIds: scenarios.filter((item) => item.state.closure !== 'OPEN').map((item) => item.id),
    newlyClosedScenarioIds: [], noveltyScore: 0, result: 'PENDING'
  }
}

function summarizeExploration(rounds: ExplorationRound[], criticalOpen: number, snapshotId?: string, window = 3, epsilon = 0): ExplorationHistory['saturation'] {
  const completed = rounds.filter((item) => item.result !== 'PENDING' && (!snapshotId || item.snapshotId === snapshotId))
  let noProgressStreak = 0
  for (const round of [...completed].reverse()) { if (round.noveltyScore <= epsilon) noProgressStreak++; else break }
  const recent = completed.slice(-window)
  const status: ExplorationHistory['saturation']['status'] = recent.length < window ? 'NOT_ENOUGH_ROUNDS'
    : recent.some((item) => item.noveltyScore > epsilon) ? 'PROGRESSING'
      : criticalOpen > 0 ? 'STALLED' : 'EMPIRICALLY_SATURATED'
  const explanation = status === 'EMPIRICALLY_SATURATED' ? `连续 ${window} 轮未发现新的空间或闭环增量；仅代表当前空间、策略与预算下的经验性饱和。`
    : status === 'STALLED' ? `连续 ${noProgressStreak} 轮无新增且仍有 ${criticalOpen} 个关键场景未闭环，应进入诊断增强而非继续重复。`
      : status === 'PROGRESSING' ? '最近探索仍产生新的 Scenario 或闭环证据。'
        : `仅完成 ${completed.length}/${window} 轮，尚不足以评价经验性饱和。`
  return { status, window, epsilon, completedRounds: completed.length, noProgressStreak, explanation }
}

function readExplorationHistory(path: string, criticalOpen: number, snapshotId?: string): ExplorationHistory {
  let rounds: ExplorationRound[] = []
  if (existsSync(path)) {
    try { rounds = (JSON.parse(readFileSync(path, 'utf-8')) as { rounds?: ExplorationRound[] }).rounds ?? [] } catch { rounds = [] }
  }
  return { version: 1, updatedAt: new Date().toISOString(), rounds, saturation: summarizeExploration(rounds, criticalOpen, snapshotId) }
}

export function buildVerificationIntelligence(workspaceDir: string): IntelligenceArtifacts {
  const workspace = resolve(workspaceDir)
  const outputDir = join(workspace, 'verification', 'intelligence')
  mkdirSync(outputDir, { recursive: true })
  const paths = { requirementModel: join(outputDir, 'requirement-model.json'), structuralModel: join(outputDir, 'structural-model.json'), riskRegister: join(outputDir, 'risk-register.json'), scenarioRegistry: join(outputDir, 'scenario-registry.json'), verificationState: join(outputDir, 'verification-state.json'), verificationPosture: join(outputDir, 'verification-posture.json'), report: join(outputDir, 'verification-intelligence-report.md'), interactionGraph: join(outputDir, 'feature-interaction-graph.json'), executionPlan: join(outputDir, 'scenario-execution-plan.json'), hypotheses: join(outputDir, 'verification-hypotheses.json'), specGaps: join(outputDir, 'spec-gap-register.json'), verificationIntents: join(outputDir, 'verification-intent-registry.json'), coverageHoles: join(outputDir, 'coverage-hole-register.json'), closureAssessment: join(outputDir, 'closure-assessment.json'), verificationSpace: join(outputDir, 'verification-space-snapshot.json'), explorationRound: join(outputDir, 'exploration-round.json'), explorationHistory: join(outputDir, 'exploration-history.json'), oracleRegistry: join(outputDir, 'oracle-registry.json'), oracleEvaluation: join(outputDir, 'oracle-evaluation.json'), mutationAssessment: join(outputDir, 'mutation-assessment.json'), residualRiskRegister: join(outputDir, 'residual-risk-register.json'), signoffPackage: join(outputDir, 'signoff-package.json'), signoffReport: join(outputDir, 'verification-signoff-package.md'), moduleVerificationStrategy: join(outputDir, 'module-verification-strategy.json') }
  const requirements = requirementModel(workspace)
  const structure = structuralModel(workspace)
  const risks = deriveRisks(workspace, structure)
  const moduleVerificationStrategy = buildModuleVerificationStrategy(workspace, structure, risks)
  const fullScenarioModules = new Set(moduleVerificationStrategy.modules.filter((item) => item.level === 'UNIT_FOCUSED' || item.level === 'IP_SIGNOFF').map((item) => item.module))
  const scenarioRisks = risks.filter((risk) => fullScenarioModules.has(risk.object) || [...fullScenarioModules].some((module) => risk.object.startsWith(`${module}.`)))
  const scenarios = buildScenarios(requirements, structure, scenarioRisks, readPrevious(paths.scenarioRegistry), workspace)
  const regressions = collectResults(workspace)
  const formalResults = collectFormalResults(workspace)
  const mutationAssessment = collectMutationAssessment(workspace, structure.rtlHash)
  const interactionGraph = buildInteractionGraph(requirements, structure, scenarios)
  const executionPlan = buildExecutionPlan(scenarios, regressions)
  const verificationSpace = buildVerificationSpace(requirements, structure, scenarios)
  const explorationRound = buildExplorationRound(verificationSpace, scenarios, executionPlan)
  const hypotheses = readHypotheses(paths.hypotheses)
  const specGaps = deriveSpecGaps(requirements, structure, risks)
  const verificationIntents = buildVerificationIntents(structure, scenarios)
  const coverageHoles = classifyCoverageHoles(scenarios, regressions)
  const multiOracle = buildMultiOracle(workspace, structure.rtlHash, scenarios, formalResults)
  const residualRiskRegister = buildResidualRisks(workspace, scenarios, formalResults, mutationAssessment, verificationSpace)
  const currentCriticalOpen = scenarios.filter((item) => item.criticality >= 0.8 && !['VERIFIED', 'EXCLUDED', 'WAIVED'].includes(item.state.closure)).length
  const explorationHistory = readExplorationHistory(paths.explorationHistory, currentCriticalOpen, verificationSpace.snapshotId)
  const closureAssessment = assessClosure(scenarios, regressions, formalResults, coverageHoles, multiOracle, explorationHistory, mutationAssessment, residualRiskRegister)
  const signoffPackage = buildSignoffPackage(structure.rtlHash, verificationSpace, closureAssessment, residualRiskRegister, scenarios, regressions, formalResults, mutationAssessment)
  const statusCounts: VerificationStateModel['statusCounts'] = {}
  for (const scenario of scenarios) statusCounts[scenario.status] = (statusCounts[scenario.status] ?? 0) + 1
  const criticalOpen = scenarios.filter((item) => item.criticality >= 0.8 && !['VERIFIED', 'EXCLUDED', 'WAIVED'].includes(item.state.closure)).map((item) => item.id)
  const structuralSummary = { fsm: structure.stateMachines.length, cfgNodes: structure.controlFlow.nodes.length, dependencies: structure.temporalDependencies.length, cones: structure.conesOfInfluence.length, protocols: structure.protocols.map((item) => ({ protocol: item.protocol, module: item.module })) }
  const verificationState: VerificationStateModel = { version: 5, generatedAt: new Date().toISOString(), rtlHash: structure.rtlHash, scenarioCount: scenarios.length, statusCounts, criticalOpen, scenarios, regressions, analyzer: structure.analyzer, interactionGraph, executionPlan, hypotheses, formalResults, specGaps, verificationIntents, coverageHoles, closureAssessment, verificationSpace, explorationRound, explorationHistory, multiOracle, mutationAssessment, residualRiskRegister, signoffPackage, moduleVerificationStrategy, structuralSummary }
  writeJsonAtomic(paths.requirementModel, requirements)
  writeJsonAtomic(paths.structuralModel, structure)
  writeJsonAtomic(paths.riskRegister, { version: 1, generatedAt: new Date().toISOString(), risks })
  writeJsonAtomic(paths.scenarioRegistry, { version: 2, generatedAt: new Date().toISOString(), rtlHash: structure.rtlHash, scenarios })
  writeJsonAtomic(paths.verificationState, verificationState)
  // The dashboard consumes a compact immutable snapshot instead of the multi-megabyte
  // analysis model. This keeps UI reads stable while a new full model is being published.
  writeJsonAtomic(paths.verificationPosture, {
    version: 1,
    generatedAt: verificationState.generatedAt,
    rtlHash: verificationState.rtlHash,
    scenarioCount: verificationState.scenarioCount,
    criticalOpen: verificationState.criticalOpen,
    verificationIntents: verificationIntents.map((intent) => ({
      id: intent.id,
      scenarioId: intent.scenarioId,
      objective: intent.objective,
      rationale: intent.rationale,
      failureMode: intent.failureMode,
      sourceIds: intent.sourceIds,
      status: intent.status,
      priority: intent.priority,
      recommendedMethods: intent.recommendedMethods,
      preconditions: intent.preconditions,
      stimulusProcedure: intent.stimulusProcedure,
      observationPoints: intent.observationPoints,
      expectedResults: intent.expectedResults,
      passCriteria: intent.passCriteria,
      boundaries: intent.boundaries.map((boundary) => ({ object: boundary.object, values: boundary.values })),
      evidence: intent.evidence
    })),
    specGaps,
    coverageHoles,
    regressions,
    formalResults,
    closureAssessment,
    verificationSpace,
    explorationRound,
    explorationHistory,
    multiOracle: { version: multiOracle.version, generatedAt: multiOracle.generatedAt, rtlHash: multiOracle.rtlHash, assessments: multiOracle.assessments, criticalInsufficient: multiOracle.criticalInsufficient, conflicts: multiOracle.conflicts },
    mutationAssessment: { status: mutationAssessment.status, threshold: mutationAssessment.threshold, weightedScore: mutationAssessment.weightedScore, validCount: mutationAssessment.validCount, killedCount: mutationAssessment.killedCount, blockingSurvivors: mutationAssessment.blockingSurvivors, invalidOrStale: mutationAssessment.invalidOrStale },
    residualRiskRegister,
    signoffPackage,
    moduleVerificationStrategy,
    structuralSummary,
    analyzer: structure.analyzer
  })
  writeJsonAtomic(paths.interactionGraph, interactionGraph)
  writeJsonAtomic(paths.executionPlan, { version: 1, generatedAt: new Date().toISOString(), plans: executionPlan })
  writeJsonAtomic(paths.specGaps, { version: 1, generatedAt: new Date().toISOString(), gaps: specGaps })
  writeJsonAtomic(paths.verificationIntents, { version: 1, generatedAt: new Date().toISOString(), intents: verificationIntents })
  writeJsonAtomic(paths.coverageHoles, { version: 1, generatedAt: new Date().toISOString(), holes: coverageHoles })
  writeJsonAtomic(paths.closureAssessment, closureAssessment)
  writeJsonAtomic(paths.verificationSpace, verificationSpace)
  writeJsonAtomic(paths.explorationRound, explorationRound)
  writeJsonAtomic(paths.explorationHistory, explorationHistory)
  writeJsonAtomic(paths.oracleRegistry, { version: 1, generatedAt: multiOracle.generatedAt, definitions: multiOracle.definitions })
  writeJsonAtomic(paths.oracleEvaluation, multiOracle)
  writeJsonAtomic(paths.mutationAssessment, mutationAssessment)
  writeJsonAtomic(paths.residualRiskRegister, { version: 1, generatedAt: new Date().toISOString(), risks: residualRiskRegister })
  writeJsonAtomic(paths.signoffPackage, signoffPackage)
  writeJsonAtomic(paths.moduleVerificationStrategy, moduleVerificationStrategy)
  writeSignoffReport(paths.signoffReport, signoffPackage, mutationAssessment, multiOracle, explorationHistory)
  if (!existsSync(paths.hypotheses)) writeJsonAtomic(paths.hypotheses, { version: 1, hypotheses: [] })
  writeReport(paths.report, verificationState, risks)
  writeVerificationDocSnapshot(workspace, verificationState)
  return { requirementModel: requirements, structuralModel: structure, risks, verificationState, paths }
}

export function recordExplorationRound(workspaceDir: string, selectedScenarioIds: string[]): ExplorationHistory {
  const workspace = resolve(workspaceDir)
  const statePath = join(workspace, 'verification', 'intelligence', 'verification-state.json')
  if (!existsSync(statePath)) buildVerificationIntelligence(workspace)
  const state = JSON.parse(readFileSync(statePath, 'utf-8')) as VerificationStateModel
  const historyPath = join(workspace, 'verification', 'intelligence', 'exploration-history.json')
  const history = readExplorationHistory(historyPath, state.criticalOpen.length, state.verificationSpace.snapshotId)
  const currentClosed = new Set(state.scenarios.filter((item) => item.state.closure !== 'OPEN').map((item) => item.id))
  const last = history.rounds.at(-1)
  if (last?.result === 'PENDING') {
    last.completedAt = new Date().toISOString()
    last.newlyClosedScenarioIds = last.selectedScenarioIds.filter((id) => currentClosed.has(id) && !last.baselineClosedScenarioIds.includes(id))
    const spaceChanged = last.snapshotId !== state.verificationSpace.snapshotId
    last.noveltyScore = last.newlyClosedScenarioIds.length * 5 + (spaceChanged ? 10 : 0)
    last.result = last.noveltyScore > 0 ? 'PROGRESS' : 'NO_PROGRESS'
  }
  const plansById = new Map(state.executionPlan.map((item) => [item.scenarioId, item]))
  const selected = selectedScenarioIds.filter((id, index, all) => all.indexOf(id) === index)
  const sequence = history.rounds.length + 1
  history.rounds.push({
    version: 1,
    roundId: `ROUND-${String(sequence).padStart(4, '0')}-${createHash('sha1').update(`${Date.now()}\0${selected.join(',')}`).digest('hex').slice(0, 8).toUpperCase()}`,
    snapshotId: state.verificationSpace.snapshotId,
    generatedAt: new Date().toISOString(),
    selectedScenarioIds: selected,
    expectedCostSeconds: selected.reduce((sum, id) => sum + (plansById.get(id)?.budgetSeconds ?? 0), 0),
    candidateCount: state.executionPlan.length,
    uncoveredCritical: state.criticalOpen.length,
    rationale: selected.map((id) => `${id}: ${plansById.get(id)?.reason ?? '独立攻击探索或无候选确认轮次'}`),
    baselineClosedScenarioIds: [...currentClosed],
    newlyClosedScenarioIds: [], noveltyScore: 0, result: 'PENDING'
  })
  history.rounds = history.rounds.slice(-50)
  history.updatedAt = new Date().toISOString()
  history.saturation = summarizeExploration(history.rounds, state.criticalOpen.length, state.verificationSpace.snapshotId)
  writeJsonAtomic(historyPath, history)
  return history
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
    if (state.closureAssessment) return { passed: state.closureAssessment.status !== 'NOT_READY', blockers: state.closureAssessment.blockers, warnings: [...state.closureAssessment.warnings, ...state.closureAssessment.residualRisks], state }
    const blockers: string[] = []
    const warnings: string[] = []
    if (state.criticalOpen.length > 0) blockers.push(`${state.criticalOpen.length} 个关键 Scenario 尚未闭环：${state.criticalOpen.slice(0, 8).join(', ')}`)
    if (state.scenarioCount === 0) warnings.push('未识别到 Scenario；简单设计允许人工确认，但需说明结构分析范围')
    if (state.regressions.length === 0) blockers.push('Verification State 中没有回归证据')
    if (state.regressions.some((item) => !item.passed)) blockers.push('Verification State 包含失败回归')
    if (state.formalResults?.some((item) => item.status === 'FAIL')) blockers.push('Verification State 包含 Formal 反例/属性失败')
    if (state.formalResults?.some((item) => item.obligation === 'required' && ['ERROR', 'UNKNOWN'].includes(item.status))) blockers.push('Verification State 包含强制 Formal 执行错误或未知结果')
    const supplementalErrors = state.formalResults?.filter((item) => item.obligation === 'supplemental' && ['ERROR', 'UNKNOWN'].includes(item.status)).length ?? 0
    if (supplementalErrors) warnings.push(`${supplementalErrors} 项补强 Formal 未产生结论；需记录 C6/限制，但不单独阻断已有充分仿真证据的 Intent`)
    return { passed: blockers.length === 0, blockers, warnings, state }
  } catch { return { passed: false, blockers: ['verification-state.json 无法解析'], warnings: [] } }
}
