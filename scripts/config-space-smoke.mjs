// AIGV 修订批 1：配置空间模型（§4 registerConfigSpace 锚点校验 + 四类配置点生成 + 剪枝 + R09/R16 替代）
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildVerificationIntelligence, registerConfigSpace } from '../packages/verification-intelligence-engine/src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'moonglass-config-space-'))
mkdirSync(join(root, 'docs', '02_requirements'), { recursive: true })
mkdirSync(join(root, 'rtl'), { recursive: true })

writeFileSync(join(root, 'docs', '02_requirements', 'product_requirements.md'), `
# Reg Config Requirements

- REQ-CFG-001 P0: 工作模式寄存器支持 idle/run/sleep 三种模式。
- SPEC-CFG-002 P1: 阈值越界写入必须报错并保留旧值。
- SPEC-CFG-003 P1: sleep 模式与中断使能同时开启属非法组合，必须报错。
`, 'utf-8')

writeFileSync(join(root, 'rtl', 'cfg_top.v'), `
module cfg_top(input clk, input rst_n, input busy, output irq);
  wire [7:0] cfg_thresh;
  reg_cfg u_regs(.clk(clk), .rst_n(rst_n), busy(busy), cfg_mode(), cfg_thresh(cfg_thresh), cfg_en(), irq(irq));
endmodule
`, 'utf-8')
writeFileSync(join(root, 'rtl', 'reg_cfg.v'), `
module reg_cfg(input clk, input rst_n, input busy, output reg [1:0] cfg_mode, output reg [7:0] cfg_thresh, output reg cfg_en, output reg irq);
  localparam MODE_IDLE = 2'd0;
  localparam MODE_RUN = 2'd1;
  localparam MODE_SLEEP = 2'd2;
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin cfg_mode <= MODE_IDLE; cfg_thresh <= 8'd0; cfg_en <= 1'b0; irq <= 1'b0; end
    else if (cfg_en && cfg_mode == MODE_RUN) irq <= busy;
  end
endmodule
`, 'utf-8')

const first = buildVerificationIntelligence(root)
const strategyTop = first.verificationState.moduleVerificationStrategy
if (strategyTop.topModules[0] !== 'cfg_top') throw new Error('顶层识别错误')

// ===== 缺 config-space 时不生成 CONFIG_DERIVED；R09/R16 场景级产出生效 =====
if (first.verificationState.scenarios.some((scenario) => scenario.origin === 'CONFIG_DERIVED')) throw new Error('无 config-space 时不得生成配置点场景')
const r09r16Before = first.verificationState.scenarios.filter((scenario) => scenario.riskIds.some((id) => first.risks.find((risk) => risk.id === id && ['R09', 'R16'].includes(risk.taxonomyId))))
if (!first.risks.some((risk) => ['R09', 'R16'].includes(risk.taxonomyId))) throw new Error('fixture 应包含 R09/R16 风险（cfg/busy 语义）')
if (r09r16Before.length === 0) throw new Error('无 config-space 时 R09/R16 应产生场景级产出')

const configPath = join(root, 'verification', 'intelligence', 'config-space.json')
const validInput = {
  registers: [{
    name: 'CFG_CTRL',
    address: '0x00',
    rtlModule: 'reg_cfg',
    fields: [
      { name: 'cfg_mode', msb: 1, lsb: 0, resetValue: '0', domain: { kind: 'enum', values: [{ value: '0', label: 'idle' }, { value: '1', label: 'run' }, { value: '2', label: 'sleep' }] }, clauseId: 'REQ-CFG-001', description: '工作模式选择' },
      { name: 'cfg_thresh', msb: 9, lsb: 2, resetValue: '0', domain: { kind: 'range', min: 0, max: 255 }, clauseId: 'SPEC-CFG-002', description: '计数阈值' },
      { name: 'cfg_en', msb: 10, lsb: 10, resetValue: '0', domain: { kind: 'flag' }, clauseId: null, description: '中断使能' }
    ]
  }],
  constraints: [{ type: 'illegal', fields: ['CFG_CTRL.cfg_mode', 'CFG_CTRL.cfg_en'], description: 'sleep 模式与中断使能同时开启属非法组合：必须报错并忽略本次写入', clauseId: 'SPEC-CFG-003' }]
}

