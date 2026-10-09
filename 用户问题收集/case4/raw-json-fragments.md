# 原始 JSON 片段附件 — BUG-VERIF-BATCH-001

> 工程：D:\Projects\rtl_lib\gmac　rtlHash：dd09a37023f64aa06611906c6c04f160575efb4bf6dd98c88797d6a94e2db859
> 说明：片段 1 为事件发生时（2026-10-08T11:04:58Z）读取到的原文，该记录此后已被 history 滚动窗口裁剪，
> 现盘上已不存在（见片段 3）。其余片段均为 2026-10-09 复核时的现盘内容。

---

## 片段 1. verif-batch-loop.json → history[index=25]（事件发生时，现已裁剪）

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

---

## 片段 2. verif-batch-loop.json → 现盘顶层状态（2026-10-09T01:10:26Z）

```json
{
  "state": "completed",
  "currentBatch": null,
  "deferredScenarioIds": ["SCN-F6539D01"]
}
```

### 2.1 history 现有 index 分布（滚动窗口 = 20）

```text
[45, 44, 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33, 32, 31, 30, 29, 28, 27, 26]
```

index 25（本报告事件批次）已不在列表中；但 `deferredScenarioIds` 仍保留该场景 ID。

---

## 片段 3. scenario-registry.json → SCN-F6539D01（现盘终态）

```json
{
  "id": "SCN-F6539D01",
  "origin": "AGENT_INTENT",
  "wave": "basic",
  "title": "Lint / 死逻辑 / Latch 与内部三态洁净静态闭环（REQ-QA-001、REQ-QA-003）",
  "riskIds": ["RISK-0065", "RISK-0076"],
  "requirementIds": [
    "REQ-QA-001#a", "REQ-QA-001#b",
    "REQ-QA-003#a", "REQ-QA-003#b", "REQ-QA-003#c"
  ],
  "rtlObjects": [
    "r_sync_rg1", "r_sync_rg2", "gmii_txd",
    "w_raddr", "r_addr_filter_flat", "r_mac_cfg"
  ],
  "features": ["error"],
  "trigger": ["RTL 在本批次冻结，rtlHash 与登记时一致"],
  "expected": [
    "run_verible_lint 全设计 elaboration 通过且 error 数 = 0",
    "check_dead_logic 报告中 undriven 项为 0（spec-anchored 项需具名裁决）",
    "综合日志无 latch 推断告警；内部网络无三态驱动（仅顶层 PAD 例外，本设计无 PAD）"
  ],
  "method": "static",
  "status": "VERIFIED",
  "state": {
    "lifecycle": "EXECUTED",
    "reach": "REACHED",
    "judgment": "PASS",
    "evidence": "COMPLETE",
    "freshness": "CURRENT",
    "closure": "VERIFIED"
  },
  "rtlHash": "dd09a37023f64aa06611906c6c04f160575efb4bf6dd98c88797d6a94e2db859",
  "priority": 0.85,
  "reason": "Agent 登记的验证意图（AGENT_INTENT），锚定 RISK-0065、RISK-0076。",
  "evidence": [
    "verification\\results\\gmac_top\\scenario_hits.json",
    "verification\\results\\gmac_top\\result.json",
    "verification\\results\\gmac_top\\simulation_icarus.log",
    "verification\\results\\gmac_top\\gmac_top.fst",
    "verification\\results\\root-causes.json",
    "verification/results/gmac_top/static-closure-SCN-F6539D01.md",
    "rtl/gmac_axil_regs.v",
    "rtlqa/lint/dead_logic_report.json",
    "imp/synthesis/gmac_top_synthesis.log"
  ],
  "reachCount": 2,
  "updatedAt": "2026-10-09T00:10:21.456Z",
  "assertionPassed": true
}
```

> 注意 `method="static"`，但 `evidence` 的前 5 项均为**仿真**产物（scenario_hits / result.json / simulation_icarus.log / fst），
> 真正的静态证据（dead_logic_report.json / gmac_top_synthesis.log）排在末位且未作为独立 oracle verdict 绑定。见报告 §3.4。

---

