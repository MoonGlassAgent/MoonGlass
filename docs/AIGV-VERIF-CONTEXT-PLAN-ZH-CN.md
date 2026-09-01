# MoonGlass VERIF 上下文治理与批级隔离 —— 实施说明

> 状态：已对齐，待开工
> 日期：2026-09-01
> 背景：VERIF 阶段上下文膨胀（intelligence/ 目录实测 ~14MB，VERIF 会话 JSONL 4.8~10.7MB）。
> 共识过程见 `交流/交流.txt`；前置改造（WS1 证据管线 + WS2 B 方向）已合入工作区。
> 三批全部由本团队实施，第 4 批观察后定。

## 0. 问题量化（实测）

| 对象 | 大小 | 性质 |
|---|---|---|
| `verification/intelligence/slang-ast.json` | 9.5 MB | 引擎中间产物，Agent 永远不该读 |
| `verification-state.json` | 1.5 MB | 全量模型（100 场景 + 五层账本） |
| `verification-posture.json` | 626 KB | 已不再是"紧凑快照" |
| interaction-graph / structural-model / 各 registry | 50~434 KB | 模型产物 |
| `session-phase-verif.jsonl`（NPU / DEC_VISINEX） | 4.8 / 10.7 MB | 会话历史，只进不出 |

三层根因：① 生成太重（穷举场景 × 20 JSON × 五层账本）；② Agent 读全文不读摘要（无读取纪律）；
③ 会话历史只进不出（compact 触发太晚）。另：大 JSONL 还会被 `listSessions` 同步整读，卡主进程。

## 1. 共识决策记录

1. 路线 = 批级会话隔离（结构封顶）+ 两级访问/摘要读取（降速），四步间 fresh restart 作兜底。
2. 根因结论落盘必须工具化（`record_root_cause`），不靠提示词纪律——实证：ADJUDICATED、
   posture 被手写覆盖、四文件写回错位。
3. 批次派发由**主进程代码**编排，LLM 不经手批次 prompt 拼装（模板由引擎确定性函数生成）。
4. 批次完成判定绑定**工具登记证据**（scenario_hits 登记 + posture 重建时间戳），
   不绑定会话末条消息。
5. 批次会话 spawn 显式继承阶段主会话的模型选择（AgentModelStore）。
6. `rootCause` ≤200 字、`fix` ≤120 字，schema 层强制，防散文 blob。
7. 批次会话双重终止：正常完成（证据齐）或熔断（watchdog / DIAGNOSTIC_ENHANCEMENT 升级无果），
   两者都触发 close + 归档。

## 2. 冻结接口契约（跨批次对齐用，改动需回写本节）

### 2.1 `record_root_cause`（pi 工具，第 2 批）

```ts
{
  scenarioId: string            // ^SCN-[A-F0-9]{8}$
  hypothesis: string            // 根因假设
  verdict: 'confirmed' | 'refuted' | 'open'
  refutedHypotheses: string[]   // 本条证伪的先前假设 id（链式追溯）
  failureSignature: string      // 关联 diagnostic-control 失败指纹
  rootCause: string             // ≤200 字，一句话，确认根因；open/refuted 可为空
  fix: string                   // ≤120 字，动作级描述（如"改 vbc_rate_ctrl 首拍 flush 锁存参数"）
  evidence: string[]            // 证据路径（日志/波形/result.json），不是内容
}
```

- 落盘：`verification/results/root-causes.json`（证据区，不进 intelligence/ 引擎产物区）。
- 引擎 rebuild 时把 confirmed 根因挂到对应 scenario.evidence，并进入 signoff package——
  签核评审可回答"这个场景出过什么、怎么修的"。
- 触发时机：run_simulation 由 FAIL 转 PASS 时引导顺手登记（提示词）；
  软强制在 `review_verification_evidence`：存在"曾 FAIL 后转 PASS 且无 root-cause 记录"
  的场景 → warning（不阻断）。

### 2.2 `buildBatchPrompt`（引擎侧确定性函数，第 2 批定义，第 3 批消费）

```ts
buildBatchPrompt(workspaceDir: string, scenarioIds: string[]): string
```

- 输入批次场景 ID 列表，输出拼好的批次会话 prompt 文本。
- 内容 = 批次 Intent 详情（objective/failureMode/passCriteria/锚点）
  + 该场景已证伪假设与已确认根因（从 root-causes.json 按 scenarioId 取）
  + 环境路径与约束（不手写 hits、不宣布执行派生状态）。
- 确定性函数，无 LLM 参与；配 smoke 测试。

### 2.3 `execution-summary.json`（第 2 批，Agent 唯一入口）

- 硬指标 ≤10KB。每次 rebuild 自动生成到 `verification/intelligence/execution-summary.json`。
- 内容：进展计数（闭环/开放/阻断）+ top-10 开放场景（仅 id/标题/状态/优先级）
  + 当前 blockers + 下一步建议 + 证据**路径**（非内容）。
