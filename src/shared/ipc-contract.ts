/**
 * IPC 通道契约：主进程与渲染进程之间唯一的通信约定。
 * preload 依据本文件暴露类型化 API。
 */

import type {
  AgentEventPayload,
  AgentSessionInfo,
  AgentSessionStats,
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
  PhaseResetMode,
  PhaseResetPreview,
  PhaseResetResult,
  PythonRunRequest,
  PythonRunResult,
  ToolDetection,
  ToolInstallJob,
  ToolInstallResult,
  VerifBatchLoopResult,
  VerifBatchRunResult,
  WaveformOpenResult
} from './types/moonglass'
import type { OpenProcessLibrary, ProcessLibraryRecord } from './types/moonglass'
import type { DesignDatabase } from '@moonglass/design-browser-engine'

export const IPC = {
  Ui: {
    SetColorMode: 'ui:set-color-mode'
  },
  Project: {
    List: 'project:list',
    Create: 'project:create',
    AnalyzeDirectory: 'project:analyze-directory',
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
    CompleteProject: 'phase:complete-project',
    PreviewReset: 'phase:preview-reset',
    Reset: 'phase:reset'
  },
  Eda: {
    DetectTools: 'eda:detect-tools',
    InstallBundle: 'eda:install-bundle',
    /** 一键安装全部缺失的可自动安装工具（编排任务，固定 id 'install-missing'） */
    InstallMissing: 'eda:install-missing',
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
    /** 只读窥视指定会话的消息（解析会话 JSONL，不 attach / 不切换 / 不 spawn） */
    GetSessionMessages: 'agent:get-session-messages',
    GetSessionStats: 'agent:get-session-stats',
    SetContextWindowOverride: 'agent:set-context-window-override',
    ResetSession: 'agent:reset-session',
    /** 开启任务粒度会话（M1）：新会话零历史继承，会话头带 parentSession 血缘 */
    StartTask: 'agent:start-task',
    CompactSession: 'agent:compact-session',
    RestartSessionFresh: 'agent:restart-session-fresh',
    /** 主进程 → 渲染进程的事件推送通道（send，非 invoke） */
    Event: 'agent:event',
    ListSessions: 'agent:list-sessions',
    SwitchSession: 'agent:switch-session',
    CloseSession: 'agent:close-session',
    /** VERIF 批次编排（第 3 批）：单个批次 / 循环派发 */
    RunVerifBatch: 'agent:run-verif-batch',
    RunVerifBatches: 'agent:run-verif-batches',
    StopVerifBatches: 'agent:stop-verif-batches'
  },
  Fs: {
    Tree: 'fs:tree',
    ReadFile: 'fs:read-file',
    ReadJson: 'fs:read-json',
    WriteText: 'fs:write-text',
    OpenExternal: 'fs:open-external',
    VerificationStatus: 'fs:verification-status'
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
  ui: {
    setColorMode(mode: 'light' | 'dark' | 'system'): Promise<void>
  }
  project: {
    list(): Promise<ChipProject[]>
    create(input: { name: string; description?: string; edaToolchain?: string; workspacePath?: string; initialPhase?: Phase }): Promise<ChipProject>
    analyzeDirectory(path: string): Promise<import('./types/moonglass').ProjectImportAssessment>
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
    previewReset(projectId: string, phase: Phase, mode: PhaseResetMode): Promise<PhaseResetPreview>
    reset(projectId: string, phase: Phase, mode: PhaseResetMode): Promise<PhaseResetResult>
  }
  eda: {
    /** 默认返回持久缓存；force=true 时重新扫描开发环境和 EDA 工具。 */
    detectTools(force?: boolean): Promise<ToolDetection[]>
    installBundle(id: string): Promise<ToolInstallJob>
    /** 一键安装缺失工具：立即返回编排任务（固定 id 'install-missing'），用 getInstallStatus 轮询 */
    installMissing(): Promise<ToolInstallJob>
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
    /** 只读窥视指定会话的消息（后台批次会话实时活动 / 历史批次回看）；会话不存在返回空数组 */
    getSessionMessages(projectId: string, sessionName: string): Promise<AgentUiMessage[]>
    /** 当前活动会话的 Token、费用和上下文窗口统计。 */
    getSessionStats(projectId: string): Promise<AgentSessionStats | null>
    /** 为当前会话所选模型自定义上下文窗口上限（Token，null 恢复自动判定）；按模型持久化，跨项目生效 */
    setContextWindowOverride(projectId: string, contextWindow: number | null): Promise<void>
    /** 创建平行会话（不关闭当前会话）。name 可选，默认自动生成 review-<时间戳> */
    resetSession(projectId: string, sessionName?: string): Promise<AgentSessionInfo>
    /** 开启任务粒度会话（M1）：成为前台会话，零历史继承，血缘指向前会话；
     *  title 为任务标题（生成 slug 与展示标签），firstPrompt 用于无标题时的 slug 兜底 */
    startTask(projectId: string, input?: { title?: string; firstPrompt?: string }): Promise<AgentSessionInfo>
    /** 使用 Pi 原生 compact 压缩当前上下文，保留关键摘要和会话文件。 */
    compactSession(projectId: string): Promise<AgentSessionInfo>
    /** 归档当前历史并以空白 session 重启；保留标签和模型，不携带旧上下文。 */
    restartSessionFresh(projectId: string): Promise<AgentSessionInfo>
    /** 列出项目所有可用会话 */
    listSessions(projectId: string): Promise<Array<{
      name: string
      file: string
      label: string
      messageCount: number
      modelLabel: string
      selectedModel: { providerId: string; modelId: string } | null
      isActive: boolean
      /** 会话进程仍在后台运行（如 VERIF 批次会话）；UI 据此区分"运行中可刷新"与"历史可回看" */
      isRunning: boolean
    }>>
    /** 切换到指定会话 */
    switchSession(projectId: string, sessionName: string): Promise<AgentSessionInfo>
    /** 关闭并删除平行会话；主会话不可关闭 */
    closeSession(projectId: string, sessionName: string): Promise<AgentSessionInfo>
    /** VERIF 批次编排（第 3 批）：派发单个批次会话执行指定场景，返回证据绑定的完成判定 */
    runVerifBatch(projectId: string, scenarioIds: string[], options?: { batchIndex?: number }): Promise<VerifBatchRunResult>
    /** VERIF 批次编排（第 3 批）：循环“选择下一批 → 派发批次会话”直至队列耗尽或熔断 */
    runVerifBatches(projectId: string, options?: { batchSize?: number; maxBatches?: number }): Promise<VerifBatchLoopResult>
    /** 停止 VERIF 批次编排：中止进行中的批次会话并不再派发新批次 */
    stopVerifBatches(projectId: string): Promise<void>
    /** 订阅流式事件，返回退订函数 */
    onEvent(cb: (payload: AgentEventPayload) => void): () => void
  }
  fs: {
    /** 项目工作目录的文件树 */
    tree(projectId: string): Promise<FileTreeNode[]>
    /** 读取文件内容（相对路径，超限截断；二进制/越界返回 null 或提示） */
    readFile(projectId: string, relPath: string): Promise<FileContentResult | null>
    /** 完整读取并在主进程解析项目内 JSON；供结构化数据视图使用，不走文件预览截断。 */
    readJson(projectId: string, relPath: string): Promise<unknown | null>
    /** 在项目工作区内写入 UTF-8 文本，用于托管报告和变更单。 */
    writeText(projectId: string, relPath: string, content: string): Promise<boolean>
    /** 读取验证环境与用例执行状态（环境是否搭建、已执行/未完成用例及 pass/fail）。 */
    verificationStatus(projectId: string): Promise<import('./types/moonglass').VerificationRunStatus>
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
