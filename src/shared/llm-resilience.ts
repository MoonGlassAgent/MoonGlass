/**
 * LLM 调用韧性纯函数（供 AgentService 与冒烟测试共用）
 *
 * 本文件不得依赖 electron / node 运行库，保持纯 TS，供纯 Node 冒烟脚本直接 import。
 */

/** 停滞阈值：距最后一个 pi 事件超过该时长且无在飞工具即判定为疑似挂起 */
export const LLM_STALL_THRESHOLD_MS = 120_000

/**
 * 停滞判定（纯函数）。
 * 关键约束：run_simulation 等长耗时工具执行期间没有事件是合法的，
 * 必须满足「流式中 && 无在飞工具 && 超过阈值无事件」三者才告警。
 */
export function isStalled(
  streaming: boolean,
  toolInFlight: number,
  lastEventAt: number,
  now: number
): boolean {
  return streaming && toolInFlight === 0 && now - lastEventAt > LLM_STALL_THRESHOLD_MS
}

const LLM_ERROR_RULES: Array<{ pattern: RegExp; message: string }> = [
  { pattern: /\b402\b/, message: '模型服务余额不足或套餐已过期，请充值或切换其他模型' },
  { pattern: /\b401\b|\b403\b/, message: 'API Key 无效或无权限访问该模型，请检查设置页的模型服务配置' },
  { pattern: /\b404\b/, message: '模型不存在或已下线，请切换模型' },
  { pattern: /\b429\b/, message: '模型服务限流，请稍后重试或切换模型' },
  { pattern: /\b5\d\d\b|timed?\s*out|etimedout|esockettimedout|econnreset|socket hang up|fetch failed/i, message: '模型服务暂时不可用，请稍后重试' }
]

/**
 * LLM 错误语义化：把 provider 裸错误映射为可操作的提示，原文保留在括号内。
 * 未命中任何规则时原样返回。
 */
export function humanizeLlmError(raw: string): string {
  const text = raw.trim()
  for (const rule of LLM_ERROR_RULES) {
    if (rule.pattern.test(text)) return `${rule.message}（${text}）`
  }
  return raw
}

/** 探活所需的最小 client 契约（PiRpcClient 结构兼容，便于注入假实现测试） */
export interface ProbeClient {
  command<T = unknown>(cmd: Record<string, unknown>, timeoutMs?: number): Promise<T>
  waitForEvent(
    predicate: (event: Record<string, unknown>) => boolean,
    timeoutMs?: number
  ): Promise<Record<string, unknown>>
}

/**
 * 切换模型并探活（可注入假 client 的判定/回滚路径）。
 *
 * 探活采用 pi 的真实 prompt 通道：pi RPC 没有独立的低成本健康检查命令
 * （get_state 不触达 LLM，无法暴露欠费 402），只有真实调用才能验证 provider/key。
 * 代价：prompt 全量持久化，"ping" 会落入会话 JSONL 历史，属可接受成本。
 *
 * 探活失败时把模型回滚到原选择（若存在）再抛错；回滚本身失败不影响抛出原始错误。
 */
export async function switchModelWithProbe(input: {
  client: ProbeClient
  applySwitch: (providerId: string, modelId: string) => Promise<void>
  providerId: string
  modelId: string
  previous: { providerId: string; modelId: string } | null
  probeTimeoutMs?: number
}): Promise<void> {
  await input.applySwitch(input.providerId, input.modelId)
  try {
    await probeModelHealth(input.client, input.probeTimeoutMs)
  } catch (error) {
    if (input.previous) {
      await input
        .applySwitch(input.previous.providerId, input.previous.modelId)
        .catch(() => undefined)
    }
    throw error instanceof Error ? error : new Error(String(error))
  }
}

/** 极小探活请求：prompt "ping"，等待 settled 或错误事件；错误时抛出原始错误。 */
export async function probeModelHealth(client: ProbeClient, timeoutMs = 60_000): Promise<void> {
  // 与 prompt() 一致：先注册事件等待器再发命令，避免极短回合在 RPC response 前 settled 的竞态
  const completion = client.waitForEvent(
    (event) => {
      if (event.type === 'agent_settled') return true
      if (event.type !== 'message_update') return false
      const delta = (event.assistantMessageEvent ?? {}) as Record<string, unknown>
      return delta.type === 'error'
    },
    timeoutMs
  )
  const [, terminal] = await Promise.all([
    client.command({ type: 'prompt', message: 'ping' }, timeoutMs),
    completion
  ])
  if (terminal.type === 'message_update') {
    const delta = (terminal.assistantMessageEvent ?? {}) as Record<string, unknown>
    throw new Error(String(delta.errorMessage ?? delta.error ?? '探活请求失败'))
  }
}
