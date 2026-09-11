# AIGV 引擎 R10（CDC Interaction）误命中调查记录

- 调查对象：W2 增补波「跨时钟域 2/2」对应的 SCN-A386F9C1 / SCN-C5D0B826
- 正式缺陷单：**BUG-AIGV-001** → `docs/04_verification/moonglass_aigv_engine_defect_report.md`
- 结论：**设计为单时钟域，不存在真实 CDC 路径；该主题由引擎 R10 规则的文本误命中产生**
- 性质：验证智能引擎的启发式误报（false positive），**不是 RTL 缺陷，也不是未验证的风险缺口**
- 证据等级：源码级可复现（engine.ts 规则 + 正则对 10 个 RTL 文件的实测命中）
- 调查日期：2026-09-10

## 1. 结构事实（设计侧）

| 项 | 实测结果 | 证据 |
|---|---|---|
| 时钟端口 | 仅 `i_clk` 一个 | 10 个 RTL 文件端口扫描 |
| always 敏感表 | 全部为 `posedge i_clk or negedge i_rst_n` | `rtl/*.v` 全量正则提取 |
| 时钟域数量 | 1 | `rtlqa/cdc/cdc_report.md:12` |
| 同步器 | 0（无需） | `rtlqa/cdc/cdc_report.md:14` |
| 跨时钟域路径 | 无 | `rtlqa/cdc/cdc_report.md:15` |
| 跨域握手 | 不适用；`ddr_reset_sync` 仅做异步置位/同步释放 | `rtl/ddr_reset_sync.v:5` |

结论：R10 场景所假定的前提（源/目标时钟域、"目标时钟域采样"）在本设计中不存在。

## 2. 误报链路（引擎侧，源码级）

1. `verification-intelligence/engine.ts:519-522` `deriveRisks()` 读取**整个文件文本**（含文件头注释），逐条执行
   `rule.patterns.every((pattern) => pattern.test(text))`。
2. R10 规则定义（`engine.ts:85`）：
   `/(?:sync|async|cdc|clk_[a-z0-9_]+).*?(?:sync|clk_[a-z0-9_]+)/is`
   —— 单个正则、带 `s` 标志（`.` 跨行）、`.*?` 允许任意长度间隔，因此**同一文件内出现两次
   "sync/async/cdc" 即命中**，与是否存在第二个时钟无关。
3. 实际命中的是**注释文本**，而非 RTL 结构：

| 风险 | 文件 | source.line | 触发文本 |
|---|---|---|---|
| RISK-0039 | `rtl/ddr_interleave_distributor.v` | 8 | `All logic belongs to i_clk (single clock domain, no CDC);` |
| RISK-0001 | `rtl/ddr_reset_sync.v` | 2 | `// Module : ddr_reset_sync` 与第 5 行 `Asynchronous assert / synchronous deassert` |

   即：**顶层注释里"本设计没有 CDC"这句话，本身就是触发 CDC 规则的原因。**
4. 复现（对 10 个 RTL 文件跑同一正则）：仅上述 2 个文件命中，其余 8 个不命中。
   跨行匹配区间示例：`'CDC); i_rst_n is\n//   async'`（起点位于 `rtl/ddr_interleave_distributor.v:8`）。

## 3. 影响面

- 风险寄存器：47 条中 2 条为 R10（`RISK-0039` riskScore 0.807/criticality 0.8；`RISK-0001` 0.619）。
- 场景注册表：2 条 ENGINE_CANDIDATE 场景（`topic=跨时钟域`、`method=static`、`coordinates.interaction.type=CROSSES_CLOCK`、`requirementIds=REQ-001`）。
- 波形报告：W2「跨时钟域 2/2」为该项的唯一呈现，容易被读成"设计存在时钟域交叉"。
- 无其他 feature=cdc 的风险条目（全库仅此 2 条）。

## 4. 这两条场景实际验证了什么（并非空转）

`verification/ddr_interleave_distributor_tb/tests/test_corner_misc.py`：

