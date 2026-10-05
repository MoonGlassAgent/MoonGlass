/**
 * 验证工作台证据核对器（主进程侧，P1，2026-10-05）
 *
 * 只读：读取当前 RTL 哈希，并对工作台引用的证据文件逐一核对存在性、版本与更新时间。
 * 供 IPC `fs:verification-workbench` 使用；不写入任何项目产物，也不参与调度。
 *
 * 口径：
 * - 姿态优先取 verification-posture.json（机器可读快照）；被 Agent 覆盖成摘要时缺失
 *   verificationIntents，回退到完整的 verification-state.json；
 * - 证据存在性只依赖 stat（便宜、可靠）；版本只在 JSON 且体积可控时解析，解析不了就
 *   报 rtlHash=null（快照侧据此把该条款判为"版本未知、需重验"，而不是当作有效通过）；
 * - 引用越出项目工作目录一律视为不存在，防止报告里的 ../ 路径读到项目外文件。
 */

import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { computeRtlHash } from '@moonglass/verification-intelligence-engine'
import type { WorkbenchEvidence } from '@shared/verification-workbench'

/** JSON 证据解析上限：超过则不解析版本，但仍报告存在性。 */
const MAX_PARSE_BYTES = 2 * 1024 * 1024

/** 当前磁盘 RTL 哈希；计算失败返回 null（快照侧据此判为版本未知，不显示就绪）。 */
export function currentRtlHashOf(workspaceDir: string): string | null {
  try {
    return computeRtlHash(workspaceDir) || null
  } catch {
    return null
  }
}

/**
 * 读取工作台数据源：优先完整姿态，回退完整状态。
 * 返回 source 供界面标注口径出处；两者都不可用时 raw 为 null（不是空对象）。
 */
export function readWorkbenchSource(workspaceDir: string): { raw: unknown; source: string | null } {
  const candidates = [
    'verification/intelligence/verification-posture.json',
    'verification/intelligence/verification-state.json'
  ]
  for (const rel of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(workspaceDir, rel), 'utf-8')) as { verificationIntents?: unknown }
      // posture 可能是被覆盖的摘要（缺 verificationIntents）→ 继续尝试下一个候选
      if (Array.isArray(parsed.verificationIntents)) return { raw: parsed, source: rel }
    } catch { /* 缺失或不可解析：尝试下一个候选 */ }
  }
  return { raw: null, source: null }
}

/** 批量核对证据引用（键为 POSIX 相对路径，与 workbenchEvidenceRefs 同口径）。 */
export function readWorkbenchEvidence(workspaceDir: string, refs: string[]): Record<string, WorkbenchEvidence> {
  const root = resolve(workspaceDir)
  const result: Record<string, WorkbenchEvidence> = {}
  for (const ref of refs) {
    const normalized = ref.replace(/\\/g, '/')
    const target = resolve(root, normalized)
    const inside = relative(root, target)
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
      result[normalized] = { exists: false, rtlHash: null }
      continue
    }
    try {
      const stat = statSync(target)
      if (!stat.isFile() || stat.size === 0) {
        result[normalized] = { exists: false, rtlHash: null }
        continue
      }
      let rtlHash: string | null = null
      if (normalized.endsWith('.json') && stat.size <= MAX_PARSE_BYTES) {
        try {
          const parsed = JSON.parse(readFileSync(target, 'utf-8')) as { rtlHash?: unknown }
          if (typeof parsed.rtlHash === 'string' && parsed.rtlHash) rtlHash = parsed.rtlHash
        } catch { /* 不可解析：仅报告存在性 */ }
      }
      result[normalized] = { exists: true, rtlHash, modifiedAt: stat.mtimeMs }
    } catch {
      result[normalized] = { exists: false, rtlHash: null }
    }
  }
  return result
}
