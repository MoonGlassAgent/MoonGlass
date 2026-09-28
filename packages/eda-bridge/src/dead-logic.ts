/**
 * RTL 无驱动/无负载（死逻辑）检查（用户需求 2026-09-28：RTL 阶段死代码检查 +
 * 涉及架构设计文档契约的处置必须经工程师裁决，禁止 Agent 自行删除）。
 *
 * 引擎：slang elaborated AST（--ast-json --ast-json-source-info）。elaboration 后
 * generate 未选中分支天然不在 AST 中，参数化死分支不会产生误报。
 * 调用模式与 packages/verification-intelligence-engine/src/structural-analyzer.ts 一致：
 * AST 落到系统临时目录、解析消费后删除；slang 缺失时明确报「工具缺失」，不静默空结果。
 *
 * 本文件会被复制到 pi-bridge 目录供 moonglass-tools.ts 相对导入，
 * 必须仅依赖 Node 内置模块与本包内模块（tool-runner）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { locateTool, run, toolEnv } from './tool-runner'

export type DeadLogicKind = 'undriven' | 'unused' | 'dead'
export type DeadLogicClassification = 'spec-anchored' | 'internal'

export interface DeadLogicIssue {
  /** 所属模块（elaborated 定义名） */
  module: string
  signal: string
  /** undriven=有负载无驱动；unused=有驱动无负载；dead=两者兼有 */
  kind: DeadLogicKind
  /** spec-anchored=命中规格文档或属顶层端口，处置必须经工程师裁决；internal=可直接清理 */
  classification: DeadLogicClassification
  /** 是否顶层模块端口（对外可见，不是天然死代码，单独标注） */
  topLevelPort: boolean
  /** 命中的规格文档（相对 workspace）；未命中为 undefined */
  specAnchor?: string
  /** 声明位置（相对 workspace） */
  file: string
  line: number
  suggestion: string
}

/** 工程师对 spec-anchored 项的裁决记录（由 Agent 经 request_user_decision 裁决后写回报告） */
export interface DeadLogicAdjudication {
  /** 与问题项对应：${module}.${signal} */
  key: string
  decision: 'remove' | 'keep' | 'tbd'
  rationale: string
  decidedBy?: string
  decidedAt?: string
}

export interface DeadLogicReport {
  version: 1
  generatedAt: string
  tool: { name: 'slang'; version: string }
  stats: {
    modules: number
    signals: number
    undriven: number
    unused: number
    dead: number
    specAnchored: number
    internal: number
  }
  issues: DeadLogicIssue[]
  adjudications: DeadLogicAdjudication[]
}

export interface DeadLogicOptions {
  /** 芯片项目工作目录（rtl/、docs/03_design/ 所在） */
  workspace: string
  /** 设计 RTL 绝对路径列表（readRtlInputs(workspace).designFiles 口径） */
  files: string[]
  libraryFiles?: string[]
  includeDirs?: string[]
  defines?: string[]
  topModule?: string
}

/** slang 可执行文件定位：MOONGLASS_SLANG_PATH 显式覆盖优先，其次 PATH / oss-cad-suite 惯例目录 */
async function locateSlang(): Promise<string | null> {
  const override = process.env.MOONGLASS_SLANG_PATH?.trim()
  if (override) {
    if (existsSync(override)) return override
    throw new Error(`工具缺失：MOONGLASS_SLANG_PATH 指向的 slang 不存在 — ${override}`)
  }
  return locateTool(['slang'])
}

/** slang AST JSON 节点的最小结构（只声明消费到的字段） */
interface AstNode {
  kind?: string
  name?: string
  direction?: string
  symbol?: unknown
  internalSymbol?: unknown
  members?: unknown
  body?: unknown
  connections?: unknown
  left?: unknown
  right?: unknown
  initializer?: unknown
  source_file?: string
  source_line?: number
  [key: string]: unknown
}

/** symbol/internalSymbol 形如 "2127368374528 i_clk"，去掉地址前缀取信号名 */
function symbolName(value: unknown): string {
  return typeof value === 'string' ? value.replace(/^\d+\s+/, '').trim() : ''
}

