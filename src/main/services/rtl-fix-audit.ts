/**
 * RTL 修复窗口的修复中标志与事后审计（M4，设计文档 §5 方案 C）。
 *
 * 纯函数模块：仅依赖 node:fs / node:path，不引入 electron，
 * 供 AgentService 修复会话编排调用，并可由临时冒烟脚本直接转译测试
 * （与 rtl-fix-verdict.ts / verif-batch-verdict.ts 同口径）。
 *
 * 三层诚实版写保护中本模块承担的部分：
 *   - 修复中标志（rtl-fix-in-progress.json）：修复会话派发时写入、settle 后清除，
 *     pi-bridge 的写保护守卫据此判定是否进入只读窗口；应用重启时由 AgentService
 *     做 stale 清除（旧修复进程已死）。
 *   - 事后审计（rtl-fix-audit-<RC-id>.json）：修复窗口前后对 rtl/ 做快照 diff，
 *     统计窗口内被写保护拦截的尝试次数，供签核审查。
 *   - 尽力拦截层在 resources/moonglass/pi-bridge/rtl-write-guard.ts（pi 扩展侧）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

/** 修复中标志内容（落盘 verification/results/rtl-fix-in-progress.json） */
export interface RtlFixInProgressFlag {
  rootCauseId: string
  scenarioId: string
  fixSessionName: string
  startedAt: string
}

const RESULTS_RELATIVE_DIR = join('verification', 'results')
const FLAG_FILE_NAME = 'rtl-fix-in-progress.json'
const BLOCKED_ATTEMPTS_FILE_NAME = 'rtl-fix-blocked-attempts.json'

export function rtlFixFlagPath(workspace: string): string {
  return join(workspace, RESULTS_RELATIVE_DIR, FLAG_FILE_NAME)
}

/** 读取修复中标志；不存在或损坏返回 null。 */
export function readRtlFixFlag(workspace: string): RtlFixInProgressFlag | null {
  try {
    const data = JSON.parse(readFileSync(rtlFixFlagPath(workspace), 'utf-8')) as Record<string, unknown>
    const rootCauseId = String(data.rootCauseId ?? '')
    if (!rootCauseId) return null
    return {
      rootCauseId,
      scenarioId: String(data.scenarioId ?? ''),
      fixSessionName: String(data.fixSessionName ?? ''),
      startedAt: String(data.startedAt ?? '')
    }
  } catch {
    return null
  }
}

/** 写入修复中标志（临时文件 + rename 原子替换，避免守卫读到半截 JSON）。 */
export function writeRtlFixFlag(workspace: string, flag: RtlFixInProgressFlag): void {
  const path = rtlFixFlagPath(workspace)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, JSON.stringify(flag, null, 2), 'utf-8')
  renameSync(temporary, path)
}

/**
 * 清除修复中标志。expectedSessionName 提供时仅当标志属于该会话才清除，
 * 防止先 settle 的旧修复会话误清后继修复会话刚写入的标志。
 * 返回是否实际发生了清除。
 */
export function clearRtlFixFlag(workspace: string, expectedSessionName?: string): boolean {
  const path = rtlFixFlagPath(workspace)
  if (!existsSync(path)) return false
  if (expectedSessionName) {
    const flag = readRtlFixFlag(workspace)
    if (flag && flag.fixSessionName !== expectedSessionName) return false
  }
  try {
    rmSync(path, { force: true })
    return true
  } catch {
    return false
  }
}

// ============================================================
// 事后审计：rtl/ 前后快照 diff
// ============================================================

export interface RtlTreeEntry {
  size: number
  mtimeMs: number
}

/** 快照键：rtl/ 下的相对路径（统一正斜杠） */
export type RtlTreeSnapshot = Record<string, RtlTreeEntry>

/** 快照排除的常见非源码/构建产物目录 */
const SNAPSHOT_EXCLUDED_DIRS = new Set(['.git', 'node_modules', '__pycache__', 'obj_dir', 'sim_build'])

