# MoonGlass 工具缺陷提交包（DEFECT-PACK-001）

| 项 | 内容 |
|----|------|
| 报告 ID | DEFECT-PACK-001（本包为**对外提交主件**，可直接转发给 MoonGlass 开发团队） |
| 提交对象 | MoonGlass 0.9.0（Windows x64，`D:/tools/MoonGlass-0.9.0/MoonGlass`） |
| 提交人 | DID 验证组（MoonGlass 用户，项目 `Flow_Cross`，DDR Interleave Distributor） |
| 提交日期 | 2026-09-11 |
| 合并的原始单 | `moonglass_toolchain_defect_register.md`（#8–#17，DEFECT-REG-001）、`moonglass_verilator_coverage_bug_report.md`（#6）、`moonglass_aigv_engine_defect_report.md`（BUG-AIGV-001）、`moonglass_synthesis_toolchain_defect_report.md`（BUG-SYNTH-001） |
| 缺陷总数 | **16 项**（A 组 5 + B 组 5 + C 组 3 + D 组 3） |
| 严重级分布 | P0：3（#8、#13、SYNTH-D1）· P1：8 · P2：4 · 待定假设：1（SYNTH-D2） |
| 一句话诉求 | 本项目 RTL 与验证工作已完成，但**引擎判定口径与证据管线缺陷使正确结论无法被采信**；请按 §6 批次修复，验收判据为 §6.5 的联合条件 |
| 状态 | 待工具方受理（项目侧不可自行关闭） |

> **转发说明**：本文件自包含，无需其他文档即可理解与复现。§0 给出一页速览，§7 给出可直接执行的复现清单。
> 深入细节与逐条溯源按 §11 索引到附件，附件均为项目内已落盘文件。

---

## 0. 给工具方的一页速览（TL;DR）

1. **症状**：`closure-assessment.json` 长期 `status = NOT_READY`、`review_verification_scenarios` /
   `review_verification_evidence` 长期「拒绝签核」，且**项目侧已无任何可自行关闭的阻断项**（实测 2026-09-11）。
2. **性质**：6 条阻断项 100% 可归因到 16 项工具缺陷；**不存在 RTL 缺陷、不存在激励缺口、不存在规格缺失**
   （截止本包提交：全量回归 **84/84 PASS**，功能覆盖率 **89.6%**，变异加权得分 **1.0**，独立 Oracle 冲突 **0**）。
3. **三类最危险的缺陷**（不是显示问题，而是**证据完整性**问题）：
   - **#13 / #17**：故障注入运行、覆盖率运行会**改写/覆盖**其他用途的黄金证据文件（实测各发生 1 次）；
   - **#8 / #16**：Formal 证据使用**异构 rtlHash 空间**，既导致 Formal verdict 被整体判无效，又会**反向污染仿真 hit**，
     使场景新鲜度被**永久钉在 `IMPACT_UNKNOWN`**（任何重跑都无法自愈）；
   - **SYNTH-D1**：`yosys-abc.exe` **未随包发布**，`run_logic_synthesis` 必然失败 → 综合/PPA 通道**无法产生任何证据**。
4. **一个可自证的事实**：本项目为**单时钟域**设计（`rtlqa/cdc/cdc_report.md`：时钟域 1、同步器 0、跨域路径 0），
   但引擎 R10 规则**按文件全文（含注释）文本匹配**，命中的正是顶层注释里「本设计没有 CDC」这句话 ⇒ 产出 2 条虚假 CDC 风险与场景。
5. **修复验收**：§6.5 给出 8 条联合验收判据；满足后本工程预期指标为
   `criticalClosed 87/88 → 88/88`、`impactUnknown 25 → 0`、`criticalInsufficient 15 → 0`、签核阻断 `6 → 0`。

---

## 1. 结论与影响量化

### 1.1 当前门禁（工具原始输出，2026-09-11）

| 指标 | 实测值 | 期望值 | 直接归因缺陷 |
|------|--------|--------|--------------|
| 签核包 `status` | `NOT_READY` | 可签核 | #8/#9(a)/#9(c)/#10/#16（组合） |
| 签核阻断项数 | **3**（closure）+ **3**（证据审查） | 0 | 见 §5 |
| `criticalClosed` | 87/88（99%） | 88/88 | **#16**（+#8） |
| `impactUnknown`（影响未知） | 25（其中 **15 个为已具名豁免场景**） | 0 | **#9(c)**、#16 |
| `criticalInsufficient`（缺第二独立 Oracle） | 15（**全部为已豁免场景**） | 0 | **#9(a)** |
| 证据审查「缺少有效 compileLogPath」 | 恒真（`compile_icarus.log` 0 字节） | 不出现 | **#10** |
| 证据审查「未找到 RTL 行/条件覆盖率」 | 恒真 | 不出现 | **#6** |
| 「既有当前 hash 新 hit 仍判 `IMPACT_UNKNOWN`」 | 1 个场景（`SCN-E33A9D4A`） | 0 | **#16** |
| 面板「规格缺口」 | 13 项 high（**12 项为误报**） | 1 | **#11** |
| 面板 P0「继续基础功能验证」 | 永久不可满足 | 消失 | **#12** |
| 综合通道 | 必然失败（ABC 缺失） | 产出网表/面积 | **SYNTH-D1** |

### 1.2 已发生的证据损坏（非理论风险）

| 事件 | 时间 | 事实 | 缺陷 |
|------|------|------|------|
| 黄金场景 hit 被改写 | 2026-09-10 06:53 | `scenario_hits.json` 中 `SCN-F6ED0063` 由 `passed=true`（`generatedAt=02:36:58Z`）→ `passed=false`（`generatedAt=06:53:44Z`），`reachCount +1`；已由后续全量回归恢复为 `passed=true`（`generatedAt=07:13:20Z`），但**被覆盖的历史记录不可追溯** | #13 |
| 回归判定被污染 | 2026-09-10 | 变异体证据被递归抓取 ⇒ 阻断项 3 → 4，`regressionsPassed` true → false | #14 |
| 功能回归原始证据被覆盖 | 2026-09-10 18:12 | 覆盖率模式运行（编译失败）覆盖同目录 `result.json`（84 用例 `passed:true` → `passed:false`），`compile_verilator.log` 26 678 B → 1 800 B | #17 |
| 误报成本 | 2026-09-10 | 2 条虚假 CDC 场景占用 W2 预算（1 个测试文件 3 条用例 + 1 个 Formal harness） | AIGV-D1 |

### 1.3 设计侧无缺陷的证据（供工具方判断“不是设计问题”）

| 项 | 事实 | 证据 |
|----|------|------|
| 全量功能回归 | **84/84 PASS，0 failed，0 skipped**（Icarus + Cocotb，1 153 秒） | `verification/results/ddr_interleave_distributor/{result.json, results_icarus.xml}` |
| 功能覆盖率 | **89.6%（112/125 bins，10 个 covergroup，`samplingErrorCount = 0`）** | `functional_coverage.json` |
| 变异测试 | `weightedScore = 1.0`（阈值 0.9），MUT-M1..M4 全部 KILLED | `verification/intelligence/mutation-assessment.json` |
| 多 Oracle | 239 条 verdict 全 PASS，`conflicts = 0` | `verification/intelligence/oracle-evaluation.json` |
| CDC | 时钟域 1、同步器 0、跨域路径 0 | `rtlqa/cdc/cdc_report.md:12,14,15` |
| 可综合性 | `check_synthesizability`：可综合，Cells 2565 / Wires 13135 | `moonglass_synthesis_toolchain_defect_report.md` §3 |
| RTL 冻结 | 10 个 `.v` 的 md5 与 `rtlHash` 基线逐项一致（§9.2） | `rtl/filelist.f` + `structural-model.json` |

---

## 2. 环境与可复核性

| 项 | 值 |
|----|----|
| OS / 区域设置 | Windows 10/11 x64，系统 ANSI 代码页 **GBK（936）** |
| MoonGlass | 0.9.0；`resources/app.asar` 293 781 795 B（2026-09-08）；`resources/pi-runtime.asar` 51 679 806 B（2026-09-08） |
| 项目路径 | `D:\项目信息\知识库\Flow_Cross`（**含非 ASCII 目录**，与 #6 相关） |
| Verilator / make / 编译器 | Verilator 5.040（`C:\msys64\mingw64\bin\verilator_bin.exe`）/ MSYS2 make（UTF-8 运行时）/ MSYS2 mingw64 g++ |
| Python / Cocotb | Python 3.13.7 / cocotb 2.0.1（均以 `python -X utf8` 调用） |
| Yosys / solver | Yosys 0.67+84（git e2c27aaaf）；boolector / bitwuzla / z3 均在包内 |
| 顶层 / 规模 | `ddr_interleave_distributor`，10 个 RTL 文件、APB 配置寄存器 32 位、3 个 DDR region |
| 关键约定 | 中文/非 ASCII 路径、GBK 控制台；证据目录固定为 `verification/results/<module>/` |

**可复核性承诺**：本包所有“根因”都在**随包发布的产物内**给出可定位锚点（函数名 + 打包副本字节偏移 + 代码片段）。
字节偏移仅对本版本（0.9.0）有效，**函数名为稳定锚点**（见 DEFECT-REG-001 §2 的取证方法）。
若工具方源码与随包 bundle 存在差异，请以函数语义为准，我们配合复核。

---

## 3. 缺陷总表（16 项）

### A 组｜引擎判定口径与状态派生（5 项）

| ID | 严重级 | 组件（函数） | 一句话 |
|----|--------|--------------|--------|
| #8 | **P0** | `runFormalVerification` / `buildMultiOracle.addVerdict` | Formal 证据 `rtlHash` 与工作区口径不同 → 全部 Formal verdict 被判无效，且已校验的 hash 会被回写覆盖 |
| #9(a) | P1 | `buildMultiOracle` | 关键场景计数未排除 `WAIVED/EXCLUDED` → 15 个已豁免场景永久计阻断 |
| #9(c) | P1 | `assessClosure` / `refreshScenarioWithHits` | `impactUnknown` 未排除闭环场景，且 `IMPACT_UNKNOWN` **粘滞不可恢复** |
| #16 | P1 | `scenarioHits()`（Formal 合并循环） | Formal 结果以异构 hash **覆盖仿真 hit 的 `rtlHash`** → 场景被永久钉在 `IMPACT_UNKNOWN` |
| AIGV-D2 | P1 | `engine.ts` 新鲜度派生 | 陈旧 Formal 证据可覆盖当前仿真证据，`freshness` 回退历史值 ⇒ 状态该降级却不降级 |

