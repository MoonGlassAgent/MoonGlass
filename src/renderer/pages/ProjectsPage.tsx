/**
 * 项目列表页（规格书 §5.2）
 */

import { useEffect, useState } from 'react'
import { ProjectCard } from '../components/ProjectCard'
import { useAppStore } from '../store/appStore'

export function ProjectsPage(): React.JSX.Element {
  const { projects, refreshProjects } = useAppStore()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  const handleCreate = async (): Promise<void> => {
    if (!name.trim()) return
    await window.moonglass.project.create({ name: name.trim(), description: description.trim() || undefined })
    setName('')
    setDescription('')
    setCreating(false)
    await refreshProjects()
  }

  const handleDelete = async (id: string): Promise<void> => {
    await window.moonglass.project.delete(id)
    await refreshProjects()
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-zinc-900">芯片项目</h1>
          <p className="mt-1 text-sm text-zinc-500">
            每个项目走 7 阶段流程：REQ → SPEC → ARCH → RTL → VERIF → QA → SYNTH
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
        >
          + 新建项目
        </button>
      </div>

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
          <div className="mb-2 text-4xl">🌙</div>
          <p>暂无项目，点击「新建项目」开始芯片设计流程</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  )
}
