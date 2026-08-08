# MoonGlass 项目总体报告

> 报告日期：2026-08-03
> 版本：v0.3.0
> 当前阶段：Phase 4（RTL / 验证）
> 授权：历史报告生成时仓库曾标注 Apache-2.0；当前授权以根目录 `LICENSE` 和 `LICENSE-CHANGE.md` 为准

---

## 1. 项目定位

MoonGlass 是面向 **ASIC/SoC 设计工程师** 的 AI 工作台桌面应用，以 **6 阶段芯片开发流程引擎** 为核心：

```
REQ_SPEC → ARCH → RTL → VERIF → QA → SYNTH
```

将 LLM Agent、提示词分层约束、Python 脚本引擎与 EDA 工具链（Verible / Yosys / Verilator 等）整合到同一个 Electron 桌面应用中。

设计依据：`ChipForge_Studio_Specification.md`。

与 Cherry Studio 的关系：架构思想借鉴（Electron 主/渲染分层、侧边栏导航、服务生命周期、IPC 契约等通用模式），但**全部代码独立编写，不含 Cherry Studio 源码，不受其 AGPL-3.0 约束**。

---

## 2. 技术栈

| 层级 | 技术 |
|------|------|
| 桌面框架 | Electron 41.10 + electron-vite |
| 包管理 | pnpm 11 workspace |
| 前端 | React 19 + TanStack Router + Tailwind CSS v4 |
| 状态管理 | zustand |
| 主进程 | Node.js / TypeScript ESM |
| Agent 运行时 | Pi Coding Agent (`@earendil-works/pi-coding-agent`) RPC 模式 |
| 数据库 | better-sqlite3 + drizzle-orm |
| EDA 桥接 | 自研 `@moonglass/eda-bridge` |
| RTL 引擎 | 自研 `@moonglass/rtl-engine` |
| 提示词 | 自研 `@moonglass/prompts` |

---

## 3. 工程结构

```
MoonGlass/
├── packages/                   # pnpm workspace 子包
│   ├── eda-bridge/             # EDA 工具链抽象（lint/synthesis/simulation/detect）
│   ├── rtl-engine/             # Verilog 解析与模板生成
│   └── prompts/                # 提示词分层约束系统
├── resources/moonglass/        # 内置资产
│   ├── ip-library/             # IP 模板库（含 axi_lite_timer smoke 样例）
│   ├── rules/                  # Lint / 编码规则（占位）
│   ├── pi-bridge/              # Pi 桥接扩展
│   └── toolchains.json         # 工具链配置
├── scripts/                    # 冒烟测试与辅助脚本
├── src/
│   ├── main/                   # Electron 主进程
│   │   ├── ai/runtime/pi/      # Pi RPC 客户端
│   │   ├── core/               # 生命周期、服务注册、路径
│   │   ├── data/               # 数据库连接、迁移、schema
│   │   ├── services/           # 业务服务
│   │   ├── ipc.ts              # IPC handler 注册中心
│   │   └── index.ts            # 入口
│   ├── preload/                # contextBridge 暴露 window.moonglass
│   ├── renderer/               # React 前端
│   │   ├── pages/              # 页面
│   │   ├── components/         # 可复用组件
│   │   ├── store/              # zustand 全局状态
│   │   └── router.tsx          # 代码式路由
│   └── shared/                 # 三端共享契约
│       ├── ipc-contract.ts     # IPC 通道与 API 形状
│       ├── types/              # 领域类型
│       └── llm-provider-presets.ts
├── electron-builder.yml        # 打包配置
├── electron.vite.config.ts     # 构建配置
├── package.json
├── pnpm-workspace.yaml
└── tsconfig*.json
```

---

## 4. 核心架构

### 4.1 进程分层

| 进程 | 职责 | 关键文件 |
|------|------|---------|
| 主进程 (main) | 业务服务、数据库、文件系统、EDA 调用、Pi 子进程管理 | `src/main/` |
| 渲染进程 (renderer) | UI、用户交互、状态展示 | `src/renderer/` |
| Preload | 类型化 IPC 桥接，仅暴露 `window.moonglass` | `src/preload/index.ts` |
| Pi 子进程 | LLM Agent 推理、工具调用、会话管理 | `@earendil-works/pi-coding-agent/dist/cli.js` |

### 4.2 服务生命周期

所有服务实现 `MoonGlassService` 接口，在 `src/main/core/application.ts` 统一注册：

```ts
export interface MoonGlassService {
  readonly name: string
  start(): void
  stop(): void
}
```

注册顺序：

```
DbService → ProjectService → PhaseEngine → PythonService →
EdaService → LlmProviderService → AgentModelStore → AgentService → FileService
```

### 4.3 IPC 契约

所有通道字符串集中在 `src/shared/ipc-contract.ts`：

