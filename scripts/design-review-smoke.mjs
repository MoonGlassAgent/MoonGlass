/**
 * 设计评审左移（片 A：门禁与数据层）冒烟脚本
 *
 * 覆盖设计文档 DESIGN-REVIEW-LEFT-SHIFT-ZH-CN.md §3/§6/§7 的门禁与数据层口径：
 *   1. 发现清单归一化：坏 JSON / 缺字段 / 旧版无 rounds 均降级不炸
 *   2. pendingMajorCount 计数（含 minor 与已处置项排除）
 *   3. 多轮 rounds[] 合并：处置状态跨轮按键保留（最新一轮覆盖）
 *   4. 发现稳定键幂等（空白折叠归一化，不同发现键不同）
 *   5. A2 微架构复杂度分级两档：条款 51（超）vs 50（未超）、模块数无法解析时降级不升档、
 *      模块数 >4 升档、超阈值且文档存在时通过
 *   6. A3 软 review 门禁三态：缺报告（提示放行+指引）/ 有 pending major（告警不阻断）/ 通过
 * 运行：node scripts/design-review-smoke.mjs
 */
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const {
  ARCH_REVIEW_FINDINGS_PATH,
  RTL_REVIEW_FINDINGS_PATH,
  findingStableKey,
  mergeFindingsAcrossRounds,
  normalizeDesignReviewFindings,
  pendingMajorCount,
  readDesignReviewFindings,
  reviewRoundCount
} = await import('../src/main/services/design-review.ts')
const { PhaseEngine } = await import('../src/main/services/PhaseEngine.ts')

const root = mkdtempSync(join(tmpdir(), 'moonglass-design-review-'))
let failures = 0
const check = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).split('\n')[0].slice(0, 160)}` : ''}`)
  if (!cond) failures++
}

// ---------- 1. 清单归一化 ----------
const normDir = join(root, 'normalize')
mkdirSync(normDir, { recursive: true })
writeFileSync(join(normDir, 'bad.json'), '{ not-valid json', 'utf-8')
check('坏 JSON 降级返回 null 不炸', readDesignReviewFindings(normDir, 'bad.json') === null)

const sparse = normalizeDesignReviewFindings({ findings: [{ 描述: '缺字段条目', 位置: 'rtl/a.v:1' }] })
check(
  '缺字段清单降级：默认值补齐且条目保留',
  sparse !== null && sparse.version === 1 && sparse.rounds.length === 0 &&
    sparse.findings.length === 1 && sparse.findings[0].严重度 === 'minor' && sparse.findings[0].处置 === 'pending',
  JSON.stringify(sparse?.findings[0])
)
const notObject = normalizeDesignReviewFindings([1, 2, 3])
check('顶层非对象归一化返回 null', notObject === null)

// 旧版单轮清单（无 rounds 字段）
const legacy = normalizeDesignReviewFindings({
  version: 1,
  generatedAt: '2026-10-09T00:00:00.000Z',
  reviewRound: 1,
  model: 'provider/model-a',
  findings: [
    { 描述: 'major 问题 A', 位置: 'docs/02_requirements/product_requirements.md#REQ-FUNC-001', 严重度: 'major', 处置: 'pending' },
    { 描述: 'minor 问题 B', 位置: 'rtl/gmac_axil_regs.v:245', 严重度: 'minor', 处置: 'pending' }
  ]
})
check('旧版无 rounds 清单可读取', legacy !== null && legacy.rounds.length === 0 && legacy.findings.length === 2)
check('旧版清单轮数为 1', reviewRoundCount(legacy) === 1)

// ---------- 2. pendingMajorCount 计数 ----------
check('pendingMajor 只计 pending 的 major', pendingMajorCount(legacy) === 1)
const allResolved = normalizeDesignReviewFindings({
  version: 1, generatedAt: '', reviewRound: 1, model: 'm',
  findings: [
    { 描述: '已修复', 位置: 'a.v:1', 严重度: 'major', 处置: 'fixed' },
    { 描述: '已裁决', 位置: 'a.v:2', 严重度: 'major', 处置: 'waived' }
  ]
})
check('fixed/waived 的 major 不计入 pendingMajor', pendingMajorCount(allResolved) === 0)
check('清单缺失时 pendingMajor 按 0 计', pendingMajorCount(null) === 0 && pendingMajorCount(undefined) === 0)

