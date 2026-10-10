/**
 * 模块级轻量 UT（MODULE-UT，设计文档 docs/MODULE-UT-DESIGN-ZH-CN.md）：
 * UT 会话锁账本、互斥门控纯函数与 UT 会话 prompt 构造。
 *
 * 纯函数模块：仅依赖 node:fs / node:path / node:crypto，不引入 electron，
 * 供 AgentService 编排调用，并可由临时冒烟脚本直接转译测试
 * （与 rtl-fix-audit.ts / verif-batch-verdict.ts 同口径）。
 *
 * 设计口径（§4/§5）：
 *  - 锁是账本文件（verification/results/ut-sessions.json，活跃计数制），不在内存：
 *    多模块 UT 可并行，应用重启经 reconcileModuleUtAfterRestart 一律释放为 interrupted；
 *  - 锁负责互斥：UT 锁非空期间主验证运行循环不派回归拍（时序互斥，非冻结 hash）；
 *  - UT 走 probe 隔离通道，不进闭环证据链（§1 定位：修复信心工具，不是证据替代品）。
 */

import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { renameSyncWithRetry } from './atomic-write.ts'

/** UT 会话锁账本相对路径（verification/results/ut-sessions.json） */
const UT_LEDGER_REL_PATH = join('verification', 'results', 'ut-sessions.json')

/** UT 报告隔离目录相对路径根（probe 隔离区口径：verification/results/ut/<module>/） */
const UT_REPORT_REL_ROOT = join('verification', 'results', 'ut')

/** 软建议阈值（§2）：同一 RTL 文件在近期修复审计中出现 ≥2 次即提示"修复密集" */
export const MODULE_UT_CHURN_THRESHOLD = 2

/** 软建议去重窗口：同一模块 1 小时内不重复提示 */
export const MODULE_UT_SUGGEST_COOLDOWN_MS = 60 * 60_000

/** UT 会话锁状态：active（进行中）/ completed（正常 settle）/ interrupted（异常/超时/重启对账） */
export type ModuleUtSessionState = 'active' | 'completed' | 'interrupted'

/** UT 会话锁账本条目 */
export interface ModuleUtSessionEntry {
  /** 会话标识：UT-<8hex> */
  utId: string
  /** 目标模块名（与 rtl/ 下 <module>.v 对应） */
  module: string
  /** 独立 UT 会话名（phase-verif--ut-<module>） */
  sessionName: string
  state: ModuleUtSessionState
  startedAt: string
  settledAt?: string
  /** 报告落盘位置（verification/results/ut/<module>/） */
  reportPath?: string
  /** 异常路径备注（不静默吞） */
  note?: string
}

/** UT 会话锁账本（version:1，sessions 新在后追加） */
export interface ModuleUtLedger {
  version: 1
  sessions: ModuleUtSessionEntry[]
}

/** 启动对账被中断的 UT 锁清单项（供调用方发提示消息） */
export interface ModuleUtInterruption {
  utId: string
  module: string
  sessionName: string
  startedAt: string
}

export function moduleUtLedgerPath(workspace: string): string {
  return join(workspace, UT_LEDGER_REL_PATH)
}

/** 归一化单条账本记录；字段非法（模块名/utId/会话名为空、状态非法）返回 null（坏条目丢弃）。 */
function normalizeModuleUtEntry(value: unknown): ModuleUtSessionEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const utId = String(raw.utId ?? '')
  const module = String(raw.module ?? '')
  const sessionName = String(raw.sessionName ?? '')
  const state = raw.state
  const startedAt = String(raw.startedAt ?? '')
  if (!utId || !module || !sessionName || !startedAt) return null
  if (state !== 'active' && state !== 'completed' && state !== 'interrupted') return null
  const entry: ModuleUtSessionEntry = { utId, module, sessionName, state, startedAt }
  if (typeof raw.settledAt === 'string' && raw.settledAt) entry.settledAt = raw.settledAt
  if (typeof raw.reportPath === 'string' && raw.reportPath) entry.reportPath = raw.reportPath
  if (typeof raw.note === 'string' && raw.note) entry.note = raw.note
  return entry
}

/**
 * 读取归一 UT 会话锁账本：缺文件/坏 JSON/结构非法一律降级为空账本（version:1, sessions:[]），
 * 坏条目丢弃、好条目保留——账本损坏不得阻断 UT 派发与互斥判定。
 */
export function readModuleUtLedger(workspace: string): ModuleUtLedger {
  try {
    const parsed = JSON.parse(readFileSync(moduleUtLedgerPath(workspace), 'utf-8')) as unknown
    if (typeof parsed !== 'object' || parsed === null) return { version: 1, sessions: [] }
    const rawSessions: unknown = (parsed as Record<string, unknown>).sessions
    const sessions: unknown[] = Array.isArray(rawSessions) ? rawSessions : []
    return {
      version: 1,
      sessions: sessions
        .map((item) => normalizeModuleUtEntry(item))
        .filter((item): item is ModuleUtSessionEntry => item !== null)
    }
  } catch {
    return { version: 1, sessions: [] }
  }
}

