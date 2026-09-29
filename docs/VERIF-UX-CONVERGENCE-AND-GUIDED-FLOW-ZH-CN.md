# MoonGlass 验证易用性改造方案：信息架构收敛 + 引导式验证流（A+B 合并）

> 状态：讨论稿 · 供评审
> 日期：2026-09-29
> 关联版本：MoonGlass v0.9.10
> 前置文档：`docs/AIGV-OPTIMIZATION-PROPOSAL-ZH-CN.md`（方向 A/B）、`docs/AIGV-VERIF-CONTEXT-PLAN-ZH-CN.md`（第 4 批，"观察后定"）
> 配套方案：失败诊断与修复可视化为独立话题，见 `docs/VERIF-DIAGNOSIS-VISIBILITY-PROPOSAL-ZH-CN.md`
> 结论先行：AIGV 的方法学（风险驱动、证据闭环、波段制）已经立住，当前的易用性瓶颈是
> **"方法学全部压在用户视野里"**。本方案做两件事：
> A. 把信息架构收敛到"3 类事实源 + 2 个读模型 + 6 态状态机"（即官方第 4 批的落地版）；
> B. 把交互从"用户读懂波段/账本后按按钮"升级为"任何时刻一个主行动"的引导式验证流。
> 原则：**方法学留给机器，结果留给用户；收敛不是砍能力，是把能力归置到该在的层。**

---

## 1. 现状诊断（全部基于代码与实测证据）

### 1.1 产物层：26 份落盘文件，约一半无人直接消费

`packages/verification-intelligence-engine/src/engine.ts:1664-1778` 一次 rebuild 产出 26 份产物到
`verification/intelligence/`。逐一核查消费方后可分为四类：

- **事实源（写入唯一、有真实消费方）**：`requirement-model.json`（规格锚点校验）、
  `structural-model.json`（Intent 信号校验）、`risk-register.json`（Top 风险/圈定验证点）、
  `scenario-registry.json`（场景状态）、`scenario-execution-plan.json`（批次调度）、
  `exploration-history.json`（饱和度/STALLED 检测）、`signoff-approvals.json`（用户具名审批，反向数据流）。
- **读模型**：`verification-posture.json`（UI 读模型）、`execution-summary.json`（Agent 读模型，≤10KB）。
  这两个方向是对的，是收敛要补全而不是推翻的雏形。
- **派生产物（可由事实源重算，独立落盘纯属冗余）**：`coverage-hole-register.json`、
  `spec-gap-register.json`、`closure-assessment.json`、`oracle-registry.json`、
  `oracle-evaluation.json`、`mutation-assessment.json`、`residual-risk-register.json`、
  `signoff-package.json`、`module-verification-strategy.json`、`verification-space-snapshot.json`、
  `exploration-round.json` —— UI 实际读的都是 posture/state 内嵌副本，独立文件无人消费。
- **孤儿/超集**：`verification-hypotheses.json`（只有写入方，无消费方）、
  `feature-interaction-graph.json`（Agent 被禁止整读，UI 只读 state 内嵌副本）、
  `verification-state.json`（全量超集，与 20+ 独立 JSON 一一重复，实测 1.5MB）。

另有两份人读 Markdown（`verification-intelligence-report.md`、`verification-signoff-package.md`）
与 `docs/04_verification/aigv_execution_snapshot.md`，定位清晰，保留。

### 1.2 状态层：12 态 + 6 维正交轴，实证已压垮 Agent 与用户

- `ScenarioStatus` 12 个枚举（`packages/verification-intelligence-engine/src/types.ts:3-15`），
  另有正交 6 维 `ScenarioState`（lifecycle/reach/judgment/evidence/freshness/closure）。
- 实证失败：Agent 对齐不了 12 态，自造非标准状态 `ADJUDICATED` 污染注册表（`docs/AIGV-OPTIMIZATION-PROPOSAL-ZH-CN.md` 附录）；`PARTIAL` 语义双关（证据不足 vs 证据陈旧）。
- 讽刺的是，UI 侧早已各自做了压缩：用例全景把 12 态压成 6 类显示
  （`src/renderer/pages/VerificationPosturePage.tsx:106-115,172-177`），引导层也只认 4 个闭环态
  （`src/renderer/verification-guidance.ts:4`）。**收敛是把 UI 已经在做的简化正式下沉到模型层。**