### B 组｜证据管线与运行隔离（5 项）

| ID | 严重级 | 组件（函数） | 一句话 |
|----|--------|--------------|--------|
| #10 | P1 | `collectEvidenceFiles` + 结果落盘 | 强制要求 `compileLogPath`，但 Cocotb+Icarus 路径写出 **0 字节**日志，`compileExitCode` 还与 `passed` 矛盾 |
| #13 | **P0** | `writeScenarioHits` | 故障注入运行的**预期失败**被当成项目场景证据并覆盖黄金 hit |
| #14 | P1 | `collectResults` | 递归抓取 `verification/results/**/result.json`，非回归证据计入回归判定 |
| #15 | P2 | `collectMutationAssessment` | 只认 `records[]`，schema 不符时**静默忽略**且无告警 |
| #17 | P1 | 结果落盘路径（`mode` 共用） | 覆盖率运行覆盖写同目录功能回归 `result.json`，并制造虚假「修复失败回归」阻断 |

### C 组｜启发式误报（3 项）

| ID | 严重级 | 组件（函数） | 一句话 |
|----|--------|--------------|--------|
| #11 | P2 | `requirementModel` / `deriveSpecGaps` | `TBD` 正则命中「`TBD-xxx 已关闭`」结论文本 → 12 项虚假高置信 Spec Gap |
| #12 | P2 | `deriveVerificationActions` | W1 下一步建议忽略 `WAIVED` → 生成永久不可满足的 P0 卡片 |
| AIGV-D1 | P1 | `engine.ts:85 / 519-522` | R10「CDC Interaction」按**文件全文（含注释）**匹配 → 单时钟设计被判跨时钟域 |

### D 组｜环境 / 打包 / 工具链（3 项）

| ID | 严重级 | 组件 | 一句话 |
|----|--------|------|--------|
| #6 | **P1（等效 P0）** | `runVerilatorSimulation`（`@moonglass/eda-bridge/src/simulation.ts`） | 非 ASCII 项目路径下 Verilator `.mk` 依赖行被 GBK 编码 → make 必然失败，RTL 覆盖率**无法采集** |
| SYNTH-D1 | **P0** | 工具链打包 | `yosys-abc.exe` **未随包发布** → `run_logic_synthesis` 必然在 ABC 阶段失败 |
| SYNTH-D2 | 待定假设 | Yosys `ALUMACC`（非工具方独有） | 全设计 `synth` 在 ALUMACC 阶段无错误信息中断，日志内嵌 GBK 破坏的绝对路径（**假设，未证实**） |

---

## 4. 缺陷详情

> 每条统一 6 段结构：**现象 → 根因（代码级锚点）→ 最小复现 → 实测量化后果 → 建议修复 → 验收判据**。

### 4.1 组 A：引擎判定口径与状态派生

#### A-1｜#8（P0）Formal 证据 `rtlHash` 口径与工作区不一致，且 verdict 被覆盖写

**现象**

- `verification/formal/results/` 下 **16 条** `formal-result.json` 全为 `PASS/PROVEN/COVERED`，
  但其 `rtlHash` 分裂为 **三个互不相同的值**：`9d2c1948…`（11 条）、`6c983613…`（3 条）、`39702549…`（2 条）；
  另有 2 条已按取代关系归档到 `verification/formal/superseded/`；
  而 `verification/intelligence/structural-model.json` 的 `rtlHash = d3da3be4577e80a6…` —— **与上述三个值无一相等**。
  （三个 Formal 值彼此也不相等，说明它随「传入文件清单 + 任务目录」变化，而非稳定哈希空间。）
- `buildMultiOracle` 的有效性过滤要求**全等**：

```js
const valid = relevant.filter((item) =>
  item.rtlHash === rtlHash && item.evidence.length > 0 && definitionsById.has(item.oracleId))
```

⇒ 全部 Formal verdict 被判**无效**，`SCN-E33A9D4A`（唯一 required Formal 义务）无法派生 `FORMAL_PROVED`。

**根因（代码级）**

- Formal 侧哈希只对**本次调用传入的 rtlFiles** 计算，先对文件名排序，且使用**传入的字符串形式**（正斜杠）：

```js
const rtlHash = createHash('sha256')
for (const relativeFile of [...options.rtlFiles].sort()) {
  const file = resolve(workspace, relativeFile)
  rtlHash.update(relativeFile).update('\0').update(readFileSync(file)).update('\0')
}
```

- 工作区侧 `computeRtlHash()` 按 `rtl/design.json` + `rtl/filelist.f` **顺序**、使用
  `relative(workspace, file)`（Windows 反斜杠）与文本更新 ⇒ **两个哈希空间永不相同**。
- 次要缺陷：`addVerdict` 采用「先删同 key、后插入」，且处理顺序为「先 `oracle_verdicts.json`/仿真 hits、
  后 Formal 结果」，`rtlHash: verdict.rtlHash ?? data.rtlHash` 使**外部写入的正确哈希也被改回 COI 哈希**。

**最小复现**

1. 对单文件 `rtl/region_decode.v` 调用 `run_formal_verification(mode="prove")`；
2. 读 `verification/formal/results/<task>/formal-result.json` 的 `rtlHash` → `9d2c1948…`；
3. 读 `verification/intelligence/structural-model.json` 的 `rtlHash` → `d3da3be4…`；
4. `build_verification_intelligence` 后该场景 `multiOracle.assessments[].status = INSUFFICIENT`，
   场景 `freshness` 降级、`closure = OPEN`。

**实测量化后果**：`formalToolErrors = 0` 却无一条 Formal 证据可采信；`criticalClosed` 上限被锁在 87/88。

**建议修复**

- 统一为**同一个哈希函数**（同一映射文件、同一顺序、同一分隔符、同一路径书写形式）；
- 或引入「子集证据」语义：Formal 仅加载子集 RTL 时按 `scenarioId + propertyFiles + 文件集合` 校验，
  不与整设计哈希强制全等；
- 同一场景多份 Formal 证据合并时，**已通过校验的 verdict 不得被后续 `addVerdict` 改写 `rtlHash`**。

**验收判据**

- 同一工作区下 `formal-result.json.rtlHash` 与 `structural-model.json.rtlHash` **逐字节相等**；或子集语义生效；
- 重复调用 `build_verification_intelligence` 不再出现「verdict 存在但被判无效」。

---

#### A-2｜#9(a)（P1）多 Oracle 判定未排除已豁免/已剔除场景

**现象与根因**

```js
criticalInsufficient: assessments
  .filter((item) => item.requiredIndependentPasses === 2 && item.status === "INSUFFICIENT")
  .map((item) => item.scenarioId)
```

`assessments` 对**全部** Scenario 生成，**缺 `closure` 过滤**。于是 15 个已具名豁免（`WAIVED`）场景
永久计入阻断项「N 个关键 Scenario 尚未获得两个独立 Oracle 的有效 PASS」。

**对照事实（证明是口径不一致，而非设计意图）**：同一文件 `assessClosure` 对关键场景使用了**正确**口径：

```js
const criticalClosed = critical.filter((item) =>
  item.state.closure === "VERIFIED" || item.state.closure === "EXCLUDED" || item.state.closure === "WAIVED")
```

`classifyCoverageHoles` 亦先 `filter(status ∉ {VERIFIED, FORMAL_PROVED, WAIVED})`，因此 Coverage Hole 阻断项
已随豁免正确归零（6 → 0）。**同一产品内两套口径**是本缺陷的核心证据。

**最小复现**：对任一 Scenario 执行 `record_scenario_adjudication(status="WAIVED")`（需先有具名审批），
重建后 `oracle-evaluation.json.criticalInsufficient` **仍包含该场景 ID**。
当前该列表 15 项全为 `WAIVED` 场景（`SCN-409EE040`、`SCN-1349C450`、`SCN-F71E628D`、`SCN-84B10BD3`、
`SCN-EDEBA086`、`SCN-FB50FFB6`、`SCN-14678081`、`SCN-40E67E3C`、`SCN-380AF64D`、`SCN-507A052D`、
`SCN-B1733205`、`SCN-4D097B16`、`SCN-5F556092`、`SCN-1EC09C42`、`SCN-8F3B7CA3`）。

**实测量化后果**：阻断项「15 个关键 Scenario 尚未获得两个独立 Oracle 的有效 PASS」**100% 由本缺陷造成**。
轨迹：补强前 `criticalInsufficient = 16`（15 豁免 + 1 真实缺口 `SCN-E33A9D4A`）；项目侧为后者补入
reference-model + metamorphic-relation 两个独立域后降至 15，此后不再下降。

**建议修复**：`criticalInsufficient` 只统计 `closure ∉ {WAIVED, EXCLUDED}` 且 `criticality ≥ 0.8` 的场景；
复用 `critical` 过滤集合，避免三处口径漂移。

**验收判据**：豁免后该列表长度随豁免数量**单调下降**；本工程应从 15 → 0（保留 `SCN-E33A9D4A` 直至 #16 修复）。

---

#### A-3｜#9(c)（P1）影响未知未过滤闭环场景，且 `IMPACT_UNKNOWN` 粘滞不可恢复

**现象与根因**

```js
const impactUnknown = scenarios.filter((item) => item.state.freshness === "IMPACT_UNKNOWN").length
```

无闭环过滤 ⇒ 15 个已豁免场景（永不会再有新 hit）永久计入「25 个 Scenario 的 RTL 变更影响未知」。
同时新鲜度计算把旧值原样续用，形成**粘滞**：