interface SignalInfo {
  name: string
  file: string
  line: number
  isPort: boolean
  portDirection?: string
}

interface ModuleScope {
  name: string
  isTop: boolean
  signals: Map<string, SignalInfo>
  driven: Set<string>
  loaded: Set<string>
}

/** 收集表达式子树内全部 NamedValue 引用名（用于赋值右值 / 连接表达式的负载统计） */
function referencedNames(value: unknown, out: Set<string>): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) referencedNames(item, out)
    return
  }
  const node = value as AstNode
  if (node.kind === 'NamedValue') {
    const name = symbolName(node.symbol)
    if (name) out.add(name)
    return
  }
  for (const child of Object.values(node)) referencedNames(child, out)
}

/**
 * 在当前模块作用域内遍历 AST 子树，累计驱动/负载。
 * - Assignment：left 侧全部引用计为驱动，right 侧计为负载（实例输出端口连接的 expr 也是 Assignment，同一规则覆盖）。
 * - 其余位置的 NamedValue（条件、敏感表、实例输入端口连接等）计为负载。
 * - 嵌套 Instance 的 body 属子模块作用域，此处只消费其 connections，body 由 analyzeBody 递归处理。
 * - Definition 为未例化的原始定义，跳过以避免重复计数。
 */
function walkScope(value: unknown, scope: ModuleScope, scopes: ModuleScope[], topNames: Set<string>): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) walkScope(item, scope, scopes, topNames)
    return
  }
  const node = value as AstNode
  const kind = String(node.kind ?? '')
  if (kind === 'Definition') return
  if (kind === 'Instance') {
    // 端口连接在当前作用域消费；实体本身作为子模块作用域递归
    walkScope(node.connections, scope, scopes, topNames)
    if (node.body && typeof node.body === 'object') analyzeBody(node.body as AstNode, scopes, topNames)
    return
  }
  if (kind === 'Assignment') {
    const sinks = new Set<string>()
    referencedNames(node.left, sinks)
    for (const name of sinks) scope.driven.add(name)
    referencedNames(node.right, scope.loaded)
    return
  }
  if (kind === 'NamedValue') {
    const name = symbolName(node.symbol)
    if (name) scope.loaded.add(name)
    return
  }
  if ((kind === 'Net' || kind === 'Variable') && node.initializer) {
    // 声明即初始化视为一次驱动
    if (node.name) scope.driven.add(node.name)
    referencedNames(node.initializer, scope.loaded)
    return
  }
  for (const key of Object.keys(node)) {
    // body 跳过仅适用于 Instance（已在上方处理）；ProceduralBlock 等节点的语句体字段也叫 body，必须遍历
    if (key === 'body' && kind === 'Instance') continue
    walkScope(node[key], scope, scopes, topNames)
  }
}

/** 分析一个 elaborated InstanceBody：登记信号（Net/Variable）与端口方向，遍历成员累计驱动/负载 */
function analyzeBody(body: AstNode, scopes: ModuleScope[], topNames: Set<string>): void {
  const moduleName = String(body.name ?? '$unknown')
  const scope: ModuleScope = { name: moduleName, isTop: topNames.has(moduleName), signals: new Map(), driven: new Set(), loaded: new Set() }
  scopes.push(scope)
  const members = Array.isArray(body.members) ? body.members : []
  // 第一遍：登记端口方向（Port.internalSymbol 指向模块内同名 Net/Variable）
  const portByInternal = new Map<string, { name: string; direction: string }>()
  for (const member of members) {
    const node = member as AstNode
    if (node?.kind !== 'Port') continue
    const internal = symbolName(node.internalSymbol) || String(node.name ?? '')
    portByInternal.set(internal, { name: String(node.name ?? internal), direction: String(node.direction ?? '') })
  }
  // 第二遍：登记信号并施加端口方向语义（In 自外部驱动本模块；Out 对外可见即负载）
  for (const member of members) {
    const node = member as AstNode
    if (!node || (node.kind !== 'Net' && node.kind !== 'Variable')) continue
    const name = String(node.name ?? '')
    if (!name || scope.signals.has(name)) continue
    const port = portByInternal.get(name)
    scope.signals.set(name, {
      name,
      file: String(node.source_file ?? ''),
      line: Number(node.source_line ?? 1),
      isPort: Boolean(port),
      portDirection: port?.direction
    })
    if (port) {
      if (port.direction === 'In' || port.direction === 'InOut') scope.driven.add(name)
      if (port.direction === 'Out' || port.direction === 'InOut') scope.loaded.add(name)
    }
  }
  // 第三遍：遍历成员累计驱动/负载
  for (const member of members) walkScope(member, scope, scopes, topNames)
}

