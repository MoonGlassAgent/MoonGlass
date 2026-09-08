# MoonGlass v0.6.0

本版本重点增强主会话的端到端验证交付能力，并完善项目报告、会话恢复和文件阅读体验。

## 主要更新

- Cocotb + Icarus 负责功能回归与功能覆盖率，Verilator C++ 负责 RTL 行、条件/表达式、翻转和 FSM 覆盖率。
- 同一模块的双通道验证结果合并到统一结构化结果，分别保留编译、仿真、JUnit、覆盖率原始数据和中文报告。
- 新增独立验证证据 Review，直接审查测试源码、JUnit、日志、结果和覆盖率，不接受 Agent 自述替代签核证据。
- `VERIF -> QA` 门禁加入行覆盖率、条件/表达式覆盖率、功能覆盖率和证据审查要求。
- 项目信息可后续编辑；总体报告扩展阶段门禁、交付物、验证运行、覆盖率、综合结果、遗留风险和产物索引。
- 修复重启后的会话模型显示，文件查看器新增稳定的 `Ctrl+F` 查找、匹配计数和前后跳转。
- 保留一键托管、受控变更、已有项目阶段恢复、深色/跟随系统主题、项目迁移、IP 库发现与 Pi 语义增强能力。
- Pi Coding Agent 内核为 `0.84.1`。

## 下载与启动

下载 `MoonGlass-0.6.0-Windows-x64-Green-r6-MIC_NPU-Demo-20260823.zip`，完整解压后运行 `MoonGlass.exe` 或 `Start-MoonGlass.bat`。首次使用请在“设置”中配置自己的模型服务。

绿色版将完整 Pi Agent 运行时封装为单一 ASAR，程序目录共 459 个文件，避免展开数千个依赖文件，并保留 MIC_NPU Demo。

压缩包不包含 API Key、模型账号配置和 Agent 会话。请使用 `SHA256SUMS.txt` 校验下载文件。

## 授权

MoonGlass 是 Source Available 软件。非商业使用遵循 PolyForm Noncommercial License 1.0.0；商业使用须另行取得书面授权。联系：`moonglassagent@126.com`。
