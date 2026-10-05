# MoonGlass 验证长程任务设计：验证运行循环（Verif Run Loop）

> 状态：评审稿 · 供评审
> 日期：2026-09-29
> 关联版本：MoonGlass v0.9.10
> 前置文档：`docs/AIGV-TOP-FIRST-STRATEGY-ZH-CN.md`、`docs/VERIF-UX-CONVERGENCE-AND-GUIDED-FLOW-ZH-CN.md`、`docs/VERIF-DIAGNOSIS-VISIBILITY-PROPOSAL-ZH-CN.md`
> 结论先行：现有系统只有"内层循环"（批次编排），没有"外层循环"——每个 prompt 都带停止边界，会话停止是设计而非 bug，断档在**停止之后没人接棒**。本设计在 VERIF 阶段引入主进程确定性状态机作为外层循环，决策模型为**规则驱动 + 证据裁决 + 结构化决策层（LLM/工程师双源、单一决策账本）**；循环可见性走结构化面板与决策卡片，**用户键盘交互对象始终是原阶段会话**，对循环的一切影响必须经账本落地。

> **术语（2026-10-05）**：本文档保留内部术语"拍/节拍"（对应账本字段 `beat`），
> **界面统一显示为「步」**（循环步数 / 第 n 步 / 最近步骤）。
> 一"步" = 循环完成一次「读态势 → 推导动作 → 派发执行 → 判定结果」的完整回合；
> **一"步"不等于一件事**：批次类动作的一步内部会跑内层批次循环（默认最多 20 批）。
> 因此 `noProgressLimit`（默认 3）是以**步**计的，而非按批计——最坏情况下一次熔断前
> 可能出现 3 步 × 20 批的重复派发。该缺口由 P2（选批器跳过无新证据的批）解决，尚未实现。

---

## 1. 背景与问题定性

### 1.1 现状（均有代码证据）

- **内层循环已验证有效**：主进程 `runVerifBatches`（`src/main/services/AgentService.ts:1840-1894`）——确定性选批、`buildBatchPrompt` 无 LLM 拼 prompt、证据绑定判定（scenario_hits + posture 时间戳）、熔断（诊断停滞/watchdog/证据缺失）。v0.9.10 修复断档后可稳定连跑。
- **外层无循环**：波段之间、动作之间的接力靠用户点击（向导卡/波段按钮）；一键托管 VERIF 是固定脚本（规划→批次→终审三段，`WorkspacePage.tsx:120-145`），态势未达标不会自动再绕一圈。
- **行动推导只在 UI 展示**：`src/renderer/verification-guidance.ts` 的 13 条规则能算出"下一步该干什么"，但结论只呈现给用户，没有机制回喂给执行侧。
- **停止即终点**：会话完成有界任务后等待用户输入；"需要人"的场景（规格澄清/豁免审批/诊断卡壳）没有结构化的暂停-恢复语义。

### 1.2 目标 / 非目标

目标：VERIF 阶段从"规划环境"到"门禁通过"可一键自主续跑；每一拍可审计；需要人时结构化暂停、人答完自动续跑；预算超限/停滞时诚实熔断。

非目标：① 其他阶段（REQ_SPEC/ARCH/RTL/QA/SYNTH）的托管维持现状；② 不追求"全程无人"——诊断卡壳升级给人是特性；③ 多项目并行循环不支持（单项目单循环）。

---

## 2. 设计原则

1. **编排归确定性代码，判断归 LLM（有界会话），完成归证据。**
2. **决策来源复数，决策账本单一**：规则、LLM、工程师的决策序列化为同一份结构化记录，过同一道合法性校验才执行。
3. **暂停待人是一等公民状态**，恢复由证据变化触发，不靠聊天文本。
4. **预算是自主的前提**：无人值守必须有硬护栏（拍数/token/墙钟/连续无进展）。
5. **状态全落盘**：循环账本承载长程状态，应用重启后续跑；LLM 上下文只装当拍工作单元。

---

## 3. 总体架构：三层决策模型

```
┌────────────────────────────────────────────────────────────┐
│ 规则层（默认路径）  deriveNextAction：态势证据 → 下一个动作    │
│   （verification-guidance 13 条规则下沉 shared，UI/循环同源）  │
├────────────────────────────────────────────────────────────┤
│ 决策层（例外路径）  触发：规则空转 N 拍 / 熔断恢复 / 规则无答案  │
│   LLM 提案 → 决策账本登记 → 规则层合法性校验 → 派发            │
│   工程师随时介入：自定义指令注入 / 审批 LLM 提案（决策卡片）     │
├────────────────────────────────────────────────────────────┤
│ 证据裁决层（寸步不让） 完成判定只认落盘证据：                    │
│   scenario_hits / posture 时间戳 / 各账本 / 门禁结果           │
└────────────────────────────────────────────────────────────┘
```

