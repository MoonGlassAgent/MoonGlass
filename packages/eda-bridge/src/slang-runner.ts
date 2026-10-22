/**
 * slang（SystemVerilog 编译器）elaborated AST 统一运行底座。
 *
 * 收敛此前分散的 slang 调用副本（structural-analyzer 的私有 executable/analyzerEnv、
 * dead-logic 的 locateSlang），调用形态与 tool-runner 底座保持一致：
 * - 定位：MOONGLASS_SLANG_PATH 显式覆盖优先，其次 locateTool(SLANG_CANDIDATES)；
 * - 环境：toolEnv 隔离 PATH（MinGW 运行时 DLL 防抢占）；
 * - 调用：--ast-json --ast-json-source-info --ignore-unknown-modules，AST 落盘缓存。
 *
 * AST 缓存：`<cacheDir>/<rtlHash>.json`（cacheDir 由调用方传入，slang-runner 不感知
 * userData；两个消费方传同一目录即共享缓存、不重复 elaborate）。缓存命中时不再调用
 * slang——slang 临时不可用也能复用上次 AST。
 *
 * 同步实现（spawnSync）：verification-intelligence-engine 的结构分析是同步 API，
 * 主进程 Design Browser 的 elaborate 可接受同步等待（实测 AST 生成 <1s）。
 *
 * 本文件会被复制到 pi-bridge 目录（eda-bridge/ 平铺复制集），必须仅依赖
 * Node 内置模块与本目录内模块（tool-runner）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { delimiter, extname, isAbsolute, join, relative } from 'node:path'
import { toolEnv } from './tool-runner.ts'

/** slang 可执行文件候选名（与 YOSYS_CANDIDATES 同口径） */
export const SLANG_CANDIDATES = process.platform === 'win32' ? ['slang.exe', 'slang'] : ['slang']

/** AST 消费上限（与 structural-analyzer 历史口径一致）：超限消费方回退旧管线 */
export const SLANG_AST_MAX_BYTES = 128 * 1024 * 1024

/** slang 单次 elaboration 墙钟上限（毫秒；实测 10 模块工程 <1s，宽裕取值防挂死） */
const SLANG_TIMEOUT_MS = 120_000

export interface SlangAstRequest {
  /** 工作区目录：作为 slang cwd；工作区内文件以相对路径传递（AST source_file 即工作区相对路径） */
  workspace: string
  /** 设计 RTL 文件（绝对或相对路径） */
  files: string[]
  /** AST 缓存目录（调用方传入，如 <userData>/moonglass/slang-ast-cache） */
  cacheDir: string
  /** 缓存键：RTL 输入内容哈希（路径 + 内容），由调用方按其哈希口径计算 */
  rtlHash: string
  /** 库文件（blackbox 视图）：slang -v 方式按需搜索，不参与重复定义 */
  libraryFiles?: string[]
  includeDirs?: string[]
  defines?: string[]
  topModule?: string
}

export type SlangAstOutcome =
  | { status: 'ok'; astPath: string; version: string; reused: boolean }
  | { status: 'missing' }
  | { status: 'failed'; log: string; astPath?: string }
  | { status: 'oversize'; astPath: string; sizeMB: number; version: string }

/**
 * slang 可执行文件定位：MOONGLASS_SLANG_PATH 显式覆盖优先（指向不存在则抛错），
 * 其次 PATH / 惯例目录。tool-runner 的 locateTool 是异步 API，而本底座是同步实现
 * （verification 结构分析链路为同步 API），此处用 spawnSync 复刻同等定位口径。
 */
export function locateSlang(): string | null {
  const override = process.env.MOONGLASS_SLANG_PATH?.trim()
  if (override) {
    if (existsSync(override)) return override
    throw new Error(`工具缺失：MOONGLASS_SLANG_PATH 指向的 slang 不存在 — ${override}`)
  }
  const command = process.platform === 'win32' ? 'where' : 'which'
  for (const name of SLANG_CANDIDATES) {
    const run = spawnSync(command, [name], { encoding: 'utf-8', windowsHide: true })
    const found = run.status === 0 ? run.stdout.split(/\r?\n/).find(Boolean)?.trim() : undefined
    if (found) return found
  }
  if (process.platform === 'win32') {
    const home = process.env.USERPROFILE ?? ''
    const localAppData = process.env.LOCALAPPDATA ?? ''
    const searchDirs = [
      ...(process.env.PATH ?? '').split(delimiter),
      join(home, 'oss-cad-suite', 'oss-cad-suite', 'bin'),
      join(home, 'scoop', 'shims'),
      join(localAppData, 'Programs', 'GTKWave', 'bin'),
      join(localAppData, 'Programs', 'gtkwave', 'bin')
    ].filter(Boolean)
    for (const name of SLANG_CANDIDATES) {
      const variants = extname(name) ? [name] : [`${name}.exe`, `${name}.cmd`, name]
      for (const dir of searchDirs) {
        for (const variant of variants) {
          const candidate = join(dir, variant)
          if (existsSync(candidate)) return candidate
        }
      }
    }
  }
  return null
}

