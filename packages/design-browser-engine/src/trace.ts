/**
 * 跨层次信号追踪（类 Verdi 的逐层 Driver/Load 展开）。
 *
 * DesignDatabase 中 traces 只描述单模块内的连接关系；本模块在运行时把
 * 「父模块信号 ↔ 实例 pin ↔ 子模块 port 信号」沿层次树缝合起来，支持按需逐跳
 * 展开追踪路径，无需额外 elaboration。
 *
 * 双形态：
 * - v3（slang，frontend === 'slang'）：端点三态 port / instancePin / statement，
 *   statement 为本层终点，instancePin 可跨层，port 向上跨入父模块；
 * - v2（Yosys 回退，冻结）：端点 port / cell（bit 级连通图口径），函数带 V2 后缀。
 */

import type {
  DesignDatabase,
  DesignDatabaseV2,
  DesignDatabaseV3,
  DesignEndpoint,
  DesignEndpointV2,
  DesignInstance,
  DesignModuleV2
} from './types'

export type TraceDirection = 'driver' | 'load'

/** 设计中的一个实例上下文：层次路径 + 对应模块名 */
export interface TraceContext {
  /** 点分隔实例路径（顶层即 topModule 名） */
  instancePath: string
  /** 该实例对应的模块名 */
  module: string
}

/** 跨边界继续追踪的目标：另一个实例上下文中的一条 net */
export interface TraceTarget {
  context: TraceContext
  net: string
}

/** 按实例路径定位层次树节点（顶层路径即 topModule 名） */
export function findInstance(database: DesignDatabase, path: string): DesignInstance | null {
  if (database.hierarchy.path === path) return database.hierarchy
  const prefix = `${database.hierarchy.path}.`
  if (!path.startsWith(prefix)) return null
  const segments = path.slice(prefix.length).split('.')
  let node: DesignInstance | undefined = database.hierarchy
  for (const segment of segments) {
    node = node?.children.find((child) => child.name === segment)
    if (!node) return null
  }
  return node ?? null
}

/** 顶层实例上下文 */
export function topContext(database: DesignDatabase): TraceContext {
  return { instancePath: database.hierarchy.path, module: database.topModule }
}

// ---------- v3（slang，语句级端点） ----------

function moduleOf(database: DesignDatabaseV3, name: string) {
  return database.modules.find((module) => module.name === name) ?? null
}

/** 查询某实例上下文中一条信号的 driver / load 端点（模块内，语句级口径） */
export function traceNet(
  database: DesignDatabaseV3,
  context: TraceContext,
  net: string,
  direction: TraceDirection
): DesignEndpoint[] {
  const module = moduleOf(database, context.module)
  const trace = module?.traces.find((candidate) => candidate.net === net)
  if (!trace) return []
  return direction === 'driver' ? trace.drivers : trace.loads
}

/**
 * v3 端点跨层展开：
 * - statement：本层终点；
 * - port：沿实例边界向上跨入父模块（顶层 port 为芯片 IO，终止）；父侧连接为复杂
 *   表达式（位选/拼接）时保守终止（宁缺毋假，expr 已在实例详情可见）；
 * - instancePin：向下进入子模块，从对应 port 信号继续（elaborated 子实例体的
 *   port 名即信号名）。
 */
export function continueTrace(
  database: DesignDatabaseV3,
  context: TraceContext,
  endpoint: DesignEndpoint,
  direction: TraceDirection
): TraceTarget[] {
  if (endpoint.kind === 'statement') return []
  const outbound = endpoint.direction === 'output' || endpoint.direction === 'inout'
  const inbound = endpoint.direction === 'input' || endpoint.direction === 'inout'
  const crossing =
    endpoint.kind === 'port'
      ? direction === 'driver'
        ? inbound
        : outbound
      : direction === 'driver'
        ? outbound
        : inbound

  if (endpoint.kind === 'port') {
    if (!crossing) return []
    if (context.instancePath === database.hierarchy.path) return []
    const separator = context.instancePath.lastIndexOf('.')
    const parentPath = context.instancePath.slice(0, separator)
    const instanceName = context.instancePath.slice(separator + 1)
    const parent = findInstance(database, parentPath)
    const parentModule = parent ? moduleOf(database, parent.module) : null
    if (!parent || !parentModule) return []
    const instanceRef = parentModule.instances.find((item) => item.name === instanceName)
    const portName = endpoint.label.replace(/^PORT\s+/, '')
    const connection = instanceRef?.connections.find((item) => item.pin === portName)
    if (!connection?.signal) return []
    return [{ context: { instancePath: parentPath, module: parent.module }, net: connection.signal }]
  }

  // instancePin：instancePath 字段为构建器写入的实例名单段（模块内相对）
  const instanceName = endpoint.instancePath ?? endpoint.label.slice(0, endpoint.label.lastIndexOf('.'))
  const pin = endpoint.label.slice(endpoint.label.lastIndexOf('.') + 1)
  if (!instanceName || !pin) return []
  const childPath = `${context.instancePath}.${instanceName}`
  const childNode = findInstance(database, childPath)
  const childModule = childNode ? moduleOf(database, childNode.module) : null
  if (!childNode || !childModule) return []
  return [{ context: { instancePath: childPath, module: childModule.name }, net: pin }]
}

