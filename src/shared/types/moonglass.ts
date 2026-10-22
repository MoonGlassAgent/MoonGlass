/**
 * MoonGlass 核心领域类型
 *
 * 依据《ChipForge Studio 软件规格说明书》§3.1 / §3.5 独立实现。
 * 本文件是主进程、渲染进程、preload 与 packages 之间共享的类型契约。
 */

// ==================== 阶段定义 ====================

/** 芯片开发 6 阶段 */
export type Phase =
  | 'REQ_SPEC' // 需求-规格定义 (Requirements & Specification)
  | 'ARCH' // 架构设计 (Architecture)
  | 'RTL' // RTL 开发 (RTL Implementation)
  | 'VERIF' // 验证完备 (Verification)
  | 'QA' // 质量检查 (Quality Assurance)
  | 'SYNTH' // 综合实现 (Synthesis)

export const PHASE_ORDER: readonly Phase[] = [
  'REQ_SPEC',
  'ARCH',
  'RTL',
  'VERIF',
  'QA',
  'SYNTH'
] as const

export const PHASE_LABELS: Record<Phase, string> = {
  REQ_SPEC: '需求-规格定义',
  ARCH: '架构设计',
  RTL: 'RTL 开发',
  VERIF: '验证完备',
  QA: '质量检查',
  SYNTH: '综合实现'
}

// ==================== 项目与阶段状态 ====================

export type PhaseStatus = 'locked' | 'active' | 'completed' | 'blocked' | 'skipped'

export type DeliverableType = 'doc' | 'code' | 'script' | 'report' | 'diagram' | 'constraint'

export type DeliverableStatus = 'draft' | 'reviewing' | 'approved' | 'rejected'

export interface Deliverable {
  id: string
  type: DeliverableType
  name: string
  filePath: string
  status: DeliverableStatus
  generatedBy: 'human' | 'agent' | 'hybrid'
  version: number
  gitCommit?: string
}

export interface GateCheckResult {
  checkId: string
  checkName: string
  passed: boolean
  severity: 'error' | 'warning' | 'info'
  message: string
  autoFixable: boolean
  fixedBy?: string
}

export interface AgentContext {
  /** 该阶段 Agent 对话的上下文快照（占位，后续接入 LLM 后细化） */
  summary?: string
  messageCount: number
  lastActiveAt?: string
}

export type PhaseChangeNoticeStatus = 'pending' | 'responded'

/** 阶段变更对后续阶段的影响通知；不删除后续阶段已有产物。 */
export interface PhaseChangeNotice {
  id: string
  sourcePhase: Phase
  reason: string
  changedAt: string
  /** 仅对已经完成并形成结果的后续阶段创建通知。 */
  baselineCompletedAt: string
  status: PhaseChangeNoticeStatus
  respondedAt?: string
  responseNote?: string
}

export interface PhaseState {
  status: PhaseStatus
  deliverables: Deliverable[]
  agentContext: AgentContext
  reviewStatus: 'pending' | 'approved' | 'rejected'
  gateCheckResults: GateCheckResult[]
  startedAt?: string
  completedAt?: string
  skippedAt?: string
  skipReason?: string
  /** 最近一次上游变更通知；pending 时阶段显示黄色感叹号。 */
  changeNotice?: PhaseChangeNotice
}

export interface ChipProject {
  id: string
  name: string
  description?: string
  /** 项目工作目录绝对路径；旧项目缺省时继续使用 MoonGlass 默认 workspace。 */
  workspacePath?: string
  currentPhase: Phase
  phases: Record<Phase, PhaseState>
  gitRepo?: string
  edaToolchain: string
  targetProcess?: string
  targetFrequency?: number
  targetArea?: number
  targetPower?: number
  createdAt: string
  updatedAt: string
}

/** 对外部工程目录的确定性阶段识别结果。 */
export interface ProjectImportAssessment {
  isExistingProject: boolean
  suggestedPhase: Phase
  confidence: number
  fileCount: number
  truncated: boolean
  evidence: Record<Phase, { score: number; paths: string[] }>
  warnings: string[]
}

export interface ProjectMigrationResult {
  project: ChipProject
  sourcePath: string
  destinationPath: string
  copiedFiles: number
  copiedBytes: number
  /** 为避免误删，MoonGlass 迁移成功后保留原目录。 */
  sourceRetained: true
}

// ==================== 门禁规则（§3.1 阶段跳转规则） ====================

