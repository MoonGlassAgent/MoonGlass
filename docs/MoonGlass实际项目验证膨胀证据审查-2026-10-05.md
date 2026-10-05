# MoonGlass 实际项目验证膨胀证据审查

审查日期：2026-10-05，包含第二轮深入复核与更正。方法：只读真实项目索引、项目文档、结构化执行账本、原始会话与仿真日志、当前源码与 Git 历史；在独立临时目录运行真实引擎的复现实验，并以 GMAC 数据副本测试当前调度。不重跑真实项目验证、不重建真实项目态势、不修改真实项目数据。

## 范围与判据

从 `%APPDATA%/moonglass/moonglass/projects.json` 定位了 11 个项目。用户所说的“进入验证完备状态”按 VERIF 阶段及项目验证完备报告理解，不等同于机器签核通过。索引中只有 DMA_mt 标注 VERIF completed，但其 REQ_SPEC 至 QA 的开始/完成时间均为同一时刻，不能作为真实验证完成的证明。其余项目多为 VERIF active；本次重点检查 GMAC、PSRAM_CTRL、小数分频器、LITE_DMA，并用 MoonGlass_DMA、DMA_mt 作为旁证样本。

判据：相同验证目标在未发生相关设计/策略变化、没有新增闭环证据时被重复派发；同一规格定义和追溯引用被扩展成独立验证义务。大场景数、长运行时间和失败结果本身不判为膨胀。Formal 状态爆炸必须有求解耗时/内存/超时日志证据，不能从缺少某项算法推断。

## 一、已经发生的重复派发：GMAC

路径：`D:/Projects/rtl_lib/gmac`。

直接证据：

- `verification/results/verif-batch-loop.json` 的全部 20 条留存历史（index 188–207）选中同样三个场景：SCN-B8CDF75D、SCN-55E014E2、SCN-03954A97；全部 verdict=completed，原因均为“证据齐全：scenario_hits 已登记且 posture 已重建”。
- 首尾 settledAt 为 2026-10-02T15:49:24.505Z 和 17:03:13.238Z，相隔 73.812 分钟（上海时间 23:49:24 至次日 01:03:13）。这是完成记录之间的时间跨度，不是仿真 CPU 时间或 Token 成本。
- `verification/intelligence/exploration-history.json` 留存 50 轮，同一 snapshotId、同样三个场景；49 轮 NO_PROGRESS、1 轮 PENDING，全部 newlyClosedScenarioIds=[]，未闭环关键场景始终为 278。时间范围 2026-10-02T13:52:16.585Z 至 17:01:00.875Z。
- `verification/results/gmac_top/result.json`：3 tests / 0 PASS / 3 FAIL，finishedAt=2026-10-02T16:53:27.145Z；rtlHash=d43ffa3b48c4ad67851bde724637e6fe82407e779b299ac86f5fac82cdf52c83。
- `simulation_icarus.log` 有三个测试失败的原始汇总，失败内容是无 PAUSE 帧生成。不能把编译/runExitCode=0 解释为功能通过。
- `batch-188-blocker-report.md` 和 `batch-207-blocker-report.md` 明确记载 RTL 未变、已有 CURRENT 失败证据、需要规格/能力裁决，当前会话不重跑仿真。报告是 Agent 陈述，重复派发数量以结构化账本为准；报告宣称“累计 63 次”未在本审查中逐条复核，不作为确认数量。

结论：至少 20 个连续批次重复派发到同一阻塞目标，有独立账本和结果文件佐证。第二轮按 session_info.name 中的逻辑批次号逐个读取原始 JSONL，找到批次 188–202 共 15 个会话，其中 14 个无 run_simulation 调用，15 个各有一次 record_scenario_adjudication。第 191 批有两次仿真调用：首次缺少技术单元/SRAM 模块导致 elaboration 失败，第二次补齐输入文件后得到功能失败。这次补齐文件重验有实际意义，不能把全部 20 批均定为零新增工作。批次 203–207 本轮只有账本证据，未找到对应逻辑批次的原始会话。可以确定存在重复裁决会话工作量膨胀与闭环停滞，不能称为“20 次重复仿真”。

最终停机证据：`verification/results/run-loop.json` 为 paused-breaker，原因 max-wall，276/240 分钟。最新预算周期 beats=7；lastBeats 所有 17 条均 advanced=true，包括批次熔断和重复派发的步骤。tokensUsed=0 是统计缺口，不能据此判断未消耗 Token。

