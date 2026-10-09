# MoonGlass 验证循环"批次无执行证据（no-evidence）"误报与 deferredScenarioIds 残留问题报告

| 项目 | 内容 |
|---|---|
| 文档编号 | BUG-VERIF-BATCH-001 |
| 日期 | 2026-10-09 |
| 报告人 | 用户（VERIF 阶段，W1 基础功能推进中） |
| 工程 | `D:\Projects\rtl_lib\gmac`（顶层 `gmac_top`，17 个 RTL 文件） |
| 当前 RTL Hash | `dd09a37023f64aa06611906c6c04f160575efb4bf6dd98c88797d6a94e2db859` |
| 严重程度 | **中**（不影响验证结论正确性，影响可审计性、静态通道场景的推进效率，并造成持久性状态失真） |
| 状态 | 待开发团队确认 |
| 证据附件 | `raw-json-fragments.md`（本目录，原始 JSON 片段） |

---

## 0. 一句话摘要

MoonGlass 验证批循环（`verif-batch-loop.json`）对**静态通道（`method=static`）场景**派发的批次，因这类场景的证据（lint / 死逻辑 / 综合日志）**永远不会写入 `scenario_hits.json`**，在会话正常结束时必然被判为 `verdict="no-evidence"`，并打上一句含糊的兜底措辞"场景可能无需执行"。该批次实际上完成了全部静态检查、发现了真实门禁违规、并触发了独立修复会话，但循环侧看不到任何"执行证据"。

更严重的是：该 no-evidence 判定留下的唯一痕迹是 `deferredScenarioIds` 里的一个**裸字符串**，而 `history` 是**20 条滚动窗口**——批次结算记录已被裁剪，残留的 deferred 项**既无时间戳、无理由、也无清除入口，且已成孤儿记录**。

---

## 1. 问题现象

### 1.1 用户可见的原始消息

```text
第 25 批
Lint / 死逻辑 / Latch 与内部三态洁净静态闭环（REQ-QA-001、REQ-QA-003）
2026/10/8 19:04:58
无执行证据（会话正常结束，场景可能无需执行）：场景未登记 scenario_hits：SCN-F6539D01
```

### 1.2 对应的机器可读记录（当时）

`verification/results/verif-batch-loop.json` → `history[index=25]`：

```json
{
  "index": 25,
  "scenarioIds": ["SCN-F6539D01"],
  "verdict": "no-evidence",
  "reason": "无执行证据（会话正常结束，场景可能无需执行）：场景未登记 scenario_hits：SCN-F6539D01",
  "settledAt": "2026-10-08T11:04:58.096Z",
  "scenarios": [
    {
      "id": "SCN-F6539D01",
      "title": "Lint / 死逻辑 / Latch 与内部三态洁净静态闭环（REQ-QA-001、REQ-QA-003）",
      "requirementIds": [
        "REQ-QA-001#a", "REQ-QA-001#b",
        "REQ-QA-003#a", "REQ-QA-003#b", "REQ-QA-003#c"
      ]
    }
  ]
}
```

> ⚠️ **该记录现已不存在**：`history` 只保留最近 20 条（当前为 index 26~45），批次 25 的结算记录已被滚动窗口裁剪。见 §3.3。

### 1.3 场景身份（`scenario-registry.json`）

| 字段 | 值 |
|---|---|
| id | `SCN-F6539D01` |
| origin | `AGENT_INTENT` |
| wave | `basic`（W1 基础功能） |
| **method** | **`static`** ← 关键 |
| 风险锚点 | `RISK-0065`、`RISK-0076` |
| 需求锚点 | `REQ-QA-001#a/#b`、`REQ-QA-003#a/#b/#c` |
| expected（判定标准） | ① lint error = 0；② `check_dead_logic` undriven = 0（spec-anchored 需具名裁决）；③ 综合无 latch 推断、内部无三态 |

### 1.4 该批次的真实执行结果（与"无执行证据"形成矛盾）

