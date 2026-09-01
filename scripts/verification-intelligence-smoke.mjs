import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildVerificationIntelligence, recordExplorationRound, registerVerificationHypotheses, reviewScenarioClosure, registerVerificationIntents, recordScenarioAdjudication } from '../packages/verification-intelligence-engine/src/index.ts'

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

writeFileSync(join(root, 'rtl', 'addr_generator.v'), `
module addr_generator(input clk, input rst_n, input advance, output reg [7:0] addr);
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) addr <= 0;
    else if (advance) addr <= addr + 1;
  end
endmodule
`, 'utf-8')
writeFileSync(join(root, 'rtl', 'cdc_sync.v'), `
module cdc_sync(input dst_clk, input dst_rst_n, input async_in, output reg sync_out);
  reg sync_meta;
  always @(posedge dst_clk or negedge dst_rst_n) begin
    if (!dst_rst_n) begin sync_meta <= 0; sync_out <= 0; end
    else begin sync_meta <= async_in; sync_out <= sync_meta; end
  end
endmodule
`, 'utf-8')
writeFileSync(join(root, 'rtl', 'simple_wire.v'), `
module simple_wire(input data_in, output data_out);
  assign data_out = data_in;
endmodule
`, 'utf-8')
writeFileSync(join(root, 'rtl', 'design.json'), JSON.stringify({ topModule: 'dma_wr_ctrl', filelist: 'filelist.f' }, null, 2), 'utf-8')

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
const semanticIntent = first.verificationState.verificationIntents[0]
if (!semanticIntent.objective.includes('验证 ') || semanticIntent.stimulusProcedure.length < 3 || semanticIntent.observationPoints.length === 0 || semanticIntent.passCriteria.length < 3) throw new Error('Verification Intent 缺少可执行语义')
if (!first.verificationState.verificationIntents.some((intent) => intent.stimulus.temporalInteractions.some((item) => item.relation === 'SAME_CYCLE'))) throw new Error('未生成时间交互条件')
if (!first.verificationState.verificationIntents.some((intent) => intent.boundaries.length > 0)) throw new Error('未生成边界条件')
if (first.verificationState.specGaps.length === 0) throw new Error('未识别 Spec Gap')
if (first.verificationState.coverageHoles.length === 0) throw new Error('未分类 Coverage Hole')
if (!first.verificationState.scenarios.every((scenario) => scenario.state?.closure && scenario.rtlHash === first.structuralModel.rtlHash)) throw new Error('AIGV 2.0 Scenario 多轴状态未生成')
if (!first.verificationState.scenarios.every((scenario) => scenario.coordinates?.feature.length && scenario.coordinates.interaction.length)) throw new Error('Scenario 五维坐标未生成')
if (first.verificationState.verificationSpace.candidateCount !== first.verificationState.scenarioCount) throw new Error('Verification Space 候选集合不完整')
if (!first.verificationState.verificationSpace.snapshotId.startsWith('VSPACE-')) throw new Error('Verification Space 缺少稳定版本 ID')
if (first.verificationState.explorationRound.selectedScenarioIds.length === 0) throw new Error('Explorer 未生成本轮选择')
if (!first.verificationState.executionPlan.some((plan) => plan.mandatory)) throw new Error('P0 Scenario 未标记为强制任务')
if (first.verificationState.closureAssessment.status !== 'NOT_READY') throw new Error('缺少闭环证据时 Closure Engine 不应就绪')
const moduleStrategy = first.verificationState.moduleVerificationStrategy
if (moduleStrategy.topModules[0] !== 'dma_wr_ctrl' || moduleStrategy.modules.find((item) => item.module === 'dma_wr_ctrl')?.level !== 'IP_SIGNOFF') throw new Error('项目顶层未进入 IP_SIGNOFF')
if (moduleStrategy.modules.find((item) => item.module === 'cdc_sync')?.level !== 'UNIT_FOCUSED') throw new Error('CDC 高风险子模块未进入 UNIT_FOCUSED')
const addrPlan = moduleStrategy.modules.find((item) => item.module === 'addr_generator')
if (addrPlan?.level !== 'UNIT_SMOKE' || addrPlan.goldenModel.recommendation !== 'RECOMMENDED' || !addrPlan.oracleStrategies.includes('REFERENCE_MODEL')) throw new Error('Golden Model 未与子模块验证等级独立决策')
if (moduleStrategy.modules.find((item) => item.module === 'simple_wire')?.level !== 'STATIC_ONLY') throw new Error('简单工具模块未进入 STATIC_ONLY')
if (first.verificationState.scenarios.some((scenario) => scenario.rtlObjects.includes('addr_generator') || scenario.rtlObjects.includes('simple_wire'))) throw new Error('普通子模块被错误扩展为完整 AIGV Scenario')
const semanticHole = first.verificationState.coverageHoles[0]
if (!semanticHole.missingTarget || semanticHole.requiredStimulus.length === 0 || semanticHole.requiredObservation.length === 0 || semanticHole.closureEvidence.length === 0) throw new Error('Coverage Hole 缺少具体闭环语义')
if (!existsSync(join(root, 'docs', '04_verification', 'aigv_execution_snapshot.md'))) throw new Error('未生成 AIGV 文档同步快照')
for (const path of [first.paths.specGaps, first.paths.verificationIntents, first.paths.coverageHoles, first.paths.verificationSpace, first.paths.explorationRound, first.paths.explorationHistory, first.paths.closureAssessment, first.paths.oracleRegistry, first.paths.oracleEvaluation, first.paths.mutationAssessment, first.paths.residualRiskRegister, first.paths.signoffPackage, first.paths.signoffReport, first.paths.moduleVerificationStrategy]) {
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
  rtlHash: first.structuralModel.rtlHash,
  scenarios: first.verificationState.scenarios.map((scenario) => ({
    id: scenario.id,
    reached: true,
    passed: true,
    assertionPassed: true,
    evidence: ['results_icarus.xml', 'dma.fst']
  }))
}, null, 2), 'utf-8')

