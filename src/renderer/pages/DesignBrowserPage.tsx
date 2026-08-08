import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import type {
  DesignCell,
  DesignDatabase,
  DesignEndpoint,
  DesignInstance,
  DesignModule,
  DesignSignalTrace
} from '@moonglass/design-browser-engine'
import type { ChipProject } from '@shared/types'
import Prism from '../utils/prism-setup'

const MIN_HIERARCHY_WIDTH = 180
const MAX_HIERARCHY_WIDTH = 480
const MIN_INSPECTOR_WIDTH = 280
const MAX_INSPECTOR_WIDTH = 640
const verilogGrammar = Prism.languages.verilog ?? {
  comment: [
    { pattern: /\/\*[\s\S]*?\*\//, greedy: true },
    { pattern: /\/\/.*/, greedy: true }
  ],
  string: { pattern: /"(?:\\.|[^"\\])*"/, greedy: true },
  keyword:
    /\b(?:always|always_comb|always_ff|always_latch|assign|begin|case|casex|casez|default|else|end|endcase|endfunction|endmodule|endtask|for|function|generate|if|inout|input|integer|localparam|logic|module|output|parameter|reg|signed|task|wire)\b/,
  number: /\b(?:\d+'[sS]?[bBoOdDhH][\da-fA-F_xXzZ?]+|\d+(?:\.\d+)?)\b/,
  operator: /(?:===?|!==?|&&|\|\||<<<?|>>>?|[-+*/%&|^~!]=?|[<>]=?)/,
  punctuation: /[{}[\];(),.:#@]/
}

function savedWidth(key: string, fallback: number): number {
  const value = Number(window.localStorage.getItem(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function ColumnResizeHandle({
  onDrag,
  label
}: {
  onDrag: (deltaX: number) => void
  label: string
}): React.JSX.Element {
  const dragging = useRef(false)

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      onMouseDown={(event) => {
        event.preventDefault()
        dragging.current = true
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        const move = (moveEvent: MouseEvent): void => {
          if (dragging.current) onDrag(moveEvent.movementX)
        }
        const up = (): void => {
          dragging.current = false
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
        }
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      }}
      className="group relative cursor-col-resize bg-zinc-300 hover:bg-blue-400 active:bg-blue-500"
    >
      <div className="absolute inset-y-0 -left-1 -right-1" />
      <div className="absolute left-1/2 top-1/2 h-10 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-zinc-400 group-hover:bg-white" />
    </div>
  )
}

function HierarchyNode({
  node,
  selected,
  expandedPaths,
  onToggle,
  onSelect,
  onOpenDefinition
}: {
  node: DesignInstance
  selected: string
  expandedPaths: Set<string>
  onToggle: (path: string) => void
  onSelect: (node: DesignInstance) => void
  onOpenDefinition: (node: DesignInstance) => void
}): React.JSX.Element {
  const hasChildren = node.children.length > 0
  const expanded = expandedPaths.has(node.path)
  return (
    <div>
      <div
        className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs ${
          selected === node.path ? 'bg-blue-50 text-blue-700' : 'text-zinc-700 hover:bg-zinc-100'
        }`}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.path)}
            className="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-500 hover:text-blue-700"
            aria-label={expanded ? `收起 ${node.name}` : `展开 ${node.name}`}
            title={expanded ? '收起' : '展开'}
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : (
          <span className="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-300">·</span>
        )}
        <button
          type="button"
          onClick={() => onSelect(node)}
          onDoubleClick={(event) => {
            event.stopPropagation()
            onOpenDefinition(node)
          }}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="truncate font-medium">{node.name}</span>
          <span className="ml-auto truncate text-zinc-400">{node.module}</span>
        </button>
      </div>
      {hasChildren && expanded && (
        <div className="ml-3 border-l border-zinc-200 pl-1">
          {node.children.map((child) => (
            <HierarchyNode
              key={child.path}
              node={child}
              selected={selected}
              expandedPaths={expandedPaths}
              onToggle={onToggle}
              onSelect={onSelect}
              onOpenDefinition={onOpenDefinition}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function EndpointList({
  title,
  items,
  onSelect
}: {
  title: string
  items: DesignSignalTrace['drivers']
  onSelect: (endpoint: DesignEndpoint) => void
}): React.JSX.Element {
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold text-zinc-500">{title}</h4>
      {items.length === 0 ? (
        <p className="text-xs text-zinc-400">无</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item, index) => (
            <li key={`${item.kind}-${item.name}-${item.pin}-${index}`}>
              <button
                type="button"
                onClick={() => onSelect(item)}
                className="w-full rounded border border-zinc-200 bg-white px-2 py-1 text-left text-xs hover:border-blue-400 hover:bg-blue-50"
              >
                <span className="font-mono text-zinc-800">{item.name}.{item.pin}</span>
                <span className="ml-2 text-zinc-400">{item.cellType ?? item.kind} · {item.direction}</span>
              </button>
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
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())
  const [selectedModuleName, setSelectedModuleName] = useState('')
  const [selectedTrace, setSelectedTrace] = useState<DesignSignalTrace | null>(null)
  const [selectedCell, setSelectedCell] = useState<DesignCell | null>(null)
  const [endpointSummary, setEndpointSummary] = useState<{
    kind: 'Driver' | 'Load'
    items: DesignEndpoint[]
  } | null>(null)
  const [source, setSource] = useState<{ file: string; line: number; content: string } | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [hierarchyWidth, setHierarchyWidth] = useState(() =>
    savedWidth('moonglass.designBrowser.hierarchyWidth', 260)
  )
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    savedWidth('moonglass.designBrowser.inspectorWidth', 360)
  )
  const sourcePreRef = useRef<HTMLPreElement>(null)

  useEffect(() => {
    window.localStorage.setItem('moonglass.designBrowser.hierarchyWidth', String(hierarchyWidth))
  }, [hierarchyWidth])
  useEffect(() => {
    window.localStorage.setItem('moonglass.designBrowser.inspectorWidth', String(inspectorWidth))
  }, [inspectorWidth])
  useEffect(() => {
    if (database) setExpandedPaths(new Set([database.hierarchy.path]))
  }, [database])

  const toggleHierarchy = (path: string): void => {
    setExpandedPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const expandAllHierarchy = (): void => {
    if (!database) return
    const paths = new Set<string>()
    const visit = (node: DesignInstance): void => {
      if (node.children.length > 0) paths.add(node.path)
      node.children.forEach(visit)
    }
    visit(database.hierarchy)
    setExpandedPaths(paths)
  }

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
      if (cached && (!preferred || cached.topModule === preferred.name)) {
        setDatabase(cached)
        setSelectedPath(cached.hierarchy.path)
        setSelectedModuleName(cached.topModule)
        void showSource(cached.hierarchy.source)
      } else if (preferred) {
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
    setEndpointSummary(null)
    void showSource(node.source)
  }

  const openInstanceDefinition = (node: DesignInstance): void => {
    setSelectedPath(node.path)
    setSelectedModuleName(node.module)
    setSelectedTrace(null)
    setSelectedCell(null)
    setEndpointSummary(null)
    void showSource(node.definitionSource)
  }

  const jumpToEndpoint = (endpoint: DesignEndpoint): void => {
    if (endpoint.kind === 'cell') {
      setSelectedCell(selectedModule?.cells.find((cell) => cell.name === endpoint.name) ?? null)
    }
    void showSource(endpoint.source)
  }

  const navigateTrace = (kind: 'Driver' | 'Load', trace = selectedTrace): void => {
    if (!trace) return
    const items = kind === 'Driver' ? trace.drivers : trace.loads
    setEndpointSummary({ kind, items })
    if (items.length === 1) jumpToEndpoint(items[0])
  }

  const selectSourceSignal = (name: string): void => {
    const trace = selectedModule?.traces.find((candidate) => candidate.net === name)
    if (!trace) return
    setSelectedTrace(trace)
    setSelectedCell(null)
    navigateTrace('Driver', trace)
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
  useEffect(() => {
    if (!source || !sourcePreRef.current) return
    const target = sourcePreRef.current.querySelector<HTMLElement>(`[data-source-line="${source.line}"]`)
    target?.scrollIntoView({ block: 'center' })
  }, [source])

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
        <div
          className="grid min-h-0 flex-1"
          style={{
            gridTemplateColumns: `${hierarchyWidth}px 4px minmax(480px, 1fr) 4px ${inspectorWidth}px`
          }}
        >
          <aside className="min-h-0 overflow-auto border-r border-zinc-300 bg-white">
            <div className="sticky top-0 z-10 flex items-center border-b border-zinc-200 bg-zinc-50 px-3 py-2 text-xs font-semibold text-zinc-600">
              <span>DESIGN HIERARCHY</span>
              <span className="ml-auto flex items-center gap-1">
                <button
                  type="button"
                  onClick={expandAllHierarchy}
                  className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-200 hover:text-blue-700"
                  title="全部展开"
                  aria-label="全部展开设计层次"
                >
                  <ChevronsUpDown size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => setExpandedPaths(new Set())}
                  className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-200 hover:text-blue-700"
                  title="全部收起"
                  aria-label="全部收起设计层次"
                >
                  <ChevronsDownUp size={14} />
                </button>
              </span>
            </div>
            <div className="py-1">
              <HierarchyNode
                node={database.hierarchy}
                selected={selectedPath}
                expandedPaths={expandedPaths}
                onToggle={toggleHierarchy}
                onSelect={selectInstance}
                onOpenDefinition={openInstanceDefinition}
              />
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

          <ColumnResizeHandle
            label="调整设计层次区域宽度"
            onDrag={(deltaX) =>
              setHierarchyWidth((width) =>
                Math.min(MAX_HIERARCHY_WIDTH, Math.max(MIN_HIERARCHY_WIDTH, width + deltaX))
              )
            }
          />

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

          <ColumnResizeHandle
            label="调整 Inspector 区域宽度"
            onDrag={(deltaX) =>
              setInspectorWidth((width) =>
                Math.min(MAX_INSPECTOR_WIDTH, Math.max(MIN_INSPECTOR_WIDTH, width - deltaX))
              )
            }
          />

          <aside className="flex min-h-0 flex-col overflow-hidden border-l border-zinc-300 bg-zinc-50">
            <div className="shrink-0 border-b border-zinc-200 bg-white px-3 py-2">
              <h3 className="text-xs font-semibold text-zinc-600">INSPECTOR</h3>
            </div>
            {selectedTrace && (
              <div className="max-h-[38%] shrink-0 space-y-4 overflow-auto border-b border-zinc-200 p-3">
                <div>
                  <p className="text-xs text-zinc-400">Signal</p>
                  <p className="font-mono text-sm font-semibold">{selectedTrace.net}</p>
                  <p className="text-xs text-zinc-500">{selectedTrace.bits.length} bits</p>
                </div>
                {endpointSummary && (
                  <div className="border-l-2 border-blue-500 bg-blue-50 px-2 py-1.5 text-xs text-blue-800">
                    {endpointSummary.items.length === 0
                      ? `未找到 ${endpointSummary.kind}`
                      : endpointSummary.items.length === 1
                        ? `已定位 1 个 ${endpointSummary.kind}`
                        : `找到 ${endpointSummary.items.length} 个 ${endpointSummary.kind}，请选择目标`}
                  </div>
                )}
                <EndpointList title="DRIVERS" items={selectedTrace.drivers} onSelect={jumpToEndpoint} />
                <EndpointList title="LOADS / FANOUT" items={selectedTrace.loads} onSelect={jumpToEndpoint} />
              </div>
            )}
            {selectedCell && (
              <div className="max-h-[38%] shrink-0 overflow-auto border-b border-zinc-200 p-3 text-xs">
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
            <div className="flex min-h-0 flex-1 flex-col p-3">
              <div className="mb-2 flex items-center gap-1">
                <h3 className="text-xs font-semibold text-zinc-600">SOURCE</h3>
                <button
                  type="button"
                  disabled={!selectedTrace}
                  onClick={() => navigateTrace('Driver')}
                  className="ml-auto rounded border border-zinc-300 bg-white px-2 py-0.5 text-[10px] hover:bg-zinc-100 disabled:opacity-40"
                >
                  Driver
                </button>
                <button
                  type="button"
                  disabled={!selectedTrace}
                  onClick={() => navigateTrace('Load')}
                  className="rounded border border-zinc-300 bg-white px-2 py-0.5 text-[10px] hover:bg-zinc-100 disabled:opacity-40"
                >
                  Load
                </button>
              </div>
              {source && <div className="mb-1 truncate text-[10px] text-zinc-400">{source.file}:{source.line}</div>}
              {source ? (
                <pre
                  ref={sourcePreRef}
                  onDoubleClick={() => {
                    const name = window.getSelection()?.toString().trim() ?? ''
                    if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) selectSourceSignal(name)
                  }}
                  className="rtl-source min-h-0 flex-1 overflow-auto overscroll-contain border border-zinc-700 bg-[#18181b] py-2 text-[11px] leading-5"
                >
                  {sourceLines.map((line, index) => {
                    const lineNumber = index + 1
                    return (
                      <div
                        key={lineNumber}
                        data-source-line={lineNumber}
                        className={`min-w-max border-l-2 px-2 ${
                          lineNumber === source.line
                            ? 'border-sky-400 bg-sky-950/50'
                            : 'border-transparent hover:bg-zinc-800/60'
                        }`}
                      >
                        <span className="mr-4 inline-block w-8 select-none text-right text-zinc-600">{lineNumber}</span>
                        <code
                          className="language-verilog"
                          dangerouslySetInnerHTML={{
                            __html: line
                              ? Prism.highlight(line, verilogGrammar, 'verilog')
                              : ' '
                          }}
                        />
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
