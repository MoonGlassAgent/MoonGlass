# MoonGlass v0.8.6 发布说明

MoonGlass v0.8.6 是自 v0.6.0 以来一次重要升级。产品从“六阶段 ASIC Agent 工作台”进一步演进为以规格、RTL 结构、风险、验证意图、场景和原始证据为核心的设计验证协同平台。

## 主要更新

### AIGV 2.0 验证方法学

- 建立 Spec Gap、Verification Intent、Scenario、Coverage Hole、Residual Risk 和签核包之间的证据链。
- 引入 FSM、CFG、COI、共享状态交互等 RTL 结构分析，按风险生成验证候选。
- 支持 Multi-Oracle、Mutation、经验性饱和、场景裁决和独立证据 Review。
- 规格条款按功能验证、PPA 综合等验收通道分类，避免错误计算验证闭环率。

### W0-W3 验证波段与验证态势

- 工作区验证操作按 W0 规划、W1 基础闭环、W2 风险驱动、W3 收敛签核组织。
- 新增全屏“验证态势”，展示最高风险、Intent 闭环、规格缺口、覆盖空洞、测试执行和签核状态。
- 推荐动作直接关联具体风险、场景和验证批次，帮助用户判断下一步工作。

### 验证执行与上下文治理

- 按场景聚类形成批次，使用隔离会话执行验证任务并记录批次里程碑。
- 增加验证摘要入口、读取纪律、根因工具和批次裁决，减少长会话上下文膨胀。
- 一键托管等待 Agent 真正结束后才检查门禁和推进，不再提前推进。
- 阶段切换不再强制中断后台任务，事件按会话路由并提供完成通知。

### EDA 与证据闭环

- 内置 Cocotb、Icarus Verilog、Verilator 覆盖率、Yosys Formal 和 Boolector BMC 支持。
- 支持仿真、JUnit、覆盖率、Formal、lint 和综合结果的结构化证据归档。
- Formal 兼容性预检会区分 RTL 缺陷与工具/语法限制，避免虚报证明结果。

### RTL Design Browser

- 重构层次、信号、源码和追踪视图，支持模块实例与源码交叉定位。
- 增强宏实例、顶层识别、`design.json` 语义结构和复杂工程解析。

### Agent 与工程体验

- 主会话和平行会话独立选择并恢复模型。
- 支持上下文压缩、无上下文重启、运行中会话观察和 Token/缓存/上下文统计。
- 增加模型服务停滞提示、错误语义化、切换模型探活和执行中切换防护。
- 支持阶段产物归档重做、彻底清除、已有项目阶段恢复和项目迁移。

## Windows 绿色版

Release 附件提供完整可用的 Windows x64 绿色版：

- 解压后运行 `MoonGlass.exe` 或 `Start-MoonGlass.bat`，无需安装。
- 内置 MIC_NPU 演示项目。
- 内置 Pi Coding Agent 0.84.1 和 MoonGlass AIGV 开源工具链。
- 不包含 API Key、模型账号配置和 Agent 会话。
- 用户数据保存在绿色版目录内的 `userdata/`。

绿色版 ZIP 的 SHA-256：

```text
4C92D27297D9A86F1EE02E03F7E2E773AA13985C67D74A6BB3E90D5324CEC7DD
```

## 验证结果

- Workspace TypeScript 类型检查通过。
- 17 项核心冒烟测试通过。
- Electron 生产构建通过。
- 打包 EXE 主进程真实启动自检通过。
- 绿色版展开文件数 469，ZIP 大小约 271.1 MB。

## 使用与授权

- 快速入门：[中文 HTML 使用说明](./docs/MoonGlass快速使用手册.html)
- 工程手册：[中文实用手册](./docs/USER-MANUAL-ZH-CN.md)
- AIGV 方法学：[MoonGlass AIGV 方法学](./docs/MoonGlass-AIGV验证方法学.html)
- 非商业使用遵循 PolyForm Noncommercial License 1.0.0；商业使用须取得书面授权。
- 联系：moonglassagent@126.com