// ===== 锚点拒绝 =====
const expectReject = (input, keyword, label) => {
  let rejected = false
  try { registerConfigSpace(root, input) } catch (err) { rejected = String(err).includes(keyword) }
  if (!rejected) throw new Error(`${label}应被拒绝（期望命中「${keyword}」）`)
}
expectReject({ registers: [{ ...validInput.registers[0], rtlModule: 'not_a_module' }], constraints: [] }, '结构模型中不存在', '坏 rtlModule')
expectReject({ registers: [{ ...validInput.registers[0], fields: [{ ...validInput.registers[0].fields[0], name: 'hallucinated_field' }] }], constraints: [] }, '检索不到', '幻觉字段名')
expectReject({ registers: [{ ...validInput.registers[0], fields: [{ ...validInput.registers[0].fields[1], domain: { kind: 'range', min: 10, max: 5 } }] }], constraints: [] }, 'min 必须 ≤ max', 'range min>max')
expectReject({ registers: [{ ...validInput.registers[0], fields: [{ ...validInput.registers[0].fields[0], domain: { kind: 'enum', values: [] } }] }], constraints: [] }, 'enum domain 非法', 'enum 空值')
expectReject({ registers: [{ ...validInput.registers[0], fields: [{ ...validInput.registers[0].fields[0], description: '长'.repeat(121) }] }], constraints: [] }, '超过 120 字', '描述超 120 字')
expectReject({ registers: validInput.registers, constraints: [{ type: 'illegal', fields: ['CFG_CTRL.not_a_field'], description: '悬空引用必须报错' }] }, '引用不存在', 'constraint 悬空引用')
expectReject({ registers: [{ ...validInput.registers[0], fields: [{ ...validInput.registers[0].fields[0], clauseId: 'SPEC-NOT-EXIST' }] }], constraints: [] }, '不存在于 requirement-model', '坏 clauseId')
expectReject({ registers: [], constraints: [] }, 'registers 不能为空', '空寄存器表')
if (existsSync(configPath)) throw new Error('校验失败不应落盘 config-space.json')

// ===== 合法登记：落盘 + 返回内容 =====
const configSpace = registerConfigSpace(root, validInput)
if (configSpace.version !== 1 || configSpace.registers.length !== 1 || configSpace.constraints.length !== 1) throw new Error('registerConfigSpace 返回值错误')
if (!existsSync(configPath)) throw new Error('config-space.json 未落盘')
const persisted = JSON.parse(readFileSync(configPath, 'utf-8'))
if (persisted.version !== 1 || !persisted.generatedAt || persisted.registers[0].fields.length !== 3) throw new Error('config-space.json 落盘内容错误')

