/**
 * 阶段产物漂移检测 + 阶段状态对账（纯函数，供冒烟脚本直接转译验证）。
 *
 * 背景：用户可能在工作区外手动删除 verification/ 或 rtl/ 等目录，
 * 而阶段状态仍记录在 SQLite 中（ProjectService.rowToProject 纯读库）。
 * detectArtifactDrift 把"库记录"与"磁盘实况"对账：仅 status==='completed'
 * 的阶段参与判定；该阶段映射的产物路径全部不存在时判为漂移
 * （部分存在不算——进行中的增删改是合法工作状态）。
 *
 * reconcileProjectPhases 是"反向"对账（MG-046：deliverables/gates/messageCount
 * 与工作区事实长期脱节）：deliverables/messageCount 运行期从不写入，导致 REQ 文档
 * 已落盘但 deliverables 恒空、ARCH active 但 messageCount 恒 0。项目被读取/打开时
 * 按磁盘实况回填校正：产物从映射路径真实发现；消息数按该阶段会话 JSONL 实况统计。
 * 原则：磁盘事实为准、只增不删、不伪造——status 与 gateCheckResults 一律不写
 * （门禁结果只来自真实运行；完成判定不可由对账代替）。
 *
 * PHASE_ARTIFACT_PATHS 与 ProjectService 的清除/归档预览共用同一份口径，
 * 禁止在两处各自维护映射副本。
 */

import { existsSync, readdirSync, readFileSync, statSync, type Dirent } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { PHASE_ORDER, type ArtifactDriftEntry, type Deliverable, type DeliverableType, type Phase, type PhaseState } from '../../shared/types/moonglass.ts'
import { readPiSessionMessages } from './session-transcript.ts'

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

// ==================== 阶段状态对账（MG-046） ====================

/**
 * 阶段主会话的稳定逻辑名（如 phase-req_spec）。
 * 注意：这是 AgentService.phaseMainSessionName 的口径副本——会话文件名是已落盘的
 * 持久格式，权威实现位于 AgentService.ts（其模块私有），两边任何修改必须同步。
 */
export function phaseMainSessionName(phase: Phase): string {
  return `phase-${phase.toLowerCase()}`
}

/** 判断逻辑会话名是否属于指定阶段；`--` 后为该阶段的平行会话（批次/修复/UT 等）。 */
export function sessionBelongsToPhase(sessionName: string, phase: Phase): boolean {
  const main = phaseMainSessionName(phase)
  return sessionName === main || sessionName.startsWith(`${main}--`)
}

/** 交付物发现时的噪音过滤：中间产物目录不参与（.moonglass 必须排除——阶段归档产物
 *  存放在其 phase-archives/ 下，不排除会被当作"新产物"反复回填）。 */
const DISCOVERY_EXCLUDED_DIRS = new Set([
  '.git', '.hg', '.svn', '.moonglass', '.pi', 'node_modules',
  '__pycache__', 'obj_dir', 'build', 'sim_build', '.venv', 'venv', '.pytest_cache'
])

/** 波形/日志/临时文件是运行中间态，不作为阶段交付物登记。 */
const DISCOVERY_EXCLUDED_EXTS = new Set(['.vcd', '.fst', '.log', '.bak', '.tmp', '.pyc'])

/** 单阶段交付物登记上限，超出部分截断（看板/提示只消费计数与清单，防止运行输出刷爆列表）。 */
const MAX_DISCOVERED_DELIVERABLES_PER_PHASE = 100

/** 扩展名 → 交付物类型（未覆盖的扩展名归 doc，与 phase_deliverables 表口径一致）。 */
const DELIVERABLE_TYPE_BY_EXT: Record<string, DeliverableType> = {
  '.md': 'doc', '.txt': 'doc', '.html': 'doc', '.pdf': 'doc',
  '.v': 'code', '.sv': 'code', '.vh': 'code', '.svh': 'code', '.py': 'code', '.c': 'code', '.h': 'code', '.cpp': 'code',
  '.sh': 'script', '.tcl': 'script', '.js': 'script', '.mjs': 'script',
  '.json': 'report', '.xml': 'report', '.csv': 'report', '.yaml': 'report', '.yml': 'report',
  '.png': 'diagram', '.svg': 'diagram', '.jpg': 'diagram', '.jpeg': 'diagram', '.drawio': 'diagram', '.mmd': 'diagram',
  '.sdc': 'constraint', '.ldc': 'constraint'
}

