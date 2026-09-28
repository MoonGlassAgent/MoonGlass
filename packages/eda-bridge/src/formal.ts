import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { delimiter } from 'node:path'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { locateTool, run, toolEnv } from './tool-runner.ts'

export type FormalMode = 'bmc' | 'prove' | 'cover'
export type FormalObligation = 'required' | 'supplemental'
export type FormalRunOutcome = 'PROVEN' | 'COUNTEREXAMPLE' | 'COVERED' | 'BOUND_EXHAUSTED' | 'INCONCLUSIVE' | 'TOOL_ERROR'
export interface FormalRunOptions { workspaceDir: string; top: string; rtlFiles: string[]; propertyFiles: string[]; mode?: FormalMode; depth?: number; engine?: 'boolector' | 'bitwuzla' | 'z3'; taskName?: string; scenarioId?: string; obligation?: FormalObligation; signal?: AbortSignal; workspaceRtlHash?: string }
export interface FormalCompatibilityIssue { file: string; line: number; construct: string; message: string }
// #8：rtlHash 在提供 workspaceRtlHash 时写工作区统一口径（computeRtlHash），使 Formal 证据进入单一哈希空间；
// 原"输入文件清单哈希"改记 scopeHash（作用域溯源用）；未提供 workspaceRtlHash 时 rtlHash 保持旧口径（向后兼容直接调用）
export interface FormalRunResult { passed: boolean; status: 'PASS' | 'FAIL' | 'UNKNOWN' | 'ERROR'; outcome: FormalRunOutcome; mode: FormalMode; top: string; engine: string; depth: number; scenarioId?: string; rtlHash: string; scopeHash: string; obligation: FormalObligation; classification?: 'C6_FRONTEND_COMPATIBILITY'; compatibilityIssues?: FormalCompatibilityIssue[]; configPath: string; resultDir: string; logPath: string; traces: string[]; propertyFiles: string[]; message: string }

function safeName(value: string): string { return value.replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^\.+/, '') || 'formal' }
function collect(dir: string, match: RegExp): string[] {
  if (!existsSync(dir)) return []
  const result: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) result.push(...collect(path, match))
    else if (match.test(entry.name) && statSync(path).size > 0) result.push(path)
  }
  return result
}

