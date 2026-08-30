/**
 * 项目文件服务
 *
 * 提供项目工作目录（pi 会话 cwd）的文件树扫描与文件读取，
 * 供工作区左侧文件树使用。所有路径限制在工作目录内，防目录穿越。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { FileContentResult, FileTreeNode } from '@shared/types'
import type { MoonGlassService } from '../core/lifecycle'
import type { ProjectService } from './ProjectService'

/** 单文件读取上限（超出截断展示） */
const READ_MAX_BYTES = 256 * 1024
const JSON_MAX_BYTES = 16 * 1024 * 1024

export class FileService implements MoonGlassService {
  readonly name = 'file-service'

  constructor(private readonly projects: ProjectService) {}

  start(): void {
    // 无常驻资源
  }

  stop(): void {
    // 无常驻资源
  }

  /** 扫描工作目录文件树（跳过隐藏项与 node_modules，目录在前按名称排序） */
  tree(projectId: string): FileTreeNode[] {
    const root = this.projects.workspaceDir(projectId)
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

  /** 结构化视图专用：完整读取 JSON，不复用面向编辑器的 256 KiB 预览截断。 */
  readJson(projectId: string, relPath: string): unknown | null {
    if (!/\.json$/i.test(relPath)) throw new Error('结构化读取仅支持 JSON 文件')
    const full = this.resolveProjectFile(projectId, relPath)
    if (!full) return null
    const size = statSync(full).size
    if (size > JSON_MAX_BYTES) throw new Error(`JSON 文件超过结构化读取上限（${(size / 1024 / 1024).toFixed(1)} MB / 16 MB）`)
    try {
      return JSON.parse(readFileSync(full, 'utf-8')) as unknown
    } catch (error) {
      throw new Error(`JSON 数据无效：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 安全写入项目内文本文件；拒绝绝对路径和目录穿越。 */
  writeText(projectId: string, relPath: string, content: string): boolean {
    const root = resolve(this.projects.workspaceDir(projectId))
    const full = resolve(root, relPath)
    if (full === root || !full.startsWith(root + sep)) return false
    mkdirSync(resolve(full, '..'), { recursive: true })
    writeFileSync(full, content, 'utf-8')
    return true
  }

  /** 将项目相对路径安全解析为绝对文件路径，拒绝目录穿越与不存在的文件。 */
  resolveProjectFile(projectId: string, relPath: string): string | null {
    const root = resolve(this.projects.workspaceDir(projectId))
    const full = resolve(root, relPath)
    if (full !== root && !full.startsWith(root + sep)) return null
    if (!existsSync(full) || !statSync(full).isFile()) return null
    return full
  }
}
