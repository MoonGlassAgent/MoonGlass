/**
 * 阶段工作区（规格书 §5.3）
 *
 * 布局：顶部 PhaseBoard + 左侧文件树（自动扫描工作目录）+
 * 中部选项卡区（Agent 对话 + 文件查看）+ 底部面板 Tab 占位。
 * 阶段推进/回退、对话、文件树均通过 IPC 走通。
 */

import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { PHASE_LABELS, PHASE_ORDER, type ChipProject, type Phase } from '@shared/types'
import { PhaseBoard, type GatePanelData } from '../components/PhaseBoard'
import { ChatPanel } from '../components/ChatPanel'
import { FileTree } from '../components/FileTree'
import { useChatStore } from '../store/chatStore'

const BOTTOM_TABS = ['🐍 Python', '📊 Lint', '🔬 仿真', '📈 波形', '📝 日志'] as const

/** 中部主区选项卡：'chat' 或已打开文件的相对路径 */
type MainTab = 'chat' | string

interface OpenFile {
  path: string
  content: string
  truncated: boolean
}

export function WorkspacePage(): React.JSX.Element {
  const { projectId } = useParams({ from: '/workspace/$projectId' })
  const [project, setProject] = useState<ChipProject | null>(null)
  const [gate, setGate] = useState<GatePanelData | null>(null)
  const [activeTab, setActiveTab] = useState<(typeof BOTTOM_TABS)[number]>(BOTTOM_TABS[0])
  const [mainTab, setMainTab] = useState<MainTab>('chat')
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [treeTick, setTreeTick] = useState(0)
  const agentStreaming = useChatStore((s) => s.streaming)

  const reload = useCallback(async () => {
    setProject(await window.moonglass.project.get(projectId))
  }, [projectId])

  useEffect(() => {
    void reload()
  }, [reload])

  // Agent 运行结束（含首次加载）后刷新文件树，及时反映 Agent 写出的文件
  useEffect(() => {
    if (!agentStreaming) setTreeTick((t) => t + 1)
  }, [agentStreaming])

  const openFile = async (relPath: string): Promise<void> => {
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
      {/* 顶部：项目信息 + 阶段看板 */}
      <header className="border-b border-zinc-200 bg-white px-6 py-4">
        <div className="mb-3 flex items-baseline gap-3">
          <h1 className="text-lg font-bold text-zinc-900">{project.name}</h1>
          <span className="text-sm text-zinc-500">
            当前阶段：{project.currentPhase} · {PHASE_LABELS[project.currentPhase]}
          </span>
        </div>
        <PhaseBoard project={project} onAdvance={handleAdvance} onRollback={handleRollback} gate={gate} />
      </header>

      <div className="flex min-h-0 flex-1">
        {/* 左侧：文件树 */}
        <aside className="w-52 border-r border-zinc-200 bg-white p-3 text-sm text-zinc-500">
          <FileTree projectId={project.id} onOpenFile={(p) => void openFile(p)} refreshTick={treeTick} />
        </aside>

        {/* 中部：选项卡区（对话 / 文件查看）+ 底部面板 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 主区选项卡条 */}
          <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-200 bg-white px-2 pt-1.5">
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
                <button
                  onClick={() => closeFile(f.path)}
                  className="text-zinc-400 hover:text-red-600"
                  title="关闭"
                >
                  ×
                </button>
              </span>
            ))}
          </div>

          {/* 主区内容：对话常驻挂载（保输入草稿），文件页只读展示 */}
          <div className="min-h-0 flex-1">
            <div className={mainTab === 'chat' ? 'h-full' : 'hidden'}>
              <ChatPanel projectId={project.id} phase={project.currentPhase} />
            </div>
            {activeFile && (
              <div className="flex h-full flex-col overflow-hidden p-3">
                <div className="mb-1 shrink-0 font-mono text-xs text-zinc-400">{activeFile.path}</div>
                <pre className="min-h-0 flex-1 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs whitespace-pre-wrap text-zinc-800">
                  {activeFile.content}
                </pre>
                {activeFile.truncated && (
                  <p className="mt-1 shrink-0 text-xs text-zinc-400">（内容过大，仅显示前 256 KB）</p>
                )}
              </div>
            )}
          </div>

          {/* 底部面板 */}
          <div className="border-t border-zinc-200 bg-white">
            <div className="flex gap-1 border-b border-zinc-200 px-3 pt-2">
              {BOTTOM_TABS.map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`rounded-t px-3 py-1.5 text-xs ${
                    activeTab === tab
                      ? 'bg-zinc-100 text-zinc-800'
                      : 'text-zinc-500 hover:text-zinc-700'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>
            <div className="h-36 p-3 text-sm text-zinc-500">
              <BottomPanel tab={activeTab} />
            </div>
          </div>
        </div>
      </div>

      {/* 状态栏 */}
      <footer className="flex items-center gap-4 border-t border-zinc-200 bg-white px-4 py-1.5 text-xs text-zinc-500">
        <span>工具链: {project.edaToolchain}</span>
        <span>
          阶段完成: {PHASE_ORDER.filter((p) => project.phases[p].status === 'completed').length}/
          {PHASE_ORDER.length}
        </span>
        <span className="ml-auto">MoonGlass v0.1（架构骨架）</span>
      </footer>
    </div>
  )
}

function BottomPanel({ tab }: { tab: (typeof BOTTOM_TABS)[number] }): React.JSX.Element {
  const [pyOut, setPyOut] = useState<string>('')

  if (tab === '🐍 Python') {
    return (
      <div className="flex h-full flex-col gap-2">
        <button
          onClick={async () => {
            const r = await window.moonglass.python.run({
              code: "import sys; print('Python OK:', sys.version.split()[0])"
            })
            setPyOut(r.stdout || r.stderr)
          }}
          className="w-fit rounded border border-zinc-300 bg-zinc-100 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-200"
        >
          ▶ 运行冒烟测试（python --version）
        </button>
        {pyOut && (
          <pre className="flex-1 overflow-auto rounded bg-zinc-100 p-2 text-xs text-emerald-700">{pyOut}</pre>
        )}
        {!pyOut && <span className="text-xs">Python 执行引擎骨架已就绪（PythonService，spawn + 超时控制）</span>}
      </div>
    )
  }

  const hints: Record<string, string> = {
    '📊 Lint': 'Verible Lint 面板占位 — Phase 4 接入 @moonglass/eda-bridge',
    '🔬 仿真': '仿真面板占位 — Phase 4 接入 Verilator/VCS',
    '📈 波形': '波形查看占位 — 后续集成 Surfer / GTKWave',
    '📝 日志': '运行日志占位'
  }
  return <span className="text-xs">{hints[tab]}</span>
}
