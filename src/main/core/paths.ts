/**
 * 主进程共享路径工具：userData 下的 moonglass 数据目录。
 *
 * 支持注入 dataDir，便于在 Node 冒烟测试中绕过 Electron app。
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'

function getUserDataDir(): string {
  // Electron 运行时使用 app.getPath('userData')
  // Node 冒烟测试由调用方通过 dataDir 注入
  try {
    const require = createRequire(import.meta.url)
    const { app } = require('electron')
    return app.getPath('userData')
  } catch {
    return ''
  }
}

/** userData/moonglass 根目录 */
export function moonglassDataDir(dataDir?: string): string {
  const base = dataDir ?? getUserDataDir()
  if (!base) throw new Error('[paths] 无法确定数据目录：未提供 dataDir 且未在 Electron 环境中运行')
  return join(base, 'moonglass')
}

/** 项目工作目录（pi 会话 cwd，Agent 产出文件的位置） */
export function projectWorkspaceDir(projectId: string, dataDir?: string): string {
  return join(moonglassDataDir(dataDir), 'workspaces', projectId)
}
