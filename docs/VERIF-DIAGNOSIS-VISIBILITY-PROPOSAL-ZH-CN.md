# MoonGlass 验证失败诊断与修复可视化方案（C）

> 状态：讨论稿 · 供评审
> 日期：2026-09-29
> 关联版本：MoonGlass v0.9.10
> 定位：独立话题。与 A+B 方案（`docs/VERIF-UX-CONVERGENCE-AND-GUIDED-FLOW-ZH-CN.md`）仅共享
> 一项基础设施（verification/ 目录文件 watch 自动刷新），其余解耦，可独立立项实施。
> 结论先行：验证的"失败→诊断→根因→修复→回归"回路在 v0.9.10 已经**全自动运转**
> （诊断账本、根因工具化、修复会话、写保护审计、批次编排全部真实实现），
> 但它几乎完全运行在后台——用户看不到根因链、看不到修复判定、看不到批次进度、
> 不知道修复窗口内 rtl/ 是只读的。本方案不动回路本身，只做两件事：
> **把判定与进度落盘（数据层），把链路上浮到 UI（呈现层）**，
> 让用户随时能回答三个问题：卡在哪、机器正在干什么、要不要我介入。

---

## 1. 现状与缺口（全部基于代码证据）

### 1.1 回路现状（已真实实现的部分）

- **诊断账本**：`run_simulation` 每次结束自动更新 `verification/results/diagnostic-control.json`
  （`resources/moonglass/pi-bridge/moonglass-tools.ts:138-167`）：attempts 滚动窗口（≤40 条）、
  失败指纹（日志归一化 sha1 前 12 位，`:91-98`）、L0-L5 诊断等级启发式推导（`:100-110`）、
  同指纹重复失败自动进入 `DIAGNOSTIC_ENHANCEMENT`（`:156-161`）。
- **根因工具化**：`record_root_cause` 工具落盘 `verification/results/root-causes.json`
  （schema 见 `packages/verification-intelligence-engine/src/types.ts:92-109`，
  rootCause ≤200 字 / fix ≤120 字硬约束，confirmed/refuted/open + refutedHypotheses 链式追溯）。
- **修复会话**：confirmed 根因触发主进程派发独立修复会话 `phase-verif--fix-<RC-id>`
  （`AgentService.ts:845-850, 2107-2210`）：修复窗口内 rtl/ 写保护（`rtl-write-guard.ts`，
  尽力拦截 + 拦截账本落盘）、窗口前后 rtl/ 快照 diff 审计（`rtl-fix-audit.ts`）、
  settle 后 `judgeRtlFixOutcome` 按修复后 scenario_hits 证据判定 FIXED/STILL_FAIL/UNKNOWN
  （`rtl-fix-verdict.ts:79-132`）。
- **批次编排**：`runVerifBatches` 循环（`AgentService.ts:1840-1894`）选批→派发
  `phase-verif--batch-N`→证据绑定判定（`verif-batch-verdict.ts:49-71`）→熔断（含诊断停滞检测）。
- **熔断/暂停联动**：修复进行中批次循环自动暂停等待 settle（上限 65 分钟），settle 后续跑。

### 1.2 可见性缺口（事实清单）

1. **根因链零展示**：`root-causes.json` 在渲染端没有任何消费者（grep 仅命中提示词字符串）。
   假设的提出、证伪、确认链（这是 AIGV 最有说服力的证据）用户完全看不到。
2. **修复判定不落盘、不可见**：FIXED/STILL_FAIL/UNKNOWN 只存在于内存、会话 JSONL 和一条
   聊天 status 文本里；`rtl-fix-in-progress.json`（修复窗口标志）、`rtl-fix-audit-<RC>.json`
   （改了哪些文件）、`rtl-fix-blocked-attempts.json`（拦截记录）渲染端均不读。
3. **修复窗口不可见**：修复进行中用户在 UI 上无从得知 rtl/ 暂为只读——只有恰好发起写操作的
   会话收到拦截 reason。
4. **批次进度无结构化展示**：批次循环的全部状态转换只发 `status` 纯文本气泡
   （派发/run_simulation 里程碑/熔断原因），`AgentStreamEvent` 无结构化批次事件类型
   （`src/shared/types/moonglass.ts:534-543`）；`VerifBatchRunResult/LoopResult` 只在托管
   日志留一行汇总。用户看不到"第几批/共几批、这批在干什么、为什么熔断、是否在等修复"。
