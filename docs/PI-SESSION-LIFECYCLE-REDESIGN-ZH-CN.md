# MoonGlass Agent 会话生命周期重构设计（Pi 任务粒度会话 + 验证并行门控）

> 状态：设计提案（未实施，2026-09-08 按团队评审修订，见 交流/交流_20260908.txt）
> 日期：2026-09-07
> 依据：pi-coding-agent 0.84.1 官方文档调研（README / docs/rpc.md / docs/extensions.md /
> docs/session-format.md / docs/compaction.md）与 MoonGlass 现状代码走查

## 1. 背景与问题

### 1.1 pi 的设计假设

pi-coding-agent 的核心设计假设（官方文档与作者博客证实）：

- **上下文是稀缺资源**。一个 pi 进程承载一段会话，会话越长质量越差；compaction
  有损（切割在 turn 边界，但早期细节必然丢失），完整历史只在 JSONL 里可回溯。
- **任务即会话粒度**。正确用法是一个独立任务（或一个小任务系列）一个会话/进程，
  任务结束会话即弃；上下文收集与实现分离，**用文件制品（artifact）在会话间传递
  上下文**，而不是在会话内派生子代理或无限追加对话。
- **可观测性优先**。会话是公开文档化的 JSONL 树（entry 带 `id`/`parentId`，
  SessionHeader 支持 `parentSession` 血缘），支持 `/tree`、`/fork`、`/clone`；
  RPC 模式（`--mode rpc`）暴露 `new_session`/`switch_session`/`fork`/`clone`/
  `get_tree`/`get_fork_messages`/`get_session_stats` 等完整能力。
- **刻意不做子代理与 MCP**。协调应放在宿主程序的确定性代码里；作者明确反对并行
  实现型子代理（"Spawning multiple sub-agents to implement various features in
  parallel is an anti-pattern"）。

### 1.2 MoonGlass 现状与差距

现状（代码事实）：

- 每项目 × 每阶段一个长驻会话（`PiSession`，`AgentService.ts:176-207`），阶段内
  所有对话堆进同一 JSONL（如 `session-phase-rtl.jsonl`），同阶段连续消息复用同一
  进程（`AgentService.ts:872-878`）。阶段切换不继承历史（park → settle → dispose，
  `AgentService.ts:806-820`）。
- **VERIF 批次会话**（`session-phase-verif--batch-<N>.jsonl`，
  `AgentService.ts:1385-1484`）已经是"每任务一个会话文件 + 手写头 + spawn 挂后台
  + settle 后归档"的完整实现——但它只是 VERIF 特例。
- artifact 约定已存在于提示词（REQ_SPEC 产出 `docs/02_requirements/*.md`、ARCH
  产出 `docs/03_design/*.md`、RTL 维护 `rtl/design.json`，
  `packages/prompts/src/templates.ts:72/100/127`），但仅是文字约束，靠 Agent 自觉
  读取，无程序化注入。
- VERIF 阶段发现 RTL bug 时**直接在 VERIF 会话内改 RTL**（`templates.ts:196`：
  固定 testcase/seed、单根因最小修改、STALLED 时暂停盲改先增强诊断）。工具层无
  任何写权限控制；修复上下文污染验证会话，且对 RTL 侧不可见。
- `rtlHash` 为全局哈希（`packages/verification-intelligence-engine/src/engine.ts:353-355`），
  证据新鲜度按场景比对 hit.rtlHash（`engine.ts:944-945`）：**任何 RTL 修改使全部
  旧证据失鲜**——这是并行验证时必须阻断派发的硬理由。
- 当前 `runVerifBatches` 实为**串行**（`runBatchToSettled` 等 settle 再派下一批），
  熔断条件（证据缺失/诊断无进展即停止后续批次）部分覆盖了串行下的协调问题。

差距一句话：**MoonGlass 把"阶段"当会话粒度，pi 的假设是"任务"才是会话粒度；
协调逻辑该在确定性层的地方目前依赖提示词自觉。**

## 2. 设计原则

1. **任务 = 会话粒度**。每任务一个独立会话文件，零历史继承；任务内 steer /
   follow-up 保持对话连续性。
