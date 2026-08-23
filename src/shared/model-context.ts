export interface ModelContextMetadata {
  contextWindow: number
  maxTokens: number
  source: string
  verified: boolean
}

const rules: Array<{ pattern: RegExp; value: ModelContextMetadata }> = [
  { pattern: /deepseek-v4-(?:pro|flash)$/i, value: { contextWindow: 1_000_000, maxTokens: 384_000, source: 'DeepSeek 官方', verified: true } },
  { pattern: /gemini-3(?:\.|-)/i, value: { contextWindow: 1_048_576, maxTokens: 65_536, source: 'Google 官方', verified: true } },
  { pattern: /grok-4\.5$/i, value: { contextWindow: 500_000, maxTokens: 65_536, source: 'xAI 官方', verified: true } },
  { pattern: /(?:mistral-large-latest|mistral-medium-latest|devstral-latest)$/i, value: { contextWindow: 262_144, maxTokens: 32_768, source: 'Mistral 官方', verified: true } },
  { pattern: /glm-5\.2$/i, value: { contextWindow: 1_000_000, maxTokens: 131_072, source: '智谱官方', verified: true } },
  { pattern: /minimax-m2\.7(?:-highspeed)?$/i, value: { contextWindow: 204_800, maxTokens: 131_072, source: 'MiniMax 官方', verified: true } },
  { pattern: /qwen3\.7-(?:plus|max)$/i, value: { contextWindow: 1_000_000, maxTokens: 131_072, source: '阿里云百炼官方', verified: true } },
  { pattern: /(?:kimi-k2\.6|kimi-k2\.7-code|k3-256k)$/i, value: { contextWindow: 262_144, maxTokens: 32_768, source: '服务商模型说明', verified: false } },
  { pattern: /claude-(?:opus-4-7|sonnet-4-6|haiku-4-5)$/i, value: { contextWindow: 1_000_000, maxTokens: 64_000, source: 'Anthropic 长上下文规格', verified: false } }
]

export const FALLBACK_MODEL_CONTEXT: ModelContextMetadata = {
  contextWindow: 128_000,
  maxTokens: 8_192,
  source: 'MoonGlass 兼容回退值',
  verified: false
}

export function resolveModelContext(modelId: string): ModelContextMetadata | null {
  const normalized = modelId.trim()
  return rules.find((rule) => rule.pattern.test(normalized))?.value ?? null
}
