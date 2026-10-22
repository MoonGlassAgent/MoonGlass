/**
 * Design Database v3 构建器：slang elaborated AST → DesignDatabase（version: 3）。
 *
 * 纯函数构建（副作用仅限读取工作区 RTL 源文件用于表达式源码文本回读）：
 * slang 调用与 AST 缓存在上游完成（eda-bridge/slang-runner），本模块只消费 AST。
 *
 * 口径（规格 §4/§5）：
 * - 信号 = InstanceBody.members 的 Net/Variable（端口 internalSymbol 去重后标记 isPort）；
 * - 过程块/assign 的 drives/reads 由 Assignment.left / 表达式 NamedValue 推导，位选取基名；
 * - trace 为语句级：drivers = 写 S 的 statement + input/inout 端口 + 输出 pin 连接；
 *   loads = 读 S 的 statement + output/inout 端口 + 输入 pin 连接；
 * - 参数实际取值取 elaborated 子实例体 Parameter.initializer 源文本（参数特化逐实例展开）。
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { normalizeSlangSource } from '@moonglass/eda-bridge/slang-runner'
import type {
  DesignDatabaseV3,
  DesignDiagnostic,
  DesignEndpoint,
  DesignInstance,
  DesignInstanceConnection,
  DesignInstanceRef,
  DesignModule,
  DesignParameter,
  DesignPort,
  DesignProcess,
  DesignSignal,
  DesignSignalTrace
} from './types'

interface AstNode {
  kind?: string
  name?: string
  addr?: number | string
  [key: string]: unknown
}

function asNode(value: unknown): AstNode | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as AstNode) : null
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** symbol/internalSymbol 形如 "2127368374528 i_clk"，去掉地址前缀取符号名 */
function symbolName(value: unknown): string {
  return str(value).replace(/^\d+\s+/, '').trim()
}

/** 从 slang type 字符串解析位宽：`logic[11:0]` → 12；无区间 → 1（保守口径） */
export function widthOfType(type: string | undefined): number {
  if (!type) return 1
  const match = /\[(-?\d+)\s*:\s*(-?\d+)\]/.exec(type)
  if (!match) return 1
  return Math.abs(num(Number(match[1])) - num(Number(match[2]))) + 1
}

function mapDirection(direction: string): 'input' | 'output' | 'inout' | 'unknown' {
  return direction === 'In' ? 'input' : direction === 'Out' ? 'output' : direction === 'InOut' ? 'inout' : 'unknown'
}

function mapSignalKind(node: AstNode): DesignSignal['kind'] {
  if (node.kind === 'Net') {
    const netType = str(asNode(node.netType)?.name)
    if (netType === 'wire') return 'wire'
    return netType ? 'other' : str(node.type).startsWith('logic') ? 'logic' : 'other'
  }
  const type = str(node.type)
  if (type.startsWith('reg')) return 'reg'
  if (type.startsWith('logic')) return 'logic'
  return 'other'
}

const PROCESS_KIND: Record<string, DesignProcess['kind']> = {
  AlwaysFF: 'always_ff',
  AlwaysComb: 'always_comb',
  AlwaysLatch: 'always_latch',
  Always: 'always',
  Initial: 'initial',
  Final: 'final'
}

export interface BuildV3Options {
  /** slang AST JSON（runSlangAst 产出物） */
  ast: Record<string, unknown>
  /** 芯片项目工作区（AST source_file 归一化与源文件回读的根） */
  workspace: string
  /** 参与本次 elaboration 的 RTL 文件（sourceFiles 兜底） */
  rtlFiles: string[]
  topModule: string
}

interface ModuleAccumulator {
  name: string
  source?: string
  parameters: Map<string, DesignParameter>
  ports: Map<string, DesignPort>
  signals: Map<string, DesignSignal>
  /** key = kind@file:line（参数化多实例体按源码位置去重） */
  processes: Map<string, DesignProcess>
  instances: Map<string, DesignInstanceRef>
  /** 连接 pin → 表达式引用信号名（trace 匹配用，不序列化） */
  connectionRefs: Map<string, Map<string, string[]>>
  unmappedKinds: Map<string, number>
}

