import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildVerificationIntelligence, reviewScenarioClosure } from '../packages/verification-intelligence-engine/src/index.ts'

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
if (!first.risks.some((risk) => risk.taxonomyId === 'R01')) throw new Error('未识别 Event Collision')
if (first.verificationState.scenarios.length === 0) throw new Error('Scenario Registry 为空')
if (reviewScenarioClosure(root).passed) throw new Error('关键 Scenario 未闭环时不应通过')

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
if (JSON.stringify(secondIds) !== JSON.stringify(firstIds)) throw new Error('Scenario ID 不稳定')
if (second.verificationState.scenarios.some((scenario) => scenario.status !== 'VERIFIED')) throw new Error('Scenario feedback 未回灌')
const review = reviewScenarioClosure(root)
if (!review.passed) throw new Error(`Scenario Closure 应通过：${review.blockers.join('; ')}`)

const state = JSON.parse(readFileSync(second.paths.verificationState, 'utf-8'))
if (state.rtlHash !== second.structuralModel.rtlHash) throw new Error('Verification State RTL Hash 不一致')

console.log(`Verification Intelligence smoke passed: ${second.risks.length} risks, ${second.verificationState.scenarioCount} scenarios`)
