# MoonGlass 阶段性开发总结 — v0.1 架构骨架

> **日期**：2026-07-28
> **阶段**：Phase 0–1（架构骨架）
> **依据**：`ChipForge_Studio_Specification.md`
> **结论**：骨架目标全部达成，工程可编译、可启动、核心链路可用。

---

## 1. 本阶段目标

按照已批准的开发计划，完成 MoonGlass（芯片开发全流程 AI 工作台）的**架构骨架**：
monorepo 工程结构、核心领域类型、主进程服务骨架、渲染端页面/路由骨架、提示词系统、
EDA 桥接桩代码。要求 `pnpm install → typecheck → build → dev` 全链路通过。

## 2. 关键技术决策

| 决策项 | 结论 | 理由 |
|--------|------|------|
| 第一方实现 | 独立编码，遵循仓库工程规范 | 当前授权以仓库根目录授权文件为准 |
| 应用形态 | Electron 桌面应用（主/渲染/preload 三端） | 与规格书一致，贴合桌面 EDA 工具链调用场景 |
| 产品命名 | MoonGlass，直接初始化于 `D:\tools\MoonGlass\` | 用户确认 |
| 技术栈 | Electron 41 + React 19 + electron-vite + pnpm workspace + TanStack Router + Tailwind v4 + zustand | 面向桌面 EDA 工具链调用场景的标准工程选型 |
| 数据持久化 | 骨架期 JSON 文件存储；drizzle schema（§4 五张表）先定义、暂缓接线 | 避免 better-sqlite3 原生编译阻塞骨架进度 |
| workspace 包分发 | `@moonglass/*` 以 TS 源码直接导出，主进程打包时内联（不外置） | 避免 Node ESM 对无扩展名/TS 源的解析问题 |

## 3. 交付内容

### 3.1 工程基座
- pnpm monorepo：根工程 + 3 个 workspace 子包（`packages/prompts`、`rtl-engine`、`eda-bridge`）
- electron-vite 三端构建配置（main / preload / renderer）、tsconfig 矩阵、Tailwind v4（`@tailwindcss/vite`）

### 3.2 已真实可用的功能
| 功能 | 位置 | 说明 |
|------|------|------|
| 提示词分层约束系统 | `packages/prompts` | 规格书 §3.3 完整实现：全局 + 6 阶段 + 安全约束模板，`buildSystemPrompt()` 五段式组装 |
| 核心领域类型 | `src/shared/types` | §3.1/§3.5 全量类型：Phase、ChipProject、PhaseState、Deliverable、GateCheckResult、ToolchainConfig 等 |
| IPC 通道契约 | `src/shared/ipc-contract.ts` | 三端唯一契约源，preload 暴露类型化 `window.moonglass` |
| 项目 CRUD + 阶段流转 | `ProjectService` / `PhaseEngine` | 6 阶段状态机推进/回退、§3.1 门禁规则表常量，IPC 全链路走通，JSON 持久化 |
| Python 脚本引擎 | `PythonService` | spawn + 超时控制，脚本页可直接运行冒烟验证 |
| EDA 工具探测 | `packages/eda-bridge/detect.ts` | PATH 扫描 verilator/yosys/verible 等并取版本，设置页一键探测 |
| 骨架 UI | `src/renderer` | 侧边栏导航 + 6 页面（项目/工作区/IP库/脚本/知识库/设置）+ PhaseBoard 四态阶段看板 + ProjectCard 进度卡片 |

### 3.3 桩与占位（统一 `throw NotImplemented` + `TODO(Phase N)` 标注）
- 芯片专用工具集注册表：§3.2 全部 15 个工具的名称/描述/inputSchema 已注册，handler 为桩
- Lint / 可综合检查 / 仿真 / 逻辑综合（`eda-bridge`）、RTL 解析 / 模板生成（`rtl-engine`）
- 6 阶段 Agent descriptor（§3.2 每阶段 Agent 的提示词 ID + 工具白名单已定义）
- LLM Provider 接入、Agent 对话流式输出、MCP、向量知识库、波形查看、IP 库模板内容

## 4. 验证结果

| 验证项 | 结果 |
|--------|------|
| `pnpm install` | ✅（Electron 41.10.3 / React 19.2 / electron-vite 5.0 等版本全部真实解析） |
| `pnpm -r typecheck` + 根 tsc | ✅ 全部通过，零错误 |
| `pnpm build` | ✅ main 12.85 kB / preload 1.23 kB / renderer 772 kB |
| `pnpm dev` 启动 | ✅ 4 个服务全部 started（project / phase-engine / python / eda），窗口正常渲染，无运行时报错 |

## 5. 过程中解决的问题

1. **pnpm 11 配置迁移**：`package.json` 的 `pnpm.onlyBuiltDependencies` 字段已被 pnpm 11 弃用且
   会导致 `ERR_PNPM_IGNORED_BUILDS` 非零退出 → 迁移到 `pnpm-workspace.yaml` 并补充
   `dangerouslyAllowAllBuilds: true`，electron / esbuild postinstall 正常执行。
2. **主进程外置 workspace 包导致模块解析失败**：`externalizeDepsPlugin` 默认外置全部
   dependencies，Node ESM 无法加载 TS 源码包 →
   `exclude: ['@moonglass/eda-bridge', '@moonglass/prompts', '@moonglass/rtl-engine']` 改为随主进程打包。
3. **环境发现**：本机未全局安装 pnpm（此前探测到的 11.9.0 实为 npm 版本号），构建期统一使用
   `npx pnpm`；建议用户 `npm i -g pnpm` 一次到位。

## 6. 当前架构一览

```
D:\tools\MoonGlass\
├── packages/
│   ├── prompts/      # @moonglass/prompts   提示词分层约束（完整实现）
│   ├── rtl-engine/   # @moonglass/rtl-engine RTL 解析/生成（桩）
│   └── eda-bridge/   # @moonglass/eda-bridge EDA 封装（探测可用，其余桩）
├── src/
│   ├── shared/       # 领域类型 + IPC 契约（三端唯一契约源）
│   ├── main/         # core(lifecycle/application) services ai(agents/tools) data(schema) ipc
│   ├── preload/      # contextBridge → window.moonglass
│   └── renderer/     # 6 页面 + PhaseBoard + ProjectCard + zustand store
├── resources/moonglass/  # IP 库目录骨架 / Verible 默认规则 / toolchains.json / 外置提示词预留
└── docs/             # 本总结
```

## 7. 遗留事项与下一阶段计划

按 README 开发路线，优先级排序：

0. **API Key 加密存储**（已记录待办）：LLM Provider 的 API Key 当前明文存于
   `userData/moonglass/llm-providers.json`，后续迁移到 electron safeStorage 加密
   （代码位置 `src/main/services/LlmProviderService.ts` 的 `TODO(Phase 2)`）。
1. **LLM Provider 注册表 + Agent 对话闭环**（Phase 2）：多 Provider（OpenAI/Anthropic/DeepSeek/Ollama）、
   SSE 流式输出、`buildSystemPrompt()` 按阶段注入。
2. **门禁检查接入真实 EDA 工具**（Phase 3–4）：`run_verible_lint`、`check_synthesizability` 优先，
   本机 Verible/Yosys/Verilator 已就绪，环境无障碍。
3. **IP 模板库内容导入**（Phase 5）：DDR_BIST、PSRAM、AXI、小数分频器等规格书 §8 资产落地。
4. **better-sqlite3 + drizzle 接线**（Phase 1 收尾）：schema 已备好，替换 JSON 存储并补迁移。
5. 工程增强：`pnpm approve-builds` 策略复核、electron-builder 打包配置、ESLint/Prettier。

---

*本总结对应代码状态：v0.1（架构骨架），全部验证通过。*
