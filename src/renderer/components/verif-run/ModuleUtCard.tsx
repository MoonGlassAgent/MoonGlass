/**
 * 模块 UT 卡（设计文档 MODULE-UT-DESIGN-ZH-CN §1-§4，渲染端交接 MODULE-UT-UI-HANDOFF-ZH-CN）
 *
 * 模块级轻量 UT：对指定 RTL 子模块派发独立子会话（probe 隔离，不进主证据链），
 * UT 期间主验证循环互斥挂起。本卡提供：
 * - 「发起模块 UT」入口（模块名输入 + rtl/ 下文件推导的候选下拉）；
 * - UT 进行中状态行（数据源 ut-sessions.json，由集成方随验证运行数据加载传入）。
 *
 * UT 会话本身复用会话标签机制（phase-verif--ut-<module>），无需额外开发。
 */

import { useState } from 'react'
import { FlaskConical, Play } from 'lucide-react'
import type { FileTreeNode } from '@shared/types'
import { useTranslation } from '../../i18n'
import type { UtSessionsView } from './types'

export interface ModuleUtCardProps {
  projectId: string
  /** UT 账本视图（null=无账本/未加载 → 空闲态） */
  ut: UtSessionsView | null
  /** 发起 UT（集成方负责调 startModuleUt IPC 并透出错误） */
  onStart: (moduleName: string) => Promise<void>
}

/** 从项目文件树推导 rtl/ 下的模块名候选（文件名≈模块名，module-filename 规则口径） */
async function listRtlModuleCandidates(projectId: string): Promise<string[]> {
  try {
    const tree = await window.moonglass.fs.tree(projectId)
    const names = new Set<string>()
    const walk = (nodes: FileTreeNode[], inRtl: boolean): void => {
      for (const node of nodes) {
        const isRtl = inRtl || /^(rtl|src|hdl)$/i.test(node.name)
        if (node.type === 'dir') walk(node.children ?? [], isRtl)
        else if (isRtl && /\.(?:v|sv)$/i.test(node.name)) names.add(node.name.replace(/\.(?:v|sv)$/i, ''))
      }
    }
    walk(tree, false)
    return [...names].sort()
  } catch {
    return []
  }
}

export function ModuleUtCard({ projectId, ut, onStart }: ModuleUtCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [moduleName, setModuleName] = useState('')
  const [candidates, setCandidates] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const openDialog = (): void => {
    setError('')
    setDialogOpen(true)
    void listRtlModuleCandidates(projectId).then(setCandidates)
  }

  const submit = async (): Promise<void> => {
    const name = moduleName.trim()
    if (!name || busy) {
      if (!name) setError(t('verifRun.ut.emptyModule'))
      return
    }
    setBusy(true)
    setError('')
    try {
      await onStart(name)
      setDialogOpen(false)
      setModuleName('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const active = ut?.active ?? 0
  return <section className="rounded border border-zinc-200 bg-white p-4">
    <div className="flex items-center gap-2">
      <FlaskConical size={15} className="text-zinc-400" />
      <h3 className="text-sm font-semibold">{t('verifRun.ut.title')}</h3>
      {active > 0 && <span className="inline-flex items-center gap-1 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />{t('verifRun.ut.activeBadge', { count: active })}
      </span>}
      <button
        type="button"
        onClick={openDialog}
        className="ml-auto inline-flex items-center gap-1.5 rounded border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 hover:border-emerald-500 hover:text-emerald-700"
      >
        <Play size={12} />{t('verifRun.ut.start')}
      </button>
    </div>

    {active > 0 ? (
      <div className="mt-3 rounded border border-sky-200 bg-sky-50/60 px-3 py-2 text-xs text-sky-800">
        {ut && ut.modules.length > 0
          ? t('verifRun.ut.activeLine', { count: active, modules: ut.modules.join('、') })
          : t('verifRun.ut.activeNoNames', { count: active })}
      </div>
    ) : (
      <p className="mt-3 text-xs text-zinc-500">{t('verifRun.ut.idleHint')}</p>
    )}

    {dialogOpen && (
      <div className="mt-3 rounded border border-zinc-300 bg-zinc-50/60 p-3">
        <div className="text-xs font-medium text-zinc-700">{t('verifRun.ut.dialogTitle')}</div>
        <div className="mt-2 flex items-center gap-2">
          <input
            autoFocus
            list="module-ut-candidates"
            value={moduleName}
            onChange={(event) => { setModuleName(event.target.value); setError('') }}
            onKeyDown={(event) => { if (event.key === 'Enter') void submit(); if (event.key === 'Escape') setDialogOpen(false) }}
            placeholder={t('verifRun.ut.modulePlaceholder')}
            className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-2.5 py-1.5 font-mono text-xs outline-none focus:border-blue-500"
          />
          <datalist id="module-ut-candidates">
            {candidates.map((name) => <option key={name} value={name} />)}
          </datalist>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="shrink-0 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {busy ? t('verifRun.ut.starting') : t('verifRun.ut.confirm')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setDialogOpen(false)}
            className="shrink-0 rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
        </div>
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </div>
    )}
  </section>
}
