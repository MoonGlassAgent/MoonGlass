# ChipForge Studio — 芯片开发全流程 AI 工作台
## 软件规格说明书（基于 Cherry Studio 代码分析）

> **版本**: v0.1-draft  
> **日期**: 2026-07-28  
> **基础**: Fork from [Cherry Studio](https://github.com/CherryHQ/cherry-studio) (AGPL-3.0)

---

## 目录

1. [Cherry Studio 真实架构解析](#1-cherry-studio-真实架构解析)
2. [ChipForge Studio 总体架构](#2-chipforge-studio-总体架构)
3. [核心模块规格](#3-核心模块规格)
   - 3.1 芯片开发流程引擎
   - 3.2 Agent 内核：Pi Coding Agent 集成
   - 3.3 提示词工程系统
   - 3.4 Python 脚本引擎
   - 3.5 代码编辑器与 EDA 集成
   - 3.6 知识库与 IP 模板库
4. [数据模型扩展](#4-数据模型扩展)
5. [UI 改造方案](#5-ui-改造方案)
6. [开发路线（MVP）](#6-开发路线mvp)
7. [关键技术决策](#7-关键技术决策)
8. [Skills 资产化落地](#8-skills-资产化落地)
9. [下一步行动](#9-下一步行动)

---

## 1. Cherry Studio 真实架构解析

基于对 [CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio) 主分支代码的深入分析，其真实技术栈如下：

| 维度 | Cherry Studio 实际实现 |
|------|------------------------|
| **框架** | Electron 41.8 + React 19 + TypeScript |
| **构建** | electron-vite + pnpm workspace monorepo |
| **路由** | TanStack Router |
| **样式** | Tailwind CSS v4 + Radix UI |
| **数据库** | better-sqlite3 + drizzle-orm（本地 SQLite） |
| **向量检索** | sqlite-vec（SQLite 扩展做 Embedding 搜索） |
| **AI SDK** | Vercel AI SDK (`ai` 包) 统一封装所有模型 |
| **Agent 内核** | `@anthropic-ai/claude-agent-sdk`（Claude Code 同款） |
| **MCP** | `@modelcontextprotocol/sdk` 原生支持 |
| **本地模型** | ONNX Runtime + HuggingFace Transformers.js |
| **文件存储** | 本地文件系统 + WebDAV/S3/局域网备份 |
| **代码编辑** | CodeMirror 6（`@uiw/react-codemirror`） |
| **文档渲染** | TipTap + Markdown-it + Mermaid |

### 核心目录结构

```
src/
├── main/           # Electron 主进程（Node.js）
│   ├── ai/         # AI 核心：Agent、MCP、推理、工具、流管理
│   │   ├── agentSession/      # Agent 会话管理
│   │   ├── agents/            # Agent 定义与调度
│   │   ├── mcp/               # MCP 服务器管理
│   │   ├── runtime/           # Agent 运行时（含 Claude Code 运行时）
│   │   ├── tools/             # 工具注册与调用
│   │   ├── skills/            # Skill 包管理
│   │   ├── inference/         # 推理引擎
│   │   ├── messages/          # 消息处理
│   │   └── streamManager/     # 流式输出管理
│   ├── core/       # 生命周期、预启动、服务注册
│   │   ├── lifecycle/         # 服务生命周期管理
│   │   ├── preboot/           # 预启动流程
│   │   └── application/       # 应用服务注册表
│   ├── data/       # 数据库、ORM、迁移
│   ├── services/   # 文件存储、备份、窗口、菜单、更新等
│   │   ├── FileStorage.ts     # 文件存储服务
│   │   ├── MainWindowService.ts # 主窗口服务
│   │   ├── PythonService.ts   # Python 执行服务
│   │   └── codeCli/           # 代码 CLI 集成
│   └── ipc.ts      # IPC 通信注册中心
├── renderer/       # 渲染进程（React）
│   ├── aiCore/     # 渲染端 AI 逻辑
│   ├── components/ # UI 组件库
│   ├── pages/      # 页面路由
│   ├── store/      # 状态管理
│   └── services/   # 前端服务层
├── preload/        # 预加载脚本
└── shared/         # 共享类型和常量
```

---

## 2. ChipForge Studio 总体架构

基于 Cherry Studio 的 monorepo 结构，采用 **Fork + 垂直领域扩展** 策略：

```
chipforge-studio/
├── packages/
│   ├── @chipforge/ai-core/        # [新增] 芯片专用 AI 内核（Python + TS 混合）
│   ├── @chipforge/rtl-engine/     # [新增] RTL 生成/解析引擎
│   ├── @chipforge/eda-bridge/     # [新增] EDA 工具桥接
│   └── @chipforge/prompts/        # [新增] 芯片提示词模板库
├── src/
│   ├── main/
│   │   ├── ai/
│   │   │   ├── agentSession/      # Agent 会话（复用 Cherry）
│   │   │   ├── agents/            # [改造] 7 阶段专用 Agent
│   │   │   ├── mcp/               # MCP 服务器（复用 Cherry）
│   │   │   ├── runtime/
│   │   │   │   └── chipforge/     # [新增] Pi Coding Agent 运行时
│   │   │   ├── tools/
│   │   │   │   └── chipforge/     # [新增] 芯片专用工具集
│   │   │   └── skills/
│   │   │       └── chipforge/     # [新增] 芯片 Skill 包
│   │   ├── core/
│   │   ├── data/
│   │   │   └── schema/
│   │   │       └── chipforge.ts   # [新增] 芯片项目数据模型
│   │   └── services/
│   │       ├── eda/               # [新增] EDA 工具服务
│   │       └── python/            # [新增] Python 脚本引擎扩展
│   └── renderer/
│       ├── pages/
│       │   └── chipforge/         # [新增] 芯片开发工作区
│       └── components/
│           └── chipforge/         # [新增] 芯片专用 UI 组件
└── resources/
    └── chipforge/                 # [新增] 内置模板、IP 库、规则文件
```

---

## 3. 核心模块规格

### 3.1 芯片开发流程引擎（状态机驱动）

在 Cherry Studio 的 `Topic`（话题）模型基础上扩展，每个芯片项目是一个 **Project**，包含 7 个 **Phase**：

```typescript
// src/shared/types/chipforge.ts

type Phase = 
  | 'REQ'   // 需求定义 (Requirements)
  | 'SPEC'  // 规格定义 (Specification)
  | 'ARCH'  // 架构设计 (Architecture)
  | 'RTL'   // RTL 开发 (RTL Implementation)
  | 'VERIF' // 验证完备 (Verification)
  | 'QA'    // 质量检查 (Quality Assurance)
  | 'SYNTH' // 综合实现 (Synthesis)

interface ChipProject {
  id: string
  name: string
  description?: string
  currentPhase: Phase
  phases: Record<Phase, PhaseState>
  gitRepo?: string              // 关联的 Git 仓库路径
  edaToolchain: string          // 工具链配置 ID
  targetProcess?: string        // 目标工艺节点（如 "12nm"）
  targetFrequency?: number      // 目标频率（MHz）
  createdAt: Date
  updatedAt: Date
}

interface PhaseState {
  status: 'locked' | 'active' | 'completed' | 'blocked'
  deliverables: Deliverable[]
  agentContext: AgentContext     // 该阶段的 Agent 上下文快照
  reviewStatus: 'pending' | 'approved' | 'rejected'
  gateCheckResults: GateCheckResult[]
  startedAt?: Date
  completedAt?: Date
}

interface Deliverable {
  id: string
  type: 'doc' | 'code' | 'script' | 'report' | 'diagram' | 'constraint'
  name: string
  filePath: string
  status: 'draft' | 'reviewing' | 'approved' | 'rejected'
  generatedBy: 'human' | 'agent' | 'hybrid'
  version: number
  gitCommit?: string
}

interface GateCheckResult {
  checkId: string               // 检查项唯一标识
  checkName: string             // 检查项名称
  passed: boolean
  severity: 'error' | 'warning' | 'info'
  message: string
  autoFixable: boolean
  fixedBy?: string              // 自动修复的 Agent/工具
}
```

#### 阶段跳转规则（门禁系统）

| 跳转 | 前置条件 | 自动检查项 |
|------|----------|------------|
| `REQ → SPEC` | 需求文档 ≥1 份 | 文档完整性、RTM（需求追溯矩阵）存在 |
| `SPEC → ARCH` | 模块规格书 + 接口定义 | 接口信号清单非空、模块划分合理 |
| `ARCH → RTL` | 架构框图 + 信号清单 | 框图可解析、时钟/复位方案定义 |
| `RTL → VERIF` | 可编译 RTL + 端口提取通过 | Verible Lint 零 Error、端口一致性检查 |
| `VERIF → QA` | 覆盖率报告 | 行覆盖 ≥90%、功能覆盖 ≥80%、仿真通过 |
| `QA → SYNTH` | Lint/CDC/代码审查通过 | Verible 零 Error、Yosys 可综合检查通过、CDC 检查通过 |
| **任意 → 回退** | 用户确认 | 警告：后续阶段产出将被标记为废弃 |

#### 状态机图示

```
┌─────┐    ┌─────┐    ┌─────┐    ┌─────┐    ┌─────┐    ┌─────┐    ┌─────┐
│ REQ │───→│SPEC │───→│ARCH │───→│ RTL │───→│VERIF│───→│ QA  │───→│SYNTH│
└─────┘    └─────┘    └─────┘    └─────┘    └─────┘    └─────┘    └─────┘
   ↑         ↑         ↑         ↑         ↑         ↑         ↑
   └─────────┴─────────┴─────────┴─────────┴─────────┴─────────┘
                        (支持回退，需确认)
```

---

### 3.2 Agent 内核：Pi Coding Agent 集成

Cherry Studio 使用 `@anthropic-ai/claude-agent-sdk` 做 Agent。ChipForge 替换/扩展为 **Pi Coding Agent**：

#### 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                    ChipForge Agent 架构                        │
├─────────────────────────────────────────────────────────────┤
│  前端 (Renderer)                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ 对话面板      │  │ 工具调用卡片  │  │ 代码预览      │      │
│  └──────────────┘  └──────────────┘  └──────────────┘      │
├─────────────────────────────────────────────────────────────┤
│  主进程 (Main)                                                │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Agent 调度器 (复用 Cherry ai/agents/)                │  │
│  │  ├─ 阶段上下文管理                                     │  │
│  │  ├─ 工具调用编排 (MCP)                                 │  │
│  │  └─ 流式输出管理 (复用 streamManager)                  │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Pi Coding Agent 运行时 (Python 子进程)               │  │
│  │  ├─ FastAPI 服务 (本地端口)                            │  │
│  │  ├─ 工具执行引擎                                       │  │
│  │  ├─ 代码执行沙箱 (Jupyter Kernel)                     │  │
│  │  └─ EDA 工具调用封装                                   │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

#### 运行时规格

| 组件 | 规格 |
|------|------|
| **进程模型** | Python 3.10+ 独立子进程，通过 IPC（WebSocket/stdio）与主进程通信 |
| **服务框架** | FastAPI（本地 HTTP 服务，端口动态分配） |
| **模型接口** | 复用 Cherry 的 Provider Registry，支持 OpenAI/Anthropic/DeepSeek/本地 Ollama |
| **上下文管理** | 项目级长期记忆（SQLite）+ 会话级短期记忆（滑动窗口） |
| **流式输出** | SSE 流式，复用 Cherry 的 `streamManager` |
| **代码执行** | Jupyter Kernel（ipykernel），支持变量持久化 |

#### 芯片专用工具集（MCP Tools）

```typescript
// src/main/ai/tools/chipforge/index.ts

const CHIPFORGE_TOOLS = [
  // ==================== RTL 工具 ====================
  {
    name: 'read_verilog',
    description: '解析 Verilog/SystemVerilog 文件，提取端口、参数、层次结构、实例化关系',
    inputSchema: {
      filePath: { type: 'string', required: true },
      extractHierarchy: { type: 'boolean', default: false }
    },
    outputSchema: {
      moduleName: 'string',
      ports: 'Port[]',
      parameters: 'Parameter[]',
      instances: 'Instance[]',
      hierarchy: 'TreeNode[]'
    }
  },
  {
    name: 'generate_rtl_template',
    description: '基于接口定义生成标准 RTL 模块框架，支持公司编码风格',
    inputSchema: {
      moduleName: { type: 'string', required: true },
      interface: { type: 'InterfaceDef', required: true },
      style: { type: "'standard' | 'company'", default: 'company' },
      companyRulesId: { type: 'string' }
    },
    outputSchema: {
      filePath: 'string',
      code: 'string',
      lintResult: 'LintResult'
    }
  },
  {
    name: 'run_verible_lint',
    description: '调用 Verible 进行代码风格检查，支持自定义规则文件',
    inputSchema: {
      filePath: { type: 'string', required: true },
      rulesFile: { type: 'string' },
      autofix: { type: 'boolean', default: false }
    },
    outputSchema: {
      passed: 'boolean',
      errors: 'LintError[]',
      warnings: 'LintWarning[]',
      fixedCode: 'string?'  // autofix=true 时返回
    }
  },
  {
    name: 'extract_interface',
    description: '从规格文档（Markdown/自然语言）提取信号接口定义',
    inputSchema: {
      specText: { type: 'string', required: true },
      busProtocol: { type: "'AXI4' | 'AXI4-Lite' | 'APB' | 'custom'" }
    },
    outputSchema: {
      signals: 'SignalDef[]',
      busType: 'string',
      confidence: 'number'
    }
  },
  {
    name: 'check_synthesizability',
    description: '使用 Yosys 检查 RTL 可综合性',
    inputSchema: {
      rtlFiles: { type: 'string[]', required: true },
      topModule: { type: 'string', required: true }
    },
    outputSchema: {
      synthesizable: 'boolean',
      issues: 'SynthesisIssue[]',
      resourceEstimate: 'ResourceEstimate'
    }
  },

  // ==================== 验证工具 ====================
  {
    name: 'generate_uvm_tb',
    description: '基于 RTL 端口自动生成 UVM testbench 框架',
    inputSchema: {
      rtlFile: { type: 'string', required: true },
      testPlan: { type: 'string' },
      coverageTarget: { type: 'number', default: 90 }
    },
    outputSchema: {
      tbFiles: 'string[]',
      agentFiles: 'string[]',
      sequenceFiles: 'string[]',
      coveragePlan: 'CoveragePlan'
    }
  },
  {
    name: 'run_simulation',
    description: '调用仿真器运行测试，支持 Verilator/VCS',
    inputSchema: {
      topModule: { type: 'string', required: true },
      testbench: { type: 'string', required: true },
      simulator: { type: "'verilator' | 'vcs' | 'xcelium'", default: 'verilator' },
      timeout: { type: 'number', default: 300 }
    },
    outputSchema: {
      passed: 'boolean',
      logPath: 'string',
      coverage: 'CoverageReport',
      waveformPath: 'string?'
    }
  },
  {
    name: 'parse_coverage',
    description: '解析覆盖率报告，生成可视化摘要',
    inputSchema: {
      coverageFile: { type: 'string', required: true },
      format: { type: "'verilator' | 'vcs' | 'urg'", required: true }
    },
    outputSchema: {
      lineCoverage: 'number',
      branchCoverage: 'number',
      toggleCoverage: 'number',
      fsmCoverage: 'number',
      uncoveredLines: 'number[]'
    }
  },

  // ==================== 综合工具 ====================
  {
    name: 'generate_sdc',
    description: '基于时钟约束规格生成 SDC 文件',
    inputSchema: {
      clockSpec: { type: 'ClockSpec', required: true },
      ioConstraints: { type: 'IOConstraint[]' }
    },
    outputSchema: {
      sdcContent: 'string',
      warnings: 'string[]'
    }
  },
  {
    name: 'run_logic_synthesis',
    description: '调用 Yosys/DC 进行逻辑综合',
    inputSchema: {
      rtlFiles: { type: 'string[]', required: true },
      sdcFile: { type: 'string' },
      targetLibrary: { type: 'string' },
      effort: { type: "'low' | 'medium' | 'high'", default: 'medium' }
    },
    outputSchema: {
      netlistPath: 'string',
      area: 'number',
      timing: 'TimingReport',
      power: 'PowerReport'
    }
  },

  // ==================== Python 工具 ====================
  {
    name: 'execute_python',
    description: '执行 Python 脚本，用于数据处理、批量生成、分析',
    inputSchema: {
      code: { type: 'string', required: true },
      timeout: { type: 'number', default: 60 },
      saveAsFile: { type: 'boolean', default: false }
    },
    outputSchema: {
      stdout: 'string',
      stderr: 'string',
      returnValue: 'any',
      savedFilePath: 'string?'
    }
  },
  {
    name: 'generate_python_script',
    description: '生成可复用的 Python 脚本文件，用于 RTL 批量生成等',
    inputSchema: {
      description: { type: 'string', required: true },
      template: { type: 'string' },
      outputPath: { type: 'string' }
    },
    outputSchema: {
      filePath: 'string',
      code: 'string',
      canExecute: 'boolean'
    }
  },

  // ==================== 知识库工具 ====================
  {
    name: 'query_ip_library',
    description: '查询内置 IP 模板库',
    inputSchema: {
      query: { type: 'string', required: true },
      category: { type: "'fifo' | 'axi' | 'arbiter' | 'clock' | 'memory' | 'all'", default: 'all' },
      processNode: { type: 'string' }
    },
    outputSchema: {
      results: 'IPTemplate[]',
      total: 'number'
    }
  },
  {
    name: 'query_company_rules',
    description: '查询公司编码规范、命名规则、综合约束',
    inputSchema: {
      ruleType: { type: "'naming' | 'style' | 'synthesis' | 'cdc' | 'all'", default: 'all' }
    },
    outputSchema: {
      rules: 'RuleEntry[]',
      version: 'string'
    }
  },
  {
    name: 'query_datasheet',
    description: '查询芯片手册、协议规范',
    inputSchema: {
      query: { type: 'string', required: true },
      docType: { type: "'protocol' | 'datasheet' | 'appnote' | 'all'", default: 'all' }
    },
    outputSchema: {
      matches: 'DocMatch[]',
      snippets: 'string[]'
    }
  }
] as const
```

---

### 3.3 提示词工程系统（分层约束）

在 Cherry Studio 的 `Assistants`（助手）系统上改造，每阶段自动注入约束：

```typescript
// packages/@chipforge/prompts/src/templates.ts

interface PromptTemplate {
  id: string
  level: 'global' | 'phase' | 'project' | 'security'
  phase?: Phase
  content: string
  injectMode: 'prepend' | 'append' | 'wrap'
  version: string
  updatedAt: Date
}

// ============================================================
// 全局约束（所有阶段生效）
// ============================================================
const GLOBAL_CONSTRAINTS: PromptTemplate = {
  id: 'cf-global-001',
  level: 'global',
  content: `你是一名专业的 ASIC/SoC 设计工程师，正在协助完成芯片设计全流程。
请严格遵守以下工程原则：

1. **可综合性**：所有 RTL 代码必须可综合，禁止使用不可综合语法（如 #delay、initial 用于综合逻辑）
2. **Latch 避免**：所有组合逻辑必须完整覆盖所有分支，避免产生 latch
3. **复位策略**：异步复位必须同步释放（async assert, sync deassert）
4. **三态门**：禁止在内部逻辑使用三态门（tri-state），仅在顶层 PAD 使用
5. **时钟域交叉**：CDC 必须通过标准同步器（2-flop synchronizer）或 FIFO 处理
6. **编码规范**：遵循公司编码规范，使用标准命名前缀（i_/o_/w_/r_）
7. **参数化设计**：关键参数必须可配置，避免硬编码魔法数字
8. **文档注释**：每个模块必须包含标准文件头（版权、作者、日期、版本历史、功能描述）`,
  injectMode: 'prepend',
  version: '1.0.0',
  updatedAt: new Date('2026-07-28')
}

// ============================================================
// 阶段约束
// ============================================================

const REQ_PHASE_CONSTRAINTS: PromptTemplate = {
  id: 'cf-phase-req-001',
  level: 'phase',
  phase: 'REQ',
  content: `当前处于【需求定义】阶段。

你的任务是：
1. 与用户深入沟通，提取功能需求、性能需求、接口需求
2. 生成结构化的需求规格书（SRS）
3. 建立需求追溯矩阵（RTM），确保每个需求可追踪
4. 识别关键性能指标：频率、面积、功耗、带宽
5. 输出格式必须为 Markdown，包含需求 ID、描述、优先级、验收标准

约束：
- 禁止在此阶段讨论具体实现细节
- 所有需求必须有明确的可验证标准
- 必须区分功能需求与非功能需求`,
  injectMode: 'prepend',
  version: '1.0.0',
  updatedAt: new Date('2026-07-28')
}

const SPEC_PHASE_CONSTRAINTS: PromptTemplate = {
  id: 'cf-phase-spec-001',
  level: 'phase',
  phase: 'SPEC',
  content: `当前处于【规格定义】阶段。

你的任务是：
1. 基于需求文档，定义模块级规格（Module Specification）
2. 明确每个模块的功能边界、接口信号、时序要求
3. 生成接口定义文档（IDD），包含信号名、位宽、方向、时钟域
4. 定义模块间通信协议

约束：
- 必须引用 REQ 阶段的输出，确保规格覆盖所有需求
- 接口信号必须使用标准命名规范
- 必须定义每个信号的时钟域归属
- 禁止在此阶段编写 RTL 代码`,
  injectMode: 'prepend',
  version: '1.0.0',
  updatedAt: new Date('2026-07-28')
}

const ARCH_PHASE_CONSTRAINTS: PromptTemplate = {
  id: 'cf-phase-arch-001',
  level: 'phase',
  phase: 'ARCH',
  content: `当前处于【架构设计】阶段。

你的任务是：
1. 设计顶层模块框图（Block Diagram）
2. 定义总线拓扑结构（AXI/APB 等）
3. 设计时钟/复位树
4. 规划存储层次与数据流
5. 生成架构设计文档（ADS）

约束：
- 必须基于 SPEC 阶段的接口定义
- 框图必须使用 Mermaid 或 ASCII 格式
- 必须标注关键路径与瓶颈分析
- 时钟域划分必须清晰标注`,
  injectMode: 'prepend',
  version: '1.0.0',
  updatedAt: new Date('2026-07-28')
}

const RTL_PHASE_CONSTRAINTS: PromptTemplate = {
  id: 'cf-phase-rtl-001',
  level: 'phase',
  phase: 'RTL',
  content: `当前处于【RTL 开发】阶段。

你的任务是：
1. 基于架构设计，编写 Verilog/SystemVerilog RTL 代码
2. 每个模块必须包含标准文件头
3. 使用参数化设计，关键参数可配置
4. 实现异步复位同步释放电路
5. 代码完成后自动调用 verible_lint 检查

编码规范：
- 输入信号前缀：i_（如 i_clk, i_rst_n）
- 输出信号前缀：o_（如 o_data_valid）
- 内部线网前缀：w_（如 w_next_state）
- 内部寄存器前缀：r_（如 r_counter）
- 参数名全大写：PARAM_NAME
- 模块名使用 snake_case

强制检查：
- 生成代码后必须调用 run_verible_lint
- Lint Error 必须修复后才能标记完成
- 必须通过 check_synthesizability 检查`,
  injectMode: 'prepend',
  version: '1.0.0',
  updatedAt: new Date('2026-07-28')
}

const VERIF_PHASE_CONSTRAINTS: PromptTemplate = {
  id: 'cf-phase-verif-001',
  level: 'phase',
  phase: 'VERIF',
  content: `当前处于【验证完备】阶段。

你的任务是：
1. 基于 RTL 端口自动生成 UVM testbench 框架
2. 编写定向测试与随机测试
3. 运行仿真并收集覆盖率
4. 分析覆盖率报告，补充测试用例直至达标

约束：
- 必须基于 RTL 阶段的端口定义
- 行覆盖率目标 ≥90%
- 分支覆盖率目标 ≥85%
- 必须包含边界条件测试
- 必须包含错误注入测试`,
  injectMode: 'prepend',
  version: '1.0.0',
  updatedAt: new Date('2026-07-28')
}

const QA_PHASE_CONSTRAINTS: PromptTemplate = {
  id: 'cf-phase-qa-001',
  level: 'phase',
  phase: 'QA',
  content: `当前处于【质量检查】阶段。

你的任务是：
1. 运行完整的 Lint 检查（Verible + 自定义规则）
2. 运行 CDC（Clock Domain Crossing）检查
3. 运行 RDC（Reset Domain Crossing）检查
4. 代码审查（Code Review）检查清单
5. 生成质量报告

门禁标准：
- Lint：零 Error，Warning 需评审
- CDC：零未同步跨时钟域信号
- RDC：零复位域问题
- 代码审查：所有检查项通过`,
  injectMode: 'prepend',
  version: '1.0.0',
  updatedAt: new Date('2026-07-28')
}

const SYNTH_PHASE_CONSTRAINTS: PromptTemplate = {
  id: 'cf-phase-synth-001',
  level: 'phase',
  phase: 'SYNTH',
  content: `当前处于【综合实现】阶段。

你的任务是：
1. 生成/优化 SDC 约束文件
2. 运行逻辑综合（Yosys/DC）
3. 分析时序报告，修复 setup/hold 违例
4. 分析面积与功耗报告
5. 生成综合实现报告

约束：
- 必须基于 QA 通过的结果
- SDC 必须覆盖所有时钟、输入/输出延迟
- 时序收敛目标：setup slack ≥ 0
- 面积与功耗需在规格范围内`,
  injectMode: 'prepend',
  version: '1.0.0',
  updatedAt: new Date('2026-07-28')
}

// ============================================================
// 安全约束
// ============================================================
const SECURITY_CONSTRAINTS: PromptTemplate = {
  id: 'cf-security-001',
  level: 'security',
  content: `安全约束：
1. 禁止在生成的 RTL 中嵌入测试后门、调试旁路
2. 禁止生成包含敏感信息（密钥、密码）的代码
3. 禁止生成可能引入安全漏洞的代码（如未初始化的状态机）
4. 所有随机数生成必须使用加密安全源
5. 扫描链设计必须遵循可测试性规范，但禁止暴露内部状态`,
  injectMode: 'append',
  version: '1.0.0',
  updatedAt: new Date('2026-07-28')
}
```

#### 提示词注入机制

```typescript
// 系统提示词组装逻辑
function buildSystemPrompt(
  phase: Phase,
  projectConstraints: PromptTemplate[],
  userCustomPrompt?: string
): string {
  const parts: string[] = []

  // 1. 全局约束（最前）
  parts.push(GLOBAL_CONSTRAINTS.content)

  // 2. 阶段约束
  const phasePrompt = getPhasePrompt(phase)
  if (phasePrompt) parts.push(phasePrompt.content)

  // 3. 项目约束
  projectConstraints
    .filter(c => c.level === 'project')
    .forEach(c => parts.push(c.content))

  // 4. 用户自定义
  if (userCustomPrompt) parts.push(userCustomPrompt)

  // 5. 安全约束（最后）
  parts.push(SECURITY_CONSTRAINTS.content)

  return parts.join('\n\n---\n\n')
}
```

---

### 3.4 Python 脚本引擎

基于 Cherry Studio 已有的 `PythonService.ts` 扩展：

| 特性 | 规格 |
|------|------|
| **运行时** | Python 3.10+，通过 `child_process.spawn` 启动独立进程 |
| **交互模式** | 类 Jupyter Notebook 的 Cell 执行（复用 `@uiw/react-codemirror`） |
| **预装库** | `cocotb`, `pyverilog`, `mako`, `jinja2`, `pandas`, `matplotlib`, `numpy`, `scipy` |
| **脚本模板** | 内置：RTL 批量生成、寄存器表生成、波形分析、覆盖率解析、SDC 生成 |
| **与 Agent 集成** | Agent 可生成 Python 脚本 → 自动执行 → 结果反馈到对话 |
| **隔离环境** | 每个项目独立 Python venv，支持 `requirements.txt` 管理 |

#### 脚本执行流程

```
Agent 生成 Python 代码
    ↓
写入项目目录下的 .chipforge/scripts/ 临时 .py 文件
    ↓
调用 PythonService 执行（带超时控制，默认 60s）
    ↓
捕获 stdout / stderr / 图像输出
    ↓
解析输出（支持 JSON / 表格 / matplotlib 图像 / 文本）
    ↓
渲染到对话面板（代码块 / 表格 / 图像）或写入文件
```

#### 内置脚本模板示例

```python
# templates/rtl_batch_generator.py
# 由 Agent 调用，基于参数化配置批量生成 RTL 模块

from mako.template import Template
import json
import os

def generate_module(module_name, params, output_dir):
    """
    基于模板生成参数化 RTL 模块
    params: {
        'data_width': 32,
        'addr_width': 16,
        'fifo_depth': 16,
        ...
    }
    """
    template_str = open('templates/rtl_module.mako').read()
    template = Template(template_str)

    rtl_code = template.render(
        module_name=module_name,
        params=params
    )

    output_path = os.path.join(output_dir, f'{module_name}.v')
    with open(output_path, 'w') as f:
        f.write(rtl_code)

    return output_path

# 由 Agent 自动填充参数后执行
if __name__ == '__main__':
    config = json.loads(os.environ['CHIPFORGE_CONFIG'])
    result = generate_module(**config)
    print(json.dumps({'generated_file': result}))
```

---

### 3.5 代码编辑器与 EDA 集成

| 特性 | 规格 |
|------|------|
| **编辑器** | CodeMirror 6（Cherry 已集成，支持多语言高亮） |
| **Verilog 支持** | 扩展 CodeMirror 语言包，支持 Verilog-2001 / SystemVerilog-2012 语法高亮、代码折叠、自动补全 |
| **Lint 实时检查** | 保存时自动调用 Verible，错误/警告标注在 gutter，支持点击跳转 |
| **波形查看** | 集成 Surfer（Rust 编写，高性能）或 GTKWave，通过外部进程调用打开 VCD/FSDB |
| **EDA 工具链配置** | 可配置工具路径：VCS、Verilator、Yosys、Design Compiler、Genus、Innovus |
| **一键运行** | 右键菜单：Run Simulation / Run Synthesis / Run Lint / Run CDC Check |
| **终端集成** | xterm.js 终端面板，支持 EDA 工具命令行交互 |

#### EDA 工具链配置格式

```json
{
  "toolchains": [
    {
      "id": "verilator-yosys",
      "name": "开源工具链 (Verilator + Yosys)",
      "simulator": {
        "type": "verilator",
        "path": "/usr/local/bin/verilator",
        "version": "5.024"
      },
      "synthesis": {
        "type": "yosys",
        "path": "/usr/local/bin/yosys",
        "libraries": ["/path/to/techlib/12nm/"]
      },
      "lint": {
        "type": "verible",
        "path": "/usr/local/bin/verible-verilog-lint",
        "rules": "/path/to/company_rules.txt"
      }
    },
    {
      "id": "synopsys-enterprise",
      "name": "Synopsys 企业工具链",
      "simulator": {
        "type": "vcs",
        "path": "/tools/synopsys/vcs/bin/vcs"
      },
      "synthesis": {
        "type": "dc",
        "path": "/tools/synopsys/dc/bin/dc_shell"
      }
    }
  ]
}
```

---

### 3.6 知识库与 IP 模板库

基于 Cherry Studio 的 `sqlite-vec` + 文档解析能力：

| 特性 | 规格 |
|------|------|
| **支持格式** | Verilog、SystemVerilog、Python、Markdown、PDF、Word、Excel、Wavedrom JSON |
| **分块策略** | 代码按模块/函数分块；文档按章节分块；PDF 按页+表格识别 |
| **向量存储** | sqlite-vec（SQLite 扩展，本地零配置，支持 ARM64/x64） |
| **Embedding 模型** | 复用 Cherry 的 `@huggingface/transformers` 本地模型或 API 模型 |
| **检索增强** | 对话时自动检索相关模块代码、规格书、历史评审记录 |
| **IP 模板库** | 内置常用 IP：FIFO、AXI 接口、仲裁器、时钟门控、DDR_BIST、PSRAM 控制器、小数分频器 |

#### IP 模板库结构

```
resources/chipforge/ip-library/
├── interface/
│   ├── axi4_master.v          # AXI4 Master 接口模板
│   ├── axi4_slave.v             # AXI4 Slave 接口模板
│   ├── axi4_lite_bridge.v      # AXI4-Lite 桥接模板
│   └── apb_slave.v             # APB Slave 接口模板
├── memory/
│   ├── async_fifo.v            # 异步 FIFO（双端口 RAM 实现）
│   ├── sync_fifo.v             # 同步 FIFO
│   ├── ddr_bist_controller.v   # DDR BIST 控制器（你的经验资产）
│   └── psram_controller.v      # PSRAM 控制器（你的经验资产）
├── clock/
│   ├── clock_gating_cell.v     # 时钟门控单元
│   ├── clock_mux.v             # 无毛刺时钟切换
│   └── frac_divider.v          # 小数分频器（你的经验资产）
├── arbiter/
│   ├── round_robin_arbiter.v   # 轮询仲裁器
│   └── priority_arbiter.v      # 优先级仲裁器
└── utility/
    ├── debounce.v              # 按键消抖
    ├── edge_detector.v         # 边沿检测
    └── pulse_extender.v        # 脉冲展宽
```

---

## 4. 数据模型扩展

在 Cherry Studio 现有 Drizzle ORM schema 上新增芯片项目相关表：

```typescript
// src/main/data/schema/chipforge.ts

import { sqliteTable, text, integer, blob, real } from 'drizzle-orm/sqlite-core'
import { relations } from 'drizzle-orm'

// ==================== 芯片项目 ====================
export const chipProjects = sqliteTable('chip_projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  currentPhase: text('current_phase', { 
    enum: ['REQ','SPEC','ARCH','RTL','VERIF','QA','SYNTH'] 
  }).notNull().default('REQ'),

  // 工程配置
  edaToolchain: text('eda_toolchain').default('verilator-yosys'),
  targetProcess: text('target_process'),        // 如 "12nm"
  targetFrequency: real('target_frequency'),   // MHz
  targetArea: real('target_area'),              // mm²
  targetPower: real('target_power'),            // mW

  // Git 集成
  gitRepoUrl: text('git_repo_url'),
  gitBranch: text('git_branch').default('main'),

  // 项目约束
  companyRulesId: text('company_rules_id'),
  customPromptId: text('custom_prompt_id'),

  // 元数据
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  createdBy: text('created_by').default('user'),
  status: text('status', { enum: ['active','archived','deleted'] }).default('active')
})

// ==================== 阶段交付物 ====================
export const phaseDeliverables = sqliteTable('phase_deliverables', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => chipProjects.id).notNull(),
  phase: text('phase', { 
    enum: ['REQ','SPEC','ARCH','RTL','VERIF','QA','SYNTH'] 
  }).notNull(),

  type: text('type', { 
    enum: ['doc','code','script','report','diagram','constraint'] 
  }).notNull(),
  name: text('name').notNull(),
  filePath: text('file_path').notNull(),

  // 版本与状态
  status: text('status', { 
    enum: ['draft','reviewing','approved','rejected'] 
  }).default('draft'),
  version: integer('version').default(1),
  generatedBy: text('generated_by', { 
    enum: ['human','agent','hybrid'] 
  }).default('human'),

  // 审查信息
  reviewedBy: text('reviewed_by'),
  reviewedAt: integer('reviewed_at', { mode: 'timestamp' }),
  reviewNotes: text('review_notes'),

  // Git 关联
  gitCommit: text('git_commit'),

  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date())
})

// ==================== 门禁检查结果 ====================
export const gateChecks = sqliteTable('gate_checks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => chipProjects.id).notNull(),
  phase: text('phase', { 
    enum: ['REQ','SPEC','ARCH','RTL','VERIF','QA','SYNTH'] 
  }).notNull(),

  checkId: text('check_id').notNull(),         // 检查项唯一标识
  checkName: text('check_name').notNull(),
  checkType: text('check_type', { 
    enum: ['lint','cdc','rdc','synthesis','coverage','review','custom'] 
  }).notNull(),

  passed: integer('passed', { mode: 'boolean' }).notNull(),
  severity: text('severity', { enum: ['error','warning','info'] }).default('info'),
  message: text('message'),
  details: text('details'),                     // JSON 详细结果

  autoFixable: integer('auto_fixable', { mode: 'boolean' }).default(false),
  autoFixed: integer('auto_fixed', { mode: 'boolean' }).default(false),
  fixedBy: text('fixed_by'),                    // Agent/工具名

  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date())
})

// ==================== Agent 对话记录 ====================
export const agentConversations = sqliteTable('agent_conversations', {
  id: text('id').primaryKey(),
  projectId: text('project_id').references(() => chipProjects.id).notNull(),
  phase: text('phase').notNull(),

  // 模型信息
  modelId: text('model_id').notNull(),
  providerId: text('provider_id').notNull(),

  // 对话内容
  messages: blob('messages', { mode: 'json' }).notNull(),      // Message[]
  toolCalls: blob('tool_calls', { mode: 'json' }),             // ToolCall[]

  // 上下文快照
  contextSnapshot: blob('context_snapshot', { mode: 'json' }), // 阶段上下文

  // 性能指标
  tokenUsage: blob('token_usage', { mode: 'json' }),           // {input, output}
  latency: integer('latency'),                                  // ms

  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date())
})

// ==================== 提示词模板 ====================
export const promptTemplates = sqliteTable('prompt_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  level: text('level', { enum: ['global','phase','project','security'] }).notNull(),
  phase: text('phase', { 
    enum: ['REQ','SPEC','ARCH','RTL','VERIF','QA','SYNTH'] 
  }),
  content: text('content').notNull(),
  injectMode: text('inject_mode', { enum: ['prepend','append','wrap'] }).default('prepend'),
  version: text('version').default('1.0.0'),
  isActive: integer('is_active', { mode: 'boolean' }).default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).$defaultFn(() => new Date())
})

// ==================== 关系定义 ====================
export const chipProjectRelations = relations(chipProjects, ({ many }) => ({
  deliverables: many(phaseDeliverables),
  gateChecks: many(gateChecks),
  conversations: many(agentConversations)
}))
```

---

## 5. UI 改造方案

基于 Cherry Studio 的现有界面，做以下改造：

### 5.1 左侧导航栏改造

```
Cherry Studio 原版：
┌──────────┐
│ [助手]   │  ← 通用 AI 助手列表
│ [话题]   │  ← 对话话题
│ [小程序] │  ← MiniApp（各种 AI 应用）
│ [文件]   │  ← 文件管理
│ [知识库] │  ← 知识库管理
└──────────┘

ChipForge 改造：
┌──────────┐
│ [项目]   │  ← 芯片项目列表（替代"助手"）
│ [阶段]   │  ← 当前项目的 7 阶段导航
│ [IP库]   │  ← 内置 IP 模板库
│ [脚本]   │  ← Python 脚本管理
│ [知识库] │  ← 项目知识库（复用）
│ [终端]   │  ← EDA 工具终端
│ [设置]   │  ← 工具链/规则配置
└──────────┘
```

### 5.2 项目面板

- 芯片项目列表（类似 Cherry 的助手列表）
- 每个项目卡片显示：
  - 项目名称 + 当前阶段标签
  - 进度条（7 阶段完成度）
  - 最近更新时间
  - 质量门禁状态（绿/黄/红）
- 点击项目 → 进入该项目的阶段工作区

### 5.3 阶段工作区（核心界面）

```
┌────────────────────────────────────────────────────────────────────────────┐
│  项目：DDR_BIST_Controller    阶段：RTL开发 ▶    模型：Claude-4-Sonnet    │
├──────────┬─────────────────────────────────────────────────────────────────┤
│          │  阶段进度导航栏                                                 │
│  项目    │  REQ ✓  →  SPEC ✓  →  ARCH ✓  →  [RTL ▶]  →  VERIF  →  QA   │
│  文件树  │         ↑ 已锁定    ↑ 已锁定    ↑ 进行中    ↓ 未解锁        │
│          │                                                               │
│  📁 rtl/ │  ┌─────────────────────────────────────────────────────────┐│
│  📄 ddr_ │  │ 🤖 Agent: RTL Engineer                                    ││
│    bist. │  │                                                           ││
│    v     │  │ 正在生成 DDR_BIST 控制器 RTL 代码...                      ││
│  📄 tb/  │  │                                                           ││
│          │  │ ```verilog                                                ││
│          │  │ module ddr_bist_controller #(                             ││
│          │  │   parameter ADDR_WIDTH = 32,                              ││
│          │  │   parameter DATA_WIDTH = 64                               ││
│          │  │ ) (                                                       ││
│          │  │   input  wire              i_clk,                         ││
│          │  │   input  wire              i_rst_n,                       ││
│          │  │   // AXI4-Lite interface                                  ││
│          │  │   input  wire              i_axi_awvalid,                 ││
│          │  │   output wire              o_axi_awready,                 ││
│          │  │   ...                                                     ││
│          │  │ );                                                        ││
│          │  │ ```                                                       ││
│          │  │                                                           ││
│          │  │ [✅ Lint 检查通过] [⚠️ 2 Warnings] [📋 查看详情]        ││
│          │  └─────────────────────────────────────────────────────────┘│
│          │                                                               │
│          ├─────────────────────────────────────────────────────────────────┤
│          │  底部面板（Tab 切换）                                         │
│          │  [🐍 Python] [📊 Lint] [🔬 仿真] [📈 波形] [📝 日志]        │
│          │  ┌─────────────────────────────────────────────────────────┐│
│          │  │ >>> # 运行覆盖率分析                                      ││
│          │  │ >>> import pandas as pd                                 ││
│          │  │ >>> df = pd.read_csv('coverage_report.csv')             ││
│          │  │ >>> print(df.head())                                    ││
│          │  └─────────────────────────────────────────────────────────┘│
├──────────┴─────────────────────────────────────────────────────────────────┤
│  Git: main ↑1 ↓0  │  Lint: 0E/2W  │  Coverage: 92%  │  ⏱️ 仿真: Ready   │
└────────────────────────────────────────────────────────────────────────────┘
```

### 5.4 阶段看板（新增组件）

- 7 个阶段节点横向排列（顶部导航栏）
- 节点样式：
  - ⬜ 灰色：未开始（locked）
  - 🔵 蓝色：进行中（active）
  - 🟢 绿色：已完成（completed）
  - 🔴 红色：有阻塞问题（blocked）
- 节点间箭头显示跳转条件提示
- 点击节点 → 切换该阶段工作区（需满足前置条件）
- 悬停显示阶段摘要：交付物数量、完成度、阻塞项列表

---

## 6. 开发路线（MVP）

基于 Cherry Studio 的 AGPL-3.0 协议，合法 Fork 并二次开发：

| 阶段 | 周期 | 工作内容 | 产出 |
|------|------|----------|------|
| **Phase 0** | 1 周 | Fork Cherry Studio，清理无关功能（小程序、绘画、翻译面板），保留核心对话+文件+知识库骨架 | 可运行的基础框架 |
| **Phase 1** | 2 周 | 新增芯片项目数据模型（Project/Phase/Deliverable），改造左侧导航为项目+阶段视图，实现基础阶段切换 | 项目创建+阶段导航可用 |
| **Phase 2** | 2 周 | 集成 Pi Coding Agent（Python 子进程 + IPC），实现基础工具调用（文件读写、Shell、Python 执行） | Agent 可执行工具 |
| **Phase 3** | 2 周 | 7 阶段流程引擎 + 门禁检查系统，提示词模板系统（全局+阶段+安全） | 阶段流转+约束生效 |
| **Phase 4** | 2 周 | 芯片专用工具集：Verible Lint、Yosys 可综合检查、接口提取、UVM TB 生成 | RTL 工具链可用 |
| **Phase 5** | 2 周 | IP 模板库 + 知识库种子内容（导入 DDR_BIST、PSRAM、AXI 等模块） | 内置资产可用 |
| **Phase 6** | 持续 | EDA 工具链深度集成（VCS/DC）、团队协作、CI/CD 对接、企业级功能 | 生产就绪 |

---

## 7. 关键技术决策

| 决策项 | 方案 | 理由 |
|--------|------|------|
| **基础框架** | Fork Cherry Studio 二次开发 | 节省 6 个月基础工作量；AGPL-3.0 允许开源二次开发；已有成熟的多模型支持、文件系统、备份、国际化等基础设施 |
| **Agent 内核** | Python 子进程（Pi Coding Agent） | 芯片 EDA 工具生态以 Python/CLI 为主；与 Cherry 的 MCP 架构无缝集成；Jupyter Kernel 提供稳定代码执行 |
| **数据库** | 复用 better-sqlite3 + drizzle-orm | Cherry 已成熟使用；sqlite-vec 提供本地向量搜索；零配置、单文件、易备份 |
| **代码编辑** | CodeMirror 6（复用 Cherry） | 已集成多种语言高亮；可扩展 Verilog 模式；性能优于 Monaco（大文件场景） |
| **Python 执行** | child_process.spawn + ipykernel | 比嵌入 V8 更稳定；支持复杂科学计算库；与 Jupyter 生态兼容 |
| **EDA 调用** | MCP 协议封装为 Tools | 与 Cherry 的 MCP 架构原生兼容；工具可独立开发测试；支持远程 EDA 服务器 |
| **向量检索** | sqlite-vec（复用 Cherry） | 零配置本地运行；SQLite 事务一致性；支持 ARM64/x64 多平台 |
| **构建工具** | electron-vite + pnpm（复用） | Cherry 已验证的构建方案；支持热更新、代码分割、多平台打包 |

---

## 8. Skills 资产化落地

| 你的经验 | 在 ChipForge 中的具体落地位置 | 形式 |
|----------|------------------------------|------|
| **DDR_BIST Verilog 开发** | `resources/chipforge/ip-library/memory/ddr_bist_controller.v` | 参考模板 + 生成示例 |
| **Python 自动生成 RTL** | `packages/@chipforge/rtl-engine/templates/` + 内置脚本模板 | 可执行脚本模板 |
| **AXI4 总线协议** | `resources/chipforge/ip-library/interface/` + AXI Agent 提示词 | IP 模板 + 约束提示词 |
| **Verible Lint 经验** | `resources/chipforge/rules/verible_company_rules.txt` | 默认 Lint 规则文件 |
| **NPU/端侧芯片架构** | `resources/chipforge/templates/npu_design_flow/` | 设计流程模板 |
| **ASIC IP 全流程** | 7 阶段流程引擎默认配置 + 门禁检查项 | 系统默认配置 |
| **PSRAM 控制器** | `resources/chipforge/ip-library/memory/psram_controller.v` | 参考模板 |
| **12nm/ODIO/PLL 经验** | `resources/chipforge/constraints/12nm_process.sdc` + 工艺约束模板 | 约束模板库 |
| **小数分频器/PLL 缓调频** | `resources/chipforge/ip-library/clock/frac_divider.v` | 参考模板 |

---

## 9. 下一步行动

1. **Fork Cherry Studio** → `git clone https://github.com/CherryHQ/cherry-studio.git chipforge-studio`
2. **跑通开发环境** → `pnpm install && pnpm dev`，熟悉代码结构
3. **清理无关功能** → 删除 `src/renderer/src/pages/` 下的小程序、绘画、翻译相关页面
4. **新增芯片项目模型** → 在 `src/main/data/schema/` 添加 `chipforge.ts`
5. **改造左侧导航** → 将"助手"改为"项目"，实现项目列表+阶段切换
6. **集成 Python 执行** → 扩展 `PythonService.ts`，支持 Jupyter Kernel 模式
7. **植入第一个 Skill** → 将 DDR_BIST 模块作为 IP 模板导入，测试 RTL 生成流程

---

> **备注**: 本规格基于对 Cherry Studio v2.0.0-beta.3 代码库的实际分析编写。所有技术选型均参考其真实依赖与架构设计，确保 Fork 后的可实施性。