该批次**执行完整、发现了真问题、并触发了独立修复**：

- `run_verible_lint`（全设计 17 文件 + 顶层 elaboration）→ **Error 3 / Warning 36**
  - 3 个 error 均为 `moonglass-no-clk-rst-in-comb`，位置 `rtl/gmac_axil_regs.v:245-247`（`assign s_axil_awready = ~rst & ...`）
- `check_dead_logic` → 36 项（undriven 3 / unused 33 / dead 0），undriven 3 项全部为 `rtl/macros/sram_blackbox.v` 的库视图端口，已由工程师具名裁决 `keep`，未裁决 0
- 综合 / latch / 三态复核 → ✅ 全部模块 "No latch inferred"；网表无三态单元；RTL 无 `1'bz`
- 场景裁决：**FAILED**（判定标准 1 被阻断），落盘 `verification/results/gmac_top/static-closure-SCN-F6539D01.md`
- 根因 `RC-427137CE`（`verdict=confirmed`），触发独立修复会话
- 修复后重跑：lint **Error 0**；功能回归 `SCN-F6539D01` PASS（`reachCount=2`）

**结论：这不是"这一批白跑了"，而是"干完了活但证据没有登记到循环认账的那个账本里"。**

---

## 2. 完整时间线（全部有落盘证据）

| 时间 (UTC) | 事件 | 证据文件 / 字段 |
|---|---|---|
| 10:59:39.433 | `ROUND-0041` 选中 `SCN-F6539D01`，派发为第 25 批 | `intelligence/exploration-history.json` |
| ~10:59–11:04 | 会话执行三项静态检查（冻结 rtlHash `86f2e7af…`），判定 FAILED | `results/gmac_top/static-closure-SCN-F6539D01.md` §1–§5 |
| 11:04:15.211 | 根因 `RC-427137CE` 记录（confirmed） | `results/root-causes.json` |
| **11:04:58.042** | **独立修复会话 `phase-verif--fix-RC-427137CE` 启动** | `results/rtl-fix-audit-RC-427137CE.json` |
| **11:04:58.096** | **第 25 批结算 → `verdict="no-evidence"`** | `results/verif-batch-loop.json`（记录已被裁剪） |
| 11:13:01.796 | `run_simulation` 回灌 `SCN-F6539D01` hit：`reached=true passed=true reachCount=2` | `results/gmac_top/scenario_hits.json` |
| 11:13:51.745 | 修复会话结算 **FIXED**（`gmac_axil_regs.v` v1.2） | `results/rtl-fix-outcomes.json`、`rtl-fix-audit-RC-427137CE.json` |
| 11:13:51.797 | `ROUND-0041` 完成，`newlyClosedScenarioIds=["SCN-F6539D01"]`，result=PROGRESS | `intelligence/exploration-history.json` |
| 13:03:40.503 | 场景终态 `status=VERIFIED / judgment=PASS / evidence=COMPLETE` | `intelligence/scenario-registry.json` |
| 之后 | `history` 滚动裁剪至 20 条，批次 25 记录**丢失**；`deferredScenarioIds` **仍保留** `SCN-F6539D01` | `results/verif-batch-loop.json` |

**关键观察**：`11:04:58.042`（修复会话启动）与 `11:04:58.096`（no-evidence 结算）相差 54 毫秒——说明该批**同一瞬间被交给修复闭环，同时被标记为 no-evidence**。both 都是"结算"，但语义互斥却没有互相协调。

---

## 3. 根本原因分析

### 3.1 原因 C1：静态通道场景在架构上无法产生 `scenario_hits`（主要）

批循环判定"有执行证据"的唯一数据源是 `verification/results/<topModule>/scenario_hits.json`。根据工具接口签名，**只有三个工具会写该文件**：

