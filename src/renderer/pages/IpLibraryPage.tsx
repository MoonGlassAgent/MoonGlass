import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { ExternalLink, FolderOpen, PackagePlus, RefreshCw, Search, Sparkles, Trash2 } from 'lucide-react'
import type { IpLibraryFileKind, IpLibraryRecord, IpTemplateRecord } from '@shared/types'

const TYPE_PRESETS = ['总线接口', '存储相关', '时钟相关', '仲裁器', '工具模块', '用户导入']
const API_NOT_READY_MESSAGE = 'IP 库后台 API 尚未加载。请完全退出并重新启动 MoonGlass，使 main/preload 进程加载最新代码。'

const STATUS_LABELS: Record<IpLibraryRecord['status'], string> = {
  ready: '索引就绪',
  missing: '目录不存在',
  indexing: '索引中',
  error: '索引失败'
}

const KIND_LABELS: Record<IpLibraryFileKind, string> = {
  rtl: 'RTL',
  verification: '验证',
  document: '文档',
  constraint: '约束',
  script: '脚本',
  metadata: '元数据',
  other: '其他'
}

const COMPONENT_LABELS: Record<NonNullable<IpTemplateRecord['componentKind']>, string> = {
  'rtl-ip': 'RTL IP',
  'verification-component': '验证组件',
  mixed: 'RTL + 验证',
  reference: '参考资源'
}

function pathBaseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function librarySubtitle(library: IpLibraryRecord): string {
  const source = library.source === 'builtin' ? '内置' : '本地'
  return `${source} · ${library.type} · ${library.ipCount} 个 IP · ${library.fileCount.toLocaleString()} 个文件`
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
  if (!api) throw new Error(API_NOT_READY_MESSAGE)
  return api
}

