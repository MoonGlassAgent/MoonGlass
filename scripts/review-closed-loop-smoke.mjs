// review-update 闭环 smoke（BOARD-AND-REVIEW-CLOSED-LOOP-ZH-CN.md §3 片 A）：
//  1) settle 正常 → 闭环经 deliver 投递跟进消息：含审查报告路径 / 发现清单路径 / pending major
//     计数，且明确「处置结论必须逐条回写到发现清单的「处置」字段」三态处置指令；
//  2) 处置写回后 pendingMajor 下降并触发阶段门禁自动重跑（rerunGate 注入出口被调用），
//     通过 → 'converged'；未通过 → 'gate-blocked'；budget 收敛清零；
//  3) 处置后仍有 pending major → 'redispatched'（redispatchReview 以当前轮+1 再派一轮）；
//     跨实例共享 budget，第 3 轮仍未清零 → 'paused-human'（emitPausedHuman 附清单），不再再派；
//  4) 原会话关闭 → deliver 返回 skipped-source-gone → 派生更新会话接管（dispatchUpdateSession
//     注入出口），闭环继续轮询至收敛；处置途中关闭同样派生（每实例至多一次）；
//  5) 防重：同一 review 请求（newlyConsumed=false）整个闭环不启动，不投递/不派生/不重跑门禁；
//  6) 忙碌重试（在线一律回原会话）与投递超时 'delivery-timeout' 降级；
//  7) 闭环再派发的请求登记 appendDesignReviewRequestRecord：原子落盘 / 幂等去重 / 可被 consumed
//     防重闸消费 / origin 留痕；
//  8) 结构断言：派发链 → resumeAfterDesignReview（活跃守卫）→ runReviewUpdateLoopInstance →
//     runReviewUpdateClosedLoop / dispatchReviewUpdateSession（phase-<phase>--review-update-<type>）
//     / redispatchDesignReviewRound 的源码接入点。
// 全部出口注入假实现（假派发/假发送器/假时钟），不真起 pi。
// 与 design-review-followup-smoke 同模式：从源码按配对扫描提取函数，拼装临时 TS 模块直接执行。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { register } from 'node:module'

register('./ts-alias-hooks.mjs', import.meta.url)

const agentSource = readFileSync(join(process.cwd(), 'src', 'main', 'services', 'AgentService.ts'), 'utf-8')

/** 从函数声明起点提取整个函数体（与 design-review-followup-smoke 同实现）。 */
function extractFunction(source, declaration) {
  const start = source.indexOf(declaration)
  if (start < 0) throw new Error(`源码中未找到：${declaration}`)
  let depth = 0
  let parenClose = -1
  for (let index = source.indexOf('(', start); index < source.length; index++) {
    if (source[index] === '(') depth++
    else if (source[index] === ')') {
      depth--
      if (depth === 0) { parenClose = index; break }
    }
  }
  if (parenClose < 0) throw new Error(`${declaration} 圆括号不配对`)
  const bodyStart = source.indexOf('{', parenClose)
  depth = 0
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++
    else if (source[index] === '}') {
      depth--
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`${declaration} 花括号不配对`)
}

/** 单行声明提取（到行尾）。 */
function extractLine(source, declaration) {
  const start = source.indexOf(declaration)
  if (start < 0) throw new Error(`源码中未找到：${declaration}`)
  const end = source.indexOf('\n', start)
  return source.slice(start, end === -1 ? undefined : end)
}

const moduleDir = mkdtempSync(join(tmpdir(), 'moonglass-review-closed-loop-'))

