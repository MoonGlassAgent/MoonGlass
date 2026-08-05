/**
 * Agent 对话面板（Phase 2）
 *
 * 工作区中部的聊天界面：消息列表（user/assistant/tool）+ 流式输出 +
 * 模型选择 + 输入区。会话由主进程 AgentService（Pi RPC 子进程）承载。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '@tanstack/react-router'
import { PHASE_LABELS, type AgentDecisionRequest, type AgentDecisionResponse, type AgentUiMessage, type LlmProviderConfig, type Phase } from '@shared/types'
import { DECISION_RESPONSE_PREFIX, serializeDecisionResponse } from '@shared/agent-interaction'
import { useChatStore } from '../store/chatStore'

interface SessionInfo {
  name: string
  file: string
  label: string
  messageCount: number
  modelLabel: string
  selectedModel: { providerId: string; modelId: string } | null
  isActive: boolean
}

interface ChatPanelProps {
  projectId: string
  phase: Phase
}

export function SessionTabs({ projectId, onActivate }: { projectId: string; onActivate?: () => void }): React.JSX.Element {
  const { sessionInfo, createParallel, switchSession, closeSession } = useChatStore()
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [showDialog, setShowDialog] = useState(false)
  const [name, setName] = useState('review')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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
      await createParallel(name.trim() || undefined)
      await refresh()
      onActivate?.()
      setShowDialog(false)
      setName('review')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }

  const close = async (session: SessionInfo): Promise<void> => {
    if (busy || session.name === 'main') return
    if (!window.confirm(`确认关闭平行会话“${session.label}”？\n\n该会话的聊天历史将被删除。`)) return
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
          title={`${session.label}，${session.messageCount} 条消息${session.modelLabel ? `，模型 ${session.modelLabel}` : '，尚未选择模型'}`}
          className={`flex max-w-48 shrink-0 items-center rounded-t border-x border-t text-xs ${
            session.isActive
              ? 'border-blue-300 bg-blue-50 font-medium text-blue-700'
              : 'border-transparent text-zinc-500 hover:bg-zinc-50 hover:text-zinc-800'
          }`}
        >
          <button
            type="button"
            disabled={busy}
            onClick={() => void select(session.name)}
            className="min-w-0 truncate px-3 py-1.5 disabled:opacity-50"
          >
            {session.name === 'main' ? '主会话' : session.label.replace(/\s*\([^)]*\)$/, '')}
            <span className="ml-1 max-w-24 truncate text-[10px] font-normal opacity-60">
              {session.modelLabel || '未选模型'}
            </span>
          </button>
          {session.name !== 'main' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void close(session)}
              aria-label={`关闭会话 ${session.label}`}
              title="关闭会话"
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
        title="新建独立的平行会话"
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
            <h2 id="parallel-session-title" className="text-sm font-semibold text-zinc-900">新建平行会话</h2>
            <p className="mt-1 text-xs text-zinc-500">新会话属于当前项目，拥有独立的消息历史。</p>
            <input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create()
                if (event.key === 'Escape' && !busy) setShowDialog(false)
              }}
              placeholder="会话名称（可留空）"
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
                取消
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void create()}
                className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
              >
                {busy ? '创建中…' : '创建'}
              </button>
            </div>
          </div>
        </div>
      ), document.body)}
    </>
  )
}

export function ChatPanel({ projectId, phase }: ChatPanelProps): React.JSX.Element {
  const {
    sessionInfo,
    messages,
    streaming,
    aborting,
    ensure,
    send,
    abort,
    setModel
  } = useChatStore()
  const [input, setInput] = useState('')
  const [providers, setProviders] = useState<LlmProviderConfig[]>([])
  const [providerHint, setProviderHint] = useState('')
  const [ensuring, setEnsuring] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

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
      ? '检测到已保存但尚未启用的模型服务。请在设置中打开“启用”开关。'
      : '还没有可用的大模型 Provider。请配置 API Key、模型 ID，并启用该 Provider。')
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


  const handleSend = (): void => {
    if (!input.trim() || streaming) return
    void send(input)
    setInput('')
  }

  const decisionResponses = new Map(
    messages
      .filter((message): message is AgentUiMessage & { decisionResponse: AgentDecisionResponse } => Boolean(message.decisionResponse))
      .map((message) => [message.decisionResponse.requestId, message.decisionResponse])
  )

  // 未配置 Provider 的引导
  if (sessionInfo && !sessionInfo.providersReady) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-dashed border-zinc-300 p-8 text-center text-zinc-500">
          <div className="mb-2 text-3xl">🤖</div>
          <p className="font-medium text-zinc-700">{PHASE_LABELS[phase]}阶段 Agent 已就绪</p>
          <p className="mt-2 text-sm">{providerHint || '正在读取模型服务配置…'}</p>
          <p className="mt-1 text-sm">
            前往
            <Link to="/settings" className="mx-1 text-blue-600 underline">
              设置 → 模型服务
            </Link>
            管理 Provider 配置。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="chat-surface flex h-full flex-col">
      {/* 头部：阶段 Agent + 会话选择 + 模型选择 */}
      <div className="chat-toolbar flex items-center justify-between border-b border-zinc-200 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-700">
            🤖 {PHASE_LABELS[phase]}阶段 Agent
          </span>
          {sessionInfo && (
            <span className="text-xs text-zinc-400">
              · {sessionInfo.sessionName === 'main' ? '主会话' : sessionInfo.sessionName}
            </span>
          )}
          {ensuring && <span className="text-xs text-zinc-400">会话启动中…</span>}
          {!ensuring && (
            <span className={`text-xs ${streaming ? 'text-amber-600' : 'text-emerald-600'}`}>
              {streaming ? '运行中' : '已就绪'}
            </span>
          )}

        </div>

        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-400">当前会话模型</span>
          <select
          value={sessionInfo?.selectedModel ? JSON.stringify([sessionInfo.selectedModel.providerId, sessionInfo.selectedModel.modelId]) : ''}
          onChange={(e) => {
            const parsed = JSON.parse(e.target.value) as [string, string]
            if (Array.isArray(parsed) && parsed.length === 2) {
              void setModel(parsed[0], parsed[1])
            }
          }}
          className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-700"
        >
          <option value="" disabled>
            {sessionInfo ? '选择模型…' : '加载中…'}
          </option>
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
            向 {PHASE_LABELS[phase]}阶段 Agent 提问，开始本阶段的工作
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
                void send(serializeDecisionResponse(request, selectedIds, customText))
              }}
            />
          ))}
          {streaming && messages.at(-1)?.role !== 'assistant' && (
            <div className="text-sm text-zinc-400">Agent 思考中…</div>
          )}
        </div>
        <div ref={bottomRef} />
      </div>

      {/* 输入区 */}
      <div className="chat-composer border-t border-zinc-200 p-3">
        <div className="flex w-full items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            rows={2}
            placeholder={streaming ? 'Agent 回复中…' : '输入消息，Enter 发送，Ctrl/Alt/Shift+Enter 换行'}
            disabled={streaming}
            className="flex-1 resize-none rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 outline-none focus:border-blue-500 disabled:opacity-60"
          />
          {streaming ? (
            <button
              onClick={() => void abort()}
              disabled={aborting}
              className="rounded border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
            >
              {aborting ? '正在中止…' : '中止'}
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim()}
              className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
            >
              发送
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
  onDecision
}: {
  msg: AgentUiMessage
  decisionResponse?: AgentDecisionResponse
  decisionDisabled: boolean
  onDecision: (request: AgentDecisionRequest, selectedIds: string[], customText: string) => void
}): React.JSX.Element {
  const thinkingRef = useRef<HTMLDetailsElement>(null)
  const [thinkingOpen, setThinkingOpen] = useState(true)
  const [toolOpen, setToolOpen] = useState(true)
  const time = new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

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
          🔧 工具调用：<span className="font-mono">{msg.toolName ?? 'tool'}</span>
          {msg.isError ? (
            <span className="ml-2 text-red-600">失败</span>
          ) : (
            <span className="ml-2 text-emerald-600">完成</span>
          )}
          <span className="ml-2 text-[10px] text-zinc-400">{time}</span>
        </summary>
        {msg.toolInput && (
          <div className="mt-2 border-t border-zinc-200 pt-2">
            <div className="mb-1 font-medium text-zinc-500">调用参数</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-zinc-700">{msg.toolInput}</pre>
          </div>
        )}
        <div className="mt-2 border-t border-zinc-200 pt-2">
          <div className={`mb-1 font-medium ${msg.isError ? 'text-red-600' : 'text-zinc-500'}`}>
            {msg.isError ? '失败原因 / 工具输出' : '工具输出'}
          </div>
          <pre className={`max-h-56 overflow-auto whitespace-pre-wrap rounded bg-white p-2 ${msg.isError ? 'text-red-700' : 'text-zinc-700'}`}>{msg.text}</pre>
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
      {msg.text}
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
            🧠 思考过程 {thinkingOpen ? '▾' : '▸'}
          </summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-zinc-600">{msg.thinking}</pre>
        </details>
      )}
    </div>
  )
}

