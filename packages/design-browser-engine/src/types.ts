export interface DesignPort {
  name: string
  direction: 'input' | 'output' | 'inout'
  width: number
  bits: string[]
}

export interface DesignNet {
  name: string
  width: number
  bits: string[]
  source?: string
}

export interface DesignEndpoint {
  kind: 'port' | 'cell'
  name: string
  pin: string
  direction: 'input' | 'output' | 'inout' | 'unknown'
}

export interface DesignSignalTrace {
  net: string
  bits: string[]
  drivers: DesignEndpoint[]
  loads: DesignEndpoint[]
}

export interface DesignCell {
  name: string
  type: string
  source?: string
  isInstance: boolean
  connections: Record<string, string[]>
}

export interface DesignModule {
  name: string
  source?: string
  ports: DesignPort[]
  nets: DesignNet[]
  cells: DesignCell[]
  traces: DesignSignalTrace[]
}

export interface DesignInstance {
  path: string
  name: string
  module: string
  parentPath?: string
  source?: string
  children: DesignInstance[]
}

export interface DesignDiagnostic {
  severity: 'error' | 'warning' | 'info'
  message: string
}

export interface DesignDatabase {
  version: 1
  topModule: string
  generatedAt: string
  sourceFiles: string[]
  modules: DesignModule[]
  hierarchy: DesignInstance
  diagnostics: DesignDiagnostic[]
}

export interface ElaborateOptions {
  rtlFiles: string[]
  topModule: string
  outputJson: string
  includeDirs?: string[]
  defines?: string[]
}
