import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { ExternalLink, FolderOpen, PackagePlus, RefreshCw, Search, Sparkles, Trash2 } from 'lucide-react'
import type { IpLibraryFileKind, IpLibraryRecord, IpTemplateRecord } from '@shared/types'
import { t, useTranslation, type MessageKey } from '../i18n'

/** 类型预设同时作为表单默认值与模板分组标题，随界面语言切换 */
function typePresets(): string[] {
  return [
    t('ipLibrary.presets.busInterface'),
    t('ipLibrary.presets.storage'),
    t('ipLibrary.presets.clock'),
    t('ipLibrary.presets.arbiter'),
    t('ipLibrary.presets.utility'),
    t('ipLibrary.presets.userImported')
  ]
}

const STATUS_LABEL_KEYS: Record<IpLibraryRecord['status'], MessageKey> = {
  ready: 'ipLibrary.status.ready',
  missing: 'ipLibrary.status.missing',
  indexing: 'ipLibrary.status.indexing',
  error: 'ipLibrary.status.error'
}

const KIND_LABEL_KEYS: Record<IpLibraryFileKind, MessageKey> = {
  rtl: 'ipLibrary.kind.rtl',
  verification: 'ipLibrary.kind.verification',
  document: 'ipLibrary.kind.document',
  constraint: 'ipLibrary.kind.constraint',
  script: 'ipLibrary.kind.script',
  metadata: 'ipLibrary.kind.metadata',
  other: 'ipLibrary.kind.other'
}

const COMPONENT_LABEL_KEYS: Record<NonNullable<IpTemplateRecord['componentKind']>, MessageKey> = {
  'rtl-ip': 'ipLibrary.component.rtlIp',
  'verification-component': 'ipLibrary.component.verificationComponent',
  mixed: 'ipLibrary.component.mixed',
  reference: 'ipLibrary.component.reference'
}

function pathBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function librarySubtitle(library: IpLibraryRecord): string {
  const source = library.source === 'builtin' ? t('ipLibrary.sourceBuiltin') : t('ipLibrary.sourceLocal')
  return t('ipLibrary.subtitle', {
    source,
    type: library.type,
    ipCount: library.ipCount,
    fileCount: library.fileCount.toLocaleString()
  })
}

function matchIp(ip: IpTemplateRecord, query: string): boolean {
  const value = query.trim().toLowerCase()
  if (!value) return true
  return [ip.name, ip.type, ip.topModule, ip.summary, ip.path]
    .filter((item): item is string => Boolean(item))
    .some((item) => item.toLowerCase().includes(value))
}

type IpLibraryApi = Window['moonglass']['ipLibrary']

function getIpLibraryApi(): IpLibraryApi {
  const api = (window.moonglass as Window['moonglass'] & { ipLibrary?: IpLibraryApi }).ipLibrary
  if (!api) throw new Error(t('ipLibrary.apiNotReady'))
  return api
}