```js
const rtlChanged = Boolean(item.rtlHash && item.rtlHash !== rtlHash)
const currentEvidence = Boolean(hit && (hit.rtlHash ? hit.rtlHash === rtlHash
                                              : !rtlChanged && item.state?.freshness !== 'IMPACT_UNKNOWN'))
const freshness = currentEvidence ? 'CURRENT' : rtlChanged ? 'IMPACT_UNKNOWN' : item.state?.freshness ?? 'CURRENT'
```

即：`freshness` 已为 `IMPACT_UNKNOWN` 时，若本场景**没有新 hit**（豁免场景必然如此）或 hit 无 `rtlHash`，
则**永远无法回到 `CURRENT`**；`rtlChanged = false` 也只会沿用旧值。

**第三类粘滞来源（2026-09-10 追加确认，根因见 A-4/#16）**：即使本场景**有**当前 `rtlHash` 的新 hit，
只要同场景存在 decisive 的 Formal 结果，`scenarioHits()` 会用 Formal 口径的 `rtlHash` **替换**该 hit 的
`rtlHash`，于是 `hit.rtlHash === rtlHash` 判假、`rtlChanged` 判真 ⇒ 仍被钉在 `IMPACT_UNKNOWN`。

**最小复现**

1. 记录 `impactUnknown = N`；
2. 对其中任一场景 `record_scenario_adjudication(WAIVED)`；
3. 重建后 `impactUnknown` **不变**，且该场景 `state.freshness` 仍为 `IMPACT_UNKNOWN`；
4. （#16 路径）对同时具备「当前 hash 仿真 hit」与「Formal PROVEN」的场景重建：
   `freshness = IMPACT_UNKNOWN`、`status = PARTIAL`、`closure = OPEN`，
   而同场景 `oracle-evaluation.json.status = PASS` —— **两个机器结论互相矛盾**。

**实测量化后果**：阻断项「25 个 Scenario 的 RTL 变更影响未知，必须执行影响回归」长期恒真，
而项目侧**无法通过任何重跑使其下降**（已实测 4 次 Formal 重跑 + 1 次全量 84 用例回归）。

**建议修复**

- `impactUnknown` 排除 `closure ∈ {WAIVED, EXCLUDED}`；
- 已闭环场景在**无 hit 更新**时，应依据「最近一次有效证据的 `rtlHash`」显式判定，不允许历史值粘滞；
- 提供「重新评估新鲜度」入口（如 `refresh=true` 时按当前 RTL 与最近证据重算）；
- 仿真 hit 的 `rtlHash` 不得被 Formal 异构 hash 覆盖（见 A-4）。

**验收判据**：豁免后 `impactUnknown` 应下降；`SCN-E33A9D4A` 修复后应 `freshness = CURRENT`、`closure = VERIFIED`。

---

#### A-4｜#16（P1）Formal 结果以异构 hash 覆盖同场景仿真 hit 的 `rtlHash`（状态永久粘滞）

**现象**

`SCN-E33A9D4A` 同时具备：
(a) `scenario_hits.json` 中 `rtlHash = d3da3be4…` 的**当前** PASS hit（84/84 全量回归）；
(b) 12 条 Formal 结果中 outcome = `PROVEN` 的所需义务证据（`rtlHash = 9d2c1948…` / `6c983613…`）。

重建后该场景：

```
state: { lifecycle: EXECUTED, reach: REACHED, judgment: PASS, evidence: COMPLETE,
         freshness: IMPACT_UNKNOWN, closure: OPEN }
status: PARTIAL
```

而同一时刻 `oracle-evaluation.json` 中该场景 `status = PASS`（3 个独立域）。
**工作区磁盘上的 `scenario_hits.json` 未被修改**（仍为 `d3da3be4…`）——污染仅存于引擎构建期内存，
因此**无法通过改磁盘文件规避**。

**根因（代码级）**：`scenarioHits()` 先读 `verification/results/**/scenario_hits.json` 构造 hits，
再用 Formal 结果**整体替换**同 id：

```js
for (const result of collectFormalResults(workspace)) {
  if (!result.scenarioId) continue
  const status = result.outcome === "COUNTEREXAMPLE" ? "FAILED"
               : result.outcome === "PROVEN" ? "FORMAL_PROVED" : ... : "PARTIAL"
  const existing = hits.get(result.scenarioId)
  const decisive = ["COUNTEREXAMPLE", "PROVEN", "PROVEN_UNREACHABLE", "COVERED"].includes(result.outcome)
  if (!decisive && existing) continue
  hits.set(result.scenarioId, { status, evidence: [...], reachCount: ...,
                               assertionPassed: ..., rtlHash: result.rtlHash ?? existing?.rtlHash })
}
```

`rtlHash: result.rtlHash ?? existing?.rtlHash` 把 **Formal 文件清单口径**的 hash 写进了**仿真 hit**；
后续 `refreshScenarioWithHits()` 的 `hit.rtlHash === rtlHash` 因而不成立 ⇒ `rtlChanged = true`
⇒ `freshness = 'IMPACT_UNKNOWN'` ⇒ `status` 降级为 `PARTIAL` ⇒ `closure = OPEN`。

**与 #8 的关系**：#8 是「Formal 证据自身 hash 与工作区不一致」；#16 是「不一致的 hash **反向污染仿真 hit**」，
是同一 hash 口径缺陷的第二个作用面。**#16 可独立修复**，不必等 #8 的口径统一。

**最小复现**

1. 对某场景用 `run_simulation(scenarioIds=[...])` 登记当前 `rtlHash` 的 PASS hit；
2. 该场景在 `verification/formal/results/` 下有 outcome = `PROVEN` 的结果（hash 与工作区不同）；
3. 调用 `build_verification_intelligence`；
4. 读 `scenario-registry.json`：`state.freshness === 'IMPACT_UNKNOWN'`、`status === 'PARTIAL'`、`closure === 'OPEN'`，
   而磁盘 `scenario_hits.json` 中该场景 `rtlHash` 恰等于工作区 hash。

**项目侧已做的排除性实验（2026-09-10 18:13，W3 复核轮次）**
按场景 ID 绑定重跑 4 个 Formal 任务，以排除「Formal hash 不同是因为传入文件集不完整」这一替代解释：

| 任务 | 模式 | 传入 `rtlFiles` 口径 | 结果 | `formal-result.json.rtlHash` |
|------|------|----------------------|------|------------------------------|
| `scn_e33a9d4a_region_pair_prove` | prove | 仅 `rtl/region_decode.v` | PASS / PROVEN | `9d2c1948743c1671…` |
| `scn_e33a9d4a_region_decode_cover` | cover | 仅 `rtl/region_decode.v` | PASS / COVERED（9 trace） | `9d2c1948743c1671…` |
| `scn_e33a9d4a_region_pair_prove_full` | prove | `rtl/filelist.f` 全部 10 个 `.v` | PASS / PROVEN | `6c983613d55b8fd9…` |
| `scn_e33a9d4a_region_decode_cover_full` | cover | `rtl/filelist.f` 全部 10 个 `.v` | PASS / COVERED | `6c983613d55b8fd9…` |

结论三点：

1. **与文件集完整性无关**：传入与仿真完全相同的 10 文件清单后，Formal 侧仍是另一个异构值 `6c983613…`
   ⇒ 二者确为两套独立口径（#8/#16 结论加强）；
2. **`scenarioId` 绑定本身有效**：重建后该场景 `evidence[]` 已出现对应 `formal-result.json` 与 trace 路径；
3. **状态逐字段不变**：证明在当前实现下**任何 Formal 重跑都无法把该场景推出 `IMPACT_UNKNOWN`**。

**建议修复**

- 仿真 hit 与 Formal 结果各自保留所属 hash 空间（如 hit 增加 `formalRtlHash` 字段，不与 `rtlHash` 混用）；
- 或先做「Formal 属性集合是否覆盖当前 RTL」的覆盖判定，再决定是否允许改写 hit 状态；
- 合并规则改为「decisive 结果只补充 evidence，不覆盖既有 hit 的 `rtlHash`」。

**验收判据**：修复后 `SCN-E33A9D4A` 应直接满足 `freshness = CURRENT`、`closure = VERIFIED`、
`criticalClosed = 88/88`（其 3 个独立域 PASS 证据已在 `verification/results/oracle_verdicts.json`）。

---

#### A-5｜BUG-AIGV-001 D2（P1）陈旧 Formal 证据可覆盖当前仿真证据，`freshness` 回退历史值

**现象**：`SCN-A386F9C1` 状态为 `FORMAL_PROVED`，但其 `ORACLE-FORMAL-PROPERTY` 判定在
`oracle-evaluation.json` 中已被标 **invalid**（Formal 结果 `rtlHash = 39702549b422…` ≠ 当前 `d3da3be4…`），属**陈旧结果**。

**根因（代码级判定顺序）**：`engine.ts:937-947` 收集 Formal 结果并覆盖同场景既有（仿真）hit
（代码同 A-4）；`engine.ts:956-962` 刷新场景：

```js
const rtlChanged = Boolean(item.rtlHash && item.rtlHash !== rtlHash)
const currentEvidence = Boolean(hit && (hit.rtlHash ? hit.rtlHash === rtlHash : ...))
const freshness = currentEvidence ? 'CURRENT' : rtlChanged ? 'IMPACT_UNKNOWN' : item.state?.freshness ?? 'CURRENT'
if (freshness !== 'CURRENT' && ['VERIFIED','FORMAL_PROVED'].includes(status)) status = 'PARTIAL'
```

当 `hit.rtlHash` 为陈旧值（`currentEvidence = false`）而 `item.rtlHash` 已是当前值时，`rtlChanged` 亦为 `false`
⇒ `freshness` **回退到上一轮 state 的 `CURRENT`** ⇒ `FORMAL_PROVED` **未被降级**为 `PARTIAL`。

**实测量化后果**：场景状态标签与证据不匹配；若同类模式出现在其他场景，会让「由陈旧 Formal 结果支撑的
`FORMAL_PROVED`」进入签核包（比 A-4 的“过度保守”更危险，属**过度乐观**）。

