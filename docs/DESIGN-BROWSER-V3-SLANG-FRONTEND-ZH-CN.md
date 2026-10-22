# RTL Design Browser v3：Slang 前端与 RTL 级数据模型设计

> 状态：设计稿，待评审
> 日期：2026-10-08
> 前置：Phase A 可用性修复包（cell pin→net 名 / 端口分组 / 缓存失效检测 / 截断显性化 / 顶层候选口径）已实施并验证

---

## 1. 背景与问题

Design Browser 当前数据管线写死在 `packages/design-browser-engine/src/elaborate.ts:200-206`：
`read_verilog -sv → hierarchy -check → proc → opt_clean → write_json`。

`proc + opt_clean` 把设计转成 Yosys 优化后的内部形态：always 块消失、信号被合并改名、
逻辑变成 `$dff`/`$mux`/`$eq` 等通用单元。后果在 trace 视图最直接——扇出列表是一堵
`CELL $eq` 墙，端点无法回答"哪段源码在用它"。这是可读性差的**根因**，Phase A 的渲染层
修复无法解决。

同时，`packages/verification-intelligence-engine/src/structural-analyzer.ts` 已用 slang
elaborated AST 独立做了一套 RTL 级结构分析（过程块/赋值/控制流），与 Design Browser 的
Yosys 管线互不共享——同一设计被两套前端解析两遍，口径各自演化。

## 2. 实证结论（2026-10-08 探针，真实项目 MoonglassNPU，10 模块）

slang 11.0.415（AIGV runtime bundled）对真实项目跑
`slang --ast-json <out> --ast-json-source-info --ignore-unknown-modules --top npu_top rtl/*.v`：

- AST 5.9MB，生成 < 1s；远低于既有 128MB 消费上限（`structural-analyzer.ts:126`）。
- 根节点 `{ design, definitions }`；每个实例有独立 elaborated `InstanceBody`
  （参数特化逐实例展开，参数实际取值免费获得）。

| v3 需要的数据 | slang AST 字段 | 实证 |
|---|---|---|
| 端口 | `Port{ name, direction: In/Out/InOut, type, internalSymbol, source_file/line }` | ✅ |
| 内部信号 | `Net{ name, type, netType.name(wire), source_* }` / `Variable{ name, type, … }` | ✅ |
| 参数 | `Parameter{ name, type, initializer(表达式树+源码区间) }` | ✅ |
| 实例及 pin 连接 | `Instance{ name, body, connections: [{ port, expr(带源码区间) }] }` | ✅ **跨层缝合的关键** |
| 模块定义链接 | `Instance.body.definition: "<addr> npu_regif"` → `definitions` | ✅ |
| 过程块 | `ProceduralBlock{ procedureKind: Always/AlwaysFF/…, body: Timed→EventList→SignalEvent(时钟/复位) }` | ✅ |
| 连续赋值 | `ContinuousAssign{ assignment: Assignment{ left, right } }` | ✅ |
| 表达式符号引用 | `NamedValue{ symbol: "<addr> <name>" }` | ✅ driver/load 推导基础 |
| 位宽 | `type` 字符串携带打包维度（`logic[3:0]`），解析即可 | ✅ |
| 源码位置 | 每个节点 `source_file/source_line(_start)` | ✅ |

**意外收获（根治病灶）**：以 cwd=工作区 + 相对路径传文件时，`source_file` 输出为
**工作区相对路径**（`rtl\npu_top.v`）——Yosys 中文路径乱码与 `repairMojibakePath` 补丁
（`DesignBrowserService.ts:36-77`）整条防线在 v3 中不复存在。

## 3. 目标与非目标

**目标**

- G1（硬口径）：trace 任意信号，端点列表每一行都能读出"哪个模块的哪段源码在驱动/使用它"，
  **零 `$` 单元名出现**。
- G2：数据模型保留 RTL 形态——源码声明的信号名、位宽、类型（wire/reg/logic）、参数、
  过程块边界。
- G3：slang 调用收敛到 `eda-bridge/tool-runner` 底座（消除 structural-analyzer 的
  私有 env/locator 副本），AST 解析结果按 rtlHash 缓存、两个消费方共享。
- G4：中文路径零特殊处理（相对路径口径，同 formal.ts 防线）。

**非目标**

- 不做门级原理图（netlistsvg 属 Phase C 候选，不在本轮）。
- 不动渲染层交互框架（三栏/历史/搜索沿用 Phase A 后的形态）。
- 不改变 verification-intelligence-engine 的产出契约（它继续消费同一份 AST，字段不动）。

