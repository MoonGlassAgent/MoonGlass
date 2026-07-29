/**
 * Lint 封装（Phase 3 真实现）
 *
 * 引擎策略：优先 verible-verilog-lint；未安装时自动回退
 * verilator --lint-only（-Wno-fatal：Warning 不影响退出码，仅 Error 计入失败）。
 * 两者解析到统一的 LintResult，engine 字段标注实际使用的引擎。
 */

import { execFile } from 'node:child_process'

export interface LintIssue {
  line: number
  column: number
  severity: 'error' | 'warning'
  rule: string
  message: string
}

export interface LintResult {
  passed: boolean
  /** 实际执行检查的的引擎 */
  engine: 'verible' | 'verilator'
  errors: LintIssue[]
  warnings: LintIssue[]
  fixedCode?: string
}

export interface VeribleLintOptions {
  filePath: string
  rulesFile?: string
  autofix?: boolean
}

const EXEC_TIMEOUT_MS = 30_000
const MAX_BUFFER = 4 * 1024 * 1024

interface ExecOutput {
  stdout: string
  stderr: string
  code: number | null
}

/** execFile 的宽松封装：非零退出不抛异常，统一返回输出与退出码 */
function run(cmd: string, args: string[]): Promise<ExecOutput> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`工具未找到: ${cmd}`))
        return
      }
      resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: err ? ((err as { code?: number }).code ?? 1) : 0 })
    })
  })
}

let veribleAvailable: boolean | null = null

async function hasVerible(): Promise<boolean> {
  if (veribleAvailable !== null) return veribleAvailable
  try {
    await run('verible-verilog-lint', ['--version'])
    veribleAvailable = true
  } catch {
    veribleAvailable = false
  }
  return veribleAvailable
}

/** Windows 上 oss-cad-suite 的 verilator 是无扩展名脚本（CreateProcess 无法执行），需回退到 verilator_bin.exe */
const VERILATOR_CANDIDATES = ['verilator', 'verilator_bin.exe']

async function runVerilator(args: string[]): Promise<ExecOutput> {
  let lastErr: unknown
  for (const cmd of VERILATOR_CANDIDATES) {
    try {
      return await run(cmd, args)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('工具未找到: verilator')
}

// verible 输出：file:line:col: message [rule-name]
const VERIBLE_LINE = /^.+?:(\d+):(\d+):\s*(.+?)\s*\[([a-z0-9-]+)\]\s*$/
// verilator 输出：%Error[-CODE]: file:line:col: message / %Warning-CODE: file:line:col: message
const VERILATOR_LINE = /^%(Error|Warning)(?:-([A-Z0-9_]+))?:\s*.+?:(\d+):(\d+):\s*(.+)$/

function parseVerible(output: string): LintIssue[] {
  const issues: LintIssue[] = []
  for (const line of output.split(/\r?\n/)) {
    const m = VERIBLE_LINE.exec(line.trim())
    if (!m) continue
    // verible lint 违规按门禁语义一律计为 error（门禁要求零违规）
    issues.push({
      line: Number(m[1]),
      column: Number(m[2]),
      severity: 'error',
      rule: m[4],
      message: m[3]
    })
  }
  return issues
}

function parseVerilator(output: string): { errors: LintIssue[]; warnings: LintIssue[] } {
  const errors: LintIssue[] = []
  const warnings: LintIssue[] = []
  for (const line of output.split(/\r?\n/)) {
    const m = VERILATOR_LINE.exec(line.trim())
    if (!m) continue
    const issue: LintIssue = {
      line: Number(m[3]),
      column: Number(m[4]),
      severity: m[1] === 'Error' ? 'error' : 'warning',
      rule: m[2] ?? (m[1] === 'Error' ? 'error' : 'warning'),
      message: m[5]
    }
    if (issue.severity === 'error') errors.push(issue)
    else warnings.push(issue)
  }
  return { errors, warnings }
}

/** 调用 verible-verilog-lint（未安装时抛错，调用方应改用 runLint 门面） */
export async function runVeribleLint(options: VeribleLintOptions): Promise<LintResult> {
  const args: string[] = []
  if (options.rulesFile) args.push(`--rules_config=${options.rulesFile}`)
  if (options.autofix) args.push('--autofix')
  args.push(options.filePath)

  const { stdout, stderr } = await run('verible-verilog-lint', args)
  const issues = parseVerible(stdout + '\n' + stderr)
  return {
    passed: issues.length === 0,
    engine: 'verible',
    errors: issues,
    warnings: []
  }
}

/** verilator --lint-only 回退实现 */
async function runVerilatorLint(options: VeribleLintOptions): Promise<LintResult> {
  const { stdout, stderr } = await runVerilator(['--lint-only', '-Wno-fatal', options.filePath])
  const { errors, warnings } = parseVerilator(stdout + '\n' + stderr)
  return {
    passed: errors.length === 0,
    engine: 'verilator',
    errors,
    warnings
  }
}

/** Lint 门面：verible 优先，未安装自动回退 verilator */
export async function runLint(options: VeribleLintOptions): Promise<LintResult> {
  if (await hasVerible()) return runVeribleLint(options)
  return runVerilatorLint(options)
}
