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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { APP_INFO } from '@shared/app-info'
import {
  AlertTriangle,
  ArrowRight,
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
  Search,
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
import { extractFileReference } from '@shared/file-reference'
import { PhaseBoard, type GatePanelData } from '../components/PhaseBoard'
import { ChatPanel, SessionTabs } from '../components/ChatPanel'
import { FileTree } from '../components/FileTree'
import { CodeViewer, fileLanguage } from '../components/CodeViewer'
import { MarkdownPreview } from '../components/MarkdownPreview'
import { useChatStore } from '../store/chatStore'
import { deriveVerificationActions, deriveVerificationSteps, type GuidanceState } from '../verification-guidance'
import { useTranslation, phaseLabel, type MessageKey } from '../i18n'

const BOTTOM_TABS = [
  { id: 'problems', labelKey: 'workspace.tabs.problems', icon: AlertTriangle },
  { id: 'runs', labelKey: 'workspace.tabs.runs', icon: Play },
  { id: 'verification', labelKey: 'workspace.tabs.verification', icon: FlaskConical },
  { id: 'synthesis', labelKey: 'workspace.tabs.synthesis', icon: Box },
  { id: 'artifacts', labelKey: 'workspace.tabs.artifacts', icon: FileOutput }
] as const satisfies ReadonlyArray<{ id: string; labelKey: MessageKey; icon: typeof AlertTriangle }>
type BottomTab = (typeof BOTTOM_TABS)[number]['id']
const MIN_SIDEBAR = 140
const MAX_SIDEBAR = 400
const MIN_BOTTOM = 80
const MAX_BOTTOM = 400

interface ManagedStep {
  phase: Phase
  status: 'running' | 'completed' | 'completed_with_risk' | 'failed'
  detail: string
}

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, milliseconds))
const isManagedPause = (message: string): boolean => /用户停止托管|托管已暂停|L3\/L4 高影响/.test(message)

function VerifStatusBar({ projectId, agentStreaming, onAction, onPlanEnv, onBasic, onCorner, onSignoff }: { projectId: string; agentStreaming: boolean; onAction: (prompt: string) => void; onPlanEnv: () => void; onBasic: () => void; onCorner: () => void; onSignoff: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [state, setState] = useState<GuidanceState | null>(null)
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    let data: GuidanceState | null = null
    try {
      data = await window.moonglass.fs.readJson(projectId, 'verification/intelligence/verification-posture.json') as GuidanceState | null
      // posture 是机器可读快照；被 Agent 覆盖成摘要时会缺失 verificationIntents，回退到完整 state.json
      if (data && !Array.isArray(data.verificationIntents)) data = null
    } catch { data = null }
    if (!data) {
      try { data = await window.moonglass.fs.readJson(projectId, 'verification/intelligence/verification-state.json') as GuidanceState | null } catch { data = null }
    }
    setState(data)
    setLoading(false)
  }, [projectId])
  useEffect(() => { void load() }, [load])
  const steps = useMemo(() => deriveVerificationSteps(state), [state])
  const actions = useMemo(() => state ? deriveVerificationActions(state) : [], [state])
  const primary = actions[0]
  const current = steps.find((step) => step.status === 'blocked') ?? steps.find((step) => step.status === 'running') ?? steps.at(-1)!
  return <div className="mt-3 border-t border-zinc-100 pt-3">
    <div className="flex items-center gap-3">
      <span className="shrink-0 text-xs font-medium text-zinc-500">{t('workspace.verifBar.statusLabel')}</span>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">{steps.map((step, index) => <div key={step.id} className="flex min-w-0 items-center gap-1.5"><span title={`${step.label}：${step.detail}`} className={`flex min-w-0 items-center gap-1 rounded px-2 py-1 text-[10px] ${step.status === 'completed' ? 'bg-emerald-50 text-emerald-700' : step.status === 'blocked' ? 'bg-red-50 text-red-700' : step.status === 'running' ? 'bg-amber-50 text-amber-700' : 'bg-zinc-50 text-zinc-400'}`}><span className={`h-1.5 w-1.5 shrink-0 rounded-full ${step.status === 'completed' ? 'bg-emerald-500' : step.status === 'blocked' ? 'bg-red-500' : step.status === 'running' ? 'bg-amber-500' : 'bg-zinc-300'}`} /><span className="truncate">{step.label}</span></span>{index < steps.length - 1 && <ArrowRight size={10} className="shrink-0 text-zinc-300" />}</div>)}</div>
      <button onClick={() => void load()} disabled={loading} className="rounded border border-zinc-200 p-1.5 text-zinc-400 hover:text-zinc-700" title={t('workspace.verifBar.refresh')}><RefreshCw size={12} className={loading ? 'animate-spin' : ''} /></button>
    </div>
    <div className="mt-2 flex items-center gap-3 bg-zinc-50 px-3 py-2">
      <div className="min-w-0 flex-1"><span className={`text-xs font-medium ${current.status === 'blocked' ? 'text-red-700' : 'text-zinc-700'}`}>{t('workspace.verifBar.current', { label: current.label })}</span><span className="ml-2 text-xs text-zinc-500">{current.detail}</span><span className="ml-3 text-xs text-zinc-400">{t('workspace.verifBar.next', { action: primary?.title ?? t('workspace.verifBar.defaultNextAction') })}</span></div>
      {primary && <button disabled={agentStreaming} onClick={() => onAction(primary.prompt)} className="shrink-0 rounded bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 disabled:opacity-50"><Play size={12} className="mr-1 inline" />{primary.title}</button>}
      <div className="flex shrink-0 overflow-hidden rounded border border-zinc-200 bg-white">
        <button onClick={onPlanEnv} disabled={agentStreaming} title={t('workspace.verifBar.planEnvTitle')} className="border-r border-zinc-200 px-2.5 py-1.5 text-xs text-blue-700 hover:bg-blue-50 disabled:opacity-50">{t('workspace.verifBar.planEnv')}</button>
        <button onClick={onBasic} disabled={agentStreaming} title={t('workspace.verifBar.basicTitle')} className="border-r border-zinc-200 px-2.5 py-1.5 text-xs text-amber-700 hover:bg-amber-50 disabled:opacity-50">{t('workspace.verifBar.basic')}</button>
        <button onClick={onCorner} disabled={agentStreaming} title={t('workspace.verifBar.cornerTitle')} className="border-r border-zinc-200 px-2.5 py-1.5 text-xs text-violet-700 hover:bg-violet-50 disabled:opacity-50">{t('workspace.verifBar.corner')}</button>
        <button onClick={onSignoff} disabled={agentStreaming} title={t('workspace.verifBar.signoffTitle')} className="px-2.5 py-1.5 text-xs text-emerald-700 hover:bg-emerald-50 disabled:opacity-50">{t('workspace.verifBar.signoff')}</button>
      </div>
    </div>
  </div>
}

// 注意：VERIF 不在此表——VERIF 托管走"主会话规划 → 主进程批级派发 → 主会话终审"
// 三段式（MANAGED_VERIF_PLANNING_PROMPT / runVerifBatches / MANAGED_VERIF_REVIEW_PROMPT）
const MANAGED_PHASE_PROMPTS: Record<Exclude<Phase, 'VERIF'>, string> = {
  REQ_SPEC: '完成需求-规格定义：审查项目目标，补齐产品需求、模块规格、接口规格和需求-规格追溯矩阵，消除占位内容并执行文档检查。',
  ARCH: '完成架构设计：根据已批准需求规格更新总体架构、模块划分、接口、时钟复位和寄存器设计，并检查需求追溯。简单单模块/单时钟复位设计可将说明合并在 architecture.md；仅在复杂微架构、多时钟、多复位或 CDC/RDC 场景单独创建 microarchitecture.md、clock_reset.md。',
  RTL: '完成 RTL 开发：依据架构实现或修复 RTL，维护 design.json/filelist，运行 Lint、可综合性和必要的 CDC 检查，修复全部 Error。',
  QA: '完成质量检查：执行变更审查、代码 Review、检查清单、Lint/CDC/回归证据核对，修复阻断问题并形成 QA 报告。',
  SYNTH: '完成综合评估：检查约束，生成 SDC，执行逻辑综合，汇总网表、单元、面积和时序估算及警告；明确区分估算与正式签核。'
}