| 工具 | 是否接受 `scenarioIds` | 是否写 `scenario_hits` |
|---|---|---|
| `run_simulation` | ✅ | ✅ |
| `run_logic_synthesis` | ✅ | ✅（综合成功时） |
| `run_formal_verification` | ✅ | ✅ |
| `run_verible_lint` | ❌ 无此参数 | ❌ |
| `check_dead_logic` | ❌ 无此参数 | ❌ |
| `check_synthesizability` | ❌ 无此参数 | ❌ |
| `run_cdc_check` | ❌ 无此参数 | ❌ |

而 `SCN-F6539D01` 的 `method = "static"`，其判定标准全部由上述**不写 scenario_hits** 的工具产出。**因此该场景被单独派发时，必然以 no-evidence 结算**——这不是偶发缺陷，而是**结构性必然**。

交叉印证：本工程 `execution-summary.json` 的 `specMapping.channels` 明确区分 `simulation: 209 / static: 26 / synthesis: 15`。其中 26 条静态条款 + 15 条综合条款都只能在"非仿真"通道闭环。同类场景 `SCN-F0D61A2F`（综合报告静态闭环）之所以没报 no-evidence，是因为它被与 `SCN-B997B6E5` 同批派发，且批次内恰好有仿真运行登记了 hit（`history[26]`）。

### 3.2 原因 C2：结算判定把三种完全不同的情况合并成一句含糊措辞

当前实现似乎把"批内至少一个 scenarioId 无 hit"一律判为 `no-evidence`，并用同一句 reason 覆盖三种语义完全不同的情况：

| 实际情况 | 应有语义 | 当前语义 |
|---|---|---|
| (a) 会话异常 / 空转，什么都没做 | 异常，需人工介入 | `no-evidence`（措辞偏"无需执行"） |
| (b) 场景 `method=static`，静态证据已完整落盘 | **应走静态通道结算，不应要求 scenario_hits** | `no-evidence` ❌ |
| (c) 会话正常结束但确实漏跑 | 缺陷，应重排或告警 | `no-evidence` ❌ |

"场景可能无需执行"这句兜底措辞**把 (b) 的正确结论和 (c) 的缺陷混为一谈**，工程师无法从消息本身判断属于哪种情况，必须人工翻 4 个 JSON 才能定性。

### 3.3 原因 C3：`deferredScenarioIds` 是永久性孤儿残留，且其来源记录已被裁剪（次要但影响最持久）

现在 `verif-batch-loop.json` 的状态是：

```json
{
  "state": "completed",
  "currentBatch": null,
  "deferredScenarioIds": ["SCN-F6539D01"]
}
```

问题：

1. **无元数据**：deferred 项是裸字符串数组，**没有 `deferredAt`、没有 `reason`、没有 `batchIndex`、没有清除/退役入口**。
2. **来源已被裁剪**：`history` 只保留最近 20 条（当前 index 26~45），批次 25 的结算记录**已经不存在**。即"这条 deferred 是谁、为什么、什么时候加进来的"**已无法从账本追溯**。
3. **状态失真**：`SCN-F6539D01` 早在 13:03:40 就已 `VERIFIED / PASS / COMPLETE`，运行循环也已 `state=completed`，但 deferred 项**依然健在**，且是全部 45 个批次里**唯一一条** deferred 记录——说明这是边缘路径，很可能缺少自动退役逻辑。
4. **审计风险**：滚动窗口会**优先裁掉最早的批次**，而非"裁掉最无害的批次"。若某个早期批次结算为 `failed` / `blocked` / `no-evidence`，其原始结算证据会**先于** completed 批次被删除。

### 3.4 原因 C4（附带发现）：静态场景的闭环证据与方法不匹配

`SCN-F6539D01` 的 `method=static`，但最终让它达成 `VERIFIED` 的证据是 `scenario_hits.json` 中的一条**仿真**记录：

```json
{
  "id": "SCN-F6539D01",
  "reached": true, "passed": true, "reachCount": 2,
  "boundTestcases": [
    "test_if007a_int_status_bit_mapping",
    "test_if007b_int_mask_gates_mac_intr",
    "test_if007c_phy_intr_two_flop_sync",
    "test_srst001_soft_reset_int_status"
  ],
  "boundBy": "scenarioIds",
  "generatedAt": "2026-10-08T11:13:01.796Z"
}
```

