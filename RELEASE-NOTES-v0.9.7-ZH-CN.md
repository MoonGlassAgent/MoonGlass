# MoonGlass v0.9.7 发布说明

MoonGlass v0.9.7 是一次以验证证据真实性、RTL 静态质量和长时 Agent 稳定性为重点的质量基线。

## 主要更新

### 覆盖率闭环与明细视图

- 验证态势新增代码覆盖率明细，可按场景、类型、文件和检测点逐层下钻。
- 支持只看未覆盖项，并在 RTL 源码 gutter 中标记行号、条件语义、命中次数和层级路径。
- 历史 `coverage.dat` 可直接解析并缓存为 `coverage-detail.json`，无需重新仿真。
- 覆盖率证据绑定当前 RTL Hash；过期结果不能继续通过门禁。
- QA 到综合阶段重新检查覆盖率，防止 QA 修改 RTL 后证据退化。
- 条件覆盖率明确采用 Verilator 表达式求值口径，不宣称 MC/DC。

### RTL 静态质量增强

- Verilator 启用 `-Wall`，将 LATCH、MULTIDRIVEN、SYNCASYNCNET、UNOPTFLAT、CASEOVERLAP、CMPCONST、SELRANGE 等高价值问题升级为阻断错误。
- 新增组合逻辑非阻塞赋值、时序寄存器阻塞赋值、RTL case equality、自赋值等 MoonGlass 结构规则。
- 新增时钟/复位信号进入普通组合逻辑的检查，并同时接入 RTL→VERIF、QA→SYNTH 门禁和 Agent Lint 工具。

### Agent 与会话稳定性

- Pi Coding Agent 从 0.84.1 升级到 0.85.1。
- 修复 Agent 启动竞态、启动期切换模型导致会话损坏以及失败后无法自动重启的问题。
- 修复 Markdown 中不存在的文件链接导致 Electron 整窗白屏。
- 已完成的 VERIF 批次会话允许关闭，运行中的批次受到保护。
- Agent Prompt 支持图片附件。
- 优化巨型会话输入性能；实测 320 条、约 16.4 MB 会话由中位 112 ms/键降至 17 ms/键，并消除 Long Task。

### 方法学与文档

- AIGV 方法学更新至 2.1，补充 W0-W3、任务级上下文、渐进式诊断、证据身份、Formal 义务分级和行动型验证态势。
- 新增验证态势工程使用指南和 MoonGlass 新手使用介绍。
- `docs` 下公开 HTML 文档改为中文可读文件名，GitHub Pages 固定入口 `index.html` 除外。

## 下载与校验

- 绿色版：`MoonGlass-0.9.7-Windows-x64-Green-v0.9.7-20260915.zip`
- SHA-256：`E741123159404182CBCCD22253B89AD25D5AD7EC9408EC7A8881E8DA878BC652`

完整解压后运行 `MoonGlass.exe`。不要直接在压缩包预览窗口中启动。

## 公开范围

公开仓库提供产品 UI、国际化资源、共享类型、六阶段流程框架、用户文档和方法学资料。完整 Agent、EDA、RTL 解析和质量执行实现不在公开源码范围内；完整可用能力通过绿色版提供。详见 `PUBLIC-SOURCE-SCOPE.md`。

MoonGlass 为 Source Available 软件。商业用途、私有部署和企业级 AIGV/EDA 集成请联系 `moonglassagent@126.com`。
