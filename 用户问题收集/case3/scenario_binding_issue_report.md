# 验证场景"未绑定"问题说明（提交开发团队）

| 项目 | 内容 |
|---|---|
| 文档编号 | BUG-VERIF-BIND-001 |
| 日期 | 2026-09-28 |
| 报告人 | 验证（VERIF 阶段，W3 签核） |
| 项目 | DDR_BIST |
| 严重程度 | 中（不影响验证结论正确性，影响可追溯性与签核审计） |
| 状态 | 待开发团队确认 |

---

## 1. 问题现象

MoonGlass 验证态势页面中，大量场景的**"绑定"列显示"未绑定"**，例如：

| 场景 ID | 波段 | 绑定 | 验证状态 | 测试用例 |
|---|---|---|---|---|
| SCN-02DB72E7 | W2·错误注入 | **未绑定** | ✓ 已验证 | — |
| SCN-0427C8AD | W1 | ✓ 已验证 | test_scn_0427c8ad_marchx1_x4 |
| SCN-050E3440 | W2·软硬件并发 | **未绑定** | ✓ 已验证 | — |
| SCN-066305EA | W1 | ✓ 已验证 | test_scn_066305ea_reg004_semantics_consistency |
| SCN-0766CEFE | W1 | **未绑定** | ✓ 已验证 | — |
| SCN-08E19A42 | W1 | **未绑定** | ✓ 已验证 | — |
| SCN-0979E363 | W3·优先级仲裁 | **未绑定** | ✓ 已验证 | — |

**关键观察**：同一页面上"未绑定"场景的"验证状态"列显示的是 **✓ 已验证**，而非"未验证"。
这说明**证据是有效的，缺的是"场景 ↔ 测试用例"的关联关系**。

---

## 2. 影响评估

### 2.1 不影响的部分

已验证场景的 `reachCount`（可达次数）与 `passed`（通过标志）**均为真实数据**，
且 `rtlHash` 与当前 RTL 完全一致（`c938badf3ea2c5cf...`）。
从"验证结论是否正确"的角度看，**这些场景确实已被覆盖并通过**。

### 2.2 受影响的部分

1. **审计不可追溯**：无法从场景 ID 直接跳转到覆盖它的测试用例，
   人工签核与第三方审计时需要反向人工排查。
2. **回归影响面无法计算**：RTL 变更后无法自动判定"哪些用例需要重跑"，
   只能全量回归。
3. **重复覆盖无法识别**：多个场景可能由同一用例覆盖而不可见。
4. **证据新旧混杂**：见 §4。

---

## 3. 根本原因分析

### 3.1 场景绑定存在两条路径，行为不一致

`run_simulation` 支持两种场景关联方式：

| 路径 | 机制 | 是否在场景上留下测试用例反向指针 |
|---|---|---|
| A. `scenarioIds=[...]` 参数 | 工具在运行后自动登记 `scenario_hits.json` | **未留下**（仅记录聚合证据文件） |
| B. 测试函数名内嵌 `scn_<8位hex>` | 工具按函数名自动匹配 | **留下**（UI 可显示用例名） |

**当前项目两种方式混用**，导致同一份 `scenario_hits.json` 中两类记录并存：
A 类记录有 `reached/passed/reachCount`，但 UI 无法反查测试用例 → 显示"未绑定"。

### 3.2 实测数据（可复现）

```text
scenario_hits.json 条目数                      : 175
scenario-registry.json 场景数                  : 165
（两者不等的 10 条为历史归档记录）

测试函数名内嵌 scn_<hex> 的场景数              :  75
测试 docstring/注释引用 SCN-<hex> 的场景数     : 164

按可追溯性分类（以注册表 165 个为分母）：
  可通过函数名绑定                              :  68
  仅可通过 docstring 注释引用                    :  81
  完全无测试引用                                :  16
```

`scenario-registry.json` 中的 `evidence` 字段：

```text
155 个场景的 evidence 仅含聚合文件（scenario_hits.json / result.json / 日志 / 波形）
  4 个场景的 evidence 含具体 testcase 引用
  6 个场景的 evidence 为空
```

**即：155 个场景缺少"场景 → 测试用例"的反向指针。**

### 3.3 测试代码逐文件统计（证据）

```text
file                                @test   nameBound   docRef
test_w1_basic.py                        5           5        6
test_w1_batch2.py                       8           8        8
test_w1_batch3.py                       8           8        8
test_w1_batch4.py                       7           7        7
test_w1_batch5.py                       7           0        7   <-- 仅注释引用
test_w1_batch6.py                       8           0        8   <-- 仅注释引用
test_w1_batch7.py                       6           0        6   <-- 仅注释引用
test_w1_batch8.py                       5           0        5   <-- 仅注释引用
test_w1_dbg_inject.py                   1           0        1
test_w1_hang.py                         1           0        1
test_w1_intr_mask.py                    1           0        1
test_w2_busy_cfg.py                     3           0        8
test_w2_err_collision.py                4           0       14
test_w2_fifo_exhaust.py                 2           0        7
test_w2_march_phase.py                  1           0        1
test_w2_outstanding.py                  3           0       12
test_w2_recovery.py                     2           0        3
test_w2_reset_collision.py              4           0       17
test_w3_dual_oracle2.py                 1           0        3
test_w3_funccov.py                      7           0        5
...
TOTAL                                 136          79      180
```

