import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { locateTool, run, toolEnv, YOSYS_CANDIDATES } from '@moonglass/eda-bridge/tool-runner'
import type {
  DesignCell,
  DesignDatabase,
  DesignEndpoint,
  DesignInstance,
  DesignModule,
  DesignNet,
  DesignPort,
  DesignSignalTrace,
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
): DesignEndpoint['direction'] {
  return direction ?? 'unknown'
}

function buildModule(
  name: string,
  raw: YosysModule,
  moduleNames: Set<string>
): DesignModule {
  const ports: DesignPort[] = Object.entries(raw.ports ?? {}).map(([portName, port]) => ({
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

  const traces: DesignSignalTrace[] = nets.map((net) => {
    const bitSet = new Set(net.bits)
    const drivers: DesignEndpoint[] = []
    const loads: DesignEndpoint[] = []
    for (const port of ports) {
      if (!port.bits.some((bit) => bitSet.has(bit))) continue
      const endpoint: DesignEndpoint = {
        kind: 'port',
        name: port.name,
        pin: port.name,
        direction: port.direction,
        source: net.source ?? sourceOf(raw.attributes)
      }
      if (port.direction === 'input' || port.direction === 'inout') drivers.push(endpoint)
      if (port.direction === 'output' || port.direction === 'inout') loads.push(endpoint)
    }
    for (const [cellName, cell] of Object.entries(raw.cells ?? {})) {
      for (const [pin, bits] of Object.entries(cell.connections ?? {})) {
        if (!bits.map(bitId).some((bit) => bitSet.has(bit))) continue
        const direction = endpointDirection(cell.port_directions?.[pin])
        const endpoint: DesignEndpoint = {
          kind: 'cell',
          name: cellName,
          pin,
          direction,
          source: sourceOf(cell.attributes),
          cellType: cell.type
        }
        if (direction === 'output' || direction === 'inout') drivers.push(endpoint)
        if (direction === 'input' || direction === 'inout' || direction === 'unknown') loads.push(endpoint)
      }
    }
    return { net: net.name, bits: net.bits, drivers, loads }
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
  modules: Map<string, DesignModule>,
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

export async function elaborateDesign(options: ElaborateOptions): Promise<DesignDatabase> {
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
  const moduleMap = new Map(modules.map((module) => [module.name, module]))
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
    topModule: options.topModule,
    generatedAt: new Date().toISOString(),
    sourceFiles: options.rtlFiles.map((file) => resolve(file)),
    modules,
    hierarchy: buildHierarchy(options.topModule, options.topModule, options.topModule, moduleMap),
    diagnostics
  }
}
