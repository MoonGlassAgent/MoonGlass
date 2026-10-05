// 验证工作台结论契约（P1）：只读投影的口径守门测试。
// 直接 import 源码 TS（纯函数模块，无外部依赖），不启动 Electron、不触碰任何项目目录。
import assert from 'node:assert/strict'

const { buildVerificationWorkbench, needsVerificationPlanning, workbenchEvidenceRefs } =
  await import('../src/shared/verification-workbench.ts')

const RTL = 'RTL-CURRENT'
const snapshotAt = '2026-10-05T02:00:00.000Z'
const snapshotMs = Date.parse(snapshotAt)
const HIT = 'verification/results/dma/scenario_hits.json'

const clause = (id, status, evidence) => ({
  clauseId: id, parentId: id, text: `${id} 的行为`, status, intentIds: [], scenarioIds: [], evidence, channel: 'simulation'
})

/** 完整可用态势：一条 PASSED（证据为当前 RTL）、一条 FAILED */
const posture = (overrides = {}) => ({
  generatedAt: snapshotAt,
  rtlHash: RTL,
  verificationIntents: [],
  specMapping: { clauseTotal: 2, coveredClause: 1, documentaryCount: 0, clauses: [clause('SPEC-A', 'PASSED', [HIT]), clause('SPEC-B', 'FAILED', [])] },
  closureAssessment: { status: 'NOT_READY', blockers: [], warnings: [], residualRisks: [], nextActions: [], metrics: { impactUnknown: 0 } },
  signoffPackage: { packageId: 'PKG', status: 'NOT_READY', summary: '', blockers: [], warnings: [], evidenceFiles: [HIT], rtlHash: RTL },
  ...overrides
})

const evidenceCurrent = { [HIT]: { exists: true, rtlHash: RTL, modifiedAt: snapshotMs - 60_000 } }

// ── 1. 无数据：明确标记 no-data，且绝不给出就绪结论 ──
const empty = buildVerificationWorkbench({}, RTL, {}, null)
assert.ok(empty.issues.includes('no-data'))
assert.equal(needsVerificationPlanning(empty), true)
assert.equal(empty.signoff.status, 'unknown')

// ── 2. 核心回归：缺闭合评估 + 零 blocker ≠ 就绪 ──
// 这是"界面结论不可信"的直接来源：没有评估却有零阻断记录，旧实现显示"具备签核条件"。
const noAssessment = buildVerificationWorkbench(posture({ closureAssessment: undefined, signoffPackage: undefined }), RTL, evidenceCurrent, 'posture')
assert.equal(noAssessment.signoff.status, 'unknown', '缺评估时只能是未确认，不能用零 blocker 推断就绪')
assert.equal(noAssessment.signoff.blockers.length, 0, '此夹具确实没有阻断记录——正因如此才必须显示未确认')

// ── 3. 记录通过 ≠ 当前有效通过：证据版本落后于当前 RTL ──
const staleEvidence = { [HIT]: { exists: true, rtlHash: 'RTL-OLD', modifiedAt: snapshotMs - 60_000 } }
const stale = buildVerificationWorkbench(posture(), RTL, staleEvidence, 'posture')
assert.equal(stale.clauses.passed, 1, '记录通过仍然保留为历史事实')
assert.equal(stale.clauses.validPassed, 0, '版本过期的通过不得计入当前有效通过')
assert.equal(stale.clauses.needsRevalidation, 1)
assert.equal(stale.evidence.status, 'stale')
assert.ok(stale.issues.includes('evidence-stale'))
assert.equal(stale.signoff.status, 'not-ready')

// ── 4. 态势版本落后于当前 RTL：整体判过期 ──
const staleSnapshot = buildVerificationWorkbench(posture({ rtlHash: 'RTL-OLD' }), RTL, evidenceCurrent, 'posture')
assert.ok(staleSnapshot.issues.includes('snapshot-stale'))
assert.equal(staleSnapshot.clauses.validPassed, 0)
assert.equal(staleSnapshot.signoff.status, 'not-ready')

// ── 5. 证据文件缺失：明确列出缺失引用并判未满足 ──
const missing = buildVerificationWorkbench(posture(), RTL, { [HIT]: { exists: false, rtlHash: null } }, 'posture')
assert.equal(missing.evidence.status, 'missing')
assert.deepEqual(missing.evidence.missing, [HIT])
assert.equal(missing.clauses.validPassed, 0)
assert.equal(missing.signoff.status, 'not-ready')