可见 `test_w1_batch5~8`、`test_w2_*` 等批次**大量使用 docstring 注释而非函数名标记**，
这类场景 UI 无法自动绑定。

---

## 4. 附带发现：证据新旧混杂

```text
175  scenario_hits 条目中：
167  条 evidence 引用 simulation_icarus.log   （较早的 Icarus 运行）
 17  条 evidence 引用 simulation_verilator.log （较新的 Verilator 运行）
```

生成时间分布：

```text
2026-09-09 : 153 条
2026-09-10 :   5 条
2026-09-14 :   8 条
2026-09-22 :   9 条
```

当前 W3 全量回归使用 Verilator，但多数场景证据仍指向 Icarus 日志。
由于 `rtlHash` 一致，**这些证据仍然有效**，但证据链新旧混杂，
审计时容易误判。

---

## 5. 需要开发团队确认/解决的事项

### 5.1 功能请求（核心）

**请求 R1：为 `run_simulation(scenarioIds=[...])` 路径补充测试用例反向指针登记。**

当前该路径只写入 `reached/passed/reachCount/rtlHash/evidence`，
未记录"本次运行中覆盖该场景的 testcase 名称"。
建议在 `scenario_hits.json` 每条记录中增加字段，例如：

```json
{
  "id": "SCN-02DB72E7",
  "reached": true,
  "passed": true,
  "reachCount": 7,
  "rtlHash": "c938badf...",
  "evidence": ["result.json", "simulation_verilator.log", "ddrbist_top.fst"],
  "boundTestcases": ["tests.test_w2_err_collision.test_error_normal_collision"],
  "boundBy": "scenarioIds",
  "generatedAt": "2026-09-28T..."
}
```

使 UI 的"绑定"列对 A 类路径同样显示具体用例名。

**请求 R2：明确"未绑定"的语义与判定条件。**

当前"未绑定"混合了三种截然不同的情况，建议 UI 或数据层区分：

| 情况 | 说明 | 建议显示 |
|---|---|---|
| (a) 由 `scenarioIds` 绑定但无用例指针 | 有证据、真实验证过 | "已绑定（路径A）"或补指针后"已绑定" |
| (b) 由 docstring 注释引用 | 有证据、可人工追溯 | "已绑定（注释）" |
| (c) **非仿真验证方法** | WAIVED 或 `formal-candidate` | **不应显示"未绑定"**，应显示"不适用"或"Formal" |

> **(c) 类尤其重要**：实测 16 个"完全无测试引用"的场景中，
> **6 个为 WAIVED（PPA 类条款）**、**10 个为 `formal-candidate`**（应由 Formal 关闭）。
> 它们没有 testcase 是**设计使然**，但 UI 显示"未绑定"会造成"验证有遗漏"的错误印象。

### 5.2 问题咨询

**问题 Q1**：是否存在受支持的、能一次性为已运行场景补建用例映射的方式？
若没有，我只能通过"重跑并显式传 `scenarioIds` 或改名含 `scn_<hex>`"来补建。

**问题 Q2**：重跑刷新绑定是否会覆盖既有 `scenario_hits.json`？
是否支持增量合并（保留旧证据记录）？

**问题 Q3**：`formal-candidate` 场景的"绑定"应如何呈现？
是否应关联 `verification/formal/` 下的 harness 与 `.sby` 文件而非 testcase？

---

## 6. 复现方法

```bash
# 1. 查看场景绑定的原始数据
cat verification/results/ddrbist_top/scenario_hits.json

# 2. 统计可追溯性缺口
grep -rho "scn_[0-9a-fA-F]\{8\}" verification/ddrbist_top_tb/tests/*.py | sort -u | wc -l
# -> 75（函数名标记数）

grep -rho "SCN-[0-9A-Fa-f]\{8\}" verification/ddrbist_top_tb/tests/*.py | sort -u | wc -l
# -> 164（含注释引用）

# 3. 检查 evidence 构成
grep -o "simulation_[a-z]*\.log" verification/results/ddrbist_top/scenario_hits.json | sort | uniq -c
```

---

## 7. 验证侧已确认的事实（供开发团队参考）

以下事实已由验证独立核实，**不构成对工具的指控，仅提供定位依据**：

1. 所有"未绑定"场景的 `passed` 均为 `true`，`reachCount` 均 ≥ 1（最小 1，最大 24）
2. 所有场景的 `rtlHash` 与当前 RTL 一致，无陈旧证据
3. 项目侧确实混用了两条绑定路径（75 个函数名标记 vs 155 个纯 `scenarioIds` 记录）
4. 16 个"无测试引用"场景确为 WAIVED / `formal-candidate`，非遗漏
5. `scenario_hits.json` 由 `run_simulation` 独占写入，验证侧**未手工修改过该文件**

---

## 8. 备注

本文档仅描述现象与成因，不预设工具缺陷结论。
若开发团队确认 R1 属于"设计如此、不计划支持"，
验证侧将通过**重跑并显式绑定**的方式自行补建映射（见 `docs/04_verification/w3_scenario_binding.md`），
但届时需接受"证据将全部刷新为最新一次运行"的代价。
