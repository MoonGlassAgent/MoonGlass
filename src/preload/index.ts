/**
 * Preload：以 contextBridge 暴露类型化的 window.moonglass API。
 * 通道名统一取自 shared/ipc-contract.ts，禁止硬编码字符串。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type MoonGlassApi } from '@shared/ipc-contract'
import type { AgentEventPayload, ImageAttachment, IpLibraryImportInput, LlmProviderConfig, Phase, PhaseResetMode, PythonRunRequest, VerifRunLoopStartOptions } from '@shared/types'

const api: MoonGlassApi = {
  ui: {
    setColorMode: (mode) => ipcRenderer.invoke(IPC.Ui.SetColorMode, mode)
  },
  project: {
    list: () => ipcRenderer.invoke(IPC.Project.List),
    create: (input) => ipcRenderer.invoke(IPC.Project.Create, input),
    analyzeDirectory: (path) => ipcRenderer.invoke(IPC.Project.AnalyzeDirectory, path),
    chooseDirectory: () => ipcRenderer.invoke(IPC.Project.ChooseDirectory),
    get: (id) => ipcRenderer.invoke(IPC.Project.Get, id),
    update: (id, patch) => ipcRenderer.invoke(IPC.Project.Update, id, patch),
    delete: (id) => ipcRenderer.invoke(IPC.Project.Delete, id),
    migrate: (id, destinationPath) => ipcRenderer.invoke(IPC.Project.Migrate, id, destinationPath),
    generateDashboard: (id) => ipcRenderer.invoke(IPC.Project.GenerateDashboard, id),
    reconcileArtifacts: (projectId) => ipcRenderer.invoke(IPC.Project.ReconcileArtifacts, projectId)
  },
  phase: {
    advance: (projectId: string, to: Phase, options?: { force?: boolean }) =>
      ipcRenderer.invoke(IPC.Phase.Advance, projectId, to, options),
    enter: (projectId: string, to: Phase) => ipcRenderer.invoke(IPC.Phase.Enter, projectId, to),
    rollback: (projectId: string, to: Phase) => ipcRenderer.invoke(IPC.Phase.Rollback, projectId, to),
    gateCheck: (projectId: string, to: Phase) => ipcRenderer.invoke(IPC.Phase.GateCheck, projectId, to),
    acknowledgeChange: (projectId: string, phase: Phase, responseNote?: string) =>
      ipcRenderer.invoke(IPC.Phase.AcknowledgeChange, projectId, phase, responseNote),
    fastTrackSynthesis: (projectId: string) => ipcRenderer.invoke(IPC.Phase.FastTrackSynthesis, projectId),
    completeProject: (projectId: string) => ipcRenderer.invoke(IPC.Phase.CompleteProject, projectId),
    previewReset: (projectId: string, phase: Phase, mode: PhaseResetMode) =>
      ipcRenderer.invoke(IPC.Phase.PreviewReset, projectId, phase, mode),
    reset: (projectId: string, phase: Phase, mode: PhaseResetMode, options?: { resetDownstream?: boolean }) =>
      ipcRenderer.invoke(IPC.Phase.Reset, projectId, phase, mode, options)
  },
  eda: {
    detectTools: (force?: boolean) => ipcRenderer.invoke(IPC.Eda.DetectTools, force),
    installBundle: (id: string) => ipcRenderer.invoke(IPC.Eda.InstallBundle, id),
    installMissing: () => ipcRenderer.invoke(IPC.Eda.InstallMissing),
    getInstallStatus: (id: string) => ipcRenderer.invoke(IPC.Eda.GetInstallStatus, id),
    openInstallPage: (url: string) => ipcRenderer.invoke(IPC.Eda.OpenInstallPage, url),
    openWaveform: (projectId: string, relPath: string) =>
      ipcRenderer.invoke(IPC.Eda.OpenWaveform, projectId, relPath),
    runEnvironmentSelfCheck: () => ipcRenderer.invoke(IPC.Eda.SelfCheck)
  },
  processLibrary: {
    list: () => ipcRenderer.invoke(IPC.ProcessLibrary.List),
    catalog: () => ipcRenderer.invoke(IPC.ProcessLibrary.Catalog),
    chooseAndAdd: () => ipcRenderer.invoke(IPC.ProcessLibrary.ChooseAndAdd),
    download: (catalogId: string) => ipcRenderer.invoke(IPC.ProcessLibrary.Download, catalogId),
    reindex: (id: string) => ipcRenderer.invoke(IPC.ProcessLibrary.Reindex, id),
    remove: (id: string) => ipcRenderer.invoke(IPC.ProcessLibrary.Remove, id),
    openFolder: (id: string) => ipcRenderer.invoke(IPC.ProcessLibrary.OpenFolder, id)
  },
  ipLibrary: {
    list: () => ipcRenderer.invoke(IPC.IpLibrary.List),
    chooseDirectory: () => ipcRenderer.invoke(IPC.IpLibrary.ChooseDirectory),
    addLocal: (input: IpLibraryImportInput) => ipcRenderer.invoke(IPC.IpLibrary.AddLocal, input),
    reindex: (id: string) => ipcRenderer.invoke(IPC.IpLibrary.Reindex, id),
    enhance: (id: string) => ipcRenderer.invoke(IPC.IpLibrary.Enhance, id),
    remove: (id: string) => ipcRenderer.invoke(IPC.IpLibrary.Remove, id),
    openFolder: (id: string) => ipcRenderer.invoke(IPC.IpLibrary.OpenFolder, id)
  },
  python: {
    run: (req: PythonRunRequest) => ipcRenderer.invoke(IPC.Python.Run, req)
  },
  llm: {
    list: () => ipcRenderer.invoke(IPC.Llm.List),
    upsert: (config: LlmProviderConfig) => ipcRenderer.invoke(IPC.Llm.Upsert, config),
    delete: (id: string) => ipcRenderer.invoke(IPC.Llm.Delete, id),
    test: (config: LlmProviderConfig) => ipcRenderer.invoke(IPC.Llm.Test, config)
  },
  agent: {
    ensureSession: (projectId: string) => ipcRenderer.invoke(IPC.Agent.EnsureSession, projectId),
    prompt: (projectId: string, text: string, images?: ImageAttachment[]) =>
      ipcRenderer.invoke(IPC.Agent.Prompt, projectId, text, images),
    abort: (projectId: string) => ipcRenderer.invoke(IPC.Agent.Abort, projectId),
    setModel: (projectId: string, providerId: string, modelId: string) =>
      ipcRenderer.invoke(IPC.Agent.SetModel, projectId, providerId, modelId),
    getMessages: (projectId: string) => ipcRenderer.invoke(IPC.Agent.GetMessages, projectId),
    getSessionMessages: (projectId: string, sessionName: string) =>
      ipcRenderer.invoke(IPC.Agent.GetSessionMessages, projectId, sessionName),
    getSessionStats: (projectId: string) => ipcRenderer.invoke(IPC.Agent.GetSessionStats, projectId),
    getSessionActivity: () => ipcRenderer.invoke(IPC.Agent.GetSessionActivity),
    setContextWindowOverride: (projectId: string, contextWindow: number | null) =>
      ipcRenderer.invoke(IPC.Agent.SetContextWindowOverride, projectId, contextWindow),
    resetSession: (projectId: string, sessionName?: string) => ipcRenderer.invoke(IPC.Agent.ResetSession, projectId, sessionName),
    startTask: (projectId: string, input?: { title?: string; firstPrompt?: string }) =>
      ipcRenderer.invoke(IPC.Agent.StartTask, projectId, input),
    compactSession: (projectId: string) => ipcRenderer.invoke(IPC.Agent.CompactSession, projectId),
    restartSessionFresh: (projectId: string) => ipcRenderer.invoke(IPC.Agent.RestartSessionFresh, projectId),
    listSessions: (projectId: string) => ipcRenderer.invoke(IPC.Agent.ListSessions, projectId),
    switchSession: (projectId: string, sessionName: string) => ipcRenderer.invoke(IPC.Agent.SwitchSession, projectId, sessionName),
    closeSession: (projectId: string, sessionName: string) => ipcRenderer.invoke(IPC.Agent.CloseSession, projectId, sessionName),
    runVerifBatch: (projectId: string, scenarioIds: string[], options?: { batchIndex?: number }) =>
      ipcRenderer.invoke(IPC.Agent.RunVerifBatch, projectId, scenarioIds, options),
    runVerifBatches: (projectId: string, options?: { batchSize?: number; maxBatches?: number }) =>
      ipcRenderer.invoke(IPC.Agent.RunVerifBatches, projectId, options),
    stopVerifBatches: (projectId: string) => ipcRenderer.invoke(IPC.Agent.StopVerifBatches, projectId),
    startVerifRunLoop: (projectId: string, options?: VerifRunLoopStartOptions) =>
      ipcRenderer.invoke(IPC.Agent.StartVerifRunLoop, projectId, options),
    pauseVerifRunLoop: (projectId: string) => ipcRenderer.invoke(IPC.Agent.PauseVerifRunLoop, projectId),
    resumeVerifRunLoop: (projectId: string, options?: VerifRunLoopStartOptions) => ipcRenderer.invoke(IPC.Agent.ResumeVerifRunLoop, projectId, options),
    stopVerifRunLoop: (projectId: string) => ipcRenderer.invoke(IPC.Agent.StopVerifRunLoop, projectId),
    decideVerifRunDecision: (projectId: string, decisionId: string, verdict: 'approved' | 'rejected', editedPrompt?: string) =>
      ipcRenderer.invoke(IPC.Agent.DecideVerifRunDecision, projectId, decisionId, verdict, editedPrompt),
    onEvent: (cb: (payload: AgentEventPayload) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: AgentEventPayload): void =>
        cb(payload)
      ipcRenderer.on(IPC.Agent.Event, listener)
      return () => ipcRenderer.removeListener(IPC.Agent.Event, listener)
    }
  },
  fs: {
    tree: (projectId: string) => ipcRenderer.invoke(IPC.Fs.Tree, projectId),
    readFile: (projectId: string, relPath: string) =>
      ipcRenderer.invoke(IPC.Fs.ReadFile, projectId, relPath),
    readJson: (projectId: string, relPath: string) =>
      ipcRenderer.invoke(IPC.Fs.ReadJson, projectId, relPath),
    writeText: (projectId: string, relPath: string, content: string) =>
      ipcRenderer.invoke(IPC.Fs.WriteText, projectId, relPath, content),
    verificationStatus: (projectId: string) => ipcRenderer.invoke(IPC.Fs.VerificationStatus, projectId),
    verificationWorkbench: (projectId: string) => ipcRenderer.invoke(IPC.Fs.VerificationWorkbench, projectId),
    openExternal: (projectId: string, relPath: string) => ipcRenderer.invoke(IPC.Fs.OpenExternal, projectId, relPath),
    watchVerification: (projectId: string) => ipcRenderer.invoke(IPC.Fs.WatchVerification, projectId),
    unwatchVerification: (projectId: string) => ipcRenderer.invoke(IPC.Fs.UnwatchVerification, projectId),
    onVerificationChanged: (cb: (payload: { projectId: string }) => void) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: { projectId: string }): void =>
        cb(payload)
      ipcRenderer.on(IPC.Fs.VerificationChanged, listener)
      return () => ipcRenderer.removeListener(IPC.Fs.VerificationChanged, listener)
    }
  },
  coverage: {
    detail: (projectId: string, relResultDir: string) => ipcRenderer.invoke(IPC.Coverage.Detail, projectId, relResultDir)
  },
  designBrowser: {
    listTops: (projectId: string) => ipcRenderer.invoke(IPC.DesignBrowser.ListTops, projectId),
    elaborate: (projectId: string, topModule: string) =>
      ipcRenderer.invoke(IPC.DesignBrowser.Elaborate, projectId, topModule),
    getCached: (projectId: string) => ipcRenderer.invoke(IPC.DesignBrowser.GetCached, projectId),
    readSource: (projectId: string, source: string) =>
      ipcRenderer.invoke(IPC.DesignBrowser.ReadSource, projectId, source)
  }
}

contextBridge.exposeInMainWorld('moonglass', api)
