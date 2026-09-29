# MoonGlass 修改记录

本文件记录开发过程中的功能修改与验证结果。版本正式发布时，再将对应内容整理到 Release Notes。

## 2026-09-29：v1.0.0 基线

- **验证策略修订《TOP 优先，UT 例外》**（`docs/AIGV-TOP-FIRST-STRATEGY-ZH-CN.md`）：DUT 默认整个设计（TOP），子模块 UT 改为诊断驱动的例外；配套配置空间模型（寄存器组合账本），"需求→规格→验证"链条顶层闭合。
- **验证环境零摩擦专项**（T1/T2/T3/T5/T6）：cocotb 2.x 版本治理与模板升级、TB 端口解析修复、安装版本钉死+装后真自检、非 ASCII 路径收尾（SYNTH-D2 证伪，真凶为 SYNTH-D1 已修）、设置页"环境自检"。
- **易用性收敛**：移除工作区底部工程控制台；验证态势 UX 收敛与引导流。
- 含 v0.9.10 已基线的：托管 VERIF 断档修复、会话状态徽标、界面重载三层、OpenCode Go、死逻辑检查、EPIPE 防御。

## 2026-09-29：验证环境零摩擦专项（VERIF-ENV-ZERO-FRICTION T1/T2/T3/T5/T6）

- **T1 cocotb 版本治理**：新增 `packages/eda-bridge/src/toolchain-manifest.ts` 作为版本 pin 单一出处（cocotb 锁定 2.0.1，兼容范围 >=2.0.0 <3.0.0）；`detect.ts` 对 cocotb 做版本范围校验（`ToolDetection` 新增 `versionCompatible`/`versionHint`，探测缓存 v2→v3）；cocotb-verification 技能模板 19 个文件全量升 2.x（`cocotb.log.SimLog`→标准 logging、`TestSuccess/TestFailure`→assert/自然返回、`units=`→`unit=`）；`validate_env.py` 新增 compat 检查族（版本校验 + 1.x 习语扫描，TestSuccess 不再当正面证据）；设置页工具行加"版本不兼容"徽标。
- **T2 generate_tb 端口解析修复**：`moonglass-tools.ts` PORT_DIR 正则方向后跳过 wire/reg/logic/signed 等声明关键字，`input wire en` 不再被解析成名为 `wire` 的端口；新增 `tb-port-parse-smoke`（22 断言）登记 core 套件。
- **T3 安装版本钉死 + 装后真自检**：OSS CAD Suite pin `2026-09-28`、Verible pin `v0.0-4296-g0f262651`（含 sha256，下载后校验，不匹配即失败）；三类 bundle 装完立即真自检（yosys/iverilog 版本+最小编译运行、verible lint 最小 SV、cocotb 版本范围），自检失败判安装失败并指名缺失项；`checkIcarusToolchain` 最小程序抽出为可复用的 `verifyIcarusToolchain`。
- **T5 非 ASCII 路径收尾**：SYNTH-D2 五组对照实验**证伪**"ALUMACC 无声中断与路径编码同源"——真凶即 SYNTH-D1（yosys-abc 漏打包），中文路径 cwd+相对路径综合产物与 ASCII 基线逐字节一致（记录见 `用户问题收集/case2/synth-d2-experiment-20260929.md`）；cocotb 仿真前置检查 TB 内非 ASCII 绝对路径引用（抛错指明文件+行号）；用户手册补非 ASCII 路径说明。
- **T6 用户侧环境自检**：新增 `eda:self-check` IPC 与设置页"环境自检"按钮，主进程内联执行 5 项最小端到端检查（iverilog 编译运行 / verible lint / yosys+ABC 综合 / sby bmc / cocotb+icarus 1 断言），逐项 PASS/FAIL/跳过 + 失败项"前往安装"指引；本机实测 4 PASS + verible 正确 SKIP。
- T4（cocotb bundled 化）与 T7（Agent shell 工作区围栏）为决策项，待产品侧/主团队拍板后实施。
- 验证：`pnpm typecheck:root` 维持既有 11 个历史错误零新增；core 28 + integration 7 套件全绿；完整回执见 `docs/VERIF-ENV-ZERO-FRICTION-GUIDE-ZH-CN.md` §6。

## 2026-09-29：v0.9.10 基线

- **托管 VERIF 断档修复**（e2e 复现确认）：批次循环等待 RTL 修复 settle 后自动续跑；任务会话继承用户模型选择；规划/审查 prompt 收敛边界。e2e 设施 `scripts/e2e-managed-verif.mjs` 入库。
- **项目卡片会话状态徽标**：进行中（绿脉冲）/ 空闲可继续输入（灰）/ 上轮中断可继续（琥珀），覆盖前台与后台批次/修复会话。
- **界面重载三层能力**：Ctrl+Shift+R 重载界面不动会话；退出时有会话运行弹确认；中断会话重启后徽标提示续跑。
- **待确认决策卡片**集中提升到会话底部（并行会话）。
- 验证：typecheck 0 错误；core 25 + integration 6 套件全过；两轮真实 e2e 复验托管链路。

## 2026-09-28：v0.9.9 基线

- **RTL 死逻辑检查**：基于 slang elaborated AST 的无驱动/无负载（undriven/unused/dead）检出；internal 项可直接清理，命中架构文档或顶层端口的 spec-anchored 项必须经工程师裁决（删除/保留/TBD），裁决为删除时先同步架构文档；RTL 阶段联合 Lint 后必查，QA 门禁无未裁决项。
- **OpenCode Go 供应商**：预置接入（`opencode.ai/zen/go/v1`）；自定义请求头端到端支持，`x-opencode-session` 会话头按会话稳定注入（官方 2026-09-06 起强制）；模型登记表补 gpt-6-luna/gpt-6-sol/grok-4.7。
- **case3 用户缺陷**：Formal 中文路径 sby 调用失败修复；验证面板场景绑定链路修复。
- 验证：typecheck 0 错误；core 25 + integration 6 smoke 套件全过。

## 2026-09-28：RTL 死逻辑（无驱动/无负载）检查 + 架构契约工程师裁决

- 背景（用户需求 2026-09-28）：RTL 阶段加入"没有 driver、没有 load"的检查——这类死代码留着会影响验证回归，应优先清理；若处置涉及架构设计文档变更（接口/寄存器/架构契约），必须通知工程师同意，不得由 Agent 自行删除。
- **分析器（packages/eda-bridge/src/dead-logic.ts）**：基于 slang elaborated AST（--ast-json --ast-json-source-info，调用模式与 structural-analyzer 一致：AST 落临时目录、消费后删除、失败写 rtlqa/lint/dead_logic_slang.log）按模块统计每个 Net/Variable 的驱动（赋值 LHS / 输入端口方向 / 实例输出连接）与负载（表达式引用 / 输出端口方向 / 实例输入连接），产出 undriven / unused / dead 三类问题；generate 未选中分支 elaborated 后天然排除；同一模块多实例取驱动/负载并集防误报；slang 缺失显式报「工具缺失」（支持 MOONGLASS_SLANG_PATH 覆盖）。
- **规格锚定分类**：信号名文本命中 docs/03_design/ 的 interface_spec/register_map/architecture/microarchitecture 或属顶层端口 → spec-anchored（需工程师裁决），否则 internal（可直接清理）。
- **pi 工具 check_dead_logic**：报告写 rtlqa/lint/dead_logic_report.json + .md（中文摘要：文件:行、类型、分类、建议动作）；复跑自动继承仍命中项的既有裁决（按 模块.信号 键）。
- **流程接入**：RTL 模板 2.1.0——联合 Lint 后必须 check_dead_logic，internal 直接清理，spec-anchored 逐项 request_user_decision 裁决（删除/保留+理由/TBD）并写回 adjudications，阶段完成前无未裁决项；QA 模板 2.2.0 门禁清单加"死逻辑检查无未裁决项"。
- **QA 门禁 qa-dead-logic-adjudicated（PhaseEngine）**：报告缺失时 warning 提示放行（不阻断，与 CDC 启发式口径一致）；存在 spec-anchored 未裁决或裁决非法（decision ∉ remove/keep/tbd 或 rationale 为空）时阻断。
- 验证：新建 dead-logic-smoke（15 断言：三类检出/实例连接/顶层端口/规格锚定/零误报/裁决继承/工具缺失路径，真实调 slang）注册进 core 套件；qa-semantic-gate-smoke 扩展 4 断言（缺失提示/未裁决阻断/非法裁决阻断/合法放行）；pi-tools-smoke 复制清单同步；`pnpm typecheck` 全 workspace 通过，typecheck:root 维持存量 11 项无新增。

## 2026-09-28：BUG-FORMAL-PATH-001 中文项目路径 Formal 回归修复（case3 DDR_BIST）

- 根因（实测确认）：内置 AIGV 工具链的 Python 是 MinGW/msvcrt 构建，窄 argv 按系统 ANSI 代码页（GBK）转码，非 ASCII 绝对路径经 argv 传递必然损坏为 surrogateescape 乱码——cmd 批处理包装与原生 sby.exe 同样中招（与 0.9.5/0.9.8 无关，机制上一直存在；0.9.5 成功案例应未经过含中文的 argv 路径）。
- 修复（packages/eda-bridge/src/formal.ts）：非 ASCII 不再经 argv/配置文件传递——sby 以 cwd=verification/formal 工作目录运行（CreateProcessW 宽字符目录参数安全），`-d` 与 .sby 用相对纯 ASCII 路径；[files] 从绝对路径改为相对 formal 目录的相对路径（项目根的非 ASCII 前缀经 ../../ 消去）；配置内容含非 ASCII 时前置报清晰错误。
- 顺带回答用户 F2：失败任务目录缺 config.sby 是因为 sby 在 open(argv 乱码) 阶段即崩，根本没进入工作目录生成阶段；修复后 config.sby 正常生成。
- 验证：formal-smoke 新增中文路径回归用例（`中文项目\DDR_BIST` 工作区，bmc PASS）全过；pnpm typecheck 零错误；pi-tools-smoke 回归通过。

## 2026-09-28：陈旧 PASS 污染防线（RTL 变更后旧证据不再污染当前状态）

- 背景（用户担心核实）：RTL 变更后重跑回归时，旧 PASS 数据存在三个污染通道——eda-bridge 无条件合并旧覆盖率与通道结论（旧 RTL 的覆盖率会被盖上当前 rtlHash 混入门禁）、cocotb/cpp 路径会解析历史遗留 coverage.dat 当作本次结果、`...previous` 展开把旧 rtlCoveragePassed 带回；门禁侧 sim-passed 与 review_verification_evidence 无新鲜度过滤。
- **eda-bridge**：新增 rtlInputHash（RTL 输入路径+内容哈希）写入 result.json；旧覆盖率、旧 coverageDataPath、旧 functionalPassed/rtlCoveragePassed 通道结论仅在同一 RTL 输入时继承，RTL 变更后一律丢弃并强制双通道重跑；两条仿真路径均只在 coverage.dat 本次运行被真正重写（mtime 前移）后才解析。
- **门禁**：sim-passed 增加 rtlHash 新鲜度检查（过期证据报"请重新回归"，不充当仿真通过判定）；review_verification_evidence 剔除 rtlHash 不匹配的 result 并 warning 留痕。
- 已有保护确认无洞：scenario_hits 陈旧 hit 降级 IMPACT_UNKNOWN/PARTIAL、specMapping PASSED 只认 CURRENT、陈旧 Formal 结果不得覆盖当前 hit、覆盖率门禁与 QA 语义审查的 rtlHash 过滤。
- 验证：verilator-coverage-smoke 新增 4 项污染断言（RTL 变更后旧覆盖率不继承/通道复位/新 rtlInputHash）全过；qa-semantic-gate-smoke 新增 sim-passed 过期阻断/放行双路径；eda-gate/scenario-hits/verification-intelligence 回归全绿；pnpm typecheck 零错误。

