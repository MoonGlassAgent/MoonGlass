/**
 * MoonGlass 核心领域类型
 *
 * 依据《ChipForge Studio 软件规格说明书》§3.1 / §3.5 独立实现。
 * 本文件是主进程、渲染进程、preload 与 packages 之间共享的类型契约。
 */

// ==================== 阶段定义 ====================

/** 芯片开发 7 阶段 */
export type Phase =
  | 'REQ' // 需求定义 (Requirements)
  | 'SPEC' // 规格定义 (Specification)
  | 'ARCH' // 架构设计 (Architecture)
  | 'RTL' // RTL 开发 (RTL Implementation)
  | 'VERIF' // 验证完备 (Verification)
  | 'QA' // 质量检查 (Quality Assurance)
  | 'SYNTH' // 综合实现 (Synthesis)

export const PHASE_ORDER: readonly Phase[] = [
  'REQ',
  'SPEC',
  'ARCH',
  'RTL',
  'VERIF',
  'QA',
  'SYNTH'
] as const

export const PHASE_LABELS: Record<Phase, string> = {
  REQ: '需求定义',
  SPEC: '规格定义',
  ARCH: '架构设计',
  RTL: 'RTL 开发',
  VERIF: '验证完备',
  QA: '质量检查',
  SYNTH: '综合实现'
}

// ==================== 项目与阶段状态 ====================

export type PhaseStatus = 'locked' | 'active' | 'completed' | 'blocked'

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

export interface PhaseState {
  status: PhaseStatus
  deliverables: Deliverable[]
  agentContext: AgentContext
  reviewStatus: 'pending' | 'approved' | 'rejected'
  gateCheckResults: GateCheckResult[]
  startedAt?: string
  completedAt?: string
}

export interface ChipProject {
  id: string
  name: string
  description?: string
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
  /** 骨架期明文存本地 JSON（userData/moonglass/llm-providers.json）；TODO(Phase 2): 迁移 electron safeStorage 加密 */
  apiKey: string
  /** 用户可用的模型 ID 列表（可增删） */
  models: string[]
  enabled: boolean
  /** 预置 Provider 不可删除（字段可改） */
  builtin: boolean
}

// ==================== Agent 对话（Phase 2：Pi Coding Agent RPC 嵌入） ====================

/** 渲染端展示用的消息（由 pi 的 AgentMessage 映射简化而来） */
export interface AgentUiMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  toolName?: string
  isError?: boolean
  timestamp: number
  /** 模型的思考过程（reasoning content） */
  thinking?: string
}

/** 主进程推送给渲染端的流式事件（pi 原始事件的简化映射） */
export type AgentStreamEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'thinking-delta'; delta: string }
  | { type: 'tool-start'; toolName: string; toolCallId: string }
  | { type: 'tool-end'; toolName: string; toolCallId: string; isError: boolean; output: string }
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
  isStreaming: boolean
  /** 当前模型展示名，如 "deepseek / deepseek-chat"；未选择时为空串 */
  modelLabel: string
  /** 当前选中的模型（结构化，供下拉框使用） */
  selectedModel: { providerId: string; modelId: string } | null
  /** 是否存在已启用且配置了 API Key 的 Provider */
  providersReady: boolean
}
