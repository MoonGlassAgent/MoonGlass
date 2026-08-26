import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildVerificationIntelligence, registerVerificationHypotheses, reviewScenarioClosure } from '../packages/verification-intelligence-engine/src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'moonglass-verification-intelligence-'))
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
  always @(*) begin
    case (state)
      0: state = abort ? 3 : 0;
      3: state = bvalid ? 5 : 3;
      default: state = 0;
    endcase
  end
endmodule
`, 'utf-8')

writeFileSync(join(root, 'verification', 'results', 'dma', 'result.json'), JSON.stringify({
  passed: true,
  testsTotal: 8,
  coverage: { lineCoverage: 96, branchCoverage: 91, functionalCoverage: 90 }
}, null, 2), 'utf-8')

const first = buildVerificationIntelligence(root)
if (first.requirementModel.requirements.length !== 2) throw new Error('Requirement Model 未提取稳定需求')
if (first.structuralModel.facts.length === 0) throw new Error('Structural Model 为空')
if (first.structuralModel.stateMachines.length === 0) throw new Error('未提取 FSM')
if (first.structuralModel.registerWriters.length === 0) throw new Error('未提取寄存器写入关系')
if (first.structuralModel.clockResetDomains.length === 0) throw new Error('未提取时钟复位域')
if (first.structuralModel.temporalDependencies.length === 0) throw new Error('未提取时序依赖')
if (!first.risks.some((risk) => risk.taxonomyId === 'R01')) throw new Error('未识别 Event Collision')
if (first.verificationState.scenarios.length === 0) throw new Error('Scenario Registry 为空')
if (first.verificationState.interactionGraph.edges.length === 0) throw new Error('Feature Interaction Graph 为空')
if (first.verificationState.executionPlan.length === 0) throw new Error('Scenario Execution Plan 为空')
if (first.verificationState.verificationIntents.length === 0) throw new Error('Verification Intent 为空')
if (!first.verificationState.verificationIntents.some((intent) => intent.stimulus.temporalInteractions.some((item) => item.relation === 'SAME_CYCLE'))) throw new Error('未生成时间交互条件')
if (!first.verificationState.verificationIntents.some((intent) => intent.boundaries.length > 0)) throw new Error('未生成边界条件')
if (first.verificationState.specGaps.length === 0) throw new Error('未识别 Spec Gap')
if (first.verificationState.coverageHoles.length === 0) throw new Error('未分类 Coverage Hole')
for (const path of [first.paths.specGaps, first.paths.verificationIntents, first.paths.coverageHoles]) {
  if (!readFileSync(path, 'utf-8').trim()) throw new Error(`智能验证产物未落盘：${path}`)
}
if (reviewScenarioClosure(root).passed) throw new Error('关键 Scenario 未闭环时不应通过')

const rejected = registerVerificationHypotheses(root, [{ title: '无依据组合', riskIds: [], rtlObjectIds: [], interactionEdgeIds: [], claims: [{ kind: 'INFERENCE', text: '猜测', references: [] }] }])
if (rejected[0].status !== 'REJECTED') throw new Error('无依据假设应被拒绝')
const graph = first.verificationState.interactionGraph
const accepted = registerVerificationHypotheses(root, [{ title: '有结构证据的交互', riskIds: [first.risks[0].id], rtlObjectIds: [graph.nodes.find((item) => item.kind === 'rtl-object').id], interactionEdgeIds: [graph.edges[0].id], claims: [{ kind: 'RTL_FACT', text: '结构关系已存在', references: [first.structuralModel.facts[0].id] }] }])
if (accepted[0].status !== 'ACCEPTED') throw new Error(`有完整引用的假设应被接受：${accepted[0].rejectionReasons.join('; ')}`)

writeFileSync(join(root, 'verification', 'results', 'dma', 'results_icarus.xml'), '<testsuite tests="8" failures="0"/>', 'utf-8')
writeFileSync(join(root, 'verification', 'results', 'dma', 'dma.fst'), 'waveform-evidence', 'utf-8')

writeFileSync(join(root, 'verification', 'results', 'dma', 'scenario_hits.json'), JSON.stringify({
  scenarios: first.verificationState.scenarios.map((scenario) => ({
    id: scenario.id,
    reached: true,
    passed: true,
    evidence: ['results_icarus.xml', 'dma.fst']
  }))
}, null, 2), 'utf-8')

const second = buildVerificationIntelligence(root)
const secondIds = second.verificationState.scenarios.map((scenario) => scenario.id)
const firstIds = first.verificationState.scenarios.map((scenario) => scenario.id)
if (JSON.stringify([...secondIds].sort()) !== JSON.stringify([...firstIds].sort())) throw new Error(`Scenario ID 不稳定：${JSON.stringify(firstIds)} -> ${JSON.stringify(secondIds)}`)
if (second.verificationState.scenarios.some((scenario) => scenario.status !== 'VERIFIED')) throw new Error('Scenario feedback 未回灌')
if (second.verificationState.coverageHoles.length !== 0) throw new Error('Scenario 已闭环后 Coverage Hole 应清除')
const review = reviewScenarioClosure(root)
if (!review.passed) throw new Error(`Scenario Closure 应通过：${review.blockers.join('; ')}`)

const state = JSON.parse(readFileSync(second.paths.verificationState, 'utf-8'))
if (state.rtlHash !== second.structuralModel.rtlHash) throw new Error('Verification State RTL Hash 不一致')

console.log(`Verification Intelligence smoke passed: ${second.risks.length} risks, ${second.verificationState.scenarioCount} scenarios`)
