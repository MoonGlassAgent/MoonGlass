# 决策卡 UI 改版指导（决策语言人性化）——渲染端交接

| 项目 | 内容 |
|---|---|
| 日期 | 2026-10-21 |
| 状态 | 主进程侧已落地（humanSummary 字段 + 提示词三段式），本文档为渲染端对接规格 |
| 背景 | 用户实测：决策/批准卡用编排黑话（闭环计数/W1 批次/绑定登记/advanced 拍），工程师读不懂在裁决什么。决策语言统一改为 **IP 行为语言** |

## 1. 数据契约（主进程侧已提供）

`verification/results/decision-ledger.json` 的决策条目新增可选字段：

```json
{
  "id": "DEC-XXXX",
  "humanSummary": "BIST 状态寄存器的 fail_cnt 位域被 RTL 截断成 16 位，与 register_map v0.2 的 32 位定义不符；需要你裁决：修 RTL 还是改规格。（≤300 字，IP 行为语言）"
}
```

- 字段名：`humanSummary`（可选；旧提案没有该字段）
- 归一化：主进程登记/读取时透传，超 300 字截断
- 渲染端视图类型（`src/renderer/components/verif-run/types.ts` 的 `VerifRunDecisionEntryView`）加同名可选字段即可

## 2. ProposedDecisionCard 改版规格

文件：`src/renderer/components/verif-run/ProposedDecisionCard.tsx`

**现状**：rationale 全文直接显示；prompt/expectedOutput/stopCriteria 截断平铺。

**改为**：

```text
┌──────────────────────────────────────────────┐
│ DEC-XXXX  [LLM]            2026/10/21 14:03  │
│                                              │
│ 【工程师摘要】（humanSummary，正常字号主视觉）   │
│ BIST 状态寄存器的 fail_cnt 位域被 RTL 截断成   │
│ 16 位，与 register_map v0.2 的 32 位定义不符； │
│ 需要你裁决：修 RTL 还是改规格。                │
│                                              │
│ ▸ 技术细节（折叠，默认收起）                    │
│   归因（rationale）/ 动作指令（prompt）/        │
│   预期产出 / 停止条件 / 证据 N 条               │
│                                              │
│              [✓ 批准]  [✗ 否决]               │
└──────────────────────────────────────────────┘
```

要点：

- **humanSummary 是主视觉**：正常字号、完整显示（不 truncate），位置在头部徽标行之下、按钮行之上
- **回退规则**：无 `humanSummary` 的旧提案 → 主视觉显示 `rationale`（与现状一致），折叠区照常
- **折叠区**：`rationale`（有 humanSummary 时移入折叠区）、`action.prompt`、`expectedOutput`、`stopCriteria`、`evidenceRefs.length` 全部进"技术细节"折叠（默认收起，点开展示）；`actionId` 徽标保留在头部
- 批准/否决按钮、busy/error 处理、`onDecide` 回调全部不动
- ChatPanel 会话底部请示区与 RunLoopCard 复用同一组件，改这一处两边同时生效

## 3. i18n 键（双语，zh-CN 为源）

建议新增：

```ts
// zh-CN/verifRun.ts → loop 命名空间下
humanSummary: '工程师摘要',
techDetails: '技术细节',
// en/verifRun.ts
humanSummary: 'Engineer Summary',
techDetails: 'Technical Details',
```

折叠区 aria/提示文案走既有惯例。禁止硬编码界面文案。

## 4. 不在本次范围

- `request_user_decision` 结构化决策卡（ChatPanel 内）：**UI 不动**。其内容人性化由提示词层保证（标题/正文必须 IP 行为语言）——本次只改写内容的一方。
- 决策历史区（已裁决条目）不动。
- 审批通过后卡片消失/状态迁移逻辑不动。

## 5. 验收清单

- [ ] 带 humanSummary 的新提案：摘要主视觉完整显示，技术细节默认折叠
- [ ] 旧提案（无 humanSummary）：显示与现状一致（rationale 主视觉）
- [ ] 批准/否决/改写后批准（onDecide 回调）行为不变
- [ ] ChatPanel 与 RunLoopCard 两处复用同时生效
- [ ] i18n 双语键齐全，无硬编码文案
- [ ] `pnpm typecheck` 过；渲染端既有测试不回归

## 6. 内容侧已配套（主进程已完成，供理解全貌）

- `propose_run_decision` 工具新增 `humanSummary` 参数 + 指引强制三段式（行为现状 → 裁决点 → 编排背景只进执行指令）
- 升级会话模板（buildRunLoopEscalationPrompt）要求必写 humanSummary 并附好坏对照示例
- `request_user_decision` 指引：标题/正文必须 IP 行为语言，编排术语禁止进标题与首段
