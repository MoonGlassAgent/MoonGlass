import { useCallback, useEffect, useState } from 'react'
import { Download, ExternalLink, FolderOpen, Library, RefreshCw, Trash2 } from 'lucide-react'
import type { OpenProcessLibrary, ProcessLibraryRecord } from '@shared/types'
import { useTranslation, type MessageKey } from '../i18n'

const KIND_LABEL_KEYS: Record<string, MessageKey> = {
  liberty: 'processLibraries.kind.liberty', lef: 'processLibraries.kind.lef', gds: 'processLibraries.kind.gds',
  verilog: 'processLibraries.kind.verilog', spice: 'processLibraries.kind.spice', tech: 'processLibraries.kind.tech',
  mapping: 'processLibraries.kind.mapping', other: 'processLibraries.kind.other'
}

const MATURITY_LABEL_KEYS: Record<OpenProcessLibrary['maturity'], MessageKey> = {
  reference: 'processLibraries.maturity.reference',
  experimental: 'processLibraries.maturity.experimental',
  research: 'processLibraries.maturity.research'
}

const STATUS_LABEL_KEYS: Record<ProcessLibraryRecord['status'], MessageKey> = {
  ready: 'processLibraries.status.ready',
  missing: 'processLibraries.status.missing',
  indexing: 'processLibraries.status.indexing',
  error: 'processLibraries.status.error'
}

export function ProcessLibrariesPage(): React.JSX.Element {
  const { t } = useTranslation()
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
          <h1 className="text-xl font-bold text-zinc-900">{t('processLibraries.title')}</h1>
          <p className="mt-1 text-sm text-zinc-500">{t('processLibraries.description')}</p>
        </div>
        <button type="button" onClick={addLocal} disabled={busy !== null} className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500">
          <FolderOpen size={16} /> {t('processLibraries.addLocal')}
        </button>
      </div>

      {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-800">{t('processLibraries.registered.title')}</h2>
          <span className="text-xs text-zinc-400">{t('processLibraries.registered.hint')}</span>
        </div>
        {libraries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 py-10 text-center text-sm text-zinc-500">
            <Library className="mx-auto mb-2 text-zinc-400" size={28} strokeWidth={1.4} />
            {t('processLibraries.registered.empty')}
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
                      <span className="text-xs text-zinc-500">{t(STATUS_LABEL_KEYS[library.status])}</span>
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px] text-zinc-400" title={library.path}>{library.path}</div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {library.files.filter((group) => group.kind !== 'other').map((group) => (
                        <span key={group.kind} className="rounded border border-zinc-200 bg-zinc-50 px-2 py-0.5 text-[11px] text-zinc-600" title={group.examples.join('\n')}>
                          {KIND_LABEL_KEYS[group.kind] ? t(KIND_LABEL_KEYS[group.kind]) : group.kind} {group.count}
                        </span>
                      ))}
                      <span className="px-1 py-0.5 text-[11px] text-zinc-400">{t('processLibraries.fileCount', { count: library.fileCount.toLocaleString() })}</span>
                    </div>
                    {library.error && <p className="mt-2 text-xs text-red-600">{library.error}</p>}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button type="button" className="icon-button" title={t('processLibraries.actions.openFolder')} onClick={() => void window.moonglass.processLibrary.openFolder(library.id)}><ExternalLink size={15} /></button>
                    <button type="button" className="icon-button" title={t('processLibraries.actions.reindex')} disabled={busy !== null} onClick={() => void run(`index-${library.id}`, () => window.moonglass.processLibrary.reindex(library.id))}><RefreshCw className={busy === `index-${library.id}` ? 'animate-spin' : ''} size={15} /></button>
                    <button type="button" className="icon-button danger" title={t('processLibraries.actions.remove')} disabled={busy !== null} onClick={() => void run(`remove-${library.id}`, () => window.moonglass.processLibrary.remove(library.id))}><Trash2 size={15} /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3">
          <h2 className="text-sm font-semibold text-zinc-800">{t('processLibraries.openSource.title')}</h2>
          <p className="mt-1 text-xs text-zinc-500">{t('processLibraries.openSource.note')}</p>
        </div>
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {catalog.map((item) => (
            <article key={item.id} className="process-catalog-item rounded-lg border border-zinc-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-zinc-900">{item.name}</h3>
                    <span className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] text-zinc-600">{item.node}</span>
                    <span className="text-[10px] text-zinc-400">{t(MATURITY_LABEL_KEYS[item.maturity])}</span>
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
                  {item.installed ? t('processLibraries.openSource.installed') : busy === `download-${item.id}` ? t('processLibraries.openSource.downloading') : t('processLibraries.openSource.download')}
                </button>
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-zinc-100 pt-3 text-[11px] text-zinc-400">
                <span>{item.license}</span>
                <a href={item.repository} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-zinc-700">{t('processLibraries.openSource.repository')} <ExternalLink size={11} /></a>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
