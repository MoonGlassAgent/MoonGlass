/**
 * 阶段产物漂移检测（纯函数，供冒烟脚本直接转译验证）。
 *
 * 背景：用户可能在工作区外手动删除 verification/ 或 rtl/ 等目录，
 * 而阶段状态仍记录在 SQLite 中（ProjectService.rowToProject 纯读库）。
 * detectArtifactDrift 把"库记录"与"磁盘实况"对账：仅 status==='completed'
 * 的阶段参与判定；该阶段映射的产物路径全部不存在时判为漂移
 * （部分存在不算——进行中的增删改是合法工作状态）。
 *
 * PHASE_ARTIFACT_PATHS 与 ProjectService 的清除/归档预览共用同一份口径，
 * 禁止在两处各自维护映射副本。
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PHASE_ORDER, type ArtifactDriftEntry, type Phase, type PhaseState } from '../../shared/types/moonglass.ts'

/** 各阶段产物路径映射（相对项目工作目录）。 */
export const PHASE_ARTIFACT_PATHS: Record<Phase, readonly string[]> = {
  REQ_SPEC: [
    'docs/01_project',
    'docs/02_requirements',
    'docs/03_design/interface_spec.md',
    'docs/03_design/register_map.md'
  ],
  ARCH: [
    'docs/03_design/architecture.md',
    'docs/03_design/microarchitecture.md',
    'docs/03_design/clock_reset.md'
  ],
  RTL: ['rtl', 'rtlqa/lint', 'rtlqa/cdc'],
  VERIF: ['docs/04_verification', 'verification'],
  QA: ['docs/06_validation'],
  SYNTH: ['docs/05_implementation', 'imp']
}

/**
 * 漂移对账：返回所有"记录已完成但产物已全部消失"的阶段。
 * 条目按 PHASE_ORDER 顺序产出，missingPaths 为相对路径。
 */
export function detectArtifactDrift(phases: Record<Phase, PhaseState>, workspaceDir: string): ArtifactDriftEntry[] {
  const root = resolve(workspaceDir)
  const entries: ArtifactDriftEntry[] = []
  for (const phase of PHASE_ORDER) {
    if (phases[phase].status !== 'completed') continue
    const artifactPaths = PHASE_ARTIFACT_PATHS[phase]
    const missingPaths = artifactPaths.filter((relPath) => !existsSync(join(root, relPath)))
    // 全部映射路径都不存在才算漂移；部分存在说明只是进行中的增删改，不打扰用户
    if (missingPaths.length === artifactPaths.length) {
      entries.push({ phase, missingPaths: [...missingPaths] })
    }
  }
  return entries
}

/**
 * resetDownstream 的纯计算：返回需连带重置为初始 locked 态的下游阶段（按阶段顺序）。
 * 仅 locked 阶段跳过——其余（completed/active/skipped/blocked）记录都建立在
 * 被删除证据之上，一并清零；只清记录，不动下游磁盘文件，也不重定位 currentPhase。
 */
export function selectDownstreamResetTargets(phases: Record<Phase, PhaseState>, phase: Phase): Phase[] {
  return PHASE_ORDER
    .slice(PHASE_ORDER.indexOf(phase) + 1)
    .filter((downstream) => phases[downstream].status !== 'locked')
}