// ===== 四类配置点生成（§4.3）=====
const withConfig = buildVerificationIntelligence(root)
const configScenarios = withConfig.verificationState.scenarios.filter((scenario) => scenario.origin === 'CONFIG_DERIVED')
const byClass = (cls) => configScenarios.filter((scenario) => scenario.configPoint?.class === cls)
const business = byClass('business')
const boundary = byClass('boundary')
const illegal = byClass('illegal')
const dynamic = byClass('dynamic')
// 业务点：enum 3 值 + flag 全开/全关/典型组合（单 flag 时典型与全开同键去重 → 2）= 5
if (business.length !== 5) throw new Error(`业务点数量错误（enum 每值 1 + flag 组合去重后 2，期望 5）：${business.length}`)
// 边界点：range 0/min/max/max+1 去重（0 与 min 重叠）= 3，每字段 ≤4
if (boundary.length !== 3) throw new Error(`边界点数量错误（0/min/max/max+1 去重后 3，每字段 ≤4）：${boundary.length}`)
if (boundary.some((scenario) => !scenario.configPoint?.refs[0]?.startsWith('CFG_CTRL.cfg_thresh='))) throw new Error('边界点 refs 应锚定 range 字段取值')
// 非法点：每条 constraint 一个违反组合 = 1
if (illegal.length !== 1 || !illegal[0].expected[0].includes('必须报错并忽略本次写入')) throw new Error('非法点应锚定 constraint 描述与期望行为')
// 动态点：在线切模式（enum）+ 忙时改配（每寄存器 1）= 2
if (dynamic.length !== 2) throw new Error(`动态点数量错误（在线切模式 + 忙时改配 = 2）：${dynamic.length}`)
if (dynamic.some((scenario) => !scenario.features.includes('busy'))) throw new Error('动态点应带 busy 语义特征')
// 口径：PLANNED 候选池 / 优先级低于阻断阈值 / 波段与主题 / method
if (!configScenarios.every((scenario) => scenario.status === 'PLANNED' && scenario.priority < 0.2 && scenario.method === 'simulation')) throw new Error('配置点候选应为 PLANNED 候选池口径（priority < 0.2，与 CLAUSE_DERIVED 一致）')
if (!business.every((scenario) => scenario.wave === 'basic')) throw new Error('业务点应归 basic 波段（W1/W2 主体）')
if (!boundary.every((scenario) => scenario.wave === 'corner' && scenario.topic === '配置边界')) throw new Error('边界点应归 corner 波段（配置边界主题）')
if (!illegal.every((scenario) => scenario.wave === 'corner' && scenario.topic === '配置非法组合')) throw new Error('非法点应归 corner 波段（配置非法组合主题）')
if (!dynamic.every((scenario) => scenario.wave === 'corner' && scenario.topic === '忙时配置变更')) throw new Error('动态点应归 corner 波段（忙时配置变更主题）')
if (!configScenarios.every((scenario) => /^SCN-[A-F0-9]{8}$/.test(scenario.id) && scenario.configPoint?.refs.length)) throw new Error('配置点场景 ID/refs 不合法')
// clauseId 双向指针（§4.6）：锚定条款进入 MAPPED_UNTESTED 且 scenarioIds 含配置点场景
const mappedMode = withConfig.verificationState.specMapping.clauses.find((item) => item.clauseId === 'REQ-CFG-001')
if (!mappedMode || mappedMode.status !== 'MAPPED_UNTESTED' || !mappedMode.scenarioIds.some((id) => business.some((scenario) => scenario.id === id && scenario.requirementIds.includes('REQ-CFG-001')))) throw new Error('寄存器章节条款应由配置点场景映射（§4.6 双向指针）')
// R09/R16 场景级产出被动态点替代（风险登记保留）
if (withConfig.verificationState.scenarios.some((scenario) => scenario.riskIds.some((id) => withConfig.risks.find((risk) => risk.id === id && ['R09', 'R16'].includes(risk.taxonomyId))))) throw new Error('有 config-space 时 R09/R16 不得再产生场景级产出')
if (!withConfig.risks.some((risk) => ['R09', 'R16'].includes(risk.taxonomyId))) throw new Error('R09/R16 风险规则应保留作风险登记')
// 幂等：二次 rebuild ID 稳定、无重复
const rebuild2 = buildVerificationIntelligence(root)
const ids2 = rebuild2.verificationState.scenarios.filter((scenario) => scenario.origin === 'CONFIG_DERIVED').map((scenario) => scenario.id).sort()
if (JSON.stringify(ids2) !== JSON.stringify(configScenarios.map((scenario) => scenario.id).sort())) throw new Error('配置点场景 ID 跨 rebuild 不稳定')
// 配置点意图（批次 prompt 消费）
const configIntents = rebuild2.verificationState.verificationIntents.filter((intent) => ids2.includes(intent.scenarioId))
if (configIntents.length !== configScenarios.length || !configIntents.every((intent) => intent.objective.includes('验证配置点'))) throw new Error('配置点场景缺少对应 Intent')
// 执行计划全局 cap 共用（§4.4：配置点与普通场景共用，超出留候选池）
if (rebuild2.verificationState.executionPlan.length > 24) throw new Error(`执行计划超出全局 cap：${rebuild2.verificationState.executionPlan.length}`)

// ===== 非法点证据闭环 → 条款 PASSED（config 场景走同一闭环）=====
mkdirSync(join(root, 'verification', 'results', 'cfg_top'), { recursive: true })
writeFileSync(join(root, 'verification', 'results', 'cfg_top', 'results.xml'), '<testsuite tests="1" failures="0"/>', 'utf-8')
writeFileSync(join(root, 'verification', 'results', 'cfg_top', 'scenario_hits.json'), JSON.stringify({
  rtlHash: rebuild2.structuralModel.rtlHash,
  scenarios: [{ id: illegal[0].id, reached: true, passed: true, assertionPassed: true, evidence: ['results.xml'] }]
}, null, 2), 'utf-8')
const closed = buildVerificationIntelligence(root)
const illegalAfter = closed.verificationState.scenarios.find((scenario) => scenario.id === illegal[0].id)
if (illegalAfter?.status !== 'VERIFIED') throw new Error('配置点场景应经 scenario_hits 证据闭环（与普通场景同口径）')
const illegalClause = closed.verificationState.specMapping.clauses.find((item) => item.clauseId === 'SPEC-CFG-003')
if (illegalClause?.status !== 'PASSED') throw new Error('配置点闭环后锚定条款应派生 PASSED（§4.6 口径）')

