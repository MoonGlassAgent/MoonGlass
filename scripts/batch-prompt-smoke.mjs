// VERIF 上下文治理第 2 批：buildBatchPrompt 确定性批次 prompt（契约 §2.2）结构断言
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildVerificationIntelligence, buildBatchPrompt, recordRootCause } from '../packages/verification-intelligence-engine/src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'moonglass-batch-prompt-'))
mkdirSync(join(root, 'docs', '02_requirements'), { recursive: true })
mkdirSync(join(root, 'rtl'), { recursive: true })
mkdirSync(join(root, 'verification', 'results', 'dma'), { recursive: true })

writeFileSync(join(root, 'docs', '02_requirements', 'product_requirements.md'), `
# DMA Requirements

- REQ-DMA-001 P0: abort stops new requests while outstanding responses may complete.
- REQ-DMA-002 P0: timeout and late response priority shall be deterministic.
`, 'utf-8')

writeFileSync(join(root, 'rtl', 'dma_wr_ctrl.v'), `
module dma_wr_ctrl(input clk, input rst_n, input abort, input timeout, input bvalid, output reg [2:0] state);
  reg [3:0] outstanding_cnt;
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin state <= 0; outstanding_cnt <= 0; end
    else if (abort) state <= 3;
    else if (timeout) state <= 4;
    else if (bvalid) begin state <= 5; outstanding_cnt <= outstanding_cnt - 1; end
  end
endmodule
`, 'utf-8')
writeFileSync(join(root, 'rtl', 'design.json'), JSON.stringify({ topModule: 'dma_wr_ctrl', filelist: 'filelist.f' }, null, 2), 'utf-8')
writeFileSync(join(root, 'verification', 'results', 'dma', 'result.json'), JSON.stringify({ passed: true, testsTotal: 4, coverage: { lineCoverage: 92 } }, null, 2), 'utf-8')

const artifacts = buildVerificationIntelligence(root)
const scenarios = artifacts.verificationState.scenarios
if (scenarios.length < 3) throw new Error(`fixture 场景不足 3 个：${scenarios.length}`)
// v0.8.6 聚类批次：批次取自当前 cluster 的执行批（同模块同 Oracle 域；2026-10 起每批 2-6 个）
const cluster = artifacts.verificationState.executionClusters[0]
if (!cluster || !Array.isArray(cluster.executionBatches) || cluster.executionBatches.length === 0) throw new Error('执行计划缺少聚类视图')
const batchIds = cluster.executionBatches[0]
if (batchIds.length < 1 || batchIds.length > 6) throw new Error(`执行批超出 2-6 个约束：${batchIds.length}`)

// 根因交接数据：第一个场景一条 confirmed + 一条 refuted（链式）
const refuted = recordRootCause(root, { scenarioId: batchIds[0], hypothesis: '假设：abort 优先级高于 bvalid', verdict: 'refuted', refutedHypotheses: [], failureSignature: 'deadbeef0001', rootCause: '', fix: '', evidence: [] })
recordRootCause(root, { scenarioId: batchIds[0], hypothesis: '假设：outstanding_cnt 在 abort 周期被重复递减', verdict: 'confirmed', refutedHypotheses: [refuted.id], failureSignature: 'deadbeef0001', rootCause: 'abort 周期 bvalid 分支同时生效导致重复递减', fix: 'abort 分支屏蔽 bvalid 递减', evidence: ['verification/results/dma/result.json'] })

const prompt = buildBatchPrompt(root, batchIds)

// 三个场景详情段：每个场景 ID、objective/failureMode/passCriteria 文本齐备
for (const id of batchIds) {
  if (!prompt.includes(`场景 ${id}`)) throw new Error(`批次 prompt 缺少场景详情段：${id}`)
  const intent = artifacts.verificationState.verificationIntents.find((item) => item.scenarioId === id)
  if (intent && !prompt.includes(intent.objective)) throw new Error(`批次 prompt 缺少 ${id} 的 objective`)
  if (intent && !prompt.includes(intent.failureMode)) throw new Error(`批次 prompt 缺少 ${id} 的 failureMode`)
  if (intent && !intent.passCriteria.every((item) => prompt.includes(item))) throw new Error(`批次 prompt 缺少 ${id} 的 passCriteria`)
}