export interface GateRule {
  from: Phase
  to: Phase
  /** 前置条件描述（展示用） */
  precondition: string
  /** 自动检查项 ID 列表 */
  autoChecks: string[]
}

/** 阶段推进结果（Phase 3：含门禁检查结果与阻断标记） */
export interface PhaseAdvanceResult {
  /** blocked=true 时为未推进的原项目状态（门禁结果已落库） */
  project: ChipProject
  gate: {
    blocked: boolean
    results: GateCheckResult[]
    /** true 表示门禁未全过但用户确认强制推进（失败项保留为遗留问题） */
    forced?: boolean
  }
}

// ==================== 项目文件树 ====================

/** 文件树节点（path 为相对项目工作目录的路径） */
export interface FileTreeNode {
  name: string
  path: string
  type: 'file' | 'dir'
  children?: FileTreeNode[]
}

/** 读取文件内容的结果（超限截断） */
export interface FileContentResult {
  content: string
  truncated: boolean
}

// ==================== Verilator 覆盖率明细 ====================

/** 单个覆盖率检测点（对应 coverage.dat 的一条 C 记录） */
export interface CoveragePointDetail {
  /** 源码行号（coverage.dat 的 \x01l 字段） */
  line: number
  /** 源码列号（coverage.dat 的 \x01n 字段，可缺失） */
  column?: number
  /** 检测点类型（coverage.dat 的 \x01t 字段） */
  kind: 'line' | 'branch' | 'expr' | 'toggle' | 'fsm_state' | 'fsm_arc'
  /** 检测点语义（coverage.dat 的 \x01o 字段，如 block/if/else，可缺失） */
  origin?: string
  /** 命中次数（0 表示未覆盖） */
  hits: number
  /** 例化层级路径（coverage.dat 的 \x01h 字段，可缺失） */
  hierarchy?: string
}

/** 单个源码文件的覆盖率检测点集合 */
export interface CoverageFileDetail {
  /** 源码文件绝对路径（coverage.dat 的 \x01f 字段） */
  file: string
  points: CoveragePointDetail[]
}

/** Verilator 覆盖率明细解析结果（coverage-detail.json 的形状） */
export interface CoverageDetailResult {
  generatedAt: string
  files: CoverageFileDetail[]
  /** 各类型覆盖率（百分比，与 parseVerilatorCoverage 同口径；无检测点的类型缺失） */
  summary: {
    line?: number
    branch?: number
    expression?: number
    toggle?: number
    fsm?: number
  }
}

// ==================== EDA 工具链（§3.5） ====================

export type SimulatorType = 'verilator' | 'vcs' | 'xcelium'
export type SynthesisType = 'yosys' | 'dc' | 'genus'
export type LintType = 'verible'

export interface ToolchainConfig {
  id: string
  name: string
  simulator?: {
    type: SimulatorType
    path: string
    version?: string
  }
  synthesis?: {
    type: SynthesisType
    path: string
    libraries?: string[]
  }
  lint?: {
    type: LintType
    path: string
    rules?: string
  }
}

/** 工具探测结果 */
export interface ToolDetection {
  tool: string
  found: boolean
  path?: string
  version?: string
  category?: 'runtime' | 'build' | 'eda' | 'verification' | 'physical'
  importance?: 'required' | 'recommended' | 'optional'
  description?: string
  installId?: string
  installUrl?: string
  builtin?: boolean
  source?: 'bundled' | 'managed' | 'system'
  /** 探测到的版本是否落在 MoonGlass 支持范围内（仅对有版本要求的工具如 cocotb 设置；found 不受影响） */
  versionCompatible?: boolean
  /** 版本不兼容时的中文升级指引（主进程/探测侧生成） */
  versionHint?: string
}

export interface ToolInstallResult {
  ok: boolean
  message: string
  path?: string
}

/** 一键安装缺失工具（install-missing 任务）的结果汇总 */
export interface InstallMissingSummary {
  /** 已成功安装的 bundle 展示名 */
  installed: string[]
  /** 安装失败的 bundle（展示名 + 失败原因） */
  failed: Array<{ id: string; message: string }>
  /** 不支持自动安装、需用户手动处理的工具 */
  manualGuidance: Array<{ tool: string; installUrl?: string }>
}

export interface ToolInstallJob {
  id: string
  status: 'idle' | 'running' | 'completed' | 'failed'
  message: string
  path?: string
  startedAt?: string
  finishedAt?: string
  /** 仅 install-missing 编排任务在完成时携带 */
  summary?: InstallMissingSummary
}

export interface WaveformOpenResult {
  ok: boolean
  viewer?: string
  error?: string
}

