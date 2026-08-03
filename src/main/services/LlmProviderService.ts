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
  deepseek: ['deepseek-chat', 'deepseek-reasoner']
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
        const models = [...new Set([...existing.models, ...preset.models])].filter((model) => !retired.has(model))
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

  /** 测试 Provider 连接并对照 /models 返回值检查每个配置模型，不产生推理 token。 */
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

    let url: URL
    try {
      const base = provider.baseUrl.replace(/\/+$/, '')
      // Anthropic 默认 Base URL 不含 /v1；OpenAI-compatible 通常已含 /v1。
      url = new URL(`${base}${provider.protocol === 'anthropic' && !/\/v\d+$/i.test(base) ? '/v1' : ''}/models`)
    } catch {
      return Promise.resolve({
        ok: false,
        error: 'Base URL 格式无效',
        models: unknownModels('Provider 配置未通过，模型未测试')
      })
    }

    const hostname = url.hostname
    const port = url.port || (url.protocol === 'https:' ? 443 : 80)
    const path = url.pathname + url.search
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': 'MoonGlass/0.3.0'
    }
    if (provider.protocol === 'anthropic') {
      headers['x-api-key'] = provider.apiKey
      headers['anthropic-version'] = '2023-06-01'
    } else {
      headers.Authorization = `Bearer ${provider.apiKey}`
    }
    const request = url.protocol === 'http:' ? httpRequest : httpsRequest

    return new Promise<LlmProviderTestResult>((resolve) => {
      const req = request(
        {
          hostname,
          port,
          path,
          method: 'GET',
          headers,
          timeout: 10000
        },
        (res) => {
          let body = ''
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString('utf-8')
          })
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              let ids: string[] = []
              try {
                const payload = JSON.parse(body) as {
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
              const models: LlmModelTestResult[] = provider.models.map((model) => {
                if (ids.length === 0) {
                  return {
                    model,
                    status: 'unknown',
                    message: 'Provider 连接成功，但未返回可识别的模型列表'
                  }
                }
                return available.has(model)
                  ? { model, status: 'pass', message: '模型 ID 存在于 Provider 可用列表' }
                  : { model, status: 'fail', message: 'Provider 可用列表中未找到该模型 ID' }
              })
              resolve({
                ok: true,
                status: res.statusCode,
                endpoint: url.toString(),
                availableModelCount: ids.length,
                models
              })
            } else if (res.statusCode === 401 || res.statusCode === 403) {
              resolve({
                ok: false,
                status: res.statusCode,
                endpoint: url.toString(),
                error: 'API Key 无效或权限不足',
                models: unknownModels('认证失败，模型未测试')
              })
            } else {
              const msg = body.slice(0, 200).replace(/\s+/g, ' ')
              resolve({
                ok: false,
                status: res.statusCode,
                endpoint: url.toString(),
                error: `HTTP ${res.statusCode}: ${msg}`,
                models: unknownModels('Provider 端点失败，模型未测试')
              })
            }
          })
        }
      )

      req.on('error', (err) => {
        resolve({
          ok: false,
          endpoint: url.toString(),
          error: `请求失败: ${err.message}`,
          models: unknownModels('Provider 无法连接，模型未测试')
        })
      })
      req.on('timeout', () => {
        req.destroy()
        resolve({
          ok: false,
          endpoint: url.toString(),
          error: '请求超时（10s）',
          models: unknownModels('Provider 请求超时，模型未测试')
        })
      })

      req.end()
    })
  }

  delete(id: string): boolean {
    const target = this.providers.get(id)
    if (!target || target.builtin) return false
    const ok = this.providers.delete(id)
    if (ok) this.persist()
    return ok
  }
}
