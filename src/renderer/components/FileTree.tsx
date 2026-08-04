/**
 * 项目文件树
 *
 * 自动扫描项目工作目录（Agent 的产出位置），目录可折叠，
 * 双击文件以选项卡打开内容。Agent 运行结束或手动刷新时重新扫描。
 */

import { useCallback, useEffect, useState } from 'react'
import { Activity, ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen, RefreshCw } from 'lucide-react'
import type { FileTreeNode } from '@shared/types'

interface FileTreeProps {
  projectId: string
  /** 双击文件时回调（相对路径） */
  onOpenFile: (relPath: string) => void
  /** 递增时触发重新扫描（父组件用于联动 Agent 运行结束等时机） */
  refreshTick?: number
}

export function FileTree({ projectId, onOpenFile, refreshTick = 0 }: FileTreeProps): React.JSX.Element {
  const [nodes, setNodes] = useState<FileTreeNode[]>([])
  const [loading, setLoading] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setNodes(await window.moonglass.fs.tree(projectId))
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    void reload()
  }, [reload, refreshTick])

  return (
    <div className="file-tree flex h-full flex-col">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-zinc-700">项目文件</span>
        <button
          onClick={() => void reload()}
          title="刷新文件树"
          className="file-tree-refresh flex h-7 w-7 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {nodes.length === 0 ? (
          <p className="mt-2 text-xs text-zinc-400">
            工作目录暂无文件
            <br />
            （Agent 生成的代码会出现在这里）
          </p>
        ) : (
          <ul className="space-y-0.5 text-xs">
            {nodes.map((n) => (
              <TreeNode key={n.path} node={n} depth={0} onOpenFile={onOpenFile} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function TreeNode({
  node,
  depth,
  onOpenFile
}: {
  node: FileTreeNode
  depth: number
  onOpenFile: (relPath: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(depth < 1)
  const indent = { paddingLeft: `${depth * 12 + 4}px` }

  if (node.type === 'dir') {
    return (
      <li>
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-zinc-600 hover:bg-zinc-100"
          style={indent}
        >
          {open ? (
            <ChevronDown size={13} className="shrink-0 text-zinc-400" />
          ) : (
            <ChevronRight size={13} className="shrink-0 text-zinc-400" />
          )}
          {open ? (
            <FolderOpen size={14} className="shrink-0 text-amber-600" />
          ) : (
            <Folder size={14} className="shrink-0 text-amber-600" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {open && node.children && node.children.length > 0 && (
          <ul className="space-y-0.5">
            {node.children.map((c) => (
              <TreeNode key={c.path} node={c} depth={depth + 1} onOpenFile={onOpenFile} />
            ))}
          </ul>
        )}
      </li>
    )
  }

  return (
    <li>
      <div className="group flex w-full items-center rounded hover:bg-zinc-100">
        <button
          onClick={(event) => {
            if (event.detail >= 2) onOpenFile(node.path)
          }}
          title={`${node.path}（双击打开）`}
          className="flex min-w-0 flex-1 items-center gap-1 px-1 py-0.5 text-left font-mono text-zinc-600"
          style={indent}
        >
          <span className="w-[13px] shrink-0" />
          <FileCode2 size={14} className="shrink-0 text-sky-600" />
          <span className="truncate">{node.name}</span>
        </button>
        {/\.(?:fst|vcd)$/i.test(node.name) && (
          <button
            type="button"
            onClick={() => onOpenFile(node.path)}
            title="用 GTKWave 打开波形"
            className="mr-1 shrink-0 rounded p-0.5 text-emerald-600 opacity-70 hover:bg-emerald-50 hover:opacity-100"
          >
            <Activity size={14} />
          </button>
        )}
      </div>
    </li>
  )
}
