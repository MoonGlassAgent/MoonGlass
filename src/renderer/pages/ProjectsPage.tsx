/**
 * 项目列表页（规格书 §5.2）
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Cpu, FolderOpen, Plus, ScanSearch } from 'lucide-react'
import { PHASE_ORDER, type ChipProject, type Phase, type ProjectImportAssessment, type ProjectSessionActivity } from '@shared/types'
import { ProjectCard } from '../components/ProjectCard'
import { phaseLabel, useTranslation } from '../i18n'
import { useAppStore } from '../store/appStore'
import { useManagedStore } from '../store/managedStore'

/** 项目卡片自定义顺序的 localStorage 键 */
const PROJECT_ORDER_KEY = 'moonglass:project-order'

/** 读取用户自定义卡片顺序；损坏时回退为空（按创建时间稳定排序） */
function loadProjectOrder(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(PROJECT_ORDER_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

export function ProjectsPage(): React.JSX.Element {
  const { t } = useTranslation()
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
  const [sessionActivity, setSessionActivity] = useState<Record<string, ProjectSessionActivity>>({})
  const managedByProject = useManagedStore((state) => state.byProject)
  /** 用户自定义卡片顺序（localStorage 持久化）；未保存过的项目按创建时间稳定排序追加在后 */
  const [customOrder, setCustomOrder] = useState<string[]>(loadProjectOrder)
  /** 长按拖拽状态：正在拖动的卡片、指针位置与抓取点偏移 */
  const [dragState, setDragState] = useState<{ id: string; x: number; y: number; offsetX: number; offsetY: number; width: number; height: number } | null>(null)
  /** 拖拽过程中的实时顺序（松手时持久化） */
  const [liveOrder, setLiveOrder] = useState<string[] | null>(null)
  const longPressRef = useRef<{ timer: number; startX: number; startY: number } | null>(null)
  const suppressClickRef = useRef(false)
  const gridRef = useRef<HTMLDivElement>(null)
  /** FLIP 动画：重排前各卡片的位置快照 */
  const positionsRef = useRef<Map<string, DOMRect>>(new Map())

  // 卡片展示顺序：自定义顺序优先，新建/未保存的项目按创建时间升序稳定追加——
  // 主进程 list() 按 updatedAt 排序会导致"点进项目回来位置变了"，这里覆盖为稳定顺序
  const orderedProjects = useMemo(() => {
    const byId = new Map(projects.map((p) => [p.id, p]))
    const ordered: ChipProject[] = []
    for (const id of customOrder) {
      const project = byId.get(id)
      if (project) {
        ordered.push(project)
        byId.delete(id)
      }
    }
    const rest = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    return [...ordered, ...rest]
  }, [projects, customOrder])

  const displayProjects = liveOrder
    ? liveOrder.flatMap((id) => orderedProjects.filter((p) => p.id === id))
    : orderedProjects

  const persistOrder = (ids: string[]): void => {
    setCustomOrder(ids)
    localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(ids))
  }

  /** 重排前捕获各卡片位置，供 useLayoutEffect 做 FLIP 位移动画 */
  const capturePositions = (): void => {
    const map = new Map<string, DOMRect>()
    gridRef.current?.querySelectorAll('[data-project-card]').forEach((el) => {
      const id = el.getAttribute('data-project-card')
      if (id) map.set(id, el.getBoundingClientRect())
    })
    positionsRef.current = map
  }

  // FLIP：展示顺序变化后，把位置变化的卡片从旧位置平滑滑动到新位置（"挤开"效果）
  useLayoutEffect(() => {
    const prev = positionsRef.current
    if (prev.size === 0) return
    positionsRef.current = new Map()
    gridRef.current?.querySelectorAll('[data-project-card]').forEach((el) => {
      const id = el.getAttribute('data-project-card')
      const before = id ? prev.get(id) : undefined
      if (!before) return
      const after = el.getBoundingClientRect()
      const dx = before.left - after.left
      const dy = before.top - after.top
      if (dx === 0 && dy === 0) return
      const htmlEl = el as HTMLElement
      htmlEl.style.transition = 'none'
      htmlEl.style.transform = `translate(${dx}px, ${dy}px)`
      requestAnimationFrame(() => {
        htmlEl.style.transition = 'transform 180ms ease'
        htmlEl.style.transform = ''
      })
    })
  }, [displayProjects])

  /** 长按卡片（350ms）进入拖拽；按住期间允许移动（肌肉记忆的先按后拖），仅松手取消 */
  const handleCardPointerDown = (id: string) => (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0 || dragState) return
    const rect = event.currentTarget.getBoundingClientRect()
    const { clientX, clientY } = event
    const timer = window.setTimeout(() => {
      longPressRef.current = null
      suppressClickRef.current = true
      capturePositions()
      setLiveOrder(orderedProjects.map((p) => p.id))
      setDragState({ id, x: clientX, y: clientY, offsetX: clientX - rect.left, offsetY: clientY - rect.top, width: rect.width, height: rect.height })
    }, 350)
    longPressRef.current = { timer, startX: clientX, startY: clientY }
  }

  const cancelLongPress = (): void => {
    const pending = longPressRef.current
    if (!pending) return
    window.clearTimeout(pending.timer)
    longPressRef.current = null
  }

  // 拖拽中的全局指针监听：实时重排 + 松手持久化 + Esc 取消
  useEffect(() => {
    if (!dragState) return
    const draggedId = dragState.id
    const onPointerMove = (event: PointerEvent): void => {
      const x = event.clientX
      const y = event.clientY
      setDragState((current) => (current ? { ...current, x, y } : current))
      const targetEl = document.elementFromPoint(x, y)?.closest('[data-project-card]')
      const targetId = targetEl?.getAttribute('data-project-card')
      if (!targetId || targetId === draggedId) return
      const rect = targetEl!.getBoundingClientRect()
      const inRowBand = y >= rect.top && y <= rect.bottom
      const insertBefore = inRowBand ? x < rect.left + rect.width / 2 : y < rect.top + rect.height / 2
      setLiveOrder((current) => {
        if (!current) return current
        const from = current.indexOf(draggedId)
        let to = current.indexOf(targetId)
        if (from < 0 || to < 0) return current
        if (!insertBefore) to += 1
        if (from === to || from + 1 === to) return current
        const next = [...current]
        next.splice(from, 1)
        next.splice(from < to ? to - 1 : to, 0, draggedId)
        capturePositions()
        return next
      })
    }
    const onPointerUp = (): void => {
      setLiveOrder((current) => {
        if (current) persistOrder(current)
        return null
      })
      setDragState(null)
      // click 在 pointerup 后同步派发，需等它过完再解除抑制
      window.setTimeout(() => { suppressClickRef.current = false }, 0)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setLiveOrder(null)
        setDragState(null)
        window.setTimeout(() => { suppressClickRef.current = false }, 0)
      }
    }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('keydown', onKeyDown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragState !== null])

  useEffect(() => {
    void refreshProjects()
  }, [refreshProjects])

  // 会话活动徽标轮询（3s，离开页面清理；失败保留旧数据不闪烁）
  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const activity = await window.moonglass.agent.getSessionActivity().catch(() => null)
      if (!cancelled && activity) setSessionActivity(activity)
    }
    void load()
    const timer = window.setInterval(() => void load(), 3_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [])

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
        setImportMessage(t('projects.importedMessage', { phase: initialPhase, phaseLabel: phaseLabel(initialPhase) }))
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
      setCreateError(t('projects.scanFailed', { error: error instanceof Error ? error.message : String(error) }))
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
      t('projects.migrateConfirm', { name: project.name, destination })
    )
    if (!confirmed) return
    setMigratingProjectId(project.id)
    setMigrationError('')
    setMigrationMessage(t('projects.migrating', { name: project.name }))
    try {
      const result = await window.moonglass.project.migrate(project.id, destination)
      setMigrationMessage(t('projects.migrated', { name: project.name, count: result.copiedFiles }))
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
          <h1 className="text-xl font-bold text-zinc-900">{t('projects.title')}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {t('projects.subtitle')}
          </p>
        </div>
        <button
          onClick={() => setCreating(true)}
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500"
        >
          <Plus size={16} /> {t('projects.newProject')}
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
          {t('projects.migrateFailed', { error: migrationError })}
        </div>
      )}

      {creating && (
        <div className="mb-6 rounded-lg border border-zinc-300 bg-white p-4">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('projects.namePlaceholder')}
            className="mb-2 w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('projects.descriptionPlaceholder')}
            className="mb-3 w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
          />
          <label className="mb-1 block text-xs font-medium text-zinc-600">{t('projects.directoryLabel')}</label>
          <div className="mb-2 flex gap-2">
            <input
              value={workspacePath}
              onChange={(e) => { setWorkspacePath(e.target.value); setAssessment(null); setAssessmentPath('') }}
              placeholder={t('projects.directoryPlaceholder')}
              className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
            />
            <button
              type="button"
              onClick={() => void handleChooseDirectory()}
              title={t('projects.chooseDirectory')}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50"
            >
              <FolderOpen size={17} />
            </button>
            <button
              type="button"
              onClick={() => void analyzeDirectory(workspacePath.trim()).catch((error) => setCreateError(t('projects.scanFailed', { error: error instanceof Error ? error.message : String(error) })))}
              disabled={!workspacePath.trim() || analyzing}
              title={t('projects.scanPhases')}
              className="inline-flex size-9 shrink-0 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 disabled:opacity-40"
            >
              <ScanSearch size={17} className={analyzing ? 'animate-pulse' : ''} />
            </button>
          </div>
          <p className="mb-3 text-xs text-zinc-500">{t('projects.directoryHint')}</p>
          {analyzing && <div className="mb-3 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700">{t('projects.analyzing')}</div>}
          {assessment?.isExistingProject && (
            <section className="mb-3 rounded border border-blue-200 bg-blue-50 p-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <strong className="text-blue-800">{t('projects.existingProjectDetected')}</strong>
                <span className="text-blue-700">{t('projects.fileCount', { count: assessment.fileCount })}</span>
                <span className="text-blue-700">{t('projects.suggested', { phase: phaseLabel(assessment.suggestedPhase) })}</span>
                <span className="text-blue-700">{t('projects.confidence', { value: assessment.confidence })}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {PHASE_ORDER.map((phase) => (
                  <span key={phase} className={`rounded px-2 py-1 text-[11px] ${assessment.evidence[phase].score > 0 ? 'bg-white text-zinc-700' : 'bg-blue-100 text-blue-400'}`} title={assessment.evidence[phase].paths.join('\n') || t('projects.noEvidence')}>
                    {phase} {assessment.evidence[phase].score}
                  </span>
                ))}
              </div>
              <label className="mt-3 block text-xs font-medium text-zinc-700">{t('projects.initialPhaseLabel')}
                <select value={initialPhase} onChange={(event) => setInitialPhase(event.target.value as Phase)} className="mt-1 w-full rounded border border-blue-200 bg-white px-3 py-2 text-sm text-zinc-800">
                  {PHASE_ORDER.map((phase) => <option key={phase} value={phase}>{phase} · {phaseLabel(phase)}</option>)}
                </select>
              </label>
              {assessment.warnings.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-[11px] text-amber-700">{assessment.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
            </section>
          )}
          {assessment && !assessment.isExistingProject && (
            <div className="mb-3 rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">{t('projects.emptyDirectory')}</div>
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
              {assessment?.isExistingProject ? t('projects.importAndRestore') : t('common.create')}
            </button>
            <button
              onClick={() => setCreating(false)}
              className="rounded bg-zinc-100 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-200"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}

      {editingProject && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setEditingProject(null) }}>
          <section role="dialog" aria-modal="true" aria-labelledby="edit-project-title" className="w-full max-w-lg rounded-md border border-zinc-300 bg-white p-5 shadow-xl">
            <h2 id="edit-project-title" className="text-base font-semibold text-zinc-900">{t('projects.editTitle')}</h2>
            <label className="mt-4 block text-xs font-medium text-zinc-600">{t('projects.nameLabel')}</label>
            <input autoFocus value={editName} onChange={(event) => setEditName(event.target.value)} className="mt-1 w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500" />
            <label className="mt-3 block text-xs font-medium text-zinc-600">{t('projects.descriptionLabel')}</label>
            <textarea value={editDescription} onChange={(event) => setEditDescription(event.target.value)} rows={5} placeholder={t('projects.editDescriptionPlaceholder')} className="mt-1 w-full resize-y rounded border border-zinc-300 bg-white px-3 py-2 text-sm leading-6 outline-none focus:border-blue-500" />
            <p className="mt-2 text-xs text-zinc-500">{t('projects.editHint')}</p>
            {editError && <p className="mt-2 text-xs text-red-600">{editError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setEditingProject(null)} className="rounded border border-zinc-300 px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100">{t('common.cancel')}</button>
              <button disabled={!editName.trim()} onClick={() => void saveEdit()} className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-500 disabled:opacity-40">{t('common.save')}</button>
            </div>
          </section>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="mt-20 text-center text-zinc-400">
          <Cpu className="mx-auto mb-3" size={38} strokeWidth={1.3} />
          <p>{t('projects.emptyState')}</p>
        </div>
      ) : (<>
        <div ref={gridRef} className={`grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3 ${dragState ? 'select-none' : ''}`}>
          {displayProjects.map((p) => {
            const isDragged = dragState?.id === p.id
            return (
              <div
                key={p.id}
                data-project-card={p.id}
                className="relative"
                style={isDragged && dragState ? { height: dragState.height } : undefined}
                onPointerDown={handleCardPointerDown(p.id)}
                onPointerUp={cancelLongPress}
                onPointerCancel={cancelLongPress}
                onClickCapture={(event) => {
                  // 长按拖拽结束后抑制随后的 click，避免误进项目
                  if (suppressClickRef.current) {
                    event.preventDefault()
                    event.stopPropagation()
                  }
                }}
              >
                {isDragged ? (
                  // 拖拽中：原位置渲染占位框，其他卡片实时挤开排位
                  <div className="flex h-full items-center justify-center rounded-lg border-2 border-dashed border-sky-300 bg-sky-50/40 text-xs text-sky-500">
                    {p.name}
                  </div>
                ) : (
                  <ProjectCard
                    project={p}
                    activity={sessionActivity[p.id]}
                    managed={managedByProject[p.id]}
                    onDelete={handleDelete}
                    onMigrate={migratingProjectId ? undefined : handleMigrate}
                    onEdit={beginEdit}
                  />
                )}
              </div>
            )
          })}
        </div>
        {/* 拖拽幽灵卡：跟随指针的简化卡片 */}
        {dragState && (
          <div
            className="pointer-events-none fixed z-50 rounded-lg border border-sky-300 bg-white p-4 opacity-90 shadow-xl"
            style={{ left: dragState.x - dragState.offsetX, top: dragState.y - dragState.offsetY, width: dragState.width }}
          >
            <div className="font-semibold text-zinc-900">{orderedProjects.find((p) => p.id === dragState.id)?.name}</div>
            <div className="mt-1 text-xs text-zinc-500">
              {phaseLabel(orderedProjects.find((p) => p.id === dragState.id)?.currentPhase ?? 'REQ_SPEC')}
            </div>
          </div>
        )}
      </>)}
    </div>
  )
}
