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
 * - 带行号、搜索和语法高亮的只读代码查看器
 * - 底部面板功能化
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import {
  AlertTriangle,
  Bot,
  Box,
  ChevronDown,
  ChevronUp,
  FileOutput,
  FlaskConical,
  Maximize2,
  Minus,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  Square,
  TerminalSquare
} from 'lucide-react'
import {
  PHASE_LABELS,
  PHASE_ORDER,
  type ChipProject,
  type GateCheckResult,
  type AgentDecisionRequest,
  type Phase
} from '@shared/types'
import { serializeDecisionResponses } from '@shared/agent-interaction'
import { PhaseBoard, type GatePanelData } from '../components/PhaseBoard'
import { ChatPanel, SessionTabs } from '../components/ChatPanel'
import { FileTree } from '../components/FileTree'
import { CodeViewer, fileLanguage } from '../components/CodeViewer'
import { MarkdownPreview } from '../components/MarkdownPreview'
import { useChatStore } from '../store/chatStore'

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

interface ManagedStep {
  phase: Phase
  status: 'running' | 'completed' | 'failed'
  detail: string
}

const MANAGED_PHASE_PROMPTS: Record<Phase, string> = {
  REQ_SPEC: '完成需求-规格定义：审查项目目标，补齐产品需求、模块规格、接口规格和需求-规格追溯矩阵，消除占位内容并执行文档检查。',
  ARCH: '完成架构设计：根据已批准需求规格更新总体架构、模块划分、接口、时钟复位、寄存器和微架构文档，并检查需求追溯。',
  RTL: '完成 RTL 开发：依据架构实现或修复 RTL，维护 design.json/filelist，运行 Lint、可综合性和必要的 CDC 检查，修复全部 Error。',
  VERIF: '完成验证闭环：更新验证计划和覆盖率计划，搭建或修复验证环境，执行相关回归，保存真实日志、JUnit、结果和波形，并更新追溯。',
  QA: '完成质量检查：执行变更审查、代码 Review、检查清单、Lint/CDC/回归证据核对，修复阻断问题并形成 QA 报告。',
  SYNTH: '完成综合评估：检查约束，生成 SDC，执行逻辑综合，汇总网表、单元、面积和时序估算及警告；明确区分估算与正式签核。'
}

function pendingDecisionRequests(): AgentDecisionRequest[] {
  const messages = useChatStore.getState().messages
  const answered = new Set(messages.flatMap((message) =>
    message.decisionResponses ?? (message.decisionResponse ? [message.decisionResponse] : [])
  ).map((response) => response.requestId))
  return messages.flatMap((message) => message.decisionRequest ? [message.decisionRequest] : [])
    .filter((request) => !answered.has(request.id))
}

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

function shouldOpenExternally(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? ''
  return ['html', 'htm', 'xml', 'svg'].includes(ext)
}

