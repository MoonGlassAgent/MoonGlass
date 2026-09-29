# MoonGlass AIGV 验证策略修订：TOP 优先，UT 例外

> 状态：已实施（批 1-4 完成于 2026-09-29）
> 日期：2026-09-29
> 关联版本：MoonGlass v0.9.10
> 前置文档：`docs/AIGV-OPTIMIZATION-PROPOSAL-ZH-CN.md`（方向 B）、`docs/VERIF-UX-CONVERGENCE-AND-GUIDED-FLOW-ZH-CN.md`（A+B 方案）、`docs/VERIF-DIAGNOSIS-VISIBILITY-PROPOSAL-ZH-CN.md`（C 方案）
> 结论先行：MoonGlass 的目标 IP 规模（RTL 很少超过 5 万行）下，**DUT 默认就是整个设计（TOP）**——只搭一套 TOP 验证环境，全部 testcase 面向 TOP，场景锚定 TOP 接口与规格条款；子模块 UT 不再预先分级规划，而是**诊断驱动的例外**（probe 仍无法定位时才单独建 TB）。配套新增**配置空间模型**：这类 IP 的业务/corner 场景本质是配置寄存器组合，配置轴必须有机器可读的账本，"需求→规格→验证"链条才完整可审。

---

## 1. 背景与动机

### 1.1 现行策略

引擎 `buildModuleVerificationStrategy`（`packages/verification-intelligence-engine/src/engine.ts:464-494`）按结构事实把每个模块分为四级：IP_SIGNOFF（顶层）/ UNIT_FOCUSED（高风险子模块）/ UNIT_SMOKE / STATIC_ONLY，UNIT_FOCUSED 以上要求独立定向 Testbench（`standaloneTestbench`，`:494`）；场景只给 UNIT_FOCUSED/IP_SIGNOFF 模块生成（`:1684-1685`）。实际项目落地为多套 cocotb 环境（如 earbuds NPU：`earbuds_npu_tb`/`pmu_tb`/`sram_ctrl_tb` + 顶层 `earbuds_npu_top_tb`）。

### 1.2 问题（为什么改）

1. **效率账不成立**。模块分级的隐含动机是省仿真时间；但 ≤5 万行的设计，Verilator/cocotb 全设计仿真只需秒级。省下的是秒级，付出的是每个模块一套 driver/monitor/scoreboard 的搭建成本——这是 Agent token 消耗的大头，也是环境摩擦（cocotb 版本、端口解析）的多发地。
2. **可追溯性链条断在模块级**。规格条款描述的是**外部可观察行为**，"需求→规格条款→场景→用例→证据"只有锚在 TOP 接口上才环环对齐；模块 UT 的场景映射不到规格条款——这正是优化提案 §2.1"结构穷举场景套话"与 case2"84/84 PASS 但证据不被采信"的病根。
3. **模块 UT 的激励是假的**。手写 driver 模拟的接口行为未必等于真实集成行为：UT 过了不代表集成对，集成坏了 UT 照样过。TOP 激励是真环境。

### 1.3 决策（已与产品侧对齐）

- DUT 默认 = 整个设计（TOP）；testcase 一律面向 TOP。
- 子模块 UT 仅作例外：定位到复杂问题、probe 子模块信号仍无法定位、不得不对该模块单独验证时，才单独建 TB。
- 测试对象为 TOP / 整个 IP，证据链与需求-规格-验证链条在顶层闭合。

---

## 2. 策略总览："TOP 优先，UT 例外"

### 2.1 默认路径（覆盖 95% 情形）

1. 规划环境 = **搭一套 TOP cocotb 环境**（`verification/<top>_tb`）：总线 VIP 做寄存器配置，driver/monitor/scoreboard/golden model 面向顶层接口。
2. 场景全部锚定 TOP rtlObjects 与规格条款；testcase 面向 TOP 编写，命名与 scenario 绑定纪律不变（`scn_<8hex>`）。
3. W1 基础验证 = 规格条款（含寄存器手册条款）逐条获得 TOP 执行证据；W2 Corner 波 = 主题波 × 配置点（§5）；W3 签核口径不变。

### 2.2 例外路径（UT 例外，诊断驱动）