## 2026-09-28：BUG-VERIF-BIND-001 场景绑定反向指针（case3 DDR_BIST）

- 背景：scenarioIds 路径的 run_simulation 只登记 reached/passed/reachCount/rtlHash/evidence，未记录"覆盖该场景的 testcase"，态势页绑定列显示"未绑定"（实测 155/165 场景缺反向指针）；WAIVED/formal-candidate 场景无 testcase 属设计使然却显示"未绑定"，造成"验证遗漏"的误读。
- **登记层（pi-bridge writeScenarioHits/run_simulation）**：新增条目字段 boundTestcases + boundBy。run_simulation 从 JUnit XML 收集本次实际执行的全部测试函数（排除 skipped）：单用例运行时把该函数提升为所有显式绑定场景的精确 testName（boundBy=testcase-name）；多用例运行时整组记入 boundTestcases（boundBy=scenarioIds，批次级绑定）。跨次运行 union 合并去重，evidence/reachCount 合并语义不变（增量，不覆盖）。
- **补绑层（FileService）**：新增 scanScenarioBindings——扫描测试函数 docstring 的 SCN-XXXXXXXX 引用建立"场景 → 测试函数"映射（manifest 的 scenarios 字段同样支持）；mapScenarioToTestId 增加该兜底；存量工程无需重跑即可追溯。执行行透传 scenarioId/boundTestcases。
- **UI（VerificationPosturePage 用例全景）**：绑定列反查 executed 行的 scenarioId + boundTestcases；无用例时区分语义——已豁免显示"不适用（已豁免）"、formal-candidate 显示"Formal 关闭"、static 显示"静态审查关闭"，不再一律"未绑定"。i18n zh/en 同步。
- 验证：scenario-hits-smoke 扩展 4 组反向指针断言（单用例精确/多例批次/合并去重/名称解析并存）全过；`pnpm typecheck`（workspace）与 pi-tools-smoke/verification-guidance-smoke 回归通过；typecheck:root 存量报错文件无新增。

## 2026-09-28：阶段提示词全量审查修复

- 背景：v0.9.8 基线后对六个阶段提示词与门禁实际行为做逐条对照审查。
- 修复（QA 模板 2.1.1）：QA 模板引用的代码审查清单 `resources/moonglass/code-review/rtl-code-review-checklist.md` 是应用资源目录、不在项目工作区内，pi 会话读不到——将 CR-01~CR-12 清单正文内嵌进模板，资源文件保留为 canonical 副本。
- 修复（VERIF 模板 2.4.1）：约束清单补齐功能覆盖率 ≥80%（与门禁 func-coverage-gte-80 对齐）；规则 3 删除误导性的显式 `simulator="icarus"`（v0.9.8 起 icarus 请求自动升级 verilator 后端采覆盖率，改为缺省行为描述）。
- 审查确认不改项：SYNTH 阶段 PPA 闭环指引缺失（用户决策暂不处理）；REQ_SPEC 超出门禁的产出与 register_map.md 落盘目录（保持现状）。
- 验证：`pnpm typecheck` 全 workspace 通过；`qa-semantic-gate-smoke` 回归通过。

## 2026-09-15：v0.9.8 基线

- **QA 阶段语义终审**：四类新门禁（语义实现审查 / 验证完备性审计 / 代码审查清单闭环 / 复位评审留档），QA 不再只做 Lint/CDC/可综合静态检查（详见同日专项条目）。
- 版本号：package.json 与 APP_INFO 同步 0.9.8。
- 验证：`pnpm typecheck`、`qa-semantic-gate-smoke`（12 断言）、`verification-intelligence-smoke`/`eda-gate-smoke`/`batch-prompt-smoke` 回归全部通过。

## 2026-09-15：QA 阶段语义终审（四类新门禁）

- 背景：QA 阶段此前只有 Lint/CDC/可综合静态检查，缺少"规格是否被 RTL 实现""每个规格点是否有验证点+用例覆盖"的语义终审；代码审查与复位评审只有提示词文本、无机器检查。
- **qa-spec-implementation-reviewed**：需求/规格 → RTL 语义实现审查。Agent 逐条款裁决 implemented/partial/missing/not_applicable 写 rtlqa/spec-implementation-review.json；门禁按 specMapping 条款闭集校验裁决完备、implemented 证据路径真实存在（支持 行号 后缀）、partial/missing 挂具名豁免（signoff-approvals.json）、rtlHash 与当前工作区一致（RTL 变更后旧审查不再采信）。
- **qa-verification-completeness**：规格点 → 验证点 → 用例 → 证据完备性审计。引擎新增 auditVerificationCompleteness：每个 VERIF 通道条款要求真实验证 Intent + 场景绑定 + 当前 RTL 版本 PASS 证据，WAIVED 需 RR-WAIVER 具名审批；synthesis 通道条款不在本分母（SYNTH 阶段验收）。
- **qa-code-review-done**：RTL 代码审查清单机器化。新增清单资产 resources/moonglass/code-review/rtl-code-review-checklist.md（CR-01~CR-12，只覆盖 lint 查不出的语义项）；Agent 逐条裁决写 rtlqa/code-review-verdicts.json，门禁校验无 open 项、waived 挂具名豁免、rtlHash 新鲜度。
- **qa-reset-review-documented**：复位风险评审结论留档 docs/06_validation/reset_review.md。
- 提示词：QA 阶段模板升级 2.1.0，四项任务与门禁口径写入。
- 验证：新建 qa-semantic-gate-smoke（12 断言，阻断/放行/豁免/过期四路径全过，注册进 integration 套件）；verification-intelligence-smoke、eda-gate-smoke、batch-prompt-smoke 回归通过；pnpm typecheck 全 workspace 通过。

## 2026-09-15：已完成批次会话标签可关闭

- 问题：会话标签栏中已完成的 VERIF 批次会话（"查看"徽标）无关闭按钮，完成记录不断堆积无法清理。
- 修复：SessionTabs 对未运行中的批次会话渲染 × 关闭按钮（复用既有 closeSession 链路：删除 JSONL + 清理模型登记，运行中批次仍不显示）；主进程 closeSession 增加保护——正在运行的 VERIF 批次会话（activeVerifBatches 命中）拒绝关闭并提示先停止托管，防止编排循环的 settle 等待悬空。
- 验证：`pnpm typecheck`、`pnpm build`、`agent-interaction-smoke` 通过。

## 2026-09-15：移除工作区底部工程控制台

- 用户反馈底部"工程控制台"（问题/运行/验证运行/验证/综合/产物六页签）几乎没有用处，整体删除：BottomPanel 组件、BOTTOM_TABS、bottomH/bottomCollapsed/activeTab 状态与高度持久化、底部调高手柄、面板专属 CSS 与 `workspace.console/problems/runs/verification/synthesis/artifacts` i18n 命名空间（中英同步）。主内容区改为自然占满高度。
- 甄别保留：`gate`（PhaseBoard/页头横幅）、`verifRunData`（FixWindowBanner）、`handleBasicValidation`（VERIF 操作条）、`verifLog/appendLog`（约 30 处流程调用）、`components/verif-run/` 库（VerificationPosturePage 在用）与 `verifRun.*` 文案。
- 验证：`pnpm typecheck`、`pnpm build` 通过，全仓零残留引用。注意：`scripts/e2e-managed-verif.mjs:316` 曾读 `.console-row` 作观测，删除后该选择器恒空（不报错），如需观测可改读聊天消息区。

## 2026-09-15：待确认决策卡集中提升到会话底部

- 问题：会话中待用户确认的 DecisionCard 嵌在原始消息气泡里，长会话中被新内容顶上去，用户需向上翻找。
- 修复：未确认的决策卡统一渲染在消息列表底部的集中区（蓝色提示区 + 全部卡片 + 提交全部按钮）；原消息位置改为虚线占位标记（显示决策标题，点击平滑滚动到底部）；已提交/已起草的卡片仍留在原位置锁定展示。只读批次回看面板不受影响。
- 验证：`pnpm typecheck`、`pnpm build`、`agent-interaction-smoke`（含决策回复路径）通过。

## 2026-09-15：聊天输入框"能粘贴不能键入"——巨型会话渲染阻塞修复

- 症状与根因：巨型会话（用户实测 3.6M token）中输入框无法键入但可粘贴。粘贴是单事件、键入是连续按键+IME 组合，对长帧极敏感。`MessageBubble` 未 memo 化，每次击键重渲染全部消息（上限 320 条），`inputHistory` 每次渲染全量 filter。
- 实测对照（`scripts/chat-input-perf-repro.mjs`，playwright 驱动真实应用 + 隔离 userData，合成 320 条/16.4MB 会话）：修复前巨型会话击键端到端中位 **112ms/键**（25 个 longtask，共 2308ms，最大 99ms），修复后 **17ms/键、0 longtask**、零焦点漂移、零 disabled 抖动。
- 修复：`MessageBubble` 包 `React.memo`（重命名实现为 `MessageBubbleImpl`），消息列表 onDecision 改稳定 `useCallback`（`handleDecisionDraft`），BatchSessionPeek 用模块级 `noopDecision`，`inputHistory` 改 `useMemo([messages])`。
- 配套：主进程新增 `MOONGLASS_USERDATA` 环境变量（仅非打包模式生效）隔离数据目录，供 E2E/诊断脚本不触碰真实 userData——Electron 在 Windows 下不读 APPDATA 环境变量，此前隔离方案无效。
- 验证：复现脚本前后对照（数据如上）；`pnpm typecheck`、`pnpm build` 通过。

## 2026-09-15：lint 规则扩展（Verilator 警告升级 + 4 条结构规则）

- 背景：对 verible 官方规则目录、svlint 规则集（ruleset-designintent）、lowRISC Verilog 风格指南与 Verilator 警告清单调研后挑选高价值项落地。
- Verilator 警告升级：runLint/runDesignLint 加 `-Wall` 打开 SYNCASYNCNET/MULTIDRIVEN 等 -Wall 专属类别；精选升级集（LATCH 非预期锁存器、MULTIDRIVEN 多驱动、SYNCASYNCNET 复位同步/异步混用、UNOPTFLAT 组合环路、CASEOVERLAP、CMPCONST、SELRANGE）由 warning 升级为门禁阻塞 Error；WIDTH 家族与 CASEINCOMPLETE 刻意保留 warning（存量命中率高、多为良性）。
- 新增 4 条 moonglass-* 结构规则：`comb-nonblocking`（组合块禁非阻塞，error）、`seq-nonblocking`（时序块禁对 reg 阻塞赋值，for 循环变量/function 豁免，error）、`no-case-equality`（RTL 禁 ===/!==，initial/task 仿真语境屏蔽，error）、`self-assign`（自赋值提醒，warning 级不阻塞）。
- 统一入口 `moonglassCustomIssues()` 挂进两个执行器；提示词 RTL 强制检查段同步补齐同义约束。
- 真实回归：用户缺陷文件 LITE_DMA/lite_dma_axi_master.v 精确命中 228/276/287 行 i_rst_n 组合逻辑且新规则零误报；IP 库与 demo-seed 存量 RTL 扫描零误报（pmu.v 一处保持态自赋值按设计为良性 warning）。
- 验证：新建 `lint-rules-smoke`（9 断言全过，注册进 core 套件）；`eda-gate-smoke`/`clk-rst-comb-lint-smoke`/`axi-lite-timer-smoke`/`pi-tools-smoke` 回归通过；`pnpm typecheck`、`pnpm build` 通过。

## 2026-09-15：lint 新规则 moonglass-no-clk-rst-in-comb（时钟/复位禁入组合逻辑）

