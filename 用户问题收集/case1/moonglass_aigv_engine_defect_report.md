# AIGV 验证智能引擎缺陷报告（R10 文本误命中 / 陈旧证据覆盖）

| 项目 | 内容 |
|---|---|
| 报告 ID | BUG-AIGV-001 |
| 发现日期 | 2026-09-10 |
| 工具入口 | `build_verification_intelligence`（`deriveRisks` / `scenarioHits` / `refreshScenarioWithHits`） |
| 引擎文件 | `MoonGlass/resources/verification-intelligence/engine.ts` |
| 影响条款 | REQ-001#a（单时钟域、无跨域路径）的验证主题命名与呈现口径 |
| 影响风险 | RISK-0039（`ddr_interleave_distributor`，riskScore 0.807）、RISK-0001（`ddr_reset_sync`，0.619） |
| 影响场景 | SCN-A386F9C1、SCN-C5D0B826（`topic=跨时钟域`、`method=static`、`interaction=CROSSES_CLOCK`） |
| 影响产物 | W2 波报告「跨时钟域 2/2」、`verification/intelligence/risk-register.json`、`scenario-registry.json`、`oracle-evaluation.json` |
| 分类 | **引擎缺陷**（D1 启发式误报；D2 证据新鲜度与状态派生不一致）——非设计缺陷、非验证激励缺口 |
| 状态 | 待 MoonGlass 引擎侧修复 |

---

## 1. 缺陷 D1（主要）：R10「CDC Interaction」规则按文件**全文（含注释）**做文本匹配，单时钟设计被误判为跨时钟域

### 现象

本工程 RTL 为**单时钟域**设计（唯一时钟 `i_clk`，全部 `always` 敏感表为
`posedge i_clk or negedge i_rst_n`；`rtlqa/cdc/cdc_report.md:12/14/15`：时钟域 1、同步器 0、跨域路径无）。
但 `build_verification_intelligence` 仍产出 2 条 `topic=跨时钟域` 的风险与场景，W2 波报告中呈现为「跨时钟域 2/2」。

### 命中根因（源码级）

1. 规则定义 `engine.ts:85`：

   ```js
   { taxonomyId: 'R10', title: 'CDC Interaction', features: ['cdc'],
     patterns: [/(?:sync|async|cdc|clk_[a-z0-9_]+).*?(?:sync|clk_[a-z0-9_]+)/is], ... }
   ```

   单个正则、带 `s` 标志（`.` 跨行）、`.*?` 允许任意长度间隔 ⇒ **同一文件内出现两次
   `sync/async/cdc` 即命中**，与是否存在第二个时钟无关。

2. 判定处 `engine.ts:519-522`：读取**整个文件文本**（含注释、字符串）后执行

   ```js
   const text = readFileSync(absolute, 'utf-8')
   if (!rule.patterns.every((pattern) => pattern.test(text))) continue
   ```

3. 命中的实际是**文件头注释**：

   | 风险 | 文件 | `source.line` | 命中的注释文本 |
   |---|---|---|---|
   | RISK-0039 | `rtl/ddr_interleave_distributor.v` | 8 | `//  ... (single clock domain, no CDC); i_rst_n is` |
   | RISK-0001 | `rtl/ddr_reset_sync.v` | 2 | `// Module : ddr_reset_sync`（配合第 5 行 `Asynchronous assert / synchronous deassert`） |

   **即：顶层注释中“本设计没有 CDC”这句话本身就是触发 CDC 规则的原因。**

### 复现（可重复执行）

命令与日志：`scripts/repro_aigv_r10_pattern.py` → `verification/results/ddr_interleave_distributor/r10_pattern_repro.log`

用引擎原正则扫描 10 个 RTL 文件：

```
[命中] ddr_interleave_distributor.v   line 8    'CDC); i_rst_n is\n//   async'
[命中] ddr_reset_sync.v               line 2    'sync\n// Project   : DDR Interleave Distributor (DID)...'
命中 2 / 未命中 8（未命中：addr_remap.v, apb_cfg_regfile.v, burst_split.v,
                          did_axi_master_port.v, interleave_engine.v,
                          master_matrix.v, region_decode.v, response_reorder.v）
```

### 影响判定