/** 规格锚定文档（架构契约：接口/寄存器/架构/微架构），命中即需工程师裁决 */
const SPEC_ANCHOR_DOCS = ['interface_spec.md', 'register_map.md', 'architecture.md', 'microarchitecture.md'] as const

function specAnchorFor(workspace: string, signal: string): string | undefined {
  const dir = join(workspace, 'docs', '03_design')
  const pattern = new RegExp(`(?<![A-Za-z0-9_$])${signal.replace(/[$]/g, '\\$&')}(?![A-Za-z0-9_$])`)
  for (const doc of SPEC_ANCHOR_DOCS) {
    const path = join(dir, doc)
    if (!existsSync(path)) continue
    try {
      if (pattern.test(readFileSync(path, 'utf-8'))) return `docs/03_design/${doc}`
    } catch { /* 读取失败按未命中处理 */ }
  }
  return undefined
}

function suggestionFor(issue: Pick<DeadLogicIssue, 'kind' | 'classification'>): string {
  const base = issue.kind === 'undriven'
    ? '信号被读取但无任何驱动（恒为未定态），确认是否漏接；若无用途请连同负载一并删除'
    : issue.kind === 'unused'
      ? '信号有驱动但无任何负载，属死代码，建议连同其驱动逻辑一并删除'
      : '信号既无驱动也无负载，属死代码，建议直接删除声明'
  return issue.classification === 'spec-anchored'
    ? `${base}；但该项命中架构契约（规格文档或顶层端口），处置须经工程师裁决（request_user_decision：删除 / 保留并说明理由 / 标注 TBD），禁止 Agent 自行删除`
    : base
}

/**
 * 死逻辑分析主入口。slang 缺失或 elaboration 失败均显式抛错（不静默返回空结果）。
 * 同一模块多实例合并口径：驱动/负载取并集（任一实例中被驱动/读取即不算死），
 * 避免参数化实例差异造成误报。
 */
