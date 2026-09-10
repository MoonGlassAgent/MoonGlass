# MoonGlass v0.9.2 发布说明

MoonGlass v0.9.2 是一次面向团队使用、跨语言交付和长时工程稳定性的增量发布。它延续六阶段 ASIC IP 开发流程与 AIGV 2.0 验证方法学，并重点改善界面国际化、文件与会话操作、验证证据新鲜度以及 Windows 绿色版交付。

## 主要更新

### 中英文界面基础

- 新增完整的简体中文与英文界面资源组织，覆盖项目、工作区、阶段、会话、设置、验证态势、设计浏览器、IP 库和知识库等主要页面。
- 界面文案由组件内硬编码逐步迁移到统一语言资源，便于后续维护、校对和扩展其他语言。
- 主题、状态、操作按钮和工程术语在中英文环境中保持一致的语义映射。

### 工作区与文件体验

- 改善项目文件打开、会话内文件引用和 Windows 绝对路径识别，减少盘符被截断或链接无法定位的问题。
- 加强文本查看器的行号、查找、语法高亮和大文件保护，降低打开异常文件导致渲染界面失效的风险。
- 改善主会话、平行会话和文件标签之间的切换体验，并继续保留各会话独立模型选择与恢复能力。

### AIGV 验证与证据治理

- 继续完善 Spec Gap、Verification Intent、Scenario、Coverage Hole、Residual Risk 与签核建议的工程语义。
- 验证态势强调最高风险、缺失证据和下一步动作，避免只展示抽象分类或单一覆盖率数字。
- 强化 RTL 基线与验证证据的新鲜度约束，避免使用与当前 RTL 不一致的历史结果形成错误闭环。
- 多轮调试无收敛时，优先增强 checker、断言和诊断证据，再决定是否继续修改 RTL。

### Agent 与模型服务

- 延续任务级会话、无上下文重启、会话停止、完成屏障和长时运行治理机制。
- 改善 OpenAI 兼容 Provider 的连接测试、模型逐项探活和消息角色兼容性。
- 主会话与平行会话仍可独立选择模型，用于执行与交叉 Review。

### Windows 绿色版

- 提供完整 Windows x64 绿色版，解压后可直接运行，无需安装 MoonGlass。
- 修正 Windows 打包过程中 GNU tar 对盘符路径的误判，统一使用系统 `bsdtar` 生成 ZIP。
- 绿色版不包含用户 API Key、模型账号配置或历史 Agent 会话。

## 下载与校验

- Release：<https://github.com/MoonGlassAgent/MoonGlass/releases/tag/v0.9.2>
- 文件：`MoonGlass-0.9.2-Windows-x64-Green-v0.9.2-20260910.zip`
- 大小：336,543,946 字节，约 321 MB
- ZIP 条目：609
- SHA-256：`6051F77FA73E7206B8ACB4C2E67890DAC66F2B097E9AB376F31F0AB259B7ED78`

完整解压后运行 `MoonGlass/MoonGlass.exe`。首次使用请在“设置”中配置自己的模型服务，并确认开发环境与 EDA 工具链检测结果。

## 公开源码范围

本仓库公开 MoonGlass 产品 UI、国际化资源、共享类型、公共 IPC 契约、六阶段流程表达和工程/学术文档，便于社区阅读、讨论和参与交互改进。

完整 Agent、AIGV/EDA/RTL 后台执行实现、内置工具链、Pi 运行时、MIC_NPU Demo 源工程、客户代码、API Key 和用户数据不进入公开源码仓库。完整可运行能力通过 GitHub Release 中的绿色版提供。详情见 [`PUBLIC-SOURCE-SCOPE.md`](./PUBLIC-SOURCE-SCOPE.md)。

## 可靠性交付边界

MoonGlass 通过需求/规格、Verification Intent、场景、Checker/Golden Model、测试日志、覆盖率、Formal 结果和残余风险记录形成机器签核建议，但不承诺绝对零缺陷，也不替代商业 EDA sign-off 与具备职责和授权的工程师最终签核。

相关问答：[MoonGlass IP 可靠性交付客户问答](./docs/MOONGLASS-IP-RELIABILITY-FAQ-ZH-CN.html)。

## 授权与联系

MoonGlass 为 Source Available 软件。非商业使用遵循 PolyForm Noncommercial License 1.0.0；商业使用须取得书面授权。

作者、商业合作、技术支持与产品建议：`moonglassagent@126.com`
