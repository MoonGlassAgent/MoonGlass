// AIGV 修订批 1：UT 例外登记（§3.2 registerUtEscalation / retireUtEscalation）+ 历史环境自动登记（§8 迁移）+ 策略两态覆写
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildVerificationIntelligence, registerUtEscalation, retireUtEscalation } from '../packages/verification-intelligence-engine/src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'moonglass-ut-escalation-'))
mkdirSync(join(root, 'docs', '02_requirements'), { recursive: true })
mkdirSync(join(root, 'rtl'), { recursive: true })

writeFileSync(join(root, 'docs', '02_requirements', 'product_requirements.md'), `
# Timer Requirements

- REQ-TMR-001 P0: 计数器达到阈值后必须置位溢出标志。
- SPEC-TMR-002 P1: 使能关闭时计数器保持当前值不变。
`, 'utf-8')

writeFileSync(join(root, 'rtl', 'sample_top.v'), `
module sample_top(input clk, input rst_n, input start, output done);
  wire sub_done;
  sample_sub u_sub(.clk(clk), .rst_n(rst_n), .go(start), .done(sub_done));
  assign done = sub_done;
endmodule
`, 'utf-8')
writeFileSync(join(root, 'rtl', 'sample_sub.v'), `
module sample_sub(input clk, input rst_n, input go, output reg done);
  reg [3:0] cnt;
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin cnt <= 0; done <= 0; end
    else if (go && cnt != 4'hF) cnt <= cnt + 1;
    else if (cnt == 4'hF) done <= 1;
  end
endmodule
`, 'utf-8')

const first = buildVerificationIntelligence(root)
const strategyOf = (artifacts) => artifacts.verificationState.moduleVerificationStrategy
// 前置断言：两态默认（top→TOP_SIGNOFF，子模块→COVERED_BY_TOP）
const baseline = strategyOf(first)
if (baseline.modules.find((item) => item.module === 'sample_top')?.level !== 'TOP_SIGNOFF') throw new Error('顶层应为 TOP_SIGNOFF')
if (baseline.modules.find((item) => item.module === 'sample_sub')?.level !== 'COVERED_BY_TOP') throw new Error('无例外时子模块应为 COVERED_BY_TOP')
if (baseline.summary.UT_EXCEPTION !== 0) throw new Error('无例外时 summary.UT_EXCEPTION 应为 0')
if (first.verificationState.scenarios.some((scenario) => scenario.rtlObjects[0]?.split('.')[0] === 'sample_sub')) throw new Error('无例外时子模块不应生成场景锚点')

const escalationPath = join(root, 'verification', 'results', 'ut-escalations.json')
const scenarioIds = first.verificationState.scenarios.map((scenario) => scenario.id)
const topScenarioId = scenarioIds[0]

// ===== 锚点拒绝：不存在模块 =====
let rejected = false
try { registerUtEscalation(root, { module: 'not_a_module', reason: '探针无法定位', failureSignature: 'sig123', rootCauseId: null, topScenarioIds: [] }) } catch (err) { rejected = String(err).includes('结构模型中不存在') }
if (!rejected) throw new Error('不存在模块的 UT 例外登记应被拒绝')

// ===== 锚点拒绝：幻觉 scenarioId =====
rejected = false
try { registerUtEscalation(root, { module: 'sample_sub', reason: '探针无法定位', failureSignature: 'sig123', rootCauseId: null, topScenarioIds: ['SCN-DEADBEEF'] }) } catch (err) { rejected = String(err).includes('幻觉引用拒绝') }
if (!rejected) throw new Error('不存在 scenarioId 的 UT 例外登记应被拒绝（幻觉引用拒绝）')

// ===== 锚点拒绝：幻觉 rootCauseId =====
rejected = false
try { registerUtEscalation(root, { module: 'sample_sub', reason: '探针无法定位', failureSignature: 'sig123', rootCauseId: 'RC-NOTEXIST', topScenarioIds: [] }) } catch (err) { rejected = String(err).includes('rootCauseId 不存在') }
if (!rejected) throw new Error('不存在 rootCauseId 的 UT 例外登记应被拒绝')

// ===== 预防性 UT（§11 决策 1）：failureSignature 可空、topScenarioIds 可空 =====
const preventive = registerUtEscalation(root, { module: 'sample_sub', reason: '预防性 UT：该模块计数边界复杂，先在模块级建立环境以降低集成定位成本', failureSignature: null, rootCauseId: null, topScenarioIds: [] })
if (!/^UTX-[A-F0-9]{8}$/.test(preventive.record.id)) throw new Error(`UT 例外 ID 不稳定：${preventive.record.id}`)
if (preventive.record.failureSignature !== null || preventive.record.status !== 'active') throw new Error('预防性 UT 应允许 failureSignature=null 且状态 active')
if (!existsSync(escalationPath)) throw new Error('ut-escalations.json 未落盘')

