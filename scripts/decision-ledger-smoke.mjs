// VERIF-RUN-LOOP 批 3（设计文档 §3.2/§3.3/§9.2）：决策账本纯函数核心的
// schema 归一化与 ≤100 截断、规则自动记账（rule-auto/executed）、双源登记读取
// （LLM proposed / 工程师 user-instruction 直接 approved）、decide 状态迁移
// （approved 可覆盖 prompt / rejected / 非 proposed 拒绝）、合法性校验各拒绝分支
// （停止条件/期望产出/prompt 长度/rationale 长度/derived 白名单/custom actionId/
// 拍数/token/墙钟预算）、执行后 outcome 回填、升级 settle 的新提案集合、
// pi 工具事件提取。与 verif-run-loop-smoke 同模式：node:module 注册别名钩子后动态 import TS 源码。
import assert from 'node:assert/strict'
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')

const {
  DECISION_ID_PATTERN,
  DECISION_LEDGER_LIMIT,
  DECISION_PROMPT_MAX,
  DECISION_RATIONALE_MAX,
  appendRunLoopRuleDecision,
  decisionLedgerPath,
  extractRunLoopDecisionProposal,
  findNewProposedDecisions,
  markDecisionStatus,
  nextRunnableDecision,
  readDecisionLedger,
  recordDecisionOutcome,
  updateDecisionLedger,
  validateDecisionForApproval,
  writeDecisionLedger
} = await import('../src/main/services/decision-ledger.ts')
const { VERIFICATION_DERIVED_ACTION_IDS } = await import('../src/shared/verification-guidance.ts')
const { createRunLoopLedger, resolveRunLoopStartOptions } = await import('../src/main/services/verif-run-loop.ts')

const dir = mkdtempSync(join(tmpdir(), 'moonglass-decision-ledger-'))
const workspace = join(dir, 'ws')
mkdirSync(join(workspace, 'verification', 'results'), { recursive: true })
const readLedgerFile = () => JSON.parse(readFileSync(decisionLedgerPath(workspace), 'utf-8'))

/** 造一条决策记录（字段与 pi 工具 propose_run_decision 落盘口径一致） */
const makeDecision = (overrides = {}) => ({
  id: 'DEC-AAAAAAAA',
  createdAt: '2026-09-29T00:00:00.000Z',
  source: 'llm',
  trigger: 'rule-stall',
  action: {
    kind: 'custom',
    actionId: null,
    prompt: '读取失败日志并归因',
    expectedOutput: '根因假设登记到 root-causes.json',
    stopCriteria: '登记完成或证据不足说明'
  },
  rationale: '规则空转，需要人工方向的替代排查路径',
  evidenceRefs: ['verification/results/diagnostic-control.json'],
  status: 'proposed',
  outcome: null,
  ...overrides
})

// ── A. 账本读写：归一化、原子写、≤100 截断 ──

// A1. 无文件 → null；空 decisions → { version: 1, decisions: [] }
assert.equal(readDecisionLedger(workspace), null)
const empty = updateDecisionLedger(workspace, () => {})
assert.deepEqual(empty, { version: 1, decisions: [] })

// A2. 缺字段/未知值归一：未知 status → rejected，未知 source → rule，outcome 非法 → null
writeDecisionLedger(workspace, { version: 1, decisions: [
  makeDecision({ id: 'DEC-00000001', status: 'bogus', source: 'alien', outcome: 'meh', action: 'nope' }),
  makeDecision({ id: 'DEC-00000002', status: 'executed', outcome: 'advanced', rationale: 42, evidenceRefs: 'x' }),
  'garbage',
  null
] })
const normalized = readDecisionLedger(workspace)
assert.equal(normalized.decisions.length, 2)
assert.equal(normalized.decisions[0].status, 'rejected')
assert.equal(normalized.decisions[0].source, 'rule')
assert.equal(normalized.decisions[0].outcome, null)
assert.equal(normalized.decisions[0].action.kind, 'derived') // 非法 action 归一默认形态
assert.equal(normalized.decisions[0].action.actionId, null)
assert.equal(normalized.decisions[1].outcome, 'advanced')
assert.equal(normalized.decisions[1].rationale, '42')
assert.deepEqual(normalized.decisions[1].evidenceRefs, [])