- 风险寄存器 47 条中 2 条（全库 `feature=cdc` 条目仅此 2 条）为误报；
- 生成 2 条 `ENGINE_CANDIDATE` 场景并占用 W2 预算（1 个测试文件 3 条用例 + 1 个 Formal harness）；
- **对读者产生事实性误导**：W2 报告「跨时钟域 2/2」会被理解为“设计存在时钟域交叉”；
- 不构成本工程 RTL 缺陷：两条场景经实测后给出的是**证伪 CDC 前提**的证据（见 §3）。

---

## 2. 缺陷 D2（次要）：陈旧 Formal 证据可覆盖当前仿真证据，`freshness` 回退历史值导致状态未被降级

### 现象

`SCN-A386F9C1` 场景状态为 `FORMAL_PROVED`，但其 `ORACLE-FORMAL-PROPERTY` 判定在
`oracle-evaluation.json` 中已被标 **invalid**（Formal 结果 `rtlHash=39702549b422…` ≠ 当前
`rtlHash=d3da3be4577e…`），属陈旧结果。

### 根因（源码级判定顺序）

1. `engine.ts:937-947` 收集 Formal 结果并**覆盖**同场景的既有（仿真）hit：

   ```js
   const decisive = ['COUNTEREXAMPLE','PROVEN','PROVEN_UNREACHABLE','COVERED'].includes(result.outcome)
   ...
   hits.set(result.scenarioId, { status, ..., rtlHash: result.rtlHash ?? existing?.rtlHash })
   ```

2. `engine.ts:956-962` 刷新场景：

   ```js
   const rtlChanged = Boolean(item.rtlHash && item.rtlHash !== rtlHash)
   const currentEvidence = Boolean(hit && (hit.rtlHash ? hit.rtlHash === rtlHash : ...))
   const freshness = currentEvidence ? 'CURRENT' : rtlChanged ? 'IMPACT_UNKNOWN' : item.state?.freshness ?? 'CURRENT'
   if (freshness !== 'CURRENT' && ['VERIFIED','FORMAL_PROVED'].includes(status)) status = 'PARTIAL'
   ```

   当 `hit.rtlHash` 为陈旧值（`currentEvidence=false`）而 `item.rtlHash` 已是当前值时，
   `rtlChanged` 亦为 `false`，`freshness` **回退到上一轮 state 的 `CURRENT`**，于是
   `FORMAL_PROVED` 未被降级为 `PARTIAL`。

### 影响判定

- 该场景的真实 PASS 依据是两个仿真 Oracle（`ORACLE-REFERENCE-SCOREBOARD` 与
  `ORACLE-INVARIANT-ASSERTION`，域名 reference-model / architecture-invariant，Level ≥2，满足规则 11）；
  Formal 那条是陈旧证据，但状态标签显示为 `FORMAL_PROVED`，**标签与证据不匹配**；
- 若同模式出现在其他场景，会使“由陈旧 Formal 结果支撑的 FORMAL_PROVED”进入签核包；
- 相关同类问题：`rtlqa` 侧的 Formal 结果整体 rtlHash 为 `9d2c1948…`/`39702549…`，早于当前 RTL 哈希。

---

## 3. 两条被误报场景的实际验证内容（证明误报只影响命名，不影响覆盖）

| 用例（`verification/ddr_interleave_distributor_tb/tests/test_corner_misc.py`） | 断言内容 | 性质 |
|---|---|---|
| `test_scn_a386f9c1_cdc_single_clock_evidence`（TEST-W2-CDC-001） | 仅 `i_clk` 端口、实例 `u_reset_sync` 存在、`rtlqa/cdc/cdc_report.md` 在盘；**在途流量中改 mask（0x0F→0x03）后拆分事务数等于金标准预期**（无丢失） | 证伪 CDC 前提 + 功能无脉冲丢失 |
| `test_scn_c5d0b826_cdc_reset_sync_release`（TEST-W2-CDC-002） | 异步拉低 `i_rst_n` 后同步释放，连续 6 拍 `CFG_STATUS==0`（无幽灵首事务）、`s_axi_bvalid==0` | 异步置位 / 同步释放正确 |

另有 Formal `verification/formal/f_ddr_reset_sync.sv`（`f_reset_sync_cover` / `f_reset_sync_prove`）。

---

## 4. 修复建议

### R1（S1）匹配前剥离注释与字符串字面量

对 `engine.ts:519` 的 `text` 先做 `//`、`/* */`、`"…"` 剥离，再交给 `rule.patterns`。
**注意：单独 R1 不足以消除本工程误报**——剥离注释后 `ddr_reset_sync`/`u_reset_sync`/`w_rst_n_sync`
等标识符仍含两次 `sync`（实测 `textHit=True`），必须与 R2 同时实施。