**建议修复**：陈旧 Formal hit（`result.rtlHash !== 当前 rtlHash`）不得覆盖同场景当前仿真 hit；
`freshness` **不得回退** `item.state?.freshness`，命中自身 hash 不匹配即判 `IMPACT_UNKNOWN` 并触发降级。

**验收判据**：陈旧 Formal 存在时，场景不得显示 `FORMAL_PROVED`；`freshness` 与 `status` 降级逻辑一致。

---

### 4.2 组 B：证据管线与运行隔离

#### B-1｜#10（P1）证据审查强制 `compileLogPath`，Icarus 路径写出 0 字节日志且退出码自相矛盾

**现象（三类，同一路径）**

1. `review_verification_evidence` **恒定**返回阻断项：`verification\results\ddr_interleave_distributor\result.json 缺少有效 compileLogPath`；
2. 该字段**存在且指向真实文件**，但 `compile_icarus.log` **大小为 0 字节**（md5 `d41d8cd98f00`，即空文件）；
3. 同一 `result.json` 中 `passed: true, testsPassed: 84, testsFailed: 0`，却记录 `compileExitCode: 2`
   —— **成功回归的编译退出码为 2**，语义矛盾。

**根因（代码级）**

```js
const requiredEvidence = data.functionalPassed !== undefined && data.rtlCoveragePassed !== undefined
  ? ['functionalCompileLogPath', 'functionalSimulationLogPath', 'rtlCompileLogPath',
     'rtlSimulationLogPath', 'resultsXml', 'coverageDataPath', 'coverageReportPath']
  : ['compileLogPath', 'simulationLogPath', ...(data.framework === 'cocotb' ? ['resultsXml'] : [])]

for (const evidence of requiredEvidence) {
  const path = typeof data[evidence] === 'string' ? data[evidence] : ''
  if (!path || !existsSync(path) || statSync(path).size === 0)
    blockers.push(`${relative(ctx.cwd, file)} 缺少有效 ${evidence}`)
}
```

Cocotb + Icarus 模式不产出 `rtlCoveragePassed` ⇒ 落入 `else` 分支 ⇒ 要求 `compileLogPath` 为非空文件；
而该模式下 Icarus 由 Cocotb make 流程编译，工具写出的 `compile_icarus.log` 为空，
且 `compileExitCode` 未反映真实步骤结果。

**最小复现**

```
run_simulation(mode="cocotb", simulator="icarus", topModule="ddr_interleave_distributor",
               testDir="verification/ddr_interleave_distributor_tb", testModule="tests", trace=true)
review_verification_evidence()
```

观察：`compile_icarus.log` 0 字节 ⇒ 证据审查阻断项恒存在（与回归是否 84/84 PASS 无关）。

**实测量化后果**：这是「证据审查 3 条阻断」中的 1 条，且**项目侧无法关闭**（不能伪造日志、不能用临时 runner）。

**建议修复**

- Cocotb 模式下 `compileLogPath` 落盘为**非空**日志（含 icarus/cocotb 编译或 make 记录）；
  或证据审查对 `framework=cocotb && simulator=icarus` 以 `resultsXml + simulationLogPath` 为必需集合；
- `compileExitCode` 反映真实编译步骤结果（成功时为 0），不得与 `passed=true` 矛盾；
- 必需集合应由 `framework/simulator` 明确推导，并在审查报告中**回显判定依据**。

**验收判据**：84/84 PASS 的 Cocotb+Icarus 回归，`review_verification_evidence` 不再报该阻断。

---

#### B-2｜#13（P0）故障注入/变异运行改写黄金场景证据（缺少运行用途隔离）

**现象（实测）**：以变异体运行 `run_simulation(testcase="test_scn_f6ed0063_err_count_saturation", ...)`
（**预期 FAIL**，未传 `scenarioIds`）后，工具报告「已自动登记 1 个场景到 `scenario_hits.json`：`SCN-F6ED0063`」，
该场景由 `passed=true`（`generatedAt=02:36:58Z`）被改写为 `passed=false`（`generatedAt=06:53:44Z`），
`reachCount +1`，`diagnostic-control.json` 进入异常态。

即**故障注入的预期失败被当成项目场景证据**，会污染验证态势、签核包、批次完成判定（`judgeBatchCompletion`）
与 RTL 修复结果判定（`judgeRtlFixOutcome`）。

**根因（代码级）**

```js
for (const id of scenarioIds) {
  const previous = byId.get(id)
  byId.set(id, { ...previous, id, reached: true, passed: input.passed,
    reachCount: Number(previous?.reachCount ?? 0) + 1, rtlHash,
    evidence: [...new Set([...((previous?.evidence as string[]) ?? []), ...evidence])],
    generatedAt: new Date().toISOString() })
}
```

`passed` **无条件覆盖**旧值；场景 ID 既可由显式 `scenarioIds` 提供，也可由**用例名中的 `scn_<8hex>` 标记自动解析**
（本例未传 `scenarioIds`，仅因用例名含 `scn_f6ed0063` 即被登记）。函数**没有任何「运行用途」概念**，
无法区分正常回归与故障注入/变异/探针运行。

**最小复现**

1. 正常回归使某场景 `passed=true`；
2. 用同一用例名（含 `scn_<8hex>`）运行任一故意失败的变体 RTL（**不传** `scenarioIds`）；
3. `scenario_hits.json` 中该场景 `passed` 变为 `false`，且证据列表被追加变异运行证据。

**实测量化后果**：黄金证据被降级；恢复需重跑全量回归（本工程 1 153 秒 / 84 用例）；
签核包若引用该场景会引用到被污染版本。

**建议修复**：`run_simulation` 增加显式「运行用途」参数（`purpose: regression | mutation | probe`）
或证据隔离目录；非 `regression` 用途**不得写入** `scenario_hits.json`（或写入独立命名空间）；
至少当 `passed=false` 会覆盖既有 `passed=true` 时给出显式确认并保留先前证据。
（自动 ID 解析可保留，但必须受运行用途约束。）

**验收判据**：故障注入运行后 `scenario_hits.json` 的黄金 hit 逐字节不变；或写入隔离命名空间。

---

#### B-3｜#14（P1）递归抓取 `verification/results/**/result.json`，非回归证据计入回归判定

**现象与根因**

```js
function collectResults(workspace) {
  return walk(join(workspace, "verification", "results"), (file) => basename(file) === "result.json").map(...)
}
```

递归匹配**任意** `result.json`（含变异体、故障注入、探针运行证据），而 `assessClosure` 使用

```js
regressionsPassed = regressions.length > 0 && regressions.every((item) => item.passed)
```

**实测**：变异体证据以 `result.json` 命名后，本已关闭的 Mutation 阻断被**新增的「存在失败回归」替代**
（阻断项 3 → 4，`regressionsPassed` 由 true 变 false）。项目侧只能靠**改文件名**规避
（现改为 `mutant-run-result.json`）——这是典型的「工具缺陷转化为项目侧命名约定负担」。

**最小复现**：在 `verification/results/mutation/MUT-X/evidence/result.json` 写一份
`{"passed": false, "testsTotal": 1}`，`build_verification_intelligence` 后
`closure-assessment.json.metrics.regressionsPassed` 变为 `false`，阻断项出现「存在失败回归」。

**建议修复**：回归证据只认「当前 RTL 哈希 + 正式回归目录约定」的 `result.json`
（如 `verification/results/<topModule>/` 一层，或显式 `purpose=regression` 标记）；
带 `mutation/`、`fault/`、`probe/` 路径段或非当前 rtlHash 的证据不得计入 `regressions`；
递归发现到无法归属的证据时给出**显式提示**而非静默计入。

**验收判据**：写入任意非回归目录的失败 `result.json` 后，`regressionsPassed` 保持为 true。

---

#### B-4｜#15（P2）`mutation-results.json` 仅认 `records[]`，schema 不符时静默忽略

**现象与根因**

```js
for (const raw of data.records ?? [])
  records.push({ ...raw, weight: ..., evidence: [relative(workspace, file), ...raw.evidence ?? []],
                 rtlHash: raw.rtlHash ?? data.rtlHash })
```

引擎只读 `records[]`。项目按自述 schema 产出的 `verification/results/mutation-results.json`
（含 4 条 `results[]` 与 `killRate 1.0`）**无 `records`** ⇒ 采信 0 条 ⇒ `weightedScore = null`、`status = MISSING`，
与「无输出文件」表现完全相同，且**没有任何告警**，面板长期显示 Mutation 为空。

**最小复现**：写入含 `results[]`、无 `records[]` 的 `mutation-results.json` 后重建：
`mutation-assessment.json.status = "MISSING"`、`weightedScore = null`、无 warning/blocker。

**建议修复**：发现文件存在但无法解析出 `records[]` 时输出**显式告警**并指明期望 schema；
或兼容读取 `results[]` 并做字段映射；对 `records[].rtlHash` 缺失、`evidence` 为空分别给出可操作提示。

**验收判据**：schema 不符产生告警（而非静默 `MISSING`）；兼容映射后 4 条 KILLED 可被采信。

---

#### B-5｜#17（P1）覆盖率模式运行覆盖写同目录功能回归证据，并制造虚假回归失败阻断

**现象**：在 `rtlHash = d3da3be4…`（工作区基线）下，三种运行写入了**同一个**
`verification/results/ddr_interleave_distributor/result.json`：

| 时刻（本地） | 写入者 | `result.json` 关键字段 |
|--------------|--------|------------------------|
| 17:54 | `mode="cocotb"`（6 用例定向运行） | `passed: true`，`testsTotal: 6` |
| **18:12** | **`mode="cpp", rtlCoverage=true`（编译失败）** | **`passed: false`，`compileExitCode: 2`，`waveformPath: null`** |
| 18:32 | 重跑聚合功能回归（84 用例） | `passed: true`，`testsTotal: 84` |

后果四条：

1. 功能回归的原始 `result.json` 被一次**与功能无关的失败运行**覆盖，历史证据不可追溯恢复；
2. 同目录 `compile_verilator.log` 被截断重写（**26 678 B → 1 800 B**），前一轮 Verilator 编译明细丢失；
3. 重建后出现**新的虚假阻断项「修复失败回归」**（阻断项 3 → 4），把工具缺陷表现为项目侧回归失败；
4. 抵消该污染需重跑完整聚合回归（实测 **1 032 秒 / 84 用例**）。

