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
  RootCauseRecord,
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
  CoverageHole,
  AgentIntentInput,
  VerificationWave,
  WaveProgressItem,
  SpecClauseMapping,
  SpecClauseStatus,
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

// ==================== v0.8.6 波段化 + 规格映射完备性 + 聚类批次（契约 交流_20260901.txt §二 Q1-Q4） ====================

/** 波段执行顺序：smoke → basic → corner → signoff。 */
const WAVE_ORDER: VerificationWave[] = ['smoke', 'basic', 'corner', 'signoff']

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

/** 场景波段解析（旧数据兼容）：无 wave 字段时 AGENT_INTENT / CLAUSE_DERIVED 默认 basic，ENGINE_CANDIDATE 按方法推导。 */
function resolveWave(scenario: Pick<VerificationScenario, 'wave' | 'origin' | 'method'>): VerificationWave {
  if (scenario.wave) return scenario.wave
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
 * 命中即拒绝登记。注意 anchors.riskIds 为必填，故 smoke 波段实际上不可经 Intent 登记
 * （冒烟属环境验收，由环境检查工具承担）——这正是契约"声明 smoke 但锚定了任何风险 → 拒绝"的落点。
 */
const WAVE_ANCHOR_RULES: Array<{ waves: VerificationWave[]; matches: (taxonomyId: string) => boolean; reason: string }> = [
  { waves: ['smoke'], matches: () => true, reason: 'smoke 波段为环境验收（reset/接口连通/单个正常事务），不得锚定任何风险；如需登记请声明 basic' },
  { waves: ['smoke', 'basic'], matches: (taxonomyId) => ruleMethodOf(taxonomyId) === 'formal-candidate', reason: '锚定 formal-candidate 类风险（如 R02/R05/R19）不得声明 smoke/basic 波段' }
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

/** 文档性条款分类（确定性规则，理由写入条款记录；宁可漏判成 verifiable 不可误判）。 */
function classifyClause(text: string): { clauseKind: 'verifiable' | 'documentary'; classificationReason?: string } {
  for (const rule of DOCUMENTARY_RULES) {
    if (rule.pattern.test(text)) return { clauseKind: 'documentary', classificationReason: `${rule.reason}：${text.slice(0, 60)}` }
  }
  return { clauseKind: 'verifiable' }
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
          const classification = classifyClause(clause.text)
          requirements.push({ id: clause.clauseId, text: clause.text, features: featuresOf(clause.text), priority, kind: 'SPEC_FACT', clauseKind: classification.clauseKind, parentId: clause.parentId, classificationReason: classification.classificationReason, source })
        }
      }
      const trimmed = line.trim()
      const isStructural = trimmed.startsWith('|') || trimmed.startsWith('#') || trimmed.startsWith('```')
      if (!isStructural && /\b(?:TBD|TODO|待定|未定义|待确认)\b/i.test(line)) unknowns.push({ id: `UNK-${unknowns.length + 1}`, text: line.trim().slice(0, 500), source: { file: relative(workspace, file), line: index + 1 } })
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

function structuralModel(workspace: string): StructuralModel {
  const inputs = readRtlInputs(workspace)
  const hash = createHash('sha256')
  for (const file of inputs.designFiles) {
    const text = readFileSync(file, 'utf-8')
    hash.update(relative(workspace, file)).update('\0').update(text).update('\0')
  }
  // 库文件不参与结构抽取，但其清单变化同样影响 elaboration 结果，计入 rtlHash
  for (const file of inputs.libraryFiles) hash.update('lib:').update(relative(workspace, file)).update('\0')
  return analyzeStructure({ workspace, files: inputs.designFiles, libraryFiles: inputs.libraryFiles, includeDirs: inputs.includeDirs, defines: inputs.defines, topModule: inputs.topModule, inputSource: inputs.inputSource, rtlHash: hash.digest('hex'), featuresOf })
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

/**
 * 执行计划（v0.8.6 契约 §4）：排序键 = 波段序（smoke→basic→corner→signoff）→ 聚类组 → 组内优先级。
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
 * blockedBySpecCount：BLOCKED_BY_SPEC 场景计数（含低优先级），规格缺口可见性（契约回应 §二）。
 */
function buildSpecMapping(requirements: RequirementModel, scenarios: VerificationScenario[], intents: VerificationIntent[]): SpecMappingMatrix {
  const verifiable = requirements.requirements.filter((item) => (item.clauseKind ?? 'verifiable') === 'verifiable')
  const documentaryCount = requirements.requirements.length - verifiable.length
  const intentByScenarioId = new Map(intents.map((item) => [item.scenarioId, item]))
  // CLAUSE_DERIVED 派生候选同样锚定条款（使被派生条款进入 MAPPED_UNTESTED）；闭环仍只认其 scenario_hits 证据
  const mappedScenarios = scenarios.filter((item) => item.origin === 'AGENT_INTENT' || item.origin === 'CLAUSE_DERIVED')
  const clauses: SpecClauseMapping[] = verifiable.map((clause) => {
    const parentId = clause.parentId ?? clause.id
    const mapped = mappedScenarios.filter((scenario) => scenario.requirementIds.includes(clause.id) || scenario.requirementIds.includes(parentId))
    // PASSED 要求当前（CURRENT）证据：陈旧（IMPACT_UNKNOWN/STALE）的 PASS 不算覆盖，防止旧证据虚报条款闭环
    const status: SpecClauseStatus = mapped.length === 0 ? 'UNMAPPED'
      : mapped.some((scenario) => scenario.state.judgment === 'FAIL') ? 'FAILED'
        : mapped.some((scenario) => scenario.state.judgment === 'PASS' && scenario.state.freshness === 'CURRENT') ? 'PASSED'
          : mapped.every((scenario) => scenario.state.closure === 'WAIVED') ? 'WAIVED'
            : 'MAPPED_UNTESTED'
    return {
      clauseId: clause.id,
      parentId,
      text: clause.text,
      status,
      intentIds: mapped.map((scenario) => intentByScenarioId.get(scenario.id)?.id ?? '').filter(Boolean),
      scenarioIds: mapped.map((scenario) => scenario.id),
      evidence: [...new Set(mapped.flatMap((scenario) => scenario.evidence))]
    }
  })
  const statusCounts: Record<SpecClauseStatus, number> = { UNMAPPED: 0, MAPPED_UNTESTED: 0, PASSED: 0, FAILED: 0, WAIVED: 0 }
  for (const clause of clauses) statusCounts[clause.status] += 1
  const blockedBySpecCount = scenarios.filter((item) => item.status === 'BLOCKED_BY_SPEC').length
  return { version: 1, generatedAt: new Date().toISOString(), clauseTotal: verifiable.length, documentaryCount, coveredClause: statusCounts.PASSED, statusCounts, blockedBySpecCount, clauses }
}

/**
 * 波段进度（展示层契约 B.1）：W0-W3 四段；W1 进度挂规格映射矩阵（闭集），
 * W2 按归一化主题聚合，W3.status 映射 closureAssessment.status。
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
  const w1Status: WaveProgressItem['status'] = specMapping.clauseTotal === 0 ? 'pending'
    : specMapping.coveredClause >= specMapping.clauseTotal ? 'done'
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
  const smoke = byWave.get('smoke') ?? []
  return [
    { id: 'W0', wave: 'smoke', label: '冒烟', status: statusOf(smoke), scenarioCount: smoke.length, passedCount: smoke.filter(passed).length },
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

/**
 * 用最新 hit 证据刷新上一轮回存场景的状态（AGENT_INTENT 保留与 CLAUSE_DERIVED 幂等合并共用）：
 * 状态合并口径 = hit 证据优先于上一轮状态，证据新鲜度按 rtlHash 判定。
 */
function refreshScenarioWithHits(item: VerificationScenario, hits: ReturnType<typeof scenarioHits>, rtlHash: string): VerificationScenario {
  const hit = hits.get(item.id)
  let status = hit?.status ?? item.status
  const rtlChanged = Boolean(item.rtlHash && item.rtlHash !== rtlHash)
  const currentEvidence = Boolean(hit && (hit.rtlHash ? hit.rtlHash === rtlHash : !rtlChanged && item.state?.freshness !== 'IMPACT_UNKNOWN'))
  const freshness: ScenarioState['freshness'] = currentEvidence ? 'CURRENT' : rtlChanged ? 'IMPACT_UNKNOWN' : item.state?.freshness ?? 'CURRENT'
  if (freshness !== 'CURRENT' && ['VERIFIED', 'FORMAL_PROVED'].includes(status)) status = 'PARTIAL'
  const evidence = [...new Set(hit?.evidence ?? item.evidence ?? [])]
  const reachCount = hit?.reachCount ?? item.reachCount ?? 0
  const assertionPassed = hit?.assertionPassed ?? item.assertionPassed
  return { ...item, status, state: scenarioState(status, evidence, reachCount, assertionPassed, freshness), rtlHash, evidence, reachCount, assertionPassed, coverageDelta: hit?.coverageDelta ?? item.coverageDelta ?? {}, updatedAt: new Date().toISOString() }
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
 */
function deriveClauseScenarios(requirements: RequirementModel, base: VerificationScenario[], previous: VerificationScenario[], hits: ReturnType<typeof scenarioHits>, structure: StructuralModel): VerificationScenario[] {
  const preliminary = buildSpecMapping(requirements, base.filter((item) => item.origin !== 'CLAUSE_DERIVED'), [])
  const previousById = new Map(previous.filter((item) => item.origin === 'CLAUSE_DERIVED').map((item) => [item.id, item]))
  const requirementById = new Map(requirements.requirements.map((item) => [item.id, item]))
  const candidates: VerificationScenario[] = []
  for (const clause of preliminary.clauses) {
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
  const hits = scenarioHits(workspace)
  const derived = risks.map((risk) => {
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
    const scenario = { id, origin: 'ENGINE_CANDIDATE' as const, wave: deriveWaveForEngineCandidate(nway ? 'formal-candidate' : rule.method), topic: TAXONOMY_TOPICS[risk.taxonomyId], title: `${risk.title}: ${risk.features.join(' × ')}`, riskIds: [risk.id], requirementIds, rtlObjects: [risk.object], features: risk.features, trigger: nway ? risk.features.map((item) => `${item} 在同周期或相邻周期有效`) : rule.trigger, expected: nway ? ['这些共享信号的优先级与更新次数符合规格，无重复累加、丢失或错误裁决'] : rule.expected, method: nway ? 'formal-candidate' as const : rule.method, status, state: scenarioState(status, evidence, reachCount, assertionPassed, freshness), rtlHash: structure.rtlHash, risk: risk.riskScore, interaction: risk.interaction, coverageGap, criticality, confidenceFactor, costFactor, priority, reason: `结构规则 ${risk.taxonomyId} 命中 ${risk.object}；${risk.features.join('、')} 共享控制或时序语义。`, evidence, reachCount, assertionPassed, coverageDelta: hit?.coverageDelta ?? previousItem?.coverageDelta ?? {}, updatedAt: new Date().toISOString() } as VerificationScenario
    scenario.coordinates = coordinatesFor(structure, scenario, risk)
    return scenario
  })
  // AGENT_INTENT 场景以 scenario-registry 为唯一事实源：全量 rebuild 必须把上一轮登记的
  // Agent 意图场景一并重投影（并用最新 hit 证据刷新状态），否则登记结果会在重建时丢失。
  const derivedIds = new Set(derived.map((item) => item.id))
  const preserved = previous.filter((item) => item.origin === 'AGENT_INTENT' && !derivedIds.has(item.id)).map((item) => refreshScenarioWithHits(item, hits, structure.rtlHash))
  // CLAUSE_DERIVED 派生候选不走保留通道：每轮按条款状态重派生（幂等），previous 仅用于状态合并
  const clauseDerived = deriveClauseScenarios(requirements, [...derived, ...preserved], previous, hits, structure)
  return [...derived, ...preserved, ...clauseDerived].sort((a, b) => b.priority - a.priority)
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

function assessClosure(scenarios: VerificationScenario[], regressions: VerificationStateModel['regressions'], formalResults: VerificationStateModel['formalResults'], coverageHoles: CoverageHole[], multiOracle: MultiOracleEvaluation, explorationHistory: ExplorationHistory, mutation: MutationAssessment, residualRiskRegister: ResidualRisk[], uncoveredRiskCandidates: RiskMarker[], specMapping: SpecMappingMatrix): ClosureAssessment {
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
  // 高分风险未被任何 Agent 验证意图锚定仅作提示，不阻断签核（避免门禁口径漂移）
  if (uncoveredRiskCandidates.length) warnings.push(`${uncoveredRiskCandidates.length} 个高分风险候选未被任何验证意图覆盖：${uncoveredRiskCandidates.slice(0, 8).map((item) => item.id).join('、')}${uncoveredRiskCandidates.length > 8 ? ' 等' : ''}`)
  // 无映射可验证规格条款（闭集完备性缺口）：Q2 先 warning 一个版本，NPU 试跑评估准确率后再升级 blocker
  const unmappedClauses = specMapping.clauses.filter((item) => item.status === 'UNMAPPED')
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
    specMapping: { clauseTotal: number; coveredClause: number; blockedBySpecCount: number; unmappedClause: Array<{ specId: string; clause: string }> }
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
      unmappedClause: state.specMapping.clauses.filter((item) => item.status === 'UNMAPPED').slice(0, 10).map((item) => ({ specId: item.clauseId, clause: item.text.slice(0, 120) }))
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
  const moduleVerificationStrategy = buildModuleVerificationStrategy(workspace, structure, risks)
  const fullScenarioModules = new Set(moduleVerificationStrategy.modules.filter((item) => item.level === 'UNIT_FOCUSED' || item.level === 'IP_SIGNOFF').map((item) => item.module))
  const scenarioRisks = risks.filter((risk) => fullScenarioModules.has(risk.object) || [...fullScenarioModules].some((module) => risk.object.startsWith(`${module}.`)))
  const scenarios = buildScenarios(requirements, structure, scenarioRisks, readPrevious(paths.scenarioRegistry), workspace)
  // 契约 §2.1：confirmed 根因挂到对应 scenario.evidence（并进入 signoff package 证据索引）
  const rootCauses = readRootCauses(workspace)
  attachConfirmedRootCauses(scenarios, rootCauses)
  const regressions = collectResults(workspace)
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
  const closureAssessment = assessClosure(scenarios, regressions, formalResults, coverageHoles, multiOracle, explorationHistory, mutationAssessment, residualRiskRegister, uncoveredRiskCandidates, specMapping)
  const waveProgress = buildWaveProgress(scenarios, specMapping, closureAssessment.status)
  const signoffPackage = buildSignoffPackage(structure.rtlHash, verificationSpace, closureAssessment, residualRiskRegister, scenarios, regressions, formalResults, mutationAssessment, rootCauses)
  const statusCounts: VerificationStateModel['statusCounts'] = {}
  for (const scenario of scenarios) statusCounts[scenario.status] = (statusCounts[scenario.status] ?? 0) + 1
  const criticalOpen = scenarios.filter((item) => item.criticality >= 0.8 && !['VERIFIED', 'EXCLUDED', 'WAIVED'].includes(item.state.closure)).map((item) => item.id)
  const structuralSummary = { fsm: structure.stateMachines.length, cfgNodes: structure.controlFlow.nodes.length, dependencies: structure.temporalDependencies.length, cones: structure.conesOfInfluence.length, protocols: structure.protocols.map((item) => ({ protocol: item.protocol, module: item.module })) }
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
    if (!input.anchors?.rtlSignals?.length) reasons.push('必须点名至少一个真实 RTL 信号（rtlSignals）')
    else if (input.anchors.rtlSignals.some((signal) => !signalNames.has(signal))) reasons.push(`rtlSignals 在结构模型中不存在（疑似幻觉信号，必须核对 structural-model.json 后修正）：${input.anchors.rtlSignals.filter((signal) => !signalNames.has(signal)).join('、')}`)
    // 波段声明 + 一致性校验（契约 Q1：防游离标签；规则表 WAVE_ANCHOR_RULES 可扩展）
    const wave: VerificationWave = input.wave ?? 'basic'
    if (input.wave && !WAVE_ORDER.includes(input.wave)) reasons.push(`wave 取值非法：${input.wave}（允许 ${WAVE_ORDER.join('/')}）`)
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
    `- 根因结论必须用 record_root_cause 落盘，不靠提示词纪律`
  )
  return sections.join('\n')
}
