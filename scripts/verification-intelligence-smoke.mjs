import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildVerificationIntelligence, recordExplorationRound, registerVerificationHypotheses, reviewScenarioClosure, reviewSynthesisClauses, registerVerificationIntents, recordScenarioAdjudication, recordRootCause, computeRtlHash } from '../packages/verification-intelligence-engine/src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'moonglass-verification-intelligence-'))
mkdirSync(join(root, 'docs', '02_requirements'), { recursive: true })
mkdirSync(join(root, 'rtl'), { recursive: true })
mkdirSync(join(root, 'verification', 'results', 'dma'), { recursive: true })

writeFileSync(join(root, 'docs', '02_requirements', 'product_requirements.md'), `
# DMA Requirements

- REQ-DMA-001 P0: abort stops new requests while outstanding responses may complete.
- REQ-DMA-002 P0: timeout and late response priority shall be deterministic.
- SPEC-ERR-001 P1: 错误响应必须返回 SLVERR；错误状态必须锁存直到软件清除。
- SPEC-DOC-001 P2: 模块文件头必须包含版权信息与命名规范说明。
- SPEC-PPA-001 P1: 面积不超过 5000 门；时钟频率不低于 200 MHz；功耗不超过 50 mW。
- SPEC-CDC-001 P1: 跨时钟域信号必须经过两级同步器。
- SPEC-TBD-001 P1: 错误计数饱和阈值 TBD，待架构评审确定。
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
if (first.requirementModel.requirements.length !== 9) throw new Error(`Requirement Model 断言级条款提取错误：${first.requirementModel.requirements.map((item) => item.id).join(',')}`)
// ===== v0.8.6：断言级条款拆分 + 文档性条款分类 =====
const clauseA = first.requirementModel.requirements.find((item) => item.id === 'SPEC-ERR-001#a')
const clauseB = first.requirementModel.requirements.find((item) => item.id === 'SPEC-ERR-001#b')
if (!clauseA || !clauseB || clauseA.parentId !== 'SPEC-ERR-001' || clauseB.parentId !== 'SPEC-ERR-001') throw new Error('SPEC 多断言条款未拆分为断言级子条款（#a/#b）')
const docClause = first.requirementModel.requirements.find((item) => item.id === 'SPEC-DOC-001')
if (docClause?.clauseKind !== 'documentary' || !docClause.classificationReason) throw new Error('文件头/版权类条款未被分类为 documentary 或缺少分类理由')
if (first.requirementModel.requirements.filter((item) => (item.clauseKind ?? 'verifiable') === 'verifiable').length !== 8) throw new Error('可验证条款计数错误（documentary 应被排除）')
// ===== 2026-09-02 契约：条款验收通道（channel）分类 =====
const ppaA = first.requirementModel.requirements.find((item) => item.id === 'SPEC-PPA-001#a')
const ppaB = first.requirementModel.requirements.find((item) => item.id === 'SPEC-PPA-001#b')
const ppaC = first.requirementModel.requirements.find((item) => item.id === 'SPEC-PPA-001#c')
if (!ppaA || !ppaB || !ppaC) throw new Error('PPA 复合条款未拆分为断言级子条款')
if (ppaA.channel !== 'synthesis' || ppaB.channel !== 'synthesis' || ppaC.channel !== 'synthesis') throw new Error(`面积/频率/功耗数值目标条款应分类为 synthesis 通道：${ppaA.channel}/${ppaB.channel}/${ppaC.channel}`)
if (!ppaA.classificationReason?.includes('synthesis')) throw new Error('synthesis 通道分类理由未写入 classificationReason')
const cdcClause = first.requirementModel.requirements.find((item) => item.id === 'SPEC-CDC-001')
if (cdcClause?.channel !== 'static' || !cdcClause.classificationReason?.includes('static')) throw new Error(`跨时钟域/同步器条款应分类为 static 通道：${cdcClause?.channel}`)
const simClause = first.requirementModel.requirements.find((item) => item.id === 'REQ-DMA-001')
if (simClause?.channel !== 'simulation') throw new Error('功能行为条款应默认 simulation 通道（宁漏勿冤）')
if (docClause.channel !== undefined) throw new Error('documentary 条款不应携带验收通道')
// TBD 条款不进入验证矩阵（2026-09-08 契约）：待定项不是可验证义务，仅在 unknowns/规格缺口
// 追踪；文本固化为确定条款后下次重建自动入矩阵
if (first.requirementModel.requirements.some((item) => item.id.startsWith('SPEC-TBD-001'))) throw new Error('TBD 条款不得进入 requirement-model（验证矩阵来源）')
if (!first.requirementModel.unknowns.some((item) => item.text.includes('SPEC-TBD-001'))) throw new Error('TBD 条款应在 unknowns 中保留追踪')
// ===== v0.8.6：规格映射矩阵（闭集完备性，尚无 Intent 映射 → VERIF 通道全部 UNMAPPED，仅 warning 不 blocker） =====
// 通道口径：clauseTotal 只计 VERIF 通道（simulation+static=5），synthesis 通道（3）单列不进分母
const firstMapping = first.verificationState.specMapping
if (firstMapping.clauseTotal !== 5 || firstMapping.documentaryCount !== 1) throw new Error(`映射矩阵分母错误：clauseTotal=${firstMapping.clauseTotal} documentary=${firstMapping.documentaryCount}`)
if (firstMapping.channels.simulation !== 4 || firstMapping.channels.static !== 1 || firstMapping.channels.synthesis !== 3) throw new Error(`通道分布错误：${JSON.stringify(firstMapping.channels)}`)
if (firstMapping.synthesisClauseTotal !== 3 || firstMapping.synthesisClauseClosed !== 0) throw new Error(`synthesis 条款单列计数错误：${firstMapping.synthesisClauseTotal}/${firstMapping.synthesisClauseClosed}`)
if (firstMapping.clauses.some((item) => item.clauseId.startsWith('SPEC-TBD-001'))) throw new Error('TBD 条款不得出现在验证矩阵')
const synthMappings = firstMapping.clauses.filter((item) => item.channel === 'synthesis')
if (synthMappings.length !== 3 || !synthMappings.every((item) => item.acceptancePhase === 'SYNTH' && item.status === 'UNMAPPED')) throw new Error('synthesis 条款应照常入矩阵追踪并标注 SYNTH 阶段验收')
// v0.8.6 延续（交流_20260901 回复 §三）：clause 派生 basic 候选使 VERIF 通道 UNMAPPED 清零、条款进入 MAPPED_UNTESTED；
// synthesis 通道条款不派生候选（验收在 SYNTH），保持 UNMAPPED 但不产生 warning
if (firstMapping.statusCounts.UNMAPPED !== 3 || firstMapping.statusCounts.MAPPED_UNTESTED !== 5 || firstMapping.coveredClause !== 0) throw new Error(`clause 派生后 VERIF 通道条款应为 MAPPED_UNTESTED、synthesis 保持 UNMAPPED：${JSON.stringify(firstMapping.statusCounts)}`)
if (first.verificationState.closureAssessment.warnings.some((item) => item.includes('UNMAPPED'))) throw new Error('派生候选已映射全部 VERIF 通道条款，synthesis 条款不产生 UNMAPPED warning')
if (first.verificationState.closureAssessment.blockers.some((item) => item.includes('UNMAPPED'))) throw new Error('Q2：UNMAPPED 条款不得进入 blockers（先 warning 一个版本）')
// ===== clause 派生 basic 候选（origin=CLAUSE_DERIVED）=====
const derivedCandidates = first.verificationState.scenarios.filter((scenario) => scenario.origin === 'CLAUSE_DERIVED')
if (derivedCandidates.length !== 5) throw new Error(`5 个 VERIF 通道可验证条款应各派生一个 basic 候选：${derivedCandidates.length}`)
if (!derivedCandidates.every((scenario) => scenario.wave === 'basic' && scenario.status === 'PLANNED' && scenario.requirementIds.length === 1)) throw new Error('派生候选应为 wave=basic / PLANNED / 单条款锚定')
if (!derivedCandidates.every((scenario) => scenario.state.closure === 'OPEN' && scenario.evidence.length === 0)) throw new Error('派生候选绝不可无证据闭环（闭环只认 scenario_hits）')
if (!derivedCandidates.every((scenario) => scenario.title.includes('基础功能'))) throw new Error('派生候选标题应直接引用条款')
if (derivedCandidates.some((scenario) => scenario.requirementIds.some((id) => id.startsWith('SPEC-PPA-001')))) throw new Error('synthesis 通道条款不得派生 VERIF 的 basic 候选（验收在 SYNTH 阶段）')
if (derivedCandidates.some((scenario) => scenario.priority >= 0.2)) throw new Error('派生候选 priority 应低于 Coverage Hole 阻断阈值（Q2 不阻断语义）')
const derivedIntents = first.verificationState.verificationIntents.filter((intent) => derivedCandidates.some((scenario) => scenario.id === intent.scenarioId))
if (derivedIntents.length !== 5 || !derivedIntents.every((intent) => intent.wave === 'basic' && intent.objective.includes('验证规格条款'))) throw new Error('派生候选缺少对应 Intent（目标应引用条款文本）')
// blockedBySpecCount：BLOCKED_BY_SPEC 场景计数（含低优先级）+ 低优先级规格缺口 warning
const blockedScenarios = first.verificationState.scenarios.filter((scenario) => scenario.status === 'BLOCKED_BY_SPEC')
const lowPriorityBlocked = blockedScenarios.filter((scenario) => scenario.priority < 0.2)
if (firstMapping.blockedBySpecCount !== blockedScenarios.length) throw new Error(`blockedBySpecCount 计数错误：${firstMapping.blockedBySpecCount} ≠ ${blockedScenarios.length}`)
if (lowPriorityBlocked.length === 0) throw new Error('fixture 应包含低优先级 BLOCKED_BY_SPEC 场景')
if (!first.verificationState.closureAssessment.warnings.some((item) => item.includes(`低优先级规格缺口 ${lowPriorityBlocked.length} 项`))) throw new Error('低优先级规格缺口未进入 closure warnings')
if (!Array.isArray(first.verificationState.waveProgress) || first.verificationState.waveProgress.length !== 3) throw new Error('波段进度未生成 W1-W3 三段（W0 冒烟已删除）')
// W1 进度挂 specMapping：clauseTotal>0 且未全覆盖 → in-progress；scenarioCount 展示实际 basic 场景数
const w1First = first.verificationState.waveProgress.find((item) => item.id === 'W1')
if (!w1First) throw new Error('波段进度缺少 W1 条目')
if (w1First.specClauseTotal !== 5 || w1First.specClauseCovered !== 0) throw new Error('W1 未挂规格映射矩阵计数（VERIF 通道口径）')
if (w1First.status !== 'in-progress' || w1First.scenarioCount !== 5 || w1First.passedCount !== 0) throw new Error(`W1 状态/计数错误：${JSON.stringify(w1First)}`)
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
if (!first.verificationState.scenarios.filter((scenario) => scenario.origin !== 'CLAUSE_DERIVED').every((scenario) => scenario.coordinates?.feature.length && scenario.coordinates.interaction.length)) throw new Error('Scenario 五维坐标未生成（CLAUSE_DERIVED 候选锚定条款而非 RTL 风险，坐标允许为空）')
if (first.verificationState.verificationSpace.candidateCount !== first.verificationState.scenarioCount) throw new Error('Verification Space 候选集合不完整')
if (!first.verificationState.verificationSpace.snapshotId.startsWith('VSPACE-')) throw new Error('Verification Space 缺少稳定版本 ID')
if (first.verificationState.explorationRound.selectedScenarioIds.length === 0) throw new Error('Explorer 未生成本轮选择')
if (!first.verificationState.executionPlan.some((plan) => plan.mandatory)) throw new Error('P0 Scenario 未标记为强制任务')
if (first.verificationState.closureAssessment.status !== 'NOT_READY') throw new Error('缺少闭环证据时 Closure Engine 不应就绪')
// ===== AIGV 修订批 1：模块策略两态化（TOP 优先，UT 例外）=====
const moduleStrategy = first.verificationState.moduleVerificationStrategy
if (moduleStrategy.topModules[0] !== 'dma_wr_ctrl' || moduleStrategy.modules.find((item) => item.module === 'dma_wr_ctrl')?.level !== 'TOP_SIGNOFF') throw new Error('项目顶层未进入 TOP_SIGNOFF')
const staticChecks = ['编译/elaboration', 'Lint', '可综合性', '端口/参数/未驱动检查']
for (const module of ['cdc_sync', 'addr_generator', 'simple_wire']) {
  const plan = moduleStrategy.modules.find((item) => item.module === module)
  if (plan?.level !== 'COVERED_BY_TOP') throw new Error(`非顶层模块未进入 COVERED_BY_TOP 默认态：${module}=${plan?.level}`)
  if (JSON.stringify(plan.requiredChecks) !== JSON.stringify(staticChecks)) throw new Error(`COVERED_BY_TOP requiredChecks 未收敛为静态检查：${module}=${JSON.stringify(plan.requiredChecks)}`)
  if (plan.standaloneTestbench) throw new Error(`COVERED_BY_TOP 模块不应标记 standaloneTestbench：${module}`)
}
if (moduleStrategy.summary.TOP_SIGNOFF !== 1 || moduleStrategy.summary.UT_EXCEPTION !== 0 || moduleStrategy.summary.COVERED_BY_TOP !== moduleStrategy.modules.length - 1) throw new Error(`两态 summary 计数错误：${JSON.stringify(moduleStrategy.summary)}`)
const addrPlan = moduleStrategy.modules.find((item) => item.module === 'addr_generator')
if (addrPlan.goldenModel.recommendation !== 'RECOMMENDED' || !addrPlan.oracleStrategies.includes('REFERENCE_MODEL')) throw new Error('Golden Model 未与模块验证等级独立决策')
const topPlan = moduleStrategy.modules.find((item) => item.module === 'dma_wr_ctrl')
if (!topPlan.requiredChecks.includes('Multi-Oracle') || topPlan.standaloneTestbench) throw new Error('TOP_SIGNOFF requiredChecks 应沿用完整签核清单；standaloneTestbench 语义应为 active UT 例外')
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
// clause 派生后：VERIF 通道全部条款经派生候选的 hit 证据 PASSED（UNMAPPED 仅剩 synthesis 通道），不再有 Q2 warning 降档
if (saturated.verificationState.specMapping.statusCounts.PASSED !== 5 || saturated.verificationState.specMapping.coveredClause !== 5) throw new Error(`派生候选闭环后 VERIF 通道全部条款应 PASSED：${JSON.stringify(saturated.verificationState.specMapping.statusCounts)}`)
if (saturated.verificationState.waveProgress.find((item) => item.id === 'W1')?.status !== 'done') throw new Error('coveredClause=clauseTotal 时 W1 应为 done')
if (saturated.verificationState.closureAssessment.status !== 'READY_FOR_HUMAN_SIGNOFF') throw new Error(`条款全覆盖且无其余 warning 时应恢复 READY_FOR_HUMAN_SIGNOFF：${saturated.verificationState.closureAssessment.status}`)
if (saturated.verificationState.closureAssessment.warnings.some((item) => item.includes('UNMAPPED'))) throw new Error('条款全覆盖后不应再有 UNMAPPED warning')
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
// 陈旧通过透出（2026-10：RTL 变更致证据过期时）：曾 PASSED 条款 status 按陈旧防线保持 MAPPED_UNTESTED，
// 但以 stalePassed 透出"曾通过待回归"（区别于从未验证——工作台据此计入待重验而非映射未验证）
const staleMapping = afterRtlChange.verificationState.specMapping
if (staleMapping.statusCounts.PASSED !== 0) throw new Error('陈旧证据不得保持 PASSED')
if ((staleMapping.stalePassedCount ?? 0) !== 5) throw new Error(`5 条曾通过条款应透出 stalePassedCount=5：${staleMapping.stalePassedCount}`)
const staleClauses = staleMapping.clauses.filter((item) => item.stalePassed)
if (staleClauses.length !== 5 || staleClauses.some((item) => item.status !== 'MAPPED_UNTESTED')) throw new Error('stalePassed 条款的 status 必须保持 MAPPED_UNTESTED（陈旧防线）')
const w1Stale = afterRtlChange.verificationState.waveProgress.find((item) => item.id === 'W1')
if ((w1Stale?.stalePassedCount ?? 0) !== 5) throw new Error('W1 waveProgress 未透出 stalePassedCount')
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
if (!baseline.verificationState.scenarios.every((scenario) => ['ENGINE_CANDIDATE', 'CLAUSE_DERIVED'].includes(scenario.origin ?? 'ENGINE_CANDIDATE'))) throw new Error('引擎穷举场景应标记 origin=ENGINE_CANDIDATE、条款派生候选应标记 origin=CLAUSE_DERIVED')

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
if (intentRegistration.warnings.length !== 0) throw new Error('非 corner 登记不应产生覆盖率软提醒')
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
// synthesis（PPA）通道条款不得锚定 VERIF 验证意图（验收义务在 SYNTH 阶段，综合报告证据闭环）
const ppaAnchored = registerVerificationIntents(root, [
  { title: 'PPA 条款误锚定', objective: '验证频率目标达成', failureMode: '反例：频率不达标', passCriteria: ['频率不低于目标值'], anchors: { riskIds: [anchorRisk.id], requirementIds: ['SPEC-PPA-001'], rtlSignals: [qualifiedSignal] }, recommendedMethod: 'simulation' }
])
if (ppaAnchored.accepted.length !== 0 || !ppaAnchored.rejected[0]?.reasons.some((reason) => reason.includes('synthesis'))) throw new Error(`synthesis 通道条款锚定的 VERIF 意图应被拒绝：${JSON.stringify(ppaAnchored)}`)
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
// ===== DEFECT-PACK-001 #9(a)：WAIVED 场景不计入 criticalInsufficient =====
// 该意图锚定 P0 条款（criticality=1），无有效 Oracle 证据，assessment 应仍为 INSUFFICIENT（仅不再计入阻断统计）
const waivedAssessment = afterWaived.verificationState.multiOracle.assessments.find((item) => item.scenarioId === intentScenarioId)
if (waivedAssessment?.status !== 'INSUFFICIENT' || waivedAssessment.requiredIndependentPasses !== 2) throw new Error(`断言前置失效：豁免的关键场景应仍为 INSUFFICIENT：${JSON.stringify(waivedAssessment)}`)
if (afterWaived.verificationState.multiOracle.criticalInsufficient.includes(intentScenarioId)) throw new Error('#9(a) 回归：WAIVED 场景仍计入 criticalInsufficient')

// ===== VERIF 上下文治理第 2 批：recordRootCause + execution-summary =====
const rcScenarioId = intentScenarioId
// 长度约束：rootCause ≤200 字、fix ≤120 字（引擎层硬约束）
let lengthRejected = false
try { recordRootCause(root, { scenarioId: rcScenarioId, hypothesis: 'h', verdict: 'confirmed', refutedHypotheses: [], failureSignature: 'sig', rootCause: '超'.repeat(201), fix: '', evidence: [] }) } catch { lengthRejected = true }
if (!lengthRejected) throw new Error('rootCause 超过 200 字未被拒绝')
lengthRejected = false
try { recordRootCause(root, { scenarioId: rcScenarioId, hypothesis: 'h', verdict: 'confirmed', refutedHypotheses: [], failureSignature: 'sig', rootCause: '正常根因', fix: '长'.repeat(121), evidence: [] }) } catch { lengthRejected = true }
if (!lengthRejected) throw new Error('fix 超过 120 字未被拒绝')
lengthRejected = false
try { recordRootCause(root, { scenarioId: 'SCN-XXXX', hypothesis: 'h', verdict: 'open', refutedHypotheses: [], failureSignature: '', rootCause: '', fix: '', evidence: [] }) } catch { lengthRejected = true }
if (!lengthRejected) throw new Error('非法 scenarioId 未被拒绝')
// 链式字段：同 scenarioId 多条共存，refutedHypotheses 引用先前记录 id
const rcOpen = recordRootCause(root, { scenarioId: rcScenarioId, hypothesis: '假设 A：计数器位宽不足', verdict: 'open', refutedHypotheses: [], failureSignature: 'abc123def456', rootCause: '', fix: '', evidence: ['verification/results/dma/result.json'] })
if (!/^RC-[A-F0-9]{8}$/.test(rcOpen.id)) throw new Error(`根因记录 ID 不稳定：${rcOpen.id}`)
const rcRefuted = recordRootCause(root, { scenarioId: rcScenarioId, hypothesis: '假设 A：计数器位宽不足', verdict: 'refuted', refutedHypotheses: [], failureSignature: 'abc123def456', rootCause: '', fix: '', evidence: [] })
const rcConfirmed = recordRootCause(root, { scenarioId: rcScenarioId, hypothesis: '假设 B：首拍 flush 锁存参数错误', verdict: 'confirmed', refutedHypotheses: [rcRefuted.id], failureSignature: 'abc123def456', rootCause: '首拍 flush 时锁存沿用了上一事务参数', fix: '改首拍 flush 锁存参数', evidence: ['verification/results/dma/result.json'] })
if (rcRefuted.id !== rcOpen.id) throw new Error('同场景同假设的 open→refuted 应复用同一稳定 ID')
const rcFile = JSON.parse(readFileSync(join(root, 'verification', 'results', 'root-causes.json'), 'utf-8'))
const rcChain = rcFile.records.filter((item) => item.scenarioId === rcScenarioId)
if (rcChain.length !== 2) throw new Error(`同 scenarioId 多条记录未共存成链：${rcChain.length}`)
if (rcConfirmed.refutedHypotheses[0] !== rcRefuted.id) throw new Error('链式追溯字段 refutedHypotheses 未保留')
// rebuild：confirmed 根因挂回 scenario.evidence 并进入 signoff package
const afterRootCause = buildVerificationIntelligence(root)
const rcScenario = afterRootCause.verificationState.scenarios.find((scenario) => scenario.id === rcScenarioId)
if (!rcScenario?.evidence.some((item) => item.includes('root-causes.json'))) throw new Error('confirmed 根因未挂回 scenario.evidence')
if (!afterRootCause.verificationState.signoffPackage.evidenceFiles.some((item) => item.includes('root-causes.json'))) throw new Error('confirmed 根因未进入 signoff package 证据索引')
if (!readFileSync(afterRootCause.paths.signoffReport, 'utf-8').includes('首拍 flush 时锁存沿用了上一事务参数')) throw new Error('签核报告未包含已确认根因')
// execution-summary.json：存在、≤10KB、结构完整
const summaryPath = join(root, 'verification', 'intelligence', 'execution-summary.json')
if (!existsSync(summaryPath)) throw new Error('execution-summary.json 未生成')
if (statSync(summaryPath).size > 10 * 1024) throw new Error(`execution-summary.json 超过 10KB：${statSync(summaryPath).size}`)
if (afterRootCause.paths.executionSummary !== summaryPath) throw new Error('paths.executionSummary 未指向 execution-summary.json')
const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'))
if (summary.progress?.scenarioCount !== afterRootCause.verificationState.scenarioCount || typeof summary.progress.closed !== 'number' || typeof summary.progress.open !== 'number' || typeof summary.progress.blocked !== 'number') throw new Error('execution-summary 进展计数缺失')
if (!summary.progress.statusCounts || typeof summary.progress.statusCounts !== 'object') throw new Error('execution-summary 缺少各状态场景数')
if (!Array.isArray(summary.topOpenScenarios) || summary.topOpenScenarios.length > 10) throw new Error('execution-summary top 开放场景超过 10 条')
if (summary.topOpenScenarios.some((item) => Object.keys(item).sort().join(',') !== 'id,priority,status,title')) throw new Error('execution-summary top 场景必须仅含 id/title/status/priority')
if (!Array.isArray(summary.blockers) || !Array.isArray(summary.nextActions) || !summary.closureStatus) throw new Error('execution-summary 缺少 blockers/nextActions/closureStatus')
if (!summary.evidencePaths?.verificationPosture || !summary.evidencePaths?.rootCauses) throw new Error('execution-summary 缺少证据路径')
if (JSON.stringify(summary.evidencePaths).includes('首拍 flush')) throw new Error('execution-summary 证据区只能含路径，不得含内容')

// ===== v0.8.6：波段标签校验（Q1）+ 主题归一（Q3）+ 聚类批次与执行门（Q4） =====
const latest = buildVerificationIntelligence(root)
// 条款状态机 WAIVED：REQ-DMA-001 被已具名审批豁免的 Intent 锚定
const waivedClause = latest.verificationState.specMapping.clauses.find((item) => item.clauseId === 'REQ-DMA-001')
if (waivedClause?.status !== 'WAIVED') throw new Error(`已豁免 Intent 锚定的条款应为 WAIVED：${waivedClause?.status}`)
// Q1：W0 冒烟波段已废弃——声明 smoke 归一为 basic 正常登记；声明 basic 锚定 formal-candidate 类风险（R05）→ 拒绝
const formalRisk = latest.risks.find((risk) => risk.taxonomyId === 'R05')
if (!formalRisk) throw new Error('fixture 缺少 R05 计数器边界风险（formal-candidate）')
const waveRejected = registerVerificationIntents(root, [
  { title: '冒烟归一登记', objective: 'x', failureMode: 'x', passCriteria: ['x'], anchors: { riskIds: [anchorRisk.id], requirementIds: ['REQ-DMA-002'], rtlSignals: [bareSignal] }, recommendedMethod: 'simulation', wave: 'smoke' },
  { title: '基础伪登记', objective: 'x', failureMode: 'x', passCriteria: ['x'], anchors: { riskIds: [formalRisk.id], requirementIds: ['REQ-DMA-002'], rtlSignals: [bareSignal] }, recommendedMethod: 'simulation', wave: 'basic' }
])
if (waveRejected.accepted.length !== 1 || waveRejected.rejected.length !== 1) throw new Error(`wave 校验结果错误（smoke 应归一为 basic 登记、basic+formal-candidate 应拒绝）：${JSON.stringify(waveRejected)}`)
if (!waveRejected.rejected.every((item) => item.reasons.some((reason) => reason.includes('冲突') && reason.includes('不得')))) throw new Error('wave 拒绝缺少冲突原因说明')
// smoke 声明落库即归一：场景 wave 为 basic，不再是 smoke
const afterSmokeNormalized = buildVerificationIntelligence(root)
if (afterSmokeNormalized.verificationState.scenarios.find((scenario) => scenario.title === '冒烟归一登记')?.wave !== 'basic') throw new Error('声明 smoke 的场景应归一登记为 basic')
// Q3：topic 归一并（trim/大小写/空白归一后按归一键聚合，防"错误注入"裂成两波）
const cornerReg = registerVerificationIntents(root, [
  { title: '错误路径定向验证', objective: '验证 abort 路径错误处理', failureMode: '反例：错误状态未锁存', passCriteria: ['错误状态锁存直到软件清除'], anchors: { riskIds: [anchorRisk.id], requirementIds: ['SPEC-ERR-001#a'], rtlSignals: [qualifiedSignal] }, recommendedMethod: 'simulation', wave: 'corner', topic: '错误注入' },
  { title: '错误恢复定向验证', objective: '验证错误清除后恢复', failureMode: '反例：恢复失败', passCriteria: ['恢复后正常事务可继续'], anchors: { riskIds: [anchorRisk.id], requirementIds: ['SPEC-ERR-001#b'], rtlSignals: [bareSignal] }, recommendedMethod: 'simulation', wave: 'corner', topic: '  错误注入  ' }
])
if (cornerReg.accepted.length !== 2) throw new Error(`corner 意图登记失败：${JSON.stringify(cornerReg.rejected)}`)
// corner 登记软提醒（方案 B）：此时条款覆盖率 0/4 < 0.8，应 warning 提示先补 basic（不拒绝登记）
if (cornerReg.warnings.length !== 1 || !cornerReg.warnings[0].includes('建议先补 basic 波段') || !cornerReg.warnings[0].includes('0%')) throw new Error(`corner 登记缺少覆盖率软提醒：${JSON.stringify(cornerReg.warnings)}`)
const afterCorner = buildVerificationIntelligence(root)
const w2 = afterCorner.verificationState.waveProgress.find((item) => item.id === 'W2')
const errorTopic = w2?.topics?.find((item) => item.name === '错误注入')
// 归一并：两个登记意图（'错误注入' 与 '  错误注入  '）+ R07 引擎候选应聚合为同一主题条目，无裂波
if (!errorTopic || errorTopic.scenarioCount !== 3) throw new Error(`topic 归一并失败（应聚合为单主题 3 场景）：${JSON.stringify(w2?.topics)}`)
if (w2?.topics?.filter((item) => item.name.trim().toLowerCase().replace(/\s+/g, ' ') === '错误注入').length !== 1) throw new Error('同一归一键的主题裂成多波')
const mappedClause = afterCorner.verificationState.specMapping.clauses.find((item) => item.clauseId === 'SPEC-ERR-001#a')
if (mappedClause?.status !== 'MAPPED_UNTESTED' || mappedClause.scenarioIds.length !== 2) throw new Error(`锚定后条款应进入 MAPPED_UNTESTED（corner 意图 + 派生候选两个场景）：${JSON.stringify(mappedClause)}`)
if (!mappedClause.scenarioIds.some((id) => afterCorner.verificationState.scenarios.find((scenario) => scenario.id === id)?.origin === 'CLAUSE_DERIVED')) throw new Error('MAPPED_UNTESTED 条款应同时锚定派生候选')
// 聚类视图：plans 全部带 wave/clusterId 且与 clusters 平铺一致；组 ≤8、执行批 2-3、同组同模块
const planFile = JSON.parse(readFileSync(join(root, 'verification', 'intelligence', 'scenario-execution-plan.json'), 'utf-8'))
if (planFile.version !== 2 || !Array.isArray(planFile.clusters) || planFile.clusters.length === 0) throw new Error('执行计划缺少聚类视图（version 2 + clusters）')
if (!planFile.plans.every((plan) => plan.wave && plan.clusterId)) throw new Error('计划条目缺少 wave/clusterId')
if (JSON.stringify(planFile.clusters.flatMap((cluster) => cluster.scenarioIds)) !== JSON.stringify(planFile.plans.map((plan) => plan.scenarioId))) throw new Error('聚类视图与平铺 plans 不一致')
for (const cluster of planFile.clusters) {
  if (cluster.scenarioIds.length > 8) throw new Error(`authoring 组超过 8 场景上限：${cluster.clusterId}`)
  for (const batch of cluster.executionBatches) if (batch.length < 1 || batch.length > 6) throw new Error(`执行批超出 2-6 个约束：${cluster.clusterId}`)
  const members = cluster.scenarioIds.map((id) => afterCorner.verificationState.scenarios.find((scenario) => scenario.id === id))
  if (new Set(members.map((scenario) => scenario.rtlObjects[0]?.split('.')[0])).size !== 1) throw new Error(`同组场景模块不一致：${cluster.clusterId}`)
}
// W1 不满不进 W2：登记 basic 意图后，corner/signoff 波段不进入执行计划（允许登记，约束执行）
const gatingReg = registerVerificationIntents(root, [
  { title: 'REQ-DMA-002 基础功能验证', objective: '验证 timeout 与迟到响应优先级确定', failureMode: '反例：优先级不确定', passCriteria: ['timeout 优先于迟到响应完成'], anchors: { riskIds: [anchorRisk.id], requirementIds: ['REQ-DMA-002'], rtlSignals: [qualifiedSignal] }, recommendedMethod: 'simulation', wave: 'basic' }
])
if (gatingReg.accepted.length !== 1) throw new Error('basic 意图登记失败')
const gated = buildVerificationIntelligence(root)
if (gated.verificationState.executionPlan.length === 0 || !gated.verificationState.executionPlan.every((plan) => plan.wave === 'basic')) throw new Error('W1 未闭环时 corner/signoff 不得进入执行计划')
if (gated.verificationState.specMapping.clauses.find((item) => item.clauseId === 'REQ-DMA-002')?.status !== 'MAPPED_UNTESTED') throw new Error('basic 意图锚定后 REQ-DMA-002 应为 MAPPED_UNTESTED')
// 派生候选属 basic 波段，参与"W1 未闭环挡 W2"执行门
const gatedDerivedInPlan = gated.verificationState.executionPlan.filter((plan) => gated.verificationState.scenarios.find((scenario) => scenario.id === plan.scenarioId)?.origin === 'CLAUSE_DERIVED')
if (gatedDerivedInPlan.length === 0) throw new Error('CLAUSE_DERIVED 派生候选未进入 W1 执行计划')
// 关闭全部 basic 波段场景（模拟 W1 填满）→ corner 重新进入执行计划；REQ-DMA-002 条款 PASSED
const openBasic = gated.verificationState.scenarios.filter((item) => item.state.closure === 'OPEN' && item.wave === 'basic')
if (openBasic.length === 0) throw new Error('应存在待闭环的 basic 场景')
writeFileSync(join(root, 'verification', 'results', 'dma', 'scenario_hits.json'), JSON.stringify({
  rtlHash: gated.structuralModel.rtlHash,
  scenarios: openBasic.map((scenario) => ({ id: scenario.id, reached: true, passed: true, assertionPassed: true, evidence: ['results_icarus.xml', 'dma.fst'] }))
}, null, 2), 'utf-8')
const ungated = buildVerificationIntelligence(root)
if (ungated.verificationState.executionPlan.length === 0 || !ungated.verificationState.executionPlan.every((plan) => plan.wave === 'corner')) throw new Error('W1 闭环后应由 corner 波段进入执行计划')
if (ungated.verificationState.specMapping.clauses.find((item) => item.clauseId === 'REQ-DMA-002')?.status !== 'PASSED') throw new Error('有 PASS 证据的条款应为 PASSED')
if (ungated.verificationState.specMapping.coveredClause < 1) throw new Error('coveredClause 未统计 PASSED 条款')
// PASSED 条款不派生：REQ-DMA-002 已由 basic 意图证据闭环，其派生候选应退出
if (ungated.verificationState.scenarios.some((scenario) => scenario.origin === 'CLAUSE_DERIVED' && scenario.requirementIds.includes('REQ-DMA-002'))) throw new Error('已被证据覆盖（PASSED）的条款不应保留派生候选')
// 派生候选 ID 幂等：同条款跨 rebuild 复用同一 SCN ID
const derivedReqA = ungated.verificationState.scenarios.filter((scenario) => scenario.origin === 'CLAUSE_DERIVED' && scenario.requirementIds.includes('SPEC-ERR-001#a'))
if (derivedReqA.length !== 1 || derivedReqA[0].status !== 'VERIFIED') throw new Error('派生候选 hit 证据未跨 rebuild 幂等合并')
// 再聚类建议（两段式第二段）：同组不同失败指纹 → 分裂；跨组同指纹 → 合并
const planNow = JSON.parse(readFileSync(join(root, 'verification', 'intelligence', 'scenario-execution-plan.json'), 'utf-8'))
const splitTarget = planNow.clusters.find((cluster) => cluster.scenarioIds.length >= 2)
if (!splitTarget) throw new Error('应存在 ≥2 场景的聚类组用于再聚类测试')
recordRootCause(root, { scenarioId: splitTarget.scenarioIds[0], hypothesis: '假设：时钟偏移', verdict: 'open', refutedHypotheses: [], failureSignature: 'aaaa1111bbbb', rootCause: '', fix: '', evidence: [] })
recordRootCause(root, { scenarioId: splitTarget.scenarioIds[1], hypothesis: '假设：计数器溢出', verdict: 'open', refutedHypotheses: [], failureSignature: 'cccc2222dddd', rootCause: '', fix: '', evidence: [] })
const withFingerprints = buildVerificationIntelligence(root)
if (!withFingerprints.verificationState.reclusterSuggestions.some((item) => item.type === 'split' && item.clusterIds.includes(splitTarget.clusterId))) throw new Error('同组不同失败指纹未产生分裂建议')
if (planNow.clusters.length >= 2) {
  const [clusterOne, clusterTwo] = planNow.clusters
  recordRootCause(root, { scenarioId: clusterOne.scenarioIds[0], hypothesis: '假设：共享根因', verdict: 'open', refutedHypotheses: [], failureSignature: 'eeee3333ffff', rootCause: '', fix: '', evidence: [] })
  recordRootCause(root, { scenarioId: clusterTwo.scenarioIds[0], hypothesis: '假设：共享根因', verdict: 'open', refutedHypotheses: [], failureSignature: 'eeee3333ffff', rootCause: '', fix: '', evidence: [] })
  const withMerge = buildVerificationIntelligence(root)
  if (!withMerge.verificationState.reclusterSuggestions.some((item) => item.type === 'merge')) throw new Error('跨组同失败指纹未产生合并建议')
}
// execution-summary 新增区块（展示层契约 B）：waveProgress + specMapping，仍 ≤10KB
const summary2Path = join(root, 'verification', 'intelligence', 'execution-summary.json')
const summary2 = JSON.parse(readFileSync(summary2Path, 'utf-8'))
if (!Array.isArray(summary2.waveProgress) || summary2.waveProgress.length !== 3) throw new Error('execution-summary 缺少 waveProgress 三段（W1-W3）')
if (typeof summary2.specMapping?.clauseTotal !== 'number' || typeof summary2.specMapping?.coveredClause !== 'number' || typeof summary2.specMapping?.blockedBySpecCount !== 'number' || !Array.isArray(summary2.specMapping?.unmappedClause)) throw new Error('execution-summary 缺少 specMapping 区块（含 blockedBySpecCount）')
if (!summary2.specMapping.unmappedClause.every((item) => item.specId && item.clause)) throw new Error('unmappedClause 形状不符展示层契约 B.2')
if (statSync(summary2Path).size > 10 * 1024) throw new Error('execution-summary 超过 10KB 硬指标')
// 旧数据兼容：registry 中无 wave/topic 字段的场景不崩，波段由来源/方法推导；存量 wave='smoke' 归一为 basic
const legacyRegistryPath = join(root, 'verification', 'intelligence', 'scenario-registry.json')
const legacyRegistry = JSON.parse(readFileSync(legacyRegistryPath, 'utf-8'))
legacyRegistry.scenarios.forEach((scenario, index) => { if (index === 0) { scenario.wave = 'smoke'; delete scenario.topic } else { delete scenario.wave; delete scenario.topic } })
writeFileSync(legacyRegistryPath, JSON.stringify(legacyRegistry, null, 2), 'utf-8')
const legacy = buildVerificationIntelligence(root)
if (!Array.isArray(legacy.verificationState.waveProgress) || legacy.verificationState.waveProgress.length !== 3) throw new Error('旧数据（无 wave 字段）重建后波段进度缺失（应为 W1-W3 三段）')
if (legacy.verificationState.waveProgress.some((item) => item.id === 'W0')) throw new Error('W0 冒烟波段已删除，不应再产出 W0 条目')
if (!legacy.verificationState.executionPlan.every((plan) => plan.wave && plan.wave !== 'smoke')) throw new Error('旧数据场景波段推导失败（存量 smoke 应归一为 basic）')
// 存量 smoke 场景应计入 W1（registry 保留原值，派生侧归一）
const legacyResolve = (scenario) => scenario.wave === 'smoke' ? 'basic' : scenario.wave ?? ((scenario.origin === 'AGENT_INTENT' || scenario.origin === 'CLAUSE_DERIVED') ? 'basic' : scenario.method === 'formal-candidate' ? 'signoff' : 'corner')
const expectedBasic = legacy.verificationState.scenarios.filter((scenario) => legacyResolve(scenario) === 'basic').length
const w1Legacy = legacy.verificationState.waveProgress.find((item) => item.id === 'W1')
if (w1Legacy?.scenarioCount !== expectedBasic || expectedBasic === 0) throw new Error(`存量 smoke 场景未归一进 W1：W1.scenarioCount=${w1Legacy?.scenarioCount}，期望 ${expectedBasic}`)
if (!legacy.verificationState.specMapping || legacy.verificationState.executionClusters === undefined) throw new Error('旧数据重建缺少 v0.8.6 区块')

// ===== SYNTH 门禁接 PPA（2026-09-02 契约 §二）：reviewSynthesisClauses 阻断/放行 =====
const synthReviewOpen = reviewSynthesisClauses(root)
if (synthReviewOpen.passed || synthReviewOpen.total !== 3 || synthReviewOpen.open !== 3) throw new Error(`synthesis 条款未闭环时 SYNTH 门禁应阻断：${JSON.stringify({ passed: synthReviewOpen.passed, total: synthReviewOpen.total, open: synthReviewOpen.open })}`)
if (!synthReviewOpen.blockers.every((item) => item.includes('SYNTH 阶段验收'))) throw new Error('SYNTH 门禁 blocker 缺少阶段验收标注')
// SYNTH 阶段 Agent 登记 static 方法意图（锚定 synthesis 条款）→ 综合证据（scenario_hits）闭环
const synthIntentReg = registerVerificationIntents(root, [{ title: 'PPA 综合验收', objective: '验证面积/频率/功耗满足规格数值目标', failureMode: '反例：综合报告面积/频率/功耗超标', passCriteria: ['综合报告面积/频率/功耗全部达标'], anchors: { riskIds: [anchorRisk.id], requirementIds: ['SPEC-PPA-001#a', 'SPEC-PPA-001#b', 'SPEC-PPA-001#c'], rtlSignals: [qualifiedSignal] }, recommendedMethod: 'static' }])
if (synthIntentReg.accepted.length !== 1) throw new Error(`锚定 synthesis 条款的 static 意图登记失败：${JSON.stringify(synthIntentReg.rejected)}`)
const synthScenarioId = synthIntentReg.accepted[0]
const preCloseBuild = buildVerificationIntelligence(root)
const synthClausesMapped = preCloseBuild.verificationState.specMapping.clauses.filter((item) => item.channel === 'synthesis')
if (!synthClausesMapped.every((item) => item.status === 'MAPPED_UNTESTED' && item.scenarioIds.includes(synthScenarioId))) throw new Error('synthesis 条款锚定意图后应为 MAPPED_UNTESTED')
writeFileSync(join(root, 'verification', 'results', 'dma', 'scenario_hits.json'), JSON.stringify({
  rtlHash: preCloseBuild.structuralModel.rtlHash,
  scenarios: [{ id: synthScenarioId, reached: true, passed: true, assertionPassed: true, evidence: ['results_icarus.xml', 'dma.fst'] }]
}, null, 2), 'utf-8')
const synthClosed = buildVerificationIntelligence(root)
if (synthClosed.verificationState.specMapping.synthesisClauseClosed !== 3) throw new Error(`综合报告证据闭环后 synthesisClauseClosed 应为 3：${synthClosed.verificationState.specMapping.synthesisClauseClosed}`)
if (synthClosed.verificationState.specMapping.clauseTotal !== 5) throw new Error('synthesis 证据闭环不得改变 VERIF 通道分母')
const synthReviewClosed = reviewSynthesisClauses(root)
if (!synthReviewClosed.passed || synthReviewClosed.open !== 0 || synthReviewClosed.total !== 3) throw new Error(`synthesis 条款闭环后 SYNTH 门禁应放行：${JSON.stringify(synthReviewClosed)}`)
// 无 verification-state.json 的工作区无 PPA 验收义务（放行，total=0）
const noStateReview = reviewSynthesisClauses(mkdtempSync(join(tmpdir(), 'moonglass-vi-nostate-')))
if (!noStateReview.passed || noStateReview.total !== 0) throw new Error('无验证状态模型时 SYNTH PPA 门禁应放行')

// ===== W1 进度挂 specMapping：clauseTotal=0 → pending（修"0/0 场景却 in-progress"空转） =====
const emptyRoot = mkdtempSync(join(tmpdir(), 'moonglass-vi-empty-'))
mkdirSync(join(emptyRoot, 'docs', '02_requirements'), { recursive: true })
mkdirSync(join(emptyRoot, 'rtl'), { recursive: true })
writeFileSync(join(emptyRoot, 'rtl', 'passthrough.v'), 'module passthrough(input a, output b); assign b = a; endmodule\n', 'utf-8')
const emptyBuild = buildVerificationIntelligence(emptyRoot)
if (emptyBuild.verificationState.specMapping.clauseTotal !== 0) throw new Error('空规格 fixture 条款数应为 0')
if (emptyBuild.verificationState.waveProgress.find((item) => item.id === 'W1')?.status !== 'pending') throw new Error(`无可验证条款时 W1 应 pending：${emptyBuild.verificationState.waveProgress.find((item) => item.id === 'W1')?.status}`)
if (emptyBuild.verificationState.waveProgress.find((item) => item.id === 'W1')?.scenarioCount !== 0) throw new Error('无可验证条款时不应派生 basic 候选')

// ===== W1 done：派生候选经 scenario_hits 闭环 → 条款 PASSED → coveredClause=clauseTotal =====
const doneRoot = mkdtempSync(join(tmpdir(), 'moonglass-vi-done-'))
mkdirSync(join(doneRoot, 'docs', '02_requirements'), { recursive: true })
mkdirSync(join(doneRoot, 'rtl'), { recursive: true })
mkdirSync(join(doneRoot, 'verification', 'results', 'mini'), { recursive: true })
writeFileSync(join(doneRoot, 'docs', '02_requirements', 'product_requirements.md'), `
# Mini Requirements

- REQ-BASE-001 P0: counter increments by one when advance is asserted and wraps at maximum.
`, 'utf-8')
writeFileSync(join(doneRoot, 'rtl', 'mini_counter.v'), `
module mini_counter(input clk, input rst_n, input advance, output reg [7:0] cnt);
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) cnt <= 0;
    else if (advance) cnt <= cnt + 1;
  end