| 用例 | 断言内容 | 判定性质 |
|---|---|---|
| `test_scn_a386f9c1_cdc_single_clock_evidence` | 仅存在 `i_clk` 端口；实例 `u_reset_sync` 存在；`rtlqa/cdc/cdc_report.md` 落盘；**在途流量中改配置（mask 0x0F→0x03）后拆分事务数等于金标准预期**（无丢失） | 证伪 CDC 前提 + 功能无脉冲丢失 |
| `test_scn_c5d0b826_cdc_reset_sync_release` | 异步拉低 `i_rst_n` 后同步释放，连续 6 拍读 `CFG_STATUS` 必须为 0（无幽灵首事务）；`s_axi_bvalid=0` | 异步置位/同步释放正确 |

- 补充 Formal：`verification/formal/f_ddr_reset_sync.sv`（`f_reset_sync_cover` / `f_reset_sync_prove`）。
- Oracle 评估：两条均为 `ORACLE-REFERENCE-SCOREBOARD`（reference-model）+ `ORACLE-INVARIANT-ASSERTION`（architecture-invariant）双独立域 PASS，assessment 状态 PASS。

因此这两条场景把"单时钟域"这一事实做成了**可执行证据**，其验证价值成立；问题只在于主题命名与它的来源（R10 误报），而不在于测试内容。

## 5. 账目卫生问题（附带发现，需修复）

`SCN-A386F9C1` 的场景状态为 `FORMAL_PROVED`，但其 `ORACLE-FORMAL-PROPERTY` 判定在
`oracle-evaluation.json` 中被标为 **invalid**（Formal 结果 `rtlHash=39702549…` ≠ 当前 `d3da3be4…`，即陈旧结果）。

- 判定顺序（`engine.ts:957-960`）：`currentEvidence` 为假时，若 `item.rtlHash === 当前 rtlHash`
  则 `rtlChanged` 亦为假，`freshness` 回退为上一轮状态值 `CURRENT`，状态因此保持 `FORMAL_PROVED`
  而未被降级为 `PARTIAL`。
- 影响：该场景 `closure=VERIFIED` 的 PASS 依据实际是**两个仿真 Oracle**（域名 reference-model 与
  architecture-invariant），Formal 那条是陈旧证据；状态标签对此表述不准确。
- 建议：陈旧 Formal hit 不应覆盖同场景的当前仿真 hit，或 freshness 判定应以 hit 自身的
  rtlHash 不匹配为唯一依据（不得回退到历史 state）。

## 6. 改进建议（引擎侧，非本工程 RTL 问题）

正式缺陷单（含源码级根因、伪代码修复方案、修复自检样例）已提交：
**`docs/04_verification/moonglass_aigv_engine_defect_report.md`（BUG-AIGV-001）**；
复现脚本 `scripts/repro_aigv_r10_pattern.py`，复现日志
`verification/results/ddr_interleave_distributor/r10_pattern_repro.log`。

| 编号 | 建议 | 目的 |
|---|---|---|
| R1 | 匹配前剥离注释与字符串字面量（`//`、`/* */`、`"…"`） | 消除"注释触发结构规则"这类系统性误报；**实测单独 R1 不足以消除本工程误报**（剥离后 `ddr_reset_sync`/`u_reset_sync` 等标识符仍含两次 `sync`） |
| R2 | R10 改为结构事实驱动：从时钟端口与 always 敏感表收集时钟集合，仅当集合基数 ≥2 时才置 `cdc` | 让规则语义与"跨时钟域"定义一致；**修复陷阱**：敏感的 `negedge i_rst_n` 是异步复位，若不加筛选会计入时钟集合，反而把单时钟复位同步器判成 CDC |
| R3 | 若保留文本规则：去掉 `s` 标志、要求同一行出现两个**不同**时钟名，并排除 `no CDC` / `single clock` 等否定句式 | 降低跨行任意间隔匹配带来的假阳性 |
| R4 | 陈旧 Formal hit 不得覆盖当前仿真 hit；`freshness` 不得回退历史 state | 修正第 5 节状态标签失真 |

修复效果实测（R1+R2）：本工程 10 个 RTL 文件全部回到 `no-cdc`，同时自造双时钟样例仍被正确判为 `CDC`（无漏报）。

## 7. 附：REQ-001 条款关系

`REQ-001#a`（单时钟域、无跨时钟路径）已由 `rtlqa/cdc/cdc_report.md` 静态确认；
`REQ-001#b`（若引入异步 `pclk` 则需 2-flop）为条件条款，因前提（异步 `pclk`）不存在而不适用。
本误报不改变这两条条款的判定。
