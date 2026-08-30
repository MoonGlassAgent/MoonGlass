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
      api: p.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
      models: p.models.map((m) => {
        const isDeepSeekReasoner = p.id === 'deepseek' && m === 'deepseek-reasoner'
        const isVolcengineAgentPlan = /ark\.cn-beijing\.volces\.com\/api\/plan\//i.test(p.baseUrl)
        const metadata = resolveModelContext(m) ?? FALLBACK_MODEL_CONTEXT
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
