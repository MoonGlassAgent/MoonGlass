# MoonGlass 开发进展报告

> 报告日期：2026-08-03
> 版本：v0.3.0
> 当前阶段：Phase 4（RTL / 验证）
> 状态：可构建、可打包、基础功能可运行

---

## 1. 本阶段完成的工作

### 1.0 需求与规格阶段正式合并

- 将 `REQ` 与 `SPEC` 合并为 `REQ_SPEC`（需求-规格定义），全流程由 7 阶段调整为 6 阶段。
- 新项目直接使用六阶段模型；旧项目启动时自动归并两个阶段的状态、交付物、Agent 上下文、评审和门禁记录。
- `REQ_SPEC → ARCH` 门禁同时检查需求、模块规格、接口规格及需求-规格追溯矩阵。
- 需求-规格矩阵继续保留，并要求每条需求 ID 映射至少一个 `SPEC-*` 规格 ID。

### 1.1 文档与版本同步

- `README.md` 状态表从 v0.1 升级到 v0.3 Phase 4。
- `package.json` 版本号统一为 `0.3.0`。
- `Sidebar.tsx` 版本标签同步为 `v0.3`。

### 1.2 UI 小 Bug 修复

| 问题 | 位置 | 修复 |
|------|------|------|
| Agent 提示词路径硬编码为 `04_verification/` | `WorkspacePage.tsx` | 修正为实际 `verification/` 目录 |
| 会话选择器 value 为硬编码假数据 | `ChatPanel.tsx` | 改为绑定当前活跃会话 |

### 1.3 RTL 引擎实现

新增 workspace 包 `@moonglass/rtl-engine`：

- `parser.ts`：ANSI / 非 ANSI Verilog 端口解析、参数提取、位宽保留、可选层级提取。
- `generator.ts`：生成 RTL 模块模板与 Wrapper。
- `types.ts`：`PortDef` 增加 `widthSpec`。
- 新增 `scripts/rtl-engine-smoke.mjs` 验证解析与生成功能。

### 1.4 EDA 仿真/执行层统一

- 新增 `packages/eda-bridge/src/tool-runner.ts`：统一工具定位、PATH 环境、执行与信号处理。
- `lint.ts`、`synthesis.ts`、`detect.ts` 重构为使用 `tool-runner`。
- `simulation.ts` 实现真实的 `runSimulation` / `runVerilatorSimulation`。
- `resources/moonglass/pi-bridge/moonglass-tools.ts` 改为从 `./eda-bridge/...` 相对导入共享实现。
- 修正 Verilator / Verible 正则解析器对 Windows 绝对路径（`C:\...`）的识别。

### 1.5 数据库迁移（#5）

- 新增 `better-sqlite3` + `drizzle-orm` 依赖。
- 新增：
  - `src/main/data/connection.ts`
  - `src/main/data/migrate.ts`
  - `src/main/services/DbService.ts`
  - `scripts/db-migration-smoke.mjs`
- `ProjectService` 从 JSON 文件存储迁移到 SQLite，保留 `projects.json.legacy` 迁移与 JSON 备份。
- `PhaseEngine` 可选将 `GateCheckResult` 持久化到 `gate_checks` 表。
- `application.ts` 服务注册顺序调整为 `DbService → ProjectService → PhaseEngine`。
- `src/main/core/paths.ts` 改为可注入 `dataDir`，方便 Node 冒烟测试。

### 1.6 打包与分发（#6）

- 新增 `electron-builder.yml`，配置 Windows nsis / macOS dmg / Linux AppImage。
- `extraResources` 打包：
  - `node_modules/@earendil-works/pi-coding-agent` → `resources/pi-coding-agent`
  - `resources/moonglass/pi-bridge` → `resources/pi-bridge`
  - `packages/eda-bridge/src` → `resources/pi-bridge/eda-bridge`
  - `resources/moonglass/ip-library` → `resources/ip-library`
  - `resources/moonglass/rules` → `resources/rules`