class V3Builder {
  private readonly fileTexts = new Map<string, string | null>()
  private readonly modules = new Map<string, ModuleAccumulator>()
  private readonly visitedBodies = new Set<string>()
  private readonly seenSourceFiles = new Set<string>()
  private readonly diagnostics: DesignDiagnostic[] = []
  private readonly ast: Record<string, unknown>
  private readonly workspace: string
  private readonly rtlFiles: string[]
  private readonly topModule: string

  constructor(ast: Record<string, unknown>, workspace: string, rtlFiles: string[], topModule: string) {
    this.ast = ast
    this.workspace = workspace
    this.rtlFiles = rtlFiles
    this.topModule = topModule
  }

  build(): DesignDatabaseV3 {
    const top = this.findTopInstance()
    const hierarchy = this.buildInstanceTree(top, this.topModule, new Set())
    const modules: DesignModule[] = [...this.modules.values()].map((accumulator) => this.finalizeModule(accumulator))
    const moduleNames = new Set(modules.map((module) => module.name))
    if (!moduleNames.has(this.topModule)) {
      throw new Error(`顶层模块在 AST 中无 elaborated 实例: ${this.topModule}`)
    }
    const sourceFiles = this.seenSourceFiles.size
      ? [...this.seenSourceFiles]
      : this.rtlFiles.map((file) => normalizeSlangSource(file, this.workspace)).filter(Boolean)
    return {
      version: 3,
      frontend: 'slang',
      topModule: this.topModule,
      generatedAt: new Date().toISOString(),
      sourceFiles,
      modules,
      hierarchy,
      diagnostics: this.diagnostics
    }
  }

  // ---- 顶层实例定位：design 子树内、InstanceBody 之外的 Instance ----

