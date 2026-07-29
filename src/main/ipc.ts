/**
 * IPC 通信注册中心
 *
 * 依据 shared/ipc-contract.ts 的通道契约注册全部 handler。
 */

import { ipcMain } from 'electron'
import { IPC } from '@shared/ipc-contract'
import type { LlmProviderConfig, Phase, PythonRunRequest } from '@shared/types'
import type { ApplicationServices } from './core/application'

export function registerIpcHandlers(services: ApplicationServices): void {
  const { projects, phaseEngine, python, eda, llm, agent } = services

  // ==================== 项目 ====================
  ipcMain.handle(IPC.Project.List, () => projects.list())

  ipcMain.handle(
    IPC.Project.Create,
    (_e, input: { name: string; description?: string; edaToolchain?: string }) =>
      projects.create(input)
  )

  ipcMain.handle(IPC.Project.Get, (_e, id: string) => projects.get(id))

  ipcMain.handle(
    IPC.Project.Update,
    (_e, id: string, patch: { name?: string; description?: string }) => projects.update(id, patch)
  )

  ipcMain.handle(IPC.Project.Delete, (_e, id: string) => projects.delete(id))

  // ==================== 阶段流转 ====================
  ipcMain.handle(IPC.Phase.Advance, (_e, projectId: string, to: Phase) => {
    const project = projects.get(projectId)
    if (!project) return null
    // 运行门禁检查（骨架阶段默认放行，结果落库供 UI 展示）
    project.phases[project.currentPhase].gateCheckResults = phaseEngine.runGateChecks(project, to)
    return projects.save(phaseEngine.advance(project, to))
  })

  ipcMain.handle(IPC.Phase.Rollback, (_e, projectId: string, to: Phase) => {
    const project = projects.get(projectId)
    if (!project) return null
    return projects.save(phaseEngine.rollback(project, to))
  })

  // ==================== EDA ====================
  ipcMain.handle(IPC.Eda.DetectTools, () => eda.detectTools())

  // ==================== Python ====================
  ipcMain.handle(IPC.Python.Run, (_e, req: PythonRunRequest) => python.run(req))

  // ==================== LLM Provider 配置 ====================
  ipcMain.handle(IPC.Llm.List, () => llm.list())

  ipcMain.handle(IPC.Llm.Upsert, (_e, config: LlmProviderConfig) => llm.upsert(config))

  ipcMain.handle(IPC.Llm.Delete, (_e, id: string) => llm.delete(id))

  // ==================== Agent 对话 ====================
  ipcMain.handle(IPC.Agent.EnsureSession, (_e, projectId: string) => agent.ensureSession(projectId))

  ipcMain.handle(IPC.Agent.Prompt, (_e, projectId: string, text: string) =>
    agent.prompt(projectId, text)
  )

  ipcMain.handle(IPC.Agent.Abort, (_e, projectId: string) => agent.abort(projectId))

  ipcMain.handle(
    IPC.Agent.SetModel,
    (_e, projectId: string, providerId: string, modelId: string) =>
      agent.setModel(projectId, providerId, modelId)
  )

  ipcMain.handle(IPC.Agent.GetMessages, (_e, projectId: string) => agent.getMessages(projectId))
}
