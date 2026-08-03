# MoonGlass v0.3 代码审查报告

> 审查日期：2026-08-03
> 审查版本：v0.3.0（git HEAD `0e9a14d`）
> 审查范围：`src/`（main / preload / renderer / shared）、`packages/`（eda-bridge / rtl-engine / prompts / design-browser-engine）、`resources/moonglass/pi-bridge`、构建与打包配置
> 审查方法：全量源码走读（约 60 个源文件）+ 静态验证 + 交叉核对

---

## 0. 验证方法

| 检查项 | 命令 / 方法 | 结果 |
|--------|------------|------|
| workspace 子包类型检查 | `pnpm typecheck`（4 个子包） | ✅ 通过 |
| root（main/preload/renderer）类型检查 | `pnpm typecheck:root` | ✅ 通过 |
| pi RPC 协议事件名核对 | grep `@earendil-works/pi-coding-agent@0.82.1` dist 源码 | ✅ 全部一致 |
| pi RPC 命令类型核对 | `get_messages / set_model / set_session_name / get_state` 对照 rpc-mode | ✅ 全部一致 |
| 打包配置与资源路径约定 | `electron-builder.yml` ↔ `AgentService.start()` 静态比对 | ⚠️ 静态一致，未实机验证 |

---

## 1. 总体评价

**结论：架构清晰、工程质量较高的 v0.3 实现，核心链路（契约中心化、服务生命周期、pi Agent 嵌入、门禁引擎接真实 EDA 工具）扎实可靠，具备继续迭代的坚实基础。**

代码风格统一（TypeScript strict / ESM / 中文注释）、错误处理细致、防御式编程到位。审查中发现的问题以**测试缺失、可移植性、安全加固、文档漂移**四类为主，无致命架构缺陷，无影响当前功能运行的阻断性问题。

| 维度 | 评级 | 说明 |
|------|------|------|
| 架构与分层 | ★★★★☆ | 契约单一来源、生命周期管理、服务化清晰 |
| 代码质量 | ★★★★☆ | strict TS、命名规范、防御性编程 |
| 安全 | ★★★☆☆ | 路径穿越防护到位；sandbox / URL scheme / Key 降级有缺口 |
| 可靠性 | ★★★☆☆ | 硬编码路径、CDC 门禁虚设、无回归测试保护 |
| 测试 | ★★☆☆☆ | 10 个手工 smoke 脚本，未接入自动化与 CI |
| 文档 | ★★★★☆ | README / reports / dev-summary 齐全，但状态表已过时 |

---

## 2. 值得肯定的设计（请保持）

### 2.1 契约中心化真正落地

IPC 通道名只在 `src/shared/ipc-contract.ts` 定义，`src/main/ipc.ts` 与 `src/preload/index.ts` 全部引用常量，无硬编码字符串；领域类型（`Phase` 等）单点定义无重复。三端共享契约的架构约定（AGENTS.md §结构约定）得到严格执行。

### 2.2 pi RPC 集成与上游协议一致（已实证）

- `PiRpcClient` 手工 JSONL 分帧 + `StringDecoder` 处理多字节 UTF-8，注释明确规避 U+2028/U+2029 被 readline 误判——细节到位。
- 本次审查将 `AgentService` 使用的事件名（`agent_start / agent_settled / message_update / tool_execution_start / tool_execution_end / auto_retry_end`）与命令类型（`get_state / get_messages / set_model / set_session_name`）逐一对照 pi dist 源码，**全部一致**，`assistantMessageEvent.thinking_delta` 映射亦匹配。集成正确性有保障。

### 2.3 安全细节到位处

- 路径穿越防护三处：`FileService.resolveProjectFile`、`EdaService.openWaveform`、`DesignBrowserService.readSource` 均校验解析后路径必须落在工作区内。
- `OpenInstallPage` 仅放行 `https://`。
- 预置 Provider 的 `builtin` 标记在主进程强制锁定，防渲染端篡改。
- API Key 使用 safeStorage 加密；启动 pi 子进程时屏蔽 40+ 个 provider 环境变量，强制走 UI 配置；调试日志只打印 Key 后 4 位。
- `DesignBrowserPage` 生成的 HTML 报告所有插值均经 `escapeHtml`，无 XSS 面。

### 2.4 门禁引擎接真实 EDA 工具