也就是说：**这 4 条用例（中断状态位/屏蔽/PHY 同步/软复位）与"lint 洁净 + 死逻辑洁净 + 无 latch/三态"没有任何验证关系**，却成了该静态场景 `VERIFIED` 的登记依据。真正的静态证据（`rtlqa/lint/dead_logic_report.json`、`imp/synthesis/gmac_top_synthesis.log`）只出现在 registry 的 `evidence` 字符串列表里，**未作为独立 oracle verdict 绑定**，也没有对应的 `oracle_verdicts.json` 条目。

这带来两个问题：
- **闭环强度虚高**：静态场景"通过"实际上是因为**别的原因**跑了仿真，而非其自身判定标准被验证。
- **可能误判为 PASS**：若某次派发中静态检查 FAIL（本次即如此），而恰好有任意仿真运行带上该 `scenarioIds`，场景就会被标成 PASS，掩盖静态门禁失败。

---

## 4. 影响评估

### 4.1 不影响的部分

- 静态检查本身结果是真实、可用的（`static-closure-SCN-F6539D01.md` §2–§6 均为工具原始输出）。
- `SCN-F6539D01` 最终确实闭环为 VERIFIED；根因 `RC-427137CE` 真实且已修复。
- 运行循环的推进逻辑未因此停摆（该批之后继续推进至 beat 45）。

### 4.2 受影响的部分

1. **可审计性受损（最严重）**
   一个"发现真实门禁失败并触发修复"的批次，其结算记录是 `no-evidence`，且原始记录已被滚动裁剪，只剩一条无理由的 deferred 残留。事后审计无法回答"第 25 批到底做了什么"。

2. **工程师时间成本**
   要判定这条消息的真实含义，需要交叉核对 5 个文件：`verif-batch-loop.json`、`exploration-history.json`、`root-causes.json`、`scenario_hits.json`、`static-closure-SCN-F6539D01.md`。本次即为典型案例。

3. **状态失真与重复派发风险**
   `deferredScenarioIds` 残留可能使循环把已 VERIFIED 的场景反复视为"未完成"，造成重复派发 / 配额浪费；或反之被永久跳过。

4. **静态通道推进效率**
   26 条 static 条款 + 15 条 synthesis 条款若全部按"单场景派发"走，都会以 no-evidence 收尾，需要靠"运气"（同批恰好有仿真）才能闭环。这使静态门禁（lint / 死逻辑 / latch / 三态 / CDC / 综合）在循环视图里长期显示为未闭环——而实际上 `execution-summary.json` 的 `specMapping.static: 26` 正是这类条款。

5. **签核口径风险**
   参见 §3.4，静态条款的"已验证"可能由无关仿真证据支撑。当前工程 `closureStatus = NOT_READY`（240 个 P0/P1 未闭环、15 个阻断性 Coverage Hole），在此背景下，把静态条款的闭环证据搅浑会直接削弱签核说服力。

---

## 5. 复现步骤

```text
前置：任意完成 build_verification_intelligence 的工程，且存在 method="static" 的场景

1. 调用 select_next_verification_batch，使某个 method=static 的场景（如本工程的
   SCN-F6539D01，锚定 REQ-QA-001/REQ-QA-003）被单独派发为一个批次；
2. 让派发会话正常执行 run_verible_lint / check_dead_logic / run_logic_synthesis，
   并正常结束——全程不调用带 scenarioIds 的 run_simulation；
3. 观察 verification/results/verif-batch-loop.json：
   - history 末尾新增一条 verdict="no-evidence"，
     reason="无执行证据（会话正常结束，场景可能无需执行）：场景未登记 scenario_hits：<SCN-ID>"；
4. 观察 deferredScenarioIds：新增该场景 ID（裸字符串，无时间/无理由）；
5. 再连续派发 ≥20 个批次后重新读取 verif-batch-loop.json：
   - 上述 no-evidence 记录已从 history 中消失（滚动窗口 = 20）；
   - deferredScenarioIds 中的该 ID 仍然存在。
```

