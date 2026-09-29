/**
 * 项目会话活动聚合（纯函数，供冒烟脚本直接打桩验证）。
 *
 * AgentService.sessionActivity 把前台 sessions 与后台 backgroundSessions
 * （VERIF 批次 / RTL 修复会话均挂在后者）投影成 SessionActivitySource
 * 后交给本模块聚合，项目列表页卡片徽标按 projectId 查询结果。
 */

import type { ProjectSessionActivity } from '@shared/types'

/** 单个存活会话的最小投影（前台/后台会话统一视图） */
export interface SessionActivitySource {
  projectId: string
  /** 会话展示名（PiSession.activeSessionName） */
  sessionName: string
  isStreaming: boolean
}

/**
 * 聚合各项目的会话活动：running = 任一会话流式中；同名会话去重；
 * 只输出有存活会话的项目（无会话的项目卡片不显示徽标）。
 */
export function aggregateSessionActivity(
  sessions: Iterable<SessionActivitySource>
): Record<string, ProjectSessionActivity> {
  const result: Record<string, ProjectSessionActivity> = {}
  for (const session of sessions) {
    let entry = result[session.projectId]
    if (!entry) {
      entry = { hasSession: true, running: false, runningSessions: [] }
      result[session.projectId] = entry
    }
    if (session.isStreaming) {
      entry.running = true
      if (!entry.runningSessions.includes(session.sessionName)) entry.runningSessions.push(session.sessionName)
    }
  }
  return result
}
