# MoonGlass 修改记录

本文件记录开发过程中的功能修改与验证结果。版本正式发布时，再将对应内容整理到 Release Notes。

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

- 新增 `docs/QUICK-START-ZH-CN.html`，覆盖启动、模型配置、新建/导入项目、六阶段开发、Agent 会话、一键托管、变更、IP 库、波形和常见问题。
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

- 新增 `docs/MOONGLASS-AIGV-METHODOLOGY-ZH-CN.html`，系统说明 AIGV 的理论原则、数据模型、风险推导、Verification Intent、Scenario、Coverage Hole、Formal、证据闭环、文档治理、签核准则、工程示例与研究议程。
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
