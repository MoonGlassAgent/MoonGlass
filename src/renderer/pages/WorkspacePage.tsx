/**
 * 阶段工作区 — 可拖拽分栏布局（Phase 4）
 *
 * 布局：顶部 PhaseBoard → 水平分栏（文件树 | 分隔条 | 主区）→
 * 主区垂直分栏（对话/文件 | 分隔条 | 底部面板）。
 * 所有分隔条可鼠标拖拽调整大小，类似 VS Code 体验。
 *
 * Phase 4 增强：
 * - 可拖拽分栏（水平 + 垂直）
 * - 验证操作按钮（VERIF 阶段）
 * - 语法高亮文件查看（Prism.js）
 * - 底部面板功能化
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { PHASE_LABELS, PHASE_ORDER, type ChipProject, type Phase } from '@shared/types'
import { PhaseBoard, type GatePanelData } from '../components/PhaseBoard'
import { ChatPanel } from '../components/ChatPanel'
import { FileTree } from '../components/FileTree'
import { useChatStore } from '../store/chatStore'

const BOTTOM_TABS = ['📊 Lint', '🔬 仿真', '📝 日志'] as const
const MIN_SIDEBAR = 140
const MAX_SIDEBAR = 400
const MIN_BOTTOM = 80
const MAX_BOTTOM = 400

// ============================================================
// 可拖拽分隔条组件
// ============================================================

function HResizeHandle({ onDrag }: { onDrag: (dx: number) => void }): React.JSX.Element {
  const dragging = useRef(false)

  return (
    <div
      onMouseDown={(e) => {
        dragging.current = true
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
        const onMove = (ev: MouseEvent): void => {
          if (dragging.current) onDrag(ev.movementX)
        }
        const onUp = (): void => {
          dragging.current = false
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      }}
      className="w-1 cursor-col-resize bg-zinc-200 hover:bg-blue-400 active:bg-blue-500 transition-colors shrink-0"
    />
  )
}

function VResizeHandle({ onDrag }: { onDrag: (dy: number) => void }): React.JSX.Element {
  const dragging = useRef(false)

  return (
    <div
      onMouseDown={(e) => {
        dragging.current = true
        document.body.style.cursor = 'row-resize'
        document.body.style.userSelect = 'none'
        const onMove = (ev: MouseEvent): void => {
          if (dragging.current) onDrag(ev.movementY)
        }
        const onUp = (): void => {
          dragging.current = false
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
          document.removeEventListener('mousemove', onMove)
          document.removeEventListener('mouseup', onUp)
        }
        document.addEventListener('mousemove', onMove)
        document.addEventListener('mouseup', onUp)
      }}
      className="h-1 cursor-row-resize bg-zinc-200 hover:bg-blue-400 active:bg-blue-500 transition-colors shrink-0"
    />
  )
}

// ============================================================
// 工具函数
// ============================================================

/** 文件扩展名 → Prism 语言类 */
function extToLang(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  const name = filePath.split(/[\\/]/).pop()?.toLowerCase() ?? ''

  // 日志文件识别（.log / .out / .rpt 及文件名含 log 的）
  if (/^(log|out|rpt)$/i.test(ext) || /log/i.test(name)) return 'log'

  const map: Record<string, string> = {
    v: 'verilog', sv: 'verilog', vh: 'verilog',
    c: 'cpp', cpp: 'cpp', h: 'cpp', hpp: 'cpp',
    py: 'python',
    pl: 'perl', pm: 'perl',
    tcl: 'tcl', sdc: 'tcl',
    js: 'javascript', ts: 'typescript',
    json: 'json', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', xml: 'xml', html: 'html',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    bat: 'batch', cmd: 'batch',
    txt: 'text', cfg: 'text', ini: 'text',
    makefile: 'makefile', mk: 'makefile'
  }
  return map[ext] ?? 'text'
}

function shouldOpenExternally(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return ['html', 'htm', 'xml', 'svg'].includes(ext)
}

function flattenFiles(nodes: Array<{ name: string; path: string; type: 'file' | 'dir'; children?: unknown[] }>): string[] {
  const out: string[] = []
  for (const n of nodes) {
    if (n.type === 'file') out.push(n.path)
    if (n.children) out.push(...flattenFiles(n.children as typeof nodes))
  }
  return out
}

// ============================================================
// 工作区页面
// ============================================================