// VERIF 托管（上下文治理第 3 批）：主会话只做规划与最终审查；
// 批次场景由主进程经 runVerifBatches 逐批 spawn 平行会话执行，完成判定绑定工具登记证据。
const MANAGED_VERIF_PLANNING_PROMPT =
  '完成验证规划与环境准备：更新验证计划和覆盖率计划，搭建或修复验证环境并跑通一次基础回归确认环境可用；' +
  '调用 build_verification_intelligence 生成风险候选与结构事实，圈定真实验证点并用 register_verification_intents 登记（锚定真实 riskIds/requirementIds/rtlSignals）。' +
  '场景批次执行由 MoonGlass 主进程编排派发到独立批次会话，本会话只做规划，不要逐批执行场景回归。'
const MANAGED_VERIF_REVIEW_PROMPT =
  'VERIF 批次执行已结束。读取 verification/intelligence/execution-summary.json 核对批次结果与证据增量；' +
  '调用 review_verification_scenarios 与 review_verification_evidence 独立审查原始测试、日志、result.json 和覆盖率证据，存在阻断项时继续修复并回归；' +
  '最后用实际机器可读产物和原始证据更新 docs/04_verification/ 文档、需求追溯和 docs/06_validation/ 验证报告。'

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
  const { t } = useTranslation()
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
  const openingFilesRef = useRef(new Set<string>())
  const [changeDialogOpen, setChangeDialogOpen] = useState(false)
  const [changeType, setChangeType] = useState<'requirement' | 'specification' | 'bug'>('bug')
  const [changeSourcePhase, setChangeSourcePhase] = useState<Phase>('RTL')
  const [changeDescription, setChangeDescription] = useState('')
  const [wordWrap, setWordWrap] = useState(() => localStorage.getItem('moonglass:viewer-word-wrap') === 'true')
  const [findRequestKey, setFindRequestKey] = useState(0)
  const [viewerFontSize, setViewerFontSize] = useState(() => Number(localStorage.getItem('moonglass:viewer-font-size')) || 13)
  const [markdownPreview, setMarkdownPreview] = useState(true)
  const agentStreaming = useChatStore((s) => s.streaming)
  // 切走后仍在后台执行的阶段（阶段栏据此显示运行标记）
  const backgroundRunningPhases = useChatStore((s) => s.sessionInfo?.backgroundRunningPhases)
  const sendAgentPrompt = useChatStore((s) => s.sendAndWait)
  const ensureAgent = useChatStore((s) => s.ensure)
  const abortAgent = useChatStore((s) => s.abort)
  const startAgentTask = useChatStore((s) => s.startTask)
  const clearAgentAfterPhasePurge = useChatStore((s) => s.clearAfterPhasePurge)

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
    const workspace = project?.workspacePath?.replace(/\\/g, '/').replace(/\/$/, '')
    const relPath = workspace && location.path.toLowerCase().startsWith(`${workspace.toLowerCase()}/`)
      ? location.path.slice(workspace.length + 1)
      : location.path
    if (location.line && /\.md$/i.test(relPath)) setMarkdownPreview(false)
    if (/\.(vcd|fst)$/i.test(relPath)) {
      try {
        const result = await window.moonglass.eda.openWaveform(projectId, relPath)
        const text = result.ok
          ? t('workspace.log.waveformOpened', { path: relPath })
          : t('workspace.log.waveformOpenFailed', { error: result.error ?? relPath })
        appendLog(text)
        setFileNotice({ ok: result.ok, text })
        window.setTimeout(() => setFileNotice(null), 5000)
      } catch (error) {
        const text = t('workspace.log.waveformOpenFailed', { error: error instanceof Error ? error.message : String(error) })
        appendLog(text)
        setFileNotice({ ok: false, text })
        window.setTimeout(() => setFileNotice(null), 5000)
      }
      return
    }
    if (shouldOpenExternally(relPath)) {
      const opened = await window.moonglass.fs.openExternal(projectId, relPath)
      if (!opened) appendLog(t('workspace.log.cannotOpenExternal', { path: relPath }))
      else { appendLog(t('workspace.log.openedExternal', { path: relPath })); return }
    }
    if (!openFiles.some((f) => f.path === relPath)) {
      if (openingFilesRef.current.has(relPath)) return
      openingFilesRef.current.add(relPath)
      try {
        const result = await window.moonglass.fs.readFile(projectId, relPath)
        setOpenFiles((files) => files.some((file) => file.path === relPath) ? files : [
          ...files,
          result
            ? { path: relPath, content: result.content, truncated: result.truncated, line: location.line, column: location.column, revealKey: Date.now() }
            : { path: relPath, content: t('workspace.viewer.unreadable'), truncated: false, line: location.line, column: location.column, revealKey: Date.now() }
        ])
      } catch (error) {
        const text = t('workspace.log.fileOpenFailed', { path: relPath, error: error instanceof Error ? error.message : String(error) })
        appendLog(text)
        setFileNotice({ ok: false, text })
        window.setTimeout(() => setFileNotice(null), 5000)
        return
      } finally {
        openingFilesRef.current.delete(relPath)
      }
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
  const requestFileFind = useCallback((): void => {
    if (mainTab === 'chat') return
    if (/\.md$/i.test(mainTab) && markdownPreview) {
      setMarkdownPreview(false)
      window.setTimeout(() => setFindRequestKey((key) => key + 1), 0)
      return
    }
    setFindRequestKey((key) => key + 1)
  }, [mainTab, markdownPreview])
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (mainTab === 'chat' || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'f') return
      event.preventDefault()
      event.stopPropagation()
      requestFileFind()
    }
    window.addEventListener('keydown', listener, true)
    return () => window.removeEventListener('keydown', listener, true)
  }, [mainTab, requestFileFind])
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
        const confirmed = window.confirm(t('workspace.confirm.gateBlocked', { count: failed.length, phase: to }))
        if (!confirmed) return
        appendLog(t('workspace.log.forceAdvanced', { phase: to }))
        const forced = await window.moonglass.phase.advance(projectId, to, { force: true })
        if (!forced) return
        setProject(forced.project)
        setGate(forced.gate)
      }
    } catch (error) {
      appendLog(t('workspace.log.advanceFailed', { error: error instanceof Error ? error.message : String(error) }))
      setGate({ blocked: true, results: [] })
    }
  }

  const handleRollback = async (to: Phase): Promise<void> => {
    if (!window.confirm(t('workspace.confirm.rollback', { phase: to }))) return
    setProject(await window.moonglass.phase.rollback(projectId, to))
    setGate(null)
  }

  /** 仅重新运行门禁检查，不推进阶段 */
  const handleRecheck = async (): Promise<void> => {
    if (!project) return
    const nextPhase = PHASE_ORDER[PHASE_ORDER.indexOf(project.currentPhase) + 1]
    if (!nextPhase) return
    appendLog(t('workspace.log.rechecking'))
    try {
      const results = await window.moonglass.phase.gateCheck(projectId, nextPhase)
      if (results) {
        const blocked = results.some((r) => r.severity === 'error' && !r.passed)
        setGate({ blocked, results })
        appendLog(blocked ? t('workspace.log.gateFailed') : t('workspace.log.gateCheckDone'))
      }
    } catch (err) {
      appendLog(t('workspace.log.gateCheckFailed', { error: err instanceof Error ? err.message : String(err) }))
    }
  }

  const appendLog = (msg: string): void => {
    setVerifLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`])
  }

  const handleEnterPhase = async (to: Phase): Promise<void> => {
    if (!project || project.currentPhase === to) return
    // 切换阶段不再中断正在运行的 Agent（转后台续跑）；托管中仍需确认，
    // 因为托管流程依赖阶段推进顺序，手动切换会打乱编排
    if (managedRunning) {
      if (!window.confirm(t('workspace.confirm.enterDuringManaged'))) return
    }
    try {
      const entered = await window.moonglass.phase.enter(projectId, to)
      if (entered) {
        setProject(entered)
        setGate(null)
        appendLog(t('workspace.log.enteredPhase', { phase: phaseLabel(to) }))
      }
    } catch (error) {
      appendLog(t('workspace.log.enterPhaseFailed', { error: error instanceof Error ? error.message : String(error) }))
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
      appendLog(t('workspace.log.respondChangeStart', { phase: phaseLabel(targetPhase) }))
      await sendAgentPrompt(buildChangeResponsePrompt(activeProject, targetPhase))
      const acknowledged = await window.moonglass.phase.acknowledgeChange(
        projectId,
        targetPhase,
        `已完成 ${PHASE_LABELS[targetPhase]} 的变更响应并提交 Agent 处理结果`
      )
      if (acknowledged) {
        setProject(acknowledged)
        appendLog(t('workspace.log.respondChangeDone', { phase: phaseLabel(targetPhase) }))
      }
    } catch (error) {
      appendLog(t('workspace.log.respondChangeFailed', { error: error instanceof Error ? error.message : String(error) }))
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
    appendLog(t('workspace.log.gateIssuesSent', { count: results.length }))
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
      appendLog(t('workspace.log.gateFixSendFailed', { error: error instanceof Error ? error.message : String(error) }))
    }
  }

  // ---- 验证操作（波段化 W0-W3，与态势页波段进度一一对应） ----
  const handlePlanEnv = async (): Promise<void> => {
    appendLog(t('workspace.log.planEnvStart'))
    try {
      await sendAgentPrompt(
        '请完成验证规划与环境搭建。停止边界是“验证点已登记、环境可编译、冒烟通过”，不要执行基础功能批次、增补验证或签核：\n' +
        '1. 使用 verification-planning 技能校验 docs/04_verification/ 三份基线计划与六份 AIGV 文档\n' +
        '2. 用 collect_rtl_files 读取 rtl/design.json 与 filelist.f，确认 DUT、topModule 和真实 RTL 范围\n' +
        '3. 调用 build_verification_intelligence 生成风险候选、结构事实与规格映射矩阵；穷举候选只是参考，不是任务清单\n' +
        '4. 阅读 risk-register.json 与 structural-model.json 并结合规格语义，圈定 5~10 个真实验证点（点名具体信号、失效反例、判定标准，声明 wave/topic 标签），调用 register_verification_intents 登记；被 REJECTED 的锚点必须修正后重登，不得绕过；Spec Gap 未澄清时标记 BLOCKED_BY_SPEC，不得自行猜测\n' +
        '5. 审查 module-verification-strategy.json 并按分层搭建验证环境；优先复用 IP 库 VIP/BFM；定向测试与 SCN-ID 绑定（testcase 命名含 scn_<8位hex>），scenario_hits.json 由 run_simulation 自动登记，禁止手写\n' +
        '6. 冒烟验收（W0）：reset、接口连通、一个正常事务经 run_simulation 真实执行通过（环境自检不绑 scenarioIds）；冒烟不过则环境不算就绪\n' +
        '7. 完成后列出登记的验证点、模块分层、环境入口和冒烟结果，然后停止'
      )
      appendLog(t('workspace.log.planEnvDone'))
    } catch (err) {
      appendLog(t('workspace.log.commandSendFailed', { error: err instanceof Error ? err.message : String(err) }))
    }
  }

  const handleResetPhase = async (phase: Phase, mode: 'archive' | 'purge'): Promise<void> => {
    try {
      const preview = await window.moonglass.phase.previewReset(projectId, phase, mode)
      const pathList = preview.paths.length > 0 ? preview.paths.map((path) => `  - ${path}`).join('\n') : t('workspace.confirm.resetNoArtifacts')
      const sizeMb = (preview.totalBytes / 1024 / 1024).toFixed(2)
      const action = mode === 'archive' ? t('workspace.confirm.resetArchive') : t('workspace.confirm.resetPurge')
      const confirmed = window.confirm(t('workspace.confirm.resetPhase', {
        action,
        phase: phaseLabel(phase),
        count: preview.fileCount,
        size: sizeMb,
        paths: pathList,
        purgeNote: mode === 'purge' ? t('workspace.confirm.resetPurgeNote') : ''
      }))
      if (!confirmed) return
      if (mode === 'purge' && !window.confirm(t('workspace.confirm.resetPurgeConfirm'))) return
      const result = await window.moonglass.phase.reset(projectId, phase, mode)
      setProject(result.project)
      setGate(null)
      setTreeTick((tick) => tick + 1)
      setMainTab('chat')
      if (mode === 'purge') clearAgentAfterPhasePurge()
      appendLog(
        mode === 'archive'
          ? t('workspace.log.archived', { phase: phaseLabel(phase), count: result.fileCount, path: result.archivePath ?? '' })
          : t('workspace.log.purged', { phase: phaseLabel(phase), count: result.fileCount })
      )
    } catch (error) {
      appendLog(t('workspace.log.phaseResetFailed', { error: error instanceof Error ? error.message : String(error) }))
    }
  }

  const handleBasicValidation = async (): Promise<void> => {
    appendLog(t('workspace.log.basicStart'))
    try {
      await sendAgentPrompt(
        '请完成 W1 基础功能验证：目标是规格映射矩阵中每条可验证条款（simulation/static 通道）都有 happy path 证据。停止边界是“条款全部有执行证据或明确缺口记录”，不要做增补验证（W2）或签核（W3）：\n' +
        '1. 读取 execution-summary.json 的 specMapping；引擎已为未覆盖条款派生 CLAUSE_DERIVED 候选，逐条确认，或用 register_verification_intents 补充更准确的验证点\n' +
        '2. 用 select_next_verification_batch 按聚类选批；同组场景一次 authoring 多条 testcase，run_simulation(scenarioIds=[...]) 一次绑定登记，scenario_hits 与态势由工具自动更新\n' +
        '3. 失败时按 diagnostic-control 提升诊断等级，确认根因后调用 record_root_cause；L3/L4 影响必须发起用户决策\n' +
        '4. 完成后报告条款覆盖（coveredClause/clauseTotal）与仍未闭合条款清单，然后停止'
      )
      appendLog(t('workspace.log.basicDone'))
    } catch (err) {
      appendLog(t('workspace.log.commandSendFailed', { error: err instanceof Error ? err.message : String(err) }))
    }
  }

  const handleCornerWaves = async (): Promise<void> => {
    appendLog(t('workspace.log.cornerStart'))
    try {
      await sendAgentPrompt(
        '请完成 W2 增补验证：按主题波执行 corner 场景。停止边界是“各主题波闭环或探索饱和”，不要进入签核（W3）：\n' +
        '1. 读取 execution-summary.json 的 waveProgress W2 主题列表（错误注入/边界/并发碰撞/性能等），逐主题推进\n' +
        '2. 每个主题用 select_next_verification_batch 选聚类组（同模块同 Oracle 域），组内一次 authoring 多条 testcase，run_simulation(scenarioIds=[...]) 一次绑定登记\n' +
        '3. 执行后参考再聚类建议（reclusterSuggestions）调整分组；formal-candidate 用 run_formal_verification 补强（BMC PASS 不算证明）\n' +
        '4. 未覆盖项按 C1-C6 分类处置；探索连续无语义新增即饱和收手并说明\n' +
        '5. 执行派生状态由工具证据派生，record_scenario_adjudication 仅用于规格澄清/豁免（WAIVED 需已有具名审批）；失败根因确认后调用 record_root_cause\n' +
        '6. 完成后报告各主题波闭环情况与残余风险，然后停止'
      )
      appendLog(t('workspace.log.cornerDone'))
    } catch (err) {
      appendLog(t('workspace.log.commandSendFailed', { error: err instanceof Error ? err.message : String(err) }))
    }
  }

  const handleSignoff = async (): Promise<void> => {
    appendLog(t('workspace.log.signoffStart'))
    try {
      await sendAgentPrompt(
        '请完成 W3 签核。停止边界是“签核包生成且独立证据审查有结论”：\n' +
        '1. 运行覆盖率签核回归（Windows 用 run_simulation mode="cpp" 采集行/条件/翻转/FSM 覆盖率），确认达标或把缺口按 C1-C6 分类记录\n' +
        '2. 完成 required Formal 义务；工具限制记入残余风险，不得伪称失败也不得把有限深度 BMC 说成证明\n' +
        '3. 核对 Multi-Oracle 冲突与关键场景的独立判定域覆盖；Mutation survivor 未经批准默认阻断\n' +
        '4. 残余风险逐项处理：优先用证据关闭，确需豁免的等待用户在 signoff-approvals.json 中具名审批，Agent 不得代替用户写审批\n' +
        '5. 最后调用 review_verification_scenarios 与 review_verification_evidence 独立审查原始证据；输出签核结论（READY_FOR_HUMAN_SIGNOFF / CONDITIONALLY_READY / NOT_READY）、证据包路径与遗留项，然后停止'
      )
      appendLog(t('workspace.log.signoffDone'))
    } catch (err) {
      appendLog(t('workspace.log.commandSendFailed', { error: err instanceof Error ? err.message : String(err) }))
    }
  }

  const handleFastTrackSynthesis = async (): Promise<void> => {
    const confirmed = window.confirm(t('workspace.confirm.fastTrack'))
    if (!confirmed) return
    const updated = await window.moonglass.phase.fastTrackSynthesis(projectId)
    if (!updated) return
    setProject(updated)
    setGate(null)
  }

  const handleCompleteProject = async (): Promise<void> => {
    if (!window.confirm(t('workspace.confirm.completeProject'))) return
    const updated = await window.moonglass.phase.completeProject(projectId)
    if (updated) setProject(updated)
  }

  const handleGenerateDashboard = async (): Promise<void> => {
    setGeneratingDashboard(true)
    try {
      const result = await window.moonglass.project.generateDashboard(projectId)
      appendLog(t('workspace.log.dashboardGenerated', { path: result.path }))
      if (!result.opened) appendLog(t('workspace.log.dashboardNotOpened'))
      setTreeTick((tick) => tick + 1)
    } catch (error) {
      appendLog(t('workspace.log.dashboardFailed', { error: error instanceof Error ? error.message : String(error) }))
    } finally {
      setGeneratingDashboard(false)
    }
  }

  const handleVerificationGuidanceAction = async (prompt: string): Promise<void> => {
    setMainTab('chat')
    appendLog(t('workspace.log.guidanceActionSent'))
    try {
      await sendAgentPrompt(prompt)
      appendLog(t('workspace.log.guidanceActionDone'))
    } catch (error) {
      appendLog(t('workspace.log.guidanceActionFailed', { error: error instanceof Error ? error.message : String(error) }))
    }
  }

  const runManagedAgent = async (instruction: string): Promise<void> => {
    const prompt = `【MoonGlass 一键托管】\n${instruction}\n\n` +
      '托管规则：直接检查并修改实际项目文件，调用本阶段适用工具完成验证，所有结论必须引用真实证据。' +
      '不要等待人工确认；存在多个方案时优先采用明确标记的推荐方案，其次采用风险最低且可回退的方案，并在总结中记录选择。' +
      'RTL 修复按 L1-L4 分级：L1/L2 可直接修改并自动完成定向复现、受影响回归、全量回归和独立证据 Review；只有 L3 架构影响或 L4 规格影响才暂停确认，并将决策标题以 [L3] 或 [L4] 开头。' +
      '不得删除失败用例、削弱 Checker/Assertion/覆盖率目标、扩大无关项范围，或无规格依据修改测试预期。不得伪造 EDA 结果，不得把估算称为签核。完成后列出修改文件、影响等级、执行命令、结果和遗留风险。'
    let lastError = ''
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try { await sendAgentPrompt(prompt); lastError = ''; break } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
        if (isManagedPause(lastError) || managedStopRef.current) throw error
        appendLog(t('workspace.log.managedRetry', { attempt, error: lastError }))
        if (attempt < 3) await wait(attempt * 1500)
      }
    }
    if (lastError) throw new Error(`Agent 重试后仍失败：${lastError}`)
    for (let round = 0; round < 6; round += 1) {
      const pending = pendingDecisionRequests()
      if (pending.length === 0) return
      const highImpact = pending.filter((request) => /\[L[34]\]|架构影响|规格影响/.test(`${request.title} ${request.prompt ?? ''}`))
      if (highImpact.length > 0) throw new Error(`托管已暂停：存在 ${highImpact.length} 个 L3/L4 高影响决策等待用户裁决`)
      const response = serializeDecisionResponses(pending.map((request) => {
        const recommended = request.options.filter((option) => option.recommended)
        const selected = recommended.length > 0 ? recommended : request.options.slice(0, 1)
        return {
          request,
          selectedIds: selected.map((option) => option.id),
          customText: '一键托管自动决策：采用推荐方案；无明确推荐时采用第一项，并要求保留可回退性。'
        }
      }))
      let sent = false
      for (let attempt = 1; attempt <= 3 && !sent; attempt += 1) {
        try { await sendAgentPrompt(response); sent = true } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          appendLog(t('workspace.log.managedDecisionSendFailed', { attempt, error: message }))
          if (attempt < 3) await wait(attempt * 1000)
          else throw error
        }
      }
    }
    throw new Error('Agent 连续产生过多待确认项，已停止托管以防止决策循环')
  }

  const writeManagedReport = async (
    outcome: 'completed' | 'completed_with_risk' | 'paused' | 'stopped' | 'failed',
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
      `- 结果：${outcome === 'completed' ? '完整通过' : outcome === 'completed_with_risk' ? '带遗留风险完成（未签核）' : outcome === 'paused' ? '等待高影响决策' : outcome === 'stopped' ? '用户停止' : '执行失败'}\n` +
      `- 托管终点：${PHASE_LABELS[managedEndPhase]}\n` +
      `- 最终阶段：${latest ? PHASE_LABELS[latest.currentPhase] : '未知'}\n` +
      (error ? `- 停止原因：${error}\n` : '') +
      `\n## 阶段执行记录\n\n${steps.map((step) => `- [${step.status === 'completed' ? 'x' : ' '}] ${PHASE_LABELS[step.phase]}：${step.detail}`).join('\n')}\n` +
      `\n## 门禁与质量证据\n\n| 阶段 | 检查项 | 结果 | 级别 | 说明 |\n|---|---|---|---|---|\n${gates.join('\n') || '| - | 尚无门禁记录 | - | - | - |'}\n` +
      `\n## 自动决策与 RTL 修复策略\n\n托管期间优先采用 Agent 明确标记的推荐项；无推荐项时采用第一项并要求保持可回退。L1/L2 RTL 修复允许自动闭环；L3 架构影响和 L4 规格影响必须暂停等待用户裁决。所有自动选择、RTL 修改、影响等级和证据保留在 Agent 会话历史中。\n` +
      `普通 Agent/工具异常会自动重试；所有阶段的门禁在多轮自动修复后仍失败时，作为未签核风险保留并继续推进。只有用户停止、模型不可用或 L3/L4 高影响决策会暂停流程。\n` +
      `\n## 遗留风险\n\n${outcome === 'completed' ? '请人工复核关键架构决策、第三方 IP 许可证，以及正式 PPA/CDC/STA 签核条件。' : outcome === 'completed_with_risk' ? '流程已运行到目标阶段，但存在上表所列失败门禁或工具异常；本结果不得作为签核。' : `托管未完整结束，必须处理停止原因后再继续：${error ?? '用户主动停止'}。`}\n`
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
    let outcome: 'completed' | 'completed_with_risk' | 'paused' | 'stopped' | 'failed' = 'completed'
    let failure = ''
    let totalRisks = 0
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
        // M1 托管自动切换（设计文档 §3.1 托管模式）：每个阶段的托管运行在独立
        // 任务会话中执行（零历史继承，血缘指向上一会话），不污染阶段主会话；
        // 触发点复用现有按阶段触发点，不新造交付物检测逻辑。失败时沿用当前会话继续。
        try {
          await startAgentTask(`一键托管 ${phase} 阶段`)
        } catch (error) {
          appendLog(t('workspace.log.managedTaskSessionFailed', { error: error instanceof Error ? error.message : String(error) }))
        }
        if (active.phases[phase].changeNotice?.status === 'pending') {
          try {
            await runManagedAgent(buildChangeResponsePrompt(active, phase))
            await window.moonglass.phase.acknowledgeChange(projectId, phase, '一键托管已完成该阶段变更响应')
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (isManagedPause(message)) throw error
            totalRisks += 1; step.detail = `变更响应异常已记录：${message}`
            appendLog(t('workspace.log.managedChangeFailed', { phase: phaseLabel(phase), error: message }))
          }
        }
        try {
          if (phase === 'VERIF') {
            // 第 3 批：VERIF 风险闭环改为“主会话规划 → 主进程逐批 spawn 批次会话执行 → 主会话最终审查”
            await runManagedAgent(MANAGED_VERIF_PLANNING_PROMPT)
            if (managedStopRef.current) throw new Error('用户停止托管')
            const loop = await window.moonglass.agent.runVerifBatches(projectId)
            appendLog(t('workspace.log.managedVerifBatches', { count: loop.batches.length, stoppedBy: loop.stoppedBy, message: loop.message }))
            if (loop.stoppedBy !== 'exhausted') {
              totalRisks += 1
              step.detail = `VERIF 批次编排中止（${loop.stoppedBy}）：${loop.message}`
            }
            if (managedStopRef.current) throw new Error('用户停止托管')
            await runManagedAgent(MANAGED_VERIF_REVIEW_PROMPT)
          } else {
            await runManagedAgent(MANAGED_PHASE_PROMPTS[phase])
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (isManagedPause(message)) throw error
          totalRisks += 1; step.detail = `阶段 Agent 异常已记录：${message}`
          appendLog(t('workspace.log.managedAgentFailed', { phase: phaseLabel(phase), error: message }))
        }
        if (managedStopRef.current) throw new Error('用户停止托管')

        if (phase === 'SYNTH') {
          const completed = await window.moonglass.phase.completeProject(projectId)
          if (completed) setProject(completed)
          else { totalRisks += 1; step.detail = '综合阶段未能完成项目收口，已作为遗留风险记录' }
        } else {
          const next = PHASE_ORDER[index + 1]
          let advanced = false
          let carriedGateIssues = 0
          for (let attempt = 0; attempt < 4 && !advanced; attempt += 1) {
            const result = await window.moonglass.phase.advance(projectId, next)
            if (!result) throw new Error(`推进到 ${PHASE_LABELS[next]} 失败`)
            setProject(result.project)
            setGate(result.gate)
            if (!result.gate.blocked) {
              advanced = true
              break
            }
            const failed = result.gate.results.filter((item) => item.severity === 'error' && !item.passed)
            if (attempt === 3) {
              const forced = await window.moonglass.phase.advance(projectId, next, { force: true })
              if (!forced) throw new Error(`无法带遗留项推进到 ${PHASE_LABELS[next]}`)
              carriedGateIssues = failed.length
              totalRisks += failed.length
              setProject(forced.project)
              setGate(forced.gate)
              appendLog(t('workspace.log.managedGateCarried', { phase: phaseLabel(phase), count: failed.length }))
              advanced = true
              break
            }
            try {
              await runManagedAgent(`这是第 ${attempt + 1}/3 轮门禁恢复。分析根因，采用与上一轮不同的修复策略，修复后重新执行相关检查：\n${failed.map((item) => `- ${item.checkName}：${item.message}`).join('\n')}`)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              if (isManagedPause(message)) throw error
              appendLog(t('workspace.log.managedGateRecoveryFailed', { error: message }))
            }
          }
          if (carriedGateIssues > 0) {
            step.detail = `阶段任务已完成；${carriedGateIssues} 个门禁阻断项作为遗留风险带入后续阶段`
          }
        }
        step.status = step.detail.includes('风险') || step.detail.includes('异常') ? 'completed_with_risk' : 'completed'
        if (step.status === 'completed') step.detail = '阶段任务及门禁已完成'
        setManagedSteps([...steps])
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      outcome = failure === '用户停止托管' ? 'stopped' : /托管已暂停|L3\/L4/.test(failure) ? 'paused' : 'failed'
      const running = steps.findLast((step) => step.status === 'running')
      if (running) {
        running.status = 'failed'
        running.detail = failure
      }
      setManagedSteps([...steps])
    } finally {
      if (outcome === 'completed' && totalRisks > 0) outcome = 'completed_with_risk'
      const path = await writeManagedReport(outcome, startedAt, steps, failure)
      const resultText = outcome === 'completed'
        ? t('workspace.log.managedCompleted')
        : outcome === 'completed_with_risk'
          ? t('workspace.log.managedCompletedWithRisk', { count: totalRisks })
          : t('workspace.log.managedPaused')
      appendLog(t('workspace.log.managedFinished', { result: resultText, path }))
      setManagedRunning(false)
      await reload()
    }
  }

  const stopManagedRun = async (): Promise<void> => {
    managedStopRef.current = true
    // M1 §3.6：主进程 abort 已覆盖该项目全部存活会话（前台 + 后台任务会话 + VERIF 批次编排）
    // 无条件 abort：停止时前台通常空闲（在等批次/后台任务），按 streaming 判断会漏掉后台任务会话
    await abortAgent()
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
    appendLog(t('workspace.log.changeCreated', { kind: t(`workspace.changeKind.${changeType}`), id, phase: phaseLabel(changeSourcePhase) }))
  }

  const handleRunSynthesis = async (): Promise<void> => {
    appendLog(t('workspace.log.synthesisStart'))
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
      appendLog(t('workspace.log.synthesisDone'))
    } catch (err) {
      appendLog(t('workspace.log.synthesisSendFailed', { error: err instanceof Error ? err.message : String(err) }))
    }
  }

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-500">
        {t('workspace.notFound')} <Link to="/projects" className="ml-2 text-blue-600 underline">{t('workspace.backToProjects')}</Link>
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
              <h2 className="text-base font-semibold text-zinc-900">{t('workspace.managedDialog.title')}</h2>
              <p className="mt-1 text-xs leading-5 text-zinc-500">{t('workspace.managedDialog.description')}</p>
            </header>
            <div className="space-y-4 p-5">
              <label className="block text-xs font-medium text-zinc-700">{t('workspace.managedDialog.endPhase')}</label>
              <select value={managedEndPhase} onChange={(event) => setManagedEndPhase(event.target.value as Phase)} className="w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm">
                {PHASE_ORDER.slice(PHASE_ORDER.indexOf(project.currentPhase)).map((phase) => (
                  <option key={phase} value={phase}>{phase} · {phaseLabel(phase)}</option>
                ))}
              </select>
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
                {t('workspace.managedDialog.hint')}
              </div>
            </div>
            <footer className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3">
              <button onClick={() => setManagedDialogOpen(false)} className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600">{t('common.cancel')}</button>
              <button onClick={() => void startManagedRun()} className="rounded bg-blue-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-blue-500">{t('workspace.managedDialog.start')}</button>
            </footer>
          </section>
        </div>
      )}
      {changeDialogOpen && project && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-6">
          <section className="w-full max-w-xl rounded-md border border-zinc-300 bg-white shadow-2xl">
            <header className="border-b border-zinc-200 px-5 py-4">
              <h2 className="text-base font-semibold text-zinc-900">{t('workspace.changeDialog.title')}</h2>
              <p className="mt-1 text-xs text-zinc-500">{t('workspace.changeDialog.description')}</p>
            </header>
            <div className="grid grid-cols-2 gap-4 p-5">
              <label className="text-xs font-medium text-zinc-700">{t('workspace.changeDialog.typeLabel')}
                <select value={changeType} onChange={(event) => setChangeType(event.target.value as typeof changeType)} className="mt-1 w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm">
                  <option value="requirement">{t('workspace.changeDialog.typeRequirement')}</option><option value="specification">{t('workspace.changeDialog.typeSpecification')}</option><option value="bug">{t('workspace.changeDialog.typeBug')}</option>
                </select>
              </label>
              <label className="text-xs font-medium text-zinc-700">{t('workspace.changeDialog.sourcePhase')}
                <select value={changeSourcePhase} onChange={(event) => setChangeSourcePhase(event.target.value as Phase)} className="mt-1 w-full rounded border border-zinc-300 bg-white px-3 py-2 text-sm">
                  {PHASE_ORDER.map((phase) => <option key={phase} value={phase}>{phase} · {phaseLabel(phase)}</option>)}
                </select>
              </label>
              <label className="col-span-2 text-xs font-medium text-zinc-700">{t('workspace.changeDialog.descriptionLabel')}
                <textarea value={changeDescription} onChange={(event) => setChangeDescription(event.target.value)} rows={5} placeholder={t('workspace.changeDialog.descriptionPlaceholder')} className="mt-1 w-full resize-y rounded border border-zinc-300 bg-white px-3 py-2 text-sm" />
              </label>
            </div>
            <footer className="flex justify-end gap-2 border-t border-zinc-200 px-5 py-3">
              <button onClick={() => setChangeDialogOpen(false)} className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600">{t('common.cancel')}</button>
              <button disabled={!changeDescription.trim()} onClick={() => void createChangeRequest()} className="rounded bg-blue-600 px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50">{t('workspace.changeDialog.submit')}</button>
            </footer>
          </section>
        </div>
      )}
      {/* ======== 顶部：项目信息 + 阶段看板 ======== */}
      <header className="workspace-header relative z-30 shrink-0 overflow-visible border-b border-zinc-200 bg-white px-6 py-4">
        <div className="mb-3 flex items-center gap-3">
          <h1 className="text-lg font-bold text-zinc-900">{project.name}</h1>
          <span className="text-sm text-zinc-500">
            {t('workspace.currentPhase', { phase: project.currentPhase, label: phaseLabel(project.currentPhase) })}
          </span>
          {managedRunning ? (
            <button type="button" onClick={() => void stopManagedRun()} className="ml-auto flex items-center gap-1.5 rounded border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700">
              <Square size={12} /> {t('workspace.managedDialog.stop')}
            </button>
          ) : (
            <button type="button" onClick={() => { setManagedEndPhase('SYNTH'); setManagedDialogOpen(true) }} disabled={agentStreaming} className="ml-auto flex items-center gap-1.5 rounded border border-blue-300 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50">
              <Bot size={14} /> {t('workspace.managedDialog.title')}
            </button>
          )}
          <button type="button" onClick={() => setChangeDialogOpen(true)} disabled={managedRunning || agentStreaming} className="rounded border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50">
            {t('workspace.startChange')}
          </button>
          <button
            type="button"
            onClick={() => void handleGenerateDashboard()}
            disabled={generatingDashboard}
            className="rounded border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
          >
            {generatingDashboard ? t('workspace.generatingDashboard') : t('workspace.generateDashboard')}
          </button>
          <Link
            to="/verification-posture/$projectId"
            params={{ projectId }}
            className="rounded border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100"
          >
            {t('workspace.verificationPosture')}
          </Link>
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
            <span className="shrink-0 font-medium text-blue-800">{managedRunning ? t('workspace.managedRun.running') : t('workspace.managedRun.lastRun')}</span>
            {managedSteps.map((step) => (
              <span key={step.phase} className={`shrink-0 rounded px-2 py-1 ${step.status === 'completed' ? 'bg-emerald-100 text-emerald-700' : step.status === 'completed_with_risk' ? 'bg-amber-100 text-amber-700' : step.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-white text-blue-700'}`} title={step.detail}>
                {phaseLabel(step.phase)} {step.status === 'completed' ? '✓' : step.status === 'completed_with_risk' ? '!' : step.status === 'failed' ? '×' : '…'}
              </span>
            ))}
            {managedReportPath && <button onClick={() => void openFile(managedReportPath)} className="ml-auto shrink-0 text-blue-700 underline">{t('workspace.managedRun.viewReport')}</button>}
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
          onResetPhase={(phase, mode) => void handleResetPhase(phase, mode)}
          backgroundRunningPhases={backgroundRunningPhases}
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
              {t('workspace.gate.recheck')}
            </button>
            {gate.blocked ? (
              <span className="text-xs text-amber-600">{t('workspace.gate.fixThenRecheck')}</span>
            ) : gate.forced ? (
              <span className="text-xs text-amber-600">{t('workspace.gate.forcedNotice')}</span>
            ) : (
              <span className="text-xs text-emerald-600">{t('workspace.gate.passed')}</span>
            )}
          </div>
        )}

        {project.currentPhase === 'VERIF' && <VerifStatusBar projectId={project.id} agentStreaming={agentStreaming} onAction={(prompt) => void handleVerificationGuidanceAction(prompt)} onPlanEnv={() => void handlePlanEnv()} onBasic={() => void handleBasicValidation()} onCorner={() => void handleCornerWaves()} onSignoff={() => void handleSignoff()} />}

        {project.currentPhase === 'SYNTH' && (
          <div className="mt-3 flex items-center gap-3 border-t border-zinc-100 pt-3">
            <span className="text-xs font-medium text-zinc-500">{t('workspace.synthBar.label')}</span>
            <button
              onClick={() => void handleRunSynthesis()}
              disabled={agentStreaming}
              className="rounded border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50"
            >
              {t('workspace.synthBar.run')}
            </button>
            {agentStreaming && <span className="text-xs text-amber-600">{t('workspace.synthBar.agentRunning')}</span>}
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
                {t('workspace.tabs.chat')}
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
                  <button onClick={() => closeFile(f.path)} className="text-zinc-400 hover:text-red-600" title={t('common.close')}>×</button>
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
                        {t('workspace.viewer.lineCount', { count: activeFile.content.split(/\r\n|\r|\n/).length })}
                      </span>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <button
                        onClick={requestFileFind}
                        className="flex h-6 w-6 items-center justify-center rounded border border-zinc-300 text-zinc-600 hover:bg-zinc-100"
                        title={t('workspace.viewer.findTitle')}
                        aria-label={t('workspace.viewer.findAria')}
                      ><Search size={12} /></button>
                      {/\.md$/i.test(activeFile.path) && (
                        <button
                          onClick={() => setMarkdownPreview((value) => !value)}
                          className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100"
                        >
                          {markdownPreview ? t('workspace.viewer.source') : t('workspace.viewer.preview')}
                        </button>
                      )}
                      <button
                        onClick={() => void refreshOpenFile(activeFile.path)}
                        className="flex h-6 w-6 items-center justify-center rounded border border-zinc-300 text-zinc-600 hover:bg-zinc-100"
                        title={t('workspace.viewer.reload')}
                      ><RefreshCw size={12} /></button>
                      <button
                        onClick={() => setWordWrap((value) => !value)}
                        className={`rounded border px-2 py-0.5 text-xs ${wordWrap ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-zinc-300 text-zinc-600 hover:bg-zinc-100'}`}
                        title={t('workspace.viewer.wordWrapTitle')}
                      >{t('workspace.viewer.wordWrap')}</button>
                      <button
                        onClick={() => setViewerFontSize((size) => Math.max(10, size - 1))}
                        className="flex h-6 w-6 items-center justify-center rounded border border-zinc-300 text-zinc-600 hover:bg-zinc-100"
                        title={t('workspace.viewer.decreaseFont')}
                      ><Minus size={12} /></button>
                      <span className="min-w-7 text-center text-[11px] leading-6 text-zinc-400">{viewerFontSize}</span>
                      <button
                        onClick={() => setViewerFontSize((size) => Math.min(24, size + 1))}
                        className="flex h-6 w-6 items-center justify-center rounded border border-zinc-300 text-zinc-600 hover:bg-zinc-100"
                        title={t('workspace.viewer.increaseFont')}
                      ><Plus size={12} /></button>
                      {shouldOpenExternally(activeFile.path) && (
                        <button
                          onClick={() => window.moonglass.fs.openExternal(projectId, activeFile.path).catch(() => {})}
                          className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100"
                        >
                          {t('workspace.viewer.openExternal')}
                        </button>
                      )}
                      <button
                        onClick={() => navigator.clipboard.writeText(activeFile.content).catch(() => {})}
                        className="rounded border border-zinc-300 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100"
                      >
                        📋 {t('common.copy')}
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
                        findRequestKey={findRequestKey}
                        wordWrap={wordWrap}
                        fontSize={viewerFontSize}
                      />
                    )}
                  </div>
                  {activeFile.truncated && (
                    <p className="mt-1 shrink-0 text-xs text-zinc-400">{t('workspace.viewer.truncated')}</p>
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
                  {t(tab.labelKey)}
                </button>
              ))}
              <span className="ml-auto text-[11px] text-zinc-400">{t('workspace.console.title')}</span>
              <button
                onClick={() => { setBottomCollapsed(false); setBottomH(MAX_BOTTOM) }}
                className="console-icon-button"
                title={t('workspace.console.maximize')}
              >
                <Maximize2 size={13} />
              </button>
              <button
                onClick={() => setBottomCollapsed((value) => !value)}
                className="console-icon-button"
                title={bottomCollapsed ? t('workspace.console.expand') : t('workspace.console.collapse')}
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
        <span>{t('workspace.statusBar.toolchain', { toolchain: project.edaToolchain })}</span>
        <span>
          {t('workspace.statusBar.phases', { done: PHASE_ORDER.filter((p) => ['completed', 'skipped'].includes(project.phases[p].status)).length, total: PHASE_ORDER.length })}
        </span>
        <span className="ml-auto">{t('workspace.statusBar.footer', { version: APP_INFO.version })}</span>
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

