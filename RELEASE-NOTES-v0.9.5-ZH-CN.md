# MoonGlass v0.9.5 发布说明

MoonGlass v0.9.5 是一次聚焦工程可用性、工具链部署韧性、模型上下文准确性与验证闭环可靠性的增量发布。它延续六阶段 ASIC IP 开发流程和 AIGV 2.0 方法学，并针对真实项目中的安装失败、工具误判、长上下文显示和验证证据一致性问题进行了集中修正。

## 主要更新

### EDA 工具一键安装与即时刷新

- 设置页支持对缺失的可管理 EDA 工具执行一键安装，并展示安装计划、来源、进度和结果。
- 安装完成后立即重新检测开发环境与 EDA 工具链，无需重启 MoonGlass。
- 修正 Verible Windows 发布资产识别和可执行文件目录归一化问题。
- 网络受限时支持 GitHub 下载镜像回退，提高 Verible 与 OSS CAD Suite 的安装成功率。

### 深色模式与界面一致性

- 补齐设置、会话、验证态势及工程状态区域的深色模式适配。
- 改善长文本、状态标签、工具输出与上下文信息在深色主题下的对比度和可读性。

### 模型上下文窗口

- 模型上下文窗口配置贯通界面、Provider 注册与 Agent 运行层。
- 按具体模型展示上下文容量和占用状态，减少统一回退值导致的错误提示。
- 更新主流模型登记信息；未知模型不再显示缺乏依据的精确占用比例。

### AIGV 与 EDA 稳定性

- 修正验证意图、场景、覆盖缺口和证据状态之间的若干一致性问题。
- 加强 CDC、Formal、仿真与综合结果的分类，避免工具限制或解析失败被误判为 RTL 缺陷。
- 改善波形产物体积治理：超限时停止继续生成，并保留可解释的失败状态和已有证据。
- 完善追溯矩阵 ID 诊断，降低章节、版本记录或其他命名空间被误识别为需求/规格映射的概率。

## 下载与校验

- Release：<https://github.com/MoonGlassAgent/MoonGlass/releases/tag/v0.9.5>
- 文件：`MoonGlass-0.9.5-Windows-x64-Green-v0.9.5-20260911.zip`
- 大小：358,128,369 字节，约 342 MB
- ZIP 条目：611
- SHA-256：`1790952423EDEF5954038D67B221746CBE1ECD8BFB87EAEA8B421F87E0639241`

完整解压后运行 `MoonGlass/MoonGlass.exe`。首次使用请在“设置”中配置自己的模型服务，并检查开发环境与 EDA 工具链状态。

## 公开源码范围

本仓库继续按既定边界公开 MoonGlass 产品 UI、国际化资源、共享类型、公共 IPC 契约、六阶段流程表达和工程/学术文档。

完整 Agent、AIGV/EDA/RTL 后台执行实现、Pi 运行时、内置工具链、Demo 源工程、客户代码、API Key、用户配置和会话数据不进入公开源码仓库。完整可运行能力通过 GitHub Release 中的 Windows 绿色版提供。详情见 [`PUBLIC-SOURCE-SCOPE.md`](./PUBLIC-SOURCE-SCOPE.md)。

## 可靠性交付边界

MoonGlass 通过需求/规格、Verification Intent、场景、Checker/Golden Model、测试日志、覆盖率、Formal 结果和残余风险记录形成机器签核建议，但不承诺绝对零缺陷，也不替代商业 EDA sign-off 与具备职责和授权的工程师最终签核。

## 授权与联系

MoonGlass 为 Source Available 软件。非商业使用遵循 PolyForm Noncommercial License 1.0.0；商业使用须取得书面授权。

作者、商业合作、技术支持与产品建议：`moonglassagent@126.com`
