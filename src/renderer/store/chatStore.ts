/**
 * Agent 对话状态（zustand）
 *
 * 按项目维护消息列表与流式状态；订阅主进程 agent:event 推送，
 * 将流式 delta 累加到最后一条 assistant 消息。
 */

import { create } from 'zustand'
import type { AgentEventPayload, AgentSessionInfo, AgentStreamEvent, AgentUiMessage } from '@shared/types'
import { parseDecisionResponse, parseDecisionResponses } from '@shared/agent-interaction'
import { isBackgroundSessionNotice, shouldApplyAgentEvent } from '@shared/agent-event-routing'

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
  /** 发送并等待该轮 Agent settled；失败向调用方抛出，供托管执行屏障使用。 */
  sendAndWait: (text: string) => Promise<void>
  abort: () => Promise<void>
  setModel: (providerId: string, modelId: string) => Promise<void>
  createParallel: (name?: string) => Promise<void>
  /** 开启任务粒度会话（M1）：新任务会话成为前台，零历史继承。title 为任务标题。 */
  startTask: (title?: string) => Promise<void>
  /** 上下文占用引导动作（M2 §3.3）：压缩当前会话保留摘要后，以同主题开新任务会话。 */
  finishAndStartTask: () => Promise<void>
  compactSession: () => Promise<void>
  restartSessionFresh: () => Promise<void>
  /** 阶段 purge 后仅清空前端状态；下一次输入时再懒启动空白会话。 */
  clearAfterPhasePurge: () => void
  switchSession: (name: string) => Promise<void>
  closeSession: (name: string) => Promise<void>
}

let eventSubscribed = false
let msgSeq = 0
let ensureSeq = 0
const nextId = (): string => `ui-${Date.now()}-${++msgSeq}`
const MAX_LIVE_MESSAGES = 320
const MAX_STREAM_CHARS = 120_000
const trimMessages = (messages: AgentUiMessage[]): AgentUiMessage[] => messages.length > MAX_LIVE_MESSAGES
  ? messages.slice(-MAX_LIVE_MESSAGES)
  : messages
const appendStream = (current: string, delta: string): string => {
  const combined = current + delta
  return combined.length > MAX_STREAM_CHARS
    ? `…（较早的流式内容已折叠，完整内容保存在 Session 中）\n${combined.slice(-MAX_STREAM_CHARS)}`
    : combined
}