### 1.3 UI 层：三处入口、19 个区块、数据重复、手动刷新

- 验证态势页 19 个区块自上而下平铺（`VerificationPosturePage.tsx:588-726`），
  新手向（L0 答案卡、用例全景）与专家向（验证空间快照、5×5 热力图、9 格指标、五层账本）混排。
- 工作区底部"验证"控制台页签六视图（`WorkspacePage.tsx:1574-1709`）与态势页大面积重复
  （scenario/intent/holes 三视图完全重复），且**整读 1.5MB 的 `verification-state.json`**（`:1456-1461`）。
- 态势页与 VerifStatusBar 均**无自动刷新**：批次 settle 后用户必须手动点刷新才能看到进展
  （`VerificationPosturePage.tsx:391-437`、`WorkspacePage.tsx:86-92`）。

### 1.4 引导层：推导规则已很强，交互形态仍是"懂方法学的人的操作台"

- `verification-guidance.ts` 已有 13 条行动推导规则（`deriveVerificationActions`，`:194-437`），
  主行动 = `actions[0]`，每条带可直接下发的中文 prompt——推导内核足够好。
- 但呈现形态要求用户理解波段制：VerifStatusBar 四个波段按钮
  （规划环境/基础验证/Corner 波/签核，`WorkspacePage.tsx:569-669`）本质是"把预写 prompt 发给 Agent"，
  用户仍需判断"现在该按哪个"。L0 答案卡（`VerificationPosturePage.tsx:487-533`）已开始回答
  "现在什么情况、要我做什么"，但只覆盖规格澄清与豁免审批两类待办。

### 1.5 官方既定方向

- `AIGV-OPTIMIZATION-PROPOSAL-ZH-CN.md` §3 方向 A：场景收敛、文件 20+→3、状态 12→6。
- `AIGV-VERIF-CONTEXT-PLAN-ZH-CN.md` §3 第 4 批（观察后定）：20+ JSON→3 事实源、
  ScenarioStatus 12→6、引擎候选池彻底退出排队。
- 本方案即第 4 批 + 引导式交互的完整落地设计。

---

## 2. 设计原则

1. **方法学留给机器，结果留给用户。** 用户首屏只需要：进展到哪、现在干什么、要不要我介入。
   波段、账本、五层门禁等概念全部下沉到专家层，默认折叠。
2. **单一事实源 + 派生读模型。** 写入方唯一（引擎/工具），UI 读 posture，Agent 读
   execution-summary；任何"页面和 Agent 脱节"的缝隙都是 bug 源（2.2 节的四文件写回错位教训）。
3. **诚实性不降级。** BMC≠证明、工具限制≠RTL 缺陷、覆盖率口径声明等诚实语义全部保留，
   只是从"平铺在用户脸上"改为"归置在专家层 + 签核包"。
4. **收敛不破坏现有消费方。** 批次判定（`verif-batch-verdict.ts:52` 依赖 posture generatedAt
   作新鲜度锚）、3 处门禁（`PhaseEngine.ts:468/728/1066` 消费 state.json）、底部控制台，
   迁移路径必须先加后删。

---

## 3. Part A：信息架构收敛（第 4 批落地）

### 3.1 产物处置：26 份 → "7 事实源 + 2 读模型 + 3 人读报告"

**保留的事实源（7 份）**

| 文件 | 角色 | 说明 |
|---|---|---|
| `requirement-model.json` | 规格事实源 | 断言级条款 + 验收通道分类 |
| `structural-model.json` | RTL 事实源 | 禁整读纪律保留 |
| `risk-register.json` | 风险事实源 | — |
| `scenario-registry.json` | **场景+Intent 合并事实源** | Intent 字段并入场景对象，`verification-intent-registry.json` 停止独立落盘（见下） |
| `scenario-execution-plan.json` | 调度事实源 | plans/clusters/reclusterSuggestions |
| `exploration-history.json` | 引擎内部状态 | 饱和度检测，Agent 不读 |
| `signoff-approvals.json` | 用户审批事实源 | 反向数据流，引擎不写 |

**保留的读模型（2 份）**：`verification-posture.json`（UI 唯一读模型，吸收 state.json 中
UI 仍需要的字段）、`execution-summary.json`（Agent 唯一入口，≤10KB 硬指标保留）。