## 4. DesignDatabase v3 契约

`packages/design-browser-engine/src/types.ts` 演进（`version: 3`）：

```ts
export interface DesignDatabase {
  version: 3
  topModule: string
  generatedAt: string
  rtlInputHash?: string          // Phase A 已引入，保留
  sourceFiles: string[]          // 工作区相对路径
  frontend: 'slang'              // 如实记录前端；回退时 'yosys'（见 §7）
  modules: DesignModule[]
  hierarchy: DesignInstance      // 节点新增 parameterOverrides
  diagnostics: DesignDiagnostic[]
}

export interface DesignParameter { name: string; type: string; valueText: string; source?: string }

export interface DesignModule {
  name: string                   // 定义名（参数化特化记录 displayName）
  source?: string
  parameters: DesignParameter[]  // 新增
  ports: DesignPort[]            // 新增 type（'logic[3:0]' 原文）与 source
  signals: DesignSignal[]        // 替代 nets：源码形态
  processes: DesignProcess[]     // 新增：always/assign 块级清单
  instances: DesignInstanceRef[] // 新增：实例连接表（pin→父侧表达式）
  traces: DesignSignalTrace[]    // 端点语义升级（见 §5）
}

export interface DesignSignal {
  name: string
  kind: 'wire' | 'reg' | 'logic' | 'other'
  width: number
  type: string                   // 'logic[11:0]' 原文
  source?: string
  isPort: boolean
  direction?: 'input' | 'output' | 'inout'
}

export interface DesignProcess {
  id: string                     // 模块内稳定序号 P1/P2…
  kind: 'always_ff' | 'always_comb' | 'always_latch' | 'always' | 'assign' | 'initial' | 'final'
  clock?: string                 // 从 EventList 提取
  reset?: string
  source?: string
  drives: string[]               // 写入的信号名（AST Assignment.left 推导）
  reads: string[]                // 读取的信号名（NamedValue 推导）
}

export interface DesignInstanceRef {
  name: string
  module: string
  parameterOverrides: Record<string, string>
  connections: Array<{ pin: string; direction: 'input' | 'output' | 'inout'; expr: string; signal?: string; source?: string }>
  source?: string
}
```

映射要点（slang AST → v3）：

| v3 字段 | 来源 |
|---|---|
| signals | InstanceBody.members 的 Net/Variable（Port 的 internalSymbol 去重），kind 取 netType.name/Variable lifetime |
| ports | Port 节点；宽度解析 `type` 的 `[a:b]` 区间 |
| processes | ProceduralBlock（procedureKind 映射）+ ContinuousAssign→`assign`；drives/reads 遍历 body 内 Assignment/NamedValue |
| instances[].connections | Instance.connections：pin=port.name，expr=表达式源码区间回读源文件文本，signal=expr 为纯 NamedValue 时的信号名 |
| hierarchy | design 顶层实例递归；parameterOverrides 取子 InstanceBody 的 Parameter.initializer 源文本 |
| traces | 见 §5 |

`DesignCell`/`nets` 等 v2 字段整体退役；渲染端与 trace.ts 同步迁移（见 §6、§8）。

## 5. Trace 语义 v3（核心变更）

端点类型从「port | $cell」升级为三态：

```ts
export interface DesignEndpoint {
  kind: 'port' | 'instancePin' | 'statement'
  label: string        // 'always_ff @ rtl/fcd.v:88' / 'u_regif.i_hs_haddr' / 'PORT i_hs_haddr'
  direction: 'input' | 'output' | 'inout' | 'unknown'
  source?: string
  processId?: string   // kind=statement 时指向 DesignProcess
  instancePath?: string
}
```

推导规则（模块内）：

- 信号 S 的 **drivers**：写入 S 的 statement（ContinuousAssign 的 left、ProceduralBlock 内的
  Assignment.left）+ 方向为 input/inout 的本模块端口 + 子实例方向为 output/inout 且
  连接到 S 的 pin。
- 信号 S 的 **loads**：读取 S 的 statement（表达式内 NamedValue 命中）+ 方向为
  output/inout 的本模块端口 + 子实例方向为 input/inout 且连接到 S 的 pin。
- **跨层缝合**（`trace.ts` 重写，算法骨架沿用）：statement/port 端点为本层终点；
  instancePin 端点可继续下钻——经 `Instance.connections` 进入子模块对应 Port 的信号继续展开。
  反向（子模块内部信号向上找父网）同理经 connections 反查。

与 v2 的语义差异要如实记录：v3 trace 是**语句级**（一个 always 块是一个端点），
不再是 bit 级连通图——位选/拼接的逐 bit 精确性让位于可读性；位宽不匹配等细节由
lint 链负责，Browser 不兜底。

