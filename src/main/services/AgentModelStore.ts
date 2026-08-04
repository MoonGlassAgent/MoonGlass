/**
 * 每个项目、每个会话选中模型的持久化存储
 *
 * 文件：userData/moonglass/agent-model-selections.json
 * 按 projectId/sessionName 记录 { providerId, modelId }，切换会话或重启后恢复。
 */

import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface ModelSelection {
  providerId: string
  modelId: string
}

interface AgentModelStoreFile {
  selections: Record<string, ModelSelection>
  activeSessions?: Record<string, string>
}

export class AgentModelStore {
  readonly name = 'agent-model-store'

  private storePath = ''
  private selections = new Map<string, ModelSelection>()
  private activeSessions = new Map<string, string>()
  private dirty = false

  start(): void {
    const dir = join(app.getPath('userData'), 'moonglass')
    mkdirSync(dir, { recursive: true })
    this.storePath = join(dir, 'agent-model-selections.json')
    this.load()
  }

  stop(): void {
    this.persist()
  }

  private load(): void {
    if (!existsSync(this.storePath)) return
    try {
      const data = JSON.parse(readFileSync(this.storePath, 'utf-8')) as AgentModelStoreFile
      for (const [key, selection] of Object.entries(data.selections ?? {})) {
        if (selection.providerId && selection.modelId) {
          // 兼容旧版按项目保存的选择：迁移为该项目主会话的选择。
          this.selections.set(key.includes('::') ? key : this.key(key, 'main'), selection)
        }
      }
      for (const [projectId, sessionName] of Object.entries(data.activeSessions ?? {})) {
        if (sessionName && /^[a-zA-Z0-9_-]+$/.test(sessionName)) {
          this.activeSessions.set(projectId, sessionName)
        }
      }
    } catch (err) {
      console.error('[agent-model-store] 读取模型选择存储失败', err)
    }
  }

  persist(): void {
    if (!this.dirty) return
    const data: AgentModelStoreFile = {
      selections: Object.fromEntries(this.selections),
      activeSessions: Object.fromEntries(this.activeSessions)
    }
    writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf-8')
    this.dirty = false
  }

  get(projectId: string, sessionName = 'main'): ModelSelection | undefined {
    return this.selections.get(this.key(projectId, sessionName))
  }

  set(projectId: string, sessionName: string, providerId: string, modelId: string): void {
    this.selections.set(this.key(projectId, sessionName), { providerId, modelId })
    this.dirty = true
    this.persist()
  }

  delete(projectId: string, sessionName?: string): void {
    const prefix = `${projectId}::`
    const keys = sessionName ? [this.key(projectId, sessionName)] : [...this.selections.keys()].filter((key) => key.startsWith(prefix))
    let changed = false
    for (const key of keys) changed = this.selections.delete(key) || changed
    if (changed) {
      this.dirty = true
      this.persist()
    }
  }

  getActiveSession(projectId: string): string | undefined {
    return this.activeSessions.get(projectId)
  }

  setActiveSession(projectId: string, sessionName: string): void {
    this.activeSessions.set(projectId, sessionName || 'main')
    this.dirty = true
    this.persist()
  }

  deleteProject(projectId: string): void {
    this.delete(projectId)
    if (this.activeSessions.delete(projectId)) {
      this.dirty = true
      this.persist()
    }
  }

  private key(projectId: string, sessionName: string): string {
    return `${projectId}::${sessionName || 'main'}`
  }
}