/** 原子写 UT 会话锁账本（临时文件 + rename，避免读到半截 JSON；rename 走 EPERM/EBUSY 退避重试）。 */
export function writeModuleUtLedger(workspace: string, ledger: ModuleUtLedger): void {
  const path = moduleUtLedgerPath(workspace)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, JSON.stringify({ version: 1, sessions: ledger.sessions }, null, 2), 'utf-8')
  renameSyncWithRetry(temporary, path)
}

/** 生成 UT 会话标识：UT-<8hex>（大写，与 RC-<8hex> 同风格）。 */
export function generateUtId(): string {
  return `UT-${randomBytes(4).toString('hex').toUpperCase()}`
}

/**
 * 获取 UT 会话锁（同模块 active 幂等拒绝，不同模块并行合法）：
 * 同模块已有 active 条目 → 返回拒绝原因（不重复加锁）；否则追加 active 条目并落盘。
 */
export function acquireModuleUt(
  workspace: string,
  moduleName: string,
  sessionName: string,
  now = new Date().toISOString()
): { ok: true; utId: string } | { ok: false; reason: string } {
  const ledger = readModuleUtLedger(workspace)
  const active = ledger.sessions.find((entry) => entry.module === moduleName && entry.state === 'active')
  if (active) {
    return {
      ok: false,
      reason: `模块 ${moduleName} 的 UT 已在进行中（${active.utId}，会话 ${active.sessionName}，开始于 ${active.startedAt}），同模块 UT 不重复派发；不同模块可并行`
    }
  }
  const utId = generateUtId()
  ledger.sessions.push({ utId, module: moduleName, sessionName, state: 'active', startedAt: now })
  writeModuleUtLedger(workspace, ledger)
  return { ok: true, utId }
}

/**
 * 释放 UT 会话锁（settle 落 completed/interrupted）：
 * 按 utId 定位 active 条目回填终态/settledAt/reportPath/note；找不到或已终态返回 null（幂等）。
 */
export function releaseModuleUt(
  workspace: string,
  utId: string,
  outcome: 'completed' | 'interrupted',
  extra?: { reportPath?: string; note?: string },
  now = new Date().toISOString()
): ModuleUtSessionEntry | null {
  const ledger = readModuleUtLedger(workspace)
  const entry = ledger.sessions.find((item) => item.utId === utId && item.state === 'active')
  if (!entry) return null
  entry.state = outcome
  entry.settledAt = now
  if (extra?.reportPath) entry.reportPath = extra.reportPath
  if (extra?.note) entry.note = extra.note
  writeModuleUtLedger(workspace, ledger)
  return entry
}

/** 进行中的 UT 会话数（主循环互斥门控的数据源）。 */
export function moduleUtActiveCount(workspace: string): number {
  return readModuleUtLedger(workspace).sessions.filter((entry) => entry.state === 'active').length
}

/** 进行中的 UT 模块清单（去重，账本顺序）。 */
export function moduleUtActiveModules(workspace: string): string[] {
  const modules: string[] = []
  for (const entry of readModuleUtLedger(workspace).sessions) {
    if (entry.state === 'active' && !modules.includes(entry.module)) modules.push(entry.module)
  }
  return modules
}

/**
 * 主验证运行循环互斥门控（§4 时序互斥）：UT 锁非空返回挂起原因（列出进行中的模块），
 * 锁归零返回 null。paused-human(module-ut-active) 会被证据轮询在 UT 落盘/锁释放写账后自动续跑。
 */
export function moduleUtRunLoopGateReason(workspace: string): string | null {
  const modules = moduleUtActiveModules(workspace)
  if (modules.length === 0) return null
  return `模块 UT 进行中（${modules.length} 个）：${modules.join('、')}——主循环互斥挂起中，UT 全部结束后自动恢复`
}

/**
 * 启动对账（§5 强关恢复）：state=active 的 UT 锁一律释放并记 interrupted（原因 app-restart），
 * 因为会话进程已随应用退出消失。返回被中断清单（供调用方发提示消息，含"RTL 可能处于半截
 * 修改状态，请确认现场后再恢复"措辞）；无中断返回空数组（幂等）。
 */