// ---- 主进程侧模块级纯函数 + design-review.ts 数据层直链（与 followup smoke 同拼装法）----
const designReviewUrl = pathToFileURL(join(process.cwd(), 'src', 'main', 'services', 'design-review.ts')).href
const mainModule = join(moduleDir, 'review-closed-loop.ts')
writeFileSync(mainModule, `import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mergeFindingsAcrossRounds, pendingMajorCount, readDesignReviewFindings } from '${designReviewUrl}'

export ${extractLine(agentSource, 'const REVIEW_UPDATE_MAX_EXTRA_ROUNDS =')}

${extractLine(agentSource, 'const DESIGN_REVIEW_REQUEST_REL_PATH =')}

${extractFunction(agentSource, 'function readDesignReviewRequestRecords(')}

${extractFunction(agentSource, 'function writeDesignReviewRequestRecords(')}

${extractFunction(agentSource, 'export function markDesignReviewRequestConsumed(')}

${extractFunction(agentSource, 'export function appendDesignReviewRequestRecord(')}

${extractFunction(agentSource, 'export function runDesignReviewFollowUp(')}

${extractFunction(agentSource, 'export async function runReviewUpdateClosedLoop(')}
`, 'utf-8')
const {
  REVIEW_UPDATE_MAX_EXTRA_ROUNDS,
  markDesignReviewRequestConsumed,
  appendDesignReviewRequestRecord,
  runDesignReviewFollowUp,
  runReviewUpdateClosedLoop
} = await import(pathToFileURL(mainModule).href)

assert.equal(REVIEW_UPDATE_MAX_EXTRA_ROUNDS, 2, '闭环再跑预算上限应为 2 轮（§3.3）')

// ---- 测试工具 ----
/** 假时钟：sleep 立即推进 fakeNow（不真等），disposeTimeout 内可跑完整轮询。 */
const makeClock = ({ pollInterval = 1000, disposeTimeout = 10_000 } = {}) => {
  let fakeNow = 0
  return {
    pollInterval,
    disposeTimeout,
    sleep: async (ms) => { fakeNow += ms },
    now: () => fakeNow
  }
}
/** 队列驱动的注入出口：按序返回脚本值，末值常驻。 */
const scripted = (values) => {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}
const rtlReportRel = join('rtlqa', 'review', 'semantic-review.md')
const rtlFindingsRel = join('rtlqa', 'review', 'review-findings.json')
/** 造一份待处置清单：2 条 pending major + 1 条 fixed major → 合并 pendingMajor=2。 */
const seedFindings = (dir) => {
  mkdirSync(dirname(join(dir, rtlFindingsRel)), { recursive: true })
  writeFileSync(join(dir, rtlFindingsRel), JSON.stringify({
    version: 1,
    generatedAt: '2026-11-12T09:00:00.000Z',
    reviewRound: 1,
    model: 'kimi/kimi-k3',
    findings: [
      { 描述: 'FIFO 边界条件与规格不符', 位置: 'rtl/gmac_fifo.v:132', 严重度: 'major', 处置: 'pending' },
      { 描述: '寄存器位宽笔误', 位置: 'rtl/gmac_axil_regs.v:245', 严重度: 'major', 处置: 'pending' },
      { 描述: '注释与实现漂移', 位置: 'rtl/gmac_tx.v:77', 严重度: 'major', 处置: 'fixed' }
    ]
  }), 'utf-8')
}

