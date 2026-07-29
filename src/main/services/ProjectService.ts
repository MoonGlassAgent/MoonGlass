/**
 * 项目服务
 *
 * 骨架阶段采用 JSON 文件存储（userData/projects.json），
 * 数据结构直接落地 ChipProject 领域模型。
 * TODO(Phase 1 后续): 迁移到 better-sqlite3 + drizzle（schema 见 data/schema/moonglass.ts）
 */

import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { ChipProject } from '@shared/types'
import type { MoonGlassService } from '../core/lifecycle'
import { createInitialPhases } from './PhaseEngine'

interface ProjectStoreFile {
  projects: ChipProject[]
}

export class ProjectService implements MoonGlassService {
  readonly name = 'project-service'

  private storePath = ''
  private projects = new Map<string, ChipProject>()

  start(): void {
    const dir = join(app.getPath('userData'), 'moonglass')
    mkdirSync(dir, { recursive: true })
    this.storePath = join(dir, 'projects.json')
    this.load()
  }

  stop(): void {
    this.persist()
  }

  private load(): void {
    if (!existsSync(this.storePath)) return
    try {
      const data = JSON.parse(readFileSync(this.storePath, 'utf-8')) as ProjectStoreFile
      for (const p of data.projects) this.projects.set(p.id, p)
    } catch (err) {
      console.error('[project-service] 读取项目存储失败，将以空库启动', err)
    }
  }

  private persist(): void {
    const data: ProjectStoreFile = { projects: this.list() }
    writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf-8')
  }

  list(): ChipProject[] {
    return [...this.projects.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  get(id: string): ChipProject | null {
    return this.projects.get(id) ?? null
  }

  create(input: { name: string; description?: string; edaToolchain?: string }): ChipProject {
    const now = new Date().toISOString()
    const project: ChipProject = {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      currentPhase: 'REQ',
      phases: createInitialPhases(),
      edaToolchain: input.edaToolchain ?? 'verilator-yosys',
      createdAt: now,
      updatedAt: now
    }
    this.projects.set(project.id, project)
    this.persist()
    return project
  }

  update(id: string, patch: Partial<Pick<ChipProject, 'name' | 'description'>>): ChipProject | null {
    const project = this.projects.get(id)
    if (!project) return null
    Object.assign(project, patch, { updatedAt: new Date().toISOString() })
    this.persist()
    return project
  }

  /** 阶段引擎就地修改后的整体保存 */
  save(project: ChipProject): ChipProject {
    this.projects.set(project.id, project)
    this.persist()
    return project
  }

  delete(id: string): boolean {
    const ok = this.projects.delete(id)
    if (ok) this.persist()
    return ok
  }
}