2. **artifact 是任务间唯一的上下文通道**。跨任务、跨阶段上下文经工作区文件传递，
   新会话由程序化 artifact 索引自举，不依赖对话记忆。
3. **协调在确定性层**。谁该停、谁该跑、证据是否失效，由主进程/验证智能引擎判定；
   LLM 只负责发现、分析、修复。
4. **隔离优于复用**。每任务 spawn 独立 pi 进程（秒级开销换上下文干净），不用 RPC
   `new_session` 复用进程（避免会话生命周期与进程生命周期耦合）。
5. **最小侵入**。复用现有平行会话机制、SessionTabs UI、批次归档、模型回退链；
   不动 `PiRpcClient` 协议层与事件路由。

## 3. 方案 A：任务粒度会话（核心）

### 3.1 会话模型

- 新会话命名：`session-<phase主名>--task-<时间戳>-<slug>.jsonl`，如
  `session-phase-rtl--task-20260907-axi-timer.jsonl`。
  命名兼容现有 `sessionBelongsToPhase`（`AgentService.ts:142-145`，`phase-rtl--*`
  前缀即属该阶段），阶段过滤、purge、归档逻辑无需改动。
- 会话头增加 `parentSession` 字段（pi SessionHeader 原生支持），指向上一个任务
  会话（或触发源会话，见方案 B），形成血缘链。现在 `resetSession` 手写头
  （`AgentService.ts:931-962`）泛化时加入。
- 任务边界的控制分两种模式：
  - **手动模式**：用户显式控制，UI 提供"新任务"动作（现"新建平行会话"的语义
    升级），不做任何自动切会话。同任务内 steer/follow-up 完全保留。
  - **托管模式**（一键托管驱动的长跑）：在明确的**交付物边界**自动切任务会话——
    阶段门禁通过、VERIF 批次完成、或提示词约定的交付物落盘时，主进程自动收尾
    当前会话并开新任务会话。触发机制与 VERIF 批次派发同构（确定性判定，不经
    LLM），只是触发点从"批次"换成"交付物"。上下文压力最大的恰恰是托管长跑，
    手动模式下托管场景零收益，此路径必须覆盖。

### 3.2 新会话上下文自举（artifact 索引注入）

新增确定性函数（不依赖 LLM）：spawn 前扫描工作区，生成当前阶段相关 artifact 清单
（路径 + 存在性 + 大小/修改时间，后续可扩展一句话摘要），注入
`writeSystemPrompt`（`AgentService.ts:497-588`）生成的 `.pi/APPEND_SYSTEM.md`
或任务首条 prompt。各阶段的索引范围：

| 阶段 | 注入的 artifact |
| --- | --- |
| ARCH | `docs/02_requirements/`（需求、模块规格、追溯矩阵） |
| RTL | 上表 + `docs/03_design/`（架构、微架构、时钟复位） |
| VERIF | 上表 + `rtl/design.json`、`rtl/filelist.f`、`execution-summary.json` |
| QA / SYNTH | 上表 + `rtlqa/` 报告、验证签核结论 |

这把现在提示词里"必须基于上阶段产物"的文字约束变成上下文里的事实。

### 3.3 上下文占用驱动行为

- 占用观测沿用官方 RPC `get_session_stats`（已接，`AgentService.ts:1846`）。
- 超阈值时 UI 从"纯告警"升级为**引导动作**："建议收尾当前任务并开新任务会话"
  （一键：compact 当前会话 → 归档 → 以同主题开新会话）。阈值沿用现有滞回设计。

### 3.4 归档

推广 VERIF 批次归档模式（`archiveBatchSession`，`AgentService.ts:1671-1709`）：
每阶段保留最近 N 个任务会话在活动目录，更老的移入 `archive/`；JSONL 永不删除
（purge 除外），回看走已有的 `getSessionMessages` 只读通道
（`AgentService.ts:1804-1811`）。

### 3.5 UI 改动

- SessionTabs 语义从"主会话 + 平行会话"升级为"任务会话列表"，新增明确的
  "新任务"按钮；批次会话维持只读查看。
