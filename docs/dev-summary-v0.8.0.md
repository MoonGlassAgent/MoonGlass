# MoonGlass 开发进度说明 — v0.8.0（最新开发报告）

> **日期**：2026-08-31  
> **代码分支**：`feature/rtl-design-browser`  
> **前一份报告**：[`dev-summary-v0.3.md`](./dev-summary-v0.3.md)  
> **设计依据**：根目录 `ChipForge_Studio_Specification.md`

## 1. 当前结论

MoonGlass 已从 v0.3 的“Agent 对话 + 基础 EDA 门禁”原型，演进为包含六阶段流程、
Pi Coding Agent、阶段会话隔离、一键托管、真实 RTL/仿真/综合工具、AIGV 2.0 验证闭环与
验证态势展示的 ASIC Agent 工作台。

当前版本最重要的变化不是继续增加 Agent 提示词，而是把长时间芯片开发中的上下文、状态、
验证证据和失败恢复纳入工程控制。需要特别说明：**功能实现、局部验证通过和正式发布签核是
三个不同状态**。当前工作区仍有第三方修改和待收敛项，本报告不把它们表述为已经发布的
绿色版本。

## 2. 从 v0.3 到 v0.8.0 的主要演进

| 领域 | v0.3 | v0.8.0 当前状态 |
|------|------|-----------------|
| Agent 会话 | 单会话跨阶段连续 | 六阶段会话隔离，阶段切换恢复各自历史 |
| 长上下文控制 | 依赖人工新建会话 | 上下文压缩、新鲜重启、流式输出与 UI 容量保护 |
| 阶段清理 | 清理后可能立即重启 | 垃圾桶只删除阶段产物与会话；后续输入或托管再按需启动 |
| Agent 工具 | schema/桩为主 | RTL lint、综合、仿真、CDC、测试台等工具进入真实闭环 |
| 验证 | 单项门禁和覆盖率阈值 | AIGV 2.0：Verification Space、Multi-Oracle、Mutation、Residual Risk |
| 验证流程 | 一次性运行 | 规划、环境、基线回归、风险闭环四步流程 |
| 运行诊断 | 日志为主 | 分级诊断、完成屏障、验证态势与原子状态快照 |
| RTL 质量 | 文件级 lint 为主 | 向全设计编译/elaboration 和声明顺序约束收敛 |

## 3. 当前能力地图

- Electron + React 19 工作台，支持项目管理、六阶段状态机、文件树、代码/Markdown 查看和阶段门禁。
- Pi Coding Agent RPC 运行时，支持多 Provider、模型切换、工具调用、思考过程和会话持久化。
- 一键托管可以根据阶段状态继续执行、触发门禁、尝试修复并形成阶段报告。
- EDA 桥接覆盖 Verible/Verilator lint、Yosys 综合、Icarus/Verilator 仿真及基础 CDC 检查。
- RTL Engine 支持 RTL 解析、设计信息提取和模板生成；IP 库已有可运行的 smoke 样例。
- AIGV 验证智能引擎记录场景、Oracle、探索轮次、变异、剩余风险和签核建议。
- 验证态势页面展示结构化验证状态，避免仅凭聊天文本或单条 PASS 判断阶段完成。

## 4. 阶段会话与长时 Agent 工程

现在每个项目的 `REQ_SPEC / ARCH / RTL / VERIF / QA / SYNTH` 分别维护 Pi JSONL 会话。
切换阶段时只恢复目标阶段的历史；新阶段可继承模型选择，但不继承此前阶段的全部对话。
并行任务、主会话和 fresh restart 使用独立命名空间，降低上下文串扰风险。

阶段垃圾桶采用“只删除、不自动重启”的语义：停止该阶段活动及后台 Agent，删除阶段产物、
主/并行/重启会话档案，同时保留 Provider 和模型选择。用户再次输入或启动一键托管时，
系统才惰性创建新的阶段会话。

针对长运行任务，还增加了以下保护：

- 对超长历史进行结构化压缩，而不是无限回放原始消息。
- 模型输出达到长度边界但没有工具动作时，不直接判定工作完成。
- 对部分模型“推理耗尽输出预算、零工具调用”的行为进行兼容和失败收敛。
- UI 对历史消息、流式字符数和渲染恢复设置边界，防止前端被超长会话拖垮。

## 5. AIGV 2.0 验证闭环