// ==================== 用户侧环境自检（T6 env doctor） ====================

/** 环境自检单项结果：每项对应一条最小端到端链路（编译/综合/形式验证/仿真） */
export interface EnvSelfCheckItem {
  id: 'icarus' | 'verible' | 'yosys' | 'sby' | 'cocotb'
  passed: boolean
  /** 工具未安装时跳过（passed=false，message 指引安装） */
  skipped?: boolean
  /** 中文明细：成功时的版本号/结论，或失败原因 */
  message: string
  durationMs: number
  /** 失败/跳过时指向对应安装 bundle（'oss-cad-suite' | 'verible' | 'python-cocotb'），UI 据此指引安装入口 */
  installId?: string
}

export interface EnvSelfCheckReport {
  items: EnvSelfCheckItem[]
  passedCount: number
  totalCount: number
  ranAt: string
}

// ==================== 工艺库管理 ====================

export type ProcessLibraryFileKind = 'liberty' | 'lef' | 'gds' | 'verilog' | 'spice' | 'tech' | 'mapping' | 'other'

export interface ProcessLibraryFileSummary {
  kind: ProcessLibraryFileKind
  count: number
  examples: string[]
}

export interface ProcessLibraryRecord {
  id: string
  name: string
  path: string
  source: 'local' | 'downloaded'
  catalogId?: string
  status: 'ready' | 'missing' | 'indexing' | 'error'
  indexedAt?: string
  fileCount: number
  files: ProcessLibraryFileSummary[]
  /** 综合默认使用的 Liberty，由索引器按 typical/工艺库优先级选出。 */
  defaultLibertyPath?: string
  error?: string
}

export interface OpenProcessLibrary {
  id: string
  name: string
  node: string
  description: string
  license: string
  repository: string
  maturity: 'reference' | 'experimental' | 'research'
  installed: boolean
}

// ==================== IP 模板库管理 ====================

export type IpLibrarySource = 'builtin' | 'local'

export type IpLibraryStatus = 'ready' | 'missing' | 'indexing' | 'error'

export type IpLibraryFileKind = 'rtl' | 'verification' | 'document' | 'constraint' | 'script' | 'metadata' | 'other'

export type IpComponentKind = 'rtl-ip' | 'verification-component' | 'mixed' | 'reference'

export interface IpLibraryFileSummary {
  kind: IpLibraryFileKind
  count: number
  examples: string[]
}

export interface IpTemplateRecord {
  id: string
  libraryId: string
  name: string
  type: string
  path: string
  source: IpLibrarySource
  status: 'ready' | 'error'
  topModule?: string
  /** 确定性扫描得到的组件用途，后续可由语义分析补充。 */
  componentKind?: IpComponentKind
  protocols?: string[]
  interfaceRoles?: string[]
  confidence?: number
  analysisSource?: 'deterministic' | 'pi'
  licenseStatus?: 'identified' | 'unknown' | 'restricted'
  summary?: string
  metadataPath?: string
  fileCount: number
  files: IpLibraryFileSummary[]
  rtlFiles: string[]
  verificationFiles: string[]
  documentFiles: string[]
  constraintFiles: string[]
  error?: string
}

export interface IpLibraryRecord {
  id: string
  name: string
  type: string
  path: string
  source: IpLibrarySource
  status: IpLibraryStatus
  importedAt?: string
  indexedAt?: string
  ipCount: number
  fileCount: number
  /** 扫描到但未归入任何候选 IP 的文件数量。 */
  unclassifiedFileCount?: number
  semanticAnalysisStatus?: 'not-run' | 'running' | 'completed' | 'failed'
  semanticAnalyzedAt?: string
  semanticModel?: string
  semanticError?: string
  ips: IpTemplateRecord[]
  error?: string
}

export interface IpLibraryImportInput {
  path: string
  name: string
  type: string
}

// ==================== Python 执行 ====================

export interface PythonRunRequest {
  code: string
  timeoutMs?: number
  cwd?: string
}

export interface PythonRunResult {
  stdout: string
  stderr: string
  exitCode: number | null
  timedOut: boolean
  durationMs: number
}

// ==================== LLM Provider 配置 ====================

/** 请求协议族：openai-compatible 走 /chat/completions 风格，anthropic 走 Messages API */
export type LlmProviderProtocol = 'openai-compatible' | 'anthropic'