function DecisionCard({
  request,
  response,
  disabled,
  onSubmit
}: {
  request: AgentDecisionRequest
  response?: AgentDecisionResponse
  disabled: boolean
  onSubmit: (request: AgentDecisionRequest, selectedIds: string[], customText: string) => void
}): React.JSX.Element {
  const [selectedIds, setSelectedIds] = useState<string[]>(response?.selectedIds ?? [])
  const [customText, setCustomText] = useState(response?.customText ?? '')
  const [error, setError] = useState('')
  const locked = Boolean(response)

  const toggle = (id: string): void => {
    if (locked || disabled) return
    setError('')
    setSelectedIds((current) => request.mode === 'single'
      ? [id]
      : current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  const submit = (): void => {
    if (request.required && selectedIds.length === 0 && !customText.trim()) {
      setError('请选择至少一个方案，或填写自己的要求。')
      return
    }
    onSubmit(request, selectedIds, customText)
  }

  return (
    <section className="decision-card w-full max-w-2xl self-start overflow-hidden rounded-md border border-zinc-300 bg-white shadow-sm">
      <header className="border-b border-zinc-200 bg-zinc-50 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-zinc-900">{request.title}</h3>
          <span className="shrink-0 text-xs text-zinc-500">{request.mode === 'single' ? '单选' : '多选'}</span>
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
                    <span className="rounded-sm border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-normal text-emerald-700">推荐</span>
                  )}
                </span>
                {option.description && <span className="mt-0.5 block text-xs leading-5 text-zinc-500">{option.description}</span>}
              </span>
            </label>
          )
        })}

        {request.allowCustom && (
          <label className="block pt-1">
            <span className="mb-1.5 block text-xs font-medium text-zinc-600">{request.customLabel ?? '补充你的要求（可选）'}</span>
            <textarea
              rows={3}
              value={customText}
              disabled={locked || disabled}
              onChange={(event) => {
                setCustomText(event.target.value)
                setError('')
              }}
              placeholder="可以补充预设选项之外的方案、限制条件或偏好"
              className="w-full resize-y rounded border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-800 outline-none focus:border-blue-500 disabled:bg-zinc-50 disabled:text-zinc-600"
            />
          </label>
        )}

        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex items-center justify-between gap-3 pt-1">
          <span className="text-xs text-zinc-500">
            {locked ? '该决策已提交并记录到当前会话' : disabled ? '等待 Agent 完成本轮回复' : '选择结果将继续发送给当前 Agent'}
          </span>
          {!locked && (
            <button
              type="button"
              disabled={disabled}
              onClick={submit}
              className="rounded bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              确认选择
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