- 阶段主会话**先保留**作为默认入口（兼容连续对话习惯），任务会话作为显式选项
  上线；验证 artifact 注入质量后再评估是否切默认。

### 3.6 停止与中止覆盖同步扩展

当前"停止"只覆盖活动会话 + VERIF 批次（`stopVerifBatches`）。任务会话、修复会话
上线后，停止/中止的覆盖面必须同步扩展：停止入口枚举该项目全部前台/后台任务会话
（含托管自动切出的会话与修复会话），逐一 abort/dispose；否则会产生新一类
"停不掉的会话"。此项并入 M1 验收标准。

## 4. 方案 B：RTL 修复任务会话

针对"VERIF 发现 RTL bug 直接改"的现状。**拆分点按真实诊断循环设计**——诊断是
"假设 → 修 → 跑 → 证伪 → 再假设"的循环，根因确认往往就是修复+回归通过的那一刻，
因此假设状态机留在验证会话，修复会话只做一锤子执行：

1. 验证会话发现 RTL bug → 走已有 `record_root_cause` 登记假设/根因
   （`verification/results/root-causes.json`，verdict: open/refuted/confirmed，
   `refutedHypotheses` 链式追溯，`verification-intelligence-engine/src/types.ts:97-99`）。
2. **假设与诊断状态机留在验证会话**：试错、证伪、增强诊断都在原会话循环，不拆。
3. **根因确认后才开修复会话**：`session-phase-verif--fix-<根因ID>.jsonl`，
   `parentSession` 指向验证会话；职责只有一个——"执行已确认的修复 + 回归验证"。
   prompt 程序化附上根因记录、固定住的 testcase/seed、相关 RTL 文件清单。
4. **回归仍 FAIL 的往返**：修复会话关闭，回到验证会话继续诊断（root-causes.json
   的 open/refuted 链天然支持多轮往返），确认新根因后再开下一个修复会话。
5. 修复完成后由主进程校验：rtlHash 已变化（自动失鲜旧证据，机制已有）、根因记录
   已更新为 confirmed、相关场景重跑证据已产生。
6. 阶段提示词相应调整（保留"固定 testcase/seed、单根因最小修改、不得改预期迎合
   RTL"等现有约束）。

收益：修复推理不再污染验证会话上下文；血缘链使"这个模块被验证阶段改过、为什么"
可追溯；为方案 C 的门控提供明确的修复边界。

## 5. 方案 C：并行验证门控（批次并行化的前置条件）

**触发逻辑**：发现 RTL bug 必须阻断其他验证，但不用 agent 间通知，用共享状态 +
派发门控：

1. **修复中标志**：主进程维护（或落盘 `verification/results/rtl-fix-in-progress.json`，
   与 `diagnostic-control.json` 同级），由方案 B 的修复会话创建/关闭。
2. **派发门控**：主进程在派发下一批前检查标志，修复期间不派新批次。这是调度器的
   if 判断，不依赖 LLM 自觉。
3. **在跑仿真的处理**：不强杀。其对旧 rtlHash 的证据仍有效（"修复前该场景也
   FAIL"是回归基线），跑完 settle 后引擎按 rtlHash 自然标失鲜。
4. **RTL 写保护（尽力拦截 + 兜底，非硬保证）**：pi 默认工具含 bash，write/edit
   钩子拦不住 `bash -c "sed -i rtl/..."`；修复期间禁用 bash 又不可行（仿真要靠
   它）。因此写保护按三层诚实实施，**不对签核语义提供"RTL 绝未被绕过修改"的
   硬保证**：
   - 尽力拦截：pi 扩展 `tool_call` 钩子 block 非修复会话对 `rtl/` 的 write/edit；
     bash 命令做路径启发式检查（检出即 block 并记录）；
   - 失鲜兜底：rtlHash 全局哈希机制已有，任何绕过拦截的 RTL 修改都会使旧证据
     失鲜——最坏结果是证据作废重跑，不会拿过期证据冒充通过；
   - 事后审计：修复窗口内 `rtl/` 的文件变更清单落盘（前后快照 diff），供签核
     审查。
