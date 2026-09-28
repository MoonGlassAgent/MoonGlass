/**
 * Provider 自定义请求头的会话占位符解析。
 *
 * OpenCode Go 自 2026-09-06 起强制每个 API 请求携带 x-opencode-session 头
 * （每会话一个固定 ID，用于路由 / prompt-cache 亲和；缺失报 400 MissingSessionID）。
 * Provider 配置中 header 值可写 `{{sessionId}}` 占位符，注入 pi 前由本模块替换。
 */

import { createHash } from 'node:crypto'

/**
 * 会话标识短哈希：sha1(sessionKey) 前 12 位十六进制。
 * 同一会话文件跨 pi 进程 respawn 结果稳定（满足 prompt-cache 亲和），
 * 不同会话文件结果不同（避免跨会话串路由）。
 */
export function sessionHeaderId(sessionKey: string): string {
  return createHash('sha1').update(sessionKey).digest('hex').slice(0, 12)
}

/**
 * 把 headers 中的 `{{sessionId}}` 占位符替换为 sessionKey 的短哈希。
 * 无 headers 或无占位符时原样返回（不替换），调用方按 undefined 跳过透传。
 */
export function resolveProviderHeaders(
  headers: Record<string, string> | undefined,
  sessionKey: string
): Record<string, string> | undefined {
  if (!headers) return undefined
  const sessionId = sessionHeaderId(sessionKey)
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key, value.replaceAll('{{sessionId}}', sessionId)])
  )
}
