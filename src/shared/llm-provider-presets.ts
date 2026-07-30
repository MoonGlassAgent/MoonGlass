/**
 * 预置 LLM Provider 清单
 *
 * 主进程首次启动时以此为种子写入 userData/moonglass/llm-providers.json，
 * 渲染端仅通过 llm.list() 获取（用户改动优先，预置项只补充不覆盖）。
 * baseUrl / models 均为默认值，用户可在设置页修改。
 */

import type { LlmProviderConfig } from './types'

export const LLM_PROVIDER_PRESETS: readonly LlmProviderConfig[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    models: ['gpt-4o', 'gpt-4o-mini'],
    enabled: true,
    builtin: true
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1'],
    enabled: false,
    builtin: true
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    enabled: false,
    builtin: true
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: '',
    models: ['kimi-k2.6'],
    enabled: false,
    builtin: true
  },
  {
    id: 'kimi-code',
    name: 'Kimi Code',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.kimi.com/coding/v1',
    apiKey: '',
    models: ['kimi-k2.6'],
    enabled: false,
    builtin: true
  },
  {
    id: 'glm',
    name: 'GLM 智谱',
    protocol: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    models: ['glm-4.6', 'glm-4-air'],
    enabled: false,
    builtin: true
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.minimaxi.com/v1',
    apiKey: '',
    models: ['MiniMax-M2'],
    enabled: false,
    builtin: true
  },
  {
    id: 'bailian',
    name: '阿里云百炼',
    protocol: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    models: ['qwen-plus', 'qwen-max'],
    enabled: false,
    builtin: true
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    models: ['Pro/deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-V2.5', 'Qwen/Qwen2.5-72B-Instruct', 'THUDM/glm-4-9b-chat'],
    enabled: true,
    builtin: true
  }
]
