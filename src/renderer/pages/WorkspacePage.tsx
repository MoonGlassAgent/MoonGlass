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
  AlertTriangle,
  Box,
  ChevronDown,
  ChevronUp,
  FileOutput,
  FlaskConical,
  Maximize2,
  Play,
  RotateCw,
  TerminalSquare
} from 'lucide-react'
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

const BOTTOM_TABS = [
  { id: 'problems', label: '问题', icon: AlertTriangle },
  { id: 'runs', label: '运行', icon: Play },
  { id: 'verification', label: '验证', icon: FlaskConical },
  { id: 'synthesis', label: '综合', icon: Box },
  { id: 'artifacts', label: '产物', icon: FileOutput }
] as const
type BottomTab = (typeof BOTTOM_TABS)[number]['id']
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
      className="resize-rail resize-rail-x w-1 cursor-col-resize shrink-0"
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
      className="resize-rail resize-rail-y h-1 cursor-row-resize shrink-0"
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

function buildChangeResponsePrompt(project: ChipProject, targetPhase: Phase): string {
  const notice = project.phases[targetPhase].changeNotice
  if (!notice) return `请检查并完成${PHASE_LABELS[targetPhase]}阶段的变更响应。`
  const taskByPhase: Record<Phase, string> = {
    REQ_SPEC: '核对需求、规格和需求-规格追溯矩阵，确认变更边界与验收标准。',
    ARCH: '根据上游变更更新架构、模块划分、接口、时钟复位和相关验证计划。',
    RTL: '根据最新架构和接口规格检查并更新 RTL、filelist、设计元数据和必要的代码质量证据。',
    VERIF: '根据最新规格和 RTL 更新验证环境、测试用例、覆盖率计划，并执行相关回归，落盘真实日志和结果。',
    QA: '执行变更专项质量审查，检查需求-规格-架构-RTL-验证追溯、Lint/CDC/回归证据和检查清单，记录遗留项。',
    SYNTH: '根据变更后的 RTL 和约束重新生成 SDC、重新执行综合，并更新面积、时序和综合质量证据。'
  }
  return `请完成${PHASE_LABELS[targetPhase]}阶段的变更响应。

变更来源：${PHASE_LABELS[notice.sourcePhase]}
变更时间：${notice.changedAt}
变更原因：${notice.reason}
本阶段要求：${taskByPhase[targetPhase]}

要求：
1. 先读取当前工作区的真实文件和已有证据，判断变更影响范围。
2. 直接修改需要更新的实际文件，不要只给出建议或文字方案。
3. 不要删除原有有效产物；如需替换，保留可审计的变更记录。
4. 调用本阶段适用的工具和技能完成检查，并把日志、报告和结果落盘。
5. 最后汇总修改文件、执行的检查、真实结果和仍需用户决定的事项。`
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
  const [bottomH, setBottomH] = useState(() => Number(localStorage.getItem(`moonglass:bottom-height:${projectId}`)) || 190)
  const [bottomCollapsed, setBottomCollapsed] = useState(false)

  const [activeTab, setActiveTab] = useState<BottomTab>('problems')
  const [mainTab, setMainTab] = useState<MainTab>('chat')
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([])
  const [treeTick, setTreeTick] = useState(0)
  const [verifLog, setVerifLog] = useState<string[]>([])
  const [fileNotice, setFileNotice] = useState<{ ok: boolean; text: string } | null>(null)
  const agentStreaming = useChatStore((s) => s.streaming)
  const sendAgentPrompt = useChatStore((s) => s.send)
  const ensureAgent = useChatStore((s) => s.ensure)

  const reload = useCallback(async () => {
    setProject(await window.moonglass.project.get(projectId))
  }, [projectId])

  useEffect(() => { void reload() }, [reload])
  useEffect(() => {
    if (!agentStreaming) {
      setTreeTick((t) => t + 1)
      void reload()
    }
  }, [agentStreaming, reload])
  useEffect(() => {
    const timer = window.setInterval(() => { void reload() }, 2000)
    return () => window.clearInterval(timer)
  }, [reload])
  useEffect(() => {
    localStorage.setItem(`moonglass:bottom-height:${projectId}`, String(bottomH))
  }, [bottomH, projectId])

  const openFile = async (relPath: string): Promise<void> => {
    if (/\.(vcd|fst)$/i.test(relPath)) {
      try {
        const result = await window.moonglass.eda.openWaveform(projectId, relPath)
        const text = result.ok
          ? `已用 GTKWave 打开：${relPath}`
          : `波形打开失败：${result.error ?? relPath}`
        appendLog(text)
        setFileNotice({ ok: result.ok, text })
        window.setTimeout(() => setFileNotice(null), 5000)
      } catch (error) {
        const text = `波形打开失败：${error instanceof Error ? error.message : String(error)}`
        appendLog(text)
        setFileNotice({ ok: false, text })
        window.setTimeout(() => setFileNotice(null), 5000)
      }
      return
    }
    if (shouldOpenExternally(relPath)) {
      const opened = await window.moonglass.fs.openExternal(projectId, relPath)
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
    try {
      const result = await window.moonglass.phase.advance(projectId, to)
      if (!result) return
      setProject(result.project)
      setGate(result.gate)
      if (result.gate.blocked) {
        // 门禁阻断：允许用户确认后强制推进（失败项以红色感叹号保留为遗留问题）
        const failed = result.gate.results.filter((r) => r.severity === 'error' && !r.passed)
        const confirmed = window.confirm(
          `门禁未完全通过（${failed.length} 项 Error 级检查失败）。\n\n` +
            `确定在门禁没有完全通过的情况下继续推进到 ${to} 吗？\n` +
            '未通过的检查项将以红色感叹号保留为遗留问题。'
        )
        if (!confirmed) return
        appendLog(`⚠️ 用户确认在门禁未完全通过的情况下强制推进到 ${to}`)
        const forced = await window.moonglass.phase.advance(projectId, to, { force: true })
        if (!forced) return
        setProject(forced.project)
        setGate(forced.gate)
      }
    } catch (error) {
      appendLog(`阶段推进失败: ${error instanceof Error ? error.message : String(error)}`)
      setGate({ blocked: true, results: [] })
    }
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

  const handleEnterPhase = async (to: Phase): Promise<void> => {
    if (!project || project.currentPhase === to) return
    try {
      const entered = await window.moonglass.phase.enter(projectId, to)
      if (entered) {
        setProject(entered)
        setGate(null)
        appendLog(`已进入 ${PHASE_LABELS[to]}，后续阶段产物已保留`)
      }
    } catch (error) {
      appendLog(`进入阶段失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const handleRespondChange = async (targetPhase: Phase): Promise<void> => {
    if (!project || project.phases[targetPhase].changeNotice?.status !== 'pending') return
    setMainTab('chat')
    let activeProject = project
    try {
      if (project.currentPhase !== targetPhase) {
        const entered = await window.moonglass.phase.enter(projectId, targetPhase)
        if (!entered) return
        activeProject = entered
        setProject(entered)
        setGate(null)
        await ensureAgent(projectId)
      }
      appendLog(`开始响应 ${PHASE_LABELS[targetPhase]} 的变更影响`)
      await sendAgentPrompt(buildChangeResponsePrompt(activeProject, targetPhase))
      const acknowledged = await window.moonglass.phase.acknowledgeChange(
        projectId,
        targetPhase,
        `已完成 ${PHASE_LABELS[targetPhase]} 的变更响应并提交 Agent 处理结果`
      )
      if (acknowledged) {
        setProject(acknowledged)
        appendLog(`✅ ${PHASE_LABELS[targetPhase]} 变更响应已完成`)
      }
    } catch (error) {
      appendLog(`变更响应失败: ${error instanceof Error ? error.message : String(error)}`)
    }
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
      await sendAgentPrompt('请对工作区所有 RTL 模块完成规范验证闭环：\n1. 使用 verification-planning 技能校验 docs/04_verification/ 三份计划\n2. collect_rtl_files 扫描，并运行 run_verible_lint、check_synthesizability\n3. 使用 cocotb-verification 技能创建 verification/<module>_tb/ 标准环境\n4. 对每个 DUT 调用 run_simulation(mode="cocotb", testModule=..., testDir=..., simulator="icarus", trace=true)，不要自行编写临时 runner 绕过工具\n5. 确认 verification/results/<module>/ 中有 compile.log、simulation.log、results.xml、result.json 和波形\n6. 更新需求追踪与 docs/06_validation/ 验证报告')
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
    setActiveTab('synthesis')
    try {
      await sendAgentPrompt(
        '请完成当前工程的逻辑综合闭环：\n' +
        '1. collect_rtl_files 读取 rtl/design.json/filelist.f，确认顶层模块，并区分 designFiles、libraryFiles、simulationFiles、physicalFiles\n' +
        '2. 检查 docs/ 中的时钟与 I/O 约束；如果关键约束缺失，先向我确认，不要猜测\n' +
        '3. 使用 generate_sdc 生成 imp/constraints/design.sdc\n' +
        '4. 使用 run_logic_synthesis 输出到 imp/synthesis/；SRAM blackbox 通过 libraryFiles 传入，禁止综合 behavioral/physical 视图\n' +
        '5. SRAM/ROM 宏面积与功耗按架构估算或宏数据手册单独汇总，不得计入 Yosys 标准单元面积\n' +
        '6. 汇总网表、单元数量、面积、时序估算、警告和报告路径\n' +
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
    <div className="workspace-shell flex h-full flex-col">
      {fileNotice && (
        <div className={`fixed right-5 top-5 z-[100] max-w-xl rounded border px-4 py-2 text-sm shadow-lg ${
          fileNotice.ok ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-red-300 bg-red-50 text-red-700'
        }`}>
          {fileNotice.text}
        </div>
      )}
      {/* ======== 顶部：项目信息 + 阶段看板 ======== */}
      <header className="workspace-header relative z-30 shrink-0 overflow-visible border-b border-zinc-200 bg-white px-6 py-4">
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
          onEnterPhase={(phase) => void handleEnterPhase(phase)}
          onAdvance={handleAdvance}
          onRollback={handleRollback}
          onFastTrackSynthesis={() => void handleFastTrackSynthesis()}
          onCompleteProject={() => void handleCompleteProject()}
          onFixGateIssues={(phase, results) => void handleFixGateIssues(phase, results)}
          onRespondChange={(phase) => void handleRespondChange(phase)}
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
            ) : gate.forced ? (
              <span className="text-xs text-amber-600">⚠️ 已强制推进，遗留问题以红色感叹号标注</span>
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
          className="workspace-tree overflow-hidden bg-white p-3 text-sm text-zinc-500 shrink-0"
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
            <div className="workspace-tabs flex items-center gap-1 overflow-x-auto border-b border-zinc-200 bg-white px-2 pt-1.5 shrink-0">
              <button
                onClick={() => setMainTab('chat')}
                className={`shrink-0 rounded-t px-3 py-1.5 text-xs ${
                  mainTab === 'chat' ? 'bg-zinc-100 font-medium text-zinc-800' : 'text-zinc-500 hover:text-zinc-700'
                }`}
              >
                💬 对话
              </button>
              <SessionTabs projectId={project.id} onActivate={() => setMainTab('chat')} />
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
            <div className="workspace-content flex-1 min-h-0">
              <div className={mainTab === 'chat' ? 'h-full' : 'hidden'}>
                <ChatPanel projectId={project.id} phase={project.currentPhase} />
              </div>

              {/* 文件查看 */}
              {activeFile && (
                <div className="source-surface flex h-full flex-col overflow-hidden p-3">
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
                          onClick={() => window.moonglass.fs.openExternal(projectId, activeFile.path).catch(() => {})}
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
          {!bottomCollapsed && (
            <VResizeHandle onDrag={(dy) => setBottomH((h) => Math.max(MIN_BOTTOM, Math.min(MAX_BOTTOM, h - dy)))} />
          )}

          {/* ---- 底部面板 ---- */}
          <div
            className="workspace-bottom border-t border-zinc-200 bg-white shrink-0"
            style={{ height: bottomCollapsed ? 38 : bottomH }}
          >
            <div className="engineering-console-tabs flex items-center gap-1 border-b border-zinc-200 px-3 pt-1.5 shrink-0">
              {BOTTOM_TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => { setActiveTab(tab.id); setBottomCollapsed(false) }}
                  className={`flex items-center gap-1.5 rounded-t px-3 py-1.5 text-xs ${
                    activeTab === tab.id ? 'bg-zinc-100 text-zinc-800' : 'text-zinc-500 hover:text-zinc-700'
                  }`}
                >
                  <tab.icon size={13} />
                  {tab.label}
                </button>
              ))}
              <span className="ml-auto text-[11px] text-zinc-400">工程控制台</span>
              <button
                onClick={() => { setBottomCollapsed(false); setBottomH(MAX_BOTTOM) }}
                className="console-icon-button"
                title="最大化控制台"
              >
                <Maximize2 size={13} />
              </button>
              <button
                onClick={() => setBottomCollapsed((value) => !value)}
                className="console-icon-button"
                title={bottomCollapsed ? '展开控制台' : '收起控制台'}
              >
                {bottomCollapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              </button>
            </div>
            {!bottomCollapsed && (
              <div className="h-[calc(100%-2.25rem)] overflow-y-auto p-3 text-sm text-zinc-500">
                <BottomPanel
                  tab={activeTab}
                  projectId={project.id}
                  verifLog={verifLog}
                  gate={gate}
                  agentStreaming={agentStreaming}
                  onOpenFile={(path) => void openFile(path)}
                  onRefresh={() => setTreeTick((tick) => tick + 1)}
                  onAskAgent={(prompt) => { setMainTab('chat'); void sendAgentPrompt(prompt) }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 状态栏 */}
      <footer className="workspace-status shrink-0 flex items-center gap-4 border-t border-zinc-200 bg-white px-4 py-1.5 text-xs text-zinc-500">
        <span>工具链: {project.edaToolchain}</span>
        <span>
          阶段处理: {PHASE_ORDER.filter((p) => ['completed', 'skipped'].includes(project.phases[p].status)).length}/{PHASE_ORDER.length}
        </span>
        <span className="ml-auto">MoonGlass v0.4 · Phase 6 综合链</span>
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
  tab: BottomTab
  projectId: string
  verifLog: string[]
  gate: GatePanelData | null
  agentStreaming: boolean
  onOpenFile: (path: string) => void
  onRefresh: () => void
  onAskAgent: (prompt: string) => void
}

interface ProjectInventory {
  rtl: string[]
  logs: string[]
  waveforms: string[]
  verification: string[]
  synthesis: string[]
  artifacts: string[]
}

const EMPTY_INVENTORY: ProjectInventory = {
  rtl: [], logs: [], waveforms: [], verification: [], synthesis: [], artifacts: []
}

function BottomPanel({
  tab,
  projectId,
  verifLog,
  gate,
  agentStreaming,
  onOpenFile,
  onRefresh,
  onAskAgent
}: BottomPanelProps): React.JSX.Element {
  const [inventory, setInventory] = useState<ProjectInventory>(EMPTY_INVENTORY)
  const [loading, setLoading] = useState(false)
  const [waveformStatus, setWaveformStatus] = useState('')

  const refreshInventory = useCallback(async () => {
    setLoading(true)
    try {
      const files = flattenFiles(await window.moonglass.fs.tree(projectId))
      const verification = files.filter((file) => /(^|\/)verification\//i.test(file))
      const synthesis = files.filter((file) => /(^|\/)imp\/(constraints|synthesis)\//i.test(file))
      setInventory({
        rtl: files.filter((file) => /(^|\/)rtl\/.*\.(v|sv)$/i.test(file)),
        logs: files.filter((file) => /\.(log|out)$/i.test(file)),
        waveforms: files.filter((file) => /\.(vcd|fst)$/i.test(file)),
        verification,
        synthesis,
        artifacts: files.filter((file) => /\.(log|out|rpt|json|xml|vcd|fst|sdc|v|html)$/i.test(file))
      })
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    let active = true
    if (active) void refreshInventory()
    return () => { active = false }
  }, [projectId, agentStreaming, refreshInventory])

  const failedGates = gate?.results.filter((result) => !result.passed) ?? []
  const errorLogs = verifLog.filter((entry) => /失败|错误|error|fail|❌/i.test(entry))
  const warningLogs = verifLog.filter((entry) => /警告|warning|⚠/i.test(entry))

  const toolbar = (
    <div className="mb-2 flex items-center gap-2">
      <button
        onClick={() => { void refreshInventory(); onRefresh() }}
        disabled={loading}
        className="console-action"
      >
        <RotateCw size={13} className={loading ? 'animate-spin' : ''} />
        刷新
      </button>
      <span className="text-[11px] text-zinc-400">{inventory.artifacts.length} 个可追踪产物</span>
    </div>
  )

  if (tab === 'problems') {
    return (
      <div className="flex h-full flex-col">
        {toolbar}
        <div className="mb-2 flex items-center gap-3 text-xs">
          <span className="problem-count problem-count-error">{failedGates.length + errorLogs.length} 错误</span>
          <span className="problem-count problem-count-warning">{warningLogs.length} 警告</span>
          <button
            onClick={() => onAskAgent('请检查工程控制台中的门禁失败、Lint、仿真和综合问题，定位根因，修改对应文件并重新运行相关工具验证。')}
            disabled={agentStreaming}
            className="console-action ml-auto"
          >
            交给 Agent 修复
          </button>
        </div>
        <div className="console-list flex-1 overflow-auto">
          {failedGates.map((result) => (
            <div key={result.checkId} className="console-row">
              <AlertTriangle size={14} className="shrink-0 text-red-500" />
              <strong className="shrink-0 text-xs text-zinc-700">{result.checkName}</strong>
              <span className="truncate text-xs text-zinc-500" title={result.message}>{result.message}</span>
              <span className="ml-auto shrink-0 text-[10px] text-zinc-400">门禁</span>
            </div>
          ))}
          {[...errorLogs, ...warningLogs].map((entry, index) => (
            <div key={`${entry}-${index}`} className="console-row">
              <TerminalSquare size={14} className="shrink-0 text-amber-500" />
              <span className="truncate font-mono text-xs text-zinc-600" title={entry}>{entry}</span>
            </div>
          ))}
          {failedGates.length + errorLogs.length + warningLogs.length === 0 && (
            <div className="console-empty">当前没有已知问题。运行 Lint、验证或综合后，诊断信息会集中显示在这里。</div>
          )}
        </div>
      </div>
    )
  }

  if (tab === 'runs') {
    return (
      <div className="flex h-full flex-col">
        {toolbar}
        {verifLog.length > 0 && (
          <div className="console-list mb-2 max-h-24 overflow-auto">
            {verifLog.map((entry, index) => (
              <div key={index} className="console-row font-mono text-xs text-zinc-600">{entry}</div>
            ))}
          </div>
        )}
        <FileRows
          files={inventory.logs}
          empty="尚无运行记录。工具启动后，实时状态显示在这里，落盘日志也会自动汇总。"
          onOpenFile={onOpenFile}
        />
      </div>
    )
  }

  if (tab === 'verification') {
    return (
      <div className="flex h-full flex-col">
        {toolbar}
        <div className="mb-2 grid grid-cols-3 gap-2">
          <ConsoleMetric label="验证产物" value={inventory.verification.length} />
          <ConsoleMetric label="波形" value={inventory.waveforms.length} />
          <ConsoleMetric label="RTL 文件" value={inventory.rtl.length} />
        </div>
        {inventory.waveforms.length > 0 && (
          <div className="console-list mb-2 max-h-24 overflow-y-auto">
            {inventory.waveforms.map((file) => (
              <div key={file} className="console-row">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-600">{file}</span>
                <button
                  onClick={async () => {
                    setWaveformStatus(`正在打开 ${file}...`)
                    const result = await window.moonglass.eda.openWaveform(projectId, file)
                    setWaveformStatus(result.ok ? `已用 GTKWave 打开 ${file}` : `打开失败: ${result.error}`)
                  }}
                  className="console-action shrink-0"
                  title="使用 GTKWave 打开波形"
                >
                  打开波形
                </button>
              </div>
            ))}
          </div>
        )}
        {waveformStatus && <p className="text-xs text-zinc-500">{waveformStatus}</p>}
        <FileRows
          files={inventory.verification.filter((file) => !/\.(vcd|fst)$/i.test(file))}
          empty="暂无验证结果。运行仿真后，result.json、JUnit、覆盖率、日志和波形会出现在 verification/results/。"
          onOpenFile={onOpenFile}
        />
      </div>
    )
  }

  if (tab === 'synthesis') {
    return (
      <div className="flex h-full flex-col">
        {toolbar}
        <div className="mb-2 grid grid-cols-3 gap-2">
          <ConsoleMetric label="综合产物" value={inventory.synthesis.length} />
          <ConsoleMetric label="约束文件" value={inventory.synthesis.filter((file) => /\.sdc$/i.test(file)).length} />
          <ConsoleMetric label="报告" value={inventory.synthesis.filter((file) => /\.(rpt|json|log)$/i.test(file)).length} />
        </div>
        <FileRows files={inventory.synthesis} empty="尚未发现综合产物。运行综合后，这里会汇总 SDC、网表、面积和时序报告。" onOpenFile={onOpenFile} />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {toolbar}
      <FileRows files={inventory.artifacts} empty="暂无可追踪产物。工具输出的日志、报告、波形、网表和结果文件会汇总在这里。" onOpenFile={onOpenFile} />
    </div>
  )
}

function ConsoleMetric({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="console-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function FileRows({ files, empty, onOpenFile }: { files: string[]; empty: string; onOpenFile: (path: string) => void }): React.JSX.Element {
  if (files.length === 0) return <div className="console-empty">{empty}</div>
  return (
    <div className="console-list flex-1 overflow-auto">
      {files.map((file) => (
        <button key={file} onDoubleClick={() => onOpenFile(file)} className="console-row w-full text-left" title="双击打开">
          <FileOutput size={14} className="shrink-0 text-sky-600" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-600">{file}</span>
          <span className="shrink-0 text-[10px] uppercase text-zinc-400">{file.split('.').pop()}</span>
        </button>
      ))}
    </div>
  )
}
