# MoonGlass AIGV 验证态势优化方案（讨论稿）

> 状态：讨论稿 · 供专家团队评审
> 日期：2026-09-01
> 关联版本：MoonGlass v0.8.0
> 结论先行：AIGV 的"骨"（风险驱动验证、证据闭环、签核门禁）是对的，"皮"（结构穷举场景、多文件、五层账本）过重，建议"收敛"而非"推倒"。

---

## 1. 背景与现状

MoonGlass 在 VERIF 阶段引入了一套 AIGV（AI-Guided Verification，智能验证）"数字孪生"：由确定性引擎 `build_verification_intelligence` 从需求/规格文档 + RTL 结构事实（FSM/寄存器/时钟域/依赖/锥体）生成一套验证模型，再由 LLM Agent 按优先级执行仿真、Formal 等闭环。

当前产出的机器模型（`verification/intelligence/` 下）：

- `requirement-model.json`：需求/规格提取
- `structural-model.json` + `slang-ast.json`：RTL 结构分析
- `risk-register.json`：风险寄存器（~100 条）
- `scenario-registry.json`：验证场景（~30~104 个）
- `verification-intent-registry.json`：验证意图（与场景 1:1）
- `coverage-hole-register.json`：覆盖缺口（与场景 1:1，C1-C6 分类）
- `spec-gap-register.json`：规格缺口
- `verification-state.json` / `verification-posture.json`：聚合模型 + 页面快照
- `multi-oracle / mutation / formal / residual-risk / signoff-package` 等五层门禁产物

共 **20+ 个 JSON 文件**，页面从快照读取并展示进展、风险、下一步。

## 2. 问题诊断（均基于实际运行证据）

### 2.1 场景/Intent 是"结构穷举"而非"语义验证点"

确定性引擎从 RTL 结构 + 15 条风险规则（R01 事件碰撞、R05 计数器边界、R07 错误/正常碰撞……）对每个模块穷举生成场景。实测 MoonGlass_NPU 生成 30 个、DEC_VISINEX 生成 97~104 个，大量目标文本是模板套话：

> "验证 vbc_entropy_dec 在 begin、if、r_ones1、r_win 发生指定时序交互及边界条件时，外部可见状态、响应和计数结果始终符合规格……"

**引擎读不懂规格语义**。真正重要的验证点（"引擎虚假重启""MAC 流水线 off-by-one"）是 Agent 读规格 + 跑仿真才发现的，而非这 100 个场景给出的。

### 2.2 多文件、无单一事实源

场景状态、意图、覆盖缺口分别散落在 `scenario-registry` / `intent-registry` / `coverage-hole-register` / `state` / `posture` / `scenario_hits` 等文件中，且**没有一个"谁说了算"的唯一写入方**。实测出现：

- Agent 用通用 write/edit 手改多个 JSON，甚至把 `verification-posture.json`（页面数据源）覆盖成人类可读的"批量进度摘要"，导致页面回退成空数据；
- Agent 发明了非标准状态 `ADJUDICATED`（标准枚举里没有），页面不识别；
- "Agent 说写回了、页面不刷新"——Agent 写 registry，页面读 posture 快照，两者脱节。

### 2.3 账本比工作重：五层门禁大量停留在 NOT_READY

Multi-Oracle / Mutation / Formal / Residual-Risk / Signoff-Package 这五层，在中小设计上 90% 时间处于"未就绪"，制造了大量噪音。实测 MoonGlass_NPU 状态：

- 功能回归 24/24 通过，真实 RTL bug 已修复；
- 但机器签核仍被 24 个覆盖缺口、2 个 Formal 工具错误、29 个影响未知、23 个关键场景未闭环挡住；
- 其中 2 个 Formal 错误是 Yosys async2sync 的**工具限制**，不是 RTL 缺陷，却被当作"门禁失败"。

### 2.4 状态模型模糊

