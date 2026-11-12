// 设计评审左移（§8）片 B 收尾 smoke：审查会话 settle → 主会话续跑跟进消息。
//  1) settle 正常 → 生成跟进消息：含审查报告路径 / 发现清单路径 / pending major 计数
//     （跨轮合并口径，直接读真实 findings 文件）/ fixed-waived-pending 三态处置指令与门禁说明；
//  2) 审查异常（markDesignReviewRequestError 出口）→ 不生成跟进（复刻派发分支结构 + 源码结构断言）；
//  3) 发起会话已 dispose / 不在线 → 不抛错，降级为状态消息留痕；send 抛错同样降级；
//  4) 防重：同一 review 请求（consumed 已落盘）只续跑一次；新一轮请求可再次续跑；
//  5) 结构断言：runDesignReviewFollowUp 的注入出口（假发送器，不真起 pi）。
// 与 design-review-dispatch-smoke 同模式：从源码按配对扫描提取函数，拼装临时 TS 模块直接执行。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { register } from 'node:module'

register('./ts-alias-hooks.mjs', import.meta.url)

const toolsSource = readFileSync(join(process.cwd(), 'resources', 'moonglass', 'pi-bridge', 'moonglass-tools.ts'), 'utf-8')
const agentSource = readFileSync(join(process.cwd(), 'src', 'main', 'services', 'AgentService.ts'), 'utf-8')

/** 从函数声明起点提取整个函数体（与 design-review-dispatch-smoke 同实现）。 */
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

/** 单行 const 声明提取（到行尾）。 */
function extractLine(source, declaration) {
  const start = source.indexOf(declaration)
  if (start < 0) throw new Error(`源码中未找到：${declaration}`)
  const end = source.indexOf('\n', start)
  return source.slice(start, end === -1 ? undefined : end)
}

const moduleDir = mkdtempSync(join(tmpdir(), 'moonglass-design-review-followup-'))

// ---- 桥接侧（moonglass-tools.ts）：请求登记（防重场景用真实 append 链）----
const bridgeModule = join(moduleDir, 'design-review-bridge.ts')
writeFileSync(bridgeModule, `import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

${extractFunction(toolsSource, 'function writeJsonAtomic(')}

${extractLine(toolsSource, 'const DESIGN_REVIEW_TYPES =')}

${extractFunction(toolsSource, 'function designReviewFindingsRelPath(')}

${extractFunction(toolsSource, 'function readDesignReviewCompletedRounds(')}

${extractFunction(toolsSource, 'export function appendDesignReviewRequest(')}
`, 'utf-8')
const { appendDesignReviewRequest } = await import(pathToFileURL(bridgeModule).href)

// ---- 主进程侧（AgentService.ts 模块级纯函数 + design-review.ts 数据层直链）----
const designReviewUrl = pathToFileURL(join(process.cwd(), 'src', 'main', 'services', 'design-review.ts')).href
const mainModule = join(moduleDir, 'design-review-followup.ts')
writeFileSync(mainModule, `import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mergeFindingsAcrossRounds, pendingMajorCount, readDesignReviewFindings } from '${designReviewUrl}'

${extractLine(agentSource, 'const DESIGN_REVIEW_REQUEST_REL_PATH =')}

${extractFunction(agentSource, 'function readDesignReviewRequestRecords(')}

${extractFunction(agentSource, 'function writeDesignReviewRequestRecords(')}

${extractFunction(agentSource, 'export function markDesignReviewRequestConsumed(')}

${extractFunction(agentSource, 'export function markDesignReviewRequestError(')}

${extractFunction(agentSource, 'export function runDesignReviewFollowUp(')}
`, 'utf-8')
const {
  markDesignReviewRequestConsumed,
  markDesignReviewRequestError,
  runDesignReviewFollowUp
} = await import(pathToFileURL(mainModule).href)

const workspace = mkdtempSync(join(tmpdir(), 'moonglass-design-review-followup-ws-'))
const requestPath = (dir) => join(dir, 'reports', 'review-request.json')
const readRequests = (dir) => JSON.parse(readFileSync(requestPath(dir), 'utf-8'))
const rtlFindingsPath = join(workspace, 'rtlqa', 'review', 'review-findings.json')
const rtlReportRel = join('rtlqa', 'review', 'semantic-review.md')
const rtlFindingsRel = join('rtlqa', 'review', 'review-findings.json')