export function reconcileModuleUtAfterRestart(workspace: string, now = new Date().toISOString()): ModuleUtInterruption[] {
  const ledger = readModuleUtLedger(workspace)
  const interrupted: ModuleUtInterruption[] = []
  for (const entry of ledger.sessions) {
    if (entry.state !== 'active') continue
    entry.state = 'interrupted'
    entry.settledAt = now
    entry.note = 'app-restart：应用重启导致 UT 会话进程不存在，锁自动释放；RTL 可能处于半截修改状态，请确认现场后再恢复'
    interrupted.push({ utId: entry.utId, module: entry.module, sessionName: entry.sessionName, startedAt: entry.startedAt })
  }
  if (interrupted.length > 0) writeModuleUtLedger(workspace, ledger)
  return interrupted
}

/** 模块名 → 报告隔离目录（verification/results/ut/<module>/，模块名做路径安全化）。 */
export function moduleUtReportRelDir(moduleName: string): string {
  const safe = moduleName.replaceAll(/[^A-Za-z0-9_.-]/g, '-')
  return `${join(UT_REPORT_REL_ROOT, safe)}/`.replaceAll('\\', '/')
}

/**
 * 模块名 → rtl/ 设计文件清单匹配（readRtlInputs(workspace).designFiles 绝对路径，
 * 取 basename 去 .v 扩展与模块名精确相等）；无匹配返回空数组（调用方拒绝派发）。
 */
export function matchModuleRtlFiles(moduleName: string, designFiles: string[]): string[] {
  return designFiles.filter((file) => {
    const base = file.replaceAll('\\', '/').split('/').pop() ?? ''
    return base.replace(/\.v$/i, '') === moduleName
  })
}

/**
 * 软建议 churn 统计（§2）：rtl-fix-audit-*.json 的 changed 字段中 rtlRelPath（正斜杠归一）
 * 出现的次数——即该 RTL 文件近期被修复窗口改动的次数。
 */
export function countRtlFileFixChurn(workspace: string, rtlRelPath: string): number {
  const resultsDir = join(workspace, 'verification', 'results')
  let auditFiles: string[]
  try {
    auditFiles = readdirSync(resultsDir).filter((name) => /^rtl-fix-audit-.*\.json$/.test(name))
  } catch {
    return 0
  }
  const target = rtlRelPath.replaceAll('\\', '/')
  let count = 0
  for (const name of auditFiles) {
    try {
      const parsed = JSON.parse(readFileSync(join(resultsDir, name), 'utf-8')) as { changed?: unknown }
      const changed = Array.isArray(parsed.changed) ? parsed.changed.map(String) : []
      if (changed.some((item) => item.replaceAll('\\', '/') === target)) count += 1
    } catch {
      // 单个审计文件损坏跳过，不影响整体计数
    }
  }
  return count
}

/** 软建议去重：同一模块上次提示距 nowMs 超过冷却窗口（或从未提示）才再次提示。 */
export function moduleUtSuggestionDue(lastHintAtMs: number | null, nowMs: number): boolean {
  if (lastHintAtMs === null) return true
  return nowMs - lastHintAtMs >= MODULE_UT_SUGGEST_COOLDOWN_MS
}

/** 宽松 JSON 读取：缺文件/坏 JSON/结构不符返回 fallback。 */
function readJsonFile<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return fallback
  }
}

/** 根因链记录（verification/results/root-causes.json；接受 {records:[...]} 或裸数组，坏条目丢弃）。 */
function readRootCauseRecords(workspace: string): Array<Record<string, unknown>> {
  const parsed = readJsonFile<unknown>(join(workspace, 'verification', 'results', 'root-causes.json'), null)
  const rawRecords: unknown = typeof parsed === 'object' && parsed !== null
    ? (parsed as Record<string, unknown>).records
    : parsed
  const raw: unknown[] = Array.isArray(rawRecords) ? rawRecords : []
  return raw.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
}

/** 修复判定账本记录（verification/results/rtl-fix-outcomes.json）。 */
function readRtlFixOutcomeRecords(workspace: string): Array<Record<string, unknown>> {
  const parsed = readJsonFile<Record<string, unknown> | null>(join(workspace, 'verification', 'results', 'rtl-fix-outcomes.json'), null)
  const rawOutcomes: unknown = parsed?.outcomes
  const raw: unknown[] = Array.isArray(rawOutcomes) ? rawOutcomes : []
  return raw.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
}

/**
 * 收集该模块的近期失败指纹/根因摘要（派发 prompt 附录，§6"含历史失败指纹"）：
 * root-causes.json 中 confirmed 且内容提及模块名的记录（无命中时取最近 3 条 confirmed），
 * rtl-fix-outcomes.json 中提及模块名的修复判定（无命中时取最近 3 条）；
 * 均为尽力而为的只读投影，缺文件/坏 JSON 返回空。
 */