**与 #13、#14 的关系**：三者同属「运行用途与证据目录未隔离」：#13 是变异注入改写黄金场景 hit，
#14 是递归抓取把非回归证据计入回归判定，#17 是非回归运行**直接覆盖**回归原始证据文件。**建议同批修复。**

**最小复现**

1. 记录 `verification/results/<module>/result.json` 的 `testsTotal` 与 `finishedAt`；
2. 调用 `run_simulation(mode="cpp", rtlCoverage=true, ...)`（非 ASCII 路径下必然编译失败，见 #6）；
3. 重新读取同一 `result.json`：内容已被 `passed: false` 覆盖；
4. `build_verification_intelligence` 后 `closure-assessment.json.blockers` 新增「修复失败回归」。

**建议修复**：不同 `mode`/用途的结果**分目录落盘**（如 `<module>/cpp/result.json`、
`<module>/mutant/<id>/result.json`），或写入用途标签并在收集时按用途过滤；
任何运行**不得覆盖**已存在且成功的回归原始证据；`closure-assessment` 的「修复失败回归」判定只应采信
与当前阶段回归用途一致的运行。

**验收判据**：覆盖率运行后功能回归 `result.json` 逐字节不变；不再出现虚假「修复失败回归」阻断。

---

### 4.3 组 C：启发式误报

#### C-1｜#11（P2）`TBD` 关键词命中「已关闭」句子 → 12 项虚假高置信 Spec Gap

**现象与根因**

```js
const isStructural = trimmed.startsWith("|") || trimmed.startsWith("#") || trimmed.startsWith("```")
if (!isStructural && /\b(?:TBD|TODO|待定|未定义|待确认)\b/i.test(line))
  unknowns.push({ id: `UNK-${unknowns.length + 1}`, ... })
```

`deriveSpecGaps` 对每条 unknown **一律** `confidence: "high"`；面板「规格缺口」取
`state.specGaps.filter((item) => item.confidence === "high").length`。

实测：13 项 high 中 **12 项**来自形如 `TBD-REQ-001 已关闭`、`TBD-ARCH-002（已关闭为 8）`、
`TBD-IF-001/002 已关闭` 的**结论文本**（`\bTBD\b` 在 `TBD-` 中仍命中），而句中「已关闭」从未被识别。
唯一真实缺口 1 项（工艺/电压/角点 TBD，归属项目组 PVT）。

**最小复现**：在 `docs/03_design/architecture.md` 中保留任一「`TBD-XXX 已关闭`」句子，
`build_verification_intelligence` 后该行即出现在 `specGaps[]`（`confidence=high`），面板计数 +1。

**建议修复**：识别「已关闭/已裁决/不适用/DEC-*」等**消解语义**（或仅在 `TBD` 后无消解标记时计为未定义）；
命中行含既有决策编号（`DEC-*`）时不得计入 high-confidence gap。

**验收判据**：本工程面板「规格缺口」应显示 **1**（而非 13）。

---

#### C-2｜#12（P2）W1 下一步建议忽略 `WAIVED`，生成永久不可满足的 P0 卡片

**现象与根因**

```js
if (w1 && w1.status === "in-progress" && (w1.specClauseTotal ?? 0) > (w1.specClauseCovered ?? 0)) {
  actions.push({ id: "wave-w1", priority: "P0", title: "继续基础功能验证",
    detail: `规格映射矩阵 ${w1.specClauseCovered}/${w1.specClauseTotal} 条款已覆盖，补齐剩余可验证规格的 happy path`, ... })
}
```

实测 W1：`specClauseTotal = 128`、`specClauseCovered = 119`，差值 **9 全部为已具名豁免条款**
（面积/功耗 TBD → SYNTH 阶段；PVT → 项目组；架构不适用 2 项；DFT → DFT 门禁；文档卫生 1 项），
另有 2 条 synthesis 通道条款单独统计。`MAPPED_UNTESTED = 0`、`FAILED = 0`，
即 W1 基础功能验证已 100% 完成，但该 P0 卡片**永远无法消除**，并把会话导向无对象的工作。

**最小复现**：`record_scenario_adjudication(status="WAIVED")` 关闭剩余条款后重建，
面板仍出现「继续基础功能验证 —— 规格映射矩阵 119/128 条款已覆盖」。

**建议修复**：覆盖口径改为 `covered = PASSED + WAIVED`（或扣除 `channel ∉ {simulation, static}` 的条款）；
当差值全部为 WAIVED/非仿真条款时，动作转为「阶段门禁/移交」类提示；W1 全闭环后该卡片**必须消失**。

**验收判据**：本工程面板不再出现该 P0 卡片。

---

#### C-3｜BUG-AIGV-001 D1（P1）R10「CDC Interaction」按文件全文（含注释）文本匹配

**现象**：本工程 RTL 为**单时钟域**设计（唯一时钟 `i_clk`，全部 `always` 敏感表为
`posedge i_clk or negedge i_rst_n`；`rtlqa/cdc/cdc_report.md:12/14/15`：时钟域 1、同步器 0、跨域路径无）。
但 `build_verification_intelligence` 仍产出 **2 条 `topic=跨时钟域`** 的风险与场景，W2 波报告呈现为「跨时钟域 2/2」。

**命中根因（源码级）**

1. 规则定义 `engine.ts:85`：

```js
{ taxonomyId: 'R10', title: 'CDC Interaction', features: ['cdc'],
  patterns: [/(?:sync|async|cdc|clk_[a-z0-9_]+).*?(?:sync|clk_[a-z0-9_]+)/is], ... }
```

单正则、带 `s` 标志（`.` 跨行）、`.*?` 允许任意长度间隔 ⇒ **同一文件内出现两次 `sync/async/cdc` 即命中**，
与是否存在第二个时钟无关。

2. 判定处 `engine.ts:519-522` 读取**整个文件文本**（含注释、字符串）后执行 `rule.patterns.every(...test(text))`。
3. 命中的实际是**文件头注释**：

| 风险 | 文件 | `source.line` | 命中的注释文本 |
|---|---|---|---|
| RISK-0039 | `rtl/ddr_interleave_distributor.v` | 8 | `//  ... (single clock domain, no CDC); i_rst_n is` |
| RISK-0001 | `rtl/ddr_reset_sync.v` | 2 | `// Module : ddr_reset_sync`（配合第 5 行 `Asynchronous assert / synchronous deassert`） |

**即：顶层注释中「本设计没有 CDC」这句话本身就是触发 CDC 规则的原因。**

**复现（可重复执行）**

```powershell
cd D:/项目信息/知识库/Flow_Cross
$env:PYTHONIOENCODING="utf-8"
python scripts/repro_aigv_r10_pattern.py
# 留档：
python scripts/repro_aigv_r10_pattern.py > verification/results/ddr_interleave_distributor/r10_pattern_repro.log
```

期望输出：命中 2 / 未命中 8，命中片段为 `'CDC); i_rst_n is\n//   async'` 与 `'sync\n// Project   : ...'`。

**实测量化后果**：风险寄存器 47 条中 2 条为纯误报（全库 `feature=cdc` 条目仅此 2 条）；
生成 2 条 `ENGINE_CANDIDATE` 场景并占用 W2 预算（1 个测试文件 3 条用例 + 1 个 Formal harness）；
**对读者产生事实性误导**（W2 报告「跨时钟域 2/2」会被理解为“设计存在时钟域交叉”）。

**建议修复（R1–R3）**

- **R1（S1）**：匹配前剥离注释与字符串字面量。
  ⚠️ **注意：单独 R1 不足以消除本工程误报**——剥离注释后 `ddr_reset_sync` / `u_reset_sync` / `w_rst_n_sync`
  等**标识符**仍含两次 `sync`（实测 `textHit=True`），必须与 R2 同时实施。
- **R2（S2）**：R10 改由**结构事实**判定。伪代码：

```js
const edges = alwaysSenseList.map(s => s.edgeSignal)
const clocks = new Set(edges.filter(isClockLike))
const hasCdc = clocks.size >= 2 && crossesClockPathExists(...)   // 或至少 clocks.size >= 2
```

  ⚠️ **修复陷阱（本工程实测踩到）**：敏感表中的 `negedge` 通常是**异步复位**
  （`posedge i_clk or negedge i_rst_n`）。若把所有边沿信号计入时钟集合，
  `ddr_reset_sync` 这类**单时钟复位同步器**会被再次误判为 CDC。
  必须按信号名/端口方向筛选：名称含 `clk|clock` 且不含 `rst|reset` 才计入时钟集合。
- **R3（S3）**：若短期保留文本规则——去掉 `s` 标志；要求同一行内出现两个**不同**时钟名；
  排除 `no CDC` / `single clock` 等否定句式。

**修复效果自检（项目侧实测）**

| 输入 | 引擎原规则 | R1+R2 修正后 | 时钟集合 |
|---|---|---|---|
| `rtl/ddr_interleave_distributor.v` | **命中（误报）** | no-cdc ✅ | `['i_clk']` |
| `rtl/ddr_reset_sync.v` | **命中（误报）** | no-cdc ✅ | `['i_clk']` |
| 其余 8 个 RTL 文件 | 未命中 | no-cdc ✅ | `['i_clk']` 或空 |
| 自检样例 A：真 CDC（`i_clk` + `i_clk_axi` + 2-flop） | 命中 | **CDC ✅（无漏报）** | `['i_clk','i_clk_axi']` |
| 自检样例 B：单时钟 + 注释含两次 `sync` | 命中（误报） | no-cdc ✅ | `['i_clk']` |
| 自检样例 C：单时钟 + 注释 “no CDC” | 未命中 | no-cdc ✅ | `['i_clk']` |

（样例 B/C 用于证明修正后**不会“修成瞎”**：真实双时钟结构仍被捕获。）

**验收判据**：本工程 R10 命中数 2 → 0；自检样例 A 仍判 CDC。

