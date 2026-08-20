/**
 * 项目服务
 *
 * Phase 5：从 JSON 文件存储迁移到 better-sqlite3 + drizzle。
 * - 首次启动时若数据库为空，自动从 legacy projects.json 导入。
 * - 保留 projects.json 作为备份，写入成功数据库后同步更新（便于回滚）。
 * - 阶段状态（phases）以 JSON 整体落库，后续逐步拆分到独立表。
 */

import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, renameSync, readdirSync, watch, type FSWatcher } from 'node:fs'
import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { eq, desc, sql } from 'drizzle-orm'
import { PHASE_LABELS, PHASE_ORDER, type ChipProject, type Phase, type PhaseState, type ProjectImportAssessment, type ProjectMigrationResult } from '@shared/types'
import type { MoonGlassService } from '../core/lifecycle.ts'
import { createInitialPhases, markPhaseChanged } from './PhaseEngine.ts'
import { projectWorkspaceDir } from '../core/paths.ts'
import { chipProjects } from '../data/schema/moonglass.ts'
import type { DbService } from './DbService.ts'
import { analyzeExistingProject } from './ProjectImportAnalyzer.ts'

interface LegacyProjectStoreFile {
  projects: ChipProject[]
}

interface CreateProjectInput {
  name: string
  description?: string
  edaToolchain?: string
  workspacePath?: string
  initialPhase?: Phase
}

function createImportedPhases(currentPhase: Phase, now: string): Record<Phase, PhaseState> {
  const phases = createInitialPhases()
  const currentIndex = PHASE_ORDER.indexOf(currentPhase)
  for (let index = 0; index < currentIndex; index += 1) {
    const phase = PHASE_ORDER[index]
    phases[phase] = {
      ...phases[phase],
      status: 'completed',
      startedAt: now,
      completedAt: now
    }
  }
  phases[currentPhase] = {
    ...phases[currentPhase],
    status: 'active',
    startedAt: now
  }
  return phases
}

function formatImportAssessment(assessment: ProjectImportAssessment, selectedPhase: Phase): string {
  const evidence = PHASE_ORDER.map((phase) => {
    const item = assessment.evidence[phase]
    return `### ${phase} · ${PHASE_LABELS[phase]}\n\n- 证据分：${item.score}\n${item.paths.length > 0 ? item.paths.map((path) => `- \`${path}\``).join('\n') : '- 未识别到明确证据'}`
  }).join('\n\n')
  return `# 已有项目导入阶段评估\n\n` +
    `- 扫描文件：${assessment.fileCount}\n` +
    `- 自动建议阶段：${assessment.suggestedPhase} · ${PHASE_LABELS[assessment.suggestedPhase]}\n` +
    `- 用户确认阶段：${selectedPhase} · ${PHASE_LABELS[selectedPhase]}\n` +
    `- 识别置信度：${assessment.confidence}%\n` +
    `- 扫描是否截断：${assessment.truncated ? '是' : '否'}\n\n` +
    `## 兼容性说明\n\nMoonGlass 根据现有工程证据恢复流程阶段，不要求原项目采用 MoonGlass 文件树或追踪矩阵。此前阶段标记为“外部流程已完成”，并不代表已经通过 MoonGlass 门禁；进入后应逐步建立目录映射和需求追溯。\n\n` +
    `${assessment.warnings.length > 0 ? `## 待适配项\n\n${assessment.warnings.map((warning) => `- ${warning}`).join('\n')}\n\n` : ''}` +
    `## 阶段证据\n\n${evidence}\n`
}