export async function analyzeDeadLogic(options: DeadLogicOptions): Promise<DeadLogicReport> {
  const slang = await locateSlang()
  if (!slang) {
    throw new Error('工具缺失：未找到 slang（AIGV 工具链内置的 SystemVerilog 编译器）；请安装 oss-cad-suite 或设置 MOONGLASS_SLANG_PATH 指向 slang 可执行文件')
  }
  if (options.files.length === 0) throw new Error('死逻辑检查至少需要一个设计 RTL 文件')

  const astDir = join(tmpdir(), 'moonglass-slang-ast')
  mkdirSync(astDir, { recursive: true })
  const astPath = join(astDir, `dead-logic-ast-${process.pid}-${Date.now()}.json`)
  const args = ['--ast-json', astPath, '--ast-json-source-info', '--ignore-unknown-modules']
  for (const dir of options.includeDirs ?? []) args.push('-I', dir)
  for (const define of options.defines ?? []) args.push('-D', define)
  for (const library of options.libraryFiles ?? []) args.push('-v', library)
  if (options.topModule) args.push('--top', options.topModule)
  args.push(...options.files)

  const env = toolEnv(slang)
  const result = await run(slang, args, env, undefined, options.workspace, 300_000)
  if (result.code !== 0 || !existsSync(astPath)) {
    // 失败回退：保留诊断日志到 rtlqa/lint/，与 structural-analyzer 的 slang-diagnostics.log 惯例一致
    const logDir = join(options.workspace, 'rtlqa', 'lint')
    mkdirSync(logDir, { recursive: true })
    writeFileSync(join(logDir, 'dead_logic_slang.log'), `${result.stdout}\n${result.stderr}`, 'utf-8')
    throw new Error(`slang elaboration 失败（exit=${result.code ?? 'null'}），诊断已写入 rtlqa/lint/dead_logic_slang.log`)
  }
  const versionResult = await run(slang, ['--version'], env)
  const version = versionResult.stdout.trim() || 'unknown'

  let ast: AstNode
  try {
    if (statSync(astPath).size > 128 * 1024 * 1024) {
      throw new Error(`slang AST 超过 128MB 消费上限（${astPath} 已保留供调试）`)
    }
    ast = JSON.parse(readFileSync(astPath, 'utf-8')) as AstNode
  } catch (err) {
    if (err instanceof Error && err.message.includes('消费上限')) throw err
    throw new Error(`slang AST 解析失败：${err instanceof Error ? err.message : String(err)}（${astPath} 已保留供调试）`)
  }

  const scopes: ModuleScope[] = []
  const topNames = new Set<string>()
  try {
    // --ast-json 顶层结构：{ design: Root, definitions: [...] }；Root.members 下 Instance 即顶层实例
    // （未指定 --top 时 slang elaborate 全部顶层）；definitions 为未例化原始定义，不消费。
    const design = (ast.design ?? {}) as AstNode
    const rootMembers = Array.isArray(design.members) ? design.members : []
    for (const member of rootMembers) {
      const node = member as AstNode
      // Root 下的 Instance 即顶层实例（未指定 --top 时 slang elaborate 全部顶层）
      if (node?.kind === 'Instance' && node.body && typeof node.body === 'object') {
        topNames.add(String((node.body as AstNode).name ?? ''))
      }
    }
    for (const member of rootMembers) {
      const node = member as AstNode
      if (node?.kind === 'Instance' && node.body && typeof node.body === 'object') {
        analyzeBody(node.body as AstNode, scopes, topNames)
      }
    }
  } finally {
    rmSync(astPath, { force: true })
  }

  // 多实例合并：同名模块的信号驱动/负载取并集
  interface Merged extends SignalInfo { module: string; isTop: boolean; driven: boolean; loaded: boolean }
  const merged = new Map<string, Merged>()
  for (const scope of scopes) {
    for (const signal of scope.signals.values()) {
      const key = `${scope.name}.${signal.name}`
      const driven = scope.driven.has(signal.name)
      const loaded = scope.loaded.has(signal.name)
      const existing = merged.get(key)
      if (existing) {
        existing.driven = existing.driven || driven
        existing.loaded = existing.loaded || loaded
        existing.isTop = existing.isTop || scope.isTop
      } else {
        merged.set(key, { ...signal, module: scope.name, isTop: scope.isTop, driven, loaded })
      }
    }
  }

  const issues: DeadLogicIssue[] = []
  for (const signal of merged.values()) {
    const kind: DeadLogicKind | null = !signal.driven && signal.loaded ? 'undriven'
      : signal.driven && !signal.loaded ? 'unused'
        : !signal.driven && !signal.loaded ? 'dead'
          : null
    if (!kind) continue
    const anchor = specAnchorFor(options.workspace, signal.name)
    const topLevelPort = signal.isTop && signal.isPort
    const classification: DeadLogicClassification = topLevelPort || anchor ? 'spec-anchored' : 'internal'
    // slang 以 cwd 运行时 source_file 可能是相对 workspace 的路径，统一按 workspace 解析后再相对化
    const file = signal.file ? relative(options.workspace, resolve(options.workspace, signal.file)) : ''
    issues.push({
      module: signal.module,
      signal: signal.name,
      kind,
      classification,
      topLevelPort,
      specAnchor: anchor,
      file,
      line: signal.line,
      suggestion: ''
    })
  }
  for (const issue of issues) issue.suggestion = suggestionFor(issue)
  issues.sort((a, b) => a.classification === b.classification
    ? `${a.module}.${a.signal}`.localeCompare(`${b.module}.${b.signal}`)
    : a.classification === 'spec-anchored' ? -1 : 1)

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    tool: { name: 'slang', version },
    stats: {
      modules: new Set(scopes.map((scope) => scope.name)).size,
      signals: merged.size,
      undriven: issues.filter((issue) => issue.kind === 'undriven').length,
      unused: issues.filter((issue) => issue.kind === 'unused').length,
      dead: issues.filter((issue) => issue.kind === 'dead').length,
      specAnchored: issues.filter((issue) => issue.classification === 'spec-anchored').length,
      internal: issues.filter((issue) => issue.classification === 'internal').length
    },
    issues,
    adjudications: []
  }
}

