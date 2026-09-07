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
    models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'],
    enabled: false,
    builtin: true
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: '',
    models: ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    enabled: false,
    builtin: true
  },
  {
    id: 'google-gemini',
    name: 'Google Gemini',
    protocol: 'openai-compatible',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKey: '',
    models: ['gemini-3.1-pro-preview', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'],
    enabled: false,
    builtin: true
  },
  {
    id: 'xai',
    name: 'xAI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    apiKey: '',
    models: ['grok-4.5'],
    enabled: false,
    builtin: true
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    apiKey: '',
    models: ['mistral-large-latest', 'devstral-latest', 'mistral-medium-latest'],
    enabled: false,
    builtin: true
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    protocol: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: '',
    models: ['openai/gpt-5.5', 'anthropic/claude-opus-4.7', 'google/gemini-3.1-pro-preview', 'x-ai/grok-4.5'],
    enabled: false,
    builtin: true
  },
  {
    id: 'groq',
    name: 'Groq',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey: '',
    models: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
    enabled: false,
    builtin: true
  },
  {
    id: 'together',
    name: 'Together AI',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.together.xyz/v1',
    apiKey: '',
    models: ['deepseek-ai/DeepSeek-V4-Pro', 'moonshotai/Kimi-K2.6', 'MiniMaxAI/MiniMax-M2.7', 'Qwen/Qwen3.7-Max', 'zai-org/GLM-5.1', 'openai/gpt-oss-120b'],
    enabled: false,
    builtin: true
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash'],
    enabled: false,
    builtin: true
  },
  {
    id: 'moonshot',
    name: 'Moonshot',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    apiKey: '',
    models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.6'],
    enabled: false,
    builtin: true
  },
  {
    id: 'kimi-code',
    name: 'Kimi Code',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.kimi.com/coding/v1',
    apiKey: '',
    models: ['k3', 'k3-256k', 'kimi-for-coding', 'kimi-for-coding-highspeed'],
    enabled: false,
    builtin: true
  },
  {
    id: 'glm',
    name: 'GLM 智谱',
    protocol: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    models: ['glm-5.3-flash', 'glm-5.2', 'glm-5'],
    enabled: false,
    builtin: true
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.minimaxi.com/v1',
    apiKey: '',
    models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed'],
    enabled: false,
    builtin: true
  },
  {
    id: 'bailian',
    name: '阿里云百炼',
    protocol: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKey: '',
    models: ['qwen3.7-plus', 'qwen3.7-max', 'qwen3-coder-plus', 'qwen3-coder-next'],
    enabled: false,
    builtin: true
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    apiKey: '',
    models: ['deepseek-ai/DeepSeek-V4-Flash', 'moonshotai/Kimi-K2.6', 'Qwen/Qwen3.5-397B-A17B', 'zai-org/GLM-5', 'MiniMaxAI/MiniMax-M2.7'],
    enabled: false,
    builtin: true
  }
]
