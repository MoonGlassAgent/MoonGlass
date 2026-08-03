/**
 * Agent 对话面板（Phase 2）
 *
 * 工作区中部的聊天界面：消息列表（user/assistant/tool）+ 流式输出 +
 * 模型选择 + 输入区。会话由主进程 AgentService（Pi RPC 子进程）承载。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { PHASE_LABELS, type LlmProviderConfig, type Phase } from '@shared/types'
import { useChatStore } from '../store/chatStore'

interface SessionInfo {
  name: string
  file: string
  label: string
  messageCount: number
  isActive: boolean
}

interface ChatPanelProps {
  projectId: string
  phase: Phase
}

export function SessionTabs({ projectId }: { projectId: string }): React.JSX.Element {
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
          title={`${session.label}，${session.messageCount} 条消息`}
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

      {showDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
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
      )}
    </>
  )
}

export function ChatPanel({ projectId, phase }: ChatPanelProps): React.JSX.Element {
  const {
    sessionInfo,
    messages,
    streaming,
    ensure,
    send,
    abort,
    setModel
  } = useChatStore()
  const [input, setInput] = useState('')
  const [providers, setProviders] = useState<LlmProviderConfig[]>([])
  const [ensuring, setEnsuring] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setEnsuring(true)
    void ensure(projectId).finally(() => setEnsuring(false))
  }, [ensure, projectId, phase])

  useEffect(() => {
    void window.moonglass.llm.list().then((list) => setProviders(list.filter((p) => p.enabled && p.apiKey)))
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])


  const handleSend = (): void => {
    if (!input.trim() || streaming) return
    void send(input)
    setInput('')
  }

  // 未配置 Provider 的引导
  if (sessionInfo && !sessionInfo.providersReady) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-lg border border-dashed border-zinc-300 p-8 text-center text-zinc-500">
          <div className="mb-2 text-3xl">🤖</div>
          <p className="font-medium text-zinc-700">{PHASE_LABELS[phase]}阶段 Agent 已就绪</p>
          <p className="mt-2 text-sm">
            还没有可用的大模型 Provider。请先到
            <Link to="/settings" className="mx-1 text-blue-600 underline">
              设置 → 模型服务
            </Link>
            启用一个 Provider 并配置 API Key。
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
          {ensuring && <span className="text-xs text-zinc-400">会话启动中…</span>}

        </div>

        <div className="flex items-center gap-2">
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
            <MessageBubble key={m.id} msg={m} />
          ))}
          {streaming && messages.at(-1)?.role !== 'assistant' && (
            <div className="text-sm text-zinc-400">Agent 思考中…</div>
          )}
        </div>
        <div ref={bottomRef} />
      </div>

      {/* 输入区 */}
      <div className="chat-composer border-t border-zinc-200 p-3">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
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
              className="rounded border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50"
            >
              中止
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
  msg
}: {
  msg: {
    id: string
    role: 'user' | 'assistant' | 'tool'
    text: string
    toolName?: string
    isError?: boolean
    thinking?: string
  }
}): React.JSX.Element {
  if (msg.role === 'user') {
    return (
      <div className="message-user self-end rounded-lg bg-blue-600 px-3 py-2 text-sm whitespace-pre-wrap text-white">
        {msg.text}
      </div>
    )
  }

  if (msg.role === 'tool') {
    return (
      <details className="message-tool rounded border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs">
        <summary className="cursor-pointer text-zinc-500">
          🔧 工具调用：<span className="font-mono">{msg.toolName ?? 'tool'}</span>
          {msg.isError ? (
            <span className="ml-2 text-red-600">失败</span>
          ) : (
            <span className="ml-2 text-emerald-600">完成</span>
          )}
        </summary>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-zinc-600">{msg.text}</pre>
      </details>
    )
  }

  const thinkingRef = useRef<HTMLDetailsElement>(null)
  const [thinkingOpen, setThinkingOpen] = useState(false)

  // 智能折叠：当思考过程被新内容推至视口外时自动折叠
  useEffect(() => {
    const el = thinkingRef.current
    if (!el || !msg.thinking) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        // 被推出视口时自动折叠（不自动展开，留给用户手动点击）
        if (!entry.isIntersecting || entry.intersectionRatio < 0.3) {
          setThinkingOpen(false)
        }
      },
      { threshold: [0, 0.3] }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [msg.thinking, msg.id])

  return (
    <div
      className={`message-assistant self-start rounded-lg border px-3 py-2 text-sm whitespace-pre-wrap ${
        msg.isError
          ? 'border-red-200 bg-red-50 text-red-700'
          : 'border-zinc-200 bg-white text-zinc-800'
      }`}
    >
      {msg.text}
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