```
TOP 仿真失败
  → 诊断账本升级（L2 时间窗/波形 → L3 关联模块内状态/计数器 → L4 根因候选）
  → probe 子模块信号（Design Browser / 波形）仍无法定位
  → 登记 UT 例外（ut-escalations.json，写明模块/理由/关联失败指纹与根因假设）
  → 针对该模块单独建 TB 并验证
  → 修复后回到 TOP 回归确认（例外 UT 的 PASS 不能替代 TOP 证据）
```

- UT 例外由 **Agent 经工具登记**（新 pi 工具 `register_ut_escalation`），落盘即审计线索；签核时可回答"为什么这个模块有 UT、当时 TOP 为什么验不出来"。
- 例外可退役：根因修复且 TOP 回归覆盖后，登记 `status: 'retired'` 并保留历史。
- 与 C 方案联动：诊断卡壳（DIAGNOSTIC_ENHANCEMENT 且 L 等级不爬升）已在 L0 有待办；UT 例外登记是该待办的建议动作之一，诊断时间线可见例外标记。

### 2.3 保留不动的部分

- **结构模型与风险寄存器**：用途改为给 TOP 场景与配置点**排优先级**，不再用于分级建环境。
- **模块级 Formal**：sby 状态空间本就适合模块粒度，formal-candidate 机制保留（W2 补强、W3 义务分级不变）。
- **覆盖率**：Verilator 本来就全设计插桩，与 TB 目标无关，门禁阈值口径不变。
- **全设计静态检查**：lint/elaboration/可综合性/死逻辑本就是顶层口径，不变。

---

## 3. 引擎改动：模块策略两态化 + UT 例外登记

### 3.1 模块策略从四档改为两态

`module-verification-strategy.json` 的 `level` 枚举改为：

- `TOP_SIGNOFF`：topSet 模块（唯一或若干顶层），完整 AIGV Intent/Scenario + 端到端回归与覆盖率 + Multi-Oracle + Mutation + 签核包。
- `COVERED_BY_TOP`：其余全部模块，默认经 TOP 场景与全设计覆盖率间接验证；requiredChecks 收敛为静态检查（编译/lint/可综合性/端口检查，随全设计 lint 完成，不单独排队）。

`UNIT_FOCUSED`/`UNIT_SMOKE` 不再由引擎预分级产生；模块被登记 UT 例外后，策略表中该模块显示为 `UT_EXCEPTION`（数据源 = §3.2 登记表，引擎 rebuild 时联查）。`standaloneTestbench` 字段语义改为"已登记 UT 例外"。

### 3.2 `ut-escalations.json`（证据区 `verification/results/`）

```ts
{
  version: 1,
  escalations: [{
    id: string                 // UTX-<sha1(module+reason) 前8位大写>
    module: string             // RTL 模块名，锚点校验必须存在
    reason: string             // ≤200 字：为什么 TOP 激励/观测不足以定位
    failureSignature: string   // 关联 diagnostic-control 失败指纹
    rootCauseId: string | null // 关联 root-causes.json 记录（可为空）
    topScenarioIds: string[]   // 触发升级的 TOP 场景（SCN-*）
    createdAt: string
    status: 'active' | 'retired'
    retiredReason: string | null
  }]
}
```

- 新 pi 工具 `register_ut_escalation`：登记/退役；模块名与 scenarioId 锚点校验（幻觉引用拒绝，沿用 Intent 登记口径）。
- 引擎 rebuild 联查：active 例外 → 该模块场景生成放开（同原 UNIT_FOCUSED 路径）、执行计划纳入排队、门禁纳入必过清单（§6）。
- 场景生成锚点：默认只锚 TOP rtlObjects + active 例外模块（替代现行 `fullScenarioModules` 判定，`engine.ts:1684-1685`）。

### 3.3 对聚类与执行计划的影响

- 聚类键的模块维度收敛：默认全部 TOP 场景按 wave × method × Oracle 域 × topic 聚类（模块维度对 TOP 恒为 topSet，自然去重）；例外模块场景独立成簇。
- 全局排队 cap 20（A+B 决议）不变；配置点场景与普通场景共用 cap。

---

## 4. 配置空间模型：`config-space.json`