5. **诊断账本只有一条横幅**：态势页诊断横幅（`VerificationPosturePage.tsx:615`）只显示
   mode/activeCase/recommendation/最新等级；attempts 历史、指纹演化、L 等级爬升、
   进入 DIAGNOSTIC_ENHANCEMENT 的原因均不展示；工作区主页面完全无诊断状态。
6. **失败原因不贯通**：`scenario_hits.json` 条目不存失败原因/指纹（`moonglass-tools.ts:203-254`），
   用例全景 failed 行的"为什么"列显示"—"（`VerificationPosturePage.tsx:184-193` 只覆盖
   planned/specBlocked）；FileService 兼容读取的 `sc.blocker/disposition` 当前写入方从不写。
7. **手动刷新**：态势页/StatusBar 不自动感知批次 settle 后的 posture 更新（与 A+B 共享缺口）。

### 1.3 为什么现在做

v0.9.10 刚修完托管 VERIF 断档（修复不续跑、批次零闭环），回路能跑通之后，
**"看不见"立刻成为下一个主要不信任来源**：用户盯着空等的批次、聊天里一闪而过的熔断原因、
修没修好只有一条文本消息——这些在 e2e 观察报告（`reports/managed-verif-e2e-20260928.md`）
里都是实际发生过的困惑。

---

## 2. 设计原则

1. **证据绑定，不信聊天文本。** UI 只读落盘账本与证据文件，不把 status 气泡当数据源——
   与批次完成判定的既有哲学（scenario_hits 登记 + posture 时间戳）一致。
2. **最小新增文件。** 新增落盘严格限于"判定结果"这类当前没有持久载体的数据；
   已有落盘（diagnostic-control/root-causes/audit/blocked-attempts）一律只做读取方，不改 schema。
3. **与 A+B 信息分层对齐。** 诊断/修复的当前状态属 L1（用户该看到的进行态）；
   attempts 历史、审计 diff、拦截记录属 L2（专家折叠层）。
4. **回路零改动。** 不修改诊断推导、修复判定、批次编排的任何逻辑，只加落盘点和读取方。

---

## 3. 数据层改造：三处落盘 + 一个推送

### 3.1 修复判定落盘：`verification/results/rtl-fix-outcomes.json`

追加式账本（数组，新记录 unshift，上限 50 条），在 `deliverRtlFixOutcome`
（`AgentService.ts:2249-2286`）送达判定时写入：

```ts
{
  version: 1,
  outcomes: [{
    rootCauseId: string        // RC-xxxxxxxx
    scenarioId: string         // SCN-XXXXXXXX
    fixSessionName: string
    judgment: 'FIXED' | 'STILL_FAIL' | 'UNKNOWN'
    reason: string             // judgeRtlFixOutcome 的判定依据一句话
    startedAt: string          // fixStartedAt
    settledAt: string
    auditPath: string          // rtl-fix-audit-<RC>.json 相对路径（改了哪些文件）
    blockedAttempts: number    // 窗口内写保护拦截次数
  }]
}
```

### 3.2 批次循环状态落盘：`verification/results/verif-batch-loop.json`

覆盖式状态文件（不是追加账本），`runVerifBatches` 各转换点（`AgentService.ts:1840-1894`）
原子更新：

```ts
{
  version: 1,
  updatedAt: string,
  state: 'idle' | 'running' | 'awaiting-rtl-fix' | 'circuit-broken' | 'completed' | 'stopped',
  currentBatch: {             // 无则为 null
    index: number             // 第 n 批（本次循环序号）
    sessionName: string
    scenarioIds: string[]
    dispatchedAt: string
    phase: 'dispatched' | 'settling'
  } | null,
  circuitBreaker: { reason: string, detail: string } | null,  // 熔断原因结构化
  rtlFixWait: { rootCauseId: string, since: string } | null,  // 等修复暂停
  history: [{                 // 本次循环已完成批次，滚动 ≤20 条
    index: number, scenarioIds: string[],
    verdict: 'completed' | 'circuit-broken',
    reason: string, settledAt: string
  }]
}
```

循环结束（completed/circuit-broken/stopped）保留终态，下次循环覆盖。
`judgeBatchCompletion` 的判定细节（缺哪个 scenario 的登记）写入 history 条目的 reason。

### 3.3 失败摘要贯通：scenario_hits 增加两个可选字段

`run_simulation` FAIL 路径（`moonglass-tools.ts:1541-1549`）登记 hit 时增补：

