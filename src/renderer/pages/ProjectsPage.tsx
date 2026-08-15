/**
 * 项目列表页（规格书 §5.2）
 */

import { useEffect, useState } from 'react'
import { Cpu, FolderOpen, Plus } from 'lucide-react'
import { ProjectCard } from '../components/ProjectCard'
import { useAppStore } from '../store/appStore'

export function ProjectsPage(): React.JSX.Element {
  const { projects, refreshProjects } = useAppStore()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [createError, setCreateError] = useState('')
  const [migrationMessage, setMigrationMessage] = useState('')
  const [migrationError, setMigrationError] = useState('')
  const [migratingProjectId, setMigratingProjectId] = useState<string | null>(null)

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  const handleCreate = async (): Promise<void> => {
    if (!name.trim()) return
    setCreateError('')
    try {
      await window.moonglass.project.create({
        name: name.trim(),
        description: description.trim() || undefined,
        workspacePath: workspacePath.trim() || undefined
      })
      setName('')
      setDescription('')
      setWorkspacePath('')
      setCreating(false)
      await refreshProjects()
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : String(error))
    }
  }

  const handleChooseDirectory = async (): Promise<void> => {
    const selected = await window.moonglass.project.chooseDirectory()
    if (selected) setWorkspacePath(selected)
  }

  const handleDelete = async (id: string): Promise<void> => {
    await window.moonglass.project.delete(id)
    await refreshProjects()
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
              onChange={(e) => setWorkspacePath(e.target.value)}
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
          </div>
          <p className="mb-3 text-xs text-zinc-500">可选择已有工程目录；MoonGlass 只补齐缺失的规范目录，不覆盖现有文件。</p>
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
              创建
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
            />
          ))}
        </div>
      )}
    </div>
  )
}
