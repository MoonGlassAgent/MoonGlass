# MoonGlass v0.4.0 首次公开发布

这是 MoonGlass ASIC Design Agent 的首次 GitHub 发布。

## 主要能力

- 六阶段 ASIC IP 开发流程与阶段状态管理
- 需求-规格合并定义及需求-规格矩阵
- 主会话和平行会话独立模型选择
- Agent 思考、工具调用与流式过程展示
- 前序阶段变更影响传播和逐阶段变更响应
- IP 库、工艺库、脚本、项目文件和质量证据管理
- RTL Design Browser、EDA 检测、验证和综合工作流
- Windows 绿色版内置 MIC_NPU Demo

## 下载与启动

下载 `MoonGlass-0.4.0-Windows-x64-Green-r7-MIC_NPU-Demo-*.zip`，完整解压后运行 `MoonGlass.exe` 或 `Start-MoonGlass.bat`。首次使用请在“设置”中配置自己的模型服务。

r7 将完整 Pi Agent 运行时封装为单一 ASAR，解压后的绿色版共 407 个文件，避免展开数千个依赖文件。

压缩包不包含 API Key、模型账号配置和 Agent 会话。请使用 `SHA256SUMS.txt` 校验下载文件。

## 授权

MoonGlass 是 Source Available 软件。非商业使用遵循 PolyForm Noncommercial License 1.0.0；商业使用须另行取得书面授权。联系：`moonglassagent@126.com`。
