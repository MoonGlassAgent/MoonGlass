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

export function ChatPanel({ projectId, phase }: ChatPanelProps): React.JSX.Element {
  const { sessionInfo, messages, streaming, ensure, send, abort, setModel, reset } = useChatStore()
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

  const [allSessions, setAllSessions] = useState<SessionInfo[]>([])

  // 加载会话列表
  const refreshSessions = useCallback(async () => {
    try {
      const list = await window.moonglass.agent.listSessions(projectId)
      setAllSessions(list)
    } catch { /* 忽略 */ }
  }, [projectId])

  useEffect(() => {
    if (sessionInfo?.providersReady) void refreshSessions()
  }, [sessionInfo?.providersReady, sessionInfo?.selectedModel, refreshSessions])

  return (
    <div className="flex h-full flex-col">
      {/* 头部：阶段 Agent + 会话选择 + 模型选择 */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-zinc-700">
            🤖 {PHASE_LABELS[phase]}阶段 Agent
          </span>
          {ensuring && <span className="text-xs text-zinc-400">会话启动中…</span>}

          {/* 平行会话切换 */}
          {allSessions.length > 1 && (
            <select
              value={allSessions.find((s) => s.isActive)?.name ?? ''}
              onChange={async (e) => {
                const name = e.target.value
                if (name && name !== '_active') {
                  try {
                    await window.moonglass.agent.switchSession(projectId, name)
                    await refreshSessions()
                    window.location.reload()
                  } catch (err) {
                    console.error('切换会话失败', err)
                  }
                }
              }}
              className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs text-zinc-600 max-w-32"
              title="切换会话"
            >
              {allSessions.map((s) => (
                <option key={s.name} value={s.isActive ? '_active' : s.name}>
                  {s.isActive ? '📌 ' : '🔄 '}{s.label} ({s.messageCount}条)
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              const name = prompt('新会话名称（可选，留空自动命名）：', 'review')
              const sessionName = name?.trim() || undefined
              try {
                await window.moonglass.agent.resetSession(projectId, sessionName)
                await refreshSessions()
                window.location.reload()
              } catch (err) {
                console.error('创建新会话失败', err)
              }
            }}
            title="创建平行会话（不关闭当前会话，新会话独立并行）"
            className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 whitespace-nowrap"
          >
            ＋ 平行会话
          </button>
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
      <div className="flex-1 overflow-y-auto p-4">
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
      <div className="border-t border-zinc-200 p-3">
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
      <div className="self-end rounded-lg bg-blue-600 px-3 py-2 text-sm whitespace-pre-wrap text-white">
        {msg.text}
      </div>
    )
  }

  if (msg.role === 'tool') {
    return (
      <details className="rounded border border-zinc-200 bg-zinc-50 px-3 py-1.5 text-xs">
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
      className={`self-start rounded-lg border px-3 py-2 text-sm whitespace-pre-wrap ${
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
