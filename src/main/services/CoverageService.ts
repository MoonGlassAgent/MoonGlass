/**
 * 覆盖率明细服务
 *
 * 为验证态势页「覆盖率明细」视图提供 Verilator 逐检测点数据：
 * 优先消费结果目录内已缓存的 coverage-detail.json，缺失时回退解析
 * coverage.dat 并回写缓存。所有路径限制在 verification/results/ 下，防目录穿越。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { CoverageDetailResult } from '@shared/types'
import { parseVerilatorCoverageDetail } from '@moonglass/eda-bridge'
import type { MoonGlassService } from '../core/lifecycle'
import type { ProjectService } from './ProjectService'

/** 覆盖率明细允许访问的相对目录前缀 */
const RESULT_DIR_PREFIX = 'verification/results/'

export class CoverageService implements MoonGlassService {
  readonly name = 'coverage-service'

  constructor(private readonly projects: ProjectService) {}

  start(): void {
    // 无常驻资源
  }

  stop(): void {
    // 无常驻资源
  }

  /**
   * 读取指定结果目录的覆盖率明细。
   * relResultDir 为项目工作区内相对路径（允许 Windows 反斜杠），归一化后必须位于
   * verification/results/ 之下；目录下 coverage-detail.json 缓存有效时直接返回，
   * 否则解析 coverage.dat 并回写缓存，均无数据时返回 null。
   */
  async detail(projectId: string, relResultDir: string): Promise<CoverageDetailResult | null> {
    const rel = relResultDir.replace(/\\/g, '/').replace(/^\.?\/+/, '')
    if (rel.includes('..') || !rel.startsWith(RESULT_DIR_PREFIX)) {
      throw new Error('覆盖率明细仅允许访问 verification/results/ 下的目录')
    }
    const root = resolve(this.projects.workspaceDir(projectId))
    const dir = resolve(root, rel)
    if (dir !== root && !dir.startsWith(root + sep)) return null

    const detailPath = join(dir, 'coverage-detail.json')
    if (existsSync(detailPath)) {
      try {
        const cached = JSON.parse(readFileSync(detailPath, 'utf-8')) as CoverageDetailResult
        if (Array.isArray(cached.files)) return cached
      } catch { /* 缓存损坏时回退重新解析 coverage.dat */ }
    }
    const detail = parseVerilatorCoverageDetail(join(dir, 'coverage.dat'))
    if (!detail) return null
    try {
      writeFileSync(detailPath, JSON.stringify(detail, null, 2), 'utf-8')
    } catch { /* 缓存回写失败不阻断本次返回 */ }
    return detail
  }
}