// ---------- 3. 多轮合并：处置状态跨轮按键保留 ----------
const multiRound = normalizeDesignReviewFindings({
  version: 1,
  generatedAt: '2026-10-09T02:00:00.000Z',
  reviewRound: 2,
  model: 'provider/model-b',
  rounds: [
    {
      model: 'provider/model-a',
      generatedAt: '2026-10-09T00:00:00.000Z',
      findings: [
        { 描述: '问题 A', 位置: 'rtl/a.v:10', 严重度: 'major', 处置: 'pending' },
        { 描述: '问题 B', 位置: 'rtl/b.v:20', 严重度: 'major', 处置: 'pending' }
      ]
    }
  ],
  // 最新一轮（顶层 findings）：A 的描述与位置与首轮完全一致（稳定键相同），仅处置回写为 fixed
  findings: [
    { 描述: '问题 A', 位置: 'rtl/a.v:10', 严重度: 'major', 处置: 'fixed' },
    { 描述: '问题 C', 位置: 'rtl/c.v:30', 严重度: 'major', 处置: 'pending' }
  ]
})
const merged = mergeFindingsAcrossRounds(multiRound)
check('跨轮按键去重后 3 条唯一发现', merged.length === 3, JSON.stringify(merged.map((item) => item.key)))
const mergedA = merged.find((item) => item.位置 === 'rtl/a.v:10')
check('同键处置按最新一轮覆盖（A 已 fixed）', mergedA?.处置 === 'fixed')
check('仅首轮出现的键保留处置（B 仍 pending）', merged.find((item) => item.位置 === 'rtl/b.v:20')?.处置 === 'pending')
check('多轮合并后 pendingMajor=2（B、C）', pendingMajorCount(multiRound) === 2)
check('多轮清单轮数为 2', reviewRoundCount(multiRound) === 2)

// ---------- 4. 稳定键幂等 ----------
const key1 = findingStableKey({ 位置: 'rtl/a.v:10', 描述: '问题 A' })
const key2 = findingStableKey({ 位置: '  rtl/a.v:10  ', 描述: '问题  \n A  ' })
const key3 = findingStableKey({ 位置: 'rtl/a.v:11', 描述: '问题 A' })
check('稳定键幂等（空白折叠归一化）', key1 === key2 && key1.length === 16)
check('位置/描述不同则键不同', key1 !== key3)

// ---------- 5. A2 微架构复杂度分级门禁 ----------
const engine = new PhaseEngine()
const fakeProject = (phase) => ({ currentPhase: phase })
const partitionOf = async (dir) =>
  (await engine.runGateChecks(fakeProject('ARCH'), 'RTL', { workspaceDir: dir })).find((result) => result.checkId === 'module-partition-sane')

const requirementsWith = (count) =>
  `# 产品需求\n\n${Array.from({ length: count }, (_, index) => `REQ-FUNC-${String(index + 1).padStart(3, '0')}：第 ${index + 1} 条规格条款，描述必须足够长以通过文档有效性检查。`).join('\n\n')}\n`
const architectureWithModules = (names) =>
  `# 架构\n\n含 Mermaid 框图：\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n\n## 3. 模块划分\n\n### 3.2 模块列表\n\n| 模块名 | 功能描述 |\n|---|---|\n${names.map((name) => `| ${name} | 功能 |`).join('\n')}\n`

// 5a. 条款数 51（超阈值）+ 无模块列表（模块数无法解析 → 降级不升档，但条款已超档）→ 缺文档应 error
const overClauseDir = join(root, 'over-clause')
mkdirSync(join(overClauseDir, 'docs', '02_requirements'), { recursive: true })
mkdirSync(join(overClauseDir, 'docs', '03_design'), { recursive: true })
writeFileSync(join(overClauseDir, 'docs', '02_requirements', 'product_requirements.md'), requirementsWith(51), 'utf-8')
writeFileSync(join(overClauseDir, 'docs', '03_design', 'architecture.md'), architectureWithModules(['m1', 'm2']), 'utf-8')
const overClause = await partitionOf(overClauseDir)
check(
  '条款数 51 超阈值：缺微架构文档报 error',
  overClause?.passed === false && overClause.severity === 'error' && overClause.message.includes('复杂度超阈值'),
  overClause?.message
)

// 5b. 条款数恰为 50（未超）+ 模块数无法解析 → 降级 info 不升档
const boundaryDir = join(root, 'boundary')
mkdirSync(join(boundaryDir, 'docs', '02_requirements'), { recursive: true })
mkdirSync(join(boundaryDir, 'docs', '03_design'), { recursive: true })
writeFileSync(join(boundaryDir, 'docs', '02_requirements', 'product_requirements.md'), requirementsWith(50), 'utf-8')
writeFileSync(
  join(boundaryDir, 'docs', '03_design', 'architecture.md'),
  '# 架构\n\n\`\`\`mermaid\nflowchart LR\n  A --> B\n\`\`\`\n\n没有模块划分表格的普通设计说明，模块数启发式应识别失败并降级为未超阈值。\n',
  'utf-8'
)
const boundary = await partitionOf(boundaryDir)
check(
  '条款数 50 未超阈值且模块数无法解析 → info 放行',
  boundary?.passed === true && boundary.severity === 'info' && boundary.message.includes('无法解析（按未超阈值处理）'),
  boundary?.message
)

