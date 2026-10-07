/**
 * EDA 工具执行公共底层（工具定位 / PATH 环境 / 进程执行 / 取消信号）
 *
 * 本文件被 @moonglass/eda-bridge 与 pi-bridge 扩展共同使用：
 * - eda-bridge 通过 package 路径 import。
 * - pi-bridge 的 moonglass-tools.ts 通过运行时复制到 userData 后以相对路径 import。
 * 因此本文件必须**仅依赖 Node 内置模块**，禁止引用 workspace 包或 @shared/types。
 */

import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, extname, join, normalize, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const EXEC_TIMEOUT_MS = 60_000
export const MAX_BUFFER = 8 * 1024 * 1024

// ---- 仿真停滞检测（挂死防护，刻意区别于 wall-clock 超时） ----
// 设计原则：仿真子进程不设 wall-clock 上限（防误杀合法长仿真），但“日志静默”是
// 挂死的典型指纹（实测 GMAC 批次 probe 仿真挂死后再无事件，墙钟被 60 分钟批次
// 超时兜底大量吞掉）。因此监视子进程 stdout/stderr：连续 N 毫秒没有任何新输出即
// 终止整个进程树并返回 stalled 标记；有持续输出的慢仿真（哪怕跑数小时）不受影响。
// 注意：完全静默但合法的慢仿真会在阈值处被杀——这是本防线的固有取舍，
// 可用 MOONGLASS_SIM_STALL_MS 按项目上调。

/** 停滞检测缺省阈值（毫秒）：连续无输出即判停滞；可用环境变量 MOONGLASS_SIM_STALL_MS 覆盖 */
export const DEFAULT_SIM_STALL_MS = 10 * 60 * 1000

/** 解析停滞阈值（毫秒）：显式参数 > 环境变量 MOONGLASS_SIM_STALL_MS > 缺省 10 分钟；<=0 视为禁用 */
export function resolveSimStallMs(param?: number): number {
  if (typeof param === 'number' && Number.isFinite(param) && param > 0) return param
  const envValue = Number(process.env.MOONGLASS_SIM_STALL_MS ?? '')
  return Number.isFinite(envValue) && envValue > 0 ? envValue : DEFAULT_SIM_STALL_MS
}

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
  /**
   * 停滞终止标记：stdout/stderr 连续 stallMs 毫秒无任何输出被强制终止（true 时 code 为
   * 被终止后的退出码）。区别于普通失败（进程自然退出非零）与普通 wall-clock 超时。
   */
  stalled?: boolean
  /** 本次生效的停滞阈值（毫秒）；未启用停滞检测时为 undefined */
  stallMs?: number
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

// ---- cocotb verilator 后端的 PATH 前置 shim（Windows） ----
// 实测本机 oss-cad-suite 的 verilator 是缺 Pod::Usage 的 perl wrapper，直接起不来；
// 且 shutil.which("verilator") 按 PATHEXT 解析会跳过无扩展名脚本、命中 PATH 里其他
// 工具链（如 msys2）的同名 wrapper——cocotb 的 Makefile/runner 经此拿到的一定是坏后端。
// 对策：在临时目录生成 verilator.cmd（内容=调用生成时已解析绝对路径的 verilator_bin.exe，
// 并前置设置正斜杠 VERILATOR_ROOT，与 toolEnv 同口径），由调用方把 shim 目录前置进
// 当次执行的 PATH，使任何按名字解析 verilator 的消费方都拿到可执行文件。
// 注意：cocotb 2.0.1 的 Python Runner 会把 verilator 经 "perl <which结果>" 调用，
// shim 只管“按名字解析到可执行后端”，runner 流程仍需 simulation.ts 的构建命令改写兜底。

/** shim 目录名（位于 os.tmpdir() 下，按用户隔离） */
export const VERILATOR_SHIM_DIR = join(tmpdir(), 'moonglass-verilator-shim')

export interface VerilatorShim {
  /** shim 目录：调用方前置进 PATH */
  dir: string
  /** 生成的 verilator.cmd 绝对路径 */
  cmdPath: string
  /** shim 实际指向的 verilator_bin.exe（绝对路径，生成时解析） */
  verilatorBin: string
  /** 写入 shim 的 VERILATOR_ROOT（正斜杠） */
  verilatorRoot: string
  /** 本次是否新生成（false=已存在且内容一致，直接复用） */
  created: boolean
}

/**
 * 幂等生成 cocotb verilator 后端的 PATH 前置 shim（仅 Windows；其他平台 verilator
 * 本身即二进制，无需 shim，调用方应按平台跳过）。已存在且内容一致时直接复用
 * （created=false）；内容不一致（bin 路径变更）时原子重写。
 * 找不到 verilator_bin.exe 时抛错——禁止静默回退到坏掉的 perl wrapper。
 */
