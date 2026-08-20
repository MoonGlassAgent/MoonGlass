# MoonGlass ASIC Design Agent - 芯片开发全流程 AI 工作台

MoonGlass 是一个面向 ASIC/SoC 设计工程师的 AI 工作台：以 **6 阶段开发流程引擎**（REQ_SPEC → ARCH → RTL → VERIF → QA → SYNTH）为骨架，将 LLM Agent、提示词分层约束、Python 脚本引擎与 EDA 工具链（Verible / Yosys / Verilator …）整合进同一个桌面应用。

> 设计依据：[`ChipForge_Studio_Specification.md`](./ChipForge_Studio_Specification.md)

## 与 Cherry Studio 的关系

MoonGlass 在**架构思想**上参考了 Electron 桌面应用的通用工程模式，包括主/渲染进程分层、侧边栏导航、服务生命周期管理与 IPC 契约中心。MoonGlass 第一方代码独立编写，不包含 Cherry Studio 源码，也不是其 Fork。第三方组件适用各自许可证。

## 当前状态：v0.5.0

| 模块 | 状态 |
|------|------|
| monorepo 工程（electron-vite + pnpm workspace） | ✅ 可用 |
| 核心领域类型（`src/shared/types`） | ✅ 完整定义 |
| 提示词分层约束系统（`@moonglass/prompts`） | ✅ 完整实现 |
| 项目 CRUD + 6 阶段状态机、双击进入与变更影响传播（IPC 全链路） | ✅ 可用（SQLite + JSON 备份） |
| LLM Provider 配置与 Agent 对话闭环（Pi RPC） | ✅ 可用 |
| EDA 工具探测与门禁检查（Lint / Yosys / 简单 CDC） | ✅ Phase 3 已接入 |
| 工作区分栏 UI / 文件树 / Monaco 代码查看 / Markdown 预览 | ✅ 可用 |
| 一键托管（自动决策、门禁修复、阶段推进与报告） | ✅ v0.5.0 新增 |
| 已有项目导入与实际阶段恢复 | ✅ v0.5.0 新增 |
| Python 脚本引擎（spawn + 超时） | ✅ 最小可用 |
| Agent 芯片专用工具集（lint / 综合 / 仿真 / CDC / 测试台生成） | ✅ 7 个工具已注册 |
| RTL 解析与模板生成（`@moonglass/rtl-engine`） | ✅ Phase 4 已实现 |
| 逻辑综合网表生成（`runLogicSynthesis`） | ✅ 已实现（Yosys，支持目标 Liberty 与通用综合） |
| IP 模板库内容 | ✅ 支持内置/本地 IP 库索引，已有 `utility/axi_lite_timer` smoke 样例 |
| 知识库（RAG） | 🚧 持续开发 |
| better-sqlite3 + drizzle 数据库接线 | ✅ 已实现（ProjectService + 门禁历史） |
| Electron 打包分发（electron-builder） | ✅ 已配置，可生成安装包 |

## 快速开始

```bash
pnpm install
pnpm dev              # 开发模式（electron-vite，HMR）
pnpm build            # 产物构建（out/）
pnpm typecheck        # 全 workspace 类型检查
pnpm smoke:ip-library # IP 库服务：内置库扫描 + 用户库导入索引冒烟
pnpm smoke:axi-lite-timer # AXI-Lite Timer 样例 RTL lint + Icarus 仿真冒烟
pnpm dist             # 打包安装包（dist/）

# better-sqlite3 是原生模块：
# - 开发前需要编译到 Electron ABI：pnpm rebuild:electron
# - Node 冒烟测试前需要编译到系统 Node ABI：pnpm rebuild:node
```

要求：Node ≥ 22，pnpm ≥ 10。可选：Python 3.10+（脚本引擎）、Verible / Yosys / Verilator（EDA 功能）。

更详细的总体说明与交接文档见 [`reports/overall-report.md`](./reports/overall-report.md) 和 [`reports/progress-report.md`](./reports/progress-report.md)。

## 目录结构

```
├── packages/
│   ├── prompts/      # @moonglass/prompts  —— 全局/阶段/安全分层提示词 + buildSystemPrompt()
│   ├── rtl-engine/   # @moonglass/rtl-engine —— RTL 解析/模板生成（已实现）
│   └── eda-bridge/   # @moonglass/eda-bridge —— EDA 工具封装（探测/Lint/可综合已可用）
├── src/
│   ├── shared/       # 领域类型 + IPC 通道契约（三端共享的唯一契约源）
│   ├── main/         # Electron 主进程：core(lifecycle/application) services ai ipc
│   ├── preload/      # contextBridge 类型化 API（window.moonglass）
│   └── renderer/     # React 19 + TanStack Router + Tailwind v4：6 页面 + PhaseBoard
└── resources/moonglass/  # IP 模板库（含 axi_lite_timer 样例）/ Verible 默认规则 / 工具链配置样例
```

## 授权

MoonGlass 是 **Source Available** 软件，不是 OSI 定义的 Open Source 软件。

- 非商业用途：遵循 [PolyForm Noncommercial License 1.0.0](./LICENSE)。
- 商业用途：企业内部商业研发、客户交付、收费服务、流片、量产及其他预期商业应用，须事先取得单独的书面授权。
- 商用方案与参考价格：见 [COMMERCIAL-LICENSE.md](./COMMERCIAL-LICENSE.md)。
- 历史授权边界：见 [LICENSE-CHANGE.md](./LICENSE-CHANGE.md)。
- 第三方组件：见 [THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md)。

用户合法输入的需求、规格、RTL、验证资产和设计输出归用户或其权利人所有。嵌入输出的 MoonGlass 代码、模板及第三方组件仍受各自许可证约束。

商用授权、定制开发与安全问题联系：`moonglassagent@126.com`。

## 使用手册

中文实用手册见 [docs/USER-MANUAL-ZH-CN.md](./docs/USER-MANUAL-ZH-CN.md)。软件内也可从左侧“关于”查看授权摘要、快速流程和联系方式。