AIGV 2.0 将“测试通过”扩展为可追踪的工程证据体系：

1. **Verification Space**：从接口、状态、时序、数据和异常等维度描述已探索与未探索空间。
2. **Scenario**：以结构化场景状态记录刺激、前置条件、检查点、结果和对应 RTL 哈希。
3. **Multi-Oracle**：把参考模型、断言、协议规则、形式验证等独立判定域分开，显式暴露冲突。
4. **Novelty Saturation**：按轮次评估新覆盖、新状态和新失败是否趋于饱和。
5. **Risk-weighted Mutation**：优先攻击高风险边界，并记录仍未消除的 Residual Risk。
6. **Signoff Package**：输出可审计的证据包和机器签核建议，而不是只输出一句 PASS。

VERIF 阶段据此拆为验证规划、环境准备、基线回归和风险闭环四步。形式验证结果也区分
证明、反例、未知、工具失败以及是否需要补充证据，避免把“工具运行结束”等同于“设计正确”。

## 6. RTL 与 EDA 质量控制进展

MoonGlass 已确认文件级 lint 不足以发现跨文件 elaboration 缺陷。当前工作区正在把 lint
入口升级为“完整 RTL 文件集 + include/library 参数 + top module”的全设计检查，并补充
Verilog 声明先于使用的静态规则，以覆盖 wire/reg 晚声明和动态 part-select 等常见生成式缺陷。

针对 MoonGlass_NPU 的最新本地检查已经能够加载 9 个设计文件、1 个 library 文件并以
`npu_top` 为顶层完成检查；当前结果为 0 个 error、60 个 warning。这个结果说明编译级错误已
被暴露和处理，但 warning 尚未清零，因此不能把它写成 RTL 正式签核完成。

## 7. 验证状态与边界

近期局部验证包括：

- `node scripts/eda-gate-smoke.mjs`：通过。
- `node scripts/pi-tools-smoke.mjs`：通过。
- `pnpm typecheck`：workspace 子包检查通过。
- MoonGlass_NPU 全设计 lint/elaboration：0 error，60 warning。

仍需明确的发布边界：

- 根应用的完整 TypeScript 检查仍存在待修复项，不能宣称全仓 `typecheck` 绿色。
- 第三方工具在当前工作区产生了多处尚未按主题审查、提交的修改。
- v0.8.0 绿色版安装包尚未完成一次干净工作树上的全量构建与安装验证。
- 开源 EDA 工具结果是工程门禁证据，不等价于商业 EDA 流程的流片签核。
- 单条无 TEST ID 的 PASS 不能代表验证阶段完成；签核必须关联场景、Oracle、RTL 哈希和证据。

## 8. 下一阶段优先事项

1. 将当前工作区修改按“会话隔离、阶段清理、验证态势、RTL lint”分主题审查并提交。
2. 清理根应用 TypeScript 错误，重新执行全仓 typecheck、build 和核心 smoke。
3. 为阶段切换、彻底删除、惰性重启和并行会话隔离补充自动回归测试。
4. 清理 MoonGlass_NPU 的 lint warning，并加入顶层 elaboration 必过门禁。
5. 在干净提交上构建并验证 v0.8.0 绿色版，再形成可追溯的发布清单和校验值。
6. 使用多个真实 IP 项目验证 AIGV 的新颖度饱和与剩余风险指标是否稳定、可复现。

## 9. 开发与检查入口

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm build
node scripts/eda-gate-smoke.mjs
node scripts/pi-tools-smoke.mjs
pnpm lint:rtl -- --project <RTL项目目录> --top <顶层模块>
```

## 10. 相关文档

- [`dev-summary-v0.3.md`](./dev-summary-v0.3.md)：上一份开发交接报告。
- [`MOONGLASS-AIGV-METHODOLOGY-ZH-CN.html`](./MOONGLASS-AIGV-METHODOLOGY-ZH-CN.html)：AIGV 方法学。
- [`MOONGLASS-LONG-RUN-AGENT-ENGINEERING-ZH-CN.html`](./MOONGLASS-LONG-RUN-AGENT-ENGINEERING-ZH-CN.html)：长时 Agent 工程学。
- [`paper.html`](./paper.html)：证据驱动 ASIC Agent 工作流。

---

*本报告描述 `feature/rtl-design-browser` 分支与 2026-08-31 当前工作区的实际状态；它是开发交接材料，不是发布签核证书。*