- 背景：第三方 review 发现生成的 RTL 中复位/时钟信号参与组合逻辑，lint 门禁查不出。根因四重叠加：规则资产与提示词均无此约束；Verilator 5.x 已移除 CLKDATA/CDCRSTLOGIC、verible 无此类语义规则；门禁只数 Error 且 `-Wno-fatal` 吞 Warning；另发现 `verible_default_rules.txt`（15 条风格规则）是死资产（rulesFile 从未传递）。
- 实现：`eda-bridge` 新增 `clkRstInCombIssues`（候选信号 = 命名约定词干 clk/clock/rst/reset（含 i_/o_、_n 变体）∪ 时序敏感表信号；违规位置 = assign 右值 + 组合 always 块体；豁免时序块复位判断、注释/字符串、词干误伤（clkdiv/rst_cnt）、整标识符直通转发），以 Error 级挂进 `runLint`/`runDesignLint`——PhaseEngine 门禁（RTL→VERIF、QA→SYNTH）与 Agent `run_verible_lint` 工具自动同时生效，无需改门禁代码。
- 提示词：RTL 阶段强制检查段新增同义约束，从源头减少生成。
- 意外收获：新规则抓到内置 IP 模板 `axi_lite_timer.sv` 用 `aresetn` 组合门控 AXI ready 的真实缺陷，已改为时序复位释放寄存器（行为等价，TB 通过）。
- 验证：新建 `clk-rst-comb-lint-smoke`（9 项断言全过，已注册进 core 套件）；IP 库与 demo-seed 存量 RTL 扫描 0 违规；`eda-gate-smoke`/`axi-lite-timer-smoke`/`pi-tools-smoke` 回归通过；`pnpm typecheck`、`pnpm build` 通过。

## 2026-09-15：Agent 启动竞态与 Markdown 链接白屏修复

- **Agent 启动竞态（进新阶段慢 + 启动期切模型导致会话永久损坏）**：根因是并发 ensure 返回半成品快照 + 启动期无 ready 门禁 + 初始化失败不清理。
  - `AgentService.ensureSession` 加 per-project 在飞去重（pendingEnsures），并发 ensure 共享同一 Promise，消灭"selectedModel=null 空快照赢"路径；
  - 所有 spawn 后初始化段（waitReady + 初始 set_model）统一 try/catch，失败时先从 sessions map 摘除再 dispose，下次 ensure 自动重 spawn——补上此前缺失的重启机制；
  - `PiSession` 新增 `ready` 标记，`prompt`/`setModel`/`compactSession` 在启动完成前直接拒绝，不再向半 boot 的 pi 挤命令；
  - 渲染端 chatStore.ensure 同做在飞共享；模型下拉在 selectedModel 未回填前禁用；WorkspacePage 去掉阶段推进后的重复 ensure。
- **Markdown 预览点击不存在文件链接白屏**：根因是 `MarkdownPreview` 的裸 `<a href>` 触发 Electron 整窗导航到不存在文件（ERR_FILE_NOT_FOUND），React 应用被卸载。双层修复：
  - 渲染端 `MarkdownPreview` 拦截相对路径链接，dispatch `moonglass-open-project-file` 复用 openFile 安全链路（不存在 → unreadable tab）；http(s)/锚点放行；
  - 主进程新增 `will-navigate` 兜底：非 app 自身导航一律 preventDefault，http(s) 转系统浏览器打开——覆盖任何来源的整窗跳转。
- 验证：`pnpm typecheck`、`pnpm build` 通过；`agent-interaction-smoke`/`session-transcript-smoke`/`pi-rpc-smoke`/`agent-run-watchdog-smoke`/`agent-event-routing-smoke` 全过。

## 2026-09-15：v0.9.7 基线

- **覆盖率详细报告视图**：Verilator 覆盖率从聚合百分比升级为可下钻明细——验证态势页新增「代码覆盖率明细」面板，按场景 → 类型（行/条件/表达式/翻转/FSM）→ 文件 → 逐检测点（行号、cond_then/else 语义、命中次数、层级路径）四层查看，支持只看未覆盖与 RTL 源码逐行 gutter 标注；历史 coverage.dat 经主进程 CoverageService 追溯解析并缓存 coverage-detail.json，无需重新仿真。
- **Pi Coding Agent 内核升级**：0.84.1 → 0.85.1（详见同日专项条目）。
- 自 v0.9.5 基线以来的其余变更：AIGV 方法学论文 2.1、docs HTML 中文化、验证态势页工程使用指南、运行中主会话切换模型。
- 验证：`pnpm typecheck`、核心测试套件（22 脚本）、`pi-rpc-smoke`/`pi-tools-smoke`/`pi-rpc-event-smoke`、`verilator-coverage-smoke`（20 项）、`pnpm build`、版本一致性检查全部通过。

## 2026-09-15：代码覆盖率详细报告视图

- 解析层：`eda-bridge` 新增 `parseVerilatorCoverageDetail`，捕获 coverage.dat 中此前丢弃的文件/行列/语义/层级字段；仿真落盘时同步写 `coverage-detail.json` 缓存；`parseVerilatorCoverage` 签名与行为不变。
- 服务层：新增主进程 `CoverageService`（`coverage:detail` IPC，`verification/results/` 前缀防穿越），缓存缺失时回退解析 coverage.dat 并回写——demo-seed 历史结果实测可解析（10 文件，汇总口径与旧解析器一致）。
- UI 层：验证态势页新增 `CoverageDetailPanel`（场景选择 / 六类概览 / 类型 tab / 只看未覆盖 / 按文件聚合 / 逐点列表 / 源码 gutter 标注）；dat 绝对路径经 `workspaces/<uuid>/` 截取 + basename 文件树匹配双路映射；文案全量走 i18n（zh-CN 源 + en 镜像）。
- 诚实性口径：本机 Verilator 5.x 无独立 branch 插桩类型，条件覆盖为表达式求值口径，报告与 coverage_report.md 均标注"非 MC/DC"。
- 验证：`pnpm typecheck`、`pnpm build`、`verilator-coverage-smoke`（真实运行 + 合成 dat 双路径断言）通过。

## 2026-09-15：Pi Coding Agent 内核升级 0.84.1 → 0.85.1

- 版本：`@earendil-works/pi-coding-agent` 精确锁定到 `0.85.1`（跳过 0.85.0——该版本误发布内部实验代码导致 SDK import 失败，0.85.1 已修复）。
- 兼容性核验：对照官方 CHANGELOG 与 dist 类型定义逐层比对——RPC 协议纯增量（`message_update` 新增 cumulative `usage`、`toolcall_start` 带 `id`/`toolName`、新增 `clear_queue`）；扩展 API 纯增量（`session_compact_failed`、`ui_prompt_start/end`），`registerProvider`/`ProviderConfig` 形状不变，`moonglass-providers.ts` / `moonglass-tools.ts` / `PiRpcClient.ts` 零改动编译通过。
- 依赖变化：pi 本体不再依赖 `pi-client`/`pi-protocol`，新增 `@earendil-works/chord`；`stage-pi-runtime.mjs` 通用递归物化逻辑直接覆盖（128 个依赖包，版本冲突照常嵌套处理）。
- 行为变化确认：`setModel`/`setThinkingLevel` 自 0.85.0 起只作用于当前会话、不再改写新会话默认（MoonGlass 每个聊天即一个 pi 会话，恰好匹配该语义）。
- 顺带受益的 upstream 修复：Windows 下 taskkill 缺失导致 shell abort 崩溃（0.84.4）、扩展 `triggerTurn:false` 消息插入乱序（0.84.4）、恢复缺换行 JSONL 会话损坏下一条（0.84.4）、RPC `abort` 不取消手动 compaction（0.85.0）。
- 验证：`pnpm typecheck`、核心测试套件（22 个脚本）、`pi-rpc-smoke`（Provider 注册 + 模型注册/切换 + 流式收尾）、`pi-tools-smoke`（桥接扩展加载零错误、技能/命令齐全）、`pi-rpc-event-smoke`、`pnpm build`、`stage-pi-runtime`（物化 0.85.1 + chord）全部通过；`typecheck:root` 的 11 条报错为工作区既有问题（升级前干净树逐字一致，均与 pi 无关）。

## 2026-09-14：AIGV 方法学论文刷新至 2.1

- 刷新 `docs/MoonGlass-AIGV验证方法学.html`，补入 MoonGlass v0.9.x 已落地的 W0-W3 验证波段、任务级会话、每批最多 3 个 Scenario、完成屏障和增量执行策略。
- 增加渐进式诊断、证据 RTL/Scope Hash、运行用途隔离、原子快照、Formal 能力预检与义务分级，以及验证态势到工程行动的映射。
- 新增“已实现 / 项目适配 / 研究方向”边界，避免把方法主张、当前产品能力和未来研究混为一谈。

## 2026-09-14：docs HTML 文件中文化

- 将 `docs` 下除 GitHub Pages 固定入口 `index.html` 外的 12 个 HTML 文档统一改为中文可读文件名。
- 同步更新 README、Release Notes、开发摘要、网页互链、canonical URL 和分享元数据中的旧文件名，避免重命名后产生失效链接。

## 2026-09-14：验证态势页工程使用指南

- 新增单文件 HTML《MoonGlass 验证态势页详解与工程使用指南》。
- 逐项解释总体签核、W0-W3、实际用例执行、规格映射、Verification Space、风险、行动、九项指标、模块策略、Intent、Spec Gap、Coverage Hole、诊断控制和证据文件。
- 增加六大核心区域专门读图法，分别说明模块分层、风险热区、签核阻断、Intent 闭环、规格缺口和 Coverage Hole 应先看什么、如何判断及如何处置，并加入 DMA/FIFO 工程示例。
- 增加三分钟快速读法、日常收敛流程、常见问题处置与人工签核检查表。

## 2026-09-14：运行中主会话支持切换模型

- 修复 Agent 执行中选择新模型时被主进程直接拒绝、界面看似无法操作的问题。
- 运行中切换会先提示用户；确认后可靠中止当前轮次，再切换模型并刷新上下文统计。已写入工作区的文件保持不变。
- 模型切换失败不再被状态层静默吞掉，会保留原模型并显示真实错误。
- 验证：`pnpm typecheck` 与 Agent 结构化交互冒烟测试通过。

## 2026-09-11：v0.9.5 基线

- **DEFECT-PACK-001（Flow_Cross 用户提交包，16 项缺陷）全部受理**：Formal 证据哈希统一进工作区口径（scopeHash 溯源）、关键场景与影响未知排除已豁免场景、run_simulation 运行用途隔离（purpose 参数 + 证据旁路归档）、Cocotb 编译日志与退出码语义修正、Verilator/Yosys 非 ASCII 路径修复、TBD 消解语义、W1 卡片口径、mutation schema 告警、yosys-abc.exe 补入打包清单。
- **深色模式全端适配**：语义变量补齐 + 213 处硬编码浅色深色映射，修复设置页 EDA 工具链不可读问题。
- **模型上下文窗口**：自定义覆盖值贯通 pi 注册表（新会话生效），切换模型即刷新显示；登记表按 9 家厂商官方文档刷新（DeepSeek 主力 deepseek-flash 1M，新增各厂现役旗舰，修正 haiku-4-5 为 200K）。
- **追溯检查器诊断增强**：矩阵裸/错前缀 ID 报带定位的格式错误；门禁 ID 正则修跨命名空间污染。
- 验证：pnpm typecheck 0 错误；core 21 + integration 5 smoke 套件全过。

## 2026-09-10：团队使用演示 PPT 重构

