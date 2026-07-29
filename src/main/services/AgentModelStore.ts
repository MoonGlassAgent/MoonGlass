/**
 * 每个项目当前选中模型的持久化存储
 *
 * 文件：userData/moonglass/agent-model-selections.json
 * 按 projectId 记录 { providerId, modelId }，切换阶段或重启后恢复。
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
}

export class AgentModelStore {
  readonly name = 'agent-model-store'

  private storePath = ''
  private selections = new Map<string, ModelSelection>()
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
      for (const [projectId, selection] of Object.entries(data.selections ?? {})) {
        if (selection.providerId && selection.modelId) {
          this.selections.set(projectId, selection)
        }
      }
    } catch (err) {
      console.error('[agent-model-store] 读取模型选择存储失败', err)
    }
  }

  persist(): void {
    if (!this.dirty) return
    const data: AgentModelStoreFile = {
      selections: Object.fromEntries(this.selections)
    }
    writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf-8')
    this.dirty = false
  }

  get(projectId: string): ModelSelection | undefined {
    return this.selections.get(projectId)
  }

  set(projectId: string, providerId: string, modelId: string): void {
    this.selections.set(projectId, { providerId, modelId })
    this.dirty = true
    this.persist()
  }

  delete(projectId: string): void {
    if (this.selections.delete(projectId)) {
      this.dirty = true
      this.persist()
    }
  }
}