### R2（S2）R10 改由**结构事实**判定，而非文本

伪代码：

```js
// 从时钟端口 + always 敏感表收集时钟集合
const edges = alwaysSenseList.map(s => s.edgeSignal)
const clocks = new Set(edges.filter(isClockLike))   // 见下方“修复陷阱”
const hasCdc = clocks.size >= 2 && crossesClockPathExists(...)   // 或至少 clocks.size >= 2
```

**修复陷阱（本工程实测踩到）**：敏感表中的 `negedge` 通常是异步复位
（`posedge i_clk or negedge i_rst_n`）。若把所有边沿信号都计入时钟集合，
`ddr_reset_sync` 这类**单时钟复位同步器**会被再次误判为 CDC。必须按信号名/端口方向筛选：
名称含 `clk|clock` 且不含 `rst|reset` 才计入时钟集合。

### R3（S3）若短期保留文本规则

去掉 `s` 标志；要求同一行内出现两个**不同**时钟名；排除 `no CDC` / `single clock` 等否定句式。

### R4（S4）修正证据新鲜度与状态派生

- 陈旧 Formal hit（`result.rtlHash !== 当前 rtlHash`）**不得覆盖**同场景的当前仿真 hit；
- `freshness` 不得回退 `item.state?.freshness`，命中自身 rtlHash 不匹配即应判 `IMPACT_UNKNOWN`
  并触发 `PARTIAL` 降级（与 `engine.ts:962` 的降级逻辑保持一致）。

### 修复效果自检（实测）

| 输入 | 引擎原规则 | R1+R2 修正后 | 时钟集合 |
|---|---|---|---|
| `rtl/ddr_interleave_distributor.v` | **命中（误报）** | no-cdc ✅ | `['i_clk']` |
| `rtl/ddr_reset_sync.v` | **命中（误报）** | no-cdc ✅ | `['i_clk']` |
| 其余 8 个 RTL 文件 | 未命中 | no-cdc ✅ | `['i_clk']` 或空 |
| 自检样例 A：真 CDC（`i_clk` + `i_clk_axi` + 2-flop） | 命中 | **CDC ✅（无漏报）** | `['i_clk','i_clk_axi']` |
| 自检样例 B：单时钟 + 注释含两次 `sync` | 命中（误报） | no-cdc ✅ | `['i_clk']` |
| 自检样例 C：单时钟 + 注释 “no CDC” | 未命中 | no-cdc ✅ | `['i_clk']` |

（样例 B/C 用于验证修正后不会“修成瞎”——真实双时钟结构仍被捕获。）

---

## 5. 原始证据落盘

| 证据 | 路径 |
|---|---|
| 误命中调查记录 | `docs/04_verification/aigv_r10_cdc_false_positive_finding.md` |
| 复现脚本 | `scripts/repro_aigv_r10_pattern.py` |
| 复现日志（10 文件命中表 + 修正后对比 + 自检样例） | `verification/results/ddr_interleave_distributor/r10_pattern_repro.log` |
| 静态 CDC 结论 | `rtlqa/cdc/cdc_report.md:12,14,15` |
| 场景/风险证据 | `verification/intelligence/risk-register.json`、`scenario-registry.json`、`oracle-evaluation.json`（只读引用，未修改） |
| 场景测试用例 | `verification/ddr_interleave_distributor_tb/tests/test_corner_misc.py` |

---

## 6. 复现命令

```powershell
cd D:/项目信息/知识库/Flow_Cross
$env:PYTHONIOENCODING="utf-8"
python scripts/repro_aigv_r10_pattern.py
# 或重定向留档：
python scripts/repro_aigv_r10_pattern.py > verification/results/ddr_interleave_distributor/r10_pattern_repro.log
```

---

## 7. 对本工程结论的影响（边界声明）

1. 设计为单时钟域，**不存在 CDC 路径**；本报告不改变 REQ-001#a 的静态判定与 REQ-001#b 的
   条件不成立结论。
2. 两条 CDC 场景的 PASS 证据有效（仿真双 Oracle 独立域），其主题命名来源于 D1 误报；
   在引擎修复前，报告中该主题宜按「单时钟域结构确认」理解，而非“存在时钟域交叉”。
3. 本报告仅为**引擎缺陷上报**，不涉及本工程 RTL 修改；`verification/intelligence/` 下机器产物未被修改。