LLM 影响循环走向的唯一通道：经工具落盘成结构化记录（决策账本），规则校验后执行——与 `record_root_cause`/`register_config_space` 同一哲学（LLM 提供判断，工具守门，证据闭环）。

### 3.1 行动推导下沉

`verification-guidance.ts` 的推导内核（deriveVerificationActions/deriveVerificationSteps，纯函数）从渲染端迁至 `src/shared/`（或引擎包），UI 与循环共用同一份——用户看到的"主行动"与机器自动执行的"下一拍"永远一致。渲染端改为 import。

### 3.2 LLM 决策层

**触发条件（全部确定性，LLM 无权自行出手）**：
- **规则空转**：规则派生动作执行后态势无进展（无新证据登记/失败指纹不变/闭环计数不变），连续 3 拍 → 升级；
- **熔断恢复**：批次熔断后，LLM 读账本做结构化归因并提出恢复方案；
- **规则无答案**：推导为空但闭环未达成（防御性兜底，现行规则有 continue-closure 保底，罕见）。

**提案与生效**：LLM 读压缩态势（execution-summary + 各账本，不读会话长历史），经新工具 `propose_run_decision` 登记决策账本；规则层校验（动作类型白名单/预算内/停止条件非空/证据锚点真实）后：
- **顾问模式（默认）**：提案以决策卡片（`request_user_decision` 已有机制）呈给工程师，批准才执行；
- **委托模式（可选，按动作类型白名单下放）**：如"批次选择/重跑策略可自定，规格解释/豁免必须问人"；LLM 直接执行并记账，工程师事后审账本。

### 3.3 工程师层

最高优先级、随时可介入：自定义指令注入（对会话说话，LLM 转写为 `source:'human'` 决策记录进账本）、审批/修改/否决 LLM 提案、随时停止循环。工程师决策同样记账，事后可回答"这个转向是谁让的、基于什么、带来了什么"。

---

## 4. 状态机

### 4.1 状态枚举

| 状态 | 含义 | 进入条件 | 出口 |
|---|---|---|---|
| `idle` | 未运行 | 初始/循环结束后 | 用户启动 |
| `planning` | W0：校验基线计划→建引擎模型→登记 intents/config-space→搭 TOP 环境→冒烟 | 启动且无可用态势 | 环境就绪→`running`；失败→`paused-breaker` |
| `running` | 执行当前动作（批次/任务会话已派发） | 每拍动作派发 | settle→`judging`；confirmed 根因→`repairing`；升级条件→`paused-*` |
| `judging` | 证据判定（瞬态） | 会话 settle | 判定完→`running`（下一拍）或波段晋升或 `paused-*` |
| `repairing` | RTL 修复子循环（复用现有修复门控：挂起派发、修复会话、判定续跑） | confirmed 根因事件 | settle 后回 `running` |
| `paused-human` | 待人工：`spec-clarify`/`waiver-approve`/`diagnosis-stuck`/`ut-decision`/`llm-decision-pending`/`gate-blocked` | 待办条件命中（规则推导） | 证据变化（用户答复已登记）→`running` |
| `paused-breaker` | 熔断：预算超限/连续无进展/watchdog/诊断停滞 | 熔断条件命中 | 用户处置（调整预算/给指令）→`running`；或 `stopped` |
| `signoff-review` | W3 序列：签核回归→Formal 义务→Multi-Oracle/Mutation 核对→独立证据审查 | W2 闭环/饱和 | 审查通过→`gate-check`；阻断→`paused-human` |
| `gate-check` | VERIF→QA 门禁 | 签核审查通过 | 通过→`completed`；失败→`paused-human`(gate-blocked) |
| `completed` / `stopped` | 终态 | — | 用户重新启动 |

### 4.2 一拍（beat）的标准节拍

```
读态势（posture/账本/plan）→ 推导动作（规则层）
  → 无动作且未闭环 → 决策层（LLM 提案/升级待人）
  → 有动作 → 记录决策（source:'rule'）→ 合法性校验（预算/互斥）
  → 派发有界会话（任务/批次/修复，继承模型选择）
  → 等 settle → 证据判定 → 账本回填（判定结果/是否推进）→ 下一拍
```

