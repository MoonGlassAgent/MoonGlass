/**
 * Verilog/SystemVerilog 解析器（Phase 4 实现）
 *
 * 基于正则的轻量解析器，用于提取模块接口（端口、参数、实例化）。
 * 不追求等价综合器级精度，但足以支撑 Agent 的接口理解、测试台生成与模板生成。
 * 复杂设计建议后续接入 pyverilog / slang 等专用解析器。
 */

import { readFileSync } from 'node:fs'
import type { InstanceDef, ModuleInfo, ParameterDef, PortDef } from './types.ts'

export interface ParseOptions {
  filePath: string
  /** 同时提取子模块实例化关系 */
  extractHierarchy?: boolean
}

/** 从文件路径推断模块名 */
function moduleNameFromPath(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? 'unknown'
  return base.replace(/\.(v|sv|vh)$/i, '')
}

// module 声明：module name #( ... ) ( ... ); 或 module name ( ... );
const MODULE_HEADER_RE = /^\s*module\s+(\w+)\s*(?:#\s*\((.*?)\))?\s*\((.*?)\)\s*;/s

// 参数声明：parameter TYPE NAME = VALUE, ...
const PARAM_BLOCK_RE = /^\s*parameter\s+(?:\w+\s+)?(\w+)\s*=\s*([^,;]+)/gim

// 非 ANSI 端口方向声明：input [7:0] i_clk, ...
const PORT_DIR_RE = /^\s*(input|output|inout)\s+(?:wire\s+|reg\s+|logic\s+)?(\[.*?\])?\s*(\w+)/gim

// ANSI 行内端口声明：input [7:0] name（用于模块头列表或单独行）
const ANSI_INLINE_PORT_RE = /\b(input|output|inout)\s+(?:wire\s+|reg\s+|logic\s+)?(\[.*?\])?\s*(\w+)/g

// module 实例化：module_name #(...) instance_name (...);
const INSTANCE_RE =
  /^\s*(?!module\s)(\w+)\s+(?:#\s*\((.*?)\)\s*)?(\w+)\s*\((.*?)\)\s*;/gims

function parseWidth(widthSpec?: string): number {
  if (!widthSpec) return 1
  const m = /\[(\d+)\s*:\s*(\d+)\]/.exec(widthSpec)
  if (!m) return 1
  const msb = Number(m[1])
  const lsb = Number(m[2])
  return Math.abs(msb - lsb) + 1
}

function parseParameters(paramText: string): ParameterDef[] {
  const params: ParameterDef[] = []
  const re = /(?:parameter\s+)?(?:\w+\s+)?(\w+)\s*=\s*([^,;)]+)/g
  let match
  while ((match = re.exec(paramText)) !== null) {
    params.push({
      name: match[1],
      defaultValue: match[2].trim()
    })
  }
  return params
}

function parsePorts(code: string, portListText: string): PortDef[] {
  const ports: PortDef[] = []
  const seen = new Set<string>()

  const addPort = (direction: string, widthSpec: string | undefined, name: string) => {
    if (seen.has(name)) return
    seen.add(name)
    ports.push({
      name,
      direction: direction as 'input' | 'output' | 'inout',
      width: parseWidth(widthSpec),
      widthSpec
    })
  }

  // 情况 1：ANSI 内联端口声明（module (input [7:0] a, output b)）
  if (/\b(input|output|inout)\b/.test(portListText)) {
    let match
    while ((match = ANSI_INLINE_PORT_RE.exec(portListText)) !== null) {
      addPort(match[1], match[2], match[3])
    }
    if (ports.length > 0) return ports
  }

  // 情况 2：端口列表只有名字（module (a, b)），后面单独声明方向
  const names = portListText
    .split(/,\s*/)
    .map((s) => s.trim())
    .filter(Boolean)

  for (const rawName of names) {
    // 可能带 .name(signal) 或 name
    const name = rawName.replace(/^\.(\w+)\s*\(.*\)$/, '$1').trim()
    if (!name) continue

    // 在模块体中搜索该端口的方向声明
    const dirRe = new RegExp(
      `^\\s*(input|output|inout)\\s+(?:wire\\s+|reg\\s+|logic\\s+)?(\\[.*?\\])?\\s*\\b${name}\\b`,
      'gim'
    )
    const m = dirRe.exec(code)
    if (m) {
      addPort(m[1], m[2], name)
    } else {
      // 未声明方向时默认为 input 1bit（旧风格）
      addPort('input', undefined, name)
    }
  }

  return ports
}

function parseInstances(code: string): InstanceDef[] {
  const instances: InstanceDef[] = []
  let match
  while ((match = INSTANCE_RE.exec(code)) !== null) {
    const moduleName = match[1]
    const instanceName = match[3]
    const connText = match[4]
    const connections: Record<string, string> = {}

    // 解析 .port(signal) 或 .port(signal[7:0]) 或 port 位置连接
    const namedConn = /\.(\w+)\s*\(\s*([^)]+)\s*\)/g
    let cm
    while ((cm = namedConn.exec(connText)) !== null) {
      connections[cm[1]] = cm[2].trim()
    }

    instances.push({
      instanceName,
      moduleName,
      connections
    })
  }
  return instances
}

