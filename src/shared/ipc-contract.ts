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
  IpLibraryImportInput,
  IpLibraryRecord,
  LlmProviderConfig,
  Phase,
  PhaseAdvanceResult,
  ProjectMigrationResult,
  PythonRunRequest,
  PythonRunResult,
  ToolDetection,
  ToolInstallJob,
  ToolInstallResult,
  WaveformOpenResult
} from './types/moonglass'
import type { OpenProcessLibrary, ProcessLibraryRecord } from './types/moonglass'
import type { DesignDatabase } from '@moonglass/design-browser-engine'

export const IPC = {
  Project: {
    List: 'project:list',
    Create: 'project:create',
    ChooseDirectory: 'project:choose-directory',
    Get: 'project:get',
    Update: 'project:update',
    Delete: 'project:delete',
    Migrate: 'project:migrate',
    GenerateDashboard: 'project:generate-dashboard'
  },
  Phase: {
    Advance: 'phase:advance',
    Enter: 'phase:enter',
    Rollback: 'phase:rollback',
    GateCheck: 'phase:gate-check',
    AcknowledgeChange: 'phase:acknowledge-change',
    FastTrackSynthesis: 'phase:fast-track-synthesis',
    CompleteProject: 'phase:complete-project'
  },
  Eda: {
    DetectTools: 'eda:detect-tools',
    InstallBundle: 'eda:install-bundle',
    GetInstallStatus: 'eda:get-install-status',
    OpenInstallPage: 'eda:open-install-page',
    OpenWaveform: 'eda:open-waveform'
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
    SwitchSession: 'agent:switch-session',
    CloseSession: 'agent:close-session'
  },
  Fs: {
    Tree: 'fs:tree',
    ReadFile: 'fs:read-file',
    OpenExternal: 'fs:open-external'
  },
  ProcessLibrary: {
    List: 'process-library:list',
    Catalog: 'process-library:catalog',
    ChooseAndAdd: 'process-library:choose-and-add',
    Download: 'process-library:download',
    Reindex: 'process-library:reindex',
    Remove: 'process-library:remove',
    OpenFolder: 'process-library:open-folder'
  },
  IpLibrary: {
    List: 'ip-library:list',
    ChooseDirectory: 'ip-library:choose-directory',
    AddLocal: 'ip-library:add-local',
    Reindex: 'ip-library:reindex',
    Enhance: 'ip-library:enhance',
    Remove: 'ip-library:remove',
    OpenFolder: 'ip-library:open-folder'
  },
  DesignBrowser: {
    ListTops: 'design-browser:list-tops',
    Elaborate: 'design-browser:elaborate',
    GetCached: 'design-browser:get-cached',
    ReadSource: 'design-browser:read-source'
  }
} as const