// ===== 0. 结构断言：闭环接入点（派发链 → 入口守卫 → 实例 → 纯函数出口） =====
const dispatchBody = extractFunction(agentSource, 'private async dispatchDesignReviewSession(')
assert.equal(dispatchBody.split('resumeAfterDesignReview(').length - 1, 1, '派发体内应恰好一处闭环入口调用')
assert.ok(dispatchBody.includes('newlyConsumed = markDesignReviewRequestConsumed('), 'consumed 返回值必须接住作防重闸')
const resumeBody = extractFunction(agentSource, 'private resumeAfterDesignReview(')
for (const marker of ['reviewUpdateLoopsActive', 'runReviewUpdateLoopInstance(', 'newlyConsumed']) {
  assert.ok(resumeBody.includes(marker), `闭环入口缺少关键接入点：${marker}`)
}
const instanceBody = extractFunction(agentSource, 'private async runReviewUpdateLoopInstance(')
for (const marker of [
  'runReviewUpdateClosedLoop(',
  'runDesignReviewFollowUp(',
  "type: 'prompt'",
  'sourceAlive',
  'backgroundSessions',
  'ready',
  'isStreaming',
  'phaseEngine.runGateChecks',
  'dispatchReviewUpdateSession(',
  'redispatchDesignReviewRound('
]) {
  assert.ok(instanceBody.includes(marker), `闭环实例缺少关键接入点：${marker}`)
}
const redispatchBody = extractFunction(agentSource, 'private redispatchDesignReviewRound(')
assert.ok(redispatchBody.includes('appendDesignReviewRequestRecord('), '再派发必须登记当前轮+1 请求')
assert.ok(redispatchBody.includes('dispatchDesignReviewSession('), '再派发必须复用独立审查会话派发链')
const updateDispatchBody = extractFunction(agentSource, 'private dispatchReviewUpdateSession(')
for (const marker of ['--review-update-', 'spawnSession(', 'runReviewUpdateSession(', 'parentSession']) {
  assert.ok(updateDispatchBody.includes(marker), `更新会话派发缺少关键接入点：${marker}`)
}
const updateRunBody = extractFunction(agentSource, 'private async runReviewUpdateSession(')
for (const marker of ['runBatchToSettled(', '「处置」字段', 'fixed', 'waived']) {
  assert.ok(updateRunBody.includes(marker), `更新会话执行体缺少关键契约：${marker}`)
}

// ===== 1. settle 正常 → 跟进消息含报告路径与 pending major；处置归零 → 门禁重跑 → 收敛 =====
{
  const workspace = mkdtempSync(join(tmpdir(), 'moonglass-rcl-converge-'))
  seedFindings(workspace)
  const clock = makeClock()
  const sent = []
  const statuses = []
  let gateCalls = 0
  const budget = { extraRoundsUsed: 0 }
  const outcome = await runReviewUpdateClosedLoop({
    newlyConsumed: true,
    type: 'rtl-semantic',
    round: 1,
    findingsRelPath: rtlFindingsRel,
    budget,
    deliver: () => runDesignReviewFollowUp({
      newlyConsumed: true,
      sourceAlive: true,
      target: { ready: true, isStreaming: false },
      type: 'rtl-semantic',
      round: 1,
      reviewSessionName: 'phase-rtl--review-rtl-semantic',
      model: 'kimi/kimi-k3',
      reportRelPath: rtlReportRel,
      findingsRelPath: rtlFindingsRel,
      workspace,
      send: (message) => { sent.push(message) },
      emitStatus: (message) => { statuses.push(message) }
    }),
    readPendingMajor: scripted([2, 0, 0]), // baseline 2 → 处置写回 → 稳定 0
    isSourceOnline: () => true,
    dispatchUpdateSession: () => assert.fail('在线时不得派生更新会话'),
    redispatchReview: () => assert.fail('已收敛不得再派发 review'),
    rerunGate: async () => { gateCalls += 1; return { passed: true, detail: '阶段门禁重跑通过' } },
    emitPausedHuman: () => assert.fail('收敛路径不得暂停待人'),
    emitStatus: (message) => { statuses.push(message) },
    sleep: clock.sleep,
    now: clock.now,
    pollIntervalMs: clock.pollInterval,
    disposeTimeoutMs: clock.disposeTimeout
  })
  assert.equal(outcome, 'converged')
  assert.equal(sent.length, 1, '闭环应恰好投递一条跟进消息')
  const followUp = sent[0]
  assert.ok(followUp.includes('rtlqa/review/semantic-review.md'), '跟进消息应含审查报告路径')
  assert.ok(followUp.includes('rtlqa/review/review-findings.json'), '跟进消息应含发现清单路径')
  assert.ok(followUp.includes('pending major 2'), '跟进消息应含 pending major 计数（合并口径）')
  assert.ok(followUp.includes('逐项处置'), '跟进消息应要求逐条处置')
  assert.ok(followUp.includes('处置结论回写到发现清单的「处置」字段'), '跟进消息应明确处置必须写回清单「处置」字段（拍②）')
  assert.equal(gateCalls, 1, 'pendingMajor 归零必须触发阶段门禁自动重跑')
  assert.equal(budget.extraRoundsUsed, 0, '收敛后预算清零')
  assert.ok(statuses.some((m) => m.includes('闭环收敛')), '收敛应落状态消息')
}