TOP 优先之后，场景完备性 = 激励轴 × 配置轴。这类 IP 的规格书核心往往是寄存器手册——配置轴必须有机器可读账本。

### 4.1 存放与角色

- 落盘 `verification/intelligence/config-space.json`（引擎产物区，Agent 禁手改）。
- 生成方式：**Agent 抽取 + 引擎校验**——Agent 读规格书（寄存器章节）经新工具 `register_config_space` 提交；引擎做锚点校验（寄存器模块存在、字段名/信号在 RTL 可锚定，幻觉引用拒绝）后落盘并 rebuild。与 Intent 登记同一诚实性哲学：LLM 提供语义，引擎守门。

### 4.2 Schema

```ts
{
  version: 1,
  generatedAt: string,
  registers: [{
    name: string               // 寄存器名（规格书口径）
    address: string | null     // 偏移地址，规格未写可空
    rtlModule: string          // 锚定的寄存器模块（如 apb_regs）
    fields: [{
      name: string
      msb: number, lsb: number
      resetValue: string | null
      domain:                  // 取值域，三选一
        | { kind: 'enum', values: [{ value: string, label: string }] }   // 模式枚举
        | { kind: 'range', min: number, max: number }                    // 数值
        | { kind: 'flag' }                                               // 单比特使能/开关
      clauseId: string | null  // 规格条款锚点（SPEC-xxx#a）
      description: string      // ≤120 字
    }]
  }],
  constraints: [{
    type: 'mutex' | 'requires' | 'illegal',
    fields: string[]           // <register>.<field> 引用
    description: string        // 约束语义（含期望行为：报错/忽略/截断）
    clauseId: string | null
  }]
}
```

### 4.3 四类配置点（场景生成规则）

| 类别 | 生成规则 | 对应场景性质 |
|---|---|---|
| 业务点 | 每个 enum 值至少一个代表组合；flag 全开/全关/典型组合 | 业务场景（W1/W2 主体） |
| 边界点 | 每个 range 字段的 0 / min / max / max+1（溢出邻值，若可表达） | Corner（W2） |
| 非法点 | 每条 constraint 至少一个违反组合，校验 DUT 行为符合规格（报错/忽略/截断） | Negative（W2） |
| 动态点 | 忙时改配、在线切换模式——替代现行 R09/R16 的信号名模式匹配，升级为配置空间驱动的系统生成 | 时序碰撞（W2） |

### 4.4 防爆剪枝

- 字段内：边界值全量（每字段 ≤4 点）。
- 字段间：风险导向成对组合——同一条 constraint、同功能域（按 clauseId 聚类）、历史失败关联（root-causes/失败指纹联查）优先；不做全笛卡尔积。
- 配置点场景与普通场景共用全局排队 cap（20），超出部分留候选池按需提升（A+B 决议口径）。

### 4.5 配置覆盖矩阵

- coverpoint = 字段 × 取值桶（enum 每值一桶、range 分 0/min/典型/max 四桶、flag 两桶）；cross = §4.4 成对组合的命中矩阵。
- 采集：cocotb scoreboard/环境按 config-space 自动埋点（gen_cocotb_env 扩展），回传 `verification/results/config-coverage.json`（沿用 `MOONGLASS_FUNCTIONAL_COVERAGE_FILE` 通道扩展 schema，旧格式兼容）。
- 消费：引擎 `collectResults` 汇总进闭环评估——签核可回答"哪些配置组合验过、哪些没验、为什么（豁免/候选）"；覆盖矩阵进态势页（§7）。

### 4.6 与规格映射矩阵的挂钩

寄存器章节条款 ↔ 配置点双向指针（clauseId）：映射矩阵中寄存器条款的 MAPPED_UNTESTED/PASSED 由配置点场景的 scenario_hits 派生，口径与现行条款矩阵一致（PASSED 需 CURRENT 证据）。

---

## 5. 提示词与技能改动