- `Project.*`：项目 CRUD
- `Phase.*`：阶段推进/回退/门禁
- `Eda.*`：工具链探测
- `Python.*`：脚本执行
- `Llm.*`：Provider 配置
- `Agent.*`：Agent 会话、消息、模型切换
- `Fs.*`：项目文件树、读取、打开外部

禁止在三端硬编码通道字符串。

### 4.4 Pi 运行时集成

- 主进程通过 `PiRpcClient` 与 `pi --mode rpc` 子进程以 JSONL 协议通信。
- Pi 通过 `-e` 参数加载 MoonGlass 桥接扩展：
  - `moonglass-providers.ts`：将 UI 配置的 Provider 注册到 pi。
  - `moonglass-tools.ts`：注册芯片专用工具（lint / 综合 / 仿真 / CDC / 测试台生成等）。
- 桥接扩展运行时被复制到 `userData/moonglass/pi-bridge/`：
  - 原因：pi 子进程无法解析 `workspace:*` 包。
  - `packages/eda-bridge/src/` 中的共享实现也被复制到 `userData/moonglass/pi-bridge/eda-bridge/`。

### 4.5 数据持久化

当前实现：

- 全局项目索引：`userData/moonglass/moonglass.db`（better-sqlite3）
- 项目元数据：`chip_projects` 表
- 阶段状态：`phases_json` JSON 列（临时方案）
- 门禁历史：`gate_checks` 表
- Agent 会话：`userData/moonglass/pi-sessions/<projectId>/session.jsonl`
- Provider 配置：`userData/moonglass/llm-providers.json`
- pi 全局配置隔离：`userData/moonglass/pi-agent/`

后续需迁移到项目目录：见第 8 章。

---

## 5. 已完成功能

### 5.1 基础工程

- [x] Electron + React + pnpm workspace monorepo
- [x] 类型化 IPC 与 Preload 桥接
- [x] 服务生命周期管理
- [x] Tailwind v4 + Prism 代码高亮
- [x] 代码式路由（TanStack Router）

### 5.2 项目与阶段引擎

- [x] 6 阶段状态机（REQ_SPEC/ARCH/RTL/VERIF/QA/SYNTH），保留需求-规格矩阵
- [x] 项目 CRUD
- [x] 阶段推进/回退
- [x] 门禁检查（Lint / 可综合性 / 简单 CDC）
- [x] 门禁结果落库
- [x] 文件树浏览与文件内容查看

### 5.3 Agent 与 LLM

- [x] Pi Coding Agent RPC 嵌入
- [x] 多 Provider 配置（OpenAI-compatible / Anthropic）
- [x] 模型选择持久化
- [x] Provider API Key 测试连接
- [x] Agent 工具集：7 个芯片专用工具
- [x] 系统提示词注入（`.pi/APPEND_SYSTEM.md`）
- [x] Prompt Templates（`/verify` 等）
- [x] IP 模板库统一索引注入 Agent 系统提示词

### 5.4 EDA 工具链

- [x] Verible Lint 解析
- [x] Yosys 可综合性检查
- [x] Verilator 仿真
- [x] AXI-Lite Timer 样例 RTL lint + Icarus 仿真 smoke
- [x] 工具链自动探测
- [x] Windows 路径解析修复

### 5.5 RTL 引擎

- [x] Verilog 端口/参数解析
- [x] 模块模板生成
- [x] Wrapper 生成
- [x] 位宽保留
- [x] IP 库本地目录导入、用户自定义名称/类型、自动扫描索引

### 5.6 打包与分发

- [x] electron-builder 配置
- [x] Windows nsis 安装包
- [x] better-sqlite3 原生模块 Electron 重建
- [x] pi-coding-agent / pi-bridge / ip-library / rules 随包分发

---

## 6. 待完成与后续路线图

### 6.1 Phase 4 收尾

- [ ] 项目数据跟随工程目录迁移（高优先级，用户强烈需求）
- [ ] Agent 会话可观测性（日志、token 统计、当前模型展示）
- [ ] 修复 / 完善 Windows / macOS / Linux 打包流程

### 6.2 Phase 5

- [ ] IP 模板库内容继续填充（已具备本地导入/索引与 `axi_lite_timer` 首个 smoke 样例）
- [ ] 知识库与本地 RAG（sqlite-vec）
- [ ] 公司/团队规则管理
- [ ] 工具链路径自定义配置

### 6.3 Phase 6

- [ ] 真实逻辑综合网表生成（当前 `runLogicSynthesis` 为桩）
- [ ] SDC 约束生成
- [ ] 后端工程文件输出

### 6.4 Phase 7+（长期）

- [ ] 多 Agent 协作与子 Agent
- [ ] 自动 Git checkpoint
- [ ] WebDAV / S3 / 局域网备份
- [ ] 自动更新（electron-updater）
- [ ] 团队协作与权限管理

