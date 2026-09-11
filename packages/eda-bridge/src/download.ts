/**
 * GitHub 下载镜像回退（纯 node，无 electron 依赖）。
 *
 * 网络受限环境下 github.com 资产下载常被重置，而 gh-proxy.com / ghproxy.net
 * 等镜像可正常中转（镜像 URL = 前缀 + 原始 URL，同样可代理 api.github.com）。
 * 候选顺序：直连 URL 在前，镜像在后；镜像前缀由环境变量
 * MOONGLASS_GITHUB_MIRRORS（逗号分隔）覆盖，缺省 gh-proxy.com / ghproxy.net。
 */

import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/** 缺省 GitHub 镜像前缀（实测 gh-proxy.com 直连可通，ghproxy.net 302 需跟随重定向） */
const DEFAULT_GITHUB_MIRRORS = ['https://gh-proxy.com/', 'https://ghproxy.net/']

const DEFAULT_DOWNLOAD_TIMEOUT_MS = 30 * 60_000

/** 可注入的 fetcher，便于 smoke 用假实现测试回退逻辑 */
export type DownloadFetcher = typeof fetch

export interface MirrorFetchOptions {
  timeoutMs?: number
  /** 每个候选通道开始尝试时回调展示名（'直连 GitHub' / '镜像 gh-proxy.com'） */
  onChannel?: (channel: string) => void
  fetcher?: DownloadFetcher
}

/**
 * 生成下载候选 URL 列表：直连 URL 在前，镜像 URL（前缀 + 原始 URL）在后。
 * 环境变量 MOONGLASS_GITHUB_MIRRORS（逗号分隔前缀）非空时覆盖缺省镜像。
 */
export function githubDownloadCandidates(url: string): string[] {
  const envMirrors = (process.env.MOONGLASS_GITHUB_MIRRORS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const mirrors = envMirrors.length > 0 ? envMirrors : DEFAULT_GITHUB_MIRRORS
  return [url, ...mirrors.map((prefix) => prefix + url)]
}

/** 候选 URL 的展示名：直连为 '直连 GitHub'，镜像为 '镜像 <hostname>' */
function githubChannelName(candidateUrl: string, originalUrl: string): string {
  if (candidateUrl === originalUrl) return '直连 GitHub'
  try {
    return `镜像 ${new URL(candidateUrl).hostname}`
  } catch {
    return `镜像 ${candidateUrl}`
  }
}

function aggregateError(url: string): Error {
  return new Error(`GitHub 直连与镜像均不可达（网络限制），请检查代理设置或手动下载安装（原始地址：${url}）`)
}

/**
 * 按候选顺序 fetch（镜像 302 由 fetch 默认 follow 处理），任一候选返回 ok 即返回。
 * 全部失败抛出汇总错误。
 */
export async function fetchWithMirrors(
  url: string,
  options?: MirrorFetchOptions
): Promise<{ response: Response; channel: string }> {
  const fetcher = options?.fetcher ?? fetch
  const timeoutMs = options?.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
  for (const candidate of githubDownloadCandidates(url)) {
    const channel = githubChannelName(candidate, url)
    options?.onChannel?.(channel)
    try {
      const response = await fetcher(candidate, {
        headers: { 'User-Agent': 'MoonGlass' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow'
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return { response, channel }
    } catch {
      // 尝试下一候选
    }
  }
  throw aggregateError(url)
}

/**
 * 按候选顺序下载文件（fetch + stream 落盘），任一成功即返回所用通道展示名。
 * 每次失败清理半成品文件；全部失败抛出汇总错误。
 */
export async function downloadFileWithMirrors(
  url: string,
  destPath: string,
  options?: MirrorFetchOptions
): Promise<{ channel: string }> {
  const fetcher = options?.fetcher ?? fetch
  const timeoutMs = options?.timeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS
  for (const candidate of githubDownloadCandidates(url)) {
    const channel = githubChannelName(candidate, url)
    options?.onChannel?.(channel)
    try {
      const response = await fetcher(candidate, {
        headers: { 'User-Agent': 'MoonGlass' },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'follow'
      })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      await pipeline(Readable.fromWeb(response.body as never), createWriteStream(destPath))
      return { channel }
    } catch {
      // 清理半成品文件后尝试下一候选
      await rm(destPath, { force: true }).catch(() => {})
    }
  }
  throw aggregateError(url)
}
