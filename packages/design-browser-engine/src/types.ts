/**
 * Design Database 契约。
 *
 * v3（slang 前端，RTL 级数据模型）为本轮主体；v2（Yosys 管线）冻结保留作为
 * slang 缺失 / elaboration 失败时的回退形态，渲染端按 `version` / `frontend`
 * 双形态渲染。共享部分（DesignInstance / DesignDiagnostic / 顶层字段）两版一致。
 */

// ---------- v2（Yosys 回退形态，冻结不再演进） ----------

export interface DesignPortV2 {
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

export interface DesignEndpointV2 {
  kind: 'port' | 'cell'
  name: string
  pin: string
  direction: 'input' | 'output' | 'inout' | 'unknown'
  source?: string
  cellType?: string
}

export interface DesignSignalTraceV2 {
  net: string
  bits: string[]
  drivers: DesignEndpointV2[]
  loads: DesignEndpointV2[]
}

export interface DesignCell {
  name: string
  type: string
  source?: string
  isInstance: boolean
  connections: Record<string, string[]>
}

export interface DesignModuleV2 {
  name: string
  source?: string
  ports: DesignPortV2[]
  nets: DesignNet[]
  cells: DesignCell[]
  traces: DesignSignalTraceV2[]
}

// ---------- v3（slang 前端，RTL 级数据模型） ----------

export interface DesignParameter {
  name: string
  type: string
  /** 实际取值源文本（实例特化时指向参数覆盖点，如 `8`） */
  valueText: string
  source?: string
}

export interface DesignPort {
  name: string
  direction: 'input' | 'output' | 'inout'
  width: number
  /** slang type 原文（如 `logic[3:0]`）；未提供时为 undefined */
  type?: string
  source?: string
}

/** 源码形态信号（Net / Variable，端口以 isPort 标记并保留在列表中） */
export interface DesignSignal {
  name: string
  kind: 'wire' | 'reg' | 'logic' | 'other'
  width: number
  /** slang type 原文（如 `reg[7:0]`） */
  type: string
  source?: string
  isPort: boolean
  direction?: 'input' | 'output' | 'inout'
}

export interface DesignProcess {
  /** 模块内稳定序号 P1/P2…（按源码位置排序） */
  id: string
  kind: 'always_ff' | 'always_comb' | 'always_latch' | 'always' | 'assign' | 'initial' | 'final'
  /** 从 EventList 提取（过程块无显式时钟时为空） */
  clock?: string
  reset?: string
  source?: string
  /** 写入的信号名（Assignment.left 推导，位选取基名） */
  drives: string[]
  /** 读取的信号名（表达式 NamedValue 推导） */
  reads: string[]
}

export interface DesignInstanceConnection {
  pin: string
  direction: 'input' | 'output' | 'inout'
  /** 连接表达式源码文本（位选/拼接等保守回读原文） */
  expr: string
  /** 表达式为纯 NamedValue 时的信号名；其余形态为 undefined（宁缺毋假） */
  signal?: string
  source?: string
}

export interface DesignInstanceRef {
  name: string
  module: string
  /** 参数实际取值（子实例体 Parameter.initializer 源文本） */
  parameterOverrides: Record<string, string>
  connections: DesignInstanceConnection[]
  source?: string
}

/**
 * v3 trace 端点（三态）：
 * - port：本模块端口（label = `PORT <name>`）；statement/port 为本层终点
 * - instancePin：子实例 pin（label = `<inst>.<pin>`），可跨层下钻/反查
 * - statement：过程块/assign 语句（label = `<kind> @ <file>:<line>`），指向 processId
 *
 * 端点 label 由构建器按固定格式生成，trace.ts 依此解析跨层引用（builder 与
 * trace 同包同版本演进，label 即契约的一部分）。
 */
export interface DesignEndpoint {
  kind: 'port' | 'instancePin' | 'statement'
  label: string
  direction: 'input' | 'output' | 'inout' | 'unknown'
  source?: string
  /** kind=statement 时指向所在 DesignProcess.id */
  processId?: string
  /** kind=instancePin 时为实例名单段（模块内相对），跨层展开时拼到当前实例路径 */
  instancePath?: string
}

export interface DesignSignalTrace {
  net: string
  width: number
  drivers: DesignEndpoint[]
  loads: DesignEndpoint[]
}

export interface DesignModule {
  name: string
  source?: string
  parameters: DesignParameter[]
  ports: DesignPort[]
  signals: DesignSignal[]
  processes: DesignProcess[]
  instances: DesignInstanceRef[]
  traces: DesignSignalTrace[]
}

// ---------- 共享 ----------

export interface DesignInstance {
  path: string
  name: string
  module: string
  parentPath?: string
  source?: string
  definitionSource?: string
  /** v3：参数实际取值（实例 tooltip / 详情展示） */
  parameterOverrides?: Record<string, string>
  children: DesignInstance[]
}

export interface DesignDiagnostic {
  severity: 'error' | 'warning' | 'info'
  message: string
}

export interface DesignDatabaseV2 {
  version: 2
  frontend: 'yosys'
  topModule: string
  generatedAt: string
  sourceFiles: string[]
  modules: DesignModuleV2[]
  hierarchy: DesignInstance
  diagnostics: DesignDiagnostic[]
  /** 本次 elaboration 的 RTL 输入内容哈希（路径 + 内容），用于缓存失效检测；旧缓存无此字段 */
  rtlInputHash?: string
}

export interface DesignDatabaseV3 {
  version: 3
  frontend: 'slang'
  topModule: string
  generatedAt: string
  sourceFiles: string[]
  modules: DesignModule[]
  hierarchy: DesignInstance
  diagnostics: DesignDiagnostic[]
  rtlInputHash?: string
}

export type DesignDatabase = DesignDatabaseV2 | DesignDatabaseV3

export interface ElaborateOptions {
  rtlFiles: string[]
  topModule: string
  outputJson: string
  includeDirs?: string[]
  defines?: string[]
}