---

### 4.4 组 D：环境 / 打包 / 工具链

#### D-1｜#6（P1，等效 P0）非 ASCII 项目路径下 Verilator C++ 覆盖率编译必然失败

**一句话摘要**：在**中文/非 ASCII 项目路径**下，`run_simulation(mode="cpp", rtlCoverage=true)` 的 Verilator 编译必然失败：
Verilator 将用户测试台与覆盖率 hook 的**绝对中文路径按 GBK 编码写入生成的 `.mk` 依赖文件**，
而 MSYS2 make 按 UTF-8 解码这些字节，路径错乱导致 `No rule to make target`。
**覆盖率 hook 文件本身已被工具正常生成**——问题不在 hook 缺失，而在**路径编码错位**。

**复现步骤**

1. 在含中文/非 ASCII 目录的项目中调用：

```js
run_simulation(mode="cpp", topModule="ddr_interleave_distributor",
               tbCpp="verification/ddr_interleave_distributor_tb/sim/sim_main.cpp",
               rtlFiles=[...], rtlCoverage=true, trace=true)
```

2. 工具流程：生成 `sim_main.cpp` → 生成 `obj_dir/moonglass_coverage_hook.cpp` →
   调用 `verilator_bin.exe --cc --build --exe --Mdir <obj_dir> --coverage-* -CFLAGS -Dmain=moonglass_user_main`
   `<obj_dir>/moonglass_coverage_hook.cpp sim_main.cpp rtl/*.v`；
3. 编译在 make 阶段失败，退出码 2。

**实际行为（症状）**：`verification/results/<module>/compile_verilator.log` 末尾：

```
make: *** No rule to make target 'D:\��Ŀ��Ϣ\֪ʶ��\Flow_Cross\verification\...\obj_dir\moonglass_coverage_hook.cpp',
        needed by 'moonglass_coverage_hook.o'.  Stop.
%Error: make -C D:\��Ŀ��Ϣ\֪ʶ��\Flow_Cross\verification\...\obj_dir -f Vddr_reset_sync.mk -j 1 exited with 2
```

注意：报错路径中的中文目录显示为**乱码**（`��Ŀ��Ϣ`），而 Verilator 自身输出的 RTL 路径正常。
`result.json`：`{"passed": false, "compileExitCode": 2, "runExitCode": null}`。

**根因分析（已验证）**

- **5.1 hook 文件确实被生成**：`obj_dir/moonglass_coverage_hook.cpp` 存在（245 字节），
  内容为工具写入的标准 hook 模板（含 `VerilatedCov::write()`）。因此 “No rule” **不是文件缺失**。
- **5.2 `.mk` 中用户 `.cpp` 依赖路径被 GBK 编码破坏**。对 `obj_dir/Vddr_reset_sync.mk` 做字节级检查：

```
第 65 行（原始字节）：
  moonglass_coverage_hook.o: D:\\\xcf\xee\xc4\xbf\xd0\xc5\xcf\xa2\\\xd6\xaa\xca\xb6\xbf\xe2\\Flow_Cross\...
第 67 行（原始字节）：
  sim_main.o: D:\\\xcf\xee\xc4\xbf\xd0\xc5\xcf\xa2\\\xd6\xaa\xca\xb6\xbf\xe2\\Flow_Cross\...
```

  其中 `\xcf\xee\xc4\xbf\xd0\xc5\xcf\xa2` / `\xd6\xaa\xca\xb6\xbf\xe2` 分别是「项目信息」「知识库」的
  **GBK 编码**（按 GBK 解码正确，按 UTF-8 解码失败）。即：
  Verilator（mingw 编译，ANSI 运行时）把命令行传入的绝对中文路径按系统代码页 **GBK** 写成字节，
  MSYS2 make 读取时按 **UTF-8** 解码 ⇒ 得到与文件系统 UTF-16 文件名不一致的乱码路径 ⇒ `No rule to make target`。
  RTL `.v` 不作为 make 依赖（Verilator 编译期读入并生成 `V*.cpp`），因此只有**用户传入的 .cpp**
  （覆盖率 hook、testbench）触发此问题。
- **5.3 为什么项目侧本地补丁无法生效**：尝试修改
  `userdata/moonglass/pi-bridge/eda-bridge/simulation.ts`（改相对 ASCII 路径、以 `objDir` 为 cwd，含
  `MG-FIX-20260909` 标记）后重跑，行为**无变化** —— 运行时实际加载 `app.asar` 内的
  `node_modules/@moonglass/eda-bridge/src/simulation.ts`（Electron asar 打包版优先），
  磁盘上的 userdata 副本**不被加载**。⇒ **项目侧无可用工作区（workaround）**。

**影响与业务后果**

1. Windows + 中文/非 ASCII 项目路径下 `run_simulation(mode="cpp")` **全部不可用**（无论是否开启覆盖率）
   ⇒ Verilator RTL 覆盖率（行/分支/翻转/FSM）**无法采集**；
2. 直接阻断 W3 签核覆盖率门限（行 ≥90%、分支 ≥85%），并使 `review_verification_evidence` 恒定返回
   2 条覆盖率缺失阻断；
3. Icarus（Cocotb）功能回归**不受影响**；
4. 已知规避只有「把工作区迁到纯 ASCII 路径」——改变工作区约定且使既有证据引用失效，**不推荐作为长期方案**。

**修复建议（供官方参考）**：核心思路是**避免把含非 ASCII 的绝对路径传给 Verilator 的用户 `.cpp` 参数**。
在 `runVerilatorSimulation`（`node_modules/@moonglass/eda-bridge/src/simulation.ts`）中：

```ts
import { relative, resolve } from 'node:path'
// 1) 用户 .cpp 与 RTL 均以“相对 objDir 的 ASCII 相对路径”传入
const relPath = (p: string) => relative(objDir, resolve(p)).split('\\').join('/')
const hookArg = 'moonglass_coverage_hook.cpp'
const tbArg   = relPath(tbCpp)
const rtlArgs = (rtlFiles ?? []).map(relPath)
// 2) 以 objDir 为 cwd 执行 verilator，使相对路径可解析
const { stdout: ccOut, ... } = await run(verilatorPath, ccArgs, verilatorEnv, signal, objDir)
```

这样 Verilator 写入 `.mk` 的将是 ASCII 相对路径（如 `../sim_main.cpp`、`moonglass_coverage_hook.cpp`），
MSYS2 make 在 `obj_dir` 工作目录下可正确解析。备选：写 `.mk` 时统一 UTF-8 或相对路径；
检测到非 ASCII 项目路径时给出**明确错误提示**而非静默失败；增加 `buildDir` 透传选项允许把 `obj_dir` 放到纯 ASCII 目录。

**验收判据**：非 ASCII 路径下 `mode="cpp"` 编译成功；`compile_verilator.log` 无乱码路径；
`run_simulation(mode="cpp", rtlCoverage=true)` 产出行/条件/翻转/FSM 覆盖率数据。

**附件**：`docs/04_verification/moonglass_verilator_coverage_bug_report.md`（含 `.mk` 字节证据与补丁 diff）。

---

#### D-2｜SYNTH-D1（P0）`yosys-abc` 未随包发布 → `run_logic_synthesis` 必然失败

**现象**：对顶层 `ddr_interleave_distributor` 及子模块 `burst_split` 调用综合，均以 `code=1` 结束，日志末尾：

```
10.22.1.1. Executed ABC.
Extracted 19347 gates and 23600 wires to a netlist network with 4250 inputs and 1330 outputs.
Running ABC script: <abc-temp-dir>/abc.script
ABC: '<yosys-exe-dir>/yosys-abc' 不是内部或外部命令，也不是可运行的程序
ERROR: ABC: execution of script ".../yosys-abc-tRGNfa/abc.script" failed: return code 1 (errno=0).
```

**字节级取证**：`D:/tools/MoonGlass-0.9.0/MoonGlass/userdata/moonglass/toolchains/bundled-aigv/aigv-toolchain/bin/`
实际内容为：

```
bitwuzla.exe  boolector.exe  sby-script.py  sby.cmd  sby.cmd.orig  slang.exe
yosys-smtbmc.cmd  yosys-smtbmc.exe-script.py  yosys.exe
```

在 `toolchains/` 全树检索 `*abc*`（maxdepth 4）与全盘 `/d/tools` 检索 `yosys*.exe` 均**无任何 ABC 可执行文件**。
即 `yosys.exe` 已随包发布，但其技术映射依赖 `yosys-abc(.exe)` **未随包发布**。

**影响判定**：`synth` 流程在 ABC 阶段必然中止 ⇒ `run_logic_synthesis` 无法产出网表/面积/时序报告；
因此**任何 PPA / 综合通道条款都无法通过工具产生证据**（与 RTL 质量无关）；
同时阻断 `run_logic_synthesis(scenarioIds=...)` 的 SYNTH 阶段场景登记路径（该路径要求综合成功）。

**对照证据（证明设计本身可综合）**：`check_synthesizability`（官方工具，轻量流程）对同一 10 个 RTL 文件、
同一顶层返回：✅ 可综合，Cells 2565，Wires 13135，Warning 140（全部为
`Replacing memory <reg array> with list of registers`，属小规模寄存器阵列展开的正常提示）。
该结果可作为 SPEC-PERF-004 / REQ-NFR-004 条款所声明的「综合报告（通用单元计数先行）」的阶段性依据，
但**不能被 `run_logic_synthesis` 的 scenarioIds 路径登记**（因 D1）⇒ 面积条款目前仍无法机器闭环。

**修复建议**：在 `bundled-aigv/aigv-toolchain/bin/` 补入与 Yosys 版本匹配的 `yosys-abc.exe`
（本机 Yosys 0.67+84，git e2c27aaaf）；修复后 D1 应消失。

**验收判据**：`run_logic_synthesis` 返回成功并产出网表、`*_synthesis.log`、面积/单元数报告。

---

#### D-3｜SYNTH-D2（待定假设）全设计 `synth` 在 ALUMACC 阶段中断