// ===== 2. 处置后仍有 pending major → 再派一轮（当前轮+1），门禁不重跑 =====
{
  const clock = makeClock()
  const redispatched = []
  let gateCalls = 0
  const budget = { extraRoundsUsed: 0 }
  const outcome = await runReviewUpdateClosedLoop({
    newlyConsumed: true,
    type: 'rtl-semantic',
    round: 1,
    findingsRelPath: rtlFindingsRel,
    budget,
    deliver: () => 'delivered',
    readPendingMajor: scripted([2, 1, 1]), // 处置 1 条后稳定 1（未清零）
    isSourceOnline: () => true,
    dispatchUpdateSession: () => assert.fail('原会话在线不得派生更新会话'),
    redispatchReview: (nextRound) => { redispatched.push(nextRound) },
    rerunGate: async () => { gateCalls += 1; return { passed: true, detail: 'x' } },
    emitPausedHuman: () => assert.fail('预算内不得暂停待人'),
    emitStatus: () => {},
    sleep: clock.sleep,
    now: clock.now,
    pollIntervalMs: clock.pollInterval,
    disposeTimeoutMs: clock.disposeTimeout
  })
  assert.equal(outcome, 'redispatched')
  assert.deepEqual(redispatched, [2], '再派发轮应为当前轮+1')
  assert.equal(gateCalls, 0, '未清零不得重跑门禁')
  assert.equal(budget.extraRoundsUsed, 1, '再跑预算应记 1 轮')
}

// ===== 3. 最多 2 轮仍未清零 → 暂停待人（附清单），不无限循环 =====
{
  const clock = makeClock()
  const redispatched = []
  let pausedCalls = 0
  let gateCalls = 0
  const budget = { extraRoundsUsed: 0 }
  const runInstance = async (round, pendingScript) => runReviewUpdateClosedLoop({
    newlyConsumed: true,
    type: 'rtl-semantic',
    round,
    findingsRelPath: rtlFindingsRel,
    budget,
    deliver: () => 'delivered',
    readPendingMajor: scripted(pendingScript),
    isSourceOnline: () => true,
    dispatchUpdateSession: () => assert.fail('原会话在线不得派生更新会话'),
    redispatchReview: (nextRound) => { redispatched.push(nextRound) },
    rerunGate: async () => { gateCalls += 1; return { passed: true, detail: 'x' } },
    emitPausedHuman: () => { pausedCalls += 1 },
    emitStatus: () => {},
    sleep: clock.sleep,
    now: clock.now,
    pollIntervalMs: clock.pollInterval,
    disposeTimeoutMs: clock.disposeTimeout
  })
  // 实例 1（第 1 轮 settle）：处置后仍 1 条 → 再派第 2 轮
  assert.equal(await runInstance(1, [2, 1, 1]), 'redispatched')
  // 实例 2（第 2 轮 settle）：新 major 出现，稳定 2 条 → 再派第 3 轮
  assert.equal(await runInstance(2, [1, 2, 2]), 'redispatched')
  assert.equal(budget.extraRoundsUsed, 2, '两实例共享预算（跨实例持久）')
  // 实例 3（第 3 轮 settle）：仍 2 条 → 预算耗尽 → 暂停待人
  assert.equal(await runInstance(3, [2, 2, 2]), 'paused-human')
  assert.deepEqual(redispatched, [2, 3], '恰好再派 2 轮，第 3 次未清零不得再派')
  assert.equal(pausedCalls, 1, '暂停待人出口应恰好调用一次（附清单由实现方组织）')
  assert.equal(gateCalls, 0, '未清零全程不得重跑门禁')
  assert.equal(budget.extraRoundsUsed, 3, '超预算轮数也计数（>2），待人处置后新收敛才清零')
}

