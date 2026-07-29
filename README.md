# MoonGlass — 芯片开发全流程 AI 工作台

MoonGlass 是一个面向 ASIC/SoC 设计工程师的 AI 工作台：以 **7 阶段开发流程引擎**（REQ → SPEC → ARCH → RTL → VERIF → QA → SYNTH）为骨架，将 LLM Agent、提示词分层约束、Python 脚本引擎与 EDA 工具链（Verible / Yosys / Verilator …）整合进同一个桌面应用。

> 设计依据：[`ChipForge_Studio_Specification.md`](./ChipForge_Studio_Specification.md)

## 与 Cherry Studio 的关系

MoonGlass 在**架构思想**上借鉴了 [Cherry Studio](https://github.com/CherryHQ/cherry-studio)（Electron 主/渲染进程分层、侧边栏导航交互、服务生命周期管理、IPC 契约中心等业界通用模式），但 **全部代码独立编写，不包含 Cherry Studio 的任何源码，也不是其 Fork**。因此本项目不受 Cherry Studio AGPL-3.0 的传染性约束，采用 **Apache-2.0** 许可证。

## 当前状态：v0.1 架构骨架

| 模块 | 状态 |
|------|------|
| monorepo 工程（electron-vite + pnpm workspace） | ✅ 可用 |
| 核心领域类型（`src/shared/types`） | ✅ 完整定义 |
| 提示词分层约束系统（`@moonglass/prompts`） | ✅ 完整实现 |
| 项目 CRUD + 7 阶段状态机推进/回退（IPC 全链路） | ✅ 可用（JSON 文件存储） |
| Python 脚本引擎（spawn + 超时） | ✅ 最小可用 |
| EDA 工具探测（`@moonglass/eda-bridge`） | ✅ 可用 |
| 阶段看板 / 项目卡片 / 6 大页面 | ✅ 骨架 UI |
| Lint / 仿真 / 综合 / RTL 生成等芯片工具 | 🚧 桩（Phase 4） |
| LLM Provider 接入与 Agent 对话 | 🚧 占位（Phase 2） |
| drizzle schema（§4 全部 5 张表） | 📐 已定义，未接线 |

## 快速开始

```bash
pnpm install
pnpm dev        # 开发模式（electron-vite，HMR）
pnpm build      # 产物构建（out/）
pnpm typecheck  # 全 workspace 类型检查
```

要求：Node ≥ 22，pnpm ≥ 10。可选：Python 3.10+（脚本引擎）、Verible / Yosys / Verilator（EDA 功能）。

## 目录结构

```
├── packages/
│   ├── prompts/      # @moonglass/prompts  —— 全局/阶段/安全分层提示词 + buildSystemPrompt()
│   ├── rtl-engine/   # @moonglass/rtl-engine —— RTL 解析/模板生成（桩）
│   └── eda-bridge/   # @moonglass/eda-bridge —— EDA 工具封装（探测可用，其余为桩）
├── src/
│   ├── shared/       # 领域类型 + IPC 通道契约（三端共享的唯一契约源）
│   ├── main/         # Electron 主进程：core(lifecycle/application) services ai ipc
│   ├── preload/      # contextBridge 类型化 API（window.moonglass）
│   └── renderer/     # React 19 + TanStack Router + Tailwind v4：6 页面 + PhaseBoard
└── resources/moonglass/  # IP 模板库骨架 / Verible 默认规则 / 工具链配置样例
```

## 开发路线

见规格书 §6。骨架之后的优先级：① LLM Provider + Agent 对话闭环 → ② 门禁检查接入真实 EDA 工具 → ③ IP 模板库内容导入 → ④ better-sqlite3 + drizzle 接线（schema 已备好）。
