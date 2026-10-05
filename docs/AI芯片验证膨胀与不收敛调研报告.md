# AI 辅助芯片验证中的状态空间膨胀与验证不收敛问题调研报告

> 调研范围：2024–2026 年 ArXiv 论文及相关会议（DATE、DVCon、ICCAD、HLDVT 等）
> 生成日期：2026-10-04

---

## 目录

1. [背景与问题界定](#1-背景与问题界定)
2. [问题一：状态空间膨胀（State Space Explosion）](#2-问题一状态空间膨胀)
3. [问题二：验证无法收敛（Non-Convergence）](#3-问题二验证无法收敛)
4. [原因分析](#4-原因分析)
5. [方法盘点（按技术路线）](#5-方法盘点)
6. [综合对比与判断](#6-综合对比与判断)
7. [参考文献](#7-参考文献)

---

## 1. 背景与问题界定

芯片验证（RTL 设计验证、形式化验证、覆盖率驱动验证）是 EDA 流程中耗时最长、成本最高的环节。随着 LLM/AI 技术进入验证领域，近年论文反复报告两类结构性失败模式：

| 编号 | 问题 | 典型表现 |
|------|------|----------|
| A | **状态空间膨胀** | 形式化验证引擎在设计规模扩大后状态爆炸，无法完成证明或内存溢出 |
| B | **验证无法收敛** | ① 形式化引擎证明目标迟迟无法 discharge；② 仿真/模糊测试覆盖率曲线平台期；③ **假收敛**——断言错误导致空真（vacuous）通过或过度约束压掉真实反例 |

这两类问题相互纠缠：状态爆炸导致引擎不收敛，而 AI 生成断言的质量缺陷又会造成"形式上看已收敛、实际未验证"的假收敛。

---

## 2. 问题一：状态空间膨胀

### 2.1 现象

- 形式化方法虽承诺穷举检查，但"often struggle with **state space explosion** in large-scale designs"，工业规模 SoC 上难以直接应用（ChipFuzzer, arXiv 2507.10340, Jul 2025）。
- 基于 SVA 断言的形式验证 "often encounters **state space explosion** in complex designs"，且构建准确 SVA 本身就需要大量专家知识（VerilogLAVD, arXiv 2508.13092）。
- 传统断言挖掘方法（GOLDMINE 类）因静态分析复杂度与状态爆炸 "fail to scale to **large industrial designs**"（AssertLLM, arXiv 2511.16010）。
- 即使比随机 fuzzing 强得多的 concolic testing，也可能因 solver timeout 或状态爆炸无法触达某些合法分支（arXiv 2603.11489）。

### 2.2 设计侧固有根因

1. **Bit-blasting 掩盖高层语义**：bit-level PDR 在 datapath 密集设计上表现差，位展开后证明相关的字级（word-level）关系被淹没（LLM4PDR, arXiv 2609.30131）。
2. **深流水线与证明引理缺失**：深 pipeline 中收敛依赖 frame lemma 的发现，纯引擎盲目搜索代价极高。
3. **硬件并发状态空间本质复杂**：控制 + 数据通路混合设计的状态关系难以穷举。

### 2.3 AI 引入的放大因素

- LLM 生成的激励/testcase 早期吞吐低，无法在爆炸空间中快速铺开（推理延迟）；
- LLM 对超长漏洞 trace 的推理受 **context window** 限制（arXiv 2512.13520）；
- 生成质量不过关导致反复返工，等效放大了需要探索的状态空间。

---

## 3. 问题二：验证无法收敛

### 3.1 三种典型表现

**① 形式化引擎不收敛（真不收敛）**
证明目标无法 discharge，deep pipeline、control+datapath 混合设计尤其严重。LLM4PDR 指出 word-level PDR 的性能瓶颈在于"discovering proof-relevant word-level relations"——找不到关键谓词/引理，引擎就原地打转。

**② 覆盖率平台期（仿真侧不收敛）**
约束随机验证（CRV）覆盖率曲线早早饱和，corner case 触达不到；人工调约束成本高（arXiv 2503.11666）。

**③ 假收敛（最危险）**
- **空真断言（vacuous assertion）**：LLM 生成的断言语法/语义错误，在任何场景下都"通过"，形式上看收敛、实际什么都没验证。LASA（arXiv 2506.17865）将空真分为两类：
  - *非空真但过强*（non-vacuous but overly restrictive）：假设比 RTL 实际行为更严，断言虽非空真却压制了合法行为；
  - *空真*（vacuous）：前置条件永远不成立，断言恒真。
- **过度约束（overconstraint）**：AI 生成的 assumption 若比 RTL 行为更严，会静默压制合法 CEX，造成验证"收敛"的假象（DVCon EU 2025 教程）。
- **信号幻觉（signal hallucination）**：LLM 编造目标 RTL 中不存在的端口名，产出物不可信（AutoTrans, arXiv 2609.10057）。

### 3.2 具体证据（近年实证结果）

| 来源 | 发现 |
|------|------|
| DATE 2025 系统评测（Pulavarthi et al., arXiv 2502.20633） | COTS LLM 生成的断言有相当比例**语法和语义错误**，结论："COTS LLMs are not yet ready for prime-time adoption for assertion generation"；微调后的 AssertionLLM 语法/语义正确率显著提升 |
| 蜕变测试（Robustness of LLM-Generated SVA, arXiv 2609.05658） | 对语义保持的 RTL 变换（操作数换序、标识符改名、冗余括号），**9.7%–27.0%** 原本正确的行为会变错；单个标识符重命名即可让 19.5% 的正确断言翻转。失败模式：路径谓词丢失、分支极性错误、布尔结构损坏、输出契约违反 |
| 输出不可复现（AutoTrans） | LLM 翻译断言会随模型更新甚至同版本内波动，需固定 prompt 模板与推理参数保证**字节级一致** |
| Agentic 流程（arXiv 2507.02660） | 简单设计 1–2 轮迭代收敛（Timer 1 轮、FIFO 2 轮），复杂设计 ECC 需 3 轮且仍需人工移除 placeholder、给出设计相关反馈；LLM 的"inherent non-determinism requires rigorous verification loops" |
| 早期吞吐瓶颈（ChipFuzzer, arXiv 2507.10340） | LLM 生成 testcase 在 fuzzing 早期覆盖增长慢于变异式 baseline（推理延迟），但后期突破平台期能力更强 |

---

## 4. 原因分析

### 4.1 设计固有原因

1. **位展开丢语义**：datapath 密集设计在 bit-level 表示下，证明相关的高层关系不可见；
2. **深流水线状态相关性**：收敛依赖 frame lemma 发现，搜索空间巨大；
3. **硬件状态空间指数级增长**：并发、复位域、时钟域交叉进一步放大。

### 4.2 AI/LLM 引入的新原因

1. **生成质量不过关**：语法/语义错误 → 空真证明 → 假收敛（§3.2 表格）；
2. **输出不稳定/非确定性**：语义等价变换下结果翻转；验证产物不可复现，回归环境无法接受；
3. **幻觉**：编造信号名、端口名；超长 trace 超出 context window；
4. **过度约束与假设过强**：压制合法 CEX；
5. **推理延迟**：仿真/fuzzing 早期吞吐瓶颈。

### 4.3 流程侧原因

- CRV 依赖大量冗余回归迭代，覆盖率收敛靠人工调约束（arXiv 2503.11666）；
- 端到端 agentic 流程缺少人在环兜底，复杂设计无法自主收敛（arXiv 2507.02660）。

---

## 5. 方法盘点

### 路线 1：LLM + 形式化引擎的"语义引导"混合方法

**思路**：LLM 当"搜索向导"出候选，形式引擎当"裁判"做验证，避免纯引擎盲目搜索。这是针对**状态爆炸 + 引擎不收敛**最直接的对策。

**代表工作：LLM4PDR**（arXiv 2609.30131, Sep 2026）
- 三种机制：
  1. **Predicate Generation**：归纳泛化时从状态关系中提取候选谓词；
  2. **Clause Generation**：生成候选 frame lemma，经验证后加速收敛（对深 pipeline 最有效）；
  3. **Assertion Generation**：合成辅助断言加强目标性质，配合 CEGAR（反例引导精化）。
- 结果：33 个算术基准解出 28 个，原版 Pono 仅 13 个、AVR 11 个；HLS pipeline 和开源 RTL 上不同模式互补加速。

**代表工作：Saarthi / Search**（arXiv 2502.16662, Feb 2025；DVCon US 2025）
- GenAI 增强的归纳式形式验证：归纳步失败时自动生成 helper assertion 与 lemma，将"AI 直觉 + 形式严谨"流水线化，提升 verification throughput。

### 路线 2：形式收敛辅助的标准工具箱

来自 DVCon EU 2025 教程（arXiv 2504.18983）的工业界共识：

| 技术 | 作用 |
|------|------|
| 输入约束 | 限制参数范围（如 AXI burst size） |
| 状态抽象 | 剔除与性质无关的 debug 寄存器/计数器 |
| 模块分解 | assume-guarantee 切分 |
| 性质分域 | 按时钟域/复位条件限定范围 |
| **过度约束检测** | 防止 assumption 压制合法 CEX |

### 路线 3：保真度闭环检查（针对假收敛）

- **空真自检**：LASA（arXiv 2506.17865）用 **9 条空真判定规则**让 LLM 检查生成性质是否 non-vacuous，并自动分析 CEX 迭代修改断言/约束；
- **引擎反馈闭环**：LLM 从形式引擎的 vacuity 警告、CEX trace 实时学习并精化断言与约束（DVCon EU 2025）；
- **可复现性工程**：AutoTrans（arXiv 2609.10057）用正则信号提取消除信号幻觉 + 固定 prompt 模板与推理参数，保证模型更新后输出字节级一致；
- **蜕变测试评估**（arXiv 2609.05658）：在语义保持变换下评测断言生成鲁棒性，暴露单点准确率掩盖的不稳定性。

### 路线 4：覆盖率驱动的智能激励生成（针对覆盖率平台期）

- **LLM 语义 fuzzing：ChipFuzzer**（arXiv 2507.10340）
  - 双阶段工作流（覆盖引导 + bug 引导），用控制流相似度和差异分析引导 LLM 生成定向 testcase；
  - 三个开源 CPU 上平均条件覆盖提升 **5.8 个点**、bug 检出率提升 **21.1 个点**；
  - 关键发现：与变异式 fuzzer **互补**——早期用变异式快速铺开，后期 LLM 突破平台期。
- **覆盖率反馈的偏好优化：TB or Not TB**（arXiv 2511.15767）
  - Coverage-Driven DPO 微调激励生成模型，PairaNet 数据集用仿真覆盖标注高低质量 testbench 对；
  - CVDP CID12 基准上代码覆盖最高提升 **77.27%**。
- **监督学习压缩回归**：PyUVM + scikit-learn 预测哪些测试能补覆盖，以 **99%+ 覆盖 regain** 大幅削减仿真轮次（arXiv 2503.11666）。

### 路线 5：领域化模型与结构化上下文（针对生成质量根源）

- **专用微调模型**：AssertionLLM（arXiv 2502.20633）——首个断言生成专用微调模型，显著提升语法/语义正确率；
- **结构增强 prompt**：提供 CDFG / 变量依赖图帮助 LLM 理解硬件数据流（AssertLLM, arXiv 2511.16010）；
- **静态分析引导挖掘**：AssertMiner 用静态分析引导 LLM 断言挖掘；STELLAR 做结构感知断言检索（arXiv 2603.22140）。

### 路线 6：Agent 化流程 + 人在环（针对端到端不收敛）

- 多智能体 + HITL 流程（arXiv 2507.02660）：简单设计 1–2 轮迭代收敛，复杂设计（ECC）需 3 轮，仍需人工移除 placeholder、给出设计相关反馈；专门的 coverage agent 在覆盖不达标时迭代生成补充性质；
- 知识图谱/结构图作为 agentic formal verification 的"缺失环节"，缓解纯 LLM 推理的不稳定性（arXiv 2605.06434）。

---

## 6. 综合对比与判断

### 6.1 问题 × 根因 × 方法对照表

| 问题 | 根因 | 当前最有效的方法 |
|------|------|------------------|
| 状态空间爆炸 | 设计复杂度 + bit-blasting 丢语义 | LLM 引导字级 PDR（谓词/子句/辅助断言）、assume-guarantee 分解、状态抽象 |
| 引擎不收敛 | 深 pipeline 缺 frame lemma、归纳步失败 | GenAI 生成 helper assertion / lemma + CEGAR 迭代 |
| 假收敛（vacuous / overconstraint） | LLM 断言质量差、约束过严 | 空真规则自检、CEX 分析闭环、过度约束检测、引擎反馈学习 |
| 覆盖率平台期 | 随机激励语义盲目 | LLM 语义 fuzzing（与变异式互补分阶段）、CD-DPO、ML 回归裁剪 |
| 结果不可复现 | LLM 非确定性、信号幻觉 | 信号提取防幻觉、固定 prompt/参数、蜕变测试评估、微调专用模型 |

### 6.2 总体趋势判断

1. **"LLM 生成 + 一次性形式检查"被证伪**：假收敛、不稳定、不可复现，无法进入工业回归；
2. **主流范式收敛为闭环混合架构**：`LLM 出候选 → 引擎/仿真做裁判 → 覆盖/空真做反馈 → 人在关键节点兜底`；
3. **完全自主 AI 验证工程师尚不可行**：最强 agentic 流程在复杂设计上仍需人工干预；
4. **社区共识**：AI 输出必须 "grounded in simulation evidence, formal reasoning, and benchmark-driven evaluation"（ChipFuzzer）；
5. **互补优于替代**：LLM 语义 fuzzing 与变异式 fuzzer 分阶段互补是当前最实用的落地形态。

---

## 7. 参考文献

| # | 论文 | ArXiv / 出处 | 时间 |
|---|------|--------------|------|
| 1 | Enhancing Word-Level PDR with LLM-Driven Semantic Guidance (LLM4PDR) | arXiv:2609.30131 | 2026-09 |
| 2 | Robustness of LLM-Generated SystemVerilog Assertions to Semantics-Preserving RTL Transformations | arXiv:2609.05658 | 2026-09 |
| 3 | AutoTrans: AI-Assisted Automatic Translation of Security Assertions for RISC-V | arXiv:2609.10057 | 2026-09 |
| 4 | Knowledge Graphs, the Missing Link for Agentic AI Formal Verification | arXiv:2605.06434 | 2026-05 |
| 5 | Trace-aware causal fix generation for hardware fuzzing | arXiv:2603.11489 | 2026-03 |
| 6 | STELLAR: Structure-aware Assertion Retrieval | arXiv:2603.22140 | 2026-03 |
| 7 | ChipFuzzer: Coverage-guided and Bug-guided Test Case Generation | arXiv:2507.10340 | 2025-07 |
| 8 | Agentic AI for HW Design & Verification: HITL Approach | arXiv:2507.02660 | 2025-07 |
| 9 | LASA: LLM-Aided Specification and Assertions | arXiv:2506.17865 | 2025-06 |
| 10 | GenAI in Formal Verification Workflows: A Tutorial | arXiv:2504.18983 (DVCon EU 2025) | 2025-04 |
| 11 | Search: The First AI Formal Verification Engineer (Saarthi) | arXiv:2502.16662 | 2025-02 |
| 12 | Are LLMs ready for practical adoption for assertion generation? | arXiv:2502.20633 (DATE 2025) | 2025-02 |
| 13 | VerilogLAVD: LLM-Assisted Vulnerability Detection | arXiv:2508.13092 | 2025-08 |
| 14 | TB or Not TB: Coverage-Driven DPO for Verilog Stimulus Generation | arXiv:2511.15767 | 2025-11 |
| 15 | AssertLLM: Assertion Mining using LLM | arXiv:2511.16010 | 2025-11 |
| 16 | Optimizing Coverage-Driven Verification Using ML and PyUVM | arXiv:2503.11666 | 2025-03 |

---

*报告完*
