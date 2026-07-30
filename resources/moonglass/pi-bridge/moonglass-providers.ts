/**
 * MoonGlass Provider 桥接扩展（由 pi 子进程加载，非本项目编译产物）
 *
 * AgentService 启动 pi 时通过 `-e` 加载本文件，
 * 从环境变量 MOONGLASS_PROVIDERS_JSON 读取 MoonGlass 设置页配置的
 * Provider 列表并注册到 pi（apiKey 为字面量注入，不写 pi 全局配置）。
 */

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
  const raw = process.env.MOONGLASS_PROVIDERS_JSON
  if (!raw) return

  let providers: MoonGlassProvider[]
  try {
    providers = JSON.parse(raw) as MoonGlassProvider[]
  } catch (err) {
    console.error('[moonglass-bridge] MOONGLASS_PROVIDERS_JSON 解析失败', err)
    return
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
        return {
          id: m,
          name: m,
          reasoning: isDeepSeekReasoner,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 8192,
          ...(isDeepSeekReasoner
            ? {
                compat: {
                  thinkingFormat: 'deepseek'
                }
              }
            : {})
        }
      })
    })
  }
}
