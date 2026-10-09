# 设计评审左移：ARCH/RTL 出口 Review 与微架构分级门禁（设计文档）

| 项目 | 内容 |
|---|---|
| 日期 | 2026-10-09 |
| 状态 | 已评审（用户拍板），实施中 |
| 背景项目 | MoonGlass_GMAC、DEC_Visinex（W2/W3 澄清成本实测） |

---

## 1. 背景与归因

W2/W3（验证增补/收口）阶段的大量工作实际是规格、架构、RTL 阶段欠下的债，在验证阶段以"澄清"的形式偿还，成本被放大一个量级以上。两条根因：

1. **架构阶段文档粒度过大**：关键实现没有解释清楚，设计文档与 RTL 之间存在 gap。
   现状实证：`microarchitecture.md` 是 info 级选配（`module-partition-sane`，"按复杂度选配"），
   架构阶段只强制 `architecture.md` + `interface_spec.md`。
2. **RTL 阶段无语义一致性检验**：lint + 死逻辑检查只保证基础代码质量；RTL 与设计文档/
   规格在语义上是否一致，第一次被检验是在 VERIF 阶段跑功能验证时——最贵的地方。
   现状实证：RTL→VERIF 门禁只有 `verible-lint-zero-error` + `port-consistency`（接口级）。

## 2. 设计原则（用户拍板）

- **活动驱动，不条款化**：MoonGlass 保证"审查活动真实发生、发现被处置、证据可溯"，
  **不规定审查方法**——怎么审由 LLM 自由发挥。不做条款↔章节↔RTL 的机械映射
  （现实设计不是线性映射，机械绑定导致过约束和价值丢失）。
- **交叉 review**：建议用户切换模型再发起 1–2 轮独立 review（不同模型有不同盲区，
  同构于人类团队的"换人二审"）。软引导，不构成门禁。
- **目标是有效拦截，不是覆盖率**：拦截主要问题、可见的简单问题和可能的深层问题；
  明确不追求高覆盖率 bug 拦截。
- **防膨胀**：不新增文档类型；review 产物只有"报告 + 发现清单"两件；发现清单极简。
- **先软后硬**：两个 review 门禁先软运行（告警不阻断），实测误报率后再评估升硬。

## 3. 方案一：微架构文档按复杂度强制（去锚点化）

- 复杂度可计算、粗分档：规格条款数 > 50 **或** 模块数 > 4 →
  `microarchitecture.md` 从 info 选配升为 **error 级必选**；未超阈值维持现状（info）。
- 内容只给最小引导（不管映射）：每个非平凡模块应有功能描述、状态机（状态+转移条件）、
  寄存器与边界行为、关键时序关系。写法与组织由 LLM 按设计实际自由决定。
- **明确不做**：章节与规格条款的锚点绑定（用户否决：过约束）。

## 4. 方案二：ARCH 出口一致性 Review（新增）

- **目标单一**：需求-规格是否都被设计文档覆盖实现。工艺/面积等 TBD 项明确排除。
- 独立 review 会话（不是设计会话自审），LLM 自由审查。
- 产出：`docs/03_design/review-arch-consistency.md`（报告）+
  `docs/03_design/review-findings.json`（发现清单）。

## 5. 方案三：RTL 出口语义 Review

- **目标单一**：RTL 实现与设计文档/规格在语义上是否一致（纯静态阅读，不跑仿真）。
- 独立 review 会话（禁止实现会话自审），LLM 自由审查。
- 产出：`rtlqa/review/semantic-review.md` + `rtlqa/review/review-findings.json`。

## 6. 发现清单数据结构（极简，用户拍板）

```json
{
  "version": 1,
  "generatedAt": "<ISO>",
  "reviewRound": 1,
  "model": "<provider/model>",
  "findings": [
    { "描述": "…", "位置": "rtl/gmac_axil_regs.v:245 或 docs/02_requirements/…#REQ-X", "严重度": "major", "处置": "pending" }
  ]
}
```

- 字段只有四个：**描述、位置、严重度（major/minor）、处置（fixed/waived/pending）**，除此之外不加字段。
- 发现没有 id 字段；处置回写的稳定键 = `位置 + 描述` 的归一化哈希（同模式复用死逻辑裁决的 key 思路）。
- 多轮 review 存 `rounds[]`：每轮记录 `model`、`generatedAt`、该轮发现；处置状态跨轮按键合并。

## 7. 门禁集成（软运行）

| 门禁 | 阶段 | 级别 | 通过条件 |
|---|---|---|---|
| `module-partition-sane`（改造） | ARCH→RTL | 超阈值升 error | 微架构文档存在且有效 |
| `arch-consistency-review`（新） | ARCH→RTL | warning（软） | review 报告存在 且 无 pending 状态的 major 发现 |
| `rtl-semantic-review`（新） | RTL→VERIF | warning（软） | review 报告存在 且 无 pending 状态的 major 发现 |

- 软运行期：不通过只告警，消息里给出"如何补齐"的指引；发现处置为 fixed/waived 即视为已处置。
- 交叉 review 建议搭载在门禁消息中：首轮 review 完成后，消息提示"建议切换模型再发起一轮独立 review"；
  态势可看到"本阶段经过 N 轮 review、分别什么模型"。
- 实测一轮误报率后再评估是否升硬门禁（error）。

## 8. 触发与派发机制

- 阶段提示词（ARCH/RTL）增加一步：工作完成、自评就绪后，调用 `request_design_review` 工具
  （参数：review 类型、范围说明）。该工具**不自己审**，只写 `review-request.json` 并返回
  "独立审查会话将由系统派发"。
- 主进程在会话 settle / 证据轮询中发现 review-request → 派一个**全新的独立会话**执行 review
  （上下文干净，看不到实现会话的推理过程，只看到产物）→ 会话按模板写报告与发现清单。
- 记录每轮 review 的 provider/model（从会话实际用模取），供交叉 review 建议与态势展示。

## 9. 与现有设施的边界

- 语义 review **不替代功能验证**：它只保证"实现的确实是设计的"；行为正确性仍归 VERIF。
- 发现处置为"修复"时，改动走正常 RTL/文档修改路径，lint/死逻辑等既有检查照常过。
- 规格模糊的澄清**回填到规格文档**（不在会话里飘散）——这同时治 W2/W3 反复澄清的根。
- 与验证运行循环无耦合：review 发生在 ARCH/RTL 阶段出口，循环设施不涉及。

## 10. 实施切分

- **片 A（门禁与数据层）**：PhaseEngine 复杂度分级（`module-partition-sane` 改造）+
  两个软门禁（`arch-consistency-review` / `rtl-semantic-review`）+ 发现清单归一化助手 + smoke。
- **片 B（工具与派发）**：pi-bridge `request_design_review` 工具 + 主进程监听派发独立 review 会话
  （记录模型）+ ARCH/RTL 阶段提示词增加 review 步骤 + 交叉 review 建议门禁文案 + smoke。
- **渲染端零改动**：门禁结果与消息走既有渲染路径；交叉 review 建议放在门禁 detail 文案里
  （避开另一团队在途的渲染端文件）。

## 11. 验收

- 复杂度阈值两档行为正确（超阈值必选 / 未超阈值 info）。
- 无 review 证据时软门禁告警且文案给出指引；有 pending major 发现时告警升级措辞。
- review 会话独立性：由 `review-request.json` 触发的新会话执行，模型身份被记录。
- 多轮 review 的发现按键合并、处置状态正确保留。
- 全部既有 smoke 不回归；新逻辑有新 smoke 覆盖。
