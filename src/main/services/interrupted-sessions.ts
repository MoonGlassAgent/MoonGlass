/**
 * 中断会话标记读写（纯函数，供冒烟脚本直接转译验证）。
 *
 * 应用退出（will-quit → stopAll 之前）把仍在运行的会话清单原子写入
 * userData/moonglass/interrupted-sessions.json；AgentService.start() 一次性
 * 消费（读取后随即删除文件），内存保留本轮，sessionActivity() 据此给项目
 * 卡片提供"上轮中断"徽标数据。会话历史在 pi 会话文件中完整保留，用户重启后
 * 在原会话继续输入即可续跑。
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Phase } from '@shared/types'

/** 单个被应用退出中断的会话记录 */
export interface InterruptedSessionRecord {
  projectId: string
  /** 会话展示名（PiSession.activeSessionName） */
  sessionName: string
  phase: Phase
  /** 中断时刻（ISO 时间串） */
  interruptedAt: string
}

/**
 * 原子写入中断会话清单（先写临时文件再 rename，避免退出途中留下半截 JSON）；
 * 无记录时不产生文件（正常无中断退出不落盘）。
 */
export function writeInterruptedSessions(filePath: string, records: InterruptedSessionRecord[]): void {
  if (records.length === 0) return
  mkdirSync(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp`
  writeFileSync(tmpPath, JSON.stringify(records, null, 2), 'utf-8')
  renameSync(tmpPath, filePath)
}

/**
 * 一次性消费中断会话清单：读取后随即删除文件；
 * 文件不存在或内容损坏时返回空数组（不阻断启动）。
 */
export function consumeInterruptedSessions(filePath: string): InterruptedSessionRecord[] {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch {
    return [] // 文件不存在：无上轮中断
  }
  rmSync(filePath, { force: true })
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // 逐条校验最小字段，损坏条目丢弃而不整体作废
    return parsed.filter(
      (item): item is InterruptedSessionRecord =>
        typeof item === 'object' && item !== null
        && typeof (item as InterruptedSessionRecord).projectId === 'string'
        && typeof (item as InterruptedSessionRecord).sessionName === 'string'
    )
  } catch {
    return []
  }
}