`lintZeroError`（verible→verilator 回退）、`yosysSynthesizable`、`simPassed` / 覆盖率解析均为真实执行而非假数据，结果落库 `gate_checks` 表；门禁规则表与规格书 §3.1 对应，`fastTrackSynthesis` 在跳过阶段写入警示标记，语义诚实。

### 2.5 Agent 系统提示词工程化（全项目最有芯片领域味的部分）

`@moonglass/prompts` 按规格 §3.3 分层组装，写入 `.pi/APPEND_SYSTEM.md`，并注入项目目录规范、存储宏三视图规则（behavioral/blackbox/phy_template）、工艺库索引指引、快速面积评估模式约束等，与 `design.json` manifest 体系（simulationFiles/libraryFiles/physicalFiles）形成闭环。

### 2.6 平台适配用心

`toolEnv` 将 oss-cad-suite bin/lib 提到 PATH 前端规避 DLL 抢占、`VERILATOR_ROOT` 反斜杠转义（Windows make 语义）、Windows 无扩展名脚本回退 `verilator_bin.exe`、`execFile` ENOENT 与其它退出码区分等，均为实际运行踩坑后的正确处理。

---

## 3. 问题清单（开发团队请按此逐条认领）

> 每条问题含：位置 / 问题描述 / 影响 / 建议。建议团队据此直接建 GitHub Issue。

### 🔴 P0 — 高优先级

#### R-01 零自动化测试，无 CI

- **位置**：仓库根（无 test 脚本、无 vitest/jest/playwright 配置、无 `.github/workflows`）
- **问题**：21 个 commit、约 1.1 万行代码，`package.json` 无任何 test 命令；`scripts/` 下 10 个 smoke 脚本（db-migration、pi-rpc、pi-tools、synthesis-flow 等）覆盖了关键链路，但**未接入任何命令或 CI**，随代码漂移后无人运行即失效。
- **影响**：门禁引擎、会话管理、数据库迁移等核心逻辑无回归保护，后续迭代风险高。
- **建议**：
  1. 现有 smoke 脚本接入 `pnpm test`（串行执行，失败即退出非零）。
  2. 为 `PhaseEngine`（状态机+门禁，纯函数易测）补单测：推进/回退/门禁阻断/快速面积模式。
  3. 加一个轻量 CI（GitHub Actions 或等价）：`pnpm install → typecheck → test → build`。

#### R-02 硬编码开发机绝对路径

- **位置**：`packages/eda-bridge/src/synthesis.ts:214` `DEFAULT_NANGATE45_LIBERTY = 'D:/Projects/rtl_lib/...'`；`resources/moonglass/toolchains.json` 同路径
- **问题**：源码中硬编码了开发机上的 Nangate45 Liberty 路径。换机器 / 打包分发后该文件不存在 → `selectTargetLibrary` 静默返回 undefined → 综合降级为 generic 单元统计。
- **影响**：与系统提示词的承诺矛盾——`AgentService.writeSystemPrompt` 明确指示 Agent"综合默认使用本机 Nangate45/FreePDK45 typical 开源 Liberty"，但实际环境大概率没有该库；用户拿到的是"通用单元数"却可能误读为工艺面积。
- **建议**：默认库改为从工艺库索引（`userData/moonglass/process-libraries/index.json`）或用户设置解析；找不到时在综合报告与 Agent 提示中显式声明"默认库不可用"，删除源码中的机器路径。

#### R-03 安全加固缺口

- **位置**：
  - `src/main/index.ts` `setWindowOpenHandler`：对任意 URL 调 `shell.openExternal`，**未校验 scheme**
  - `src/main/index.ts` `webPreferences.sandbox: false`
  - `src/main/services/AgentService.ts` `MOONGLASS_PROVIDERS_JSON` 环境变量携带明文 API Key
- **问题**：
  1. 渲染进程被诱导 `window.open('file:///...')` 或自定义协议可触发系统程序打开，存在钓鱼/越权面。
  2. preload 仅使用 `contextBridge / ipcRenderer`，无 Node 依赖，`sandbox: false` 不必要地扩大了渲染进程攻击面。
  3. pi 子进程继承全量环境（`{...cleanEnv, ...}`），其中含明文 Key；同机进程可枚举子进程环境读取。