// ===== 幂等：同模块同 reason 复用 id，不产生新记录 =====
const again = registerUtEscalation(root, { module: 'sample_sub', reason: '预防性 UT：该模块计数边界复杂，先在模块级建立环境以降低集成定位成本', failureSignature: null, rootCauseId: null, topScenarioIds: [] })
if (!again.reused || again.record.id !== preventive.record.id) throw new Error('同模块同 reason 应幂等复用同一 id')
let escalations = JSON.parse(readFileSync(escalationPath, 'utf-8')).escalations
if (escalations.length !== 1) throw new Error(`幂等复用不应新增记录：${escalations.length}`)

// ===== 正常登记（带失败指纹与 TOP 场景锚点）=====
const diagnostic = registerUtEscalation(root, { module: 'sample_sub', reason: 'TOP 波形只能看到 done，L3 计数器状态无法经 probe 定位满量边界错误', failureSignature: 'aaaa1111bbbb', rootCauseId: null, topScenarioIds: [topScenarioId] })
if (diagnostic.reused) throw new Error('不同 reason 应产生新记录')
escalations = JSON.parse(readFileSync(escalationPath, 'utf-8')).escalations
if (escalations.length !== 2) throw new Error(`应共存两条例外记录：${escalations.length}`)
if (JSON.stringify(escalations.find((item) => item.id === diagnostic.record.id).topScenarioIds) !== JSON.stringify([topScenarioId])) throw new Error('topScenarioIds 未持久化')

// ===== rebuild 联查：策略两态覆写为 UT_EXCEPTION + 场景锚点放开 + 执行计划纳入 =====
const withException = buildVerificationIntelligence(root)
const strategy = strategyOf(withException)
const subPlan = strategy.modules.find((item) => item.module === 'sample_sub')
if (subPlan?.level !== 'UT_EXCEPTION') throw new Error(`active 例外模块应覆写为 UT_EXCEPTION：${subPlan?.level}`)
if (!subPlan.standaloneTestbench) throw new Error('UT_EXCEPTION 模块应标记 standaloneTestbench（已登记 active UT 例外）')
if (!subPlan.requiredChecks.includes('独立定向 Testbench')) throw new Error('UT_EXCEPTION requiredChecks 应为独立定向 Testbench 清单')
if (strategy.summary.UT_EXCEPTION !== 1 || strategy.summary.TOP_SIGNOFF !== 1 || strategy.summary.COVERED_BY_TOP !== strategy.modules.length - 2) throw new Error(`summary 计数错误（按模块计级，同模块多条例外不重复计数）：${JSON.stringify(strategy.summary)}`)
if (!withException.verificationState.scenarios.some((scenario) => scenario.rtlObjects[0]?.split('.')[0] === 'sample_sub')) throw new Error('active 例外模块的场景锚点应放开（同原 UNIT_FOCUSED 路径）')
// 执行计划纳入口径与普通场景一致：受"W1 不满不进 W2"波段门约束（basic 未闭环时 corner/signoff 不排队）
const subScenarioInPlanWave = withException.verificationState.executionPlan.some((plan) => withException.verificationState.scenarios.find((scenario) => scenario.id === plan.scenarioId)?.rtlObjects[0]?.split('.')[0] === 'sample_sub')
const subWaves = new Set(withException.verificationState.scenarios.filter((scenario) => scenario.rtlObjects[0]?.split('.')[0] === 'sample_sub').map((scenario) => scenario.wave ?? 'basic'))
if (subWaves.has('basic') && !subScenarioInPlanWave) throw new Error('active 例外模块的 basic 场景应进入执行计划')
// posture 携带登记表（批 3 UI 数据源）
const posture = JSON.parse(readFileSync(join(root, 'verification', 'intelligence', 'verification-posture.json'), 'utf-8'))
if (!Array.isArray(posture.utEscalations) || posture.utEscalations.length !== 2) throw new Error('posture 未携带 utEscalations 登记表')

// ===== 退役：根因修复且 TOP 回归覆盖后 retired，rebuild 恢复 COVERED_BY_TOP =====
const retired = retireUtEscalation(root, preventive.record.id, '根因修复且 TOP 回归已覆盖，模块环境退役保留历史')
if (retired.status !== 'retired' || !retired.retiredReason.includes('根因修复')) throw new Error('退役字段未写入')
const retiredAgain = retireUtEscalation(root, preventive.record.id, '重复退役依据')
if (retiredAgain !== retired && retiredAgain.status !== 'retired') throw new Error('重复退役应幂等返回 retired 记录')
let afterRetire = buildVerificationIntelligence(root)
if (strategyOf(afterRetire).modules.find((item) => item.module === 'sample_sub')?.level !== 'UT_EXCEPTION') throw new Error('仍存在另一条 active 例外时不应降级')
retireUtEscalation(root, diagnostic.record.id, '根因修复且 TOP 回归已覆盖')
afterRetire = buildVerificationIntelligence(root)
if (strategyOf(afterRetire).modules.find((item) => item.module === 'sample_sub')?.level !== 'COVERED_BY_TOP') throw new Error('全部例外退役后应恢复 COVERED_BY_TOP')
escalations = JSON.parse(readFileSync(escalationPath, 'utf-8')).escalations
if (escalations.filter((item) => item.status === 'active').length !== 0 || escalations.length !== 2) throw new Error('退役应保留历史记录（不删除）')
rejected = false
try { retireUtEscalation(root, 'UTX-NOTEXIST', 'x') } catch (err) { rejected = String(err).includes('不存在') }
if (!rejected) throw new Error('退役不存在的例外应报错')
rmSync(join(root, 'verification', 'results', 'ut-escalations.json'))

