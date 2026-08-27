# MoonGlass 修改记录

本文件记录开发过程中的功能修改与验证结果。版本正式发布时，再将对应内容整理到 Release Notes。

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
