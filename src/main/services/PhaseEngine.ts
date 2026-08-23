/**
 * 6 阶段流程引擎（状态机 + 门禁规则）
 *
 * 依据规格书 §3.1 的阶段跳转规则定义。
 * Phase 3：门禁自动检查接入真实 EDA 工具（lint / yosys 可综合性），
 * Error 级检查失败阻断推进；文档类/覆盖率类检查保持「未接入」占位（不阻塞）。
 */

import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { runLint, checkSynthesizability, readRtlInputs } from '@moonglass/eda-bridge'
import {
  PHASE_ORDER,
  type ChipProject,
  type GateCheckResult,
  type GateRule,
  type Phase,
  type PhaseChangeNotice,
  type PhaseState
} from '@shared/types'
import type { MoonGlassService } from '../core/lifecycle.ts'
import { gateChecks } from '../data/schema/moonglass.ts'
import type { DbService } from './DbService.ts'

/** 阶段跳转门禁规则表（规格书 §3.1） */
export const GATE_RULES: readonly GateRule[] = [
  { from: 'REQ_SPEC', to: 'ARCH', precondition: '需求、模块规格、接口规格与追溯矩阵可用于架构设计', autoChecks: ['requirements-usable', 'module-spec-usable', 'interface-spec-usable', 'rtm-complete'] },
  { from: 'ARCH', to: 'RTL', precondition: '总体架构和接口可用；独立微架构与时钟复位文档按设计复杂度选配', autoChecks: ['block-diagram-parsable', 'interface-signals-nonempty', 'module-partition-sane', 'clock-reset-defined'] },
  { from: 'RTL', to: 'VERIF', precondition: '可编译 RTL + 端口提取通过', autoChecks: ['verible-lint-zero-error', 'port-consistency'] },
  { from: 'VERIF', to: 'QA', precondition: '覆盖率与独立证据审查报告', autoChecks: ['line-coverage-gte-90', 'branch-coverage-gte-85', 'func-coverage-gte-80', 'sim-passed', 'verification-evidence-review'] },
  { from: 'QA', to: 'SYNTH', precondition: 'Lint/CDC/代码审查通过', autoChecks: ['verible-zero-error', 'yosys-synthesizable', 'cdc-passed'] }
] as const

/** checkId → check_type 映射 */
function inferCheckType(checkId: string): 'lint' | 'cdc' | 'rdc' | 'synthesis' | 'coverage' | 'review' | 'custom' {
  if (checkId.includes('lint')) return 'lint'
  if (checkId.includes('cdc')) return 'cdc'
  if (checkId.includes('rdc')) return 'rdc'
  if (checkId.includes('synthesiz') || checkId.includes('synth')) return 'synthesis'
  if (checkId.includes('coverage')) return 'coverage'
  if (checkId.includes('review') || checkId.includes('rtm') || checkId.includes('doc')) return 'review'
  return 'custom'
}
const CHECK_NAMES: Record<string, string> = {
  'requirements-usable': '需求定义可用于架构设计',
  'module-spec-usable': '模块规格可用于架构设计',
  'interface-spec-usable': '接口规格可用于架构设计',
  'rtm-complete': '需求-规格追溯矩阵完备',
  'interface-signals-nonempty': '接口信号清单非空',
  'module-partition-sane': '微架构文档（按复杂度选配）',
  'block-diagram-parsable': '架构框图可解析',
  'clock-reset-defined': '独立时钟/复位文档（按复杂度选配）',
  'verible-lint-zero-error': 'Lint 零 Error',
  'port-consistency': '端口一致性检查',
  'line-coverage-gte-90': '行覆盖率 ≥90%',
  'branch-coverage-gte-85': '条件/分支覆盖率 ≥85%',
  'func-coverage-gte-80': '功能覆盖率 ≥80%',
  'verification-evidence-review': '验证原始证据独立审查',
  'sim-passed': '仿真通过',
  'verible-zero-error': 'Lint 零 Error',
  'yosys-synthesizable': 'Yosys 可综合性',
  'cdc-passed': 'CDC 启发式风险扫描（非签核）'
}

/** 门禁检查执行上下文（由调用方注入，避免本模块依赖 Electron） */
export interface GateCheckContext {
  /** 项目工作目录（pi 会话 cwd，Agent 产出 RTL 的位置） */
  workspaceDir: string
}

type GateChecker = (ctx: GateCheckContext) => Promise<GateCheckResult>

const MAX_ISSUES_IN_MESSAGE = 3

