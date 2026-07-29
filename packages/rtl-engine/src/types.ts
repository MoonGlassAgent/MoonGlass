/**
 * RTL 引擎公共类型（骨架）
 */

export interface PortDef {
  name: string
  direction: 'input' | 'output' | 'inout'
  width: number
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