// A3. 截断：写入 120 条（新在前）→ 读取只保留前 100
const many = Array.from({ length: 120 }, (_, index) => makeDecision({ id: `DEC-${String(index).padStart(8, '0')}` }))
writeDecisionLedger(workspace, { version: 1, decisions: many })
assert.equal(readDecisionLedger(workspace).decisions.length, DECISION_LEDGER_LIMIT)
assert.equal(DECISION_LEDGER_LIMIT, 100)
// update 追加也强制截断
updateDecisionLedger(workspace, (ledger) => {
  ledger.decisions = [...ledger.decisions, ...many]
})
assert.equal(readLedgerFile().decisions.length, DECISION_LEDGER_LIMIT)

// ── B. 规则层自动决策记账（§4.2：source='rule'/trigger='rule-auto'/status='executed'）──

const ruleRecord = appendRunLoopRuleDecision(workspace, {
  actionId: 'fix-regressions',
  prompt: '读取失败回归的日志并修复',
  rationale: '回归失败修复（规则自动）'
})
assert.ok(DECISION_ID_PATTERN.test(ruleRecord.id), `规则决策 id 形态非法: ${ruleRecord.id}`)
assert.equal(ruleRecord.source, 'rule')
assert.equal(ruleRecord.trigger, 'rule-auto')
assert.equal(ruleRecord.status, 'executed')
assert.equal(ruleRecord.outcome, null)
assert.equal(ruleRecord.action.kind, 'derived')
assert.equal(ruleRecord.action.actionId, 'fix-regressions')
assert.equal(readLedgerFile().decisions[0].id, ruleRecord.id) // 新在前

// B1. id 唯一：连续登记不撞号
const second = appendRunLoopRuleDecision(workspace, { actionId: 'run-batch', prompt: 'p' })
assert.notEqual(second.id, ruleRecord.id)

// B2. 执行后 outcome 回填（拍判定 advanced/no-progress；会话异常 failed）
recordDecisionOutcome(workspace, ruleRecord.id, 'advanced')
recordDecisionOutcome(workspace, second.id, 'no-progress')
const afterOutcomes = readDecisionLedger(workspace)
assert.equal(afterOutcomes.decisions.find((item) => item.id === ruleRecord.id).outcome, 'advanced')
assert.equal(afterOutcomes.decisions.find((item) => item.id === second.id).outcome, 'no-progress')
recordDecisionOutcome(workspace, 'DEC-NOTEXIST', 'failed') // 不存在：静默跳过
// 回填后不再是可执行决策（outcome 非 null）
assert.equal(nextRunnableDecision(workspace)?.id === ruleRecord.id, false)

// ── C. 双源登记读取：LLM proposed 待人审 / 工程师 user-instruction 直接 approved ──

// C1. 模拟 pi 工具落盘的 LLM 提案（bridge 同 schema）：status='proposed'
const llmProposal = makeDecision({ id: 'DEC-LLM00001', status: 'proposed', source: 'llm', trigger: 'rule-stall' })
// C2. 模拟工程师指令登记：trigger='user-instruction' → source='human' 且直接 approved
const humanDecision = makeDecision({ id: 'DEC-HUM00001', status: 'approved', source: 'human', trigger: 'user-instruction', rationale: '工程师：先补 checker 再回归' })
writeDecisionLedger(workspace, { version: 1, decisions: [humanDecision, llmProposal] })
const pending = readDecisionLedger(workspace)
assert.equal(pending.decisions[0].status, 'approved') // 工程师决策不审批（§3.3）
assert.equal(pending.decisions[0].source, 'human')
assert.equal(pending.decisions[1].status, 'proposed')
// C3. 下一拍可执行决策：approved 未执行（human）优先于 proposed（proposed 不自动执行，顾问模式）
assert.equal(nextRunnableDecision(workspace).id, 'DEC-HUM00001')
recordDecisionOutcome(workspace, 'DEC-HUM00001', 'advanced')
assert.equal(nextRunnableDecision(workspace), null) // 全部已执行/待审批 → 无