// 根因交接段：已证伪假设与已确认根因都从 root-causes.json 按 scenarioId 取出
if (!prompt.includes('根因交接')) throw new Error('批次 prompt 缺少根因交接段')
if (!prompt.includes(`已证伪假设（${refuted.id}`) || !prompt.includes('假设：abort 优先级高于 bvalid')) throw new Error('批次 prompt 缺少已证伪假设')
if (!prompt.includes('已确认根因') || !prompt.includes('abort 周期 bvalid 分支同时生效导致重复递减')) throw new Error('批次 prompt 缺少已确认根因')
if (!prompt.includes('abort 分支屏蔽 bvalid 递减')) throw new Error('批次 prompt 缺少已确认根因的修复动作')

// 纪律约束段：scenario_hits 自动登记、禁止手写、执行派生状态不可宣布
if (!prompt.includes('纪律约束')) throw new Error('批次 prompt 缺少纪律约束段')
if (!prompt.includes('run_simulation(scenarioIds=...)') || !prompt.includes('禁止手写')) throw new Error('纪律约束缺少 scenario_hits 自动登记条款')
if (!prompt.includes('执行派生状态') || !prompt.includes('不得宣布')) throw new Error('纪律约束缺少执行派生状态条款')
if (!prompt.includes('execution-summary.json')) throw new Error('纪律约束缺少状态入口路径')

// AIGV 修订批 3：UT 例外登记纪律 + 配置点场景执行纪律（§5.2/§5.3 确定性文本）
if (!prompt.includes('UT 例外纪律') || !prompt.includes('register_ut_escalation') || !prompt.includes('禁止为任何子模块单独搭建 Testbench')) throw new Error('纪律约束缺少 UT 例外登记条款')
if (!prompt.includes('configPoint.class') || !prompt.includes('illegal') || !prompt.includes('非法激励当 PASS 放行')) throw new Error('纪律约束缺少配置点场景执行条款')

// v0.8.6 聚类组语义段：同模块同 Oracle 域、一个测试文件 N 个 testcase、一次绑定全部 scenarioIds
if (!prompt.includes(`聚类组语义（${cluster.clusterId}）`)) throw new Error('批次 prompt 缺少聚类组语义段')
if (!prompt.includes(`模块 ${cluster.module}`) || !prompt.includes(`Oracle 域 ${cluster.oracleDomain}`)) throw new Error('聚类组语义缺少模块/Oracle 域')
if (!prompt.includes(`内含 ${batchIds.length} 个 testcase`) || !prompt.includes('一次绑定全部 scenarioIds')) throw new Error('聚类组语义缺少组 authoring 指引')

// 未知场景 ID 不得静默丢弃
const withUnknown = buildBatchPrompt(root, ['SCN-FFFFFFFF'])
if (!withUnknown.includes('SCN-FFFFFFFF') || !withUnknown.includes('不在 scenario-registry')) throw new Error('未知场景 ID 未被显式标注')

// 环境就绪摘要（2026-10 W1 实测：每批重复探索环境 20+ 次，摘要前移到确定性 prompt）：
// 无 tb 目录时不谎称就绪
if (!prompt.includes('环境状态：未就绪') || !prompt.includes('先按 module-verification-strategy')) throw new Error('缺环境未就绪指引')
// 有 tb 目录：结构 + README 摘录 + 免探索纪律
mkdirSync(join(root, 'verification', 'dma_wr_ctrl_tb', 'env'), { recursive: true })
mkdirSync(join(root, 'verification', 'dma_wr_ctrl_tb', 'sequences'), { recursive: true })
writeFileSync(join(root, 'verification', 'dma_wr_ctrl_tb', 'README.md'), 'DMA 验证环境说明：env 内含 driver/monitor/scoreboard。', 'utf-8')
writeFileSync(join(root, 'verification', 'dma_wr_ctrl_tb', 'env', 'dma_env.py'), '# env', 'utf-8')
const promptReady = buildBatchPrompt(root, batchIds)
if (!promptReady.includes('环境就绪摘要（verification/dma_wr_ctrl_tb）')) throw new Error('缺环境就绪摘要段')
if (!promptReady.includes('env/：dma_env.py') || !promptReady.includes('sequences/')) throw new Error('环境就绪摘要缺目录结构')
if (!promptReady.includes('DMA 验证环境说明')) throw new Error('环境就绪摘要缺 README 摘录')
if (!promptReady.includes('禁止 grep/find/ls -R') || !promptReady.includes('免探索纪律')) throw new Error('缺免探索纪律条款')

console.log(`Batch Prompt smoke passed: ${batchIds.length} scenarios, prompt ${prompt.length} chars`)