export function IpLibraryPage(): React.JSX.Element {
  const { t } = useTranslation()
  const [libraries, setLibraries] = useState<IpLibraryRecord[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [tip, setTip] = useState('')
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState(() => ({ path: '', name: '', type: t('ipLibrary.presets.userImported') }))
  const [apiReady, setApiReady] = useState(() => {
    try {
      return Boolean(getIpLibraryApi())
    } catch {
      return false
    }
  })

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const api = getIpLibraryApi()
      setApiReady(true)
      setError('')
      setLibraries(await api.list())
    } catch (cause) {
      setApiReady(false)
      setLibraries([])
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const run = async (key: string, action: () => Promise<unknown>): Promise<void> => {
    setBusy(key)
    setError('')
    setTip('')
    try {
      await action()
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const chooseDirectory = async (): Promise<void> => {
    setError('')
    setTip('')
    try {
      const selected = await getIpLibraryApi().chooseDirectory()
      if (!selected) return
      setDraft((current) => ({
        ...current,
        path: selected,
        name: current.name.trim() || pathBaseName(selected)
      }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const importLibrary = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const input = {
      path: draft.path.trim(),
      name: draft.name.trim() || pathBaseName(draft.path.trim()),
      type: draft.type.trim() || t('ipLibrary.presets.userImported')
    }
    if (!input.path) {
      setError(t('ipLibrary.errorNoPath'))
      return
    }
    await run('import', async () => {
      const record = await getIpLibraryApi().addLocal(input)
      setDraft({ path: '', name: '', type: t('ipLibrary.presets.userImported') })
      setTip(t('ipLibrary.importedTip', { name: record.name, count: record.ipCount }))
    })
  }

  const allIps = useMemo(() => libraries.flatMap((library) => library.ips), [libraries])
  const filteredIps = useMemo(() => allIps.filter((ip) => matchIp(ip, query)), [allIps, query])
  const presets = typePresets()
  const groupedIps = useMemo(() => {
    const types = [...new Set([...presets, ...allIps.map((ip) => ip.type)])]
    return types.map((type) => ({
      type,
      ips: filteredIps.filter((ip) => ip.type === type)
    }))
  }, [presets, allIps, filteredIps])

  const readyLibraries = libraries.filter((library) => library.status === 'ready').length
  const importedLibraries = libraries.filter((library) => library.source === 'local').length

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-zinc-900">{t('ipLibrary.title')}</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {t('ipLibrary.description')}
          </p>
        </div>
        <div className="flex gap-2 text-xs text-zinc-500">
          <span className="rounded border border-zinc-200 bg-white px-2 py-1">{t('ipLibrary.readyBadge', { ready: readyLibraries, total: libraries.length })}</span>
          <span className="rounded border border-zinc-200 bg-white px-2 py-1">{t('ipLibrary.localBadge', { count: importedLibraries })}</span>
          <span className="rounded border border-zinc-200 bg-white px-2 py-1">{t('ipLibrary.ipBadge', { count: allIps.length })}</span>
        </div>
      </div>

      <section className="surface-panel mb-5 rounded-lg border border-zinc-200 bg-white p-4">
        {!apiReady && (
          <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {t('ipLibrary.apiNotReady')}
          </div>
        )}
        <form onSubmit={(event) => void importLibrary(event)} className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_180px_2fr_auto]">
          <label className="min-w-0">
            <span className="mb-1 block text-xs font-medium text-zinc-500">{t('ipLibrary.form.nameLabel')}</span>
            <input
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder={t('ipLibrary.form.namePlaceholder')}
              className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800"
            />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-xs font-medium text-zinc-500">{t('ipLibrary.form.typeLabel')}</span>
            <input
              value={draft.type}
              list="ip-library-type-presets"
              onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value }))}
              className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800"
            />
            <datalist id="ip-library-type-presets">
              {presets.map((type) => <option key={type} value={type} />)}
            </datalist>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-xs font-medium text-zinc-500">{t('ipLibrary.form.pathLabel')}</span>
            <div className="flex gap-2">
              <input
                value={draft.path}
                onChange={(event) => setDraft((current) => ({ ...current, path: event.target.value }))}
                placeholder="D:\Projects\ip-library"
                className="min-w-0 flex-1 rounded border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-800"
              />
              <button
                type="button"
                onClick={() => void chooseDirectory()}
                disabled={busy !== null || !apiReady}
                className="icon-button h-[38px] w-[38px]"
                title={t('ipLibrary.form.chooseDirectory')}
              >
                <FolderOpen size={16} />
              </button>
            </div>
          </label>
          <div className="flex items-end">
            <button
              type="submit"
              disabled={busy !== null || !apiReady}
              className="inline-flex h-[38px] items-center gap-2 rounded-md bg-blue-600 px-4 text-sm font-medium text-white hover:bg-blue-500"
            >
              <PackagePlus size={16} />
              {busy === 'import' ? t('ipLibrary.form.importing') : t('ipLibrary.form.importSubmit')}
            </button>
          </div>
        </form>
        <p className="mt-3 text-xs text-zinc-500">
          {t('ipLibrary.footnote')}
        </p>
        {error && <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        {tip && <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{tip}</div>}
      </section>

      <section className="mb-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-800">{t('ipLibrary.registered.title')}</h2>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
            disabled={busy !== null}
            onClick={() => void run('refresh', refresh)}
          >
            <RefreshCw className={busy === 'refresh' ? 'animate-spin' : ''} size={14} />
            {t('common.refresh')}
          </button>
        </div>

        {libraries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 py-10 text-center text-sm text-zinc-500">
            {t('ipLibrary.registered.empty')}
          </div>
        ) : (
          <div className="overflow-hidden rounded-lg border border-zinc-200 bg-white">
            {libraries.map((library, index) => (
              <div key={library.id} className={`process-library-row p-4 ${index > 0 ? 'border-t border-zinc-200' : ''}`}>
                <div className="flex min-w-0 items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-sm font-semibold text-zinc-900">{library.name}</h3>
                      <span className={`status-dot status-${library.status}`} />
                      <span className="text-xs text-zinc-500">{t(STATUS_LABEL_KEYS[library.status])}</span>
                      <span className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] text-zinc-600">
                        {library.source === 'builtin' ? t('ipLibrary.sourceBuiltin') : t('ipLibrary.sourceUser')}
                      </span>
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px] text-zinc-400" title={library.path}>{library.path}</div>
                    <div className="mt-2 text-xs text-zinc-500">{librarySubtitle(library)}</div>
                    {library.semanticAnalysisStatus && library.semanticAnalysisStatus !== 'not-run' && (
                      <div className="mt-1 text-xs text-zinc-500">
                        {t('ipLibrary.semantic.label', {
                          status: library.semanticAnalysisStatus === 'completed'
                            ? t('ipLibrary.semantic.completed', { model: library.semanticModel ?? '' })
                            : library.semanticAnalysisStatus === 'running'
                              ? t('ipLibrary.semantic.running')
                              : t('ipLibrary.semantic.failed')
                        })}
                      </div>
                    )}
                    {library.semanticError && <p className="mt-1 text-xs text-red-600">{library.semanticError}</p>}
                    {library.error && <p className="mt-2 text-xs text-red-600">{library.error}</p>}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button type="button" className="icon-button" title={t('ipLibrary.actions.openFolder')} onClick={() => void getIpLibraryApi().openFolder(library.id)}><ExternalLink size={15} /></button>
                    <button type="button" className="icon-button" title={t('ipLibrary.actions.reindex')} disabled={busy !== null} onClick={() => void run(`index-${library.id}`, () => getIpLibraryApi().reindex(library.id))}><RefreshCw className={busy === `index-${library.id}` ? 'animate-spin' : ''} size={15} /></button>
                    {library.source === 'local' && (
                      <>
                        <button type="button" className="icon-button" title={library.semanticAnalysisStatus === 'running' ? t('ipLibrary.actions.enhancing') : t('ipLibrary.actions.enhance')} disabled={busy !== null || library.ipCount === 0 || library.semanticAnalysisStatus === 'running'} onClick={() => void run(`enhance-${library.id}`, async () => {
                          const analyzed = await getIpLibraryApi().enhance(library.id)
                          setTip(t('ipLibrary.piAnalyzedTip', { name: analyzed.name, count: analyzed.ips.filter((ip) => ip.analysisSource === 'pi').length }))
                        })}><Sparkles className={busy === `enhance-${library.id}` ? 'animate-pulse' : ''} size={15} /></button>
                        <button type="button" className="icon-button danger" title={t('ipLibrary.actions.remove')} disabled={busy !== null} onClick={() => void run(`remove-${library.id}`, () => getIpLibraryApi().remove(library.id))}><Trash2 size={15} /></button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-zinc-800">{t('ipLibrary.templates.title')}</h2>
          <label className="relative block w-full max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('ipLibrary.templates.searchPlaceholder')}
              className="w-full rounded border border-zinc-300 bg-white py-2 pl-9 pr-3 text-sm text-zinc-800"
            />
          </label>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {groupedIps.map((group) => (
            <div key={group.type} className="rounded-lg border border-zinc-200 bg-white p-4">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h3 className="font-semibold text-zinc-800">{group.type}</h3>
                <span className="text-xs text-zinc-400">{t('ipLibrary.templates.count', { count: group.ips.length })}</span>
              </div>
              {group.ips.length === 0 ? (
                <div className="rounded border border-dashed border-zinc-200 py-6 text-center text-xs text-zinc-400">
                  {t('ipLibrary.templates.empty')}
                </div>
              ) : (
                <ul className="space-y-2">
                  {group.ips.map((ip) => (
                    <IpTemplateItem key={ip.id} ip={ip} />
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}

function IpTemplateItem({ ip }: { ip: IpTemplateRecord }): React.JSX.Element {
  const { t } = useTranslation()
  const visibleKinds = ip.files.filter((group) => group.kind !== 'other' && group.count > 0)
  return (
    <li className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-zinc-800">{ip.name}</span>
            {ip.topModule && <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">{ip.topModule}</span>}
            {ip.componentKind && <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700">{t(COMPONENT_LABEL_KEYS[ip.componentKind])}</span>}
            {typeof ip.confidence === 'number' && <span className="text-[10px] text-zinc-400">{t('ipLibrary.confidence', { percent: Math.round(ip.confidence * 100) })}</span>}
            {ip.analysisSource === 'pi' && <span className="text-[10px] text-violet-600">{t('ipLibrary.piEnhanced')}</span>}
          </div>
          {ip.summary && <p className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-500">{ip.summary}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {ip.protocols?.map((protocol) => (
              <span key={protocol} className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-700">{protocol}</span>
            ))}
            {ip.interfaceRoles?.map((role) => (
              <span key={role} className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-700">{role}</span>
            ))}
            {visibleKinds.map((group) => (
              <span key={group.kind} className="rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-[10px] text-zinc-500" title={group.examples.join('\n')}>
                {t(KIND_LABEL_KEYS[group.kind])} {group.count}
              </span>
            ))}
          </div>
          <div className="mt-2 truncate font-mono text-[10px] text-zinc-400" title={ip.path}>{ip.path}</div>
          {ip.error && <p className="mt-1 text-xs text-red-600">{ip.error}</p>}
        </div>
      </div>
    </li>
  )
}