- 将演示重构为“一个已有 IP 从进入工程到可复核交付”的单项目故事线，共 11 页。
- 移除容易产生方向歧义的连接箭头，统一使用编号、泳道和阶段卡表达先后与归属关系。
- 内容收敛为价值主张、4 个现场操作、证据驱动可靠性说明和两周团队试点方案，并保留逐页演讲者备注。
- 已重新完成逐页渲染以及 PPTX 结构、布局和字体校验。

## 2026-09-10：IP 可靠性交付客户问答

- 新增独立 HTML 客户问答手册，直接回答 MoonGlass 如何证明 IP 满足规格、验证证据是否可信及最终签核责任。
- 覆盖追溯矩阵、覆盖率、Verification Intent、Golden Model、Multi-Oracle、Formal、工具链、Agent 偏差、变更回归和客户验收等 36 个问题。
- 增加分类筛选、关键词搜索、展开/收起、打印样式和客户尽调清单，并明确“不承诺绝对零缺陷”的能力边界。

## 2026-09-08：商业授权方案调整

- 将旧的低价团队档位替换为 Community、Professional、Team、Enterprise、EDA Enterprise Pack 和 AIGV Enterprise Pack 六档方案。
- Professional 调整为 `¥1,299 / seat / year`，Team 调整为 `starting ¥19,800 / year`，企业级方案改为联系询价。
- 同步更新中英文授权说明，移除旧的个人辅助、10 人、50 人和人日定价。

## 2026-09-08：v0.9.0 绿色版与界面版本同步

- 侧栏版本号改为完整显示 `v0.9.0`，不再省略补丁版本。
- 使用统一绿色版脚本构建并校验 Windows x64 便携版本。
- 绿色版启动自检临时目录迁移到项目磁盘的 `dist/.smoke`，避免系统盘空间不足导致打包失败。

## 2026-09-08：v0.6.0-v0.9.0 工程演进学术文章

- 新增学术型 HTML 文档，系统梳理证据驱动基线、Verification Intelligence、AIGV 2.0、W0-W3、批次上下文治理、任务粒度会话、RTL 修复隔离与并行验证门控。
- 增加研究问题、架构对比、工程评价、可检验假设、有效性威胁和后续研究方向。

## 2026-09-08：重写 GitHub README 首页叙事

- 将 README 核心内容调整为 MoonGlass 基础介绍、用户上手、六阶段工程流程、AIGV 2.0、工程思想和学术社区入口。
- 增加绿色版、用户手册、界面预览、源码运行、授权和问题讨论入口。
- 移除与产品核心价值无关的历史背景叙事。
- 增加独立的开源声明、作者与维护者、商业合作和技术支持章节。

## 2026-09-08：清理第三方产品明文引用

- 删除历史规格草案及其相关明文说明。
- 清理 README、开发总结、总体报告、第三方声明和项目指南中的相关产品名称、链接及比较性描述。
- 保留第一方独立实现和第三方许可证边界的通用说明。

## 2026-09-07：v0.8.6 GitHub 界面截图刷新

- 重新采集项目总览、VERIF 工作区、验证态势、RTL Design Browser 和设置页截图。
- 新增开发环境与 EDA 工具链、关于与授权页面截图。
- 公开截图隐藏无关项目，避免项目名称遮挡影响展示效果。
- 修正工作区底栏遗留的 `v0.5` 硬编码，改为读取统一应用版本信息。

## 2026-09-07：准备 MoonGlass v0.8.6 GitHub Release

- 更新 README 与 HTML 快速手册的版本、功能清单和绿色版下载入口。
- 新增 `RELEASE-NOTES-v0.8.6-ZH-CN.md`，系统说明 AIGV 2.0、W0-W3 验证波段、批次会话、EDA 证据闭环、设计浏览器及 Agent 韧性更新。
- 发布附件使用已通过 17 项核心测试和真实 EXE 启动自检的 Windows x64 绿色版，并公开 SHA-256。

## 2026-09-06：界面版本号同步为 v0.8.6

- 将共享 UI 版本常量由 `0.8.0` 更新为 `0.8.6`，左下角和关于页面现在显示完整版本号。
- 新增版本一致性检查，测试时自动核对 `package.json` 与 `APP_INFO.version`，防止后续版本升级遗漏界面版本。

## 2026-09-01：验证态势数据流收敛与下一步引导修复

- 新增 `record_scenario_adjudication` 工具（引擎函数 + pi 工具）：场景裁决（规格澄清/豁免/验证）只写 `scenario-registry.json`（单一事实源）并自动重建态势快照（RTL 未变时 0.3 秒），页面刷新即见；提示词同步约束“Agent 禁止用 write/edit 手改 `verification/intelligence/` 下的机器 JSON，裁决必须走工具”。
- 验证态势页与工作区 VERIF 状态条读取时校验 schema：`verification-posture.json` 被覆盖或缺失 `verificationIntents` 时自动回退 `verification-state.json`。
- `deriveVerificationActions/Steps/TopRisks` 增加 `normalizeGuidanceState` 防御：缺失数组字段按空数组处理，修复“从验证态势返回工作区”时 `undefined.filter` 崩溃。
- 推荐下一步优先级修正：C3 激励缺失的“执行下一批高风险场景”提升为 P0；规格缺口按是否阻断拆分（C5 阻断为 P0、文档级 TBD 为 P1）；Formal 工具/环境限制独立为 P1（不再与 RTL 失败混为 P0）；统一“规格缺口 5 项 vs 2 个场景”的口径。
- 数据清洗：将 Agent 自造的非标准状态 `ADJUDICATED`（7 个场景）迁移为 `DISCOVERED`，证据中保留迁移记录。
- 新增 AIGV 优化方案讨论稿 `docs/AIGV-OPTIMIZATION-PROPOSAL-ZH-CN.md`（供专家团队评审：收敛/LLM 主导规划/重型层取舍）。

## 2026-08-31：AIGV 引擎收敛与验证态势重构

- 修复 spec-gap 解析 bug：不再把版本历史/变更日志表格行、Markdown 表格行、章节标题里的 “TBD” 当规格缺口（MoonGlass_NPU 52 项；DEC_VISINEX 104→68 项）。
- N-way Shared State Interaction 风险按模块去重（每模块最多 1 个），消除锥体影响生成的组合爆炸。
- Verification Intent 模板具体化：objective 改为“验证 X：具体信号 在同周期/相邻周期交互时，具体预期”；failureMode 改为“反例：…不成立（如计数重复/丢失…）”；不再重复罗列信号。
- 新增 `refine_verification_intents` 工具 + VERIF 提示词步骤 4.1：build 后由 Agent 精炼优先级最高的 10 个 Intent（点名具体信号/反例/判定），合并回注册表与态势。
- 验证态势页新增操作级视图：验证环境搭建状态、规划用例、已执行用例 pass/fail/发现的 Bug、未完成用例（读 JUnit XML + scenario_hits.json + result.json）。
- 修复用例状态误报：scenario_hits.json（累计证据）作为 PASS/FAIL 首要来源，JUnit XML（最后一次运行）降级为补充；解决“单用例调试运行导致其余用例被误报未执行”。
- 验证态势页重构：新增“当前验证进展”白话总览；风险卡落到具体对象/失效/验证点；Spec Gap 过滤垃圾并显示来源；Intent/Coverage Hole 只展示 top 15/20。

## 2026-08-31：会话静默中止与运行中可输入修复

- 转发 `tool_execution_update` 为 `tool-update` 事件：长耗时工具（如 run_simulation）中间进度实时展示，不再长时间无反馈被误判“中止”。
- 展示 `status` 事件（长度截断重试、Watchdog 收敛等提示），不再静默丢弃。
- `AgentService.prompt` 增加 `isStreaming` 守卫：渲染层状态漂移时也不会把第二条 prompt 发给运行中的 Agent。
- EDA 工具超时/中止时用 `taskkill /T /F` 递归清理进程树，消除 Icarus `vvp.exe` 等孤儿孙进程。

## 2026-08-31：RTL Design Browser 宏实例化解析

- Design Browser 解析 `design.json` 时追加 `libraryFiles`（SRAM blackbox 视图），解决 `hierarchy -check` 报 “Module not part of the design” 无法展开层次的问题。

## 2026-08-31：绿色版打包脚本补充

- 新增 `build-green.bat` 双击入口（UTF-8 + CRLF + 参数透传 + 结束暂停）。
- 修复 `package-green.mjs` 失效的演示数据兜底路径：改为自动继承最近一次绿色版产物中的 userdata，避免直接打包产出空白绿色版（缺少 MIC_NPU Demo）。

## 2026-08-31：Agent 阶段隔离会话

- REQ_SPEC、ARCH、RTL、VERIF、QA、SYNTH 分别使用独立 Pi JSONL；阶段推进或回退时自动切换到目标阶段主会话，不再把上游长历史、失败轨迹和工具输出注入下游阶段。
- 阶段首次进入时仅继承上一活动会话的有效模型选择，不继承消息历史；回退到已工作过的阶段时恢复该阶段原有历史。
- 平行会话按阶段命名并限制在所属阶段内切换；旧版 `session.jsonl` 和其他阶段日志继续保留在磁盘，但不会出现在当前阶段页签或被误加载。
- `pnpm typecheck` 通过。

## 2026-08-31：阶段彻底清除不再自动重做

- 阶段垃圾桶改为仅永久删除标准阶段产物，不再切换阶段、不再发送任务，也不再启动空白 Pi 进程或执行 `restartSessionFresh`；后续工作只在用户会话输入或一键托管时懒启动。
- 清除前终止该阶段活动与后台 Pi 进程，并删除该阶段主会话、平行会话及 fresh-restart 归档，避免 Agent 或旧上下文把产物重新写回；Provider/模型选择作为用户配置保留。
- REQ_SPEC 清理范围补齐 `docs/01_project`，与项目章程交付物保持一致；已完成下游阶段继续收到变更提醒。

## 2026-08-30：修复模型只思考不执行与托管误判完成

- 复盘 MoonGlass_NPU RTL 阶段：GLM-5.3-Flash 多轮将 8192 个输出 Token 全部用于 reasoning，均以 `stopReason=length` 结束且没有任何工具调用；MoonGlass 旧逻辑错误地将其视为任务完成并继续门禁恢复。
- 火山方舟 Agent Plan Provider 采用 Pi `deepseek` thinking 兼容格式，使会话的 thinking=off 实际下发 `thinking: { type: "disabled" }`，防止默认深度思考吞尽工具调用预算。
- Agent 执行完成判定新增 `length + 零 toolCall` 检测：自动注入最小可验证动作恢复指令并继续等待；连续 3 轮仍无工具调用则明确失败并停止托管，提示切换 Coding Agent 模型。
- 全局提示词明确“执行优先”和事实边界：计划中列出的 RTL 不等于实际文件，只有文件工具结果和 EDA 原始证据可用于完成结论。
- 修复火山 Agent Plan Chat API 拒绝 `developer` role 的 400 错误：Provider 显式设置 `supportsDeveloperRole: false`，由 Pi 使用受支持的 `system` role 发送系统约束。

## 2026-08-30：会话上下文压缩与无上下文重启

- 会话工具菜单新增“压缩上下文”，调用 Pi 原生 `compact` 生成关键摘要并继续当前会话；操作前明确提示会产生一次摘要模型调用。
- 新增“无上下文重启”：将当前 JSONL 历史归档到项目会话目录的 `archive/`，以空白同名 session 重启 Pi；会话标签、阶段和模型选择保持不变，旧消息和摘要均不会注入新上下文。
- 两项操作在 Agent 运行期间禁用，并提供不同确认说明，避免把上下文压缩误认为彻底清空。

## 2026-08-30：MoonGlass v0.8.0 模块分层验证策略

