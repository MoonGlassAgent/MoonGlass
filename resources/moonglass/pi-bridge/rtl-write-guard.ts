/**
 * RTL 写保护守卫（M4，设计文档 §5.4 三层诚实版之"尽力拦截"层）。
 *
 * 背景：VERIF 阶段根因确认后会派发独立的 RTL 修复会话（--fix-），修复窗口内
 * 其他会话对 rtl/ 的并发修改会让验证证据失去可比性。本模块在 pi 扩展的
 * tool_call 钩子里尽力拦截非修复会话对 rtl/ 的写操作：
 *
 *   - write/edit 工具：路径参数指向 rtl/ 即 block；
 *   - bash 工具：启发式检测对 rtl/ 的写入（重定向 >、>>、tee；sed -i / patch /
 *     mv / cp / dd / install / truncate 等命令的目标在 rtl/）。
 *
 * 诚实声明：这是**尽力拦截**，不是硬保证。bash 命令是自由文本，变形写法
 * （变量拼接、python -c、编辑器脚本等）检不出即放行；绕过拦截的修改由
 * rtlHash 全局失鲜兜底（旧证据作废重跑），并靠主进程的事后审计
 * （rtl-fix-audit-<RC-id>.json，前后快照 diff + 本模块记录的
 * rtl-fix-blocked-attempts.json）供签核审查。不得把本守卫当作
 * "RTL 绝未被绕过修改"的签核依据。
 *
 * 生效条件（两个同时满足）：
 *   1. 工作区存在 verification/results/rtl-fix-in-progress.json（主进程在
 *      修复会话派发时写入、settle 后清除）；
 *   2. 本进程没有 MOONGLASS_RTL_FIX_SESSION 环境变量（修复会话自身由主进程
 *      spawn 时注入该变量，修复会话必须能写 rtl/）。
 *
 * 纯函数模块：仅依赖 node:fs / node:path，供 moonglass-tools.ts 注册钩子，
 * 并可由冒烟脚本以 ts.transpileModule 方式转译后直接测试。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** 修复中标志（主进程写入；此处只读 rootCauseId 用于拦截文案） */
export interface RtlFixInProgressFlag {
  rootCauseId: string
  scenarioId?: string
  fixSessionName?: string
  startedAt?: string
}

const FLAG_RELATIVE_PATH = join('verification', 'results', 'rtl-fix-in-progress.json')
const BLOCKED_ATTEMPTS_RELATIVE_PATH = join('verification', 'results', 'rtl-fix-blocked-attempts.json')

/** 读取修复中标志；不存在或损坏时返回 null（视为无修复窗口，全部放行）。 */
export function readRtlFixFlag(workspace: string): RtlFixInProgressFlag | null {
  try {
    const data = JSON.parse(readFileSync(join(workspace, FLAG_RELATIVE_PATH), 'utf-8')) as Record<string, unknown>
    const rootCauseId = String(data.rootCauseId ?? '')
    if (!rootCauseId) return null
    return {
      rootCauseId,
      scenarioId: typeof data.scenarioId === 'string' ? data.scenarioId : undefined,
      fixSessionName: typeof data.fixSessionName === 'string' ? data.fixSessionName : undefined,
      startedAt: typeof data.startedAt === 'string' ? data.startedAt : undefined
    }
  } catch {
    return null
  }
}

/**
 * 判断目标路径（相对或绝对，兼容正反斜杠）是否指向工作区 rtl/ 目录下。
 * 统一为正斜杠后解析：rtl/ 下不会存在字面反斜杠文件名，反向兼容代价可忽略。
 */