/** Yosys 内置 read_verilog -sv 只支持有限的 formal SystemVerilog 子集。 */
export function checkYosysFormalCompatibility(workspace: string, propertyFiles: string[]): FormalCompatibilityIssue[] {
  const rules: Array<{ pattern: RegExp; construct: string; message: string }> = [
    { pattern: /\bdefault\s+clocking\b/i, construct: 'default clocking', message: '改用 always @(posedge clk) 中的过程式监控寄存器。' },
    { pattern: /\b(?:end)?property\b/i, construct: 'property/endproperty', message: '改用 immediate assert/assume/cover。' },
    { pattern: /\b(?:assert|assume|cover)\s+property\b/i, construct: 'assert/assume/cover property', message: '改用 always 时序块中的 immediate assertion。' },
    { pattern: /\|->|\|=>|##(?:\[|\d)/, construct: 'SVA temporal sequence', message: '用计数器、pending 标志和 $past 显式编码时间关系。' },
    { pattern: /\bdisable\s+iff\b/i, construct: 'disable iff', message: '在 always 块中用 reset 条件保护 assertion。' }
  ]
  const issues: FormalCompatibilityIssue[] = []
  for (const relativeFile of propertyFiles) {
    const file = resolve(workspace, relativeFile)
    if (!existsSync(file)) continue
    const lines = readFileSync(file, 'utf-8').split(/\r?\n/)
    let inBlockComment = false
    lines.forEach((line, index) => {
      let code = line
      if (inBlockComment) {
        const end = code.indexOf('*/')
        if (end < 0) return
        code = code.slice(end + 2)
        inBlockComment = false
      }
      while (code.includes('/*')) {
        const start = code.indexOf('/*'); const end = code.indexOf('*/', start + 2)
        if (end < 0) { code = code.slice(0, start); inBlockComment = true; break }
        code = code.slice(0, start) + code.slice(end + 2)
      }
      code = code.replace(/\/\/.*$/, '')
      for (const rule of rules) if (rule.pattern.test(code)) issues.push({ file: relative(workspace, file), line: index + 1, construct: rule.construct, message: rule.message })
    })
  }
  return issues.filter((issue, index, all) => all.findIndex((item) => item.file === issue.file && item.line === issue.line && item.construct === issue.construct) === index)
}

export async function runFormalVerification(options: FormalRunOptions): Promise<FormalRunResult> {
  const workspace = resolve(options.workspaceDir)
  const sby = await locateTool(process.platform === 'win32' ? ['sby.exe', 'sby.cmd', 'sby'] : ['sby'])
  if (!sby) throw new Error('未找到 SymbiYosys (sby)。请在“设置 > 开发环境与 EDA 工具链”安装 OSS CAD Suite。')
  const mode = options.mode ?? 'bmc'; const depth = Math.max(1, Math.min(10000, Math.round(options.depth ?? (mode === 'prove' ? 40 : 64))))
  const engine = options.engine ?? 'boolector'; const task = safeName(options.taskName ?? `${options.top}_${mode}`); const obligation = options.obligation ?? 'supplemental'
  const root = join(workspace, 'verification', 'formal'); const resultDir = join(root, 'results', task); mkdirSync(resultDir, { recursive: true })
  const allFiles = [...new Set([...options.rtlFiles, ...options.propertyFiles].map((file) => resolve(workspace, file)))]
  const missing = allFiles.filter((file) => !existsSync(file)); if (missing.length) throw new Error(`Formal 输入文件不存在：${missing.join(', ')}`)
  const names = new Map<string, string>();
  for (const file of allFiles) { const name = basename(file); if (names.has(name) && names.get(name) !== file) throw new Error(`Formal 输入存在同名文件：${name}`); names.set(name, file) }
  const configPath = join(root, `${task}.sby`)
  const rtlHash = createHash('sha256')
  for (const relativeFile of [...options.rtlFiles].sort()) { const file = resolve(workspace, relativeFile); rtlHash.update(relativeFile).update('\0').update(readFileSync(file)).update('\0') }
  const scopeHash = rtlHash.digest('hex')
  // #8：优先使用调用方传入的工作区统一口径哈希；未提供时保持旧行为（rtlHash = 输入文件清单哈希）
  const currentRtlHash = options.workspaceRtlHash ?? scopeHash
  // BUG-FORMAL-PATH-001（内容侧）：MinGW Python 以系统 ANSI（GBK）读取配置文件，
  // 非 ASCII 绝对路径会在读文件阶段炸出 UnicodeDecodeError；[files] 改写为相对 formal
  // 工作目录的相对路径（项目根目录的非 ASCII 前缀经 ../../ 自然消去，不进文件内容）
  const files = [...names.entries()].map(([name, file]) => [name, relative(root, file).replace(/\\/g, '/')] as [string, string])
  const configContent = `[options]\nmode ${mode}\ndepth ${depth}\nwait on\n\n[engines]\nsmtbmc ${engine}\n\n[script]\nread -formal -sv ${files.map(([name]) => name).join(' ')}\nprep -top ${options.top}\n\n[files]\n${files.map(([name, file]) => `${name} ${file}`).join('\n')}\n`
  if (/[^\x00-\x7F]/.test(configContent)) {
    throw new Error('Formal 暂不支持非 ASCII 的 RTL/属性文件名或相对路径（内置工具链的 MinGW Python 以系统 ANSI 读取 .sby 配置）：请将这些文件重命名为 ASCII 后重试')
  }
  writeFileSync(configPath, configContent, 'utf-8')
  const compatibilityIssues = checkYosysFormalCompatibility(workspace, options.propertyFiles)
  if (compatibilityIssues.length) {
    const logPath = join(resultDir, 'moonglass-formal.log')
    const guidance = compatibilityIssues.map((issue) => `${issue.file}:${issue.line} [${issue.construct}] ${issue.message}`).join('\n')
    writeFileSync(logPath, `MoonGlass Formal compatibility preflight failed.\nNo solver was started and no PASS/FAIL verdict exists.\n\n${guidance}\n\nUse Yosys-compatible clocked always blocks with immediate assert/assume/cover and explicit monitor counters. Liveness properties must document environment response assumptions.\n`, 'utf-8')
    const result: FormalRunResult = {
      passed: false, status: 'ERROR', outcome: 'TOOL_ERROR', mode, top: options.top, engine, depth, scenarioId: options.scenarioId, rtlHash: currentRtlHash, scopeHash, obligation,
      classification: 'C6_FRONTEND_COMPATIBILITY', compatibilityIssues, configPath: relative(workspace, configPath),
      resultDir: relative(workspace, resultDir), logPath: relative(workspace, logPath), traces: [], propertyFiles: options.propertyFiles,
      message: `Formal 兼容性预检拒绝 ${compatibilityIssues.length} 项 Yosys 不支持的 SVA 结构；未启动求解器，不能形成 PASS/FAIL 结论`
    }
    writeFileSync(join(resultDir, 'formal-result.json'), JSON.stringify({ ...result, generatedAt: new Date().toISOString(), exitCode: null }, null, 2), 'utf-8')
    return result
  }
  const env = toolEnv(sby)
  if (process.platform === 'win32') {
    const packagedSmtbmc = join(dirname(sby), 'yosys-smtbmc.exe.exe')
    if (existsSync(packagedSmtbmc)) {
      const shimDir = join(root, '.moonglass-bin'); mkdirSync(shimDir, { recursive: true })
      writeFileSync(join(shimDir, 'yosys-smtbmc.cmd'), `@echo off\r\n"${packagedSmtbmc}" %*\r\n`, 'utf-8')
      env.PATH = `${shimDir}${delimiter}${env.PATH ?? ''}`
    }
  }
  // BUG-FORMAL-PATH-001：打包工具链的 Python 是 MinGW/msvcrt 构建，窄 argv 按系统 ANSI
  // 代码页（GBK）转码——非 ASCII 绝对路径经 argv 传递必被损坏（surrogateescape 乱码），
  // cmd 批处理包装同样如此。因此 .sby 与 -d 一律使用相对 formal 工作目录的纯 ASCII
  // 相对路径，非 ASCII 仅经 cwd（宽字符目录参数，安全）传递；[files] 中的绝对路径是
  // 配置文件内容而非 argv，不受此限制。
  const execution = await run(sby, ['-f', '-d', relative(root, resultDir).replace(/\\/g, '/'), basename(configPath)], env, options.signal, root, 15 * 60_000)
  const combined = `${execution.stdout}\n${execution.stderr}`; const logPath = join(resultDir, 'moonglass-formal.log'); writeFileSync(logPath, combined, 'utf-8')
  const statusText = collect(resultDir, /^status$/i).map((file) => readFileSync(file, 'utf-8')).join('\n')
  const token = /\b(PASS|FAIL|UNKNOWN|ERROR)\b/i.exec(`${statusText}\n${combined}`)?.[1]?.toUpperCase() as FormalRunResult['status'] | undefined
  const status = token ?? (execution.code === 0 ? 'UNKNOWN' : 'ERROR'); const traces = collect(resultDir, /\.(?:vcd|fst|yw)$/i).map((file) => relative(workspace, file))
  const outcome: FormalRunOutcome = status === 'ERROR' ? 'TOOL_ERROR' : status === 'UNKNOWN' ? 'INCONCLUSIVE'
    : status === 'PASS' ? mode === 'prove' ? 'PROVEN' : mode === 'cover' ? 'COVERED' : 'BOUND_EXHAUSTED'
      : mode === 'cover' ? 'BOUND_EXHAUSTED' : 'COUNTEREXAMPLE'
  const message = outcome === 'PROVEN' ? '属性已在当前模型与 assumptions 下证明'
    : outcome === 'COVERED' ? '目标场景已在当前深度内到达'
      : outcome === 'BOUND_EXHAUSTED' ? `${mode} 仅完成当前深度检查，不能解释为不可达证明`
        : outcome === 'COUNTEREXAMPLE' ? `发现反例或属性失败${traces.length ? '，已生成 trace' : ''}`
          : `Formal 任务状态 ${status}，请检查日志`
  const result: FormalRunResult = { passed: status === 'PASS', status, outcome, mode, top: options.top, engine, depth, scenarioId: options.scenarioId, rtlHash: currentRtlHash, scopeHash, obligation, configPath: relative(workspace, configPath), resultDir: relative(workspace, resultDir), logPath: relative(workspace, logPath), traces, propertyFiles: options.propertyFiles, message }
  writeFileSync(join(resultDir, 'formal-result.json'), JSON.stringify({ ...result, generatedAt: new Date().toISOString(), exitCode: execution.code }, null, 2), 'utf-8')
  return result
}