endmodule
`, 'utf-8')
const doneFirst = buildVerificationIntelligence(doneRoot)
const doneDerived = doneFirst.verificationState.scenarios.filter((scenario) => scenario.origin === 'CLAUSE_DERIVED')
if (doneDerived.length !== 1 || doneDerived[0].requirementIds[0] !== 'REQ-BASE-001') throw new Error(`单条款项目应派生恰好一个 basic 候选：${doneDerived.length}`)
if (doneFirst.verificationState.waveProgress.find((item) => item.id === 'W1')?.status !== 'in-progress') throw new Error('条款未覆盖时 W1 应 in-progress')
// 派生候选进 W1 执行门：basic 未闭环时 corner/signoff（如 R05 formal 候选）不进执行计划
if (doneFirst.verificationState.executionPlan.length === 0 || !doneFirst.verificationState.executionPlan.every((plan) => plan.wave === 'basic')) throw new Error('派生候选未进入 W1 执行门（corner/signoff 应被挡）')
writeFileSync(join(doneRoot, 'verification', 'results', 'mini', 'results_icarus.xml'), '<testsuite tests="2" failures="0"/>', 'utf-8')
writeFileSync(join(doneRoot, 'verification', 'results', 'mini', 'mini.fst'), 'waveform-evidence', 'utf-8')
writeFileSync(join(doneRoot, 'verification', 'results', 'mini', 'scenario_hits.json'), JSON.stringify({
  rtlHash: doneFirst.structuralModel.rtlHash,
  scenarios: [{ id: doneDerived[0].id, reached: true, passed: true, assertionPassed: true, evidence: ['results_icarus.xml', 'mini.fst'] }]
}, null, 2), 'utf-8')
const doneSecond = buildVerificationIntelligence(doneRoot)
if (doneSecond.verificationState.scenarios.find((scenario) => scenario.id === doneDerived[0].id)?.status !== 'VERIFIED') throw new Error('派生候选 scenario_hits 证据未闭环')
if (doneSecond.verificationState.specMapping.statusCounts.PASSED !== 1 || doneSecond.verificationState.specMapping.coveredClause !== 1) throw new Error('派生候选闭环后条款应 PASSED')
if (doneSecond.verificationState.waveProgress.find((item) => item.id === 'W1')?.status !== 'done') throw new Error(`coveredClause=clauseTotal 时 W1 应 done：${doneSecond.verificationState.waveProgress.find((item) => item.id === 'W1')?.status}`)

// 单一哈希空间契约（2026-09-08 修复）：computeRtlHash 是证据登记与新鲜度判定的唯一口径
if (computeRtlHash(doneRoot) !== doneSecond.structuralModel.rtlHash) throw new Error('computeRtlHash 与 structuralModel.rtlHash 口径不一致')
// RTL 变更后：异空间哈希（如旧的绝对路径口径）的 hit 不得让场景重新闭环（修复前会永久卡 IMPACT_UNKNOWN）；
// 统一口径的 hit 必须能重新闭环
writeFileSync(join(doneRoot, 'rtl', 'mini_counter.v'), readFileSync(join(doneRoot, 'rtl', 'mini_counter.v'), 'utf-8') + '\n// rtl change\n', 'utf-8')
const foreignHitsPath = join(doneRoot, 'verification', 'results', 'mini', 'scenario_hits.json')
writeFileSync(foreignHitsPath, JSON.stringify({
  rtlHash: 'f'.repeat(64),
  scenarios: [{ id: doneDerived[0].id, reached: true, passed: true, assertionPassed: true, evidence: ['results_icarus.xml', 'mini.fst'] }]
}, null, 2), 'utf-8')
const foreignBuild = buildVerificationIntelligence(doneRoot)
const foreignScenario = foreignBuild.verificationState.scenarios.find((scenario) => scenario.id === doneDerived[0].id)
if (foreignScenario?.state.freshness === 'CURRENT' || foreignScenario?.status === 'VERIFIED') throw new Error('异空间哈希的 hit 不应被当作当前证据闭环')
writeFileSync(foreignHitsPath, JSON.stringify({
  rtlHash: computeRtlHash(doneRoot),
  scenarios: [{ id: doneDerived[0].id, reached: true, passed: true, assertionPassed: true, evidence: ['results_icarus.xml', 'mini.fst'] }]
}, null, 2), 'utf-8')
const unifiedBuild = buildVerificationIntelligence(doneRoot)
const unifiedScenario = unifiedBuild.verificationState.scenarios.find((scenario) => scenario.id === doneDerived[0].id)
if (unifiedScenario?.status !== 'VERIFIED' || unifiedScenario?.state.freshness !== 'CURRENT') throw new Error('统一口径 hit 未能在 RTL 变更后重新闭环')
rmSync(emptyRoot, { recursive: true, force: true })
rmSync(doneRoot, { recursive: true, force: true })

// ===== TBD 固化路径（2026-09-08 契约）：TBD 文本改为确定条款后，重建自动进入验证矩阵 =====
writeFileSync(join(root, 'docs', '02_requirements', 'product_requirements.md'), readFileSync(join(root, 'docs', '02_requirements', 'product_requirements.md'), 'utf-8').replace('错误计数饱和阈值 TBD，待架构评审确定。', '错误计数达到饱和阈值 255 后必须锁存并置位溢出标志。'), 'utf-8')
const tbdResolved = buildVerificationIntelligence(root)
const resolvedClause = tbdResolved.verificationState.specMapping.clauses.find((item) => item.clauseId === 'SPEC-TBD-001')
if (!resolvedClause) throw new Error('TBD 固化为确定条款后应自动进入验证矩阵')
if (resolvedClause.channel !== 'simulation') throw new Error(`固化后的功能条款应归 simulation 通道：${resolvedClause.channel}`)
if (tbdResolved.requirementModel.unknowns.some((item) => item.text.includes('SPEC-TBD-001'))) throw new Error('TBD 固化后不应再出现在 unknowns 中')

// ===== DEFECT-PACK-001 #9(c)/#9(a)：WAIVED 场景不计入 impactUnknown / criticalInsufficient；#8：Formal 工作区哈希 verdict 有效 =====
const exemptRoot = mkdtempSync(join(tmpdir(), 'moonglass-vi-exempt-'))
mkdirSync(join(exemptRoot, 'docs', '02_requirements'), { recursive: true })
mkdirSync(join(exemptRoot, 'rtl'), { recursive: true })
writeFileSync(join(exemptRoot, 'docs', '02_requirements', 'product_requirements.md'), `
# Exempt Requirements

