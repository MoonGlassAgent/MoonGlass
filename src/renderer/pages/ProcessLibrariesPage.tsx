import { useCallback, useEffect, useState } from 'react'
import { Download, ExternalLink, FolderOpen, Library, RefreshCw, Trash2 } from 'lucide-react'
import type { OpenProcessLibrary, ProcessLibraryRecord } from '@shared/types'

const KIND_LABELS: Record<string, string> = {
  liberty: 'Liberty', lef: 'LEF', gds: 'GDS', verilog: 'Verilog', spice: 'SPICE/CDL', tech: 'Tech', mapping: 'Map', other: '其他'
}

const MATURITY_LABELS: Record<OpenProcessLibrary['maturity'], string> = {
  reference: '参考平台', experimental: '实验版本', research: '研究用途'
}

export function ProcessLibrariesPage(): React.JSX.Element {
  const [libraries, setLibraries] = useState<ProcessLibraryRecord[]>([])
  const [catalog, setCatalog] = useState<OpenProcessLibrary[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  const refresh = useCallback(async (): Promise<void> => {
    const [records, entries] = await Promise.all([
      window.moonglass.processLibrary.list(),
      window.moonglass.processLibrary.catalog()
    ])
    setLibraries(records)
    setCatalog(entries)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const run = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    setError('')
    try {
      await action()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const addLocal = (): void => {
    void run('add', () => window.moonglass.processLibrary.chooseAndAdd())
  }

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-zinc-900">工艺库</h1>
          <p className="mt-1 text-sm text-zinc-500">管理综合与物理实现使用的本地 PDK、标准单元库和宏视图。</p>
        </div>
        <button type="button" onClick={addLocal} disabled={busy !== null} className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500">
          <FolderOpen size={16} /> 添加本地目录
        </button>
      </div>

      {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-800">已登记工艺库</h2>
          <span className="text-xs text-zinc-400">Agent 自动读取统一索引</span>
        </div>
        {libraries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 py-10 text-center text-sm text-zinc-500">
            <Library className="mx-auto mb-2 text-zinc-400" size={28} strokeWidth={1.4} />
            尚未登记工艺库
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
            {libraries.map((library, index) => (
              <div key={library.id} className={`process-library-row p-4 ${index > 0 ? 'border-t border-zinc-200' : ''}`}>
                <div className="flex min-w-0 items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-zinc-900">{library.name}</h3>
                      <span className={`status-dot status-${library.status}`} />
                      <span className="text-xs text-zinc-500">{library.status === 'ready' ? '索引就绪' : library.status === 'missing' ? '目录不存在' : library.status === 'error' ? '索引失败' : '索引中'}</span>
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px] text-zinc-400" title={library.path}>{library.path}</div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {library.files.filter((group) => group.kind !== 'other').map((group) => (
                        <span key={group.kind} className="rounded border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-600" title={group.examples.join('\n')}>
                          {KIND_LABELS[group.kind] ?? group.kind} {group.count}
                        </span>
                      ))}
                      <span className="px-1 py-0.5 text-[11px] text-zinc-400">共 {library.fileCount.toLocaleString()} 个文件</span>
                    </div>
                    {library.error && <p className="mt-2 text-xs text-red-600">{library.error}</p>}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button type="button" className="icon-button" title="打开目录" onClick={() => void window.moonglass.processLibrary.openFolder(library.id)}><ExternalLink size={15} /></button>
                    <button type="button" className="icon-button" title="重新建立索引" disabled={busy !== null} onClick={() => void run(`index-${library.id}`, () => window.moonglass.processLibrary.reindex(library.id))}><RefreshCw className={busy === `index-${library.id}` ? 'animate-spin' : ''} size={15} /></button>
                    <button type="button" className="icon-button danger" title="移除登记（不会删除目录）" disabled={busy !== null} onClick={() => void run(`remove-${library.id}`, () => window.moonglass.processLibrary.remove(library.id))}><Trash2 size={15} /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-zinc-800">开源工艺库</h2>
          <p className="mt-1 text-xs text-zinc-500">下载内容来自公开项目；实验与研究库不可直接视为量产签核依据。</p>
        </div>
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {catalog.map((item) => (
            <article key={item.id} className="process-catalog-item rounded-lg border border-zinc-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-zinc-900">{item.name}</h3>
                    <span className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] text-zinc-600">{item.node}</span>
                    <span className="text-[10px] text-zinc-400">{MATURITY_LABELS[item.maturity]}</span>
                  </div>
                  <p className="mt-2 text-xs leading-5 text-zinc-600">{item.description}</p>
                </div>
                <button
                  type="button"
                  disabled={busy !== null || item.installed}
                  onClick={() => void run(`download-${item.id}`, () => window.moonglass.processLibrary.download(item.id))}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:border-zinc-400 hover:bg-zinc-50"
                >
                  <Download className={busy === `download-${item.id}` ? 'animate-pulse' : ''} size={14} />
                  {item.installed ? '已安装' : busy === `download-${item.id}` ? '下载并索引中' : '下载'}
                </button>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-zinc-100 pt-3 text-[11px] text-zinc-400">
                <span>{item.license}</span>
                <a href={item.repository} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-zinc-700">官方仓库 <ExternalLink size={11} /></a>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
