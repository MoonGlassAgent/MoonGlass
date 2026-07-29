/**
 * Verilog/SystemVerilog 解析（骨架桩）
 *
 * TODO(Phase 4): 基于正则/树解析器提取模块端口、参数、实例化关系；
 * 可评估复用 pyverilog（经 PythonService）或 node 侧解析库。
 */

import type { ModuleInfo } from './types'

export interface ParseOptions {
  filePath: string
  extractHierarchy?: boolean
}

export async function parseVerilog(_options: ParseOptions): Promise<ModuleInfo> {
  throw new Error('NotImplemented: parseVerilog 将在 Phase 4（芯片专用工具集）实现')
}