- 产品版本由 `0.7.0` 升级到 `0.8.0`。
- AIGV 新增 `module-verification-strategy.json`，按 `STATIC_ONLY`、`UNIT_SMOKE`、`UNIT_FOCUSED`、`IP_SIGNOFF` 对 RTL 模块分层；优先采用 `rtl/design.json` 的 `topModule`，缺失时再从实例关系推断顶层。
- 风险仍覆盖全部 RTL 模块，但只有高风险子模块和顶层 IP 进入完整 VI/SCN 闭环；普通子模块只执行静态检查或轻量 Smoke，不再把每个 `.v` 文件当成独立 DUT 重复完整 AIGV。
- 验证深度与 Oracle 策略解耦；Golden Model 根据模块语义、独立判定、故障定位和收敛收益推荐，允许 `UNIT_SMOKE` 子模块使用参考模型，也避免无收益地复制 RTL。
- 工作区验证规划、环境搭建、基础回归、风险闭环以及 VERIF 主 Prompt 全部接入模块分层策略。
- 验证态势新增模块策略表，展示模块角色、风险等级、独立 Testbench、Oracle 组合、Golden Model 建议和工程依据。

## 2026-08-30：兼容无 `/models` 端点的套餐型模型网关

- Provider 连接测试优先使用 `/models` 做无 Token 探测；端点返回 404/405 时，不再直接判定连接失败。
- OpenAI-compatible Provider 自动对全部配置模型顺序发起最小 `chat/completions` 请求，兼容火山方舟 Agent Plan 等套餐型网关，同时避免并发探测触发限流。
- 测试结果明确标注实际探测端点、每个模型的 PASS/FAIL 和具体 HTTP 原因；无模型列表时显示“已逐一探测配置模型”，不再错误显示“发现 0 个模型”。

## 2026-08-29：AIGV 2.0 Mutation、Residual Risk 与最终签核包

- 新增绑定当前 RTL Hash 的风险加权 Mutation 评估，区分 `KILLED`、`SURVIVED`、`EQUIVALENT`、`INVALID` 和 `EQUIVALENCE_UNKNOWN`；高风险 survivor、未知等价性和低于阈值均阻断签核。
- 新增 Residual Risk Register，统一收敛 Formal 工具限制、Mutation survivor、Negative Space 和 Scenario waiver；仅接受包含审批人、依据和时间的显式批准记录，Agent 不得自行代签。
- 新增机器可读 `signoff-package.json` 和工程可读 `verification-signoff-package.md`，固化 RTL Hash、Verification Space Snapshot、闭环结论、阻断项、警告、残余风险与证据清单。
- Closure Engine、验证态势、工作区下一步引导与主 Agent Prompt 全部接入 Mutation 和残余风险；最终状态明确区分未就绪、条件就绪和待人工签核。
- 专项测试覆盖 Mutation 全杀、survivor 阻断、探索饱和后的签核包生成，以及 Markdown 报告与 Package ID 的一致性。

## 2026-08-29：AIGV 2.0 自主探索历史与经验性饱和

- 新增 `exploration-history.json`；只有真实调用下一批验证任务才开启探索轮次，下一次选批结算上一轮的新增闭环与空间变化，刷新态势不会伪造轮次。
- Novelty Saturation 分为 `NOT_ENOUGH_ROUNDS`、`PROGRESSING`、`EMPIRICALLY_SATURATED`、`STALLED`；连续三轮无新增只表示当前 Verification Space、探索策略与预算下的经验性饱和，不宣称数学证明。
- 探索历史按 Verification Space Snapshot 隔离，规格或 RTL 变化后旧空间的饱和结论立即失效；关键场景仍开放时连续无新增进入 STALLED，要求停止重复并增强 Checker、Assertion、激励或空间模型。
- 修复 RTL 变化后第二次重建可能重新接受旧 scenario_hits 的问题：证据携带的 rtlHash 成为恢复 CURRENT 的唯一依据，`IMPACT_UNKNOWN` 不会被连续重建洗白。
- Closure Engine 将经验性饱和纳入机器签核条件；验证态势显示探索状态与解释，主 Agent 行动引导区分继续独立攻击探索和退出重复探索。

## 2026-08-29：AIGV 2.0 Multi-Oracle 独立裁决

- 新增 Oracle Registry，登记 Reference Model/Scoreboard、Invariant/Assertion、Protocol Checker、Formal Property、Metamorphic Relation 与 End-to-End Checker 的实现、独立性等级、独立性域和共享 assumptions。
- 新增 `oracle-evaluation.json`；从绑定当前 RTL Hash 的 scenario_hits、oracle_verdicts 和 Formal 结果采集结构化 verdict，过期或来源未知的结果不进入有效裁决。
- 关键 Scenario 至少需要两个 Level >= 2 且 independenceDomain 不同的 PASS；单个 `passed=true` 仅代表 Scoreboard，不能冒充 Assertion 或第二份独立证据。
- 任意有效 Oracle PASS/FAIL 并存均标记 `CONFLICT` 并阻断签核，不设置 Invariant、Reference 或 End-to-End 的固定优先级赢家。
- Closure Engine、验证态势指标和工作区行动引导接入 Multi-Oracle：优先仲裁冲突，其次补齐独立判定域；VERIF Prompt 要求生成 `oracle_verdicts.json` 并审查 provenance。

## 2026-08-29：AIGV 2.0 Verification Space 与 Explorer

- 每个 Scenario 新增 Feature、Boundary、Interaction、Temporal、State 五维坐标，生成版本化 `verification-space-snapshot.json`；Snapshot ID 同时绑定规格、RTL 与有限候选集合，输入不变时保持稳定。
- 新增 first-class Negative Space，明确记录规格未定义、已证明不可达和批准豁免等“不验证”原因；未批准的 Negative Space 不得用于签核关闭。
- 新增 `exploration-round.json`，固化本轮候选数量、选中场景、预计成本、关键未闭环数量和选择依据，为后续 Novelty Saturation 提供可审计轮次数据。
- Explorer 对 P0 Scenario 设置强制任务和最低优先级，预算选择遇到昂贵普通任务时继续寻找可执行项，避免提前终止和关键场景饥饿。
- 验证态势新增 Verification Space 条带，展示空间版本、候选/Negative 数量、五维规模和当前探索轮次。

## 2026-08-29：AIGV 2.0 状态内核与机器签核评估

- Scenario 在兼容旧 `status` 的同时新增执行、到达、裁决、证据、时效性和闭环六轴状态；所有新证据绑定 RTL Hash，RTL 变化后无法证明无关的旧证据进入 `IMPACT_UNKNOWN` 并阻断签核。
- Formal 结果新增 `PROVEN`、`COUNTEREXAMPLE`、`COVERED`、`BOUND_EXHAUSTED`、`INCONCLUSIVE`、`TOOL_ERROR` 等结论分级；BMC 深度通过和 cover 未到达不再被解释为证明，补强 Formal 工具错误不再覆盖已闭环仿真证据。
- 新增机器可读 `closure-assessment.json`，统一计算 P0/P1 Scenario 闭环、回归、Coverage Hole、强制 Formal、工具错误、变更影响和残余风险，输出 `NOT_READY`、`CONDITIONALLY_READY` 或 `READY_FOR_HUMAN_SIGNOFF`。
- 验证态势顶部展示机器签核阻断和 AIGV 2.0 下一步，工作区行动引导优先处理 RTL 变更影响未知；专项测试覆盖旧数据兼容、证据闭环、Formal C6 隔离及 RTL 变更失效。

## 2026-08-28：Yosys Formal 兼容层与签核义务分级

- `run_formal_verification` 在启动求解器前拒绝 Yosys 不支持的 `default clocking`、`property/endproperty`、`assert property`、`disable iff`、`|->`、`|=>` 和 `##`，输出 C6 兼容性问题及过程式改写建议。
- Formal 任务新增 `required`/`supplemental` 义务等级：任何 FAIL 均阻断；强制 Formal 的 ERROR/UNKNOWN 阻断；补强 Formal 的工具 ERROR 形成警告和修复动作，但不单独推翻已有充分仿真证据。
- Formal Skill 与阶段 Prompt 要求使用 clocked `always`、监控计数器、`$past` 和 immediate assert/assume/cover；Liveness 环境 assumption 必须有规格依据。
- Formal Smoke Test 新增高级 SVA 前置拒绝测试，确保同类 C6 不再经过三次盲试才发现。

## 2026-08-28：长会话白屏防护与验证耗时优化

- Agent 历史改为直接读取持久化 Session JSONL，避免长任务期间 `get_messages` RPC 超时；UI 仅保留最近 320 条展示记录，完整历史仍在 Session 文件中。
- 单条流式正文/思考过程设置 120,000 字符显示窗口，Renderer 连续 20 秒无响应时自动重新加载界面，项目和 Agent 任务不受影响。
- `select_next_verification_batch` 默认复用现有执行计划且每批最多 3 个 Scenario，只有规格、RTL 或回归证据变化时才全量重建 AIGV。
- 局部修复只执行定向和受影响回归；Verilator 全量 Coverage、广泛 Formal、全量回归调整到基础稳定、批次稳定和签核前里程碑执行。

## 2026-08-28：AIGV 方法学白皮书 v1.1

- 方法学论文新增“验证规划、环境搭建、基础回归、风险闭环”外层四步交付状态机，明确每一步的完成判据与停止边界。
- 新增 L0-L5 渐进式失败诊断、失败指纹与 `DIAGNOSTIC_ENHANCEMENT` 控制模式，说明无项目基线时不采用统一硬超时的工程理由。
- 补充诊断信息增益、重复修复次数、分步交付时间等评价指标，并增加诊断精度边界和自适应停止策略研究议题。

## 2026-08-28：VERIF 四步执行与 Prompt 边界

- 工作区将原“规划与搭建”拆分为“验证规划、环境搭建、基础回归、风险闭环”四个独立操作，每一步都有明确停止边界。
- 验证规划只生成权威计划与 AIGV 机器可读模型；环境搭建只做到 Testbench、Checker 和最小 smoke 可运行；基础回归只建立结构化回归基线；风险闭环才执行高风险 Scenario、Coverage、Formal 和签核。
- VERIF 阶段全局 Prompt 遵从当前操作的显式范围，已有规划和环境增量复用，避免子任务隐式扩展为完整验证闭环。

## 2026-08-28：绿色版打包脚本 Windows PowerShell 兼容修复

- 将 `Build-Green.ps1` 固定为带 BOM 的 UTF-8，避免 Windows PowerShell 5.1 按本地 ANSI 代码页误读中文并破坏字符串边界。
- 读取 `package.json` 时显式使用 UTF-8，避免中文产品描述经 ANSI 误解码后导致 `ConvertFrom-Json` 失败。
- 已分别通过 PowerShell 7 与 Windows PowerShell 5.1 语法解析检查。

## 2026-08-27：MoonGlass v0.7.0 绿色版基线

- 产品版本统一升级到 `0.7.0`，同步应用包版本与软件信息页。
- 基于当前 AIGV、验证态势、一键托管 Agent 完成屏障等最新功能制作 Windows x64 绿色版。
- 绿色版保留 MIC_NPU Demo，不包含 API Key、模型账号配置或 Agent 会话；打包期间不关闭当前运行中的 MoonGlass。

## 2026-08-27：验证态势稳定读取与 AIGV 文档体系

- AIGV 新增原子发布的紧凑 `verification-posture.json`，验证态势页优先读取该快照并兼容旧版全量状态，避免大文件并发更新造成 JSON 中间态错误。
- 修复验证态势误用 256 KiB 文件预览接口的问题：新增 16 MiB 上限的结构化 JSON IPC，由主进程完整解析后返回，文件查看器仍保持截断保护。
- `docs/04_verification/` 从验证/测试/覆盖率三份基线计划扩展为 AIGV 策略、Intent 矩阵、风险场景、Formal、Coverage Closure、Signoff 六份方法与闭环文档。
- VERIF 阶段 Prompt、工作区快捷操作、`/verify` 模板与 verification-planning Skill 统一要求使用机器可读产物和原始证据维护 AIGV 文档。