- **建议**：`setWindowOpenHandler` 加 `http(s)` 白名单；`sandbox: true`；pi 子进程环境改为最小白名单构造（仅保留 PATH/系统必需 + MOONGLASS_* 注入项）。

---

### 🟡 P1 — 中优先级

#### R-04 CDC 门禁名实不符（QA→SYNTH 门禁形同虚设）

- **位置**：`src/main/services/PhaseEngine.ts` `cdcPassed`
- **问题**：多时钟域设计返回 `passed: true` + severity `warning`（报告文案"0 个潜在违规"），而门禁阻断只认 `severity==='error' && !passed`——**CDC 检查永远不会阻断推进**。且检查为正则启发式，仅识别 `i_clk` / `r_\w+` / `o_\w+` 命名风格，对真实设计误报与漏报都高。
- **影响**：UI 显示"CDC 检查通过"会给用户"已完成 CDC 签核"的错误暗示，而实际只是正则扫描。
- **建议**（二选一）：
  1. 接入 symbiyosys 真检查（规格书 §3.1 门禁语义）；
  2. 或明确降级为 `info` 并标注"启发式提示，不纳入门禁"，同时在 PhaseBoard 提示文案中如实说明。

#### R-05 工具元数据三处漂移

- **位置**：`src/main/ai/tools/moonglass/index.ts`（stub 注册表）、`src/main/ai/agents/index.ts`（阶段工具白名单）、`resources/moonglass/pi-bridge/moonglass-tools.ts`（真实实现）
- **问题**：真实工具已在 pi-bridge 注册 9 个（`run_verible_lint`、`check_synthesizability`、`read_verilog`、`collect_rtl_files`、`generate_tb`、`run_simulation`、`generate_sdc`、`run_logic_synthesis`、`run_cdc_check`），但 `ai/agents` 中 RTL 阶段白名单仍引用旧名（如 `generate_rtl_template`、`query_ip_library`，pi 扩展中不存在）。三处靠人工同步，已出现漂移。
- **影响**：阶段工具白名单（TODO(Phase 4) 承诺）形同虚设且会误导后续实现。
- **建议**：删掉两处"文档参照"死代码，或在文件头显式声明"以 pi-bridge 为唯一事实源"；实现按阶段白名单时再以 pi-bridge 为准重建单一数据源。

#### R-06 RTL 收集与 Lint 解析逻辑三份拷贝

- **位置**：
  - `PhaseEngine.collectRtlFiles`（含 EXCLUDED_DIRS/FILES 排除）
  - `DesignBrowserService.collectRtl`（无排除，会把 `macros/` 视图与生成文件列为候选）
  - `moonglass-tools.ts` `collectRtlFiles`（独立第三份）
  - lint 输出解析正则 `VERIBLE_LINE / VERILATOR_LINE` 在 `eda-bridge/src/lint.ts` 与 pi-bridge 中重复
- **问题**：排除规则不一致导致同一工作区在不同功能中扫描出不同文件集；解析逻辑两处维护。
- **影响**：设计浏览器可能把 SRAM 行为视图、综合产物列为顶层候选；未来修解析 bug 需改两处。
- **建议**：把收集/解析下沉到 `packages/eda-bridge` 的独立模块（仅依赖 Node 内置，满足 pi-bridge 约束），PhaseEngine / DesignBrowserService / pi-bridge 统一引用；pi-bridge 启动复制时同步带上该模块。

#### R-07 DB Schema 双源 + 数据表无限增长

- **位置**：`src/main/data/schema/moonglass.ts`（drizzle 定义）↔ `src/main/data/migrate.ts`（手写 SQL）；`gate_checks` 表写入
- **问题**：
  1. 同一 schema 两份定义，加表/改列需同步两处且无一致性校验；
  2. 每次门禁检查向 `gate_checks` 插入 N 行（`randomUUID` 主键），无清理/归档策略，长期运行膨胀。
- **建议**：增加生成期对比校验（drizzle 生成 SQL vs migrate 手写 SQL）；为 `gate_checks` 增加按项目保留最近 N 次的清理策略。

#### R-08 打包链路未实机验证

