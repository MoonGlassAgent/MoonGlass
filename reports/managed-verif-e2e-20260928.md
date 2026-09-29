# 一键托管 VERIF 阶段真实 e2e 观察报告（v0.9.9 / release/v0.9.8）

- 日期：2026-09-28 20:54–21:18（UTC+8）
- 方式：playwright-core 驱动 electron.exe + `out/` 构建产物；`MOONGLASS_USERDATA` 隔离数据目录（未触碰用户真实 userData 的项目数据）
- 工程：8 位计数器 mini_counter（RTL 内置 off-by-one 回绕 bug：规格要求 8'hFF 回绕，RTL 在 8'hFE 提前回绕）
- 模型：前台选了 glm-5.3-flash；托管任务会话实际用 deepseek-flash（见结论 3）
- 脚本：`scripts/e2e-managed-verif.mjs`（已入库，可复用；`E2E_BUDGET_MIN`/`E2E_POLL_SEC` 可调）
- 原始证据：截图序列 `e2e-screenshots/mv1790600085988-*.png`（36 张）、逐轮观察流水 `e2e-screenshots/managed-verif-timeline-1790600085988.md`、取证目录 `C:\Users\Allarum\AppData\Local\Temp\mg-e2e-verif-1790600085988\`（工作区 + 隔离 userData + pi 会话 JSONL）

## 行为时间线（精确到分钟）

| 时刻 | t+ | 事件 |
|---|---|---|
| 20:54:46 | 0:00 | 隔离环境就绪，应用启动，providers 全部解密成功 |
| 20:55:04 | 0:18 | 点击"开始托管"（VERIF→SYNTH）。spawn 任务会话 `phase-verif--task-20260928-205504-VERIF`，**模型被切到 deepseek-flash 而非用户选的 glm-5.3-flash** |
| 20:55–21:12 | 0:40–17:40 | **规划 prompt 独占约 17 分钟**：写 8+ 份验证文档、搭 cocotb 环境（踩 cocotb 2.0.1 API、oss-cad-suite perl Pod::Usage、C++ TB 端口名生成 bug 等环境坑）、`build_verification_intelligence`（20:56:18，11 场景）、登记 9 个 intents（21:07，20 场景） |
| 21:08:26 | 13:40 | **规划会话自己跑基础回归，直接跑出 10 个 FAILED**（找到植入 bug）——注意这发生在批次编排之前 |
| 21:10–21:12 | 15–18 | 规划会话继续收集覆盖率（行 60%、功能 76%）、写闭环文档 |
| 21:13:17 | 18:32 | 根因确认，主进程派发 RTL 修复会话 `phase-verif--fix-RC-5C448CB0`（继承 glm-5.3-flash） |
| 21:13:25 | 18:40 | 托管循环进入 `runVerifBatches`，**第一轮选批前即命中修复门控**，返回 `stoppedBy='circuit-break'`："等待 RTL 修复完成…暂停派发新批次（修复结束后不自动续跑…）"。**全程零批次被派发**（无任何 `*--batch-*` 会话文件） |
| 21:13:49 起 | 19:00 | 托管循环按计划继续走 `MANAGED_VERIF_REVIEW_PROMPT`（审查 prompt），与修复会话**并行**：审查会话跑 SBY formal、mutation、覆盖率分析；修复会话修 RTL |
| 21:14:37 | 19:52 | 修复落盘：`8'hFE`→`8'hFF`（rtlHash 585eff…→533728…），rtl/ 写保护生效（blockedAttempts=1） |
| 21:17:41 | 22:56 | 观察预算耗尽，点击停止托管 → 全局 abort。修复会话 mid-regression 被中止（stopReason=aborted），审计落盘 changed=1；托管报告 outcome=stopped，最终阶段仍是 VERIF |

## 与嫌疑点的对应

### 嫌疑 1（M4 门控不续跑）——**确认，且比预想更严重**

实测触发的正是代码注释写明的行为（`AgentService.ts:1725`："修复结束后不自动续跑（§5.5）"），且有两个放大器：

1. **零批次即中止**：修复会话是在规划阶段（基础回归发现 bug）就被派发的，等托管循环走到 `runVerifBatches` 时门控已激活，第一轮直接 circuit-break 返回，`batches=[]`。也就是说 VERIF 托管的"批次执行"环节可以一批都不跑就结束。
2. **不重跑 + 不等待**：`WorkspacePage.tsx:836-843` 对 `stoppedBy !== 'exhausted'` 只记一条 risk（`totalRisks += 1`），随后立刻进 REVIEW prompt，之后就是 `phase.advance` 门禁。修复完成（21:14:37）后没有任何一方重新调用 `runVerifBatches`——设计文档把续跑寄托在"修复结果的 follow-up 引导验证继续"，但该 follow-up 发给的是**前台主会话**（见嫌疑 2），托管循环的 task 会话根本收不到、也不会据此重跑批次。若本例跑完，结局就是：批次队列 20 个场景绝大多数 open，VERIF 门禁 3 轮修复失败后被 force 推进 QA——**"VERIF 没闭环就被推进"的用户报告被完整复现**。

### 嫌疑 2（修复 follow-up 与托管 prompt 交错）——**结构性确认存在，运行时未观察到碰撞**

- 修复 settle 时刻（21:17:41）与我们点击停止完全重合，follow-up prompt 未发出（主会话 JSONL 只有最初的 pong 预热），所以 isStreaming 撞车没有实际发生。
- 但结构上已看清错位：follow-up 的目标是前台 VERIF 主会话，而托管循环全程驱动的是 M1 task 会话——两条线本来就不交汇。"由修复结果的 follow-up 引导验证继续"在托管模式下**无法引导托管循环**，只会把一个 prompt 塞给无人值守的主会话。

### 嫌疑 3（批次模型继承链）——**批次/修复继承正常；M1 任务会话不继承，另行确认**

- 修复会话正确继承了 VERIF 主会话的 glm-5.3-flash（`AgentService.ts:1667-1671` 的继承链对 batch/fix 类会话有效）。
- 但托管的 M1 任务会话（`startAgentTask`）在 spawn 后切到了 `providers[0].models[0]`（deepseek-flash），**没有继承用户在前台选定的模型**。规划/审查这两个最重的一段跑在非用户指定的模型上。

### 其他新发现

1. **规划阶段越权执行**：规划 prompt 明确写了"本会话只做规划，不要逐批执行场景回归"，但 agent 仍在规划会话里跑了基础回归并直接把场景标成 FAILED/VERIFIED——这既消耗了 17 分钟，又提前触发修复门控，是"零批次"的直接原因之一。
2. **agent 逃逸工作区**：规划会话 `cd /d/Projects/ASIC_Flow/MoonGlass && grep -rl MOONGLASS_FUNCTIONAL_COVERAGE_FILE .` 翻 MoonGlass 仓库源码找环境变量约定（截图 mv…-08/09 可见），shell 工具未限制在项目工作区内。
3. **环境摩擦大**：cocotb 2.0.1 `cocotb.log` 不存在、oss-cad-suite verilator 的 perl Pod::Usage 缺失、C++ TB 生成器把 `input wire en` 的端口名解析成 `wire`——这些坑吃掉了大量 token 和时间，提示词/工具侧可沉淀。
4. **托管 UI 的 verifLog 在 chat 主 tab 下不可见**（日志区只在 runs tab 渲染），托管期间用户看不到 `appendLog` 的编排日志，问题发生时无感知。

## 可操作的修复方向（按收益排序）

1. `runVerifBatches` 返回 circuit-break 且 `batches.length === 0` + 修复进行中时，托管循环应**等修复 settle 后重跑 `runVerifBatches`**（或主进程在修复 settle 后自动续跑队列），而不是记一条 risk 就走 REVIEW。
2. 修复 follow-up 在托管模式下应路由到托管 task 会话（或改为托管循环轮询 `activeRtlFixes` 状态），否则"引导验证继续"落空。
3. `startAgentTask` 应继承当前会话模型选择。
4. 规划 prompt 与批次职责硬隔离：规划会话禁止 `run_simulation` 场景登记类调用（工具侧按会话角色门控），把回归留给批次。

## 数据安全说明

- 真实 `projects.json` 全程未被本测试写入（隔离 userData 机制保证）。运行期间 hash 变化来自用户自己开着的 MoonGlass 实例（其删除/重建 DMA_mt、更新 LITE_DMA 等项目的 updatedAt），与本测试无关；因此**没有恢复备份**（恢复会回滚用户自己的操作）。手动备份保留在 `%APPDATA%/moonglass/moonglass/projects.json.mg-e2e-manual-backup`，确认无误后可自行删除。
- 未做任何 git 变更；唯一入库文件是 `scripts/e2e-managed-verif.mjs`。
