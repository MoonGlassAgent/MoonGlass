/**
 * Agent 对话面板（Phase 2）
 *
 * 工作区中部的聊天界面：消息列表（user/assistant/tool）+ 流式输出 +
 * 模型选择 + 输入区。会话由主进程 AgentService（Pi RPC 子进程）承载。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { Minimize2, MoreVertical, RotateCcw, Ruler } from 'lucide-react'
import { type AgentDecisionRequest, type AgentDecisionResponse, type AgentSessionStats, type AgentUiMessage, type LlmProviderConfig, type Phase } from '@shared/types'
import { DECISION_RESPONSE_PREFIX, serializeDecisionResponses } from '@shared/agent-interaction'
import { FILE_REFERENCE_SOURCE, isFileReference } from '@shared/file-reference'
import { useChatStore } from '../store/chatStore'
import { useTranslation, phaseLabel, t } from '../i18n'

interface SessionInfo {
  name: string
  file: string
  label: string
  messageCount: number
  modelLabel: string
  selectedModel: { providerId: string; modelId: string } | null
  isActive: boolean
  /** 会话进程仍在后台运行（如 VERIF 批次会话） */
  isRunning: boolean
}

/** 编排托管的只读会话名标记：VERIF 批次（phase-verif--batch-N）与 RTL 修复会话（phase-verif--fix-RC-*，M3 §4） */
function isBatchSession(name: string): boolean {
  return name.includes('--batch-') || name.includes('--fix-')
}