- **位置**：`electron-builder.yml` `extraResources` ↔ `AgentService.start()` 的 `process.resourcesPath` 约定
- **问题**：静态比对显示路径约定一致（`pi-coding-agent/dist/**`、`pi-bridge`、`skills`、`eda-bridge`），但本次审查未执行 `pnpm dist` 实机验证。
- **影响**：pi 扩展在 asar 环境下的加载、better-sqlite3 ABI（`rebuild:electron` 顺序）、NSIS 安装后资源路径均为发布前高危点。
- **建议**：发布前完整执行 `pnpm rebuild:electron → pnpm dist → 安装 → 启动冒烟（Agent 会话 + 门禁 + 综合）`，并将结果记入本报告或 progress-report。

#### R-09 文档与代码漂移

- **位置**：`README.md` 状态表、`src/shared/types/moonglass.ts:254` 注释、`src/main/ai/agents/index.ts` 头注释
- **问题**：
  1. `runLogicSynthesis` 已是完整实现（网表 + Liberty 映射 + 面积/时序报告），README 仍标"🚧 桩（Phase 6）"；
  2. `moonglass.ts` 注释称 API Key"骨架期明文存本地 JSON"，实际已 safeStorage 加密；
  3. `ai/agents` 头注释称"TODO(Phase 2) 接入运行时"，实际 Phase 2 已完成。
- **影响**：交接/评审时产生误导。
- **建议**：发布 v0.3.1 时同步更新 README 状态表与过期注释；后续约定"代码合入时同步文档"。

---

### 🟢 P2 — 低优先级 / 卫生项

| ID | 位置 | 问题 | 建议 |
|----|------|------|------|
| R-10 | `src/renderer/components/ChatPanel.tsx` `MessageBubble` | `useRef/useState/useEffect` 在 user/tool 角色早退 return 之后调用，字面违反 Rules of Hooks（因 key 稳定暂未触发） | 拆分为独立子组件，hooks 放在无条件位置 |
| R-11 | `src/main/services/LlmProviderService.ts` | `User-Agent: MoonGlass/0.3.0` 版本号硬编码 | 统一版本常量（package.json 单一来源） |
| R-12 | `src/main/services/PythonService.ts` | `spawn('python')` 无 `python3` 候选回退（detect.ts 有回退，执行层没有） | 复用 `locateTool` 候选逻辑 |
| R-13 | `src/main/services/EdaService.ts` `installBundle` | GitHub API / 下载 `fetch` 无超时、无代理支持、无重试 | 加超时与错误分类 |
| R-14 | `src/main/services/AgentService.ts` `listSessions` | 内联 `require('node:fs')`（CJS 风格） | 静态 import |
| R-15 | `packages/eda-bridge/src/lint.ts` | `veribleAvailable` 模块级缓存，会话中安装 Verible 不刷新 | 降级为每次探测或加失效窗口 |
| R-16 | `src/renderer/pages/WorkspacePage.tsx` `handleAdvance` | 无 try/catch，IPC 异常产生未处理 rejection | 与其他 handler 一致补 catch |
| R-17 | `src/shared/ipc-contract.ts` `llm.test` JSDoc | 两行注释语义重复（"不消耗 token" / "测试当前表单配置"） | 清理 |
| R-18 | `resources/moonglass/skills/` | 与外部 `agent_env/agent/skills/` 双份拷贝，无同步校验 | 加 hash 校验脚本或明确唯一来源 |
| R-19 | `src/main/services/AgentService.ts` `mapMessage` | 历史消息恢复时 thinking 字段不还原（仅流式有） | 低优，可接受 |
| R-20 | `src/main/services/ProjectService.ts` | SQLite + JSON 双写，`backupToJson` 失败静默吞掉 | 至少记录日志级别告警 |

---

## 4. 与规格书的差距（未实现能力盘点）

以下能力当前为显式占位（符合 AGENTS.md"禁止静默返回假数据"约定），交付前需向用户如实标注：

| 能力 | 规格章节 | 现状 |
|------|---------|------|
| 知识库 RAG（sqlite-vec 向量检索） | §3.x | `KnowledgePage` 纯占位 |
| IP 模板库内容 | §5.x | `IpLibraryPage` 静态常量占位；`ip-library/` 仅 README |
| 公司规则管理 / 自定义提示词 UI | §3.3 | 设置页占位 |
| 项目级约束接入系统提示词 | §3.3 | `writeSystemPrompt` 中 TODO(Phase 3 后续) 未传参 |
| Python Jupyter Kernel（变量持久化） | — | 仍为 spawn 一次性执行 |
| 按阶段工具白名单 | §3.2 | 未实现（见 R-05） |
| VCS / Xcelium 仿真 | §3.5 | `NotImplemented` 显式抛错 |
| 项目数据跟随工程目录 | — | 仍在 `userData/moonglass/`（progress-report §3.2 已列） |