const mutationPath = join(root, 'verification', 'results', 'dma', 'mutation-results.json')
const mutationRecords = [
  { id: 'MUT-001', operator: 'priority-inversion', weight: 10, status: 'KILLED', evidence: ['results_icarus.xml'] },
  { id: 'MUT-002', operator: 'counter-boundary', weight: 8, status: 'KILLED', evidence: ['results_icarus.xml'] },
  { id: 'MUT-003', operator: 'error-suppression', weight: 8, status: 'KILLED', evidence: ['results_icarus.xml'] }
]
writeFileSync(mutationPath, JSON.stringify({ rtlHash: first.structuralModel.rtlHash, records: mutationRecords }, null, 2), 'utf-8')

const second = buildVerificationIntelligence(root)
const secondIds = second.verificationState.scenarios.map((scenario) => scenario.id)
const firstIds = first.verificationState.scenarios.map((scenario) => scenario.id)
if (JSON.stringify([...secondIds].sort()) !== JSON.stringify([...firstIds].sort())) throw new Error(`Scenario ID 不稳定：${JSON.stringify(firstIds)} -> ${JSON.stringify(secondIds)}`)
if (second.verificationState.verificationSpace.snapshotId !== first.verificationState.verificationSpace.snapshotId) throw new Error('输入未变化时 Verification Space Snapshot ID 不稳定')
if (second.verificationState.scenarios.some((scenario) => scenario.status !== 'VERIFIED')) throw new Error('Scenario feedback 未回灌')
if (second.verificationState.coverageHoles.length !== 0) throw new Error('Scenario 已闭环后 Coverage Hole 应清除')
if (second.verificationState.closureAssessment.status !== 'NOT_READY') throw new Error('缺少探索饱和证据时不应直接签核')
if (second.verificationState.multiOracle.criticalInsufficient.length !== 0) throw new Error('Scoreboard + Assertion 独立证据未被识别')
if (!second.verificationState.multiOracle.assessments.every((item) => item.status === 'PASS')) throw new Error('Multi-Oracle 有效 PASS 未完成裁决')
if (second.verificationState.mutationAssessment.status !== 'PASS' || second.verificationState.mutationAssessment.weightedScore !== 1) throw new Error('风险加权 Mutation 未通过')