- `AgentService` 根据 `app.isPackaged` 区分开发与生产资源路径。
- 新增脚本：
  - `pnpm dist`：生成安装包。
  - `pnpm rebuild:electron`：better-sqlite3 编译到 Electron ABI。
  - `pnpm rebuild:node`：better-sqlite3 编译到系统 Node ABI（用于 Node 冒烟测试）。

### 1.7 Agent 模型认证修复

- 启动 pi 子进程时屏蔽 40+ 个 Provider API key 环境变量，避免用户环境变量覆盖 UI 配置。
- 隔离 pi 全局配置目录到 `userData/moonglass/pi-agent`，避免与命令行 pi 互相污染。
- `moonglass-providers.ts` 增加 `authHeader: true` 与 `$` 转义。
- `LlmProviderService` 保存 API Key 时自动 `trim()`。
- `setModel` 后校验 pi 返回的 provider/model，失败抛错而非静默 fallback。

### 1.8 设置页增加 Provider 测试按钮

- 新增 `llm:test` IPC 通道。
- `LlmProviderService.test()` 调用 Provider `/models` 端点验证 API Key，不消耗 token。
- `SettingsPage.tsx` 增加"测试连接"按钮与结果展示。

### 1.9 IP 模板库首个真实样例

- 新增 `resources/moonglass/ip-library/utility/axi_lite_timer/`：
  - `rtl/axi_lite_timer.sv`：AXI-Lite 定时器 RTL。
  - `verification/tb_axi_lite_timer.sv`：Icarus smoke testbench。
  - `docs/register-map.md`：寄存器说明。
  - `docs/verification-plan.md`：最小验证计划与质量证据清单。
  - `metadata.json`：模板元数据。
- 新增 `pnpm smoke:axi-lite-timer`，验证 lint、Icarus 编译仿真、VCD 与 `result.json` 证据生成。

### 1.10 IP 模板库导入与索引

- 新增 `IpLibraryService`，统一扫描内置库与用户登记的本地 IP 库。
- 支持用户自定义 IP 库名称、类型和目录路径；重复路径会更新名称/类型并重建索引。
- 索引器优先读取 `metadata.json` / `ip.json`，否则按 `rtl/`、`.v/.sv`、docs、verification、constraints 自动识别 IP 条目。
- 索引结果持久化到 `userData/moonglass/ip-libraries/libraries.json`，统一输出 `index.json` 供 Agent 与流程看板读取。
- `IpLibraryPage` 从静态占位改为真实导入表单、库列表、分类视图、刷新/重建索引/移除登记/打开目录。
- 新增 `pnpm smoke:ip-library`，覆盖内置样例扫描、用户库导入、自定义类型与统一索引落盘。

---

## 2. 验证结果

### 2.1 类型与构建

- `pnpm typecheck` ✅
- `pnpm typecheck:root` ✅
- `pnpm build` ✅
- `pnpm dist` ✅（生成 `dist/MoonGlass Setup 0.3.0.exe`）

### 2.2 冒烟测试

| 测试 | 脚本 | 结果 |
|------|------|------|
| 数据库迁移 | `scripts/db-migration-smoke.mjs` | ✅ |
| IP 库索引 | `scripts/ip-library-service-smoke.mjs` | ✅ |
| EDA 门禁 | `scripts/eda-gate-smoke.mjs` | ✅ |
| AXI-Lite Timer 样例 | `scripts/axi-lite-timer-smoke.mjs` | ✅ |
| Pi 工具集 | `scripts/pi-tools-smoke.mjs` | ✅ |
| RTL 引擎 | `scripts/rtl-engine-smoke.mjs` | ✅ |

### 2.3 安装包验证

- Windows 安装包可正常安装/卸载。
- 安装后可启动，服务全部加载，数据库初始化正常。
- GUI 可正常显示（在开发和打包环境中验证）。

---

## 3. 已知问题与限制

### 3.1 原生模块 ABI 切换

`better-sqlite3` 是原生 C++ 模块：

- 开发运行 / 打包前需要：`pnpm rebuild:electron`
- Node 冒烟测试前需要：`pnpm rebuild:node`