/** AST 缓存文件路径（rtlHash 中的路径分隔符不安全字符由调用方负责，此处再兜底） */
export function slangAstPath(cacheDir: string, rtlHash: string): string {
  const safe = rtlHash.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64) || 'unknown'
  return join(cacheDir, `${safe}.json`)
}

/** 工作区内文件转 slang 命令行参数：相对路径优先（source_file 输出工作区相对口径） */
function slangFileArg(workspace: string, file: string): string {
  const absolute = isAbsolute(file) ? file : join(workspace, file)
  const rel = relative(workspace, absolute)
  // 工作区外的文件（库视图等）退回绝对路径
  return rel.startsWith('..') || isAbsolute(rel) ? absolute : rel
}

function slangVersion(slang: string, env: NodeJS.ProcessEnv): string {
  const run = spawnSync(slang, ['--version'], { encoding: 'utf-8', windowsHide: true, env })
  return run.status === 0 ? run.stdout.trim() : ''
}

/**
 * 获取 elaborated AST（缓存优先）。
 * - 缓存命中（存在且不超上限）：直接复用，reused=true，不要求 slang 可用；
 * - 缓存文件损坏由消费方解析时兜底（各自的回退路径处理），此处保持轻量。
 */
export function runSlangAst(request: SlangAstRequest): SlangAstOutcome {
  if (request.files.length === 0) return { status: 'failed', log: '没有可 elaboration 的 RTL 文件' }
  mkdirSync(request.cacheDir, { recursive: true })
  const astPath = slangAstPath(request.cacheDir, request.rtlHash)

  if (existsSync(astPath)) {
    const size = statSync(astPath).size
    const version = ((): string => {
      try {
        const slang = locateSlang()
        return slang ? slangVersion(slang, toolEnv(slang)) : 'cache'
      } catch {
        return 'cache'
      }
    })()
    if (size > SLANG_AST_MAX_BYTES) {
      return { status: 'oversize', astPath, sizeMB: Math.round(size / 1024 / 1024), version }
    }
    if (size === 0) rmSync(astPath, { force: true })
    else return { status: 'ok', astPath, version, reused: true }
  }

  const slang = locateSlang()
  if (!slang) return { status: 'missing' }
  const env = toolEnv(slang)
  const version = slangVersion(slang, env) || 'unknown'

  const args = ['--ast-json', astPath, '--ast-json-source-info', '--ignore-unknown-modules']
  for (const dir of request.includeDirs ?? []) args.push('-I', dir)
  for (const define of request.defines ?? []) args.push('-D', define)
  for (const library of request.libraryFiles ?? []) args.push('-v', slangFileArg(request.workspace, library))
  if (request.topModule) args.push('--top', request.topModule)
  for (const file of request.files) args.push(slangFileArg(request.workspace, file))

  const run = spawnSync(slang, args, {
    cwd: request.workspace,
    encoding: 'utf-8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    env,
    timeout: SLANG_TIMEOUT_MS,
    killSignal: 'SIGKILL'
  })
  if (run.status === 0 && existsSync(astPath)) {
    const size = statSync(astPath).size
    if (size > SLANG_AST_MAX_BYTES) {
      return { status: 'oversize', astPath, sizeMB: Math.round(size / 1024 / 1024), version }
    }
    return { status: 'ok', astPath, version, reused: false }
  }
  const tail = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.trim().split(/\r?\n/).slice(-12).join('\n')
  const reason = run.error ? `spawn 错误: ${run.error.message}` : run.signal ? `信号终止: ${run.signal}` : `退出码 ${run.status}`
  return {
    status: 'failed',
    log: `slang elaboration 失败（${version}，${reason}）\n${tail}`,
    astPath: existsSync(astPath) ? astPath : undefined
  }
}

/** 读取并解析缓存的 AST JSON（超限显式抛错，由调用方回退旧管线） */
export function readSlangAst(astPath: string): Record<string, unknown> {
  const size = statSync(astPath).size
  if (size > SLANG_AST_MAX_BYTES) {
    throw new Error(`Slang AST 为 ${Math.round(size / 1024 / 1024)}MB，超过 ${Math.round(SLANG_AST_MAX_BYTES / 1024 / 1024)}MB 消费上限: ${astPath}`)
  }
  return JSON.parse(readFileSync(astPath, 'utf-8')) as Record<string, unknown>
}

/**
 * 归一化 slang AST 的 source_file：反斜杠转正斜杠；绝对路径转工作区相对路径
 * （调用侧统一消费「工作区相对路径」口径，与 formal.ts 防线一致）。
 */
export function normalizeSlangSource(file: string, workspace: string): string {
  const normalized = file.replace(/\\/g, '/')
  if (!normalized) return ''
  return isAbsolute(normalized) ? relative(workspace, normalized).replace(/\\/g, '/') : normalized
}
