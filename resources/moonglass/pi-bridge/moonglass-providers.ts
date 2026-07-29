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
    pi.registerProvider(p.id, {
      name: p.name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      api: p.protocol === 'anthropic' ? 'anthropic-messages' : 'openai-completions',
      models: p.models.map((m) => ({
        id: m,
        name: m,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 8192
      }))
    })
  }
}