5. **修复完成后**：rtlHash 失鲜旧证据 → 引擎重建态势 → 受影响场景优先重跑。

**后续优化（非前提）**：rtlHash 全局哈希过保守（改注释也全量失鲜）。结构模型已有
`conesOfInfluence`（`structural-analyzer.ts:187`），可演进为模块级影响分析，
只失鲜受影响模块的场景，其余继续跑。

## 6. 后续方向（不在本期范围）

- **fork 接线（原 #2）**：RPC `fork(entryId)` + `get_fork_messages` 支撑
  "回到本任务第 N 个 prompt 修改重试"（e2e 已有回滚重录场景）。任务粒度会话
  落地后才有明确语义。
- **controller 模式（原 #4）**：controller 会话只规划验收、派生的每个执行任务
  就是方案 A 的任务会话，`parentSession` 血缘即验收依据；`PI_SESSION_FILE` 环境
  变量可让子任务引用父会话。适合串行派发 + 验收，不做并行实现型 worker。
- **审批流**：pi 扩展的 `extension_ui_request/response` RPC 子协议可支撑危险操作
  确认门，配合方案 C 的写锁钩子一起评估。
- **模型分工**：`set_model` + pi 跨 provider 上下文交接，执行用快模型、审验收
  用贵模型。

## 7. 实施路线

- **M1（方案 A 骨架）**：`startTask` 入口（泛化 `resetSession`）+ `parentSession`
  会话头 + artifact 索引注入 + "新任务" UI 动作 + 托管模式交付物边界自动切换 +
  停止/中止覆盖扩展（§3.6）。验收：RTL 阶段跑通两个连续任务，第二任务零历史继承
  但能正确定位 artifact；停止能覆盖全部任务会话。
- **M2（归档与占用引导）**：任务会话归档推广 + 上下文占用引导动作。
- **M3（方案 B）**：RTL 修复任务会话 + 根因登记联动 + VERIF 提示词调整。
  **前置验证**：先用 NPU 试跑的真实修复案例验证"根因确认再拆会话"在真实流程
  中成立（用真实数据检验拆分点），再实施。验收：批次发现 bug → 根因确认 →
  修复会话 → 证据失鲜 → 重跑闭环；回归仍 FAIL 能往返。
- **M4（方案 C）**：修复中标志 + 派发门控 + RTL 写保护（§5.4 三层诚实版本：
  尽力拦截 + 失鲜兜底 + 事后审计）。验收：并行批次实验开启后，修复期间无新批次
  派发、非修复会话对 `rtl/` 的 write/edit 与可检出的 bash 改写被 block、绕过
  拦截的变更被审计清单捕获。

每个里程碑独立可用、可回滚：M1 不动现有主会话行为，M3/M4 逐层加约束。

## 8. 风险与决策点

1. **"刚才那个改一下"失效**：跨任务后新会话无上一任务对话记忆。缓解：手动模式
   任务边界用户显式控制，托管模式只在交付物边界自动切（§3.1）；同任务内连续性
   完整。**决策点**：是否接受显式"新任务"交互（手动模式）。
2. **artifact 质量成为硬依赖**：上任务未落盘则新会话断粮。缓解：任务 settle 后
   主进程校验关键 artifact 存在性（轻量版先行），缺失时 UI 提示。
3. **会话文件膨胀**：归档机制兜底；会话目录需列表 UI 分页/搜索（后续）。
4. **spawn 开销**：每任务一次进程启动 + provider 注入 + APPEND_SYSTEM 重写，
   秒级。短任务可感知，但符合"进程即用即弃"的隔离收益。
5. **阶段主会话去留**：建议先保留（增量上线），M1 验证后再评估切换默认。
6. **安全**：MoonGlass spawn pi 带 `-a`（信任项目目录），项目 workspace 的
   `.pi/extensions/` 会被加载（≤0.58.4 有 RCE CVE-2026-5556，现靠 trust 缓解）。
   **采纳评审建议**：导入外部项目时默认禁用项目级扩展自动加载，白名单放行；
   内置桥接扩展走 `-e` 显式加载不受影响。