/** 死逻辑报告路径（QA 门禁与工具共用此口径） */
export function deadLogicReportPath(workspace: string): string {
  return join(workspace, 'rtlqa', 'lint', 'dead_logic_report.json')
}

/**
 * 写出 rtlqa/lint/dead_logic_report.json + dead_logic_report.md。
 * 复跑时从旧报告继承仍命中问题项的工程师裁决（按 module.signal 键），避免重复裁决。
 */
export function writeDeadLogicReport(workspace: string, report: DeadLogicReport): { jsonPath: string; mdPath: string } {
  const jsonPath = deadLogicReportPath(workspace)
  const mdPath = join(workspace, 'rtlqa', 'lint', 'dead_logic_report.md')
  const currentKeys = new Set(report.issues.map((issue) => `${issue.module}.${issue.signal}`))
  try {
    if (existsSync(jsonPath)) {
      const previous = JSON.parse(readFileSync(jsonPath, 'utf-8')) as { adjudications?: DeadLogicAdjudication[] }
      const seen = new Set<string>()
      for (const item of previous.adjudications ?? []) {
        if (item?.key && currentKeys.has(item.key) && !seen.has(item.key)) {
          seen.add(item.key)
          report.adjudications.push(item)
        }
      }
    }
  } catch { /* 旧报告缺失或损坏时从空裁决开始 */ }

  mkdirSync(join(workspace, 'rtlqa', 'lint'), { recursive: true })
  const temporary = `${jsonPath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, JSON.stringify(report, null, 2), 'utf-8')
  renameSync(temporary, jsonPath)

  const lines: string[] = [
    '# RTL 死逻辑（无驱动/无负载）检查报告',
    '',
    `- 生成时间：${report.generatedAt}`,
    `- 引擎：slang ${report.tool.version}（elaborated AST，generate 未选中分支天然排除）`,
    `- 模块 ${report.stats.modules} 个，信号 ${report.stats.signals} 个`,
    `- 问题 ${report.issues.length} 项：undriven ${report.stats.undriven} / unused ${report.stats.unused} / dead ${report.stats.dead}`,
    `- 分类：spec-anchored（需工程师裁决）${report.stats.specAnchored} 项，internal（可直接清理）${report.stats.internal} 项`,
    ''
  ]
  const adjudicationByKey = new Map(report.adjudications.map((item) => [item.key, item]))
  if (report.issues.length > 0) {
    lines.push('| 位置 | 模块.信号 | 类型 | 分类 | 裁决 | 建议动作 |', '| --- | --- | --- | --- | --- | --- |')
    for (const issue of report.issues) {
      const key = `${issue.module}.${issue.signal}`
      const adjudication = adjudicationByKey.get(key)
      const verdict = issue.classification === 'internal'
        ? '无需裁决'
        : adjudication ? `${adjudication.decision}（${adjudication.rationale}）` : '**未裁决**'
      const anchor = issue.topLevelPort ? '顶层端口' : issue.specAnchor ?? '-'
      lines.push(`| ${issue.file}:${issue.line} | ${key} | ${issue.kind} | ${issue.classification}（${anchor}） | ${verdict} | ${issue.suggestion} |`)
    }
  } else {
    lines.push('未发现无驱动/无负载信号。')
  }
  lines.push('')
  writeFileSync(mdPath, lines.join('\n'), 'utf-8')
  return { jsonPath, mdPath }
}