**注意**：运行 `pnpm dist` 后 `node_modules` 中的二进制会被切换为 Electron ABI；若随后执行 `pnpm rebuild:node`，之前打好的安装包里的二进制不会被自动更新，但 `node_modules` 已变为 Node ABI。重新打包前必须先 `pnpm rebuild:electron`。

### 3.2 项目数据仍存放在 userData

当前 `moonglass.db`、pi 会话文件、Agent 工作区均放在 `userData/moonglass/`。用户反馈这些应跟随工程目录，但尚未完成迁移。后续需要：

1. 项目创建时选择/指定工程目录。
2. 将项目级数据库、会话文件、交付物迁移到 `<工程目录>/.moonglass/`。
3. 保留全局 `userData` 仅作为项目索引与应用配置。

### 3.3 Provider 认证仅支持 API Key

当前仅实现 OpenAI-compatible 与 Anthropic 协议的 API Key 认证，尚未支持 OAuth、订阅登录、Azure AD 等企业认证方式。

### 3.4 安装包签名

当前使用 electron-builder 自动签名（测试证书）。正式分发前需要配置代码签名证书，否则 Windows SmartScreen 可能拦截。

### 3.5 会话文件与 pi 配置隔离

pi 子进程的 `PI_CODING_AGENT_DIR` 已隔离到 `userData/moonglass/pi-agent`，但会话文件仍在 `userData/moonglass/pi-sessions/<projectId>/`。迁移到工程目录是后续工作。

---

## 4. 关键架构决策

### 4.1 Pi 桥接扩展运行时复制

Pi 子进程无法解析 `workspace:*` 包，因此 `AgentService.start()` 运行时将：

- `resources/moonglass/pi-bridge/*.ts` 复制到 `userData/moonglass/pi-bridge/`
- `packages/eda-bridge/src/*.ts` 复制到 `userData/moonglass/pi-bridge/eda-bridge/`

`moonglass-tools.ts` 通过相对路径 `./eda-bridge/...` 导入共享实现。

### 4.2 环境变量隔离

`AgentService.spawnSession()` 显式删除 40+ 个 Provider API key 环境变量，并覆盖 `PI_CODING_AGENT_DIR`、`PI_CODING_AGENT_SESSION_DIR`，确保 MoonGlass 使用 UI 中配置的 key，不受用户 shell 环境或命令行 pi 登录状态影响。

### 4.3 IPC 契约集中管理

所有主进程 ↔ 渲染进程通道定义在 `src/shared/ipc-contract.ts`；`preload/index.ts` 仅暴露 `window.moonglass` API。禁止三端硬编码通道字符串。

---

## 5. 下一步建议

### 5.1 高优先级

1. **项目数据跟随工程目录**：将数据库、会话文件、Agent 工作区从 `userData` 迁移到项目目录，支持用户选择工程路径。
2. **完善模型认证**：支持更多 Provider（Google、Azure、AWS Bedrock）及 OAuth / 订阅登录。
3. **Agent 会话可观测性**：增加主进程日志落盘、渲染端显示当前模型、请求/token 消耗统计。

### 5.2 中优先级

4. **IP 模板库内容继续填充**：当前已有导入/索引能力与 `utility/axi_lite_timer` 样例，需要继续扩展 UART/SPI/FIFO/arbiter 等模板。
5. **知识库 / RAG**：接入 `sqlite-vec` 实现本地向量检索。
6. **RTL→VERIF 闭环 GUI 反馈**：将 lint/综合/仿真结果以面板形式展示，而非仅依赖 Agent 文本输出。

### 5.3 低优先级

7. **macOS / Linux 安装包验证**：当前主要验证 Windows，其他平台需单独测试。
8. **自动更新**：集成 electron-updater。

---

## 6. 交付物清单

- 源码仓库：`D:/Projects/ASIC_Flow/MoonGlass`
- 构建产物：`out/`
- 安装包：`dist/MoonGlass Setup 0.3.0.exe`
- 免安装版：`dist/win-unpacked/MoonGlass.exe`
- 规格书：`ChipForge_Studio_Specification.md`
- 开发指南：`README.md`
- 本报告：`reports/progress-report.md`
- 总体报告：`reports/overall-report.md`
