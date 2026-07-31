import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import type {
  DesignCell,
  DesignDatabase,
  DesignInstance,
  DesignModule,
  DesignSignalTrace
} from '@moonglass/design-browser-engine'
import type { ChipProject } from '@shared/types'

function HierarchyNode({
  node,
  selected,
  onSelect
}: {
  node: DesignInstance
  selected: string
  onSelect: (node: DesignInstance) => void
}): React.JSX.Element {
  return (
    <div>
      <button
        type="button"
        onClick={() => onSelect(node)}
        className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs ${
          selected === node.path ? 'bg-blue-50 text-blue-700' : 'text-zinc-700 hover:bg-zinc-100'
        }`}
      >
        <span className="text-zinc-400">{node.children.length > 0 ? '▾' : '·'}</span>
        <span className="truncate font-medium">{node.name}</span>
        <span className="ml-auto truncate text-zinc-400">{node.module}</span>
      </button>
      {node.children.length > 0 && (
        <div className="ml-3 border-l border-zinc-200 pl-1">
          {node.children.map((child) => (
            <HierarchyNode key={child.path} node={child} selected={selected} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  )
}

function EndpointList({
  title,
  items
}: {
  title: string
  items: DesignSignalTrace['drivers']
}): React.JSX.Element {
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold text-zinc-500">{title}</h4>
      {items.length === 0 ? (
        <p className="text-xs text-zinc-400">无</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item, index) => (
            <li key={`${item.kind}-${item.name}-${item.pin}-${index}`} className="rounded border border-zinc-200 bg-white px-2 py-1 text-xs">
              <span className="font-mono text-zinc-800">{item.name}.{item.pin}</span>
              <span className="ml-2 text-zinc-400">{item.kind} · {item.direction}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function DesignBrowserPage(): React.JSX.Element {
  const { projectId } = useParams({ from: '/design-browser/$projectId' })
  const [project, setProject] = useState<ChipProject | null>(null)
  const [tops, setTops] = useState<Array<{
    name: string
    file: string
    recommended: boolean
    reason: 'manifest' | 'root-module' | 'candidate'
  }>>([])
  const [top, setTop] = useState('')
  const [database, setDatabase] = useState<DesignDatabase | null>(null)
  const [selectedPath, setSelectedPath] = useState('')
  const [selectedModuleName, setSelectedModuleName] = useState('')
  const [selectedTrace, setSelectedTrace] = useState<DesignSignalTrace | null>(null)
  const [selectedCell, setSelectedCell] = useState<DesignCell | null>(null)
  const [source, setSource] = useState<{ file: string; line: number; content: string } | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    void Promise.all([
      window.moonglass.project.get(projectId),
      window.moonglass.designBrowser.listTops(projectId),
      window.moonglass.designBrowser.getCached(projectId)
    ]).then(([projectData, candidates, cached]) => {
      setProject(projectData)
      setTops(candidates)
      const preferred = candidates.find((candidate) => candidate.recommended)
      const initialTop = preferred?.name ?? cached?.topModule ?? candidates[0]?.name ?? ''
      setTop(initialTop)
      if (preferred) {
        setLoading(true)
        void window.moonglass.designBrowser.elaborate(projectId, preferred.name)
          .then((result) => {
            setDatabase(result)
            setSelectedPath(result.hierarchy.path)
            setSelectedModuleName(result.topModule)
            void showSource(result.hierarchy.source)
          })
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => setLoading(false))
      } else if (cached) {
        setDatabase(cached)
        setSelectedPath(cached.hierarchy.path)
        setSelectedModuleName(cached.topModule)
      }
    }).catch((reason) => setError(String(reason)))
  }, [projectId])

  const selectedModule = useMemo(
    () => database?.modules.find((module) => module.name === selectedModuleName) ?? null,
    [database, selectedModuleName]
  )
  const hasRecommendedTop = tops.some((candidate) => candidate.recommended)
  const filteredTraces = useMemo(() => {
    const traces = selectedModule?.traces ?? []
    const needle = query.trim().toLowerCase()
    return needle ? traces.filter((trace) => trace.net.toLowerCase().includes(needle)) : traces
  }, [selectedModule, query])

  const showSource = async (sourceLocation?: string): Promise<void> => {
    if (!sourceLocation) {
      setSource(null)
      return
    }
    try {
      setSource(await window.moonglass.designBrowser.readSource(projectId, sourceLocation))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const selectInstance = (node: DesignInstance): void => {
    setSelectedPath(node.path)
    setSelectedModuleName(node.module)
    setSelectedTrace(null)
    setSelectedCell(null)
    void showSource(node.source)
  }

  const elaborate = async (): Promise<void> => {
    if (!top) return
    setLoading(true)
    setError('')
    try {
      const result = await window.moonglass.designBrowser.elaborate(projectId, top)
      setDatabase(result)
      setSelectedPath(result.hierarchy.path)
      setSelectedModuleName(result.topModule)
      setSelectedTrace(null)
      setSelectedCell(null)
      await showSource(result.hierarchy.source)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  const sourceLines = source?.content.split(/\r?\n/) ?? []
  const sourceStart = Math.max(0, (source?.line ?? 1) - 12)
  const sourceEnd = Math.min(sourceLines.length, (source?.line ?? 1) + 18)

  return (
    <div className="flex h-full flex-col bg-zinc-100">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-zinc-300 bg-white px-4">
        <Link to="/workspace/$projectId" params={{ projectId }} className="text-sm text-zinc-500 hover:text-zinc-900">
          ← 工作区
        </Link>
        <div className="h-5 w-px bg-zinc-200" />
        <div>
          <h1 className="text-sm font-semibold text-zinc-900">RTL Design Browser</h1>
          <p className="text-[11px] text-zinc-400">{project?.name ?? projectId}</p>
        </div>
        <span className="ml-4 text-xs text-zinc-500">Top</span>
        {hasRecommendedTop ? (
          <span className="rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs font-mono text-zinc-700">
            {top}
          </span>
        ) : (
          <select
            value={top}
            onChange={(event) => setTop(event.target.value)}
            className="min-w-48 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs"
            title="检测到多个根模块，请选择设计顶层"
          >
            {tops.map((candidate) => (
              <option key={`${candidate.name}-${candidate.file}`} value={candidate.name}>
                {candidate.name} · {candidate.file}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          onClick={() => void elaborate()}
          disabled={!top || loading}
          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {loading ? 'Elaborating…' : database ? '重新解析' : hasRecommendedTop ? '自动解析' : '使用所选 Top'}
        </button>
        {database && (
          <span className="ml-auto text-xs text-zinc-500">
            {database.modules.length} modules · {database.generatedAt.slice(0, 19).replace('T', ' ')}
          </span>
        )}
      </header>

      {error && (
        <div className="shrink-0 border-b border-red-200 bg-red-50 px-4 py-2 text-xs whitespace-pre-wrap text-red-700">
          {error}
        </div>
      )}

      {!database ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
          {loading
            ? `正在自动加载 ${top || 'design'}…`
            : hasRecommendedTop
              ? '正在准备设计数据库…'
              : '检测到多个可能的根模块，请选择 Top 后加载'}
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[260px_minmax(480px,1fr)_360px]">
          <aside className="min-h-0 overflow-auto border-r border-zinc-300 bg-white">
            <div className="sticky top-0 border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-xs font-semibold text-zinc-600">
              DESIGN HIERARCHY
            </div>
            <div className="py-1">
              <HierarchyNode node={database.hierarchy} selected={selectedPath} onSelect={selectInstance} />
            </div>
            {database.diagnostics.length > 0 && (
              <div className="m-2 border-t border-zinc-200 pt-2">
                <h3 className="mb-1 text-xs font-semibold text-amber-700">Diagnostics</h3>
                {database.diagnostics.map((diagnostic, index) => (
                  <p key={index} className="mb-1 text-xs text-amber-700">{diagnostic.message}</p>
                ))}
              </div>
            )}
          </aside>

          <main className="min-h-0 overflow-auto bg-zinc-100 p-4">
            {selectedModule && (
              <>
                <div className="mb-3 flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-zinc-900">{selectedPath}</h2>
                    <p className="text-xs text-zinc-500">module {selectedModule.name}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void showSource(selectedModule.source)}
                    className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs hover:bg-zinc-50"
                  >
                    查看模块源码
                  </button>
                </div>

                <section className="border border-zinc-300 bg-white">
                  <div className="grid min-h-64 grid-cols-[180px_1fr_180px]">
                    <div className="border-r border-zinc-200 p-3">
                      <h3 className="mb-2 text-xs font-semibold text-zinc-500">INPUTS</h3>
                      {selectedModule.ports.filter((port) => port.direction === 'input').map((port) => (
                        <button
                          key={port.name}
                          onClick={() => setSelectedTrace(selectedModule.traces.find((trace) => trace.net === port.name) ?? null)}
                          className="mb-1 block w-full border-l-2 border-blue-400 bg-blue-50 px-2 py-1 text-left font-mono text-xs text-blue-800"
                        >
                          {port.name} [{port.width}]
                        </button>
                      ))}
                    </div>
                    <div className="p-4">
                      <div className="mb-4 border-2 border-zinc-500 bg-zinc-50 px-4 py-3 text-center">
                        <strong className="font-mono text-sm">{selectedModule.name}</strong>
                        <div className="mt-1 text-xs text-zinc-500">
                          {selectedModule.cells.length} cells · {selectedModule.nets.length} nets
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
                        {selectedModule.cells.slice(0, 120).map((cell) => (
                          <button
                            key={cell.name}
                            type="button"
                            onClick={() => {
                              setSelectedCell(cell)
                              setSelectedTrace(null)
                              void showSource(cell.source)
                            }}
                            className={`min-h-14 border px-2 py-1 text-left text-xs ${
                              selectedCell?.name === cell.name
                                ? 'border-blue-500 bg-blue-50'
                                : cell.isInstance
                                  ? 'border-emerald-300 bg-emerald-50 hover:border-emerald-500'
                                  : 'border-zinc-300 bg-white hover:border-zinc-500'
                            }`}
                          >
                            <span className="block truncate font-mono font-medium">{cell.name}</span>
                            <span className="block truncate text-zinc-500">{cell.type}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="border-l border-zinc-200 p-3">
                      <h3 className="mb-2 text-xs font-semibold text-zinc-500">OUTPUTS</h3>
                      {selectedModule.ports.filter((port) => port.direction !== 'input').map((port) => (
                        <button
                          key={port.name}
                          onClick={() => setSelectedTrace(selectedModule.traces.find((trace) => trace.net === port.name) ?? null)}
                          className="mb-1 block w-full border-r-2 border-emerald-400 bg-emerald-50 px-2 py-1 text-right font-mono text-xs text-emerald-800"
                        >
                          {port.name} [{port.width}]
                        </button>
                      ))}
                    </div>
                  </div>
                </section>

                <section className="mt-4 border border-zinc-300 bg-white">
                  <div className="flex items-center border-b border-zinc-200 px-3 py-2">
                    <h3 className="text-xs font-semibold text-zinc-600">SIGNALS / CONNECTIVITY</h3>
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder="搜索 net"
                      className="ml-auto w-48 rounded border border-zinc-300 px-2 py-1 text-xs"
                    />
                  </div>
                  <div className="grid max-h-56 grid-cols-3 overflow-auto">
                    {filteredTraces.map((trace) => (
                      <button
                        key={trace.net}
                        onClick={() => {
                          setSelectedTrace(trace)
                          setSelectedCell(null)
                        }}
                        className={`border-b border-r border-zinc-100 px-2 py-1.5 text-left text-xs ${
                          selectedTrace?.net === trace.net ? 'bg-blue-50 text-blue-700' : 'hover:bg-zinc-50'
                        }`}
                      >
                        <span className="font-mono">{trace.net}</span>
                        <span className="ml-2 text-zinc-400">D{trace.drivers.length}/L{trace.loads.length}</span>
                      </button>
                    ))}
                  </div>
                </section>
              </>
            )}
          </main>

          <aside className="min-h-0 overflow-auto border-l border-zinc-300 bg-zinc-50">
            <div className="border-b border-zinc-200 bg-white px-3 py-2">
              <h3 className="text-xs font-semibold text-zinc-600">INSPECTOR</h3>
            </div>
            {selectedTrace && (
              <div className="space-y-4 border-b border-zinc-200 p-3">
                <div>
                  <p className="text-xs text-zinc-400">Signal</p>
                  <p className="font-mono text-sm font-semibold">{selectedTrace.net}</p>
                  <p className="text-xs text-zinc-500">{selectedTrace.bits.length} bits</p>
                </div>
                <EndpointList title="DRIVERS" items={selectedTrace.drivers} />
                <EndpointList title="LOADS / FANOUT" items={selectedTrace.loads} />
              </div>
            )}
            {selectedCell && (
              <div className="border-b border-zinc-200 p-3 text-xs">
                <p className="text-zinc-400">Cell / Instance</p>
                <p className="font-mono font-semibold text-zinc-900">{selectedCell.name}</p>
                <p className="font-mono text-zinc-500">{selectedCell.type}</p>
                <table className="mt-2 w-full">
                  <tbody>
                    {Object.entries(selectedCell.connections).map(([pin, bits]) => (
                      <tr key={pin} className="border-t border-zinc-200">
                        <th className="py-1 text-left font-mono">{pin}</th>
                        <td className="py-1 text-right text-zinc-500">{bits.length} bit</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold text-zinc-600">SOURCE</h3>
                {source && <span className="max-w-56 truncate text-[10px] text-zinc-400">{source.file}:{source.line}</span>}
              </div>
              {source ? (
                <pre className="overflow-auto border border-zinc-300 bg-zinc-900 p-2 text-[11px] leading-5 text-zinc-200">
                  {sourceLines.slice(sourceStart, sourceEnd).map((line, index) => {
                    const lineNumber = sourceStart + index + 1
                    return (
                      <div key={lineNumber} className={lineNumber === source.line ? 'bg-amber-900/60 text-amber-100' : ''}>
                        <span className="mr-3 inline-block w-8 select-none text-right text-zinc-500">{lineNumber}</span>
                        {line || ' '}
                      </div>
                    )
                  })}
                </pre>
              ) : (
                <p className="text-xs text-zinc-400">选择模块或 cell 查看源码</p>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
