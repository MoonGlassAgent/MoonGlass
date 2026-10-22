import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { ArrowLeft, ArrowRight, Search } from 'lucide-react'
import type {
  DesignDatabase,
  DesignInstance,
  DesignInstanceRef,
  DesignModule,
  DesignModuleV2,
  DesignProcess
} from '@moonglass/design-browser-engine'
import { topContext, type TraceContext } from '@moonglass/design-browser-engine/trace'
import type { ChipProject } from '@shared/types'
import { ColumnResizeHandle, RowResizeHandle } from '../components/design-browser/ResizeHandle'
import { HierarchyPanel } from '../components/design-browser/HierarchyPanel'
import { SourcePanel } from '../components/design-browser/SourcePanel'
import { SignalPanel } from '../components/design-browser/SignalPanel'
import { TracePanel } from '../components/design-browser/TracePanel'
import { displayModuleName } from '../components/design-browser/module-name'
import { useTranslation } from '../i18n'

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
  /** v2 = cell 名；v3 = 实例名（v3 无 cell 概念） */
  cell: string | null
  /** v3：选中的过程块 id（DesignProcess.id） */
  process?: string | null
  /** 源码位置串（file:line，v3 为工作区相对路径），空表示不改变源码视图 */
  source: string | null
}

interface SearchGroup<T> {
  items: T[]
  /** 未截断前的总匹配数 */
  total: number
  truncated: boolean
}

interface SearchResults {
  instances: SearchGroup<DesignInstance>
  modules: SearchGroup<{ name: string; source?: string }>
  signals: SearchGroup<{ module: string; net: string; source?: string }>
}

const INSTANCE_RESULT_LIMIT = 8
const MODULE_RESULT_LIMIT = 8
const NET_RESULT_LIMIT = 12

/** 搜索下拉每组最多展示条数；截断时组尾显示「仅显示前 N 条 · 共 M 条」 */
function searchDesign(database: DesignDatabase, query: string): SearchResults {
  const needle = query.trim().toLowerCase()
  const emptyGroup = <T,>(): SearchGroup<T> => ({ items: [], total: 0, truncated: false })
  const empty: SearchResults = { instances: emptyGroup(), modules: emptyGroup(), signals: emptyGroup() }
  if (!needle) return empty
  const instances: DesignInstance[] = []
  let instanceTotal = 0
  const visit = (node: DesignInstance): void => {
    if (node.path.toLowerCase().includes(needle)) {
      instanceTotal += 1
      if (instances.length < INSTANCE_RESULT_LIMIT) instances.push(node)
    }
    node.children.forEach(visit)
  }
  visit(database.hierarchy)
  const moduleMatches = database.modules.filter((module) =>
    displayModuleName(module.name).toLowerCase().includes(needle)
  )
  // 信号搜索：v3 搜 signals（源码形态），v2 搜 nets（Yosys 优化后形态）
  const signals: Array<{ module: string; net: string; source?: string }> = []
  let signalTotal = 0
  for (const module of database.modules) {
    const entries = 'signals' in module
      ? module.signals.map((signal) => ({ name: signal.name, source: signal.source }))
      : module.nets.map((net) => ({ name: net.name, source: net.source }))
    for (const entry of entries) {
      if (!entry.name.toLowerCase().includes(needle)) continue
      signalTotal += 1
      if (signals.length < NET_RESULT_LIMIT) signals.push({ module: module.name, net: entry.name, source: entry.source })
    }
  }
  return {
    instances: { items: instances, total: instanceTotal, truncated: instanceTotal > instances.length },
    modules: {
      items: moduleMatches
        .slice(0, MODULE_RESULT_LIMIT)
        .map((module) => ({ name: module.name, source: module.source })),
      total: moduleMatches.length,
      truncated: moduleMatches.length > MODULE_RESULT_LIMIT
    },
    signals: { items: signals, total: signalTotal, truncated: signalTotal > signals.length }
  }
}

/** 搜索截断提示行（下拉组尾 / 层次过滤列表共用样式） */
function TruncatedNote({ shown, total }: { shown: number; total: number }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <p className="px-3 py-1 text-[10px] text-zinc-400">
      {t('designBrowser.searchTruncated', { shown, total })}
    </p>
  )
}

/** Yosys 常量 bit（'0'/'1'/'x'/'z' 原样字符串） */
const CONSTANT_BITS = new Set(['0', '1', 'x', 'z'])