波段晋升判据绑定证据（沿用 A+B 口径）：W1=条款 PASSED+WAIVED 全覆盖；W2=主题波闭环或探索饱和；W3=签核审查三态结论。

---

## 5. 暂停/恢复协议

1. **暂停即落盘**：`pause: { kind, reason, detail, pendingItems, since }` 写入循环账本；对应待办出现在 L0 队列（已有）与运行卡。
2. **恢复由证据触发**：工程师在会话中答复 → Agent 经工具登记（裁决/审批/新假设）→ 证据文件变化 → 循环检测后自动续跑。豁免审批等直接文件动作（`signoff-approvals.json` 编辑）同理由 watch 触发。循环**从不解析聊天文本**决定是否恢复。
3. **显式恢复入口**：运行卡"继续"按钮（用户已线下处理完毕时手动触发再推导）。

---

## 6. 预算与熔断

- 预算维度：拍数（默认 50）、token（按会话统计聚合，默认随模型档位）、墙钟（默认 4 小时）、连续无进展拍数（默认 3）。均可在启动对话框调整。
- 超限 → `paused-breaker` 账本落盘 + L0 待办 + 运行卡明示；不静默烧钱。
- 既有熔断原样嵌入：watchdog、DIAGNOSTIC_ENHANCEMENT 停滞、批次证据缺失、修复等待超时。

---

## 7. 交互模型（界面分工与互斥）

### 7.1 三个界面

| 用户意图 | 界面 | 机制（现状） |
|---|---|---|
| 看状态 | 验证运行页签：外层循环卡（状态/波段/第几拍/动作来源徽标 规则·LLM·人工/预算水位/暂停原因） | 循环账本 + 文件 watch（已有） |
| 收请示 | 聊天面板决策卡片 + L0 待办 | request_user_decision（已有） |
| 做控制 | 循环卡按钮：启动/暂停/继续/停止/调预算；决策卡批准/否决 | 结构化控制通道 |
| 看过程 | 会话标签只读窥视批次/修复/任务会话 | BatchSessionPeek（已有） |
| 自由指令 | 对阶段会话说话 → LLM 转写决策记录 → 校验 → 循环执行 | 决策账本 |
| 元问题（"为什么在跑 W2？"） | 问会话，LLM 读循环账本用人话回答 | 账本机器可读 |

**外循环不拥有聊天人格**（它是确定性代码，给它聊天入口就得再接一个 LLM 来解析，决策链路反而浑浊）；用户键盘交互对象始终是原阶段会话。

### 7.2 手动/自动互斥（方向盘唯一）

- 循环运行时，向导卡/波段按钮保持可见但点击弹确认："将暂停自动循环，改为你手动驱动的这个动作"——**手动即接管**：循环转 `paused-breaker`（kind=manual-override），手动动作执行期间循环不派拍；用户可一键恢复自动。
- 循环派发的会话与用户前台会话的模型选择、会话标签、事件路由沿用现有隔离机制；批次/修复会话不抢前台（现有行为）。

---

## 8. 与既有功能的关系

- **一键托管**：VERIF 段的三段式固定脚本被本循环替换（托管 2.0）；其他阶段维持逐阶段派发现状。
- **向导卡/波段按钮**：成为"手动驾驶模式"，与循环同源（同一份行动推导），不删。
- **批次编排**：成为循环内层（`running` 状态内的一种动作类型），其判定/熔断设施原样复用。
- **C 方案可视化**：批次进度卡/修复卡/根因链/诊断时间线原样保留，循环卡是其上层。

---

## 9. 数据落盘清单（均带 version，原子写，缺字段归一）

### 9.1 `verification/results/run-loop.json`（覆盖式循环账本）

```ts
{
  version: 1, updatedAt: string,
  state: 'idle'|'planning'|'running'|'judging'|'repairing'
       |'paused-human'|'paused-breaker'|'signoff-review'|'gate-check'|'completed'|'stopped',
  wave: 'W0'|'W1'|'W2'|'W3'|null,
  beat: number,
  current: { kind: string, actionId: string|null, sessionName: string,
             dispatchedAt: string, source: 'rule'|'llm'|'human', decisionId: string } | null,
  pause: { kind: 'human'|'breaker', reason: string, detail: string,
           pendingItems: string[], since: string } | null,
  budget: { beats: number, maxBeats: number, tokensUsed: number, maxTokens: number,
            startedAt: string, maxWallMinutes: number },
  lastBeats: [{ beat: number, summary: string, decisionId: string,
                verdict: string, advanced: boolean }]   // ≤20，新在前
}
```