**降级（12 份，不再独立落盘）**：`coverage-hole-register`、`spec-gap-register`、`closure-assessment`、
`oracle-registry`、`oracle-evaluation`、`mutation-assessment`、`residual-risk-register`、
`signoff-package`、`module-verification-strategy`、`verification-space-snapshot`、
`exploration-round`、`feature-interaction-graph` —— 数据全部保留，改为内嵌进 posture
（UI 需要时）或由引擎函数按需重算（Agent/门禁需要时）。落盘一等人读签核包时，
`signoff-package.json` 仍可按需生成到 `verification/results/signoff/`，但不再是常驻平铺产物。

**删除（3 份）**：`verification-hypotheses.json`（孤儿，假设链已由 `root-causes.json` 承载）、
`verification-state.json`（超集冗余，消费方迁移后退役）、
`verification-intent-registry.json`（并入 scenario-registry）。

**Intent 合并的具体口径**：Intent 本就没有独立状态机（`engine.ts:1182` 直接镜像 scenario.status），
其 objective/passCriteria/锚点本就是场景的天然字段。合并后：
- `scenario-registry.json` 的场景对象增加 `intent: { objective, passCriteria, stimulusAnchors, ... }`；
- `register_verification_intents` / `refine_verification_intents` 工具**契约不变**，
  引擎内部写回目标从 intent-registry 改为 scenario-registry；
- `buildBatchPrompt`（`engine.ts:2256-2259`）改为只读 scenario-registry 一处。

**候选池退出排队**：CLAUSE_DERIVED 派生候选不再进 `scenario-execution-plan` 排队，
仅在 scenario-registry 以 `origin=CLAUSE_DERIVED` + 候选标记存在，由 Agent 按
`select_next_verification_batch`/引导 prompt 按需提升为正式场景。DISCOVERED 不再是一个
"排队状态"（见 3.2）。

### 3.2 状态机：12 态 → 6 态

| 新状态 | 含义 | 吸收的旧状态 |
|---|---|---|
| `NOT_STARTED` | 已登记/已规划，未执行 | DISCOVERED（提升后）、PLANNED、IMPLEMENTED |
| `RUNNING` | 已派发执行中，或有执行证据但未裁决 | REACHED、NOT_REACHED、PARTIAL（证据不足支） |
| `PASSED` | 到达+通过+证据 CURRENT | VERIFIED、FORMAL_PROVED、FORMAL_UNREACHABLE（以 `oracle: 'formal'` 标注区分证明证据） |
| `FAILED` | 反例/失败 | FAILED |
| `BLOCKED` | 规格未定义或环境/工具阻断 | BLOCKED_BY_SPEC；PARTIAL 中"工具限制"支 |
| `WAIVED` | 具名豁免 | WAIVED（审批门控不变） |

关键设计：

- **`PARTIAL` 拆解**：其"证据陈旧"语义由 freshness 轴表达——UI 显示为 `PASSED · 待回归`角标
  （freshness≠CURRENT），不占用独立状态；"证据不足"语义归 `RUNNING`。状态与新鲜度正交，
  这正是原来 6 维 ScenarioState 里唯一有用户价值的轴。
- **`NOT_REACHED`（执行了但场景条件未触发）归 `RUNNING`**：它是覆盖问题而非失败，
  reach 信息保留在证据轴，引导层可对长期 NOT_REACHED 的场景推"检查激励构造"行动。
- **正交 6 维 ScenarioState 保留为引擎内部派生轴**，不进用户视野、不进 UI 契约。
- **迁移**：引擎 rebuild 时对旧注册表做确定性映射（含历史 `ADJUDICATED` 等非标状态——
  一律按 scenario_hits 证据重算，映射表随代码评审）。写保护不变：执行派生态仍拒绝 Agent 宣布。
- SpecMapping 5 态（UNMAPPED/MAPPED_UNTESTED/PASSED/FAILED/WAIVED）不变——它简单且用户已能理解。

### 3.3 UI 信息分层：态势页三层，底部控制台去重

**态势页三层结构**（`VerificationPosturePage.tsx` 重排，不改数据源）：

- **L0 头条答案卡**（保留并强化，见 Part B）：签核状态、当前步、进展一句话、"需要你处理"。
- **L1 进展与行动**：波段步骤条、主行动区、用例全景、验证环境与用例执行、规格映射矩阵、
  阻断清单、Top 风险（前 5）。