// ── 6. 有评估 + 证据当前 + 版本一致 → 允许给出"等待人工签核" ──
const ready = buildVerificationWorkbench(posture({
  specMapping: { clauseTotal: 1, coveredClause: 1, documentaryCount: 0, clauses: [clause('SPEC-A', 'PASSED', [HIT])] },
  closureAssessment: { status: 'READY_FOR_HUMAN_SIGNOFF', blockers: [], warnings: [], residualRisks: [], nextActions: [], metrics: { impactUnknown: 0 } },
  signoffPackage: { packageId: 'PKG', status: 'READY_FOR_HUMAN_SIGNOFF', summary: '', blockers: [], warnings: [], evidenceFiles: [HIT], rtlHash: RTL }
}), RTL, evidenceCurrent, 'posture')
assert.equal(ready.evidence.status, 'current')
assert.equal(ready.clauses.validPassed, 1)
assert.equal(ready.signoff.status, 'review', '有评估且证据当前时才给出等待人工签核')

// ── 7. 尚有失败条款时不得判就绪 ──
const withFailure = buildVerificationWorkbench(posture({
  closureAssessment: { status: 'READY_FOR_HUMAN_SIGNOFF', blockers: [], warnings: [], residualRisks: [], nextActions: [], metrics: { impactUnknown: 0 } },
  signoffPackage: { packageId: 'PKG', status: 'READY_FOR_HUMAN_SIGNOFF', summary: '', blockers: [], warnings: [], evidenceFiles: [HIT], rtlHash: RTL }
}), RTL, evidenceCurrent, 'posture')
assert.equal(withFailure.clauses.failed, 1)
assert.equal(withFailure.signoff.status, 'not-ready', '存在记录失败条款时不得显示就绪')

// ── 8. 分母与明细不一致：标记 mapping-incomplete，并区分两个分支 ──
// 8a 明细少于分母：分母权威（引擎给的条款总数），差额计入"未确认"——不谎报通过，也不丢掉分母
const fewer = buildVerificationWorkbench(posture({ specMapping: { clauseTotal: 9, coveredClause: 1, documentaryCount: 0, clauses: [clause('SPEC-A', 'PASSED', [HIT])] } }), RTL, evidenceCurrent, 'posture')
assert.ok(fewer.issues.includes('mapping-incomplete'))
assert.equal(fewer.clauses.total, 9)
assert.equal(fewer.clauses.unknown, 8, '分母与明细的差额必须计入未确认，不能静默丢弃')
assert.equal(fewer.clauses.validPassed, 1)
// 8b 明细多于分母：分母本身不可信 → 置为未确认而不是给出更小的假分母
const more = buildVerificationWorkbench(posture({ specMapping: { clauseTotal: 1, coveredClause: 1, documentaryCount: 0, clauses: [clause('SPEC-A', 'PASSED', [HIT]), clause('SPEC-B', 'FAILED', [])] } }), RTL, evidenceCurrent, 'posture')
assert.ok(more.issues.includes('mapping-incomplete'))
assert.equal(more.clauses.total, null, '明细多于分母时分母不可信，不得给出假分母')

// ── 9. synthesis 通道不计入 VERIF 分母；文档性条款单列 ──
const channels = buildVerificationWorkbench(posture({
  specMapping: { clauseTotal: 2, coveredClause: 1, documentaryCount: 3, clauses: [
    clause('SPEC-A', 'PASSED', [HIT]),
    { ...clause('SPEC-PPA', 'PASSED', []), channel: 'synthesis' },
    { ...clause('SPEC-DOC', 'PASSED', []), clauseKind: 'documentary' }
  ] }
}), RTL, evidenceCurrent, 'posture')
assert.equal(channels.clauses.synthesis, 1)
assert.equal(channels.clauses.documentary, 3)
assert.equal(channels.clauseDetails.length, 1, 'synthesis 与文档性条款都不进入 VERIF 条款明细')

// ── 10. 证据引用收集：反斜杠归一 + 去重 ──
const refs = workbenchEvidenceRefs({
  specMapping: { clauses: [{ evidence: ['verification\\results\\a\\scenario_hits.json', 'verification/results/a/scenario_hits.json'] }] },
  signoffPackage: { evidenceFiles: ['verification/results/b/result.json'] },
  regressions: [{ resultFile: 'verification/results/c/result.json' }],
  formalResults: [{ resultFile: 'verification/results/d/formal-result.json' }]
})
assert.deepEqual(refs.sort(), [
  'verification/results/a/scenario_hits.json',
  'verification/results/b/result.json',
  'verification/results/c/result.json',
  'verification/results/d/formal-result.json'
])

console.log('verification-workbench-smoke: OK（无数据/缺评估不推断就绪/记录通过vs当前有效通过/态势过期/证据缺失/就绪三态/失败条款阻断/分母对账/通道口径/引用归一）')
