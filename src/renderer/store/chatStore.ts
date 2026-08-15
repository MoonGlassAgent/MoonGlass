/**
 * Agent 对话状态（zustand）
 *
 * 按项目维护消息列表与流式状态；订阅主进程 agent:event 推送，
 * 将流式 delta 累加到最后一条 assistant 消息。
 */

import { create } from 'zustand'
import type { AgentEventPayload, AgentSessionInfo, AgentStreamEvent, AgentUiMessage } from '@shared/types'
import { parseDecisionResponse, parseDecisionResponses } from '@shared/agent-interaction'

interface ChatState {
  projectId: string | null
  sessionInfo: AgentSessionInfo | null
  messages: AgentUiMessage[]
  streaming: boolean
  aborting: boolean
  /** 当前流式累加目标消息 id（text-delta 追加到这条消息上） */
  streamTargetId: string | null

  ensure: (projectId: string) => Promise<void>
  send: (text: string) => Promise<void>
  abort: () => Promise<void>
  setModel: (providerId: string, modelId: string) => Promise<void>
  createParallel: (name?: string) => Promise<void>
  switchSession: (name: string) => Promise<void>
  closeSession: (name: string) => Promise<void>
}

let eventSubscribed = false
let msgSeq = 0
let ensureSeq = 0
const nextId = (): string => `ui-${Date.now()}-${++msgSeq}`

export const useChatStore = create<ChatState>((set, get) => {
  const handleEvent = (payload: AgentEventPayload): void => {
    const { projectId } = get()
    if (payload.projectId !== projectId) return
    applyEvent(set, payload.event)
  }

  return {
    projectId: null,
    sessionInfo: null,
    messages: [],
    streaming: false,
    aborting: false,
    streamTargetId: null,

    ensure: async (projectId) => {
      const requestSeq = ++ensureSeq
      if (!eventSubscribed) {
        window.moonglass.agent.onEvent(handleEvent)
        eventSubscribed = true
      }
      if (get().projectId !== projectId) {
        set({ projectId, sessionInfo: null, messages: [], streaming: false, aborting: false, streamTargetId: null })
      } else if (get().sessionInfo?.providersReady === false) {
        // 配置刚变为可用时，立即移除旧的“未配置”提示；pi 启动期间展示加载状态。
        set({ sessionInfo: null })
      }
      let info: AgentSessionInfo
      try {
        info = await window.moonglass.agent.ensureSession(projectId)
      } catch (err) {
        if (requestSeq !== ensureSeq) return
        // 会话启动失败（如 pi 进程异常）：以错误气泡展示原因
        set({ projectId, sessionInfo: null, messages: [], streaming: false, streamTargetId: null })
        pushError(set, err)
        return
      }
      // Provider 配置变化或阶段切换可能触发并发初始化；旧请求不得覆盖新状态。
      if (requestSeq !== ensureSeq || get().projectId !== projectId) return
      if (!info.providersReady) {
        set({ projectId, sessionInfo: info, messages: [], streaming: false, streamTargetId: null })
        return
      }
      // 阶段切换后是新会话，历史以 pi 侧为准重新拉取
      let history: AgentUiMessage[] = []
      try {
        history = await window.moonglass.agent.getMessages(projectId)
      } catch (err) {
        if (requestSeq !== ensureSeq) return
        pushError(set, err)
      }
      if (requestSeq !== ensureSeq || get().projectId !== projectId) return
      set({
        projectId,
        sessionInfo: info,
        messages: history,
        streaming: info.isStreaming,
        streamTargetId: null
      })
    },

    send: async (text) => {
      const { projectId, streaming, sessionInfo } = get()
      if (!projectId || streaming || !text.trim()) return
      if (!sessionInfo?.providersReady) {
        pushError(set, new Error('会话尚未就绪，请稍候（若持续无响应请重新进入工作区）'))
        return
      }
      const userMsg: AgentUiMessage = {
        id: nextId(),
        role: 'user',
        text: text.trim(),
        timestamp: Date.now(),
        decisionResponse: parseDecisionResponse(text),
        decisionResponses: parseDecisionResponses(text)
      }
      set((s) => ({ messages: [...s.messages, userMsg], streaming: true, streamTargetId: null }))
      try {
        await window.moonglass.agent.prompt(projectId, text.trim())
      } catch (err) {
        if (!get().aborting) pushError(set, err)
      }
    },

    abort: async () => {
      const { projectId, aborting } = get()
      if (!projectId || aborting) return
      set({ aborting: true })
      try {
        await window.moonglass.agent.abort(projectId)
        set({ streaming: false, aborting: false, streamTargetId: null })
      } catch (error) {
        set({ aborting: false })
        pushError(set, error)
      }
    },

    setModel: async (providerId, modelId) => {
      const { projectId } = get()
      if (!projectId) return
      try {
        const info = await window.moonglass.agent.setModel(projectId, providerId, modelId)
        set({ sessionInfo: info })
      } catch (err) {
        // 切换失败（如进程内 Provider 注册表过期）：显示原因，下拉框回弹到原模型
        pushError(set, err)
      }
    },

    createParallel: async (name) => {
      const { projectId } = get()
      if (!projectId) return
      try {
        const info = await window.moonglass.agent.resetSession(projectId, name)
        const messages = await window.moonglass.agent.getMessages(projectId)
        set({ sessionInfo: info, messages, streaming: false, streamTargetId: null })
      } catch (err) {
        pushError(set, err)
        throw err
      }
    },

    switchSession: async (name) => {
      const { projectId } = get()
      if (!projectId) return
      try {
        const info = await window.moonglass.agent.switchSession(projectId, name)
        const messages = await window.moonglass.agent.getMessages(projectId)
        set({ sessionInfo: info, messages, streaming: info.isStreaming, streamTargetId: null })
      } catch (err) {
        pushError(set, err)
        throw err
      }
    },

    closeSession: async (name) => {
      const { projectId } = get()
      if (!projectId) return
      try {
        const info = await window.moonglass.agent.closeSession(projectId, name)
        const messages = await window.moonglass.agent.getMessages(projectId)
        set({ sessionInfo: info, messages, streaming: info.isStreaming, streamTargetId: null })
      } catch (err) {
        pushError(set, err)
        throw err
      }
    }
  }
})

