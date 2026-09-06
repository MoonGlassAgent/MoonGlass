import type { DesignDatabase, DesignEndpoint, DesignInstance, DesignModule } from './types'

/**
 * 跨层次信号追踪（类 Verdi 的逐层 Driver/Load 展开）。
 *
 * DesignDatabase 中 traces 只描述单模块内的连接关系；本模块在运行时把
 * 「父模块 net ↔ 实例 pin ↔ 子模块 port」沿层次树缝合起来，支持按需逐跳
 * 展开追踪路径，无需额外 elaboration。
 */

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

function moduleOf(database: DesignDatabase, name: string): DesignModule | null {
  return database.modules.find((module) => module.name === name) ?? null
}

/** 按 bit id 反查模块内命中的 net 名 */
function netsByBits(module: DesignModule, bits: string[]): string[] {
  const wanted = new Set(bits)
  return module.nets.filter((net) => net.bits.some((bit) => wanted.has(bit))).map((net) => net.name)
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

/** 查询某实例上下文中一条 net 的 driver / load 端点（模块内） */
export function traceNet(
  database: DesignDatabase,
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
 * 判断端点是否可跨越层次边界继续追踪，并计算追踪目标。
 *
 * - port 端点：沿实例边界向上跨入父模块（顶层 port 为芯片 IO，终止）
 * - 实例 cell 端点：向下进入子模块，从对应 port 的 net 继续
 * - 普通 cell（$dff / $add 等）：边界终止，返回空
 */
export function continueTrace(
  database: DesignDatabase,
  context: TraceContext,
  endpoint: DesignEndpoint,
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
    const parentModule = parent ? moduleOf(database, parent.module) : null
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
  const childModule = endpoint.cellType ? moduleOf(database, endpoint.cellType) : null
  if (!childModule) return []
  const port = childModule.ports.find((candidate) => candidate.name === endpoint.pin)
  if (!port || port.bits.length === 0) return []
  const childContext: TraceContext = {
    instancePath: `${context.instancePath}.${endpoint.name}`,
    module: childModule.name
  }
  return netsByBits(childModule, port.bits).map((net) => ({ context: childContext, net }))
}