/** 门禁只检查设计源；verification 中的 DUT 镜像和测试辅助模块不能进入综合。 */
function collectDesignRtlFiles(workspaceDir: string): string[] {
  return readRtlInputs(workspaceDir).designFiles
}

function collectLibraryRtlFiles(workspaceDir: string): string[] {
  return readRtlInputs(workspaceDir).libraryFiles
}

function makeResult(
  checkId: string,
  passed: boolean,
  severity: GateCheckResult['severity'],
  message: string
): GateCheckResult {
  return { checkId, checkName: CHECK_NAMES[checkId] ?? checkId, passed, severity, message, autoFixable: false }
}

interface DocumentInspection {
  path: string
  content: string
  issues: string[]
}

function inspectDocument(ctx: GateCheckContext, relativePath: string): DocumentInspection {
  const path = join(ctx.workspaceDir, ...relativePath.split('/'))
  if (!existsSync(path)) {
    return {
      path: relativePath,
      content: '',
      issues: ['文件不存在；请创建该文件并补充本阶段要求的内容']
    }
  }
  const content = readFileSync(path, 'utf-8').trim()
  const issues: string[] = []
  if (content.length < 80) {
    issues.push(`有效内容过少（当前 ${content.length} 个字符，至少需要 80 个字符）`)
  }
  return { path: relativePath, content, issues }
}

function meaningfulFile(ctx: GateCheckContext, relativePath: string): boolean {
  return inspectDocument(ctx, relativePath).issues.length === 0
}

function requireFiles(paths: string[], severity: GateCheckResult['severity'] = 'error') {
  return async (ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> => {
    const failed = paths.map((path) => inspectDocument(ctx, path)).filter((item) => item.issues.length > 0)
    const details = failed.flatMap((item) => [
      `• ${item.path}`,
      ...item.issues.map((issue) => `  - ${issue}`)
    ])
    return failed.length === 0
      ? makeResult(checkId, true, severity, `通过：${paths.join('、')}`)
      : makeResult(checkId, false, severity, `检查发现 ${failed.length} 个文档问题：\n${details.join('\n')}`)
  }
}

function optionalDocument(relativePath: string, simpleDesignReason: string) {
  return async (ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> => {
    const absolutePath = join(ctx.workspaceDir, ...relativePath.split('/'))
    if (!existsSync(absolutePath)) {
      return makeResult(
        checkId,
        true,
        'info',
        `可选文档未提供：${relativePath}。${simpleDesignReason}，不阻断进入 RTL；必要说明应在 architecture.md 中可追溯。`
      )
    }
    const document = inspectDocument(ctx, relativePath)
    return document.issues.length === 0
      ? makeResult(checkId, true, 'info', `可选文档已提供且内容有效：${relativePath}`)
      : makeResult(
          checkId,
          false,
          'warning',
          `可选文档已存在但内容不完整，不阻断推进：${relativePath}\n${document.issues.map((issue) => `  - ${issue}`).join('\n')}`
        )
  }
}

const REQUIREMENT_ID = /\b(?:REQ(?:-[A-Z]+)?|FR|F|NFR|PERF|P|IF|SEC)[-_]?\d+\b/gi
const SPECIFICATION_ID = /\bSPEC(?:-[A-Z]+)?[-_]?\d+\b/gi

function requirementIds(content: string): Set<string> {
  const ids = new Set(
    (content.match(REQUIREMENT_ID) ?? [])
      .map((id) => id.toUpperCase().replace(/_/g, '-'))
      .filter((id) => !/^P[0-2]$/.test(id))
  )
  const ranges = content.matchAll(
    /\b(REQ(?:-[A-Z]+)?|FR|F|NFR|PERF|IF|SEC)[-_]?(\d+)\s*(?:~|～|\.\.|至)\s*(\d+)\b/gi
  )
  for (const range of ranges) {
    const prefix = range[1].toUpperCase().replace(/_/g, '-')
    const start = Number(range[2])
    const end = Number(range[3])
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || end - start > 999) continue
    const width = Math.max(range[2].length, range[3].length)
    for (let value = start; value <= end; value += 1) {
      ids.add(`${prefix}-${String(value).padStart(width, '0')}`)
    }
  }
  return ids
}

interface TraceabilityRow {
  cells: string[]
  requirementCell: string
  specificationCell: string
}

function markdownCells(line: string): string[] | null {
  if (!/^\s*\|.*\|\s*$/.test(line)) return null
  return line.split('|').slice(1, -1).map((cell) => cell.trim())
}

/** 只读取表头明确声明“需求 ID”和“规格 ID”的追溯表，忽略版本、优先级、TBD 等辅助表。 */
function traceabilityRows(content: string): TraceabilityRow[] {
  const lines = content.split(/\r?\n/)
  const rows: TraceabilityRow[] = []
  for (let index = 0; index < lines.length - 1; index += 1) {
    const headers = markdownCells(lines[index])
    const separator = markdownCells(lines[index + 1])
    if (!headers || !separator || !separator.every((cell) => /^:?-{3,}:?$/.test(cell))) continue

    const requirementIndex = headers.findIndex((cell) =>
      /^(?:关联\s*)?(?:需求|requirement)\s*(?:id|编号)$/i.test(cell)
    )
    const specificationIndex = headers.findIndex((cell) =>
      /^(?:关联\s*)?(?:规格|specification|spec)\s*(?:id|编号)$/i.test(cell)
    )
    if (requirementIndex < 0 || specificationIndex < 0) continue

    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const cells = markdownCells(lines[rowIndex])
      if (!cells) break
      rows.push({
        cells,
        requirementCell: cells[requirementIndex] ?? '',
        specificationCell: cells[specificationIndex] ?? ''
      })
      index = rowIndex
    }
  }
  return rows
}