// 造一份两轮清单：历史轮 major 已 waived（跨轮按键保留，不计 pending），
// 最新轮 3 条（1 major pending + 1 major fixed + 1 minor pending）→ 合并共 4 条、pending major 1
mkdirSync(dirname(rtlFindingsPath), { recursive: true })
writeFileSync(rtlFindingsPath, JSON.stringify({
  version: 1,
  generatedAt: '2026-10-20T09:00:00.000Z',
  reviewRound: 2,
  model: 'kimi/kimi-k3',
  rounds: [
    {
      model: 'deepseek/deepseek-chat',
      generatedAt: '2026-10-19T09:00:00.000Z',
      findings: [
        { 描述: '旧轮已裁决的 major', 位置: 'rtl/gmac_top.v:88', 严重度: 'major', 处置: 'waived' }
      ]
    }
  ],
  findings: [
    { 描述: 'FIFO 边界条件与规格不符', 位置: 'rtl/gmac_fifo.v:132', 严重度: 'major', 处置: 'pending' },
    { 描述: '寄存器位宽笔误', 位置: 'rtl/gmac_axil_regs.v:245', 严重度: 'major', 处置: 'fixed' },
    { 描述: '注释与实现漂移', 位置: 'rtl/gmac_tx.v:77', 严重度: 'minor', 处置: 'pending' }
  ]
}), 'utf-8')

// ===== 0. 派发链结构断言：跟进只在正常 settle 分支调用，且接 consumed 返回值作防重闸 =====
const dispatchBody = extractFunction(agentSource, 'private async dispatchDesignReviewSession(')
assert.equal(dispatchBody.split('resumeAfterDesignReview(').length - 1, 1, '派发体内应恰好一处续跑调用')
assert.ok(
  dispatchBody.indexOf('resumeAfterDesignReview(') > dispatchBody.indexOf('run.watchdogAbort'),
  '续跑调用必须位于 watchdog 熔断分支之后（即正常 settle 分支内），异常分支不得投递'
)
assert.ok(dispatchBody.includes('newlyConsumed = markDesignReviewRequestConsumed('), 'consumed 返回值必须接住作防重闸')
assert.ok(dispatchBody.includes('failRequest(`审查会话异常'), '异常出口应保持不投递（failRequest）')
const resumeBody = extractFunction(agentSource, 'private resumeAfterDesignReview(')
// 闭环入口（BOARD-AND-REVIEW-CLOSED-LOOP §3 片 A）：活跃实例守卫 + 异步闭环实例
for (const marker of ['reviewUpdateLoopsActive', 'runReviewUpdateLoopInstance(', 'newlyConsumed']) {
  assert.ok(resumeBody.includes(marker), `闭环入口缺少关键接入点：${marker}`)
}
// 跟进投递出口已迁入闭环实例（片 A）：原口径断言打在实例方法上
const loopInstanceBody = extractFunction(agentSource, 'private async runReviewUpdateLoopInstance(')
for (const marker of ['runDesignReviewFollowUp(', "type: 'prompt'", 'sourceAlive', 'backgroundSessions', 'ready', 'isStreaming']) {
  assert.ok(loopInstanceBody.includes(marker), `续跑实例缺少关键接入点：${marker}`)
}

