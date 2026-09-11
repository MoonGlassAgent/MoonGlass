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

/** 渲染端展示用的消息（由 pi 的 AgentMessage 映射简化而来） */
export interface AgentUiMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
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

/** VERIF 批次完成判定（上下文治理第 3 批，决策 4：绑定工具登记证据，不读会话文本） */
export interface VerifBatchVerdict {
  /** 全齐：所有场景已登记 scenario_hits 且 posture 晚于批次开始 */
  complete: boolean
  /** 未在任何 verification/results/&#42;&#42;/scenario_hits.json 中登记的场景 ID */
  missingScenarioIds: string[]
  /** verification-posture.json 的 generatedAt；不存在或不可解析为 null */
  postureGeneratedAt: string | null
  /** posture 是否晚于批次开始时间 */
  postureFresh: boolean
  /** 结构化缺失说明（供熔断报告） */
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
  status: 'completed' | 'circuit-broken' | 'error'
  verdict: VerifBatchVerdict
  /** 熔断原因（watchdog / diagnostic-control 无进展 / 证据缺失 / 会话异常） */
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

/** 波段进度条目（W0-W3，展示层契约，引擎侧生产） */
export interface WaveProgressEntry {
  id: 'W0' | 'W1' | 'W2' | 'W3'
  label: string
  status: 'done' | 'in-progress' | 'pending'
  scenarioCount: number
  passedCount: number
  /** W1 专用：可验证规格条款总数 / 已覆盖数 */
  specClauseTotal?: number
  specClauseCovered?: number
  /** W2 专用：增补波主题列表 */
  topics?: Array<{ name: string; scenarioCount: number; passedCount: number }>
}

/** 规格映射完备性矩阵（展示层契约，引擎侧生产） */
export interface SpecMapping {
  clauseTotal: number
  coveredClause: number
  /** 文档性条款数（不参与完备性分母） */
  documentaryCount?: number
  /** 无映射条款（execution-summary 精简形状） */
  unmappedClause?: Array<{ specId: string; clause: string }>
  /** 全量条款映射（posture/state 完整形状，状态机 UNMAPPED/MAPPED_UNTESTED/PASSED/FAILED/WAIVED） */
  clauses?: Array<{ clauseId: string; parentId: string; text: string; status: string; intentIds: string[]; scenarioIds: string[]; evidence: string[]; channel?: string }>
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