// ===== §8 历史迁移：<module>_tb + scenario_hits 登记 → 自动登记 active 例外（幂等）=====
const legacy = mkdtempSync(join(tmpdir(), 'moonglass-ut-legacy-'))
mkdirSync(join(legacy, 'docs', '02_requirements'), { recursive: true })
mkdirSync(join(legacy, 'rtl'), { recursive: true })
mkdirSync(join(legacy, 'verification', 'results', 'legacy_top'), { recursive: true })
writeFileSync(join(legacy, 'docs', '02_requirements', 'product_requirements.md'), '- REQ-LG-001 P0: legacy top must complete transactions.\n', 'utf-8')
writeFileSync(join(legacy, 'rtl', 'legacy_top.v'), `
module legacy_top(input clk, input rst_n, input req, output ack);
  legacy_sub u_sub(.clk(clk), .rst_n(rst_n), .req(req), .ack(ack));
endmodule
`, 'utf-8')
writeFileSync(join(legacy, 'rtl', 'legacy_sub.v'), `
module legacy_sub(input clk, input rst_n, input req, output reg ack);
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) ack <= 0;
    else if (req) ack <= 1;
  end
endmodule
`, 'utf-8')
const legacyFirst = buildVerificationIntelligence(legacy)
// 仅 TB 目录无 hits 登记 → 不自动登记
mkdirSync(join(legacy, 'verification', 'legacy_sub_tb'), { recursive: true })
let legacyBuild = buildVerificationIntelligence(legacy)
if (existsSync(join(legacy, 'verification', 'results', 'ut-escalations.json'))) throw new Error('无 scenario_hits 登记时不应自动登记')
// 补上 scenario_hits 登记（hits 位于 results/legacy_sub/ 目录）→ 自动登记
mkdirSync(join(legacy, 'verification', 'results', 'legacy_sub'), { recursive: true })
writeFileSync(join(legacy, 'verification', 'results', 'legacy_sub', 'scenario_hits.json'), JSON.stringify({
  rtlHash: legacyFirst.structuralModel.rtlHash,
  scenarios: [{ id: legacyFirst.verificationState.scenarios[0].id, reached: true, passed: true, assertionPassed: true, evidence: [] }]
}, null, 2), 'utf-8')
legacyBuild = buildVerificationIntelligence(legacy)
const legacyEscalations = JSON.parse(readFileSync(join(legacy, 'verification', 'results', 'ut-escalations.json'), 'utf-8')).escalations
if (legacyEscalations.length !== 1) throw new Error(`历史环境应自动登记一条例外：${legacyEscalations.length}`)
const migrated = legacyEscalations[0]
if (migrated.module !== 'legacy_sub' || migrated.reason !== '历史环境自动登记' || migrated.failureSignature !== null || migrated.status !== 'active') throw new Error(`历史迁移记录字段错误：${JSON.stringify(migrated)}`)
if (strategyOf(legacyBuild).modules.find((item) => item.module === 'legacy_sub')?.level !== 'UT_EXCEPTION') throw new Error('历史迁移后策略表应显示 UT_EXCEPTION')
// 幂等：二次 rebuild 不重复登记
legacyBuild = buildVerificationIntelligence(legacy)
if (JSON.parse(readFileSync(join(legacy, 'verification', 'results', 'ut-escalations.json'), 'utf-8')).escalations.length !== 1) throw new Error('历史迁移应幂等（已有记录不重复登记）')
// 已有 retired 记录的模块不重复登记
retireUtEscalation(legacy, migrated.id, '用户退役历史环境')
mkdirSync(join(legacy, 'verification', 'results', 'legacy_sub', 'deeper'), { recursive: true })
writeFileSync(join(legacy, 'verification', 'results', 'legacy_sub', 'deeper', 'scenario_hits.json'), JSON.stringify({ scenarios: [{ id: legacyFirst.verificationState.scenarios[0].id, reached: true, passed: true }] }, null, 2), 'utf-8')
buildVerificationIntelligence(legacy)
const afterRetiredMigration = JSON.parse(readFileSync(join(legacy, 'verification', 'results', 'ut-escalations.json'), 'utf-8')).escalations
if (afterRetiredMigration.length !== 1) throw new Error('已有 retired 记录的模块不得重复自动登记')

rmSync(legacy, { recursive: true, force: true })
rmSync(root, { recursive: true, force: true })
console.log('UT escalation smoke passed: 登记/幂等/锚点拒绝/退役/历史迁移/两态覆写全通过')
