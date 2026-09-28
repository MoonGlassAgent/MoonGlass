/**
 * MoonGlass Provider 桥接扩展（由 pi 子进程加载，非本项目编译产物）
 *
 * AgentService 启动 pi 时通过 `-e` 加载本文件，从权限受限的一次性文件
 * 读取 Provider 列表；读取后立即删除，避免 API Key 长期出现在环境变量中。
 */

import { readFileSync, rmSync } from 'node:fs'
import { FALLBACK_MODEL_CONTEXT, resolveModelContext } from './model-context.ts'

interface MoonGlassProvider {
  id: string
  name: string
  protocol: 'openai-compatible' | 'anthropic'
  baseUrl: string
  apiKey: string
  models: string[]
  /**
   * 随每个 API 请求附加的自定义请求头（可选；pi 的 provider config 原生支持
   * `headers` 字段）。主进程注入前已把 `{{sessionId}}` 占位符替换为会话短哈希
   * （OpenCode Go 自 2026-09-06 起强制 x-opencode-session 会话头）。
   */
  headers?: Record<string, string>
  /**
   * 主进程按模型计算的有效上下文窗口（用户自定义覆盖 > 内置登记表 > 兼容回退值）。
   * 可选字段：旧版 payload 缺失时回退到本扩展自带的登记表解析。
   * 注意：pi 的模型注册表在进程启动时固定，主进程侧的覆盖值变更只对新 spawn
   * 的会话生效；显示层（get_session_stats）由主进程即时改写，不受此限制。
   */
  contextWindows?: Record<string, { contextWindow: number; maxTokens: number }>
}

export default function (pi: {
  registerProvider: (id: string, config: Record<string, unknown>) => void
}): void {
  const providerFile = process.env.MOONGLASS_PROVIDERS_FILE
  if (!providerFile) return

  let providers: MoonGlassProvider[]
  try {
    const raw = readFileSync(providerFile, 'utf-8')
    providers = JSON.parse(raw) as MoonGlassProvider[]
  } catch (err) {
    console.error('[moonglass-bridge] Provider 配置读取失败', err)
    return
  } finally {
    rmSync(providerFile, { force: true })
    delete process.env.MOONGLASS_PROVIDERS_FILE
  }

  for (const p of providers) {
    // 如果 key 中包含 $，pi 会尝试环境变量插值；用 $$ 转义，确保字面量传递
    const escapedKey = p.apiKey.replace(/\$/g, '$$$$')
    pi.registerProvider(p.id, {
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: escapedKey,
      authHeader: true, // 明确添加 Authorization: Bearer header
      ...(p.headers ? { headers: p.headers } : {}), // 自定义请求头（如 x-opencode-session）
      api: p.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
      models: p.models.map((m) => {
        const isDeepSeekReasoner = p.id === 'deepseek' && m === 'deepseek-reasoner'
        const isVolcengineAgentPlan = /ark\.cn-beijing\.volces\.com\/api\/plan\//i.test(p.baseUrl)
        // 主进程注入的有效上下文窗口优先（含用户自定义覆盖）；缺失时回退自带登记表
        const metadata = p.contextWindows?.[m] ?? resolveModelContext(m) ?? FALLBACK_MODEL_CONTEXT
        return {
          id: m,
          name: m,
          // Agent Plan 默认可能开启深度思考。让 Pi 的 thinking=off 真正下发
          // thinking:{type:"disabled"}，避免 reasoning_content 吞尽输出预算。
          reasoning: isDeepSeekReasoner || isVolcengineAgentPlan,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: metadata.contextWindow,
          maxTokens: metadata.maxTokens,
          ...(isDeepSeekReasoner || isVolcengineAgentPlan
            ? {
                compat: {
                  thinkingFormat: 'deepseek',
                  // 火山 Agent Plan Chat API 不接受 developer role；系统约束必须使用 system。
                  ...(isVolcengineAgentPlan ? { supportsDeveloperRole: false } : {})
                }
              }
            : {})
        }
      })
    })
  }
}
