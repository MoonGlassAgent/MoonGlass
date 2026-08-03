/**
 * Preload：以 contextBridge 暴露类型化的 window.moonglass API。
 * 通道名统一取自 shared/ipc-contract.ts，禁止硬编码字符串。
 */

import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type MoonGlassApi } from '@shared/ipc-contract'
import type { AgentEventPayload, LlmProviderConfig, Phase, PythonRunRequest } from '@shared/types'

const api: MoonGlassApi = {
  project: {
    list: () => ipcRenderer.invoke(IPC.Project.List),
    create: (input) => ipcRenderer.invoke(IPC.Project.Create, input),
    get: (id) => ipcRenderer.invoke(IPC.Project.Get, id),
    update: (id, patch) => ipcRenderer.invoke(IPC.Project.Update, id, patch),
    delete: (id) => ipcRenderer.invoke(IPC.Project.Delete, id),
    generateDashboard: (id) => ipcRenderer.invoke(IPC.Project.GenerateDashboard, id)
  },
  phase: {
    advance: (projectId: string, to: Phase) => ipcRenderer.invoke(IPC.Phase.Advance, projectId, to),
    rollback: (projectId: string, to: Phase) => ipcRenderer.invoke(IPC.Phase.Rollback, projectId, to),
    gateCheck: (projectId: string, to: Phase) => ipcRenderer.invoke(IPC.Phase.GateCheck, projectId, to),
    fastTrackSynthesis: (projectId: string) => ipcRenderer.invoke(IPC.Phase.FastTrackSynthesis, projectId),
    completeProject: (projectId: string) => ipcRenderer.invoke(IPC.Phase.CompleteProject, projectId)
  },
  eda: {
    detectTools: () => ipcRenderer.invoke(IPC.Eda.DetectTools),
    installBundle: (id: string) => ipcRenderer.invoke(IPC.Eda.InstallBundle, id),
    openInstallPage: (url: string) => ipcRenderer.invoke(IPC.Eda.OpenInstallPage, url),
    openWaveform: (projectId: string, relPath: string) =>
      ipcRenderer.invoke(IPC.Eda.OpenWaveform, projectId, relPath)
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
    prompt: (projectId: string, text: string) =>
      ipcRenderer.invoke(IPC.Agent.Prompt, projectId, text),
    abort: (projectId: string) => ipcRenderer.invoke(IPC.Agent.Abort, projectId),
    setModel: (projectId: string, providerId: string, modelId: string) =>
      ipcRenderer.invoke(IPC.Agent.SetModel, projectId, providerId, modelId),
    getMessages: (projectId: string) => ipcRenderer.invoke(IPC.Agent.GetMessages, projectId),
    resetSession: (projectId: string, sessionName?: string) => ipcRenderer.invoke(IPC.Agent.ResetSession, projectId, sessionName),
    listSessions: (projectId: string) => ipcRenderer.invoke(IPC.Agent.ListSessions, projectId),
    switchSession: (projectId: string, sessionName: string) => ipcRenderer.invoke(IPC.Agent.SwitchSession, projectId, sessionName),
    closeSession: (projectId: string, sessionName: string) => ipcRenderer.invoke(IPC.Agent.CloseSession, projectId, sessionName),
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
    openExternal: (projectId: string, relPath: string) => ipcRenderer.invoke(IPC.Fs.OpenExternal, projectId, relPath)
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