### 9.2 `verification/results/decision-ledger.json`（追加式决策账本，≤100 条）

```ts
{
  version: 1,
  decisions: [{
    id: string,                  // DEC-<8hex>
    createdAt: string,
    source: 'rule'|'llm'|'human',
    trigger: string,             // rule-auto / rule-stall / breaker-recovery / user-instruction / manual-override
    action: { kind: 'derived'|'custom', actionId: string|null, prompt: string,
              expectedOutput: string, stopCriteria: string },
    rationale: string,           // ≤200 字
    evidenceRefs: string[],
    status: 'proposed'|'approved'|'rejected'|'executed'|'superseded',
    outcome: 'advanced'|'no-progress'|'failed'|null   // 执行后按证据回填
  }]
}
```

---

## 10. 实施分批

### 批 1：行动推导下沉（零风险搬迁）
- verification-guidance 纯函数迁 `src/shared/`，渲染端改 import；行为对照 smoke（guidance smoke 保绿）。
- 验收：typecheck 全过（root 基线 11 不新增）；core smoke 全绿。

### 批 2：循环骨架（主进程）
- `VerifRunLoop`（AgentService 辅助模块，纯函数决策节拍 + 状态机）：状态机 + run-loop.json + 预算熔断 + IPC（start/pause/resume/stop/status）+ 复用批次派发/判定/修复门控；规则层闭环（暂不接 LLM 决策层，规则空转直接 paused-human）。
- 验收：新增 loop smoke（状态迁移/预算熔断/恢复/账本截断）；core 全绿。

### 批 3：决策层 + 暂停恢复
- decision-ledger.json + `propose_run_decision` 工具 + 规则层合法性校验 + 决策卡片接线（顾问模式）+ 委托模式白名单 + 暂停/恢复协议（证据触发）。
- 验收：决策账本 smoke（校验拒绝/双源登记/结果回填）；暂停恢复链路 smoke。

### 批 4：UI + 托管切换 + 互斥
- 运行页签外层循环卡；启动对话框（预算）；手动接管互斥；一键托管 VERIF 切换到循环；e2e 观察脚本适配。
- 验收：真实项目跑一轮"VERIF 一键自主到门禁"，记录拍数/暂停点/决策账本审计；typecheck 全过；core+integration 全绿。

每批口径沿用既有规范：typecheck 全过、smoke 随批交付、引擎包零新依赖。

---

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| LLM 决策提案质量差 | 白名单+合法性校验+顾问模式默认；错误决策由无进展检测 3 拍内抓住 |
| 规则空转误判（实际有进展但没检测到） | "推进"判定用多信号（新证据/指纹变化/闭环计数）；误判后果只是升级待人，不丢工作 |
| 委托模式烧钱 | token 预算硬熔断 + 决策账本审计 + 默认顾问模式 |
| 循环与手动操作互相打架 | 方向盘唯一：手动即接管（§7.2） |
| 重启后循环状态错乱 | 账本覆盖式落盘 + 启动对账（会话存活性校验，沿用 interrupted-sessions 口径） |

---

## 12. 已知局限（对"感觉还缺点什么"的诚实回应）

1. **循环质量上限 = LLM 单元执行质量 × 规则表覆盖率**。决策层只能缓解规则表的闭集性，不能消除；规则表本身需要随真实项目持续补规则。
2. **只覆盖 VERIF**。REQ_SPEC/ARCH/RTL 的长程化是另一个课题（文档/代码产出型阶段的"完成"判定比验证的证据判定更主观），本设计不承诺。
3. **暂停待人时的等待是开放式的**：用户离线时循环一直停着（这是特性），但没有通知机制（桌面通知/邮件属未来项）。
4. **预算计数依赖会话统计准确性**；pi 侧统计缺口会传导到预算熔断的精度。
5. 本设计与"验证态势页"的信息分层已对齐（循环卡属 L1，决策账本明细属 L2），但**循环运行的全过程回放**（逐拍复盘视图）本版不做，留观察后再定。

---

## 13. 待决策问题

1. 委托模式的默认白名单范围（本方案默认仅顾问模式，委托需显式开启）。
2. 预算默认值（拍数 50 / 墙钟 4 小时 / 无进展 3 拍）是否合适，实测后调。
3. 循环是否对"快速综合通道"（跳过 VERIF/QA）开放——本方案默认不开放。
4. `paused-human` 是否需要桌面通知（os notification）提醒用户回来处置。
