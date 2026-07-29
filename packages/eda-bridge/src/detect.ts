/**
 * EDA 工具探测
 *
 * 在系统 PATH 中探测常用 EDA 工具并尝试获取版本号。
 * 本模块为骨架阶段唯一提供真实功能的 EDA 能力。
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ToolDetection } from '@shared/types'

const execFileAsync = promisify(execFile)

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
  const locator = process.platform === 'win32' ? 'where' : 'which'
  try {
    const { stdout } = await execFileAsync(locator, [tool], { timeout: 5000 })
    const toolPath = stdout.trim().split(/\r?\n/)[0]
    let version: string | undefined
    try {
      const ver = await execFileAsync(tool, versionArgs, { timeout: 5000 })
      version = (ver.stdout || ver.stderr).trim().split(/\r?\n/)[0]
    } catch {
      // 版本获取失败不影响探测结果
    }
    return { tool, found: true, path: toolPath, version }
  } catch {
    return { tool, found: false }
  }
}

/** 探测全部已注册的 EDA 工具 */
export async function detectToolchain(): Promise<ToolDetection[]> {
  return Promise.all(TOOL_PROBES.map((p) => probeOne(p.tool, p.versionArgs)))
}
