/**
 * RTL 模板生成（骨架桩）
 *
 * TODO(Phase 4): 基于接口定义 + 编码规范生成标准 RTL 模块框架，
 * 生成后自动联动 @moonglass/eda-bridge 的 Lint 检查。
 */

import type { ModuleInfo } from './types'

export type RtlStyle = 'standard' | 'company'

export interface GenerateOptions {
  moduleName: string
  interface: Pick<ModuleInfo, 'ports' | 'parameters'>
  style?: RtlStyle
  companyRulesId?: string
}

export interface GenerateResult {
  filePath: string
  code: string
}

export async function generateRtlTemplate(_options: GenerateOptions): Promise<GenerateResult> {
  throw new Error('NotImplemented: generateRtlTemplate 将在 Phase 4（芯片专用工具集）实现')
}
