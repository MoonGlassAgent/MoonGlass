/**
 * IPC 通信注册中心
 *
 * 依据 shared/ipc-contract.ts 的通道契约注册全部 handler。
 */

import { BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { IPC } from '@shared/ipc-contract'
import type { IpLibraryImportInput, LlmProviderConfig, Phase, PythonRunRequest } from '@shared/types'
import type { ApplicationServices } from './core/application'
import { pathToFileURL } from 'node:url'
import { generateProjectDashboard } from './services/ProjectDashboardService'

export function registerIpcHandlers(services: ApplicationServices): void {
  const { projects, phaseEngine, python, eda, llm, agent, files, designBrowser, processLibraries, ipLibraries } = services
  const ipEnhancementJobs = new Map<string, Promise<Awaited<ReturnType<typeof ipLibraries.applySemanticAnalysis>>>>()

  ipcMain.handle(IPC.Ui.SetColorMode, (event, mode: 'light' | 'dark' | 'system') => {
    nativeTheme.themeSource = mode
    const owner = BrowserWindow.fromWebContents(event.sender)
    owner?.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#111316' : '#f4f5f7')
  })

  // ==================== 项目 ====================
  ipcMain.handle(IPC.Project.List, () => projects.list())

  ipcMain.handle(
    IPC.Project.Create,
    (_e, input: { name: string; description?: string; edaToolchain?: string; workspacePath?: string; initialPhase?: Phase }) =>
      projects.create(input)
  )

  ipcMain.handle(IPC.Project.AnalyzeDirectory, (_e, path: string) => projects.analyzeDirectory(path))

  ipcMain.handle(IPC.Project.ChooseDirectory, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner
      ? await dialog.showOpenDialog(owner, {
          title: '选择项目工作目录',
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          title: '选择项目工作目录',
          properties: ['openDirectory', 'createDirectory']
        })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.Project.Get, (_e, id: string) => projects.get(id))

  ipcMain.handle(
    IPC.Project.Update,
    (_e, id: string, patch: { name?: string; description?: string }) => projects.update(id, patch)
  )

  ipcMain.handle(IPC.Project.Delete, (_e, id: string) => projects.delete(id))

  ipcMain.handle(IPC.Project.Migrate, async (_e, id: string, destinationPath: string) => {
    return projects.migrate(id, destinationPath, () => agent.prepareProjectMigration(id))
  })

  ipcMain.handle(IPC.Project.GenerateDashboard, async (_e, id: string) => {
    const project = projects.get(id)
    if (!project) throw new Error(`项目不存在: ${id}`)
    const result = generateProjectDashboard(project, projects.workspaceDir(id))
    const openError = await shell.openPath(result.path)
    return { ...result, opened: openError === '' }
  })

  // ==================== 阶段流转 ====================
  ipcMain.handle(IPC.Phase.Advance, async (_e, projectId: string, to: Phase, options?: { force?: boolean }) => {
    const project = projects.get(projectId)
    if (!project) return null
    if (options?.force) {
      // 强制推进：复用上一次已落库的门禁结果（未跑过门禁则补跑），失败项保留为遗留问题
      let results = project.phases[project.currentPhase].gateCheckResults
      if (results.length === 0) {
        results = await phaseEngine.runGateChecks(project, to, {
          workspaceDir: projects.workspaceDir(projectId)
        })
        project.phases[project.currentPhase].gateCheckResults = results
      }
      return {
        project: projects.save(phaseEngine.advance(project, to)),
        gate: { blocked: false, results, forced: phaseEngine.isBlocked(results) }
      }
    }
    // 运行门禁检查（Error 级失败阻断推进；结果落库供 UI 展示）
    const results = await phaseEngine.runGateChecks(project, to, {
      workspaceDir: projects.workspaceDir(projectId)
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

  ipcMain.handle(IPC.Phase.Enter, (_e, projectId: string, to: Phase) => {
    const project = projects.get(projectId)
    if (!project) return null
    return projects.save(phaseEngine.enterPhase(project, to))
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
      workspaceDir: projects.workspaceDir(projectId)
    })
    // 结果落库供展示
    project.phases[project.currentPhase].gateCheckResults = results
    projects.save(project)
    return results
  })

  ipcMain.handle(IPC.Phase.AcknowledgeChange, (_e, projectId: string, phase: Phase, responseNote?: string) => {
    const project = projects.get(projectId)
    if (!project) return null
    return projects.save(phaseEngine.acknowledgePhaseChange(project, phase, responseNote))
  })

  // ==================== EDA ====================
  ipcMain.handle(IPC.Eda.DetectTools, (_e, force?: boolean) => eda.detectTools(force === true))
  ipcMain.handle(IPC.Eda.InstallBundle, (_e, id: string) => eda.startInstallBundle(id))
  ipcMain.handle(IPC.Eda.GetInstallStatus, (_e, id: string) => eda.getInstallStatus(id))
  ipcMain.handle(IPC.Eda.OpenInstallPage, async (_e, url: string) => {
    if (!/^https:\/\//i.test(url)) return false
    await shell.openExternal(url)
    return true
  })
  ipcMain.handle(IPC.Eda.OpenWaveform, (_e, projectId: string, relPath: string) =>
    eda.openWaveform(projectId, relPath)
  )

  // ==================== 工艺库 ====================
  ipcMain.handle(IPC.ProcessLibrary.List, () => processLibraries.list())
  ipcMain.handle(IPC.ProcessLibrary.Catalog, () => processLibraries.catalog())
  ipcMain.handle(IPC.ProcessLibrary.ChooseAndAdd, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner
      ? await dialog.showOpenDialog(owner, { title: '选择工艺库目录', properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ title: '选择工艺库目录', properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : processLibraries.addLocal(result.filePaths[0])
  })
  ipcMain.handle(IPC.ProcessLibrary.Download, (_e, catalogId: string) => processLibraries.download(catalogId))
  ipcMain.handle(IPC.ProcessLibrary.Reindex, (_e, id: string) => processLibraries.reindex(id))
  ipcMain.handle(IPC.ProcessLibrary.Remove, (_e, id: string) => processLibraries.remove(id))
  ipcMain.handle(IPC.ProcessLibrary.OpenFolder, async (_e, id: string) => {
    const record = processLibraries.get(id)
    return record ? (await shell.openPath(record.path)) === '' : false
  })

  // ==================== IP 模板库 ====================
  ipcMain.handle(IPC.IpLibrary.List, () => ipLibraries.list())
  ipcMain.handle(IPC.IpLibrary.ChooseDirectory, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender)
    const result = owner
      ? await dialog.showOpenDialog(owner, { title: '选择 IP 库目录', properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ title: '选择 IP 库目录', properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  ipcMain.handle(IPC.IpLibrary.AddLocal, (_e, input: IpLibraryImportInput) => ipLibraries.addLocal(input))
  ipcMain.handle(IPC.IpLibrary.Reindex, (_e, id: string) => ipLibraries.reindex(id))
  ipcMain.handle(IPC.IpLibrary.Enhance, async (_e, id: string) => {
    const existing = ipEnhancementJobs.get(id)
    if (existing) return existing
    const job = (async () => {
      const record = await ipLibraries.get(id)
      if (!record || record.source !== 'local') throw new Error('仅支持分析用户导入的 IP 库')
      await ipLibraries.markSemanticAnalysis(id, 'running')
      try {
        const result = await agent.analyzeIpLibrary(record)
        return await ipLibraries.applySemanticAnalysis(id, result)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        await ipLibraries.markSemanticAnalysis(id, 'failed', message)
        throw error
      }
    })()
    ipEnhancementJobs.set(id, job)
    try {
      return await job
    } finally {
      if (ipEnhancementJobs.get(id) === job) ipEnhancementJobs.delete(id)
    }
  })
  ipcMain.handle(IPC.IpLibrary.Remove, (_e, id: string) => ipLibraries.remove(id))
  ipcMain.handle(IPC.IpLibrary.OpenFolder, async (_e, id: string) => {
    const record = await ipLibraries.get(id)
    return record ? (await shell.openPath(record.path)) === '' : false
  })

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
  ipcMain.handle(IPC.Agent.GetSessionStats, (_e, projectId: string) => agent.getSessionStats(projectId))

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

  ipcMain.handle(IPC.Fs.WriteText, (_e, projectId: string, relPath: string, content: string) =>
    files.writeText(projectId, relPath, content)
  )

  ipcMain.handle(IPC.Fs.OpenExternal, async (_e, projectId: string, relPath: string) => {
    const filePath = files.resolveProjectFile(projectId, relPath)
    if (!filePath) return false
    try {
      if (/\.html?$/i.test(filePath)) {
        await shell.openExternal(pathToFileURL(filePath).href)
        return true
      }
      return (await shell.openPath(filePath)) === ''
    } catch {
      return false
    }
  })

  // ==================== RTL Design Browser ====================
  ipcMain.handle(IPC.DesignBrowser.ListTops, (_e, projectId: string) =>
    designBrowser.listTopModules(projects.workspaceDir(projectId))
  )
  ipcMain.handle(IPC.DesignBrowser.Elaborate, (_e, projectId: string, topModule: string) =>
    designBrowser.elaborate(projectId, projects.workspaceDir(projectId), topModule)
  )
  ipcMain.handle(IPC.DesignBrowser.GetCached, (_e, projectId: string) =>
    designBrowser.getCached(projectId)
  )
  ipcMain.handle(IPC.DesignBrowser.ReadSource, (_e, projectId: string, source: string) =>
    designBrowser.readSource(projects.workspaceDir(projectId), source)
  )
}
