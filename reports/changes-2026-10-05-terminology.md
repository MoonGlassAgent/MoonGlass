# MoonGlass 修改报告：验证循环术语统一（2026-10-05 补充）

面向对象：MoonGlass 原始开发团队
类型：**纯文案与提示消息修改**（无逻辑、无契约、无迁移）
基线：`bbf6a94`（含 2026-10-05 轮 P0/P1 全部提交）
状态：**未提交**（工作区改动）

---

## 0. 摘要

把验证运行循环的**用户可见文案**从自造术语「拍」统一为「**步**」，英文由 `Beat` 统一为 `Step`。

| 项 | 值 |
|---|---|
| 文件 | **9 个**（8 代码/脚本 + 1 设计文档） |
| 代码量 | **+64 / −37** |
| 用户可见文案 | 中英各 **10** 处 + 主进程状态消息 **9** 处 |
| 补漏 | **4 处**（原提交遗漏，当时就已存在的用户可见文案） |
| 逻辑/契约/迁移 | **无**。账本字段仍为 `beat`，不涉及 schema 与兼容 |
| 验证 | typecheck 5 包全过 · root 11 项既有错误零新增 · core **36 项全过** · build 通过 |

---

## 1. 动因

### 1.1 用户实测反馈

用户在使用「验证运行」页签时提问：**"这个『拍数』是什么？"**

「拍」是 MoonGlass 自造术语（节拍比喻），不属于芯片验证或 EDA 领域的既有词汇。
用户看不出「拍数 11 / 50」在数什么，也不知道它和「批次」「场景」是什么关系——
**自造术语本身即 UI 缺陷**。

### 1.2 这个修正此前做过，被回退丢失

同一问题在 2026-09-30 已被提出并修复过，提交 `fd0d48a`
（`refactor(verif): 循环预算术语统一为"循环步数"（替代自造的"拍"）`，4 文件 +40/−34）。

该提交位于 2026-10-05 回退到 v1.1.0 时被丢弃的 9 个提交之中，
因此界面又变回「拍数」。本次**重新应用并补齐遗漏**。

---

## 2. 术语定义（本次同时落到设计文档）

- 一「**步**」= 循环完成一次「读态势 → 推导动作 → 派发执行 → 判定结果」的完整回合；
- 内部与账本字段**仍称 `beat`**（不改 schema），仅界面统一称「步」；
- **一「步」不等于一件事**：批次类动作的一步内部会跑内层批次循环（默认最多 20 批）；
- 因此 `noProgressLimit`（默认 3）按**步**计而非按批计——最坏情况下一次熔断前
  可能出现 3 步 × 20 批的重复派发（该缺口由 P2 解决，尚未实现）。

---

## 3. 改动清单

### 3.1 中文界面（`src/renderer/i18n/locales/zh-CN/verifRun.ts`）

| 键 | 改前 | 改后 |
|---|---|---|
| `beat` | 第 {n} 拍 | 第 {n} **步** |
| `noCurrent` | 本**拍**尚未派发动作 | 本**步**尚未派发动作 |
| `beatsBudget` | **拍数** | **循环步数** |
| `beatsTitle` | 最近**节拍**（新在前，绿点=推进） | 最近**步骤**（新在前，绿点=推进） |
| `startDialog.description` | 循环按**拍**自动推导并执行验证动作… | 循环逐**步**自动推导并执行验证动作… |
| `startDialog.maxBeats` | **拍数上限** | **循环步数上限** |
| `startDialog.maxBeatsHint` | 最多自动执行的**拍数**（默认 50） | 最多自动执行多少**步**；每步 = 一次验证动作派发（批次类动作的一步内部可含多批），默认 50 |
| `startDialog.noProgressLimit` | 连续无进展上限（**拍**） | 连续无进展上限（**步**） |
| `startDialog.noProgressLimitHint` | 连续多少**拍**无进展即熔断升级（默认 3） | 连续多少**步**无进展即熔断升级（默认 3） |
| 文件头注释 | — | 新增术语说明（步的定义 / 内部仍称 beat / 一步≠一件事） |

> `maxBeatsHint` 在原文案基础上**补了一句"每步 = 一次验证动作派发（批次类动作的一步内部可含多批）"**——
> 这正是用户困惑的核心，原提交的提示语仍不足以自解释。

### 3.2 英文界面（`src/renderer/i18n/locales/en/verifRun.ts`）

| 键 | 改前 | 改后 |
|---|---|---|
| `beat` | Beat {n} | **Step** {n} |
| `noCurrent` | No action dispatched this **beat** | … this **step** |
| `beatsBudget` | **Beats** | **Loop steps** |
| `beatsTitle` | Recent **beats** (…) | Recent **steps** (…) |
| `startDialog.description` | …beat by beat… | …**step by step**… |
| `startDialog.maxBeats` | Max **beats** | Max **loop steps** |
| `startDialog.maxBeatsHint` | Maximum automatically executed **beats** (default 50) | How many **steps** the loop may execute automatically; each step is one verification action dispatch (a batch-loop step may contain several batches). Default 50. |
| `startDialog.noProgressLimit` | No-progress limit (**beats**) | No-progress limit (**steps**) |
| `startDialog.noProgressLimitHint` | Consecutive **beats** … | Consecutive **steps** … |
| 文件头注释 | — | 新增术语说明 |

### 3.3 主进程状态消息（用户会在会话流中看到）

