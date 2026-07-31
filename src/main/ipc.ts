/**
 * IPC 通信注册中心
 *
 * 依据 shared/ipc-contract.ts 的通道契约注册全部 handler。
 */

import { ipcMain, shell } from 'electron'
import { IPC } from '@shared/ipc-contract'
import type { LlmProviderConfig, Phase, PythonRunRequest } from '@shared/types'
import type { ApplicationServices } from './core/application'
import { projectWorkspaceDir } from './core/paths'
import { generateProjectDashboard } from './services/ProjectDashboardService'

export function registerIpcHandlers(services: ApplicationServices): void {
  const { projects, phaseEngine, python, eda, llm, agent, files, designBrowser } = services

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

  ipcMain.handle(IPC.Project.GenerateDashboard, async (_e, id: string) => {
    const project = projects.get(id)
    if (!project) throw new Error(`项目不存在: ${id}`)
    const result = generateProjectDashboard(project, projectWorkspaceDir(id))
    const openError = await shell.openPath(result.path)
    return { ...result, opened: openError === '' }
  })

  // ==================== 阶段流转 ====================
  ipcMain.handle(IPC.Phase.Advance, async (_e, projectId: string, to: Phase) => {
    const project = projects.get(projectId)
    if (!project) return null
    // 运行门禁检查（Error 级失败阻断推进；结果落库供 UI 展示）
    const results = await phaseEngine.runGateChecks(project, to, {
      workspaceDir: projectWorkspaceDir(projectId)
    })
    project.phases[project.currentPhase].gateCheckResults = results
    if (phaseEngine.isBlocked(results)) {
      return { project: projects.save(project), gate: { blocked: true, results } }
    }
    return { project: projects.save(phaseEngine.advance(project, to)), gate: { blocked: false, results } }
  })

  ipcMain.handle(IPC.Phase.Rollback, (_e, projectId: string, to: Phase) => {
    const project = projects.get(projectId)
    if (!project) return null
    return projects.save(phaseEngine.rollback(project, to))
  })

  ipcMain.handle(IPC.Phase.FastTrackSynthesis, (_e, projectId: string) => {
    const project = projects.get(projectId)
    if (!project) return null
    return projects.save(phaseEngine.fastTrackSynthesis(project))
  })

  ipcMain.handle(IPC.Phase.CompleteProject, (_e, projectId: string) => {
    const project = projects.get(projectId)
    if (!project) return null
    return projects.save(phaseEngine.completeProject(project))
  })

  // 仅运行门禁检查（不推进阶段），供「重新检查」按钮使用
  ipcMain.handle(IPC.Phase.GateCheck, async (_e, projectId: string, to: Phase) => {
    const project = projects.get(projectId)
    if (!project) return null
    const results = await phaseEngine.runGateChecks(project, to, {
      workspaceDir: projectWorkspaceDir(projectId)
    })
    // 结果落库供展示
    project.phases[project.currentPhase].gateCheckResults = results
    projects.save(project)
    return results
  })

  // ==================== EDA ====================
  ipcMain.handle(IPC.Eda.DetectTools, () => eda.detectTools())
  ipcMain.handle(IPC.Eda.OpenWaveform, (_e, projectId: string, relPath: string) =>
    eda.openWaveform(projectId, relPath)
  )

  // ==================== Python ====================
  ipcMain.handle(IPC.Python.Run, (_e, req: PythonRunRequest) => python.run(req))

  // ==================== LLM Provider 配置 ====================
  ipcMain.handle(IPC.Llm.List, () => llm.list())

  ipcMain.handle(IPC.Llm.Upsert, (_e, config: LlmProviderConfig) => llm.upsert(config))

  ipcMain.handle(IPC.Llm.Delete, (_e, id: string) => llm.delete(id))

  ipcMain.handle(IPC.Llm.Test, (_e, config: LlmProviderConfig) => llm.test(config))

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

  ipcMain.handle(IPC.Agent.ResetSession, (_e, projectId: string, sessionName?: string) =>
    agent.resetSession(projectId, sessionName)
  )

  ipcMain.handle(IPC.Agent.ListSessions, (_e, projectId: string) => agent.listSessions(projectId))

  ipcMain.handle(IPC.Agent.SwitchSession, (_e, projectId: string, sessionName: string) =>
    agent.switchSession(projectId, sessionName)
  )
  ipcMain.handle(IPC.Agent.CloseSession, (_e, projectId: string, sessionName: string) =>
    agent.closeSession(projectId, sessionName)
  )

  // ==================== 项目文件 ====================
  ipcMain.handle(IPC.Fs.Tree, (_e, projectId: string) => files.tree(projectId))

  ipcMain.handle(IPC.Fs.ReadFile, (_e, projectId: string, relPath: string) =>
    files.readFile(projectId, relPath)
  )

  ipcMain.handle(IPC.Fs.OpenExternal, async (_e, filePath: string) => {
    try {
      await shell.openPath(filePath)
      return true
    } catch {
      return false
    }
  })

  // ==================== RTL Design Browser ====================
  ipcMain.handle(IPC.DesignBrowser.ListTops, (_e, projectId: string) =>
    designBrowser.listTopModules(projectWorkspaceDir(projectId))
  )
  ipcMain.handle(IPC.DesignBrowser.Elaborate, (_e, projectId: string, topModule: string) =>
    designBrowser.elaborate(projectId, projectWorkspaceDir(projectId), topModule)
  )
  ipcMain.handle(IPC.DesignBrowser.GetCached, (_e, projectId: string) =>
    designBrowser.getCached(projectId)
  )
  ipcMain.handle(IPC.DesignBrowser.ReadSource, (_e, projectId: string, source: string) =>
    designBrowser.readSource(projectWorkspaceDir(projectId), source)
  )
}