interface ChatPanelProps {
  projectId: string
  phase: Phase
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 100_000 ? 0 : 1)}k`
  return String(value)
}

/** 解析用户输入的上下文上限：支持 131072 / 128k / 1M 写法；无效返回 null */
function parseTokenCountInput(raw: string): number | null {
  const match = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km])?$/)
  if (!match) return null
  const value = Number(match[1]) * (match[2] === 'm' ? 1_000_000 : match[2] === 'k' ? 1_000 : 1)
  if (!Number.isFinite(value) || value < 1024 || value > 10_000_000) return null
  return Math.round(value)
}

function statsTitle(stats: AgentSessionStats): string {
  const lines = [
    t('chat.stats.inputTokens', { value: stats.tokens.input.toLocaleString() }),
    t('chat.stats.outputTokens', { value: stats.tokens.output.toLocaleString() })
  ]
  if (stats.tokens.cacheRead) lines.push(t('chat.stats.cacheRead', { value: stats.tokens.cacheRead.toLocaleString() }))
  if (stats.tokens.cacheWrite) lines.push(t('chat.stats.cacheWrite', { value: stats.tokens.cacheWrite.toLocaleString() }))
  lines.push(t('chat.stats.sessionTotal', { value: stats.tokens.total.toLocaleString() }))
  if (stats.contextWindowStatus === 'verified') lines.push(t('chat.stats.contextVerified', { source: stats.contextWindowSource ?? t('chat.stats.sourceOfficial') }))
  if (stats.contextWindowStatus === 'estimated') lines.push(t('chat.stats.contextEstimated', { source: stats.contextWindowSource ?? t('chat.stats.sourcePendingReview') }))
  if (stats.contextWindowStatus === 'custom') lines.push(t('chat.stats.contextCustom', { value: formatTokens(stats.contextWindowOverride ?? 0) }))
  if (stats.contextWindowStatus === 'unknown') lines.push(t('chat.stats.contextUnknown'))
  if (typeof stats.cost === 'number' && stats.cost > 0) lines.push(t('chat.stats.estimatedCost', { value: stats.cost.toFixed(4) }))
  lines.push(t('chat.stats.messageCounts', { user: stats.userMessages, assistant: stats.assistantMessages, tool: stats.toolCalls }))
  return lines.join('\n')
}

export function SessionTabs({ projectId, onActivate }: { projectId: string; onActivate?: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const { sessionInfo, startTask, switchSession, closeSession } = useChatStore()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [showDialog, setShowDialog] = useState(false)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** 正在只读查看的批次会话（不切换活动会话） */
  const [peekSession, setPeekSession] = useState<SessionInfo | null>(null)

  const refresh = useCallback(async () => {
    try {
      setSessions(await window.moonglass.agent.listSessions(projectId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [projectId])

  useEffect(() => {
    if (sessionInfo?.projectId === projectId && sessionInfo.providersReady) void refresh()
  }, [projectId, refresh, sessionInfo])

  const select = async (sessionName: string): Promise<void> => {
    onActivate?.()
    if (busy || sessions.find((session) => session.name === sessionName)?.isActive) return
    setBusy(true)
    setError('')
    try {
      await switchSession(sessionName)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await startTask(name.trim() || undefined)
      await refresh()
      onActivate?.()
      setShowDialog(false)
      setName('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const close = async (session: SessionInfo): Promise<void> => {
    if (busy || session.name === 'main') return
    if (!window.confirm(t('chat.tabs.confirmClose', { label: session.label }))) return
    setBusy(true)
    setError('')
    try {
      await closeSession(session.name)
      await refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {sessions.map((session) => (
        <span
          key={session.name}
          title={`${t('chat.tabs.sessionTitle', { label: session.label, count: session.messageCount })}${session.modelLabel ? t('chat.tabs.sessionTitleModel', { model: session.modelLabel }) : t('chat.tabs.sessionTitleNoModel')}`}
          className={`flex max-w-48 shrink-0 items-center rounded-t border-x border-t text-xs ${
            session.isActive
              ? 'border-blue-300 bg-blue-50 font-medium text-blue-700'
              : 'border-transparent text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800'
          }`}
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              // 批次会话（phase-verif--batch-N）由编排托管：不切换、不 attach，只读查看
              if (isBatchSession(session.name)) setPeekSession(session)
              else void select(session.name)
            }}
            title={isBatchSession(session.name) ? t('chat.tabs.peekBatch') : undefined}
            className="min-w-0 truncate px-3 py-1.5 disabled:opacity-50"
          >
            {session.name === 'main' ? t('chat.mainSession') : session.label.replace(/\s*\([^)]*\)$/, '')}
            {isBatchSession(session.name) && (
              <span className={`ml-1 text-[10px] font-normal ${session.isRunning ? 'text-amber-600' : 'opacity-60'}`}>
                {session.isRunning ? t('chat.tabs.runningBadge') : t('chat.tabs.viewBadge')}
              </span>
            )}
            <span className="ml-1 max-w-24 truncate text-[10px] font-normal opacity-60">
              {session.modelLabel || t('chat.tabs.noModel')}
            </span>
          </button>
          {session.name !== 'main' && !isBatchSession(session.name) && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void close(session)}
              aria-label={t('chat.tabs.closeAria', { label: session.label })}
              title={t('chat.tabs.closeTitle')}
              className="mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-red-100 hover:text-red-600 disabled:opacity-50"
            >
              ×
            </button>
          )}
        </span>
      ))}
      <button
        type="button"
        onClick={() => {
          setError('')
          setShowDialog(true)
        }}
        title={t('chat.tabs.newTaskTitle')}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-base text-zinc-500 hover:bg-zinc-100 hover:text-blue-700"
      >
        +
      </button>
      {error && !showDialog && <span className="shrink-0 text-xs text-red-600">{error}</span>}

      {showDialog && createPortal((
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setShowDialog(false)
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="parallel-session-title"
            className="w-full max-w-sm rounded-md border border-zinc-300 bg-white p-4 shadow-xl"
          >
            <h2 id="parallel-session-title" className="text-sm font-semibold text-zinc-900">{t('chat.tabs.newTask')}</h2>
            <p className="mt-1 text-xs text-zinc-500">{t('chat.tabs.newTaskDesc')}</p>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create()
                if (event.key === 'Escape' && !busy) setShowDialog(false)
              }}
              placeholder={t('chat.tabs.newTaskPlaceholder')}
              className="mt-3 w-full rounded border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-200"
            />
            {error && <p className="mt-2 whitespace-pre-wrap text-xs text-red-600">{error}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setShowDialog(false)}
                className="rounded border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 hover:bg-zinc-100 disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void create()}
                className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {busy ? t('chat.tabs.creating') : t('common.create')}
              </button>
            </div>
          </div>
        </div>
      ), document.body)}

      {peekSession && (
        <BatchSessionPeek
          projectId={projectId}
          session={peekSession}
          onClose={() => {
            setPeekSession(null)
            void refresh()
          }}
        />
      )}
    </>
  )
}

/**
 * 批次会话只读查看面板（VERIF 批次可观测性）：
 * 打开时经 getSessionMessages 解析会话 JSONL；会话仍在后台运行时
 * 每 5 秒轮询刷新并标注"运行中（只读）"。只读——不提供输入框。
 */
function BatchSessionPeek({ projectId, session, onClose }: { projectId: string; session: SessionInfo; onClose: () => void }): React.JSX.Element {
  const { t } = useTranslation()
  const [messages, setMessages] = useState<AgentUiMessage[]>([])
  const [loadError, setLoadError] = useState('')
  const [running, setRunning] = useState(session.isRunning)

  const load = useCallback(async (): Promise<void> => {
    try {
      setMessages(await window.moonglass.agent.getSessionMessages(projectId, session.name))
      // 同步刷新运行标记：批次结束后停止轮询
      const sessions = await window.moonglass.agent.listSessions(projectId)
      setRunning(sessions.find((item) => item.name === session.name)?.isRunning ?? false)
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [projectId, session.name])

  useEffect(() => {
    void load()
    if (!running) return
    const timer = window.setInterval(() => void load(), 5_000)
    return () => window.clearInterval(timer)
  }, [load, running])

  return createPortal(
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('chat.tabs.batchDialogAria', { label: session.label })}
        className="flex h-[80vh] w-full max-w-3xl flex-col rounded-md border border-zinc-300 bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2">
          <h2 className="text-sm font-semibold text-zinc-900">
            {session.label.replace(/\s*\([^)]*\)$/, '')}
            <span className={`ml-2 text-xs font-normal ${running ? 'text-amber-600' : 'text-zinc-400'}`}>
              {running ? t('chat.tabs.runningReadonly') : t('chat.tabs.finishedReadonly')}
            </span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('chat.tabs.closePeekAria')}
            className="flex h-6 w-6 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
          >
            ×
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loadError && <p className="text-xs text-red-600">{loadError}</p>}
          {!loadError && messages.length === 0 && (
            <p className="mt-8 text-center text-sm text-zinc-400">{t('chat.tabs.emptyBatch')}</p>
          )}
          <div className="flex flex-col gap-3">
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                msg={m}
                decisionDisabled
                onDecision={() => { /* 只读面板不响应决策 */ }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

export function ChatPanel({ projectId, phase }: ChatPanelProps): React.JSX.Element {
  const { t } = useTranslation()
  const {
    sessionInfo,
    messages,
    streaming,
    aborting,
    ensure,
    send,
    abort,
    setModel,
    compactSession,
    finishAndStartTask,
    restartSessionFresh
  } = useChatStore()
  const [input, setInput] = useState('')
  const [providers, setProviders] = useState<LlmProviderConfig[]>([])
  const [providerHint, setProviderHint] = useState('')
  const [ensuring, setEnsuring] = useState(false)
  const [decisionDrafts, setDecisionDrafts] = useState<Record<string, { selectedIds: string[]; customText: string }>>({})
  const [historyIndex, setHistoryIndex] = useState<number | null>(null)
  const [sessionStats, setSessionStats] = useState<AgentSessionStats | null>(null)
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false)
  const [sessionActionBusy, setSessionActionBusy] = useState(false)
  /** 自定义上下文上限表单（三点菜单内联展开） */
  const [contextLimitEditing, setContextLimitEditing] = useState(false)
  const [contextLimitDraft, setContextLimitDraft] = useState('')
  const [contextLimitError, setContextLimitError] = useState('')
  const historyDraftRef = useRef('')
  const bottomRef = useRef<HTMLDivElement>(null)

  const inputHistory = messages
    .filter((message) => message.role === 'user')
    .map((message) => message.text.trim())
    .filter((text) => text && !text.startsWith(DECISION_RESPONSE_PREFIX) && !text.startsWith('【MoonGlass 一键托管】'))

  useEffect(() => {
    setEnsuring(true)
    void ensure(projectId).finally(() => setEnsuring(false))
  }, [ensure, projectId, phase])

  const refreshProviders = useCallback(async (): Promise<void> => {
    const list = await window.moonglass.llm.list()
    const ready = list.filter((p) => p.enabled && p.apiKey.trim() && p.models.length > 0)
    setProviders(ready)
    const configuredButDisabled = list.some((p) => !p.enabled && p.apiKey.trim() && p.models.length > 0)
    setProviderHint(configuredButDisabled
      ? t('chat.providerHintDisabled')
      : t('chat.providerHintEmpty'))
  }, [])

  useEffect(() => {
    void refreshProviders()
    const handleConfigurationChanged = (): void => {
      setEnsuring(true)
      void refreshProviders()
        .then(() => ensure(projectId))
        .finally(() => setEnsuring(false))
    }
    window.addEventListener('moonglass:llm-config-changed', handleConfigurationChanged)
    return () => window.removeEventListener('moonglass:llm-config-changed', handleConfigurationChanged)
  }, [ensure, projectId, refreshProviders])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    setHistoryIndex(null)
    historyDraftRef.current = input
  }, [sessionInfo?.sessionName])

  const refreshSessionStats = useCallback(async (): Promise<void> => {
    if (!sessionInfo?.providersReady) {
      setSessionStats(null)
      return
    }
    const requestedSession = sessionInfo.sessionName
    const stats = await window.moonglass.agent.getSessionStats(projectId).catch(() => null)
    if (useChatStore.getState().sessionInfo?.sessionName === requestedSession) setSessionStats(stats)
    // 依赖 selectedModel：切换模型后立即重取统计，上下文上限同步到新模型
  }, [projectId, sessionInfo?.providersReady, sessionInfo?.sessionName, sessionInfo?.selectedModel?.providerId, sessionInfo?.selectedModel?.modelId])

  useEffect(() => {
    setSessionStats(null)
    void refreshSessionStats()
    const timer = streaming ? window.setInterval(() => void refreshSessionStats(), 5_000) : undefined
    return () => { if (timer) window.clearInterval(timer) }
  }, [refreshSessionStats, streaming])


  const handleSend = (): void => {
    if (!input.trim() || streaming) return
    void send(input)
    setInput('')
    setHistoryIndex(null)
    historyDraftRef.current = ''
  }

  const recallInput = (direction: 'previous' | 'next'): void => {
    if (inputHistory.length === 0) return
    if (direction === 'previous') {
      if (historyIndex === null) historyDraftRef.current = input
      const nextIndex = historyIndex === null
        ? inputHistory.length - 1
        : Math.max(0, historyIndex - 1)
      setHistoryIndex(nextIndex)
      setInput(inputHistory[nextIndex])
      return
    }
    if (historyIndex === null) return
    if (historyIndex >= inputHistory.length - 1) {
      setHistoryIndex(null)
      setInput(historyDraftRef.current)
      return
    }
    const nextIndex = historyIndex + 1
    setHistoryIndex(nextIndex)
    setInput(inputHistory[nextIndex])
  }

  const decisionResponses = new Map<string, AgentDecisionResponse>()
  for (const message of messages) {
    for (const response of message.decisionResponses ?? (message.decisionResponse ? [message.decisionResponse] : [])) {
      decisionResponses.set(response.requestId, response)
    }
  }
  const pendingDecisions = messages
    .flatMap((message) => message.decisionRequest ? [message.decisionRequest] : [])
    .filter((request) => !decisionResponses.has(request.id))
  const completedDraftCount = pendingDecisions.filter((request) => Boolean(decisionDrafts[request.id])).length
  const allDecisionsReady = pendingDecisions.length > 0 && completedDraftCount === pendingDecisions.length
  const selectedModelValue = sessionInfo?.selectedModel
    ? JSON.stringify([sessionInfo.selectedModel.providerId, sessionInfo.selectedModel.modelId])
    : ''
  const selectedModelAvailable = sessionInfo?.selectedModel
    ? providers.some((provider) => provider.id === sessionInfo.selectedModel?.providerId && provider.models.includes(sessionInfo.selectedModel.modelId))
    : false

  const submitAllDecisions = (): void => {
    if (!allDecisionsReady || streaming) return
    const text = serializeDecisionResponses(pendingDecisions.map((request) => ({
      request,
      selectedIds: decisionDrafts[request.id].selectedIds,
      customText: decisionDrafts[request.id].customText
    })))
    setDecisionDrafts({})
    void send(text)
  }

  const handleCompactSession = async (): Promise<void> => {
    if (streaming || sessionActionBusy) return
    if (!window.confirm(t('chat.confirmCompact'))) return
    setSessionMenuOpen(false)
    setSessionActionBusy(true)
    try {
      await compactSession()
      await refreshSessionStats()
    } catch {
      // Store 已将错误写入当前会话消息区。
    } finally {
      setSessionActionBusy(false)
    }
  }

  const handleRestartSessionFresh = async (): Promise<void> => {
    if (streaming || sessionActionBusy) return
    if (!window.confirm(t('chat.confirmRestartFresh'))) return
    setSessionMenuOpen(false)
    setSessionActionBusy(true)
    try {
      await restartSessionFresh()
      setSessionStats(null)
    } catch {
      // Store 已将错误写入当前会话消息区。
    } finally {
      setSessionActionBusy(false)
    }
  }

  /** M2 §3.3 占用引导动作：压缩当前会话（保留摘要）→ 以同主题开新任务会话 */
  const handleFinishAndStartTask = async (): Promise<void> => {
    if (streaming || sessionActionBusy) return
    if (!window.confirm(t('chat.confirmFinishAndStart'))) return
    setSessionActionBusy(true)
    try {
      await finishAndStartTask()
      setSessionStats(null)
    } catch {
      // Store 已将错误写入当前会话消息区。
    } finally {
      setSessionActionBusy(false)
    }
  }

  /** 保存/清除自定义上下文上限：按当前会话模型持久化，随后重取统计刷新显示 */
  const handleSetContextLimit = async (value: number | null): Promise<void> => {
    if (sessionActionBusy) return
    setSessionActionBusy(true)
    setContextLimitError('')
    try {
      await window.moonglass.agent.setContextWindowOverride(projectId, value)
      await refreshSessionStats()
      setContextLimitEditing(false)
    } catch (reason) {
      setContextLimitError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSessionActionBusy(false)
    }
  }

  const submitContextLimit = (): void => {
    const parsed = parseTokenCountInput(contextLimitDraft)
    if (parsed == null) {
      setContextLimitError(t('chat.contextLimitInvalid'))
      return
    }
    void handleSetContextLimit(parsed)
  }

  // 未配置 Provider 的引导
  if (sessionInfo && !sessionInfo.providersReady) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-dashed border-zinc-300 p-8 text-center text-zinc-500">
          <div className="mb-2 text-3xl">🤖</div>
          <p className="font-medium text-zinc-700">{t('chat.readyTitle', { phase: phaseLabel(phase) })}</p>
          <p className="mt-2 text-sm">{providerHint || t('chat.readingProviderConfig')}</p>
          <p className="mt-1 text-sm">
            {t('chat.goToSettingsPrefix')}
            <Link to="/settings" className="mx-1 text-blue-600 underline">
              {t('chat.goToSettingsLink')}
            </Link>
            {t('chat.goToSettingsSuffix')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-surface flex h-full flex-col">
      {/* 头部：阶段 Agent + 会话选择 + 模型选择；relative z-40 确保三点菜单不被消息区遮挡（backdrop-filter 会使 toolbar 形成独立层叠上下文） */}
      <div className="chat-toolbar relative z-40 flex items-center justify-between border-b border-zinc-200 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-700">
            🤖 {t('chat.phaseAgent', { phase: phaseLabel(phase) })}
          </span>
          {sessionInfo && (
            <span className="text-xs text-zinc-400">
              · {sessionInfo.sessionName === 'main' ? t('chat.mainSession') : sessionInfo.sessionName}
            </span>
          )}
          {ensuring && <span className="text-xs text-zinc-400">{t('chat.sessionStarting')}</span>}
          {!ensuring && (
            <span className={`text-xs ${streaming ? 'text-amber-600' : 'text-emerald-600'}`}>
              {streaming ? t('chat.statusRunning') : t('chat.statusReady')}
            </span>
          )}

        </div>

        <div className="flex items-center gap-2">
          {sessionStats && (
            <span
              className={`whitespace-nowrap rounded border px-2 py-1 text-[11px] ${
                (sessionStats.contextUsage?.percent ?? 0) >= 90
                  ? 'border-red-300 bg-red-50 text-red-700'
                  : (sessionStats.contextUsage?.percent ?? 0) >= 70
                    ? 'border-amber-300 bg-amber-50 text-amber-700'
                    : 'border-zinc-200 bg-zinc-50 text-zinc-500'
              }`}
              title={statsTitle(sessionStats)}
            >
              {sessionStats.contextUsage?.tokens != null
                ? t('chat.contextUsage', { used: formatTokens(sessionStats.contextUsage.tokens), total: formatTokens(sessionStats.contextUsage.contextWindow), percent: Math.round(sessionStats.contextUsage.percent ?? 0) })
                : t('chat.sessionTokensUnknown', { total: formatTokens(sessionStats.tokens.total) })}
              {typeof sessionStats.cost === 'number' && sessionStats.cost > 0 ? ` · $${sessionStats.cost.toFixed(3)}` : ''}
            </span>
          )}
          {/* M2 §3.3：上下文占用 ≥60% 时的引导动作（与主进程 60% 提醒阈值一致） */}
          {sessionStats && (sessionStats.contextUsage?.percent ?? 0) >= 60 && (
            <button
              type="button"
              onClick={() => void handleFinishAndStartTask()}
              disabled={!sessionInfo || streaming || sessionActionBusy}
              className="whitespace-nowrap rounded border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] text-amber-700 hover:bg-amber-100 disabled:opacity-40"
              title={t('chat.finishAndStartTitle')}
            >
              {t('chat.finishAndStart')}
            </button>
          )}
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                if (sessionMenuOpen) setContextLimitEditing(false)
                setSessionMenuOpen((open) => !open)
              }}
              disabled={!sessionInfo || streaming || sessionActionBusy}
              className="flex h-7 w-7 items-center justify-center rounded border border-zinc-300 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-40"
              title={t('chat.sessionMenuTitle')}
              aria-label={t('chat.sessionMenuAria')}
            >
              <MoreVertical size={15} />
            </button>
            {sessionMenuOpen && <div className="absolute right-0 top-8 z-[80] w-64 border border-zinc-200 bg-white py-1 shadow-lg">
              <button type="button" onClick={() => void handleCompactSession()} className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-zinc-50"><Minimize2 size={15} className="mt-0.5 shrink-0 text-blue-600" /><span><b className="block text-xs text-zinc-800">{t('chat.compact')}</b><span className="mt-0.5 block text-[10px] text-zinc-500">{t('chat.compactDesc')}</span></span></button>
              <button type="button" onClick={() => void handleRestartSessionFresh()} className="flex w-full items-start gap-2 border-t border-zinc-100 px-3 py-2 text-left hover:bg-zinc-50"><RotateCcw size={15} className="mt-0.5 shrink-0 text-amber-600" /><span><b className="block text-xs text-zinc-800">{t('chat.restartFresh')}</b><span className="mt-0.5 block text-[10px] text-zinc-500">{t('chat.restartFreshDesc')}</span></span></button>
              <button
                type="button"
                onClick={() => {
                  setContextLimitError('')
                  setContextLimitDraft(String(sessionStats?.contextUsage?.contextWindow ?? ''))
                  setContextLimitEditing((editing) => !editing)
                }}
                className="flex w-full items-start gap-2 border-t border-zinc-100 px-3 py-2 text-left hover:bg-zinc-50"
              >
                <Ruler size={15} className="mt-0.5 shrink-0 text-emerald-600" />
                <span>
                  <b className="block text-xs text-zinc-800">{t('chat.contextLimit')}</b>
                  <span className="mt-0.5 block text-[10px] text-zinc-500">
                    {t('chat.contextLimitDesc')}
                    {sessionStats?.contextWindowStatus === 'custom' && sessionStats.contextWindowOverride != null && (
                      <b className="ml-1 text-emerald-600">{t('chat.contextLimitCurrent', { value: formatTokens(sessionStats.contextWindowOverride) })}</b>
                    )}
                  </span>
                </span>
              </button>
              {contextLimitEditing && (
                <div className="border-t border-zinc-100 px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    <input
                      autoFocus
                      value={contextLimitDraft}
                      onChange={(event) => {
                        setContextLimitDraft(event.target.value)
                        setContextLimitError('')
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') submitContextLimit()
                      }}
                      placeholder={t('chat.contextLimitPlaceholder')}
                      disabled={sessionActionBusy}
                      className="min-w-0 flex-1 rounded border border-zinc-300 px-2 py-1 text-xs outline-none focus:border-blue-500 disabled:opacity-60"
                    />
                    <button
                      type="button"
                      disabled={sessionActionBusy || !sessionInfo?.selectedModel}
                      onClick={submitContextLimit}
                      className="shrink-0 rounded bg-blue-600 px-2 py-1 text-[11px] text-white hover:bg-blue-500 disabled:opacity-40"
                    >
                      {t('common.save')}
                    </button>
                    {sessionStats?.contextWindowStatus === 'custom' && (
                      <button
                        type="button"
                        disabled={sessionActionBusy}
                        onClick={() => void handleSetContextLimit(null)}
                        className="shrink-0 rounded border border-zinc-300 px-2 py-1 text-[11px] text-zinc-600 hover:bg-zinc-100 disabled:opacity-40"
                      >
                        {t('chat.restoreAuto')}
                      </button>
                    )}
                  </div>
                  {contextLimitError
                    ? <p className="mt-1 text-[10px] text-red-600">{contextLimitError}</p>
                    : !sessionInfo?.selectedModel && <p className="mt-1 text-[10px] text-zinc-400">{t('chat.noModelSelected')}</p>}
                </div>
              )}
            </div>}
          </div>
          <span className="text-[11px] text-zinc-400">{t('chat.currentModel')}</span>
          <select
          value={selectedModelValue}
          onChange={(e) => {
            const parsed = JSON.parse(e.target.value) as [string, string]
            if (Array.isArray(parsed) && parsed.length === 2) {
              // 切换成功后立即刷新统计徽标，上下文上限同步到新模型（注册表/覆盖值/回退）
              void setModel(parsed[0], parsed[1]).then(() => refreshSessionStats())
            }
          }}
          className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700"
        >
          <option value="" disabled>
            {sessionInfo ? t('chat.selectModel') : t('common.loading')}
          </option>
          {sessionInfo?.selectedModel && !selectedModelAvailable && (
            <option value={selectedModelValue}>
              {sessionInfo.modelLabel || `${sessionInfo.selectedModel.providerId} / ${sessionInfo.selectedModel.modelId}`}{t('chat.modelRestored')}
            </option>
          )}
          {providers.flatMap((p) =>
            p.models.map((m) => (
              <option key={`${p.id} / ${m}`} value={JSON.stringify([p.id, m])}>
                {p.name} / {m}
              </option>
            ))
          )}
        </select>
        </div>
      </div>

      {/* 消息列表 */}
      <div className="chat-messages flex-1 overflow-y-auto p-4">
        {messages.length === 0 && !streaming && (
          <p className="mt-8 text-center text-sm text-zinc-400">
            {t('chat.emptyHint', { phase: phaseLabel(phase) })}
          </p>
        )}
        <div className="flex flex-col gap-3">
          {messages.map((m) => (
            <MessageBubble
              key={m.id}
              msg={m}
              decisionResponse={m.decisionRequest ? decisionResponses.get(m.decisionRequest.id) : undefined}
              decisionDisabled={streaming}
              onDecision={(request, selectedIds, customText) => {
                setDecisionDrafts((current) => ({ ...current, [request.id]: { selectedIds, customText } }))
              }}
              decisionDraft={m.decisionRequest ? decisionDrafts[m.decisionRequest.id] : undefined}
            />
          ))}
          {streaming && messages.at(-1)?.role !== 'assistant' && (
            <div className="text-sm text-zinc-400">{t('chat.thinking')}</div>
          )}
        </div>
        {pendingDecisions.length > 0 && (
          <div className="mt-3 flex items-center justify-between gap-3 rounded border border-blue-200 bg-blue-50 px-4 py-3">
            <span className="text-xs text-blue-800">
              {t('chat.pendingDecisions', { done: completedDraftCount, total: pendingDecisions.length })}
            </span>
            <button
              type="button"
              disabled={!allDecisionsReady || streaming}
              onClick={submitAllDecisions}
              className="rounded bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('chat.submitAllDecisions')}
            </button>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入区 */}
      <div className="chat-composer border-t border-zinc-200 p-3">
        <div className="flex w-full items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              setHistoryIndex(null)
              historyDraftRef.current = e.target.value
            }}
            onKeyDown={(e) => {
              if (!e.nativeEvent.isComposing && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
                const beforeCursor = e.currentTarget.value.slice(0, e.currentTarget.selectionStart)
                const afterCursor = e.currentTarget.value.slice(e.currentTarget.selectionEnd)
                const atFirstLine = !beforeCursor.includes('\n')
                const atLastLine = !afterCursor.includes('\n')
                if (e.key === 'ArrowUp' && (historyIndex !== null || !input || atFirstLine)) {
                  e.preventDefault()
                  recallInput('previous')
                  return
                }
                if (e.key === 'ArrowDown' && historyIndex !== null && atLastLine) {
                  e.preventDefault()
                  recallInput('next')
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            rows={2}
            placeholder={streaming ? t('chat.inputPlaceholderStreaming') : t('chat.inputPlaceholder')}
            disabled={streaming}
            className="flex-1 resize-none rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 outline-none focus:border-blue-500 disabled:opacity-60"
          />
          {streaming ? (
            <button
              onClick={() => void abort()}
              disabled={aborting}
              className="rounded border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
            >
              {aborting ? t('chat.aborting') : t('chat.abort')}
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {t('chat.send')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function MessageBubble({
  msg,
  decisionResponse,
  decisionDisabled,
  onDecision,
  decisionDraft
}: {
  msg: AgentUiMessage
  decisionResponse?: AgentDecisionResponse
  decisionDisabled: boolean
  onDecision: (request: AgentDecisionRequest, selectedIds: string[], customText: string) => void
  decisionDraft?: { selectedIds: string[]; customText: string }
}): React.JSX.Element {
  const { t, locale } = useTranslation()
  const thinkingRef = useRef<HTMLDetailsElement>(null)
  const [thinkingOpen, setThinkingOpen] = useState(true)
  const [toolOpen, setToolOpen] = useState(true)
  const time = new Date(msg.timestamp).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' })

  if (msg.role === 'user') {
    const displayText = msg.decisionResponse
      ? msg.text.split(/\r?\n/).filter((line) => !line.startsWith(DECISION_RESPONSE_PREFIX)).join('\n')
      : msg.text
    return (
      <div className="message-user self-end rounded-lg bg-blue-600 px-3 py-2 text-sm whitespace-pre-wrap text-white">
        <span className="block">{displayText}</span>
        <span className="mt-1 block text-right text-[10px] text-blue-100">{time}</span>
      </div>
    )
  }

  if (msg.role === 'tool') {
    if (msg.decisionRequest) {
      return (
        <DecisionCard
          request={msg.decisionRequest}
          response={decisionResponse}
          disabled={decisionDisabled}
          onSubmit={onDecision}
          draft={decisionDraft}
        />
      )
    }
    return (
      <details
        open={toolOpen}
        onToggle={(event) => setToolOpen(event.currentTarget.open)}
        className={`message-tool w-full rounded border px-3 py-1.5 text-xs ${msg.isError ? 'border-red-200 bg-red-50' : 'border-zinc-200 bg-zinc-50'}`}
      >
        <summary className="cursor-pointer text-zinc-600">
          🔧 {t('chat.toolCall')}<span className="font-mono">{msg.toolName ?? 'tool'}</span>
          {msg.isError ? (
            <span className="ml-2 text-red-600">{t('chat.toolFailed')}</span>
          ) : (
            <span className="ml-2 text-emerald-600">{t('chat.toolDone')}</span>
          )}
          <span className="ml-2 text-[10px] text-zinc-400">{time}</span>
        </summary>
        {msg.toolInput && (
          <div className="mt-2 border-t border-zinc-200 pt-2">
            <div className="mb-1 font-medium text-zinc-500">{t('chat.toolInputLabel')}</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-zinc-700">{msg.toolInput}</pre>
          </div>
        )}
        <div className="mt-2 border-t border-zinc-200 pt-2">
          <div className={`mb-1 font-medium ${msg.isError ? 'text-red-600' : 'text-zinc-500'}`}>
            {msg.isError ? t('chat.toolOutputError') : t('chat.toolOutput')}
          </div>
          <pre className={`max-h-56 overflow-auto whitespace-pre-wrap rounded bg-white p-2 ${msg.isError ? 'text-red-700' : 'text-zinc-700'}`}><FileReferenceText text={msg.text} /></pre>
        </div>
      </details>
    )
  }

  return (
    <div
      className={`message-assistant self-start rounded-lg border px-3 py-2 text-sm whitespace-pre-wrap ${
        msg.isError
          ? 'border-red-200 bg-red-50 text-red-700'
          : 'border-zinc-200 bg-white text-zinc-800'
      }`}
    >
      <FileReferenceText text={msg.text} />
      <span className="mt-1 block text-[10px] text-zinc-400">{time}</span>
      {msg.thinking && (
        <details
          ref={thinkingRef}
          open={thinkingOpen}
          className="mt-2 rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-500"
        >
          <summary
            className="cursor-pointer select-none"
            onClick={(e) => {
              // 用户手动点击时切换状态，不受 observer 覆盖
              e.preventDefault()
              setThinkingOpen((v) => !v)
            }}
          >
            {t('chat.thinkingProcess')} {thinkingOpen ? '▾' : '▸'}
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-zinc-600">{msg.thinking}</pre>
        </details>
      )}
    </div>
  )
}

function FileReferenceText({ text }: { text: string }): React.JSX.Element {
  const { t } = useTranslation()
  const pattern = new RegExp(`(${FILE_REFERENCE_SOURCE})`, 'g')
  const parts = text.split(pattern)
  return (
    <>
      {parts.map((part, index) => isFileReference(part) ? (
        <button
          key={`${part}-${index}`}
          type="button"
          className="font-mono text-blue-600 underline decoration-blue-300 underline-offset-2 hover:text-blue-800"
          title={t('chat.openFile')}
          onClick={() => window.dispatchEvent(new CustomEvent('moonglass-open-project-file', { detail: { path: part } }))}
        >
          {part}
        </button>
      ) : <span key={index}>{part}</span>)}
    </>
  )
}

function DecisionCard({
  request,
  response,
  disabled,
  onSubmit,
  draft
}: {
  request: AgentDecisionRequest
  response?: AgentDecisionResponse
  disabled: boolean
  onSubmit: (request: AgentDecisionRequest, selectedIds: string[], customText: string) => void
  draft?: { selectedIds: string[]; customText: string }
}): React.JSX.Element {
  const { t } = useTranslation()
  const [selectedIds, setSelectedIds] = useState<string[]>(response?.selectedIds ?? draft?.selectedIds ?? [])
  const [customText, setCustomText] = useState(response?.customText ?? draft?.customText ?? '')
  const [error, setError] = useState('')
  const locked = Boolean(response || draft)

  const toggle = (id: string): void => {
    if (locked || disabled) return
    setError('')
    setSelectedIds((current) => request.mode === 'single'
      ? [id]
      : current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  const submit = (): void => {
    if (request.required && selectedIds.length === 0 && !customText.trim()) {
      setError(t('chat.decision.requiredError'))
      return
    }
    onSubmit(request, selectedIds, customText.trim())
  }

  return (
    <section className="decision-card w-full max-w-2xl self-start overflow-hidden rounded-md border border-zinc-300 bg-white shadow-sm">
      <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-zinc-900">{request.title}</h3>
          <span className="shrink-0 text-xs text-zinc-500">{request.mode === 'single' ? t('chat.decision.single') : t('chat.decision.multiple')}</span>
        </div>
        {request.prompt && <p className="mt-1 text-xs leading-5 text-zinc-600">{request.prompt}</p>}
      </header>

      <div className="space-y-2 p-3">
        {request.options.map((option) => {
          const selected = selectedIds.includes(option.id)
          return (
            <label
              key={option.id}
              className={`flex cursor-pointer items-start gap-3 rounded border px-3 py-2.5 transition-colors ${
                selected ? 'border-blue-500 bg-blue-50' : 'border-zinc-200 hover:border-zinc-300 hover:bg-zinc-50'
              } ${locked || disabled ? 'cursor-default' : ''}`}
            >
              <input
                type={request.mode === 'single' ? 'radio' : 'checkbox'}
                name={`decision-${request.id}`}
                checked={selected}
                disabled={locked || disabled}
                onChange={() => toggle(option.id)}
                className="mt-0.5 h-4 w-4 accent-blue-600"
              />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-800">
                  {option.label}
                  {option.recommended && (
                    <span className="rounded-sm border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-normal text-emerald-700">{t('chat.decision.recommended')}</span>
                  )}
                </span>
                {option.description && <span className="mt-0.5 block text-xs leading-5 text-zinc-500">{option.description}</span>}
              </span>
            </label>
          )
        })}

        {request.allowCustom && (
          <label className="block pt-1">
            <span className="mb-1.5 block text-xs font-medium text-zinc-600">{request.customLabel ?? t('chat.decision.customLabel')}</span>
            <textarea
              rows={3}
              value={customText}
              disabled={locked || disabled}
              onChange={(event) => {
                setCustomText(event.target.value)
                setError('')
              }}
              placeholder={t('chat.decision.customPlaceholder')}
              className="w-full resize-y rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 outline-none focus:border-blue-500 disabled:bg-zinc-50 disabled:text-zinc-600"
            />
          </label>
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-xs text-zinc-500">
            {response ? t('chat.decision.submitted') : draft ? t('chat.decision.drafted') : disabled ? t('chat.decision.waitingAgent') : t('chat.decision.noImmediateTrigger')}
          </span>
          {!locked && (
            <button
              type="button"
              disabled={disabled}
              onClick={submit}
              className="rounded bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {t('chat.decision.complete')}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