`effort=medium` 与 `effort=low` 两次全设计综合均在 Yosys 内部 pass 处**无错误信息中断**（非 ABC 阶段）：

| 尝试 | effort | 日志末尾 pass |
|---|---|---|
| 1 | medium | `16.14.3. Executing OPT_MUXTREE pass` |
| 2 | low | `16.12. Executing ALUMACC pass (create $alu and $macc cells)` |

日志显示 Yosys 内部单元名内嵌了**被 GBK 破坏的绝对路径**，例如：

```
creating $alu model for $macc $add$D:/$cf$ee$c4$bf$d0$c5$cf$a2/$d6$aa$ca$b6$bf$e2/Flow_Cross/rtl/burst_split.v:172$5911
```

（`D:/项目信息/知识库` 被写成 `D:/$cf$ee$c4$bf$d0$c5$cf$a2/$d6$aa$ca$b6$bf$e2`）

- **观测事实**：崩溃点在 ALUMACC（把常量除法展开出的 `$macc` 链实例化 `$alu`）；同目录的
  `check_synthesizability` 轻量流程**成功**。
- **假设（未证实）**：与 #6 同源的非 ASCII 路径编码问题，或 ALUMACC 在该规模下的资源耗竭。
- **结论口径**：D2 **尚为假设**，不得当作设计缺陷结论；D1 为确证事实。

**修复建议**：优先在纯 ASCII 路径（如 `D:/work/Flow_Cross`）下重跑全设计综合以判定其是否为路径编码问题；
若仍失败，按 ALUMACC 规模问题上报。在 D1/D2 修复前，PPA / 综合通道条款应统一记为
**C6 工具阻断**，而非「验证未执行」或设计残留风险。

---

## 5. 签核门禁映射（当前 6 条阻断 → 缺陷）

| # | 阻断项（工具原始文案） | 归因缺陷 | 修复后预期 |
|---|------------------------|----------|-----------|
| 1 | 「1 个 P0/P1 Scenario 尚未形成完整闭环证据」（`SCN-E33A9D4A`） | **#16**（+#8） | 场景 `closure = VERIFIED`，`criticalClosed 88/88` |
| 2 | 「25 个 Scenario 的 RTL 变更影响未知，必须执行影响回归」 | **#9(c)**（+#16） | `impactUnknown 25 → 0` |
| 3 | 「15 个关键 Scenario 尚未获得两个独立 Oracle 的有效 PASS」 | **#9(a)** | `criticalInsufficient 15 → 0` |
| 4 | 「`result.json` 缺少有效 `compileLogPath`」 | **#10** | 证据审查不再报该项 |
| 5 | 「未找到 RTL 行覆盖率」 | **#6**（+需要 #17 隔离） | 产出 Verilator 覆盖率数据 |
| 6 | 「未找到条件/分支覆盖率」 | **#6** | 同上 |

补充：修复前项目侧已实测「阻断项 4 → 3」（功能覆盖率模型落地后），**证明项目侧已无可自行关闭项**。
另：`rr` 警告类提示（39 条残余风险）**已由具名审批关闭**（24 `NEGATIVE_SPACE` + 15 `WAIVER`，
`approver = 验证负责人 李宇航`，`approvedAt = 2026-09-10`）；
但 `review_verification_scenarios` 仍把这 39 条标题原样列为「尚未批准」警告 —— 属**显示口径未反映审批状态**，请一并复核。

---

## 6. 建议修复批次与验收判据

### 6.1 批次 1（最高优先）：哈希口径统一 + 状态可恢复 → 解除 3 条 closure 阻断

`#8` + `#16` + AIGV-D2 + `#9(a)` + `#9(c)`
（共享 `closure` 过滤与 hash 空间两处改动，一次修改可同时消除 3 条阻断）。
**关键点**：`#16` **可独立于 `#8` 修复**，且是当前最后 1 个未闭环场景 + `impactUnknown` 粘滞的直接原因。

### 6.2 批次 2（证据完整性，最危险）：运行用途隔离 → 解除虚假回归阻断并保护黄金证据

`#13` + `#17` + `#14`（建议同批：运行用途标签 + 分目录落盘 + 收集时按用途过滤）。

### 6.3 批次 3：证据必要集合与落盘 → 解除 1 条证据阻断

`#10`（Cocotb 路径日志与 `compileExitCode` 语义）。

### 6.4 批次 4：环境/打包/启发式 → 解除覆盖率阻断与可信度问题

`#6`（非 ASCII 路径，含 `buildDir` 透传）→ 解除覆盖率 2 条证据阻断；
`SYNTH-D1`（补 `yosys-abc.exe`）→ 解除综合/PPA 通道；`SYNTH-D2`（ASCII 路径下复测）；
`#11` / `#12` / AIGV-D1（误报与不可满足卡片）；`#15`（schema 告警）。

### 6.5 联合验收判据（本工程可直接复核）

| # | 判据 | 复核方式 |
|---|------|----------|
| 1 | `formal-result.json.rtlHash` 与 `structural-model.json.rtlHash` 同源可比 | 重跑 Formal + 重建，比较字段 |
| 2 | 仿真 hit 的 `rtlHash` 不被 Formal 异构 hash 覆盖 | 重建后 `scenario_hits.json` 与内存判定一致 |
| 3 | `SCN-E33A9D4A` 变为 `freshness=CURRENT / closure=VERIFIED` | `scenario-registry.json` |
| 4 | `criticalClosed = 88/88`、`impactUnknown = 0`、`criticalInsufficient = 0` | `closure-assessment.json` / `oracle-evaluation.json` |
| 5 | 6 条阻断全部消失，`signoff-package.status` 可签核 | 两个 `review_*` + `signoff-package.json` |
| 6 | 故障注入/覆盖率运行后，黄金 `result.json` 与 `scenario_hits.json` 逐字节不变 | 前后 md5 比对 |
| 7 | 非 ASCII 路径下 `mode="cpp"` 编译成功并产出 RTL 覆盖率 | `compile_verilator.log` + 覆盖率文件 |
| 8 | `run_logic_synthesis` 成功产出网表与面积报告 | `imp/synthesis/` |

---

## 7. 工具方复现清单

### 7.1 最短路径（约 15 分钟，覆盖 5 类缺陷）

```powershell
cd D:/项目信息/知识库/Flow_Cross
$env:PYTHONIOENCODING="utf-8"

# ① #10 证据审查：Cocotb 回归后 compile_icarus.log 为 0 字节
#   （在 MoonGlass 中调用 run_simulation(mode="cocotb", simulator="icarus",
#     testDir="verification/ddr_interleave_distributor_tb", testModule="tests",
#     topModule="ddr_interleave_distributor") 然后 review_verification_evidence）
python -X utf8 -c "import os;p='verification/results/ddr_interleave_distributor/compile_icarus.log';print(os.path.getsize(p),'bytes')"

# ② AIGV-D1 R10 误报复现（只读，不修改任何文件）
python scripts/repro_aigv_r10_pattern.py
#   期望：命中 ddr_interleave_distributor.v(line 8 注释) 与 ddr_reset_sync.v(line 2 注释)

# ③ #8/#16 哈希异构证据（本工程已跑好的原始产物）
python -X utf8 -c "import json;print('workspace',json.load(open('verification/intelligence/structural-model.json',encoding='utf-8'))['rtlHash'][:24])"
python -X utf8 -c "import json,glob,os;[print('%-42s %-14s %s %s' % (os.path.basename(os.path.dirname(p)), json.load(open(p,encoding='utf-8')).get('outcome'), json.load(open(p,encoding='utf-8')).get('rtlHash','')[:20], json.load(open(p,encoding='utf-8')).get('scenarioId'))) for p in sorted(glob.glob('verification/formal/results/*/formal-result.json'))]"
#   期望：16 行均 PROVEN/COVERED，但 rtlHash 出现 9d2c1948…/6c983613…/39702549… 三个值，均 != 工作区 d3da3be4…

# ④ #13 证据覆盖：查看黄金场景 hit 的当前登记状态（其历史 false 记录已被覆盖）
python -X utf8 -c "import json;d=json.load(open('verification/results/ddr_interleave_distributor/scenario_hits.json',encoding='utf-8'));r=[s for s in d['scenarios'] if s['id']=='SCN-F6ED0063'][0];print({k:r.get(k) for k in ('id','passed','reachCount','generatedAt')})"

# ⑤ #6 非 ASCII 路径失败指纹（本工程已留存日志）
python -X utf8 -c "b=open('verification/results/ddr_interleave_distributor/compile_verilator.log','rb').read();print(b.decode('gbk','replace')[-600:])"
```

### 7.2 完整路径（覆盖 §5 全部 6 条阻断）

1. `run_simulation(mode="cocotb", simulator="icarus", ...)`（全量 84 用例，约 19 分钟）→ 记录 `result.json`、
   `results_icarus.xml`、`simulation_icarus.log`；
2. `build_verification_intelligence()` → 读 `closure-assessment.json`（3 阻断）与 `oracle-evaluation.json`
   （`criticalInsufficient` 15 全为 `WAIVED`）；
3. `review_verification_scenarios()` / `review_verification_evidence()` → 6 条阻断与 §5 完全一致；
4. `run_simulation(mode="cpp", rtlCoverage=true, ...)` → #6 失败指纹 + **#17 覆盖写**（对比步骤 1 的 `result.json` 指纹）；
5. `build_verification_intelligence()` → 新增虚假阻断「修复失败回归」（#17 / #14）；
6. `run_formal_verification(scenarioId="SCN-E33A9D4A", ...)` ×4 → 全部 PASS 但场景仍 `PARTIAL`（#16 / #8）；
7. `run_logic_synthesis(topModule="ddr_interleave_distributor")` → ABC 缺失失败（SYNTH-D1）。

---

## 8. 项目侧已采用的规避与残留影响（供工具方参考，非修复）