interface VerificationIntelligenceSummary {
  scenarioCount: number
  criticalOpen: string[]
  regressions: Array<{ passed: boolean }>
  scenarios: Array<{
    id: string
    title: string
    priority: number
    method: string
    status: string
    evidence: string[]
  }>
  analyzer?: { engine: string; version?: string; limitations: string[] }
  interactionGraph?: {
    nodes: Array<{ id: string; kind: string; label: string; source?: { file: string; line?: number } }>
    edges: Array<{ id: string; from: string; to: string; type: string; confidence: string }>
  }
  executionPlan?: Array<{ scenarioId: string; sequence: string; iterations: number; budgetSeconds: number; priority: number; reason: string }>
  formalResults?: Array<{ resultFile: string; status: string; mode: string; scenarioId?: string; traces: string[] }>
  specGaps?: Array<{ id: string; category: string; title: string; confidence: string }>
  verificationIntents?: Array<{ id: string; scenarioId: string; objective: string; status: string; priority: number; recommendedMethods: string[]; boundaries: Array<{ object: string; values: string[] }> }>
  coverageHoles?: Array<{ id: string; scenarioId: string; classification: string; confidence: string; reason: string; recommendedAction: string; blocking: boolean }>
  structuralSummary?: { fsm: number; cfgNodes: number; dependencies: number; cones: number; protocols: Array<{ protocol: string; module: string }> }
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
  const { t } = useTranslation()
  const [inventory, setInventory] = useState<ProjectInventory>(EMPTY_INVENTORY)
  const [loading, setLoading] = useState(false)
  const [waveformStatus, setWaveformStatus] = useState('')
  const [intelligence, setIntelligence] = useState<VerificationIntelligenceSummary | null>(null)
  const [intelligenceView, setIntelligenceView] = useState<'scenario' | 'intent' | 'holes' | 'interaction' | 'schedule' | 'formal'>('scenario')