export function ensureVerilatorShim(locatedVerilator: string): VerilatorShim {
  if (process.platform !== 'win32') {
    throw new Error('verilator shim 仅用于 Windows；其他平台 verilator 本身即可执行文件')
  }
  const binDir = dirname(locatedVerilator)
  // 定位结果若是无扩展名脚本（perl wrapper）或 verilator.exe 之外的形态，必须落到
  // 同目录 verilator_bin.exe；拿不到就明确报错，不得把坏 wrapper 留给 cocotb。
  let verilatorBin = locatedVerilator
  if (!/^verilator(?:_bin)?\.exe$/i.test(basename(locatedVerilator))) {
    const candidate = join(binDir, 'verilator_bin.exe')
    if (!existsSync(candidate)) {
      throw new Error(
        `cocotb verilator 后端不可用：${binDir} 下未找到可执行文件 verilator_bin.exe；` +
        `定位到的 ${locatedVerilator} 是损坏的 perl wrapper（oss-cad-suite 缺 Pod::Usage），禁止静默回退到坏 wrapper`
      )
    }
    verilatorBin = candidate
  }
  if (!existsSync(verilatorBin)) {
    throw new Error(`cocotb verilator 后端不可用：verilator_bin.exe 不存在: ${verilatorBin}`)
  }
  // 与 toolEnv 同口径：正斜杠，防 make 吞反斜杠转义
  const verilatorRoot = join(binDir, '..', 'share', 'verilator').replace(/\\/g, '/')
  const binForward = verilatorBin.replace(/\\/g, '/')
  const content = [
    '@echo off',
    'rem MoonGlass 自动生成（cocotb verilator 后端 shim，指向 verilator_bin.exe 绕过坏 perl wrapper）',
    'rem 内容一致时跳过重新生成；手改后下次生成会被覆盖',
    `set "VERILATOR_ROOT=${verilatorRoot}"`,
    `"${binForward}" %*`,
    ''
  ].join('\r\n')
  mkdirSync(VERILATOR_SHIM_DIR, { recursive: true })
  const cmdPath = join(VERILATOR_SHIM_DIR, 'verilator.cmd')
  let created = false
  if (!existsSync(cmdPath) || readFileSync(cmdPath, 'utf-8') !== content) {
    // 原子落盘：先写临时文件再改名，避免并发生成/半写状态
    const tmpPath = join(VERILATOR_SHIM_DIR, `verilator.cmd.${process.pid}.tmp`)
    writeFileSync(tmpPath, content, 'utf-8')
    renameSync(tmpPath, cmdPath)
    created = true
  }
  return { dir: VERILATOR_SHIM_DIR, cmdPath, verilatorBin, verilatorRoot, created }
}

/** 递归终止整个进程树，避免超时/中止后残留孤儿孙进程（如 Icarus 的 vvp.exe）。 */
function killProcessTree(pid: number): void {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } catch { /* 进程树可能已退出 */ }
    return
  }
  try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch { /* 已退出 */ } }
}

/**
 * execFile 的宽松封装——ENOENT 时 reject（供 runWithFallback 候选回退），其余非零退出 resolve
 *
 * stallMs（可选）：停滞检测阈值（毫秒）。>0 时监视子进程 stdout/stderr，连续 stallMs
 * 毫秒没有任何新输出即终止整个进程树并在结果中标记 stalled（挂死防护，非 wall-clock
 * 上限）；缺省/undefined 时不启用。wall-clock 超时（timeoutMs）语义不变。
 */
export function run(
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  cwd?: string,
  timeoutMs: number = EXEC_TIMEOUT_MS,
  stallMs?: number
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const isWindowsScript = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(cmd)
    const executable = isWindowsScript ? (process.env.ComSpec ?? 'cmd.exe') : cmd
    const executableArgs = isWindowsScript ? ['/d', '/s', '/c', cmd, ...args] : args

    let child: ReturnType<typeof execFile>
    let killed = false
    let timer: NodeJS.Timeout | undefined
    // 停滞检测状态：stalled 仅在停滞计时器真实触发时置位（区分于 abort/超时/自然退出）
    let stalled = false
    let stallTimer: NodeJS.Timeout | undefined
    const stallThreshold = typeof stallMs === 'number' && Number.isFinite(stallMs) && stallMs > 0 ? stallMs : undefined
    const bumpStall = (): void => {
      if (stallThreshold === undefined) return
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        stalled = true
        kill()
      }, stallThreshold)
    }
    const onAbort = (): void => kill()
    function kill(): void {
      if (killed) return
      killed = true
      if (timer) clearTimeout(timer)
      killProcessTree(child?.pid ?? 0)
    }

    child = execFile(
      executable,
      executableArgs,
      { maxBuffer: MAX_BUFFER, env, cwd },
      (err, stdout, stderr) => {
        if (timer) clearTimeout(timer)
        if (stallTimer) clearTimeout(stallTimer)
        if (signal) signal.removeEventListener('abort', onAbort)
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error(`工具未找到: ${cmd}`))
          return
        }
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: err ? ((err as { code?: number }).code ?? 1) : 0,
          ...(stallThreshold !== undefined ? { stallMs: stallThreshold } : {}),
          ...(stalled ? { stalled: true } : {})
        })
      }
    )

    // 停滞监视：进程启动即开始计时（从头静默的挂死进程同样受控），
    // stdout/stderr 任一有数据即重置计时器；execFile 内部的输出收集不受影响。
    if (stallThreshold !== undefined) {
      bumpStall()
      child.stdout?.on('data', bumpStall)
      child.stderr?.on('data', bumpStall)
    }

    if (timeoutMs > 0) timer = setTimeout(kill, timeoutMs)
    if (signal) {
      if (signal.aborted) kill()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
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
