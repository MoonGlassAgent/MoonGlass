/**
 * Agent 事件按会话路由（阶段切换不中断执行）
 *
 * 阶段切换后，切走的会话进程挂入 backgroundSessions 继续运行，
 * 其流式事件仍带原 sessionName 推送。渲染层据此把事件路由到
 * 当前活动会话的聊天面板：其他会话的流式事件一律忽略，
 * 仅放行 status 通知（如“XX 阶段的后台任务已完成”）。
 */

import type { AgentEventPayload } from './types/moonglass'

/** 事件是否应应用到当前活动会话的聊天面板 */
export function shouldApplyAgentEvent(
  payload: Pick<AgentEventPayload, 'sessionName' | 'event'>,
  activeSessionName: string | null | undefined
): boolean {
  if (!payload.sessionName || payload.sessionName === activeSessionName) return true
  return payload.event.type === 'status'
}

/** 是否为后台会话的通知（用于触发会话信息刷新，更新后台运行标记） */
export function isBackgroundSessionNotice(
  payload: Pick<AgentEventPayload, 'sessionName' | 'event'>,
  activeSessionName: string | null | undefined
): boolean {
  return Boolean(payload.sessionName)
    && payload.sessionName !== activeSessionName
    && payload.event.type === 'status'
}