export function WorkspacePage(): React.JSX.Element {
  const { projectId } = useParams({ from: '/workspace/$projectId' })
  const [project, setProject] = useState<ChipProject | null>(null)
  const [gate, setGate] = useState<GatePanelData | null>(null)

  // 分栏布局状态（px）
  const [sidebarW, setSidebarW] = useState(200)
  const [bottomH, setBottomH] = useState(160)

  const [activeTab, setActiveTab] = useState<(typeof BOTTOM_TABS)[number]>(BOTTOM_TABS[0])
  const [mainTab, setMainTab] = useState<MainTab>('chat')
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [treeTick, setTreeTick] = useState(0)
  const [verifLog, setVerifLog] = useState<string[]>([])
  const agentStreaming = useChatStore((s) => s.streaming)
  const sendAgentPrompt = useChatStore((s) => s.send)
  const fileViewerRef = useRef<HTMLDivElement>(null)

  const reload = useCallback(async () => {
    setProject(await window.moonglass.project.get(projectId))
  }, [projectId])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => { if (!agentStreaming) setTreeTick((t) => t + 1) }, [agentStreaming])

  // Prism 语法高亮（使用预配置版本，含 verilog/perl/tcl/python/log 等组件）
  useEffect(() => {
    if (mainTab !== 'chat' && fileViewerRef.current) {
      const timer = setTimeout(() => {
        import('../utils/prism-setup').then((mod) => {
          mod.default.highlightAllUnder(fileViewerRef.current!)
        }).catch(() => {})
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [mainTab, openFiles])

  const openFile = async (relPath: string): Promise<void> => {
    if (shouldOpenExternally(relPath)) {
      const opened = await window.moonglass.fs.openExternal(relPath)
      if (!opened) appendLog(`⚠️ ${relPath} 无法在外部打开`)
      else { appendLog(`🌐 已打开: ${relPath}`); return }
    }
    if (!openFiles.some((f) => f.path === relPath)) {
      const result = await window.moonglass.fs.readFile(projectId, relPath)
      setOpenFiles((files) => [
        ...files,
        result
          ? { path: relPath, content: result.content, truncated: result.truncated }
          : { path: relPath, content: '（无法读取该文件）', truncated: false }
      ])
    }
    setMainTab(relPath)
  }

  const closeFile = (relPath: string): void => {
    setOpenFiles((files) => files.filter((f) => f.path !== relPath))
    if (mainTab === relPath) setMainTab('chat')
  }

  const handleAdvance = async (to: Phase): Promise<void> => {
    const result = await window.moonglass.phase.advance(projectId, to)
    if (!result) return
    setProject(result.project)
    setGate(result.gate)
  }

  const handleRollback = async (to: Phase): Promise<void> => {
    if (!window.confirm(`回退到 ${to} 后，后续阶段产出将被标记为废弃。确认回退？`)) return
    setProject(await window.moonglass.phase.rollback(projectId, to))
    setGate(null)
  }

  /** 仅重新运行门禁检查，不推进阶段 */
  const handleRecheck = async (): Promise<void> => {
    if (!project) return
    const nextPhase = PHASE_ORDER[PHASE_ORDER.indexOf(project.currentPhase) + 1]
    if (!nextPhase) return
    appendLog('🔄 重新运行门禁检查...')
    try {
      const results = await window.moonglass.phase.gateCheck(projectId, nextPhase)
      if (results) {
        const blocked = results.some((r) => r.severity === 'error' && !r.passed)
        setGate({ blocked, results })
        appendLog(blocked ? '❌ 门禁未通过' : '✅ 门禁检查完成')
      }
    } catch (err) {
      appendLog(`❌ 门禁检查失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const appendLog = (msg: string): void => {
    setVerifLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`])
  }

  // ---- 验证操作 ----
  const handleSetupEnv = async (): Promise<void> => {
    appendLog('🔧 开始搭建验证环境...')
    try {
      await sendAgentPrompt('请扫描工作区所有 RTL 文件，为每个模块生成 Verilator C++ 测试台。把测试台放到 verification/ 目录下。完成后汇总生成的测试台文件列表。')
      appendLog('✅ 验证环境搭建指令已发送')
    } catch (err) {
      appendLog(`❌ 指令发送失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleRunRegression = async (): Promise<void> => {
    appendLog('🚀 开始完整验证回归...')
    try {
      await sendAgentPrompt('请对工作区所有 RTL 模块完成完整验证闭环：\n1. collect_rtl_files 扫描\n2. 对每个 RTL 运行 run_verible_lint\n3. 运行 check_synthesizability\n4. 生成测试台到 verification/\n5. 运行 run_simulation\n6. 输出验证报告')
      appendLog('✅ 验证回归指令已发送')
    } catch (err) {
      appendLog(`❌ 指令发送失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        项目不存在或加载中… <Link to="/projects" className="ml-2 text-blue-600 underline">返回项目列表</Link>
      </div>
    )
  }

  const activeFile = openFiles.find((f) => f.path === mainTab)

  return (
    <div className="flex h-full flex-col">
      {/* ======== 顶部：项目信息 + 阶段看板 ======== */}
      <header className="shrink-0 border-b border-zinc-200 bg-white px-6 py-4">
        <div className="mb-3 flex items-baseline gap-3">
          <h1 className="text-lg font-bold text-zinc-900">{project.name}</h1>
          <span className="text-sm text-zinc-500">
            当前阶段：{project.currentPhase} · {PHASE_LABELS[project.currentPhase]}
          </span>
        </div>
        <PhaseBoard project={project} onAdvance={handleAdvance} onRollback={handleRollback} gate={gate} />

        {/* 门禁检查结果区：显示 gate 结果 + 重新检查按钮 */}
        {gate && (
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => void handleRecheck()}
              disabled={agentStreaming}
              className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
            >
              🔄 重新检查门禁
            </button>
            {gate.blocked ? (
              <span className="text-xs text-amber-600">修复问题后点击重新检查</span>
            ) : (
              <span className="text-xs text-emerald-600">✅ 门禁通过，可推进</span>
            )}
          </div>
        )}

        {project.currentPhase === 'VERIF' && (
          <div className="mt-3 flex items-center gap-3 border-t border-zinc-100 pt-3">
            <span className="text-xs font-medium text-zinc-500">验证操作：</span>
            <button
              onClick={() => void handleSetupEnv()}
              disabled={agentStreaming}
              className="rounded border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
            >
              🔧 搭建验证环境
            </button>
            <button
              onClick={() => void handleRunRegression()}
              disabled={agentStreaming}
              className="rounded border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
            >
              🚀 完成验证回归
            </button>
            {agentStreaming && <span className="text-xs text-amber-600">Agent 运行中…</span>}
          </div>
        )}
      </header>

      {/* ======== 主体：水平分栏（文件树 | 主区） ======== */}
      <div className="flex min-h-0 flex-1">
        {/* 左侧：文件树 */}
        <aside
          className="overflow-hidden bg-white p-3 text-sm text-zinc-500 shrink-0"
          style={{ width: sidebarW }}
        >
          <FileTree projectId={project.id} onOpenFile={(p) => void openFile(p)} refreshTick={treeTick} />
        </aside>

        {/* 水平分隔条 */}
        <HResizeHandle onDrag={(dx) => setSidebarW((w) => Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, w + dx)))} />

        {/* 右侧：垂直分栏（主区 | 底部面板） */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* ---- 主区 ---- */}
          <div className="flex min-h-0 flex-col" style={{ height: `calc(100% - ${bottomH}px - 0.25rem)` }}>
            {/* 选项卡条 */}
            <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-200 bg-white px-2 pt-1.5 shrink-0">
              <button
                onClick={() => setMainTab('chat')}
                className={`shrink-0 rounded-t px-3 py-1.5 text-xs ${
                  mainTab === 'chat' ? 'bg-zinc-100 font-medium text-zinc-800' : 'text-zinc-500 hover:text-zinc-700'
                }`}
              >
                💬 对话
              </button>
              {openFiles.map((f) => (
                <span
                  key={f.path}
                  className={`flex shrink-0 items-center gap-1 rounded-t px-2 py-1.5 text-xs ${
                    mainTab === f.path ? 'bg-zinc-100 font-medium text-zinc-800' : 'text-zinc-500'
                  }`}
                >
                  <button onClick={() => setMainTab(f.path)} className="max-w-40 truncate font-mono hover:text-zinc-700">
                    {f.path.split(/[\\/]/).pop()}
                  </button>
                  <button onClick={() => closeFile(f.path)} className="text-zinc-400 hover:text-red-600" title="关闭">×</button>
                </span>
              ))}
            </div>

            {/* 内容区 */}
            <div className="flex-1 min-h-0">
              <div className={mainTab === 'chat' ? 'h-full' : 'hidden'}>
                <ChatPanel projectId={project.id} phase={project.currentPhase} />
              </div>

              {/* 文件查看 */}
              {activeFile && (
                <div className="flex h-full flex-col overflow-hidden p-3" ref={fileViewerRef}>
                  <div className="mb-1 flex shrink-0 items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] ${
                        extToLang(activeFile.path) !== 'text'
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-zinc-100 text-zinc-500'
                      }`}>
                        {extToLang(activeFile.path)}
                      </span>
                      <span className="font-mono text-xs text-zinc-400">{activeFile.path}</span>
                    </div>
                    <div className="flex gap-1">
                      {shouldOpenExternally(activeFile.path) && (
                        <button
                          onClick={() => window.moonglass.fs.openExternal(activeFile.path).catch(() => {})}
                          className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100"
                        >
                          🌐 外部打开
                        </button>
                      )}
                      <button
                        onClick={() => navigator.clipboard.writeText(activeFile.content).catch(() => {})}
                        className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100"
                      >
                        📋 复制
                      </button>
                    </div>
                  </div>
                  <pre className={`min-h-0 flex-1 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs whitespace-pre-wrap language-${extToLang(activeFile.path)}`}>
                    <code className={`language-${extToLang(activeFile.path)}`}>{activeFile.content}</code>
                  </pre>
                  {activeFile.truncated && (
                    <p className="mt-1 shrink-0 text-xs text-zinc-400">（内容过大，仅显示前 256 KB）</p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* ---- 垂直分隔条 ---- */}
          <VResizeHandle onDrag={(dy) => setBottomH((h) => Math.max(MIN_BOTTOM, Math.min(MAX_BOTTOM, h - dy)))} />

          {/* ---- 底部面板 ---- */}
          <div className="border-t border-zinc-200 bg-white shrink-0" style={{ height: bottomH }}>
            <div className="flex gap-1 border-b border-zinc-200 px-3 pt-2 shrink-0">
              {BOTTOM_TABS.map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`rounded-t px-3 py-1.5 text-xs ${
                    activeTab === tab ? 'bg-zinc-100 text-zinc-800' : 'text-zinc-500 hover:text-zinc-700'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
            <div className="h-[calc(100%-2rem)] overflow-y-auto p-3 text-sm text-zinc-500">
              <BottomPanel tab={activeTab} projectId={project.id} verifLog={verifLog} agentStreaming={agentStreaming} onAppendLog={appendLog} />
            </div>
          </div>
        </div>
      </div>

      {/* 状态栏 */}
      <footer className="shrink-0 flex items-center gap-4 border-t border-zinc-200 bg-white px-4 py-1.5 text-xs text-zinc-500">
        <span>工具链: {project.edaToolchain}</span>
        <span>阶段完成: {PHASE_ORDER.filter((p) => project.phases[p].status === 'completed').length}/{PHASE_ORDER.length}</span>
        <span className="ml-auto">MoonGlass v0.3 · Phase 4 · 拖拽分隔条调整面板大小</span>
      </footer>
    </div>
  )
}

// ============================================================
// 类型
// ============================================================

type MainTab = 'chat' | string

interface OpenFile {
  path: string
  content: string
  truncated: boolean
}

// ============================================================
// 底部面板
// ============================================================

interface BottomPanelProps {
  tab: string
  projectId: string
  verifLog: string[]
  agentStreaming: boolean
  onAppendLog: (msg: string) => void
}

function BottomPanel({ tab, projectId, verifLog, agentStreaming }: BottomPanelProps): React.JSX.Element {
  const [output, setOutput] = useState('')

  if (tab === '📊 Lint') {
    return (
      <div className="flex h-full flex-col gap-2">
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={async () => {
              try {
                const tree = await window.moonglass.fs.tree(projectId)
                const rtlFiles = flattenFiles(tree).filter((f) => /\.(v|sv)$/i.test(f))
                if (rtlFiles.length === 0) { setOutput('工作区暂无 RTL 文件'); return }
                setOutput(`发现 ${rtlFiles.length} 个 RTL 文件:\n${rtlFiles.map((f) => `  ${f}`).join('\n')}\n\n在对话中用 run_verible_lint 检查`)
              } catch (err) {
                setOutput(`错误: ${err instanceof Error ? err.message : String(err)}`)
              }
            }}
            disabled={agentStreaming}
            className="w-fit rounded border border-zinc-300 bg-zinc-100 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-200 disabled:opacity-50"
          >
            🔍 扫描 RTL 文件
          </button>
          <span className="text-xs text-zinc-400">共 {verifLog.filter(l => l.includes('Lint')).length} 次 Lint 操作</span>
        </div>
        {output && <pre className="flex-1 overflow-auto rounded bg-zinc-100 p-2 text-xs text-zinc-700 whitespace-pre-wrap">{output}</pre>}
      </div>
    )
  }

  if (tab === '🔬 仿真') {
    return (
      <div className="flex h-full flex-col gap-2">
        <p className="text-xs text-zinc-500 shrink-0">
          仿真输出区。用 generate_tb + run_simulation 运行后结果在此。
        </p>
        <p className="text-xs text-zinc-400">提示：「对 counter 模块运行仿真验证」</p>
      </div>
    )
  }

  if (tab === '📝 日志') {
    return (
      <div className="flex h-full flex-col gap-1">
        {verifLog.length === 0 ? (
          <p className="text-xs text-zinc-400">暂无验证操作日志。</p>
        ) : (
          <div className="space-y-0.5 flex-1 overflow-auto">
            {verifLog.map((entry, i) => (
              <div key={i} className="font-mono text-xs text-zinc-600">{entry}</div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return <></>
}