## 2026-08-27：验证态势解释层与 VERIF 行动引导

- 新增共享验证行动模型，将失败回归、Formal、Spec Gap、C1-C6 Coverage Hole 和 Intent 状态归并为 P0/P1/P2 推荐动作。
- 验证态势顶部新增当前结论、七步交付路径、Top 5 风险解释和推荐下一步；风险明确区分已确认问题、高风险待验证、验证基础设施缺口、规格缺口与已接受风险。
- Top 风险展示当前缺口、可能影响和推荐操作，并支持一键将具体任务交给主 Agent 执行。
- 工作区 VERIF 阶段新增紧凑状态条，显示规划、环境、基础回归、风险场景、覆盖闭环、Formal 和签核状态，以及动态主操作。
- AIGV 紧凑快照补充 Risk → Intent 的 `sourceIds` 关联；新增验证行动推导 Smoke Test。

## 2026-08-27：v0.7.0 绿色版主进程启动修复

- 修复 `@moonglass/verification-intelligence-engine` 被 electron-vite 错误外置，导致绿色版从 `app.asar/node_modules` 加载 TypeScript 并触发 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`。
- 所有 `@moonglass/*` workspace 包统一随主进程 bundle，绿色版构建发现残留外部 require 时立即失败。
- 新增打包 EXE 真实启动冒烟：使用隔离用户目录启动完整主进程与服务，收到成功标记并正常退出后才允许生成 ZIP。

## 2026-08-27：会话文件链接白屏防护

- 会话中的 Windows 绝对文件引用先规范化为项目相对路径，避免盘符、冒号和行号直接进入文件 tab 与 Monaco 模型标识。
- Monaco 改用编码后的 `inmemory://moonglass/` 模型 URI；同一文件的并发打开请求去重，状态更新再次检查重复 tab。
- 文件读取和打开异常在工作区内提示，不再形成未处理 Promise rejection。
- 新增全局 React Error Boundary、window error/unhandled rejection 日志，以及主进程 renderer console、unresponsive、render-process-gone 诊断。
- renderer 进程意外退出时自动恢复一次；组件异常时显示可重新加载的中文错误页，避免永久白屏。

## 2026-08-26：AIGV 完备化与开源 Formal 闭环

- 新增 SymbiYosys + Yosys-SMTBMC + Boolector/Bitwuzla/Z3 开源 Formal 执行器，支持 `bmc`、`prove`、`cover`，统一归档 `.sby`、日志、`formal-result.json` 和 VCD/YW 反例/见证。
- 修复 OSS CAD Suite Windows 包中 `yosys-smtbmc.exe.exe` 无法被 SBY 调用的问题：MoonGlass 在任务目录外创建隔离 shim，不修改用户安装目录。
- Formal 语义严格区分：BMC PASS 仅记 `PARTIAL`，prove PASS 才记 `FORMAL_PROVED`，cover PASS 记可达；FAIL/ERROR 进入质量阻断。
- 新增 `run_formal_verification` Pi 工具和 `formal-verification` Skill，强制审查 assumptions、绑定 `SCN-*`，不支持的高级 SVA 必须改写或明确报告。
- Slang 前端改为隔离工具链环境并真正消费 elaborated AST，从过程块、条件、case、赋值和符号引用建立 CFG/DFG；AST 超过 128MB 时安全降级。
- 新增静态 COI、多源共享状态与 N-way Interaction 分析；共享下游对象形成 `SHARES_STATE` 图边和高价值 Formal Candidate，禁止任意 Feature 笛卡尔积。
- 自动识别 AXI/APB/AHB/ready-valid/FIFO 协议结构，新增机器可读协议规则库，用于仿真 assertion、Formal property 和验证计划约束。
- `scenario_hits.json` 扩展 `reachCount`、`assertionPassed`、`coverageDelta`，调度器按 Scenario 级增量降低已有效覆盖任务预算。
- 验证面板新增 Formal 证据视图，并显示 FSM、CFG、依赖、COI、协议数量；兼容旧版 Verification State 文件。
- 新增真实 SymbiYosys/Boolector smoke test，并将 Formal、结构智能、Pi 扩展纳入核心测试链。

## 2026-08-26：Verification Intelligence 第二阶段完整落地

- 新增 Slang AST 可选前端与设置页工具链探测：检测到 Slang 时执行完整 SystemVerilog elaboration 并保存带源位置 AST；未安装或分析失败时自动使用 MoonGlass 结构分析器，诊断与限制明确落盘。
- 结构模型升级为 v2，提取 FSM/状态、寄存器写入者与条件优先级、时钟复位域、数据与时序依赖；复杂宏/generate/UVM 不伪装成已精确解析。
- 新增 Feature Interaction Graph，统一表示 Requirement、Feature、RTL Object、Clock Domain、Scenario 及 CONTROLS/WRITES/DEPENDS_ON/PRECEDES/COVERS 等关系，并支持从 UI 双击回到源证据。
- 新增受约束 Scenario Reasoner：`register_verification_hypotheses` 强制引用现有 Risk、RTL Object、Interaction Edge，逐条标记 SPEC_FACT/RTL_FACT/INFERENCE/UNKNOWN；无依据组合直接拒绝。
- 新增可执行 `scenario-execution-plan.json` 与 `select_next_verification_batch`，为 Cocotb 复用/生成 sequence、约束、时序条件、checker、迭代次数和预算。
- 覆盖率反馈调度器根据 Scenario 状态、回归覆盖率和成本持续重排剩余任务；`scenario_hits.json` 回灌后自动移出已闭环项。
- 验证面板增加“风险场景 / 交互图 / 执行队列”视图，显示实际分析器、图边、队列预算并提供源文件跳转。
- 扩充 Verification Intelligence smoke test，覆盖结构抽取、交互图、执行计划、假设接受/拒绝与证据闭环。

## 2026-08-26：Verification Intelligence 风险驱动验证闭环

- 新增 Requirement Model、Structural Model、Risk Register、Scenario Registry 与 Verification State 五类机器可读产物。
- 建立 R01-R20 风险分类；第一版以确定性结构规则提取风险事实，并明确标注 Pattern MVP 局限，不把风险标记冒充 RTL Bug。
- 新增 `build_verification_intelligence` 和 `review_verification_scenarios` Pi 工具，按 Risk、Interaction、Coverage Gap、Criticality、Confidence 与 Cost 排序 Scenario。
- Cocotb/回归通过 `scenario_hits.json` 回灌 Scenario reach/pass 和原始证据；引用证据不存在或为空时只能标记为 `PARTIAL`。
- 主 Agent VERIF Prompt、`/verify` 模板和 verification-planning Skill 接入智能规划，要求稳定 `SCN-*` ID、禁止无结构依据的 Feature 笛卡尔积。
- VERIF → QA 增加关键 Scenario 闭环门禁，现有覆盖率与独立原始证据审查继续保留。
- 工作区底部“验证”面板新增 Scenario 总数、关键未闭环计数、优先级列表和一键生成智能验证模型入口。
- 新增 Verification Intelligence Smoke Test；核心测试、集成测试、Pi 扩展加载、类型检查和生产构建通过。

## 2026-08-26：在线说明书补充开发环境与 EDA 工具链配置

- 新增按工作目标划分的最低工具组合，覆盖文档、RTL、功能验证、覆盖率、综合、波形与 STA/物理实现。
- 补充 MoonGlass 设置页的一键安装 OSS CAD Suite、安装 Cocotb、重新检测和重启刷新步骤。
- 增加 PowerShell 自检命令、Python 多版本、PATH、GTKWave 与工艺库相关故障排查说明。

## 2026-08-24：MoonGlass 中文配音演示短视频

- 基于 MoonGlass 真实界面制作竖屏产品短视频，展示六阶段流程、主 Agent 端到端交付、RTL Design Browser 与证据驱动验证。
- 配套中文旁白、关键卖点字幕与品牌收束画面，输出可直接分享的 H.264/AAC MP4 文件。
- 生成脚本与旁白文案保存在 `artifacts/promo-video-20260824/`，便于后续替换截图和迭代版本。

## v0.5.2 发布摘要

### 会话 Token 与上下文用量

- 会话顶部按当前主会话或平行会话独立显示上下文占用、累计 Token 与可用的费用信息。
- 悬停可查看输入、输出、缓存读写、消息和工具调用统计；上下文达到 70%/90% 时分级提醒。
- 统计来自 Pi `get_session_stats`，按 Provider 实际能力自适应，缺失字段不估造。

- 工具链：文档校验增加阶段感知、UTF-8 安全输出、双向追溯与 ID/状态检查，新项目统一生成 `.gitattributes`。
- 文件体验：会话中的 Windows 绝对路径完整可点击，支持中文与空格目录以及行列定位。
- 查看器：文本和 RTL 文件支持 `Ctrl+F` 原生查找，Markdown 预览可自动切换到源码查找。
- 版本：应用、关于页面、README 和在线使用说明统一更新到 `0.5.2`。

## 2026-08-21：微架构与时钟复位文档改为按复杂度选配

- `docs/03_design/microarchitecture.md` 和 `docs/03_design/clock_reset.md` 不再是 ARCH → RTL 的强制门禁。
- 简单单模块设计、单时钟单复位且无 CDC/RDC 的设计可以省略独立文档，并在 `architecture.md` 保留必要说明和省略理由。
- 文件存在但内容不足时仅记录 Warning，不阻断推进；复杂流水线/控制、多时钟、多复位、CDC/RDC 等场景仍由 Agent 和 QA 要求补充。
- 同步更新一键托管 Prompt、文档 Skill、文档检查脚本和门禁回归测试。

## 2026-08-21：修复 IP 库 Pi 语义分析并发冲突

- IP 语义分析在每批 Prompt 后同时等待命令回执和 `agent_settled`，不再把“已接收”误判为“分析完成”；后续批次使用 `followUp` 排队保护。
- 同一个 IP 库的并发增强请求在主进程合并为同一任务，页面分析期间禁用重复点击。
- 软件重启时将遗留的“分析中”状态恢复为“上次中断，可重新运行”，避免永久卡住。

## 2026-08-21：托管前段门禁连续执行与输入历史

- 一键托管在需求-规格定义和架构设计阶段经过三轮自动修复后仍有门禁失败时，不再中断任务；自动带遗留项推进，并在日志、阶段记录和托管报告中明确保留风险。
- RTL、验证、QA 和综合阶段继续执行严格门禁阻断，人工推进逻辑不变。
- 会话输入框支持 `↑/↓` 回顾当前会话的历史输入；退出历史末端后恢复尚未发送的草稿，多行输入中保留正常光标移动。

## 2026-08-20：修复需求-规格追溯矩阵门禁误报

- 门禁只解析表头同时包含“需求 ID”和“规格 ID”的正式追溯表，不再把版本历史、P0/P1/P2 优先级和假设/TBD 表当作矩阵数据。
- 需求与规格分别按对应列检查，避免辅助文字既造成误报、又掩盖真实缺失。
- 支持 `REQ-PERF-001~009`、`REQ-PERF-001～009`、`REQ-PERF-001..009` 和“至”形式的紧凑范围映射。
- 新增混合多表场景回归测试。

## 2026-08-20：新增傻瓜式 HTML 使用说明

- 新增 `docs/MoonGlass快速使用手册.html`，覆盖启动、模型配置、新建/导入项目、六阶段开发、Agent 会话、一键托管、变更、IP 库、波形和常见问题。
- HTML 可离线打开、浏览器阅读和打印为 PDF，使用仓库内现有截图，不依赖外部脚本或样式。
- 生成可直接分享的单文件版 `D:\Projects\ASIC_Flow\MoonGlass-使用说明书-v0.5.0.html`，将三张界面截图以 Data URI 内嵌，不依赖外部图片目录。
- 为在线说明书增加 Open Graph、Twitter Card、摘要和 canonical 元数据，并以 GitHub Pages 形式发布，分享链接可展示标题、说明和界面封面。

## v0.5.0 发布摘要

- 版本：软件、构建包、关于页面和公开文档统一升级到 `0.5.0`。
- 重点：一键托管、受控变更、已有项目阶段恢复、Monaco 文本查看器、深色模式完善、SRAM 视图生成与 IP 库增强。
- 发布边界：GitHub 公开 UI、流程框架、共享类型与 IPC 契约；完整 Agent/EDA 执行能力仅随可运行绿色版提供。

## 2026-08-20

### 已有项目阶段恢复

- 选择已有工程目录时，MoonGlass 在补充规范目录前扫描真实文件证据，不再统一初始化为需求-规格阶段。
- 支持非标准文件树，按需求/规格与追溯、架构、RTL、验证、QA、综合六类证据给出建议阶段、置信度和命中路径。
- 新建项目界面展示扫描文件数、阶段证据分、待适配提醒，并允许用户在导入前覆盖建议阶段。
- 导入后将建议阶段之前标记为外部流程已完成，建议阶段设为活动，后续阶段保持待开始；不删除或覆盖已有工程文件。
- 自动生成 `docs/01_project/import_assessment.md`，记录自动建议、用户确认、兼容性说明、证据路径和追踪矩阵适配缺口。
- 新增非标准 RTL、验证、综合目录识别及噪声目录排除测试。
- 验证：类型检查、五组核心测试和生产构建通过；Electron 实际导入非标准工程后正确恢复到 VERIF，REQ_SPEC/ARCH/RTL 为已完成、QA/SYNTH 为待开始，并成功生成证据报告。

## 2026-08-17

### 一键托管与受控变更

- 工作区新增“一键托管”，可从当前阶段选择托管终点，自动执行阶段任务、处理推荐决策、运行门禁并逐阶段推进。
- 托管门禁失败后最多执行两轮 Agent 修复；仍有 Error 级阻断项时立即停止，禁止静默强制推进。
- 托管支持随时停止；完成、失败或停止后均在 `docs/07_release/` 生成完整报告，记录阶段结果、门禁证据、自动决策策略和遗留风险。
- 工作区新增“发起变更”，支持需求变更、规格变更和第三方/测试缺陷；自动生成带编号变更单，并进入用户选择的最早影响阶段。
- 变更处理保留后续已有成果；实际文件修改后沿用黄色感叹号机制提示已完成的后续阶段响应，再可使用一键托管完成架构、RTL、验证、QA 和综合闭环。
- 新增项目范围内的安全文本写入 IPC，仅允许在项目工作区内生成托管报告和变更单，拒绝目录穿越。
- 验证：类型检查、核心测试、生产构建通过；Electron 1080×700 实窗确认两个入口和弹窗无横向溢出，临时项目验证报告写入成功且目录穿越被拒绝。

## 2026-08-16

### 深色模式工作区修复

- 修复工程控制台标签栏、空状态、操作按钮、状态栏和对话消息区被后置浅色样式覆盖的问题。
- 新增渲染进程到 Electron 主进程的颜色模式同步，Windows 原生标题栏现在跟随浅色、深色或系统主题。

### 项目文本文件查看器

- 双击项目文本文件后改用 Monaco 只读代码查看器，显示稳定行号并高亮当前行。
- 支持 `Ctrl+F` 搜索、代码折叠、横向滚动、链接识别和右键菜单，查看器自动跟随 MoonGlass 明暗主题。
- 增加文件类型自动识别，并为 Verilog/SystemVerilog 提供基础语法高亮；未知类型以纯文本安全显示。
- 保留复制、外部打开和 256 KB 大文件截断提示，启用大文件渲染优化。
- 第二阶段：支持 Agent 回复、工具输出及问题日志中的 `path:line:column` 文件引用点击定位。
- 第二阶段：增加自动换行、10-24 px 字号调节、手动重新加载，并持久保存查看偏好。
- 第二阶段：Markdown 支持源码与安全预览切换，预览内容经过 HTML 清理。
- 第二阶段：当前打开文件每 2 秒轻量同步，Agent 或外部工具修改后自动更新标签内容。
- 验证：类型检查、核心测试、生产构建及 Electron 真实窗口冒烟通过；已确认 Markdown 预览、Monaco 行号和查看工具栏正常渲染。

## 2026-08-15

### SRAM 宏仿真视图生成器

- 现状：内置“存储相关”IP 库此前只有占位 README，无法为真实 Memory Compiler 宏生成实体仿真模型。
- 新增：支持按宏名称、wrapper、depth 和 width 生成 1RW 同步 SRAM 行为模型、Yosys blackbox、固定尺寸 wrapper 与 manifest。
- 示例：覆盖 `RFSP288X80M4LL` / `SRAMS288X80_CPU`，正确处理 288×80、9 位地址、低有效 `CEN/WEN` 和非法地址。
- Agent：新增 `generate_sram_macro_views` 工具，输出限定在项目工作区内。
- 流程：Agent 在已知 wrapper 尺寸与真实宏名、但缺少厂商模型时使用生成器；取得官方模型后必须替换并重新回归。
- 边界：不生成虚假 Liberty/LEF/GDS；缺少真实工艺视图时不得用于 SRAM 时序、面积或功耗签核。

### v0.4.3 发布准备

- 版本：软件、构建包与关于页面统一更新为 `0.4.3`。
- 发布边界：完整绿色版包含本轮功能；GitHub 源码继续只公开 UI、流程框架和公共契约，不上传用户数据、API Key、Agent/EDA 后台实现或 MIC_NPU 源工程。

## 2026-08-14

### IP 库多 IP 智能发现

- 扫描：用户只需提供一个目录，MoonGlass 自动递归识别 metadata、`rtl/src/hdl` 源码目录、独立 HDL IP 和 `VIP/BFM/UVM/testbench` 验证组件。
- 索引：`index.json` 升级为 v2，补充组件用途、协议、接口角色和识别置信度；同时生成 `IP_LIBRARY_GUIDE.md` 供用户和 Agent 阅读。
- 使用：架构、RTL 和验证 Agent 按阶段优先检索适合的 IP/VIP，采用前必须核对兼容性并保持源库只读，不符合要求时允许不用并记录原因。
- Agent 工具：新增 \`ip_search\` 和 \`ip_inspect\`，大规模 IP 库先检索少量候选再读取详情，避免整份索引占满会话上下文。
- Pi 语义增强：用户库新增独立分析按钮，使用已启用模型分批补充中文摘要、类型、协议、接口角色、许可证状态和置信度；失败不会破坏确定性索引。
- 状态：重新建立确定性索引后自动重置语义分析状态，避免展示已经过期的 Pi 结论。
- 稳定性：语义分析改为读取 Pi 最终完整消息；JSON 截断时自动二分批次并对单项重试，解决流式增量不完整导致的 `Unexpected end of JSON input`。
- 界面：IP 卡片显示 RTL/验证组件类型、协议、接口角色和识别置信度，导入区明确说明自动发现与只读原则。
- 验证：多 IP、AXI 协议、验证组件、v2 索引及指南生成冒烟测试通过；类型检查、核心测试和生产构建通过。

## 2026-08-13

### 会话多确认项批量提交

- 问题：同一轮会话存在多个确认项时，任意一项确认都会立即发送给 Agent，导致提前进入下一轮。
- 修改：每个确认卡片改为“完成本项”，只保存本地选择；全部待确认项完成后，通过“提交全部确认并继续”一次性发送。
- 兼容：批量回复支持持久化解析，重启或切换会话后可恢复多个确认结果；原有单项确认格式继续兼容。
- 验证：`pnpm typecheck`、核心测试和 `pnpm build` 全部通过，新增“支持一轮提交多个决策回复”测试。

### 浅色、深色与跟随系统主题

- 修改：外观设置新增“浅色 / 深色 / 跟随系统”，与四种强调色独立选择并持久化。
- 跟随系统：监听系统颜色方案变化，Windows 切换明暗模式后界面实时同步。
- 适配：统一处理导航、工作区、会话、表单、弹窗、状态提示和代码区域的深色对比度；深色模式禁用浅色纸张纹理。
- 验证：`pnpm typecheck`、核心测试和 `pnpm build` 全部通过，并通过 Electron 截图检查设置页和项目页。

### Pi Coding Agent 内核升级

- 版本：`@earendil-works/pi-coding-agent` 从 `0.82.1` 升级并精确锁定到 `0.84.1`。
- 兼容：适配 Pi 0.84 RPC `message_update` 仅发送增量事件的协议变化，错误信息直接从事件增量读取，同时保留旧事件格式回退。
- 验证：类型检查、核心测试、Provider/Skills/工具扩展、RPC 就绪、模型注册与切换均通过；打包后 ASAR 可直接启动并报告 `0.84.1`，`win-unpacked` 共 308 个文件。
- 已知环境项：完整集成测试的 Verilator 仿真用例因本机缺少 `g++` 失败，与 Pi 升级链路无关；其余已执行集成测试通过。

### 项目目录迁移

- 功能：项目卡片新增“迁移项目目录”，用户可选择新的绝对路径并迁移整个项目工作区。
- 安全：目标目录必须为空且不能与其他项目冲突；复制后校验文件数量和总字节数，成功后才切换数据库路径。
- 保留：迁移成功后保留原目录，避免不可逆误删；迁移前释放该项目的主会话和平行 Agent 进程，重新进入项目后从新目录恢复。
- 验证：`pnpm typecheck`、核心测试和 `pnpm build` 全部通过。
## 2026-08-21

### 文件查看器支持 Ctrl+F 查找

- 文件标签激活时，`Ctrl+F` 打开 Monaco 原生查找框，支持回车下一个、`Shift+Enter` 上一个和 `Esc` 关闭。
- Markdown 预览状态下触发查找会自动切换到源码视图；文件工具栏新增查找按钮。

### 会话工具输出的 Windows 绝对路径可点击

- 修复 `D:/...` 中盘符 `D:` 未被纳入文件链接，导致点击后按错误相对路径打开的问题。
- 文件引用统一支持正/反斜杠、中文或空格目录、项目相对路径以及可选行号/列号。
- 会话工具输出、Agent 回复和问题列表共用同一套路径识别规则。

### 文档工具链与追溯门禁加固

- `check_doc_repo.py` 增加阶段感知、双向 REQ/SPEC 覆盖、ID 范围/斜杠展开、状态值校验、UTF-8 安全 JSON、`--output` 和忽略规则。
- 后续阶段文档不再提前报错，`microarchitecture.md` 与 `clock_reset.md` 保持按复杂度选用，模板和 `.gitkeep` 不再误报。
- 新项目自动生成 `.gitattributes`，统一 HDL、Markdown、Python、Tcl、SDC 和 JSON/YAML 为 LF，二进制资料不参与换行转换。
- 规范明确 ID 定义与引用边界、验证 ID 分段和 Windows 中文文档必须使用 Python 校验器。
# 2026-08-23 - 修正 Pi 模型上下文窗口

- 移除所有模型统一按 128K 计算的错误逻辑，按模型匹配上下文窗口与最大输出。
- 会话统计区分官方核实、服务商估计和未知模型；未知模型不再显示虚假占用率。
- Pi 注册与 MoonGlass 状态栏使用同一套模型窗口规则，避免显示和上下文压缩行为不一致。
# 2026-08-23 - 项目信息编辑与总体报告增强

- 项目卡片增加编辑入口，可修改既有项目的名称和多行描述，不改变目录与流程状态。
- 总体报告扩展阶段门禁、交付物、验证运行、覆盖率、综合结果、遗留风险和产物索引。

# 2026-08-23 - 主会话验证闭环与覆盖率签核

- 主会话验证改为双通道：Cocotb + Icarus 负责功能回归和功能覆盖率，Verilator C++ 回归负责 RTL 行、条件/表达式、翻转和 FSM 覆盖率；Linux 可直接使用 Cocotb + Verilator。
- Verilator 自动插入覆盖率落盘钩子，生成 `coverage.dat`、`coverage.json` 和中文覆盖率报告；修复 Windows 下编译器、Make 与运行时覆盖率文件的调用链。
- 同一模块的功能回归和 RTL 覆盖率结果合并到同一 `result.json`，Icarus 与 Verilator 日志独立归档，执行顺序不再影响最终签核状态。
- 新增 `review_verification_evidence`，直接审查测试源码、JUnit、日志、结构化结果和覆盖率；`VERIF -> QA` 门禁要求证据审查通过，不接受 Agent 自述作为验证完成依据。
- 验证目标统一为行覆盖率不低于 90%、条件/表达式覆盖率不低于 85%、功能覆盖率不低于 80%，并写入阶段 Agent 的端到端执行约束。

# 2026-08-23 - 会话模型恢复显示与文件查找修复

- 会话重启后，即使模型 Provider 列表尚未加载或当前配置暂时无法匹配，模型下拉框仍显示已恢复的真实模型，不再错误显示“选择模型”。
- 代码查看器新增轻量查找条，修复 `Ctrl+F` 和工具栏查找按钮无响应；支持匹配计数、前后跳转，Markdown 预览会先切换到源码视图再打开查找框。

# 2026-08-23 - MoonGlass v0.6.0 发布准备

- 产品版本由 `0.5.2` 升级到 `0.6.0`，同步软件信息页、HTML 使用说明和绿色版发布文案。
- 本次版本以主会话验证闭环、RTL/功能覆盖率、独立证据 Review 和验证门禁增强为核心发布内容。

# 2026-08-24 - ASIC Agent 学术讨论文档

- 新增中文综述型 HTML《从代码生成到工程签核：面向 ASIC IP 开发的证据驱动型人机协同 Agent 工作流》。
- 系统整理流程状态、Agent 控制、验证闭环、追溯门禁、IP/SRAM 复用、工具链、评价指标、局限性和开放研究议程。
- 文档采用单文件响应式排版，支持浏览器分享与打印，并明确区分工程观察、系统方法和待验证研究假设。

# 2026-08-27 - AIGV 开源工具链内置

- Windows 发布包内置裁剪后的 Slang、Yosys、SymbiYosys、Yosys-SMTBMC、Boolector 与 Bitwuzla，无需用户逐项下载安装。
- AIGV 运行时以单个压缩包随软件交付，首次启动自动解压到 MoonGlass 数据目录，避免绿色版出现大量零散文件。
- 设置页显示工具来自“MoonGlass 内置”“MoonGlass 管理安装”或“系统环境”，并能识别内置组件异常。
- Windows 工具执行层支持 `.cmd/.bat` 包装器，保证内置 SymbiYosys 可由 MoonGlass 直接启动。

# 2026-08-27 - AIGV Verification Intent 与分级自动修复

- Verification Intelligence 升级为 v3，新增 Spec Gap、Verification Intent、时间交互、边界条件和 Coverage Hole 机器可读产物。
- 时间交互覆盖 BEFORE、SAME_CYCLE、AFTER 与可配置周期窗口；计数器、FIFO 和 outstanding 自动生成 0/1/MAX 等边界点。
- Coverage Hole 区分不可达、约束阻断、激励缺失、观察缺失、规格未定义和工具/插桩问题，场景证据闭环后自动清除。
- 验证控制台新增“验证意图”和“覆盖缺口”视图，可直接查看方法建议、边界数量、缺口分类与处置方向。
- RTL 自动修复采用 L1-L4 影响分级：L1/L2 可无人值守完成修改与回归，L3 架构影响和 L4 规格影响暂停托管并等待用户裁决。
- 自动修复禁止删除失败用例、削弱 Checker/Assertion/覆盖率目标或无规格依据修改测试预期。

# 2026-08-27 - 一键托管容错与带风险完成

- Agent 单轮执行和自动决策回传失败时最多自动重试三次，短暂模型过载或工具异常不再直接结束整段托管。
- 每个阶段门禁最多执行三轮差异化恢复；仍失败时保留原始失败证据、标记阶段未签核并继续后续流程。
- 托管状态区分“完整通过”“带遗留风险完成”“等待 L3/L4 决策”“用户停止”和“执行失败”，不再把强制推进伪装成成功签核。
- 阶段状态使用绿色表示通过、黄色表示带风险完成、红色表示真正终止；完整报告记录门禁失败和工具异常。
- 只有用户主动停止、模型服务不可用、项目不可访问或 L3/L4 高影响决策等不可自动裁决事件才暂停托管。

# 2026-08-27 - AIGV 验证态势全屏视图

- 新增项目级“验证态势”全屏页面，工作区顶部可直接进入，并保留返回项目工作区入口。
- 顶部集中展示总体签核结论、Verification Intent 闭环率、关键未闭环、Spec Gap、Coverage Hole、Formal 与回归状态。
- 新增结构复杂度 × 交互强度风险热区、签核阻断列表、Verification Intent 明细、Spec Gap 与 Coverage Hole 处置视图。
- 总体签核只接受结构化 AIGV、回归和 Formal 证据；没有 Verification Intent 的旧模型显示“模型需要更新”，不会误报为零风险。
- 页面兼容旧版 verification-state 数据，缺少 v3 字段时仍可打开并提示重新生成 AIGV 态势。

# 2026-08-27 - 验证态势并发读取修复

- AIGV 全部机器可读 JSON 改为同目录临时文件写入后原子替换，避免页面读到 Agent 尚未写完的半截状态文件。
- 验证态势页对瞬时读取或解析失败自动进行四次退避重试，并在错误页提供“重新读取”按钮。
- “尚未生成”与“生成过程中暂时不可读”不再混为一类；状态文件完整后无需重新执行整个验证流程即可刷新查看。

# 2026-08-27 - VERIF 快捷操作接入完整 AIGV

- VERIF 阶段快捷入口调整为“规划与搭建”和“AIGV 验证闭环”，保留双入口但重新定义其职责。
- “规划与搭建”先生成 Verification Intelligence，再将 VI/SCN、Spec Gap、时间窗口、边界、Checker、Coverage 与环境实现绑定，不再只创建 Testbench 目录。
- “AIGV 验证闭环”按执行队列驱动 Cocotb/Icarus、Verilator 覆盖率、开源 Formal、Coverage Hole 分类和独立 Evidence Review，不能只跑传统功能回归。
- 软件信息页同步更新验证完备阶段说明，避免界面描述仍停留在 AIGV 合入前的方法。

# 2026-08-27 - 一键托管 Agent 完成屏障

- 修复 Pi `prompt` RPC 回执被误当作 Agent 任务完成的问题；主进程现在注册终止事件后再发命令，并等待真实 `agent_settled`。
- 模型返回明确 error 时任务立即失败并进入托管重试，不再继续检查门禁或推进阶段。
- Chat Store 新增 `sendAndWait`：一键托管、阶段快捷操作和门禁修复使用严格等待；普通手工聊天保留友好的错误展示行为。
- 阶段推进、门禁复查和自动决策只会在上一轮 Agent 完成后执行；单轮最长允许一小时，用户仍可随时中止。
- VERIF 和综合快捷操作日志改为在 Agent 真正完成后显示“任务已完成”，不再在仅发送消息后误报完成。
# 2026-08-28：AIGV 验证语义与文档主链增强

- Risk 增加具体风险陈述、结构识别依据、失效模式和外部可见影响，不再只显示 taxonomy 标签。
- Verification Intent 改为可证伪工程目标，明确前置状态、逐步激励、观察点、通过标准和证据要求。
- Coverage Hole 增加具体缺失场景、所需激励、观察/Checker 和关闭证据。
- 验证态势页面展开显示风险语义、Intent 执行方法和 Coverage Hole 闭环条件。
- `verification_plan/test_plan/coverage_plan` 与 AIGV 文档统一为 `REQ/SPEC → VI → SCN → TEST/COVER/PROPERTY → EVIDENCE → SIGNOFF` 主链，并自动生成 `aigv_execution_snapshot.md` 同步快照。

# 2026-08-28：统一绿色版打包入口

- 新增根目录 `Build-Green.ps1`，自动读取版本、执行检查、构建绿色版并输出 ZIP 路径、大小、文件数量与 SHA-256。
- 支持指定演示 userdata、跳过检查或复用构建产物；默认不会关闭当前运行中的 MoonGlass。

# 2026-08-28：AIGV 方法学白皮书

- 新增 `docs/MoonGlass-AIGV验证方法学.html`，系统说明 AIGV 的理论原则、数据模型、风险推导、Verification Intent、Scenario、Coverage Hole、Formal、证据闭环、文档治理、签核准则、工程示例与研究议程。
- 文档采用响应式、可打印的学术论文版式，可直接离线阅读和分享。

# 2026-08-28：渐进式验证诊断控制

- 仿真默认不再使用统一的最大周期或 wall-clock 硬限制；只有项目明确提供依据时才启用显式超时。
- Cocotb 运行前自动执行 Python 语法、重复测试函数和重复脚本注入标记检查，阻止损坏测试继续执行。
- 新增 `verification/results/diagnostic-control.json`，记录失败指纹、RTL/Testbench Hash、L0-L5 诊断等级、证据和尝试历史。
- 重复失败且诊断没有提升时切换为 `DIAGNOSTIC_ENHANCEMENT`，要求先增强 Checker、Assertion、事务追踪与波形，再继续修改 RTL。
- 验证态势展示当前诊断模式、case、诊断等级、尝试次数和下一步建议。
## 2026-08-30：Agent 文档编辑循环熔断与阶段收敛保护

- 基于 MoonGlass_NPU 的 82.5 分钟会话复盘，新增运行时 Agent Watchdog：需求/架构阶段 80 次工具调用进入收敛模式，160 次自动中止并保留现场；后续阶段使用更宽预算。
- 同一文件读取 12 次时强制改为一次性章节读取，同一文件精确编辑连续失败 3 次时强制切换章节级重写，6 次时自动中止，禁止固定行号破坏性修补。
- 连续 40 次工具调用没有成功写入或编辑时注入停滞诊断；门禁通过后禁止继续措辞润色、重复清单和主动 Git 初始化。
- REQ_SPEC 提示词与 doc-repository 技能明确使用“需求 ID”“规格 ID”表头，并采用“批量生成 → 一次检查 → 批量修复 → 立即复检”的收敛流程。
# 2026-08-30 - 阶段产物归档/清除与重做

- 阶段节点新增“归档重做”和“彻底清除”操作，执行前预览命中路径、文件数和体积。
- 默认归档到 `.moonglass/phase-archives/<PHASE>/<timestamp>/`，并写入操作清单；彻底清除要求二次确认。
- 重做仅处理阶段白名单产物，保留上游成果；已完成的后续阶段按既有规则显示黄色变更提醒。
- 重置阶段状态、门禁与评审信息，并以空白 Agent session 重新开始，同时保留原模型选择。
# 2026-09-14 - 新增 MoonGlass 新手使用介绍

- 新增 `docs/MoonGlass新手使用介绍.html`，以大纲、真实界面截图和流程图系统介绍首次配置、项目管理、六阶段工作流、Agent 协作、AIGV、验证态势、一键托管、变更重做与交付签核。
- 增加 30 分钟新手演练、常见问题、工具用途表与首次使用检查表，并提供桌面、移动端和打印排版。