  private findTopInstance(): AstNode {
    const candidates: AstNode[] = []
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) walk(item)
        return
      }
      const node = asNode(value)
      if (!node) return
      if (node.kind === 'Instance') {
        candidates.push(node)
        return
      }
      if (node.kind === 'InstanceBody') return
      for (const child of Object.values(node)) walk(child)
    }
    walk(this.ast.design)
    const matched = candidates.filter((candidate) => str(asNode(candidate.body)?.name) === this.topModule)
    const top = matched[0] ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (!top) {
      throw new Error(
        `顶层模块不存在: ${this.topModule}（AST 顶层实例: ${candidates.map((candidate) => str(asNode(candidate.body)?.name)).join(', ') || '无'}）`
      )
    }
    return top
  }

  // ---- 实例树 ----

  private sourceRef(file: unknown, line: unknown): string | undefined {
    const normalized = normalizeSlangSource(str(file), this.workspace)
    if (!normalized) return undefined
    this.seenSourceFiles.add(normalized)
    const lineNumber = num(line)
    return lineNumber > 0 ? `${normalized}:${lineNumber}` : normalized
  }

  private buildInstanceTree(instance: AstNode, path: string, ancestors: Set<string>): DesignInstance {
    const body = asNode(instance.body)
    const moduleName = str(body?.name)
    const node: DesignInstance = {
      path,
      name: str(instance.name) || path,
      module: moduleName,
      source: this.sourceRef(instance.source_file, instance.source_line),
      definitionSource: this.sourceRef(body?.source_file, body?.source_line),
      parameterOverrides: body ? this.parameterOverridesOf(body) : {},
      children: []
    }
    if (!body) {
      this.diagnostics.push({ severity: 'warning', message: `实例 ${path} 缺少 elaborated 实例体（未解析模块？），层次在此截断` })
      return node
    }
    // addr 区分参数化特化的多个实例体（同名模块不同特化各自展开，模块级数据首见者胜出）
    const addr = body.addr !== undefined ? String(body.addr) : `${moduleName}@${node.definitionSource ?? ''}`
    if (this.visitedBodies.has(addr) || ancestors.has(moduleName)) return node
    this.visitedBodies.add(addr)
    this.accumulateModule(moduleName, body)
    const nextAncestors = new Set(ancestors).add(moduleName)
    for (const member of Array.isArray(body.members) ? (body.members as unknown[]) : []) {
      const child = asNode(member)
      if (child?.kind !== 'Instance') continue
      const childNode = this.buildInstanceTree(child, `${path}.${str(child.name)}`, nextAncestors)
      childNode.parentPath = path
      node.children.push(childNode)
    }
    return node
  }

  private parameterOverridesOf(body: AstNode): Record<string, string> {
    const overrides: Record<string, string> = {}
    for (const member of Array.isArray(body.members) ? (body.members as unknown[]) : []) {
      const node = asNode(member)
      if (node?.kind !== 'Parameter') continue
      const name = str(node.name)
      if (!name) continue
      overrides[name] = this.initializerText(node) ?? ''
    }
    return overrides
  }

  /** Parameter.initializer 源文本；无源码区间时回退常量字面量 */
  private initializerText(node: AstNode): string | undefined {
    const initializer = asNode(node.initializer)
    if (!initializer) return undefined
    return (this.sourceTextOf(initializer) ?? str(initializer.constant)) || str(initializer.value) || undefined
  }

  // ---- 模块聚合 ----

  private accumulatorOf(name: string): ModuleAccumulator {
    let accumulator = this.modules.get(name)
    if (!accumulator) {
      accumulator = {
        name,
        parameters: new Map(),
        ports: new Map(),
        signals: new Map(),
        processes: new Map(),
        instances: new Map(),
        connectionRefs: new Map(),
        unmappedKinds: new Map()
      }
      this.modules.set(name, accumulator)
    }
    return accumulator
  }

  private accumulateModule(name: string, body: AstNode): void {
    const accumulator = this.accumulatorOf(name)
    if (!accumulator.source) accumulator.source = this.sourceRef(body.source_file, body.source_line)
    const members = Array.isArray(body.members) ? (body.members as unknown[]) : []
    const portInternalNames = new Set<string>()
    for (const member of members) {
      const node = asNode(member)
      if (node?.kind !== 'Port') continue
      const internal = symbolName(node.internalSymbol) || str(node.name)
      if (internal) portInternalNames.add(internal)
      const portName = str(node.name) || internal
      if (!portName || accumulator.ports.has(portName)) continue
      const type = str(node.type)
      const direction = mapDirection(str(node.direction))
      accumulator.ports.set(portName, {
        name: portName,
        // Port 节点必有方向；极端缺失时按 input 兜底（DesignPort 无 unknown 形态）
        direction: direction === 'unknown' ? 'input' : direction,
        width: widthOfType(type),
        type,
        source: this.sourceRef(node.source_file, node.source_line)
      })
    }
    for (const member of members) {
      const node = asNode(member)
      if (!node) continue
      switch (node.kind) {
        case 'Port':
          break
        case 'Net':
        case 'Variable': {
          const signalName = str(node.name)
          if (!signalName || accumulator.signals.has(signalName)) break
          const type = str(node.type)
          accumulator.signals.set(signalName, {
            name: signalName,
            kind: mapSignalKind(node),
            width: widthOfType(type),
            type,
            source: this.sourceRef(node.source_file, node.source_line),
            isPort: portInternalNames.has(signalName)
          })
          break
        }
        case 'Parameter': {
          const paramName = str(node.name)
          if (!paramName || accumulator.parameters.has(paramName)) break
          accumulator.parameters.set(paramName, {
            name: paramName,
            type: str(node.type),
            valueText: this.initializerText(node) ?? '',
            source: this.sourceRef(node.source_file, node.source_line)
          })
          break
        }
        case 'ProceduralBlock':
          this.accumulateProcess(accumulator, node)
          break
        case 'ContinuousAssign':
          this.accumulateAssign(accumulator, node)
          break
        case 'Instance':
          this.accumulateInstance(accumulator, node)
          break
        default:
          accumulator.unmappedKinds.set(str(node.kind) || 'unknown', (accumulator.unmappedKinds.get(str(node.kind) || 'unknown') ?? 0) + 1)
      }
    }
    // 端口在信号表中的 direction 标注（signals.isPort 直接给答案）
    for (const port of accumulator.ports.values()) {
      const signal = accumulator.signals.get(port.name)
      if (signal) signal.direction = port.direction
      else {
        accumulator.signals.set(port.name, {
          name: port.name,
          kind: 'other',
          width: port.width,
          type: port.type ?? '',
          source: port.source,
          isPort: true,
          direction: port.direction
        })
      }
    }
    for (const [kind, count] of accumulator.unmappedKinds) {
      this.diagnostics.push({ severity: 'info', message: `模块 ${name} 存在未映射的 AST 成员 ${kind}（${count} 个），已跳过` })
    }
  }

  // ---- 过程块 / assign 的 drives / reads 推导 ----

  /** 收集表达式子树内全部 NamedValue 符号名 */
  private namedValuesIn(value: unknown, out: Set<string>): void {
    const node = asNode(value)
    if (!node) {
      if (Array.isArray(value)) for (const item of value) this.namedValuesIn(item, out)
      return
    }
    if (node.kind === 'NamedValue') {
      const name = symbolName(node.symbol)
      if (name) out.add(name)
      return
    }
    for (const child of Object.values(node)) this.namedValuesIn(child, out)
  }

  /**
   * 写入目标提取：位选/索引选取基名（.value 链到底），索引表达式计入读取；
   * 其余形态（纯 NamedValue / 拼接左值）全量计为写入。
   */
  private collectWrites(left: unknown, drives: Set<string>, reads: Set<string>): void {
    let current = asNode(left)
    while (current && (current.kind === 'RangeSelect' || current.kind === 'ElementSelect')) {
      for (const key of ['left', 'right']) this.namedValuesIn(current[key], reads)
      current = asNode(current.value)
    }
    if (current) this.namedValuesIn(current, drives)
  }

  private collectReads(value: unknown, reads: Set<string>): void {
    this.namedValuesIn(value, reads)
  }

  /** 遍历语句体：Assignment 按写/读推导，其余 NamedValue 一律计读（含敏感表/条件/case） */
  private walkStatements(value: unknown, drives: Set<string>, reads: Set<string>): void {
    const node = asNode(value)
    if (!node) {
      if (Array.isArray(value)) for (const item of value) this.walkStatements(item, drives, reads)
      return
    }
    if (node.kind === 'Assignment') {
      this.collectWrites(node.left, drives, reads)
      this.collectReads(node.right, reads)
      return
    }
    if (node.kind === 'NamedValue') {
      const name = symbolName(node.symbol)
      if (name) reads.add(name)
      return
    }
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('source_') || key === 'type') continue
      this.walkStatements(child, drives, reads)
    }
  }

  /** Timed 包装提取时钟/复位：首个事件为时钟，名含 rst/reset 的事件为复位 */
  private extractClockReset(body: unknown): { clock?: string; reset?: string } {
    const timed = asNode(body)
    if (timed?.kind !== 'Timed') return {}
    const timing = asNode(timed.timing)
    const events = Array.isArray(timing?.events) ? (timing.events as unknown[]) : []
    let clock: string | undefined
    let reset: string | undefined
    for (const eventValue of events) {
      const event = asNode(eventValue)
      if (event?.kind !== 'SignalEvent') continue
      const expr = asNode(event.expr)
      if (expr?.kind !== 'NamedValue') continue
      const name = symbolName(expr.symbol)
      if (!name) continue
      if (!clock) clock = name
      if (!reset && /rst|reset/i.test(name)) reset = name
    }
    return { clock, reset }
  }

  private accumulateProcess(accumulator: ModuleAccumulator, block: AstNode): void {
    const kind = PROCESS_KIND[str(block.procedureKind)] ?? 'always'
    const source = this.sourceRef(block.source_file, block.source_line)
    const key = `${kind}@${source ?? ''}`
    if (accumulator.processes.has(key)) return
    const drives = new Set<string>()
    const reads = new Set<string>()
    this.walkStatements(block.body, drives, reads)
    const { clock, reset } = this.extractClockReset(block.body)
    accumulator.processes.set(key, {
      id: '',
      kind,
      ...(clock ? { clock } : {}),
      ...(reset ? { reset } : {}),
      ...(source ? { source } : {}),
      drives: [...drives],
      reads: [...reads]
    })
  }

  private accumulateAssign(accumulator: ModuleAccumulator, assign: AstNode): void {
    const source = this.sourceRef(assign.source_file, assign.source_line)
    const key = `assign@${source ?? ''}`
    if (accumulator.processes.has(key)) return
    const drives = new Set<string>()
    const reads = new Set<string>()
    const assignment = asNode(assign.assignment)
    if (assignment) {
      this.collectWrites(assignment.left, drives, reads)
      this.collectReads(assignment.right, reads)
    }
    accumulator.processes.set(key, {
      id: '',
      kind: 'assign',
      ...(source ? { source } : {}),
      drives: [...drives],
      reads: [...reads]
    })
  }

  // ---- 实例连接 ----

  private accumulateInstance(accumulator: ModuleAccumulator, instance: AstNode): void {
    const name = str(instance.name)
    if (!name || accumulator.instances.has(name)) return
    const body = asNode(instance.body)
    const moduleName = str(body?.name)
    if (!moduleName) {
      this.diagnostics.push({ severity: 'warning', message: `模块 ${accumulator.name} 的实例 ${name} 未解析到模块定义（--ignore-unknown-modules）` })
    }
    const connections: DesignInstanceConnection[] = []
    const refs = new Map<string, string[]>()
    const rawConnections = Array.isArray(instance.connections) ? (instance.connections as unknown[]) : []
    for (const connectionValue of rawConnections) {
      const connection = asNode(connectionValue)
      if (!connection) continue
      const port = asNode(connection.port)
      const pin = str(port?.name)
      if (!pin) continue
      const expr = asNode(connection.expr)
      const direction = mapDirection(str(port?.direction))
      const exprText = expr ? (this.sourceTextOf(expr) ?? '') : ''
      const referenced = new Set<string>()
      if (expr) this.namedValuesIn(expr, referenced)
      refs.set(pin, [...referenced])
      const connectionSource = this.sourceRef(expr?.source_file_start, expr?.source_line_start)
      connections.push({
        pin,
        direction: direction === 'unknown' ? 'inout' : direction,
        expr: exprText,
        ...(expr?.kind === 'NamedValue' && symbolName(expr.symbol) ? { signal: symbolName(expr.symbol) } : {}),
        ...(connectionSource ? { source: connectionSource } : {})
      })
    }
    accumulator.instances.set(name, {
      name,
      module: moduleName,
      parameterOverrides: body ? this.parameterOverridesOf(body) : {},
      connections,
      source: this.sourceRef(instance.source_file, instance.source_line)
    })
    accumulator.connectionRefs.set(name, refs)
  }

  // ---- 源码文本回读（表达式 source range → 源文件切片） ----

  private fileText(file: string): string | null {
    const normalized = normalizeSlangSource(file, this.workspace)
    if (!normalized) return null
    if (this.fileTexts.has(normalized)) return this.fileTexts.get(normalized) ?? null
    const absolute = isAbsolute(normalized) ? normalized : resolve(this.workspace, normalized)
    let text: string | null = null
    try {
      text = readFileSync(absolute, 'utf-8')
    } catch {
      text = null
    }
    this.fileTexts.set(normalized, text)
    return text
  }

  private sourceTextOf(node: AstNode): string | undefined {
    const file = str(node.source_file_start)
    if (!file) return undefined
    const text = this.fileText(file)
    if (text === null) return undefined
    const lineStart = num(node.source_line_start)
    const lineEnd = num(node.source_line_end)
    const colStart = num(node.source_column_start)
    const colEnd = num(node.source_column_end)
    if (lineStart <= 0 || lineEnd <= 0 || colStart <= 0 || colEnd <= 0) return undefined
    const lines = text.split(/\r?\n/)
    if (lineStart === lineEnd) return (lines[lineStart - 1] ?? '').slice(colStart - 1, colEnd - 1).trim()
    const parts: string[] = [(lines[lineStart - 1] ?? '').slice(colStart - 1)]
    for (let line = lineStart + 1; line < lineEnd; line++) parts.push(lines[line - 1] ?? '')
    parts.push((lines[lineEnd - 1] ?? '').slice(0, colEnd - 1))
    return parts.join('\n').trim()
  }

  // ---- 模块定稿：process 序号 + trace 端点 ----

  private finalizeModule(accumulator: ModuleAccumulator): DesignModule {
    const processes = [...accumulator.processes.values()].sort((a, b) =>
      (a.source ?? '￿').localeCompare(b.source ?? '￿') || a.kind.localeCompare(b.kind)
    )
    processes.forEach((process, index) => {
      process.id = `P${index + 1}`
    })
    const signals = [...accumulator.signals.values()].sort((a, b) => (a.source ?? '').localeCompare(b.source ?? '') || a.name.localeCompare(b.name))
    const traces = signals.map((signal) => this.buildTrace(accumulator, signal, processes))
    return {
      name: accumulator.name,
      ...(accumulator.source ? { source: accumulator.source } : {}),
      parameters: [...accumulator.parameters.values()],
      ports: [...accumulator.ports.values()],
      signals,
      processes,
      instances: [...accumulator.instances.values()],
      traces
    }
  }

  private buildTrace(accumulator: ModuleAccumulator, signal: DesignSignal, processes: DesignProcess[]): DesignSignalTrace {
    const drivers: DesignEndpoint[] = []
    const loads: DesignEndpoint[] = []
    if (signal.isPort && signal.direction) {
      const endpoint: DesignEndpoint = {
        kind: 'port',
        label: `PORT ${signal.name}`,
        direction: signal.direction,
        ...(signal.source ? { source: signal.source } : {})
      }
      if (signal.direction === 'input' || signal.direction === 'inout') drivers.push(endpoint)
      if (signal.direction === 'output' || signal.direction === 'inout') loads.push(endpoint)
    }
    for (const process of processes) {
      if (process.drives.includes(signal.name)) {
        drivers.push({
          kind: 'statement',
          label: `${process.kind} @ ${process.source ?? accumulator.name}`,
          direction: 'output',
          ...(process.source ? { source: process.source } : {}),
          processId: process.id
        })
      }
      if (process.reads.includes(signal.name)) {
        loads.push({
          kind: 'statement',
          label: `${process.kind} @ ${process.source ?? accumulator.name}`,
          direction: 'input',
          ...(process.source ? { source: process.source } : {}),
          processId: process.id
        })
      }
    }
    for (const instance of accumulator.instances.values()) {
      const refs = accumulator.connectionRefs.get(instance.name)
      for (const connection of instance.connections) {
        const referenced = refs?.get(connection.pin) ?? []
        const touches = connection.signal === signal.name || (!connection.signal && referenced.includes(signal.name))
        if (!touches) continue
        const endpoint: DesignEndpoint = {
          kind: 'instancePin',
          label: `${instance.name}.${connection.pin}`,
          direction: connection.direction,
          ...(connection.source ? { source: connection.source } : {}),
          instancePath: instance.name
        }
        if (connection.direction === 'output' || connection.direction === 'inout') drivers.push(endpoint)
        if (connection.direction === 'input' || connection.direction === 'inout') loads.push(endpoint)
      }
    }
    return { net: signal.name, width: signal.width, drivers, loads }
  }
}

export function buildDatabaseV3(options: BuildV3Options): DesignDatabaseV3 {
  return new V3Builder(options.ast, options.workspace, options.rtlFiles, options.topModule).build()
}