// ===== 配置覆盖消费（§4.5 批 3）：读取/归一化/stale 判定/损坏降级 =====
const coverageFixture = {
  version: 1,
  generatedAt: new Date().toISOString(),
  rtlHash: closed.structuralModel.rtlHash,
  topModule: 'cfg_top',
  coverpoints: [
    { id: 'cp_mode', field: 'CFG_CTRL.cfg_mode', buckets: [{ label: 'idle', hits: 3 }, { label: 'run', hits: 0 }, { label: 'sleep', hits: 1 }] },
    { id: 'cp_en', field: 'CFG_CTRL.cfg_en', buckets: [{ label: 'off', hits: 2 }, { label: 'on', hits: 2 }] }
  ],
  crosses: [
    { id: 'x_mode_en', fields: ['CFG_CTRL.cfg_mode', 'CFG_CTRL.cfg_en'], bins: [{ key: 'idle×off', hits: 1 }, { key: 'run×on', hits: 0 }] }
  ]
}
const coveragePath = join(root, 'verification', 'results', 'cfg_top', 'config-coverage.json')
const posturePath = join(root, 'verification', 'intelligence', 'verification-posture.json')
writeFileSync(coveragePath, JSON.stringify(coverageFixture, null, 2), 'utf-8')
buildVerificationIntelligence(root)
const postureWithCoverage = JSON.parse(readFileSync(posturePath, 'utf-8'))
const coverage = postureWithCoverage.configCoverage
if (!coverage) throw new Error('posture 应挂载 configCoverage（§4.5 消费链路）')
if (coverage.stale !== false || coverage.topModule !== 'cfg_top' || coverage.rtlHash !== closed.structuralModel.rtlHash) throw new Error('configCoverage 元数据/stale 判定错误')
const cpMode = coverage.coverpoints.find((item) => item.field === 'CFG_CTRL.cfg_mode')
if (!cpMode || cpMode.bucketCount !== 3 || cpMode.hitBuckets !== 2 || Math.abs(cpMode.hitRate - 2 / 3) > 1e-9 || cpMode.totalHits !== 4) throw new Error(`coverpoint 归一化错误：${JSON.stringify(cpMode)}`)
const cross = coverage.crosses.find((item) => item.id === 'x_mode_en')
if (!cross || cross.binCount !== 2 || cross.hitBins !== 1 || cross.bins[0].key !== 'idle×off' || cross.fields.length !== 2) throw new Error(`cross 归一化错误（bins 应保留 key）：${JSON.stringify(cross)}`)
// stale：rtlHash 与当前不一致 → stale=true（freshness 口径沿用覆盖率门禁）
writeFileSync(coveragePath, JSON.stringify({ ...coverageFixture, rtlHash: 'deadbeef' }, null, 2), 'utf-8')
buildVerificationIntelligence(root)
const stalePosture = JSON.parse(readFileSync(posturePath, 'utf-8'))
if (stalePosture.configCoverage?.stale !== true) throw new Error('rtlHash 不一致时 configCoverage.stale 应为 true')
// 损坏/缺文件 = posture 无该字段
writeFileSync(coveragePath, '{oops', 'utf-8')
buildVerificationIntelligence(root)
const brokenPosture = JSON.parse(readFileSync(posturePath, 'utf-8'))
if ('configCoverage' in brokenPosture) throw new Error('损坏的 config-coverage.json 应导致 posture 无 configCoverage 字段')
rmSync(coveragePath)

// ===== 删除 config-space：派生候选退出，R09/R16 恢复 =====
rmSync(configPath)
const withoutConfig = buildVerificationIntelligence(root)
if (withoutConfig.verificationState.scenarios.some((scenario) => scenario.origin === 'CONFIG_DERIVED')) throw new Error('config-space 删除后派生候选应退出')
if (!withoutConfig.verificationState.scenarios.some((scenario) => scenario.riskIds.some((id) => withoutConfig.risks.find((risk) => risk.id === id && ['R09', 'R16'].includes(risk.taxonomyId))))) throw new Error('config-space 删除后 R09/R16 场景级产出应恢复')

rmSync(root, { recursive: true, force: true })
console.log(`Config space smoke passed: 校验/四类点(${business.length}业务 ${boundary.length}边界 ${illegal.length}非法 ${dynamic.length}动态)/剪枝/替代/闭环/配置覆盖消费全通过`)