function collectFilesRecursive(absDir: string, relDir: string, out: string[]): void {
  let entries: Dirent[]
  try {
    entries = readdirSync(absDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (DISCOVERY_EXCLUDED_DIRS.has(entry.name)) continue
      collectFilesRecursive(join(absDir, entry.name), rel, out)
    } else if (entry.isFile()) {
      if (DISCOVERY_EXCLUDED_EXTS.has(extname(entry.name).toLowerCase())) continue
      out.push(rel)
    }
  }
}

/**
 * 按 PHASE_ARTIFACT_PATHS 映射发现阶段在磁盘上的真实产物（相对项目工作目录的稳定
 * 排序路径列表，去重并截断到上限）。目录映射递归收集其内文件；空目录不产生条目
 * （initWorkspace 预建的模板目录因此不会误判）。仅发现，不做任何写入。
 */
export function discoverPhaseArtifacts(workspaceDir: string, phase: Phase): string[] {
  const root = resolve(workspaceDir)
  const found: string[] = []
  for (const mapped of PHASE_ARTIFACT_PATHS[phase]) {
    const abs = join(root, mapped)
    if (!existsSync(abs)) continue
    let isDirectory = false
    try {
      isDirectory = statSync(abs).isDirectory()
    } catch {
      continue
    }
    if (isDirectory) collectFilesRecursive(abs, mapped, found)
    else found.push(mapped)
  }
  return [...new Set(found)].sort().slice(0, MAX_DISCOVERED_DELIVERABLES_PER_PHASE)
}

/** 磁盘发现产物 → Deliverable 登记项。id 以 disk: 为命名空间保证幂等稳定；
 *  status 记 draft（对账只证明"存在"，不证明"已评审"）；作者无法从磁盘判定，
 *  沿用 phase_deliverables 表 generated_by 的 DDL 默认口径 human。 */
function buildDiskDeliverable(relPath: string): Deliverable {
  return {
    id: `disk:${relPath}`,
    type: DELIVERABLE_TYPE_BY_EXT[extname(relPath).toLowerCase()] ?? 'doc',
    name: basename(relPath),
    filePath: relPath,
    status: 'draft',
    generatedBy: 'human',
    version: 1
  }
}

/** 会话消息统计结果：messageCount 为该阶段全部归属会话的真实消息数；
 *  lastActiveAt 为归属会话文件的最新 mtime（ISO），无归属会话时为 undefined。 */
export interface PhaseSessionStats {
  messageCount: number
  lastActiveAt?: string
}

interface SessionMessageCache {
  mtimeMs: number
  size: number
  count: number
}

/** 会话文件统计缓存：项目列表 3s 轮询 / 工作区 2s 轮询下的成本控制，
 *  只在 mtime 或大小变化后重读（同 pending-actions.ts 的 mtime 缓存口径）。 */
const sessionMessageCache = new Map<string, SessionMessageCache>()

/** 从会话文件名取逻辑名；旧版跨阶段主会话 session.jsonl 返回 null
 *  （与 AgentService.listSessions 的口径一致：不计入任何阶段）。 */
function sessionLogicalNameFromFile(fileName: string): string | null {
  if (fileName === 'session.jsonl') return null
  return fileName.replace(/^session-/, '').replace(/\.jsonl$/, '') || null
}

/**
 * 统计指定阶段会话 JSONL 的真实消息数（复用 session-transcript 解析路径，
 * 只读不 attach）。平行会话（--batch/--fix/--ut 等）同属该阶段一并统计；
 * archive/ 子目录与 .bak.jsonl 不参与（与 listSessions 枚举口径一致）。
 */
export function countPhaseSessionMessages(sessionDir: string, phase: Phase): PhaseSessionStats {
  let messageCount = 0
  let lastMtimeMs: number | undefined
  let fileNames: string[]
  try {
    fileNames = existsSync(sessionDir) ? readdirSync(sessionDir) : []
  } catch {
    return { messageCount: 0 }
  }
  for (const fileName of fileNames) {
    if (!fileName.endsWith('.jsonl') || fileName.endsWith('.bak.jsonl')) continue
    const logicalName = sessionLogicalNameFromFile(fileName)
    if (logicalName === null || !sessionBelongsToPhase(logicalName, phase)) continue
    const filePath = join(sessionDir, fileName)
    try {
      const fileStat = statSync(filePath)
      if (!fileStat.isFile()) continue
      const cached = sessionMessageCache.get(filePath)
      let count: number
      if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
        count = cached.count
      } else {
        // readPiSessionMessages 与 VERIF 批次可观测性共用同一解析口径，
        // 只统计 type==='message' 且结构完整的条目，流式残缺末行自动跳过。
        count = readPiSessionMessages(filePath).length
        sessionMessageCache.set(filePath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, count })
      }
      messageCount += count
      if (lastMtimeMs === undefined || fileStat.mtimeMs > lastMtimeMs) lastMtimeMs = fileStat.mtimeMs
    } catch {
      // 单文件读取失败（被占用/权限）不阻塞整体统计
    }
  }
  return { messageCount, lastActiveAt: lastMtimeMs === undefined ? undefined : new Date(lastMtimeMs).toISOString() }
}