export interface LlmProviderConfig {
  /** 预置项用稳定 id（如 'openai'），自定义项用 uuid */
  id: string
  /** 展示名 */
  name: string
  protocol: LlmProviderProtocol
  baseUrl: string
  /** 由主进程使用 Electron safeStorage 加密后存入 userData/moonglass/llm-providers.json */
  apiKey: string
  /** 用户可用的模型 ID 列表（可增删） */
  models: string[]
  /**
   * 随每个 API 请求附加的自定义请求头（可选）。
   * 值中的 `{{sessionId}}` 占位符在注入 pi 时按会话替换为稳定短哈希
   * （见主进程 provider-headers.ts；OpenCode Go 自 2026-09-06 起强制
   * x-opencode-session 会话头，缺失报 400 MissingSessionID）。
   */
  headers?: Record<string, string>
  enabled: boolean
  /** 预置 Provider 不可删除（字段可改） */
  builtin: boolean
}

/** Provider 连接测试结果 */
export interface LlmModelTestResult {
  model: string
  status: 'pass' | 'fail' | 'unknown'
  message: string
}

export interface LlmProviderTestResult {
  ok: boolean
  /** 状态码或错误码 */
  status?: number
  /** 错误信息 */
  error?: string
  /** 实际探测的模型列表端点 */
  endpoint?: string
  /** Provider 返回的可用模型数量 */
  availableModelCount?: number
  /** 用户配置的每个模型是否存在于 Provider 返回列表 */
  models: LlmModelTestResult[]
}

/** 阶段产物漂移条目：库记录显示该阶段已完成，但其全部产物路径已从磁盘消失。 */
export interface ArtifactDriftEntry {
  phase: Phase
  /** 已不存在的产物相对路径（相对项目工作目录） */
  missingPaths: string[]
}

export type PhaseResetMode = 'archive' | 'purge'

export interface PhaseResetPreview {
  phase: Phase
  mode: PhaseResetMode
  paths: string[]
  fileCount: number
  totalBytes: number
  downstreamAffected: Phase[]
  archivePath?: string
}

export interface PhaseResetResult extends PhaseResetPreview {
  project: ChipProject
}

// ==================== Agent 对话（Phase 2：Pi Coding Agent RPC 嵌入） ====================

export interface AgentDecisionOption {
  id: string
  label: string
  description?: string
  recommended?: boolean
}

export interface AgentDecisionRequest {
  id: string
  title: string
  prompt?: string
  mode: 'single' | 'multiple'
  options: AgentDecisionOption[]
  allowCustom: boolean
  customLabel?: string
  required: boolean
}

export interface AgentDecisionResponse {
  requestId: string
  selectedIds: string[]
  customText?: string
}

/** 随消息附带的图片（data 为裸 base64，非 data URL） */
export interface ImageAttachment {
  mimeType: string
  data: string
}

/** 渲染端展示用的消息（由 pi 的 AgentMessage 映射简化而来） */
export interface AgentUiMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  /** 随消息附带的图片（用户贴图发送或 pi 侧图片内容块） */
  images?: ImageAttachment[]
  toolName?: string
  toolCallId?: string
  /** 工具调用参数的格式化 JSON。 */
  toolInput?: string
  isError?: boolean
  timestamp: number
  /** 模型的思考过程（reasoning content） */
  thinking?: string
  decisionRequest?: AgentDecisionRequest
  decisionResponse?: AgentDecisionResponse
  /** 一条用户消息批量提交的全部决策回复。 */
  decisionResponses?: AgentDecisionResponse[]
}

/** 主进程推送给渲染端的流式事件（pi 原始事件的简化映射） */
export type AgentStreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'thinking-delta'; delta: string }
  | { type: 'tool-start'; toolName: string; toolCallId: string; input?: string }
  | { type: 'tool-update'; toolName: string; toolCallId: string; text: string }
  | { type: 'tool-end'; toolName: string; toolCallId: string; isError: boolean; output: string; decisionRequest?: AgentDecisionRequest }
  | { type: 'agent-start' }
  | { type: 'agent-settled' }
  | { type: 'status'; message: string }
  | { type: 'error'; message: string }

/** agent:event 推送负载 */
export interface AgentEventPayload {
  projectId: string
  /** 事件来源会话的逻辑名（如 phase-rtl）；渲染层据此把流式事件路由到对应会话的聊天面板 */
  sessionName?: string
  event: AgentStreamEvent
}

