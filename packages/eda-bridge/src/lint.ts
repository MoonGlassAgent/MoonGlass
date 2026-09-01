/**
 * Lint 封装（Phase 3 真实现）
 *
 * 引擎策略：优先 verible-verilog-lint；未安装时自动回退
 * verilator --lint-only（-Wno-fatal：Warning 不影响退出码，仅 Error 计入失败）。
 * 两者解析到统一的 LintResult，engine 字段标注实际使用的引擎。
 */

import { readFileSync } from 'node:fs'
import {
  locateTool,
  run,
  runWithFallback,
  toolEnv,
  VERILATOR_CANDIDATES,
  VERIBLE_CANDIDATES
} from './tool-runner'

export interface LintIssue {
  file?: string
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

export interface DesignLintOptions {
  files: string[]
  libraryFiles?: string[]
  topModule?: string
  includeDirs?: string[]
  defines?: string[]
}

async function hasVerible(): Promise<boolean> {
  return (await locateTool(VERIBLE_CANDIDATES)) !== null
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
      file: m[1],
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
      file: m[3],
      severity: m[1] === 'Error' ? 'error' : 'warning',
      rule: m[2] ?? (m[1] === 'Error' ? 'error' : 'warning'),
      message: m[6]
    }
    if (issue.severity === 'error') errors.push(issue)
    else warnings.push(issue)
  }
  return { errors, warnings }
}

/** MoonGlass Verilog-2001 规则：内部对象必须先声明后使用。 */
function declarationOrderIssues(filePath: string): LintIssue[] {
  const source = readFileSync(filePath, 'utf-8')
  const clean = source
    .replace(/\/\*[\s\S]*?\*\//g, (text) => text.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (text) => ' '.repeat(text.length))
  const issues: LintIssue[] = []
  const seen = new Set<string>()
  for (const moduleMatch of clean.matchAll(/\bmodule\b[\s\S]*?\bendmodule\b/g)) {
    const moduleText = moduleMatch[0]
    const headerEnd = moduleText.indexOf(');')
    if (headerEnd < 0) continue
    const body = moduleText.slice(headerEnd + 2)
    const bodyOffset = (moduleMatch.index ?? 0) + headerEnd + 2
    const declarations = body.matchAll(/^[ \t]*(?:wire|reg|integer|genvar)\b([^;]*);/gm)
    for (const declaration of declarations) {
      const declarationStart = declaration.index ?? 0
      // 初始化表达式中可能包含函数参数逗号；只在第一个 '=' 之前拆声明符，
      // 避免把表达式尾部误识别为另一个声明名称。
      const names = declaration[1].split('=', 1)[0]
        .replace(/\[[^\]]*\]/g, ' ')
        .split(',')
        .map((item) => item.trim().match(/[A-Za-z_$][\w$]*$/)?.[0])
        .filter((name): name is string => Boolean(name))
      for (const name of names) {
        const before = body.slice(0, declarationStart)
        // 1'b0 等数值字面量中的 b0 不是标识符。
        const use = new RegExp(`(?<!['\\w$])${name.replace(/[$]/g, '\\$&')}(?![\\w$])`).exec(before)
        if (!use) continue
        const absolute = bodyOffset + use.index
        const line = source.slice(0, absolute).split(/\r?\n/).length
        const lineStart = source.lastIndexOf('\n', absolute - 1) + 1
        const key = `${name}:${absolute}`
        if (seen.has(key)) continue
        seen.add(key)
        issues.push({
          file: filePath,
          line,
          column: absolute - lineStart + 1,
          severity: 'error',
          rule: 'moonglass-declaration-before-use',
          message: `${name} 在声明之前已被使用；Verilog-2001 内部 wire/reg/integer/genvar 必须在首次使用前声明`
        })
      }
    }
  }
  return issues
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
  const result = await (await hasVerible() ? runVeribleLint(options) : runVerilatorLint(options))
  const customErrors = declarationOrderIssues(options.filePath)
  return { ...result, passed: result.passed && customErrors.length === 0, errors: [...result.errors, ...customErrors] }
}

/**
 * 全设计联合 Lint。逐文件 Lint 不能建立模块层次，也不能发现跨文件端口、缺失模块和
 * 顶层 elaboration 错误；这里强制 Verilator 一次读取完整 filelist 并指定顶层。
 */
export async function runDesignLint(options: DesignLintOptions): Promise<LintResult> {
  if (options.files.length === 0) throw new Error('全设计 Lint 至少需要一个 RTL 文件')
  const args = [
    '--lint-only',
    '-Wno-fatal',
    ...(options.topModule ? ['--top-module', options.topModule] : []),
    ...(options.includeDirs ?? []).map((dir) => `-I${dir}`),
    ...(options.defines ?? []).map((define) => `-D${define}`),
    ...options.files,
    ...(options.libraryFiles ?? [])
  ]
  const verilatorPath = await locateTool(VERILATOR_CANDIDATES)
  if (!verilatorPath) throw new Error('工具未找到: verilator')
  const { stdout, stderr, code } = await run(verilatorPath, args, toolEnv(verilatorPath))
  const parsed = parseVerilator(stdout + '\n' + stderr)
  parsed.errors.push(...options.files.flatMap(declarationOrderIssues))
  if (code !== 0 && parsed.errors.length === 0) {
    parsed.errors.push({
      line: 0,
      column: 0,
      severity: 'error',
      rule: 'ELABORATION',
      message: (stderr || stdout).trim().slice(0, 2000) || `Verilator 异常退出 (code=${code})`
    })
  }
  return { passed: parsed.errors.length === 0 && code === 0, engine: 'verilator', ...parsed }
}