```ts
{
  // ScenarioHit 新增可选字段，旧数据兼容
  failureSummary?: string     // 失败日志归一化后首个错误行，≤160 字
  failureSignature?: string   // 与 diagnostic-control 同一算法（复用 :91-98）
}
```

- 引擎 `scenarioHits()`（`engine.ts:983-999`）与 FileService 透传即可，不派生状态；
- 用例全景 failed 行的"为什么"列显示 failureSummary；指纹把场景失败与诊断账本
  （按 topModule::testcase 维度）关联起来，UI 可做"查看诊断过程"跳转。

### 3.4 推送：落盘为准，watch 触达 UI

不新增 `AgentStreamEvent` 类型（避免依赖会话路由的文本通道）。渲染端感知走
A+B 方案 3.3 的同一个文件 watch（`verification/results/` 目录 + posture）：
三个新账本写入即触发 `verification:changed`，态势页/运行中心自动重载。
watch 不可用时降级 5 秒轮询 mtime。

---

## 4. UI 层设计

### 4.1 工作区新增"验证运行"页签（底部控制台，VERIF 阶段高亮）

在工作区底部控制台新增 `verifrun` 页签（`WorkspacePage.tsx` BOTTOM_TABS，`:56-62`），
或并入 A+B 收敛后的"验证"页签顶部作为"运行态"分区。三个卡片：

**批次进度卡**（读 `verif-batch-loop.json`）

- 状态行：循环状态徽标（运行中/等修复暂停/已熔断/已完成）+ "第 n 批 · 场景 SCN-x/SCN-y/SCN-z"。
- 执行中：当前批 phase（已派发/判定中）；最近一条 run_simulation 里程碑（沿用现有 status 即可，不重复建设）。
- 熔断时：结构化原因 + "在对话中继续"按钮（把熔断原因与建议动作拼成 prompt 发给阶段会话）。
- 历史：本次循环已完成批次的 verdict 列表（绿/红）。
- 空态：无循环记录时显示"尚未启动批次编排"，附"开始基础验证"按钮（沿用现有波段 prompt）。

**修复卡**（读 `rtl-fix-outcomes.json` + `rtl-fix-in-progress.json` + root-causes.json）

- 每个 confirmed 根因一张卡：根因 ID、场景、一句话根因、修复指令（fix ≤120 字天然适合展示）。
- 状态机可视化：修复中（脉冲）→ FIXED（绿）/ STILL_FAIL（红）/ UNKNOWN（灰）+ 判定依据。
- 展开可见（L2）：审计 diff 统计（changed/created/deleted 文件清单，读 auditPath）、
  写保护拦截次数、关联 scenario_hits 证据路径。
- STILL_FAIL/UNKNOWN 卡带"继续诊断"按钮（发 prompt 引导回诊断循环开新假设链——
  与现有 deliverRtlFixOutcome follow-up 同语义）。

**修复窗口横幅**（`rtl-fix-in-progress.json` 存在时，工作区全局置顶一条）

- "RTL 修复进行中（根因 RC-x / 场景 SCN-y），修复窗口内 rtl/ 目录处于写保护状态。"
- 窗口结束（文件消失 + watch 触发）自动消失；审计落盘后可在修复卡看到窗口结果。

### 4.2 根因链视图（态势页 L1 新区块，L2 可展开）

读 `root-causes.json`，按 scenarioId 分组渲染假设链：

- 每条场景一列：open（蓝）/ refuted（灰，划线）/ confirmed（绿）徽标 + 假设一句话；
- refutedHypotheses 链式追溯以缩进/箭头呈现（"假设 2 证伪了假设 1"）；
- confirmed 条目显示根因 + fix + 修复判定徽标（联 4.1 修复卡）；
- 这块同时是签核包"这个场景出过什么、怎么修的"的用户可视版
  （引擎 `attachConfirmedRootCauses` 已把 confirmed 证据挂进 signoff package，口径天然一致）。

### 4.3 诊断账本时间线（态势页诊断横幅升级为可展开区块）

现有横幅（mode + activeCase + recommendation）保留为摘要行，点击展开时间线：

- attempts 列表：时间、testcase、PASS/FAIL、L 等级、耗时；
- L 等级爬升以阶梯点图呈现（L0→L5 纯序号，前端画点即可）；
- 当前失败指纹 + 同指纹次数；进入 DIAGNOSTIC_ENHANCEMENT 的那次尝试高亮并显示触发条件
  （同指纹 ≥2 次 / ≥3 次尝试且等级未爬升）；