## 6. slang 调用收敛与共享

1. `packages/eda-bridge/src/` 新增 `slang-runner.ts`：`locateTool(SLANG_CANDIDATES)` +
   `toolEnv`（复用 tool-runner 的 MinGW 隔离）+ `--ast-json` 调用 + AST 落
   `<userData>/moonglass/slang-ast-cache/<rtlHash>.json`（按 rtlHash 复用，两个消费方
   各取所需，不重复 elaborate）。
2. `structural-analyzer.ts` 删除私有 `executable()`/`analyzerEnv()`（:22-40），改调
   slang-runner；消费逻辑不变。AST 不再用完即删（缓存化），其 `analyzer.limitations`
   文案同步更新。
3. design-browser-engine 新增 `elaborate-v3.ts`：slang AST → DesignDatabase v3
   纯函数构建器（可测，不碰 fs 之外副作用）。

## 7. 回退与兼容

- slang 缺失/elaboration 失败：**回退现有 Yosys 管线**产出 v2 形态并在
  `diagnostics` 显式登记降级原因；渲染端按 `frontend` 字段双形态渲染
  （v2 形态 = Phase A 后的现状，不删旧代码路径）。
- 缓存：v3 数据库写入时 version=3；`getCached` 仅接受 version===3（v2 缓存一律
  判过期重 elaboration）；`rtlStale` 语义（Phase A）原样保留。
- IPC 通道不变（`elaborate`/`getCached` 形状不动，内部数据版本升级）。

## 8. 渲染端改造点

| 组件 | 改动 |
|---|---|
| SignalPanel | 数据源 nets→signals（isPort 分组逻辑已在 Phase A 就位，改字段名）；kind 徽标（wire/reg/logic） |
| TracePanel | 端点三态渲染：statement 端点显示 processKind 徽标 + 源码位置；PORT/CELL 徽标改 PORT/PIN/STMT |
| DesignBrowserPage Inspector | cell 详情改为 instance 详情（DesignInstanceRef：参数覆盖 + pin 连接表，pin→expr/signal）；process 详情视图（drives/reads 列表可点击跳信号） |
| HierarchyPanel | 实例节点 tooltip 显示参数覆盖 |
| 双击下钻 | instances[].name 匹配（v2 是 cells）；层次引用 `u_child.sig` 解析可在此轮补上（SourcePanel 取词支持点号路径） |

## 9. 验收标准

- **硬口径 G1**：真实项目（MoonglassNPU + CLK_DIV_FRA）trace 任意 10 个抽样信号，
  端点列表零 `$` 单元名，每行含模块名 + 源码位置，点击可跳转。
- 参数化模块（如有 $paramod 场景）实例 tooltip 显示实际参数值。
- 中文路径工作区全链路无 mojibake 修复代码路径被触发（该函数随 v3 删除）。
- `design-browser-smoke` 扩展：v3 fixture（含 always_ff/assign/参数/实例连接/位选）
  断言字段映射与 trace 端点语义；保留 v2 回退路径断言。
- `pnpm typecheck` 全过、`typecheck:root` 基线零新增、core 全绿、`pnpm build` 通过。
- 真实应用 Playwright 截图复核（沿用 Phase A 的验证方式）。

## 10. 风险与缓释

| 风险 | 缓释 |
|---|---|
| slang AST 大工程体积（>128MB） | 沿用 structural-analyzer 的体积上限口径，超限回退 Yosys 管线并登记 diagnostics |
| 表达式 → 信号名推导的边界（位选/拼接/常量/层级引用） | 保守口径：纯 NamedValue 才记 signal，其余显示 expr 源文本；宁缺毋假 |
| generate 块形态差异 | v3 首轮把 generate 内实例按 elaborated 结果平铺（slang 已展开），源码位置指向 generate 块；不做源级 generate 折叠 |
| struct/interface/class 等 SV 高级结构 | `--ignore-unknown-modules` 已有；遇不可映射成员记 diagnostics，不中断 |
| 渲染端双形态维护成本 | v2 路径冻结不再演进，v3 稳定一个版本后删除 |

## 11. 工作量估算

| 项 | 规模 |
|---|---|
| slang-runner + 缓存 + structural-analyzer 收编 | ~150 行 |
| elaborate-v3 构建器（AST→v3） | ~450 行 |
| trace.ts v3 重写 | ~150 行 |
| 渲染端迁移 | ~300 行 |
| smoke 扩展 + 真实项目验证 | — |