/** preload 暴露给渲染进程的 API 形状 */
export interface MoonGlassApi {
  project: {
    list(): Promise<ChipProject[]>
    create(input: { name: string; description?: string; edaToolchain?: string; workspacePath?: string }): Promise<ChipProject>
    chooseDirectory(): Promise<string | null>
    get(id: string): Promise<ChipProject | null>
    update(id: string, patch: Partial<Pick<ChipProject, 'name' | 'description'>>): Promise<ChipProject | null>
    delete(id: string): Promise<boolean>
    migrate(id: string, destinationPath: string): Promise<ProjectMigrationResult>
    generateDashboard(id: string): Promise<{ path: string; generatedAt: string; opened: boolean }>
  }
  phase: {
    /** 推进阶段（先跑门禁检查，Error 级失败则阻断并返回未推进的原状态；
     *  force=true 时复用已落库的门禁结果并强制推进，失败项保留为遗留问题） */
    advance(projectId: string, to: Phase, options?: { force?: boolean }): Promise<PhaseAdvanceResult | null>
    /** 双击阶段节点进入阶段，不删除或锁定后续阶段产物。 */
    enter(projectId: string, to: Phase): Promise<ChipProject | null>
    rollback(projectId: string, to: Phase): Promise<ChipProject | null>
    /** 仅运行门禁检查，不推进阶段。用于修复问题后重新验证 */
    gateCheck(projectId: string, to: Phase): Promise<GateCheckResult[] | null>
    /** 完成指定阶段对上游变更的响应。 */
    acknowledgeChange(projectId: string, phase: Phase, responseNote?: string): Promise<ChipProject | null>
    /** 用户明确跳过 VERIF/QA，直接进入仅用于快速面积评估的综合阶段 */
    fastTrackSynthesis(projectId: string): Promise<ChipProject | null>
    /** 完成最终综合阶段并将项目标记为完成 */
    completeProject(projectId: string): Promise<ChipProject | null>
  }
  eda: {
    /** 默认返回持久缓存；force=true 时重新扫描开发环境和 EDA 工具。 */
    detectTools(force?: boolean): Promise<ToolDetection[]>
    installBundle(id: string): Promise<ToolInstallJob>
    getInstallStatus(id: string): Promise<ToolInstallJob>
    openInstallPage(url: string): Promise<boolean>
    /** 使用 GTKWave 打开项目内的 VCD/FST 波形文件 */
    openWaveform(projectId: string, relPath: string): Promise<WaveformOpenResult>
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
    /** 测试当前表单配置，不要求预先保存 */
    test(config: LlmProviderConfig): Promise<import('./types/moonglass').LlmProviderTestResult>
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
    listSessions(projectId: string): Promise<Array<{
      name: string
      file: string
      label: string
      messageCount: number
      modelLabel: string
      selectedModel: { providerId: string; modelId: string } | null
      isActive: boolean
    }>>
    /** 切换到指定会话 */
    switchSession(projectId: string, sessionName: string): Promise<AgentSessionInfo>
    /** 关闭并删除平行会话；主会话不可关闭 */
    closeSession(projectId: string, sessionName: string): Promise<AgentSessionInfo>
    /** 订阅流式事件，返回退订函数 */
    onEvent(cb: (payload: AgentEventPayload) => void): () => void
  }
  fs: {
    /** 项目工作目录的文件树 */
    tree(projectId: string): Promise<FileTreeNode[]>
    /** 读取文件内容（相对路径，超限截断；二进制/越界返回 null 或提示） */
    readFile(projectId: string, relPath: string): Promise<FileContentResult | null>
    /** 在系统默认程序中打开文件（如 .html 用浏览器、.xml 用浏览器/编辑器） */
    /** 在系统浏览器/默认程序中打开项目文件；路径必须相对项目工作区。 */
    openExternal(projectId: string, relPath: string): Promise<boolean>
  }
  processLibrary: {
    list(): Promise<ProcessLibraryRecord[]>
    catalog(): Promise<OpenProcessLibrary[]>
    chooseAndAdd(): Promise<ProcessLibraryRecord | null>
    download(catalogId: string): Promise<ProcessLibraryRecord>
    reindex(id: string): Promise<ProcessLibraryRecord>
    remove(id: string): Promise<boolean>
    openFolder(id: string): Promise<boolean>
  }
  ipLibrary: {
    list(): Promise<IpLibraryRecord[]>
    chooseDirectory(): Promise<string | null>
    addLocal(input: IpLibraryImportInput): Promise<IpLibraryRecord>
    reindex(id: string): Promise<IpLibraryRecord>
    enhance(id: string): Promise<IpLibraryRecord>
    remove(id: string): Promise<boolean>
    openFolder(id: string): Promise<boolean>
  }
  designBrowser: {
    listTops(projectId: string): Promise<Array<{
      name: string
      file: string
      recommended: boolean
      reason: 'manifest' | 'root-module' | 'candidate'
    }>>
    elaborate(projectId: string, topModule: string): Promise<DesignDatabase>
    getCached(projectId: string): Promise<DesignDatabase | null>
    readSource(projectId: string, source: string): Promise<{ file: string; line: number; content: string }>
  }
}

declare global {
  interface Window {
    moonglass: MoonGlassApi
  }
}