/** 会话信息（ensureSession 返回） */
export interface AgentSessionInfo {
  projectId: string
  phase: Phase
  /** 当前 Agent 会话名：main 为主会话，其余为平行会话 */
  sessionName: string
  isStreaming: boolean
  /** 当前模型展示名，如 "deepseek / deepseek-chat"；未选择时为空串 */
  modelLabel: string
  /** 当前选中的模型（结构化，供下拉框使用） */
  selectedModel: { providerId: string; modelId: string } | null
  /** 是否存在已启用且配置了 API Key 的 Provider */
  providersReady: boolean
  /** 切走后仍在后台执行的阶段列表（阶段栏据此显示运行标记） */
  backgroundRunningPhases?: Phase[]
}

/** 单个项目的会话活动聚合（AgentService.sessionActivity 返回，项目卡片徽标据此渲染） */
export interface ProjectSessionActivity {
  /** 项目存在存活会话（前台或后台）；仅有上轮中断标记而无存活会话时也会出现在聚合结果中（hasSession 为 false） */
  hasSession: boolean
  /** 任一会话正在流式执行（进行中） */
  running: boolean
  /** 进行中的会话展示名列表（卡片 tooltip 用） */
  runningSessions: string[]
  /** 上一轮被应用退出中断的会话展示名（启动时一次性消费，本轮保留；无则省略） */
  interrupted?: string[]
  /** 待用户处理项（会话待确认决策 + 循环待裁决提案）；无时省略 */
  pendingActions?: ProjectPendingActions
}

/** 项目级"待人处理"聚合（项目卡片通知徽标的数据源） */
export interface ProjectPendingActions {
  /** 会话内待确认决策数（DecisionCard 未答复） */
  decisionRequests: number
  /** 验证运行循环待裁决提案数（decision-ledger.json status=proposed） */
  loopDecisions: number
  /** 待处理项标题（卡片 tooltip 用，前几条） */
  titles: string[]
}

/** VERIF 批次完成判定（上下文治理第 3 批，决策 4：绑定工具登记证据，不读会话文本） */
export interface VerifBatchVerdict {
  /**
   * 批次会话契约是否完成：全部场景有登记，且态势在批次开始后重建。
   * 语义边界——complete ≠ 场景通过 ≠ 验证进展 ≠ 签核；它只说明本批会话按约定交付了登记与态势。
   */
  complete: boolean
  /** 未在任何 verification/results/&#42;&#42;/scenario_hits.json 中登记的场景 ID */
  missingScenarioIds: string[]
  /**
   * 本批窗口内取得登记的场景（本批新增执行证据）。与 replayedScenarioIds 互补；旧数据可能缺失。
   */
  freshScenarioIds?: string[]
  /**
   * 仅有早于本批开始的登记的场景：本批未产生新的执行证据，只是重放了历史登记。
   * 这是"空转批次"的可观测信号，供展示层与进展判定使用；旧数据可能缺失。
   */
  replayedScenarioIds?: string[]
  /** verification-posture.json 的 generatedAt；不存在或不可解析为 null */
  postureGeneratedAt: string | null
  /** posture 是否晚于批次开始时间 */
  postureFresh: boolean
  /** 结构化缺失说明（供熔断报告与展示层） */
  reasons: string[]
}

/** VERIF 批次编排的单次批次结果（主进程 AgentService.runVerifBatch 返回） */
export interface VerifBatchRunResult {
  batchIndex: number
  /** 批次平行会话逻辑名（phase-verif--batch-N） */
  sessionName: string
  scenarioIds: string[]
  startedAt: string
  finishedAt: string
  /**
   * completed=证据齐；circuit-broken=熔断（会话异常 / watchdog / 证据缺失 / 诊断停滞）；
   * no-evidence=会话正常 settle 但无执行证据（场景无需执行 / 会话纯分析，属合法出口而非故障，
   * 循环内记入 verif-batch-loop.json 的 deferredScenarioIds 延后重选，不熔断停止循环）；
   * error=批次派发异常
   */
  status: 'completed' | 'circuit-broken' | 'no-evidence' | 'error'
  verdict: VerifBatchVerdict
  /** 熔断原因（watchdog / diagnostic-control 无进展 / 证据缺失 / 会话异常）；no-evidence 时为 null */
  circuitBreaker: string | null
  errorMessage: string | null
  /** 批次会话 JSONL 的归档文件路径；延迟归档下仅当该批次超出保留窗口被真正归档时才有值 */
  archivedTo: string | null
  /** 批次会话 JSONL 保留在会话目录中供只读回看（archivedTo 为 null 且会话文件存在时为 true） */
  keptForReview: boolean
}