writeFileSync(mutationPath, JSON.stringify({ rtlHash: first.structuralModel.rtlHash, records: mutationRecords.map((item, index) => index === 2 ? { ...item, status: 'SURVIVED' } : item) }, null, 2), 'utf-8')
const withSurvivor = buildVerificationIntelligence(root)
if (withSurvivor.verificationState.mutationAssessment.status !== 'BLOCKED_BY_SURVIVOR') throw new Error('Mutation survivor 未阻断签核')
writeFileSync(mutationPath, JSON.stringify({ rtlHash: first.structuralModel.rtlHash, records: mutationRecords }, null, 2), 'utf-8')
for (let index = 0; index < 4; index++) recordExplorationRound(root, [])
const saturated = buildVerificationIntelligence(root)
if (saturated.verificationState.explorationHistory.saturation.status !== 'EMPIRICALLY_SATURATED') throw new Error('连续无新增探索未形成经验性饱和')
const review = reviewScenarioClosure(root)
if (!review.passed) throw new Error(`Scenario Closure 应通过：${review.blockers.join('; ')}`)
if (saturated.verificationState.closureAssessment.status !== 'READY_FOR_HUMAN_SIGNOFF') throw new Error('完整关键证据与探索饱和后应进入人工签核就绪状态')
if (saturated.verificationState.signoffPackage.status !== 'READY_FOR_HUMAN_SIGNOFF' || !saturated.verificationState.signoffPackage.packageId.startsWith('SIGNOFF-')) throw new Error('最终 Sign-off Package 未生成')
if (!readFileSync(saturated.paths.signoffReport, 'utf-8').includes(saturated.verificationState.signoffPackage.packageId)) throw new Error('可读签核报告未绑定最终 Sign-off Package')

const conflictPath = join(root, 'verification', 'results', 'dma', 'oracle_verdicts.json')
writeFileSync(conflictPath, JSON.stringify({ rtlHash: second.structuralModel.rtlHash, verdicts: [{ scenarioId: second.verificationState.scenarios[0].id, oracleId: 'ORACLE-PROTOCOL-CHECKER', verdict: 'FAIL', evidence: ['results_icarus.xml'] }] }, null, 2), 'utf-8')
const withConflict = buildVerificationIntelligence(root)
if (!withConflict.verificationState.multiOracle.conflicts.includes(second.verificationState.scenarios[0].id)) throw new Error('Oracle PASS/FAIL 冲突未进入 CONFLICT')
if (withConflict.verificationState.closureAssessment.status !== 'NOT_READY') throw new Error('Oracle 冲突不得机器签核')
rmSync(conflictPath)

mkdirSync(join(root, 'verification', 'formal', 'results', 'compatibility'), { recursive: true })
writeFileSync(join(root, 'verification', 'formal', 'results', 'compatibility', 'formal-result.json'), JSON.stringify({
  status: 'ERROR', mode: 'prove', obligation: 'supplemental', classification: 'C6_TOOL_INSTRUMENTATION', scenarioId: second.verificationState.scenarios[0].id
}, null, 2), 'utf-8')
const withFormalError = buildVerificationIntelligence(root)
if (withFormalError.verificationState.scenarios[0].status !== 'VERIFIED') throw new Error('补强 Formal 工具错误不应覆盖已闭环仿真证据')
if (withFormalError.verificationState.formalResults[0].outcome !== 'TOOL_ERROR') throw new Error('Formal ERROR 未分级为 TOOL_ERROR')

writeFileSync(join(root, 'rtl', 'dma_wr_ctrl.v'), readFileSync(join(root, 'rtl', 'dma_wr_ctrl.v'), 'utf-8') + '\n// rtl change\n', 'utf-8')
const afterRtlChange = buildVerificationIntelligence(root)
if (!afterRtlChange.verificationState.scenarios.some((scenario) => scenario.state.freshness === 'IMPACT_UNKNOWN')) throw new Error('RTL 变化后旧证据未进入 IMPACT_UNKNOWN')
if (afterRtlChange.verificationState.closureAssessment.status !== 'NOT_READY') throw new Error('影响未知的 Scenario 不得签核')
if (afterRtlChange.verificationState.explorationHistory.saturation.status !== 'NOT_ENOUGH_ROUNDS') throw new Error('RTL 变化后旧 Snapshot 饱和结论未失效')
for (let index = 0; index < 4; index++) recordExplorationRound(root, afterRtlChange.verificationState.scenarios.slice(0, 1).map((scenario) => scenario.id))
const stalled = buildVerificationIntelligence(root)
if (stalled.verificationState.explorationHistory.saturation.status !== 'STALLED') throw new Error('关键缺口连续无新增未进入 STALLED')
if (!stalled.verificationState.closureAssessment.nextActions.some((item) => item.includes('停止重复'))) throw new Error('探索停滞未引导诊断增强')