// 5c. 模块数 5（超阈值）+ 条款数未超 → 缺文档应 error
const overModuleDir = join(root, 'over-module')
mkdirSync(join(overModuleDir, 'docs', '02_requirements'), { recursive: true })
mkdirSync(join(overModuleDir, 'docs', '03_design'), { recursive: true })
writeFileSync(join(overModuleDir, 'docs', '02_requirements', 'product_requirements.md'), requirementsWith(10), 'utf-8')
writeFileSync(join(overModuleDir, 'docs', '03_design', 'architecture.md'), architectureWithModules(['m1', 'm2', 'm3', 'm4', 'm5']), 'utf-8')
const overModule = await partitionOf(overModuleDir)
check(
  '模块数 5 超阈值：缺微架构文档报 error',
  overModule?.passed === false && overModule.severity === 'error' && overModule.message.includes('模块数 5'),
  overModule?.message
)

// 5d. 条款数 51 超阈值但微架构文档存在且有效 → 通过（error 级）
writeFileSync(
  join(overClauseDir, 'docs', '03_design', 'microarchitecture.md'),
  '# 微架构\n\n' + '每个非平凡模块的功能描述、状态机（状态+转移条件）、寄存器与边界行为、关键时序关系均在此说明。'.repeat(2) + '\n',
  'utf-8'
)
const overClauseWithDoc = await partitionOf(overClauseDir)
check(
  '超阈值且微架构文档有效 → 通过',
  overClauseWithDoc?.passed === true && overClauseWithDoc.severity === 'error' && overClauseWithDoc.message.includes('复杂度超阈值且微架构文档存在且有效'),
  overClauseWithDoc?.message
)

// ---------- 6. A3 软 review 门禁三态 ----------
const archGateOf = async (dir) =>
  (await engine.runGateChecks(fakeProject('ARCH'), 'RTL', { workspaceDir: dir })).find((result) => result.checkId === 'arch-consistency-review')
const rtlGateOf = async (dir) =>
  (await engine.runGateChecks(fakeProject('RTL'), 'VERIF', { workspaceDir: dir })).find((result) => result.checkId === 'rtl-semantic-review')

// 6a. 缺报告：提示放行（passed + warning），消息给出可操作指引
const noReviewDir = join(root, 'no-review')
mkdirSync(join(noReviewDir, 'docs', '03_design'), { recursive: true })
const noReview = await archGateOf(noReviewDir)
check(
  '缺报告：提示放行且指引 request_design_review',
  noReview?.passed === true && noReview.severity === 'warning' &&
    noReview.message.includes('尚未发起架构一致性 review：请在 ARCH 会话中调用 request_design_review'),
  noReview?.message
)