`ScenarioStatus` 有 12 个枚举值，另有 `ScenarioState`（lifecycle/reach/judgment/evidence/freshness/closure 六轴）。实际使用中 Agent 无法精确对齐，于是自造 `ADJUDICATED`；`PARTIAL` 语义也不清（规格已澄清但未执行 vs 部分执行）。

### 2.5 页面/Agent 脱节

页面读的是"快照"，Agent 写的是"注册表"，两者只在 `build_verification_intelligence` 重建时才同步。任何增量裁决（规格澄清、场景执行）都不会即时反映到页面。

## 3. 优化方向

### 方向 A：收敛，不动架构（低风险，建议立即做）

1. **场景收敛**：去重 + 上限（每模块 × 每风险类型只留 top，全局 ≤ 20）；其余保留在 JSON 作"完备性兜底"，但不展示、不排队。
2. **文件收敛**：20+ 个 JSON → 3 个核心事实源
   - `verification-status.json`（单一事实源：场景状态 + 裁决 + 回归证据）
   - `risk-register.json`、`spec-gap-register.json`（保留，本就有价值）
   - 五层门禁产物降级为"按需生成、存报告"，不再平铺。
3. **状态模型简化**：12 个 ScenarioStatus → 6 个（`NOT_STARTED / RUNNING / PASSED / FAILED / BLOCKED / WAIVED`），消除非标准状态与 `PARTIAL` 模糊。

### 方向 B：LLM 主导验证规划（中风险，收益最大）

把流程反过来：**不再是"引擎生成 100 场景 → Agent 逐个执行"，而是"Agent 读规格 + 风险寄存器 → 圈出 top 5~10 个真实验证点（点名信号 + 判定标准）→ 引擎只做证据记账"。**

- 引擎只产"风险候选"（哪里可能出问题），不再产 100 个套话 Intent；
- LLM 读规格后精炼成可执行的验证点（已部分落地：`refine_verification_intents` 工具 + 提示词步骤 4.1）。

### 方向 C：重型层取舍（大决策，涉及规格书）

明确回答：**Multi-Oracle / Mutation / Formal / Residual-Risk / Signoff-Package 这五层，是否要作为"机器签核门禁"？**

- **保留但按需**：只在关键场景上触发，不默认生成、不默认阻断；Formal/覆盖率受工具链环境限制时，明确记为"环境待补齐"，不伪称失败。
- **砍掉**：降级为"用例 pass/fail + 覆盖率 + 证据清单 + 门禁结论"，签核由人 + Agent 独立审查完成。

## 4. 推荐路线

1. **先做 A（收敛）**：把 AIGV 从"重"变成"能用"——场景收敛、状态简化、单一事实源。
2. **再做 B（LLM 主导）**：把"能用"变成"有用"——让 Agent 读规格圈真风险。
3. **C 由专家团队决策**：五层门禁的去留。

## 5. 待决策问题

1. 五层门禁（Multi-Oracle / Mutation / Formal / Residual-Risk / Signoff）是"保留但按需"还是"砍掉"？
2. 场景收敛的"度"：cap 到 10？20？还是只保留"关键风险清单"？
3. 状态模型简化后，`PARTIAL` 的语义如何表达（拆成"已裁决待执行"等明确状态，还是删除）？
4. 是否接受"LLM 主导规划"带来的不确定性（LLM 可能漏掉结构风险）？如何用确定性引擎做兜底？

## 附录：关键数据（问题证据）

- DEC_VISINEX：需求 86、风险 99、场景 97、Intent 97、Coverage Hole 97、Spec Gap 68（修复解析 bug 后）；其中 39 个 `BLOCKED_BY_SPEC`、65 个 `DISCOVERED`，0 个真正闭环。
- MoonGlass_NPU：场景 30、关键未闭环 23、阻断 Coverage Hole 24（全部为 C3 激励缺失）、2 个 Formal ERROR（Yosys async2sync 工具限制）、29 个影响未知；功能回归 24/24 PASS。
- 状态分布（MoonGlass_NPU，迁移前）：`ADJUDICATED×7`（非标准状态，页面不识别）。