// ===== 1. settle 正常 → 生成跟进消息（含路径与 pending major 计数）=====
let sentMessages = []
let statusMessages = []
const fakeSend = (message) => { sentMessages.push(message) }
const fakeStatus = (message) => { statusMessages.push(message) }
const baseInput = {
  newlyConsumed: true,
  sourceAlive: true,
  target: { ready: true, isStreaming: false },
  type: 'rtl-semantic',
  round: 2,
  reviewSessionName: 'phase-rtl--review-rtl-semantic',
  model: 'kimi/kimi-k3',
  reportRelPath: rtlReportRel,
  findingsRelPath: rtlFindingsRel,
  workspace,
  send: fakeSend,
  emitStatus: fakeStatus
}
const delivered = runDesignReviewFollowUp(baseInput)
assert.equal(delivered, 'delivered')
assert.equal(sentMessages.length, 1, '正常 settle 应恰好投递一条跟进消息')
const followUp = sentMessages[0]
assert.ok(followUp.includes('phase-rtl--review-rtl-semantic'), '跟进消息应含审查会话名')
assert.ok(followUp.includes('kimi/kimi-k3'), '跟进消息应含审查模型身份')
assert.ok(followUp.includes('rtlqa/review/semantic-review.md'), '跟进消息应含审查报告路径（正斜杠展示）')
assert.ok(followUp.includes('rtlqa/review/review-findings.json'), '跟进消息应含发现清单路径')
assert.ok(followUp.includes('pending major 1'), 'pending major 计数应为跨轮合并口径（历史 waived 不计、fixed 不计）')
assert.ok(followUp.includes('共 4 条发现'), '发现总数应含历史轮合并条目')
for (const marker of ['fixed', 'waived', 'pending', '处置', '门禁自然通过']) {
  assert.ok(followUp.includes(marker), `跟进消息缺少下一步指令要点：${marker}`)
}
assert.ok(!followUp.includes('\\'), '跟进消息内路径不得残留反斜杠')
assert.ok(statusMessages.some((m) => m.includes('已送达发起会话')), '投递后应有送达状态消息')

// ===== 2. 清单缺失 → pending major 按 0 计，仍正常投递（降级不炸）=====
const emptyWorkspace = mkdtempSync(join(tmpdir(), 'moonglass-design-review-followup-empty-'))
sentMessages = []
statusMessages = []
const noFindings = runDesignReviewFollowUp({ ...baseInput, workspace: emptyWorkspace })
assert.equal(noFindings, 'delivered', '清单缺失不得阻断投递')
assert.ok(sentMessages[0].includes('pending major 0'), '清单缺失 pending major 按 0 计')
assert.ok(sentMessages[0].includes('共 0 条发现'), '清单缺失发现总数按 0 计')

// ===== 3. 审查异常 → 不生成跟进（复刻派发 settle/异常分支结构）=====
const errorWorkspace = mkdtempSync(join(tmpdir(), 'moonglass-design-review-followup-err-'))
appendDesignReviewRequest(errorWorkspace, { type: 'rtl-semantic' })
sentMessages = []
statusMessages = []
// 与 dispatchDesignReviewSession 同构：error 分支只 failRequest（markDesignReviewRequestError），不触碰续跑
const errorMark = markDesignReviewRequestError(errorWorkspace, 'rtl-semantic', '审查会话异常：provider 超时')
assert.equal(errorMark, true)
let errorState = readRequests(errorWorkspace)
const errEntry = () => errorState.requests.find((item) => item.type === 'rtl-semantic')
assert.notEqual(errEntry().consumed, true, '异常路径请求必须保持未消费')
assert.match(errEntry().lastError, /provider 超时/)
assert.equal(sentMessages.length, 0, '异常路径不得生成跟进消息（续跑函数根本不应被调用）')
// watchdog 熔断同口径：仍不投递
markDesignReviewRequestError(errorWorkspace, 'rtl-semantic', '审查会话被 watchdog 熔断：重复读写 rtl/')
errorState = readRequests(errorWorkspace)
assert.match(errEntry().lastError, /watchdog 熔断/)
assert.equal(sentMessages.length, 0, '熔断路径同样不得生成跟进消息')

// ===== 4. 原会话不在线 / 忙碌 / 发送失败 → 不抛错，降级状态消息 =====
sentMessages = []
statusMessages = []
const gone = runDesignReviewFollowUp({ ...baseInput, sourceAlive: false, target: null })
assert.equal(gone, 'skipped-source-gone')
assert.equal(sentMessages.length, 0, '发起会话不在线不得投递')
assert.ok(statusMessages.some((m) => m.includes('已结束或不在线') && m.includes('未投递')), '不在线须落状态消息留痕')
const goneNullTarget = runDesignReviewFollowUp({ ...baseInput, sourceAlive: true, target: null })
assert.equal(goneNullTarget, 'skipped-source-gone', 'sourceAlive 但 target=null 同样按不在线降级')