1. **规划环境 prompt（VerifStatusBar 波段按钮 / 托管规划 prompt）**：从"按 module-verification-strategy 分层搭 N 套环境"改为"搭一套 TOP 环境"——collect_rtl_files 确认 TOP → 总线 VIP 挂接 → driver/monitor/scoreboard/golden model 面向顶层 → W0 冒烟。保留"读 risk-register 圈定 5-10 个验证点"步骤（优先级来源）。
2. **W1/W2 prompt**：testcase 一律面向 TOP；W2 增加配置点执行纪律（按 config-space 四类点选批，非法点必须校验规格期望行为，不得把非法激励当 PASS 放行）。
3. **诊断升级指引（VERIF 系统提示词 + 批次 prompt）**：写入 §2.2 例外路径——L3/L4 且 probe 无果时评估 `register_ut_escalation`，禁止未经登记直接搭模块 TB。
4. **verification-planning 技能**：基线文档模板增加"寄存器/配置章节"要求（规格书缺寄存器手册时，`register_config_space` 拒绝并转 Spec Gap）。
5. **cocotb-verification 技能**：TOP 环境模板补充"配置序列 → 业务流量"范式与配置覆盖埋点（E 团队 2.x 化后的模板上叠加，注意协调）。

---

## 6. 门禁改动

- **`sim-passed` 收紧**：从"任意 `verification/results/<module>/result.json`"改为——**TOP 的 result.json 必须存在且通过** + 每个 active UT 例外模块的 result.json 必须存在且通过；rtlHash 新鲜度防线不变。TOP 判定口径：design.json manifest 的 topModule（`engine.ts:432-441` 同一来源），无法判定时回退现行行为并在消息中标注"TOP 未识别，按任意模块证据放行（建议补 design.json）"。
- **scenario-closure / evidence-review**：口径不变（配置点场景就是普通场景，走同一闭环）。
- **覆盖率门禁**：不变（全设计插桩天然契合 TOP 优先）。
- 快速综合通道、PPA 条款通道：不变。

---

## 7. UI 改动

1. **态势页 L2 模块策略表**：四档分级列改为两态显示——`TOP_SIGNOFF`（顶层签核状态）/ `COVERED_BY_TOP`（默认）/ `UT_EXCEPTION`（徽标 + 悬浮显示升级原因与关联根因，数据来自 ut-escalations）。
2. **配置覆盖矩阵**（新区块，L1/L2 边界，默认折叠）：字段覆盖桶 + 关键交叉命中率 + 未覆盖配置点清单（交接 Agent 按钮）。
3. **用例全景**：场景行增加"配置点"标记（该场景由 config-space 派生），why 列对未执行的配置点场景显示"属于哪个字段组合"。
4. C 方案的诊断时间线：UT 例外登记作为事件点显示在时间线上。

---

## 8. 迁移与兼容

- **旧项目的四级策略文件**：引擎 rebuild 时按新口径重算（topSet→TOP_SIGNOFF，其余→COVERED_BY_TOP），旧 `module-verification-strategy.json` 不留迁移包袱。
- **已有的模块 TB（如 earbuds NPU 的 pmu_tb/sram_ctrl_tb）**：首次 rebuild 时若发现 `verification/<module>_tb`（module ∉ topSet）且该模块有 scenario_hits 证据 → 自动登记为 active UT 例外（reason 标注"历史环境自动登记"），环境保留可用；用户可在态势页退役。
- **证据继承**：rtlHash 与当前 RTL 一致的既有 result.json/scenario_hits 继续有效（含 TOP 与非 TOP）；sim-passed 新口径首次检查时若 TOP 证据缺失，报错消息明确指引"以 TOP 为 DUT 跑一次回归"。
- **历史项目的 Intent/Scenario**：锚点在校验时自然过滤非 TOP/非例外模块的锚定，相应场景转候选池，不删除。

---

## 9. 实施分批

### 批 1：引擎（策略两态化 + UT 例外 + 配置空间模型）

- `buildModuleVerificationStrategy` 两态化；`ut-escalations.json` + `register_ut_escalation` 工具；场景锚点迁移（TOP + active 例外）。
- `config-space.json` schema + `register_config_space` 工具（含锚点校验）+ 四类配置点生成 + 剪枝。
- smoke：策略两态、例外登记/退役/锚点拒绝、config-space 校验与四类点生成、剪枝上限。`verification-intelligence-smoke` 同步更新。
- 验收：typecheck 全过（root 基线 11 不新增）；core smoke 全绿；用 earbuds NPU 工作区重放：策略变两态、历史模块 TB 自动登记为例外、既有证据不失效。

