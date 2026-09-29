/**
 * 缺失工具一键安装计划计算与 PATH 合并的纯函数。
 *
 * 与 EdaService 的编排解耦，便于 smoke 直接断言。
 */

import { delimiter } from 'node:path'
import type { ToolDetection } from '@shared/types'

export interface MissingInstallPlan {
  /** 需要串行安装的 bundle id（oss-cad-suite / python-cocotb / verible） */
  bundles: string[]
  /** 不自动安装、需要用户手动处理的工具（runtime/build 中无 installId 的缺失项） */
  manualGuidance: Array<{ tool: string; installUrl?: string }>
}

/** 已知可一键安装的 bundle 顺序（串行执行顺序即数组顺序）；与 toolchain-manifest.ts 的键一一对应 */
export const INSTALLABLE_BUNDLES = ['oss-cad-suite', 'verible', 'python-cocotb'] as const

/**
 * 计算缺失工具的安装计划。
 * - builtin 工具缺失属于内置组件异常，不进安装计划；
 * - physical（时序与物理实现）类别不支持一键安装，也不进手动指引；
 * - 其余缺失项：带 installId 的归入对应 bundle，runtime/build 中无 installId 的进手动指引。
 */
export function computeMissingInstallPlan(tools: ToolDetection[]): MissingInstallPlan {
  const missing = tools.filter((tool) => !tool.found && !tool.builtin && tool.category !== 'physical')
  const needed = new Set(missing.map((tool) => tool.installId).filter((id): id is string => Boolean(id)))
  const bundles = INSTALLABLE_BUNDLES.filter((id) => needed.has(id))
  const manualGuidance = missing
    .filter((tool) => !tool.installId && (tool.category === 'runtime' || tool.category === 'build'))
    .map((tool) => ({ tool: tool.tool, installUrl: tool.installUrl }))
  return { bundles, manualGuidance }
}

/**
 * 合并注册表 PATH 与当前进程 PATH：保留进程 PATH 原有顺序，
 * 注册表中新增的条目追加在后，按目录大小写不敏感去重（忽略尾部斜杠差异）。
 */
export function mergePathEntries(currentPath: string, extraPath: string): string {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const raw of [...currentPath.split(delimiter), ...extraPath.split(delimiter)]) {
    const entry = raw.trim()
    if (!entry) continue
    const key = entry.replace(/[\\/]+$/, '').toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(entry)
  }
  return merged.join(delimiter)
}
