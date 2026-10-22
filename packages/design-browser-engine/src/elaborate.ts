import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { locateTool, run, toolEnv, YOSYS_CANDIDATES } from '@moonglass/eda-bridge/tool-runner'
import type {
  DesignCell,
  DesignDatabaseV2,
  DesignEndpointV2,
  DesignInstance,
  DesignModuleV2,
  DesignNet,
  DesignPortV2,
  DesignSignalTraceV2,
  ElaborateOptions
} from './types'

type YosysBit = number | string

interface YosysPort {
  direction: 'input' | 'output' | 'inout'
  bits: YosysBit[]
}

interface YosysCell {
  type: string
  attributes?: Record<string, string | number>
  port_directions?: Record<string, 'input' | 'output' | 'inout'>
  connections?: Record<string, YosysBit[]>
}

interface YosysModule {
  attributes?: Record<string, string | number>
  ports?: Record<string, YosysPort>
  cells?: Record<string, YosysCell>
  netnames?: Record<string, { bits: YosysBit[]; attributes?: Record<string, string | number> }>
}

interface YosysJson {
  modules?: Record<string, YosysModule>
}

function quote(value: string): string {
  return `"${resolve(value).replace(/\\/g, '/').replace(/"/g, '\\"')}"`
}

function bitId(bit: YosysBit): string {
  return typeof bit === 'number' ? `b${bit}` : String(bit)
}

function sourceOf(attributes?: Record<string, string | number>): string | undefined {
  const source = attributes?.src
  return typeof source === 'string' ? source : undefined
}

function endpointDirection(
  direction: 'input' | 'output' | 'inout' | undefined
): DesignEndpointV2['direction'] {
  return direction ?? 'unknown'
}

function buildModule(
  name: string,
  raw: YosysModule,
  moduleNames: Set<string>
): DesignModuleV2 {
  const ports: DesignPortV2[] = Object.entries(raw.ports ?? {}).map(([portName, port]) => ({
    name: portName,
    direction: port.direction,
    width: port.bits.length,
    bits: port.bits.map(bitId)
  }))
  const nets: DesignNet[] = Object.entries(raw.netnames ?? {}).map(([netName, net]) => ({
    name: netName,
    width: net.bits.length,
    bits: net.bits.map(bitId),
    source: sourceOf(net.attributes)
  }))
  const cells: DesignCell[] = Object.entries(raw.cells ?? {}).map(([cellName, cell]) => ({
    name: cellName,
    type: cell.type,
    source: sourceOf(cell.attributes),
    isInstance: moduleNames.has(cell.type),
    connections: Object.fromEntries(
      Object.entries(cell.connections ?? {}).map(([pin, bits]) => [pin, bits.map(bitId)])
    )
  }))

  const driversByBit = new Map<string, DesignEndpointV2[]>()
  const loadsByBit = new Map<string, DesignEndpointV2[]>()
  const addEndpoint = (index: Map<string, DesignEndpointV2[]>, bits: string[], endpoint: DesignEndpointV2): void => {
    for (const bit of bits) {
      const endpoints = index.get(bit)
      if (endpoints) endpoints.push(endpoint)
      else index.set(bit, [endpoint])
    }
  }
  for (const port of ports) {
    const endpoint: DesignEndpointV2 = {
      kind: 'port',
      name: port.name,
      pin: port.name,
      direction: port.direction,
      source: sourceOf(raw.attributes)
    }
    if (port.direction === 'input' || port.direction === 'inout') addEndpoint(driversByBit, port.bits, endpoint)
    if (port.direction === 'output' || port.direction === 'inout') addEndpoint(loadsByBit, port.bits, endpoint)
  }
  for (const [cellName, cell] of Object.entries(raw.cells ?? {})) {
    for (const [pin, rawBits] of Object.entries(cell.connections ?? {})) {
      const direction = endpointDirection(cell.port_directions?.[pin])
      const endpoint: DesignEndpointV2 = {
        kind: 'cell',
        name: cellName,
        pin,
        direction,
        source: sourceOf(cell.attributes),
        cellType: cell.type
      }
      const bits = rawBits.map(bitId)
      if (direction === 'output' || direction === 'inout') addEndpoint(driversByBit, bits, endpoint)
      if (direction === 'input' || direction === 'inout' || direction === 'unknown') addEndpoint(loadsByBit, bits, endpoint)
    }
  }
  const endpointsForBits = (index: Map<string, DesignEndpointV2[]>, bits: string[]): DesignEndpointV2[] => {
    const found: DesignEndpointV2[] = []
    const seen = new Set<string>()
    for (const bit of bits) {
      for (const endpoint of index.get(bit) ?? []) {
        const key = `${endpoint.kind}\0${endpoint.name}\0${endpoint.pin}`
        if (seen.has(key)) continue
        seen.add(key)
        found.push(endpoint)
      }
    }
    return found
  }
  const traces: DesignSignalTraceV2[] = nets.map((net) => {
    return {
      net: net.name,
      bits: net.bits,
      drivers: endpointsForBits(driversByBit, net.bits),
      loads: endpointsForBits(loadsByBit, net.bits)
    }
  })

  return {
    name,
    source: sourceOf(raw.attributes),
    ports,
    nets,
    cells,
    traces
  }
}