## 二、场景义务重复派生：小数分频器与 PSRAM_CTRL

小数分频器 `docs/02_requirements/module_specification.md` 第 68 行定义 SPEC-IF-003 并追溯 REQ-IF-003，描述 i_div_int 与 i_load 同拍采样；第 69 行对应 i_div_frac 的 SPEC-IF-004 / REQ-IF-004。

`requirement-model.json` 将第 68 行同时生成为 SPEC-IF-003#b 和 REQ-IF-003#b，两个 text 相同、source.file/source.line 相同。随后 `verification-state.json` 产生 SCN-8FDCAED1、SCN-B10D4D61 两个独立 CLAUSE_DERIVED 场景。第 69 行同样产生 SCN-1D51A685、SCN-63EA3AF9。

两根输入信号确实应分别验证；但同一行的 SPEC 定义与 REQ 追溯引用被分别物化，是可确认的追溯重复。不能因四条 text 相同便把两根不同信号合并。

PSRAM_CTRL 的 `requirement-model.json` 还将标题 `2.1 协议与器件（SPEC-PROTO）` 生成为可仿真的 verifiable 义务（源文档第 24 行）。这不是独立可执行行为，属于解析噪声进入验证空间的实例。

现有快照统计如下。unique expected 仅按完整 expected 文本相等分组，不能当作真实独立测试目标数量或可删除数量。

| 项目 | 总场景 | CLAUSE_DERIVED | 不同 expected 文本 | 文本重复额外记录 |
|---|---:|---:|---:|---:|
| 小数分频器 | 83 | 59 | 36 | 23 |
| PSRAM_CTRL | 516 | 292 | 205 | 87 |
| GMAC | 402 | 316 | 213 | 103 |
| LITE_DMA | 187 | 105 | 81 | 24 |

这支持“义务登记有重复”，尚不能证明表内每条重复记录都被单独仿真。一个测试可以绑定多个场景；执行成本应按实际派发统计。

PSRAM 的历史完备报告记载“296 个 scenario 全部 CLOSED”，包含大量 waiver；现快照为 516 个，增加 220。两者跨版本、规格与 RTL 发生变化，报告计数也有内部不一致，因此这 220 个不能全部归为无效膨胀。

## 三、重复记录不全部等于重复执行

小数分频器的 exploration-history 留存 9 次相同 SCN-B13F1B0E 选择，其中 8 NO_PROGRESS。最新批次账本只留存一次熔断：posture 没有在批次开始后重建。选择轮次不等于求解/仿真执行次数，因此本审查不声称执行了 9 次相同测试。

PSRAM 最近 20 条批次记录中，同一三场景组 SCN-D31BFF97 / SCN-84225FCD / SCN-078F0739 出现 8 次，当前三场景已 VERIFIED。留存资料不足以逐次排除修复和证据失效带来的合理重验，因此该项仅列为重复派发线索，不与 GMAC 同等定性。

## 四、由实际证据追到的流程机制

### 1. 文档追溯引用被当成独立定义

`packages/verification-intelligence-engine/src/engine.ts:298` 中 requirementModel 对一行全部 REQ/SPEC ID 逐个处理，并把同一行文本交给 splitClauses；seen 只按 ID 去重，没有区分表格主键与追溯列，也没有按同源定义关联别名。

`engine.ts:1513` 对每个未覆盖条款创建一个 CLAUSE_DERIVED 场景，ID 由 clauseId 哈希生成。因此 REQ/SPEC 别名有不同 ID，即使指向同一行也会独立派生。标题匹配出的 SPEC-PROTO 也能进入该路径。

默认 criticality 为 0.8（P0 为 1）；Multi-Oracle 的两个独立域门槛也是 criticality>=0.8。重复的条款义务因而会进一步进入关键闭环与 Oracle 补证清单。数据中的关键场景占比：小数分频器 82/83，PSRAM 514/516，GMAC 376/402，LITE_DMA 187/187。该比例本身不证明设计风险分级错误，但与派生规则一致。

### 2. 批次完成判定接受历史 hit

`src/main/services/verif-batch-verdict.ts:47` 的 judgeBatchCompletion 只要求 ID 在历史 scenario_hits 中出现，以及 posture 时间晚于本批开始。它不要求本批新增执行证据、不检查本批 hit 时间或状态变化。

