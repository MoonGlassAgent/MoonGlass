import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react'
import type { DesignDiagnostic, DesignInstance } from '@moonglass/design-browser-engine'
import { useTranslation } from '../../i18n'
import { displayModuleName } from './module-name'

/** 实例 tooltip：打开定义提示 + 参数覆盖列表（v3 层次树节点带 parameterOverrides） */
function instanceTooltip(hint: string, overridesLabel: string, node: DesignInstance): string {
  const entries = Object.entries(node.parameterOverrides ?? {})
  if (entries.length === 0) return hint
  const summary = entries.map(([name, value]) => `${name}=${value}`).join(', ')
  return `${hint}\n${overridesLabel}: ${summary}`
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
  const { t } = useTranslation()
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
            aria-label={
              expanded
                ? t('designBrowser.hierarchy.collapseNode', { name: node.name })
                : t('designBrowser.hierarchy.expandNode', { name: node.name })
            }
            title={expanded ? t('designBrowser.hierarchy.collapse') : t('designBrowser.hierarchy.expand')}
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
          title={instanceTooltip(
            t('designBrowser.hierarchy.openDefinitionHint', { path: node.path }),
            t('designBrowser.hierarchy.parameterOverrides'),
            node
          )}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="truncate font-medium">{node.name}</span>
          <span className="ml-auto truncate text-zinc-400" title={node.module}>
            {displayModuleName(node.module)}
          </span>
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

/** 左侧设计层次树（类 Verdi 层次浏览器，支持过滤） */
export function HierarchyPanel({
  root,
  diagnostics,
  selectedPath,
  expandedPaths,
  onToggle,
  onSelect,
  onOpenDefinition,
  onExpandAll,
  onCollapseAll
}: {
  root: DesignInstance
  diagnostics: DesignDiagnostic[]
  selectedPath: string
  expandedPaths: Set<string>
  onToggle: (path: string) => void
  onSelect: (node: DesignInstance) => void
  onOpenDefinition: (node: DesignInstance) => void
  onExpandAll: () => void
  onCollapseAll: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [filter, setFilter] = useState('')
  const flatMatches = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (!needle) return null
    const matches: DesignInstance[] = []
    const visit = (node: DesignInstance): void => {
      if (
        node.name.toLowerCase().includes(needle) ||
        displayModuleName(node.module).toLowerCase().includes(needle)
      ) {
        matches.push(node)
      }
      node.children.forEach(visit)
    }
    visit(root)
    // 记录总匹配数，截断时列表末尾显示「仅显示前 N 条 · 共 M 条」
    return { items: matches.slice(0, 100), total: matches.length }
  }, [root, filter])

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-zinc-200 bg-zinc-50 px-3 py-2">
        <span className="text-xs font-semibold text-zinc-600">{t('designBrowser.hierarchy.title')}</span>
        <span className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onExpandAll}
            className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-200 hover:text-blue-700"
            title={t('designBrowser.hierarchy.expandAll')}
            aria-label={t('designBrowser.hierarchy.expandAllAria')}
          >
            <ChevronsUpDown size={14} />
          </button>
          <button
            type="button"
            onClick={onCollapseAll}
            className="flex h-6 w-6 items-center justify-center rounded text-zinc-500 hover:bg-zinc-200 hover:text-blue-700"
            title={t('designBrowser.hierarchy.collapseAll')}
            aria-label={t('designBrowser.hierarchy.collapseAllAria')}
          >
            <ChevronsDownUp size={14} />
          </button>
        </span>
      </div>
      <div className="shrink-0 border-b border-zinc-200 px-2 py-1.5">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t('designBrowser.hierarchy.filterPlaceholder')}
          className="w-full rounded border border-zinc-300 px-2 py-1 text-xs"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {flatMatches ? (
          flatMatches.items.length === 0 ? (
            <p className="px-3 py-2 text-xs text-zinc-400">{t('designBrowser.hierarchy.noMatchingInstances')}</p>
          ) : (
            <>
              {flatMatches.items.map((node) => (
                <button
                  key={node.path}
                  type="button"
                  onClick={() => onSelect(node)}
                  onDoubleClick={() => onOpenDefinition(node)}
                  className={`flex w-full items-center gap-2 px-3 py-1 text-left text-xs ${
                    selectedPath === node.path ? 'bg-blue-50 text-blue-700' : 'hover:bg-zinc-100'
                  }`}
                  title={instanceTooltip(
                    node.path,
                    t('designBrowser.hierarchy.parameterOverrides'),
                    node
                  )}
                >
                  <span className="truncate font-medium">{node.name}</span>
                  <span className="ml-auto truncate text-zinc-400" title={node.module}>
                    {displayModuleName(node.module)}
                  </span>
                </button>
              ))}
              {flatMatches.total > flatMatches.items.length && (
                <p className="px-3 py-1 text-[10px] text-zinc-400">
                  {t('designBrowser.searchTruncated', {
                    shown: flatMatches.items.length,
                    total: flatMatches.total
                  })}
                </p>
              )}
            </>
          )
        ) : (
          <HierarchyNode
            node={root}
            selected={selectedPath}
            expandedPaths={expandedPaths}
            onToggle={onToggle}
            onSelect={onSelect}
            onOpenDefinition={onOpenDefinition}
          />
        )}
      </div>
      {diagnostics.length > 0 && (
        <div className="max-h-32 shrink-0 overflow-auto border-t border-zinc-200 p-2">
          <h3 className="mb-1 text-xs font-semibold text-amber-700">{t('designBrowser.hierarchy.diagnostics')}</h3>
          {diagnostics.map((diagnostic, index) => (
            <p key={index} className="mb-1 text-xs text-amber-700">
              {diagnostic.message}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}
