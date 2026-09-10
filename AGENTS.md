# AGENTS.md — MoonGlass 项目指南

## 项目定位

芯片开发全流程 AI 工作台（Electron 桌面应用）。实现必须遵循仓库内的工程规范、阶段门禁和许可证要求；第一方代码独立编写，许可证以仓库根目录的授权文件为准。

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
  界面国际化（i18n）在 `src/renderer/i18n/`：运行时仿 `theme.ts`
  （localStorage `moonglass-locale` + CustomEvent 广播），文案资源按命名空间
  拆分为 `locales/zh-CN/<namespace>.ts`（中文为源）与 `locales/en/<namespace>.ts`
  （以 `typeof` 中文资源为类型约束），新命名空间须注册进两个 `locales/*/index.ts`。
  组件内用 `useTranslation()` 的 `t()`，纯逻辑模块直接 `import { t }`，
  插值用 `{param}`，阶段显示名用 `phaseLabel(phase)`。
- `packages/` —— pnpm workspace 子包（`@moonglass/*`），通过 `workspace:*` 引用；
  子包直接以 TS 源码导出（无构建步骤）。
- `resources/moonglass/` —— 内置资产：IP 模板库、Lint 规则、工具链配置、外置提示词、
  pi 桥接扩展（`pi-bridge/`，启动时复制到 userData 供 pi `-e` 加载）。

## 编码规范

- TypeScript strict；ESM；命名：文件 PascalCase（类/组件）或 kebab-case（模块），
  类型/接口 PascalCase，常量 UPPER_SNAKE。
- 注释使用中文；**UI 文案一律走 `src/renderer/i18n/` 资源（zh-CN 为源语言），
  禁止在组件中硬编码界面文案**；发给 Agent 的提示词与写入项目文件/报告的内容
  不受 i18n 约束，保持中文。标识符使用英文。
- 未实现的能力统一 `throw new Error('NotImplemented: ...')`，并在注释中以
  `TODO(Phase N)` 标注对应规格书阶段，禁止静默返回假数据。
- 芯片领域约定：6 阶段枚举 `Phase`（REQ_SPEC/ARCH/RTL/VERIF/QA/SYNTH）定义在
  `src/shared/types/moonglass.ts`，不得在其他位置重复定义。