  const refreshInventory = useCallback(async () => {
    setLoading(true)
    try {
      const files = flattenFiles(await window.moonglass.fs.tree(projectId))
      const verification = files.filter((file) => /(^|\/)verification\//i.test(file))
      const synthesis = files.filter((file) => /(^|\/)imp\/(constraints|synthesis)\//i.test(file))
      const intelligencePath = 'verification/intelligence/verification-state.json'
      if (files.includes(intelligencePath)) {
        try {
          const result = await window.moonglass.fs.readFile(projectId, intelligencePath)
          setIntelligence(result ? JSON.parse(result.content) as VerificationIntelligenceSummary : null)
        } catch { setIntelligence(null) }
      } else setIntelligence(null)
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
        {t('common.refresh')}
      </button>
      <span className="text-[11px] text-zinc-400">{t('workspace.console.trackableArtifacts', { count: inventory.artifacts.length })}</span>
    </div>
  )

  if (tab === 'problems') {
    return (
      <div className="flex h-full flex-col">
        {toolbar}
        <div className="mb-2 flex items-center gap-3 text-xs">
          <span className="problem-count problem-count-error">{t('workspace.console.errors', { count: failedGates.length + errorLogs.length })}</span>
          <span className="problem-count problem-count-warning">{t('workspace.console.warnings', { count: warningLogs.length })}</span>
          <button
            onClick={() => onAskAgent('请检查工程控制台中的门禁失败、Lint、仿真和综合问题，定位根因，修改对应文件并重新运行相关工具验证。')}
            disabled={agentStreaming}
            className="console-action ml-auto"
          >
            {t('workspace.console.askAgentFix')}
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
              title={extractFileReference(result.message) ? t('workspace.console.openProblemFile') : result.message}
            >
              <AlertTriangle size={14} className="shrink-0 text-red-500" />
              <strong className="shrink-0 text-xs text-zinc-700">{result.checkName}</strong>
              <span className="truncate text-xs text-zinc-500" title={result.message}>{result.message}</span>
              <span className="ml-auto shrink-0 text-[10px] text-zinc-400">{t('workspace.console.gateBadge')}</span>
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
              title={extractFileReference(entry) ? t('workspace.console.openProblemFile') : entry}
            >
              <TerminalSquare size={14} className="shrink-0 text-amber-500" />
              <span className="truncate font-mono text-xs text-zinc-600" title={entry}>{entry}</span>
            </div>
          ))}
          {failedGates.length + errorLogs.length + warningLogs.length === 0 && (
            <div className="console-empty">{t('workspace.problems.empty')}</div>
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
          empty={t('workspace.runs.empty')}
          onOpenFile={onOpenFile}
        />
      </div>
    )
  }

  if (tab === 'verification') {
    return (
      <div className="flex h-full flex-col">
        {toolbar}
        <div className="mb-2 grid grid-cols-6 gap-2">
          <ConsoleMetric label={t('workspace.verification.metricArtifacts')} value={inventory.verification.length} />
          <ConsoleMetric label="Scenario" value={intelligence?.scenarioCount ?? 0} />
          <ConsoleMetric label={t('workspace.verification.metricCriticalOpen')} value={intelligence?.criticalOpen.length ?? 0} />
          <ConsoleMetric label={t('workspace.verification.metricFormalEvidence')} value={intelligence?.formalResults?.length ?? 0} />
          <ConsoleMetric label={t('workspace.verification.metricIntents')} value={intelligence?.verificationIntents?.length ?? 0} />
          <ConsoleMetric label={t('workspace.verification.metricSpecGaps')} value={intelligence?.specGaps?.length ?? 0} />
        </div>
        {intelligence && (
          <div className="mb-2 flex items-center gap-1" aria-label={t('workspace.verification.viewsAria')}>
            {([['scenario', t('workspace.verification.viewScenario')], ['intent', t('workspace.verification.viewIntent')], ['holes', t('workspace.verification.viewHoles')], ['interaction', t('workspace.verification.viewInteraction')], ['schedule', t('workspace.verification.viewSchedule')], ['formal', t('workspace.verification.viewFormal')]] as const).map(([value, label]) => (
              <button key={value} onClick={() => setIntelligenceView(value)} className={`console-action ${intelligenceView === value ? 'border-emerald-500 text-emerald-600' : ''}`}>{label}</button>
            ))}
            <span className="ml-auto truncate text-[10px] text-zinc-400" title={intelligence.analyzer?.limitations.join('；')}>{t('workspace.verification.analyzer', { engine: intelligence.analyzer?.engine ?? t('workspace.verification.analyzerLegacy') })}{intelligence.analyzer?.version ? ` · ${intelligence.analyzer.version}` : ''}</span>
          </div>
        )}
        {intelligence?.structuralSummary && <div className="mb-2 truncate text-[10px] text-zinc-400" title={intelligence.structuralSummary.protocols.map((item) => `${item.module}:${item.protocol}`).join('；')}>{t('workspace.verification.structuralSummary', { fsm: intelligence.structuralSummary.fsm, cfg: intelligence.structuralSummary.cfgNodes, deps: intelligence.structuralSummary.dependencies, coi: intelligence.structuralSummary.cones, protocols: intelligence.structuralSummary.protocols.length })}</div>}
        {!intelligence && (
          <div className="console-empty mb-2 flex items-center justify-between gap-3">
            <span>{t('workspace.verification.noIntelligence')}</span>
            <button
              onClick={() => onAskAgent('请调用 build_verification_intelligence，基于当前规格、RTL 结构事实和覆盖率反馈生成风险与 Scenario 看板，并说明最高优先级场景的选择依据。')}
              disabled={agentStreaming}
              className="console-action shrink-0"
            >
              {t('workspace.verification.buildIntelligence')}
            </button>
          </div>
        )}
        {intelligence && intelligenceView === 'scenario' && intelligence.scenarios.length > 0 && (
          <div className="console-list mb-2 max-h-32 overflow-y-auto" aria-label={t('workspace.verification.scenarioBoardAria')}>
            {intelligence.scenarios.slice(0, 12).map((scenario) => (
              <button
                key={scenario.id}
                onDoubleClick={() => onOpenFile(scenario.evidence?.[0] ?? 'verification/intelligence/scenario-registry.json')}
                className="console-row w-full text-left"
                title={t('workspace.verification.openScenarioRegistry')}
              >
                <strong className="shrink-0 font-mono text-[11px] text-emerald-700">{scenario.id}</strong>
                <span className="min-w-0 flex-1 truncate text-xs text-zinc-600">{scenario.title}</span>
                <span className="shrink-0 font-mono text-[10px] text-zinc-500">P={scenario.priority.toFixed(3)}</span>
                <span className={`shrink-0 text-[10px] ${['VERIFIED', 'FORMAL_PROVED', 'WAIVED'].includes(scenario.status) ? 'text-emerald-600' : scenario.status === 'FAILED' ? 'text-red-600' : 'text-amber-600'}`}>{scenario.status}</span>
              </button>
            ))}
          </div>
        )}
        {intelligence && intelligenceView === 'interaction' && (
          <div className="console-list mb-2 max-h-32 overflow-y-auto" aria-label={t('workspace.verification.interactionAria')}>
            {(intelligence.interactionGraph?.edges ?? []).slice(0, 40).map((edge) => {
              const source = intelligence.interactionGraph?.nodes.find((node) => node.id === edge.from)?.source
              return <button key={edge.id} onDoubleClick={() => source?.file && onOpenFile(source.file)} className="console-row w-full text-left" title={source?.file ? t('workspace.verification.jumpToEvidence') : edge.id}>
                <strong className="shrink-0 font-mono text-[10px] text-sky-600">{edge.type}</strong>
                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-600">{edge.from} → {edge.to}</span>
                <span className="shrink-0 text-[10px] text-zinc-400">{edge.confidence}</span>
              </button>
            })}
            {(intelligence.interactionGraph?.edges.length ?? 0) === 0 && <div className="console-empty">{t('workspace.verification.noInteractions')}</div>}
          </div>
        )}
        {intelligence && intelligenceView === 'intent' && (
          <div className="console-list mb-2 max-h-32 overflow-y-auto" aria-label={t('workspace.verification.intentAria')}>
            {(intelligence.verificationIntents ?? []).slice(0, 30).map((intent) => <button key={intent.id} onDoubleClick={() => onOpenFile('verification/intelligence/verification-intent-registry.json')} className="console-row w-full text-left" title={t('workspace.verification.openIntentRegistry')}>
              <strong className="shrink-0 font-mono text-[11px] text-emerald-700">{intent.id}</strong>
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-600">{intent.objective}</span>
              <span className="shrink-0 text-[10px] text-sky-600">{intent.recommendedMethods.join(' + ')}</span>
              <span className="shrink-0 text-[10px] text-zinc-500">{t('workspace.verification.boundaryCount', { count: intent.boundaries.length })}</span>
              <span className="shrink-0 text-[10px] text-amber-600">{intent.status}</span>
            </button>)}
            {(intelligence.verificationIntents?.length ?? 0) === 0 && <div className="console-empty">{t('workspace.verification.noIntents')}</div>}
          </div>
        )}
        {intelligence && intelligenceView === 'holes' && (
          <div className="console-list mb-2 max-h-32 overflow-y-auto" aria-label={t('workspace.verification.holesAria')}>
            {(intelligence.coverageHoles ?? []).slice(0, 30).map((hole) => <button key={hole.id} onDoubleClick={() => onOpenFile('verification/intelligence/coverage-hole-register.json')} className="console-row w-full text-left" title={`${hole.reason} ${hole.recommendedAction}`}>
              <strong className={`shrink-0 font-mono text-[11px] ${hole.blocking ? 'text-red-600' : 'text-amber-600'}`}>{hole.classification}</strong>
              <span className="shrink-0 font-mono text-[10px] text-zinc-500">{hole.scenarioId}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-600">{hole.reason}</span>
              <span className="shrink-0 text-[10px] text-zinc-400">{hole.confidence}</span>
            </button>)}
            {(intelligence.coverageHoles?.length ?? 0) === 0 && <div className="console-empty">{t('workspace.verification.noHoles')}</div>}
          </div>
        )}
        {intelligence && intelligenceView === 'schedule' && (
          <div className="console-list mb-2 max-h-32 overflow-y-auto" aria-label={t('workspace.verification.scheduleAria')}>
            {(intelligence.executionPlan ?? []).map((plan) => <div key={plan.scenarioId} className="console-row" title={plan.reason}>
              <strong className="shrink-0 font-mono text-[11px] text-emerald-700">{plan.scenarioId}</strong>
              <span className="min-w-0 flex-1 truncate text-xs text-zinc-600">{plan.sequence}</span>
              <span className="shrink-0 text-[10px] text-zinc-500">{t('workspace.verification.iterations', { iterations: plan.iterations, budget: plan.budgetSeconds })}</span>
            </div>)}
            {(intelligence.executionPlan?.length ?? 0) === 0 && <div className="console-empty">{t('workspace.verification.noScheduled')}</div>}
          </div>
        )}
        {intelligence && intelligenceView === 'formal' && (
          <div className="console-list mb-2 max-h-32 overflow-y-auto" aria-label={t('workspace.verification.formalAria')}>
            {(intelligence.formalResults ?? []).map((result) => <button key={result.resultFile} onDoubleClick={() => onOpenFile(result.resultFile)} className="console-row w-full text-left" title={t('workspace.verification.openFormalResult')}>
              <strong className={`shrink-0 font-mono text-[11px] ${result.status === 'PASS' ? 'text-emerald-600' : result.status === 'FAIL' ? 'text-red-600' : 'text-amber-600'}`}>{result.status}</strong>
              <span className="shrink-0 text-[10px] text-zinc-500">{result.mode}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-600">{result.scenarioId ?? result.resultFile}</span>
              <span className="shrink-0 text-[10px] text-zinc-400">{t('workspace.verification.traceCount', { count: result.traces.length })}</span>
            </button>)}
            {(intelligence.formalResults ?? []).length === 0 && <div className="console-empty">{t('workspace.verification.noFormal')}</div>}
          </div>
        )}
        {inventory.waveforms.length > 0 && (
          <div className="console-list mb-2 max-h-24 overflow-y-auto">
            {inventory.waveforms.map((file) => (
              <div key={file} className="console-row">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-600">{file}</span>
                <button
                  onClick={async () => {
                    setWaveformStatus(t('workspace.verification.openingWaveform', { file }))
                    const result = await window.moonglass.eda.openWaveform(projectId, file)
                    setWaveformStatus(result.ok ? t('workspace.verification.waveformOpened', { file }) : t('workspace.verification.waveformFailed', { error: result.error ?? '' }))
                  }}
                  className="console-action shrink-0"
                  title={t('workspace.verification.openWaveformTitle')}
                >
                  {t('workspace.verification.openWaveform')}
                </button>
              </div>
            ))}
          </div>
        )}
        {waveformStatus && <p className="text-xs text-zinc-500">{waveformStatus}</p>}
        <FileRows
          files={inventory.verification.filter((file) => !/\.(vcd|fst)$/i.test(file))}
          empty={t('workspace.verification.empty')}
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
          <ConsoleMetric label={t('workspace.synthesis.metricArtifacts')} value={inventory.synthesis.length} />
          <ConsoleMetric label={t('workspace.synthesis.metricConstraints')} value={inventory.synthesis.filter((file) => /\.sdc$/i.test(file)).length} />
          <ConsoleMetric label={t('workspace.synthesis.metricReports')} value={inventory.synthesis.filter((file) => /\.(rpt|json|log)$/i.test(file)).length} />
        </div>
        <FileRows files={inventory.synthesis} empty={t('workspace.synthesis.empty')} onOpenFile={onOpenFile} />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {toolbar}
      <FileRows files={inventory.artifacts} empty={t('workspace.artifacts.empty')} onOpenFile={onOpenFile} />
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
  const { t } = useTranslation()
  if (files.length === 0) return <div className="console-empty">{empty}</div>
  return (
    <div className="console-list flex-1 overflow-auto">
      {files.map((file) => (
        <button key={file} onDoubleClick={() => onOpenFile(file)} className="console-row w-full text-left" title={t('workspace.console.doubleClickOpen')}>
          <FileOutput size={14} className="shrink-0 text-sky-600" />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-600">{file}</span>
          <span className="shrink-0 text-[10px] uppercase text-zinc-400">{file.split('.').pop()}</span>
        </button>
      ))}
    </div>
  )
}