/** VERIF 批次编排循环结果（AgentService.runVerifBatches 返回） */
export interface VerifBatchLoopResult {
  batches: VerifBatchRunResult[]
  /** exhausted=队列耗尽正常结束；circuit-break=批次熔断停止后续批次；max-batches=达到批次上限；error=编排异常；user-stop=用户停止托管 */
  stoppedBy: 'exhausted' | 'circuit-break' | 'max-batches' | 'error' | 'user-stop'
  message: string
}

// ==================== 验证运行循环（VERIF-RUN-LOOP 批 2，设计文档 §4/§6/§9.1） ====================

/** 外层循环状态机 11 态（设计文档 §4.1；idle=未运行，planning=W0 无态势规划，running/judging 为执行与证据判定，repairing=修复门控挂起） */
export type VerifRunLoopState =
  | 'idle'
  | 'planning'
  | 'running'
  | 'judging'
  | 'repairing'
  | 'paused-human'
  | 'paused-breaker'
  | 'signoff-review'
  | 'gate-check'
  | 'completed'
  | 'stopped'

/** 波段（waveProgress 首个 in-progress 条目；无则 null） */
export type VerifRunWave = 'W0' | 'W1' | 'W2' | 'W3'

/** 当前拍已派发的动作（无则 null） */
export interface VerifRunLoopCurrent {
  kind: string
  actionId: string | null
  sessionName: string
  dispatchedAt: string
  /** 决策来源徽标（批 3 起规则/LLM/工程师三源均有值；升级会话为 'llm'） */
  source: 'rule' | 'llm' | 'human'
  /** 决策账本条目 ID（批 3 decision-ledger 接入后回填；规则自动拍为其 rule-auto 记录 id） */
  decisionId: string
}

/** 暂停结构化记录（§5.1 暂停即落盘；kind=human 待人处置，kind=breaker 熔断待人处置） */
export interface VerifRunLoopPause {
  kind: 'human' | 'breaker'
  reason: string
  detail: string
  pendingItems: string[]
  since: string
}

/** 预算水位（§6：循环步数/token/墙钟；连续无进展步数由 lastBeats 前导 advanced=false 计数推导） */
export interface VerifRunLoopBudget {
  beats: number
  maxBeats: number
  tokensUsed: number
  maxTokens: number
  startedAt: string
  maxWallMinutes: number
  /** 连续无进展步数熔断阈值（入账本：继续时不再丢回默认值；旧账本缺失按默认解释） */
  noProgressLimit?: number
  /** 墙钟累计基数（分钟）：手动继续开窗重置前滚入的历史时长；墙钟预算比较的是当前窗口（now - startedAt） */
  wallResetBase?: number
}

/** 最近拍摘要（新在前，滚动 ≤20 条） */
export interface VerifRunLoopBeatEntry {
  beat: number
  summary: string
  decisionId: string
  verdict: string
  advanced: boolean
}

/** 收口计划（战略层数据面，规则算战略：纯函数推导、LLM 不参与计算）。
 *  W1 收口四判据（clauses-covered/no-open-failures/no-pending-repairs/signoff-regression）；
 *  W2/W3 本期只留 wave 与空 criteria（totalCount 0），不展开。 */
export interface VerifRunClosurePlan {
  /** 目标波段（无在跑波段时按 W1 收口口径预估） */
  wave: string
  /** 当前运行策略（确定性触发器评估；deep-dive 攻坚派发本期不实现，只留标记与账本） */
  strategy: 'normal' | 'converge-first' | 'deep-dive' | 'steady-regression'
  /** 当前策略生效时刻（ISO）；同策略不重复切换，切换时刷新 */
  strategySince: string
  criteria: Array<{ id: string; met: boolean }>
  metCount: number
  totalCount: number
}

/** 进展预测（战略层数据面，确定性纯函数产出；展示时带"样本不足"降权，不假精确）。 */
export interface RunLoopForecast {
  /** 当前已闭环条款（specClauseCovered 口径）；无条款数据为 null */
  covered: number | null
  /** 条款总数；无条款数据为 null */
  total: number | null
  /** 自循环启动的平均闭环速率（条款/小时）；运行 ≤0.5h 或无条款数据为 null */
  ratePerHour: number | null
  /** 近 ≤10 步 advanced=true 比例 0-1（无拍记录 → 0） */
  recentAdvanceRatio: number
  /** 预计剩余闭环时长区间（小时）；数据不足或速率为 0 → null */
  etaHours: { low: number; high: number } | null
  /** 按当前速率，各维度预算耗尽前能走完的条款数；任一度量数据不足 → 整体 null */
  budgetProjection: {
    steps: { projectedClauses: number }
    tokens: { projectedClauses: number }
    wallMinutes: { projectedClauses: number }
  } | null
  /** 预算约束判定：任一度量投影 < 剩余条款 → insufficient；余量 <20% → tight；无速率数据 → unknown */
  binding: 'sufficient' | 'tight' | 'insufficient' | 'unknown'
  /** 置信度：步数 ≥5 且近 ≤10 步有进展 → medium，否则 low */
  confidence: 'low' | 'medium'
}