### 批 2：提示词 + 技能

- §5 全部；配置覆盖埋点进 gen_cocotb_env 模板。
- 验收：pi-tools-smoke 等全绿；prompt 文本评审。

### 批 3：门禁 + UI

- sim-passed 收紧（含 TOP 未识别回退）；§7 全部 UI；配置覆盖矩阵消费链路。
- 验收：eda-gate-smoke/qa-semantic-gate-smoke 全绿 + 新增门禁 smoke；typecheck 全过；态势页实机目检。

### 批 4（收尾）：文档与白皮书

- AIGV 方法学/白皮书/用户手册相关章节修订；本修订文档状态改"已实施"。

每批交付口径沿用既有规范：typecheck 全过、对应 smoke 随批交付且全绿、引擎包不得引入新外部依赖。

---

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 深状态模块 TOP 不可控，例外触发不及时 | 诊断卡壳待办（C 方案已上线）兜底；例外登记进签核包可审计 |
| 配置空间抽取质量依赖规格书完整度 | 缺寄存器章节→Spec Gap 显式阻断，不静默降级；锚点校验防幻觉 |
| 配置组合爆炸 | §4.4 剪枝 + 全局 cap + 候选池 |
| 旧 TOP 环境缺失的项目门禁突然变严 | sim-passed 提供 TOP 未识别回退与明确指引；老项目有一次性迁移提示 |
| TOP 单环境成为单点故障 | 环境冒烟（W0）前置；例外路径不受单环境制约 |

## 11. 待决策问题

1. `COVERED_BY_TOP` 模块是否保留"自愿升级"通道（用户/Agent 无失败也想给某模块建 UT）——本方案允许（register_ut_escalation 的 failureSignature 可空、reason 写明预防性理由），评审确认。
2. 配置覆盖的签核阈值：是否将"关键交叉覆盖率 ≥ X%"纳入 W3 签核阻断项，还是仅作展示与提醒。本方案默认后者（先记账后定阈）。
3. formal-candidate 的模块选择在新两态下是否仍按结构风险自动提名（本方案维持现状）。

---

## 12. 实施记录

- **批 1（引擎）**：模块验证策略两态化（`TOP_SIGNOFF` / `COVERED_BY_TOP`，`UT_EXCEPTION` 联查例外登记表）；`ut-escalations.json` 例外登记/退役与锚点校验；场景生成锚点迁移为 TOP + active 例外模块；配置空间模型 `config-space.json` + `register_config_space` 工具（含锚点校验）+ 业务/边界/非法/动态四类配置点生成与防爆剪枝；历史模块 TB 首次 rebuild 自动登记为 active UT 例外。
- **批 2（提示词与技能）**：规划环境提示词改为"搭一套 TOP 环境"口径；W1/W2 提示词补配置点执行纪律（非法点必须校验规格期望行为）；诊断升级指引写入"probe 无果才登记 UT 例外"例外路径；verification-planning 技能基线模板增加寄存器/配置章节要求；cocotb-verification 技能 TOP 环境模板叠加"配置序列 → 业务流量"范式与配置覆盖埋点（`config_coverage.py`）。
- **批 3（门禁与 UI）**：`sim-passed` 门禁收紧为 TOP 必过 + 每个 active UT 例外必过（含 TOP 未识别回退与指引）；验证态势页新增配置覆盖区块（字段覆盖桶、关键交叉命中率、未覆盖配置点清单）；模块策略表两态化显示（TOP_SIGNOFF / COVERED_BY_TOP / UT_EXCEPTION 徽标 + 悬浮原因）。
- **批 4（文档，本批）**：本文档状态改"已实施"并补本实施记录；`docs/USER-MANUAL-ZH-CN.md` 验证章节更新为两态策略 + 配置空间与配置覆盖 + UT 例外触发方式；方法学/白皮书/验证态势用户指南三份 HTML 相应章节最小修订并标注修订指针。

批 1-3 交付验收口径：typecheck 全过（root 基线 11 不新增）、core smoke 全绿（含新增的 ut-escalation / config-space / sim-passed-gate 等 smoke）、引擎包未引入新外部依赖。