| 缺陷 | 规避手段 | 残留影响 |
|------|----------|----------|
| #8 | 在 `oracle_dual_domain_report.md` / `formal_verification_report.md` 保留双引擎 PROVEN 原始证据与哈希推导 | 机器派生状态仍 `PARTIAL`，需人工引用报告 |
| #9(a)/#9(c) | 具名豁免 + 在 `spec_adjudication_package.md` §3 逐项记录豁免前后计数 | 阻断项仍存在，需人工解释 |
| #10 | 以 `simulation_icarus.log`、`results_icarus.xml`、`scenario_hits.json` 作为功能回归证据 | 证据审查恒定返回该阻断项 |
| #11/#12 | 报告中显式说明 12/13 为误报、W1 已闭环 | 面板显示与真实状态不一致 |
| #13 | 变异运行后重跑黄金回归恢复证据 | 每次故障注入都需额外一轮全量回归 |
| #14 | 变异体证据改名 `mutant-run-*`（不叫 `result.json`） | 依赖命名约定，易被后续人员破坏 |
| #15 | 按引擎 schema 重写 `mutation-results.json`（`records[]`）并保留逐变异体原始证据 | 旧证据只能归档，不可追溯采信 |
| #16 | **无规避**（污染仅在引擎内存，磁盘 `scenario_hits.json` 正确） | 场景永久 `PARTIAL`；`criticalClosed` 上限 87/88 |
| #17 | 覆盖率尝试后立即重跑聚合功能回归恢复 `result.json` | 每次失败尝试额外消耗约 19 分钟；被覆盖的历史证据**不可追溯恢复** |
| #6 | **未采用**：唯一已知规避是迁移到纯 ASCII 路径（改变工作区约定，需项目组批准） | 覆盖率门禁无法满足；2026-09-10 18:12 复测仍为同一 `No rule to make target` 指纹 |
| SYNTH-D1 | **未采用**（无 `yosys-abc.exe` 可用） | PPA/综合通道条款无法机器闭环，已统一记为 C6 工具阻断 |

---

## 9. 证据索引

### 9.1 关键证据文件（大小 / 时间 / md5 前 12 位）

| 文件 | 大小 | 时间 | md5(12) | 说明 |
|------|------|------|---------|------|
| `verification/results/ddr_interleave_distributor/result.json` | 1 448 B | 2026-09-11 10:02:22 | `96692eb3b465` | 84/84 PASS；`compileExitCode: 2`（#10） |
| `.../results_icarus.xml` | 25 556 B | 2026-09-11 10:02:21 | `5ec926edb4a5` | 84 个 `<testcase>`，0 failure |
| `.../simulation_icarus.log` | 2 093 944 B | 2026-09-11 10:02:22 | `1aebd92256ea` | 全量回归日志 |
| `.../functional_coverage.json` | 10 394 B | 2026-09-11 10:02:15 | `108cc43539dc` | 112/125 = 89.6%，`samplingErrorCount=0` |
| `.../compile_icarus.log` | **0 B** | 2026-09-11 10:02:22 | `d41d8cd98f00` | **空文件（#10 直接证据）** |
| `.../compile_verilator.log` | 1 800 B | 2026-09-10 18:12:17 | `3368d9722c44` | #6 失败指纹；曾被 #17 从 26 678 B 截断 |
| `.../scenario_hits.json` | 57 898 B | 2026-09-10 18:17:43 | `1a70f4094928` | #13 污染对象（磁盘当前为修复后状态） |
| `.../ddr_interleave_distributor.fst` | 1 365 537 B | 2026-09-11 10:02:37 | `b62eeb0ffcdf` | 波形证据 |
| `.../r10_pattern_repro.log` | 2 698 B | 2026-09-10 16:09:08 | `ee9878a869a0` | R10 误报复现日志 |
| `verification/intelligence/closure-assessment.json` | — | 2026-09-11 02:33:46 | — | 3 阻断 + 12 项指标 |
| `verification/intelligence/oracle-evaluation.json` | 159 088 B | 2026-09-11 02:33:46 | — | 239 verdict 全 PASS；`criticalInsufficient=15` |
| `verification/intelligence/signoff-package.json` | — | 2026-09-11 02:33:46 | — | `NOT_READY`，`blockers=3`，`residualRisks=39` |
| `verification/formal/results/scn_e33a9d4a_*/formal-result.json` | 761–2 535 B | 2026-09-10 18:13 | — | 4 个任务（2 PROVEN / 2 COVERED），hash 异构（#16） |
| `verification/ddr_interleave_distributor_tb/sim/obj_dir/Vddr_reset_sync.mk` | — | — | — | 第 65/67 行 GBK 字节（#6 根因证据） |
| `imp/synthesis/ddr_interleave_distributor_synthesis.log` | — | — | — | ABC 缺失日志（SYNTH-D1） |

### 9.2 RTL 冻结指纹（`rtl/filelist.f` 顺序；与 `rtlHash = d3da3be4577e80a6…` 一致）

| 文件 | md5(12) |
|------|---------|
| `rtl/ddr_reset_sync.v` | `9d7da2f030d9` |
| `rtl/region_decode.v` | `33048c4538bd` |
| `rtl/interleave_engine.v` | `1d67763f8eb7` |
| `rtl/addr_remap.v` | `da0b4646f727` |
| `rtl/apb_cfg_regfile.v` | `3a10e38044cd` |
| `rtl/did_axi_master_port.v` | `9f0a5e2680d9` |
| `rtl/master_matrix.v` | `2f981092b413` |
| `rtl/response_reorder.v` | `d42ed0cb0af8` |
| `rtl/burst_split.v` | `e89781ad0e4b` |
| `rtl/ddr_interleave_distributor.v` | `88794f256d1a` |

> 说明：工具方若需对比，请在**相同 RTL 冻结状态**下复现，以保证哈希可比。

---

## 10. 边界声明（我们明确不宣称什么）

1. **不宣称 RTL 缺陷**：本包全部 16 项均定位在随包发布的工具产物内（函数级锚点 + 最小复现），
   不涉及本工程 RTL 或验证激励的修改建议；
2. **不宣称覆盖率达标**：行/条件/翻转/FSM 覆盖率**确实未采集**（受 #6 阻断），本项目从未在此项上虚报；
   功能覆盖率 89.6% 是**项目侧独立证据**（`functional_coverage.json`），不依赖工具派生；
3. **不宣称签核完成**：当前口径为 `NOT_READY` / 「拒绝签核」，本包不改变这一结论；
4. **不把假设当结论**：SYNTH-D2（ALUMACC）明确标注为**未证实假设**；其余 15 项均有字节级/代码级证据；
5. **不替工具方内部实现下结论**：所有根因均基于**随包 bundle** 的代码与行为；若源码版本有差异，请以函数语义为准；
6. **历史编号声明**：工程内编号 #1–#5、#7 仅出现在历史会话记录中，工作区内**无任何文件留证**，
   本包不代为转述以免失真；如需并入对外提交，请提供对应原始结论或允许按现存报告重新编号；
7. **未伪造任何审批**：`signoff-approvals.json` 中的 39 条审批均为具名责任人（验证负责人 李宇航）在
   `2026-09-10` 记录；Agent/工具不得代替用户生成审批。

---

## 11. 附件与深读指引

| 主题 | 附件 | 内容 |
|------|------|------|
| 缺陷登记主件（逐条溯源） | `docs/04_verification/moonglass_toolchain_defect_register.md` | #8–#17 全字段 + 取证方法 + 优先级建议 + 规避手段 |
| Verilator 覆盖率（#6） | `docs/04_verification/moonglass_verilator_coverage_bug_report.md` | `.mk` 字节证据、补丁 diff、环境信息 |
| AIGV 引擎（R10 误报 / 新鲜度） | `docs/04_verification/moonglass_aigv_engine_defect_report.md` | `engine.ts` 行号、复现脚本、修正自检表 |
| 综合通道 | `docs/04_verification/moonglass_synthesis_toolchain_defect_report.md` | ABC 取证、ALUMACC 日志、对照证据 |
| 豁免与口径实证 | `docs/04_verification/spec_adjudication_package.md` | 9 项 `BLOCKED_BY_SPEC` 与 15 项豁免的逐条依据（#9 实证） |
| 双域 Oracle 证据 | `docs/04_verification/oracle_dual_domain_report.md` | 独立域补强过程与计数轨迹（#9(a) 实证） |
| 规格缺口误报溯源 | `docs/04_verification/spec_gap_clarification.md` | 13 → 1 的逐条溯源（#11 实证） |
| R10 误报专项 | `docs/04_verification/aigv_r10_cdc_false_positive_finding.md` | 命中原注释与结构事实对比 |
| CDC 静态结论 | `rtlqa/cdc/cdc_report.md` | 时钟域 1 / 同步器 0 / 跨域路径 0 |
| 门禁与交付口径 | `docs/04_verification/verification_signoff_report.md` | 当前条件性签核口径、6 条阻断、明确不宣称项 |
| 复现脚本 | `scripts/repro_aigv_r10_pattern.py` | R10 规则复现（只读） |

---

## 12. 版本历史

| 版本 | 日期 | 作者 | 变更说明 |
|------|------|------|----------|
| 1.0 | 2026-09-11 | DID 验证组 | 首次发布：合并 DEFECT-REG-001（#8–#17）、#6、BUG-AIGV-001、BUG-SYNTH-001 为单一对外提交包；新增 §5 门禁映射、§6 修复批次与联合验收判据、§7 复现清单、§10 边界声明 |

---

## 13. 期望响应

1. 确认 16 项中哪些已受理、哪些需要补充信息（我们可在同一工作区按 §7 提供现场复现）；
2. 对**批次 1（#8/#16/#9(a)/#9(c)/AIGV-D2）**与**批次 2（#13/#17/#14）**给出修复计划——这两批直接决定
   本工程能否从「条件性签核」转为「可签核」；
3. 对 **#6** 明确是否按 §4.4 D-1 的相对路径方案修复，或提供 `buildDir`/ASCII 临时方案；
4. 对 **SYNTH-D1** 补包 `yosys-abc.exe`（阻断 PPA 通道）；
5. 修复版本发布后，我们将按 §6.5 联合验收判据执行复核，并把结果回填至
   `docs/04_verification/verification_signoff_report.md` 与 `verification_stage_handoff.md`。
