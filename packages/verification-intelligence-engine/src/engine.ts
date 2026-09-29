import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type {
  Confidence,
  ClosureAssessment,
  ConfigSpaceFile,
  ConfigCoverageSummary,
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
  RootCauseRecord,
  ScenarioStatus,
  ScenarioState,
  ScenarioCoordinates,
  StructuralFact,
  StructuralModel,
  UtEscalationRecord,
  VerificationScenario,
  VerificationSpaceSnapshot,
  VerificationStateModel,
  FeatureInteractionGraph,
  ScenarioExecutionPlan,
  VerificationHypothesis,
  SpecGap,
  BoundaryCondition,
  VerificationIntent,
  CoverageHole,
  AgentIntentInput,
  VerificationWave,
  WaveProgressItem,
  SpecClauseMapping,
  SpecClauseStatus,
  SpecClauseChannel,
  SpecMappingMatrix,
  ScenarioCluster,
  ReclusterSuggestion
} from './types.ts'
import { analyzeStructure } from './structural-analyzer.ts'

interface RiskRule {
  taxonomyId: string
  title: string
  features: string[]
  patterns: RegExp[]
  /** 结构事实判定（替代文本正则）：返回 true 即命中。与 patterns 二选一（BUG-AIGV-001 D1/R2）。 */
  structural?: (structure: StructuralModel, moduleName: string) => boolean
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
  // R10 不再做文本匹配（BUG-AIGV-001 D1：原文正则对全文含注释匹配，单时钟设计的注释/标识符中
  // 出现两次 sync 即误报）；改为结构事实：该模块 always 敏感表中出现 ≥2 个不同时钟才判定跨时钟域。
  // clockResetDomains 由 structural-analyzer 提取，复位信号已按 rst|reset 名称模式排除，不会误入时钟集合。
  { taxonomyId: 'R10', title: 'CDC Interaction', features: ['cdc'], patterns: [], structural: (structure, moduleName) => new Set(structure.clockResetDomains.filter((domain) => domain.module === moduleName).map((domain) => domain.clock)).size >= 2, trigger: ['源时钟域数据变化', '目标时钟域采样'], expected: ['同步策略明确且无脉冲丢失/重复'], method: 'static', temporalDepth: 1, concurrency: 0.8 },
  { taxonomyId: 'R11', title: 'Timeout/Late Response', features: ['timeout', 'response'], patterns: [/time(?:out|r)/i, /(?:bvalid|rvalid|response|resp)/i], trigger: ['timeout 已发生', '迟到响应随后到达'], expected: ['迟到响应不会重复完成或破坏计数'], method: 'simulation', temporalDepth: 1, concurrency: 0.9 },
  { taxonomyId: 'R12', title: 'Backpressure', features: ['backpressure'], patterns: [/\bvalid\w*\b/i, /\bready\w*\b/i], trigger: ['valid 保持', 'ready 长期拉低'], expected: ['数据与控制保持稳定且无丢失'], method: 'simulation', temporalDepth: 0.8, concurrency: 0.6 },
  { taxonomyId: 'R13', title: 'Resource Exhaustion', features: ['fifo', 'outstanding'], patterns: [/(?:fifo|full|outstanding|credit)/i, /(?:max|depth|limit|>=|==)/i], trigger: ['资源达到容量上限', '继续到达请求'], expected: ['正确 backpressure，无覆盖或计数错误'], method: 'simulation', temporalDepth: 0.7, concurrency: 0.9 },
  { taxonomyId: 'R15', title: 'Recovery Path', features: ['error', 'reset'], patterns: [/(?:err|error|fault)/i, /(?:recover|retry|clear|reset|idle)/i], trigger: ['进入错误状态', '执行恢复', '恢复后重新发起事务'], expected: ['恢复后状态和接口可继续工作'], method: 'simulation', temporalDepth: 1, concurrency: 0.5 },
  { taxonomyId: 'R16', title: 'Configuration Change During Busy', features: ['configuration', 'busy'], patterns: [/(?:cfg|config|control|ctrl)_\w+/i, /\bbusy\b/i], trigger: ['模块 busy', '配置发生变化'], expected: ['配置更新策略符合规格且不破坏在途事务'], method: 'simulation', temporalDepth: 0.8, concurrency: 0.7 },
  { taxonomyId: 'R19', title: 'Interrupt Mask/Pending/Clear Collision', features: ['interrupt'], patterns: [/(?:irq|interrupt|intr_)\w*/i, /(?:mask|pending|clear|status)/i], trigger: ['中断置位', 'mask/clear 同周期变化'], expected: ['pending、mask 和外部中断输出一致'], method: 'formal-candidate', temporalDepth: 0.6, concurrency: 0.9 }
]

// ==================== v0.8.6 波段化 + 规格映射完备性 + 聚类批次（契约 交流_20260901.txt §二 Q1-Q4） ====================

/** 波段执行顺序：basic → corner → signoff（W0 冒烟波段已废弃：声明/存量 smoke 一律归一为 basic）。 */
const WAVE_ORDER: VerificationWave[] = ['basic', 'corner', 'signoff']

/** R01~R19 taxonomyId → 预定义 W2 主题名（契约 Q3 确定性底座；LLM 可补分类法未覆盖主题）。 */
const TAXONOMY_TOPICS: Record<string, string> = {
  R01: '并发碰撞', R02: '优先级仲裁', R04: '在途事务一致性', R05: '计数器边界', R07: '错误注入',
  R08: '复位碰撞', R09: '软硬件并发', R10: '跨时钟域', R11: '超时处理', R12: '反压',
  R13: '资源耗尽', R15: '错误恢复', R16: '忙时配置变更', R19: '中断并发'
}

/**
 * 引擎穷举候选（ENGINE_CANDIDATE）的波段推导表（契约：由 taxonomyId 推导，默认 corner）：
 * formal-candidate 方法归 W3 签核（Formal 属签核波段），其余（含 static）默认 W2 增补批——
 * 风险开集场景属增补批选材，W1 基础功能只由锚定规格条款的 AGENT_INTENT 承载。
 * 新增规则往表里加，不改逻辑。
 */
function deriveWaveForEngineCandidate(method: VerificationScenario['method']): VerificationWave {
  if (method === 'formal-candidate') return 'signoff'
  return 'corner'
}

/** 场景波段解析（旧数据兼容）：存量 wave='smoke' 归一为 basic（W0 冒烟已废弃，保持旧 registry 数据可读）；无 wave 字段时 AGENT_INTENT / CLAUSE_DERIVED 默认 basic，ENGINE_CANDIDATE 按方法推导。 */
function resolveWave(scenario: Pick<VerificationScenario, 'wave' | 'origin' | 'method'>): VerificationWave {
  if (scenario.wave) return scenario.wave === 'smoke' ? 'basic' : scenario.wave
  const origin = scenario.origin ?? 'ENGINE_CANDIDATE'
  return origin === 'AGENT_INTENT' || origin === 'CLAUSE_DERIVED' ? 'basic' : deriveWaveForEngineCandidate(scenario.method)
}

/** 主题名归一化（契约 Q3 补充：trim/大小写/空白归一，按归一键去重聚合，防"错误注入/错误处理"式裂波）。 */
function normalizeTopic(topic: string | undefined): string | undefined {
  const normalized = topic?.trim().toLowerCase().replace(/\s+/g, ' ')
  return normalized ? normalized : undefined
}

/** 由锚定风险推导预定义主题（取首个命中 taxonomyId 的主题名）。 */
function deriveTopicFromRisks(risks: Array<Pick<RiskMarker, 'taxonomyId'>>): string | undefined {
  for (const risk of risks) {
    const topic = TAXONOMY_TOPICS[risk.taxonomyId]
    if (topic) return topic
  }
  return undefined
}

function ruleMethodOf(taxonomyId: string): RiskRule['method'] | undefined {
  return RISK_RULES.find((rule) => rule.taxonomyId === taxonomyId)?.method
}

/**
 * 波段声明一致性校验规则表（契约 Q1：声明 + 引擎校验，防游离标签；可扩展）。
 * 命中即拒绝登记。W0 冒烟波段已废弃：登记入口把 smoke 声明归一为 basic 后再走本表
 * （冒烟验证由环境搭建与基础功能附带完成，不再单独成波），故本表只需约束 basic。
 */
const WAVE_ANCHOR_RULES: Array<{ waves: VerificationWave[]; matches: (taxonomyId: string) => boolean; reason: string }> = [
  { waves: ['basic'], matches: (taxonomyId) => ruleMethodOf(taxonomyId) === 'formal-candidate', reason: '锚定 formal-candidate 类风险（如 R02/R05/R19）不得声明 basic 波段' }
]

/**
 * 文档性规格条款分类器（契约：宁可漏判成 verifiable 也不可误判——只命中明确结构/流程类措辞才排除）。
 * 命中即 documentary，不进映射矩阵分母；理由写入条款记录。
 */
const DOCUMENTARY_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /文件头|版权|著作权|copyright|license|许可证/i, reason: '命中文件头/版权类措辞' },
  { pattern: /命名规范|命名规则|命名约定|naming\s*(?:convention|rule)/i, reason: '命中命名规范类措辞' },
  { pattern: /目录结构|目录组织|目录划分|交付物清单|交付物列表|deliverable/i, reason: '命中目录结构/交付物类措辞' },
  { pattern: /编码规范|代码风格|coding\s*style|格式要求|缩进|注释规范|注释风格/i, reason: '命中编码/注释风格类措辞' },
  { pattern: /评审流程|review\s*流程|变更记录|修订历史|修订记录|版本历史|版本记录|文档结构/i, reason: '命中流程/历史记录类措辞' },
  { pattern: /初稿|定稿|变更描述|阶段规格定义/i, reason: '命中版本历史表数据行措辞' }
]

/** 断言级条款拆分：单条 SPEC 文本中的断言分隔符（枚举/分号/句号/inline 编号）。 */
const CLAUSE_SEPARATORS = /；|;|。|(?:^|\s)(?:\d+[)．、]|（\d+）|\([a-z]\)|[a-z][)．])\s*/g
/** 过短的拆分碎片不构成独立可判定断言，并回相邻条款 */
const MIN_CLAUSE_LENGTH = 8

/** 聚类约束（契约 Q4）：authoring 组上限 8 场景，执行批 2-3 个（一次 run_simulation）。 */
const CLUSTER_AUTHORING_CAP = 8
const EXECUTION_BATCH_SIZE = 3

/** Coverage Hole 阻断阈值（priority ≥ 阈值才阻断签核；低于此值的 BLOCKED_BY_SPEC 为"低优先级规格缺口"）。 */
const COVERAGE_HOLE_BLOCKING_PRIORITY = 0.2

/** corner 登记软提醒阈值（契约回应 §三.方案 B）：specMapping 条款覆盖率低于此值时登记 corner 返回 warning（不拒绝）。 */
export const CORNER_COVERAGE_WARNING_THRESHOLD = 0.8

/** 方法 → 主 Oracle 判定域（聚类键"Oracle 域"的确定性推导）。 */
function oracleDomainOf(method: VerificationScenario['method']): string {
  return method === 'formal-candidate' ? 'formal-property' : method === 'static' ? 'architecture-invariant' : 'reference-model'
}

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

/**
 * 匹配前剥离 Verilog 注释与字符串字面量（以空格替换、保留换行，行号不变），
 * 防止注释/字符串中的关键字触发文本启发式规则（BUG-AIGV-001 D1/R1）。
 */
function stripVerilogText(text: string): string {
  const blank = (match: string): string => match.replace(/[^\r\n]/g, ' ')
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/"(?:\\.|[^"\\\r\n])*"/g, blank)
    .replace(/\/\/[^\r\n]*/g, blank)
}

/**
 * 把一条 SPEC 文本拆分为可观察断言级子条款（契约 §二.1：一条 SPEC 常含多个可判定断言）。
 * 拆分键为确定性分隔符（；;。与 inline 编号），过短碎片并回相邻条款；
 * 单条款保持原 id 不变（旧 anchors 兼容），多条款派生 `${id}#a`、`#b`。
 */
function splitClauses(id: string, text: string): Array<{ clauseId: string; parentId?: string; text: string }> {
  const parts = text.split(CLAUSE_SEPARATORS).map((part) => part.trim()).filter(Boolean)
  if (parts.length <= 1) return [{ clauseId: id, text }]
  const merged: string[] = []
  for (const part of parts) {
    if (part.length < MIN_CLAUSE_LENGTH && merged.length) merged[merged.length - 1] += `；${part}`
    else merged.push(part)
  }
  if (merged.length <= 1) return [{ clauseId: id, text }]
  // 拆分后的子条款首段仍可能带着原 id 前缀，剔除避免文本冗余
  const strip = (part: string): string => part.replace(new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:：|]?\\s*`), '').trim() || part
  return merged.map((part, index) => ({ clauseId: `${id}#${String.fromCharCode(97 + index)}`, parentId: id, text: strip(part).slice(0, 500) }))
}

/**
 * 验收通道分类规则（契约"PPA 条款混入 VERIF 完备性分母"§二，确定性规则）。
 * synthesis：条款文本含面积/时序/功耗/门数/频率等 PPA 措辞且带数值目标（数值是硬条件，
 * 无量值的定性表述不判 synthesis，防止误伤功能条款）。
 * static：CDC/跨时钟域/同步器/结构静态检查类措辞。
 * 宁漏勿冤：均不命中时归 simulation，由人工裁决纠偏。
 */
const SYNTHESIS_CLAUSE_KEYWORD = /面积|功耗|门数|时钟频率|工作频率|主频|频率|综合时序|\bWNS\b|\bTNS\b|时序(?:目标|要求|约束)|\barea\b|\bpower\b|gate\s*count|\bfrequency\b|\btiming\b/i
// 数值目标：数字+单位（容忍表格 `|` 分隔数值与单位两列）或 比较符+数字（≤ 2.0 / WNS ≥ 0）
const SYNTHESIS_NUMERIC_TARGET = /\d+(?:\.\d+)?\s*\|?\s*(?:%|mhz|ghz|khz|hz|ns|ps|ms|mw|uw|μw|w|um2|um²|μm2|μm²|mm2|mm²|gates?|门)|[≤≥<>≦≧]\s*\d+(?:\.\d+)?/i
const STATIC_CLAUSE_RULES: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bCDC\b|\bRDC\b|跨时钟域|clock[- ]domain crossing/i, reason: '命中 CDC/跨时钟域静态检查类措辞' },
  { pattern: /同步器|synchronizer/i, reason: '命中同步器结构检查类措辞' },
  { pattern: /结构检查|静态检查|可综合性检查/i, reason: '命中结构/静态检查类措辞' }
]

function classifyChannel(text: string): { channel: SpecClauseChannel; reason: string } {
  if (SYNTHESIS_CLAUSE_KEYWORD.test(text) && SYNTHESIS_NUMERIC_TARGET.test(text)) {
    return { channel: 'synthesis', reason: '命中 PPA 数值目标措辞（面积/时序/功耗/门数/频率）' }
  }
  for (const rule of STATIC_CLAUSE_RULES) {
    if (rule.pattern.test(text)) return { channel: 'static', reason: rule.reason }
  }
  return { channel: 'simulation', reason: '未命中 PPA/静态检查规则，按功能行为条款处理（宁漏勿冤）' }
}

/** TBD/待定条款识别（条款级与行级共用）：TBD 项不是可验证义务，不进入验证矩阵。 */
const TBD_PATTERN = /\b(?:TBD|TODO|待定|未定义|待确认)\b/i

/**
 * 缺陷 DEFECT-PACK-001#11：TBD 消解语义标记集合（按项目实践扩充）。
 * 行内出现这些标记说明该 TBD 项已有结论（如 "TBD-REQ-001 已关闭"、"TBD-IF-001/002 已关闭"），
 * 属于结论文本而非待定缺口——不计入 unknowns，也就不经 deriveSpecGaps 虚增 high 置信规格缺口。
 * 宁漏勿冤：仅命中明确消解措辞才豁免；真正的待定项（如"工艺/电压/角点 TBD"）不含这些标记。
 */
const TBD_RESOLUTION_PATTERN = /已关闭|已解决|已裁决|已确认|不适用|已定|\bRESOLVED\b|\bCLOSED\b|\bDEC-\w+/i

/** 条款分类（确定性规则，理由写入条款记录；documentary 宁可漏判成 verifiable 不可误判，channel 宁漏勿冤归 simulation）。 */
function classifyClause(text: string): { clauseKind: 'verifiable' | 'documentary'; channel?: SpecClauseChannel; classificationReason?: string } {
  for (const rule of DOCUMENTARY_RULES) {
    if (rule.pattern.test(text)) return { clauseKind: 'documentary', classificationReason: `${rule.reason}：${text.slice(0, 60)}` }
  }
  const { channel, reason } = classifyChannel(text)
  return { clauseKind: 'verifiable', channel, classificationReason: `验收通道=${channel}：${reason}` }
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
        const lineText = line.replace(/^\s*[-|#]+\s*/, '').trim().slice(0, 500)
        const priority = /\bP[012]\b/.exec(line)?.[0] as RequirementFact['priority']
        const source = { file: relative(workspace, file), line: index + 1 }
        for (const clause of splitClauses(id, lineText)) {
          // TBD 条款不进入验证矩阵（2026-09-08 契约）：待定项不是可验证义务，不生成
          // RequirementFact（该行仍经下方 unknowns 追踪，规格缺口可见）；文本固化为
          // 确定条款后，下次重建自动作为新条款进入 RTL 评审与验证矩阵。
          // 判定时剥掉条款 ID——ID 片段（如 SPEC-TBD-001 里的 TBD）不构成内容待定。
          if (TBD_PATTERN.test(clause.text.replace(/\b(?:REQ|SPEC)-[A-Z0-9_-]+\b/g, ''))) continue
          const classification = classifyClause(clause.text)
          requirements.push({ id: clause.clauseId, text: clause.text, features: featuresOf(clause.text), priority, kind: 'SPEC_FACT', clauseKind: classification.clauseKind, channel: classification.channel, parentId: clause.parentId, classificationReason: classification.classificationReason, source })
        }
      }
      const trimmed = line.trim()
      const isStructural = trimmed.startsWith('|') || trimmed.startsWith('#') || trimmed.startsWith('```')
      // 缺陷 DEFECT-PACK-001#11：与 TBD_PATTERN 同口径剥掉 REQ/SPEC ID 后，行内仍含消解语义
      // 标记（已关闭/RESOLVED/DEC-* 等）的是结论文本，不计入 unknowns/规格缺口
      const stripped = line.replace(/\b(?:REQ|SPEC)-[A-Z0-9_-]+\b/g, '')
      if (!isStructural && TBD_PATTERN.test(stripped) && !TBD_RESOLUTION_PATTERN.test(stripped)) unknowns.push({ id: `UNK-${unknowns.length + 1}`, text: line.trim().slice(0, 500), source: { file: relative(workspace, file), line: index + 1 } })
    }
  }
  return { version: 1, generatedAt: new Date().toISOString(), requirements, unknowns, sourceFiles: files.map((file) => relative(workspace, file)) }
}

// design.json 语义与 packages/eda-bridge/src/rtl-files.ts 的 readRtlInputs 对齐的精简内联实现。
// 注意：引擎源文件会被复制到 pi 侧运行，禁止跨包 import eda-bridge，也禁止新增外部依赖。
interface RtlAnalysisInputs {
  designFiles: string[]
  libraryFiles: string[]
  includeDirs: string[]
  defines: string[]
  topModule?: string
  inputSource: 'design.json' | 'walk'
}

// 与 eda-bridge 一致：只排除明确命名的互斥宏视图（behavioral/blackbox/phy_template）。
const MACRO_VIEW = /_(?:behavioral|blackbox|phy_template)\.v$/i

function resolveRtlEntry(workspace: string, rtlDir: string, entry: string): string {
  if (/^(?:[A-Za-z]:[\\/]|\/)/.test(entry)) return resolve(entry)
  return resolve(entry.replace(/\\/g, '/').startsWith('rtl/') ? workspace : rtlDir, entry)
}

