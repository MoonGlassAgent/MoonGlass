/**
 * 芯片专用工具集注册表（文档参照）
 *
 * 依据规格书 §3.2 定义全部工具的名称 / 描述 / 输入模式。
 *
 * Phase 4 注：handler 已不在本文件实现。真实芯片工具以 Pi 扩展形式
 * 注入 Agent 运行时（resources/moonglass/pi-bridge/moonglass-tools.ts），
 * 由 AgentService start() 复制到 userData 并通过 pi -e 加载。
 * 当前已在 pi 扩展中实现的工具：
 *   - run_verible_lint（含 verible/verilator 回退 + autofix）
 *   - check_synthesizability（yosys check + stat 解析）
 *   - read_verilog（端口/参数提取）
 *   - collect_rtl_files（工作区 RTL 扫描）
 *   - generate_tb / run_simulation（旧式 Verilator C++ 验证链）
 *   - generate_sdc / run_logic_synthesis（约束与综合）
 *   - run_cdc_check（CDC 静态检查）
 */

export type ToolCategory = 'rtl' | 'verification' | 'synthesis' | 'python' | 'knowledge'

export interface MoonglassToolDef {
  name: string
  category: ToolCategory
  description: string
  /** JSON Schema（简化记录，供未来 MCP 暴露使用） */
  inputSchema: Record<string, unknown>
  /** 工具执行入口（骨架：全部未实现） */
  handler: (args: Record<string, unknown>) => Promise<unknown>
}

function stub(name: string) {
  return async (): Promise<never> => {
    throw new Error(`NotImplemented: 工具 ${name} 将在 Phase 4（芯片专用工具集）实现`)
  }
}

function def(
  name: string,
  category: ToolCategory,
  description: string,
  inputSchema: Record<string, unknown>
): MoonglassToolDef {
  return { name, category, description, inputSchema, handler: stub(name) }
}

export const MOONGLASS_TOOLS: readonly MoonglassToolDef[] = [
  // ==================== RTL 工具 ====================
  def('collect_rtl_files', 'rtl', '按 rtl/design.json 与 rtl/filelist.f 收集有序设计源文件', {
    type: 'object',
    properties: {
      includeTestbench: { type: 'boolean', default: false }
    }
  }),
  def('read_verilog', 'rtl', '解析 Verilog/SystemVerilog 文件，提取端口、参数、层次结构、实例化关系', {
    type: 'object',
    properties: {
      filePath: { type: 'string' },
      extractHierarchy: { type: 'boolean', default: false }
    },
    required: ['filePath']
  }),
  def('generate_rtl_template', 'rtl', '基于接口定义生成标准 RTL 模块框架，支持公司编码风格', {
    type: 'object',
    properties: {
      moduleName: { type: 'string' },
      interface: { type: 'object' },
      style: { type: 'string', enum: ['standard', 'company'], default: 'company' },
      companyRulesId: { type: 'string' }
    },
    required: ['moduleName', 'interface']
  }),
  def('run_verible_lint', 'rtl', '调用 Verible 进行代码风格检查，支持自定义规则文件', {
    type: 'object',
    properties: {
      filePath: { type: 'string' },
      rulesFile: { type: 'string' },
      autofix: { type: 'boolean', default: false }
    },
    required: ['filePath']
  }),
  def('extract_interface', 'rtl', '从规格文档（Markdown/自然语言）提取信号接口定义', {
    type: 'object',
    properties: {
      specText: { type: 'string' },
      busProtocol: { type: 'string', enum: ['AXI4', 'AXI4-Lite', 'APB', 'custom'] }
    },
    required: ['specText']
  }),
  def('check_synthesizability', 'rtl', '使用 Yosys 检查 RTL 可综合性', {
    type: 'object',
    properties: {
      rtlFiles: { type: 'array', items: { type: 'string' } },
      topModule: { type: 'string' }
    },
    required: ['rtlFiles', 'topModule']
  }),

  // ==================== 验证工具 ====================
  def('generate_tb', 'verification', '基于 RTL 端口生成旧式 Verilator C++ testbench；规范 Cocotb 项目应使用 cocotb-verification 技能', {
    type: 'object',
    properties: {
      rtlFile: { type: 'string' },
      testPlan: { type: 'string' },
      coverageTarget: { type: 'number', default: 90 }
    },
    required: ['rtlFile']
  }),
  def('run_simulation', 'verification', '调用仿真器运行测试，支持 Verilator/VCS', {
    type: 'object',
    properties: {
      topModule: { type: 'string' },
      testbench: { type: 'string' },
      simulator: { type: 'string', enum: ['verilator', 'vcs', 'xcelium'], default: 'verilator' },
      timeout: { type: 'number', default: 300 }
    },
    required: ['topModule', 'testbench']
  }),
  def('run_cdc_check', 'rtl', '检查设计中的跨时钟域路径并输出 rtlqa/cdc 报告', {
    type: 'object',
    properties: {
      rtlFiles: { type: 'array', items: { type: 'string' } },
      topModule: { type: 'string' }
    }
  }),

  // ==================== 综合工具 ====================
  def('generate_sdc', 'synthesis', '基于时钟约束规格生成 SDC 文件', {
    type: 'object',
    properties: {
      clockSpec: { type: 'object' },
      ioConstraints: { type: 'array' }
    },
    required: ['clockSpec']
  }),
  def('run_logic_synthesis', 'synthesis', '调用 Yosys/DC 进行逻辑综合', {
    type: 'object',
    properties: {
      rtlFiles: { type: 'array', items: { type: 'string' } },
      sdcFile: { type: 'string' },
      targetLibrary: { type: 'string' },
      effort: { type: 'string', enum: ['low', 'medium', 'high'], default: 'medium' }
    },
    required: ['rtlFiles']
  }),

  // ==================== Python 工具 ====================
  def('execute_python', 'python', '执行 Python 脚本，用于数据处理、批量生成、分析', {
    type: 'object',
    properties: {
      code: { type: 'string' },
      timeout: { type: 'number', default: 60 },
      saveAsFile: { type: 'boolean', default: false }
    },
    required: ['code']
  }),
  def('generate_python_script', 'python', '生成可复用的 Python 脚本文件，用于 RTL 批量生成等', {
    type: 'object',
    properties: {
      description: { type: 'string' },
      template: { type: 'string' },
      outputPath: { type: 'string' }
    },
    required: ['description']
  }),

  // ==================== 知识库工具 ====================
  def('query_ip_library', 'knowledge', '查询内置 IP 模板库', {
    type: 'object',
    properties: {
      query: { type: 'string' },
      category: { type: 'string', enum: ['fifo', 'axi', 'arbiter', 'clock', 'memory', 'all'], default: 'all' },
      processNode: { type: 'string' }
    },
    required: ['query']
  }),
  def('query_company_rules', 'knowledge', '查询公司编码规范、命名规则、综合约束', {
    type: 'object',
    properties: {
      ruleType: { type: 'string', enum: ['naming', 'style', 'synthesis', 'cdc', 'all'], default: 'all' }
    }
  }),
  def('query_datasheet', 'knowledge', '查询芯片手册、协议规范', {
    type: 'object',
    properties: {
      query: { type: 'string' },
      docType: { type: 'string', enum: ['protocol', 'datasheet', 'appnote', 'all'], default: 'all' }
    },
    required: ['query']
  })
] as const

export const CHIPFORGE_TOOL_NAMES: readonly string[] = MOONGLASS_TOOLS.map((t) => t.name)

export function getTool(name: string): MoonglassToolDef | undefined {
  return MOONGLASS_TOOLS.find((t) => t.name === name)
}