export const useChatStore = create<ChatState>((set, get) => {
  const handleEvent = (payload: AgentEventPayload): void => {
    const { projectId, sessionInfo } = get()
    if (payload.projectId !== projectId) return
    // 事件按会话路由：只有当前活动会话的流式事件进入聊天面板；
    // 切走后仍在后台运行的会话（阶段切换挂后台、VERIF 批次）只放行 status 通知。
    if (!shouldApplyAgentEvent(payload, sessionInfo?.sessionName)) return
    applyEvent(set, payload.event)
    // 后台会话的 status 通知（如"XX 阶段的后台任务已完成"）：
    // 顺带刷新会话信息，让阶段栏的后台运行标记及时消失
    if (isBackgroundSessionNotice(payload, sessionInfo?.sessionName)) {
      window.moonglass.agent.ensureSession(projectId)
        .then((info) => { if (get().projectId === projectId) set({ sessionInfo: info }) })
        .catch(() => undefined)
    }
  }

  const dispatchPrompt = async (text: string, propagateError: boolean): Promise<void> => {
    let { projectId, streaming, sessionInfo } = get()
    if (!projectId) throw new Error('Agent 会话尚未关联项目')
    if (streaming) throw new Error('Agent 仍在处理上一轮任务')
    if (!text.trim()) return
    if (!sessionInfo) {
      sessionInfo = await window.moonglass.agent.ensureSession(projectId)
      if (sessionInfo.providersReady) {
        const history = await window.moonglass.agent.getMessages(projectId)
        set({ sessionInfo, messages: history, streaming: false, streamTargetId: null })
      }
    } else {
      // 发送前强制对齐会话阶段指纹：阶段可能刚被一键托管等流程推进，
      // ensureSession 幂等——阶段未变是廉价校验，阶段已变会切换到目标阶段会话
      const aligned = await window.moonglass.agent.ensureSession(projectId)
      if (aligned.sessionName !== sessionInfo.sessionName || aligned.phase !== sessionInfo.phase) {
        const history = aligned.providersReady ? await window.moonglass.agent.getMessages(projectId) : []
        set({ sessionInfo: aligned, messages: history, streaming: false, streamTargetId: null })
        sessionInfo = aligned
      }
    }
    if (!sessionInfo?.providersReady) throw new Error('会话尚未就绪，请稍候（若持续无响应请重新进入工作区）')
    const userMsg: AgentUiMessage = {
      id: nextId(), role: 'user', text: text.trim(), timestamp: Date.now(),
      decisionResponse: parseDecisionResponse(text), decisionResponses: parseDecisionResponses(text)
    }
    set((s) => ({ messages: trimMessages([...s.messages, userMsg]), streaming: true, streamTargetId: null }))
    try {
      await window.moonglass.agent.prompt(projectId, text.trim())
    } catch (err) {
      // 主进程的 error 事件通常已写入消息；仅在事件尚未到达时补充一次。
      if (!get().aborting && get().streaming) pushError(set, err)
      if (propagateError) throw err
    }
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
      try { await dispatchPrompt(text, false) } catch (error) {
        if (!get().aborting) pushError(set, error)
      }
    },
    sendAndWait: async (text) => dispatchPrompt(text, true),

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

    startTask: async (title) => {
      const { projectId } = get()
      if (!projectId) return
      try {
        const info = await window.moonglass.agent.startTask(projectId, title ? { title } : undefined)
        // 任务会话零历史继承；旧会话若正在流式已 park 到后台，前台不再是流式状态
        set({ sessionInfo: info, messages: [], streaming: false, aborting: false, streamTargetId: null })
      } catch (err) {
        pushError(set, err)
        throw err
      }
    },

    finishAndStartTask: async () => {
      const { projectId, streaming } = get()
      if (!projectId || streaming) return
      try {
        // 标题沿用当前会话标签，去掉尾部 " (PHASE)" 后缀；阶段主会话不带任务主题，不传标题
        const sessions = await window.moonglass.agent.listSessions(projectId).catch(() => [])
        const active = sessions.find((session) => session.isActive)
        const title = active && active.name !== 'main'
          ? active.label.replace(/\s*\([A-Z_]+\)\s*$/, '').trim() || undefined
          : undefined
        // 任一步失败即中止后续步骤：压缩失败不开新会话，错误经 pushError 上报
        await window.moonglass.agent.compactSession(projectId)
        const info = await window.moonglass.agent.startTask(projectId, title ? { title } : undefined)
        // 任务会话零历史继承；新会话成为前台
        set({ sessionInfo: info, messages: [], streaming: false, aborting: false, streamTargetId: null })
      } catch (err) {
        pushError(set, err)
        throw err
      }
    },

    compactSession: async () => {
      const { projectId, streaming } = get()
      if (!projectId || streaming) return
      try {
        const info = await window.moonglass.agent.compactSession(projectId)
        const messages = await window.moonglass.agent.getMessages(projectId)
        set({ sessionInfo: info, messages, streaming: false, streamTargetId: null })
      } catch (err) {
        pushError(set, err)
        throw err
      }
    },

    restartSessionFresh: async () => {
      const { projectId, streaming } = get()
      if (!projectId || streaming) return
      try {
        const info = await window.moonglass.agent.restartSessionFresh(projectId)
        set({ sessionInfo: info, messages: [], streaming: false, aborting: false, streamTargetId: null })
      } catch (err) {
        pushError(set, err)
        throw err
      }
    },

    clearAfterPhasePurge: () => {
      ++ensureSeq
      set({ sessionInfo: null, messages: [], streaming: false, aborting: false, streamTargetId: null })
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
    messages: trimMessages([
      ...s.messages,
      { id: nextId(), role: 'assistant', text: message, isError: true, timestamp: Date.now() }
    ])
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
            messages: [...s.messages.slice(0, -1), { ...last, text: appendStream(last.text, event.delta) }]
          }
        }
        const msg: AgentUiMessage = {
          id: nextId(),
          role: 'assistant',
          text: event.delta,
          timestamp: Date.now()
        }
        return { messages: trimMessages([...s.messages, msg]), streamTargetId: msg.id }
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
              { ...last, thinking: appendStream(last.thinking ?? '', event.delta) }
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
        return { messages: trimMessages([...s.messages, msg]), streamTargetId: msg.id }
      })
      break

    case 'tool-start':
      set((s) => ({
        streamTargetId: null,
        messages: trimMessages([
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
        ])
      }))
      break

    case 'tool-update':
      set((s) => {
        // 长耗时工具的中间进度：按 toolCallId 回填到对应“执行中…”卡片
        const idx = [...s.messages]
          .reverse()
          .findIndex((m) => m.role === 'tool' && (m.toolCallId ? m.toolCallId === event.toolCallId : m.toolName === event.toolName))
        if (idx === -1) return {}
        const realIdx = s.messages.length - 1 - idx
        const target = s.messages[realIdx]
        const base = target.text && target.text !== '执行中…' ? target.text : ''
        const next = base ? `${base}\n${event.text}` : (event.text || '执行中…')
        return {
          messages: [
            ...s.messages.slice(0, realIdx),
            { ...target, text: next },
            ...s.messages.slice(realIdx + 1)
          ]
        }
      })
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
            messages: trimMessages([
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
            ])
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

    case 'status':
      set((s) => ({
        messages: trimMessages([
          ...s.messages,
          {
            id: nextId(),
            role: 'assistant',
            text: event.message,
            timestamp: Date.now()
          }
        ])
      }))
      break

    case 'error':
      set((s) => ({
        streaming: false,
        streamTargetId: null,
        messages: trimMessages([
          ...s.messages,
          {
            id: nextId(),
            role: 'assistant',
            text: event.message,
            isError: true,
            timestamp: Date.now()
          }
        ])
      }))
      break
  }
}
