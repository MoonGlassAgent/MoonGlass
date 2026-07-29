/**
 * 主进程共享路径工具：userData 下的 moonglass 数据目录。
 */

import { app } from 'electron'
import { join } from 'node:path'

/** userData/moonglass 根目录 */
export function moonglassDataDir(): string {
  return join(app.getPath('userData'), 'moonglass')
}

/** 项目工作目录（pi 会话 cwd，Agent 产出文件的位置） */
export function projectWorkspaceDir(projectId: string): string {
  return join(moonglassDataDir(), 'workspaces', projectId)
}