- 每条 attempt 的 evidence 路径可点击打开（日志/波形/result.json）。

### 4.4 失败贯通到既有视图

- 用例全景 failed 行"为什么"列：failureSummary（3.3），附"查看诊断"锚点跳 4.3。
- VerificationRunSection 用例表的 FAIL 行 errorMessage 逻辑不变（JUnit 来源），
  与 scenario 级 failureSummary 互补（一个是用例口径，一个是场景口径）。

### 4.5 "需要你处理"联动

- 诊断卡壳（DIAGNOSTIC_ENHANCEMENT 且最近 3 次尝试 L 等级无爬升）→ L0 待办项
  "这个 bug 需要你参与定位"（A+B 方案 4.4 第 3 条的落盘依据即本方案的 diagnostic watch）。
- 修复 STILL_FAIL 超过 2 轮（同 scenario 多张修复卡连续失败）→ L0 待办
  "修复未收敛，建议人工介入"。

---

## 5. 实施分批

### 批 1：落盘三件套 + 推送（主进程 + pi-bridge，渲染端不动）

- 3.1 修复判定账本、3.2 批次循环状态、3.3 hits 失败摘要；文件 watch 推送（与 A+B 批 1 共建，
  谁先做谁带）。
- 验收：新增 smoke——`rtl-fix-outcome-smoke`（FIXED/STILL_FAIL/UNKNOWN 三路径落盘）、
  批次循环状态转换落盘（可并入 `verif-batch-verdict-smoke` 扩展）；`scenario-hits-smoke`
  覆盖新可选字段与旧数据兼容；`pnpm typecheck` 全过（不新增于基线 11 个之外）。

### 批 2：验证运行页签（批次进度卡 + 修复卡 + 窗口横幅）

- 验收：真实项目跑一轮托管 VERIF，用户全程不看聊天面板也能回答"第几批、在修什么、
  修好没有"；修复窗口期间发起 rtl/ 写操作的会话仍被拦截且用户能看到横幅解释。

### 批 3：根因链视图 + 诊断时间线 + 失败贯通 + 待办联动

- 验收：DDR_BIST 历史数据回放——根因链、诊断爬升与当时的真实排障过程一致；
  failed 场景行均显示失败摘要；诊断卡壳待办在构造场景下触发。

每批交付口径沿用既有规范：typecheck 全过、对应 smoke 随批交付且全绿、
引擎包不引入新外部依赖（本方案主要动主进程/pi-bridge/渲染端，引擎只加字段透传）。

---

## 6. 与 A+B 方案的接口（仅两处）

1. **共享文件 watch**：`verification:changed` 推送通道，谁先实施谁建，另一方复用。
2. **信息分层归属**：本方案的批次/修复当前态卡属 L1；诊断时间线明细、审计 diff、
   拦截记录属 L2 折叠层。态势页 L0 的"需要你处理"队列由 A+B 方案 4.4 定义，
   本方案 4.5 只提供触发数据源。
3. 除上述外，两方案文件改动面不重叠（A+B 主战场在引擎产物与态势页结构，
   本方案在主进程编排落盘与底部控制台/新区块），可独立排期。

---

## 7. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 新落盘文件 schema 后续演进 | 全部带 `version` 字段；读取方做缺字段归一（沿用 normalizeGuidanceState 思路） |
| 批次状态文件与真实循环脱节（漏写转换点） | 写入点收敛在 runVerifBatches 单函数内；smoke 覆盖全部状态转换 |
| 会话归档后修复卡丢失上下文 | 修复卡数据来自账本而非会话 JSONL；归档不影响 |
| failureSummary 泄露大段日志到 UI | 落盘前归一化 + ≤160 字硬截断（与 failureSignature 同一次日志处理产出） |
| 用户把"修复 UNKNOWN"误读为"修复失败" | 卡片文案如实写判定依据（"修复后未重跑回归"），附"去重跑"按钮 |

---

## 8. 待决策问题

1. "验证运行"信息放底部控制台新页签，还是并入收敛后的"验证"页签顶部（依赖 A+B 批 1 结论）。
2. 批次循环终态（completed/circuit-broken）是否需要在下次循环前保留提示条（防"熔断静默"）。
3. 根因链是否允许用户在 UI 上直接对 open 假设做"我判断是 X"输入（写回 root-causes.json 走
   adjudication 工具），还是保持只读 + prompt 交接。本方案默认后者（写入一律走工具链）。