// ===== 4. 原会话关闭 → 派生更新会话接管处置（拍③），闭环继续轮询至收敛 =====
{
  const workspace = mkdtempSync(join(tmpdir(), 'moonglass-rcl-source-gone-'))
  seedFindings(workspace)
  const clock = makeClock()
  const sent = []
  let dispatchCalls = 0
  let onlineChecks = 0
  let gateCalls = 0
  const outcome = await runReviewUpdateClosedLoop({
    newlyConsumed: true,
    type: 'rtl-semantic',
    round: 1,
    findingsRelPath: rtlFindingsRel,
    budget: { extraRoundsUsed: 0 },
    deliver: () => runDesignReviewFollowUp({
      newlyConsumed: true,
      sourceAlive: false,
      target: null,
      type: 'rtl-semantic',
      round: 1,
      reviewSessionName: 'phase-rtl--review-rtl-semantic',
      model: 'kimi/kimi-k3',
      reportRelPath: rtlReportRel,
      findingsRelPath: rtlFindingsRel,
      workspace,
      send: (message) => { sent.push(message) },
      emitStatus: () => {}
    }),
    readPendingMajor: scripted([2, 0, 0]), // 更新会话接管后处置归零
    isSourceOnline: () => { onlineChecks += 1; return false },
    dispatchUpdateSession: () => { dispatchCalls += 1 },
    redispatchReview: () => assert.fail('更新会话接管后收敛不得再派发 review'),
    rerunGate: async () => { gateCalls += 1; return { passed: true, detail: '阶段门禁重跑通过' } },
    emitPausedHuman: () => assert.fail('收敛路径不得暂停待人'),
    emitStatus: () => {},
    sleep: clock.sleep,
    now: clock.now,
    pollIntervalMs: clock.pollInterval,
    disposeTimeoutMs: clock.disposeTimeout
  })
  assert.equal(outcome, 'converged')
  assert.equal(sent.length, 0, '原会话不在线不得向原会话投递')
  assert.equal(dispatchCalls, 1, '原会话关闭应恰好派生一次更新会话（phase-<phase>--review-update-<type>）')
  assert.equal(onlineChecks, 0, '已派生更新会话后不再重复检测原会话在线')
  assert.equal(gateCalls, 1, '更新会话处置归零后同样触发门禁重跑')
}

// ===== 5. 处置途中原会话关闭 → 派生更新会话接管（每实例至多一次） =====
{
  const clock = makeClock()
  let dispatchCalls = 0
  let onlineChecks = 0
  let gateCalls = 0
  const outcome = await runReviewUpdateClosedLoop({
    newlyConsumed: true,
    type: 'arch-consistency',
    round: 2,
    findingsRelPath: join('docs', '03_design', 'review-findings.json'),
    budget: { extraRoundsUsed: 0 },
    deliver: () => 'delivered',
    readPendingMajor: scripted([1, 0, 0]),
    isSourceOnline: () => { onlineChecks += 1; return false }, // 处置途中掉线
    dispatchUpdateSession: () => { dispatchCalls += 1 },
    redispatchReview: () => assert.fail('接管后收敛不得再派发 review'),
    rerunGate: async () => { gateCalls += 1; return { passed: true, detail: 'x' } },
    emitPausedHuman: () => assert.fail('收敛路径不得暂停待人'),
    emitStatus: () => {},
    sleep: clock.sleep,
    now: clock.now,
    pollIntervalMs: clock.pollInterval,
    disposeTimeoutMs: clock.disposeTimeout
  })
  assert.equal(outcome, 'converged')
  assert.equal(dispatchCalls, 1, '处置途中关闭应恰好派生一次更新会话')
  assert.equal(onlineChecks, 1, '掉线检测应在首次轮询命中，派生后不再检测')
  assert.equal(gateCalls, 1)
}