- **L2 专家明细（默认折叠，一个"技术细节"分区统收）**：验证空间快照、模块验证策略、
  9 格指标、模块风险分布、5×5 热力图、Intent 三栏明细、Spec Gap / Coverage Hole 双栏、
  五层账本（Multi-Oracle/Mutation/Formal/残余风险）——全部保留，只是默认不展开。
  覆盖率明细面板（CoverageDetailPanel）保持在 L1/L2 边界，默认折叠。

**工作区底部"验证"控制台页签收敛**（`WorkspacePage.tsx:1574-1709`）：

- 删除 scenario/intent/holes 三个与态势页完全重复的视图；
- 保留并聚焦"执行侧"内容：波形文件、verification/ 文件清单、formal 结果、schedule；
- 数据源从整读 `verification-state.json` 改为读 posture（配合 3.1 state.json 退役）；
- 页签顶部加一行态势摘要 + "打开验证态势"跳转按钮。

**自动刷新**（A+B 与 C 方案共享的基础设施）：

- `FileService` 增加对 `verification/intelligence/verification-posture.json` 与
  `verification/results/` 目录的文件 watch（主进程 `fs.watch`，debounce 后经
  `agent:event` 或新 IPC 通道推送 `verification:changed`）；
- 态势页与 VerifStatusBar 订阅该事件自动重载，替代手动刷新；
- 批次 settle、修复窗口收尾都会触发 posture/results 写入，天然覆盖所有进展时点。

### 3.4 五层门禁的工作口径

按官方提案 §5 的待决策项，本方案先按**"保留但按需"**落地（不阻塞收敛主线）：

- Multi-Oracle / Mutation / Formal / 残余风险 / 签核包不再默认平铺（3.1 已降级），
  只在关键场景与签核波段触发，结论进 posture 内嵌副本与签核包；
- 工具/环境限制导致的 Formal ERROR 等，在 L0/L1 统一显示为"环境待补齐"类提示，
  不与 RTL 缺陷混排（延续 DEFECT-PACK-001 以来的口径分离）。
- "砍掉"与否仍留专家团队决策，本方案的信息架构两种口径都兼容。

---

## 4. Part B：引导式验证流

### 4.1 核心交互：任何时刻，一个主行动

把 `deriveVerificationActions` 的 `actions[0]` 从"列表第一项"升级为**验证向导卡**，
在工作区 VerifStatusBar 与态势页 L0 两处同源呈现：

- **当前目标**：当前波段的一句话目标（如"基础验证：让每条规格条款都有执行证据"）。
- **进展**：波段步骤条 + 关键计数（条款 covered/total、批次 第 n/N 批）。
- **主行动大按钮**：行动标题 + 一句"为什么现在做这个"（由 action 的推导条件反解生成，
  如"还有 3 个场景因规格未澄清被阻断"）。
- **预期产出**：点击后 Agent 要交付什么、停止边界是什么（prompt 里已有，上浮一句给用户）。
- **次要行动**：其余 P0/P1 收进"其他可做"折叠列表，不抢视觉。

### 4.2 波段按钮降权，不删除

VerifStatusBar 的四个波段按钮（规划环境/基础验证/Corner 波/签核）移入"专家操作"折叠区，
prompt 内容不变。手动分步推进的能力保留给懂方法学的用户；新手路径是"一路按主行动"，
托管路径完全不经过这些按钮。

### 4.3 引导状态机与完成判据

- 步骤条继续用 `deriveVerificationSteps`（waveProgress 口径），每步的**完成判据绑定证据**
  （条款覆盖数、scenario_hits、posture 新鲜度），不绑定会话消息——与批次判定同一哲学。
- 主行动发出后，向导卡进入"执行中"态（利用 3.3 的文件 watch，posture 更新后自动切回
  并刷新下一步）；执行中断（熔断/停滞）时，向导卡显示阻断原因与建议动作
  （与 C 方案的批次/诊断可见性联动）。

### 4.4 "需要你处理"清单扩展

L0 答案卡现有的两类待办（规格澄清、豁免审批）扩展为统一待办队列：

1. 规格待澄清（现有）；
2. 豁免待审批（现有）；
3. 诊断卡壳：DIAGNOSTIC_ENHANCEMENT 进入且连续 N 次尝试诊断等级无爬升时，
   生成"这个 bug 需要你参与定位"待办（与 C 方案诊断时间线联动，L3/L4 本就有用户决策机制）；