`isDiagnosticStalled` 在没有新增 attempts 时返回 false。像 GMAC 只读旧失败证据、登记裁决、重建态势的会话可以被记为 completed，而不会触发这个诊断熔断。注意 completed 是批次会话契约，不是功能 PASS 或签核；诊断失败后登记有效下一步工作也可以合理完成批次。真正的风险是该契约单独无法区分旧证据重放与本批新增结果，必须结合后续工作和重派限制判断。

`AgentService.ts:2005` 内层一次默认最多 20 批。外层一次运行循环步骤会等待整个内层完成，连续无进展预算在外层步骤开始才检查。这解释了为何一轮内仍可连续派发 20 个相同阻塞批次。

### 3. 失败证据覆盖判断类裁决

`engine.ts:2378` 的 recordScenarioAdjudication 修改 registry.status 后立即 buildVerificationIntelligence。`refreshScenarioWithHits`（1471）取 hit.status 优先于 registry.status；现有 FAILED hit 会将刚写的 BLOCKED_BY_SPEC 覆盖。CLAUSE_DERIVED 同样经过该刷新路径。

GMAC 批次报告记载工具返回更新成功、重建后仍 FAILED；最终 registry 中三场景也确为 FAILED/OPEN。代码与数据对应，支持裁决未能改变执行队列的归因。

底层计划生成（engine.ts:1131）选择当前最早波段的 OPEN 场景，固定排序截取 24 个后分组。在独立实验中，即使没有旧 hit，BLOCKED_BY_SPEC 状态能够保存，该场景仍为 OPEN 并出现在 executionPlan。因而问题不止是 FAIL 覆盖裁决。但底层计划不等于当前最终派发：AgentService:2117 的选批器另有 verification-work 排除机制，见下节；上一轮漏查此层，不能据底层计划断言当前同类场景必然反复被派发。

### 4. 历史虚假进展条件已修正

Git `fd0d48a` 中 AgentService 的推进判定含 `judgeRunLoopAdvanced(...) || postureFresh`，即重建态势时间就能计为 advanced。GMAC 记录中连续无新增闭环但外层全部 advanced，与此一致。

2026-10-03 08:36:21 +0800 的提交 `1993bbf` 删除了该条件。当前 AgentService:2917 仅比较闭环计数；当前 out/main/index.js 也无该时间兜底。因此这项是有历史事故佐证且已在现源码修正的问题，不能说它仍原样存在。

### 5. 上一轮遗漏的自动工作调和与执行屏蔽

同一提交还引入 `verification-work.ts`。`reconcileVerificationWork`（176 行）读取 root-causes.json，将 verdict=confirmed、fix 非空、对应 registry 场景仍 FAILED 的记录自动登记为只读诊断工作；无需先手工创建依赖。`blockedVerificationScenarios` 排除所有未 done 工作涉及的场景。AgentService:2124 在选批时自动调和并筛选，工具执行层也有阻止相关仿真/Formal/综合绕过的检查。

第二轮将真实 GMAC 的 registry、root-causes、execution-plan 三个文件复制到独立临时目录，调用真实 reconcile 和从当前 AgentService 提取的选批方法：三个历史目标均自动屏蔽，下一批选择 SCN-8E90D241 / SCN-D1447FB7 / SCN-C89566BF。另运行现有 verification-work-dispatch-smoke，实际桥接工具的工作登记、选批、仿真/Formal/综合依赖守卫均通过。

这直接推翻“当前完全没有阻断调度支持”以及“当前一定会原样重复派发 GMAC 三个目标”。它只是当前调和与选批层的复现，不等于真实运行已完成端到端收敛、所有项目均已防止空转。尤其仅记录 BLOCKED_BY_SPEC、既无 confirmed+fix 根因也无显式 work 的路径，不满足这条自动迁移条件，底层 OPEN 计划问题仍存在。

保留历史 FAIL 执行事实本身是正确的；不应为了停派把失败涂改成 PASS。应该将执行结果、规格裁决、下一步工作分开表达。旧 recordScenarioAdjudication 返回 updated 后目标状态又被覆盖，仍是可复现的工具契约缺口，但不能忽略新 work 路径已提供替代机制。

