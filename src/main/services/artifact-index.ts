/**
 * 工作区产物索引（任务粒度会话 M1，设计文档 §3.2）
 *
 * 确定性扫描（不依赖 LLM）：按阶段范围列出工作区中已存在的相关产物
 * （相对路径 + 大小 + mtime），作为独立小节追加到 .pi/APPEND_SYSTEM.md，
 * 让零历史继承的新任务会话能直接定位上一任务/上一阶段的落盘产物。
 * 每次 spawn 由 AgentService.writeSystemPrompt 重新扫描生成。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Phase } from '@shared/types'

/** 索引小节总体积上限（紧凑注入，避免挤占系统提示词预算） */
const ARTIFACT_INDEX_MAX_BYTES = 2048
/** 单个扫描目录最多列出的文件数（防御失控目录，如 node_modules 误入） */
const ARTIFACT_INDEX_MAX_ENTRIES = 40
/** 目录递归深度上限 */
const ARTIFACT_INDEX_MAX_DEPTH = 3

/**
 * 各阶段注入的 artifact 扫描范围（相对工作区路径，逐阶段累积，见 §3.2 阶段表）。
 * 目录递归枚举，文件直接探测存在性。
 */
const PHASE_ARTIFACT_PATHS: Record<Phase, string[]> = {
  REQ_SPEC: [],
  ARCH: ['docs/02_requirements'],
  RTL: ['docs/02_requirements', 'docs/03_design'],
  VERIF: [
    'docs/02_requirements',
    'docs/03_design',
    'rtl/design.json',
    'rtl/filelist.f',
    'verification/intelligence/execution-summary.json'
  ],
  QA: [
    'docs/02_requirements',
    'docs/03_design',
    'rtl/design.json',
    'rtl/filelist.f',
    'verification/intelligence/execution-summary.json',
    'rtlqa',
    'docs/04_verification'
  ],
  SYNTH: [
    'docs/02_requirements',
    'docs/03_design',
    'rtl/design.json',
    'rtl/filelist.f',
    'verification/intelligence/execution-summary.json',
    'rtlqa',
    'docs/04_verification'
  ]
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** 递归枚举目录内文件（相对工作区路径），受深度与条目数约束。 */
function collectDir(workspace: string, relDir: string, depth: number, out: string[]): void {
  if (depth > ARTIFACT_INDEX_MAX_DEPTH || out.length >= ARTIFACT_INDEX_MAX_ENTRIES) return
  const absDir = join(workspace, relDir)
  let names: string[]
  try {
    names = readdirSync(absDir)
  } catch {
    return
  }
  for (const name of names.sort()) {
    if (out.length >= ARTIFACT_INDEX_MAX_ENTRIES) return
    const rel = `${relDir}/${name}`
    const abs = join(workspace, rel)
    try {
      const stat = statSync(abs)
      if (stat.isDirectory()) collectDir(workspace, rel, depth + 1, out)
      else if (stat.isFile()) out.push(rel)
    } catch { /* 忽略枚举期间消失的文件 */ }
  }
}

/**
 * 生成产物索引小节（Markdown）。扫描范围内一个文件都不存在时返回空串，
 * 不注入空小节（如 REQ_SPEC 起步阶段）。
 */
export function buildArtifactIndexSection(workspace: string, phase: Phase): string {
  const paths = PHASE_ARTIFACT_PATHS[phase]
  if (paths.length === 0) return ''

  const found: string[] = []
  for (const rel of paths) {
    const abs = join(workspace, rel)
    if (!existsSync(abs)) continue
    try {
      if (statSync(abs).isDirectory()) collectDir(workspace, rel, 1, found)
      else found.push(rel)
    } catch { /* 忽略扫描期间消失的路径 */ }
  }
  if (found.length === 0) return ''

  const lines = found.sort().map((rel) => {
    try {
      const stat = statSync(join(workspace, rel))
      return `- ${rel}（${formatSize(stat.size)}，${stat.mtime.toISOString()}）`
    } catch {
      return `- ${rel}`
    }
  })

  const header = '\n\n## 工作区产物索引（自动生成）\n\n' +
    '以下为当前工作区已落盘的相关产物（确定性扫描，仅列存在项）；新任务请基于这些文件继续，不要凭记忆重建。\n'
  let section = header
  let included = 0
  for (const line of lines) {
    // 预留省略说明的空间，确保总体积不超过上限
    if (Buffer.byteLength(section + line + '\n', 'utf-8') > ARTIFACT_INDEX_MAX_BYTES - 64) break
    section += line + '\n'
    included += 1
  }
  const omitted = lines.length - included
  if (omitted > 0) section += `- …（其余 ${omitted} 个文件从略，按需用文件工具查看）\n`
  return section
}