export function isRtlPath(workspace: string, target: string): boolean {
  const cleaned = target.trim().replace(/^["']+|["']+$/g, '')
  if (!cleaned) return false
  const absolute = resolve(workspace, cleaned.replaceAll('\\', '/'))
  const rel = relative(resolve(workspace), absolute).replaceAll('\\', '/')
  return rel === 'rtl' || rel.startsWith('rtl/')
}

/**
 * bash 命令的 rtl/ 写入启发式检测：命中返回目标摘要，未命中返回 null（放行）。
 *
 * 覆盖的常见形态：
 *   - 重定向：`> rtl/x.v`、`>> rtl/x.v`、`2> rtl/log`、`cat x >rtl/y.v`、`tee rtl/x.v`
 *   - 就地/写文件命令：sed -i（含 --in-place）、patch、mv、truncate 的任一路径参数；
 *     cp / install 的目标（最后一个非选项参数）；dd 的 of= 输出
 *
 * 已知漏检（诚实放行）：变量/子 shell 拼接的路径、python -c 等脚本内写文件、
 * patch 从 stdin 读补丁按补丁内路径落盘等。这些由 rtlHash 失鲜与事后审计兜底。
 */
export function detectBashRtlWrite(workspace: string, command: string): string | null {
  const targets: string[] = []
  // 命令按分隔符拆段（&&、||、;、|、&、换行），逐段识别命令名
  for (const segment of command.split(/&&|\|\||[;|&\n]/)) {
    // 重定向目标：`>`/`>>`（可带 fd 前缀如 2>），目标可连写或跟空格；>& 不算写文件
    for (const match of segment.matchAll(/[0-9]*>>?\s*(["']?)([^\s"'>&|;]+)\1/g)) {
      if (match[2]) targets.push(match[2])
    }
    const tokens = (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [])
      .map((token) => token.replace(/^["']+|["']+$/g, ''))
      .filter(Boolean)
    if (tokens.length === 0) continue
    const cmdName = tokens[0].split(/[\\/]/).pop() ?? ''
    const args = tokens.slice(1).filter((token) => !token.startsWith('-'))
    if (cmdName === 'tee') {
      targets.push(...args)
    } else if (cmdName === 'sed' && tokens.slice(1).some((token) => /^-[^-]*i/.test(token) || token === '--in-place')) {
      // sed -i 的文件参数与脚本表达式混在一起；脚本内容不会解析进 rtl/，逐个参数试即可
      targets.push(...args)
    } else if (cmdName === 'mv' || cmdName === 'truncate' || cmdName === 'patch') {
      // mv 任一参数在 rtl/ 都会改动 rtl/（移出即删除）；truncate/patch 的文件参数都是目标
      targets.push(...args)
    } else if (cmdName === 'cp' || cmdName === 'install') {
      // 目标 = 最后一个非选项参数
      const destination = args.at(-1)
      if (destination) targets.push(destination)
    } else if (cmdName === 'dd') {
      for (const token of tokens.slice(1)) if (token.startsWith('of=')) targets.push(token.slice(3))
    }
  }
  for (const target of targets) {
    if (isRtlPath(workspace, target)) return target
  }
  return null
}

/** 被拦截尝试的审计记录（追加到 rtl-fix-blocked-attempts.json，供事后审计统计） */
export interface BlockedAttemptRecord {
  timestamp: string
  /** pi 注入的 PI_SESSION_FILE（哪个会话试图写） */
  sessionFile: string | null
  toolName: string
  /** 目标摘要（路径或 bash 命中的目标 token） */
  target: string
}

/** 追加一条拦截记录；读不到旧文件时按空数组起写。 */
export function appendBlockedAttempt(workspace: string, record: BlockedAttemptRecord): void {
  const path = join(workspace, BLOCKED_ATTEMPTS_RELATIVE_PATH)
  let list: unknown[] = []
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as unknown
    if (Array.isArray(data)) list = data
  } catch { /* 首次写入或文件损坏：按空数组起写 */ }
  list.push(record)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(list, null, 2), 'utf-8')
}

/** 守卫的运行时探针（默认读进程环境变量；测试时注入桩） */
export interface RtlWriteGuardRuntime {
  /** 本进程是否为 RTL 修复会话（MOONGLASS_RTL_FIX_SESSION 由主进程 spawn 时注入） */
  isFixSession: () => boolean
  /** 审计记录用的会话文件标识（pi 注入的 PI_SESSION_FILE） */
  sessionFile: () => string | undefined
}

const defaultRuntime: RtlWriteGuardRuntime = {
  isFixSession: () => Boolean(process.env.MOONGLASS_RTL_FIX_SESSION),
  sessionFile: () => process.env.PI_SESSION_FILE
}

export interface RtlWriteGuardBlock {
  block: true
  reason: string
}

/**
 * 构造 tool_call 钩子守卫（pi.on('tool_call', ...) 的 handler）。
 * 返回 undefined 表示放行；返回 { block, reason } 表示拦截。
 * getWorkspace 惰性取工作区（pi 子进程 cwd 即项目工作目录），便于测试注入。
 */
export function createRtlWriteGuard(
  getWorkspace: () => string,
  runtime: RtlWriteGuardRuntime = defaultRuntime
): (event: { toolName: string; input: unknown }) => RtlWriteGuardBlock | undefined {
  return (event) => {
    const workspace = getWorkspace()
    const flag = readRtlFixFlag(workspace)
    if (!flag) return undefined
    // 修复会话自身必须能写 rtl/（职责就是执行已确认修复）
    if (runtime.isFixSession()) return undefined

    const input = (event.input ?? {}) as Record<string, unknown>
    let target: string | null = null
    if (event.toolName === 'write' || event.toolName === 'edit') {
      const path = String(input.path ?? '')
      if (isRtlPath(workspace, path)) target = path
    } else if (event.toolName === 'bash') {
      target = detectBashRtlWrite(workspace, String(input.command ?? ''))
    }
    if (!target) return undefined

    try {
      appendBlockedAttempt(workspace, {
        timestamp: new Date().toISOString(),
        sessionFile: runtime.sessionFile() ?? null,
        toolName: event.toolName,
        target
      })
    } catch { /* 审计落盘失败不影响拦截本身 */ }
    return {
      block: true,
      reason: `RTL 修复会话 ${flag.rootCauseId} 进行中，rtl/ 暂时只读（写保护为尽力拦截；本次目标：${target}）。请等待修复完成后再修改 RTL。`
    }
  }
}