/** 覆盖式循环账本（verification/results/run-loop.json，§9.1；原子写 + 缺字段归一） */
export interface VerifRunLoopLedger {
  version: 1
  updatedAt: string
  /** 代际标记：每次启动生成新 id；残留（僵尸）循环苏醒时 id 不符即静默退出、禁止写账 */
  loopId: string
  state: VerifRunLoopState
  wave: VerifRunWave | null
  beat: number
  current: VerifRunLoopCurrent | null
  pause: VerifRunLoopPause | null
  budget: VerifRunLoopBudget
  lastBeats: VerifRunLoopBeatEntry[]
  /** 收口计划（可选字段：战略层每拍重算尽力落盘；旧账本缺失按无计划处理） */
  closurePlan?: VerifRunClosurePlan
  /** 进展预测（可选字段：与 closurePlan 同拍重算尽力落盘；旧账本缺失按无预测处理） */
  forecast?: RunLoopForecast
}

/** 启动选项（均可选；缺省见主进程 verif-run-loop.ts 的 DEFAULT_*，§13 待决策 2 实测后调） */
export interface VerifRunLoopStartOptions {
  maxBeats?: number
  maxTokens?: number
  maxWallMinutes?: number
  noProgressLimit?: number
}

// ==================== 验证运行循环决策账本（VERIF-RUN-LOOP 批 3，设计文档 §3.2/§3.3/§9.2） ====================

/** 决策来源：规则自动 / LLM 提案 / 工程师指令（§3.3 工程师决策不审批，直接 approved） */
export type VerifRunDecisionSource = 'rule' | 'llm' | 'human'

/** 决策登记触发（§9.2 trigger 口径；rule-auto=规则层每拍自动记账，user-instruction=工程师在会话中明确指示；
 *  strategy-switch=战略层运行策略切换记账（规则自动，source 恒为 'rule'）） */
export type VerifRunDecisionTrigger = 'rule-auto' | 'rule-stall' | 'breaker-recovery' | 'user-instruction' | 'manual-override' | 'strategy-switch'

/** 决策动作形态：derived=引用推导内核已知动作 id（需规则层白名单校验）；custom=自由指令（actionId 恒为 null） */
export interface VerifRunDecisionAction {
  kind: 'derived' | 'custom'
  /** derived 时为推导内核已知动作 id（src/shared/verification-guidance 的 VERIFICATION_DERIVED_ACTION_IDS）；custom 时为 null */
  actionId: string | null
  prompt: string
  /** 期望产出（合法性校验：approved 前必须非空；规则自动记录允许空串） */
  expectedOutput: string
  /** 停止条件（同 expectedOutput 口径） */
  stopCriteria: string
}

/** 决策生命周期：proposed=待人审批（顾问模式默认）→ approved/rejected → executed=已派发执行 → superseded=被取代 */
export type VerifRunDecisionStatus = 'proposed' | 'approved' | 'rejected' | 'executed' | 'superseded'

/** 执行结果回填（按证据裁决：拍判定 advanced/no-progress；会话异常记 failed；未执行恒为 null） */
export type VerifRunDecisionOutcome = 'advanced' | 'no-progress' | 'failed' | null

/** 决策账本条目（id=DEC-<8hex>；追加式，新在前，滚动 ≤100 条） */
export interface VerifRunDecision {
  id: string
  createdAt: string
  source: VerifRunDecisionSource
  trigger: string
  action: VerifRunDecisionAction
  /** ≤200 字 */
  rationale: string
  /** 证据锚点（相对工作区的账本/证据文件路径） */
  evidenceRefs: string[]
  /**
   * 给工程师的 IP 行为语言摘要（可选字段，旧账本数据缺此字段照常归一）：
   * 哪个信号/寄存器/场景、实测到了什么、与规格哪里不符、需要工程师裁决什么；
   * 归一化时 >300 字截断到 300（不报错）。
   */
  humanSummary?: string
  status: VerifRunDecisionStatus
  outcome: VerifRunDecisionOutcome
}

