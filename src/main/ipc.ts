/**
 * IPC 通信注册中心
 *
 * 依据 shared/ipc-contract.ts 的通道契约注册全部 handler。
 */

import { BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { IPC } from '@shared/ipc-contract'
import { PHASE_ORDER } from '@shared/types'
import type { ImageAttachment, IpLibraryImportInput, LlmProviderConfig, Phase, PhaseResetMode, PythonRunRequest, VerifRunLoopStartOptions } from '@shared/types'
import type { ApplicationServices } from './core/application'
import { pathToFileURL } from 'node:url'
import { generateProjectDashboard } from './services/ProjectDashboardService'
import { GATE_RULES } from './services/PhaseEngine'
import { currentRtlHashOf, readWorkbenchEvidence, readWorkbenchSource } from './services/verification-evidence-reader'
import { buildVerificationWorkbench, workbenchEvidenceRefs } from '@shared/verification-workbench'

export function registerIpcHandlers(services: ApplicationServices): void {
  const { projects, phaseEngine, python, eda, llm, agent, files, coverage, designBrowser, processLibraries, ipLibraries } = services
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

  ipcMain.handle(IPC.Phase.Enter, async (_e, projectId: string, to: Phase) => {
    const project = projects.get(projectId)
    if (!project) return null
    // 双击阶段节点不再绕过门禁：向前跨越带门禁的相邻跳转时，先逐跳执行门禁检查，
    // Error 级失败抛错阻断（与 Advance 同一口径）；回退/平移不受影响
    const fromIndex = PHASE_ORDER.indexOf(project.currentPhase)
    const toIndex = PHASE_ORDER.indexOf(to)
    if (fromIndex >= 0 && toIndex > fromIndex) {
      const ctx = { workspaceDir: projects.workspaceDir(projectId) }
      for (let i = fromIndex; i < toIndex; i += 1) {
        const stepFrom = PHASE_ORDER[i]
        const stepTo = PHASE_ORDER[i + 1]
        if (!GATE_RULES.some((r) => r.from === stepFrom && r.to === stepTo)) continue
        const results = await phaseEngine.runGateChecksForTransition(project, stepFrom, stepTo, ctx)
        project.phases[stepFrom].gateCheckResults = results
        if (phaseEngine.isBlocked(results)) {
          projects.save(project)
          const failed = results.filter((r) => r.severity === 'error' && !r.passed)
          throw new Error(
            `门禁未通过，无法进入 ${to}（${stepFrom} → ${stepTo} 检查失败 ${failed.length} 项）：` +
            failed.map((r) => `${r.checkName}：${r.message}`).join('；')
          )
        }
      }
    }
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
    // SYNTH 收口挂 PPA 条款门禁（synthesis 通道条款须有综合报告证据闭环）
    return projects.save(phaseEngine.completeProject(project, projects.workspaceDir(projectId)))
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
  ipcMain.handle(IPC.Eda.InstallMissing, () => eda.startInstallMissing())
  ipcMain.handle(IPC.Eda.GetInstallStatus, (_e, id: string) => eda.getInstallStatus(id))
  ipcMain.handle(IPC.Eda.OpenInstallPage, async (_e, url: string) => {
    if (!/^https:\/\//i.test(url)) return false
    await shell.openExternal(url)
    return true
  })
  ipcMain.handle(IPC.Eda.OpenWaveform, (_e, projectId: string, relPath: string) =>
    eda.openWaveform(projectId, relPath)
  )
  // 环境自检可能耗时约 1 分钟（cocotb 项含 runner 构建），invoke 不设超时
  ipcMain.handle(IPC.Eda.SelfCheck, () => eda.runEnvironmentSelfCheck())

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

  ipcMain.handle(IPC.Phase.PreviewReset, (_e, projectId: string, phase: Phase, mode: PhaseResetMode) =>
    projects.previewPhaseReset(projectId, phase, mode)
  )

  // 阶段产物漂移对账：库记录 vs 磁盘实况（手动删除产物目录后仍能感知）
  ipcMain.handle(IPC.Project.ReconcileArtifacts, (_e, projectId: string) =>
    projects.reconcileArtifactDrift(projectId)
  )

  ipcMain.handle(IPC.Phase.Reset, async (_e, projectId: string, phase: Phase, mode: PhaseResetMode, options?: { resetDownstream?: boolean }) => {
    // 阶段重置会连 verification/ 一起清除（PHASE_ARTIFACT_PATHS 含 run-loop.json 与 decision-ledger.json）。
    // 若该项目的验证运行循环仍在内存中存活，它下一拍就会把刚清理的账本重新写回（账本缺失时
    // updateVerifRunLoopLedger 会新建并重建目录），用户看到的现象是"产物已全删、重新进入验证，
    // 却仍从上次中断处继续"。必须先停稳循环再清产物。
    // abort 只停批次编排（stopVerifBatches），不含运行循环，故这里单独停止并等待退出。
    await agent.stopVerifRunLoopAndWait(projectId).catch((error) => {
      console.warn('[ipc] 阶段重置前停止验证运行循环失败（继续执行重置）', error)
    })
    await agent.abort(projectId).catch(() => undefined)
    // 释放 verification/ 目录监视器：Windows 上 fs.watch(recursive) 持有目录句柄，不释放时
    // 目录删除只能进入 delete pending（目录项仍在但无法打开、rmSync 完不成），账本随之残留，
    // 重新进入验证阶段就会继续显示上一轮状态。渲染端订阅会在目录重建后自动恢复。
    files.forceReleaseVerificationWatch(projectId)
    if (mode === 'purge') agent.clearPhaseSessions(projectId, phase)
    const result = projects.resetPhase(projectId, phase, mode, options)
    if (mode === 'archive') {
      await agent.ensureSession(projectId)
      await agent.restartSessionFresh(projectId)
    }
    return result
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

  ipcMain.handle(IPC.Agent.Prompt, (_e, projectId: string, text: string, images?: ImageAttachment[]) =>
    agent.prompt(projectId, text, images)
  )

  ipcMain.handle(IPC.Agent.Abort, (_e, projectId: string) => agent.abort(projectId))

  ipcMain.handle(
    IPC.Agent.SetModel,
    (_e, projectId: string, providerId: string, modelId: string) =>
      agent.setModel(projectId, providerId, modelId)
  )

  ipcMain.handle(IPC.Agent.GetMessages, (_e, projectId: string) => agent.getMessages(projectId))
  // 只读窥视指定会话（后台批次会话），不 attach / 不切换 / 不 spawn
  ipcMain.handle(IPC.Agent.GetSessionMessages, (_e, projectId: string, sessionName: string) =>
    agent.getSessionMessages(projectId, sessionName)
  )
  ipcMain.handle(IPC.Agent.GetSessionStats, (_e, projectId: string) => agent.getSessionStats(projectId))
  // 项目列表页卡片徽标轮询：全项目会话活动聚合（无参数，主进程内存态，开销可忽略）
  ipcMain.handle(IPC.Agent.GetSessionActivity, () => agent.sessionActivity())
  // 用户自定义模型上下文上限（自有模型登记表查不到，由用户指定）
  ipcMain.handle(IPC.Agent.SetContextWindowOverride, (_e, projectId: string, contextWindow: number | null) =>
    agent.setContextWindowOverride(projectId, contextWindow)
  )

  ipcMain.handle(IPC.Agent.ResetSession, (_e, projectId: string, sessionName?: string) =>
    agent.resetSession(projectId, sessionName)
  )
  // 任务粒度会话（M1）：新任务会话成为前台，血缘经 parentSession 记录
  ipcMain.handle(IPC.Agent.StartTask, (_e, projectId: string, input?: { title?: string; firstPrompt?: string }) =>
    agent.startTask(projectId, input)
  )
  ipcMain.handle(IPC.Agent.CompactSession, (_e, projectId: string) => agent.compactSession(projectId))
  ipcMain.handle(IPC.Agent.RestartSessionFresh, (_e, projectId: string) => agent.restartSessionFresh(projectId))

  ipcMain.handle(IPC.Agent.ListSessions, (_e, projectId: string) => agent.listSessions(projectId))

  ipcMain.handle(IPC.Agent.SwitchSession, (_e, projectId: string, sessionName: string) =>
    agent.switchSession(projectId, sessionName)
  )
  ipcMain.handle(IPC.Agent.CloseSession, (_e, projectId: string, sessionName: string) =>
    agent.closeSession(projectId, sessionName)
  )

  // VERIF 批次编排（第 3 批）：主进程派发批次会话，完成判定绑定证据
  ipcMain.handle(IPC.Agent.RunVerifBatch, (_e, projectId: string, scenarioIds: string[], options?: { batchIndex?: number }) =>
    agent.runVerifBatch(projectId, scenarioIds, options)
  )
  ipcMain.handle(IPC.Agent.RunVerifBatches, (_e, projectId: string, options?: { batchSize?: number; maxBatches?: number }) =>
    agent.runVerifBatches(projectId, options)
  )
  ipcMain.handle(IPC.Agent.StopVerifBatches, async (_e, projectId: string) => {
    await agent.stopVerifBatches(projectId)
  })

  // 验证运行循环（VERIF-RUN-LOOP 批 2/批 3）：外层循环控制通道 + 决策审批（decide）
  ipcMain.handle(IPC.Agent.StartVerifRunLoop, (_e, projectId: string, options?: VerifRunLoopStartOptions) =>
    agent.startVerifRunLoop(projectId, options)
  )
  ipcMain.handle(IPC.Agent.PauseVerifRunLoop, (_e, projectId: string) => agent.pauseVerifRunLoop(projectId))
  ipcMain.handle(IPC.Agent.ResumeVerifRunLoop, (_e, projectId: string, options?: VerifRunLoopStartOptions) => agent.resumeVerifRunLoop(projectId, options))
  ipcMain.handle(IPC.Agent.StopVerifRunLoop, (_e, projectId: string) => agent.stopVerifRunLoop(projectId))
  ipcMain.handle(IPC.Agent.DecideVerifRunDecision, (_e, projectId: string, decisionId: string, verdict: 'approved' | 'rejected', editedPrompt?: string) =>
    agent.decideVerifRunDecision(projectId, decisionId, verdict, editedPrompt)
  )

  // ==================== 项目文件 ====================
  ipcMain.handle(IPC.Fs.Tree, (_e, projectId: string) => files.tree(projectId))

  ipcMain.handle(IPC.Fs.ReadFile, (_e, projectId: string, relPath: string) =>
    files.readFile(projectId, relPath)
  )

  ipcMain.handle(IPC.Fs.ReadJson, (_e, projectId: string, relPath: string) =>
    files.readJson(projectId, relPath)
  )

  ipcMain.handle(IPC.Fs.VerificationStatus, (_e, projectId: string) =>
    files.verificationRunStatus(projectId)
  )

  // 验证工作台结论（P1）：主进程侧核对当前 RTL 版本与证据文件，渲染端只做展示。
  // 只读：不写任何项目产物、不触发调度；姿态不可用时返回 null（渲染端据此显示"未生成"，
  // 而不是"零 blocker 即就绪"）。
  ipcMain.handle(IPC.Fs.VerificationWorkbench, (_e, projectId: string) => {
    const workspace = projects.workspaceDir(projectId)
    const { raw, source } = readWorkbenchSource(workspace)
    const rtlHash = currentRtlHashOf(workspace)
    // 无姿态/不可解析时返回"无数据"快照，而不是 null：null 留给 IPC 层失败，
    // 二者在界面上的含义不同（"尚未生成" vs "读取失败"），不能混为一谈。
    if (raw === null) return buildVerificationWorkbench({}, rtlHash, {}, null)
    const refs = workbenchEvidenceRefs(raw)
    return buildVerificationWorkbench(raw, rtlHash, readWorkbenchEvidence(workspace, refs), source)
  })

  ipcMain.handle(IPC.Fs.WatchVerification, (_e, projectId: string) => {
    files.watchVerification(projectId)
  })

  ipcMain.handle(IPC.Fs.UnwatchVerification, (_e, projectId: string) => {
    files.unwatchVerification(projectId)
  })

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

  // ==================== 覆盖率明细 ====================
  ipcMain.handle(IPC.Coverage.Detail, (_e, projectId: string, relResultDir: string) =>
    coverage.detail(projectId, relResultDir)
  )

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
