/**
 * Lint 封装（Phase 3 真实现）
 *
 * 引擎策略：优先 verible-verilog-lint；未安装时自动回退
 * verilator --lint-only（-Wno-fatal：Warning 不影响退出码，仅 Error 计入失败）。
 * 两者解析到统一的 LintResult，engine 字段标注实际使用的引擎。
 */

import {
  locateTool,
  run,
  runWithFallback,
  toolEnv,
  VERILATOR_CANDIDATES,
  VERIBLE_CANDIDATES
} from './tool-runner'

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

let veribleAvailable: boolean | null = null

async function hasVerible(): Promise<boolean> {
  if (veribleAvailable !== null) return veribleAvailable
  veribleAvailable = (await locateTool(VERIBLE_CANDIDATES)) !== null
  return veribleAvailable
}

// verible 输出：file:line:col: message [rule-name]
const VERIBLE_LINE = /^(.+):(\d+):(\d+):\s*(.+?)\s*\[([a-z0-9-]+)\]\s*$/
// verilator 输出：%Error[-CODE]: file:line:col: message / %Warning-CODE: file:line:col: message
const VERILATOR_LINE = /^%(Error|Warning)(?:-([A-Z0-9_]+))?:\s*(.+):(\d+):(\d+):\s*(.+)$/

function parseVerible(output: string): LintIssue[] {
  const issues: LintIssue[] = []
  for (const line of output.split(/\r?\n/)) {
    const m = VERIBLE_LINE.exec(line.trim())
    if (!m) continue
    // verible lint 违规按门禁语义一律计为 error（门禁要求零违规）
    issues.push({
      line: Number(m[2]),
      column: Number(m[3]),
      severity: 'error',
      rule: m[5],
      message: m[4]
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
      line: Number(m[4]),
      column: Number(m[5]),
      severity: m[1] === 'Error' ? 'error' : 'warning',
      rule: m[2] ?? (m[1] === 'Error' ? 'error' : 'warning'),
      message: m[6]
    }
    if (issue.severity === 'error') errors.push(issue)
    else warnings.push(issue)
  }
  return { errors, warnings }
}

/** 调用 verible-verilog-lint（未安装时抛错，调用方应改用 runLint 门面） */
export async function runVeribleLint(options: VeribleLintOptions): Promise<LintResult> {
  const veriblePath = await locateTool(VERIBLE_CANDIDATES)
  if (!veriblePath) throw new Error('工具未找到: verible-verilog-lint')

  const args: string[] = []
  if (options.rulesFile) args.push(`--rules_config=${options.rulesFile}`)
  if (options.autofix) args.push('--autofix')
  args.push(options.filePath)

  const { stdout, stderr } = await run(veriblePath, args, toolEnv(veriblePath))
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
  const { stdout, stderr } = await runWithFallback(VERILATOR_CANDIDATES, [
    '--lint-only',
    '-Wno-fatal',
    options.filePath
  ])
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