/** 追加式决策账本（verification/results/decision-ledger.json，§9.2；原子写 + 缺字段归一 + ≤100 截断） */
export interface VerifRunDecisionLedger {
  version: 1
  decisions: VerifRunDecision[]
}

/** 波段进度条目（W1-W3，展示层契约，引擎侧生产；W0 冒烟已废弃，旧快照可能仍含 W0 条目，渲染端需容错） */
export interface WaveProgressEntry {
  id: 'W0' | 'W1' | 'W2' | 'W3'
  label: string
  status: 'done' | 'in-progress' | 'pending'
  scenarioCount: number
  passedCount: number
  /** W1 专用：可验证规格条款总数 / 已覆盖数 */
  specClauseTotal?: number
  specClauseCovered?: number
  /** W1 专用：曾通过但证据陈旧（待回归）的条款数；引擎透出，区别于从未验证 */
  stalePassedCount?: number
  /** W2 专用：增补波主题列表 */
  topics?: Array<{ name: string; scenarioCount: number; passedCount: number }>
}

/** 规格映射完备性矩阵（展示层契约，引擎侧生产） */
export interface SpecMapping {
  clauseTotal: number
  coveredClause: number
  /** 曾通过但证据陈旧（待回归）的条款数（引擎透出，区别于从未验证） */
  stalePassedCount?: number
  /** 文档性条款数（不参与完备性分母） */
  documentaryCount?: number
  /** 无映射条款（execution-summary 精简形状） */
  unmappedClause?: Array<{ specId: string; clause: string }>
  /** 全量条款映射（posture/state 完整形状，状态机 UNMAPPED/MAPPED_UNTESTED/PASSED/FAILED/WAIVED） */
  clauses?: Array<{ clauseId: string; parentId: string; text: string; status: string; intentIds: string[]; scenarioIds: string[]; evidence: string[]; channel?: string; stalePassed?: boolean }>
}

/** Pi 当前会话累计用量；不同 Provider 可能省略费用或上下文估算。 */
export interface AgentSessionStats {  sessionId?: string
  userMessages: number
  assistantMessages: number
  toolCalls: number
  totalMessages: number
  tokens: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
  cost?: number
  contextWindowStatus?: 'verified' | 'estimated' | 'custom' | 'unknown'
  contextWindowSource?: string
  /** 用户为当前模型自定义的上下文上限（Token）；存在时优先于登记表与回退值 */
  contextWindowOverride?: number
  contextUsage?: {
    tokens: number | null
    contextWindow: number
    percent: number | null
  }
}

/** 验证用例执行结果（操作级，来自 JUnit XML） */
export interface VerificationExecutedCase {
  /** 关联的 TEST ID（如 TEST-RESET-001）；未能映射到规划清单时为空串 */
  testId: string
  /** Cocotb 测试函数名（如 test_reset_sync_smoke） */
  testName: string
  /** 所属模块/测试环境目录名（如 vbc_enc_tb） */
  module: string
  status: 'PASS' | 'FAIL' | 'SKIPPED' | 'ERROR'
  /** FAIL/ERROR 视为发现疑似 Bug */
  bugFound: boolean
  errorMessage?: string
  /** 场景级阻断标签（来自 scenario_hits.json 的 blocker，如 RTL_L2_*） */
  blocker?: string
  /** BUG-VERIF-BIND-001：该执行记录对应的场景 ID（scenario_hits 来源行才有） */
  scenarioId?: string
  /** BUG-VERIF-BIND-001：批次级绑定用例（scenarioIds 路径登记的运行用例集合；精确单用例在 testName） */
  boundTestcases?: string[]
  timeSec?: number
}

/** 规划中的验证用例（来自 test_plan.md 或测试文件函数清单） */
export interface VerificationPlannedCase {
  testId: string
  tcId: string
  priority: string
  name: string
  environment: string
}

/** 验证环境与用例执行状态（操作级视图，区别于 AIGV 场景级态势） */
export interface VerificationRunStatus {
  environment: {
    ready: boolean
    testbenches: string[]
    missing: string[]
  }
  planned: VerificationPlannedCase[]
  executed: VerificationExecutedCase[]
  /** test_plan.md 缺少标准表头（首列 TEST ID）时的提示；渲染端展示以代替静默列错位 */
  headerWarning?: string
  summary: {
    planned: number
    executed: number
    passed: number
    failed: number
    skipped: number
    notRun: number
    bugsFound: number
  }
}