- 提示词口径：Agent 日常读取只读它；需要细节用 `select_next_verification_batch` 或按需小工具。

### 2.4 大文件禁令清单（第 1 批，进 dirGuide/APPEND_SYSTEM）

禁止整读：`slang-ast.json`、`verification-state.json`、`feature-interaction-graph.json`。
句式照抄 IP 库"不得整读 index.json"的现成条款。

## 3. 分批实施清单

### 第 1 批：读取纪律 + 源头止损（小改动）✅ 已完成

- [x] `src/main/services/AgentService.ts` dirGuide：加大文件禁令清单（2.4）。
- [x] `packages/verification-intelligence-engine`：slang AST 不落工作区——
      写系统临时目录（按 rtlHash 命名，消费后删除，失败保留供调试）；工作区只保留 `slang-diagnostics.log`。
- [x] `resources/moonglass/pi-bridge/moonglass-tools.ts`：`run_simulation` 回显收紧——
      PASS 只给结论行 + 产物路径；FAIL 给首尾截断 + 失败指纹行。
- [x] VERIF 提示词模板同步禁令清单（2.1.1）。

### 第 2 批：摘要入口 + 根因工具化（引擎小版本）✅ 已完成

- [x] `execution-summary.json` 生成（2.3），posture 保持不动（页面依赖）。
- [x] `record_root_cause` 工具 + `root-causes.json` + 引擎 rebuild 挂回证据（2.1）。
- [x] `review_verification_evidence` 增加 FAIL→PASS 无根因记录 warning。
- [x] `buildBatchPrompt` 确定性函数 + smoke（2.2）。
- [x] VERIF 阶段 compact 阈值调激进——pi 无 RPC 级配置，经 `.pi/settings.json`
      `compaction.reserveTokens` 实现（VERIF 写 20% 窗口 = 80% 触发压缩，spawn 前按阶段写入）；
      60% 提醒经 `getSessionStats` 轮询事件实现。

### 第 3 批：主进程编排的批级隔离（AgentService 特性）✅ 已完成

- [x] VERIF 托管运行编排（主进程代码，非 LLM）：
      `AgentService.runVerifBatches` 循环：读 `scenario-execution-plan.json` 选择下一批
      （对齐 `select_next_verification_batch` 默认路径）→ `buildBatchPrompt` →
      spawn `phase-verif--batch-N`（后台平行会话，继承 AgentModelStore 阶段模型选择）→ 等待 settle。
- [x] 完成判定：`verif-batch-verdict.ts#judgeBatchCompletion` 校验批次 scenarioIds 均已出现在
      scenario_hits 登记且 posture 重建时间戳晚于批次开始；缺一 → 熔断路径。
- [x] 双重终止 + 自动 close + 归档（`archiveBatchSession`，复用 restartSessionFresh 归档语义）。
- [x] 批次会话异常（watchdog abort / DIAGNOSTIC_ENHANCEMENT 升级无果 / 证据缺失）→
      结构化 `VerifBatchRunResult.circuitBreaker` 回报主流程，循环停止后续批次。
- [x] IPC：`agent:run-verif-batch` / `agent:run-verif-batches`（契约 + preload + WorkspacePage
      一键托管 VERIF 步骤接入）。
- [x] 回归：阶段切换、平行会话隔离、归档清理的现有 smoke 保持绿；新增
      `scripts/verif-batch-verdict-smoke.mjs`（完成判定 + 熔断路径 + 批次选择，入 core 套件）。

### 第 4 批（观察后定，本说明不承诺）

- 20+ JSON → 3 事实源合并；ScenarioStatus 12 → 6；引擎候选池彻底退出排队。
- 触发条件：NPU 真实重跑数据（jsonl 增长速率、禁令文件零读取、summary 覆盖率）出来后评审。

## 4. 验收标准（每批交付口径）

1. `pnpm typecheck`：5 个 workspace 包全过；根应用不得新增错误（基线 11 个历史遗留）。
2. 对应 smoke 全过：`verification-intelligence-smoke`、`pi-tools-smoke`、`eda-gate-smoke`，
   新增 smoke 随批交付。
3. 引擎包（verification-intelligence-engine）**不得引入新外部依赖**（源码复制到 pi 侧运行的约束）。
4. 第 1 批完成后实测：NPU 工作区 `verification/intelligence/` 体积、Agent 对禁令文件的读取次数（应为 0）。
5. 第 3 批完成后实测：单个批次会话 JSONL 上限（应稳定在 KB~小 MB 级）、批次完成判定不读会话文本。

## 5. 开工前 git 协同

当前工作区含 WS1/WS2 + 提示词体系的全部未提交改动。开工前按主题提交
（会话隔离/阶段清理/验证态势/RTL lint/AIGV 证据管线与 B 方向），三批改动落在干净基线上。
