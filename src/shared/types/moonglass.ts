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
}

export interface ToolInstallResult {
  ok: boolean
  message: string
  path?: string
}

export interface ToolInstallJob {
  id: string
  status: 'idle' | 'running' | 'completed' | 'failed'
  message: string
  path?: string
  startedAt?: string
  finishedAt?: string
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
}

/** 主进程推送给渲染端的流式事件（pi 原始事件的简化映射） */
export type AgentStreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'thinking-delta'; delta: string }
  | { type: 'tool-start'; toolName: string; toolCallId: string; input?: string }
  | { type: 'tool-end'; toolName: string; toolCallId: string; isError: boolean; output: string; decisionRequest?: AgentDecisionRequest }
  | { type: 'agent-start' }
  | { type: 'agent-settled' }
  | { type: 'error'; message: string }

/** agent:event 推送负载 */
export interface AgentEventPayload {
  projectId: string
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
}
