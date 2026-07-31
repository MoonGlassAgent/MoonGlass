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
import { delimiter, dirname, join } from 'node:path'
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
    PATH: `${bin}${delimiter}${join(bin, '..', 'lib')}${delimiter}${process.env.PATH ?? ''}`
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
  cwd?: string
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER, env, signal, cwd },
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
