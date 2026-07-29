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
import { join } from 'node:path'
import type { LlmProviderConfig } from '@shared/types'
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
      if (!this.providers.has(preset.id)) {
        this.providers.set(preset.id, { ...preset })
        dirty = true
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
    const presetOrder = new Map(LLM_PROVIDER_PRESETS.map((p, i) => [p.id, i]))
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
    this.providers.set(next.id, next)
    this.persist()
    return next
  }

  delete(id: string): boolean {
    const target = this.providers.get(id)
    if (!target || target.builtin) return false
    const ok = this.providers.delete(id)
    if (ok) this.persist()
    return ok
  }
}