export function IpLibraryPage(): React.JSX.Element {
  const [libraries, setLibraries] = useState<IpLibraryRecord[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [tip, setTip] = useState('')
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState({ path: '', name: '', type: '用户导入' })
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
      type: draft.type.trim() || '用户导入'
    }
    if (!input.path) {
      setError('请先选择或输入 IP 库目录')
      return
    }
    await run('import', async () => {
      const record = await getIpLibraryApi().addLocal(input)
      setDraft({ path: '', name: '', type: '用户导入' })
      setTip(`已导入 ${record.name}，索引到 ${record.ipCount} 个 IP`)
    })
  }

  const allIps = useMemo(() => libraries.flatMap((library) => library.ips), [libraries])
  const filteredIps = useMemo(() => allIps.filter((ip) => matchIp(ip, query)), [allIps, query])
  const groupedIps = useMemo(() => {
    const types = [...new Set([...TYPE_PRESETS, ...allIps.map((ip) => ip.type)])]
    return types.map((type) => ({
      type,
      ips: filteredIps.filter((ip) => ip.type === type)
    }))
  }, [allIps, filteredIps])

  const readyLibraries = libraries.filter((library) => library.status === 'ready').length
  const importedLibraries = libraries.filter((library) => library.source === 'local').length

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-zinc-900">IP 模板库</h1>
          <p className="mt-1 text-sm text-zinc-500">
            选择一个目录后自动递归发现多个 IP、RTL 与验证组件，供 Agent、RTL 生成和验证流程复用。
          </p>
        </div>
        <div className="flex gap-2 text-xs text-zinc-500">
          <span className="rounded border border-zinc-200 bg-white px-2 py-1">就绪 {readyLibraries}/{libraries.length}</span>
          <span className="rounded border border-zinc-200 bg-white px-2 py-1">用户库 {importedLibraries}</span>
          <span className="rounded border border-zinc-200 bg-white px-2 py-1">IP {allIps.length}</span>
        </div>
      </div>

      <section className="surface-panel mb-5 rounded-lg border border-zinc-200 bg-white p-4">
        {!apiReady && (
          <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {API_NOT_READY_MESSAGE}
          </div>
        )}
        <form onSubmit={(event) => void importLibrary(event)} className="grid grid-cols-1 gap-3 xl:grid-cols-[1fr_180px_2fr_auto]">
          <label className="min-w-0">
            <span className="mb-1 block text-xs font-medium text-zinc-500">IP 库名称</span>
            <input
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="例如 公司通用 IP"
              className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800"
            />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-xs font-medium text-zinc-500">类型</span>
            <input
              value={draft.type}
              list="ip-library-type-presets"
              onChange={(event) => setDraft((current) => ({ ...current, type: event.target.value }))}
              className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800"
            />
            <datalist id="ip-library-type-presets">
              {TYPE_PRESETS.map((type) => <option key={type} value={type} />)}
            </datalist>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-xs font-medium text-zinc-500">目录路径</span>
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
                title="选择目录"
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
              {busy === 'import' ? '导入中' : '导入'}
            </button>
          </div>
        </form>
        <p className="mt-3 text-xs text-zinc-500">
          MoonGlass 会自动跳过构建目录，按 metadata、源码目录和 HDL 文件识别 IP 边界，并提取协议、接口角色与组件用途；不会执行库内脚本，也不会修改源文件。
        </p>
        {error && <div className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
        {tip && <div className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{tip}</div>}
      </section>

      <section className="mb-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-800">已登记 IP 库</h2>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
            disabled={busy !== null}
            onClick={() => void run('refresh', refresh)}
          >
            <RefreshCw className={busy === 'refresh' ? 'animate-spin' : ''} size={14} />
            刷新
          </button>
        </div>

        {libraries.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 py-10 text-center text-sm text-zinc-500">
            尚未登记 IP 库
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
                      <span className="text-xs text-zinc-500">{STATUS_LABELS[library.status]}</span>
                      <span className="rounded border border-zinc-200 bg-zinc-50 px-1.5 py-0.5 text-[10px] text-zinc-600">
                        {library.source === 'builtin' ? '内置' : '用户'}
                      </span>
                    </div>
                    <div className="mt-1 truncate font-mono text-[11px] text-zinc-400" title={library.path}>{library.path}</div>
                    <div className="mt-2 text-xs text-zinc-500">{librarySubtitle(library)}</div>
                    {library.semanticAnalysisStatus && library.semanticAnalysisStatus !== 'not-run' && (
                      <div className="mt-1 text-xs text-zinc-500">
                        Pi 语义分析：{library.semanticAnalysisStatus === 'completed' ? `已完成 · ${library.semanticModel ?? ''}` : library.semanticAnalysisStatus === 'running' ? '分析中' : '失败'}
                      </div>
                    )}
                    {library.semanticError && <p className="mt-1 text-xs text-red-600">{library.semanticError}</p>}
                    {library.error && <p className="mt-2 text-xs text-red-600">{library.error}</p>}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button type="button" className="icon-button" title="打开目录" onClick={() => void getIpLibraryApi().openFolder(library.id)}><ExternalLink size={15} /></button>
                    <button type="button" className="icon-button" title="重新建立索引" disabled={busy !== null} onClick={() => void run(`index-${library.id}`, () => getIpLibraryApi().reindex(library.id))}><RefreshCw className={busy === `index-${library.id}` ? 'animate-spin' : ''} size={15} /></button>
                    {library.source === 'local' && (
                      <>
                        <button type="button" className="icon-button" title={library.semanticAnalysisStatus === 'running' ? 'Pi 语义分析正在运行' : '使用 Pi 补充功能、协议与许可证语义'} disabled={busy !== null || library.ipCount === 0 || library.semanticAnalysisStatus === 'running'} onClick={() => void run(`enhance-${library.id}`, async () => {
                          const analyzed = await getIpLibraryApi().enhance(library.id)
                          setTip(`Pi 已完成 ${analyzed.name} 的语义分析，共更新 ${analyzed.ips.filter((ip) => ip.analysisSource === 'pi').length} 个 IP`)
                        })}><Sparkles className={busy === `enhance-${library.id}` ? 'animate-pulse' : ''} size={15} /></button>
                        <button type="button" className="icon-button danger" title="移除登记（不会删除目录）" disabled={busy !== null} onClick={() => void run(`remove-${library.id}`, () => getIpLibraryApi().remove(library.id))}><Trash2 size={15} /></button>
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
          <h2 className="text-sm font-semibold text-zinc-800">模板分类</h2>
          <label className="relative block w-full max-w-sm">
            <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={15} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索 IP、topModule 或路径"
              className="w-full rounded border border-zinc-300 bg-white py-2 pl-9 pr-3 text-sm text-zinc-800"
            />
          </label>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-3">
          {groupedIps.map((group) => (
            <div key={group.type} className="rounded-lg border border-zinc-200 bg-white p-4">
              <div className="mb-3 flex items-baseline justify-between gap-3">
                <h3 className="font-semibold text-zinc-800">{group.type}</h3>
                <span className="text-xs text-zinc-400">{group.ips.length} 个 IP</span>
              </div>
              {group.ips.length === 0 ? (
                <div className="rounded border border-dashed border-zinc-200 py-6 text-center text-xs text-zinc-400">
                  暂无 IP
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
  const visibleKinds = ip.files.filter((group) => group.kind !== 'other' && group.count > 0)
  return (
    <li className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-zinc-800">{ip.name}</span>
            {ip.topModule && <span className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">{ip.topModule}</span>}
            {ip.componentKind && <span className="rounded border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-700">{COMPONENT_LABELS[ip.componentKind]}</span>}
            {typeof ip.confidence === 'number' && <span className="text-[10px] text-zinc-400">识别 {Math.round(ip.confidence * 100)}%</span>}
            {ip.analysisSource === 'pi' && <span className="text-[10px] text-violet-600">Pi 增强</span>}
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
                {KIND_LABELS[group.kind]} {group.count}
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