function parseFileLocation(reference: string): { path: string; line?: number; column?: number } {
  const normalized = reference.trim().replace(/^['"`]|['"`]$/g, '')
  const match = normalized.match(/^(.*?\.[a-zA-Z0-9_+-]+)(?::(\d+))?(?::(\d+))?$/)
  if (!match) return { path: normalized }
  return {
    path: match[1].replace(/\\/g, '/'),
    line: match[2] ? Number(match[2]) : undefined,
    column: match[3] ? Number(match[3]) : undefined
  }
}

function extractFileReference(text: string): string | null {
  return text.match(/(?:[\w.-]+[\\/])+[\w.@+()-]+\.[a-zA-Z0-9_+-]+(?::\d+)?(?::\d+)?/)?.[0] ?? null
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
  const [managedDialogOpen, setManagedDialogOpen] = useState(false)
  const [managedEndPhase, setManagedEndPhase] = useState<Phase>('SYNTH')
  const [managedRunning, setManagedRunning] = useState(false)
  const [managedSteps, setManagedSteps] = useState<ManagedStep[]>([])
  const [managedReportPath, setManagedReportPath] = useState('')
  const managedStopRef = useRef(false)
  const [changeDialogOpen, setChangeDialogOpen] = useState(false)
  const [changeType, setChangeType] = useState<'requirement' | 'specification' | 'bug'>('bug')
  const [changeSourcePhase, setChangeSourcePhase] = useState<Phase>('RTL')
  const [changeDescription, setChangeDescription] = useState('')
  const [wordWrap, setWordWrap] = useState(() => localStorage.getItem('moonglass:viewer-word-wrap') === 'true')
  const [viewerFontSize, setViewerFontSize] = useState(() => Number(localStorage.getItem('moonglass:viewer-font-size')) || 13)
  const [markdownPreview, setMarkdownPreview] = useState(true)
  const agentStreaming = useChatStore((s) => s.streaming)
  const sendAgentPrompt = useChatStore((s) => s.send)
  const ensureAgent = useChatStore((s) => s.ensure)
  const abortAgent = useChatStore((s) => s.abort)

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

  const refreshOpenFile = useCallback(async (relPath: string): Promise<void> => {
    const result = await window.moonglass.fs.readFile(projectId, relPath)
    if (!result) return
    setOpenFiles((files) => files.map((file) => file.path === relPath && (file.content !== result.content || file.truncated !== result.truncated)
      ? { ...file, content: result.content, truncated: result.truncated }
      : file))
  }, [projectId])

  const openFile = async (reference: string): Promise<void> => {
    const location = parseFileLocation(reference)
    const relPath = location.path
    if (location.line && /\.md$/i.test(relPath)) setMarkdownPreview(false)
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
          ? { path: relPath, content: result.content, truncated: result.truncated, ...location, revealKey: Date.now() }
          : { path: relPath, content: '（无法读取该文件）', truncated: false, ...location, revealKey: Date.now() }
      ])
    } else if (location.line) {
      setOpenFiles((files) => files.map((file) => file.path === relPath
        ? { ...file, line: location.line, column: location.column, revealKey: Date.now() }
        : file))
    }
    setMainTab(relPath)
  }

  useEffect(() => {
    localStorage.setItem('moonglass:viewer-word-wrap', String(wordWrap))
  }, [wordWrap])
  useEffect(() => {
    localStorage.setItem('moonglass:viewer-font-size', String(viewerFontSize))
  }, [viewerFontSize])
  useEffect(() => {
    if (mainTab === 'chat') return
    const timer = window.setInterval(() => { void refreshOpenFile(mainTab) }, 2000)
    return () => window.clearInterval(timer)
  }, [mainTab, refreshOpenFile])
  useEffect(() => {
    const listener = (event: Event): void => {
      const path = (event as CustomEvent<{ path?: string }>).detail?.path
      if (path) void openFile(path)
    }
    window.addEventListener('moonglass-open-project-file', listener)
    return () => window.removeEventListener('moonglass-open-project-file', listener)
  })

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

  const runManagedAgent = async (instruction: string): Promise<void> => {
    await sendAgentPrompt(
      `【MoonGlass 一键托管】\n${instruction}\n\n` +
      '托管规则：直接检查并修改实际项目文件，调用本阶段适用工具完成验证，所有结论必须引用真实证据。' +
      '不要等待人工确认；存在多个方案时优先采用明确标记的推荐方案，其次采用风险最低且可回退的方案，并在总结中记录选择。' +
      '不得伪造 EDA 结果，不得把估算称为签核。完成后列出修改文件、执行命令、结果和遗留风险。'
    )
    for (let round = 0; round < 6; round += 1) {
      const pending = pendingDecisionRequests()
      if (pending.length === 0) return
      const response = serializeDecisionResponses(pending.map((request) => {
        const recommended = request.options.filter((option) => option.recommended)
        const selected = recommended.length > 0 ? recommended : request.options.slice(0, 1)
        return {
          request,
          selectedIds: selected.map((option) => option.id),
          customText: '一键托管自动决策：采用推荐方案；无明确推荐时采用第一项，并要求保留可回退性。'
        }
      }))
      await sendAgentPrompt(response)
    }
    throw new Error('Agent 连续产生过多待确认项，已停止托管以防止决策循环')
  }

  const writeManagedReport = async (
    outcome: 'completed' | 'stopped' | 'failed',
    startedAt: string,
    steps: ManagedStep[],
    error?: string
  ): Promise<string> => {
    const finishedAt = new Date().toISOString()
    const latest = await window.moonglass.project.get(projectId)
    const stamp = finishedAt.replace(/[:.]/g, '-').slice(0, 19)
    const path = `docs/07_release/managed_run_${stamp}.md`
    const gates = latest ? PHASE_ORDER.flatMap((phase) => latest.phases[phase].gateCheckResults.map((result) =>
      `| ${PHASE_LABELS[phase]} | ${result.checkName} | ${result.passed ? '通过' : '失败'} | ${result.severity} | ${result.message.replace(/\r?\n/g, ' ')} |`
    )) : []
    const content = `# MoonGlass 一键托管报告\n\n` +
      `- 项目：${latest?.name ?? project?.name ?? projectId}\n` +
      `- 开始时间：${startedAt}\n- 结束时间：${finishedAt}\n` +
      `- 结果：${outcome === 'completed' ? '已完成' : outcome === 'stopped' ? '用户停止' : '执行失败'}\n` +
      `- 托管终点：${PHASE_LABELS[managedEndPhase]}\n` +
      `- 最终阶段：${latest ? PHASE_LABELS[latest.currentPhase] : '未知'}\n` +
      (error ? `- 停止原因：${error}\n` : '') +
      `\n## 阶段执行记录\n\n${steps.map((step) => `- [${step.status === 'completed' ? 'x' : ' '}] ${PHASE_LABELS[step.phase]}：${step.detail}`).join('\n')}\n` +
      `\n## 门禁与质量证据\n\n| 阶段 | 检查项 | 结果 | 级别 | 说明 |\n|---|---|---|---|---|\n${gates.join('\n') || '| - | 尚无门禁记录 | - | - | - |'}\n` +
      `\n## 自动决策策略\n\n托管期间优先采用 Agent 明确标记的推荐项；无推荐项时采用第一项并要求保持可回退。所有自动选择保留在 Agent 会话历史中。\n` +
      `\n## 遗留风险\n\n${outcome === 'completed' ? '请人工复核关键架构决策、第三方 IP 许可证，以及正式 PPA/CDC/STA 签核条件。' : `托管未完整结束，必须处理停止原因后再继续：${error ?? '用户主动停止'}。`}\n`
    await window.moonglass.fs.writeText(projectId, path, content)
    setTreeTick((tick) => tick + 1)
    setManagedReportPath(path)
    return path
  }

  const startManagedRun = async (): Promise<void> => {
    if (!project || managedRunning) return
    const startIndex = PHASE_ORDER.indexOf(project.currentPhase)
    const endIndex = PHASE_ORDER.indexOf(managedEndPhase)
    if (endIndex < startIndex) return
    managedStopRef.current = false
    setManagedDialogOpen(false)
    setManagedRunning(true)
    setManagedReportPath('')
    setMainTab('chat')
    const startedAt = new Date().toISOString()
    const steps: ManagedStep[] = []
    setManagedSteps([])
    let outcome: 'completed' | 'stopped' | 'failed' = 'completed'
    let failure = ''
    try {
      await ensureAgent(projectId)
      if (!useChatStore.getState().sessionInfo?.providersReady) throw new Error('模型会话未就绪，请先配置并测试模型服务')
      for (let index = startIndex; index <= endIndex; index += 1) {
        const phase = PHASE_ORDER[index]
        if (managedStopRef.current) throw new Error('用户停止托管')
        const step: ManagedStep = { phase, status: 'running', detail: 'Agent 正在执行阶段任务' }
        steps.push(step)
        setManagedSteps([...steps])

        let active = await window.moonglass.project.get(projectId)
        if (!active) throw new Error('项目不存在')
        if (active.currentPhase !== phase) {
          active = await window.moonglass.phase.enter(projectId, phase)
          if (!active) throw new Error(`无法进入 ${PHASE_LABELS[phase]}`)
          await ensureAgent(projectId)
        }
        await ensureAgent(projectId)
        if (active.phases[phase].changeNotice?.status === 'pending') {
          await runManagedAgent(buildChangeResponsePrompt(active, phase))
          await window.moonglass.phase.acknowledgeChange(projectId, phase, '一键托管已完成该阶段变更响应')
        }
        await runManagedAgent(MANAGED_PHASE_PROMPTS[phase])
        if (managedStopRef.current) throw new Error('用户停止托管')

        if (phase === 'SYNTH') {
          const completed = await window.moonglass.phase.completeProject(projectId)
          if (!completed) throw new Error('综合阶段无法完成项目收口')
          setProject(completed)
        } else {
          const next = PHASE_ORDER[index + 1]
          let advanced = false
          for (let attempt = 0; attempt < 3 && !advanced; attempt += 1) {
            const result = await window.moonglass.phase.advance(projectId, next)
            if (!result) throw new Error(`推进到 ${PHASE_LABELS[next]} 失败`)
            setProject(result.project)
            setGate(result.gate)
            if (!result.gate.blocked) {
              advanced = true
              break
            }
            const failed = result.gate.results.filter((item) => item.severity === 'error' && !item.passed)
            if (attempt === 2) throw new Error(`${PHASE_LABELS[phase]} 门禁重试后仍有 ${failed.length} 个阻断项`)
            await runManagedAgent(`修复以下门禁阻断项并重新执行相关检查：\n${failed.map((item) => `- ${item.checkName}：${item.message}`).join('\n')}`)
          }
        }
        step.status = 'completed'
        step.detail = '阶段任务及门禁已完成'
        setManagedSteps([...steps])
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      outcome = failure === '用户停止托管' ? 'stopped' : 'failed'
      const running = steps.findLast((step) => step.status === 'running')
      if (running) {
        running.status = 'failed'
        running.detail = failure
      }
      setManagedSteps([...steps])
    } finally {
      const path = await writeManagedReport(outcome, startedAt, steps, failure)
      appendLog(`${outcome === 'completed' ? '✅' : '⚠️'} 一键托管${outcome === 'completed' ? '完成' : '停止'}，报告：${path}`)
      setManagedRunning(false)
      await reload()
    }
  }

  const stopManagedRun = async (): Promise<void> => {
    managedStopRef.current = true
    if (useChatStore.getState().streaming) await abortAgent()
  }

  const createChangeRequest = async (): Promise<void> => {
    if (!project || !changeDescription.trim()) return
    const now = new Date().toISOString()
    const id = `CR-${now.replace(/\D/g, '').slice(0, 14)}`
    const labels = { requirement: '需求变更', specification: '规格变更', bug: '缺陷修复' } as const
    const path = `docs/01_project/change_requests/${id}.md`
    const content = `# ${id} ${labels[changeType]}\n\n- 创建时间：${now}\n- 影响起点：${PHASE_LABELS[changeSourcePhase]}\n- 状态：处理中\n\n## 变更说明\n\n${changeDescription.trim()}\n\n## 影响分析\n\n待 Agent 分析需求、架构、RTL、验证、QA 和综合影响。\n\n## 验证与关闭条件\n\n待补充对应回归、质量审查和综合证据。\n`
    const entered = await window.moonglass.phase.enter(projectId, changeSourcePhase)
    if (!entered) return
    await window.moonglass.fs.writeText(projectId, path, content)
    setProject(entered)
    setChangeDialogOpen(false)
    setChangeDescription('')
    setMainTab('chat')
    setTreeTick((tick) => tick + 1)
    await ensureAgent(projectId)
    await sendAgentPrompt(`处理变更单 ${path}。先完成影响分析并修改 ${PHASE_LABELS[changeSourcePhase]} 阶段相关文件；保留已有有效成果，更新追溯矩阵和变更记录。完成本阶段修改后，后续阶段将通过黄色感叹号和一键托管完成响应、回归与质量闭环。`)
    appendLog(`已创建${labels[changeType]} ${id}，进入 ${PHASE_LABELS[changeSourcePhase]}`)
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
      {managedDialogOpen && project && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-6">
          <section className="w-full max-w-lg rounded-md border border-zinc-300 bg-white shadow-2xl">
            <header className="border-b border-zinc-200 px-5 py-4">
              <h2 className="text-base font-semibold text-zinc-900">一键托管</h2>
              <p className="mt-1 text-xs leading-5 text-zinc-500">从当前阶段开始自动执行、修复门禁并推进。门禁重试失败时立即停止，不会强制越过。</p>
            </header>
            <div className="space-y-4 p-5">
              <label className="block text-xs font-medium text-zinc-700">托管完成至</label>
              <select value={managedEndPhase} onChange={(event) => setManagedEndPhase(event.target.value as Phase)} className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm">
                {PHASE_ORDER.slice(PHASE_ORDER.indexOf(project.currentPhase)).map((phase) => (
                  <option key={phase} value={phase}>{phase} · {PHASE_LABELS[phase]}</option>
                ))}
              </select>
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
                自动决策会优先选择推荐项并记录到报告。涉及正式签核、第三方许可证或不可逆操作时，托管结果仍需工程师复核。
              </div>
            </div>
            <footer className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3">
              <button onClick={() => setManagedDialogOpen(false)} className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600">取消</button>
              <button onClick={() => void startManagedRun()} className="rounded bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-500">开始托管</button>
            </footer>
          </section>
        </div>
      )}
      {changeDialogOpen && project && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-6">
          <section className="w-full max-w-xl rounded-md border border-zinc-300 bg-white shadow-2xl">
            <header className="border-b border-zinc-200 px-5 py-4">
              <h2 className="text-base font-semibold text-zinc-900">发起受控变更</h2>
              <p className="mt-1 text-xs text-zinc-500">保留已有成果，建立变更单，并从受影响的最早阶段开始处理。</p>
            </header>
            <div className="grid grid-cols-2 gap-4 p-5">
              <label className="text-xs font-medium text-zinc-700">变更类型
                <select value={changeType} onChange={(event) => setChangeType(event.target.value as typeof changeType)} className="mt-1 w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm">
                  <option value="requirement">需求变更</option><option value="specification">规格变更</option><option value="bug">第三方/测试缺陷</option>
                </select>
              </label>
              <label className="text-xs font-medium text-zinc-700">影响起点
                <select value={changeSourcePhase} onChange={(event) => setChangeSourcePhase(event.target.value as Phase)} className="mt-1 w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm">
                  {PHASE_ORDER.map((phase) => <option key={phase} value={phase}>{phase} · {PHASE_LABELS[phase]}</option>)}
                </select>
              </label>
              <label className="col-span-2 text-xs font-medium text-zinc-700">变更或缺陷说明
                <textarea value={changeDescription} onChange={(event) => setChangeDescription(event.target.value)} rows={5} placeholder="说明现象、期望行为、涉及接口、复现条件或新增规格..." className="mt-1 w-full resize-y rounded border border-zinc-300 bg-white px-3 py-2 text-sm" />
              </label>
            </div>
            <footer className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3">
              <button onClick={() => setChangeDialogOpen(false)} className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600">取消</button>
              <button disabled={!changeDescription.trim()} onClick={() => void createChangeRequest()} className="rounded bg-blue-600 px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50">创建并进入处理</button>
            </footer>
          </section>
        </div>
      )}
      {/* ======== 顶部：项目信息 + 阶段看板 ======== */}
      <header className="workspace-header relative z-30 shrink-0 overflow-visible border-b border-zinc-200 bg-white px-6 py-4">
        <div className="mb-3 flex items-center gap-3">
          <h1 className="text-lg font-bold text-zinc-900">{project.name}</h1>
          <span className="text-sm text-zinc-500">
            当前阶段：{project.currentPhase} · {PHASE_LABELS[project.currentPhase]}
          </span>
          {managedRunning ? (
            <button type="button" onClick={() => void stopManagedRun()} className="ml-auto flex items-center gap-1.5 rounded border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700">
              <Square size={12} /> 停止托管
            </button>
          ) : (
            <button type="button" onClick={() => { setManagedEndPhase('SYNTH'); setManagedDialogOpen(true) }} disabled={agentStreaming} className="ml-auto flex items-center gap-1.5 rounded border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50">
              <Bot size={14} /> 一键托管
            </button>
          )}
          <button type="button" onClick={() => setChangeDialogOpen(true)} disabled={managedRunning || agentStreaming} className="rounded border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50">
            发起变更
          </button>
          <button
            type="button"
            onClick={() => void handleGenerateDashboard()}
            disabled={generatingDashboard}
            className="rounded border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
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
        {(managedRunning || managedSteps.length > 0) && (
          <div className="mb-3 flex items-center gap-2 overflow-x-auto rounded border border-blue-200 bg-blue-50 px-3 py-2 text-xs">
            <Bot size={14} className="shrink-0 text-blue-600" />
            <span className="shrink-0 font-medium text-blue-800">{managedRunning ? '托管进行中' : '最近托管'}</span>
            {managedSteps.map((step) => (
              <span key={step.phase} className={`shrink-0 rounded px-2 py-1 ${step.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : step.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-white text-blue-700'}`} title={step.detail}>
                {PHASE_LABELS[step.phase]} {step.status === 'completed' ? '✓' : step.status === 'failed' ? '!' : '…'}
              </span>
            ))}
            {managedReportPath && <button onClick={() => void openFile(managedReportPath)} className="ml-auto shrink-0 text-blue-700 underline">查看托管报告</button>}
          </div>
        )}
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
                  <div className="mb-1 flex shrink-0 items-center justify-between gap-3 overflow-x-auto pb-1">
                    <div className="flex min-w-0 shrink items-center gap-2">
                      <span className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] ${
                        fileLanguage(activeFile.path) !== 'plaintext'
                          ? 'bg-blue-100 text-blue-700'
                          : 'bg-zinc-100 text-zinc-500'
                      }`}>
                        {fileLanguage(activeFile.path)}
                      </span>
                      <span className="max-w-80 truncate font-mono text-xs text-zinc-400" title={activeFile.path}>{activeFile.path}</span>
                      <span className="text-[11px] text-zinc-400">
                        {activeFile.content.split(/\r\n|\r|\n/).length} 行 · 只读
                      </span>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      {/\.md$/i.test(activeFile.path) && (
                        <button
                          onClick={() => setMarkdownPreview((value) => !value)}
                          className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100"
                        >
                          {markdownPreview ? '源码' : '预览'}
                        </button>
                      )}
                      <button
                        onClick={() => void refreshOpenFile(activeFile.path)}
                        className="flex h-6 w-6 items-center justify-center rounded border border-zinc-300 text-zinc-600 hover:bg-zinc-100"
                        title="重新加载文件"
                      ><RefreshCw size={12} /></button>
                      <button
                        onClick={() => setWordWrap((value) => !value)}
                        className={`rounded border px-2 py-0.5 text-xs ${wordWrap ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-zinc-300 text-zinc-600 hover:bg-zinc-100'}`}
                        title="切换自动换行"
                      >自动换行</button>
                      <button
                        onClick={() => setViewerFontSize((size) => Math.max(10, size - 1))}
                        className="flex h-6 w-6 items-center justify-center rounded border border-zinc-300 text-zinc-600 hover:bg-zinc-100"
                        title="缩小字体"
                      ><Minus size={12} /></button>
                      <span className="min-w-7 text-center text-[11px] leading-6 text-zinc-400">{viewerFontSize}</span>
                      <button
                        onClick={() => setViewerFontSize((size) => Math.min(24, size + 1))}
                        className="flex h-6 w-6 items-center justify-center rounded border border-zinc-300 text-zinc-600 hover:bg-zinc-100"
                        title="放大字体"
                      ><Plus size={12} /></button>
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
                  <div className="project-source min-h-0 flex-1 overflow-hidden rounded border border-zinc-200 bg-zinc-50">
                    {/\.md$/i.test(activeFile.path) && markdownPreview ? (
                      <MarkdownPreview content={activeFile.content} />
                    ) : (
                      <CodeViewer
                        path={activeFile.path}
                        content={activeFile.content}
                        line={activeFile.line}
                        column={activeFile.column}
                        revealKey={activeFile.revealKey}
                        wordWrap={wordWrap}
                        fontSize={viewerFontSize}
                      />
                    )}
                  </div>
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
        <span className="ml-auto">MoonGlass v0.5 · 六阶段 ASIC 开发链</span>
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
  line?: number
  column?: number
  revealKey?: number
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
            <div
              key={result.checkId}
              className="console-row"
              onDoubleClick={() => {
                const reference = extractFileReference(result.message)
                if (reference) onOpenFile(reference)
              }}
              title={extractFileReference(result.message) ? '双击打开问题文件并定位' : result.message}
            >
              <AlertTriangle size={14} className="shrink-0 text-red-500" />
              <strong className="shrink-0 text-xs text-zinc-700">{result.checkName}</strong>
              <span className="truncate text-xs text-zinc-500" title={result.message}>{result.message}</span>
              <span className="ml-auto shrink-0 text-[10px] text-zinc-400">门禁</span>
            </div>
          ))}
          {[...errorLogs, ...warningLogs].map((entry, index) => (
            <div
              key={`${entry}-${index}`}
              className="console-row"
              onDoubleClick={() => {
                const reference = extractFileReference(entry)
                if (reference) onOpenFile(reference)
              }}
              title={extractFileReference(entry) ? '双击打开问题文件并定位' : entry}
            >
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
