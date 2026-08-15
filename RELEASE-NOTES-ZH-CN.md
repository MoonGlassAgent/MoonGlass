# MoonGlass v0.4.3

本版本聚焦开发过程可控性、项目可迁移性和大规模 IP 库复用能力。

## 主要更新

- 新增浅色、深色和跟随系统主题。
- 同一轮多个 Agent 确认项可全部选择后一次提交。
- 项目支持迁移到新的指定目录，复制校验成功后才切换路径，并保留原目录。
- Pi Coding Agent 内核升级到 `0.84.1`。
- IP 库支持从一个目录递归发现多个 RTL IP、VIP、BFM 和验证组件。
- IP 索引补充协议、接口角色、组件用途与识别置信度。
- 新增 Pi 语义增强以及 `ip_search`、`ip_inspect` 检索能力。
- 修复 Pi 语义分析 JSON 流式输出不完整导致的解析失败。

## 下载与启动

下载 `MoonGlass-0.4.3-Windows-x64-Green-r8-MIC_NPU-Demo-*.zip`，完整解压后运行 `MoonGlass.exe` 或 `Start-MoonGlass.bat`。首次使用请在“设置”中配置自己的模型服务。

绿色版将完整 Pi Agent 运行时封装为单一 ASAR，共 443 个文件，避免展开数千个依赖文件，并保留 MIC_NPU Demo。

压缩包不包含 API Key、模型账号配置和 Agent 会话。请使用 `SHA256SUMS.txt` 校验下载文件。

## 授权

MoonGlass 是 Source Available 软件。非商业使用遵循 PolyForm Noncommercial License 1.0.0；商业使用须另行取得书面授权。联系：`moonglassagent@126.com`。