// ── D. decide 状态迁移：approved（可覆盖 prompt）/ rejected / 非 proposed 拒绝 ──

// D1. proposed → approved + editedPrompt 覆盖 action.prompt
const approved = markDecisionStatus(workspace, 'DEC-LLM00001', 'approved', { prompt: '覆盖后的指令' })
assert.equal(approved.status, 'approved')
assert.equal(approved.action.prompt, '覆盖后的指令')
// D2. 非 proposed 不可重复审批 → null
assert.equal(markDecisionStatus(workspace, 'DEC-LLM00001', 'approved'), null)
assert.equal(markDecisionStatus(workspace, 'DEC-HUM00001', 'rejected'), null)
// D3. 不存在的决策 → null
assert.equal(markDecisionStatus(workspace, 'DEC-NOEXIST00', 'approved'), null)
// D4. rejected 迁移
const rejectedLedger = { version: 1, decisions: [makeDecision({ id: 'DEC-REJ00001' })] }
writeDecisionLedger(workspace, rejectedLedger)
const rejected = markDecisionStatus(workspace, 'DEC-REJ00001', 'rejected')
assert.equal(rejected.status, 'rejected')
assert.equal(rejected.outcome, null) // 未执行不填 outcome

// ── E. 合法性校验（§3.2 守门）：各拒绝分支 + 通过分支 ──

const NOW = '2026-09-29T01:00:00.000Z'
const baseOptions = resolveRunLoopStartOptions()
const healthyBudget = createRunLoopLedger(baseOptions, '2026-09-29T00:30:00.000Z', true).budget

// E1. 全合法 → ok（derived 白名单内 / 预算健康）
const goodDerived = makeDecision({
  action: { kind: 'derived', actionId: 'fix-regressions', prompt: 'p', expectedOutput: 'e', stopCriteria: 's' }
})
assert.deepEqual(validateDecisionForApproval(goodDerived, healthyBudget, NOW), { ok: true, reason: '' })

// E2. stopCriteria 为空 → 拒绝
assert.equal(validateDecisionForApproval(makeDecision({ action: { kind: 'custom', actionId: null, prompt: 'p', expectedOutput: 'e', stopCriteria: '  ' } }), healthyBudget, NOW).ok, false)
// E3. expectedOutput 为空 → 拒绝
assert.equal(validateDecisionForApproval(makeDecision({ action: { kind: 'custom', actionId: null, prompt: 'p', expectedOutput: '', stopCriteria: 's' } }), healthyBudget, NOW).ok, false)
// E4. prompt 为空 / 超 4000 字 → 拒绝
assert.equal(validateDecisionForApproval(makeDecision({ action: { kind: 'custom', actionId: null, prompt: '   ', expectedOutput: 'e', stopCriteria: 's' } }), healthyBudget, NOW).ok, false)
const longPrompt = makeDecision({ action: { kind: 'custom', actionId: null, prompt: 'x'.repeat(DECISION_PROMPT_MAX + 1), expectedOutput: 'e', stopCriteria: 's' } })
const longPromptCheck = validateDecisionForApproval(longPrompt, healthyBudget, NOW)
assert.equal(longPromptCheck.ok, false)
assert.ok(longPromptCheck.reason.includes('4000'))
// E5. rationale 超 200 字 → 拒绝
assert.equal(validateDecisionForApproval(makeDecision({ rationale: 'r'.repeat(DECISION_RATIONALE_MAX + 1) }), healthyBudget, NOW).ok, false)
// E6. derived 类 actionId 不在推导内核白名单 → 拒绝（幻觉动作）
const phantom = validateDecisionForApproval(makeDecision({
  action: { kind: 'derived', actionId: 'hack-the-planet', prompt: 'p', expectedOutput: 'e', stopCriteria: 's' }
}), healthyBudget, NOW)
assert.equal(phantom.ok, false)
assert.ok(phantom.reason.includes('白名单'))
assert.ok(VERIFICATION_DERIVED_ACTION_IDS.includes('fix-regressions'))
assert.ok(!VERIFICATION_DERIVED_ACTION_IDS.includes('hack-the-planet'))
// E7. derived 类 actionId 为空 → 拒绝
assert.equal(validateDecisionForApproval(makeDecision({
  action: { kind: 'derived', actionId: null, prompt: 'p', expectedOutput: 'e', stopCriteria: 's' }
}), healthyBudget, NOW).ok, false)
// E8. custom 类 actionId 非 null → 拒绝
assert.equal(validateDecisionForApproval(makeDecision({
  action: { kind: 'custom', actionId: 'fix-regressions', prompt: 'p', expectedOutput: 'e', stopCriteria: 's' }
}), healthyBudget, NOW).ok, false)
// E9. 预算三维度超限 → 拒绝
const beatsOut = createRunLoopLedger(baseOptions, NOW, true)
beatsOut.budget.beats = beatsOut.budget.maxBeats
assert.ok(validateDecisionForApproval(goodDerived, beatsOut.budget, NOW).reason.includes('拍数'))
const tokensOut = createRunLoopLedger(baseOptions, NOW, true)
tokensOut.budget.tokensUsed = tokensOut.budget.maxTokens
assert.ok(validateDecisionForApproval(goodDerived, tokensOut.budget, NOW).reason.includes('token'))
const wallOut = createRunLoopLedger(baseOptions, '2026-09-28T20:00:00.000Z', true)
assert.ok(validateDecisionForApproval(goodDerived, wallOut.budget, NOW).reason.includes('墙钟'))
// E10. 预算账本缺失（null）→ 跳过预算维度，其余照常
assert.equal(validateDecisionForApproval(goodDerived, null, NOW).ok, true)
assert.equal(validateDecisionForApproval(longPrompt, null, NOW).ok, false)