---

## 5. 优先行动建议（按 ROI 排序）

1. **补自动化测试 + CI（R-01）**：先接现有 smoke 脚本为 `pnpm test`，再补 `PhaseEngine` 单测——投入小、回报最大。
2. **移除硬编码 Liberty 路径（R-02）**：改为工艺库索引解析，消除换机失效与"承诺/实现背离"。
3. **安全加固（R-03）**：`setWindowOpenHandler` scheme 白名单、`sandbox: true`、子进程环境最小化——三处小改动。
4. **CDC 门禁降级或真实现（R-04）**：当前"永不阻断"比"显式未接入"更危险，务必处理。
5. **清理工具元数据死代码（R-05）**：确定 pi-bridge 为唯一事实源。
6. **统一 RTL 收集逻辑（R-06）**：下沉到 eda-bridge 共享模块。
7. **发布前实机打包验证（R-08）**：`pnpm dist` + 安装后冒烟。

---

## 6. 结论

MoonGlass v0.3 是一个**架构正确、核心功能真实可用**的中型 Electron 应用骨架：契约中心化、生命周期管理、pi Agent 嵌入、真实 EDA 门禁、提示词工程化均为加分项，且经本次审查实证与上游 pi 协议一致、类型检查全绿。

当前不具备阻断性缺陷，但**测试空白与打包链路未验证**是发布前必须补上的两块短板；安全加固（R-03）与 CDC 门禁语义（R-04）建议在下一个版本周期优先处理。建议团队按 §5 顺序推进，并将 §3 问题表逐条转为 Issue 跟踪闭环。

---

## 7. 第二轮评审（基线 review-baseline-2026-08-03）

> 评审日期：2026-08-03
> 评审对象：提交 `24f39d5`（tag `review-baseline-2026-08-03`，分支 `feature/rtl-design-browser`）
> 评审方式：基于基线全量复核 + 独立执行验证 + 补齐首轮未覆盖文件（`styles.css`、`ThemePicker`、`Sidebar`、`SettingsPage` 剩余、`ProcessLibrariesPage`、`main.tsx` 等）

### 7.1 基线范围确认

基线提交 `24f39d5` 相对首轮评审的 `0e9a14d` 变更 38 个文件、+2594/-265 行。经逐文件比对确认：**基线内容即首轮评审所读工作树**（此前未提交的开发改动被打包进基线），外加主题系统（CSS 变量 + ThemePicker + `workbench-texture.png`）与评审报告本身。基线没有包含任何问题修复。

### 7.2 独立验证结果（本轮重新执行）

| 检查项 | 结果 |
|--------|------|
| `pnpm typecheck`（4 个子包） | ✅ 通过 |
| `pnpm typecheck:root`（main/preload/renderer） | ✅ 通过 |
| `pnpm build` | ✅ 通过 |
| 基线工作树 / tag | ✅ 干净 / 存在 |

**构建产物体积告警**（本轮新观察）：

- `out/renderer/assets/workbench-texture-*.png` **2,356 KB**
- `out/renderer/assets/index-*.js` **978 KB**（详见 R-21 / R-23）

### 7.3 首轮 20 条问题状态确认

**结论：R-01 ~ R-20 在基线中全部仍存在，无一条被修复**（基线为评审快照，符合预期）。抽样复核证据：

