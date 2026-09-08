# MoonGlass v0.9.0 发布说明

MoonGlass v0.9.0 聚焦 ASIC Agent 的任务级协同、验证闭环和长时运行可靠性。它延续六阶段工程流程，并进一步把 Agent 的工作单位从不断膨胀的长会话收敛为可隔离、可观察、可恢复、可审查的工程任务。

## 主要更新

### 任务级 Agent 会话

- 一键托管和关键工程动作可按任务创建隔离会话，减少历史上下文对当前工作的干扰。
- 任务仅注入必要工件索引、当前目标和验收要求，降低无效读取与重复推理。
- 支持任务会话归档、无上下文重启、停止控制和阶段间状态恢复。

### AIGV 2.0 与验证协同

- 继续完善 Spec Gap、Verification Intent、Scenario、Coverage Hole、Residual Risk 与签核证据链。
- 引入验证批次状态、RTL 修复状态和并行验证门控，避免多个 Agent 同时改写 RTL 或读取过期证据。
- 统一 RTL 哈希空间，使证据登记、新鲜度判断和验证态势使用同一基线。
- 子模块与顶层采用分层验证策略，根据模块风险决定冒烟、Golden Model、覆盖率和 Formal 深度。

### 长时运行可靠性

- 增加 Agent Watchdog、重复失败识别、停滞提示和诊断优先策略。
- 多轮修复无收敛时，优先增强 checker、断言和故障定位证据，再继续修改 RTL。
- 会话、工具事件和后台任务进一步解耦，降低长任务造成界面阻塞或状态错乱的风险。

### 模型与上下文治理

- 自定义模型可持久化上下文窗口上限，并优先于内置模型登记表。
- 修正部分 OpenAI 兼容服务对消息角色的限制，增强 Provider 与模型逐项探活。
- 主会话和平行会话继续保持独立模型选择和恢复能力。

### 工程体验

- 侧栏显示完整版本号 `v0.9.0`。
- 绿色版打包脚本执行真实 EXE 启动自检，并避免占用系统盘临时空间。
- v0.9.0 绿色版内置 MIC_NPU Demo、Pi Coding Agent 0.84.1 和 MoonGlass AIGV 工具链。

## 学术与工程文章

- [从证据驱动流程到任务级验证协同：MoonGlass v0.6.0-v0.9.0 工程演进](./docs/MOONGLASS-v0.6.0-TO-v0.9.0-EVOLUTION-ZH-CN.html)
- [MoonGlass AIGV 2.0 白皮书](./docs/MOONGLASS-AIGV-2.0-WHITEPAPER.html)
- [证据驱动型 ASIC Agent 工作流](./docs/EVIDENCE-DRIVEN-ASIC-AGENT-WORKFLOW-ZH-CN.html)

## Windows 绿色版

- ZIP：`MoonGlass-0.9.0-Windows-x64-Green-v0.9.0-MIC_NPU-Demo-20260908.zip`
- 大小：约 271.1 MB
- 展开文件数：470
- SHA-256：`27DB83A952307B2F14DB2C9C276E2495C0FEFB9770851AAB2D94D09EF4CC0DB5`

绿色版不包含 API Key、模型账号配置或用户 Agent 会话。解压后运行 `MoonGlass.exe` 或 `Start-MoonGlass.bat`。

## 验证结果

- Workspace TypeScript 类型检查通过。
- 18 项核心测试通过。
- Electron 生产构建通过。
- Pi 运行时与内置 AIGV 工具链自检通过。
- 打包后的 `MoonGlass.exe` 主进程真实启动自检通过。

## 授权与联系

MoonGlass 为 Source Available 软件，非商业使用遵循 PolyForm Noncommercial License 1.0.0；商业使用须取得书面授权。

作者、商务合作、技术支持与产品建议：`moonglassagent@126.com`