// ===== 6. 防重：同一 review 请求（consumed 非新写入）整个闭环不启动 =====
{
  let deliverCalls = 0
  let dispatchCalls = 0
  let redispatchCalls = 0
  let gateCalls = 0
  let pausedCalls = 0
  const outcome = await runReviewUpdateClosedLoop({
    newlyConsumed: false,
    type: 'rtl-semantic',
    round: 1,
    findingsRelPath: rtlFindingsRel,
    budget: { extraRoundsUsed: 0 },
    deliver: () => { deliverCalls += 1; return 'delivered' },
    readPendingMajor: () => 9,
    isSourceOnline: () => true,
    dispatchUpdateSession: () => { dispatchCalls += 1 },
    redispatchReview: () => { redispatchCalls += 1 },
    rerunGate: async () => { gateCalls += 1; return { passed: true, detail: 'x' } },
    emitPausedHuman: () => { pausedCalls += 1 },
    emitStatus: () => {},
    sleep: async () => {}
  })
  assert.equal(outcome, 'skipped-not-consumed', 'consumed 闸未过不得启动闭环')
  assert.equal(deliverCalls + dispatchCalls + redispatchCalls + gateCalls + pausedCalls, 0, '防重闸未过时任何出口都不得触发')
}

// ===== 7. 门禁重跑未通过 → gate-blocked（待人按门禁结果处置），预算不清零 =====
{
  const clock = makeClock()
  const budget = { extraRoundsUsed: 0 }
  const outcome = await runReviewUpdateClosedLoop({
    newlyConsumed: true,
    type: 'rtl-semantic',
    round: 1,
    findingsRelPath: rtlFindingsRel,
    budget,
    deliver: () => 'delivered',
    readPendingMajor: scripted([2, 0, 0]),
    isSourceOnline: () => true,
    dispatchUpdateSession: () => assert.fail('在线时不得派生更新会话'),
    redispatchReview: () => assert.fail('已清零不得再派发 review'),
    rerunGate: async () => ({ passed: false, detail: '门禁失败 1 项：verible-lint' }),
    emitPausedHuman: () => assert.fail('gate-blocked 与 paused-human 语义不同'),
    emitStatus: () => {},
    sleep: clock.sleep,
    now: clock.now,
    pollIntervalMs: clock.pollInterval,
    disposeTimeoutMs: clock.disposeTimeout
  })
  assert.equal(outcome, 'gate-blocked')
  assert.equal(budget.extraRoundsUsed, 0, 'gate-blocked 不视为收敛，预算保持')
}