// ---------- v2（Yosys 回退形态，冻结） ----------

function moduleOfV2(database: DesignDatabaseV2, name: string): DesignModuleV2 | null {
  return database.modules.find((module) => module.name === name) ?? null
}

/** 按 bit id 反查模块内命中的 net 名 */
function netsByBits(module: DesignModuleV2, bits: string[]): string[] {
  const wanted = new Set(bits)
  return module.nets.filter((net) => net.bits.some((bit) => wanted.has(bit))).map((net) => net.name)
}

/** v2：查询某实例上下文中一条 net 的 driver / load 端点（模块内，bit 级口径） */
export function traceNetV2(
  database: DesignDatabaseV2,
  context: TraceContext,
  net: string,
  direction: TraceDirection
): DesignEndpointV2[] {
  const module = moduleOfV2(database, context.module)
  const trace = module?.traces.find((candidate) => candidate.net === net)
  if (!trace) return []
  return direction === 'driver' ? trace.drivers : trace.loads
}

/**
 * v2 端点跨层展开（冻结口径）：
 * - port 端点：沿实例边界向上跨入父模块（顶层 port 为芯片 IO，终止）
 * - 实例 cell 端点：向下进入子模块，从对应 port 的 net 继续
 * - 普通 cell（$dff / $add 等）：边界终止，返回空
 */
export function continueTraceV2(
  database: DesignDatabaseV2,
  context: TraceContext,
  endpoint: DesignEndpointV2,
  direction: TraceDirection
): TraceTarget[] {
  const outbound = endpoint.direction === 'output' || endpoint.direction === 'inout'
  const inbound = endpoint.direction === 'input' || endpoint.direction === 'inout'
  // driver 追踪：关心「驱动来自边界另一侧」的端点；load 追踪反之
  const crossing =
    endpoint.kind === 'port'
      ? direction === 'driver'
        ? inbound
        : outbound
      : direction === 'driver'
        ? outbound
        : inbound || endpoint.direction === 'unknown'
  if (!crossing) return []

  if (endpoint.kind === 'port') {
    // 向上跨入父模块
    if (context.instancePath === database.hierarchy.path) return []
    const separator = context.instancePath.lastIndexOf('.')
    const parentPath = context.instancePath.slice(0, separator)
    const instanceName = context.instancePath.slice(separator + 1)
    const parent = findInstance(database, parentPath)
    const parentModule = parent ? moduleOfV2(database, parent.module) : null
    if (!parent || !parentModule) return []
    const instanceCell = parentModule.cells.find(
      (cell) => cell.isInstance && cell.name === instanceName
    )
    const bits = instanceCell?.connections[endpoint.pin]
    if (!bits || bits.length === 0) return []
    return netsByBits(parentModule, bits).map((net) => ({
      context: { instancePath: parentPath, module: parent.module },
      net
    }))
  }

  // 向下进入子模块
  const childModule = endpoint.cellType ? moduleOfV2(database, endpoint.cellType) : null
  if (!childModule) return []
  const port = childModule.ports.find((candidate) => candidate.name === endpoint.pin)
  if (!port || port.bits.length === 0) return []
  const childContext: TraceContext = {
    instancePath: `${context.instancePath}.${endpoint.name}`,
    module: childModule.name
  }
  return netsByBits(childModule, port.bits).map((net) => ({ context: childContext, net }))
}