const state = JSON.parse(readFileSync(second.paths.verificationState, 'utf-8'))
if (state.rtlHash !== afterRtlChange.structuralModel.rtlHash) throw new Error('Verification State RTL Hash 不一致')
const posture = JSON.parse(readFileSync(second.paths.verificationPosture, 'utf-8'))
if (posture.rtlHash !== state.rtlHash || !Array.isArray(posture.verificationIntents)) throw new Error('Verification Posture 快照无效')
if (readFileSync(second.paths.verificationPosture, 'utf-8').length >= readFileSync(second.paths.verificationState, 'utf-8').length) throw new Error('Verification Posture 未实现紧凑快照')
if (readdirSync(join(root, 'verification', 'intelligence')).some((name) => name.endsWith('.tmp'))) throw new Error('原子写入遗留临时文件')

// ===== WS2 B 方向：未覆盖风险兜底 =====
const baseline = buildVerificationIntelligence(root)
if (baseline.verificationState.uncoveredRiskCandidates.length === 0) throw new Error('未覆盖风险候选兜底未生成（riskScore 前 20%）')
if (!baseline.verificationState.uncoveredRiskCandidates.every((risk) => risk.id && risk.riskScore > 0)) throw new Error('未覆盖风险候选缺少 RiskMarker 语义')
if (!baseline.verificationState.closureAssessment.warnings.some((item) => item.includes('未被任何验证意图覆盖'))) throw new Error('未覆盖风险候选未进入 Closure 警告（应仅告警不阻断）')
const baselinePosture = JSON.parse(readFileSync(baseline.paths.verificationPosture, 'utf-8'))
if (!Array.isArray(baselinePosture.uncoveredRiskCandidates) || baselinePosture.uncoveredRiskCandidates.length !== baseline.verificationState.uncoveredRiskCandidates.length) throw new Error('Verification Posture 未携带 uncoveredRiskCandidates')
if (!baseline.verificationState.scenarios.every((scenario) => (scenario.origin ?? 'ENGINE_CANDIDATE') === 'ENGINE_CANDIDATE')) throw new Error('引擎穷举场景应标记 origin=ENGINE_CANDIDATE')

// ===== WS2 B 方向：registerVerificationIntents 锚点校验与持久化 =====
const anchorRisk = baseline.verificationState.uncoveredRiskCandidates[0]
const anchorWriter = baseline.structuralModel.registerWriters.find((item) => item.module === 'dma_wr_ctrl') ?? baseline.structuralModel.registerWriters[0]
const qualifiedSignal = `${anchorWriter.module}.${anchorWriter.register}`
const bareSignal = anchorWriter.register
const intentRegistration = registerVerificationIntents(root, [
  { title: '在途计数边界验证', objective: '验证 outstanding_cnt 在 abort 与 bvalid 同周期时更新次数正确', failureMode: '反例：abort 与响应同周期导致 outstanding_cnt 重复递减', passCriteria: ['outstanding_cnt 每周期至多变化一次', 'abort 生效后无新事务计入'], anchors: { riskIds: [anchorRisk.id], requirementIds: ['REQ-DMA-001'], rtlSignals: [qualifiedSignal, bareSignal] }, recommendedMethod: 'simulation', preconditions: ['存在未完成事务'], observationPoints: [qualifiedSignal] },
  { title: '幻觉信号意图', objective: '验证不存在信号', failureMode: '反例：不存在', passCriteria: ['不存在'], anchors: { riskIds: [anchorRisk.id], requirementIds: ['REQ-DMA-001'], rtlSignals: ['not_a_real_signal_xyz'] }, recommendedMethod: 'simulation' },
  { title: '不存在风险锚点', objective: '验证不存在风险', failureMode: '反例：不存在', passCriteria: ['不存在'], anchors: { riskIds: ['RISK-9999'], requirementIds: ['REQ-DMA-001'], rtlSignals: [bareSignal] }, recommendedMethod: 'simulation' }
])
if (intentRegistration.accepted.length !== 1 || intentRegistration.rejected.length !== 2) throw new Error(`意图登记接受/拒绝计数错误：${JSON.stringify(intentRegistration)}`)
if (!intentRegistration.rebuilt) throw new Error('意图登记接受后未自动全量重建')
if (!intentRegistration.rejected.every((item) => item.reasons.length > 0)) throw new Error('被拒绝意图缺少中文拒绝原因')
const intentScenarioId = intentRegistration.accepted[0]
if (!/^SCN-[A-F0-9]{8}$/.test(intentScenarioId)) throw new Error('AGENT_INTENT 场景 ID 不符合稳定格式')

