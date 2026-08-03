/**
 * 项目文件服务
 *
 * 提供项目工作目录（pi 会话 cwd）的文件树扫描与文件读取，
 * 供工作区左侧文件树使用。所有路径限制在工作目录内，防目录穿越。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { FileContentResult, FileTreeNode } from '@shared/types'
import type { MoonGlassService } from '../core/lifecycle'
import { projectWorkspaceDir } from '../core/paths'

/** 单文件读取上限（超出截断展示） */
const READ_MAX_BYTES = 256 * 1024

export class FileService implements MoonGlassService {
  readonly name = 'file-service'

  start(): void {
    // 无常驻资源
  }

  stop(): void {
    // 无常驻资源
  }

  /** 扫描工作目录文件树（跳过隐藏项与 node_modules，目录在前按名称排序） */
  tree(projectId: string): FileTreeNode[] {
    const root = projectWorkspaceDir(projectId)
    if (!existsSync(root)) return []
    return this.scanDir(root, root)
  }

  private scanDir(dir: string, root: string): FileTreeNode[] {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const nodes: FileTreeNode[] = []
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue
      const full = join(dir, e.name)
      const rel = full.slice(root.length + 1)
      if (e.isDirectory()) {
        nodes.push({ name: e.name, path: rel, type: 'dir', children: this.scanDir(full, root) })
      } else {
        nodes.push({ name: e.name, path: rel, type: 'file' })
      }
    }
    return nodes.sort((a, b) =>
      a.type !== b.type ? (a.type === 'dir' ? -1 : 1) : a.name.localeCompare(b.name)
    )
  }

  /** 读取文件内容（限制在工作目录内；二进制/超限做截断处理） */
  readFile(projectId: string, relPath: string): FileContentResult | null {
    const full = this.resolveProjectFile(projectId, relPath)
    if (!full) return null
    if (!existsSync(full) || !statSync(full).isFile()) return null

    const buf = readFileSync(full)
    // 含 NUL 字节视为二进制，不做文本展示
    if (buf.includes(0)) {
      return { content: '（二进制文件，暂不支持预览）', truncated: false }
    }
    const truncated = buf.length > READ_MAX_BYTES
    return { content: buf.subarray(0, READ_MAX_BYTES).toString('utf-8'), truncated }
  }

  /** 将项目相对路径安全解析为绝对文件路径，拒绝目录穿越与不存在的文件。 */
  resolveProjectFile(projectId: string, relPath: string): string | null {
    const root = resolve(projectWorkspaceDir(projectId))
    const full = resolve(root, relPath)
    if (full !== root && !full.startsWith(root + sep)) return null
    if (!existsSync(full) || !statSync(full).isFile()) return null
    return full
  }
}