sentMessages = []
statusMessages = []
const busyStreaming = runDesignReviewFollowUp({ ...baseInput, target: { ready: true, isStreaming: true } })
assert.equal(busyStreaming, 'skipped-source-busy')
const busyNotReady = runDesignReviewFollowUp({ ...baseInput, target: { ready: false, isStreaming: false } })
assert.equal(busyNotReady, 'skipped-source-busy')
assert.equal(sentMessages.length, 0, '发起会话忙碌（流式/未就绪）不得投递')
assert.equal(statusMessages.length, 2, '忙碌降级应各落一条状态消息')

sentMessages = []
statusMessages = []
const throwingSend = runDesignReviewFollowUp({
  ...baseInput,
  send: () => { throw new Error('pi prompt 通道已关闭') }
})
assert.equal(throwingSend, 'send-failed', 'send 同步抛错应降级为 send-failed 且不向上抛')
assert.ok(statusMessages.some((m) => m.includes('投递失败') && m.includes('pi prompt 通道已关闭')), 'send 失败须落状态消息留痕')

// ===== 5. 防重：同一 review 请求只续跑一次；新一轮请求可再续跑 =====
const dedupWorkspace = mkdtempSync(join(tmpdir(), 'moonglass-design-review-followup-dedup-'))
mkdirSync(dirname(join(dedupWorkspace, rtlFindingsRel)), { recursive: true })
writeFileSync(join(dedupWorkspace, rtlFindingsRel), JSON.stringify({
  version: 1, generatedAt: '2026-10-20T10:00:00.000Z', reviewRound: 1, model: 'm1',
  findings: [{ 描述: 'major A', 位置: 'rtl/a.v:1', 严重度: 'major', 处置: 'pending' }]
}), 'utf-8')
appendDesignReviewRequest(dedupWorkspace, { type: 'rtl-semantic' })
sentMessages = []
statusMessages = []
// 首次 settle：consumed 新写入 → 投递
const firstConsumed = markDesignReviewRequestConsumed(dedupWorkspace, 'rtl-semantic', { sessionName: 'phase-rtl--review-rtl-semantic', model: 'm1', settledAt: '2026-10-20T10:05:00.000Z' })
assert.equal(firstConsumed, true)
const firstRun = runDesignReviewFollowUp({ ...baseInput, workspace: dedupWorkspace, round: 1 })
assert.equal(firstRun, 'delivered')
assert.equal(sentMessages.length, 1, '首次 settle 应投递一次跟进')
// 幂等重复结算（同一请求再次 settle）：consumed 返回 false → 防重闸拦截
const secondConsumed = markDesignReviewRequestConsumed(dedupWorkspace, 'rtl-semantic', { sessionName: 'phase-rtl--review-rtl-semantic-2', model: 'm1', settledAt: '2026-10-20T10:06:00.000Z' })
assert.equal(secondConsumed, false, '无未消费请求时 consumed 返回 false（幂等重复结算）')
const secondRun = runDesignReviewFollowUp({ ...baseInput, workspace: dedupWorkspace, round: 1, newlyConsumed: secondConsumed })
assert.equal(secondRun, 'skipped-not-consumed', '防重闸未过不得投递')
assert.equal(sentMessages.length, 1, '同一 review 请求只续跑一次')
// 新一轮请求（round 2）登记后 → 可再次续跑
appendDesignReviewRequest(dedupWorkspace, { type: 'rtl-semantic' })
const thirdConsumed = markDesignReviewRequestConsumed(dedupWorkspace, 'rtl-semantic', { sessionName: 'phase-rtl--review-rtl-semantic-3', model: 'm2', settledAt: '2026-10-20T11:00:00.000Z' })
assert.equal(thirdConsumed, true, '新一轮请求应可新消费')
const thirdRun = runDesignReviewFollowUp({ ...baseInput, workspace: dedupWorkspace, round: 2, newlyConsumed: thirdConsumed, model: 'm2' })
assert.equal(thirdRun, 'delivered', '新一轮请求应允许再次续跑')
assert.equal(sentMessages.length, 2, '每请求恰好续跑一次（round1 一次 + round2 一次）')

console.log('[design-review-followup-smoke] OK')
