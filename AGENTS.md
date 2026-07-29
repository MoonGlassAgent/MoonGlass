# AGENTS.md — MoonGlass 项目指南

## 项目定位

芯片开发全流程 AI 工作台（Electron 桌面应用）。唯一权威设计依据是根目录的
`ChipForge_Studio_Specification.md`；实现必须**独立编码**，禁止复制 Cherry Studio 源码
（仅可借鉴通用架构模式），许可证 Apache-2.0。

## 构建与检查

```bash
pnpm install
pnpm dev         # electron-vite 开发模式
pnpm build       # 构建到 out/
pnpm typecheck   # 全 workspace tsc --noEmit
```

改动后必须通过 `pnpm typecheck`；涉及构建配置的改动必须通过 `pnpm build`。

## 结构约定

- `src/shared/` —— **三端共享契约的唯一来源**：领域类型（`types/moonglass.ts`）与
  IPC 通道（`ipc-contract.ts`）。主进程 / preload / 渲染进程禁止各自硬编码通道字符串。
- `src/main/` —— 主进程。服务一律实现 `core/lifecycle.ts` 的 `MoonGlassService` 接口，
  在 `core/application.ts` 注册，在 `ipc.ts` 统一暴露 handler。
  `ai/runtime/pi/` 为 Pi Coding Agent（`@earendil-works/pi-coding-agent`）的 RPC 运行时：
  主进程 spawn `pi --mode rpc` 子进程承载 Agent 会话（JSONL 协议见 `PiRpcClient.ts`），
  Provider 由 `resources/moonglass/pi-bridge/moonglass-providers.ts` 桥接扩展注入，
  系统提示词经项目工作目录 `.pi/APPEND_SYSTEM.md` 注入。
- `src/preload/` —— 只通过 `contextBridge` 暴露 `window.moonglass`，API 形状以
  `shared/ipc-contract.ts` 的 `MoonGlassApi` 为准。
- `src/renderer/` —— React 19 + TanStack Router（代码式路由，`router.tsx`）+
  Tailwind v4（`@tailwindcss/vite`，无 tailwind.config）。页面放 `pages/`，
  可复用组件放 `components/`，全局状态用 zustand（`store/`）。
- `packages/` —— pnpm workspace 子包（`@moonglass/*`），通过 `workspace:*` 引用；
  子包直接以 TS 源码导出（无构建步骤）。
- `resources/moonglass/` —— 内置资产：IP 模板库、Lint 规则、工具链配置、外置提示词、
  pi 桥接扩展（`pi-bridge/`，启动时复制到 userData 供 pi `-e` 加载）。

## 编码规范

- TypeScript strict；ESM；命名：文件 PascalCase（类/组件）或 kebab-case（模块），
  类型/接口 PascalCase，常量 UPPER_SNAKE。
- 注释与 UI 文案使用中文；标识符使用英文。
- 未实现的能力统一 `throw new Error('NotImplemented: ...')`，并在注释中以
  `TODO(Phase N)` 标注对应规格书阶段，禁止静默返回假数据。
- 芯片领域约定：7 阶段枚举 `Phase`（REQ/SPEC/ARCH/RTL/VERIF/QA/SYNTH）定义在
  `src/shared/types/moonglass.ts`，不得在其他位置重复定义。
