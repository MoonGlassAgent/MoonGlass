# 流程看板与 Review-Update 闭环（设计文档）

| 项目 | 内容 |
|---|---|
| 日期 | 2026-11-12 |
| 状态 | 已评审（用户基本同意），实施中 |
| 背景 | 用户要求：① 类似流程 DAG 看板（阶段列+任务卡+尝试记录）；② ARCH/RTL review 后更新自动回到原会话（关闭才新开） |

---

## 1. 目标与范围

**A. 流程看板**：把「阶段 → 任务 → 尝试（attempt）」三层事实以 DAG 形式呈现——阶段列、任务卡（批次/修复/review/UT/决策）、每次尝试一行（模型、判定、耗时）。

**B. Review-Update 闭环**：ARCH/RTL 的独立审查会话 settle 后，**更新动作自动回到发起会话**执行，处置完成自动复核并收敛；只有原会话已关闭时才派新会话接管。

非目标：不重做现有验证循环/门禁/决策链路；看板是只读视图，不与编排耦合。

## 2. 数据模型（全部来自既有账本，不新造数据管道）

| 看板层 | 来源 |
|---|---|
| 阶段列 | `projects.json` phases + PhaseEngine 门禁结果 |
| 任务卡 | `verif-batch-loop.json`（批次）、`rtl-fix-outcomes.json`（修复判定）、`decision-ledger.json`（决策提案）、`review-request.json`（审查请求）+ 模块 UT 账本 |
| 尝试记录 | 各会话 JSONL：模型 ID、起止时间、settle 判定（completed/FIXED/STILL_FAIL/no-evidence/circuit-broken/异常） |

统一卡片模型（主进程 `board-model.ts` 归一化）：

```ts
interface BoardTask {
  id: string                 // 稳定任务 id（如 batch-12 / RC-xxx / DEC-xxx / review-<type>-<round>）
  kind: 'batch' | 'rtl-fix' | 'design-review' | 'module-ut' | 'decision' | 'run-loop'
  title: string              // 任务一句话（场景标题/根因/审查类型）
  phase: Phase
  status: 'success' | 'running' | 'needs-fix' | 'pending-human' | 'not-started'
  attempts: BoardAttempt[]   // 每次派发一次新会话 = 一次 attempt
}
interface BoardAttempt {
  index: number              // 第几次尝试（从 1 起）
  model: string              // provider/model（可取会话实际用模）
  verdict: 'success' | 'failed' | 'no-evidence' | 'circuit-broken' | 'error' | 'running'
  startedAt: string
  settledAt?: string
  note?: string              // 一句话判定理由（FAIL 指纹/no-evidence 原因等）
}
```

## 3. Review-Update 闭环（核心）

### 3.1 闭环四拍

```
① 审查 settle（正常完成）
   → 主进程 resumeAfterDesignReview 向发起会话投递跟进消息（已有）
② 更新驱动：跟进消息必须驱动发起会话真实行动——按发现清单逐条处置
   （fixed/waived/pending 三态写回清单），而不是只留一句提示
③ 自动复核：处置写回后自动重评 pendingMajor（发现清单归一合并口径），
   =0 才算闭环；>0 则允许再跑一轮 review（仍回原会话）
④ 收敛：pendingMajor=0 → 阶段门禁自动重跑（不必用户手动点推进）；
   若处置后又有新 major，允许最多再跑 N=2 轮 review-update，仍不清零回人
```

### 3.2 原会话优先，关闭才新开

- 原会话在线（前台同一对象或在 backgroundSessions）→ 投递到原会话；
- 原会话已 dispose/不在线 → **派一个新的更新会话**（`phase-<phase>--review-update-<type>`）接管处置，而不是只留状态消息；
- 防重：同一 review 请求只续跑一次（consumed 闸），同请求不重复投递/重复派生。

### 3.3 收敛与停止

- `pendingMajor=0`：停止，阶段门禁自动重跑并放行（软门禁口径不变）。
- `pendingMajor>0` 且还有可处置项：允许再跑一轮 review（原会话）+ 更新；**最多 2 轮**。
- 超过 2 轮仍未清零 → 暂停待人（paused-human，附清单），不无限循环。

### 3.4 与既有设施的关系

- `resumeAfterDesignReview`（已落地）是第 ① 拍的入口，本设计补 ②③④。
- 处置写回沿用发现清单极简四字段（描述/位置/严重度/处置），多轮 `rounds[]` 合并按键保留。
- 交叉 review（换模型再审）是**可选增强**，不在本闭环默认路径（不因此新开审查会话）。

## 4. 看板呈现

- 阶段列（REQ_SPEC/ARCH/RTL/VERIF/QA/SYNTH）按 DAG 排列；每列下按任务时间序列排卡片。
- 卡片：标题 + 状态色（成功绿/进行中蓝/要求修改红/待人黄/未开始灰）+ 类型徽标 + 最近尝试摘要。
- 尝试行展开：模型、判定、起止、耗时、note。决策待批卡片链接到决策卡（批准/否决入口保留）。
- 数据来源归一化在主进程，渲染端只读呈现（新增独立页面/区块，不改既有 VerifRunPanel）。

## 5. 实施切分

- **片 A（闭环）**：AgentService review settle → 原会话更新驱动（含 settle 判定）+ 自动复核 + 收敛门禁重跑 + 关闭时新派更新会话 + smoke。
- **片 B（看板数据层）**：`board-model.ts` 归一化器 + IPC + smoke。
- **片 C（看板 UI）**：独立看板页面（新文件，零碰撞）。

## 6. 验收

- review settle 后原会话实际开始处置（不是只留消息）；pendingMajor 随处置下降。
- pendingMajor=0 时门禁自动重跑通过；>0 时最多 2 轮后暂停待人。
- 原会话关闭时新派更新会话且行为一致；同一请求不重复续跑。
- 看板正确呈现阶段/任务/尝试三层；尝试记录含模型与判定。