复现性：**100%（结构性必然，非竞态）**。同类记录在本工程仅此 1 条，只因其恰好被单独派发——原因见 §3.1。

---

## 6. 修复建议

### R1（主要）为静态/synthesis 通道引入独立证据账本

新增 `verification/results/<topModule>/static_hits.json`（或统一的 `evidence_hits.json`），由静态工具（`run_verible_lint`、`check_dead_logic`、`check_synthesizability`、`run_cdc_check`）在写报告的同时登记：

```
{ scenarioId, method: "static", tool, rtlHash, verdict: PASS|FAIL, artifactPaths[], generatedAt }
```

批循环结算时按 `scenario.method` 选择证据源：`simulation→scenario_hits.json`、`static→static_hits.json`、`synthesis→synthesis hits`。**不要在静态通道上要求 scenario_hits。**

### R2 拆分 `no-evidence` 的判定与措辞

至少区分：

- `no-evidence-static-pending`：静态场景，静态证据未落盘 → 应告警"静态证据缺失"
- `no-evidence-session-aborted`：会话异常/空转 → 应重排或升级
- `no-evidence-unexpected`：仿真通道场景无 hit → 视为缺陷

并在消息中直接给出**可操作的下一步**（例如"该批为静态通道，请确认 `rtlqa/lint/*` 与 `imp/synthesis/*` 产物是否已生成"），而不是"场景可能无需执行"。

### R3 让 `deferredScenarioIds` 成为可审计、可退役的结构

- 升级为对象数组：`{ scenarioId, deferredAt, reason, batchIndex, clearedAt, clearedBy }`；
- 场景状态转为 `VERIFIED` / `WAIVED` 后**自动退役**并保留历史；
- 提供显式清理入口（工具调用即可，而非人工改 JSON）；
- 在 execution-summary 中对"存活超过 N 批的 deferred 项"给出阻断提示。

### R4 `history` 滚动窗口不得裁剪非成功结算

- 方案 A：把每次结算追加写入**append-only 审计账本**（如 `batch-settlements.jsonl`），UI 的 `history` 仅作展示；
- 方案 B：滚动裁剪时**只裁 `verdict="completed"` 的批次**，`no-evidence` / `failed` / `blocked` 永久保留。
- 附带：`history` 的裁剪行为应在文档与 UI 中明示（当前为隐式）。

### R5 静态场景的闭环必须由静态证据驱动

- registry 中为每个 evidence 条目标注**证据通道**（simulation / static / synthesis / formal），并在签核包中按通道校验；
- 禁止"任意仿真 hit"把静态场景抬升为 PASS；静态场景需要 `static_hits` 中对应 `rtlHash` 的 PASS 记录；
- 若某静态场景确实需要仿真补证，应在场景定义中显式声明双通道，而不是事后由无关用例顶替。

### R6 UI 呈现

- 对 `no-evidence` / `deferred` 批次在验证态势页显示醒目提示，并附"该批实际完成的工作"（若有 `root-causes.json` / `static-closure-*.md` 落盘则直接链接）；
- 在场景详情页显示"证据通道 + 通道匹配度"，避免把静态条款显示成由仿真闭环。

---

## 7. 附录

### 7.1 证据文件清单（均已在磁盘核对）