/** ChipProject 转数据库行 */
function projectToRow(project: ChipProject): typeof chipProjects.$inferInsert {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    workspacePath: project.workspacePath,
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

type StoredPhase = Phase | 'REQ' | 'SPEC'
type StoredProject = Omit<ChipProject, 'currentPhase' | 'phases'> & {
  currentPhase: StoredPhase
  phases: Partial<Record<StoredPhase, PhaseState>>
}

function mergeLegacyRequirementPhases(req?: PhaseState, spec?: PhaseState): PhaseState {
  const initial = createInitialPhases().REQ_SPEC
  if (!req && !spec) return initial
  const states = [req, spec].filter((state): state is PhaseState => Boolean(state))
  const status = spec?.status === 'completed' || spec?.status === 'skipped'
    ? spec.status
    : states.some((state) => state.status === 'blocked')
      ? 'blocked'
      : states.some((state) => state.status === 'active' || state.status === 'completed')
        ? 'active'
        : 'locked'
  return {
    status,
    deliverables: states.flatMap((state) => state.deliverables),
    agentContext: {
      summary: [req?.agentContext.summary, spec?.agentContext.summary].filter(Boolean).join('\n\n') || undefined,
      messageCount: states.reduce((sum, state) => sum + state.agentContext.messageCount, 0),
      lastActiveAt: states.map((state) => state.agentContext.lastActiveAt).filter((value): value is string => Boolean(value)).sort().at(-1)
    },
    reviewStatus: states.some((state) => state.reviewStatus === 'rejected')
      ? 'rejected'
      : states.length > 0 && states.every((state) => state.reviewStatus === 'approved') ? 'approved' : 'pending',
    gateCheckResults: states.flatMap((state) => state.gateCheckResults),
    startedAt: states.map((state) => state.startedAt).filter((value): value is string => Boolean(value)).sort().at(0),
    completedAt: status === 'completed' ? spec?.completedAt ?? req?.completedAt : undefined,
    skippedAt: status === 'skipped' ? spec?.skippedAt : undefined,
    skipReason: status === 'skipped' ? spec?.skipReason : undefined
  }
}

/** 读取旧版七阶段项目时，无损归并 REQ/SPEC，并补齐当前六阶段结构。 */
function normalizeStoredProject(project: StoredProject): ChipProject {
  const initial = createInitialPhases()
  const phases = { ...initial }
  for (const phase of ['ARCH', 'RTL', 'VERIF', 'QA', 'SYNTH'] as const) {
    phases[phase] = project.phases[phase] ?? initial[phase]
  }
  phases.REQ_SPEC = project.phases.REQ_SPEC
    ?? mergeLegacyRequirementPhases(project.phases.REQ, project.phases.SPEC)
  // 清理旧版错误传播给未完成阶段的黄色标记；新版通知必须记录完成基线。
  for (const phase of Object.keys(phases) as Phase[]) {
    const notice = phases[phase].changeNotice
    if (notice?.status === 'pending' && !notice.baselineCompletedAt) {
      phases[phase] = { ...phases[phase], changeNotice: undefined }
    }
  }
  return {
    ...project,
    currentPhase: project.currentPhase === 'REQ' || project.currentPhase === 'SPEC'
      ? 'REQ_SPEC'
      : project.currentPhase,
    phases
  }
}

/** 数据库行转 ChipProject */
function rowToProject(row: typeof chipProjects.$inferSelect): ChipProject {
  return normalizeStoredProject({
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    workspacePath: row.workspacePath ?? undefined,
    currentPhase: row.currentPhase as StoredPhase,
    phases: (row.phasesJson as StoredProject['phases']) ?? createInitialPhases(),
    edaToolchain: row.edaToolchain ?? 'verilator-yosys',
    targetProcess: row.targetProcess ?? undefined,
    targetFrequency: row.targetFrequency ?? undefined,
    targetArea: row.targetArea ?? undefined,
    targetPower: row.targetPower ?? undefined,
    gitRepo: row.gitRepoUrl ?? undefined,
    createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? new Date().toISOString()
  })
}

export class ProjectService implements MoonGlassService {
  readonly name = 'project-service'

  private storePath = ''
  private legacyPath = ''
  private db: DbService
  private dataDir: string
  private workspaceWatchers = new Map<string, FSWatcher>()
  private workspaceChangeTimers = new Map<string, NodeJS.Timeout>()

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
    const projects = this.list()
    for (const project of projects) {
      this.db.getDb().update(chipProjects).set(projectToRow(project)).where(eq(chipProjects.id, project.id)).run()
      this.initWorkspace(project.id)
      this.watchWorkspace(project.id)
    }
    if (projects.length > 0) this.backupToJson()
  }

  stop(): void {
    for (const watcher of this.workspaceWatchers.values()) watcher.close()
    this.workspaceWatchers.clear()
    for (const timer of this.workspaceChangeTimers.values()) clearTimeout(timer)
    this.workspaceChangeTimers.clear()
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

  /** 返回项目实际工作目录；旧项目保持默认目录，不要求迁移。 */
  workspaceDir(projectId: string): string {
    const configured = this.get(projectId)?.workspacePath?.trim()
    return configured ? resolve(configured) : projectWorkspaceDir(projectId, this.dataDir)
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
    const root = this.workspaceDir(projectId)
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

  analyzeDirectory(path: string): ProjectImportAssessment {
    if (!path.trim() || !isAbsolute(path)) throw new Error('项目目录必须是绝对路径')
    return analyzeExistingProject(path)
  }

  create(input: CreateProjectInput): ChipProject {
    const requestedPath = input.workspacePath?.trim()
    if (requestedPath && !isAbsolute(requestedPath)) {
      throw new Error('项目目录必须是绝对路径')
    }
    const workspacePath = requestedPath ? normalize(resolve(requestedPath)) : undefined
    if (workspacePath && this.list().some((item) => this.workspaceDir(item.id).toLowerCase() === workspacePath.toLowerCase())) {
      throw new Error('该项目目录已被另一个 MoonGlass 项目使用')
    }
    const now = new Date().toISOString()
    const assessment = workspacePath && existsSync(workspacePath) ? analyzeExistingProject(workspacePath) : undefined
    const initialPhase = assessment?.isExistingProject
      ? input.initialPhase ?? assessment.suggestedPhase
      : 'REQ_SPEC'
    const project: ChipProject = {
      id: randomUUID(),
      name: input.name,
      description: input.description,
      workspacePath,
      currentPhase: initialPhase,
      phases: assessment?.isExistingProject ? createImportedPhases(initialPhase, now) : createInitialPhases(),
      edaToolchain: input.edaToolchain ?? 'verilator-yosys',
      createdAt: now,
      updatedAt: now
    }
    this.db.getDb().insert(chipProjects).values(projectToRow(project)).run()
    this.initWorkspace(project.id)
    if (assessment?.isExistingProject) {
      const reportPath = join(this.workspaceDir(project.id), 'docs', '01_project', 'import_assessment.md')
      writeFileSync(reportPath, formatImportAssessment(assessment, initialPhase), 'utf-8')
    }
    this.watchWorkspace(project.id)
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
    this.workspaceWatchers.get(id)?.close()
    this.workspaceWatchers.delete(id)
    const timer = this.workspaceChangeTimers.get(id)
    if (timer) clearTimeout(timer)
    this.workspaceChangeTimers.delete(id)
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

  async migrate(
    id: string,
    requestedDestination: string,
    beforeCommit?: () => void
  ): Promise<ProjectMigrationResult> {
    const project = this.get(id)
    if (!project) throw new Error('项目不存在')
    if (!requestedDestination.trim() || !isAbsolute(requestedDestination)) {
      throw new Error('迁移目标必须是绝对路径')
    }

    const sourcePath = normalize(resolve(this.workspaceDir(id)))
    const destinationPath = normalize(resolve(requestedDestination))
    const comparable = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
    const sourceKey = comparable(sourcePath)
    const destinationKey = comparable(destinationPath)
    if (sourceKey === destinationKey) throw new Error('迁移目标与当前项目目录相同')
    const sourceToDestination = relative(sourcePath, destinationPath)
    const destinationToSource = relative(destinationPath, sourcePath)
    if (!sourceToDestination.startsWith('..') || !destinationToSource.startsWith('..')) {
      throw new Error('迁移目标不能位于当前项目目录内部或包含当前项目目录')
    }
    if (this.list().some((item) => item.id !== id && comparable(this.workspaceDir(item.id)) === destinationKey)) {
      throw new Error('迁移目标已被另一个 MoonGlass 项目使用')
    }
    if (!existsSync(sourcePath)) throw new Error('当前项目目录不存在，无法迁移')

    let destinationExisted = false
    try {
      const entries = await readdir(destinationPath)
      destinationExisted = true
      if (entries.length > 0) throw new Error('迁移目标目录必须为空')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }

    const temporaryPath = join(dirname(destinationPath), `.${basename(destinationPath)}.moonglass-${randomUUID()}`)
    const inventory = async (root: string): Promise<{ files: number; bytes: number }> => {
      let files = 0
      let bytes = 0
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = join(root, entry.name)
        if (entry.isDirectory()) {
          const nested = await inventory(path)
          files += nested.files
          bytes += nested.bytes
        } else {
          files += 1
          bytes += (await stat(path)).size
        }
      }
      return { files, bytes }
    }

    try {
      await mkdir(dirname(destinationPath), { recursive: true })
      await cp(sourcePath, temporaryPath, { recursive: true, force: false, errorOnExist: true })
      beforeCommit?.()
      const [sourceInventory, copiedInventory] = await Promise.all([inventory(sourcePath), inventory(temporaryPath)])
      if (sourceInventory.files !== copiedInventory.files || sourceInventory.bytes !== copiedInventory.bytes) {
        throw new Error('迁移副本校验失败，项目路径未切换')
      }
      if (destinationExisted) await rm(destinationPath, { recursive: true, force: true })
      await rename(temporaryPath, destinationPath)

      this.workspaceWatchers.get(id)?.close()
      this.workspaceWatchers.delete(id)
      const timer = this.workspaceChangeTimers.get(id)
      if (timer) clearTimeout(timer)
      this.workspaceChangeTimers.delete(id)
      project.workspacePath = destinationPath
      const saved = this.save(project)
      this.watchWorkspace(id)
      return {
        project: saved,
        sourcePath,
        destinationPath,
        copiedFiles: copiedInventory.files,
        copiedBytes: copiedInventory.bytes,
        sourceRetained: true
      }
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
  }

  /** Agent 或 Claude Code 修改工作区文件时，自动向后续阶段传播变更通知。 */
  private watchWorkspace(projectId: string): void {
    if (this.workspaceWatchers.has(projectId)) return
    const root = this.workspaceDir(projectId)
    try {
      const watcher = watch(root, { recursive: true }, (_eventType, filename) => {
        const changedPath = filename ? String(filename).replace(/\\/g, '/') : ''
        if (!changedPath || changedPath.startsWith('.pi/') || changedPath.startsWith('.git/')) return
        const sourcePhase = this.get(projectId)?.currentPhase
        if (!sourcePhase) return
        const previous = this.workspaceChangeTimers.get(projectId)
        if (previous) clearTimeout(previous)
        const timer = setTimeout(() => {
          this.workspaceChangeTimers.delete(projectId)
          const project = this.get(projectId)
          if (!project) return
          const detail = relative(root, join(root, changedPath)).replace(/\\/g, '/')
          this.save(markPhaseChanged(project, sourcePhase, `检测到工作区文件变更：${detail}`))
        }, 700)
        this.workspaceChangeTimers.set(projectId, timer)
      })
      watcher.on('error', (error) => {
        console.error(`[project-service] 工作区监听失败 (${projectId})`, error)
        watcher.close()
        this.workspaceWatchers.delete(projectId)
      })
      this.workspaceWatchers.set(projectId, watcher)
    } catch (error) {
      console.error(`[project-service] 无法监听工作区 (${projectId})`, error)
    }
  }
}
