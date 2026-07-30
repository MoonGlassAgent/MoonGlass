/**
 * IPC 通道契约：主进程与渲染进程之间唯一的通信约定。
 * preload 依据本文件暴露类型化 API。
 */

import type {
  AgentEventPayload,
  AgentSessionInfo,
  AgentUiMessage,
  ChipProject,
  FileContentResult,
  FileTreeNode,
  GateCheckResult,
  LlmProviderConfig,
  Phase,
  PhaseAdvanceResult,
  PythonRunRequest,
  PythonRunResult,
  ToolDetection
} from './types/moonglass'

export const IPC = {
  Project: {
    List: 'project:list',
    Create: 'project:create',
    Get: 'project:get',
    Update: 'project:update',
    Delete: 'project:delete'
  },
  Phase: {
    Advance: 'phase:advance',
    Rollback: 'phase:rollback',
    GateCheck: 'phase:gate-check'
  },
  Eda: {
    DetectTools: 'eda:detect-tools'
  },
  Python: {
    Run: 'python:run'
  },
  Llm: {
    List: 'llm:list',
    Upsert: 'llm:upsert',
    Delete: 'llm:delete',
    Test: 'llm:test'
  },
  Agent: {
    EnsureSession: 'agent:ensure-session',
    Prompt: 'agent:prompt',
    Abort: 'agent:abort',
    SetModel: 'agent:set-model',
    GetMessages: 'agent:get-messages',
    ResetSession: 'agent:reset-session',
    /** 主进程 → 渲染进程的事件推送通道（send，非 invoke） */
    Event: 'agent:event',
    ListSessions: 'agent:list-sessions',
    SwitchSession: 'agent:switch-session'
  },
  Fs: {
    Tree: 'fs:tree',
    ReadFile: 'fs:read-file',
    OpenExternal: 'fs:open-external'
  }
} as const

/** preload 暴露给渲染进程的 API 形状 */
export interface MoonGlassApi {
  project: {
    list(): Promise<ChipProject[]>
    create(input: { name: string; description?: string; edaToolchain?: string }): Promise<ChipProject>
    get(id: string): Promise<ChipProject | null>
    update(id: string, patch: Partial<Pick<ChipProject, 'name' | 'description'>>): Promise<ChipProject | null>
    delete(id: string): Promise<boolean>
  }
  phase: {
    /** 推进阶段（先跑门禁检查，Error 级失败则阻断并返回未推进的原状态） */
    advance(projectId: string, to: Phase): Promise<PhaseAdvanceResult | null>
    rollback(projectId: string, to: Phase): Promise<ChipProject | null>
    /** 仅运行门禁检查，不推进阶段。用于修复问题后重新验证 */
    gateCheck(projectId: string, to: Phase): Promise<GateCheckResult[] | null>
  }
  eda: {
    detectTools(): Promise<ToolDetection[]>
  }
  python: {
    run(req: PythonRunRequest): Promise<PythonRunResult>
  }
  llm: {
    list(): Promise<LlmProviderConfig[]>
    upsert(config: LlmProviderConfig): Promise<LlmProviderConfig>
    /** 预置 Provider 不可删除，返回 false */
    delete(id: string): Promise<boolean>
    /** 测试 Provider 的 API Key 是否可用（调用 /models 端点，不消耗 token） */
    test(id: string): Promise<import('./types/moonglass').LlmProviderTestResult>
  }
  agent: {
    /** 确保项目的 Agent 会话就绪（惰性启动 pi 进程；阶段变化时重置会话） */
    ensureSession(projectId: string): Promise<AgentSessionInfo>
    prompt(projectId: string, text: string): Promise<void>
    abort(projectId: string): Promise<void>
    setModel(projectId: string, providerId: string, modelId: string): Promise<AgentSessionInfo>
    getMessages(projectId: string): Promise<AgentUiMessage[]>
    /** 创建平行会话（不关闭当前会话）。name 可选，默认自动生成 review-<时间戳> */
    resetSession(projectId: string, sessionName?: string): Promise<AgentSessionInfo>
    /** 列出项目所有可用会话 */
    listSessions(projectId: string): Promise<Array<{ name: string; file: string; label: string; messageCount: number; isActive: boolean }>>
    /** 切换到指定会话 */
    switchSession(projectId: string, sessionName: string): Promise<AgentSessionInfo>
    /** 订阅流式事件，返回退订函数 */
    onEvent(cb: (payload: AgentEventPayload) => void): () => void
  }
  fs: {
    /** 项目工作目录的文件树 */
    tree(projectId: string): Promise<FileTreeNode[]>
    /** 读取文件内容（相对路径，超限截断；二进制/越界返回 null 或提示） */
    readFile(projectId: string, relPath: string): Promise<FileContentResult | null>
    /** 在系统默认程序中打开文件（如 .html 用浏览器、.xml 用浏览器/编辑器） */
    openExternal(filePath: string): Promise<boolean>
  }
}

declare global {
  interface Window {
    moonglass: MoonGlassApi
  }
}