| 文件 | 用途 |
|---|---|
| `verification/results/verif-batch-loop.json` | 批循环状态、history（滚动 20 条）、deferredScenarioIds |
| `verification/intelligence/scenario-registry.json` | `SCN-F6539D01` 定义与终态 |
| `verification/intelligence/exploration-history.json` | `ROUND-0041` 选批与闭环记录 |
| `verification/results/root-causes.json` | `RC-427137CE`、`RC-CCF4908A` |
| `verification/results/rtl-fix-outcomes.json` | 修复会话判定 FIXED |
| `verification/results/rtl-fix-audit-RC-427137CE.json` | 修复会话启动/结算时间与变更文件 |
| `verification/results/gmac_top/scenario_hits.json` | 该场景唯一的执行 hit 记录 |
| `verification/results/gmac_top/static-closure-SCN-F6539D01.md` | 静态闭环证据（§5 FAILED / §6 修复后复验） |
| `verification/results/gmac_top/fix-rc427137ce-regression.md` | 修复引入的 `SCN-0F47AE69` 回归分析 |
| `rtlqa/lint/dead_logic_report.json` / `.md` | 死逻辑检查与工程师裁决 |
| `imp/synthesis/gmac_top_synthesis.log` | latch 推断复核 |
| `verification/intelligence/execution-summary.json` | 通道分布（simulation 209 / static 26 / synthesis 15） |
| `raw-json-fragments.md` | 本报告引用的原始 JSON 片段 |

### 7.2 根因 `RC-427137CE` 原始记录

```json
{
  "id": "RC-427137CE",
  "scenarioId": "SCN-F6539D01",
  "verdict": "confirmed",
  "createdAt": "2026-10-08T11:04:15.211Z",
  "hypothesis": "本批次 lint FAIL 源于 RC-CCF4908A（AXI4-Lite 软复位死锁）的修复在 gmac_axil_regs 的 ready 输出上引入的 ~rst 组合门控，违反复位不得参与组合逻辑。",
  "rootCause": "RC-CCF4908A 的修复为消除 AXI4-Lite 软复位死锁，在 gmac_axil_regs.v:245-247 用 ~rst 组合门控 s_axil_awready/wready/arready，该门控把复位信号引入组合逻辑，命中 moonglass-no-clk-rst-in-comb 共 3 个 error，违反 REQ-QA-001#a。",
  "fix": "用寄存复位保持位（rst 置位时置 1，释放后 1 拍置 0）替代 ~rst 门控，既恢复复位窗内 ready=0 又不引入组合复位路径。",
  "evidence": [
    "verification/results/gmac_top/static-closure-SCN-F6539D01.md",
    "rtl/gmac_axil_regs.v",
    "rtlqa/lint/dead_logic_report.json",
    "imp/synthesis/gmac_top_synthesis.log"
  ]
}
```

### 7.3 附带发现：修复引入的回归（供参考，非本报告主体）

为消除上述 lint error 而引入的 `r_rst_hold` 寄存门控，导致 `SCN-0F47AE69`（`SOFT_RST` 读回为 0）回归 **FAIL**，A/B 探针证明由本次修复引入：

- 证据：`verification/results/gmac_top/probe-runs/test_reqfunc018b_soft_rst_reads_back_zero-2026-10-08T11-09-26-746Z/`
- 分析：`verification/results/gmac_top/fix-rc427137ce-regression.md` §4 / §5

这说明"静态门禁闭环"与"功能回归不回退"之间缺少自动联动检查——建议在批循环中增加一条规则：**静态通道修复导致 rtlHash 变更时，自动对同源根因链上的关联场景（`RC-CCF4908A` → `SCN-0F47AE69`）触发定向回归**。

### 7.4 当前工程状态快照（2026-10-09T00:10Z / 01:10Z）

```text
run-loop.json            : state=stopped, wave=W1, beat=25 / maxBeats=41
verif-batch-loop.json    : state=completed, history=20 条(index 26~45),
                           deferredScenarioIds=["SCN-F6539D01"]
execution-summary.json   : scenarioCount=304, VERIFIED=62, open=242,
                           closureStatus=NOT_READY
                           channels: simulation=209 / static=26 / synthesis=15
rtlHash                  : dd09a37023f64aa06611906c6c04f160575efb4bf6dd98c88797d6a94e2db859
```

---

**报告结束。** 如需补充原始日志或复现脚本（`select_next_verification_batch` + 静态工具调用的最小复现序列），可进一步提供。
