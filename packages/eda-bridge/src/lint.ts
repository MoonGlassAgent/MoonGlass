/**
 * Verible Lint 封装（骨架桩）
 *
 * TODO(Phase 4): 调用 verible-verilog-lint 子进程，
 * 解析其输出为结构化 LintResult，支持 --autofix。
 */

export interface LintIssue {
  line: number
  column: number
  severity: 'error' | 'warning'
  rule: string
  message: string
}

export interface LintResult {
  passed: boolean
  errors: LintIssue[]
  warnings: LintIssue[]
  fixedCode?: string
}

export interface VeribleLintOptions {
  filePath: string
  rulesFile?: string
  autofix?: boolean
}

export async function runVeribleLint(_options: VeribleLintOptions): Promise<LintResult> {
  throw new Error('NotImplemented: runVeribleLint 将在 Phase 4（芯片专用工具集）实现')
}
