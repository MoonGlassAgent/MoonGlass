/**
 * 项目列表页（规格书 §5.2）
 */

import { useEffect, useState } from 'react'
import { Cpu, FolderOpen, Plus, ScanSearch } from 'lucide-react'
import { PHASE_LABELS, PHASE_ORDER, type ChipProject, type Phase, type ProjectImportAssessment } from '@shared/types'
import { ProjectCard } from '../components/ProjectCard'
import { useAppStore } from '../store/appStore'

export function ProjectsPage(): React.JSX.Element {
  const { projects, refreshProjects } = useAppStore()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [createError, setCreateError] = useState('')
  const [assessment, setAssessment] = useState<ProjectImportAssessment | null>(null)
  const [assessmentPath, setAssessmentPath] = useState('')
  const [initialPhase, setInitialPhase] = useState<Phase>('REQ_SPEC')
  const [analyzing, setAnalyzing] = useState(false)
  const [importMessage, setImportMessage] = useState('')
  const [migrationMessage, setMigrationMessage] = useState('')
  const [migrationError, setMigrationError] = useState('')
  const [migratingProjectId, setMigratingProjectId] = useState<string | null>(null)
  const [editingProject, setEditingProject] = useState<ChipProject | null>(null)
  const [editName, setEditName] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const [editError, setEditError] = useState('')

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  const handleCreate = async (): Promise<void> => {
    if (!name.trim()) return
    setCreateError('')
    try {
      let currentAssessment = assessmentPath === workspacePath.trim() ? assessment : null
      if (workspacePath.trim() && !currentAssessment) currentAssessment = await analyzeDirectory(workspacePath.trim())
      await window.moonglass.project.create({
        name: name.trim(),
        description: description.trim() || undefined,
        workspacePath: workspacePath.trim() || undefined,
        initialPhase: currentAssessment?.isExistingProject ? initialPhase : undefined
      })
      if (currentAssessment?.isExistingProject) {
        setImportMessage(`已有项目已导入，恢复到 ${initialPhase} · ${PHASE_LABELS[initialPhase]}；阶段证据报告已写入项目目录。`)
      }
      setName('')
      setDescription('')
      setWorkspacePath('')
      setAssessment(null)
      setAssessmentPath('')
      setInitialPhase('REQ_SPEC')
      setCreating(false)
      await refreshProjects()
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error))
    }
  }

  const analyzeDirectory = async (path: string): Promise<ProjectImportAssessment> => {
    setAnalyzing(true)
    setCreateError('')
    try {
      const result = await window.moonglass.project.analyzeDirectory(path)
      setAssessment(result)
      setAssessmentPath(path)
      setInitialPhase(result.suggestedPhase)
      return result
    } catch (error) {
      setAssessment(null)
      setAssessmentPath('')
      throw error
    } finally {
      setAnalyzing(false)
    }
  }

  const handleChooseDirectory = async (): Promise<void> => {
    const selected = await window.moonglass.project.chooseDirectory()
    if (!selected) return
    setWorkspacePath(selected)
    try { await analyzeDirectory(selected) } catch (error) {
      setCreateError(`目录扫描失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const handleDelete = async (id: string): Promise<void> => {
    await window.moonglass.project.delete(id)
    await refreshProjects()
  }

  const beginEdit = (project: ChipProject): void => {
    setEditingProject(project)
    setEditName(project.name)
    setEditDescription(project.description ?? '')
    setEditError('')
  }

  const saveEdit = async (): Promise<void> => {
    if (!editingProject || !editName.trim()) return
    try {
      await window.moonglass.project.update(editingProject.id, {
        name: editName.trim(),
        description: editDescription.trim() || undefined
      })
      setEditingProject(null)
      await refreshProjects()
    } catch (error) {
      setEditError(error instanceof Error ? error.message : String(error))
    }
  }

  const handleMigrate = async (project: (typeof projects)[number]): Promise<void> => {
    const destination = await window.moonglass.project.chooseDirectory()
    if (!destination) return
    const confirmed = window.confirm(
      `确认将项目「${project.name}」迁移到：\n${destination}\n\n迁移完成后原目录会保留，请确认新项目正常后再自行删除。`
    )
    if (!confirmed) return
    setMigratingProjectId(project.id)
    setMigrationError('')
    setMigrationMessage(`正在迁移「${project.name}」，请勿关闭 MoonGlass…`)
    try {
      const result = await window.moonglass.project.migrate(project.id, destination)
      setMigrationMessage(`「${project.name}」已迁移，共复制 ${result.copiedFiles} 个文件；原目录已保留。`)
      await refreshProjects()
    } catch (error) {
      setMigrationMessage('')
      setMigrationError(error instanceof Error ? error.message : String(error))
    } finally {
      setMigratingProjectId(null)
    }
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-zinc-900">芯片项目</h1>
          <p className="mt-1 text-sm text-zinc-500">
            每个项目走 6 阶段流程：REQ_SPEC → ARCH → RTL → VERIF → QA → SYNTH
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
        >
          <Plus size={16} /> 新建项目
        </button>
      </div>

      {migrationMessage && (
        <div className="mb-4 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
          {migrationMessage}
        </div>
      )}
      {importMessage && (
        <div className="mb-4 rounded border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {importMessage}
        </div>
      )}
      {migrationError && (
        <div className="mb-4 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          迁移失败：{migrationError}
        </div>
      )}

      {creating && (
        <div className="mb-6 rounded-lg border border-zinc-300 bg-white p-4">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="项目名称（如 DDR_BIST_Controller）"
            className="mb-2 w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="项目描述（可选）"
            className="mb-3 w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
          <label className="mb-1 block text-xs font-medium text-zinc-600">项目目录</label>
          <div className="mb-2 flex gap-2">
            <input
              value={workspacePath}
              onChange={(e) => { setWorkspacePath(e.target.value); setAssessment(null); setAssessmentPath('') }}
              placeholder="留空则使用 MoonGlass 默认目录"
              className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
            <button
              type="button"
              onClick={() => void handleChooseDirectory()}
              title="选择项目目录"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50"
            >
              <FolderOpen size={17} />
            </button>
            <button
              type="button"
              onClick={() => void analyzeDirectory(workspacePath.trim()).catch((error) => setCreateError(`目录扫描失败：${error instanceof Error ? error.message : String(error)}`))}
              disabled={!workspacePath.trim() || analyzing}
              title="扫描已有项目阶段"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 disabled:opacity-40"
            >
              <ScanSearch size={17} className={analyzing ? 'animate-pulse' : ''} />
            </button>
          </div>
          <p className="mb-3 text-xs text-zinc-500">选择已有工程后会先识别实际阶段；MoonGlass 只补齐缺失的规范目录，不覆盖现有文件。</p>
          {analyzing && <div className="mb-3 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">正在扫描项目证据并判断阶段…</div>}
          {assessment?.isExistingProject && (
            <section className="mb-3 rounded border border-blue-200 bg-blue-50 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <strong className="text-blue-800">识别为已有项目</strong>
                <span className="text-blue-700">{assessment.fileCount} 个文件</span>
                <span className="text-blue-700">建议：{PHASE_LABELS[assessment.suggestedPhase]}</span>
                <span className="text-blue-700">置信度 {assessment.confidence}%</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {PHASE_ORDER.map((phase) => (
                  <span key={phase} className={`rounded px-2 py-1 text-[11px] ${assessment.evidence[phase].score > 0 ? 'bg-white text-zinc-700' : 'bg-blue-100 text-blue-400'}`} title={assessment.evidence[phase].paths.join('\n') || '未识别到明确证据'}>
                    {phase} {assessment.evidence[phase].score}
                  </span>
                ))}
              </div>
              <label className="mt-3 block text-xs font-medium text-zinc-700">导入后的当前阶段
                <select value={initialPhase} onChange={(event) => setInitialPhase(event.target.value as Phase)} className="mt-1 w-full rounded border border-blue-200 bg-white px-3 py-2 text-sm text-zinc-800">
                  {PHASE_ORDER.map((phase) => <option key={phase} value={phase}>{phase} · {PHASE_LABELS[phase]}</option>)}
                </select>
              </label>
              {assessment.warnings.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-amber-700">{assessment.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
            </section>
          )}
          {assessment && !assessment.isExistingProject && (
            <div className="mb-3 rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">目录为空，将按全新项目从需求-规格阶段开始。</div>
          )}
          {createError && (
            <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {createError}
            </div>
          )}
          <div className="flex gap-2">
            <button
              onClick={() => void handleCreate()}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500"
            >
              {assessment?.isExistingProject ? '导入并恢复阶段' : '创建'}
            </button>
            <button
              onClick={() => setCreating(false)}
              className="rounded bg-zinc-100 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-200"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {editingProject && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingProject(null) }}>
          <section role="dialog" aria-modal="true" aria-labelledby="edit-project-title" className="w-full max-w-lg rounded-md border border-zinc-300 bg-white p-5 shadow-xl">
            <h2 id="edit-project-title" className="text-base font-semibold text-zinc-900">编辑项目信息</h2>
            <label className="mt-4 block text-xs font-medium text-zinc-600">项目名称</label>
            <input autoFocus value={editName} onChange={(event) => setEditName(event.target.value)} className="mt-1 w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" />
            <label className="mt-3 block text-xs font-medium text-zinc-600">项目描述</label>
            <textarea value={editDescription} onChange={(event) => setEditDescription(event.target.value)} rows={5} placeholder="说明项目目标、主要接口、应用场景和关键约束" className="mt-1 w-full resize-y rounded border border-zinc-300 bg-white px-3 py-2 text-sm leading-6 outline-none focus:border-blue-500" />
            <p className="mt-2 text-xs text-zinc-500">项目目录和开发阶段不会因此改变。</p>
            {editError && <p className="mt-2 text-xs text-red-600">{editError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setEditingProject(null)} className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">取消</button>
              <button disabled={!editName.trim()} onClick={() => void saveEdit()} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-40">保存</button>
            </div>
          </section>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="mt-20 text-center text-zinc-400">
          <Cpu className="mx-auto mb-3" size={38} strokeWidth={1.3} />
          <p>暂无项目，点击「新建项目」开始芯片设计流程</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              onDelete={handleDelete}
              onMigrate={migratingProjectId ? undefined : handleMigrate}
              onEdit={beginEdit}
            />
          ))}
        </div>
      )}
    </div>
  )
}
