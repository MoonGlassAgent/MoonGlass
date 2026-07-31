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
import {
  PHASE_LABELS,
  PHASE_ORDER,
  type ChipProject,
  type GateCheckResult,
  type Phase
} from '@shared/types'
import { PhaseBoard, type GatePanelData } from '../components/PhaseBoard'
import { ChatPanel, SessionTabs } from '../components/ChatPanel'
import { FileTree } from '../components/FileTree'
import { useChatStore } from '../store/chatStore'
import { highlightCode } from '../utils/prism-setup'

const BOTTOM_TABS = ['📊 Lint', '🔬 仿真', '⚙ 综合', '📝 日志'] as const
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
  const [generatingDashboard, setGeneratingDashboard] = useState(false)

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

  const reload = useCallback(async () => {
    setProject(await window.moonglass.project.get(projectId))
  }, [projectId])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => { if (!agentStreaming) setTreeTick((t) => t + 1) }, [agentStreaming])

  const openFile = async (relPath: string): Promise<void> => {
    if (/\.(vcd|fst)$/i.test(relPath)) {
      const result = await window.moonglass.eda.openWaveform(projectId, relPath)
      appendLog(
        result.ok
          ? `波形已用 GTKWave 打开: ${relPath}`
          : `波形打开失败: ${result.error ?? relPath}`
      )
      if (result.ok) return
    }
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

  const handleFixGateIssues = async (
    phase: Phase,
    results: GateCheckResult[]
  ): Promise<void> => {
    if (results.length === 0) return
    setMainTab('chat')
    const details = results
      .map((result, index) => `${index + 1}. [${result.checkName}] ${result.message}`)
      .join('\n')
    appendLog(`已将 ${results.length} 项门禁问题发送到 Agent 会话`)
    try {
      await sendAgentPrompt(
        `请修复以下 ${PHASE_LABELS[phase]} 阶段门禁问题：\n\n${details}\n\n` +
        '要求：\n' +
        '1. 先读取相关规范文档和现有文件，不要覆盖用户已有的有效内容\n' +
        '2. 按 MoonGlass 规范目录和当前阶段技能规则修改实际工作区文件\n' +
        '3. 对占位内容补充可评审的具体内容；对误报标记采用语义判断，不要简单删除已关闭的历史记录\n' +
        '4. 运行相应技能校验脚本或 EDA 工具验证修复结果\n' +
        '5. 在会话中逐项说明修改文件、验证结果和仍需用户决定的事项\n' +
        '完成后提醒我点击“重新检查门禁”。'
      )
    } catch (error) {
      appendLog(`门禁修复指令发送失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ---- 验证操作 ----
  const handleSetupEnv = async (): Promise<void> => {
    appendLog('🔧 开始搭建验证环境...')
    try {
      await sendAgentPrompt(
        '请按 MoonGlass 验证目录规范搭建环境：\n' +
        '1. 先使用 verification-planning 技能检查并补齐 docs/04_verification/ 三份计划\n' +
        '2. 使用 collect_rtl_files 读取 rtl/design.json 与 rtl/filelist.f，确认 DUT 和 topModule\n' +
        '3. 使用 cocotb-verification 技能为各 DUT 创建 verification/<module>_tb/{agents,env,coverage,tests,sequences,sim}/\n' +
        '4. 使用技能校验脚本验证环境结构；不要把测试代码或构建产物写入 rtl/\n' +
        '5. 完成后汇总创建的环境、待实现测试和发现的规格缺口'
      )
      appendLog('✅ 验证环境搭建指令已发送')
    } catch (err) {
      appendLog(`❌ 指令发送失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleRunRegression = async (): Promise<void> => {
    appendLog('🚀 开始完整验证回归...')
    try {
      await sendAgentPrompt('请对工作区所有 RTL 模块完成规范验证闭环：\n1. 使用 verification-planning 技能校验 docs/04_verification/ 三份计划\n2. collect_rtl_files 扫描，并运行 run_verible_lint、check_synthesizability\n3. 使用 cocotb-verification 技能创建 verification/<module>_tb/ 标准环境\n4. 运行 run_simulation\n5. 确认 verification/results/<module>/ 中有日志、result.json、覆盖率和波形\n6. 更新需求追踪与 docs/06_validation/ 验证报告')
      appendLog('✅ 验证回归指令已发送')
    } catch (err) {
      appendLog(`❌ 指令发送失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleFastTrackSynthesis = async (): Promise<void> => {
    const confirmed = window.confirm(
      '将跳过验证检查和 QA 质量检查，直接进入综合实现。\n\n' +
      '该路径仅用于快速评估面积，综合结果不能视为功能验证、质量签核或发布依据。确认继续？'
    )
    if (!confirmed) return
    const updated = await window.moonglass.phase.fastTrackSynthesis(projectId)
    if (!updated) return
    setProject(updated)
    setGate(null)
  }

  const handleCompleteProject = async (): Promise<void> => {
    if (!window.confirm('确认综合实现已完成，并将项目标记为完成？')) return
    const updated = await window.moonglass.phase.completeProject(projectId)
    if (updated) setProject(updated)
  }

  const handleGenerateDashboard = async (): Promise<void> => {
    setGeneratingDashboard(true)
    try {
      const result = await window.moonglass.project.generateDashboard(projectId)
      appendLog(`总体报告已生成: ${result.path}`)
      if (!result.opened) appendLog('总体报告未能自动打开，请从文件树打开 docs/07_release/project_dashboard.html')
      setTreeTick((tick) => tick + 1)
    } catch (error) {
      appendLog(`总体报告生成失败: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setGeneratingDashboard(false)
    }
  }

  const handleRunSynthesis = async (): Promise<void> => {
    appendLog('⚙ 开始逻辑综合流程...')
    setActiveTab('⚙ 综合')
    try {
      await sendAgentPrompt(
        '请完成当前工程的逻辑综合闭环：\n' +
        '1. collect_rtl_files 扫描 RTL，并确认顶层模块\n' +
        '2. 检查 docs/ 中的时钟与 I/O 约束；如果关键约束缺失，先向我确认，不要猜测\n' +
        '3. 使用 generate_sdc 生成 imp/constraints/design.sdc\n' +
        '4. 使用 run_logic_synthesis 输出到 imp/synthesis/\n' +
        '5. 汇总网表、单元数量、面积、时序估算、警告和报告路径\n' +
        '注意区分通用单元统计、Liberty 映射估算与正式 STA 签核结果'
      )
      appendLog('✅ 综合指令已发送')
    } catch (err) {
      appendLog(`❌ 综合指令发送失败: ${err instanceof Error ? err.message : String(err)}`)
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
        <div className="mb-3 flex items-center gap-3">
          <h1 className="text-lg font-bold text-zinc-900">{project.name}</h1>
          <span className="text-sm text-zinc-500">
            当前阶段：{project.currentPhase} · {PHASE_LABELS[project.currentPhase]}
          </span>
          <button
            type="button"
            onClick={() => void handleGenerateDashboard()}
            disabled={generatingDashboard}
            className="ml-auto rounded border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
          >
            {generatingDashboard ? '正在生成…' : '生成总体报告'}
          </button>
          <Link
            to="/design-browser/$projectId"
            params={{ projectId }}
            className="rounded border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100"
          >
            RTL Design Browser
          </Link>
        </div>
        <PhaseBoard
          project={project}
          onAdvance={handleAdvance}
          onRollback={handleRollback}
          onFastTrackSynthesis={() => void handleFastTrackSynthesis()}
          onCompleteProject={() => void handleCompleteProject()}
          onFixGateIssues={(phase, results) => void handleFixGateIssues(phase, results)}
          gate={gate}
        />

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

        {project.currentPhase === 'SYNTH' && (
          <div className="mt-3 flex items-center gap-3 border-t border-zinc-100 pt-3">
            <span className="text-xs font-medium text-zinc-500">综合操作：</span>
            <button
              onClick={() => void handleRunSynthesis()}
              disabled={agentStreaming}
              className="rounded border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
            >
              ⚙ 生成 SDC 并运行综合
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
              <SessionTabs projectId={project.id} />
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
                <div className="flex h-full flex-col overflow-hidden p-3">
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
                  <pre className={`project-source min-h-0 flex-1 overflow-auto rounded border border-zinc-200 bg-zinc-50 p-3 font-mono text-xs whitespace-pre-wrap language-${extToLang(activeFile.path)}`}>
                    <code
                      className={`language-${extToLang(activeFile.path)}`}
                      dangerouslySetInnerHTML={{
                        __html: highlightCode(activeFile.content, extToLang(activeFile.path))
                      }}
                    />
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
        <span>
          阶段处理: {PHASE_ORDER.filter((p) => ['completed', 'skipped'].includes(project.phases[p].status)).length}/{PHASE_ORDER.length}
        </span>
        <span className="ml-auto">MoonGlass v0.3 · Phase 6 综合链</span>
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
  const [waveforms, setWaveforms] = useState<string[]>([])
  const [waveformStatus, setWaveformStatus] = useState('')

  useEffect(() => {
    if (tab !== '🔬 仿真') return
    let active = true
    window.moonglass.fs.tree(projectId)
      .then((tree) => {
        if (!active) return
        setWaveforms(flattenFiles(tree).filter((file) => /\.(vcd|fst)$/i.test(file)))
      })
      .catch((err) => {
        if (active) setWaveformStatus(`扫描波形失败: ${err instanceof Error ? err.message : String(err)}`)
      })
    return () => { active = false }
  }, [projectId, tab, agentStreaming])

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
        <div className="flex items-center justify-between">
          <p className="text-xs text-zinc-500">波形文件</p>
          <span className="text-xs text-zinc-400">{waveforms.length} 个</span>
        </div>
        {waveforms.length === 0 ? (
          <p className="text-xs text-zinc-400">暂无 VCD/FST。运行仿真后波形会出现在 verification/results/。</p>
        ) : (
          <div className="space-y-1 overflow-y-auto">
            {waveforms.map((file) => (
              <div key={file} className="flex items-center gap-2 rounded border border-zinc-200 bg-zinc-50 px-2 py-1">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-600">{file}</span>
                <button
                  onClick={async () => {
                    setWaveformStatus(`正在打开 ${file}...`)
                    const result = await window.moonglass.eda.openWaveform(projectId, file)
                    setWaveformStatus(result.ok ? `已用 GTKWave 打开 ${file}` : `打开失败: ${result.error}`)
                  }}
                  className="shrink-0 rounded border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs text-blue-700 hover:bg-blue-100"
                  title="使用 GTKWave 打开波形"
                >
                  打开波形
                </button>
              </div>
            ))}
          </div>
        )}
        {waveformStatus && <p className="text-xs text-zinc-500">{waveformStatus}</p>}
      </div>
    )
  }

  if (tab === '⚙ 综合') {
    return (
      <div className="flex h-full flex-col gap-2">
        <p className="text-xs text-zinc-500 shrink-0">
          综合产物默认写入 imp/constraints/ 与 imp/synthesis/，可在左侧文件树查看 SDC、门级网表、日志和报告。
        </p>
        <p className="text-xs text-zinc-400">
          无 Liberty 工艺库时仅提供通用单元统计；提供 .lib 后可生成映射面积和 ABC 延迟估算。
        </p>
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