| ID | 复核证据 | 状态 |
|----|---------|------|
| R-01 | `package.json` 仍无 test 脚本；无 `.github/` | 🔴 仍存在 |
| R-02 | `synthesis.ts:177` 与 `toolchains.json:18` 硬编码 `D:/Projects/rtl_lib/...` | 🔴 仍存在 |
| R-03 | `index.ts:45-48` `setWindowOpenHandler` 无 scheme 校验；`index.ts:31` `sandbox: false` | 🔴 仍存在 |
| R-04 | `PhaseEngine.ts:488` `cdcPassed` 返回 `passed=true + warning`，永不阻断 | 🟡 仍存在 |
| R-05 | `ai/tools/moonglass/index.ts` stub 与 `ai/agents/index.ts` 死代码（RTL 阶段仍引用不存在的工具名） | 🟡 仍存在 |
| R-06 | `collectRtlFiles` 三份拷贝：`PhaseEngine.ts:79`、`moonglass-tools.ts:290`、`DesignBrowserService` | 🟡 仍存在 |
| R-07 | `gate_checks` 无清理策略 | 🟡 仍存在 |
| R-09 | `README.md:25` 仍标综合为“🚧 桩（Phase 6）”，与已实现代码不符 | 🟡 仍存在 |
| R-10 | `ChatPanel.tsx` `MessageBubble` 条件 hooks | 🟢 仍存在 |
| R-11 | `LlmProviderService.ts:217` 硬编码 `User-Agent: MoonGlass/0.3.0` | 🟢 仍存在 |
| R-12 | `PythonService.ts:32` `spawn('python')` 无候选回退 | 🟢 仍存在 |
| R-14 | `AgentService.ts:628/639` 内联 `require('node:fs')` | 🟢 仍存在 |
| R-15 | `lint.ts:41` `veribleAvailable` 模块级缓存 | 🟢 仍存在 |
| R-16 | `WorkspacePage.tsx:221` `handleAdvance` 无 try/catch | 🟢 仍存在 |
| R-17 | `ipc-contract.ts:128` `llm.test` JSDoc 冗余 | 🟢 仍存在 |
| R-18 | `resources/moonglass/skills/` 与外部 skills 双份拷贝 | 🟢 仍存在 |

（R-08、R-13、R-19、R-20 复核未变，同上轮描述。）

### 7.4 本轮新增发现

| ID | 位置 | 问题 | 影响 | 建议 |
|----|------|------|------|------|
| **R-21** | `src/renderer/assets/workbench-texture.png`（2.3 MB）；引用：`styles.css` 多个 `background-image: url(...)` | 512px 平铺纹理使用 2.3 MB PNG，随 renderer 产物整体打包 | 安装包体积 +~2.3 MB，首屏解码与 `background-attachment: fixed` 渲染开销 | 转 WebP/量化压缩（目标 ≤300 KB），或改用 CSS 渐变 / 内联噪声 SVG 替代 |
| **R-22** | `src/renderer/styles.css` 主题实现：`.bg-blue-600 { ... !important }` 等全局 `!important` 覆盖 Tailwind 工具类（约 10 组） | 以 `!important` 全局劫持 Tailwind 类实现主题换色 | 后续任何组件使用 `bg-blue-600`（包括未来"警示/危险"等非主题语义）都会被主题色强制替换；`!important` 堆叠排障困难 | 改用 Tailwind v4 `@theme` / CSS 变量生成语义色（`--color-*`），或限定作用域选择器，消除全局 `!important` |
| **R-23** | `out/renderer/assets/index-*.js` 978 KB | 单 bundle 过大（Prism 全量语言 + React + TanStack Router） | 首屏加载慢；未来路由增多更严重 | Prism 按需加载语言、路由级 code splitting（TanStack Router `route.lazy`） |
| **R-24** | `SettingsPage.tsx` `EdaDetectSection` 的 `inferLegacyCategory` 兜底分支 | 兼容旧版主进程返回的检测项 | 说明主/渲染进程存在跨版本运行场景（升级期） | 保留即可；若可约束主/渲染同版本则删除该分支 |

### 7.5 第二轮结论

1. **基线可信**：`24f39d5` 内容与首轮评审对象一致，可放心作为后续修复工作的出发点；首轮 §3 全部 20 条问题 + 本轮 4 条新发现（R-21~R-24）即为待办全集。
2. **修复优先级不变**：仍按 §5 顺序推进（测试/CI → 硬编码路径 → 安全加固 → CDC 门禁），新增 R-21（纹理体积）建议随视觉收尾一并处理，R-22（`!important` 主题）建议在主题系统扩展前重构。
3. **发布前红线**（沿用首轮）：`pnpm dist` 打包验证 + 安装后 Agent/门禁/综合链路冒烟（R-08），以及 ABI 顺序（`rebuild:electron` ↔ `rebuild:node`，见 progress-report §3.1）。
