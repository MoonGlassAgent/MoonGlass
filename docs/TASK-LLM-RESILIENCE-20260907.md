# 任务：LLM 调用韧性三修（停滞检测 + 错误语义化 + 切换探活）

> 背景：用户在 MoonGlass（Electron 应用）中切换到一个欠费的模型服务（SiliconFlow 402），
> 现象是长时间无任何响应，很久后才收到裸的 "402 status code (no body)"。
> 本任务加固 LLM 调用链的错误体验。代码基线：分支 feature/rtl-design-browser。

## 严格约束

- 只改下列涉及的文件；注释用中文、标识符用英文；不做顺手重构。
- IPC 通道常量只能加在 `src/shared/ipc-contract.ts`，preload 只经 contextBridge 暴露。
- 工作区可能有他人未提交改动：`git status` 先检查，提交时只暂存你改的文件。
- 验证：`pnpm typecheck`（5 个包全过；根应用 `npx tsc --noEmit -p tsconfig.json`
  保持恰好 11 个历史错误，不得新增）；`node scripts/run-tests.mjs core` 全过。

## 修复 1：LLM 停滞检测（最重要，坑最多）

文件：`src/main/services/AgentService.ts`

- **关键坑**：`run_simulation` 等工具刻意不设超时，工具执行期间长时间没有事件是
  **合法的**。停滞检测的判定条件必须是：会话 `isStreaming === true`
  **且当前没有工具在执行**（最近一次 `tool_execution_start` 已有对应
  `tool_execution_end`），且距最后一个任何事件超过 120 秒。
  事件入口在 `handlePiEvent`（约 :1895），在这里维护 `lastEventAt` 与
  `toolInFlight` 计数即可。
- 实现：prompt 发出后开始计时（setInterval 或 setTimeout 轮询，30s 粒度即可），
  命中停滞条件时向 UI emit 一条 `status` 事件：
  `模型服务超过 120 秒无任何响应，可能已挂起；可点击停止按钮中止`。
  只警告、不自动中止（长推理模型可能合法地慢）。会话 settle/abort/进程退出时
  清理计时器，防止泄漏。同一回合只警告一次。
- 后台会话（backgroundSessions，含 VERIF 批次）同样适用——事件都过
  handlePiEvent，注意计时器按会话而不是按项目存。

## 修复 2：错误语义化

文件：`src/main/services/AgentService.ts` 的 `message_update` → `delta.type === 'error'`
分支（约 :1910-1917）。

- 新增一个纯函数（可放 `src/shared/` 或 AgentService 内并导出供 smoke）：
  `humanizeLlmError(raw: string): string`，映射规则：
  - 402 → `模型服务余额不足或套餐已过期，请充值或切换其他模型`
  - 401/403 → `API Key 无效或无权限访问该模型，请检查设置页的模型服务配置`
  - 404 → `模型不存在或已下线，请切换模型`
  - 429 → `模型服务限流，请稍后重试或切换模型`
  - 5xx / timeout / ECONNRESET 等 → `模型服务暂时不可用，请稍后重试`
  - 其他原样返回。
- 映射后原文保留在括号里，如：`模型服务余额不足或套餐已过期，请充值或切换其他模型（402 status code）`。
- 覆盖两处错误出口：`:1910` 的流式 error 事件和 `runBatchToSettled`/
  `waitForEvent` 路径上的 terminal error（约 :864、:1623）——统一走 humanizeLlmError。

## 修复 3：切换模型后轻量探活

文件：`src/main/services/AgentService.ts` 的 `setModel`（约 :1731）。

- `setModelInternal` 成功后，发一个极小的探活请求（如 prompt "ping"，要求 1 个 token
  回应；若 pi RPC 有更低成本的健康检查命令则优先用，先读 `src/main/ai/runtime/pi/PiRpcClient.ts`
  看有哪些可用命令）。探活失败 → 把模型切回原选择（若原本有选择），抛出语义化错误
  （经修复 2 的映射），让 UI 下拉回弹并显示原因。
- 探活会真实消耗 1-2 个 token，在注释里说明；探活内容不得进入会话历史
  （用一次性短会话或确认 pi 的 prompt 是否落 JSONL——若落，接受并在注释说明，
  或找 pi 的非会话补全通道）。
- 前置防护：`setModel` 在 `session.isStreaming === true` 时直接抛错
  `Agent 正在执行中，请等待完成或先停止再切换模型`（执行中切模型有死锁嫌疑，
  本次一并堵上）。

## 测试

- 新增 `scripts/llm-error-smoke.mjs`（注册进 `scripts/run-tests.mjs` core 套件）：
  至少覆盖 humanizeLlmError 的六类映射与"其他原样返回"；停滞判定的纯逻辑部分
  （如果抽得出纯函数：isStalled(streaming, toolInFlight, lastEventAt, now)）。
- 探活逻辑不强求真调 API；把判定/回滚路径抽成可注入假 client 的形式测试。

## 提交

一个 commit：`feat(agent): LLM 调用韧性——停滞检测 + 错误语义化 + 切模型探活与执行中防护`

## 完成后报告

改动文件清单、实现落点（path:line）、探活采用的 pi 机制、测试结果、偏差及原因。
