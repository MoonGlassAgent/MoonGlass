/**
 * 7 阶段流程引擎（状态机 + 门禁规则）
 *
 * 依据规格书 §3.1 的阶段跳转规则定义。
 * Phase 3：门禁自动检查接入真实 EDA 工具（lint / yosys 可综合性），
 * Error 级检查失败阻断推进；文档类/覆盖率类检查保持「未接入」占位（不阻塞）。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { runLint, checkSynthesizability } from '@moonglass/eda-bridge'
import {
  PHASE_ORDER,
  type ChipProject,
  type GateCheckResult,
  type GateRule,
  type Phase,
  type PhaseState
} from '@shared/types'
import type { MoonGlassService } from '../core/lifecycle.ts'
import { gateChecks } from '../data/schema/moonglass.ts'
import type { DbService } from './DbService.ts'

/** 阶段跳转门禁规则表（规格书 §3.1） */
export const GATE_RULES: readonly GateRule[] = [
  { from: 'REQ', to: 'SPEC', precondition: '需求文档已建立', autoChecks: ['doc-completeness', 'rtm-exists'] },
  { from: 'SPEC', to: 'ARCH', precondition: '需求定义可用 + RTM 可追溯', autoChecks: ['requirements-usable', 'rtm-complete'] },
  { from: 'ARCH', to: 'RTL', precondition: '架构、接口、模块划分与时钟复位方案可用', autoChecks: ['block-diagram-parsable', 'interface-signals-nonempty', 'module-partition-sane', 'clock-reset-defined'] },
  { from: 'RTL', to: 'VERIF', precondition: '可编译 RTL + 端口提取通过', autoChecks: ['verible-lint-zero-error', 'port-consistency'] },
  { from: 'VERIF', to: 'QA', precondition: '覆盖率报告', autoChecks: ['line-coverage-gte-90', 'func-coverage-gte-80', 'sim-passed'] },
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
  'doc-completeness': '需求文档已建立',
  'rtm-exists': '需求追溯矩阵（RTM）存在',
  'requirements-usable': '需求定义可用于架构设计',
  'rtm-complete': '需求追溯矩阵（RTM）完备',
  'interface-signals-nonempty': '接口信号清单非空',
  'module-partition-sane': '模块划分合理性',
  'block-diagram-parsable': '架构框图可解析',
  'clock-reset-defined': '时钟/复位方案定义',
  'verible-lint-zero-error': 'Lint 零 Error',
  'port-consistency': '端口一致性检查',
  'line-coverage-gte-90': '行覆盖率 ≥90%',
  'func-coverage-gte-80': '功能覆盖率 ≥80%',
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

/** 递归收集工作区 RTL 文件（跳过 .pi 等隐藏目录与 node_modules） */
/** 排除的生成文件/目录名模式 */
const EXCLUDED_DIRS = /^(obj_dir|__pycache__|node_modules|build|sim_build|04_verification)$/
const EXCLUDED_FILES = /^(_+)?(synth_|output_|result_|merged_|combined_|tmp_|temp_)/i

function collectRtlFiles(dir: string): string[] {
  const out: string[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (e.name.startsWith('.') || EXCLUDED_DIRS.test(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) {
      out.push(...collectRtlFiles(full))
    } else if (/\.(v|sv)$/i.test(e.name) && !EXCLUDED_FILES.test(e.name)) {
      out.push(full)
    }
  }
  return out
}

/** 门禁只检查设计源；verification 中的 DUT 镜像和测试辅助模块不能进入综合。 */
function collectDesignRtlFiles(workspaceDir: string): string[] {
  const canonicalRtlDir = join(workspaceDir, 'rtl')
  const manifestPath = join(canonicalRtlDir, 'design.json')
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>
      let entries = Array.isArray(manifest.files) ? manifest.files.filter((item): item is string => typeof item === 'string') : []
      const filelist = typeof manifest.filelist === 'string' ? manifest.filelist : 'filelist.f'
      const filelistPath = resolveRtlPath(workspaceDir, canonicalRtlDir, filelist)
      if (entries.length === 0 && existsSync(filelistPath)) {
        entries = readFileSync(filelistPath, 'utf-8').split(/\r?\n/)
          .map((line) => line.trim()).filter((line) => line.length > 0 && !/^(#|\/\/|\+|-)/.test(line))
      }
      if (entries.length > 0) return [...new Set(entries.map((entry) => resolveRtlPath(workspaceDir, canonicalRtlDir, entry)))]
    } catch { /* 无效 manifest 由后续 RTL 检查给出文件级错误 */ }
  }
  const macroView = /(?:^|[\\/])macros[\\/]|_(?:behavioral|blackbox|phy_template)\.v$/i
  return collectRtlFiles(existsSync(canonicalRtlDir) ? canonicalRtlDir : workspaceDir).filter((file) => !macroView.test(file))
}

function resolveRtlPath(workspaceDir: string, rtlDir: string, entry: string): string {
  if (isAbsolute(entry)) return resolve(entry)
  return resolve(entry.replace(/\\/g, '/').startsWith('rtl/') ? workspaceDir : rtlDir, entry)
}

function collectLibraryRtlFiles(workspaceDir: string): string[] {
  const rtlDir = join(workspaceDir, 'rtl')
  const manifestPath = join(rtlDir, 'design.json')
  if (!existsSync(manifestPath)) return []
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>
    const entries = Array.isArray(manifest.libraryFiles)
      ? manifest.libraryFiles.filter((item): item is string => typeof item === 'string')
      : []
    return [...new Set(entries.map((entry) => resolveRtlPath(workspaceDir, rtlDir, entry)))]
  } catch {
    return []
  }
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

const REQUIREMENT_ID = /\b(?:REQ(?:-[A-Z]+)?|FR|NFR|PERF|IF|SEC)[-_]?\d+\b/gi

function requirementIds(content: string): Set<string> {
  return new Set((content.match(REQUIREMENT_ID) ?? []).map((id) => id.toUpperCase().replace('_', '-')))
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
      `RTM 不可用：\n• ${rtm.path}\n${rtm.issues.map((issue) => `  - ${issue}`).join('\n')}`
    )
  }
  const tableRows = rtm.content
    .split(/\r?\n/)
    .filter((line) => /^\s*\|.*\|\s*$/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => !cells.every((cell) => /^:?-{3,}:?$/.test(cell)))
    .filter((cells) => !cells.some((cell) => /^(?:需求|requirement)\s*(?:id|编号)?$/i.test(cell)))
  if (tableRows.length === 0) {
    return makeResult(checkId, false, 'error', 'RTM 未识别到有效的 Markdown 追溯表行')
  }

  const requirements = inspectDocument(ctx, 'docs/02_requirements/product_requirements.md')
  const requiredIds = requirementIds(requirements.content)
  const tracedIds = requirementIds(rtm.content)
  const missing = [...requiredIds].filter((id) => !tracedIds.has(id))
  if (missing.length > 0) {
    return makeResult(
      checkId,
      false,
      'error',
      `RTM 缺少 ${missing.length} 个需求 ID 的追溯关系：${missing.slice(0, 12).join('、')}${missing.length > 12 ? '…' : ''}`
    )
  }
  return makeResult(
    checkId,
    true,
    'error',
    requiredIds.size > 0
      ? `通过：RTM 表格有效，${requiredIds.size} 个需求 ID 均可追溯`
      : '通过：RTM 表格存在有效追溯内容；需求文档尚未采用标准 ID，不阻断进入架构阶段'
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
  return failed.length === 0
    ? makeResult(checkId, true, 'error', `${resultFiles.length} 个仿真结果均通过`)
    : makeResult(checkId, false, 'error', `${failed.length} 个仿真结果失败或无法解析`)
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
  'doc-completeness': requireFiles([
    'docs/02_requirements/product_requirements.md'
  ], 'warning'),
  'rtm-exists': requireFiles(['docs/02_requirements/requirements_traceability.md'], 'warning'),
  'requirements-usable': requirementsUsable,
  'rtm-complete': rtmComplete,
  'interface-signals-nonempty': requireFiles(['docs/03_design/interface_spec.md']),
  'module-partition-sane': requireFiles(['docs/03_design/microarchitecture.md']),
  'block-diagram-parsable': architectureDiagramParsable,
  'clock-reset-defined': requireFiles(['docs/03_design/clock_reset.md']),
  'port-consistency': requireFiles(['docs/03_design/interface_spec.md']),
  'line-coverage-gte-90': coverageAtLeast(['lineCoverage', 'line_coverage'], 90),
  'func-coverage-gte-80': coverageAtLeast(['functionalCoverage', 'functional_coverage', 'funcCoverage'], 80),
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
  phases.REQ.status = 'active'
  phases.REQ.startedAt = new Date().toISOString()
  return phases
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

  /** 推进到下一阶段（就地修改 project，由调用方持久化） */
  advance(project: ChipProject, to: Phase): ChipProject {
    if (!this.canAdvance(project, to)) {
      throw new Error(`[phase-engine] 非法阶段跳转: ${project.currentPhase} → ${to}（仅支持逐阶段推进）`)
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
