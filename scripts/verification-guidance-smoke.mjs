import { deriveTopRisks, deriveVerificationActions, deriveVerificationSteps } from '../src/renderer/verification-guidance.ts'

const state = {
  criticalOpen: ['SCN-1'],
  verificationIntents: [{ id: 'VI-1', scenarioId: 'SCN-1', objective: '复位期间保持事务一致', sourceIds: ['RISK-1'], status: 'REACHED', priority: 0.9, recommendedMethods: ['simulation'], evidence: [] }],
  specGaps: [],
  coverageHoles: [{ scenarioId: 'SCN-1', classification: 'C4_OBSERVATION_MISSING', reason: '已到达但缺少 Checker', recommendedAction: '补充 Checker', blocking: true }],
  regressions: [{ passed: true, testsTotal: 12, coverage: { line: 92 } }],
  formalResults: []
}

const actions = deriveVerificationActions(state)
if (actions[0]?.id !== 'add-checkers' || actions[0].priority !== 'P0') throw new Error('观察缺失未优先生成 Checker 行动')
const steps = deriveVerificationSteps(state)
if (steps.find((item) => item.id === 'coverage')?.status !== 'blocked') throw new Error('Coverage Hole 未反映为步骤阻断')
const risks = deriveTopRisks(state, [{ id: 'RISK-1', title: 'Reset/Transaction Collision', object: 'dut', features: ['reset', 'response'], riskScore: 0.95, confidence: 'high', source: { file: 'rtl/dut.v', line: 20 } }])
if (risks[0]?.level !== '验证基础设施缺口' || !risks[0].impact.includes('事务')) throw new Error('Top 风险解释不正确')

const failed = { ...state, regressions: [{ passed: false, testsTotal: 12, coverage: {} }] }
if (deriveVerificationActions(failed)[0]?.id !== 'fix-regressions') throw new Error('失败证据没有最高行动优先级')

const closed = { ...state, criticalOpen: [], verificationIntents: [{ ...state.verificationIntents[0], status: 'VERIFIED', evidence: ['result.xml'] }], coverageHoles: [] }
if (deriveVerificationSteps(closed).at(-1)?.status !== 'completed') throw new Error('完整证据未进入签核完成状态')

const supplementalError = { ...closed, formalResults: [{ status: 'ERROR', mode: 'bmc', obligation: 'supplemental', classification: 'C6_FRONTEND_COMPATIBILITY' }] }
if (deriveVerificationSteps(supplementalError).find((item) => item.id === 'formal')?.status === 'blocked') throw new Error('补强 Formal 工具错误不应单独阻断签核')
if (!deriveVerificationActions(supplementalError).some((item) => item.id === 'repair-formal-compatibility')) throw new Error('补强 Formal 工具错误缺少修复行动')

const requiredError = { ...closed, formalResults: [{ status: 'ERROR', mode: 'bmc', obligation: 'required', classification: 'C6_FRONTEND_COMPATIBILITY' }] }
if (deriveVerificationSteps(requiredError).find((item) => item.id === 'formal')?.status !== 'blocked') throw new Error('强制 Formal 工具错误必须阻断')
if (deriveVerificationActions(requiredError)[0]?.id !== 'fix-formal') throw new Error('强制 Formal 工具错误必须成为 P0 行动')

const supplementalFail = { ...closed, formalResults: [{ status: 'FAIL', mode: 'bmc', obligation: 'supplemental' }] }
if (deriveVerificationSteps(supplementalFail).find((item) => item.id === 'formal')?.status !== 'blocked') throw new Error('任何 Formal FAIL 均必须阻断')

console.log('Verification guidance smoke passed: actions, risks, steps')