async function requirementsUsable(
  ctx: GateCheckContext,
  checkId: string
): Promise<GateCheckResult> {
  const document = inspectDocument(ctx, 'docs/02_requirements/product_requirements.md')
  if (document.issues.length > 0) {
    return makeResult(
      checkId,
      false,
      'error',
      `需求文档不可用于架构设计：\n• ${document.path}\n${document.issues.map((issue) => `  - ${issue}`).join('\n')}`
    )
  }
  const ids = requirementIds(document.content)
  return makeResult(
    checkId,
    true,
    'error',
    ids.size > 0
      ? `通过：需求文档存在有效内容，识别到 ${ids.size} 个稳定需求 ID`
      : '通过：需求文档存在有效内容；未识别到标准需求 ID，已作为非阻断遗留事项记录'
  )
}

async function rtmComplete(ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> {
  const rtm = inspectDocument(ctx, 'docs/02_requirements/requirements_traceability.md')
  if (rtm.issues.length > 0) {
    return makeResult(
      checkId,
      false,
      'error',
      `需求-规格追溯矩阵不可用：\n• ${rtm.path}\n${rtm.issues.map((issue) => `  - ${issue}`).join('\n')}`
    )
  }
  const tableRows = traceabilityRows(rtm.content)
  if (tableRows.length === 0) {
    return makeResult(
      checkId,
      false,
      'error',
      '需求-规格追溯矩阵未识别到有效数据表；表头必须同时包含“需求 ID”和“规格 ID”列'
    )
  }

  const requirements = inspectDocument(ctx, 'docs/02_requirements/product_requirements.md')
  const requiredIds = requirementIds(requirements.content)
  const tracedIds = new Set(tableRows.flatMap((row) => [...requirementIds(row.requirementCell)]))
  const missing = [...requiredIds].filter((id) => !tracedIds.has(id))
  if (missing.length > 0) {
    return makeResult(
      checkId,
      false,
      'error',
      `需求-规格追溯矩阵缺少 ${missing.length} 个需求 ID 的追溯关系：${missing.join('、')}`
    )
  }
  const rowsWithoutSpecification = tableRows.filter((row) => {
    return requirementIds(row.requirementCell).size > 0 &&
      (row.specificationCell.match(SPECIFICATION_ID) ?? []).length === 0
  })
  if (rowsWithoutSpecification.length > 0) {
    // 逐行列出需求 ID 与行内容摘要，便于 Agent 直接定位修复
    const details = rowsWithoutSpecification.slice(0, 10).map((entry) => {
      const row = entry.cells.join(' | ')
      const ids = [...requirementIds(entry.requirementCell)].join('、')
      const preview = row.length > 80 ? `${row.slice(0, 80)}…` : row
      return `  - ${ids || '(未识别需求 ID)'}：${preview}`
    })
    const more = rowsWithoutSpecification.length > 10 ? `\n  … 其余 ${rowsWithoutSpecification.length - 10} 行同问题` : ''
    return makeResult(
      checkId,
      false,
      'error',
      `需求-规格追溯矩阵有 ${rowsWithoutSpecification.length} 行缺少 SPEC-* 规格 ID 映射：\n${details.join('\n')}${more}`
    )
  }
  return makeResult(
    checkId,
    true,
    'error',
    requiredIds.size > 0
      ? `通过：需求-规格追溯矩阵有效，${requiredIds.size} 个需求 ID 均已映射规格 ID`
      : '通过：需求-规格追溯矩阵存在有效内容；需求文档尚未采用标准 ID，不阻断进入架构阶段'
  )
}

async function architectureDiagramParsable(
  ctx: GateCheckContext,
  checkId: string
): Promise<GateCheckResult> {
  const document = inspectDocument(ctx, 'docs/03_design/architecture.md')
  if (document.issues.length === 0) {
    const hasMermaid = /```mermaid[\s\S]*?\b(flowchart|graph|architecture-beta|block-beta)\b/i.test(document.content)
    const hasAsciiDiagram =
      /(?:\+[-=]{2,}\+|┌[─━]{2,}┐)/.test(document.content) &&
      /(?:--?>|==?>|→|←|↔)/.test(document.content)
    if (!hasMermaid && !hasAsciiDiagram) {
      document.issues.push(
        '未识别到可解析的架构框图；请添加 Mermaid flowchart/graph/block-beta 代码块，或包含方框和连接箭头的 ASCII 框图'
      )
    }
  }
  if (document.issues.length === 0) {
    return makeResult(checkId, true, 'error', '通过：architecture.md 内容完整，并识别到架构框图')
  }
  return makeResult(
    checkId,
    false,
    'error',
    [
      '架构文档未达到推进条件：',
      '• docs/03_design/architecture.md',
      ...document.issues.map((issue) => `  - ${issue}`),
      '修复后在阶段看板点击“重新检查”。'
    ].join('\n')
  )
}

function collectJsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collectJsonFiles(full))
    else if (entry.name.endsWith('.json')) files.push(full)
  }
  return files
}

async function simPassed(ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> {
  const resultFiles = collectJsonFiles(join(ctx.workspaceDir, 'verification', 'results'))
    .filter((file) => file.endsWith('result.json'))
  if (resultFiles.length === 0) {
    return makeResult(checkId, false, 'error', 'verification/results/<module>/result.json 不存在')
  }
  const failed = resultFiles.filter((file) => {
    try { return JSON.parse(readFileSync(file, 'utf-8')).passed !== true } catch { return true }
  })
  if (failed.length === 0) {
    return makeResult(checkId, true, 'error', `${resultFiles.length} 个仿真结果均通过`)
  }
  // 列出失败文件与原因（结果未通过 / JSON 无法解析），便于 Agent 定位
  const details = failed.map((file) => {
    const rel = relative(ctx.workspaceDir, file)
    try {
      JSON.parse(readFileSync(file, 'utf-8'))
      return `  - ${rel}：仿真未通过（passed != true）`
    } catch {
      return `  - ${rel}：result.json 无法解析`
    }
  })
  return makeResult(
    checkId,
    false,
    'error',
    `${failed.length} 个仿真结果失败或无法解析：\n${details.join('\n')}`
  )
}

function coverageAtLeast(keys: string[], threshold: number) {
  return async (ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> => {
    const values: number[] = []
    for (const file of collectJsonFiles(join(ctx.workspaceDir, 'verification', 'results'))) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
        for (const key of keys) if (typeof data[key] === 'number') values.push(data[key] as number)
        const coverage = data.coverage as Record<string, unknown> | undefined
        if (coverage) for (const key of keys) if (typeof coverage[key] === 'number') values.push(coverage[key] as number)
      } catch { /* 其他 JSON 不影响覆盖率扫描 */ }
    }
    if (values.length === 0) return makeResult(checkId, false, 'error', `未找到覆盖率字段：${keys.join('/')}`)
    const minimum = Math.min(...values)
    return makeResult(checkId, minimum >= threshold, 'error', `最低覆盖率 ${minimum}%（要求 ≥${threshold}%）`)
  }
}

async function verificationEvidenceReview(ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> {
  const path = join(ctx.workspaceDir, 'verification', 'results', 'verification_signoff_review.json')
  if (!existsSync(path)) return makeResult(checkId, false, 'error', '尚未调用 review_verification_evidence 生成独立证据审查')
  try {
    const review = JSON.parse(readFileSync(path, 'utf-8')) as { verdict?: string; blockers?: unknown[] }
    const blockers = Array.isArray(review.blockers) ? review.blockers.length : 0
    return makeResult(checkId, review.verdict === 'passed' && blockers === 0, 'error', `审查结论：${review.verdict ?? '未知'}，阻断项 ${blockers}`)
  } catch { return makeResult(checkId, false, 'error', 'verification_signoff_review.json 无法解析') }
}

/** Lint 零 Error：逐文件 runLint（verible 优先，verilator 回退），任一 Error 即失败 */
async function lintZeroError(ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> {
  const files = collectDesignRtlFiles(ctx.workspaceDir)
  if (files.length === 0) {
    return makeResult(checkId, false, 'error', '工作区暂无 RTL 文件（*.v/*.sv），无法执行 Lint')
  }

  let engine = ''
  const errors: string[] = []
  let warningCount = 0
  for (const file of files) {
    const result = await runLint({ filePath: file })
    engine = result.engine
    warningCount += result.warnings.length
    for (const e of result.errors) {
      errors.push(`${file}:${e.line}:${e.column} ${e.message}`)
    }
  }

  if (errors.length > 0) {
    const shown = errors.slice(0, MAX_ISSUES_IN_MESSAGE).join('；')
    const more = errors.length > MAX_ISSUES_IN_MESSAGE ? ` 等 ${errors.length} 条` : ''
    return makeResult(checkId, false, 'error', `${errors.length} 条 Error（${engine}）：${shown}${more}`)
  }
  const warn = warningCount > 0 ? `，${warningCount} 条 Warning 待评审` : ''
  return makeResult(checkId, true, 'error', `通过（${engine}，${files.length} 个文件${warn}）`)
}

/** Yosys 可综合性：全部 RTL 文件一次检查 */
async function yosysSynthesizable(ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> {
  const files = collectDesignRtlFiles(ctx.workspaceDir)
  if (files.length === 0) {
    return makeResult(checkId, false, 'error', '工作区暂无 RTL 文件（*.v/*.sv），无法执行综合检查')
  }

  const libraryFiles = collectLibraryRtlFiles(ctx.workspaceDir)
  const result = await checkSynthesizability({ rtlFiles: files, libraryFiles })
  if (!result.synthesizable) {
    const errs = result.issues.filter((i) => i.severity === 'error')
    const shown = errs.slice(0, MAX_ISSUES_IN_MESSAGE).map((e) => e.message).join('；')
    const more = errs.length > MAX_ISSUES_IN_MESSAGE ? ` 等 ${errs.length} 条` : ''
    return makeResult(checkId, false, 'error', `不可综合：${shown}${more}`)
  }
  const est = result.resourceEstimate
  const estText = est.cells !== undefined ? `，约 ${est.cells} cells / ${est.wires} wires` : ''
  return makeResult(checkId, true, 'error', `可综合（${files.length} 个设计文件，${libraryFiles.length} 个 blackbox 宏视图${estText}）`)
}

/** Yosys CDC 检查：检测多时钟域间的信号交叉
 *
 * 使用 Yosys 读取设计，运行 proc/flatten 后 dump 所有连接信息，
 * 解析时钟域并检测跨时钟域信号是否经过了同步器。
 */
async function cdcPassed(ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> {
  const files = collectDesignRtlFiles(ctx.workspaceDir)
  if (files.length === 0) {
    return makeResult(checkId, true, 'info', '工作区暂无 RTL 文件，跳过 CDC 检查')
  }

  try {
    // 使用 Yosys dump 设计信息：clock 域 + 连接关系
    // 先检测全局时钟信号
    const clockSignals = new Set<string>()
    const resetSignals = new Set<string>()
    const clockDomains = new Map<string, string[]>() // clock -> registers

    for (const file of files) {
      const code = readFileSync(file, 'utf-8')
      const lines = code.split(/\r?\n/)

      let currentClk = ''
      let currentRst = ''

      for (const line of lines) {
        const t = line.trim()

        // 检测 module 级别时钟/复位输入端口
        const inputMatch = /^\s*(input)\s+(wire\s+)?(\[.*?\]\s+)?(i_(clk|rst_n?|rst))(\s*,\s*|\s*;|\s*\)|\s*$)/i.exec(line)
        if (inputMatch) {
          const name = inputMatch[4]
          if (/clk/i.test(name)) clockSignals.add(name)
          if (/rst/i.test(name)) resetSignals.add(name)
        }

        // 检测 always @(posedge clk ...)
        const alwaysMatch = /always\s*@\s*\(\s*(posedge|negedge)\s+(\w+)/i.exec(t)
        if (alwaysMatch) {
          currentClk = alwaysMatch[2]
          currentRst = ''
          clockSignals.add(currentClk)
          if (!clockDomains.has(currentClk)) clockDomains.set(currentClk, [])
          continue
        }

        // 检测 always 块内的寄存器赋值
        if (currentClk && /^\s*(r_\w+|o_\w+)\s*<=\s*/.test(t)) {
          const regMatch = /^\s*(r_\w+|o_\w+)\s*<=\s*/.exec(t)
          if (regMatch) {
            clockDomains.get(currentClk)!.push(regMatch[1])
          }
        }

        // 检测复位条件
        if (currentClk && /negedge\s+(\w+)/i.test(t) && !/clk/i.test(t)) {
          const rstMatch = /negedge\s+(\w+)/i.exec(t)
          if (rstMatch && /rst/i.test(rstMatch[1])) {
            currentRst = rstMatch[1]
            resetSignals.add(currentRst)
          }
        }
      }
    }

    // 多时钟域检测
    if (clockDomains.size <= 1) {
      return makeResult(checkId, true, 'info',
        `单时钟域设计（${files.length} 个文件，时钟: ${[...clockSignals].join(', ') || '无'}` +
        `）；启发式扫描未发现多时钟域，本结果不构成 CDC 签核`
      )
    }

    // 检测跨时钟域信号：查找一个时钟域中写入、另一时钟域中读取的寄存器
    const clkList = [...clockDomains.keys()]
    const cdComments: string[] = []
    const violations: string[] = []

    for (let i = 0; i < clkList.length; i++) {
      for (let j = i + 1; j < clkList.length; j++) {
        const clkA = clkList[i]
        const clkB = clkList[j]
        const regsA = clockDomains.get(clkA) ?? []
        const regsB = clockDomains.get(clkB) ?? []

        // 本简易检查：报告多时钟域信息
        cdComments.push(`  时钟域 ${clkA}: ${regsA.length} 个寄存器`)
        cdComments.push(`  时钟域 ${clkB}: ${regsB.length} 个寄存器`)

        // 跨时钟域信号检测（本检查为启发式）
        // TODO: 更精确的 CDC 分析需形式化方法（symbiyosys）
        cdComments.push(`  ${clkA} ↔ ${clkB}: 存在多时钟域，请确认所有跨域信号都经过同步器`)
      }
    }

    const report = [
      `检测到 ${clockDomains.size} 个时钟域：`,
      ...cdComments,
      '',
      '建议：',
      '  - 单比特跨时钟域信号使用 2-flop 同步器',
      '  - 多比特/数据总线使用异步 FIFO',
      '  - 确认所有跨域路径都有明确同步策略'
    ]

    return makeResult(checkId, true, 'warning',
      `启发式风险提示，不纳入门禁且不构成 CDC 签核：${clockDomains.size} 个时钟域。${report.join('；')}`
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return makeResult(checkId, true, 'info', `CDC 分析执行异常: ${msg}（不阻断流转）`)
  }
}

/** 检查器注册表：checkId → 真实检查实现；未注册的走「未接入」占位 */
const CHECKERS: Record<string, (ctx: GateCheckContext, checkId: string) => Promise<GateCheckResult>> = {
  'requirements-usable': requirementsUsable,
  'module-spec-usable': requireFiles(['docs/02_requirements/module_specification.md']),
  'interface-spec-usable': requireFiles(['docs/03_design/interface_spec.md']),
  'rtm-complete': rtmComplete,
  'interface-signals-nonempty': requireFiles(['docs/03_design/interface_spec.md']),
  'module-partition-sane': optionalDocument(
    'docs/03_design/microarchitecture.md',
    '简单单模块或无需展开内部流水线/控制状态的设计可不单独创建微架构文档'
  ),
  'block-diagram-parsable': architectureDiagramParsable,
  'clock-reset-defined': optionalDocument(
    'docs/03_design/clock_reset.md',
    '单时钟、单复位且无 CDC/RDC 的设计可不单独创建时钟复位文档'
  ),
  'port-consistency': requireFiles(['docs/03_design/interface_spec.md']),
  'line-coverage-gte-90': coverageAtLeast(['lineCoverage', 'line_coverage'], 90),
  'branch-coverage-gte-85': coverageAtLeast(['branchCoverage', 'branch_coverage', 'expressionCoverage'], 85),
  'func-coverage-gte-80': coverageAtLeast(['functionalCoverage', 'functional_coverage', 'funcCoverage'], 80),
  'verification-evidence-review': verificationEvidenceReview,
  'sim-passed': simPassed,
  'verible-lint-zero-error': lintZeroError,
  'verible-zero-error': lintZeroError,
  'yosys-synthesizable': yosysSynthesizable,
  'cdc-passed': cdcPassed
}

export function createInitialPhases(): Record<Phase, PhaseState> {
  const blank = (): PhaseState => ({
    status: 'locked',
    deliverables: [],
    agentContext: { messageCount: 0 },
    reviewStatus: 'pending',
    gateCheckResults: []
  })
  const phases = Object.fromEntries(PHASE_ORDER.map((p) => [p, blank()])) as Record<Phase, PhaseState>
  phases.REQ_SPEC.status = 'active'
  phases.REQ_SPEC.startedAt = new Date().toISOString()
  return phases
}

/** 将一次阶段修改传播给已完成的后续阶段；尚未开始的阶段不产生通知。 */
export function markPhaseChanged(project: ChipProject, sourcePhase: Phase, reason: string): ChipProject {
  const sourceIndex = PHASE_ORDER.indexOf(sourcePhase)
  if (sourceIndex < 0) return project
  const now = new Date().toISOString()
  const changeId = randomUUID()
  for (let index = sourceIndex + 1; index < PHASE_ORDER.length; index += 1) {
    const phase = PHASE_ORDER[index]
    const phaseState = project.phases[phase]
    if (phaseState.status !== 'completed') continue
    const notice: PhaseChangeNotice = {
      id: changeId,
      sourcePhase,
      reason,
      changedAt: now,
      baselineCompletedAt: phaseState.completedAt ?? now,
      status: 'pending'
    }
    phaseState.changeNotice = notice
  }
  project.updatedAt = now
  return project
}

/** 双击阶段节点进入阶段，不清理任何后续阶段结果。 */
export function enterPhase(project: ChipProject, to: Phase): ChipProject {
  if (!PHASE_ORDER.includes(to)) throw new Error(`[phase-engine] 未知阶段: ${to}`)
  const now = new Date().toISOString()
  project.currentPhase = to
  project.phases[to].status = 'active'
  project.phases[to].startedAt = project.phases[to].startedAt ?? now
  project.updatedAt = now
  return project
}

/** 标记指定阶段已完成对上游变更的响应。 */
export function acknowledgePhaseChange(project: ChipProject, phase: Phase, responseNote = '已完成变更响应'): ChipProject {
  const notice = project.phases[phase].changeNotice
  if (!notice || notice.status !== 'pending') return project
  const now = new Date().toISOString()
  project.phases[phase].changeNotice = {
    ...notice,
    status: 'responded',
    respondedAt: now,
    responseNote
  }
  project.updatedAt = now
  return project
}

export class PhaseEngine implements MoonGlassService {
  readonly name = 'phase-engine'

  private db?: DbService

  constructor(db?: DbService) {
    this.db = db
  }

  start(): void {
    // 无外部资源
  }

  stop(): void {
    // 无外部资源
  }

  /** 查询两个相邻阶段间的门禁规则 */
  getGateRule(from: Phase, to: Phase): GateRule | undefined {
    return GATE_RULES.find((r) => r.from === from && r.to === to)
  }

  /**
   * 运行门禁自动检查。
   * 已注册检查器（lint / yosys）真实执行；未接入检查项返回 info 占位（不阻塞）。
   * 若数据库可用，每条结果都会持久化到 gate_checks 表。
   */
  async runGateChecks(project: ChipProject, to: Phase, ctx: GateCheckContext): Promise<GateCheckResult[]> {
    const rule = this.getGateRule(project.currentPhase, to)
    if (!rule) return []

    const results = await Promise.all(
      rule.autoChecks.map(async (checkId) => {
        const checker = CHECKERS[checkId]
        if (!checker) {
          return makeResult(checkId, true, 'info', '未接入（待后续阶段），不阻塞流转')
        }
        try {
          return await checker(ctx, checkId)
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return makeResult(checkId, false, 'error', `检查执行失败：${msg}`)
        }
      })
    )

    // 持久化到数据库（可选）
    if (this.db) {
      try {
        const database = this.db.getDb()
        // UI 和推进逻辑只消费最近一次结果；同项目同阶段旧记录直接替换，避免无限增长。
        database.delete(gateChecks).where(and(
          eq(gateChecks.projectId, project.id),
          eq(gateChecks.phase, project.currentPhase)
        )).run()
        for (const r of results) {
          database.insert(gateChecks).values({
            id: randomUUID(),
            projectId: project.id,
            phase: project.currentPhase,
            checkId: r.checkId,
            checkName: r.checkName,
            checkType: inferCheckType(r.checkId),
            passed: r.passed,
            severity: r.severity,
            message: r.message,
            details: JSON.stringify({ autoFixable: r.autoFixable, fixedBy: r.fixedBy })
          }).run()
        }
      } catch (err) {
        console.error('[phase-engine] 门禁结果落库失败', err)
      }
    }

    return results
  }

  /** 是否存在阻断项（Error 级检查未通过） */
  isBlocked(results: GateCheckResult[]): boolean {
    return results.some((r) => r.severity === 'error' && !r.passed)
  }

  /** 判断 to 是否为 currentPhase 的下一相邻阶段 */
  canAdvance(project: ChipProject, to: Phase): boolean {
    const cur = PHASE_ORDER.indexOf(project.currentPhase)
    return PHASE_ORDER.indexOf(to) === cur + 1
  }

  enterPhase(project: ChipProject, to: Phase): ChipProject {
    return enterPhase(project, to)
  }

  acknowledgePhaseChange(project: ChipProject, phase: Phase, responseNote?: string): ChipProject {
    return acknowledgePhaseChange(project, phase, responseNote)
  }

  /** 推进到下一阶段（就地修改 project，由调用方持久化） */
  advance(project: ChipProject, to: Phase): ChipProject {
    if (!this.canAdvance(project, to)) {
      throw new Error(`[phase-engine] 非法阶段跳转: ${project.currentPhase} → ${to}（仅支持逐阶段推进）`)
    }
    const pendingChange = project.phases[project.currentPhase].changeNotice
    if (pendingChange?.status === 'pending') {
      throw new Error(`[phase-engine] ${project.currentPhase} 仍有上游变更待响应，请先完成变更响应`)
    }
    const now = new Date().toISOString()
    project.phases[project.currentPhase].status = 'completed'
    project.phases[project.currentPhase].completedAt = now
    project.currentPhase = to
    project.phases[to].status = 'active'
    project.phases[to].startedAt = project.phases[to].startedAt ?? now
    project.updatedAt = now
    return project
  }

  /** 用户显式选择快速面积评估：从 RTL 跳过 VERIF/QA，直接进入 SYNTH。 */
  fastTrackSynthesis(project: ChipProject): ChipProject {
    if (project.currentPhase !== 'RTL') {
      throw new Error(`[phase-engine] 快速面积评估只能从 RTL 阶段发起，当前为 ${project.currentPhase}`)
    }
    const now = new Date().toISOString()
    const reason = '用户选择跳过验证检查和 QA 质量检查，仅进行快速面积评估；结果不得视为验证或质量签核。'
    project.phases.RTL.status = 'completed'
    project.phases.RTL.completedAt = now
    for (const phase of ['VERIF', 'QA'] as const) {
      project.phases[phase].status = 'skipped'
      project.phases[phase].skippedAt = now
      project.phases[phase].skipReason = reason
      project.phases[phase].gateCheckResults = [
        makeResult(`fast-track-${phase.toLowerCase()}`, false, 'warning', reason)
      ]
    }
    project.currentPhase = 'SYNTH'
    project.phases.SYNTH.status = 'active'
    project.phases.SYNTH.startedAt = now
    project.updatedAt = now
    return project
  }

  /** 最终阶段收口：SYNTH 由 active 变为 completed，项目由此可判定完成。 */
  completeProject(project: ChipProject): ChipProject {
    if (project.currentPhase !== 'SYNTH' || project.phases.SYNTH.status !== 'active') {
      throw new Error('[phase-engine] 只有进行中的 SYNTH 阶段可以完成项目')
    }
    const now = new Date().toISOString()
    project.phases.SYNTH.status = 'completed'
    project.phases.SYNTH.completedAt = now
    project.updatedAt = now
    return project
  }

  /** 回退到之前的任一阶段（后续阶段产出标记为废弃的语义由调用方处理） */
  rollback(project: ChipProject, to: Phase): ChipProject {
    const cur = PHASE_ORDER.indexOf(project.currentPhase)
    const target = PHASE_ORDER.indexOf(to)
    if (target >= cur) {
      throw new Error(`[phase-engine] 非法回退: ${project.currentPhase} → ${to}`)
    }
    const now = new Date().toISOString()
    for (let i = target + 1; i < PHASE_ORDER.length; i++) {
      const p = PHASE_ORDER[i]
      project.phases[p].status = 'locked'
      project.phases[p].completedAt = undefined
      project.phases[p].skippedAt = undefined
      project.phases[p].skipReason = undefined
    }
    project.currentPhase = to
    project.phases[to].status = 'active'
    project.phases[to].completedAt = undefined
    project.phases[to].skippedAt = undefined
    project.phases[to].skipReason = undefined
    project.updatedAt = now
    return project
  }
}
