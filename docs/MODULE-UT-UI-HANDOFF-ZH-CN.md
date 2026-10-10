# 模块 UT 功能：渲染端交接说明（给 UI 团队）

| 项目 | 内容 |
|---|---|
| 日期 | 2026-10-10 |
| 状态 | **主进程侧已落地**（`agent:start-module-ut`，契约见 `src/shared/ipc-contract.ts`） |
| 背景设计 | docs/MODULE-UT-DESIGN-ZH-CN.md（请先读 §1 定位与 §4 互斥口径） |

## 一句话背景

验证阶段新增「模块级轻量 UT」：对某个 RTL 子模块发起一个独立子会话，搭最简环境快速
迭代验证（证据隔离，不进主验证证据链）。主进程负责派发/互斥/恢复，**渲染端只需补
入口与状态呈现**。

## 需要 UI 做的三件事

### 1. 「发起模块 UT」入口按钮（必需）

- 建议位置：验证运行卡（VerifRunPanel）操作区，或 RTL 修复卡旁。
- 交互：点击 → 弹窗输入/选择模块名（下拉候选 = 项目 `rtl/*.v` 模块名清单；
  若清单读取需要新 IPC，主进程侧可加 `listRtlModules`，未落地前先用自由输入框）。
- 可用性：仅 VERIF 阶段可用；UT 进行中/主循环运行中可并发（不同模块并行 UT 合法）。
- 调用（契约以 ipc-contract.ts 落地为准——**已落地**，注意在 `agent` 命名空间下）：
  `window.moonglass.agent.startModuleUt(projectId: string, moduleName: string): Promise<{ utId: string }>`
- 错误呈现：同名模块 UT 已在跑、模块不存在、主循环处于不可互斥状态时会 reject，
  消息可直接红条透出。

### 2. UT 进行中的状态呈现（必需）

- 主进程会发 status 消息（既有 agent 事件流，无需新通道）：
  派发时「模块 UT 已派发：<module>（独立会话）」；结束时「模块 UT 完成：<module>」。
- UT 会话本身是一个平行会话标签页（复用现有会话标签机制，会话名形如
  `phase-verif--ut-<module>`，无需额外开发）。
- 验证运行卡区域建议显示一行轻量状态：「模块 UT 进行中（N 个）：<模块名列表>——
  主循环互斥挂起中」。数据源：轮询/订阅 `verification/results/ut-sessions.json`
  （`active` 计数），或复用既有 run-loop 账本推送（以主进程落地为准）。

### 3. 软建议提示（可选增强，首期可不做）

主进程会在「同一 RTL 文件短期被修复 ≥2 次」时发 status 消息：
「模块 <X> 修复密集，建议发起一次模块 UT」。渲染端可选：把这条消息升级为带
「发起 UT」按钮的卡片。首期做成普通消息也可接受。

## 工程约束

- 文案一律走 i18n（zh-CN 为源，en 同步），新键放合适命名空间（建议 `verifRun` 或
  `workspace`），禁止硬编码。
- 本功能渲染端改动与你们在途的 VerifRunPanel/WorkspacePage 改动同区域，注意合流。
- ⚠️ 修订（2026-10-10）：API 在 **`agent` 命名空间**下——`window.moonglass.agent.startModuleUt(...)`，
  不是顶层 `window.moonglass.startModuleUt(...)`。若已按顶层接入，改一行调用即可。
- 联调验证：dev 起项目 → 对 MIC_NPU 或 GMAC 项目发起 UT → 观察会话标签页、
  主循环挂起提示、UT 结束后主循环可恢复。

## 明确不做（防范围蔓延）

- 不做 UT 结果的图形化报告页（产物是 md 报告，文件树可点开）。
- 不做 UT 用例的 UI 编辑器。
- 不做 UT 与主证据链的任何可视化关联（设计上两者刻意隔离）。