// ===== 8. 原会话忙碌 → 在线一律回原会话：轮询重试后送达；持续忙碌 → delivery-timeout =====
{
  const clock = makeClock()
  let deliverCalls = 0
  let gateCalls = 0
  const busyThenDeliver = scripted(['skipped-source-busy', 'skipped-source-busy', 'delivered'])
  const outcome = await runReviewUpdateClosedLoop({
    newlyConsumed: true,
    type: 'rtl-semantic',
    round: 1,
    findingsRelPath: rtlFindingsRel,
    budget: { extraRoundsUsed: 0 },
    deliver: () => { deliverCalls += 1; return busyThenDeliver() },
    readPendingMajor: scripted([0]), // 跟进送达时清单已无待处置 → 直接收敛
    isSourceOnline: () => true,
    dispatchUpdateSession: () => assert.fail('忙碌不等于关闭，不得派生更新会话'),
    redispatchReview: () => assert.fail('收敛后不得再派发 review'),
    rerunGate: async () => { gateCalls += 1; return { passed: true, detail: 'x' } },
    emitPausedHuman: () => assert.fail('收敛路径不得暂停待人'),
    emitStatus: () => {},
    sleep: clock.sleep,
    now: clock.now,
    pollIntervalMs: clock.pollInterval,
    disposeTimeoutMs: clock.disposeTimeout
  })
  assert.equal(outcome, 'converged')
  assert.equal(deliverCalls, 3, '忙碌应轮询重试直至送达（每轮询粒度重投一次）')
  assert.equal(gateCalls, 1)
}
{
  const clock = makeClock({ pollInterval: 1000, disposeTimeout: 5000 })
  let deliverCalls = 0
  let statusCount = 0
  const outcome = await runReviewUpdateClosedLoop({
    newlyConsumed: true,
    type: 'rtl-semantic',
    round: 1,
    findingsRelPath: rtlFindingsRel,
    budget: { extraRoundsUsed: 0 },
    deliver: () => { deliverCalls += 1; return 'skipped-source-busy' },
    readPendingMajor: () => assert.fail('投递超时不得进入处置轮询'),
    isSourceOnline: () => true,
    dispatchUpdateSession: () => assert.fail('忙碌不等于关闭，不得派生更新会话'),
    redispatchReview: () => assert.fail('投递超时不得再派发 review'),
    rerunGate: async () => assert.fail('投递超时不得重跑门禁'),
    emitPausedHuman: () => assert.fail('投递超时不是 paused-human'),
    emitStatus: () => { statusCount += 1 },
    sleep: clock.sleep,
    now: clock.now,
    pollIntervalMs: clock.pollInterval,
    disposeTimeoutMs: clock.disposeTimeout
  })
  assert.equal(outcome, 'delivery-timeout')
  assert.ok(deliverCalls >= 5, '超时预算内应持续重试投递')
  assert.ok(statusCount >= 1, '投递超时应落状态消息留痕')
}

// ===== 9. 再派发请求登记：原子落盘 / 幂等去重 / 可被 consumed 闸消费 / origin 留痕 =====
{
  const workspace = mkdtempSync(join(tmpdir(), 'moonglass-rcl-ledger-'))
  const requestPath = join(workspace, 'reports', 'review-request.json')
  const readRequests = () => JSON.parse(readFileSync(requestPath, 'utf-8'))
  const first = appendDesignReviewRequestRecord(workspace, 'rtl-semantic', '  重点看 FIFO 边界  ', 2)
  assert.equal(first.deduplicated, false)
  assert.equal(first.record.type, 'rtl-semantic')
  assert.equal(first.record.scope, '重点看 FIFO 边界', 'scope 应裁剪空白')
  assert.equal(first.record.round, 2, 'round 由闭环显式给定（当前轮+1）')
  assert.equal(first.record.origin, 'review-update-closed-loop', '闭环派生请求应留痕 origin')
  assert.ok(first.record.requestedAt, '应有 requestedAt')
  assert.equal(readRequests().requests.length, 1)
  // 同类型未消费请求存在 → 幂等去重，不重复追加
  const again = appendDesignReviewRequestRecord(workspace, 'rtl-semantic', '别的 scope', 3)
  assert.equal(again.deduplicated, true)
  assert.equal(again.record.scope, '重点看 FIFO 边界', '去重返回既有记录，scope 不被覆盖')
  assert.equal(readRequests().requests.length, 1, '去重不得重复追加')
  // 闭环登记的请求与工具登记同账本：可被 consumed 防重闸消费
  const consumed = markDesignReviewRequestConsumed(workspace, 'rtl-semantic', { sessionName: 'phase-rtl--review-rtl-semantic-2', model: 'm2', settledAt: '2026-11-12T10:00:00.000Z' })
  assert.equal(consumed, true, '闭环登记请求必须能被 consumed 闸消费（同请求只续跑一次）')
  assert.equal(readRequests().requests.filter((item) => item.consumed === true).length, 1)
  // 消费后可登记下一轮
  const second = appendDesignReviewRequestRecord(workspace, 'rtl-semantic', '', 3)
  assert.equal(second.deduplicated, false)
  assert.equal(second.record.round, 3)
  assert.equal('scope' in second.record, false, '空 scope 不写 scope 字段')
  assert.equal(readRequests().requests.length, 2)
}

console.log('[review-closed-loop-smoke] OK')
