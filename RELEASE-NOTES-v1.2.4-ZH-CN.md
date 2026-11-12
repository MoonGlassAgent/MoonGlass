# MoonGlass v1.2.4 发布说明

MoonGlass v1.2.4 新增流程看板，并打通架构/RTL Review 到原会话修改的自动闭环。本版适合用于完整项目的用户测试：既能观察长程任务如何推进，也能减少 Review 完成后仍需手工催促修改的断点。

## 主要更新

### 流程看板

- 工作区头部新增「流程看板」入口，按 REQ_SPEC、ARCH、RTL、VERIF、QA、SYNTH 六阶段展示任务。
- 统一呈现验证批次、RTL 修复、设计评审、模块 UT、人工决策和验证外循环六类任务。
- 任务状态、起止时间、判定结果与多次尝试记录集中展示；尝试记录包含所用模型和备注。
- 采用现代控制平面式布局：阶段色点、状态徽标、任务卡片与尝试时间线，便于快速定位正在运行、等待人工和已完成的任务。

### Review → Update 自动闭环

- 架构一致性与 RTL 语义 Review 完成后，自动把报告路径、待处置 major 数和处置要求投递到原设计/RTL 会话。
- 原会话在线时始终回到原会话，保留既有设计上下文；只有原会话已关闭或不在线时，才创建独立更新会话。
- 不把「已投递」误判为「已修改」：系统读取跨轮合并后的 Review 清单，确认 pending major 下降或归零后才完成本轮闭环。
- pending major 归零后自动重跑阶段门禁，但不自动推进阶段；多轮后仍有待处置项时暂停并交给工程师处理。
- 通过消费闸、活跃实例守卫和请求幂等避免重复派发。

### 验证可靠性修复

- 补齐 `BLOCKED_BY_SPEC` / `WAIVED` 场景的修复派单门控：已具名裁决的终局场景即使出现新的 FAIL 证据，也不会再误触发 RTL 修复会话。
- FAIL 证据仍正常登记；只有裁决发生变化后，才重新评估是否允许派单。

## 验证

- `pnpm typecheck`：全部 workspace 包通过。
- 核心测试：57 个脚本全部通过，包含看板模型、看板页面、Review 闭环、派单过滤和波形保护等回归。
- 绿色版打包包含 Pi 运行时版本检查、内置 AIGV 工具链检查和打包 EXE 主进程真实启动自检。
- 内置 Pi Coding Agent 1.5.2。

## Windows 绿色版

- 便携数据保存在程序目录 `userdata`，不写入系统默认 MoonGlass 数据目录。
- 内置 MIC_NPU 演示项目；不包含 API Key、模型账号配置或 Agent 会话。
- 完整解压后运行 `MoonGlass.exe` 或 `Start-MoonGlass.bat`，首次使用请在设置中配置模型服务。
- ZIP：`MoonGlass-1.2.4-Windows-x64-Green-v1.2.4-20261112.zip`
- 大小：约 337.3 MB（353,710,647 bytes）
- 展开文件数：526
- SHA-256：`6DB75E7ADBF646E6BF3DFD0D674D3578E7EDB8272F14AC6081302E744A106102`

## 下载

- GitHub Release：`https://github.com/MoonGlassAgent/MoonGlass/releases/download/v1.2.4/MoonGlass-1.2.4-Windows-x64-Green-v1.2.4-20261112.zip`
