/**
 * Agent 对话面板（Phase 2）
 *
 * 工作区中部的聊天界面：消息列表（user/assistant/tool）+ 流式输出 +
 * 模型选择 + 输入区。会话由主进程 AgentService（Pi RPC 子进程）承载。
 */

import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { PHASE_LABELS, type LlmProviderConfig, type Phase } from '@shared/types'
import { useChatStore } from '../store/chatStore'

interface ChatPanelProps {
  projectId: string
  phase: Phase
}

export function ChatPanel({ projectId, phase }: ChatPanelProps): React.JSX.Element {
  const { sessionInfo, messages, streaming, ensure, send, abort, setModel } = useChatStore()
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
    <div className="flex h-full flex-col">
      {/* 头部：阶段 Agent + 模型选择 */}
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-2">
        <span className="text-sm font-medium text-zinc-700">
          🤖 {PHASE_LABELS[phase]}阶段 Agent
          {ensuring && <span className="ml-2 text-xs text-zinc-400">会话启动中…</span>}
        </span>
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

      {/* 消息列表 */}
      <div className="flex-1 overflow-y-auto p-4">
        {messages.length === 0 && !streaming && (
          <p className="mt-8 text-center text-sm text-zinc-400">
            向 {PHASE_LABELS[phase]}阶段 Agent 提问，开始本阶段的工作
          </p>
        )}
        <div className="mx-auto flex max-w-3xl flex-col gap-3">
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
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            rows={2}
            placeholder={streaming ? 'Agent 回复中…' : '输入消息，Enter 发送，Shift+Enter 换行'}
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
        <details className="mt-2 rounded border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-500">
          <summary className="cursor-pointer">🧠 思考过程</summary>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap text-zinc-600">{msg.thinking}</pre>
        </details>
      )}
    </div>
  )
}
