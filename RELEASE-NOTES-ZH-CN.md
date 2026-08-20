# MoonGlass v0.5.0

本版本聚焦流程自动托管、工程接续开发、变更闭环和代码阅读体验。

## 主要更新

- 新增“一键托管”，可选择连续的后续阶段，由 Agent 自动处理推荐项、推进门禁和有限次数修复重试，完成后生成完整报告。
- 新增受控变更流程：需求、规格或缺陷发生变化后，可记录影响范围并驱动已完成阶段逐级响应。
- 导入已有项目时自动分析目录、文档、RTL、验证、质量与综合证据，恢复实际开发阶段，并生成分析报告。
- 文本文件查看器升级为 Monaco Editor，支持行号、语法高亮、自动换行、字号调节和复制。
- 修复深色模式下标题栏、工程控制台和空状态区域颜色不一致的问题。
- 保留深色/跟随系统主题、项目迁移、大规模 IP 库发现与 Pi 语义增强能力。
- Pi Coding Agent 内核为 `0.84.1`。

## 下载与启动

下载 `MoonGlass-0.5.0-Windows-x64-Green-r6-MIC_NPU-Demo-20260820.zip`，完整解压后运行 `MoonGlass.exe` 或 `Start-MoonGlass.bat`。首次使用请在“设置”中配置自己的模型服务。

绿色版将完整 Pi Agent 运行时封装为单一 ASAR，共 457 个文件，避免展开数千个依赖文件，并保留 MIC_NPU Demo。

压缩包不包含 API Key、模型账号配置和 Agent 会话。请使用 `SHA256SUMS.txt` 校验下载文件。

## 授权

MoonGlass 是 Source Available 软件。非商业使用遵循 PolyForm Noncommercial License 1.0.0；商业使用须另行取得书面授权。联系：`moonglassagent@126.com`。