### 6. 更深的解析缺陷：引用遮蔽正式定义，而非只有重复

walk（203 行）按文件名排序，module_specification 在 product_requirements 之前；requirementModel 的 seen 在任意首次引用处即登记 ID，后续正式定义直接跳过。splitClauses 还会将同一行的前后上下文拆开。

实际样本：

- 小数分频器 module_specification:68/69 的 REQ-IF-003/004 是追溯引用，但生成条款 source 均来自此处。product_requirements:186/187 的正式定义包括整数/分数分频含义和“边界值加载功能正确（REQ-FUNC-002）”，未被纳入这些 ID 的解析内容。同拍采样 #b 子句又丢失所在信号名。不能由此声称边界测试在整个项目完全不存在；确认的是对应需求解析丢失与追溯失真。
- GMAC module_specification:37 在范围说明中引用 SPEC-HD-001 / FC-002 / STA-001 / CS-001。现 requirement-model 的这些 #a 条款却统一取“交换机功能、MACsec/1588、协议栈、PHY 内部寄存器实现、SRAM 宏物理视图”作为功能仿真文本。52 行 SPEC-FC-002 的正式 PAUSE 生成、quanta、滞回、释放与重传定义因此没有成为该 SPEC ID 的内容（REQ-FUNC-007 等其他 ID 可能保留相关行为）。62 行正式半双工行为同样被前面的引用遮蔽。

在独立最小工程里保留“模块规格追溯引用”和“产品需求正式定义”，调用真实 buildVerificationIntelligence，正式需求中的溢出边界内容确实完全未进入 requirement-model。故不是仅凭多个 ID 同文猜测重复，而是当前实现可复现的定义优先级错误。与简单去重相比，应优先修复定义/引用识别、正式定义合并与条款上下文保存，之后才判断义务是否等价。

## 五、没有证据支持的结论

- 本次未找到可以确认“求解器状态空间爆炸”的内存、超时或证明扩展曲线证据。GMAC 的实际阻塞目标是缺少 PAUSE 生成能力以及规格裁决，不能归因为 Formal 状态爆炸。
- 未从本次样本证实 SVA 空真或 assumptions 过强导致 PASS。缺少检测器不是事件证据。
- 历史报告写“全部通过”不等于当前机器闭环。MoonGlass_DMA 的 R2 报告明确推翻 R1 的全过结论；DMA_mt 的 completed 标签也缺少门禁时间链支持。这些与重复派发应分别讨论。

## 结论与对应处理方向

已经确认的是历史流程级重复派发，以及当前规格义务重复物化和正式定义遮蔽。GMAC 同一组失败目标连续重派 20 批，约 74 分钟没有新的场景闭环，但不是每一批都零新增诊断。当前至少有两项相关防护：删除姿态时间计为进展，以及自动下一步工作调和/排除；真实数据副本的选批测试已经证实后者会屏蔽历史三个目标。

第二轮修正后的优先方向：先修复解析中的正式定义遮蔽与上下文丢失；再验证没有 confirmed+fix 根因/work 登记的裁决路径是否能转入下一步工作，并补充无变化重派的契约测试。批次 completed 与功能 PASS 保持分离，不要求所有诊断批次都新跑仿真。已经存在的 work 守卫应先验证和完善，不重复发明一套阻断状态系统；本轮未修改生产实现。

## 第二轮复现与检查

新增 `scripts/review-verification-inflation.mjs`，仅写独立临时目录；`--gmac-sessions` 开关只读真实 GMAC 数据和原始会话。运行结果：

- `node scripts/review-verification-inflation.mjs --gmac-sessions`：通过，覆盖同源重复、引用遮蔽、标题入模、裁决覆盖、无 hit 阻断仍留计划、旧 FAIL hit 满足批次完成、新 work 屏蔽、真实 GMAC 副本自动排除与 15 个原始会话统计。
- `node scripts/verification-work-dispatch-smoke.mjs`：通过。
- `pnpm typecheck`：通过（仓库现有脚本执行 workspace 子包类型检查；本轮生产代码未改）。
- `pnpm typecheck:root`：通过，额外检查主项目 TypeScript。

独立实验检验机制存在性，不替代真实项目端到端长运行。未证明 Formal 状态爆炸、Multi-Oracle 是历史事故原因、统计表中所有重复均有独立仿真成本、或所有 VERIF 项目已经签核。
