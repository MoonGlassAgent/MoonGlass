/**
 * EDA 工具执行公共底层（工具定位 / PATH 环境 / 进程执行 / 取消信号）
 *
 * 本文件被 @moonglass/eda-bridge 与 pi-bridge 扩展共同使用：
 * - eda-bridge 通过 package 路径 import。
 * - pi-bridge 的 moonglass-tools.ts 通过运行时复制到 userData 后以相对路径 import。
 * 因此本文件必须**仅依赖 Node 内置模块**，禁止引用 workspace 包或 @shared/types。
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, extname, join, normalize, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const EXEC_TIMEOUT_MS = 60_000
export const MAX_BUFFER = 8 * 1024 * 1024

/** Windows 上 oss-cad-suite 的 verilator 是无扩展名脚本，需回退到 verilator_bin.exe */
export const VERILATOR_CANDIDATES = process.platform === 'win32'
  ? ['verilator_bin.exe', 'verilator.exe', 'verilator']
  : ['verilator']

/** Yosys 可执行文件候选名 */
export const YOSYS_CANDIDATES = process.platform === 'win32' ? ['yosys.exe', 'yosys'] : ['yosys']

/** Verible lint 可执行文件候选名 */
export const VERIBLE_CANDIDATES = ['verible-verilog-lint']

export interface RunResult {
  stdout: string
  stderr: string
  code: number | null
}

const MINGW_RUNTIME_DLLS = [
  'libgcc_s_seh-1.dll',
  'libstdc++-6.dll',
  'libwinpthread-1.dll',
  'libvvp-1.dll'
]

function pathKey(value: string): string {
  const normalized = normalize(resolve(value))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function containsMinGWRuntime(dir: string): boolean {
  return process.platform === 'win32' && MINGW_RUNTIME_DLLS.some((name) => existsSync(join(dir, name)))
}

/**
 * 为单一工具链构造隔离 PATH。目标工具链的 bin/lib 固定在最前，其他携带
 * MinGW 运行时 DLL 的目录会被移除，防止 Windows 加载到不兼容版本。
 */
export function isolatedToolPath(toolPath: string, inheritedPath = process.env.PATH ?? ''): string {
  const bin = dirname(toolPath)
  const lib = join(bin, '..', 'lib')
  const selected = new Set([pathKey(bin), pathKey(lib)])
  const retained = inheritedPath
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !selected.has(pathKey(entry)))
    .filter((entry) => !containsMinGWRuntime(entry))
  return [bin, lib, ...retained].join(delimiter)
}

/** 在 PATH 中定位可执行文件（支持候选名列表） */
export async function locateTool(names: string[]): Promise<string | null> {
  const locator = process.platform === 'win32' ? 'where' : 'which'
  for (const name of names) {
    try {
      const { stdout } = await execFileAsync(locator, [name], { timeout: 5000 })
      const found = stdout.trim().split(/\r?\n/)[0]
      if (found) return found
    } catch {
      // 继续尝试下一个候选
    }
  }
  if (process.platform === 'win32') {
    const home = process.env.USERPROFILE ?? ''
    const localAppData = process.env.LOCALAPPDATA ?? ''
    const searchDirs = [
      ...((process.env.PATH ?? '').split(delimiter)),
      join(home, 'oss-cad-suite', 'oss-cad-suite', 'bin'),
      join(home, 'scoop', 'shims'),
      join(localAppData, 'Programs', 'GTKWave', 'bin'),
      join(localAppData, 'Programs', 'gtkwave', 'bin')
    ].filter(Boolean)
    for (const name of names) {
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

/**
 * 构造工具执行环境：把工具所在 bin 与同级 lib 提到 PATH 最前。
 * oss-cad-suite 的工具依赖自带 DLL（bin/lib），且必须位于 PATH 前端，
 * 否则会被系统中其他 mingw DLL（Strawberry Perl 等）抢占导致加载失败。
 */
export function toolEnv(toolPath: string): NodeJS.ProcessEnv {
  const bin = dirname(toolPath)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: isolatedToolPath(toolPath)
  }
  if (/verilator(?:_bin)?(?:\.exe)?$/i.test(toolPath)) {
    // Verilator 会把该值写入 Makefile；Windows 反斜杠会被 make 当作转义符吞掉。
    env.VERILATOR_ROOT = join(bin, '..', 'share', 'verilator').replace(/\\/g, '/')
  }
  return env
}

/** execFile 的宽松封装——ENOENT 时 reject（供 runWithFallback 候选回退），其余非零退出 resolve */
export function run(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  cwd?: string,
  timeoutMs: number = EXEC_TIMEOUT_MS
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const isWindowsScript = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(cmd)
    const executable = isWindowsScript ? (process.env.ComSpec ?? 'cmd.exe') : cmd
    const executableArgs = isWindowsScript ? ['/d', '/s', '/c', cmd, ...args] : args
    const child = execFile(
      executable,
      executableArgs,
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, env, signal, cwd },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(`工具未找到: ${cmd}`))
          return
        }
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: err ? ((err as { code?: number }).code ?? 1) : 0
        })
      }
    )
  })
}

/** 尝试多个候选名执行，返回第一个成功的结果 */
export async function runWithFallback(
  candidates: string[],
  args: string[],
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal
): Promise<RunResult & { cmd: string }> {
  for (const cmd of candidates) {
    try {
      const result = await run(cmd, args, env, signal)
      return { ...result, cmd }
    } catch {
      continue
    }
  }
  return { stdout: '', stderr: `所有候选均不可用: ${candidates.join(', ')}`, code: null, cmd: '' }
}

/** 断言文件存在，否则抛出清晰错误 */
export function ensureFileExists(filePath: string, label = '文件'): void {
  if (!existsSync(filePath)) {
    throw new Error(`${label}不存在: ${filePath}`)
  }
}
