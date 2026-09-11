export interface ModelContextMetadata {
  contextWindow: number
  maxTokens: number
  source: string
  verified: boolean
}

/**
 * 模型上下文登记表（2026-09-11 按各厂商官方文档刷新，调研记录见 交流/交流_20260908.txt）。
 * verified=true 表示官方页面直接确认；false 为官方未公布输出上限或间接核实（取保守值）。
 * 注意：本文件与 resources/moonglass/pi-bridge/model-context.ts 是两份副本（桥接被复制到
 * userData 运行，禁止跨目录 import），修改必须两侧同步。
 * 聚合商（OpenRouter/Together/硅基流动）的带前缀模型 ID 不在此表覆盖范围内。
 */
const rules: Array<{ pattern: RegExp; value: ModelContextMetadata }> = [
  // DeepSeek：2026-09 官方 API 事实主力仅 deepseek-flash（V4.1-Flash，1M/384K）；
  // v4-pro 自 2026-09-14 路由至 Flash，v4-flash 旧名临时路由至 V4.1-Flash，规格一致
  { pattern: /^deepseek-(?:flash|v4(?:\.\d+)?-(?:flash|pro)(?:-vision-exp)?)$/i, value: { contextWindow: 1_048_576, maxTokens: 393_216, source: 'DeepSeek 官方', verified: true } },
  // OpenAI：旗舰线 1.05M/128K；mini 与 codex 为 400K/128K
  { pattern: /^(?:gpt-6-astra|gpt-5\.6-(?:sol|terra|luna)|gpt-5\.5|gpt-5\.4)$/i, value: { contextWindow: 1_050_000, maxTokens: 128_000, source: 'OpenAI 官方', verified: true } },
  { pattern: /^(?:gpt-5\.4-mini|gpt-5\.3-codex)$/i, value: { contextWindow: 400_000, maxTokens: 128_000, source: 'OpenAI 官方', verified: true } },
  // Anthropic：1M 均为默认（非 beta）；haiku 4.5 固定 200K 无 1M 变体
  { pattern: /^claude-(?:opus-5|sonnet-5|fable-5-1)$/i, value: { contextWindow: 1_048_576, maxTokens: 128_000, source: 'Anthropic 官方', verified: true } },
  { pattern: /^claude-(?:opus-4-[678]|sonnet-4-6)$/i, value: { contextWindow: 1_048_576, maxTokens: 128_000, source: 'Anthropic 官方（输出上限页面口径曾不一致）', verified: false } },
  { pattern: /^claude-haiku-4-5/i, value: { contextWindow: 200_000, maxTokens: 64_000, source: 'Anthropic 官方', verified: true } },
  // Google：Gemini 3.x 全线 1M/64K（Model Card 统一口径；当前 Flash 主力 3.8）
  { pattern: /gemini-3(?:\.|-)/i, value: { contextWindow: 1_048_576, maxTokens: 65_536, source: 'Google 官方', verified: true } },
  // xAI：输出上限官方未公布，取保守值；grok-4.5 为官方直证，其余为 2026-09 间接核实
  { pattern: /^grok-4\.5$/i, value: { contextWindow: 500_000, maxTokens: 65_536, source: 'xAI 官方', verified: true } },
  { pattern: /^grok-4\.6$/i, value: { contextWindow: 500_000, maxTokens: 65_536, source: 'xAI 官方（间接核实）', verified: false } },
  { pattern: /^grok-4\.3$/i, value: { contextWindow: 1_048_576, maxTokens: 65_536, source: 'xAI 官方（间接核实）', verified: false } },
  { pattern: /^grok-4\.20/i, value: { contextWindow: 2_097_152, maxTokens: 65_536, source: 'xAI 官方（间接核实）', verified: false } },
  { pattern: /^(?:grok-build|grok-code-fast)/i, value: { contextWindow: 262_144, maxTokens: 65_536, source: 'xAI 官方（间接核实）', verified: false } },
  // Mistral：-latest 别名当前指向 Large 3 / Medium 3.5 / Devstral 2（均 256K）；
  // 输出上限官方未公布，保留保守值
  { pattern: /(?:mistral-large-latest|mistral-medium-latest|devstral-latest)$/i, value: { contextWindow: 262_144, maxTokens: 32_768, source: 'Mistral 官方（输出上限未公布）', verified: false } },
  // Moonshot：开放平台 kimi-k3 为 1M（默认输出 128K）；K2.6/K2.7-code 及
  // Kimi Code 通道（k3 按档位 256K/1M，取保守 256K）均 256K
  { pattern: /^kimi-k3$/i, value: { contextWindow: 1_048_576, maxTokens: 131_072, source: 'Moonshot 官方', verified: true } },
  { pattern: /^(?:kimi-k2\.7-code(?:-highspeed)?|kimi-k2\.6|kimi-for-coding(?:-highspeed)?|k3-256k|k3)$/i, value: { contextWindow: 262_144, maxTokens: 32_768, source: 'Moonshot 官方（Kimi Code 通道输出上限未公布）', verified: false } },
  // 智谱：GLM-5.3 家族（含 flash 多模态）与 5.2 均 1M/128K；GLM-5 为 200K/128K
  { pattern: /glm-?5[._-]?3(?:[._-]flash)?$/i, value: { contextWindow: 1_048_576, maxTokens: 131_072, source: '智谱官方', verified: true } },
  { pattern: /glm-5\.2$/i, value: { contextWindow: 1_048_576, maxTokens: 131_072, source: '智谱官方', verified: true } },
  { pattern: /^glm-5$/i, value: { contextWindow: 200_000, maxTokens: 131_072, source: '智谱官方', verified: true } },
  // MiniMax：M3 为当前旗舰（1M）；M2.7 系列 204.8K（输出上限官方未公布）
  { pattern: /^minimax-m3$/i, value: { contextWindow: 1_000_000, maxTokens: 131_072, source: 'MiniMax 官方（输出上限未公布）', verified: false } },
  { pattern: /minimax-m2\.7(?:-highspeed)?$/i, value: { contextWindow: 204_800, maxTokens: 131_072, source: 'MiniMax 官方（输出上限未公布）', verified: false } },
  // 阿里云百炼：qwen3.8-max 为当前旗舰；3.7/3.8 旗舰线 1M/128K，coder-plus 1M/64K，
  // coder-next 256K/64K（官方模型信息页口径）
  { pattern: /^qwen3\.8-max$/i, value: { contextWindow: 1_000_000, maxTokens: 131_072, source: '阿里云百炼官方', verified: true } },
  { pattern: /qwen3\.7-(?:plus|max)$/i, value: { contextWindow: 1_000_000, maxTokens: 131_072, source: '阿里云百炼官方', verified: true } },
  { pattern: /^qwen3-coder-plus$/i, value: { contextWindow: 1_000_000, maxTokens: 65_536, source: '阿里云百炼官方', verified: true } },
  { pattern: /^qwen3-coder-next$/i, value: { contextWindow: 262_144, maxTokens: 65_536, source: '阿里云百炼官方', verified: true } },
  // Groq：gpt-oss-120b 规格出自官方 changelog；llama-3.3-70b 官方页未能直连，
  // 取第三方一致标注值
  { pattern: /^openai\/gpt-oss-120b$/i, value: { contextWindow: 131_072, maxTokens: 32_768, source: 'Groq 官方 changelog', verified: true } },
  { pattern: /^llama-3\.3-70b-versatile$/i, value: { contextWindow: 131_072, maxTokens: 32_768, source: '第三方一致标注（Groq 官方页未直连）', verified: false } }
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
