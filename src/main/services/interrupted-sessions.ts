/**
 * 中断会话标记读写（纯函数，供冒烟脚本直接转译验证）。
 *
 * 应用退出（will-quit → stopAll 之前）把仍在运行的会话清单原子写入
 * userData/moonglass/interrupted-sessions.json；AgentService.start() 一次性
 * 消费（读取后随即删除文件），内存保留本轮，sessionActivity() 据此给项目
 * 卡片提供"上轮中断"徽标数据。会话历史在 pi 会话文件中完整保留，用户重启后
 * 在原会话继续输入即可续跑。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { renameSyncWithRetry } from './atomic-write.ts'
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
  // rename 走 EPERM/EBUSY 退避重试（Windows 杀毒瞬时持锁，见 atomic-write.ts）
  renameSyncWithRetry(tmpPath, filePath)
}

/**
 * 一次性消费中断会话清单：读取后随即删除文件；
 * 文件不存在或内容损坏时返回空数组（不阻断启动）。
 *
 * sessionsRootDir 提供时（pi-sessions 根目录），额外过滤掉会话 JSONL
 * 已不存在的中断记录——阶段 purge 会删除会话文件，不应再提示"上轮中断"。
 */
export function consumeInterruptedSessions(filePath: string, sessionsRootDir?: string): InterruptedSessionRecord[] {
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
    const records = parsed.filter(
      (item): item is InterruptedSessionRecord =>
        typeof item === 'object' && item !== null
        && typeof (item as InterruptedSessionRecord).projectId === 'string'
        && typeof (item as InterruptedSessionRecord).sessionName === 'string'
    )
    if (!sessionsRootDir) return records
    return records.filter((record) => {
      const fileName = record.sessionName === 'main' ? 'session.jsonl' : `session-${record.sessionName}.jsonl`
      return existsSync(join(sessionsRootDir, record.projectId, fileName))
    })
  } catch {
    return []
  }
}