// 6b. 有 pending major：告警升级（passed=false + warning），不阻断。
// pendingDir 同时是“完整合法 ARCH 工作区”（其余 error 级门禁全过），
// 因此 isBlocked 只能来自软门禁——isBlocked=false 即证明软运行不阻断。
const pendingDir = join(root, 'pending-major')
mkdirSync(join(pendingDir, 'docs', '02_requirements'), { recursive: true })
mkdirSync(join(pendingDir, 'docs', '03_design'), { recursive: true })
writeFileSync(join(pendingDir, 'docs', '02_requirements', 'product_requirements.md'), requirementsWith(2), 'utf-8')
writeFileSync(join(pendingDir, 'docs', '03_design', 'architecture.md'), architectureWithModules(['m1', 'm2']), 'utf-8')
writeFileSync(
  join(pendingDir, 'docs', '03_design', 'interface_spec.md'),
  '# 接口规格\n\n| 信号 | 方向 | 位宽 | 时钟域 |\n|---|---|---|---|\n| i_clk | input | 1 | clk |\n| i_rst_n | input | 1 | clk |\n| o_data | output | 8 | clk |\n\n所有接口信号均在同一时钟域，复位行为与方向说明足够长以通过有效性检查。\n',
  'utf-8'
)
writeFileSync(join(pendingDir, 'docs', '03_design', 'review-arch-consistency.md'), '# 架构一致性 review 报告\n\n审查结论与发现明细。\n', 'utf-8')
writeFileSync(
  join(pendingDir, 'docs', '03_design', 'review-findings.json'),
  JSON.stringify({
    version: 1,
    generatedAt: '2026-10-09T00:00:00.000Z',
    reviewRound: 1,
    model: 'provider/model-a',
    findings: [
      { 描述: 'REQ-FUNC-001 未被架构覆盖', 位置: 'docs/02_requirements/product_requirements.md#REQ-FUNC-001', 严重度: 'major', 处置: 'pending' },
      { 描述: '已修复项', 位置: 'rtl/a.v:1', 严重度: 'major', 处置: 'fixed' },
      { 描述: '轻微问题', 位置: 'rtl/a.v:2', 严重度: 'minor', 处置: 'pending' }
    ]
  }, null, 2),
  'utf-8'
)
const pendingGate = await archGateOf(pendingDir)
check(
  '有 pending major：告警升级且不阻断',
  pendingGate?.passed === false && pendingGate.severity === 'warning' &&
    pendingGate.message.includes('1 条 major 发现待处置（修复或裁决 waived）') &&
    pendingGate.message.includes('不阻断流转'),
  pendingGate?.message
)
const pendingAll = await engine.runGateChecks(fakeProject('ARCH'), 'RTL', { workspaceDir: pendingDir })
check('软门禁失败不阻断（isBlocked=false）', engine.isBlocked(pendingAll) === false)

// 6c. 通过：报告存在且 pending major 为 0；单轮记录追加交叉 review 建议
writeFileSync(
  join(pendingDir, 'docs', '03_design', 'review-findings.json'),
  JSON.stringify({
    version: 1,
    generatedAt: '2026-10-09T01:00:00.000Z',
    reviewRound: 1,
    model: 'provider/model-a',
    findings: [
      { 描述: 'REQ-FUNC-001 未被架构覆盖', 位置: 'docs/02_requirements/product_requirements.md#REQ-FUNC-001', 严重度: 'major', 处置: 'waived' },
      { 描述: '轻微问题', 位置: 'rtl/a.v:2', 严重度: 'minor', 处置: 'pending' }
    ]
  }, null, 2),
  'utf-8'
)
const passedGate = await archGateOf(pendingDir)
check(
  '通过：pending major 0 条且追加交叉 review 建议',
  passedGate?.passed === true && passedGate.severity === 'warning' &&
    passedGate.message.includes('pending major 0 条') && passedGate.message.includes('建议切换模型再发起一轮独立 review'),
  passedGate?.message
)

// 6d. RTL 侧语义 review 门禁对称（清单路径 rtlqa/review/，缺证据提示放行）
const rtlReviewDir = join(root, 'rtl-review')
mkdirSync(join(rtlReviewDir, 'rtlqa', 'review'), { recursive: true })
const rtlNoReview = await rtlGateOf(rtlReviewDir)
check(
  'RTL 语义 review 缺报告：提示放行且指引 request_design_review',
  rtlNoReview?.passed === true && rtlNoReview.severity === 'warning' &&
    rtlNoReview.message.includes('尚未发起语义一致性 review：请在 RTL 会话中调用 request_design_review'),
  rtlNoReview?.message
)
writeFileSync(join(rtlReviewDir, 'rtlqa', 'review', 'semantic-review.md'), '# 语义一致性 review 报告\n\n静态阅读审查结论。\n', 'utf-8')
writeFileSync(
  join(rtlReviewDir, 'rtlqa', 'review', 'review-findings.json'),
  JSON.stringify({
    version: 1,
    generatedAt: '2026-10-09T00:00:00.000Z',
    reviewRound: 1,
    model: 'provider/model-c',
    findings: [{ 描述: '状态机转移条件与文档不符', 位置: 'rtl/ctrl.v:88', 严重度: 'major', 处置: 'pending' }]
  }, null, 2),
  'utf-8'
)
const rtlPending = await rtlGateOf(rtlReviewDir)
check('RTL 语义 review 有 pending major 时告警', rtlPending?.passed === false && rtlPending.message.includes('1 条 major 发现待处置（修复或裁决 waived）'), rtlPending?.message)
check('ARCH/RTL 清单路径常量符合设计文档', ARCH_REVIEW_FINDINGS_PATH === 'docs/03_design/review-findings.json' && RTL_REVIEW_FINDINGS_PATH === 'rtlqa/review/review-findings.json')

rmSync(root, { recursive: true, force: true })
console.log('')
console.log(failures === 0 ? '✅ 设计评审门禁冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
