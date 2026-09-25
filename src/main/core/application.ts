/**
 * 应用服务注册表
 *
 * 集中创建并注册所有主进程服务，供入口与 IPC 层取用。
 */

import { app } from 'electron'
import { LifecycleManager } from './lifecycle'
import { DbService } from '../services/DbService'
import { ProjectService } from '../services/ProjectService'
import { PhaseEngine } from '../services/PhaseEngine'
import { PythonService } from '../services/PythonService'
import { EdaService } from '../services/EdaService'
import { LlmProviderService } from '../services/LlmProviderService'
import { AgentModelStore } from '../services/AgentModelStore'
import { AgentService } from '../services/AgentService'
import { FileService } from '../services/FileService'
import { CoverageService } from '../services/CoverageService'
import { DesignBrowserService } from '../services/DesignBrowserService'
import { ProcessLibraryService } from '../services/ProcessLibraryService'
import { IpLibraryService } from '../services/IpLibraryService'
import { join } from 'node:path'

export interface ApplicationServices {
  lifecycle: LifecycleManager
  db: DbService
  projects: ProjectService
  phaseEngine: PhaseEngine
  python: PythonService
  eda: EdaService
  llm: LlmProviderService
  modelStore: AgentModelStore
  agent: AgentService
  files: FileService
  coverage: CoverageService
  designBrowser: DesignBrowserService
  processLibraries: ProcessLibraryService
  ipLibraries: IpLibraryService
}

export function createApplication(): ApplicationServices {
  const lifecycle = new LifecycleManager()

  const userDataDir = app.getPath('userData')
  const db = new DbService(userDataDir)
  const projects = new ProjectService(db, userDataDir)
  const phaseEngine = new PhaseEngine(db)
  const python = new PythonService()
  const eda = new EdaService(userDataDir, projects)
  const llm = new LlmProviderService()
  const modelStore = new AgentModelStore()
  const agent = new AgentService(projects, llm, modelStore)
  const files = new FileService(projects)
  const coverage = new CoverageService(projects)
  const designBrowser = new DesignBrowserService(userDataDir)
  const processLibraries = new ProcessLibraryService(userDataDir)
  const resourcesDir = app.isPackaged ? process.resourcesPath : process.cwd()
  const builtinIpRoot = app.isPackaged
    ? join(resourcesDir, 'ip-library')
    : join(resourcesDir, 'resources', 'moonglass', 'ip-library')
  const ipLibraries = new IpLibraryService(userDataDir, builtinIpRoot)

  // 注册顺序即启动顺序；db 必须在 projects 之前启动
  lifecycle
    .register(db)
    .register(projects)
    .register(phaseEngine)
    .register(python)
    .register(eda)
    .register(llm)
    .register(modelStore)
    .register(agent)
    .register(files)
    .register(coverage)
    .register(designBrowser)
    .register(processLibraries)
    .register(ipLibraries)

  return { lifecycle, db, projects, phaseEngine, python, eda, llm, modelStore, agent, files, coverage, designBrowser, processLibraries, ipLibraries }
}
