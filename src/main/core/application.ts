/**
 * 应用服务注册表
 *
 * 集中创建并注册所有主进程服务，供入口与 IPC 层取用。
 */

import { LifecycleManager } from './lifecycle'
import { ProjectService } from '../services/ProjectService'
import { PhaseEngine } from '../services/PhaseEngine'
import { PythonService } from '../services/PythonService'
import { EdaService } from '../services/EdaService'
import { LlmProviderService } from '../services/LlmProviderService'
import { AgentModelStore } from '../services/AgentModelStore'
import { AgentService } from '../services/AgentService'
import { FileService } from '../services/FileService'

export interface ApplicationServices {
  lifecycle: LifecycleManager
  projects: ProjectService
  phaseEngine: PhaseEngine
  python: PythonService
  eda: EdaService
  llm: LlmProviderService
  modelStore: AgentModelStore
  agent: AgentService
  files: FileService
}

export function createApplication(): ApplicationServices {
  const lifecycle = new LifecycleManager()

  const projects = new ProjectService()
  const phaseEngine = new PhaseEngine()
  const python = new PythonService()
  const eda = new EdaService()
  const llm = new LlmProviderService()
  const modelStore = new AgentModelStore()
  const agent = new AgentService(projects, llm, modelStore)
  const files = new FileService()

  // 注册顺序即启动顺序
  lifecycle
    .register(projects)
    .register(phaseEngine)
    .register(python)
    .register(eda)
    .register(llm)
    .register(modelStore)
    .register(agent)
    .register(files)

  return { lifecycle, projects, phaseEngine, python, eda, llm, modelStore, agent, files }
}