type Set = (fn: (s: ChatState) => Partial<ChatState>) => void

function pushError(set: Set, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  set((s) => ({
    streaming: false,
    aborting: false,
    streamTargetId: null,
    messages: [
      ...s.messages,
      { id: nextId(), role: 'assistant', text: message, isError: true, timestamp: Date.now() }
    ]
  }))
}

function applyEvent(set: Set, event: AgentStreamEvent): void {
  switch (event.type) {
    case 'agent-start':
      set(() => ({ streaming: true, aborting: false, streamTargetId: null }))
      break

    case 'agent-settled':
      set(() => ({ streaming: false, aborting: false, streamTargetId: null }))
      break

    case 'text-delta':
      set((s) => {
        // 有累加目标则追加，否则新建 assistant 消息
        if (s.streamTargetId && s.messages.at(-1)?.id === s.streamTargetId) {
          const last = s.messages.at(-1)!
          return {
            messages: [...s.messages.slice(0, -1), { ...last, text: last.text + event.delta }]
          }
        }
        const msg: AgentUiMessage = {
          id: nextId(),
          role: 'assistant',
          text: event.delta,
          timestamp: Date.now()
        }
        return { messages: [...s.messages, msg], streamTargetId: msg.id }
      })
      break

    case 'thinking-delta':
      set((s) => {
        // 追加到当前流式目标 assistant 消息的 thinking 字段
        if (s.streamTargetId && s.messages.at(-1)?.id === s.streamTargetId && s.messages.at(-1)?.role === 'assistant') {
          const last = s.messages.at(-1)!
          return {
            messages: [
              ...s.messages.slice(0, -1),
              { ...last, thinking: (last.thinking ?? '') + event.delta }
            ]
          }
        }
        // 没有目标时新建 assistant 占位消息
        const msg: AgentUiMessage = {
          id: nextId(),
          role: 'assistant',
          text: '',
          thinking: event.delta,
          timestamp: Date.now()
        }
        return { messages: [...s.messages, msg], streamTargetId: msg.id }
      })
      break

    case 'tool-start':
      set((s) => ({
        streamTargetId: null,
        messages: [
          ...s.messages,
          {
            id: nextId(),
            role: 'tool',
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            toolInput: event.input,
            text: '执行中…',
            timestamp: Date.now()
          }
        ]
      }))
      break

    case 'tool-end':
      set((s) => {
        // 按 toolCallId 精确回填；兼容旧事件时才回退到工具名。
        const idx = [...s.messages]
          .reverse()
          .findIndex((m) => m.role === 'tool' && m.text === '执行中…' && (
            m.toolCallId ? m.toolCallId === event.toolCallId : m.toolName === event.toolName
          ))
        const output = event.output || (event.isError ? '（执行失败）' : '（无输出）')
        if (idx === -1) {
          return {
            messages: [
              ...s.messages,
              {
                id: nextId(),
                role: 'tool',
                toolName: event.toolName,
                toolCallId: event.toolCallId,
                text: output,
                isError: event.isError,
                timestamp: Date.now(),
                decisionRequest: event.decisionRequest
              }
            ]
          }
        }
        const realIdx = s.messages.length - 1 - idx
        const target = s.messages[realIdx]
        return {
          messages: [
            ...s.messages.slice(0, realIdx),
            { ...target, text: output, isError: event.isError, decisionRequest: event.decisionRequest },
            ...s.messages.slice(realIdx + 1)
          ]
        }
      })
      break

    case 'error':
      set((s) => ({
        streaming: false,
        streamTargetId: null,
        messages: [
          ...s.messages,
          {
            id: nextId(),
            role: 'assistant',
            text: event.message,
            isError: true,
            timestamp: Date.now()
          }
        ]
      }))
      break
  }
}