- REQ-EX-001 P0: counter wraps at maximum.
- REQ-EX-002 P1: counter never skips a value.
`, 'utf-8')
writeFileSync(join(exemptRoot, 'rtl', 'exempt_counter.v'), `
module exempt_counter(input clk, input rst_n, input advance, output reg [7:0] cnt);
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) cnt <= 0;
    else if (advance) cnt <= cnt + 1;
  end
endmodule
`, 'utf-8')
const exemptFirst = buildVerificationIntelligence(exemptRoot)
const exemptWaived = exemptFirst.verificationState.scenarios.find((scenario) => scenario.origin === 'CLAUSE_DERIVED' && scenario.requirementIds[0] === 'REQ-EX-001')
const exemptFormal = exemptFirst.verificationState.scenarios.find((scenario) => scenario.origin === 'CLAUSE_DERIVED' && scenario.requirementIds[0] === 'REQ-EX-002')
if (!exemptWaived || !exemptFormal) throw new Error('断言前置失效：夹具应派生 REQ-EX-001/REQ-EX-002 两个条款候选场景')
mkdirSync(join(exemptRoot, 'verification', 'intelligence'), { recursive: true })
writeFileSync(join(exemptRoot, 'verification', 'intelligence', 'signoff-approvals.json'), JSON.stringify({ approvals: [{ riskId: `RR-WAIVER-${exemptWaived.id}`, approver: 'smoke-user', rationale: '已评估并接受残余风险', approvedAt: new Date().toISOString() }] }, null, 2), 'utf-8')
const exemptAdjudication = recordScenarioAdjudication(exemptRoot, [{ scenarioId: exemptWaived.id, status: 'WAIVED' }])
if (!exemptAdjudication.updated.includes(exemptWaived.id)) throw new Error(`夹具 WAIVED 裁决失败：${JSON.stringify(exemptAdjudication.rejected)}`)
// RTL 变更：豁免场景不会再产生新 hit，freshness 必为 IMPACT_UNKNOWN（修复前永久计入 impactUnknown 阻断）
writeFileSync(join(exemptRoot, 'rtl', 'exempt_counter.v'), readFileSync(join(exemptRoot, 'rtl', 'exempt_counter.v'), 'utf-8') + '\n// rtl change\n', 'utf-8')
const exemptBuild = buildVerificationIntelligence(exemptRoot)
const exemptWaivedAfter = exemptBuild.verificationState.scenarios.find((scenario) => scenario.id === exemptWaived.id)
if (exemptWaivedAfter?.state.closure !== 'WAIVED' || exemptWaivedAfter.state.freshness !== 'IMPACT_UNKNOWN') throw new Error(`断言前置失效：豁免场景应为 WAIVED + IMPACT_UNKNOWN：${exemptWaivedAfter?.state.closure}/${exemptWaivedAfter?.state.freshness}`)
const expectedImpactUnknown = exemptBuild.verificationState.scenarios.filter((scenario) => scenario.state.freshness === 'IMPACT_UNKNOWN' && !['WAIVED', 'EXCLUDED'].includes(scenario.state.closure)).length
if (exemptBuild.verificationState.closureAssessment.metrics.impactUnknown !== expectedImpactUnknown) throw new Error(`#9(c) 回归：WAIVED 场景仍计入 impactUnknown（${exemptBuild.verificationState.closureAssessment.metrics.impactUnknown} !== ${expectedImpactUnknown}）`)
if (exemptBuild.verificationState.multiOracle.criticalInsufficient.includes(exemptWaived.id)) throw new Error('#9(a) 回归：WAIVED 场景计入 criticalInsufficient')
if (!exemptBuild.verificationState.multiOracle.criticalInsufficient.includes(exemptFormal.id)) throw new Error('#9(a) 断言前置失效：未豁免的关键场景应计入 criticalInsufficient')
// #8：Formal 结果携带工作区统一口径 rtlHash 后，verdict 有效且证据能合并进 hits（FORMAL_PROVED）
mkdirSync(join(exemptRoot, 'verification', 'formal', 'results', 'ex_prove'), { recursive: true })
writeFileSync(join(exemptRoot, 'verification', 'formal', 'results', 'ex_prove', 'formal-result.json'), JSON.stringify({
  status: 'PASS', outcome: 'PROVEN', mode: 'prove', obligation: 'required', scenarioId: exemptFormal.id,
  rtlHash: computeRtlHash(exemptRoot), propertyFiles: [], traces: []
}, null, 2), 'utf-8')
const exemptProved = buildVerificationIntelligence(exemptRoot)
const formalAssessment = exemptProved.verificationState.multiOracle.assessments.find((item) => item.scenarioId === exemptFormal.id)
if (!formalAssessment?.passOracleIds.includes('ORACLE-FORMAL-PROPERTY') || formalAssessment.invalidOracleIds.includes('ORACLE-FORMAL-PROPERTY')) throw new Error(`#8 回归：工作区口径 rtlHash 的 Formal verdict 仍被判无效：${JSON.stringify(formalAssessment)}`)
const provedScenario = exemptProved.verificationState.scenarios.find((scenario) => scenario.id === exemptFormal.id)
if (provedScenario?.status !== 'FORMAL_PROVED') throw new Error(`#8 回归：工作区口径 Formal 证据未合并进 hits：${provedScenario?.status}`)
rmSync(exemptRoot, { recursive: true, force: true })

console.log(`Verification Intelligence smoke passed: ${second.risks.length} risks, ${second.verificationState.scenarioCount} scenarios`)
