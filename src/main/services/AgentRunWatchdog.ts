import type { Phase } from '@shared/types'

export interface WatchdogAction {
  level: 'steer' | 'abort'
  reason: string
  instruction: string
}

export function isTruncatedWithoutToolCall(messages: Array<{
  role: string
  stopReason?: string
  content?: unknown
}>): boolean {
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant')
  if (!assistant || assistant.stopReason !== 'length') return false
  const blocks = Array.isArray(assistant.content)
    ? assistant.content as Array<{ type?: string }>
    : []
  return !blocks.some((block) => block.type === 'toolCall')
}

interface ToolCallState {
  toolName: string
  target: string
}

const normalizeTarget = (input: unknown): string => {
  if (!input || typeof input !== 'object') return ''
  const args = input as Record<string, unknown>
  const direct = args.path ?? args.filePath ?? args.file_path
  if (typeof direct === 'string') return direct.replace(/\\/g, '/').toLowerCase()
  if (typeof args.command !== 'string') return ''
  const match = args.command.replace(/\\/g, '/').match(/(?:[a-z]:)?[^\s"']+\.(?:md|json|ya?ml|v|sv|py|tcl|sdc)/i)
  return match?.[0]?.toLowerCase() ?? ''
}

/**
 * 单轮 Agent 工具活动守护。它不按 wall-clock 或仿真周期武断限时，只识别
 * 工具调用失控、同文件重复读取和精确编辑连续失败这三类明确退化信号。
 */
export class AgentRunWatchdog {
  private readonly activeCalls = new Map<string, ToolCallState>()
  private readonly readsByTarget = new Map<string, number>()
  private readonly failedEditsByTarget = new Map<string, number>()
  private toolCalls = 0
  private toolsSinceProgress = 0
  private steeredForReads = new Set<string>()
  private steeredForEdits = new Set<string>()
  private steeredForNoProgress = false
  private steeredForBudget = false
  private aborted = false

  constructor(private readonly phase: Phase) {}

  start(toolCallId: string, toolName: string, args: unknown): WatchdogAction | null {
    const target = normalizeTarget(args)
    this.activeCalls.set(toolCallId, { toolName, target })
    this.toolCalls += 1
    this.toolsSinceProgress += 1

    if (toolName === 'read' && target) {
      const count = (this.readsByTarget.get(target) ?? 0) + 1
      this.readsByTarget.set(target, count)
      if (count >= 12 && !this.steeredForReads.has(target)) {
        this.steeredForReads.add(target)
        return {
          level: 'steer',
          reason: `同一文件已读取 ${count} 次：${target}`,
          instruction: '停止分页反复读取该文件。一次性读取完成目标章节或全文，形成修改计划后只执行一次章节级或文件级修改；修改后立即运行现有检查器。'
        }
      }
    }

    const softBudget = this.phase === 'REQ_SPEC' || this.phase === 'ARCH' ? 80 : 180
    const hardBudget = this.phase === 'REQ_SPEC' || this.phase === 'ARCH' ? 160 : 360
    if (this.toolCalls >= hardBudget) return this.abort(`本轮工具调用达到硬上限 ${hardBudget}`)
    if (this.toolCalls >= softBudget && !this.steeredForBudget) {
      this.steeredForBudget = true
      return {
        level: 'steer',
        reason: `本轮工具调用已达 ${this.toolCalls} 次`,
        instruction: '进入收敛模式：停止非必要润色、重复列举和 Git 初始化。只处理尚未通过的明确门禁；修复后立即复检，通过即结束本轮。'
      }
    }
    if (this.toolsSinceProgress >= 40 && !this.steeredForNoProgress) {
      this.steeredForNoProgress = true
      return {
        level: 'steer',
        reason: `连续 ${this.toolsSinceProgress} 次工具调用没有成功写入或编辑`,
        instruction: '暂停当前尝试并诊断停滞原因。不要继续相同命令；说明当前唯一阻断项，选择一个可验证的恢复动作，完成后立即运行检查器。'
      }
    }
    return null
  }

  end(toolCallId: string, isError: boolean): WatchdogAction | null {
    const call = this.activeCalls.get(toolCallId)
    this.activeCalls.delete(toolCallId)
    if (!call) return null

    if ((call.toolName === 'write' || call.toolName === 'edit') && !isError) {
      this.toolsSinceProgress = 0
      this.steeredForNoProgress = false
      if (call.target) this.failedEditsByTarget.set(call.target, 0)
      return null
    }
    if (call.toolName !== 'edit' || !isError || !call.target) return null

    const failures = (this.failedEditsByTarget.get(call.target) ?? 0) + 1
    this.failedEditsByTarget.set(call.target, failures)
    if (failures >= 6) return this.abort(`同一文件精确编辑连续失败 ${failures} 次：${call.target}`)
    if (failures >= 3 && !this.steeredForEdits.has(call.target)) {
      this.steeredForEdits.add(call.target)
      return {
        level: 'steer',
        reason: `同一文件精确编辑连续失败 ${failures} 次：${call.target}`,
        instruction: '禁止再次使用相同 oldText 或固定行号删除。重新读取目标章节一次，使用稳定标题/ID 作为锚点整体重写该章节；若检查器已通过，则停止修改。'
      }
    }
    return null
  }

  private abort(reason: string): WatchdogAction | null {
    if (this.aborted) return null
    this.aborted = true
    return {
      level: 'abort',
      reason,
      instruction: 'MoonGlass 已中止本轮以保护工程现场。请检查最后一个有效产物和门禁报告，再从单一明确问题恢复。'
    }
  }
}