/**
 * 解析 Verilog/SystemVerilog 文件，返回模块信息。
 *
 * 支持：
 * - ANSI / 非 ANSI 端口列表
 * - 参数（parameter）提取
 * - 端口方向、位宽推断
 * - 子模块实例化（extractHierarchy=true）
 */
export async function parseVerilog(options: ParseOptions): Promise<ModuleInfo> {
  const code = readFileSync(options.filePath, 'utf-8')

  const headerMatch = MODULE_HEADER_RE.exec(code)
  let moduleName = moduleNameFromPath(options.filePath)
  let parameters: ParameterDef[] = []
  let ports: PortDef[] = []
  let instances: InstanceDef[] = []

  if (headerMatch) {
    moduleName = headerMatch[1]
    const paramBlock = headerMatch[2] ?? ''
    const portListText = headerMatch[3] ?? ''

    parameters = parseParameters(paramBlock)
    if (parameters.length === 0) {
      // 参数也可能在模块体中声明
      parameters = parseParameters(code)
    }

    ports = parsePorts(code, portListText)

    if (options.extractHierarchy) {
      instances = parseInstances(code)
    }
  } else {
    // 退化：未匹配到标准 module header，按端口方向声明兜底提取
    let match
    while ((match = ANSI_INLINE_PORT_RE.exec(code)) !== null) {
      if (!ports.some((p) => p.name === match![3])) {
        ports.push({
          name: match[3],
          direction: match[1] as 'input' | 'output' | 'inout',
          width: parseWidth(match[2]),
          widthSpec: match[2]
        })
      }
    }
    while ((match = PORT_DIR_RE.exec(code)) !== null) {
      if (!ports.some((p) => p.name === match![3])) {
        ports.push({
          name: match[3],
          direction: match[1] as 'input' | 'output' | 'inout',
          width: parseWidth(match[2]),
          widthSpec: match[2]
        })
      }
    }
  }

  return {
    moduleName,
    ports,
    parameters,
    instances
  }
}

/**
 * 从端口列表推断顶层时钟/复位信号（启发式）
 */
export function inferClockAndReset(ports: PortDef[]): {
  clock?: string
  reset?: string
  resetActiveLow: boolean
} {
  const clock = ports.find((p) => /^(i_)?clk$/i.test(p.name))?.name
  const reset =
    ports.find((p) => /^(i_)?rst_n$/i.test(p.name))?.name ??
    ports.find((p) => /^(i_)?rst$/i.test(p.name))?.name
  const resetActiveLow = reset ? /rst_n/i.test(reset) : true
  return { clock, reset, resetActiveLow }
}
