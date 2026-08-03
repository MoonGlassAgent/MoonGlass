/**
 * 项目服务
 *
 * Phase 5：从 JSON 文件存储迁移到 better-sqlite3 + drizzle。
 * - 首次启动时若数据库为空，自动从 legacy projects.json 导入。
 * - 保留 projects.json 作为备份，写入成功数据库后同步更新（便于回滚）。
 * - 阶段状态（phases）以 JSON 整体落库，后续逐步拆分到独立表。
 */

import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { eq, desc, sql } from 'drizzle-orm'
import type { ChipProject } from '@shared/types'
import type { MoonGlassService } from '../core/lifecycle.ts'
import { createInitialPhases } from './PhaseEngine.ts'
import { projectWorkspaceDir } from '../core/paths.ts'
import { chipProjects } from '../data/schema/moonglass.ts'
import type { DbService } from './DbService.ts'

interface LegacyProjectStoreFile {
  projects: ChipProject[]
}

/** ChipProject 转数据库行 */
function projectToRow(project: ChipProject): typeof chipProjects.$inferInsert {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    currentPhase: project.currentPhase,
    phasesJson: project.phases,
    edaToolchain: project.edaToolchain,
    targetProcess: project.targetProcess,
    targetFrequency: project.targetFrequency,
    targetArea: project.targetArea,
    targetPower: project.targetPower,
    gitRepoUrl: project.gitRepo,
    createdAt: new Date(project.createdAt),
    updatedAt: new Date(project.updatedAt)
  }
}

/** 数据库行转 ChipProject */
function rowToProject(row: typeof chipProjects.$inferSelect): ChipProject {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    currentPhase: row.currentPhase,
    phases: (row.phasesJson as ChipProject['phases']) ?? createInitialPhases(),
    edaToolchain: row.edaToolchain ?? 'verilator-yosys',
    targetProcess: row.targetProcess ?? undefined,
    targetFrequency: row.targetFrequency ?? undefined,
    targetArea: row.targetArea ?? undefined,
    targetPower: row.targetPower ?? undefined,
    gitRepo: row.gitRepoUrl ?? undefined,
    createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? new Date().toISOString()
  }
}

export class ProjectService implements MoonGlassService {
  readonly name = 'project-service'

  private storePath = ''
  private legacyPath = ''
  private db: DbService
  private dataDir: string

  constructor(db: DbService, dataDir: string) {
    this.db = db
    this.dataDir = dataDir
  }

  start(): void {
    const dir = join(this.dataDir, 'moonglass')
    mkdirSync(dir, { recursive: true })
    this.storePath = join(dir, 'projects.json')
    this.legacyPath = join(dir, 'projects.json.legacy')

    this.migrateFromLegacyIfNeeded()
    for (const project of this.list()) this.initWorkspace(project.id)
  }

  stop(): void {
    // 数据已落库，无需额外操作
  }

  /** 首次启动：若 SQLite 为空，从 projects.json 导入 */
  private migrateFromLegacyIfNeeded(): void {
    const database = this.db.getDb()
    const existing = database
      .select({ count: sql<number>`count(*)` })
      .from(chipProjects)
      .get()

    if (existing && existing.count > 0) return

    if (!existsSync(this.storePath)) return

    try {
      const data = JSON.parse(readFileSync(this.storePath, 'utf-8')) as LegacyProjectStoreFile
      if (!data.projects?.length) return

      for (const p of data.projects) {
        database.insert(chipProjects).values(projectToRow(p)).onConflictDoNothing().run()
      }
      // 迁移完成后重命名旧文件，避免重复导入
      renameSync(this.storePath, this.legacyPath)
      console.log(`[project-service] 已从 ${this.storePath} 迁移 ${data.projects.length} 个项目到 SQLite`)
    } catch (err) {
      console.error('[project-service] 读取旧版 projects.json 失败', err)
    }
  }

  /** 同步写一份 JSON 备份（便于紧急回滚/外部查看） */
  private backupToJson(): void {
    try {
      const projects = this.list()
      writeFileSync(this.storePath, JSON.stringify({ projects }, null, 2), 'utf-8')
    } catch (err) {
      console.error('[project-service] JSON 备份失败', err)
    }
  }

