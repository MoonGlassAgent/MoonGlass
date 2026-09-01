/**
 * Pi 会话 JSONL 的只读解析（VERIF 批次可观测性）。
 *
 * 独立成模块以便冒烟测试在纯 Node 下直接 import（不拉入 electron 依赖）：
 * AgentService.getMessages / getSessionMessages 共用此解析，
 * 只读窥视不 attach、不切换会话、不 spawn 进程。
 */

import { existsSync, readFileSync } from 'node:fs'

/** pi 消息（仅声明映射所需的最小形状） */
export interface PiMessage {
  role: string
  content?: unknown
  toolName?: string
  toolCallId?: string
  isError?: boolean
  stopReason?: string
  errorMessage?: string
  command?: string
  output?: string
  timestamp?: number
}

/** 只读解析 Session JSONL 中的消息条目；文件不存在返回空数组，流式写入的残缺末行跳过。 */
export function readPiSessionMessages(sessionFile: string): PiMessage[] {
  if (!existsSync(sessionFile)) return []
  const messages: PiMessage[] = []
  for (const line of readFileSync(sessionFile, 'utf-8').split(/\r?\n/)) {
    if (!line.includes('"type":"message"')) continue
    try {
      const entry = JSON.parse(line) as { type?: string; message?: PiMessage }
      if (entry.type === 'message' && entry.message) messages.push(entry.message)
    } catch {
      // 流式写入时末行可能尚未完整，忽略后等待下一次读取。
    }
  }
  return messages
}
