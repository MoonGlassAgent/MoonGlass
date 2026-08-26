---
name: formal-verification
description: Create and run evidence-grounded open-source formal verification with SymbiYosys. Use for bounded checks, invariant proof, reachability, counterexamples, protocol properties, and formal candidates from Verification Intelligence scenarios.
---

# 开源 Formal 验证

在 `verification/formal/` 下创建独立 harness/property 文件，不修改交付 RTL 来隐藏问题。

## 必须遵守

1. 先读取 Scenario、Specification Fact、RTL Fact、COI 和协议规则。属性必须绑定 `SCN-*`，不能从风险标题直接臆造期望。
2. 将环境约束写成最小 `assume` 集合，将设计义务写成 `assert`，将目标可达性写成 `cover`。在文件头逐条说明每个 assumption 的规格依据。
3. OSS Yosys 只使用其支持的可综合/形式化 SystemVerilog 子集。高级 SVA 不受支持时，改写为监控寄存器和 immediate `assert/assume/cover`；禁止删除属性后宣称通过。
4. 先运行 `bmc` 找浅层反例，再运行 `cover` 检查场景是否可达；适合不变量时才运行 `prove`。
5. 调用 `run_formal_verification`，传入 harness top、RTL、property 文件、mode、depth、solver 与 Scenario ID。
6. 解读状态：
   - `bmc PASS`：仅表示配置深度内无反例，不能叫“已证明”。
   - `prove PASS`：在当前模型和 assumptions 下归纳证明成功。
   - `cover PASS`：目标可达，不代表安全属性成立。
   - `FAIL`：读取 VCD/YW 反例，判断是 RTL 缺陷、属性错误还是过弱/过强环境模型。
7. 将 `formal-result.json`、日志、property、assumption review 和 trace 纳入质量证据；修改属性或 assumptions 后必须重新运行。

## 推荐目录

```text
verification/formal/
  <module>_formal.sv
  assumptions_review.md
  results/<task>/formal-result.json
```