---

## 7. 构建与开发指南

### 7.1 环境要求

- Node.js ≥ 22
- pnpm ≥ 10
- Python 3.10+（脚本引擎可选）
- Verible / Yosys / Verilator（EDA 功能可选）

### 7.2 常用命令

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm dev

# 构建产物到 out/
pnpm build

# 全 workspace 类型检查
pnpm typecheck

# 根项目类型检查
pnpm typecheck:root

# 打包安装包到 dist/
pnpm dist

# better-sqlite3 原生模块重建
pnpm rebuild:electron   # 用于开发/打包
pnpm rebuild:node      # 用于 Node 冒烟测试
```

### 7.3 冒烟测试

```bash
node scripts/db-migration-smoke.mjs
pnpm smoke:ip-library
node scripts/eda-gate-smoke.mjs
pnpm smoke:axi-lite-timer
node scripts/pi-tools-smoke.mjs
node scripts/rtl-engine-smoke.mjs
```

**注意**：执行 `pnpm dist` 后，`better-sqlite3` 会被切到 Electron ABI；此时若跑 Node 冒烟测试，需要先 `pnpm rebuild:node`。反之，打包前需要 `pnpm rebuild:electron`。

### 7.4 打包产物

- 安装包：`dist/MoonGlass Setup 0.3.0.exe`
- 免安装版：`dist/win-unpacked/MoonGlass.exe`

---

## 8. 关键决策与注意事项

### 8.1 数据目录设计

当前项目相关数据（数据库、会话、工作区）放在 `userData/moonglass/`。这是早期简化实现，**不符合最终产品预期**。后续团队应优先实现：

1. 创建项目时选择工程目录。
2. 将项目级数据库、交付物、会话文件迁移到 `<工程目录>/.moonglass/`。
3. 全局 `userData` 仅保留：
   - 最近打开的项目索引
   - 应用级设置
   - pi 全局配置隔离目录 `pi-agent/`

### 8.2 Pi 桥接扩展

- Pi 子进程不能解析 workspace 包，因此桥接文件和 `eda-bridge` 共享代码在运行时被复制到 `userData/moonglass/pi-bridge/`。
- 任何新增的被 pi 使用的共享代码，都必须不依赖 workspace 包，并通过相对路径导入。
- 修改 `resources/moonglass/pi-bridge/` 或 `packages/eda-bridge/src/` 后，需要重新打包或确保开发时文件被复制。

### 8.3 Provider 认证

- 当前仅支持 API Key 方式。
- 启动 pi 时屏蔽了 40+ 个 Provider 环境变量，避免用户环境变量意外覆盖 UI 配置。
- 添加新 Provider 时：
  - 更新 `src/shared/llm-provider-presets.ts`。
  - 在 `moonglass-providers.ts` 中考虑 `authHeader` 与 `thinkingFormat`。

### 8.4 代码规范

- TypeScript strict，ESM。
- 文件命名：类/组件 PascalCase，模块 kebab-case。
- 类型/接口 PascalCase，常量 UPPER_SNAKE。
- 注释与 UI 文案中文，标识符英文。
- 未实现能力统一 `throw new Error('NotImplemented: ...')` 并标注 `TODO(Phase N)`。

---

## 9. 风险与建议

| 风险 | 影响 | 建议 |
|------|------|------|
| better-sqlite3 ABI 切换容易出错 | 打包后无法启动 | 建立 CI 流程，在 `postinstall` 中默认 Electron ABI，Node 测试单独处理 |
| 数据仍放在 userData | 项目迁移/协作困难 | 作为最高优先级重构 |
| Pi 子进程调试困难 | Agent 问题难定位 | 增加日志落盘与日志查看器 |
| 安装包未正式签名 | 分发受阻 | 配置代码签名证书 |
| 仅验证 Windows | macOS/Linux 可能异常 | 增加跨平台 CI 与测试 |

---

## 10. 联系人 / 交接说明

- 当前代码仓库：`D:/Projects/ASIC_Flow/MoonGlass`
- 主要入口：
  - 主进程：`src/main/index.ts`
  - 渲染进程：`src/renderer/main.tsx`
  - 路由：`src/renderer/router.tsx`
  - 服务注册：`src/main/core/application.ts`
  - IPC 契约：`src/shared/ipc-contract.ts`
- 规格书：`ChipForge_Studio_Specification.md`
- 开发指南：`README.md`

后续团队接手时，建议按以下顺序：

1. 通读 `README.md` 与 `ChipForge_Studio_Specification.md`。
2. 跑通 `pnpm install → pnpm typecheck → pnpm build → pnpm dist`。
3. 跑通 4 个冒烟测试。
4. 优先处理"项目数据跟随工程目录"重构。
5. 根据规格书逐步补齐 Phase 5/6/7 功能。
