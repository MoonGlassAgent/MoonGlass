/**
 * 项目级"待人处理"聚合（项目卡片通知徽标的数据源，主进程侧）。
 *
 * 两路磁盘事实源：
 * - 会话待确认决策：扫描项目会话 JSONL 中的 MOONGLASS_DECISION_REQUEST /
 *   MOONGLASS_DECISION_RESPONSE 标记（@shared/agent-interaction 同口径解析），
 *   未答复的请求即待确认；
 * - 循环待裁决提案：verification/results/decision-ledger.json 中 status=proposed 的条目。
 *
 * 会话文件按 mtime 缓存扫描结果，只在变更后重扫（项目列表 3s 轮询下的成本控制）。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseDecisionRequest, parseDecisionResponses } from '@shared/agent-interaction'
import type { ProjectPendingActions } from '@shared/types'

/** tooltip 标题上限，避免长清单 */
const TITLE_LIMIT = 6

interface SessionScanCache {
  mtimeMs: number
  pending: Map<string, string>
}

const sessionScanCache = new Map<string, SessionScanCache>()

/** 解析消息内容中的文本块（string 或 content 数组两种形态） */
function messageTexts(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => {
    if (typeof block !== 'object' || block === null) return []
    const record = block as Record<string, unknown>
    return typeof record.text === 'string' ? [record.text] : []
  })
}

/** 扫描单个会话 JSONL，返回未答复的决策请求（id → title）。结果按 mtime 缓存。 */
export function scanSessionPendingDecisions(file: string): Map<string, string> {
  try {
    const mtimeMs = statSync(file).mtimeMs
    const cached = sessionScanCache.get(file)
    if (cached && cached.mtimeMs === mtimeMs) return cached.pending
    const pending = new Map<string, string>()
    for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
      if (!line.includes('MOONGLASS_DECISION_')) continue
      let entry: { type?: string; message?: { content?: unknown } }
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.type !== 'message' || !entry.message) continue
      for (const text of messageTexts(entry.message.content)) {
        const request = parseDecisionRequest(text)
        if (request) pending.set(request.id, request.title)
        for (const response of parseDecisionResponses(text)) pending.delete(response.requestId)
      }
    }
    sessionScanCache.set(file, { mtimeMs, pending })
    return pending
  } catch {
    return new Map()
  }
}

/** 聚合单个项目的待人处理项；无待处理项返回 null。 */
export function collectPendingActions(workspaceDir: string, sessionDir: string): ProjectPendingActions | null {
  const titles: string[] = []
  let decisionRequests = 0
  let loopDecisions = 0

  // 会话待确认决策（扫描全部会话文件；批次/修复/UT 等后台会话同样可能待人）
  try {
    if (existsSync(sessionDir)) {
      for (const name of readdirSync(sessionDir)) {
        if (!name.endsWith('.jsonl') || name.endsWith('.bak.jsonl')) continue
        const pending = scanSessionPendingDecisions(join(sessionDir, name))
        decisionRequests += pending.size
        for (const title of pending.values()) titles.push(title)
      }
    }
  } catch { /* 会话目录读取失败视为无待确认项 */ }

  // 验证运行循环待裁决提案
  try {
    const ledgerPath = join(workspaceDir, 'verification', 'results', 'decision-ledger.json')
    if (existsSync(ledgerPath)) {
      const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as { decisions?: Array<{ id?: string; status?: string; trigger?: string }> }
      for (const decision of ledger.decisions ?? []) {
        if (decision.status !== 'proposed') continue
        loopDecisions += 1
        titles.push(`${decision.id ?? 'DEC-?' }${decision.trigger ? `（${decision.trigger}）` : ''}`)
      }
    }
  } catch { /* 账本损坏视为无待裁决项 */ }

  if (decisionRequests + loopDecisions === 0) return null
  return { decisionRequests, loopDecisions, titles: titles.slice(0, TITLE_LIMIT) }
}