function buildHierarchy(
  moduleName: string,
  instanceName: string,
  path: string,
  modules: Map<string, DesignModuleV2>,
  ancestors = new Set<string>()
): DesignInstance {
  const module = modules.get(moduleName)
  const node: DesignInstance = {
    path,
    name: instanceName,
    module: moduleName,
    source: module?.source,
    definitionSource: module?.source,
    children: []
  }
  if (!module || ancestors.has(moduleName)) return node
  const nextAncestors = new Set(ancestors).add(moduleName)
  node.children = module.cells
    .filter((cell) => cell.isInstance)
    .map((cell) => {
      const child = buildHierarchy(
        cell.type,
        cell.name,
        `${path}.${cell.name}`,
        modules,
        nextAncestors
      )
      child.parentPath = path
      child.source = cell.source ?? child.source
      return child
    })
  return node
}

export async function elaborateDesign(options: ElaborateOptions): Promise<DesignDatabaseV2> {
  if (options.rtlFiles.length === 0) throw new Error('没有可 elaboration 的 RTL 文件')
  for (const file of options.rtlFiles) if (!existsSync(file)) throw new Error(`RTL 文件不存在: ${file}`)

  const yosys = await locateTool(YOSYS_CANDIDATES)
  if (!yosys) throw new Error('工具未找到: yosys')
  mkdirSync(dirname(options.outputJson), { recursive: true })

  const includeArgs = (options.includeDirs ?? []).map((dir) => `-I${quote(dir)}`)
  const defineArgs = (options.defines ?? []).map((define) => `-D${define}`)
  const commands = [
    `read_verilog -sv ${includeArgs.join(' ')} ${defineArgs.join(' ')} ${options.rtlFiles.map(quote).join(' ')}`,
    `hierarchy -check -top ${options.topModule}`,
    'proc',
    'opt_clean',
    `write_json ${quote(options.outputJson)}`
  ]
  const result = await run(yosys, ['-p', commands.join('; ')], toolEnv(yosys))
  if (result.code !== 0 || !existsSync(options.outputJson)) {
    const tail = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/).slice(-12).join('\n')
    throw new Error(`Design elaboration 失败 (Yosys code=${result.code})\n${tail}`)
  }

  const raw = JSON.parse(readFileSync(options.outputJson, 'utf-8')) as YosysJson
  const rawModules = raw.modules ?? {}
  const moduleNames = new Set(Object.keys(rawModules))
  if (!moduleNames.has(options.topModule)) throw new Error(`顶层模块不存在: ${options.topModule}`)
  const modules = Object.entries(rawModules).map(([name, module]) => buildModule(name, module, moduleNames))
  const moduleMap = new Map<string, DesignModuleV2>(modules.map((module) => [module.name, module]))
  const diagnostics = modules.flatMap((module) =>
    module.cells
      .filter((cell) => !cell.isInstance && !cell.type.startsWith('$'))
      .map((cell) => ({
        severity: 'warning' as const,
        message: `${module.name}.${cell.name}: 未解析模块类型 ${cell.type}`
      }))
  )
  return {
    version: 2,
    frontend: 'yosys',
    topModule: options.topModule,
    generatedAt: new Date().toISOString(),
    sourceFiles: options.rtlFiles.map((file) => resolve(file)),
    modules,
    hierarchy: buildHierarchy(options.topModule, options.topModule, options.topModule, moduleMap),
    diagnostics
  }
}