4. 门禁遗留问题：force 推进产生的遗留项在当前阶段超过阈值时提醒处理。

### 4.5 概念词典兜底

波段、Intent、Scenario、Multi-Oracle 等术语在 UI 首次出现处加悬浮一句话解释
（i18n 资源进 `verification` 命名空间），不做"新手/专家模式"开关——信息分层已经覆盖，
模式开关只会多一个状态维度。

---

## 5. 实施分批

### 批 1：UI 信息分层 + 自动刷新（纯渲染端 + FileService watch，零引擎风险）

- 态势页三层重排（L2 分区折叠）；底部控制台验证页签去三视图、加态势跳转。
- FileService 文件 watch + `verification:changed` 推送 + 态势页/StatusBar 订阅自动刷新。
- 验收：`pnpm typecheck` 全过（根应用不新增于基线 11 个之外）；`verification-guidance-smoke` 等
  core 套件保持绿；实测批次 settle 后态势页 5 秒内自动更新，无需手动刷新。

### 批 2：引导向导卡 + 波段按钮降权（渲染端为主）

- 向导卡组件（当前目标/进展/主行动/预期产出/次要行动折叠），VerifStatusBar 与 L0 同源渲染。
- 待办队列扩展（诊断卡壳项依赖 C 方案批 1 的诊断落盘，可先做空态）。
- 术语悬浮解释进 i18n。
- 验收：引导推导的 13 条规则行为不变（smoke 对照）；新用户路径可走通
  "一路主行动"完成 W1（用 e2e-managed-verif 观察脚本验证）。

### 批 3：状态机 12→6 + 迁移映射（引擎中版本）

- 状态枚举收窄 + 映射表 + freshness 角标；UI 各状态色同步（用例全景本就已按 6 类显示，改动小）。
- 引擎对旧注册表的迁移逻辑 + 非标状态按证据重算。
- 验收：`verification-intelligence-smoke`、`scenario-hits-smoke`、`verif-batch-verdict-smoke`、
  `eda-gate-smoke` 全绿；用 NPU/DDR_BIST 历史工作区做迁移回放，状态分布与旧口径的
  6 类压缩结果一致。

### 批 4：产物收敛（引擎 + 消费方迁移，最后做、先加后删）

- Intent 并入 scenario-registry（工具契约不变）；12 份派生产物降级内嵌；
  底部控制台与 3 处门禁从 state.json 迁到 posture/引擎函数；state.json 退役。
- 验收：`verification/intelligence/` 常驻 JSON 从 26 份降到 ≤10 份；posture 保持 ≤100KB
  量级（吸收必要字段后复测）；`verif-batch-verdict` 新鲜度锚行为不变（smoke）；门禁结果与
  迁移前逐项目一致。

每批交付口径沿用 `AIGV-VERIF-CONTEXT-PLAN-ZH-CN.md` §4：typecheck 全过、对应 smoke 全过、
引擎包不得引入新外部依赖、实测指标随批记录。

---

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| state.json 退役牵动门禁与控制台 | 批 4 先给 posture 补齐字段并双写观察一轮，再切读取方，最后停产 |
| 状态映射丢失语义（尤其 PARTIAL） | freshness 轴保留为 UI 角标；映射表随批 3 评审；历史工作区回放对照 |
| 派生产物降级后某消费方被漏迁 | 批 4 开工前先全仓 grep 产物文件名做消费方审计（本方案 §1.1 已做一轮，实施时复核） |
| 引导主行动推导错误带偏用户 | 推导规则保持确定性函数 + smoke；向导卡始终显示"为什么"，用户可否决；波段按钮兜底 |
| 文件 watch 在 Windows 上的稳定性 | 轮询兜底（watch 失败时降级为 5 秒轮询 posture mtime） |

---

## 7. 待决策问题（提交专家评审）

1. 五层门禁（Multi-Oracle/Mutation/Formal/残余风险/签核包）"保留但按需"还是"砍掉"
   （本方案按前者落地，两者都兼容）。
2. 候选池（CLAUSE_DERIVED）退出排队后，是否保留"一键提升全部候选"的快捷操作。
3. 场景规模上限：官方提案建议全局 ≤20 排队，是否按模块分级（IP_SIGNOFF 模块放宽）。
4. `NOT_REACHED` 归 `RUNNING` 还是新增"覆盖未触发"提示类——本方案取前者，评审确认。