export function collectModuleUtFailureHints(
  workspace: string,
  moduleName: string
): { rootCauseHints: string[]; fixOutcomeHints: string[] } {
  const needle = moduleName.toLowerCase()
  const rootCauses = readRootCauseRecords(workspace)
  const confirmed = rootCauses.filter((item) => item.verdict === 'confirmed')
  const mentionModule = (item: Record<string, unknown>): boolean => JSON.stringify(item).toLowerCase().includes(needle)
  const picked = confirmed.filter(mentionModule)
  const rootCauseHints = (picked.length > 0 ? picked : confirmed.slice(-3)).map((item) => {
    const id = String(item.id ?? '')
    const rootCause = String(item.rootCause ?? '').trim()
    const signature = String(item.failureSignature ?? '').trim()
    const scenarioId = String(item.scenarioId ?? '')
    return [id && `根因 ${id}`, scenarioId && `场景 ${scenarioId}`, rootCause, signature && `失败指纹：${signature}`]
      .filter((part): part is string => Boolean(part))
      .join('；')
  }).filter((line) => line.length > 0)

  const outcomes = readRtlFixOutcomeRecords(workspace)
  const outcomePicked = outcomes.filter(mentionModule)
  const fixOutcomeHints = (outcomePicked.length > 0 ? outcomePicked : outcomes.slice(0, 3)).map((item) => {
    const rootCauseId = String(item.rootCauseId ?? '')
    const judgment = String(item.judgment ?? '')
    const reason = String(item.reason ?? '').trim()
    return [rootCauseId && `根因 ${rootCauseId}`, judgment && `判定 ${judgment}`, reason]
      .filter((part): part is string => Boolean(part))
      .join('；')
  }).filter((line) => line.length > 0)

  return { rootCauseHints, fixOutcomeHints }
}

/**
 * 构造模块 UT 会话 prompt（§6 工作要点契约；派发前由主进程选定模型，prompt 不绑定模型身份）：
 * 单上下文完成"读模块+接口 → 搭最简 cocotb TB → 定向用例（含历史失败指纹）→ 跑 → 改 → 再跑"，
 * probe 隔离、不动主验证环境、报告落盘隔离目录、迭代自由、禁止扩大范围。
 */
export function buildModuleUtPrompt(input: {
  moduleName: string
  rtlFiles: string[]
  rootCauseHints: string[]
  fixOutcomeHints: string[]
}): string {
  const reportDir = moduleUtReportRelDir(input.moduleName)
  const fileLines = input.rtlFiles.map((file) => `- ${file.replaceAll('\\', '/')}`).join('\n')
  const rootCauseSection = input.rootCauseHints.length > 0
    ? input.rootCauseHints.map((line) => `- ${line}`).join('\n')
    : '- （无：root-causes.json 中暂无该模块相关的 confirmed 根因）'
  const fixOutcomeSection = input.fixOutcomeHints.length > 0
    ? input.fixOutcomeHints.map((line) => `- ${line}`).join('\n')
    : '- （无：rtl-fix-outcomes.json 中暂无该模块相关的修复判定）'
  return [
    `你是 MoonGlass 派发的模块级轻量 UT 会话（probe 隔离通道），目标模块：${input.moduleName}。`,
    '',
    '本任务全程单上下文完成，无跨会话重复读入：读模块源码+接口 → 搭最简 cocotb 测试台 → 编写定向用例（含下方历史失败指纹）→ 跑 → 定位修改 → 再跑，直至定向用例全过或明确卡住。',
    '',
    `范围（钉死，禁止扩大）：只允许验证并修改模块 ${input.moduleName} 及其直接依赖；禁止扩大范围到其他模块（需要时由用户另行发起 UT）。目标模块对应 RTL 文件：`,
    fileLines,
    '',
    '隔离与诚实（底线）：',
    '- 全程走 probe 隔离通道（run_simulation purpose=\'probe\' 同款隔离）：不写 scenario_hits、不进验证态势、不计入闭环证据。你的结果是修复信心工具，不是证据替代品——闭环仍归 TOP 级回归，UT 通过不免除全量重回归。',
    '- 不动主验证环境：TOP 级验证环境（cocotb 基建/verilator shim/停滞保护）可复用但只读；测试台与全部 UT 产物只写在隔离目录，禁止修改主验证环境、scenario_hits、态势文件与任何闭环证据文件。',
    `- 报告落盘：${reportDir}（至少含 report.md：过/不过结论 + 发现 + 改动清单）。`,
    '',
    '迭代自由：RTL 修改不限次数（probe 隔离，主链此时互斥挂起）；每次改 RTL 前先确认问题定位，改动保持最小。',
    '结束条件：定向用例全过 + 报告落盘；或明确卡住——报告如实写明卡点与已排除的方向，锁照常释放，禁止硬撑空转。',
    '',
    '历史失败指纹 / 近期根因摘要（定向用例须覆盖这些模式；来源 root-causes.json / rtl-fix-outcomes.json）：',
    '近期 confirmed 根因：',
    rootCauseSection,
    '近期修复判定：',
    fixOutcomeSection,
    ''
  ].join('\n')
}