`src/main/services/AgentService.ts`——9 处 `emit`：

启动预算行（`拍数 ≤N…连续无进展 ≤N 拍` → `循环步数 ≤N…连续无进展 ≤N 步`）、
暂停提示（当前**拍**完成 → 当前**步**完成）、恢复提示（重新推导下一**拍** → 下一**步**）、
决策派发（第 N **拍**：决策 → 第 N **步**：决策）、W0 规划派发（第 N **拍**：基线规划 → 第 N **步**）、
规则决策停止条件（**拍** settle → 本**步** settle）、规则动作派发（第 N **拍**：{动作} → 第 N **步**）、
**步**完成汇总、决策批准后恢复（下一**拍**执行已批准决策 → 下一**步**执行）。

`src/main/services/verif-run-loop.ts`——3 处：

| 位置 | 改前 | 改后 |
|---|---|---|
| `rule-stall` 熔断明细 | 连续 N **拍**无进展（上限 M **拍**） | 连续 N **步**无进展（上限 M **步**） |
| `max-beats` 熔断明细 | **拍数** N/M | **循环步数** N/M |
| 决策升级会话 prompt | 规则层已连续多**拍**无进展 | 规则层已连续多**步**无进展 |

### 3.4 原提交遗漏的 4 处（本次补上）

这 4 处用户可见文案在 `fd0d48a` 当时**就已存在**，但原提交没有改到：

| 文件 | 文案 |
|---|---|
| `src/main/services/decision-ledger.ts` | 决策批准前校验的拒绝原因：`拍数预算已超限（N/M）` → `循环步数预算已超限（N/M）`（**这一步会直接展示给批准决策的工程师**） |
| `src/renderer/i18n/locales/zh-CN/workspace.ts` | 一键托管完成提示：`验证运行循环已完成（{beats} 拍）` → `（{beats} 步）` |
| `src/renderer/i18n/locales/en/workspace.ts` | `completed ({beats} beats)` → `completed ({beats} steps)` |
| `src/main/services/AgentService.ts` | `验证运行循环恢复：下一拍执行已批准决策` → `下一步执行已批准决策` |

### 3.5 设计文档（`docs/VERIF-RUN-LOOP-DESIGN-ZH-CN.md`）

在该文档头部新增一段**术语说明**（7 行）：说明内部保留「拍/节拍」与账本字段 `beat`、
界面统一「步」、一步的定义、一步≠一件事、`noProgressLimit` 按步计的后果，以及 P2 尚未实现该缺口。

文档正文的 18 处「拍」**有意保留**——它是内部设计口径的记录，与账本字段一致。

### 3.6 测试（`scripts/decision-ledger-smoke.mjs`）

| 断言 | 改前 | 改后 |
|---|---|---|
| 预算超限拒绝原因 | `reason.includes('拍数')` | `reason.includes('循环步数')`（+ 注释说明术语变更） |

该断言锁定的是**用户可见措辞**，措辞变更必须同步更新——与 P1 阶段
`verification-guidance-smoke` 的签核断言同类处理。

---

## 4. 有意不改的三类

| 类别 | 例子 | 理由 |
|---|---|---|
| 内部注释、开发日志、账本字段 | `AgentService.ts` 的 `// 拍循环…`、`console.error('…不影响拍记账')`、账本字段 `beat` | 按原提交确立的口径：**内部/账本仍称 beat**，避免无意义的改动面扩大与 schema 变更 |
| RTL 语境的「拍」 | 桥接工具提示 `改 vbc_rate_ctrl 首拍 flush 锁存参数`；`e2e-managed-verif.mjs` 的 `下一拍回绕`、`寄 1 拍` | 这是**时钟周期**语义，与运行循环无关，误改会造成事实错误 |
| 「拍板」 | `verification.ts` 的 `需要你逐条拍板` / `需要你拍板` | 另一个词（决定），与「拍」同形不同义 |

---

## 5. 验证

| 检查 | 命令 | 结果 |
|---|---|---|
| 子包类型检查 | `pnpm typecheck` | 5 个子包全过 |
| 主工程类型检查 | `pnpm typecheck:root` | **11 项既有错误，零新增** |
| 核心回归 | `pnpm test` | **36 项全过**（退出码 0） |
| 构建 | `pnpm build` | 通过 |

**残留扫描**（改后）：i18n 内仅剩头部术语说明与「拍板」；主进程内仅剩注释与开发日志；
不含任何用户可见的「拍」。英文侧不含任何显示用的 `Beat`。

**已知环境噪声**：`pnpm test` 在连续执行时偶发 `EPERM: rename ...tmp` 失败
（临时目录文件被占用，疑似杀毒/索引干扰）。单独复跑该脚本 3/3 通过，
重跑整套亦通过；与本改动无关，但建议团队留意 CI 稳定性。

---

## 6. 与仓库当前状态的关系

- 2026-10-05 轮的 P0/P1 工作与两份报告（`reports/changes-2026-10-05.md`、
  `reports/merge-request-2026-10-05.md`）已由并行会话提交为 5 个 commit（`b1d3eda`…`bbf6a94`）；
- **本报告描述的 9 个文件改动是其后新增的、尚未提交的工作**；
- 工作区内另有**不属于本次改动**的修改（`ChatPanel.tsx`、`WorkspacePage.tsx`、
  `CHANGELOG-DEV.md`、新增 `scripts/repair-session-names.mjs`），来自并行会话，
  合入时需与本次改动分开提交。
