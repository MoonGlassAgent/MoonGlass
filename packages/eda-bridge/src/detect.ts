/**
 * EDA 工具探测
 *
 * 在系统 PATH 中探测常用 EDA 工具并尝试获取版本号。
 * 本模块为骨架阶段唯一提供真实功能的 EDA 能力。
 */

import type { ToolDetection } from '@shared/types'
import { locateTool, run } from './tool-runner'

/** 待探测工具清单：工具名 → 版本命令参数 */
const TOOL_PROBES: Array<{ tool: string; versionArgs: string[] }> = [
  { tool: 'verilator', versionArgs: ['--version'] },
  { tool: 'yosys', versionArgs: ['-V'] },
  { tool: 'verible-verilog-lint', versionArgs: ['--version'] },
  { tool: 'iverilog', versionArgs: ['-V'] },
  { tool: 'gtkwave', versionArgs: ['--version'] },
  { tool: 'python', versionArgs: ['--version'] }
]

async function probeOne(tool: string, versionArgs: string[]): Promise<ToolDetection> {
  const toolPath = await locateTool([tool])
  if (!toolPath) return { tool, found: false }

  let version: string | undefined
  try {
    const { stdout, stderr } = await run(toolPath, versionArgs)
    version = (stdout || stderr).trim().split(/\r?\n/)[0]
  } catch {
    // 版本获取失败不影响探测结果
  }
  return { tool, found: true, path: toolPath, version }
}

/** 探测全部已注册的 EDA 工具 */
export async function detectToolchain(): Promise<ToolDetection[]> {
  return Promise.all(TOOL_PROBES.map((p) => probeOne(p.tool, p.versionArgs)))
}