// ── F. 升级 settle 的新提案集合（findNewProposedDecisions）──

const beforeSet = [makeDecision({ id: 'DEC-OLD00001', status: 'proposed' })]
const afterSet = [
  makeDecision({ id: 'DEC-NEW00001' }),                                     // 新 proposed → 命中
  makeDecision({ id: 'DEC-NEW00002', status: 'proposed' }),                 // 新 proposed → 命中
  makeDecision({ id: 'DEC-HUM00002', status: 'approved', source: 'human', trigger: 'user-instruction' }), // 新 approved → 不命中（不算提案）
  makeDecision({ id: 'DEC-OLD00001', status: 'proposed' }),                 // 旧 id → 不重复计数
  makeDecision({ id: 'DEC-EXE00001', status: 'executed' })                  // 非 proposed → 不命中
]
const fresh = findNewProposedDecisions(beforeSet, afterSet)
assert.deepEqual(fresh.map((item) => item.id), ['DEC-NEW00001', 'DEC-NEW00002'])
assert.deepEqual(findNewProposedDecisions([], []), [])

// ── G. pi 工具事件提取（tool_execution_end → 聊天面板可见性）──

const proposalEvent = {
  type: 'tool_execution_end',
  toolName: 'propose_run_decision',
  isError: false,
  result: { details: { record: { id: 'DEC-EVT00001', source: 'llm', trigger: 'rule-stall', status: 'proposed', rationale: '归因完成' } } }
}
assert.deepEqual(extractRunLoopDecisionProposal(proposalEvent), {
  id: 'DEC-EVT00001', source: 'llm', trigger: 'rule-stall', status: 'proposed', rationale: '归因完成'
})
assert.equal(extractRunLoopDecisionProposal({ ...proposalEvent, type: 'tool_execution_start' }), null)
assert.equal(extractRunLoopDecisionProposal({ ...proposalEvent, isError: true }), null)
assert.equal(extractRunLoopDecisionProposal({ ...proposalEvent, toolName: 'record_root_cause' }), null)
assert.equal(extractRunLoopDecisionProposal({ type: 'tool_execution_end', toolName: 'propose_run_decision', isError: false, result: {} }), null)

console.log('decision-ledger-smoke: OK（归一化+截断/rule-auto 记账+outcome 回填/双源登记/decide 迁移/合法性校验九分+通过分支/升级新提案集合/工具事件提取）')