  list(): ChipProject[] {
    const rows = this.db
      .getDb()
      .select()
      .from(chipProjects)
      .orderBy(desc(chipProjects.updatedAt))
      .all()
    return rows.map(rowToProject)
  }

  get(id: string): ChipProject | null {
    const row = this.db
      .getDb()
      .select()
      .from(chipProjects)
      .where(eq(chipProjects.id, id))
      .get()
    return row ? rowToProject(row) : null
  }

  /** MoonGlass 项目规范目录。模块级 `<module>_tb` 在生成验证环境时创建。 */
  private static readonly DIR_TEMPLATE = [
    'docs/01_project',
    'docs/02_requirements',
    'docs/03_design',
    'docs/04_verification',
    'docs/05_implementation',
    'docs/06_validation',
    'docs/07_release',
    'rtl',
    'rtl/macros',
    'rtlqa/lint',
    'rtlqa/cdc',
    'verification/results',
    'imp/constraints',
    'imp/synthesis',
    'scripts'
  ]

  private static readonly LEGACY_DOC_MAP: Array<{ pattern: RegExp; target: string }> = [
    { pattern: /_srs\.md$/i, target: 'docs/02_requirements/product_requirements.md' },
    { pattern: /_rtm\.md$/i, target: 'docs/02_requirements/requirements_traceability.md' },
    { pattern: /_arch\.md$/i, target: 'docs/03_design/architecture.md' }
  ]

  /** 初始化项目工作目录结构 */
  private initWorkspace(projectId: string): void {
    const root = projectWorkspaceDir(projectId, this.dataDir)
    mkdirSync(root, { recursive: true })
    for (const dir of ProjectService.DIR_TEMPLATE) {
      mkdirSync(join(root, dir), { recursive: true })
    }

    const docsDir = join(root, 'docs')
    if (existsSync(docsDir)) {
      for (const file of readdirSync(docsDir, { withFileTypes: true })) {
        if (!file.isFile()) continue
        const mapping = ProjectService.LEGACY_DOC_MAP.find((item) => item.pattern.test(file.name))
        if (!mapping) continue
        const target = join(root, mapping.target)
        if (!existsSync(target)) {
          copyFileSync(join(docsDir, file.name), target)
          console.log(`[project-service] 保留旧文档并复制到规范路径: ${file.name} -> ${mapping.target}`)
        }
      }
    }

    const readme = join(root, 'README.md')
    if (!existsSync(readme)) {
      writeFileSync(
        readme,
        '# MoonGlass ASIC Project\n\n按 `docs -> rtl -> verification -> rtlqa -> imp` 阶段推进；所有生成物应保存在对应规范目录。\n',
        'utf-8'
      )
    }

    const gitignore = join(root, '.gitignore')
    if (!existsSync(gitignore)) {
      writeFileSync(
        gitignore,
        'node_modules/\n__pycache__/\n*.pyc\nverification/*_tb/build/\nverification/*_tb/obj_dir/\n',
        'utf-8'
      )
    }
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
    this.db.getDb().insert(chipProjects).values(projectToRow(project)).run()
    this.initWorkspace(project.id)
    this.backupToJson()
    return project
  }

  update(id: string, patch: Partial<Pick<ChipProject, 'name' | 'description'>>): ChipProject | null {
    const project = this.get(id)
    if (!project) return null
    Object.assign(project, patch, { updatedAt: new Date().toISOString() })
    this.db
      .getDb()
      .update(chipProjects)
      .set(projectToRow(project))
      .where(eq(chipProjects.id, id))
      .run()
    this.backupToJson()
    return project
  }

  /** 阶段引擎就地修改后的整体保存 */
  save(project: ChipProject): ChipProject {
    project.updatedAt = new Date().toISOString()
    this.db
      .getDb()
      .update(chipProjects)
      .set(projectToRow(project))
      .where(eq(chipProjects.id, project.id))
      .run()
    this.backupToJson()
    return project
  }

  delete(id: string): boolean {
    const before = this.db
      .getDb()
      .select({ count: sql<number>`count(*)` })
      .from(chipProjects)
      .get()
    this.db.getDb().delete(chipProjects).where(eq(chipProjects.id, id)).run()
    const after = this.db
      .getDb()
      .select({ count: sql<number>`count(*)` })
      .from(chipProjects)
      .get()
    this.backupToJson()
    return (after?.count ?? 0) < (before?.count ?? 0)
  }
}
