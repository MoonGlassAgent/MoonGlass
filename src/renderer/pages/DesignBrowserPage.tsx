import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, Search } from 'lucide-react'
import type {
  DesignCell,
  DesignDatabase,
  DesignInstance
} from '@moonglass/design-browser-engine'
import { topContext, type TraceContext } from '@moonglass/design-browser-engine/trace'
import type { ChipProject } from '@shared/types'
import { ColumnResizeHandle, RowResizeHandle } from '../components/design-browser/ResizeHandle'
import { HierarchyPanel } from '../components/design-browser/HierarchyPanel'
import { SourcePanel } from '../components/design-browser/SourcePanel'
import { SignalPanel } from '../components/design-browser/SignalPanel'
import { TracePanel } from '../components/design-browser/TracePanel'
import { displayModuleName } from '../components/design-browser/module-name'

const MIN_HIERARCHY_WIDTH = 180
const MAX_HIERARCHY_WIDTH = 480
const MIN_INSPECTOR_WIDTH = 260
const MAX_INSPECTOR_WIDTH = 640
const MIN_SIGNAL_HEIGHT = 120
const MAX_SIGNAL_HEIGHT = 480

function savedSize(key: string, fallback: number): number {
  const value = Number(window.localStorage.getItem(key))
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** 一次导航的完整快照，用于前进 / 后退历史 */
interface NavEntry {
  context: TraceContext
  net: string | null
  cell: string | null
  /** Yosys src 位置串（file:line），空表示不改变源码视图 */
  source: string | null
}

interface SearchResults {
  instances: DesignInstance[]
  modules: Array<{ name: string; source?: string }>
  nets: Array<{ module: string; net: string; source?: string }>
}

function searchDesign(database: DesignDatabase, query: string): SearchResults {
  const needle = query.trim().toLowerCase()
  const empty: SearchResults = { instances: [], modules: [], nets: [] }
  if (!needle) return empty
  const instances: DesignInstance[] = []
  const visit = (node: DesignInstance): void => {
    if (instances.length < 8 && node.path.toLowerCase().includes(needle)) instances.push(node)
    node.children.forEach(visit)
  }
  visit(database.hierarchy)
  const modules = database.modules
    .filter((module) => displayModuleName(module.name).toLowerCase().includes(needle))
    .slice(0, 8)
    .map((module) => ({ name: module.name, source: module.source }))
  const nets: SearchResults['nets'] = []
  for (const module of database.modules) {
    for (const net of module.nets) {
      if (nets.length >= 12) break
      if (net.name.toLowerCase().includes(needle)) {
        nets.push({ module: module.name, net: net.name, source: net.source })
      }
    }
    if (nets.length >= 12) break
  }
  return { instances, modules, nets }
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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 当前设计上下文与选中对象
  const [context, setContext] = useState<TraceContext | null>(null)
  const [selectedNet, setSelectedNet] = useState<string | null>(null)
  const [selectedCellName, setSelectedCellName] = useState<string | null>(null)

  // 源码浏览器：多 Tab + 当前定位行
  const [tabs, setTabs] = useState<string[]>([])
  const [files, setFiles] = useState<Record<string, string>>({})
  const [activeFile, setActiveFile] = useState('')
  const [activeLine, setActiveLine] = useState(1)

  // 导航历史（前进 / 后退）
  const historyRef = useRef<NavEntry[]>([])
  const [histIndex, setHistIndex] = useState(-1)

  // 层次树展开状态
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set())

  // 全局搜索
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)

  // 分栏尺寸（可拖拽，不可关闭）
  const [hierarchyWidth, setHierarchyWidth] = useState(() =>
    savedSize('moonglass.designBrowser.hierarchyWidth', 240)
  )
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    savedSize('moonglass.designBrowser.inspectorWidth', 380)
  )
  const [signalHeight, setSignalHeight] = useState(() =>
    savedSize('moonglass.designBrowser.signalHeight', 200)
  )
  useEffect(() => {
    window.localStorage.setItem('moonglass.designBrowser.hierarchyWidth', String(hierarchyWidth))
  }, [hierarchyWidth])
  useEffect(() => {
    window.localStorage.setItem('moonglass.designBrowser.inspectorWidth', String(inspectorWidth))
  }, [inspectorWidth])
  useEffect(() => {
    window.localStorage.setItem('moonglass.designBrowser.signalHeight', String(signalHeight))
  }, [signalHeight])

  const currentModule = useMemo(
    () => database?.modules.find((module) => module.name === context?.module) ?? null,
    [database, context]
  )
  const selectedCell = useMemo<DesignCell | null>(
    () => currentModule?.cells.find((cell) => cell.name === selectedCellName) ?? null,
    [currentModule, selectedCellName]
  )
  const hasRecommendedTop = tops.some((candidate) => candidate.recommended)
  const searchResults = useMemo(
    () => (database && searchOpen ? searchDesign(database, query) : null),
    [database, query, searchOpen]
  )

  /** 解析 Yosys src 位置串并打开对应文件 Tab */
  const showSource = async (source?: string | null): Promise<void> => {
    if (!source) return
    try {
      const result = await window.moonglass.designBrowser.readSource(projectId, source)
      setFiles((prev) => (prev[result.file] ? prev : { ...prev, [result.file]: result.content }))
      setTabs((prev) => (prev.includes(result.file) ? prev : [...prev, result.file]))
      setActiveFile(result.file)
      setActiveLine(result.line)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  /** 应用一次导航；record=false 用于历史回放（不再入栈） */
  const applyNav = (entry: NavEntry, record: boolean): void => {
    setContext(entry.context)
    setSelectedNet(entry.net)
    setSelectedCellName(entry.cell)
    void showSource(entry.source)
    if (record) {
      historyRef.current = [...historyRef.current.slice(0, histIndex + 1), entry]
      setHistIndex(historyRef.current.length - 1)
    }
  }

  const navigate = (entry: NavEntry): void => applyNav(entry, true)

  const goHistory = (offset: number): void => {
    const next = histIndex + offset
    if (next < 0 || next >= historyRef.current.length) return
    setHistIndex(next)
    applyNav(historyRef.current[next], false)
  }

  /** 新数据库就绪后重置视图并定位顶层 */
  const adoptDatabase = (result: DesignDatabase): void => {
    setDatabase(result)
    setExpandedPaths(new Set([result.hierarchy.path]))
    historyRef.current = []
    setHistIndex(-1)
    navigate({
      context: topContext(result),
      net: null,
      cell: null,
      source: result.hierarchy.source ?? null
    })
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
        adoptDatabase(cached)
      } else if (preferred) {
        setLoading(true)
        void window.moonglass.designBrowser.elaborate(projectId, preferred.name)
          .then(adoptDatabase)
          .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
          .finally(() => setLoading(false))
      }
    }).catch((reason) => setError(String(reason)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  const elaborate = async (): Promise<void> => {
    if (!top) return
    setLoading(true)
    setError('')
    try {
      adoptDatabase(await window.moonglass.designBrowser.elaborate(projectId, top))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  // ---- 交互回调 ----

  const selectInstance = (node: DesignInstance): void => {
    navigate({
      context: { instancePath: node.path, module: node.module },
      net: null,
      cell: null,
      source: node.source ?? null
    })
  }

  const openInstanceDefinition = (node: DesignInstance): void => {
    navigate({
      context: { instancePath: node.path, module: node.module },
      net: null,
      cell: null,
      source: node.definitionSource ?? node.source ?? null
    })
  }

  const selectNet = (net: string): void => {
    if (!context) return
    const source = currentModule?.nets.find((candidate) => candidate.name === net)?.source ?? null
    navigate({ context, net, cell: null, source })
  }

  /** 源码标识符：单击选中，双击跳转定义 / 下钻实例 */
  const handleWord = (word: string, action: 'select' | 'jump'): void => {
    if (!database || !context || !currentModule) return
    const net = currentModule.nets.find((candidate) => candidate.name === word)
    const cell = currentModule.cells.find((candidate) => candidate.name === word)
    if (action === 'select') {
      if (net) {
        setSelectedNet(word)
        setSelectedCellName(null)
      } else if (cell) {
        setSelectedCellName(word)
        setSelectedNet(null)
      }
      return
    }
    if (cell?.isInstance) {
      // 双击实例名：下钻进入子模块
      navigate({
        context: { instancePath: `${context.instancePath}.${cell.name}`, module: cell.type },
        net: null,
        cell: null,
        source: database.modules.find((module) => module.name === cell.type)?.source ?? cell.source ?? null
      })
    } else if (net) {
      navigate({ context, net: word, cell: null, source: net.source ?? null })
    } else if (cell) {
      navigate({ context, net: null, cell: word, source: cell.source ?? null })
    } else {
      const module = database.modules.find((candidate) => candidate.name === word)
      if (module) void showSource(module.source)
    }
  }

  const pickSearchResult = (entry: NavEntry): void => {
    setSearchOpen(false)
    setQuery('')
    navigate(entry)
  }

  const pickNetResult = (moduleName: string, net: string, source?: string): void => {
    if (!database) return
    // net 属于模块而非实例：定位到该模块的第一个实例
    let target: TraceContext = { instancePath: database.hierarchy.path, module: database.topModule }
    const visit = (node: DesignInstance): boolean => {
      if (node.module === moduleName) {
        target = { instancePath: node.path, module: node.module }
        return true
      }
      return node.children.some(visit)
    }
    visit(database.hierarchy)
    pickSearchResult({ context: target, net, cell: null, source: source ?? null })
  }

  const closeTab = (file: string): void => {
    setTabs((prev) => {
      const next = prev.filter((item) => item !== file)
      if (file === activeFile) setActiveFile(next[next.length - 1] ?? '')
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
        <span className="ml-2 text-xs text-zinc-500">Top</span>
        {hasRecommendedTop ? (
          <span className="rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs font-mono text-zinc-700">
            {top}
          </span>
        ) : (
          <select
            value={top}
            onChange={(event) => setTop(event.target.value)}
            className="min-w-40 rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs"
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
        <div className="h-5 w-px bg-zinc-200" />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => goHistory(-1)}
            disabled={histIndex <= 0}
            title="后退"
            aria-label="导航后退"
            className="flex h-7 w-7 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 disabled:opacity-40"
          >
            <ArrowLeft size={14} />
          </button>
          <button
            type="button"
            onClick={() => goHistory(1)}
            disabled={histIndex >= historyRef.current.length - 1}
            title="前进"
            aria-label="导航前进"
            className="flex h-7 w-7 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 disabled:opacity-40"
          >
            <ArrowRight size={14} />
          </button>
        </div>
        <div className="relative ml-auto">
          <Search size={13} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setSearchOpen(true)
            }}
            onFocus={() => setSearchOpen(true)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setSearchOpen(false)
            }}
            placeholder="全局搜索实例 / 模块 / 信号…"
            className="w-64 rounded border border-zinc-300 py-1.5 pl-7 pr-2 text-xs"
          />
          {searchResults && query.trim() && (
            <div className="absolute right-0 top-full z-30 mt-1 max-h-96 w-96 overflow-auto rounded border border-zinc-300 bg-white shadow-lg">
              {searchResults.instances.length === 0 &&
                searchResults.modules.length === 0 &&
                searchResults.nets.length === 0 && (
                  <p className="px-3 py-2 text-xs text-zinc-400">无匹配结果</p>
                )}
              {searchResults.instances.length > 0 && (
                <div>
                  <p className="bg-zinc-50 px-3 py-1 text-[10px] font-semibold text-zinc-500">实例</p>
                  {searchResults.instances.map((node) => (
                    <button
                      key={node.path}
                      type="button"
                      onClick={() =>
                        pickSearchResult({
                          context: { instancePath: node.path, module: node.module },
                          net: null,
                          cell: null,
                          source: node.source ?? null
                        })
                      }
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-blue-50"
                    >
                      <span className="truncate font-mono">{node.path}</span>
                      <span className="ml-auto text-zinc-400">{displayModuleName(node.module)}</span>
                    </button>
                  ))}
                </div>
              )}
              {searchResults.modules.length > 0 && (
                <div>
                  <p className="bg-zinc-50 px-3 py-1 text-[10px] font-semibold text-zinc-500">模块</p>
                  {searchResults.modules.map((module) => (
                    <button
                      key={module.name}
                      type="button"
                      onClick={() =>
                        context &&
                        pickSearchResult({ context, net: null, cell: null, source: module.source ?? null })
                      }
                      className="block w-full px-3 py-1.5 text-left font-mono text-xs hover:bg-blue-50"
                    >
                      {displayModuleName(module.name)}
                    </button>
                  ))}
                </div>
              )}
              {searchResults.nets.length > 0 && (
                <div>
                  <p className="bg-zinc-50 px-3 py-1 text-[10px] font-semibold text-zinc-500">信号</p>
                  {searchResults.nets.map((item) => (
                    <button
                      key={`${item.module}.${item.net}`}
                      type="button"
                      onClick={() => pickNetResult(item.module, item.net, item.source)}
                      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-blue-50"
                    >
                      <span className="truncate font-mono">{item.net}</span>
                      <span className="ml-auto text-zinc-400">{displayModuleName(item.module)}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {database && (
          <span className="text-xs text-zinc-500">
            {database.modules.length} modules · {database.generatedAt.slice(0, 19).replace('T', ' ')}
          </span>
        )}
      </header>

      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{error}</span>
          <button
            type="button"
            onClick={() => setError('')}
            aria-label="关闭错误提示"
            className="shrink-0 rounded px-1 text-red-400 hover:bg-red-100 hover:text-red-700"
          >
            ✕
          </button>
        </div>
      )}

      {!database || !context ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
          {loading
            ? `正在自动加载 ${top || 'design'}…`
            : hasRecommendedTop
              ? '正在准备设计数据库…'
              : '检测到多个可能的根模块，请选择 Top 后加载'}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside style={{ width: hierarchyWidth }} className="shrink-0 overflow-hidden border-r border-zinc-300 bg-white">
            <HierarchyPanel
              root={database.hierarchy}
              diagnostics={database.diagnostics}
              selectedPath={context.instancePath}
              expandedPaths={expandedPaths}
              onToggle={(path) =>
                setExpandedPaths((current) => {
                  const next = new Set(current)
                  if (next.has(path)) next.delete(path)
                  else next.add(path)
                  return next
                })
              }
              onSelect={selectInstance}
              onOpenDefinition={openInstanceDefinition}
              onExpandAll={expandAllHierarchy}
              onCollapseAll={() => setExpandedPaths(new Set())}
            />
          </aside>

          <ColumnResizeHandle
            label="调整设计层次区域宽度"
            onDrag={(deltaX) =>
              setHierarchyWidth((width) =>
                Math.min(MAX_HIERARCHY_WIDTH, Math.max(MIN_HIERARCHY_WIDTH, width + deltaX))
              )
            }
          />

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1">
              <SourcePanel
                tabs={tabs}
                activeFile={activeFile}
                content={activeFile ? files[activeFile] ?? null : null}
                line={activeLine}
                onActivate={setActiveFile}
                onClose={closeTab}
                onWord={handleWord}
              />
            </div>
            <RowResizeHandle
              label="调整信号列表区域高度"
              onDrag={(deltaY) =>
                setSignalHeight((height) =>
                  Math.min(MAX_SIGNAL_HEIGHT, Math.max(MIN_SIGNAL_HEIGHT, height - deltaY))
                )
              }
            />
            <div style={{ height: signalHeight }} className="shrink-0 overflow-hidden border-t border-zinc-300">
              <SignalPanel module={currentModule} selectedNet={selectedNet} onSelect={selectNet} />
            </div>
          </div>

          <ColumnResizeHandle
            label="调整 Inspector 区域宽度"
            onDrag={(deltaX) =>
              setInspectorWidth((width) =>
                Math.min(MAX_INSPECTOR_WIDTH, Math.max(MIN_INSPECTOR_WIDTH, width - deltaX))
              )
            }
          />

          <aside style={{ width: inspectorWidth }} className="shrink-0 overflow-hidden border-l border-zinc-300 bg-white">
            <div className="flex h-full min-h-0 flex-col">
              <div className="shrink-0 border-b border-zinc-200 bg-zinc-50 px-3 py-2">
                <h3 className="text-xs font-semibold text-zinc-600">INSPECTOR</h3>
              </div>
              {selectedNet && context ? (
                <div className="min-h-0 flex-1">
                  <TracePanel
                    database={database}
                    context={context}
                    net={selectedNet}
                    onJumpSource={(source) => void showSource(source)}
                  />
                </div>
              ) : selectedCell ? (
                <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
                  <p className="text-zinc-400">Cell / Instance</p>
                  <p className="font-mono font-semibold text-zinc-900">{selectedCell.name}</p>
                  <p className="font-mono text-zinc-500" title={selectedCell.type}>
                    {displayModuleName(selectedCell.type)}
                  </p>
                  {selectedCell.isInstance && (
                    <button
                      type="button"
                      onClick={() =>
                        navigate({
                          context: {
                            instancePath: `${context.instancePath}.${selectedCell.name}`,
                            module: selectedCell.type
                          },
                          net: null,
                          cell: null,
                          source:
                            database.modules.find((module) => module.name === selectedCell.type)
                              ?.source ?? null
                        })
                      }
                      className="mt-2 rounded border border-blue-300 bg-blue-50 px-2 py-1 text-blue-700 hover:bg-blue-100"
                    >
                      进入该实例 →
                    </button>
                  )}
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
              ) : (
                <p className="p-3 text-xs text-zinc-400">
                  在信号列表或源码中单击标识符选择信号；选中后可逐层展开 Driver / Load 追踪树
                </p>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
