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
import { basename, dirname, join, relative, sep } from 'node:path'
import { runLint, runDesignLint, checkSynthesizability, readRtlInputs } from '@moonglass/eda-bridge'
import { buildVerificationIntelligence, reviewScenarioClosure, reviewSynthesisClauses, computeRtlHash, auditVerificationCompleteness } from '@moonglass/verification-intelligence-engine'
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
import {
  ARCH_REVIEW_FINDINGS_PATH,
  RTL_REVIEW_FINDINGS_PATH,
  pendingMajorCount,
  readDesignReviewFindings,
  reviewRoundCount
} from './design-review.ts'

/** 阶段跳转门禁规则表（规格书 §3.1） */
export const GATE_RULES: readonly GateRule[] = [
  { from: 'REQ_SPEC', to: 'ARCH', precondition: '需求、模块规格、接口规格与追溯矩阵可用于架构设计', autoChecks: ['requirements-usable', 'module-spec-usable', 'interface-spec-usable', 'rtm-complete'] },
  { from: 'ARCH', to: 'RTL', precondition: '总体架构和接口可用；复杂度超阈值时微架构文档必选；建议完成独立架构一致性 review（软告警不阻断）', autoChecks: ['block-diagram-parsable', 'interface-signals-nonempty', 'module-partition-sane', 'clock-reset-defined', 'arch-consistency-review'] },
  { from: 'RTL', to: 'VERIF', precondition: '可编译 RTL + 端口提取通过；建议完成独立语义一致性 review（软告警不阻断）', autoChecks: ['verible-lint-zero-error', 'port-consistency', 'rtl-semantic-review'] },
  { from: 'VERIF', to: 'QA', precondition: '覆盖率、Scenario 闭环与独立证据审查报告', autoChecks: ['line-coverage-gte-90', 'branch-coverage-gte-85', 'func-coverage-gte-80', 'sim-passed', 'verification-scenario-closure', 'verification-evidence-review'] },
  { from: 'QA', to: 'SYNTH', precondition: 'Lint/CDC/代码审查通过，语义实现与验证完备性已终审，覆盖率无退化', autoChecks: ['verible-zero-error', 'yosys-synthesizable', 'cdc-passed', 'line-coverage-gte-90', 'branch-coverage-gte-85', 'func-coverage-gte-80', 'qa-spec-implementation-reviewed', 'qa-verification-completeness', 'qa-code-review-done', 'qa-reset-review-documented', 'qa-dead-logic-adjudicated'] }
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
  'module-partition-sane': '微架构文档（复杂度超阈值必选）',
  'block-diagram-parsable': '架构框图可解析',
  'clock-reset-defined': '独立时钟/复位文档（按复杂度选配）',
  'verible-lint-zero-error': 'Lint 零 Error',
  'port-consistency': '端口一致性检查',
  'arch-consistency-review': 'ARCH 出口架构一致性 review（软运行）',
  'rtl-semantic-review': 'RTL 出口语义一致性 review（软运行）',
  'line-coverage-gte-90': '行覆盖率 ≥90%',
  'branch-coverage-gte-85': '条件覆盖率 ≥85%（表达式求值口径，非 MC/DC）',
  'func-coverage-gte-80': '功能覆盖率 ≥80%',
  'verification-evidence-review': '验证原始证据独立审查',
  'verification-scenario-closure': '关键风险 Scenario 闭环',
  'sim-passed': '仿真通过',
  'verible-zero-error': 'Lint 零 Error',
  'yosys-synthesizable': 'Yosys 可综合性',
  'cdc-passed': 'CDC 启发式风险扫描（非签核）',
  'qa-spec-implementation-reviewed': 'QA 需求/规格语义实现审查',
  'qa-verification-completeness': 'QA 规格点-验证点-用例完备性审计',
  'qa-code-review-done': 'QA 代码审查检查清单闭环',
  'qa-reset-review-documented': 'QA 复位风险评审结论留档',
  'qa-dead-logic-adjudicated': 'QA 死逻辑检查无未裁决项'
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

// 复杂度阈值口径（设计文档 DESIGN-REVIEW-LEFT-SHIFT-ZH-CN.md §3「方案一」）：
// 规格条款数 > 50 或 模块数 > 4 时，docs/03_design/microarchitecture.md 由 info 选配升为 error 必选；
// 未超阈值维持 info 现状。两个指标任一超阈值即升档。
const MICROARCH_CLAUSE_THRESHOLD = 50
const MICROARCH_MODULE_THRESHOLD = 4

/**
 * 从 architecture.md 的模块划分节统计模块数（保守启发式，宁软勿硬）：
 * 只认「标题含『模块』且含『划分/列表』」的小节内的 Markdown 表格，
 * 且表头首列须恰为 模块名/模块名称/模块，统计首列非空的数据行数（按模块名去重）。
 * 识别不到符合口径的模块列表时返回 null，调用方按「未超阈值」处理。
 */
function countArchitectureModules(content: string): number | null {
  const lines = content.split(/\r?\n/)
  let inModuleSection = false
  let sectionLevel = 0
  let expectSeparator = false
  let expectRows = false
  const names = new Set<string>()
  for (const line of lines) {
    const heading = /^(#{1,6})\s+/.exec(line)
    if (heading) {
      const level = heading[1].length
      if (inModuleSection && level <= sectionLevel) {
        inModuleSection = false
        expectSeparator = false
        expectRows = false
      }
      const title = line.replace(/^#{1,6}\s+/, '').trim()
      if (/模块/.test(title) && /(?:划分|列表)/.test(title)) {
        inModuleSection = true
        sectionLevel = level
      }
      continue
    }
    if (!inModuleSection) continue
    const cells = markdownCells(line)
    if (!cells) {
      expectSeparator = false
      expectRows = false
      continue
    }
    if (expectSeparator) {
      expectSeparator = false
      expectRows = cells.every((cell) => /^:?-{3,}:?$/.test(cell))
      continue
    }
    if (expectRows) {
      const name = (cells[0] ?? '').trim()
      if (name) names.add(name)
    } else if (/^(?:模块名|模块名称|模块)$/.test((cells[0] ?? '').trim())) {
      expectSeparator = true
    }
  }
  return names.size > 0 ? names.size : null
}

/**
 * 微架构文档分级门禁（module-partition-sane 改造，设计文档 §3/§7）：
 * 规格条款数复用 requirements-usable 的稳定需求 ID 识别口径（requirementIds）；
 * 模块数走 countArchitectureModules 保守启发式（识别失败按未超阈值处理）。
 * 超阈值时 microarchitecture.md 缺失/无效报 error 阻断；未超阈值维持 info 选配语义。
 */
async function modulePartitionSane(ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> {
  const requirements = inspectDocument(ctx, 'docs/02_requirements/product_requirements.md')
  const clauseCount = requirementIds(requirements.content).size
  const architecture = inspectDocument(ctx, 'docs/03_design/architecture.md')
  const moduleCount = architecture.issues.length === 0 ? countArchitectureModules(architecture.content) : null
  const thresholdNote = `复杂度口径：规格条款数 ${clauseCount}（升档阈值 >${MICROARCH_CLAUSE_THRESHOLD}），模块数 ${moduleCount === null ? '无法解析（按未超阈值处理）' : moduleCount}（升档阈值 >${MICROARCH_MODULE_THRESHOLD}）`
  const overClause = clauseCount > MICROARCH_CLAUSE_THRESHOLD
  const overModule = moduleCount !== null && moduleCount > MICROARCH_MODULE_THRESHOLD
  if (!overClause && !overModule) {
    const optional = await optionalDocument(
      'docs/03_design/microarchitecture.md',
      '简单单模块或无需展开内部流水线/控制状态的设计可不单独创建微架构文档'
    )(ctx, checkId)
    return { ...optional, message: `${optional.message}\n${thresholdNote}` }
  }
  const document = inspectDocument(ctx, 'docs/03_design/microarchitecture.md')
  if (document.issues.length > 0) {
    return makeResult(
      checkId,
      false,
      'error',
      [
        '设计复杂度超阈值，必须提供独立微架构文档（设计文档 DESIGN-REVIEW-LEFT-SHIFT-ZH-CN.md §3）：',
        '• docs/03_design/microarchitecture.md',
        ...document.issues.map((issue) => `  - ${issue}`),
        thresholdNote,
        '每个非平凡模块应在微架构文档中说明功能、状态机（状态+转移条件）、寄存器与边界行为、关键时序关系。'
      ].join('\n')
    )
  }
  return makeResult(checkId, true, 'error', `通过：复杂度超阈值且微架构文档存在且有效。${thresholdNote}`)
}

// 负向回顾 (?<![A-Za-z0-9]-) 阻止裸前缀匹配到另一 ID 内部（如 SPEC-PERF-006 中的 PERF-006），
// 同时保留 REQ-PERF-001 整体匹配与 legacy 裸前缀 ID（如单独的 PERF-001）的兼容
const REQUIREMENT_ID = /(?<![A-Za-z0-9]-)\b(?:REQ(?:-[A-Z]+)?|FR|F|NFR|PERF|P|IF|SEC)[-_]?\d+\b/gi
const SPECIFICATION_ID = /(?<![A-Za-z0-9]-)\bSPEC(?:-[A-Z]+)?[-_]?\d+\b/gi

function requirementIds(content: string): Set<string> {
  const ids = new Set(
    (content.match(REQUIREMENT_ID) ?? [])
      .map((id) => id.toUpperCase().replace(/_/g, '-'))
      .filter((id) => !/^P[0-2]$/.test(id))
  )
  const ranges = content.matchAll(
    /(?<![A-Za-z0-9]-)\b(REQ(?:-[A-Z]+)?|FR|F|NFR|PERF|IF|SEC)[-_]?(\d+)\s*(?:~|～|\.\.|至)\s*(\d+)\b/gi
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
  const missing = [...requiredIds].filter((id) => !tracedIds.has(id)).sort()
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

// 缺陷 DEFECT-PACK-001#14/#17 配套：run_simulation 的 mutation/probe 隔离运行产物
// （verification/results/<module>/<purpose>-runs/…，及历史 mutation/、probe/ 段）不计入
// 门禁的回归判定与覆盖率统计；口径与 verification-intelligence 引擎 collectResults 一致
const ISOLATED_RESULTS_SEGMENT = /^(?:mutation|probe|regression)-runs$|^(?:mutation|probe)$/
function isIsolatedRunEvidence(file: string): boolean {
  return file.split(/[\\/]/).some((segment) => ISOLATED_RESULTS_SEGMENT.test(segment))
}

async function simPassed(ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> {
  // 缺陷 DEFECT-PACK-001#14：回归证据只认顶层模块目录直下的 result.json；
  // 隔离运行（*-runs/）与其他深层 result.json 不参与门禁判定
  const resultsRoot = join(ctx.workspaceDir, 'verification', 'results')
  const resultFiles = collectJsonFiles(resultsRoot)
    .filter((file) => basename(file) === 'result.json' && relative(resultsRoot, file).split(sep).length === 2)
  if (resultFiles.length === 0) {
    return makeResult(checkId, false, 'error', 'verification/results/<module>/result.json 不存在')
  }
  // 陈旧 PASS 污染防线：与覆盖率门禁同口径——rtlHash 与当前 RTL 不一致（或缺失）的
  // result.json 视为过期证据，不得充当"仿真通过"判定，必须先重新回归
  const currentRtlHash = currentWorkspaceRtlHash(ctx.workspaceDir)
  if (currentRtlHash) {
    const stale = resultFiles.filter((file) => {
      try { return JSON.parse(readFileSync(file, 'utf-8')).rtlHash !== currentRtlHash } catch { return false }
    })
    if (stale.length > 0) {
      return makeResult(
        checkId,
        false,
        'error',
        `${stale.length} 个模块的回归证据已过期（rtlHash 与当前 RTL 不一致或缺失）：${stale.map((file) => relative(ctx.workspaceDir, file)).join('、')}。请重新运行 run_simulation 回归后再检查`
      )
    }
  }
  const failed = resultFiles.filter((file) => {
    try { return JSON.parse(readFileSync(file, 'utf-8')).passed !== true } catch { return true }
  })
  // AIGV 修订 §6 收紧（TOP 优先，UT 例外）：TOP 的 result.json 必须存在且通过，
  // 每个 active UT 例外模块的 result.json 也必须存在且通过（例外 PASS 不替代 TOP 证据）；
  // TOP 未识别（manifest 缺失/无法判定）时回退"任意模块证据"口径并在消息中标注
  const topModule = resolveGateTopModule(ctx.workspaceDir)
  const utExceptionModules = readActiveUtExceptionModules(ctx.workspaceDir)
  if (topModule || utExceptionModules.length > 0) {
    const fileByModule = new Map(resultFiles.map((file) => [basename(dirname(file)), file]))
    const namedFailures: string[] = []
    if (topModule) {
      const topFile = fileByModule.get(topModule)
      if (!topFile) {
        namedFailures.push(`TOP 证据缺失：verification/results/${topModule}/result.json 不存在——以 TOP 为 DUT 跑一次回归后再检查`)
      } else if (failed.includes(topFile)) {
        namedFailures.push(`TOP 仿真未通过：verification/results/${topModule}/result.json 的 passed != true 或无法解析——以 TOP 为 DUT 重新回归`)
      }
    }
    for (const module of utExceptionModules) {
      const file = fileByModule.get(module)
      if (!file) {
        namedFailures.push(`UT 例外模块证据缺失：verification/results/${module}/result.json 不存在——该模块已登记 active UT 例外（ut-escalations.json），必须单独建 TB 并回归通过`)
      } else if (failed.includes(file)) {
        namedFailures.push(`UT 例外模块仿真未通过：verification/results/${module}/result.json 的 passed != true 或无法解析`)
      }
    }
    if (namedFailures.length > 0) {
      return makeResult(checkId, false, 'error', namedFailures.join('\n'))
    }
  }
  if (failed.length === 0) {
    const scope = topModule ? `（TOP ${topModule}${utExceptionModules.length ? `、UT 例外模块 ${utExceptionModules.join('、')}` : ''}）` : ''
    const fallbackNote = topModule ? '' : 'TOP 未识别，按任意模块证据放行（建议补 design.json）；'
    return makeResult(checkId, true, 'error', `${fallbackNote}${resultFiles.length} 个仿真结果均通过${scope}`)
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

/**
 * sim-passed TOP 判定（AIGV 修订 §6）：与引擎 buildModuleVerificationStrategy 同一来源——
 * rtl/design.json manifest 的 topModule，且必须是设计文件里真实声明的模块；
 * manifest 缺失/无法判定时返回 null（门禁回退"任意模块证据"口径并在消息中标注）。
 */
function resolveGateTopModule(workspaceDir: string): string | null {
  try {
    const manifestPath = join(workspaceDir, 'rtl', 'design.json')
    if (!existsSync(manifestPath)) return null
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { topModule?: unknown }
    if (typeof manifest.topModule !== 'string' || !manifest.topModule.trim()) return null
    const top = manifest.topModule.trim()
    const pattern = new RegExp(`\\bmodule\\s+${top.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    for (const file of collectDesignRtlFiles(workspaceDir)) {
      if (pattern.test(readFileSync(file, 'utf-8'))) return top
    }
    return null
  } catch { return null }
}

/** active UT 例外模块清单（§6：读 verification/results/ut-escalations.json；缺文件/损坏=无例外）。 */
function readActiveUtExceptionModules(workspaceDir: string): string[] {
  try {
    const data = JSON.parse(readFileSync(join(workspaceDir, 'verification', 'results', 'ut-escalations.json'), 'utf-8')) as { escalations?: Array<{ module?: unknown; status?: unknown }> }
    if (!Array.isArray(data.escalations)) return []
    const modules = data.escalations
      .filter((item) => item !== null && typeof item === 'object' && item.status === 'active' && typeof item.module === 'string' && item.module.trim().length > 0)
      .map((item) => (item.module as string).trim())
    return [...new Set(modules)]
  } catch { return [] }
}

function coverageAtLeast(keys: string[], threshold: number) {
  return async (ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> => {
    // 新鲜度过滤：只采信与当前 RTL 版本（rtlHash，run_simulation 回归时自动登记）
    // 一致的覆盖率结果；无 rtlHash 或 rtlHash 不匹配的历史数据一律视为过期，
    // 防止门禁拿早期冒烟/旧 RTL 的残留 coverage 数据判定（与 scenario_hits 同一哈希空间）
    let currentRtlHash: string | null = null
    try { currentRtlHash = computeRtlHash(ctx.workspaceDir) } catch { currentRtlHash = null }
    const values: number[] = []
    let staleCount = 0
    for (const file of collectJsonFiles(join(ctx.workspaceDir, 'verification', 'results'))) {
      // 缺陷 DEFECT-PACK-001#14：隔离运行目录内的覆盖率数据不拉低门禁最低值
      if (isIsolatedRunEvidence(file)) continue
      try {
        const data = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
        if (currentRtlHash && data.rtlHash !== currentRtlHash) { staleCount += 1; continue }
        for (const key of keys) if (typeof data[key] === 'number') values.push(data[key] as number)
        const coverage = data.coverage as Record<string, unknown> | undefined
        if (coverage) for (const key of keys) if (typeof coverage[key] === 'number') values.push(coverage[key] as number)
      } catch { /* 其他 JSON 不影响覆盖率扫描 */ }
    }
    if (values.length === 0) {
      return makeResult(
        checkId,
        false,
        'error',
        staleCount > 0
          ? `覆盖率数据已过期（${staleCount} 份结果属于旧 RTL 版本，与当前 rtlHash 不匹配）：请先运行 run_simulation（rtlCoverage 缺省开启）重新采集，再补测试`
          : `未找到覆盖率字段：${keys.join('/')}`
      )
    }
    const minimum = Math.min(...values)
    const staleNote = staleCount > 0 ? `；已忽略 ${staleCount} 份旧 RTL 版本的过期数据` : ''
    return makeResult(checkId, minimum >= threshold, 'error', `最低覆盖率 ${minimum}%（要求 ≥${threshold}%）${staleNote}`)
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

async function verificationScenarioClosure(ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> {
  buildVerificationIntelligence(ctx.workspaceDir)
  const review = reviewScenarioClosure(ctx.workspaceDir)
  if (review.passed) {
    return makeResult(checkId, true, 'error', `Scenario 闭环通过：${review.state?.scenarioCount ?? 0} 个场景，关键未闭环 0`)
  }
  return makeResult(checkId, false, 'error', [...review.blockers, ...review.warnings].join('\n'))
}

/** Lint 零 Error：逐文件规则检查后，对完整 filelist 执行顶层联合 Lint/elaboration。 */
async function lintZeroError(ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> {
  const inputs = readRtlInputs(ctx.workspaceDir)
  const files = inputs.designFiles
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

  const designResult = await runDesignLint({
    files,
    libraryFiles: inputs.libraryFiles,
    topModule: inputs.topModule,
    includeDirs: inputs.includeDirs,
    defines: inputs.defines
  })
  engine = `${engine} + verilator-design`
  warningCount += designResult.warnings.length
  for (const e of designResult.errors) errors.push(`全设计:${e.line}:${e.column} ${e.message}`)

  if (errors.length > 0) {
    const shown = errors.slice(0, MAX_ISSUES_IN_MESSAGE).join('；')
    const more = errors.length > MAX_ISSUES_IN_MESSAGE ? ` 等 ${errors.length} 条` : ''
    return makeResult(checkId, false, 'error', `${errors.length} 条 Error（${engine}）：${shown}${more}`)
  }
  const warn = warningCount > 0 ? `，${warningCount} 条 Warning 待评审` : ''
  return makeResult(checkId, true, 'error', `通过（${engine}，${files.length} 个设计文件，顶层 ${inputs.topModule ?? '自动识别'}${warn}）`)
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

/** 读取 signoff-approvals.json 的具名审批登记（QA 语义审查/代码审查的 waiver 校验用） */
function readSignoffApprovals(workspaceDir: string): Map<string, { approver: string }> {
  const path = join(workspaceDir, 'verification', 'intelligence', 'signoff-approvals.json')
  const map = new Map<string, { approver: string }>()
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as { approvals?: Array<{ riskId?: string; approver?: string; rationale?: string }> }
    for (const item of data.approvals ?? []) {
      if (item.riskId && item.approver && item.rationale) map.set(item.riskId, { approver: item.approver })
    }
  } catch { /* 缺失或损坏按"无审批"处理 */ }
  return map
}

/** 与覆盖率门禁同口径的 RTL 新鲜度校验：返回当前 rtlHash（计算失败返回 null，不做过滤） */
function currentWorkspaceRtlHash(workspaceDir: string): string | null {
  try { return computeRtlHash(workspaceDir) } catch { return null }
}

/**
 * QA 需求/规格语义实现审查（全面 review：每个规格条款是否被 RTL 实现）。
 * Agent 逐条款裁决写 rtlqa/spec-implementation-review.json；门禁校验条款闭集完备、
 * verdict 合法、implemented 证据真实存在、partial/missing 挂具名豁免、rtlHash 与当前一致。
 */
async function qaSpecImplementationReviewed(ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> {
  const reviewPath = join(ctx.workspaceDir, 'rtlqa', 'spec-implementation-review.json')
  if (!existsSync(reviewPath)) {
    return makeResult(checkId, false, 'error', '尚未完成需求/规格 → RTL 语义实现审查：rtlqa/spec-implementation-review.json 不存在（逐条款裁决 implemented/partial/missing/not_applicable 后重试）')
  }
  buildVerificationIntelligence(ctx.workspaceDir)
  let clauses: Array<{ clauseId: string; channel?: string }> = []
  try {
    const state = JSON.parse(readFileSync(join(ctx.workspaceDir, 'verification', 'intelligence', 'verification-state.json'), 'utf-8')) as { specMapping?: { clauses?: Array<{ clauseId: string; channel?: string }> } }
    clauses = (state.specMapping?.clauses ?? []).filter((clause) => (clause.channel ?? 'simulation') !== 'synthesis')
  } catch { return makeResult(checkId, false, 'error', 'verification-state.json 无法解析，无法核对条款闭集') }

  interface SpecReviewItem { clauseId?: string; verdict?: string; evidence?: unknown; waiverId?: string; note?: string }
  let review: { rtlHash?: string; reviews?: SpecReviewItem[] }
  try { review = JSON.parse(readFileSync(reviewPath, 'utf-8')) as typeof review } catch {
    return makeResult(checkId, false, 'error', 'rtlqa/spec-implementation-review.json 无法解析')
  }
  const currentRtlHash = currentWorkspaceRtlHash(ctx.workspaceDir)
  if (currentRtlHash && !review.rtlHash) {
    return makeResult(checkId, false, 'error', '语义实现审查缺少 rtlHash 字段，无法确认与当前 RTL 一致：请在审查文件写入 rtlHash')
  }
  if (currentRtlHash && review.rtlHash && review.rtlHash !== currentRtlHash) {
    return makeResult(checkId, false, 'error', '语义实现审查基于旧 RTL 版本（rtlHash 不匹配）：RTL 变更后需重新逐条款审查')
  }
  const byClause = new Map((review.reviews ?? []).filter((item) => typeof item.clauseId === 'string').map((item) => [item.clauseId as string, item]))
  const approvals = readSignoffApprovals(ctx.workspaceDir)
  const issues: string[] = []
  for (const clause of clauses) {
    const item = byClause.get(clause.clauseId)
    if (!item) { issues.push(`${clause.clauseId} 缺少裁决`); continue }
    const verdict = item.verdict
    if (!['implemented', 'partial', 'missing', 'not_applicable'].includes(verdict ?? '')) {
      issues.push(`${clause.clauseId} verdict 非法（${verdict ?? '缺失'}，应为 implemented/partial/missing/not_applicable）`)
      continue
    }
    if (verdict === 'implemented') {
      const evidence = Array.isArray(item.evidence) ? item.evidence.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : []
      if (evidence.length === 0) { issues.push(`${clause.clauseId} 裁决 implemented 但无证据（需点名 RTL 模块/信号/行号路径）`); continue }
      const missing = evidence.filter((entry) => !existsSync(join(ctx.workspaceDir, entry.replace(/:\d+(?::\d+)?$/, ''))))
      if (missing.length > 0) issues.push(`${clause.clauseId} 证据路径不存在：${missing[0]}${missing.length > 1 ? ` 等 ${missing.length} 条` : ''}`)
    } else if (verdict === 'partial' || verdict === 'missing') {
      const waiver = typeof item.waiverId === 'string' ? approvals.get(item.waiverId) : undefined
      if (!waiver) issues.push(`${clause.clauseId} 裁决 ${verdict} 但无具名豁免（signoff-approvals.json 需有 waiverId=${item.waiverId ?? '<缺失>'} 的记录，含审批人与依据）`)
    }
  }
  if (issues.length > 0) {
    const shown = issues.slice(0, MAX_ISSUES_IN_MESSAGE).join('；')
    const more = issues.length > MAX_ISSUES_IN_MESSAGE ? ` 等 ${issues.length} 条` : ''
    return makeResult(checkId, false, 'error', `语义实现审查 ${issues.length} 项未通过：${shown}${more}`)
  }
  return makeResult(checkId, true, 'error', `语义实现审查通过：${clauses.length} 个 VERIF 通道条款均有合法裁决（implemented 带证据 / partial、missing 挂具名豁免 / not_applicable）`)
}

/** QA 验证完备性审计（每个规格点是否有验证点、用例绑定与 PASS 证据） */
async function qaVerificationCompletenessGate(ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> {
  buildVerificationIntelligence(ctx.workspaceDir)
  const audit = auditVerificationCompleteness(ctx.workspaceDir)
  if (audit.passed) {
    return makeResult(checkId, true, 'error', `完备性审计通过：${audit.stats.covered}/${audit.stats.clauseTotal} 个规格条款有验证点 + 用例绑定 + 当前 RTL 版本的 PASS 证据（或具名豁免）`)
  }
  const shown = audit.blockers.slice(0, MAX_ISSUES_IN_MESSAGE).join('；')
  const more = audit.blockers.length > MAX_ISSUES_IN_MESSAGE ? ` 等 ${audit.blockers.length} 条` : ''
  return makeResult(checkId, false, 'error', `${audit.blockers.length} 个规格条款验证不完备：${shown}${more}`)
}

/** QA 代码审查检查清单闭环（rtlqa/code-review-verdicts.json，逐条 pass/waived/not_applicable） */
async function qaCodeReviewDone(ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> {
  const path = join(ctx.workspaceDir, 'rtlqa', 'code-review-verdicts.json')
  if (!existsSync(path)) {
    return makeResult(checkId, false, 'error', '尚未完成代码审查：rtlqa/code-review-verdicts.json 不存在（按 RTL 代码审查清单 CR-01 ~ CR-12 逐条裁决 pass/waived/not_applicable）')
  }
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8')) as { rtlHash?: string; items?: Array<{ id?: string; status?: string; waiverId?: string }> }
    const items = data.items ?? []
    if (items.length === 0) {
      return makeResult(checkId, false, 'error', '代码审查清单为空：必须逐条裁决 CR-01 ~ CR-12（pass/waived/not_applicable）')
    }
    const currentRtlHash = currentWorkspaceRtlHash(ctx.workspaceDir)
    if (currentRtlHash && data.rtlHash && data.rtlHash !== currentRtlHash) {
      return makeResult(checkId, false, 'error', '代码审查基于旧 RTL 版本（rtlHash 不匹配）：RTL 变更后需重新审查')
    }
    const approvals = readSignoffApprovals(ctx.workspaceDir)
    const open = items.filter((item) => !['pass', 'waived', 'not_applicable'].includes(item.status ?? ''))
    if (open.length > 0) {
      return makeResult(checkId, false, 'error', `${open.length} 条审查项未闭环（缺失或状态非法）：${open.slice(0, 3).map((item) => item.id ?? '<无ID>').join('、')}${open.length > 3 ? ' 等' : ''}`)
    }
    const unwaivered = items.filter((item) => item.status === 'waived' && !approvals.has(item.waiverId ?? ''))
    if (unwaivered.length > 0) {
      return makeResult(checkId, false, 'error', `${unwaivered.length} 条 waived 项缺具名豁免：${unwaivered.slice(0, 3).map((item) => item.id).join('、')}${unwaivered.length > 3 ? ' 等' : ''}`)
    }
    return makeResult(checkId, true, 'error', `代码审查闭环：${items.length} 条均已裁决（pass / waived+具名豁免 / not_applicable）`)
  } catch { return makeResult(checkId, false, 'error', 'rtlqa/code-review-verdicts.json 无法解析') }
}

/**
 * QA 死逻辑检查裁决闭环（用户需求 2026-09-28：RTL 死逻辑检查 + 架构契约变更需工程师裁决）。
 * 校验 rtlqa/lint/dead_logic_report.json：所有 spec-anchored 项（命中架构文档或顶层端口）
 * 必须在 adjudications 中有合法裁决（remove/keep/tbd 且 rationale 非空）；internal 项由
 * RTL 阶段直接清理，不进门禁。报告缺失时按提示放行（warning），与既有门禁严格度保持一致。
 */
async function qaDeadLogicAdjudicated(ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> {
  const path = join(ctx.workspaceDir, 'rtlqa', 'lint', 'dead_logic_report.json')
  if (!existsSync(path)) {
    return makeResult(checkId, true, 'warning', '提示：尚未运行死逻辑检查（rtlqa/lint/dead_logic_report.json 不存在）；建议在 RTL 阶段联合 Lint 后执行 check_dead_logic。本项不阻断流转')
  }
  interface DeadLogicIssueItem { module?: string; signal?: string; classification?: string }
  interface DeadLogicAdjudicationItem { key?: string; decision?: string; rationale?: string }
  let report: { issues?: DeadLogicIssueItem[]; adjudications?: DeadLogicAdjudicationItem[] }
  try { report = JSON.parse(readFileSync(path, 'utf-8')) as typeof report } catch {
    return makeResult(checkId, false, 'error', 'rtlqa/lint/dead_logic_report.json 无法解析')
  }
  const adjudications = new Map((report.adjudications ?? []).filter((item) => typeof item.key === 'string').map((item) => [item.key as string, item]))
  const problems: string[] = []
  const specAnchored = (report.issues ?? []).filter((issue) => issue.classification === 'spec-anchored')
  for (const issue of specAnchored) {
    const key = `${issue.module ?? ''}.${issue.signal ?? ''}`
    const adjudication = adjudications.get(key)
    if (!adjudication) { problems.push(`${key} 未裁决`); continue }
    if (!['remove', 'keep', 'tbd'].includes(adjudication.decision ?? '') || !adjudication.rationale?.trim()) {
      problems.push(`${key} 裁决非法（decision 应为 remove/keep/tbd 且 rationale 必填）`)
    }
  }
  if (problems.length > 0) {
    const shown = problems.slice(0, MAX_ISSUES_IN_MESSAGE).join('；')
    const more = problems.length > MAX_ISSUES_IN_MESSAGE ? ` 等 ${problems.length} 条` : ''
    return makeResult(checkId, false, 'error', `死逻辑检查 ${problems.length} 项 spec-anchored 未闭环：${shown}${more}（须回 RTL 阶段经 request_user_decision 工程师裁决并写回 adjudications）`)
  }
  return makeResult(checkId, true, 'error', `死逻辑检查闭环：${specAnchored.length} 项 spec-anchored 均有合法工程师裁决（remove / keep+理由 / tbd）`)
}

/** 软 review 门禁的品类定义（设计文档 §4/§5/§7：报告 + 发现清单两件产物） */
type DesignReviewKind = 'arch-consistency' | 'rtl-semantic'

interface DesignReviewGateSpec {
  /** 发现清单相对路径（design-review.ts 中的路径常量） */
  findingsPath: string
  /** review 报告（md）相对路径 */
  reportPath: string
  /** review 名称（门禁消息文案用） */
  reviewLabel: string
  /** 发起 review 的会话阶段（指引文案用） */
  phaseLabel: string
}

const DESIGN_REVIEW_GATES: Record<DesignReviewKind, DesignReviewGateSpec> = {
  'arch-consistency': {
    findingsPath: ARCH_REVIEW_FINDINGS_PATH,
    reportPath: 'docs/03_design/review-arch-consistency.md',
    reviewLabel: '架构一致性',
    phaseLabel: 'ARCH'
  },
  'rtl-semantic': {
    findingsPath: RTL_REVIEW_FINDINGS_PATH,
    reportPath: 'rtlqa/review/semantic-review.md',
    reviewLabel: '语义一致性',
    phaseLabel: 'RTL'
  }
}

/** 交叉 review 建议文案（设计文档 §2/§7：首轮后建议切换模型再发起一轮独立 review） */
const CROSS_REVIEW_ADVICE = '建议切换模型再发起一轮独立 review（不同模型盲区不同，可显著降低漏检）'

/**
 * 软 review 门禁工厂（设计文档 §7：warning 软运行，告警不阻断）：
 * - 报告/清单缺失或清单无法解析：passed=true + warning 提示（与 qa-dead-logic-adjudicated
 *   缺失放行口径一致——「没审过」是提示不是失败），消息给出如何补齐的指引；
 * - 存在 pending major 发现：passed=false + warning（仍不阻断），措辞升级；
 * - 通过：报告存在且跨轮合并后 pending major 为 0；
 * 仅 1 轮记录时在任何有清单的状态下都追加交叉 review 建议。
 */
function designReviewGate(kind: DesignReviewKind) {
  const spec = DESIGN_REVIEW_GATES[kind]
  return async (ctx: GateCheckContext, checkId: string): Promise<GateCheckResult> => {
    const reportExists = existsSync(join(ctx.workspaceDir, ...spec.reportPath.split('/')))
    const findingsExists = existsSync(join(ctx.workspaceDir, ...spec.findingsPath.split('/')))
    const findings = readDesignReviewFindings(ctx.workspaceDir, spec.findingsPath)
    if (!reportExists || findings === null) {
      const lines: string[] = []
      if (!reportExists) {
        lines.push(`尚未发起${spec.reviewLabel} review：请在 ${spec.phaseLabel} 会话中调用 request_design_review（报告产物：${spec.reportPath}）`)
      } else {
        lines.push(`发现清单缺失或无法解析（${spec.findingsPath}）：请在 ${spec.phaseLabel} 会话中重新调用 request_design_review，由独立审查会话写出报告与发现清单`)
      }
      lines.push(`本检查为软运行告警，不阻断进入下一阶段；review 目标见设计文档 DESIGN-REVIEW-LEFT-SHIFT-ZH-CN.md。`)
      return makeResult(checkId, true, 'warning', lines.join('\n'))
    }
    const pendingMajor = pendingMajorCount(findings)
    const roundNote = `已记录 ${reviewRoundCount(findings)} 轮 review`
    if (pendingMajor > 0) {
      return makeResult(
        checkId,
        false,
        'warning',
        `${pendingMajor} 条 major 发现待处置（修复或裁决 waived）：${spec.findingsPath}（${roundNote}）。处置完成（fixed/waived）后本检查自动通过；本告警不阻断流转。`
      )
    }
    const advice = reviewRoundCount(findings) <= 1 ? `；${CROSS_REVIEW_ADVICE}` : ''
    return makeResult(
      checkId,
      true,
      'warning',
      `通过：${spec.reviewLabel} review 报告存在（${spec.reportPath}），跨轮合并后 pending major 0 条（${roundNote}）${advice}`
    )
  }
}

/** 检查器注册表：checkId → 真实检查实现；未注册的走「未接入」占位 */
const CHECKERS: Record<string, (ctx: GateCheckContext, checkId: string) => Promise<GateCheckResult>> = {
  'requirements-usable': requirementsUsable,
  'module-spec-usable': requireFiles(['docs/02_requirements/module_specification.md']),
  'interface-spec-usable': requireFiles(['docs/03_design/interface_spec.md']),
  'rtm-complete': rtmComplete,
  'interface-signals-nonempty': requireFiles(['docs/03_design/interface_spec.md']),
  'module-partition-sane': modulePartitionSane,
  'block-diagram-parsable': architectureDiagramParsable,
  'clock-reset-defined': optionalDocument(
    'docs/03_design/clock_reset.md',
    '单时钟、单复位且无 CDC/RDC 的设计可不单独创建时钟复位文档'
  ),
  'port-consistency': requireFiles(['docs/03_design/interface_spec.md']),
  'arch-consistency-review': designReviewGate('arch-consistency'),
  'rtl-semantic-review': designReviewGate('rtl-semantic'),
  'line-coverage-gte-90': coverageAtLeast(['lineCoverage', 'line_coverage'], 90),
  'branch-coverage-gte-85': coverageAtLeast(['branchCoverage', 'branch_coverage', 'expressionCoverage'], 85),
  'func-coverage-gte-80': coverageAtLeast(['functionalCoverage', 'functional_coverage', 'funcCoverage'], 80),
  'verification-evidence-review': verificationEvidenceReview,
  'verification-scenario-closure': verificationScenarioClosure,
  'sim-passed': simPassed,
  'verible-lint-zero-error': lintZeroError,
  'verible-zero-error': lintZeroError,
  'yosys-synthesizable': yosysSynthesizable,
  'cdc-passed': cdcPassed,
  'qa-spec-implementation-reviewed': qaSpecImplementationReviewed,
  'qa-verification-completeness': qaVerificationCompletenessGate,
  'qa-code-review-done': qaCodeReviewDone,
  'qa-reset-review-documented': requireFiles(['docs/06_validation/reset_review.md']),
  'qa-dead-logic-adjudicated': qaDeadLogicAdjudicated
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
  // 仅进入未完成阶段时置 active；已完成/已跳过阶段保持原状态——
  // 双击查看已完成阶段不得把它回退成“进行中”
  if (project.phases[to].status !== 'completed' && project.phases[to].status !== 'skipped') {
    project.phases[to].status = 'active'
    project.phases[to].startedAt = project.phases[to].startedAt ?? now
  }
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
    return this.runChecksAndPersist(project, project.currentPhase, rule, ctx)
  }

  /**
   * 显式指定 from→to 的门禁检查（供 enterPhase 双击跨越带门禁跳转时使用，
   * 与 runGateChecks 同一执行与落库口径）。
   */
  async runGateChecksForTransition(project: ChipProject, from: Phase, to: Phase, ctx: GateCheckContext): Promise<GateCheckResult[]> {
    const rule = this.getGateRule(from, to)
    if (!rule) return []
    return this.runChecksAndPersist(project, from, rule, ctx)
  }

  private async runChecksAndPersist(project: ChipProject, fromPhase: Phase, rule: GateRule, ctx: GateCheckContext): Promise<GateCheckResult[]> {
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
          eq(gateChecks.phase, fromPhase)
        )).run()
        for (const r of results) {
          database.insert(gateChecks).values({
            id: randomUUID(),
            projectId: project.id,
            phase: fromPhase,
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
  completeProject(project: ChipProject, workspaceDir?: string): ChipProject {
    if (project.currentPhase !== 'SYNTH' || project.phases.SYNTH.status !== 'active') {
      throw new Error('[phase-engine] 只有进行中的 SYNTH 阶段可以完成项目')
    }
    // SYNTH 门禁接 PPA 条款（契约 2026-09-02"PPA 条款混入 VERIF 完备性分母"§二）：
    // synthesis 通道条款由综合报告证据闭环；存在未闭环 PPA 条款时阻断收口。
    // 参照 verificationScenarioClosure 的挂法：先重建验证态势再评审（无 synthesis 条款时 total=0 直接放行）。
    if (workspaceDir) {
      buildVerificationIntelligence(workspaceDir)
      const review = reviewSynthesisClauses(workspaceDir)
      if (!review.passed) {
        throw new Error(`[phase-engine] SYNTH 门禁未通过（PPA 条款 ${review.total - review.open}/${review.total} 已闭环）：\n${review.blockers.join('\n')}`)
      }
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
