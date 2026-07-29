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
    Delete: 'llm:delete'
  },
  Agent: {
    EnsureSession: 'agent:ensure-session',
    Prompt: 'agent:prompt',
    Abort: 'agent:abort',
    SetModel: 'agent:set-model',
    GetMessages: 'agent:get-messages',
    ResetSession: 'agent:reset-session',
    /** 主进程 → 渲染进程的事件推送通道（send，非 invoke） */
    Event: 'agent:event'
  },
  Fs: {
    Tree: 'fs:tree',
    ReadFile: 'fs:read-file'
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
  }
  agent: {
    /** 确保项目的 Agent 会话就绪（惰性启动 pi 进程；阶段变化时重置会话） */
    ensureSession(projectId: string): Promise<AgentSessionInfo>
    prompt(projectId: string, text: string): Promise<void>
    abort(projectId: string): Promise<void>
    setModel(projectId: string, providerId: string, modelId: string): Promise<AgentSessionInfo>
    getMessages(projectId: string): Promise<AgentUiMessage[]>
    /** 新会话：不继承原对话（原会话归档为 session.bak.jsonl） */
    resetSession(projectId: string): Promise<AgentSessionInfo>
    /** 订阅流式事件，返回退订函数 */
    onEvent(cb: (payload: AgentEventPayload) => void): () => void
  }
  fs: {
    /** 项目工作目录的文件树 */
    tree(projectId: string): Promise<FileTreeNode[]>
    /** 读取文件内容（相对路径，超限截断；二进制/越界返回 null 或提示） */
    readFile(projectId: string, relPath: string): Promise<FileContentResult | null>
  }
}

declare global {
  interface Window {
    moonglass: MoonGlassApi
  }
}
