/**
 * LLM Provider 配置服务
 *
 * 管理大模型 Provider 配置（API Key / Base URL / 模型列表），
 * JSON 文件存储（userData/moonglass/llm-providers.json），首次启动以
 * shared/llm-provider-presets.ts 的预置清单播种。
 * API Key 使用 electron safeStorage 加密静态存储；内存与 IPC 仍传明文。
 */

import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'
import type {
  LlmModelTestResult,
  LlmProviderConfig,
  LlmProviderTestResult
} from '@shared/types'
import { LLM_PROVIDER_PRESETS } from '@shared/llm-provider-presets'
import type { MoonGlassService } from '../core/lifecycle'

/** 磁盘存储格式：apiKeyEnc 为 safeStorage 密文（base64），apiKey 为旧版明文 */
interface LlmProviderStoreFile {
  version?: number
  providers: Array<
    Omit<LlmProviderConfig, 'apiKey'> & {
      apiKeyEnc?: string | null
      apiKey?: string
    }
  >
}

const STORAGE_VERSION = 1
const PREFERRED_PROVIDER_ORDER = [
  'openai',
  'deepseek',
  'moonshot',
  'kimi-code',
  'siliconflow',
  'bailian'
] as const
const RETIRED_PRESET_MODELS: Readonly<Record<string, readonly string[]>> = {
  openai: ['gpt-5.2', 'gpt-5-mini', 'gpt-4.1'],
  anthropic: ['claude-sonnet-4-5', 'claude-opus-4-1'],
  'google-gemini': ['gemini-2.5-pro'],
  xai: ['grok-4', 'grok-4-fast'],
  mistral: ['codestral-latest', 'ministral-8b-latest'],
  openrouter: ['openai/gpt-5.2', 'anthropic/claude-sonnet-4.5'],
  together: ['deepseek-ai/DeepSeek-V3.1', 'moonshotai/Kimi-K2-Instruct'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  'kimi-code': ['kimi-k2.6'],
  glm: ['glm-4.6', 'glm-4-air'],
  minimax: ['MiniMax-M2'],
  bailian: ['qwen-plus', 'qwen-max'],
  siliconflow: ['Pro/deepseek-ai/DeepSeek-V3', 'deepseek-ai/DeepSeek-V2.5', 'Qwen/Qwen2.5-72B-Instruct', 'THUDM/glm-4-9b-chat']
}

export class LlmProviderService implements MoonGlassService {
  readonly name = 'llm-provider-service'

  private storePath = ''
  private providers = new Map<string, LlmProviderConfig>()
  private encryptionAvailable: boolean | null = null

  start(): void {
    const dir = join(app.getPath('userData'), 'moonglass')
    mkdirSync(dir, { recursive: true })
    this.storePath = join(dir, 'llm-providers.json')
    this.encryptionAvailable = safeStorage.isEncryptionAvailable()
    this.load()
  }

  stop(): void {
    this.persist()
  }

  /** 加密：空 key 仍返回空串；safeStorage 不可用时返回 null */
  private encryptKey(plain: string): string | null {
    if (plain === '') return ''
    if (!this.encryptionAvailable) return null
    try {
      return safeStorage.encryptString(plain).toString('base64')
    } catch (err) {
      console.warn('[llm-provider-service] 加密 API Key 失败，将使用明文存储', err)
      this.encryptionAvailable = false
      return null
    }
  }

  /** 解密：空/null/undefined 返回空串 */
  private decryptKey(cipher: string | null | undefined): string {
    if (!cipher || cipher === '') return ''
    if (!this.encryptionAvailable) {
      console.warn('[llm-provider-service] safeStorage 不可用，无法解密 apiKeyEnc')
      return ''
    }
    try {
      return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
    } catch (err) {
      console.warn('[llm-provider-service] 解密 apiKeyEnc 失败，视为空 Key', err)
      return ''
    }
  }

  private load(): void {
    let dirty = false
    if (existsSync(this.storePath)) {
      try {
        const data = JSON.parse(readFileSync(this.storePath, 'utf-8')) as LlmProviderStoreFile
        for (const p of data.providers) {
          // 优先读取加密字段；同时存在旧版明文字段时触发迁移
          let apiKey = this.decryptKey(p.apiKeyEnc)
          if (p.apiKey !== undefined) {
            if (apiKey === '' && p.apiKey !== '') {
              apiKey = p.apiKey
              dirty = true
            }
          }
          const config: LlmProviderConfig = { ...(p as LlmProviderConfig), apiKey }
          this.providers.set(config.id, config)
        }
      } catch (err) {
        console.error('[llm-provider-service] 读取 Provider 存储失败，将以预置清单启动', err)
      }
    }
    // 合并新增预置项（用户已有配置优先，预置只补缺不覆盖）
    for (const preset of LLM_PROVIDER_PRESETS) {
      const existing = this.providers.get(preset.id)
      if (!existing) {
        this.providers.set(preset.id, { ...preset })
        dirty = true
      } else if (existing.builtin) {
        // 预置更新只补充推荐模型；用户的 Key、URL、启用状态和自定义模型均保留。
        const retired = new Set(RETIRED_PRESET_MODELS[existing.id] ?? [])
        const models = [...new Set([...preset.models, ...existing.models])].filter((model) => !retired.has(model))
        if (models.length !== existing.models.length || models.some((model, index) => model !== existing.models[index])) {
          this.providers.set(existing.id, { ...existing, models })
          dirty = true
        }
      }
    }
    if (dirty) this.persist()
  }

  private persist(): void {
    const providers = this.list().map((p) => {
      const cipher = this.encryptKey(p.apiKey)
      if (cipher !== null) {
        // 加密可用：写 apiKeyEnc，不写明文 apiKey
        const { apiKey: _, ...rest } = p
        return { ...rest, apiKeyEnc: cipher }
      }
      // 加密不可用：保持明文（降级）
      return { ...p }
    })
    const data: LlmProviderStoreFile = { version: STORAGE_VERSION, providers }
    writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf-8')
  }

  /** 预置项在前，其余按名称排序 */
  list(): LlmProviderConfig[] {
    const orderedIds = [
      ...PREFERRED_PROVIDER_ORDER,
      ...LLM_PROVIDER_PRESETS.map((provider) => provider.id).filter(
        (id) => !PREFERRED_PROVIDER_ORDER.includes(id as (typeof PREFERRED_PROVIDER_ORDER)[number])
      )
    ]
    const presetOrder = new Map(orderedIds.map((id, index) => [id, index]))
    return [...this.providers.values()].sort((a, b) => {
      const ia = presetOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER
      const ib = presetOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER
      return ia !== ib ? ia - ib : a.name.localeCompare(b.name)
    })
  }

  upsert(config: LlmProviderConfig): LlmProviderConfig {
    // 预置项锁定 id / builtin 标记，防止渲染端篡改
    const preset = LLM_PROVIDER_PRESETS.find((p) => p.id === config.id)
    const next: LlmProviderConfig = preset
      ? { ...config, protocol: preset.protocol, builtin: true }
      : { ...config, builtin: false }
    // 清理 API Key 前后空格，避免复制时带入换行或空白导致认证失败
    next.apiKey = next.apiKey.trim()
    this.providers.set(next.id, next)
    this.persist()
    return next
  }

  /**
   * 测试 Provider 连接。
   *
   * 标准 OpenAI-compatible Provider 优先使用 /models 做无 Token 探测；部分套餐型
   * 网关（如火山方舟 Agent Plan）不提供该端点，遇到 404/405 时逐个使用配置模型
   * 发起最小 chat/completions 请求，以免把“模型列表未实现”误判为连接失败。
   */
  test(input: LlmProviderConfig): Promise<LlmProviderTestResult> {
    const provider = { ...input, apiKey: input.apiKey.trim(), baseUrl: input.baseUrl.trim() }
    const unknownModels = (message: string): LlmModelTestResult[] =>
      provider.models.map((model) => ({ model, status: 'unknown', message }))

    if (!provider.apiKey) {
      return Promise.resolve({
        ok: false,
        error: 'API Key 为空',
        models: unknownModels('Provider 配置未通过，模型未测试')
      })
    }
    if (!provider.baseUrl) {
      return Promise.resolve({
        ok: false,
        error: 'Base URL 为空',
        models: unknownModels('Provider 配置未通过，模型未测试')
      })
    }

    let modelsUrl: URL
    try {
      const base = provider.baseUrl.replace(/\/+$/, '')
      // Anthropic 默认 Base URL 不含 /v1；OpenAI-compatible 通常已含 /v1。
      modelsUrl = new URL(`${base}${provider.protocol === 'anthropic' && !/\/v\d+$/i.test(base) ? '/v1' : ''}/models`)
    } catch {
      return Promise.resolve({
        ok: false,
        error: 'Base URL 格式无效',
        models: unknownModels('Provider 配置未通过，模型未测试')
      })
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': `MoonGlass/${app.getVersion()}`
    }
    if (provider.protocol === 'anthropic') {
      headers['x-api-key'] = provider.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers.Authorization = `Bearer ${provider.apiKey}`
    }
    const send = (url: URL, method: 'GET' | 'POST', body?: string): Promise<{ status?: number; body: string }> => new Promise((resolve) => {
      const request = url.protocol === 'http:' ? httpRequest : httpsRequest
      const requestHeaders = { ...headers }
      if (body !== undefined) {
        requestHeaders['Content-Type'] = 'application/json'
        requestHeaders['Content-Length'] = Buffer.byteLength(body).toString()
      }
      const req = request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method,
          headers: requestHeaders,
          timeout: 10000
        },
        (res) => {
          let body = ''
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf-8')
          })
          res.on('end', () => {
            resolve({ status: res.statusCode, body })
          })
        }
      )

      req.on('error', (err) => {
        resolve({ body: '', status: undefined, error: err.message } as { status?: number; body: string })
      })
      req.on('timeout', () => {
        req.destroy()
        resolve({ body: '', status: undefined })
      })

      if (body !== undefined) req.write(body)
      req.end()
    })

    return (async (): Promise<LlmProviderTestResult> => {
      const modelsResponse = await send(modelsUrl, 'GET')
      if (modelsResponse.status && modelsResponse.status >= 200 && modelsResponse.status < 300) {
        let ids: string[] = []
        try {
          const payload = JSON.parse(modelsResponse.body) as {
            data?: Array<{ id?: unknown }>
            models?: Array<{ id?: unknown } | string>
          }
          const entries = payload.data ?? payload.models ?? []
          ids = entries
            .map((entry) => typeof entry === 'string' ? entry : entry.id)
            .filter((id): id is string => typeof id === 'string' && id.length > 0)
        } catch {
          // 连接成功但响应不是标准模型列表，模型状态保持 unknown。
        }
        const available = new Set(ids)
        return {
          ok: true,
          status: modelsResponse.status,
          endpoint: modelsUrl.toString(),
          availableModelCount: ids.length,
          models: provider.models.map((model) => ids.length === 0
            ? { model, status: 'unknown', message: 'Provider 连接成功，但未返回可识别的模型列表' }
            : available.has(model)
              ? { model, status: 'pass', message: '模型 ID 存在于 Provider 可用列表' }
              : { model, status: 'fail', message: 'Provider 可用列表中未找到该模型 ID' })
        }
      }

      if (modelsResponse.status === 404 || modelsResponse.status === 405) {
        if (provider.protocol === 'anthropic' || provider.models.length === 0) {
          return {
            ok: false,
            status: modelsResponse.status,
            endpoint: modelsUrl.toString(),
            error: 'Provider 未提供模型列表端点，且没有可用于兼容探测的模型',
            models: unknownModels('未执行模型推理探测')
          }
        }
        const base = provider.baseUrl.replace(/\/+$/, '')
        const chatUrl = new URL(`${base}/chat/completions`)
        const modelResults: LlmModelTestResult[] = []
        let successfulStatus: number | undefined
        for (const model of provider.models) {
          const chatBody = JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'Reply OK.' }],
            max_tokens: 1,
            stream: false
          })
          const chatResponse = await send(chatUrl, 'POST', chatBody)
          if (chatResponse.status && chatResponse.status >= 200 && chatResponse.status < 300) {
            successfulStatus ??= chatResponse.status
            modelResults.push({
              model,
              status: 'pass',
              message: '已通过最小推理请求验证（可能产生极少量 Token）'
            })
            continue
          }
          const msg = chatResponse.body.slice(0, 200).replace(/\s+/g, ' ')
          modelResults.push({
            model,
            status: 'fail',
            message: chatResponse.status
              ? `最小推理请求失败：HTTP ${chatResponse.status}${msg ? `，${msg}` : ''}`
              : '最小推理请求失败或超时'
          })
        }
        if (successfulStatus !== undefined) {
          return {
            ok: true,
            status: successfulStatus,
            endpoint: chatUrl.toString(),
            models: modelResults
          }
        }
        return {
          ok: false,
          endpoint: chatUrl.toString(),
          error: '模型列表端点不可用，且所有配置模型的最小推理探测均失败',
          models: modelResults
        }
      }

      if (modelsResponse.status === 401 || modelsResponse.status === 403) {
        return {
          ok: false,
          status: modelsResponse.status,
          endpoint: modelsUrl.toString(),
          error: 'API Key 无效或权限不足',
          models: unknownModels('认证失败，模型未测试')
        }
      }
      const msg = modelsResponse.body.slice(0, 200).replace(/\s+/g, ' ')
      return {
        ok: false,
        status: modelsResponse.status,
        endpoint: modelsUrl.toString(),
        error: modelsResponse.status ? `HTTP ${modelsResponse.status}: ${msg}` : '请求失败或超时（10s）',
        models: unknownModels('Provider 端点失败，模型未测试')
      }
    })()
  }

  delete(id: string): boolean {
    const target = this.providers.get(id)
    if (!target || target.builtin) return false
    const ok = this.providers.delete(id)
    if (ok) this.persist()
    return ok
  }
}
