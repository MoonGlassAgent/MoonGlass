/**
 * RTL 引擎公共类型（骨架）
 */

export interface PortDef {
  name: string
  direction: 'input' | 'output' | 'inout'
  /** 解析后的位宽（标量=1；向量=msb-lsb+1） */
  width: number
  /** 原始位宽表达式（如 [WIDTH-1:0]），保留用于参数化宽度 */
  widthSpec?: string
  clockDomain?: string
  description?: string
}

export interface ParameterDef {
  name: string
  defaultValue: string
  description?: string
}

export interface InstanceDef {
  instanceName: string
  moduleName: string
  connections: Record<string, string>
}

export interface ModuleInfo {
  moduleName: string
  ports: PortDef[]
  parameters: ParameterDef[]
  instances: InstanceDef[]
}