export interface PhaseReconcileInput {
  phase: Phase
  state: PhaseState
  /** 项目工作目录（绝对路径） */
  workspaceDir: string
  /** 项目会话目录（<userData>/moonglass/pi-sessions/<projectId>；不存在时按无会话处理） */
  sessionDir: string
}

/**
 * 单阶段对账（磁盘事实为准，只增不删、不伪造）：
 * - deliverables：记录为空且磁盘发现产物 → 按发现回填（id 稳定幂等）；已有记录不动
 *   （历史语义保留，产物被删也不回删——与漂移判定"部分存在是合法工作态"同口径，
 *   全量清除走 resetPhase 的"从0开始"）；
 * - agentContext：messageCount 校正为该阶段会话实况（含会话归档/清空后如实归零，
 *   与 restartSessionFresh 的从0重计语义一致）；lastActiveAt 缺失时按会话 mtime 回填；
 * - status / gateCheckResults / reviewStatus：只读不写。门禁结果只来自真实运行，
 *   对账绝不合成"未跑过"或"已通过"的记录。
 *
 * 返回校正后的新状态；无变化返回 null（调用方据此跳过持久化，避免轮询写盘）。
 */
export function reconcilePhaseState(input: PhaseReconcileInput): PhaseState | null {
  const { phase, state, workspaceDir, sessionDir } = input
  let next: PhaseState | null = null

  if (state.deliverables.length === 0) {
    const found = discoverPhaseArtifacts(workspaceDir, phase)
    if (found.length > 0) {
      next = { ...state, deliverables: found.map((relPath) => buildDiskDeliverable(relPath)) }
    }
  }

  const stats = countPhaseSessionMessages(sessionDir, phase)
  const recordedCount = state.agentContext.messageCount
  const countChanged = recordedCount !== stats.messageCount
  const lastActiveMissing = stats.messageCount > 0 && !state.agentContext.lastActiveAt
  if (countChanged || lastActiveMissing) {
    const base = next ?? state
    next = {
      ...base,
      agentContext: {
        ...base.agentContext,
        messageCount: stats.messageCount,
        lastActiveAt: stats.lastActiveAt
      }
    }
  }

  return next
}

/** 项目级对账结果：phases 为校正后的整体阶段表；changedPhases 为本次有字段被
 *  校正的阶段；deliverablesBackfilledPhases 为其中完成交付物回填的子集
 *  （供调用方日志/冒烟断言区分"历史补写"与"计数校正"）。 */
export interface ProjectReconcileResult {
  phases: Record<Phase, PhaseState>
  /** 有任一字段被校正即列入 */
  changedPhases: Phase[]
  /** changedPhases 中完成 deliverables 回填的子集 */
  deliverablesBackfilledPhases: Phase[]
}

/** 按 PHASE_ORDER 对全部阶段执行 reconcilePhaseState 聚合。纯函数，无副作用。 */
export function reconcileProjectPhases(input: {
  phases: Record<Phase, PhaseState>
  workspaceDir: string
  sessionDir: string
}): ProjectReconcileResult {
  const phases = { ...input.phases }
  const changedPhases: Phase[] = []
  const deliverablesBackfilledPhases: Phase[] = []
  for (const phase of PHASE_ORDER) {
    const before = phases[phase]
    const next = reconcilePhaseState({
      phase,
      state: before,
      workspaceDir: input.workspaceDir,
      sessionDir: input.sessionDir
    })
    if (!next) continue
    if (next.deliverables.length > before.deliverables.length) deliverablesBackfilledPhases.push(phase)
    phases[phase] = next
    changedPhases.push(phase)
  }
  return { phases, changedPhases, deliverablesBackfilledPhases }
}