function readRtlInputs(workspace: string): RtlAnalysisInputs {
  const rtlDir = join(workspace, 'rtl')
  // design.json 缺失/损坏或清单为空时回退现有 walk 行为（保持兼容）
  const fallback = (): RtlAnalysisInputs => ({ designFiles: walk(rtlDir, (file) => /\.(?:v|sv)$/i.test(file)), libraryFiles: [], includeDirs: [], defines: [], inputSource: 'walk' })
  const manifestPath = join(rtlDir, 'design.json')
  if (!existsSync(manifestPath)) return fallback()
  let data: Record<string, unknown>
  try { data = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown> } catch { return fallback() }
  const stringList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  let designEntries = stringList(data.files)
  if (designEntries.length === 0) {
    const filelistPath = resolveRtlEntry(workspace, rtlDir, typeof data.filelist === 'string' ? data.filelist : 'filelist.f')
    if (existsSync(filelistPath)) {
      designEntries = readFileSync(filelistPath, 'utf-8').split(/\r?\n/)
        .map((line) => line.replace(/\/\/.*$/, '').replace(/#.*$/, '').trim())
        .filter((line) => line.length > 0 && !/^[+-]/.test(line))
    }
  }
  if (designEntries.length === 0) return fallback()
  const unique = (items: string[]): string[] => [...new Set(items.map((item) => resolveRtlEntry(workspace, rtlDir, item)).filter((item) => existsSync(item)))]
  const topModule = typeof data.topModule === 'string' && data.topModule.trim() ? data.topModule.trim() : undefined
  // simulationFiles / physicalFiles / rtl/macros 不进入结构分析；libraryFiles 以 slang -v 库文件方式按需搜索
  return {
    designFiles: unique(designEntries.filter((entry) => !MACRO_VIEW.test(entry))),
    libraryFiles: unique(stringList(data.libraryFiles)),
    includeDirs: unique(stringList(data.includeDirs)),
    defines: stringList(data.defines),
    topModule,
    inputSource: 'design.json'
  }
}

/**
 * 全局 RTL 哈希的唯一计算口径（单一哈希空间）：design.json 语义的设计文件
 * （相对路径 + 内容）+ 库文件清单。scenario_hits 的证据登记（pi-bridge 侧经
 * 引擎源码引入同一实现）与引擎的新鲜度判定必须使用同一口径，禁止另起哈希。
 */
function rtlHashFromInputs(workspace: string, inputs: ReturnType<typeof readRtlInputs>): string {
  const hash = createHash('sha256')
  for (const file of inputs.designFiles) {
    const text = readFileSync(file, 'utf-8')
    hash.update(relative(workspace, file)).update('\0').update(text).update('\0')
  }
  // 库文件不参与结构抽取，但其清单变化同样影响 elaboration 结果，计入 rtlHash
  for (const file of inputs.libraryFiles) hash.update('lib:').update(relative(workspace, file)).update('\0')
  return hash.digest('hex')
}

/** 计算工作区当前 RTL 哈希（证据登记与新鲜度判定的统一口径）。 */
export function computeRtlHash(workspaceDir: string): string {
  const workspace = resolve(workspaceDir)
  return rtlHashFromInputs(workspace, readRtlInputs(workspace))
}

function structuralModel(workspace: string): StructuralModel {
  const inputs = readRtlInputs(workspace)
  return analyzeStructure({ workspace, files: inputs.designFiles, libraryFiles: inputs.libraryFiles, includeDirs: inputs.includeDirs, defines: inputs.defines, topModule: inputs.topModule, inputSource: inputs.inputSource, rtlHash: rtlHashFromInputs(workspace, inputs), featuresOf })
}

/**
 * 模块验证策略两态化（AIGV 修订 §3.1）：topSet→TOP_SIGNOFF（requiredChecks 沿用原 IP_SIGNOFF 完整清单）；
 * 其余模块→COVERED_BY_TOP（requiredChecks 收敛为静态检查：编译/elaboration、Lint、可综合性、端口/参数/未驱动检查）；
 * 已登记 active UT 例外的模块联查覆写为 UT_EXCEPTION（独立定向 Testbench 义务，同原 UNIT_FOCUSED 检查清单）。
 * 模块角色/风险评分/Oracle 策略推导保留（§2.3：结构模型与风险寄存器改用途为排优先级，不再用于分级建环境）。
 */
function buildModuleVerificationStrategy(workspace: string, structure: StructuralModel, risks: RiskMarker[], activeUtExceptionModules: ReadonlySet<string>): ModuleVerificationStrategy {
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
    const level: ModuleVerificationPlan['level'] = topSet.has(module) ? 'TOP_SIGNOFF' : activeUtExceptionModules.has(module) ? 'UT_EXCEPTION' : 'COVERED_BY_TOP'
    const goldenRecommended = modelFriendly && !/(?:sync|reset|rst)/i.test(semanticName)
    const goldenModel: ModuleVerificationPlan['goldenModel'] = goldenRecommended
      ? { recommendation: 'RECOMMENDED', rationale: '该模块具有可独立预测的数据变换、调度、容量或编码语义；参考模型有助于定位首个偏差并加速收敛。' }
      : level === 'TOP_SIGNOFF' || role === 'INTEGRATION'
        ? { recommendation: 'OPTIONAL', rationale: '根据端到端行为是否可低成本独立预测决定；不得为了形式完整而复制 RTL 实现。' }
        : { recommendation: 'NOT_NEEDED', rationale: '当前结构更适合使用静态检查、局部 Assertion 或协议规则判定；后续出现观察缺口时可升级。' }
    const oracleStrategies = new Set<ModuleOracleStrategy>()
    if (level === 'TOP_SIGNOFF') oracleStrategies.add('END_TO_END')
    if (protocols.length) oracleStrategies.add('PROTOCOL_CHECKER')
    if (fsms.length || writers.length || cdcReset) oracleStrategies.add('ASSERTION')
    if (goldenModel.recommendation === 'RECOMMENDED') oracleStrategies.add('REFERENCE_MODEL')
    if (level === 'UT_EXCEPTION' && (cdcReset || fsms.length > 0)) oracleStrategies.add('FORMAL')
    if (oracleStrategies.size === 0 && level !== 'COVERED_BY_TOP') oracleStrategies.add('ASSERTION')
    const reasons = [
      topSet.has(module) ? '项目顶层，承担对外功能与最终签核；全部 testcase 面向 TOP。' : activeUtExceptionModules.has(module) ? '已登记 active UT 例外（诊断驱动单独验证），例外 PASS 不替代 TOP 证据。' : '默认经 TOP 场景与全设计静态检查间接验证（TOP 优先，UT 例外）。',
      protocols.length ? `识别到 ${[...new Set(protocols.map((item) => item.protocol))].join('/')} 协议。` : '',
      fsms.length ? `包含 ${fsms.length} 个状态机。` : '',
      cdcReset ? '包含时钟/复位域敏感语义。' : '',
      integration ? `实例化多个子模块，承担集成职责。` : ''
    ].filter(Boolean)
    const requiredChecks = level === 'COVERED_BY_TOP'
      ? ['编译/elaboration', 'Lint', '可综合性', '端口/参数/未驱动检查']
      : level === 'UT_EXCEPTION'
        ? ['全部静态检查', '独立定向 Testbench', '模块风险 Scenario', '边界/异常/并发检查', 'Oracle 原始证据']
        : ['完整 AIGV Intent/Scenario', '端到端回归与覆盖率', 'Multi-Oracle', 'Mutation', 'Residual Risk 与 Sign-off Package']
    return { module, role, level, riskScore: Number(maxRisk.toFixed(3)), reasons, oracleStrategies: [...oracleStrategies], goldenModel, requiredChecks, standaloneTestbench: level === 'UT_EXCEPTION' }
  }).sort((a, b) => ['TOP_SIGNOFF', 'UT_EXCEPTION', 'COVERED_BY_TOP'].indexOf(a.level) - ['TOP_SIGNOFF', 'UT_EXCEPTION', 'COVERED_BY_TOP'].indexOf(b.level) || b.riskScore - a.riskScore)
  const summary: ModuleVerificationStrategy['summary'] = { TOP_SIGNOFF: 0, UT_EXCEPTION: 0, COVERED_BY_TOP: 0 }
  for (const plan of plans) summary[plan.level] += 1
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    rtlHash: structure.rtlHash,
    topModules,
    modules: plans,
    summary,
    policy: [
      'DUT 默认是整个设计（TOP）：只搭一套 TOP cocotb 环境，全部 testcase 面向 TOP，场景锚定 TOP 接口与规格条款。',
      '非顶层模块默认 COVERED_BY_TOP，经 TOP 场景与全设计覆盖率间接验证，requiredChecks 收敛为静态检查，不单独排队建环境。',
      '子模块 UT 仅为诊断驱动的例外：probe 子模块信号仍无法定位时经 register_ut_escalation 登记（ut-escalations.json），策略表显示 UT_EXCEPTION 并单独建 TB；例外 PASS 不替代 TOP 回归证据。',
      'Golden Model 由独立判定、故障定位和收敛收益决定，不与模块大小或验证等级机械绑定。',
      '结构模型与风险寄存器用于给 TOP 场景与配置点排优先级，不再用于分级建环境；模块级 Formal 提名维持现状。'
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
    // 文本启发式一律在剥离注释/字符串后的代码上做（BUG-AIGV-001 D1/R1）
    const code = stripVerilogText(text)
    const moduleName = /\bmodule\s+([A-Za-z_$][\w$]*)/.exec(code)?.[1] ?? basename(file)
    for (const rule of RISK_RULES) {
      // 带 structural 的规则（如 R10）按结构事实判定，否则按文本正则（BUG-AIGV-001 D1/R2）
      const hit = rule.structural ? rule.structural(structure, moduleName) : rule.patterns.every((pattern) => pattern.test(code))
      if (!hit) continue
      const features = [...new Set([...rule.features, ...featuresOf(code).filter((feature) => rule.features.includes(feature))])]
      const structuralComplexity = Math.min(1, 0.35 + (code.match(/\b(?:if|case|always|assign)\b/g)?.length ?? 0) / 120)
      const interaction = Math.min(1, 0.35 + features.length * 0.14)
      const riskScore = Number((0.3 * structuralComplexity + 0.3 * interaction + 0.2 * rule.temporalDepth + 0.2 * rule.concurrency).toFixed(3))
      const line = rule.structural
        ? Math.min(...structure.clockResetDomains.filter((domain) => domain.module === moduleName).map((domain) => domain.source.line ?? 1))
        : Math.min(...rule.patterns.map((pattern) => sourceLine(code, pattern)))
      risks.push({ id: `RISK-${String(risks.length + 1).padStart(4, '0')}`, taxonomyId: rule.taxonomyId, title: rule.title, ...riskSemantics(rule, moduleName, features), object: moduleName, features, structuralComplexity, interaction, temporalDepth: rule.temporalDepth, concurrency: rule.concurrency, riskScore, confidence: 'medium', facts: structure.facts.filter((fact) => fact.module === moduleName).map((fact) => fact.id), source: { file, line } })
    }
  }
  const nwaySeen = new Set<string>()
  const conesOfInfluence = structure.conesOfInfluence.filter((item) => item.directSources.length >= 3).sort((a, b) => b.directSources.length - a.directSources.length)
  for (const cone of conesOfInfluence) {
    const [module, ...sinkParts] = cone.sink.split('.'); const sink = sinkParts.join('.')
    if (nwaySeen.has(module)) continue
    const dependency = structure.temporalDependencies.find((item) => item.module === module && item.to === sink)
    if (!dependency) continue
    nwaySeen.add(module)
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

function readIntents(path: string): VerificationIntent[] {
  if (!existsSync(path)) return []
  try { return (JSON.parse(readFileSync(path, 'utf-8')) as { intents?: VerificationIntent[] }).intents ?? [] } catch { return [] }
}

/** root-causes.json 相对工作区路径（证据区，不进 intelligence/ 引擎产物区） */
const ROOT_CAUSES_RELATIVE_PATH = join('verification', 'results', 'root-causes.json')
/** execution-summary.json 硬指标：≤10KB，超限截断 top 列表（契约 §2.3） */
const EXECUTION_SUMMARY_MAX_BYTES = 10 * 1024

function readRootCauses(workspace: string): RootCauseRecord[] {
  const path = join(workspace, ROOT_CAUSES_RELATIVE_PATH)
  if (!existsSync(path)) return []
  try { return (JSON.parse(readFileSync(path, 'utf-8')) as { records?: RootCauseRecord[] }).records ?? [] } catch { return [] }
}

/**
 * 引擎 rebuild 时把 confirmed 根因挂到对应 scenario.evidence（root-causes.json 路径 +
 * 记录内证据路径），使签核评审可回答"这个场景出过什么、怎么修的"；挂载后按机器规则
 * 重算 scenario.state（evidence 轴），不手写状态。
 */
function attachConfirmedRootCauses(scenarios: VerificationScenario[], rootCauses: RootCauseRecord[]): void {
  const confirmed = new Map<string, RootCauseRecord[]>()
  for (const record of rootCauses) {
    if (record.verdict !== 'confirmed' || !record.scenarioId) continue
    const list = confirmed.get(record.scenarioId) ?? []
    list.push(record)
    confirmed.set(record.scenarioId, list)
  }
  if (confirmed.size === 0) return
  for (const scenario of scenarios) {
    const records = confirmed.get(scenario.id)
    if (!records?.length) continue
    scenario.evidence = [...new Set([...scenario.evidence, ROOT_CAUSES_RELATIVE_PATH, ...records.flatMap((record) => record.evidence)])]
    scenario.state = scenarioState(scenario.status, scenario.evidence, scenario.reachCount, scenario.assertionPassed, scenario.state.freshness)
  }
}

// ==================== AIGV 修订批 1：TOP 优先，UT 例外（§3 UT 例外登记 + §8 迁移） ====================

/** ut-escalations.json 相对工作区路径（证据区，不进 intelligence/ 引擎产物区）。 */
const UT_ESCALATIONS_RELATIVE_PATH = join('verification', 'results', 'ut-escalations.json')
/** 例外理由硬约束（§3.2：≤200 字）。 */
export const UT_ESCALATION_REASON_MAX_LENGTH = 200
/** 历史环境自动登记的固定理由（§8 迁移）。 */
const UT_ESCALATION_MIGRATION_REASON = '历史环境自动登记'

function readUtEscalations(workspace: string): UtEscalationRecord[] {
  const path = join(workspace, UT_ESCALATIONS_RELATIVE_PATH)
  if (!existsSync(path)) return []
  try { return (JSON.parse(readFileSync(path, 'utf-8')) as { escalations?: UtEscalationRecord[] }).escalations ?? [] } catch { return [] }
}

function writeUtEscalations(workspace: string, escalations: UtEscalationRecord[]): void {
  const path = join(workspace, UT_ESCALATIONS_RELATIVE_PATH)
  mkdirSync(dirname(path), { recursive: true })
  writeJsonAtomic(path, { version: 1, escalations })
}

/** registerUtEscalation 的输入（缺 id/createdAt/status/retiredReason，由引擎派生）。 */
export interface UtEscalationInput {
  module: string
  reason: string
  /** 可空：允许预防性 UT（§11 决策 1），此时 reason 须写明预防性理由 */
  failureSignature: string | null
  /** 可空：关联 root-causes.json 记录（RC-*） */
  rootCauseId: string | null
  /** 触发升级的 TOP 场景（SCN-*）；预防性 UT 可为空数组 */
  topScenarioIds: string[]
}

export interface UtEscalationResult {
  record: UtEscalationRecord
  /** 同模块同 reason 命中已有记录时为 true（幂等复用 id，不产生新记录） */
  reused: boolean
}

/**
 * 登记 UT 例外（§3.2，诊断驱动）：模块名必须在结构模型存在、topScenarioIds 必须存在于
 * scenario-registry、rootCauseId 非空时必须在 root-causes.json 存在（幻觉引用一律拒绝）。
 * id = UTX-<sha1(module+reason) 前8位大写>：同模块同 reason 幂等复用；命中 retired 记录时
 * 重新激活（保留稳定 id，刷新登记字段）。写后由工具层触发 rebuild（参照 recordRootCause 模式）。
 */
export function registerUtEscalation(workspaceDir: string, input: UtEscalationInput): UtEscalationResult {
  const workspace = resolve(workspaceDir)
  if (!input.module?.trim()) throw new Error('module 不能为空')
  if (!input.reason?.trim()) throw new Error('reason 不能为空：必须说明为什么 TOP 激励/观测不足以定位（或预防性理由）')
  if (input.reason.length > UT_ESCALATION_REASON_MAX_LENGTH) throw new Error(`reason 超过 ${UT_ESCALATION_REASON_MAX_LENGTH} 字（当前 ${input.reason.length}）`)
  // 锚点校验需要最新的结构模型与 scenario-registry：先全量重建（同 registerVerificationIntents 模式）
  const artifacts = buildVerificationIntelligence(workspace)
  const structuralModules = new Set<string>()
  for (const file of artifacts.structuralModel.sourceFiles) {
    const text = readFileSync(resolve(workspace, file), 'utf-8')
    for (const match of text.matchAll(/\bmodule\s+([A-Za-z_$][\w$]*)/g)) structuralModules.add(match[1])
  }
  structuralModules.delete('$design')
  if (!structuralModules.has(input.module)) throw new Error(`module 在结构模型中不存在（疑似幻觉模块名，必须核对 structural-model.json）：${input.module}`)
  const scenarioIds = new Set(artifacts.verificationState.scenarios.map((item) => item.id))
  const missingScenarios = input.topScenarioIds.filter((id) => !scenarioIds.has(id))
  if (missingScenarios.length) throw new Error(`topScenarioIds 不存在于 scenario-registry（幻觉引用拒绝）：${missingScenarios.join('、')}`)
  const rootCauseIds = new Set(readRootCauses(workspace).map((item) => item.id))
  if (input.rootCauseId && !rootCauseIds.has(input.rootCauseId)) throw new Error(`rootCauseId 不存在于 root-causes.json：${input.rootCauseId}`)
  const id = `UTX-${createHash('sha1').update(`${input.module}${input.reason}`).digest('hex').slice(0, 8).toUpperCase()}`
  const existing = readUtEscalations(workspace)
  const index = existing.findIndex((item) => item.id === id)
  if (index >= 0 && existing[index].status === 'active') return { record: existing[index], reused: true }
  const record: UtEscalationRecord = {
    id,
    module: input.module.trim(),
    reason: input.reason.trim(),
    failureSignature: input.failureSignature?.trim() ? input.failureSignature.trim() : null,
    rootCauseId: input.rootCauseId?.trim() ? input.rootCauseId.trim() : null,
    topScenarioIds: [...new Set(input.topScenarioIds)],
    createdAt: new Date().toISOString(),
    status: 'active',
    retiredReason: null
  }
  if (index >= 0) existing.splice(index, 1, record)
  else existing.push(record)
  writeUtEscalations(workspace, existing)
  return { record, reused: false }
}

/**
 * 退役 UT 例外（§2.2：根因修复且 TOP 回归覆盖后登记 retired 并保留历史）。
 * 幂等：已是 retired 的返回原记录；id 不存在抛错。
 */
export function retireUtEscalation(workspaceDir: string, id: string, reason: string): UtEscalationRecord {
  const workspace = resolve(workspaceDir)
  if (!reason?.trim()) throw new Error('retiredReason 不能为空：必须说明退役依据（如根因修复且 TOP 回归已覆盖）')
  const existing = readUtEscalations(workspace)
  const record = existing.find((item) => item.id === id)
  if (!record) throw new Error(`UT 例外不存在：${id}`)
  if (record.status === 'retired') return record
  record.status = 'retired'
  record.retiredReason = reason.trim()
  writeUtEscalations(workspace, existing)
  return record
}

/**
 * 历史迁移（§8）：rebuild 时扫描 verification/，发现 `<module>_tb` 环境（module ∉ topSet）且
 * 该模块在任一 scenario_hits.json 有登记 → 自动登记为 active UT 例外（reason=历史环境自动登记，
 * failureSignature=null）。幂等：该模块已有 active/retired 记录不重复登记。返回是否有新增。
 */
function migrateLegacyTestbenches(workspace: string, structure: StructuralModel, topModules: string[], escalations: UtEscalationRecord[]): boolean {
  const verificationDir = join(workspace, 'verification')
  if (!existsSync(verificationDir)) return false
  const structuralModules = new Set<string>()
  for (const file of structure.sourceFiles) {
    const text = readFileSync(resolve(workspace, file), 'utf-8')
    for (const match of text.matchAll(/\bmodule\s+([A-Za-z_$][\w$]*)/g)) structuralModules.add(match[1])
  }
  structuralModules.delete('$design')
  const topSet = new Set(topModules)
  // 既有登记（active/retired 任一）的模块不重复登记
  const registeredModules = new Set(escalations.map((item) => item.module))
  // 模块在任一 scenario_hits.json 的登记口径：hits 文件位于 results/<module>/ 下，
  // 或登记的 scenario 在 scenario-registry 中锚定该模块（rtlObjects 首段）
  const hitsRegisteredModules = new Set<string>()
  const previousRegistry = readPrevious(join(workspace, 'verification', 'intelligence', 'scenario-registry.json'))
  const scenarioModule = new Map(previousRegistry.map((item) => [item.id, item.rtlObjects[0]?.split('.')[0] ?? '']))
  for (const file of walk(join(workspace, 'verification', 'results'), (path) => basename(path) === 'scenario_hits.json')) {
    const relativeSegments = relative(join(workspace, 'verification', 'results'), dirname(file)).split(sep)
    if (relativeSegments.length > 0 && structuralModules.has(relativeSegments[0])) hitsRegisteredModules.add(relativeSegments[0])
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as { scenarios?: Array<{ id?: string }> }
      for (const item of data.scenarios ?? []) {
        const module = item.id ? scenarioModule.get(item.id) : undefined
        if (module && structuralModules.has(module)) hitsRegisteredModules.add(module)
      }
    } catch { /* 无效 hits 文件按无登记处理 */ }
  }
  let changed = false
  for (const entry of readdirSync(verificationDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const match = /^(.+)_tb$/.exec(entry.name)
    if (!match) continue
    const module = match[1]
    if (!structuralModules.has(module) || topSet.has(module)) continue
    if (registeredModules.has(module) || !hitsRegisteredModules.has(module)) continue
    escalations.push({
      id: `UTX-${createHash('sha1').update(`${module}${UT_ESCALATION_MIGRATION_REASON}`).digest('hex').slice(0, 8).toUpperCase()}`,
      module,
      reason: UT_ESCALATION_MIGRATION_REASON,
      failureSignature: null,
      rootCauseId: null,
      topScenarioIds: [],
      createdAt: new Date().toISOString(),
      status: 'active',
      retiredReason: null
    })
    registeredModules.add(module)
    changed = true
  }
  if (changed) writeUtEscalations(workspace, escalations)
  return changed
}

/** active UT 例外模块集合（策略两态联查与场景锚点共用口径）。 */
function activeUtExceptionModules(escalations: UtEscalationRecord[]): Set<string> {
  return new Set(escalations.filter((item) => item.status === 'active').map((item) => item.module))
}

// ==================== AIGV 修订批 1：配置空间模型（§4 config-space.json + 四类配置点） ====================

/** config-space.json 相对工作区路径（引擎产物区，Agent 禁手改）。 */
const CONFIG_SPACE_RELATIVE_PATH = join('verification', 'intelligence', 'config-space.json')
/** 配置字段描述硬约束（§4.2：≤120 字）。 */
export const CONFIG_FIELD_DESCRIPTION_MAX_LENGTH = 120

/** registerConfigSpace 的输入（ConfigSpaceFile 内容，缺 version/generatedAt，由引擎派生）。 */
export type ConfigSpaceInput = Omit<ConfigSpaceFile, 'version' | 'generatedAt'>

function readConfigSpace(workspace: string): ConfigSpaceFile | undefined {
  const path = join(workspace, CONFIG_SPACE_RELATIVE_PATH)
  if (!existsSync(path)) return undefined
  try { return JSON.parse(readFileSync(path, 'utf-8')) as ConfigSpaceFile } catch { return undefined }
}

/**
 * 读取并归一化配置覆盖采集文件（§4.5 消费链路：cocotb 环境回传
 * verification/results/<topModule>/config-coverage.json，rebuild 时挂到 posture.configCoverage）。
 * freshness 口径与覆盖率门禁一致：rtlHash 缺失或与当前 RTL 不一致即 stale。
 * 缺文件/损坏/schema 不符返回 null（posture 不带该字段，页面不渲染配置覆盖区块）。
 */
function readConfigCoverage(workspace: string, topModules: string[], currentRtlHash: string): ConfigCoverageSummary | null {
  for (const topModule of topModules) {
    const path = join(workspace, 'verification', 'results', topModule, 'config-coverage.json')
    if (!existsSync(path)) continue
    let raw: Record<string, unknown>
    try { raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown> } catch { return null }
    if (!Array.isArray(raw.coverpoints) || !Array.isArray(raw.crosses)) return null
    const toBuckets = (items: unknown, keyField: 'label' | 'key'): Array<{ label: string; hits: number }> => {
      if (!Array.isArray(items)) return []
      return items
        .filter((item): item is { label?: unknown; key?: unknown; hits?: unknown } => item !== null && typeof item === 'object')
        .map((item) => ({ label: typeof item[keyField] === 'string' ? item[keyField] : String(item.label ?? item.key ?? ''), hits: typeof item.hits === 'number' && Number.isFinite(item.hits) ? item.hits : 0 }))
    }
    const coverpoints = raw.coverpoints
      .filter((item): item is { id?: unknown; field?: unknown; buckets?: unknown } => item !== null && typeof item === 'object' && typeof (item as { field?: unknown }).field === 'string')
      .map((item) => {
        const buckets = toBuckets(item.buckets, 'label')
        const hitBuckets = buckets.filter((bucket) => bucket.hits > 0).length
        return { id: typeof item.id === 'string' ? item.id : String(item.field), field: String(item.field), buckets, hitBuckets, bucketCount: buckets.length, hitRate: buckets.length ? hitBuckets / buckets.length : 0, totalHits: buckets.reduce((sum, bucket) => sum + bucket.hits, 0) }
      })
    const crosses = raw.crosses
      .filter((item): item is { id?: unknown; fields?: unknown; bins?: unknown } => item !== null && typeof item === 'object' && Array.isArray((item as { fields?: unknown }).fields))
      .map((item) => {
        const bins = toBuckets(item.bins, 'key').map((bin) => ({ key: bin.label, hits: bin.hits }))
        const hitBins = bins.filter((bin) => bin.hits > 0).length
        return { id: typeof item.id === 'string' ? item.id : `cross:${(item.fields as unknown[]).join('.')}`, fields: (item.fields as unknown[]).filter((field): field is string => typeof field === 'string'), bins, hitBins, binCount: bins.length, hitRate: bins.length ? hitBins / bins.length : 0, totalHits: bins.reduce((sum, bin) => sum + bin.hits, 0) }
      })
    return {
      generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
      rtlHash: typeof raw.rtlHash === 'string' ? raw.rtlHash : null,
      topModule: typeof raw.topModule === 'string' ? raw.topModule : topModule,
      stale: typeof raw.rtlHash !== 'string' || raw.rtlHash !== currentRtlHash,
      coverpoints,
      crosses
    }
  }
  return null
}

/**
 * 登记配置空间账本（§4.1：Agent 抽取 + 引擎校验，LLM 提供语义、引擎守门）：
 * - rtlModule 必须存在于结构模型；
 * - 字段名必须能在该模块 RTL 源码中检索到（宽松标识符匹配，幻觉引用拒绝）；
 * - 非法 domain 拒绝（range min>max、enum 空值表）；
 * - constraint 的 `<register>.<field>` 引用必须指向已声明的寄存器字段；
 * - clauseId 非空则必须存在于 requirement-model。
 * 校验通过则落盘 config-space.json；rebuild 由工具层负责（参照 recordRootCause 模式）。
 */
export function registerConfigSpace(workspaceDir: string, input: ConfigSpaceInput): ConfigSpaceFile {
  const workspace = resolve(workspaceDir)
  if (!Array.isArray(input.registers) || input.registers.length === 0) throw new Error('registers 不能为空：规格书缺寄存器/配置章节时应先转 Spec Gap，禁止编造配置空间')
  if (!Array.isArray(input.constraints)) throw new Error('constraints 必须为数组（无约束传空数组）')
  // 锚点校验需要最新的结构模型与 requirement-model：先全量重建（同 registerVerificationIntents 模式）
  const artifacts = buildVerificationIntelligence(workspace)
  const moduleFiles = new Map<string, string>()
  for (const file of artifacts.structuralModel.sourceFiles) {
    const text = readFileSync(resolve(workspace, file), 'utf-8')
    for (const match of text.matchAll(/\bmodule\s+([A-Za-z_$][\w$]*)/g)) moduleFiles.set(match[1], file)
  }
  moduleFiles.delete('$design')
  const requirementIds = new Set(artifacts.requirementModel.requirements.map((item) => item.id))
  const fieldRefs = new Set<string>()
  for (const register of input.registers) {
    if (!register.name?.trim()) throw new Error('寄存器 name 不能为空')
    if (!moduleFiles.has(register.rtlModule)) throw new Error(`rtlModule 在结构模型中不存在（疑似幻觉模块名，必须核对 structural-model.json）：${register.rtlModule}`)
    if (!Array.isArray(register.fields) || register.fields.length === 0) throw new Error(`寄存器 ${register.name} 至少需要一个字段`)
    const sourceText = readFileSync(resolve(workspace, moduleFiles.get(register.rtlModule)!), 'utf-8')
    for (const field of register.fields) {
      if (!field.name?.trim()) throw new Error(`寄存器 ${register.name} 存在空字段名`)
      if (!Number.isInteger(field.msb) || !Number.isInteger(field.lsb) || field.msb < field.lsb || field.lsb < 0) throw new Error(`寄存器 ${register.name}.${field.name} 位宽非法（要求整数且 msb ≥ lsb ≥ 0）：msb=${field.msb} lsb=${field.lsb}`)
      if (field.description.length > CONFIG_FIELD_DESCRIPTION_MAX_LENGTH) throw new Error(`寄存器 ${register.name}.${field.name} 描述超过 ${CONFIG_FIELD_DESCRIPTION_MAX_LENGTH} 字（当前 ${field.description.length}）`)
      if (field.domain.kind === 'range') {
        if (!Number.isFinite(field.domain.min) || !Number.isFinite(field.domain.max) || field.domain.min > field.domain.max) throw new Error(`寄存器 ${register.name}.${field.name} 的 range domain 非法（min 必须 ≤ max）：${field.domain.min} > ${field.domain.max}`)
      } else if (field.domain.kind === 'enum') {
        if (!field.domain.values.length || field.domain.values.some((item) => !item.value?.trim())) throw new Error(`寄存器 ${register.name}.${field.name} 的 enum domain 非法（values 不能为空且每项 value 非空）`)
      } else if (field.domain.kind !== 'flag') {
        throw new Error(`寄存器 ${register.name}.${field.name} 的 domain kind 非法（允许 enum/range/flag）：${String((field.domain as { kind?: string }).kind)}`)
      }
      // 宽松标识符匹配：字段名作为整词出现在该模块 RTL 源码中（不靠文本启发式，允许命名变体命中）
      const identifier = new RegExp(`\\b${field.name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
      if (!identifier.test(sourceText)) throw new Error(`字段名 ${register.rtlModule}.${field.name} 在该模块 RTL 源码中检索不到（疑似幻觉字段，必须核对 rtl/${moduleFiles.get(register.rtlModule)}）：${field.name}`)
      if (field.clauseId && !requirementIds.has(field.clauseId)) throw new Error(`寄存器 ${register.name}.${field.name} 的 clauseId 不存在于 requirement-model：${field.clauseId}`)
      fieldRefs.add(`${register.name}.${field.name}`)
    }
  }
  for (const constraint of input.constraints) {
    if (!['mutex', 'requires', 'illegal'].includes(constraint.type)) throw new Error(`constraint type 非法（允许 mutex/requires/illegal）：${String(constraint.type)}`)
    if (!constraint.description?.trim()) throw new Error('constraint description 不能为空：必须写明约束语义与期望行为（报错/忽略/截断）')
    if (!Array.isArray(constraint.fields) || constraint.fields.length === 0) throw new Error(`constraint（${constraint.type}）至少引用一个字段`)
    for (const ref of constraint.fields) {
      if (!fieldRefs.has(ref)) throw new Error(`constraint 引用不存在的寄存器字段（必须是 <register>.<field> 且已在 registers 声明）：${ref}`)
    }
    if (constraint.clauseId && !requirementIds.has(constraint.clauseId)) throw new Error(`constraint 的 clauseId 不存在于 requirement-model：${constraint.clauseId}`)
  }
  const configSpace: ConfigSpaceFile = { version: 1, generatedAt: new Date().toISOString(), registers: input.registers, constraints: input.constraints }
  writeJsonAtomic(join(workspace, CONFIG_SPACE_RELATIVE_PATH), configSpace)
  return configSpace
}

/** W2 配置点主题（§4.3：边界/非法/动态属增补批；业务点为 W1/W2 主体，归 basic 波段）。 */
const CONFIG_POINT_TOPICS = { boundary: '配置边界', illegal: '配置非法组合', dynamic: '忙时配置变更' } as const

/** 配置点场景稳定 ID：sha1('CONFIG\0' + 派生键) 前 8 位大写——同配置点跨 rebuild 复用（幂等）。 */
function configScenarioId(key: string): string {
  return `SCN-${createHash('sha1').update(`CONFIG\0${key}`).digest('hex').slice(0, 8).toUpperCase()}`
}

interface ConfigPointSeed {
  key: string
  pointClass: 'business' | 'boundary' | 'illegal' | 'dynamic'
  title: string
  trigger: string[]
  expected: string[]
  refs: string[]
  requirementIds: string[]
  rtlObjects: string[]
  features: string[]
  wave: VerificationWave
  topic?: string
}

/**
 * 四类配置点生成（§4.3），剪枝按 §4.4（字段内边界值全量 ≤4/字段；字段间不做全笛卡尔积，
 * 仅同 constraint / 同 clauseId 功能域的天然组合）：
 * - 业务点：enum 每值一个代表组合（每字段 ≤8 代表值，其余值留候选池由 Agent 按需登记）；
 *   flag 全开/全关/典型组合（按组合键去重）；
 * - 边界点：range 字段 0/min/max/max+1（每字段 ≤4，去重）；
 * - 非法点：每条 constraint 一个违反组合，expected 必须为规格期望行为（报错/忽略/截断）；
 * - 动态点：忙时改配/在线切模式（从配置字段 + busy 语义生成，替代 R09/R16 的场景级产出）。
 */
function buildConfigPointSeeds(configSpace: ConfigSpaceFile): ConfigPointSeed[] {
  const seeds: ConfigPointSeed[] = []
  for (const register of configSpace.registers) {
    const flagFields = register.fields.filter((field) => field.domain.kind === 'flag')
    for (const field of register.fields) {
      const ref = `${register.name}.${field.name}`
      const requirementIds = field.clauseId ? [field.clauseId] : []
      if (field.domain.kind === 'enum') {
        for (const item of field.domain.values.slice(0, 8)) {
          seeds.push({
            key: `${ref}=enum:${item.value}`, pointClass: 'business',
            title: `配置业务点（${ref} = ${item.label || item.value}）`,
            trigger: ['DUT 完成复位并处于正常空闲状态', `按寄存器手册写入 ${ref} = ${item.value}，其余字段保持复位值`],
            expected: [`${field.description}（配置生效后 DUT 外部可观察行为符合规格）`],
            refs: [`${ref}=${item.value}`], requirementIds, rtlObjects: [`${register.rtlModule}.${field.name}`], features: ['configuration'], wave: 'basic'
          })
        }
      } else if (field.domain.kind === 'range') {
        const { min, max } = field.domain
        const values = [...new Set([0, min, max, max + 1])]
        for (const value of values) {
          seeds.push({
            key: `${ref}=range:${value}`, pointClass: 'boundary',
            title: `配置边界点（${ref} = ${value}）`,
            trigger: ['DUT 完成复位并处于正常空闲状态', `总线 VIP 向 ${register.rtlModule} 写入 ${ref} = ${value}`],
            expected: [`写入 ${value} 后 DUT 行为符合规格：${field.description}；越界邻值按规格截断/饱和或报错，不得静默损坏在途事务`],
            refs: [`${ref}=${value}`], requirementIds, rtlObjects: [`${register.rtlModule}.${field.name}`], features: ['configuration'], wave: 'corner', topic: CONFIG_POINT_TOPICS.boundary
          })
        }
      }
      // 动态点：在线切换模式（enum 字段）与忙时改配（每寄存器首个可写字段）
      if (field.domain.kind === 'enum') {
        seeds.push({
          key: `${ref}=dynamic-switch`, pointClass: 'dynamic',
          title: `动态配置点（忙时在线切换 ${ref}）`,
          trigger: ['DUT 处于 busy（在途事务未完成）', `在 busy 期间经总线切换 ${ref} 模式`],
          expected: [`忙时切换 ${ref} 的更新策略符合规格且不破坏在途事务：${field.description}`],
          refs: [ref], requirementIds, rtlObjects: [`${register.rtlModule}.${field.name}`], features: ['configuration', 'busy'], wave: 'corner', topic: CONFIG_POINT_TOPICS.dynamic
        })
      }
    }
    if (flagFields.length) {
      const combos: Array<{ key: string; label: string; assignments: string[] }> = [
        { key: 'all-on', label: '全开', assignments: flagFields.map((item) => `${register.name}.${item.name}=1`) },
        { key: 'all-off', label: '全关', assignments: flagFields.map((item) => `${register.name}.${item.name}=0`) },
        { key: 'typical', label: '典型', assignments: flagFields.map((item, index) => `${register.name}.${item.name}=${index === 0 ? 1 : 0}`) }
      ]
      const seen = new Set<string>()
      for (const combo of combos) {
        const comboKey = combo.assignments.join(',')
        if (seen.has(comboKey)) continue
        seen.add(comboKey)
        seeds.push({
          key: `${register.name}=flags:${combo.key}`, pointClass: 'business',
          title: `配置业务点（${register.name} 使能${combo.label}：${combo.assignments.join('，')}）`,
          trigger: ['DUT 完成复位并处于正常空闲状态', `按组合写入 ${register.name} 各 flag 字段（${combo.label}）`],
          expected: [`${combo.label}组合下 DUT 外部可观察行为符合规格（各 flag 语义见寄存器手册）`],
          refs: combo.assignments, requirementIds: [...new Set(flagFields.flatMap((item) => item.clauseId ? [item.clauseId] : []))],
          rtlObjects: [`${register.rtlModule}.${flagFields[0].name}`], features: ['configuration'], wave: 'basic'
        })
      }
    }
    if (register.fields.length) {
      const first = register.fields[0]
      seeds.push({
        key: `${register.name}=dynamic-busy-write`, pointClass: 'dynamic',
        title: `动态配置点（busy 期间改写 ${register.name}.${first.name}）`,
        trigger: ['DUT 处于 busy（在途事务未完成）', `在 busy 期间经总线改写 ${register.name}.${first.name}`],
        expected: [`忙时改写 ${register.name}.${first.name} 的更新策略符合规格且不破坏在途事务：${first.description}`],
        refs: [`${register.name}.${first.name}`], requirementIds: first.clauseId ? [first.clauseId] : [],
        rtlObjects: [`${register.rtlModule}.${first.name}`], features: ['configuration', 'busy'], wave: 'corner', topic: CONFIG_POINT_TOPICS.dynamic
      })
    }
  }
  for (const constraint of configSpace.constraints) {
    seeds.push({
      key: `constraint:${constraint.type}:${constraint.fields.join('+')}`, pointClass: 'illegal',
      title: `配置非法点（${constraint.type}：${constraint.description.slice(0, 60)}）`,
      trigger: ['DUT 完成复位并处于正常空闲状态', `构造违反约束的激励组合：${constraint.fields.join(' + ')}（${constraint.type}）`],
      expected: [`DUT 行为必须符合规格期望（报错/忽略/截断，以规格为准）：${constraint.description}；不得把非法激励当 PASS 放行`],
      refs: [...constraint.fields, constraint.description],
      requirementIds: constraint.clauseId ? [constraint.clauseId] : [],
      rtlObjects: constraint.fields.map((ref) => ref.split('.').slice(0, 2).join('.')),
      features: ['configuration'], wave: 'corner', topic: CONFIG_POINT_TOPICS.illegal
    })
  }
  return seeds
}

/**
 * 配置点场景派生（origin=CONFIG_DERIVED）：与 CLAUSE_DERIVED 同口径——进 scenario-registry
 * 候选池（PLANNED、priority 恒低于 Coverage Hole 阻断阈值，初始不排队执行，按需提升），
 * 经 scenario_hits 证据闭环；clauseId 锚点挂规格映射矩阵（§4.6），与普通场景共用执行计划全局 cap。
 * 无 config-space 时不生成；config-space 删除后派生候选自然退出（每轮按账本重派生，幂等）。
 */
function deriveConfigScenarios(configSpace: ConfigSpaceFile, previous: VerificationScenario[], hits: ReturnType<typeof scenarioHits>, structure: StructuralModel): VerificationScenario[] {
  const previousById = new Map(previous.filter((item) => item.origin === 'CONFIG_DERIVED').map((item) => [item.id, item]))
  const candidates: VerificationScenario[] = []
  for (const seed of buildConfigPointSeeds(configSpace)) {
    const id = configScenarioId(seed.key)
    const risk = 0.5
    const interaction = 0.5
    const coverageGap = 1
    const confidenceFactor = 0.85
    const costFactor = 0.9
    const criticality = 0.8
    const priority = Number((criticality * risk * interaction * coverageGap * confidenceFactor * costFactor).toFixed(3))
    const status: ScenarioStatus = 'PLANNED'
    const fresh: VerificationScenario = {
      id, origin: 'CONFIG_DERIVED', wave: seed.wave, topic: seed.topic,
      configPoint: { class: seed.pointClass, refs: seed.refs },
      title: seed.title,
      riskIds: [], requirementIds: seed.requirementIds, rtlObjects: seed.rtlObjects, features: seed.features,
      trigger: seed.trigger, expected: seed.expected, method: 'simulation',
      status, state: scenarioState(status, [], 0, undefined, 'CURRENT'),
      coordinates: { feature: seed.features, boundary: [], interaction: [], temporal: [], systemState: [] },
      rtlHash: structure.rtlHash, risk, interaction, coverageGap, criticality, confidenceFactor, costFactor, priority,
      reason: `配置空间派生（config-space.json，${seed.pointClass} 类配置点）：${seed.refs.join('、')}；闭环仍只认 scenario_hits 工具登记证据。`,
      evidence: [], reachCount: 0, coverageDelta: {}, updatedAt: new Date().toISOString()
    }
    const merged = previousById.get(id) ? { ...previousById.get(id)!, title: fresh.title, expected: fresh.expected, requirementIds: fresh.requirementIds, rtlObjects: fresh.rtlObjects, features: fresh.features, wave: seed.wave, topic: seed.topic, configPoint: fresh.configPoint } : fresh
    candidates.push(refreshScenarioWithHits(merged, hits, structure.rtlHash))
  }
  return candidates
}

/**
 * 执行计划（v0.8.6 契约 §4）：排序键 = 波段序（basic→corner→signoff）→ 聚类组 → 组内优先级。
 * 波段执行门（"W1 不满不进 W2"，约束执行不约束登记）：最早存在未闭环场景的波段圈住全部更晚
 * 波段，只有该波段的 OPEN 场景进入执行计划；更晚波段允许登记、不进计划。
 * 聚类（规划期，两段式第一段）：键 = 模块 × 方法 × Oracle 域（+ corner 波段同主题），
 * authoring 组上限 8 场景，组内执行批 2-3 个（一次 run_simulation 绑定一批 scenarioIds）。
 */
function buildExecutionPlan(scenarios: VerificationScenario[], regressions: VerificationStateModel['regressions']): { plans: ScenarioExecutionPlan[]; clusters: ScenarioCluster[] } {
  const values = regressions.flatMap((item) => Object.values(item.coverage))
  const baseline = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0
  // 同分时 AGENT_INTENT 优先于 ENGINE_CANDIDATE：origin 只作排序 tiebreaker，不改 priority 公式
  const intentFirst = (item: VerificationScenario): number => Number((item.origin ?? 'ENGINE_CANDIDATE') === 'AGENT_INTENT')
  const open = scenarios.filter((item) => item.state.closure === 'OPEN')
  const openWaves = new Set(open.map(resolveWave))
  const activeWave = WAVE_ORDER.find((wave) => openWaves.has(wave))
  const gated = open.filter((item) => resolveWave(item) === activeWave)
  const sorted = gated.sort((a, b) => Number(b.criticality === 1) - Number(a.criticality === 1) || b.priority - a.priority || intentFirst(b) - intentFirst(a) || a.costFactor - b.costFactor).slice(0, 24)

  // 规划期聚类（确定性键；失败指纹再聚类在首轮执行后以 reclusterSuggestions 输出）
  const groups = new Map<string, VerificationScenario[]>()
  for (const scenario of sorted) {
    const wave = resolveWave(scenario)
    const module = scenario.rtlObjects[0]?.split('.')[0] ?? 'unknown'
    const key = [wave, module, scenario.method, oracleDomainOf(scenario.method), wave === 'corner' ? normalizeTopic(scenario.topic) ?? '' : ''].join('\0')
    const members = groups.get(key) ?? []
    members.push(scenario)
    groups.set(key, members)
  }
  const clusters: ScenarioCluster[] = []
  for (const [key, members] of groups) {
    const [wave, module, method, oracleDomain, topic] = key.split('\0') as [VerificationWave, string, VerificationScenario['method'], string, string]
    // authoring 组上限 8 场景：超出按同键序拆为多个同键分组
    for (let chunk = 0; chunk * CLUSTER_AUTHORING_CAP < members.length; chunk++) {
      const scenarioIds = members.slice(chunk * CLUSTER_AUTHORING_CAP, (chunk + 1) * CLUSTER_AUTHORING_CAP).map((item) => item.id)
      const executionBatches: string[][] = []
      for (let index = 0; index < scenarioIds.length; index += EXECUTION_BATCH_SIZE) executionBatches.push(scenarioIds.slice(index, index + EXECUTION_BATCH_SIZE))
      // 余 1 个的孤儿批并回上一批（保持每批 2-3 个）
      if (executionBatches.length > 1 && executionBatches.at(-1)!.length === 1) {
        const last = executionBatches.at(-1)!
        last.unshift(executionBatches.at(-2)!.pop()!)
      }
      clusters.push({
        clusterId: `CL-${createHash('sha1').update(`${key}\0${chunk}`).digest('hex').slice(0, 8).toUpperCase()}`,
        wave, module, method, oracleDomain,
        topic: topic || undefined,
        scenarioIds,
        executionBatches
      })
    }
  }

  const clusterOf = new Map(clusters.flatMap((cluster) => cluster.scenarioIds.map((id) => [id, cluster])))
  const ordered = clusters.flatMap((cluster) => cluster.scenarioIds)
  const byId = new Map(sorted.map((item) => [item.id, item]))
  const plans = ordered.map((scenarioId, index) => {    const item = byId.get(scenarioId)!
    const cluster = clusterOf.get(scenarioId)!
    return {
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
      reason: `${item.reason} 当前状态 ${item.status}；到达 ${item.reachCount} 次；覆盖反馈均值 ${baseline.toFixed(1)}%；Scenario 覆盖增量 ${JSON.stringify(item.coverageDelta)}。`,
      wave: cluster.wave,
      clusterId: cluster.clusterId
    } satisfies ScenarioExecutionPlan
  })
  return { plans, clusters }
}

/**
 * 规格映射矩阵（契约 §2，闭集完备性）：每个可验证（verifiable）断言级条款 →
 * 锚定它的 Intent（AGENT_INTENT 登记 / CLAUSE_DERIVED 派生候选的 requirementIds）→
 * 关联 Scenario → 证据与状态。文档性条款不进分母。条款锚定兼容母 id（锚 SPEC-ERR-001 覆盖其全部子条款）。
 * 状态机：UNMAPPED / MAPPED_UNTESTED / PASSED / FAILED / WAIVED（FAILED 优先于 PASSED，
 * WAIVED 要求全部映射场景经具名审批豁免）。
 * 通道口径（2026-09-02 契约）：synthesis 通道条款照常入矩阵追踪并标注 acceptancePhase='SYNTH'，
 * 但不进 VERIF 完备性分母（clauseTotal/coveredClause 只计 simulation+static），单列
 * synthesisClauseTotal/synthesisClauseClosed 供 SYNTH 门禁与展示层消费。
 * blockedBySpecCount：BLOCKED_BY_SPEC 场景计数（含低优先级），规格缺口可见性（契约回应 §二）。
 */
function buildSpecMapping(requirements: RequirementModel, scenarios: VerificationScenario[], intents: VerificationIntent[]): SpecMappingMatrix {
  const verifiable = requirements.requirements.filter((item) => (item.clauseKind ?? 'verifiable') === 'verifiable')
  const documentaryCount = requirements.requirements.length - verifiable.length
  const intentByScenarioId = new Map(intents.map((item) => [item.scenarioId, item]))
  // CLAUSE_DERIVED 派生候选同样锚定条款（使被派生条款进入 MAPPED_UNTESTED）；闭环仍只认其 scenario_hits 证据
  // CONFIG_DERIVED 配置点候选同口径（§4.6：寄存器章节条款 ↔ 配置点双向指针，由配置点场景 hits 派生条款状态）
  const mappedScenarios = scenarios.filter((item) => item.origin === 'AGENT_INTENT' || item.origin === 'CLAUSE_DERIVED' || item.origin === 'CONFIG_DERIVED')
  const clauses: SpecClauseMapping[] = verifiable.map((clause) => {
    const parentId = clause.parentId ?? clause.id
    const mapped = mappedScenarios.filter((scenario) => scenario.requirementIds.includes(clause.id) || scenario.requirementIds.includes(parentId))
    // PASSED 要求当前（CURRENT）证据：陈旧（IMPACT_UNKNOWN/STALE）的 PASS 不算覆盖，防止旧证据虚报条款闭环
    const status: SpecClauseStatus = mapped.length === 0 ? 'UNMAPPED'
      : mapped.some((scenario) => scenario.state.judgment === 'FAIL') ? 'FAILED'
        : mapped.some((scenario) => scenario.state.judgment === 'PASS' && scenario.state.freshness === 'CURRENT') ? 'PASSED'
          : mapped.every((scenario) => scenario.state.closure === 'WAIVED') ? 'WAIVED'
            : 'MAPPED_UNTESTED'
    const channel = clause.channel ?? 'simulation'
    return {
      clauseId: clause.id,
      parentId,
      text: clause.text,
      status,
      channel,
      acceptancePhase: channel === 'synthesis' ? 'SYNTH' : undefined,
      intentIds: mapped.map((scenario) => intentByScenarioId.get(scenario.id)?.id ?? '').filter(Boolean),
      scenarioIds: mapped.map((scenario) => scenario.id),
      evidence: [...new Set(mapped.flatMap((scenario) => scenario.evidence))]
    }
  })
  const statusCounts: Record<SpecClauseStatus, number> = { UNMAPPED: 0, MAPPED_UNTESTED: 0, PASSED: 0, FAILED: 0, WAIVED: 0 }
  for (const clause of clauses) statusCounts[clause.status] += 1
  // 通道口径（契约 §二）：clauseTotal/coveredClause 只计 VERIF 通道（simulation+static），
  // synthesis 通道条款照常入矩阵追踪（标注 SYNTH 阶段验收）但不进 VERIF 完备性分母
  const channels: Record<SpecClauseChannel, number> = { simulation: 0, static: 0, synthesis: 0 }
  for (const clause of clauses) channels[clause.channel ?? 'simulation'] += 1
  const verifClauses = clauses.filter((clause) => (clause.channel ?? 'simulation') !== 'synthesis')
  const synthesisClauses = clauses.filter((clause) => clause.channel === 'synthesis')
  const synthesisClauseClosed = synthesisClauses.filter((clause) => clause.status === 'PASSED' || clause.status === 'WAIVED').length
  const blockedBySpecCount = scenarios.filter((item) => item.status === 'BLOCKED_BY_SPEC').length
  return { version: 1, generatedAt: new Date().toISOString(), clauseTotal: verifClauses.length, documentaryCount, coveredClause: verifClauses.filter((clause) => clause.status === 'PASSED').length, channels, synthesisClauseTotal: synthesisClauses.length, synthesisClauseClosed, statusCounts, blockedBySpecCount, clauses }
}

/**
 * 波段进度（展示层契约 B.1）：W1-W3 三段（W0 冒烟波段已删除，存量 smoke 场景经 resolveWave
 * 归一进 W1 基础功能）；W1 进度挂规格映射矩阵（闭集），W2 按归一化主题聚合，W3.status 映射 closureAssessment.status。
 */
function buildWaveProgress(scenarios: VerificationScenario[], specMapping: SpecMappingMatrix, closure: ClosureAssessment['status']): WaveProgressItem[] {
  const byWave = new Map<VerificationWave, VerificationScenario[]>()
  for (const scenario of scenarios) {
    const wave = resolveWave(scenario)
    const members = byWave.get(wave) ?? []
    members.push(scenario)
    byWave.set(wave, members)
  }
  const passed = (item: VerificationScenario): boolean => item.state.judgment === 'PASS'
  const statusOf = (members: VerificationScenario[]): WaveProgressItem['status'] =>
    members.length === 0 ? 'pending'
      : members.every((item) => item.state.closure !== 'OPEN') ? 'done'
        : members.some((item) => item.state.closure !== 'OPEN' || passed(item)) ? 'in-progress' : 'pending'
  const basic = byWave.get('basic') ?? []
  // W1 status 改挂规格映射矩阵（闭集，契约回应 §三.3）：不再由 basic 场景数量推导，
  // 修掉"0/0 场景却 in-progress"的空转；scenarioCount/passedCount 保留为实际 basic 场景展示口径
  // 缺陷 DEFECT-PACK-001#12：W1 闭环口径 = PASSED + WAIVED（具名豁免条款也是已处置条款），
  // 否则差值全为已豁免条款时 W1 永久 in-progress；specClauseCovered 展示口径保持 PASSED 不变，
  // synthesis 通道条款本就不在分母（clauseTotal 只计 VERIF 通道），保持一致
  const w1Closed = specMapping.clauses.filter((clause) => (clause.channel ?? 'simulation') !== 'synthesis' && (clause.status === 'PASSED' || clause.status === 'WAIVED')).length
  const w1Status: WaveProgressItem['status'] = specMapping.clauseTotal === 0 ? 'pending'
    : w1Closed >= specMapping.clauseTotal ? 'done'
      : 'in-progress'
  const corner = byWave.get('corner') ?? []
  const topicMap = new Map<string, { name: string; scenarioCount: number; passedCount: number }>()
  for (const scenario of corner) {
    const name = normalizeTopic(scenario.topic) ?? '未命名主题'
    const entry = topicMap.get(name) ?? { name, scenarioCount: 0, passedCount: 0 }
    entry.scenarioCount += 1
    if (passed(scenario)) entry.passedCount += 1
    topicMap.set(name, entry)
  }
  const signoff = byWave.get('signoff') ?? []
  return [
    { id: 'W1', wave: 'basic', label: '基础功能', status: w1Status, scenarioCount: basic.length, passedCount: basic.filter(passed).length, specClauseTotal: specMapping.clauseTotal, specClauseCovered: specMapping.coveredClause },
    { id: 'W2', wave: 'corner', label: '增补', status: statusOf(corner), scenarioCount: corner.length, passedCount: corner.filter(passed).length, topics: [...topicMap.values()] },
    { id: 'W3', wave: 'signoff', label: '签核', status: closure === 'READY_FOR_HUMAN_SIGNOFF' ? 'done' : closure === 'CONDITIONALLY_READY' ? 'in-progress' : signoff.length ? 'in-progress' : 'pending', scenarioCount: signoff.length, passedCount: signoff.filter(passed).length }
  ]
}

/**
 * 再聚类建议（契约 Q4 两段式第二段）：首轮失败后按失败指纹收敛聚类。
 * 指纹来源：root-causes.json（scenarioId 级）+ diagnostic-control.json（topModule 级）。
 * 同组存在不同失败指纹 → 建议分裂；跨组共享同一指纹 → 建议合并。建议性质，不自动执行。
 */
function buildReclusterSuggestions(workspace: string, clusters: ScenarioCluster[], scenarios: VerificationScenario[]): ReclusterSuggestion[] {
  if (clusters.length === 0) return []
  const fingerprints = new Map<string, string>()
  for (const record of readRootCauses(workspace)) {
    if (record.scenarioId && record.failureSignature && record.failureSignature !== 'PASS') fingerprints.set(record.scenarioId, record.failureSignature)
  }
  const scenarioById = new Map(scenarios.map((item) => [item.id, item]))
  try {
    const diagnosticPath = join(workspace, 'verification', 'results', 'diagnostic-control.json')
    if (existsSync(diagnosticPath)) {
      const diagnostic = JSON.parse(readFileSync(diagnosticPath, 'utf-8')) as { attempts?: Array<{ topModule?: string; passed?: boolean; failureSignature?: string }> }
      const moduleFingerprint = new Map<string, string>()
      for (const attempt of diagnostic.attempts ?? []) {
        if (!attempt.passed && attempt.topModule && attempt.failureSignature && attempt.failureSignature !== 'PASS') moduleFingerprint.set(attempt.topModule, attempt.failureSignature)
      }
      // 模块级指纹兜底：仅当场景自身无根因指纹时继承其模块最近失败指纹
      for (const cluster of clusters) {
        const moduleFp = moduleFingerprint.get(cluster.module)
        if (!moduleFp) continue
        for (const id of cluster.scenarioIds) if (!fingerprints.has(id) && scenarioById.has(id)) fingerprints.set(id, moduleFp)
      }
    }
  } catch { /* 诊断账本损坏时不再聚类 */ }
  const suggestions: ReclusterSuggestion[] = []
  for (const cluster of clusters) {
    const distinct = new Map<string, string[]>()
    for (const id of cluster.scenarioIds) {
      const fp = fingerprints.get(id)
      if (!fp) continue
      distinct.set(fp, [...(distinct.get(fp) ?? []), id])
    }
    if (distinct.size > 1) {
      suggestions.push({
        type: 'split', clusterIds: [cluster.clusterId], scenarioIds: [...distinct.values()].flat(),
        failureSignature: [...distinct.keys()].join(','),
        reason: `组 ${cluster.clusterId} 内存在 ${distinct.size} 种不同失败指纹（${[...distinct.entries()].map(([fp, ids]) => `${fp.slice(0, 6)}:${ids.length} 场景`).join('、')}），失败原因不可归并，建议按指纹拆组`
      })
    }
  }
  const clusterFp = new Map<string, string[]>()
  for (const cluster of clusters) {
    for (const id of cluster.scenarioIds) {
      const fp = fingerprints.get(id)
      if (!fp) continue
      clusterFp.set(fp, [...new Set([...(clusterFp.get(fp) ?? []), cluster.clusterId])])
    }
  }
  for (const [fp, clusterIds] of clusterFp) {
    if (clusterIds.length > 1) {
      suggestions.push({
        type: 'merge', clusterIds, failureSignature: fp,
        scenarioIds: clusters.filter((cluster) => clusterIds.includes(cluster.clusterId)).flatMap((cluster) => cluster.scenarioIds.filter((id) => fingerprints.get(id) === fp)),
        reason: `组 ${clusterIds.join('、')} 共享同一失败指纹 ${fp.slice(0, 6)}，疑似同一根因，建议合并为一组统一诊断`
      })
    }
  }
  return suggestions
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

// 缺陷 DEFECT-PACK-001#14：run_simulation 非回归用途（mutation/probe）的隔离运行目录段，
// 形如 verification/results/<module>/<purpose>-runs/<taskOrTimestamp>/result.json
const ISOLATED_RUN_SEGMENT = /^(?:mutation|probe|regression)-runs$|^(?:mutation|probe)$/

/**
 * 收集回归证据。缺陷 DEFECT-PACK-001#14：只认顶层模块目录直下一层
 * （verification/results/<topModule>/result.json）；隔离运行目录（*-runs/、mutation/、probe/）
 * 内的 result.json 明确排除不计入；其余递归发现、无法归属的 result.json 既不静默计入
 * 也不静默丢弃——路径返回给调用方写入 warnings。
 */
function collectResults(workspace: string): { regressions: VerificationStateModel['regressions']; orphanedResultFiles: string[] } {
  const resultsRoot = join(workspace, 'verification', 'results')
  const regressions: VerificationStateModel['regressions'] = []
  const orphanedResultFiles: string[] = []
  for (const file of walk(resultsRoot, (item) => basename(item) === 'result.json')) {
    const segments = relative(resultsRoot, file).split(sep)
    if (segments.length !== 2) {
      if (!segments.some((segment) => ISOLATED_RUN_SEGMENT.test(segment))) orphanedResultFiles.push(relative(workspace, file))
      continue
    }
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
      const rawCoverage = (data.coverage ?? {}) as Record<string, unknown>
      const coverage = Object.fromEntries(Object.entries(rawCoverage).filter(([, value]) => typeof value === 'number')) as Record<string, number>
      regressions.push({ resultFile: relative(workspace, file), passed: data.passed === true, testsTotal: Number(data.testsTotal ?? 0), coverage })
    } catch { regressions.push({ resultFile: relative(workspace, file), passed: false, testsTotal: 0, coverage: {} }) }
  }
  return { regressions, orphanedResultFiles }
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

function scenarioHits(workspace: string, currentRtlHash?: string): Map<string, { status: ScenarioStatus; evidence: string[]; reachCount: number; assertionPassed?: boolean; coverageDelta: Record<string, number>; rtlHash?: string; failureSummary?: string; failureSignature?: string }> {
  const hits = new Map<string, { status: ScenarioStatus; evidence: string[]; reachCount: number; assertionPassed?: boolean; coverageDelta: Record<string, number>; rtlHash?: string; failureSummary?: string; failureSignature?: string }>()
  for (const file of walk(join(workspace, 'verification', 'results'), (path) => basename(path) === 'scenario_hits.json')) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8')) as { rtlHash?: string; scenarios?: Array<{ id?: string; status?: ScenarioStatus; reached?: boolean; passed?: boolean; assertionPassed?: boolean; reachCount?: number; coverageDelta?: Record<string, number>; evidence?: string[]; rtlHash?: string; failureSummary?: string; failureSignature?: string }> }
      for (const item of data.scenarios ?? []) {
        if (!item.id) continue
        const evidence = (item.evidence ?? []).map((path) => resolve(dirname(file), path))
        const validEvidence = evidence.filter((path) => existsSync(path) && statSync(path).isFile() && statSync(path).size > 0)
        const requestedStatus = item.status ?? (item.reached ? (item.passed ? 'VERIFIED' : 'FAILED') : 'NOT_REACHED')
        const status = ['VERIFIED', 'FORMAL_PROVED', 'FORMAL_UNREACHABLE'].includes(requestedStatus) && validEvidence.length === 0
          ? 'PARTIAL'
          : requestedStatus
        // 方案 C 批 1（§3.3）：failureSummary/failureSignature 仅透传（旧数据无字段则缺省），不进 status 派生
        hits.set(item.id, { status, evidence: [relative(workspace, file), ...validEvidence.map((path) => relative(workspace, path))], reachCount: Number(item.reachCount ?? (item.reached ? 1 : 0)), assertionPassed: item.assertionPassed ?? item.passed, coverageDelta: Object.fromEntries(Object.entries(item.coverageDelta ?? {}).filter(([, value]) => typeof value === 'number')), rtlHash: item.rtlHash ?? data.rtlHash, ...(typeof item.failureSummary === 'string' && item.failureSummary ? { failureSummary: item.failureSummary } : {}), ...(typeof item.failureSignature === 'string' && item.failureSignature ? { failureSignature: item.failureSignature } : {}) })
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
    // BUG-AIGV-001 D2/R4：陈旧 Formal 结果（rtlHash 与当前 RTL 不一致）不得覆盖同场景的当前 hit
    const stale = Boolean(result.rtlHash && currentRtlHash && result.rtlHash !== currentRtlHash)
    if (existing && (!decisive || stale)) continue
    hits.set(result.scenarioId, { status, evidence: [...new Set([...(existing?.evidence ?? []), result.resultFile, ...result.propertyFiles, ...result.traces])], reachCount: result.outcome === 'COVERED' || result.outcome === 'PROVEN' ? Math.max(1, existing?.reachCount ?? 0) : existing?.reachCount ?? 0, assertionPassed: result.outcome === 'COUNTEREXAMPLE' ? false : result.outcome === 'PROVEN' ? true : existing?.assertionPassed, coverageDelta: existing?.coverageDelta ?? {}, rtlHash: result.rtlHash ?? existing?.rtlHash })
  }
  return hits
}

/**
 * 用最新 hit 证据刷新上一轮回存场景的状态（AGENT_INTENT 保留与 CLAUSE_DERIVED 幂等合并共用）：
 * 状态合并口径 = hit 证据优先于上一轮状态，证据新鲜度按 rtlHash 判定。
 */
function refreshScenarioWithHits(item: VerificationScenario, hits: ReturnType<typeof scenarioHits>, rtlHash: string): VerificationScenario {
  const hit = hits.get(item.id)
  let status = hit?.status ?? item.status
  const rtlChanged = Boolean(item.rtlHash && item.rtlHash !== rtlHash)
  // BUG-AIGV-001 D2/R4：hit 自身 rtlHash 陈旧即判 IMPACT_UNKNOWN 并触发降级，不回退历史 state
  const staleHit = Boolean(hit && hit.rtlHash && hit.rtlHash !== rtlHash)
  const currentEvidence = Boolean(hit && (hit.rtlHash ? hit.rtlHash === rtlHash : !rtlChanged && item.state?.freshness !== 'IMPACT_UNKNOWN'))
  const freshness: ScenarioState['freshness'] = currentEvidence ? 'CURRENT' : rtlChanged || staleHit ? 'IMPACT_UNKNOWN' : item.state?.freshness ?? 'CURRENT'
  if (freshness !== 'CURRENT' && ['VERIFIED', 'FORMAL_PROVED'].includes(status)) status = 'PARTIAL'
  const evidence = [...new Set(hit?.evidence ?? item.evidence ?? [])]
  const reachCount = hit?.reachCount ?? item.reachCount ?? 0
  const assertionPassed = hit?.assertionPassed ?? item.assertionPassed
  const next: VerificationScenario = { ...item, status, state: scenarioState(status, evidence, reachCount, assertionPassed, freshness), rtlHash, evidence, reachCount, assertionPassed, coverageDelta: hit?.coverageDelta ?? item.coverageDelta ?? {}, updatedAt: new Date().toISOString() }
  // 方案 C 批 1（§3.3）：失败摘要/指纹透传——hit 有记录时以 hit 为准（PASS 登记已清除旧字段，
  // 不再回退历史值，避免通过后的场景挂陈旧失败信息）；无 hit 时保留上一轮值。不进 scenarioState 判定。
  const failureSummary = hit ? hit.failureSummary : item.failureSummary
  const failureSignature = hit ? hit.failureSignature : item.failureSignature
  if (failureSummary) next.failureSummary = failureSummary
  else delete next.failureSummary
  if (failureSignature) next.failureSignature = failureSignature
  else delete next.failureSignature
  return next
}

/** 条款派生场景 ID：sha1('CLAUSE\0' + clauseId) 前 8 位大写——同条款跨 rebuild 复用同 ID（幂等）。 */
function clauseScenarioId(clauseId: string): string {
  return `SCN-${createHash('sha1').update(`CLAUSE\0${clauseId}`).digest('hex').slice(0, 8).toUpperCase()}`
}

/**
 * clause 派生 basic 候选（origin=CLAUSE_DERIVED，交流_20260901.txt 回复 §三.方案 A）：
 * 对规格映射矩阵中尚无证据闭环的可验证条款自动派生 wave=basic 场景候选（每条款一个，
 * 标题/目标直接引用条款文本，初始 PLANNED，锚定该 clause 的 requirementIds）。
 * 与 ENGINE_CANDIDATE 的开集风险穷举不同：每个候选锚定一条具体条款文本，天然可证伪，总量被闭集封顶。
 * 证据纪律：
 * - 派生资格用"不含 CLAUSE_DERIVED 的矩阵"预判，避免派生候选自我证成；
 * - 已被其他证据覆盖（PASSED）或具名豁免（WAIVED）的条款不派生，已有派生候选同步退出
 *   （候选生命周期完全由条款状态驱动；FAILED 条款保留候选，失败证据不丢）；
 * - 派生候选绝不可无证据闭环——闭环仍只认 scenario_hits 工具登记；
 * - 派生后该条款在矩阵中变为 MAPPED_UNTESTED（buildSpecMapping 把 CLAUSE_DERIVED 计入映射）。
 * - synthesis 通道（PPA）条款不派生 VERIF basic 候选：其验收在 SYNTH 阶段，由综合报告证据闭环。
 */
function deriveClauseScenarios(requirements: RequirementModel, base: VerificationScenario[], previous: VerificationScenario[], hits: ReturnType<typeof scenarioHits>, structure: StructuralModel): VerificationScenario[] {
  const preliminary = buildSpecMapping(requirements, base.filter((item) => item.origin !== 'CLAUSE_DERIVED'), [])
  const previousById = new Map(previous.filter((item) => item.origin === 'CLAUSE_DERIVED').map((item) => [item.id, item]))
  const requirementById = new Map(requirements.requirements.map((item) => [item.id, item]))
  const candidates: VerificationScenario[] = []
  for (const clause of preliminary.clauses) {
    // synthesis 通道条款不派生 VERIF 的 basic 候选（契约 §二：其验收在 SYNTH 阶段，由综合报告证据闭环）
    if (clause.channel === 'synthesis') continue
    const id = clauseScenarioId(clause.clauseId)
    const prev = previousById.get(id)
    if (clause.status === 'PASSED' || clause.status === 'WAIVED') continue
    const requirement = requirementById.get(clause.clauseId)
    const features = requirement?.features ?? featuresOf(clause.text)
    const criticality = requirement?.priority === 'P0' ? 1 : 0.8
    // 派生候选为确定性中等风险画像：priority 恒低于 Coverage Hole 阻断阈值（Q2 语义——
    // 未覆盖条款先不升级 blocker；执行门已由"basic 波段未闭环挡更晚波段"承担）
    const risk = 0.5
    const interaction = 0.5
    const coverageGap = 1
    const confidenceFactor = 0.85
    const costFactor = 0.9
    const priority = Number((criticality * risk * interaction * coverageGap * confidenceFactor * costFactor).toFixed(3))
    const status: ScenarioStatus = 'PLANNED'
    const fresh: VerificationScenario = {
      id, origin: 'CLAUSE_DERIVED', wave: 'basic',
      title: `基础功能（${clause.clauseId}）：${clause.text.slice(0, 120)}`,
      riskIds: [], requirementIds: [clause.clauseId], rtlObjects: [], features,
      trigger: ['DUT 完成复位并处于正常工作状态'], expected: [clause.text], method: 'simulation',
      status, state: scenarioState(status, [], 0, undefined, 'CURRENT'),
      coordinates: { feature: features, boundary: [], interaction: [], temporal: [], systemState: [] },
      rtlHash: structure.rtlHash, risk, interaction, coverageGap, criticality, confidenceFactor, costFactor, priority,
      reason: `规格映射矩阵派生（条款状态 ${clause.status}）：条款 ${clause.clauseId} 尚无验证证据闭环，自动生成 basic 波段候选；闭环仍只认 scenario_hits 工具登记证据。`,
      evidence: [], reachCount: 0, coverageDelta: {}, updatedAt: new Date().toISOString()
    }
    // 幂等合并：同条款复用同 ID，状态/证据按 previous + hit 合并（与 AGENT_INTENT 保留逻辑同口径），
    // 文本类字段（title/expected/features/锚点）取最新规格文本
    const merged = prev ? { ...prev, title: fresh.title, expected: fresh.expected, requirementIds: fresh.requirementIds, features: fresh.features, wave: 'basic' as const, origin: 'CLAUSE_DERIVED' as const } : fresh
    candidates.push(refreshScenarioWithHits(merged, hits, structure.rtlHash))
  }
  return candidates
}

function buildScenarios(requirements: RequirementModel, structure: StructuralModel, risks: RiskMarker[], previous: VerificationScenario[], workspace: string): VerificationScenario[] {
  const previousById = new Map(previous.map((item) => [item.id, item]))
  const hits = scenarioHits(workspace, structure.rtlHash)
  // 配置空间账本（§4）：存在时 R09/R16 的场景级产出由配置空间驱动的动态点替代
  // （风险规则本身保留作风险登记与优先级来源，§4.3）；无账本时维持现行 R09/R16 行为。
  const configSpace = readConfigSpace(workspace)
  const scenarioRisks = configSpace ? risks.filter((risk) => risk.taxonomyId !== 'R09' && risk.taxonomyId !== 'R16') : risks
  const derived = scenarioRisks.map((risk) => {
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
    // BUG-AIGV-001 D2/R4：hit 自身 rtlHash 陈旧即判 IMPACT_UNKNOWN 并触发降级，不回退历史 state
    const staleHit = Boolean(hit && hit.rtlHash && hit.rtlHash !== structure.rtlHash)
    const currentEvidence = Boolean(hit && (hit.rtlHash ? hit.rtlHash === structure.rtlHash : !rtlChanged && previousItem?.state?.freshness !== 'IMPACT_UNKNOWN'))
    const freshness: ScenarioState['freshness'] = currentEvidence ? 'CURRENT' : rtlChanged || staleHit ? 'IMPACT_UNKNOWN' : previousItem?.state?.freshness ?? 'CURRENT'
    if (freshness !== 'CURRENT' && ['VERIFIED', 'FORMAL_PROVED'].includes(status)) status = 'PARTIAL'
    const closed = ['VERIFIED', 'FORMAL_PROVED', 'FORMAL_UNREACHABLE', 'WAIVED'].includes(status)
    const coverageGap = closed ? 0 : status === 'PARTIAL' ? 0.5 : 1
    const confidenceFactor = risk.confidence === 'high' ? 1 : risk.confidence === 'medium' ? 0.85 : 0.65
    const costFactor = rule.method === 'static' ? 1 : rule.method === 'formal-candidate' ? 0.8 : 0.9
    const priority = Number((criticality * risk.riskScore * risk.interaction * coverageGap * confidenceFactor * costFactor).toFixed(3))
    const evidence = [...new Set([risk.source.file, ...(hit?.evidence ?? previousItem?.evidence ?? [])])]
    const reachCount = hit?.reachCount ?? previousItem?.reachCount ?? 0
    const assertionPassed = hit?.assertionPassed ?? previousItem?.assertionPassed
    const scenario = { id, origin: 'ENGINE_CANDIDATE' as const, wave: deriveWaveForEngineCandidate(nway ? 'formal-candidate' : rule.method), topic: TAXONOMY_TOPICS[risk.taxonomyId], title: `${risk.title}: ${risk.features.join(' × ')}`, riskIds: [risk.id], requirementIds, rtlObjects: [risk.object], features: risk.features, trigger: nway ? risk.features.map((item) => `${item} 在同周期或相邻周期有效`) : rule.trigger, expected: nway ? ['这些共享信号的优先级与更新次数符合规格，无重复累加、丢失或错误裁决'] : rule.expected, method: nway ? 'formal-candidate' as const : rule.method, status, state: scenarioState(status, evidence, reachCount, assertionPassed, freshness), rtlHash: structure.rtlHash, risk: risk.riskScore, interaction: risk.interaction, coverageGap, criticality, confidenceFactor, costFactor, priority, reason: `结构规则 ${risk.taxonomyId} 命中 ${risk.object}；${risk.features.join('、')} 共享控制或时序语义。`, evidence, reachCount, assertionPassed, coverageDelta: hit?.coverageDelta ?? previousItem?.coverageDelta ?? {}, updatedAt: new Date().toISOString() } as VerificationScenario
    scenario.coordinates = coordinatesFor(structure, scenario, risk)
    // 方案 C 批 1（§3.3）：失败摘要/指纹透传（hit 有记录时以 hit 为准，无 hit 保留上一轮值；不进状态派生）
    const failureSummary = hit ? hit.failureSummary : previousItem?.failureSummary
    if (failureSummary) scenario.failureSummary = failureSummary
    const failureSignature = hit ? hit.failureSignature : previousItem?.failureSignature
    if (failureSignature) scenario.failureSignature = failureSignature
    return scenario
  })
  // AGENT_INTENT 场景以 scenario-registry 为唯一事实源：全量 rebuild 必须把上一轮登记的
  // Agent 意图场景一并重投影（并用最新 hit 证据刷新状态），否则登记结果会在重建时丢失。
  const derivedIds = new Set(derived.map((item) => item.id))
  const preserved = previous.filter((item) => item.origin === 'AGENT_INTENT' && !derivedIds.has(item.id)).map((item) => refreshScenarioWithHits(item, hits, structure.rtlHash))
  // CLAUSE_DERIVED 派生候选不走保留通道：每轮按条款状态重派生（幂等），previous 仅用于状态合并
  const clauseDerived = deriveClauseScenarios(requirements, [...derived, ...preserved], previous, hits, structure)
  // CONFIG_DERIVED 配置点候选同口径：每轮按 config-space 账本重派生（幂等），无账本不生成
  const configDerived = configSpace ? deriveConfigScenarios(configSpace, previous, hits, structure) : []
  return [...derived, ...preserved, ...clauseDerived, ...configDerived].sort((a, b) => b.priority - a.priority)
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

function buildVerificationIntents(structure: StructuralModel, scenarios: VerificationScenario[], previous: VerificationIntent[] = []): VerificationIntent[] {
  // AGENT_INTENT 场景的 Intent 表述（objective/failureMode/passCriteria）来自 Agent 输入，
  // 不经模板套话；重建时保留原文，仅刷新机器维护的状态/优先级/证据字段。
  const previousByScenarioId = new Map(previous.map((item) => [item.scenarioId, item]))
  return scenarios.map((scenario) => {
    if ((scenario.origin ?? 'ENGINE_CANDIDATE') === 'AGENT_INTENT') {
      const existing = previousByScenarioId.get(scenario.id)
      if (existing) return { ...existing, evidence: scenario.evidence, status: scenario.status, priority: scenario.priority }
    }
    if (scenario.origin === 'CONFIG_DERIVED') {
      // 配置点候选的 Intent：目标/判定直接引用配置点语义（refs + 期望行为），不套风险交互模板；
      // 已有 Intent 保留原文（Agent 可经 refine_verification_intents 精炼），仅刷新机器字段
      const existing = previousByScenarioId.get(scenario.id)
      if (existing) return { ...existing, evidence: scenario.evidence, status: scenario.status, priority: scenario.priority }
      const point = scenario.configPoint
      return {
        id: `VI-${scenario.id.slice(4)}`, scenarioId: scenario.id,
        objective: `验证配置点（${point?.class ?? 'business'}）：${scenario.title}`,
        rationale: scenario.reason,
        failureMode: `反例：${scenario.expected.join('；')} 不成立（如非法激励被当 PASS 放行、越界值未按规格截断/报错）`,
        sourceIds: [...scenario.requirementIds],
        preconditions: scenario.trigger,
        stimulus: { events: scenario.features, temporalInteractions: [] },
        observations: scenario.rtlObjects,
        stimulusProcedure: [
          `按 config-space.json 写入配置点组合：${point?.refs.join('、') ?? scenario.title}`,
          ...(point?.class === 'dynamic' ? ['保持 DUT busy（在途事务未完成）期间完成上述写入'] : []),
          `记录 ${scenario.id} hit、配置序列、关键内部状态和输出响应`
        ],
        observationPoints: [...scenario.rtlObjects],
        expectedResults: scenario.expected,
        passCriteria: [
          `Checker/Assertion 必须证明：${scenario.expected.join('；')}`,
          '场景产生可追踪的 Scenario hit（reached=true 且 passed=true）',
          ...(point?.class === 'illegal' ? ['非法组合必须校验规格期望行为（报错/忽略/截断），不得把非法激励当 PASS 放行'] : []),
          '结果必须关联原始日志、结构化 result 与覆盖率'
        ],
        boundaries: [], recommendedMethods: ['simulation', 'assertion'],
        evidence: scenario.evidence, status: scenario.status, priority: scenario.priority,
        wave: resolveWave(scenario), topic: scenario.topic
      }
    }
    if (scenario.origin === 'CLAUSE_DERIVED') {
      // 条款派生候选的 Intent：目标/判定直接引用条款文本（可证伪），不套风险交互模板；
      // 已有 Intent 保留原文（Agent 可经 refine_verification_intents 精炼），仅刷新机器字段
      const existing = previousByScenarioId.get(scenario.id)
      if (existing) return { ...existing, evidence: scenario.evidence, status: scenario.status, priority: scenario.priority }
      const clauseId = scenario.requirementIds[0] ?? ''
      const clauseText = scenario.expected[0] ?? scenario.title
      return {
        id: `VI-${scenario.id.slice(4)}`, scenarioId: scenario.id,
        objective: `验证规格条款 ${clauseId} 的基础功能行为：${clauseText}`,
        rationale: scenario.reason,
        failureMode: `反例：${clauseText} 不成立`,
        sourceIds: [...scenario.requirementIds],
        preconditions: scenario.trigger,
        stimulus: { events: scenario.features, temporalInteractions: [] },
        observations: scenario.rtlObjects,
        stimulusProcedure: [
          `将 DUT 初始化到正常工作状态（${scenario.trigger.join('；') || '复位完成'}）`,
          `按规格条款 ${clauseId} 构造正常功能激励（happy path），逐条覆盖条款断言`,
          `记录 ${scenario.id} hit、输入事务、关键内部状态和输出响应`
        ],
        observationPoints: [...scenario.rtlObjects],
        expectedResults: scenario.expected,
        passCriteria: [
          `Checker/Assertion 必须证明：${clauseText}`,
          '场景产生可追踪的 Scenario hit（reached=true 且 passed=true）',
          '无 assertion failure、scoreboard mismatch 或协议违规',
          '结果必须关联原始日志、结构化 result 与覆盖率'
        ],
        boundaries: [], recommendedMethods: ['simulation', 'assertion'],
        evidence: scenario.evidence, status: scenario.status, priority: scenario.priority,
        wave: 'basic'
      }
    }
    const events = scenario.features.slice(0, 4)
    const temporalInteractions = events.length >= 2 ? [
      { relation: 'BEFORE' as const, offsetCycles: -1, events },
      { relation: 'SAME_CYCLE' as const, offsetCycles: 0, events },
      { relation: 'AFTER' as const, offsetCycles: 1, events },
      { relation: 'WITHIN_N_CYCLES' as const, offsetCycles: '[-2,+2]', events }
    ] : []
    const methods: VerificationIntent['recommendedMethods'] = scenario.method === 'formal-candidate' ? ['formal', 'assertion', 'simulation'] : scenario.method === 'static' ? ['static', 'assertion'] : ['simulation', 'assertion']
    const eventText = events.map(featureLabel).join('、') || '目标控制事件'
    const objective = `验证 ${scenario.rtlObjects.join('、')}：${eventText} 在同周期/相邻周期交互时，${scenario.expected.join('；')}。`
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
    return { id: `VI-${scenario.id.slice(4)}`, scenarioId: scenario.id, objective, rationale: scenario.reason, failureMode: `反例：${scenario.expected.join('；')} 不成立（如计数重复/丢失、优先级错误或状态矛盾）。`, sourceIds: [...scenario.requirementIds, ...scenario.riskIds], preconditions: scenario.trigger, stimulus: { events, temporalInteractions }, observations: scenario.rtlObjects, stimulusProcedure, observationPoints, expectedResults: scenario.expected, passCriteria, boundaries: boundaryConditions(structure, scenario), recommendedMethods: methods, evidence: scenario.evidence, status: scenario.status, priority: scenario.priority, wave: resolveWave(scenario), topic: scenario.topic }
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
    return { id: `HOLE-${scenario.id.slice(4)}`, scenarioId: scenario.id, scenarioTitle: scenario.title, classification, confidence, evidence: scenario.evidence, reason, missingTarget: `${scenario.rtlObjects.join('、')} 中 ${scenario.features.map(featureLabel).join('、')} 的时序交互尚未形成“到达 + 裁决 + 证据”闭环。`, requiredStimulus, requiredObservation, closureEvidence, recommendedAction: action, blocking: scenario.priority >= COVERAGE_HOLE_BLOCKING_PRIORITY }
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

// #9(a)/#9(c)：WAIVED/EXCLUDED（具名豁免/剔除）场景不参与阻断性统计的共享过滤集合，
// buildMultiOracle.criticalInsufficient 与 assessClosure.impactUnknown 复用同一口径，避免多处漂移
const EXEMPT_CLOSURES = new Set<ScenarioState['closure']>(['WAIVED', 'EXCLUDED'])

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
  const warnings: string[] = []
  // 缺陷 DEFECT-PACK-001#15：期望 schema 说明（records[] 为主，兼容项目侧自述的 results[]）
  const SCHEMA_HINT = '期望 schema：{ rtlHash?, records: [{ id, operator, weight?, status: KILLED|SURVIVED|INVALID|EQUIVALENT|EQUIVALENCE_UNKNOWN, evidence[], rtlHash?, review? }] }（兼容 results[]，字段映射 id/operator/status/evidence/rtlHash，缺省 weight=1）'
  for (const file of walk(join(workspace, 'verification', 'results'), (path) => basename(path) === 'mutation-results.json')) {
    const rel = relative(workspace, file)
    let data: { rtlHash?: string; records?: MutationRecord[]; results?: Array<Record<string, unknown>> }
    try {
      data = JSON.parse(readFileSync(file, 'utf-8'))
    } catch {
      // 缺陷 DEFECT-PACK-001#15：文件存在但解析不出 JSON 不得静默按 MISSING 处理
      warnings.push(`Mutation 结果文件无法解析为 JSON，未采信：${rel}；${SCHEMA_HINT}`)
      continue
    }
    // 缺陷 DEFECT-PACK-001#15：文件存在但无 records[] 时兼容读取 results[] 并做字段映射；
    // 两者皆无则显式告警（此前与"无输出文件"表现完全相同，面板长期静默显示 Mutation 为空）
    const rawRecords: MutationRecord[] | null = Array.isArray(data.records)
      ? data.records
      : Array.isArray(data.results)
        ? data.results.map((raw) => ({
            id: String(raw.id ?? ''),
            operator: String(raw.operator ?? 'unknown'),
            weight: raw.weight !== undefined ? Number(raw.weight) : 1,
            status: String(raw.status ?? '').toUpperCase() as MutationRecord['status'],
            evidence: Array.isArray(raw.evidence) ? raw.evidence.map(String) : [],
            rtlHash: typeof raw.rtlHash === 'string' ? raw.rtlHash : undefined
          }))
        : null
    if (!rawRecords) {
      warnings.push(`Mutation 结果文件缺少 records[]（兼容 results[]），按 MISSING 处理：${rel}；${SCHEMA_HINT}`)
      continue
    }
    for (const raw of rawRecords) {
      // 缺陷 DEFECT-PACK-001#15：rtlHash 缺失、evidence 为空分别给出可操作提示
      if (!raw.rtlHash && !data.rtlHash) warnings.push(`Mutation 记录 ${raw.id || '(无 id)'} 缺少 rtlHash 且文件级 rtlHash 缺失，无法与当前 RTL 匹配（将被判为 stale 不计入）：${rel}；请在记录或文件级补 rtlHash`)
      if (!Array.isArray(raw.evidence) || raw.evidence.length === 0) warnings.push(`Mutation 记录 ${raw.id || '(无 id)'} evidence 为空，不计入有效 Mutation 证据：${rel}；请关联击杀/存活判定的日志或结果文件路径`)
      records.push({ ...raw, weight: Math.max(0, Number(raw.weight ?? 0)), evidence: [rel, ...(raw.evidence ?? [])], rtlHash: raw.rtlHash ?? data.rtlHash })
    }
  }
  const current = records.filter((item) => item.rtlHash === rtlHash && item.evidence.length > 0)
  const scored = current.filter((item) => item.status === 'KILLED' || item.status === 'SURVIVED' || item.status === 'EQUIVALENCE_UNKNOWN' || (item.status === 'EQUIVALENT' && !item.review?.approved))
  const denominator = scored.reduce((sum, item) => sum + item.weight, 0)
  const killedWeight = scored.filter((item) => item.status === 'KILLED').reduce((sum, item) => sum + item.weight, 0)
  const weightedScore = denominator > 0 ? Number((killedWeight / denominator).toFixed(4)) : null
  const blockingSurvivors = scored.filter((item) => item.status !== 'KILLED' && !item.review?.approved).map((item) => item.id)
  const invalidOrStale = records.filter((item) => item.status === 'INVALID' || item.rtlHash !== rtlHash).map((item) => item.id)
  const status: MutationAssessment['status'] = current.length === 0 || weightedScore === null ? 'MISSING' : blockingSurvivors.length ? 'BLOCKED_BY_SURVIVOR' : weightedScore < threshold ? 'BELOW_THRESHOLD' : 'PASS'
  return { version: 1, generatedAt: new Date().toISOString(), rtlHash, threshold, weightedScore, records, validCount: scored.length, killedCount: scored.filter((item) => item.status === 'KILLED').length, blockingSurvivors, invalidOrStale, status, warnings }
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
  // #9(a)：criticalInsufficient 只统计未豁免场景——assessments 只有 scenarioId，用场景表建 closure 映射后过滤
  const closureByScenario = new Map(scenarios.map((item) => [item.id, item.state.closure]))
  return { version: 1, generatedAt: new Date().toISOString(), rtlHash, definitions, verdicts, assessments, criticalInsufficient: assessments.filter((item) => item.requiredIndependentPasses === 2 && item.status === 'INSUFFICIENT' && !EXEMPT_CLOSURES.has(closureByScenario.get(item.scenarioId) ?? 'OPEN')).map((item) => item.scenarioId), conflicts: assessments.filter((item) => item.status === 'CONFLICT').map((item) => item.scenarioId) }
}

function assessClosure(scenarios: VerificationScenario[], regressions: VerificationStateModel['regressions'], formalResults: VerificationStateModel['formalResults'], coverageHoles: CoverageHole[], multiOracle: MultiOracleEvaluation, explorationHistory: ExplorationHistory, mutation: MutationAssessment, residualRiskRegister: ResidualRisk[], uncoveredRiskCandidates: RiskMarker[], specMapping: SpecMappingMatrix, orphanedResultFiles: string[]): ClosureAssessment {
  const blockers: string[] = []
  const warnings: string[] = []
  const residualRisks: string[] = []
  const nextActions: string[] = []
  const critical = scenarios.filter((item) => item.criticality >= 0.8)
  const criticalClosed = critical.filter((item) => item.state.closure === 'VERIFIED' || item.state.closure === 'EXCLUDED' || item.state.closure === 'WAIVED')
  // #9(c)：WAIVED/EXCLUDED 场景不再产生新 hit，永久 IMPACT_UNKNOWN 属预期，不计入"影响未知"阻断统计
  const impactUnknown = scenarios.filter((item) => item.state.freshness === 'IMPACT_UNKNOWN' && !EXEMPT_CLOSURES.has(item.state.closure)).length
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
  // 缺陷 DEFECT-PACK-001#15：mutation-results.json schema 不符/记录缺 rtlHash/evidence 的显式告警
  for (const warning of mutation.warnings ?? []) warnings.push(warning)
  const unapprovedResidual = residualRiskRegister.filter((item) => item.approvalRequired && !item.approved)
  if (unapprovedResidual.length) blockers.push(`${unapprovedResidual.length} 项 Residual Risk 尚未批准或关闭`)
  // 缺陷 DEFECT-PACK-001 §5 补充：显示口径反映审批状态——已具名审批的残余风险不再逐条
  // 按登记时标题列为警告（如 NEGATIVE_SPACE 标题含"尚未批准"是登记语义，不代表当前审批
  // 状态），合并为一条"已批准 N / 待批准 M"计数摘要；待批准的仍逐条列出以便处置。
  const approvedResidual = residualRiskRegister.filter((item) => item.approved)
  for (const risk of unapprovedResidual) residualRisks.push(`${risk.id}：${risk.title}（待批准）`)
  if (approvedResidual.length) residualRisks.push(`残余风险审批状态：已批准 ${approvedResidual.length} / 待批准 ${unapprovedResidual.length}（明细与审批人见 residual-risk-register.json / signoff-approvals.json）`)
  if (formalToolErrors) warnings.push(`${formalToolErrors} 项 Formal 工具错误仅记录为 C6，不得解释为不可达或 RTL 缺陷`)
  // 缺陷 DEFECT-PACK-001#14：递归发现但无法归属（不在顶层模块目录直下、也不在隔离运行目录内）
  // 的 result.json 显式提示，不静默计入回归证据也不静默丢弃
  if (orphanedResultFiles.length) warnings.push(`发现 ${orphanedResultFiles.length} 个无法归属的 result.json，未计入回归证据（回归证据只认 verification/results/<topModule>/result.json）：${orphanedResultFiles.slice(0, 8).join('、')}${orphanedResultFiles.length > 8 ? ' 等' : ''}`)
  // 高分风险未被任何 Agent 验证意图锚定仅作提示，不阻断签核（避免门禁口径漂移）
  if (uncoveredRiskCandidates.length) warnings.push(`${uncoveredRiskCandidates.length} 个高分风险候选未被任何验证意图覆盖：${uncoveredRiskCandidates.slice(0, 8).map((item) => item.id).join('、')}${uncoveredRiskCandidates.length > 8 ? ' 等' : ''}`)
  // 无映射可验证规格条款（闭集完备性缺口）：Q2 先 warning 一个版本，NPU 试跑评估准确率后再升级 blocker；
  // 通道口径：synthesis 通道条款不在 VERIF 阶段产生 UNMAPPED warning（其验收义务在 SYNTH 门禁）
  const unmappedClauses = specMapping.clauses.filter((item) => item.status === 'UNMAPPED' && (item.channel ?? 'simulation') !== 'synthesis')
  if (unmappedClauses.length) warnings.push(`规格映射矩阵：${unmappedClauses.length}/${specMapping.clauseTotal} 个可验证规格条款尚无验证意图映射（UNMAPPED）：${unmappedClauses.slice(0, 8).map((item) => item.clauseId).join('、')}${unmappedClauses.length > 8 ? ' 等' : ''}`)
  // 低优先级规格缺口可见性（契约回应 §二）：BLOCKED_BY_SPEC 低于阻断阈值时虽不阻断，但本质是无法验证，不得隐形
  const lowPriorityBlocked = scenarios.filter((item) => item.status === 'BLOCKED_BY_SPEC' && item.priority < COVERAGE_HOLE_BLOCKING_PRIORITY).length
  if (lowPriorityBlocked) warnings.push(`低优先级规格缺口 ${lowPriorityBlocked} 项（非阻断，本质是无法验证）`)
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

function buildSignoffPackage(rtlHash: string, space: VerificationSpaceSnapshot, closure: ClosureAssessment, residualRisks: ResidualRisk[], scenarios: VerificationScenario[], regressions: VerificationStateModel['regressions'], formalResults: VerificationStateModel['formalResults'], mutation: MutationAssessment, rootCauses: RootCauseRecord[] = []): SignoffPackage {
  const confirmedRootCauses = rootCauses.filter((item) => item.verdict === 'confirmed')
  const evidenceFiles = [...new Set([
    ...scenarios.flatMap((item) => item.evidence),
    ...regressions.map((item) => item.resultFile),
    ...formalResults.flatMap((item) => [item.resultFile, ...item.propertyFiles, ...item.traces]),
    ...mutation.records.flatMap((item) => item.evidence),
    // 已确认根因结论进入签核包证据索引：评审可回答"这个场景出过什么、怎么修的"
    ...(confirmedRootCauses.length ? [ROOT_CAUSES_RELATIVE_PATH, ...confirmedRootCauses.flatMap((item) => item.evidence)] : [])
  ])].filter(Boolean)
  const packageId = `SIGNOFF-${createHash('sha256').update(`${rtlHash}\0${space.snapshotId}\0${closure.status}\0${closure.blockers.join('|')}\0${evidenceFiles.sort().join('|')}`).digest('hex').slice(0, 16).toUpperCase()}`
  const summary = closure.status === 'READY_FOR_HUMAN_SIGNOFF' ? '机器闭环条件已满足，等待具名工程审批。' : closure.status === 'CONDITIONALLY_READY' ? '核心条件满足，但仍有已批准残余风险需要在最终审批中确认。' : '存在未关闭的验证、工具、Mutation 或风险审批阻断。'
  return { version: 1, packageId, generatedAt: new Date().toISOString(), rtlHash, verificationSpaceSnapshotId: space.snapshotId, status: closure.status, summary, blockers: closure.blockers, warnings: closure.warnings, residualRisks, evidenceFiles }
}

function writeSignoffReport(path: string, pkg: SignoffPackage, mutation: MutationAssessment, multiOracle: MultiOracleEvaluation, history: ExplorationHistory, rootCauses: RootCauseRecord[] = []): void {
  const blockers = pkg.blockers.map((item) => `- ${item}`).join('\n') || '- 无'
  const residual = pkg.residualRisks.map((item) => `| ${item.id} | ${item.category} | ${item.title.replace(/\|/g, '\\|')} | ${item.approved ? `已批准：${item.approval?.approver ?? '-'}` : '未批准'} |`).join('\n') || '| - | - | 无 | - |'
  const evidence = pkg.evidenceFiles.map((item) => `- \`${item}\``).join('\n') || '- 无'
  const confirmedRootCauses = rootCauses.filter((item) => item.verdict === 'confirmed')
  const rootCauseSection = confirmedRootCauses.length
    ? `\n## 已确认根因\n\n| 记录 | Scenario | 根因 | 修复 |\n|---|---|---|---|\n${confirmedRootCauses.map((item) => `| ${item.id} | ${item.scenarioId} | ${item.rootCause.replace(/\|/g, '\\|')} | ${item.fix.replace(/\|/g, '\\|')} |`).join('\n')}\n`
    : ''
  writeFileSync(path, `# MoonGlass AIGV 2.0 Verification Sign-off Package\n\n- Package ID：\`${pkg.packageId}\`\n- 生成时间：${pkg.generatedAt}\n- RTL Hash：\`${pkg.rtlHash}\`\n- Verification Space：\`${pkg.verificationSpaceSnapshotId}\`\n- 机器结论：**${pkg.status}**\n- 说明：${pkg.summary}\n\n## 签核阻断\n\n${blockers}\n\n## 关键评价\n\n- Multi-Oracle：${multiOracle.assessments.filter((item) => item.status === 'PASS').length}/${multiOracle.assessments.length} PASS；冲突 ${multiOracle.conflicts.length}；关键证据不足 ${multiOracle.criticalInsufficient.length}\n- Risk-weighted Mutation：${mutation.weightedScore == null ? '无有效结果' : `${(mutation.weightedScore * 100).toFixed(1)}%`}；阈值 ${(mutation.threshold * 100).toFixed(1)}%；状态 ${mutation.status}\n- Novelty Saturation：${history.saturation.status}；${history.saturation.explanation}${rootCauseSection}\n\n## Residual Risk Register\n\n| ID | 分类 | 风险 | 审批 |\n|---|---|---|---|\n${residual}\n\n## Evidence Index\n\n${evidence}\n\n> 本报告是机器签核建议，不替代具名工程责任人的最终批准。所有结论仅对上述 RTL、规格空间快照、工具配置和证据集合有效。\n`, 'utf-8')
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

/**
 * 生成 execution-summary.json（契约 §2.3 + 展示层契约 B）：Agent 日常状态读取的唯一入口，硬指标 ≤10KB。
 * 内容只含计数、top-N 开放场景摘要、波段进度、规格映射计数与 top 未映射清单、blockers/nextActions
 * 与证据路径（非内容）；超限时按 waveProgress.topics → specMapping.unmappedClause → top 列表 →
 * 文本条数 → 单条长度逐级截断，保证硬指标成立。
 */
function writeExecutionSummary(path: string, workspace: string, state: VerificationStateModel, paths: IntelligenceArtifacts['paths']): void {
  const open = state.scenarios.filter((item) => item.state.closure === 'OPEN')
  const closedCount = state.scenarioCount - open.length
  const relativePath = (absolute: string): string => relative(workspace, absolute)
  interface Summary {
    version: 1
    generatedAt: string
    rtlHash: string
    progress: { scenarioCount: number; statusCounts: Partial<Record<ScenarioStatus, number>>; closed: number; open: number; blocked: number }
    topOpenScenarios: Array<{ id: string; title: string; status: ScenarioStatus; priority: number }>
    waveProgress: WaveProgressItem[]
    specMapping: {
      clauseTotal: number
      coveredClause: number
      blockedBySpecCount: number
      channels: Record<SpecClauseChannel, number>
      synthesisClauseTotal: number
      synthesisClauseClosed: number
      unmappedClause: Array<{ specId: string; clause: string }>
    }
    reclusterSuggestionCount: number
    closureStatus: ClosureAssessment['status']
    blockers: string[]
    nextActions: string[]
    evidencePaths: Record<string, string>
  }
  const summary: Summary = {
    version: 1,
    generatedAt: state.generatedAt,
    rtlHash: state.rtlHash,
    progress: { scenarioCount: state.scenarioCount, statusCounts: state.statusCounts, closed: closedCount, open: open.length, blocked: state.closureAssessment.blockers.length },
    topOpenScenarios: [...open].sort((a, b) => b.priority - a.priority).slice(0, 10).map((item) => ({ id: item.id, title: item.title, status: item.status, priority: item.priority })),
    waveProgress: state.waveProgress,
    specMapping: {
      clauseTotal: state.specMapping.clauseTotal,
      coveredClause: state.specMapping.coveredClause,
      blockedBySpecCount: state.specMapping.blockedBySpecCount,
      channels: state.specMapping.channels,
      synthesisClauseTotal: state.specMapping.synthesisClauseTotal,
      synthesisClauseClosed: state.specMapping.synthesisClauseClosed,
      // 通道口径：synthesis 条款不进 VERIF 的 UNMAPPED 清单（SYNTH 阶段验收，单列计数）
      unmappedClause: state.specMapping.clauses.filter((item) => item.status === 'UNMAPPED' && (item.channel ?? 'simulation') !== 'synthesis').slice(0, 10).map((item) => ({ specId: item.clauseId, clause: item.text.slice(0, 120) }))
    },
    reclusterSuggestionCount: state.reclusterSuggestions.length,
    closureStatus: state.closureAssessment.status,
    blockers: [...state.closureAssessment.blockers],
    nextActions: [...state.closureAssessment.nextActions],
    // 证据路径（非内容）：需要细节时按需读这些文件或用 select_next_verification_batch
    evidencePaths: {
      verificationPosture: relativePath(paths.verificationPosture),
      scenarioRegistry: relativePath(paths.scenarioRegistry),
      coverageHoleRegister: relativePath(paths.coverageHoles),
      closureAssessment: relativePath(paths.closureAssessment),
      signoffPackage: relativePath(paths.signoffPackage),
      signoffReport: relativePath(paths.signoffReport),
      rootCauses: ROOT_CAUSES_RELATIVE_PATH
    }
  }
  let serialized = JSON.stringify(summary, null, 2)
  // 展示层契约 B：超限时 waveProgress.topics 与 unmappedClause 先截断
  if (Buffer.byteLength(serialized, 'utf-8') > EXECUTION_SUMMARY_MAX_BYTES) {
    for (const wave of summary.waveProgress) delete wave.topics
    for (const keep of [5, 3, 0]) {
      summary.specMapping.unmappedClause = summary.specMapping.unmappedClause.slice(0, keep)
      serialized = JSON.stringify(summary, null, 2)
      if (Buffer.byteLength(serialized, 'utf-8') <= EXECUTION_SUMMARY_MAX_BYTES) break
    }
    serialized = JSON.stringify(summary, null, 2)
  }
  if (Buffer.byteLength(serialized, 'utf-8') > EXECUTION_SUMMARY_MAX_BYTES) {
    for (const keep of [5, 3, 0]) {
      summary.topOpenScenarios = summary.topOpenScenarios.slice(0, keep)
      serialized = JSON.stringify(summary, null, 2)
      if (Buffer.byteLength(serialized, 'utf-8') <= EXECUTION_SUMMARY_MAX_BYTES) break
    }
  }
  if (Buffer.byteLength(serialized, 'utf-8') > EXECUTION_SUMMARY_MAX_BYTES) {
    summary.blockers = summary.blockers.slice(0, 5).map((item) => item.slice(0, 120))
    summary.nextActions = summary.nextActions.slice(0, 5).map((item) => item.slice(0, 120))
    serialized = JSON.stringify(summary, null, 2)
  }
  writeJsonAtomic(path, JSON.parse(serialized))
}

export function buildVerificationIntelligence(workspaceDir: string): IntelligenceArtifacts {
  const workspace = resolve(workspaceDir)
  const outputDir = join(workspace, 'verification', 'intelligence')
  mkdirSync(outputDir, { recursive: true })
  const paths = { requirementModel: join(outputDir, 'requirement-model.json'), structuralModel: join(outputDir, 'structural-model.json'), riskRegister: join(outputDir, 'risk-register.json'), scenarioRegistry: join(outputDir, 'scenario-registry.json'), verificationState: join(outputDir, 'verification-state.json'), verificationPosture: join(outputDir, 'verification-posture.json'), report: join(outputDir, 'verification-intelligence-report.md'), interactionGraph: join(outputDir, 'feature-interaction-graph.json'), executionPlan: join(outputDir, 'scenario-execution-plan.json'), hypotheses: join(outputDir, 'verification-hypotheses.json'), specGaps: join(outputDir, 'spec-gap-register.json'), verificationIntents: join(outputDir, 'verification-intent-registry.json'), coverageHoles: join(outputDir, 'coverage-hole-register.json'), closureAssessment: join(outputDir, 'closure-assessment.json'), verificationSpace: join(outputDir, 'verification-space-snapshot.json'), explorationRound: join(outputDir, 'exploration-round.json'), explorationHistory: join(outputDir, 'exploration-history.json'), oracleRegistry: join(outputDir, 'oracle-registry.json'), oracleEvaluation: join(outputDir, 'oracle-evaluation.json'), mutationAssessment: join(outputDir, 'mutation-assessment.json'), residualRiskRegister: join(outputDir, 'residual-risk-register.json'), signoffPackage: join(outputDir, 'signoff-package.json'), signoffReport: join(outputDir, 'verification-signoff-package.md'), moduleVerificationStrategy: join(outputDir, 'module-verification-strategy.json'), executionSummary: join(outputDir, 'execution-summary.json') }
  const requirements = requirementModel(workspace)
  const structure = structuralModel(workspace)
  const risks = deriveRisks(workspace, structure)
  // UT 例外登记表（§3.2）：rebuild 联查 active 例外 → 策略表 UT_EXCEPTION 覆写 + 场景锚点放开；
  // 历史迁移（§8）：发现 <module>_tb（module ∉ topSet）且有 scenario_hits 登记的模块自动登记 active 例外（幂等）。
  let escalations = readUtEscalations(workspace)
  const provisionalStrategy = buildModuleVerificationStrategy(workspace, structure, risks, activeUtExceptionModules(escalations))
  migrateLegacyTestbenches(workspace, structure, provisionalStrategy.topModules, escalations)
  escalations = readUtEscalations(workspace)
  const utExceptionModules = activeUtExceptionModules(escalations)
  const moduleVerificationStrategy = buildModuleVerificationStrategy(workspace, structure, risks, utExceptionModules)
  // 场景锚点迁移（§3.2）：默认只锚 TOP rtlObjects + active UT 例外模块（替代原 fullScenarioModules 判定）
  const fullScenarioModules = new Set([...moduleVerificationStrategy.topModules, ...utExceptionModules])
  const scenarioRisks = risks.filter((risk) => fullScenarioModules.has(risk.object) || [...fullScenarioModules].some((module) => risk.object.startsWith(`${module}.`)))
  const scenarios = buildScenarios(requirements, structure, scenarioRisks, readPrevious(paths.scenarioRegistry), workspace)
  // 契约 §2.1：confirmed 根因挂到对应 scenario.evidence（并进入 signoff package 证据索引）
  const rootCauses = readRootCauses(workspace)
  attachConfirmedRootCauses(scenarios, rootCauses)
  const { regressions, orphanedResultFiles } = collectResults(workspace)
  const formalResults = collectFormalResults(workspace)
  const mutationAssessment = collectMutationAssessment(workspace, structure.rtlHash)
  const interactionGraph = buildInteractionGraph(requirements, structure, scenarios)
  const { plans: executionPlan, clusters: executionClusters } = buildExecutionPlan(scenarios, regressions)
  const verificationSpace = buildVerificationSpace(requirements, structure, scenarios)
  const explorationRound = buildExplorationRound(verificationSpace, scenarios, executionPlan)
  const hypotheses = readHypotheses(paths.hypotheses)
  const specGaps = deriveSpecGaps(requirements, structure, risks)
  const verificationIntents = buildVerificationIntents(structure, scenarios, readIntents(paths.verificationIntents))
  const specMapping = buildSpecMapping(requirements, scenarios, verificationIntents)
  const reclusterSuggestions = buildReclusterSuggestions(workspace, executionClusters, scenarios)
  const coverageHoles = classifyCoverageHoles(scenarios, regressions)
  const multiOracle = buildMultiOracle(workspace, structure.rtlHash, scenarios, formalResults)
  const residualRiskRegister = buildResidualRisks(workspace, scenarios, formalResults, mutationAssessment, verificationSpace)
  // 未覆盖风险兜底：风险评分前 20%、未被任何 AGENT_INTENT 场景锚定、且尚无已闭环证据场景的 RiskMarker
  const intentAnchoredRiskIds = new Set(scenarios.filter((item) => item.origin === 'AGENT_INTENT').flatMap((item) => item.riskIds))
  const evidenceCoveredRiskIds = new Set(scenarios.filter((item) => item.state.closure !== 'OPEN').flatMap((item) => item.riskIds))
  const topRiskCount = Math.ceil(risks.length * 0.2)
  const uncoveredRiskCandidates = risks.slice(0, topRiskCount).filter((risk) => !intentAnchoredRiskIds.has(risk.id) && !evidenceCoveredRiskIds.has(risk.id))
  const currentCriticalOpen = scenarios.filter((item) => item.criticality >= 0.8 && !['VERIFIED', 'EXCLUDED', 'WAIVED'].includes(item.state.closure)).length
  const explorationHistory = readExplorationHistory(paths.explorationHistory, currentCriticalOpen, verificationSpace.snapshotId)
  const closureAssessment = assessClosure(scenarios, regressions, formalResults, coverageHoles, multiOracle, explorationHistory, mutationAssessment, residualRiskRegister, uncoveredRiskCandidates, specMapping, orphanedResultFiles)
  const waveProgress = buildWaveProgress(scenarios, specMapping, closureAssessment.status)
  const signoffPackage = buildSignoffPackage(structure.rtlHash, verificationSpace, closureAssessment, residualRiskRegister, scenarios, regressions, formalResults, mutationAssessment, rootCauses)
  const statusCounts: VerificationStateModel['statusCounts'] = {}
  for (const scenario of scenarios) statusCounts[scenario.status] = (statusCounts[scenario.status] ?? 0) + 1
  const criticalOpen = scenarios.filter((item) => item.criticality >= 0.8 && !['VERIFIED', 'EXCLUDED', 'WAIVED'].includes(item.state.closure)).map((item) => item.id)
  const structuralSummary = { fsm: structure.stateMachines.length, cfgNodes: structure.controlFlow.nodes.length, dependencies: structure.temporalDependencies.length, cones: structure.conesOfInfluence.length, protocols: structure.protocols.map((item) => ({ protocol: item.protocol, module: item.module })) }
  // 配置覆盖消费（§4.5）：读 verification/results/<topModule>/config-coverage.json 归一化挂 posture；
  // 不进闭环阻断（§11 决策 2：先记账后定阈）；缺文件/损坏=无该字段
  const configCoverage = readConfigCoverage(workspace, moduleVerificationStrategy.topModules, structure.rtlHash)
  const verificationState: VerificationStateModel = { version: 6, generatedAt: new Date().toISOString(), rtlHash: structure.rtlHash, scenarioCount: scenarios.length, statusCounts, criticalOpen, uncoveredRiskCandidates, scenarios, regressions, analyzer: structure.analyzer, interactionGraph, executionPlan, executionClusters, reclusterSuggestions, waveProgress, specMapping, hypotheses, formalResults, specGaps, verificationIntents, coverageHoles, closureAssessment, verificationSpace, explorationRound, explorationHistory, multiOracle, mutationAssessment, residualRiskRegister, signoffPackage, moduleVerificationStrategy, structuralSummary }
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
    uncoveredRiskCandidates,
    waveProgress,
    specMapping,
    reclusterSuggestions,
    executionClusters,
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
      wave: intent.wave,
      topic: intent.topic,
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
    /** UT 例外登记表（§3.2，态势页徽标/悬浮与签核审计数据源；批 3 UI 消费） */
    utEscalations: escalations,
    /** 配置覆盖矩阵（§4.5 消费链路；缺文件/损坏时无该字段，页面不渲染配置覆盖区块） */
    ...(configCoverage ? { configCoverage } : {}),
    structuralSummary,
    analyzer: structure.analyzer
  })
  writeJsonAtomic(paths.interactionGraph, interactionGraph)
  writeJsonAtomic(paths.executionPlan, { version: 2, generatedAt: new Date().toISOString(), plans: executionPlan, clusters: executionClusters, reclusterSuggestions })
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
  writeSignoffReport(paths.signoffReport, signoffPackage, mutationAssessment, multiOracle, explorationHistory, rootCauses)
  if (!existsSync(paths.hypotheses)) writeJsonAtomic(paths.hypotheses, { version: 1, hypotheses: [] })
  writeReport(paths.report, verificationState, risks)
  writeExecutionSummary(paths.executionSummary, workspace, verificationState, paths)
  writeVerificationDocSnapshot(workspace, verificationState)
  return { requirementModel: requirements, structuralModel: structure, risks, verificationState, paths }
}

/** 单个 Intent 的精炼字段（LLM 改写后合并回注册表与态势）。 */
export interface IntentRefinement {
  scenarioId: string
  objective?: string
  failureMode?: string
  passCriteria?: string[]
  /** 可选：点名的真实 RTL 信号；引擎校验存在性后并入 observationPoints，文本不做强行解析。 */
  rtlSignals?: string[]
}

/**
 * 把 LLM 精炼后的 Intent 表述合并回 intent 注册表与验证态势（页面读取）。
 * 只更新提供的字段，不重算其余机器产物，避免破坏完整候选集。
 */
export function refineVerificationIntents(workspaceDir: string, refinements: IntentRefinement[]): { updated: string[]; missing: string[] } {
  const workspace = resolve(workspaceDir)
  const outputDir = join(workspace, 'verification', 'intelligence')
  const registryPath = join(outputDir, 'verification-intent-registry.json')
  const posturePath = join(outputDir, 'verification-posture.json')
  const structuralPath = join(outputDir, 'structural-model.json')
  // rtlSignals 存在性校验需要结构模型；缺失时退化为不校验（保持原有精炼行为）
  let signalNames: Set<string> | undefined
  if (existsSync(structuralPath)) {
    try { signalNames = structuralSignalNames(JSON.parse(readFileSync(structuralPath, 'utf-8')) as StructuralModel) } catch { /* 保留原文件 */ }
  }
  const byId = new Map(refinements.filter((item) => item.scenarioId).map((item) => [item.scenarioId, item]))
  const updated = new Set<string>()

  const apply = (intent: { scenarioId?: string; objective?: string; failureMode?: string; passCriteria?: string[]; observationPoints?: string[] }): void => {
    if (!intent.scenarioId) return
    const refinement = byId.get(intent.scenarioId)
    if (!refinement) return
    if (refinement.objective?.trim()) intent.objective = refinement.objective.trim()
    if (refinement.failureMode?.trim()) intent.failureMode = refinement.failureMode.trim()
    if (refinement.passCriteria?.length) intent.passCriteria = [...refinement.passCriteria]
    if (refinement.rtlSignals?.length) {
      const valid = signalNames ? refinement.rtlSignals.filter((signal) => signalNames.has(signal)) : refinement.rtlSignals
      if (valid.length) intent.observationPoints = [...new Set([...(intent.observationPoints ?? []), ...valid])]
    }
    updated.add(intent.scenarioId)
  }

  if (existsSync(registryPath)) {
    try {
      const registry = JSON.parse(readFileSync(registryPath, 'utf-8')) as { intents?: Array<{ scenarioId?: string; objective?: string; failureMode?: string; passCriteria?: string[]; observationPoints?: string[] }> }
      for (const intent of registry.intents ?? []) apply(intent)
      writeJsonAtomic(registryPath, registry)
    } catch { /* 保留原文件 */ }
  }
  if (existsSync(posturePath)) {
    try {
      const posture = JSON.parse(readFileSync(posturePath, 'utf-8')) as { verificationIntents?: Array<{ scenarioId?: string; objective?: string; failureMode?: string; passCriteria?: string[]; observationPoints?: string[] }> }
      for (const intent of posture.verificationIntents ?? []) apply(intent)
      writeJsonAtomic(posturePath, posture)
    } catch { /* 保留原文件 */ }
  }

  const missing = refinements.filter((item) => item.scenarioId && !updated.has(item.scenarioId)).map((item) => item.scenarioId)
  return { updated: [...updated], missing }
}

/** 单个场景裁决（规格澄清/豁免/验证等）的回写字段。 */
export interface ScenarioAdjudication {
  scenarioId: string
  status: ScenarioStatus
  evidence?: string[]
}

/**
 * 把场景裁决写回 scenario-registry.json（单一事实源），并重新生成验证态势快照，
 * 使 posture/state/intents/holes 与 registry 一致——页面刷新即可见，无需 Agent 手改多个 JSON。
 *
 * 裁决已缩权为判断类：执行派生状态（VERIFIED/FAILED/REACHED/NOT_REACHED/PARTIAL/
 * FORMAL_PROVED/FORMAL_UNREACHABLE）只能由 run_simulation / run_formal_verification 的
 * 证据自动派生，此处一律拒绝；WAIVED 必须已有 signoff-approvals.json 中 key 为
 * RR-WAIVER-<scenarioId> 的具名审批条目，否则拒绝。
 */
export function recordScenarioAdjudication(workspaceDir: string, adjudications: ScenarioAdjudication[]): { updated: string[]; missing: string[]; rejected: Array<{ scenarioId: string; reason: string }>; rebuilt: boolean } {
  const workspace = resolve(workspaceDir)
  const registryPath = join(workspace, 'verification', 'intelligence', 'scenario-registry.json')
  const updated: string[] = []
  const missing: string[] = []
  const rejected: Array<{ scenarioId: string; reason: string }> = []
  const EXECUTION_DERIVED: ScenarioStatus[] = ['VERIFIED', 'FAILED', 'REACHED', 'NOT_REACHED', 'PARTIAL', 'FORMAL_PROVED', 'FORMAL_UNREACHABLE']
  const approvals = readRiskApprovals(workspace)
  const acceptable = adjudications.filter((item) => {
    if (EXECUTION_DERIVED.includes(item.status)) {
      rejected.push({ scenarioId: item.scenarioId, reason: `执行派生状态 ${item.status} 由 run_simulation / run_formal_verification 的证据自动派生，不可宣布` })
      return false
    }
    if (item.status === 'WAIVED' && !approvals.has(`RR-WAIVER-${item.scenarioId}`)) {
      rejected.push({ scenarioId: item.scenarioId, reason: `豁免需用户具名审批：signoff-approvals.json 中不存在 RR-WAIVER-${item.scenarioId} 审批条目` })
      return false
    }
    return true
  })
  if (existsSync(registryPath)) {
    try {
      const registry = JSON.parse(readFileSync(registryPath, 'utf-8')) as { scenarios?: Array<Record<string, unknown>> }
      const byId = new Map(acceptable.filter((item) => item.scenarioId).map((item) => [item.scenarioId, item]))
      for (const scenario of registry.scenarios ?? []) {
        const id = String(scenario.id ?? '')
        const adjudication = byId.get(id)
        if (!adjudication) continue
        scenario.status = adjudication.status
        if (adjudication.evidence?.length) {
          const existing = Array.isArray(scenario.evidence) ? (scenario.evidence as string[]) : []
          scenario.evidence = [...new Set([...existing, ...adjudication.evidence])]
        }
        scenario.updatedAt = new Date().toISOString()
        updated.push(id)
      }
      writeJsonAtomic(registryPath, registry)
    } catch { /* 保留原文件 */ }
  }
  for (const item of acceptable) if (item.scenarioId && !updated.includes(item.scenarioId)) missing.push(item.scenarioId)
  let rebuilt = false
  if (updated.length > 0) {
    buildVerificationIntelligence(workspace)
    rebuilt = true
  }
  return { updated, missing, rejected, rebuilt }
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

/** 从 StructuralModel 收集可锚定的 RTL 信号名（同时支持 module.signal 与裸信号名两种写法）。 */
function structuralSignalNames(structure: StructuralModel): Set<string> {
  const names = new Set<string>()
  const add = (module: string | undefined, signal: string | undefined): void => {
    if (!signal) return
    names.add(signal)
    if (module) names.add(`${module}.${signal}`)
  }
  for (const writer of structure.registerWriters) add(writer.module, writer.register)
  for (const machine of structure.stateMachines) { add(machine.module, machine.stateObject); for (const state of machine.states) add(machine.module, state) }
  for (const protocol of structure.protocols) for (const signal of protocol.signals) add(protocol.module, signal)
  for (const cone of structure.conesOfInfluence) for (const signal of [cone.sink, ...cone.directSources, ...cone.transitiveSources]) names.add(signal)
  for (const fact of structure.facts) add(fact.module, fact.object)
  return names
}

/**
 * 登记 Agent 主导的验证意图（B 方向：LLM 主导验证规划，引擎退为候选生成器 + 裁判 + 记账员）。
 * 锚点校验复用 hypotheses 的引用约束模式：riskIds 必须存在于 risk-register，
 * requirementIds 必须存在于 requirement-model，rtlSignals 必须能在 StructuralModel 中匹配；
 * 任一不满足即 REJECTED 并给出中文原因。接受项生成 origin=AGENT_INTENT 的稳定 Scenario
 * （SCN- + sha1(title\0首个锚定信号) 前 8 位大写，与 buildScenarios 同规则）与对应 Intent
 * （objective/failureMode/passCriteria 直接来自输入，不经模板套话），写回注册表后全量 rebuild。
 */
export function registerVerificationIntents(workspaceDir: string, inputs: AgentIntentInput[]): { accepted: string[]; rejected: Array<{ title: string; reasons: string[] }>; rebuilt: boolean; warnings: string[] } {
  const workspace = resolve(workspaceDir)
  const artifacts = buildVerificationIntelligence(workspace)
  const riskIds = new Set(artifacts.risks.map((item) => item.id))
  const riskById = new Map(artifacts.risks.map((item) => [item.id, item]))
  // 断言级条款兼容：锚定母条款 id（SPEC-ERR-001）等价于锚定其全部子条款（SPEC-ERR-001#a…）
  const requirementIds = new Set(artifacts.requirementModel.requirements.flatMap((item) => item.parentId ? [item.id, item.parentId] : [item.id]))
  const signalNames = structuralSignalNames(artifacts.structuralModel)
  const accepted: string[] = []
  const rejected: Array<{ title: string; reasons: string[] }> = []
  const valid: Array<{ input: AgentIntentInput; scenarioId: string; wave: VerificationWave; topic?: string }> = []
  for (const input of inputs) {
    const reasons: string[] = []
    if (!input.title?.trim() || !input.objective?.trim() || !input.failureMode?.trim()) reasons.push('title、objective、failureMode 均不能为空')
    if (!input.passCriteria?.length) reasons.push('passCriteria 不能为空：必须给出具体可判定标准')
    if (!input.anchors?.riskIds?.length) reasons.push('必须锚定至少一个现有 Risk ID')
    else if (input.anchors.riskIds.some((id) => !riskIds.has(id))) reasons.push(`riskIds 不存在于 risk-register：${input.anchors.riskIds.filter((id) => !riskIds.has(id)).join('、')}`)
    if (!input.anchors?.requirementIds?.length) reasons.push('必须锚定至少一个现有 Requirement ID')
    else if (input.anchors.requirementIds.some((id) => !requirementIds.has(id))) reasons.push(`requirementIds 不存在于 requirement-model：${input.anchors.requirementIds.filter((id) => !requirementIds.has(id)).join('、')}`)
    // synthesis（PPA）通道条款的验收义务在 SYNTH 阶段（综合报告证据闭环），不属于 VERIF
    // 验证范围：simulation/formal 方法锚定即拒绝；static 方法（综合报告静态审查）是 SYNTH
    // 闭环的正路，放行。母子条款锚定时按全部匹配条款的通道判定（混合通道不误伤）
    if (input.anchors?.requirementIds?.length && input.recommendedMethod !== 'static') {
      const synthesisAnchors = input.anchors.requirementIds.filter((id) => {
        const matched = artifacts.requirementModel.requirements.filter((item) => item.id === id || item.parentId === id)
        return matched.length > 0 && matched.every((item) => item.channel === 'synthesis')
      })
      if (synthesisAnchors.length) reasons.push(`锚定条款为 synthesis（PPA）通道，验收义务在 SYNTH 阶段（综合报告证据闭环），不属于 VERIF 验证范围：${synthesisAnchors.join('、')}；如需以综合报告静态审查闭环，请用 recommendedMethod="static" 登记`)
    }
    if (!input.anchors?.rtlSignals?.length) reasons.push('必须点名至少一个真实 RTL 信号（rtlSignals）')
    else if (input.anchors.rtlSignals.some((signal) => !signalNames.has(signal))) reasons.push(`rtlSignals 在结构模型中不存在（疑似幻觉信号，必须核对 structural-model.json 后修正）：${input.anchors.rtlSignals.filter((signal) => !signalNames.has(signal)).join('、')}`)
    // 波段声明 + 一致性校验（契约 Q1：防游离标签；规则表 WAVE_ANCHOR_RULES 可扩展）
    // W0 冒烟已废弃：声明 smoke 归一为 basic 后再校验（向后兼容仍声明 smoke 的 Agent/旧提示词）
    const declaredWave = input.wave === 'smoke' ? 'basic' : input.wave
    const wave: VerificationWave = declaredWave ?? 'basic'
    if (declaredWave && !WAVE_ORDER.includes(declaredWave)) reasons.push(`wave 取值非法：${input.wave}（允许 ${WAVE_ORDER.join('/')}；smoke 已废弃，按 basic 处理）`)
    else if (input.anchors?.riskIds?.length) {
      const taxonomyIds = input.anchors.riskIds.map((id) => riskById.get(id)?.taxonomyId).filter((id): id is string => Boolean(id))
      for (const rule of WAVE_ANCHOR_RULES) {
        if (!rule.waves.includes(wave)) continue
        const hit = taxonomyIds.filter((id) => rule.matches(id))
        if (hit.length) reasons.push(`wave=${wave} 与锚定风险 ${hit.join('、')} 冲突：${rule.reason}`)
      }
    }
    // 主题归一化（契约 Q3）：corner 波段必填或可由锚定风险 taxonomyId 推导预定义主题
    let topic = normalizeTopic(input.topic)
    if (wave === 'corner' && !topic) {
      const anchoredRisks = (input.anchors?.riskIds ?? []).map((id) => riskById.get(id)).filter((risk): risk is RiskMarker => Boolean(risk))
      topic = deriveTopicFromRisks(anchoredRisks)
      if (!topic) reasons.push('wave=corner 必须提供 topic（增补批主题名），或锚定可推导预定义主题的风险')
    }
    if (reasons.length) { rejected.push({ title: input.title ?? '(未命名)', reasons }); continue }
    const scenarioId = `SCN-${createHash('sha1').update(`${input.title.trim()}\0${input.anchors.rtlSignals[0]}`).digest('hex').slice(0, 8).toUpperCase()}`
    valid.push({ input, scenarioId, wave, topic })
    accepted.push(scenarioId)
  }
  let rebuilt = false
  if (valid.length) {
    const scenarios = artifacts.verificationState.scenarios
    const intents = artifacts.verificationState.verificationIntents
    for (const { input, scenarioId, wave, topic } of valid) {
      const anchoredRisks = artifacts.risks.filter((risk) => input.anchors.riskIds.includes(risk.id))
      const risk = Math.max(0.5, ...anchoredRisks.map((item) => item.riskScore))
      const interaction = Math.max(0.5, ...anchoredRisks.map((item) => item.interaction))
      const anchoredRequirements = artifacts.requirementModel.requirements.filter((item) => input.anchors.requirementIds.includes(item.id) || input.anchors.requirementIds.includes(item.parentId ?? ''))
      const criticality = anchoredRequirements.some((item) => item.priority === 'P0') ? 1 : 0.8
      const costFactor = input.recommendedMethod === 'static' ? 1 : input.recommendedMethod === 'formal-candidate' ? 0.8 : 0.9
      const features = featuresOf(`${input.title} ${input.objective}`)
      const rtlObjects = [...new Set(input.anchors.rtlSignals.map((signal) => signal.split('.')[0]))]
      const existing = scenarios.find((item) => item.id === scenarioId)
      if (existing) {
        // 重复登记按更新处理：刷新锚点、波段标签与判定口径，保留已由证据派生的执行状态
        existing.title = input.title.trim()
        existing.wave = wave
        existing.topic = topic
        existing.riskIds = [...input.anchors.riskIds]
        existing.requirementIds = [...input.anchors.requirementIds]
        existing.rtlObjects = rtlObjects
        existing.method = input.recommendedMethod
        existing.trigger = [...(input.preconditions ?? [])]
        existing.expected = [...input.passCriteria]
        existing.updatedAt = new Date().toISOString()
      } else {
        const status: ScenarioStatus = 'PLANNED'
        const coverageGap = 1
        const confidenceFactor = 0.85
        const priority = Number((criticality * risk * interaction * coverageGap * confidenceFactor * costFactor).toFixed(3))
        scenarios.push({ id: scenarioId, origin: 'AGENT_INTENT', wave, topic, title: input.title.trim(), riskIds: [...input.anchors.riskIds], requirementIds: [...input.anchors.requirementIds], rtlObjects, features, trigger: [...(input.preconditions ?? [])], expected: [...input.passCriteria], method: input.recommendedMethod, status, state: scenarioState(status, [], 0, undefined, 'CURRENT'), coordinates: { feature: features, boundary: [], interaction: [], temporal: [], systemState: [] }, rtlHash: artifacts.structuralModel.rtlHash, risk, interaction, coverageGap, criticality, confidenceFactor, costFactor, priority, reason: `Agent 登记的验证意图（AGENT_INTENT），锚定 ${input.anchors.riskIds.join('、')}。`, evidence: [], reachCount: 0, coverageDelta: {}, updatedAt: new Date().toISOString() })
      }
      const recommendedMethods: VerificationIntent['recommendedMethods'] = input.recommendedMethod === 'formal-candidate' ? ['formal', 'assertion', 'simulation'] : input.recommendedMethod === 'static' ? ['static', 'assertion'] : ['simulation', 'assertion']
      const observationPoints = [...new Set([...(input.observationPoints ?? []), ...rtlObjects])]
      const intent = intents.find((item) => item.scenarioId === scenarioId)
      if (intent) {
        intent.objective = input.objective.trim()
        intent.failureMode = input.failureMode.trim()
        intent.passCriteria = [...input.passCriteria]
        intent.expectedResults = [...input.passCriteria]
        intent.sourceIds = [...input.anchors.requirementIds, ...input.anchors.riskIds]
        intent.preconditions = [...(input.preconditions ?? [])]
        intent.observationPoints = observationPoints
        intent.recommendedMethods = recommendedMethods
        intent.wave = wave
        intent.topic = topic
      } else {
        intents.push({ id: `VI-${scenarioId.slice(4)}`, scenarioId, objective: input.objective.trim(), rationale: `Agent 登记的验证意图（AGENT_INTENT），锚定 ${input.anchors.riskIds.join('、')}。`, failureMode: input.failureMode.trim(), sourceIds: [...input.anchors.requirementIds, ...input.anchors.riskIds], preconditions: [...(input.preconditions ?? [])], stimulus: { events: features, temporalInteractions: [] }, observations: rtlObjects, stimulusProcedure: [], observationPoints, expectedResults: [...input.passCriteria], passCriteria: [...input.passCriteria], boundaries: [], recommendedMethods, evidence: [], status: 'PLANNED', priority: scenarios.find((item) => item.id === scenarioId)?.priority ?? 0, wave, topic })
      }
    }
    writeJsonAtomic(artifacts.paths.scenarioRegistry, { version: 2, generatedAt: new Date().toISOString(), rtlHash: artifacts.structuralModel.rtlHash, scenarios })
    writeJsonAtomic(artifacts.paths.verificationIntents, { version: 1, generatedAt: new Date().toISOString(), intents })
    buildVerificationIntelligence(workspace)
    rebuilt = true
  }
  // corner 登记软提醒（契约回应 §三.方案 B）：specMapping 覆盖率低于阈值时 warning 提示先补 basic，不拒绝登记
  const warnings: string[] = []
  const specMapping = artifacts.verificationState.specMapping
  if (valid.some((item) => item.wave === 'corner') && specMapping.clauseTotal > 0) {
    const coverage = specMapping.coveredClause / specMapping.clauseTotal
    if (coverage < CORNER_COVERAGE_WARNING_THRESHOLD) {
      warnings.push(`基础功能条款覆盖率 ${Math.round(coverage * 100)}%（${specMapping.coveredClause}/${specMapping.clauseTotal}），建议先补 basic 波段（corner 登记已接受，不阻断）`)
    }
  }
  return { accepted, rejected, rebuilt, warnings }
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

/**
 * SYNTH 阶段 PPA 门禁（2026-09-02 契约 §二）：synthesis 通道条款由综合报告证据闭环（SYNTH 阶段验收），
 * 存在未闭环（无 PASSED/WAIVED 证据）的 synthesis 条款即阻断 SYNTH 收口。
 * 无 verification-state.json / 无 synthesis 条款时直接放行（total=0 即无 PPA 验收义务）。
 */
export function reviewSynthesisClauses(workspaceDir: string): { passed: boolean; blockers: string[]; total: number; open: number } {
  const path = join(resolve(workspaceDir), 'verification', 'intelligence', 'verification-state.json')
  if (!existsSync(path)) return { passed: true, blockers: [], total: 0, open: 0 }
  try {
    const state = JSON.parse(readFileSync(path, 'utf-8')) as VerificationStateModel
    const synthesisClauses = (state.specMapping?.clauses ?? []).filter((clause) => clause.channel === 'synthesis')
    const open = synthesisClauses.filter((clause) => clause.status !== 'PASSED' && clause.status !== 'WAIVED')
    const blockers = open.map((clause) => `PPA 条款 ${clause.clauseId} 尚无综合报告证据闭环（SYNTH 阶段验收）：${clause.text.slice(0, 60)}`)
    return { passed: blockers.length === 0, blockers, total: synthesisClauses.length, open: open.length }
  } catch { return { passed: true, blockers: [], total: 0, open: 0 } }
}

/**
 * QA 阶段验证完备性审计（规格点 → 验证点 → 用例 → 证据 闭集完整性）：
 * 对 specMapping 矩阵中每个 VERIF 通道条款（simulation/static；synthesis 通道的验收义务
 * 在 SYNTH 阶段由 reviewSynthesisClauses 兜底）要求：
 *   1. ≥1 个真实验证点（Verification Intent，AGENT_INTENT；CLAUSE_DERIVED 派生候选不算——
 *      派生候选只是占位，不产生 intentIds）；
 *   2. ≥1 个绑定的验证用例/场景（scenarioIds 非空）；
 *   3. CURRENT PASS 证据（陈旧证据由 specMapping 的 PASSED 派生口径排除），且证据路径非空；
 *   4. WAIVED 必须有具名审批（signoff-approvals.json 中对应 RR-WAIVER-<scenarioId> 记录）。
 * 调用方应先执行 buildVerificationIntelligence 重建矩阵后再调用（与 reviewScenarioClosure 同约定）。
 */
export function auditVerificationCompleteness(workspaceDir: string): {
  passed: boolean
  blockers: string[]
  warnings: string[]
  stats: { clauseTotal: number; covered: number }
} {
  const workspace = resolve(workspaceDir)
  const path = join(workspace, 'verification', 'intelligence', 'verification-state.json')
  if (!existsSync(path)) {
    return { passed: false, blockers: ['尚未生成 Verification State Model（先调用 build_verification_intelligence 重建验证态势）'], warnings: [], stats: { clauseTotal: 0, covered: 0 } }
  }
  let state: VerificationStateModel
  try { state = JSON.parse(readFileSync(path, 'utf-8')) as VerificationStateModel } catch {
    return { passed: false, blockers: ['verification-state.json 无法解析'], warnings: [], stats: { clauseTotal: 0, covered: 0 } }
  }
  const blockers: string[] = []
  const warnings: string[] = []
  const clauses = (state.specMapping?.clauses ?? []).filter((clause) => (clause.channel ?? 'simulation') !== 'synthesis')
  const approvals = readRiskApprovals(workspace)
  let covered = 0
  for (const clause of clauses) {
    if (clause.intentIds.length === 0) {
      blockers.push(`${clause.clauseId} 无验证点（仅有引擎派生候选占位，未登记真实 Verification Intent）：${clause.text.slice(0, 60)}`)
      continue
    }
    if (clause.scenarioIds.length === 0) {
      blockers.push(`${clause.clauseId} 有验证点但无验证用例绑定（无 scenario 锚定该条款）`)
      continue
    }
    if (clause.status === 'PASSED') {
      if (clause.evidence.length === 0) blockers.push(`${clause.clauseId} 标记 PASSED 但无证据路径`)
      else covered += 1
      continue
    }
    if (clause.status === 'WAIVED') {
      if (clause.scenarioIds.some((id) => approvals.has(`RR-WAIVER-${id}`))) covered += 1
      else blockers.push(`${clause.clauseId} 已豁免但缺具名审批（signoff-approvals.json 需有对应 RR-WAIVER-* 记录）`)
      continue
    }
    blockers.push(`${clause.clauseId} 状态 ${clause.status}：缺当前 RTL 版本的 PASS 证据`)
  }
  if (blockers.length > 8) warnings.push('（阻断明细过多时按 execution-summary.json 的 specMapping.unmappedClause 逐条处理）')
  return { passed: blockers.length === 0, blockers, warnings, stats: { clauseTotal: clauses.length, covered } }
}

/** recordRootCause 的输入（缺 id/createdAt，由引擎派生）。字段口径见契约 §2.1。 */
export interface RootCauseInput {
  scenarioId: string
  hypothesis: string
  verdict: 'confirmed' | 'refuted' | 'open'
  refutedHypotheses: string[]
  failureSignature: string
  rootCause: string
  fix: string
  evidence: string[]
}

export const ROOT_CAUSE_MAX_LENGTH = 200
export const ROOT_CAUSE_FIX_MAX_LENGTH = 120

/**
 * 把根因结论写/合并到 verification/results/root-causes.json（契约 §2.1）。
 * 每条记录有稳定 id（RC-<sha1前8位大写>，由 scenarioId/hypothesis 派生；同假设裁决更新复用同 id）；
 * 同 scenarioId 多条共存成链，refutedHypotheses 引用先前记录 id 做链式追溯。
 * rootCause ≤200 字、fix ≤120 字为硬约束（schema 层的 maxLength 之外的引擎兜底）。
 */
export function recordRootCause(workspaceDir: string, input: RootCauseInput): RootCauseRecord {
  const workspace = resolve(workspaceDir)
  if (!/^SCN-[A-F0-9]{8}$/.test(input.scenarioId)) throw new Error(`scenarioId 不符合 ^SCN-[A-F0-9]{8}$：${input.scenarioId}`)
  if (!input.hypothesis?.trim()) throw new Error('hypothesis 不能为空')
  if (input.rootCause.length > ROOT_CAUSE_MAX_LENGTH) throw new Error(`rootCause 超过 ${ROOT_CAUSE_MAX_LENGTH} 字（当前 ${input.rootCause.length}）：根因结论必须是一句话，不是散文 blob`)
  if (input.fix.length > ROOT_CAUSE_FIX_MAX_LENGTH) throw new Error(`fix 超过 ${ROOT_CAUSE_FIX_MAX_LENGTH} 字（当前 ${input.fix.length}）：只写动作级描述`)
  if (input.verdict === 'confirmed' && !input.rootCause.trim()) throw new Error('verdict=confirmed 时 rootCause 不能为空')
  const record: RootCauseRecord = {
    ...input,
    id: `RC-${createHash('sha1').update(`${input.scenarioId}${input.hypothesis}`).digest('hex').slice(0, 8).toUpperCase()}`,
    createdAt: new Date().toISOString()
  }
  const path = join(workspace, ROOT_CAUSES_RELATIVE_PATH)
  const existing = readRootCauses(workspace)
  // 同 id（同场景 + 同假设）重复登记按更新处理（如 open→confirmed），链式历史其余记录原样保留
  const index = existing.findIndex((item) => item.id === record.id)
  if (index >= 0) existing.splice(index, 1, record)
  else existing.push(record)
  mkdirSync(dirname(path), { recursive: true })
  writeJsonAtomic(path, { version: 1, generatedAt: new Date().toISOString(), records: existing })
  return record
}

/**
 * 确定性拼装批次会话 prompt（契约 §2.2，第 3 批由主进程编排消费，无 LLM 参与）：
 * 批次 Intent 详情（objective/failureMode/passCriteria/锚点）+ 从 root-causes.json 按
 * scenarioId 取出的已证伪假设与已确认根因 + 环境路径与纪律约束。
 */
export function buildBatchPrompt(workspaceDir: string, scenarioIds: string[]): string {
  const workspace = resolve(workspaceDir)
  const registryPath = join(workspace, 'verification', 'intelligence', 'scenario-registry.json')
  if (!existsSync(registryPath)) buildVerificationIntelligence(workspace)
  const scenarios = readPrevious(registryPath)
  const intents = readIntents(join(workspace, 'verification', 'intelligence', 'verification-intent-registry.json'))
  const rootCauses = readRootCauses(workspace)
  const byId = new Map(scenarios.map((item) => [item.id, item]))
  const intentByScenarioId = new Map(intents.map((item) => [item.scenarioId, item]))

  // 聚类组语义（v0.8.6 契约 §4）：批次来自同一 cluster 时明确"同模块同 Oracle 域、
  // 一个测试文件 N 个 testcase、一次 run_simulation 绑定全部 scenarioIds"
  let cluster: ScenarioCluster | undefined
  try {
    const planPath = join(workspace, 'verification', 'intelligence', 'scenario-execution-plan.json')
    const plan = JSON.parse(readFileSync(planPath, 'utf-8')) as { clusters?: ScenarioCluster[] }
    cluster = (plan.clusters ?? []).find((item) => scenarioIds.length > 0 && scenarioIds.every((id) => item.scenarioIds.includes(id)))
  } catch { /* 无聚类视图时退化为普通批次 prompt */ }

  const sections: string[] = [
    `# 验证批次任务（${scenarioIds.length} 个场景）`,
    '',
    '本批次由 MoonGlass 主进程编排派发。逐个完成以下场景的"到达 + 裁决 + 证据"闭环。'
  ]
  if (cluster) {
    sections.push(
      '',
      `## 聚类组语义（${cluster.clusterId}）`,
      '',
      `本组 ${scenarioIds.length} 个场景同属一个聚类组：模块 ${cluster.module}、方法 ${cluster.method}、Oracle 域 ${cluster.oracleDomain}${cluster.topic ? `、主题「${cluster.topic}」` : ''}（波段 ${cluster.wave}）。`,
      `按组 authoring：写一个测试文件，内含 ${scenarioIds.length} 个 testcase（每个场景一个 @cocotb.test），并用 run_simulation(scenarioIds=[${scenarioIds.join(', ')}]) 一次绑定全部 scenarioIds 登记证据。`
    )
  }
  const missing: string[] = []
  for (const scenarioId of scenarioIds) {
    const scenario = byId.get(scenarioId)
    if (!scenario) { missing.push(scenarioId); continue }
    const intent = intentByScenarioId.get(scenarioId)
    sections.push(
      '',
      `## 场景 ${scenarioId}：${scenario.title}`,
      '',
      `- 验证目标（objective）：${intent?.objective ?? scenario.expected.join('；')}`,
      `- 失效反例（failureMode）：${intent?.failureMode ?? '反例：预期不成立'}`,
      `- 判定标准（passCriteria）：`,
      ...(intent?.passCriteria ?? scenario.expected).map((item) => `  - ${item}`),
      `- 锚点：需求 ${scenario.requirementIds.join('、') || '无'}；风险 ${scenario.riskIds.join('、') || '无'}；RTL 对象 ${scenario.rtlObjects.join('、') || '无'}`,
      `- 推荐方法：${scenario.method}；前置条件：${scenario.trigger.join('；') || '无'}`
    )
  }
  if (missing.length) sections.push('', `⚠️ 以下场景 ID 不在 scenario-registry 中（须先核对 execution-summary.json）：${missing.join('、')}`)

  const handoff: string[] = []
  for (const scenarioId of scenarioIds) {
    const records = rootCauses.filter((item) => item.scenarioId === scenarioId)
    if (!records.length) continue
    const refuted = records.filter((item) => item.verdict === 'refuted')
    const confirmed = records.filter((item) => item.verdict === 'confirmed')
    const openHypotheses = records.filter((item) => item.verdict === 'open')
    handoff.push(`### ${scenarioId}`)
    for (const item of confirmed) handoff.push(`- 已确认根因（${item.id}）：${item.rootCause}；修复：${item.fix}`)
    for (const item of refuted) handoff.push(`- 已证伪假设（${item.id}，不得再沿此方向排查）：${item.hypothesis}`)
    for (const item of openHypotheses) handoff.push(`- 待证假设（${item.id}）：${item.hypothesis}`)
  }
  sections.push(
    '',
    '## 根因交接（来自 verification/results/root-causes.json）',
    '',
    handoff.length ? handoff.join('\n') : '本批次场景暂无已登记的根因记录。FAIL 修复后必须用 record_root_cause 顺手登记根因结论。'
  )

  sections.push(
    '',
    '## 环境路径与纪律约束',
    '',
    `- 工作区根目录：${workspace}`,
    `- RTL 源：rtl/（清单 rtl/filelist.f，元数据 rtl/design.json）`,
    `- 证据目录：verification/results/<module>/（日志、result.json、波形）`,
    `- 状态入口：verification/intelligence/execution-summary.json（日常只读此摘要）`,
    `- scenario_hits 由 run_simulation(scenarioIds=...) 在执行后自动登记，禁止手写或修改 scenario_hits.json`,
    `- 执行派生状态（VERIFIED/FAILED/REACHED/NOT_REACHED/PARTIAL/FORMAL_PROVED/FORMAL_UNREACHABLE）由证据自动派生，不得宣布；判断类裁决只能用 record_scenario_adjudication`,
    `- 根因结论必须用 record_root_cause 落盘，不靠提示词纪律`,
    `- UT 例外纪律：未经 register_ut_escalation 登记（ut-escalations.json active），禁止为任何子模块单独搭建 Testbench；模块级 TB 仅限已登记 active UT 例外的模块`,
    `- 配置点场景（origin=CONFIG_DERIVED）按 configPoint.class 执行：非法点（illegal）必须校验规格期望行为（报错/忽略/截断），不得把非法激励当 PASS 放行`
  )
  return sections.join('\n')
}