const afterRegister = buildVerificationIntelligence(root)
const intentScenario = afterRegister.verificationState.scenarios.find((scenario) => scenario.id === intentScenarioId)
if (!intentScenario || intentScenario.origin !== 'AGENT_INTENT' || intentScenario.status !== 'PLANNED') throw new Error('AGENT_INTENT 场景未在重建后的 State 中持久化')
if (intentScenario.riskIds[0] !== anchorRisk.id || !intentScenario.requirementIds.includes('REQ-DMA-001')) throw new Error('AGENT_INTENT 场景锚点未写回')
const registeredIntent = afterRegister.verificationState.verificationIntents.find((intent) => intent.scenarioId === intentScenarioId)
if (!registeredIntent || registeredIntent.objective !== '验证 outstanding_cnt 在 abort 与 bvalid 同周期时更新次数正确') throw new Error('AGENT_INTENT Intent 未保留 Agent 原文（不应套用模板）')
if (afterRegister.verificationState.uncoveredRiskCandidates.some((risk) => risk.id === anchorRisk.id)) throw new Error('已被验证意图锚定的高分风险仍出现在未覆盖候选中')
// 重复登记按更新处理：场景 ID 稳定，不新增重复场景
const reRegistration = registerVerificationIntents(root, [{ title: '在途计数边界验证', objective: '验证 outstanding_cnt 更新次数正确（修订）', failureMode: '反例：重复递减', passCriteria: ['计数单调'], anchors: { riskIds: [anchorRisk.id], requirementIds: ['REQ-DMA-001'], rtlSignals: [qualifiedSignal] }, recommendedMethod: 'simulation' }])
if (reRegistration.accepted[0] !== intentScenarioId) throw new Error('重复登记未命中同一稳定场景 ID')
const afterReRegister = buildVerificationIntelligence(root)
if (afterReRegister.verificationState.scenarios.filter((scenario) => scenario.id === intentScenarioId).length !== 1) throw new Error('重复登记产生了重复场景')

// ===== WS1：record_scenario_adjudication 缩权 =====
const verdictRejected = recordScenarioAdjudication(root, [{ scenarioId: intentScenarioId, status: 'VERIFIED' }])
if (!verdictRejected.rejected.some((item) => item.scenarioId === intentScenarioId && item.reason.includes('不可宣布')) || verdictRejected.updated.length !== 0) throw new Error('执行派生状态 VERIFIED 应被拒绝')
const waivedWithoutApproval = recordScenarioAdjudication(root, [{ scenarioId: intentScenarioId, status: 'WAIVED' }])
if (!waivedWithoutApproval.rejected.some((item) => item.scenarioId === intentScenarioId && item.reason.includes('具名审批'))) throw new Error('无具名审批的 WAIVED 应被拒绝')
writeFileSync(join(root, 'verification', 'intelligence', 'signoff-approvals.json'), JSON.stringify({ approvals: [{ riskId: `RR-WAIVER-${intentScenarioId}`, approver: 'smoke-user', rationale: '已评估并接受残余风险', approvedAt: new Date().toISOString() }] }, null, 2), 'utf-8')
const waivedWithApproval = recordScenarioAdjudication(root, [{ scenarioId: intentScenarioId, status: 'WAIVED' }])
if (!waivedWithApproval.updated.includes(intentScenarioId) || waivedWithApproval.rejected.length !== 0 || !waivedWithApproval.rebuilt) throw new Error('有具名审批的 WAIVED 应通过并触发重建')
const afterWaived = buildVerificationIntelligence(root)
if (afterWaived.verificationState.scenarios.find((scenario) => scenario.id === intentScenarioId)?.status !== 'WAIVED') throw new Error('WAIVED 裁决未持久化到 scenario-registry')
if (readdirSync(join(root, 'verification', 'intelligence')).some((name) => name.endsWith('.tmp'))) throw new Error('裁决链路原子写入遗留临时文件')

console.log(`Verification Intelligence smoke passed: ${second.risks.length} risks, ${second.verificationState.scenarioCount} scenarios`)