/** 递归快照 rtl/（相对路径 → size + mtimeMs）；rtl/ 不存在或读失败时按空树处理。 */
export function snapshotRtlTree(workspace: string): RtlTreeSnapshot {
  const root = join(workspace, 'rtl')
  const snapshot: RtlTreeSnapshot = {}
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SNAPSHOT_EXCLUDED_DIRS.has(entry.name)) walk(full)
      } else if (entry.isFile()) {
        try {
          const stat = statSync(full)
          snapshot[relative(root, full).replaceAll('\\', '/')] = { size: stat.size, mtimeMs: stat.mtimeMs }
        } catch { /* 并发变化的文件由下一次快照捕捉 */ }
      }
    }
  }
  walk(root)
  return snapshot
}

export interface RtlAuditDiff {
  /** 两边都存在但 size 或 mtimeMs 变化 */
  changed: string[]
  created: string[]
  deleted: string[]
}

export function diffRtlSnapshots(before: RtlTreeSnapshot, after: RtlTreeSnapshot): RtlAuditDiff {
  const changed: string[] = []
  const created: string[] = []
  const deleted: string[] = []
  for (const [path, entry] of Object.entries(after)) {
    const previous = before[path]
    if (!previous) created.push(path)
    else if (previous.size !== entry.size || previous.mtimeMs !== entry.mtimeMs) changed.push(path)
  }
  for (const path of Object.keys(before)) {
    if (!(path in after)) deleted.push(path)
  }
  return { changed: changed.sort(), created: created.sort(), deleted: deleted.sort() }
}

/** 修复窗口审计记录（落盘 verification/results/rtl-fix-audit-<RC-id>.json） */
export interface RtlFixAudit {
  rootCauseId: string
  scenarioId: string
  fixSessionName: string
  startedAt: string
  settledAt: string
  changed: string[]
  created: string[]
  deleted: string[]
  /** 窗口内被写保护守卫拦截的尝试次数（读 rtl-fix-blocked-attempts.json 本窗口记录） */
  blockedAttempts: number
}

/** 落盘审计文件，返回文件路径。 */
export function writeRtlFixAudit(workspace: string, audit: RtlFixAudit): string {
  const safeId = audit.rootCauseId.replaceAll(/[^A-Za-z0-9_-]/g, '-')
  const path = join(workspace, RESULTS_RELATIVE_DIR, `rtl-fix-audit-${safeId}.json`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(audit, null, 2), 'utf-8')
  return path
}

/**
 * 统计拦截账本（rtl-fix-blocked-attempts.json）中落在 [windowStart, windowEnd]
 * 窗口内的记录数（ISO 时间戳字典序比较）；账本缺失/损坏按 0 处理。
 */
export function countBlockedAttempts(workspace: string, windowStart: string, windowEnd: string): number {
  try {
    const data = JSON.parse(readFileSync(join(workspace, RESULTS_RELATIVE_DIR, BLOCKED_ATTEMPTS_FILE_NAME), 'utf-8')) as unknown
    if (!Array.isArray(data)) return 0
    return data.filter((item) => {
      const timestamp = (item as Record<string, unknown> | null)?.timestamp
      return typeof timestamp === 'string' && timestamp >= windowStart && timestamp <= windowEnd
    }).length
  } catch {
    return 0
  }
}

/**
 * 派发门控判定（M4 §5.2）：修复会话进行中返回拒绝/暂停原因，否则 null。
 * 门控只拦新派发，不强杀在跑批次/仿真（设计 §5.3）；
 * 批次循环（pause）等待修复 settle 后自动续跑（托管 VERIF 断档修复，e2e 实测 2026-09-28），
 * 单次派发（reject）仍直接拒绝，由修复结果的 follow-up 引导验证会话继续（§5.5）。
 */
export function rtlFixGateReason(activeFixSessionName: string | undefined, mode: 'reject' | 'pause'): string | null {
  if (!activeFixSessionName) return null
  return mode === 'reject'
    ? `RTL 修复会话 ${activeFixSessionName} 进行中，rtl/ 处于写保护窗口，拒绝派发新验证批次；修复完成后由修复结果引导继续验证`
    : `等待 RTL 修复完成：修复会话 ${activeFixSessionName} 进行中，暂停派发新批次，修复 settle 后自动续跑`
}