## 片段 4. scenario_hits.json → SCN-F6539D01（唯一的执行 hit）

```json
{
  "id": "SCN-F6539D01",
  "reached": true,
  "passed": true,
  "reachCount": 2,
  "rtlHash": "dd09a37023f64aa06611906c6c04f160575efb4bf6dd98c88797d6a94e2db859",
  "evidence": ["result.json", "simulation_icarus.log", "gmac_top.fst"],
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

> 绑定的 4 条用例分别验证中断状态位映射、INT_MASK 门控、PHY 中断两拍同步、软复位后中断状态——
> **与"lint error = 0 / 死逻辑 undriven = 0 / 无 latch 与三态"三条判定标准无验证关系**。见报告 §3.4。

---

## 片段 5. root-causes.json → RC-427137CE（本批次确认的根因）

```json
{
  "id": "RC-427137CE",
  "scenarioId": "SCN-F6539D01",
  "verdict": "confirmed",
  "createdAt": "2026-10-08T11:04:15.211Z",
  "hypothesis": "本批次 lint FAIL 源于 RC-CCF4908A（AXI4-Lite 软复位死锁）的修复在 gmac_axil_regs 的 ready 输出上引入的 ~rst 组合门控，违反复位不得参与组合逻辑。",
  "rootCause": "RC-CCF4908A 的修复为消除 AXI4-Lite 软复位死锁，在 gmac_axil_regs.v:245-247 用 ~rst 组合门控 s_axil_awready/wready/arready，该门控把复位信号引入组合逻辑，命中 moonglass-no-clk-rst-in-comb 共 3 个 error，违反 REQ-QA-001#a。",
  "fix": "用寄存复位保持位（rst 置位时置 1，释放后 1 拍置 0）替代 ~rst 门控，既恢复复位窗内 ready=0 又不引入组合复位路径。",
  "refutedHypotheses": [],
  "failureSignature": "",
  "evidence": [
    "verification/results/gmac_top/static-closure-SCN-F6539D01.md",
    "rtl/gmac_axil_regs.v",
    "rtlqa/lint/dead_logic_report.json",
    "imp/synthesis/gmac_top_synthesis.log"
  ]
}
```

---

## 片段 6. rtl-fix-audit-RC-427137CE.json（修复会话实际改动）

```json
{
  "rootCauseId": "RC-427137CE",
  "scenarioId": "SCN-F6539D01",
  "fixSessionName": "phase-verif--fix-RC-427137CE",
  "startedAt": "2026-10-08T11:04:58.042Z",
  "settledAt": "2026-10-08T11:13:51.745Z",
  "changed": ["gmac_axil_regs.v"],
  "created": [],
  "deleted": [],
  "blockedAttempts": 0
}
```

> `startedAt = 11:04:58.042Z` 与 no-evidence 结算 `settledAt = 11:04:58.096Z` 相差 54 ms。

---

## 片段 7. exploration-history.json → ROUND-0041（选批与闭环）

```json
{
  "roundId": "ROUND-0041-768589D0",
  "snapshotId": "VSPACE-71AF71F4E7A5",
  "generatedAt": "2026-10-08T10:59:39.433Z",
  "selectedScenarioIds": ["SCN-F6539D01"],
  "expectedCostSeconds": 300,
  "candidateCount": 24,
  "uncoveredCritical": 317,
  "baselineClosedScenarioIds": ["SCN-F0D61A2F", "SCN-A6438761", "SCN-BD87A579", "SCN-79DADA3B", "SCN-2038494D"],
  "newlyClosedScenarioIds": ["SCN-F6539D01"],
  "noveltyScore": 15,
  "result": "PROGRESS",
  "completedAt": "2026-10-08T11:13:51.797Z"
}
```

---

## 片段 8. execution-summary.json → 通道分布（证明静态/综合通道规模）

```json
{
  "specMapping": {
    "clauseTotal": 235,
    "coveredClause": 59,
    "channels": {
      "simulation": 209,
      "static": 26,
      "synthesis": 15
    }
  }
}
```

> 26 条 static + 15 条 synthesis 条款都无法通过 `scenario_hits.json` 登记执行证据。