/**
 * cell pin 连接展示：常量 bit 原样显示，普通 bit 反查所属 net 名（逗号连接，去重）；
 * 全部 bit 均未命中任何 net 且非常量时返回 null，由调用方回退为原始 bit 数。
 */
function connectionLabel(bits: string[], bitToNet: Map<string, string>): string | null {
  const names: string[] = []
  for (const bit of bits) {
    const name = CONSTANT_BITS.has(bit) ? bit : bitToNet.get(bit)
    if (name) names.push(name)
  }
  const unique = [...new Set(names)]
  return unique.length > 0 ? unique.join(', ') : null
}

export function DesignBrowserPage(): React.JSX.Element {
  const { t } = useTranslation()
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
  const [rtlStale, setRtlStale] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 当前设计上下文与选中对象
  const [context, setContext] = useState<TraceContext | null>(null)
  const [selectedNet, setSelectedNet] = useState<string | null>(null)
  const [selectedCellName, setSelectedCellName] = useState<string | null>(null)
  const [selectedProcessName, setSelectedProcessName] = useState<string | null>(null)

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

  const currentModule = useMemo<DesignModule | DesignModuleV2 | null>(
    () => database?.modules.find((module) => module.name === context?.module) ?? null,
    [database, context]
  )
  const isV3 = database?.version === 3
  /** v3 选中实例（instances[]）；v2 选中 cell（cells[]） */
  const selectedInstance = useMemo<DesignInstanceRef | null>(() => {
    if (!currentModule || !('instances' in currentModule) || !selectedCellName) return null
    return currentModule.instances.find((instance) => instance.name === selectedCellName) ?? null
  }, [currentModule, selectedCellName])
  const selectedProcess = useMemo<DesignProcess | null>(() => {
    if (!currentModule || !('processes' in currentModule) || !selectedProcessName) return null
    return currentModule.processes.find((process) => process.id === selectedProcessName) ?? null
  }, [currentModule, selectedProcessName])
  /** v2 cell 详情数据（冻结路径） */
  const selectedCell = useMemo(() => {
    if (!currentModule || !('cells' in currentModule) || !selectedCellName) return null
    return currentModule.cells.find((cell) => cell.name === selectedCellName) ?? null
  }, [currentModule, selectedCellName])
  /** v2：bit id → 所属 net 名：cell pin 的连接 bit 反查 net；同一 bit 有多个 net 别名时先登记者优先 */
  const bitToNet = useMemo(() => {
    const map = new Map<string, string>()
    if (!currentModule || !('nets' in currentModule)) return map
    for (const net of currentModule.nets) {
      for (const bit of net.bits) {
        if (!map.has(bit)) map.set(bit, net.name)
      }
    }
    return map
  }, [currentModule])
  /** cell 详情连接表：pin → 所连 net 名（未命中回退原始 bit 数） */
  const cellConnections = useMemo(
    () =>
      selectedCell
        ? Object.entries(selectedCell.connections).map(([pin, bits]) => ({
            pin,
            bits,
            label: connectionLabel(bits, bitToNet)
          }))
        : [],
    [selectedCell, bitToNet]
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
    setSelectedProcessName(entry.process ?? null)
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
      const initialTop = preferred?.name ?? cached?.database.topModule ?? candidates[0]?.name ?? ''
      setTop(initialTop)
      setRtlStale(cached?.rtlStale ?? false)
      if (cached && (!preferred || cached.database.topModule === preferred.name)) {
        adoptDatabase(cached.database)
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
      setRtlStale(false)
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
    const source = currentModule
      ? 'signals' in currentModule
        ? currentModule.signals.find((candidate) => candidate.name === net)?.source ?? null
        : currentModule.nets.find((candidate) => candidate.name === net)?.source ?? null
      : null
    navigate({ context, net, cell: null, source })
  }

  /** 源码标识符：单击选中，双击跳转定义 / 下钻实例；v3 支持 u_child.sig 层次引用解析 */
  const handleWord = (word: string, action: 'select' | 'jump'): void => {
    if (!database || !context || !currentModule) return
    // v3 层次引用 u_child.sig：下钻到子实例上下文并选中 sig
    if (database.version === 3 && 'instances' in currentModule && word.includes('.')) {
      const segments = word.split('.')
      const instanceName = segments[0]
      const signalName = segments.slice(1).join('.')
      const instance = currentModule.instances.find((item) => item.name === instanceName)
      if (instance && signalName) {
        const childPath = `${context.instancePath}.${instanceName}`
        const childNode = findInstanceByPath(database.hierarchy, childPath)
        if (childNode) {
          const childContext = { instancePath: childPath, module: childNode.module }
          if (action === 'select') {
            setContext(childContext)
            setSelectedNet(signalName)
            setSelectedCellName(null)
            setSelectedProcessName(null)
          } else {
            const childModule = database.modules.find((module) => module.name === childNode.module)
            const source = childModule && 'signals' in childModule
              ? childModule.signals.find((signal) => signal.name === signalName)?.source ?? instance.source ?? null
              : instance.source ?? null
            navigate({ context: childContext, net: signalName, cell: null, source })
          }
          return
        }
      }
    }
    if (database.version === 3 && 'signals' in currentModule) {
      const signal = currentModule.signals.find((candidate) => candidate.name === word)
      const instance = currentModule.instances.find((candidate) => candidate.name === word)
      if (action === 'select') {
        if (signal) {
          setSelectedNet(word)
          setSelectedCellName(null)
          setSelectedProcessName(null)
        } else if (instance) {
          setSelectedCellName(word)
          setSelectedNet(null)
          setSelectedProcessName(null)
        }
        return
      }
      if (instance) {
        // 双击实例名：下钻进入子模块（instances[].name 匹配口径）
        navigate({
          context: { instancePath: `${context.instancePath}.${instance.name}`, module: instance.module },
          net: null,
          cell: null,
          source: database.modules.find((module) => module.name === instance.module)?.source ?? instance.source ?? null
        })
      } else if (signal) {
        navigate({ context, net: word, cell: null, source: signal.source ?? null })
      } else {
        const module = database.modules.find((candidate) => candidate.name === word)
        if (module) void showSource(module.source)
      }
      return
    }
    // v2（Yosys 回退形态，冻结）：nets / cells 口径
    if (!('nets' in currentModule) || !('cells' in currentModule)) return
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

  /** 按实例路径在层次树中定位实例（用于取当前实例子树） */
  const findInstanceByPath = (root: DesignInstance, path: string): DesignInstance | null => {
    if (root.path === path) return root
    for (const child of root.children) {
      const found = findInstanceByPath(child, path)
      if (found) return found
    }
    return null
  }
  /** 深度优先找子树内模块名的第一个实例 */
  const findFirstModuleInstance = (root: DesignInstance, moduleName: string): DesignInstance | null => {
    if (root.module === moduleName) return root
    for (const child of root.children) {
      const found = findFirstModuleInstance(child, moduleName)
      if (found) return found
    }
    return null
  }

  /**
   * net 归属模块而非实例，定位规则：①当前实例所属模块即目标模块 → 保持当前实例不动；
   * ②取当前实例子树内该模块的第一个实例；③回退到全局第一个实例。
   */
  const pickNetResult = (moduleName: string, net: string, source?: string): void => {
    if (!database) return
    let target: TraceContext
    if (context && context.module === moduleName) {
      target = context
    } else {
      const subtree = context ? findInstanceByPath(database.hierarchy, context.instancePath) : null
      const hit =
        (subtree && findFirstModuleInstance(subtree, moduleName)) ??
        findFirstModuleInstance(database.hierarchy, moduleName)
      target = hit
        ? { instancePath: hit.path, module: hit.module }
        : { instancePath: database.hierarchy.path, module: database.topModule }
    }
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
          {t('designBrowser.backToWorkspace')}
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
            title={t('designBrowser.selectTopTitle')}
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
          {loading
            ? t('designBrowser.elaborating')
            : database
              ? t('designBrowser.reElaborate')
              : hasRecommendedTop
                ? t('designBrowser.autoElaborate')
                : t('designBrowser.useSelectedTop')}
        </button>
        <div className="h-5 w-px bg-zinc-200" />
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => goHistory(-1)}
            disabled={histIndex <= 0}
            title={t('designBrowser.navBack')}
            aria-label={t('designBrowser.navBackAria')}
            className="flex h-7 w-7 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-600 hover:bg-zinc-50 disabled:opacity-40"
          >
            <ArrowLeft size={14} />
          </button>
          <button
            type="button"
            onClick={() => goHistory(1)}
            disabled={histIndex >= historyRef.current.length - 1}
            title={t('designBrowser.navForward')}
            aria-label={t('designBrowser.navForwardAria')}
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
            placeholder={t('designBrowser.searchPlaceholder')}
            className="w-64 rounded border border-zinc-300 py-1.5 pl-7 pr-2 text-xs"
          />
          {searchResults && query.trim() && (
            <div className="absolute right-0 top-full z-30 mt-1 max-h-96 w-96 overflow-auto rounded border border-zinc-300 bg-white shadow-lg">
              {searchResults.instances.items.length === 0 &&
                searchResults.modules.items.length === 0 &&
                searchResults.signals.items.length === 0 && (
                  <p className="px-3 py-2 text-xs text-zinc-400">{t('designBrowser.noSearchResults')}</p>
                )}
              {searchResults.instances.items.length > 0 && (
                <div>
                  <p className="bg-zinc-50 px-3 py-1 text-[10px] font-semibold text-zinc-500">{t('designBrowser.searchGroups.instances')}</p>
                  {searchResults.instances.items.map((node) => (
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
                  {searchResults.instances.truncated && (
                    <TruncatedNote shown={searchResults.instances.items.length} total={searchResults.instances.total} />
                  )}
                </div>
              )}
              {searchResults.modules.items.length > 0 && (
                <div>
                  <p className="bg-zinc-50 px-3 py-1 text-[10px] font-semibold text-zinc-500">{t('designBrowser.searchGroups.modules')}</p>
                  {searchResults.modules.items.map((module) => (
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
                  {searchResults.modules.truncated && (
                    <TruncatedNote shown={searchResults.modules.items.length} total={searchResults.modules.total} />
                  )}
                </div>
              )}
              {searchResults.signals.items.length > 0 && (
                <div>
                  <p className="bg-zinc-50 px-3 py-1 text-[10px] font-semibold text-zinc-500">{t('designBrowser.searchGroups.signals')}</p>
                  {searchResults.signals.items.map((item) => (
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
                  {searchResults.signals.truncated && (
                    <TruncatedNote shown={searchResults.signals.items.length} total={searchResults.signals.total} />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        {database && (
          <span className="text-xs text-zinc-500">
            {t('designBrowser.databaseInfo', {
              count: database.modules.length,
              time: database.generatedAt.slice(0, 19).replace('T', ' ')
            })}
          </span>
        )}
        {database && rtlStale && (
          <span
            className="rounded border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700"
            title={t('designBrowser.rtlStaleBadge')}
          >
            {t('designBrowser.rtlStaleBadge')}
          </span>
        )}
      </header>

      {error && (
        <div className="flex shrink-0 items-start gap-2 border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{error}</span>
          <button
            type="button"
            onClick={() => setError('')}
            aria-label={t('designBrowser.dismissError')}
            className="shrink-0 rounded px-1 text-red-400 hover:bg-red-100 hover:text-red-700"
          >
            ✕
          </button>
        </div>
      )}

      {!database || !context ? (
        <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
          {loading
            ? t('designBrowser.autoLoading', { top: top || 'design' })
            : hasRecommendedTop
              ? t('designBrowser.preparingDatabase')
              : t('designBrowser.multipleRootsHint')}
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
            label={t('designBrowser.resizeHierarchy')}
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
              label={t('designBrowser.resizeSignals')}
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
            label={t('designBrowser.resizeInspector')}
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
              ) : selectedProcess ? (
                <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
                  <p className="text-zinc-400">{t('designBrowser.process.kind')}</p>
                  <p className="font-mono font-semibold text-zinc-900">
                    {selectedProcess.id} · {selectedProcess.kind}
                  </p>
                  {(selectedProcess.clock || selectedProcess.reset) && (
                    <p className="mt-1 font-mono text-zinc-500">
                      {selectedProcess.clock && `@(${selectedProcess.clock})`}
                      {selectedProcess.reset && ` ${t('designBrowser.process.reset')}: ${selectedProcess.reset}`}
                    </p>
                  )}
                  {selectedProcess.source && (
                    <button
                      type="button"
                      onClick={() => void showSource(selectedProcess.source)}
                      className="mt-1 block truncate font-mono text-blue-600 hover:underline"
                      title={selectedProcess.source}
                    >
                      {selectedProcess.source}
                    </button>
                  )}
                  <p className="mt-2 text-zinc-400">{t('designBrowser.process.drives')}</p>
                  {selectedProcess.drives.length === 0 ? (
                    <p className="text-zinc-400">—</p>
                  ) : (
                    selectedProcess.drives.map((name) => (
                      <button
                        key={name}
                        type="button"
                        onClick={() => selectNet(name)}
                        className="mr-2 font-mono text-blue-600 hover:underline"
                      >
                        {name}
                      </button>
                    ))
                  )}
                  <p className="mt-2 text-zinc-400">{t('designBrowser.process.reads')}</p>
                  {selectedProcess.reads.length === 0 ? (
                    <p className="text-zinc-400">—</p>
                  ) : (
                    selectedProcess.reads.map((name) => (
                      <button
                        key={name}
                        type="button"
                        onClick={() => selectNet(name)}
                        className="mr-2 font-mono text-blue-600 hover:underline"
                      >
                        {name}
                      </button>
                    ))
                  )}
                </div>
              ) : selectedInstance && context ? (
                <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
                  <p className="text-zinc-400">{t('designBrowser.instance.kind')}</p>
                  <p className="font-mono font-semibold text-zinc-900">{selectedInstance.name}</p>
                  <p className="font-mono text-zinc-500" title={selectedInstance.module}>
                    {displayModuleName(selectedInstance.module)}
                  </p>
                  {selectedInstance.module && (
                    <button
                      type="button"
                      onClick={() =>
                        navigate({
                          context: {
                            instancePath: `${context.instancePath}.${selectedInstance.name}`,
                            module: selectedInstance.module
                          },
                          net: null,
                          cell: null,
                          source:
                            database.modules.find((module) => module.name === selectedInstance.module)
                              ?.source ?? selectedInstance.source ?? null
                        })
                      }
                      className="mt-2 rounded border border-blue-300 bg-blue-50 px-2 py-1 text-blue-700 hover:bg-blue-100"
                    >
                      {t('designBrowser.enterInstance')}
                    </button>
                  )}
                  <p className="mt-2 text-zinc-400">{t('designBrowser.instance.parameters')}</p>
                  {Object.keys(selectedInstance.parameterOverrides).length === 0 ? (
                    <p className="text-zinc-400">{t('designBrowser.instance.noParameters')}</p>
                  ) : (
                    <table className="w-full">
                      <tbody>
                        {Object.entries(selectedInstance.parameterOverrides).map(([name, value]) => (
                          <tr key={name} className="border-t border-zinc-200">
                            <th className="py-1 text-left font-mono">{name}</th>
                            <td className="py-1 text-right font-mono text-zinc-600">{value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <p className="mt-2 text-zinc-400">{t('designBrowser.instance.connections')}</p>
                  <table className="w-full">
                    <tbody>
                      {selectedInstance.connections.map((connection) => (
                        <tr key={connection.pin} className="border-t border-zinc-200">
                          <th className="py-1 text-left font-mono">
                            <button
                              type="button"
                              onClick={() => void showSource(connection.source)}
                              className="font-mono text-blue-600 hover:underline"
                              title={connection.source ?? connection.pin}
                            >
                              {connection.pin}
                            </button>
                          </th>
                          <td className="py-1 text-right text-zinc-500">
                            {connection.signal ? (
                              <button
                                type="button"
                                onClick={() => {
                                  if (connection.signal) selectNet(connection.signal)
                                }}
                                className="block max-w-44 truncate font-mono text-blue-600 hover:underline"
                                title={connection.expr || connection.signal}
                              >
                                {connection.signal}
                              </button>
                            ) : (
                              <span
                                className="block max-w-44 truncate font-mono"
                                title={connection.expr || t('designBrowser.instance.exprFallback')}
                              >
                                {connection.expr || t('designBrowser.instance.exprFallback')}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : selectedCell ? (
                <div className="min-h-0 flex-1 overflow-auto p-3 text-xs">
                  <p className="text-zinc-400">{t('designBrowser.cellKind')}</p>
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
                      {t('designBrowser.enterInstance')}
                    </button>
                  )}
                  <table className="mt-2 w-full">
                    <tbody>
                      {cellConnections.map(({ pin, bits, label }) => (
                        <tr key={pin} className="border-t border-zinc-200">
                          <th className="py-1 text-left font-mono">{pin}</th>
                          <td className="py-1 text-right text-zinc-500">
                            {label ? (
                              <span className="block max-w-44 truncate font-mono" title={label}>
                                {label}
                              </span>
                            ) : (
                              t('designBrowser.cellDetail.bitCount', { count: bits.length })
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="p-3 text-xs text-zinc-400">
                  {t('designBrowser.inspectorHint')}
                </p>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
