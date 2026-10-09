// 设计评审左移（DESIGN-REVIEW-LEFT-SHIFT §8）片 B smoke：
//  1) pi 工具落盘助手 appendDesignReviewRequest：幂等不重复追加、round=已完成轮数+1、
//     非法 type 拒绝、ARCH/RTL 发现清单路径、scope 记录（直测 moonglass-tools.ts 发布源码）。
//  2) 主进程纯函数：extractDesignReviewRequest 事件提取（无关事件/isError/缺 details/非法 type 不触发）、
//     markDesignReviewRequestConsumed（consumed + settledAt + 会话名 + 模型身份）、
//     markDesignReviewRequestError（保持未消费仅记 lastError）。
//  3) 派发链路（可注入假派发，不真起 pi）：并发守卫状态机 + consumed/lastError 出口。
//  4) buildDesignReviewDispatchPlan：阶段/会话名/产物路径/审查 prompt 契约要点。
// 与 scenario-hits-smoke 同模式：从源码按配对扫描提取函数，拼装临时 TS 模块直接执行。
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const toolsSource = readFileSync(join(process.cwd(), 'resources', 'moonglass', 'pi-bridge', 'moonglass-tools.ts'), 'utf-8')
const agentSource = readFileSync(join(process.cwd(), 'src', 'main', 'services', 'AgentService.ts'), 'utf-8')

/** 从函数声明起点提取整个函数体：先越过参数列表的配对圆括号（参数里可有对象类型花括号），
 *  再从参数列表结束后的第一个花括号做配对匹配（覆盖内联对象返回类型的花括号）。 */
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

const moduleDir = mkdtempSync(join(tmpdir(), 'moonglass-design-review-'))

// ---- 桥接侧（moonglass-tools.ts）----
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

// ---- 主进程侧（AgentService.ts 模块级纯函数）----
const mainModule = join(moduleDir, 'design-review-main.ts')
writeFileSync(mainModule, `import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

${extractLine(agentSource, 'const DESIGN_REVIEW_REQUEST_REL_PATH =')}

${extractLine(agentSource, 'const PHASE_SESSION_PREFIX =')}

${extractFunction(agentSource, 'function phaseMainSessionName(')}

${extractFunction(agentSource, 'export function extractDesignReviewRequest(')}

${extractFunction(agentSource, 'function readDesignReviewRequestRecords(')}

${extractFunction(agentSource, 'function writeDesignReviewRequestRecords(')}

${extractFunction(agentSource, 'export function markDesignReviewRequestConsumed(')}

${extractFunction(agentSource, 'export function markDesignReviewRequestError(')}

${extractFunction(agentSource, 'export function buildDesignReviewDispatchPlan(')}
`, 'utf-8')
const {
  extractDesignReviewRequest,
  markDesignReviewRequestConsumed,
  markDesignReviewRequestError,
  buildDesignReviewDispatchPlan
} = await import(pathToFileURL(mainModule).href)

const workspace = mkdtempSync(join(tmpdir(), 'moonglass-design-review-ws-'))
const requestPath = join(workspace, 'reports', 'review-request.json')
const readRequests = () => JSON.parse(readFileSync(requestPath, 'utf-8'))
const archFindingsPath = join(workspace, 'docs', '03_design', 'review-findings.json')
const rtlFindingsPath = join(workspace, 'rtlqa', 'review', 'review-findings.json')

// ===== 1. 工具落盘：非法 type 拒绝 =====
assert.throws(
  () => appendDesignReviewRequest(workspace, { type: 'bogus' }),
  /非法 review 类型/,
  '非法 type 必须拒绝'
)
assert.equal(existsSync(requestPath), false, '非法 type 不应产生请求文件')

// ===== 2. 首次写入 + round=1 + scope 记录 =====
const first = appendDesignReviewRequest(workspace, { type: 'arch-consistency', scope: '  重点审查寄存器接口与 DMA 通道仲裁  ' })
assert.equal(first.deduplicated, false)
assert.equal(first.record.type, 'arch-consistency')
assert.equal(first.record.round, 1, '无历史清单时 round 应为 1')
assert.equal(first.record.scope, '重点审查寄存器接口与 DMA 通道仲裁', 'scope 应裁剪空白')
assert.ok(first.record.requestedAt, '应有 requestedAt')
let state = readRequests()
assert.equal(state.version, 1)
assert.equal(state.requests.length, 1)

// 无 scope 时不写 scope 字段
const noScope = appendDesignReviewRequest(workspace, { type: 'rtl-semantic' })
assert.equal('scope' in noScope.record, false, '未提供 scope 不应写 scope 字段')
state = readRequests()
assert.equal(state.requests.length, 2, '不同类型请求应并列追加')
assert.equal(state.requests[1].type, 'rtl-semantic')
assert.equal(state.requests[1].round, 1)

// ===== 3. 幂等：同 type 未消费请求不重复追加 =====
const again = appendDesignReviewRequest(workspace, { type: 'arch-consistency', scope: '换一个说法' })
assert.equal(again.deduplicated, true, '同 type 未消费请求应幂等')
assert.equal(again.record.round, 1, '幂等返回原记录，不重新计算 round')
assert.equal(again.record.requestedAt, first.record.requestedAt, '幂等返回原记录时间戳')
assert.equal(again.record.scope, '重点审查寄存器接口与 DMA 通道仲裁', '幂等返回原 scope，不被覆盖')
state = readRequests()
assert.equal(state.requests.length, 2, '幂等不得重复追加')

// ===== 4. round 计算：已完成轮数 +1（顶层 reviewRound 优先，rounds[] 长度兜底） =====
markDesignReviewRequestConsumed(workspace, 'arch-consistency', { sessionName: 'phase-arch--review-arch-consistency', model: 'deepseek/deepseek-chat', settledAt: '2026-10-09T10:00:00.000Z' })
mkdirSync(dirname(archFindingsPath), { recursive: true })
writeFileSync(archFindingsPath, JSON.stringify({ version: 1, generatedAt: '2026-10-09T10:00:00.000Z', reviewRound: 2, model: 'deepseek/deepseek-chat', findings: [] }), 'utf-8')
const third = appendDesignReviewRequest(workspace, { type: 'arch-consistency' })
assert.equal(third.deduplicated, false, '已消费后可重新追加')
assert.equal(third.record.round, 3, 'round 应为已完成轮数（reviewRound=2）+1')
// rtl-semantic：清单只有 rounds[] 无顶层 reviewRound → 按 rounds 长度
markDesignReviewRequestConsumed(workspace, 'rtl-semantic', { sessionName: 'phase-rtl--review-rtl-semantic', model: 'kimi/kimi-k3', settledAt: '2026-10-09T11:00:00.000Z' })
mkdirSync(dirname(rtlFindingsPath), { recursive: true })
writeFileSync(rtlFindingsPath, JSON.stringify({ version: 1, generatedAt: '2026-10-09T11:00:00.000Z', rounds: [{ model: 'a' }, { model: 'b' }, { model: 'c' }], findings: [] }), 'utf-8')
const rtlSecond = appendDesignReviewRequest(workspace, { type: 'rtl-semantic' })
assert.equal(rtlSecond.record.round, 4, 'round 应为 rounds[] 长度（3）+1')

// ===== 5. 事件提取：无关事件 / isError / 缺 details / 非法 type 不触发 =====
assert.equal(extractDesignReviewRequest({ type: 'text-delta' }), null, '无关事件类型不得触发')
assert.equal(extractDesignReviewRequest({ type: 'tool_execution_end', toolName: 'run_verible_lint' }), null, '非本工具不得触发')
assert.equal(extractDesignReviewRequest({ type: 'tool_execution_end', toolName: 'request_design_review', isError: true, result: { details: { request: { type: 'arch-consistency' } } } }), null, 'isError 不得触发')
assert.equal(extractDesignReviewRequest({ type: 'tool_execution_end', toolName: 'request_design_review', result: {} }), null, '缺 details.request 不得触发')
assert.equal(extractDesignReviewRequest({ type: 'tool_execution_end', toolName: 'request_design_review', result: { details: { request: { type: 'nope' } } } }), null, 'details 中非法 type 不得触发')
const extracted = extractDesignReviewRequest({
  type: 'tool_execution_end',
  toolName: 'request_design_review',
  result: { details: { request: { type: 'rtl-semantic', scope: '重点看 FIFO 边界', round: 4 }, deduplicated: false } }
})
assert.deepEqual(extracted, { type: 'rtl-semantic', scope: '重点看 FIFO 边界', round: 4 }, '合法事件应提取 type/scope/round')

// ===== 6. consumed 标记：只命中同类型最新未消费请求，带 settledAt/会话名/模型 =====
const before = readRequests().requests
const marked = markDesignReviewRequestConsumed(workspace, 'rtl-semantic', { sessionName: 's-2', model: 'kimi/kimi-k3', settledAt: '2026-10-09T12:00:00.000Z' })
assert.equal(marked, true)
state = readRequests()
const rtlEntry = state.requests.find((item) => item.type === 'rtl-semantic' && item.round === 4)
assert.equal(rtlEntry.consumed, true)
assert.equal(rtlEntry.consumedAt, '2026-10-09T12:00:00.000Z')
assert.equal(rtlEntry.reviewSession, 's-2')
assert.equal(rtlEntry.reviewModel, 'kimi/kimi-k3', '模型身份须落盘（交叉 review 建议与态势展示）')
const archPending = state.requests.find((item) => item.type === 'arch-consistency' && item.round === 3)
assert.notEqual(archPending.consumed, true, '不同类型未消费请求不得被误标记')
assert.equal(state.requests.filter((item) => item.consumed === true).length, 3, '此前两轮 consumed 标记应保留')
assert.equal(before.length, state.requests.length, 'consumed 标记不得增删请求')
assert.equal(markDesignReviewRequestConsumed(workspace, 'rtl-semantic', { sessionName: 's-3', model: 'x/y', settledAt: '2026-10-09T13:00:00.000Z' }), false, '无未消费请求时返回 false（幂等重复结算）')

// ===== 7. lastError 路径：请求保持未消费，仅记 lastError =====
const markedErr = markDesignReviewRequestError(workspace, 'arch-consistency', '审查会话异常：provider 超时')
assert.equal(markedErr, true)
state = readRequests()
const archErr = state.requests.find((item) => item.type === 'arch-consistency' && item.round === 3)
assert.notEqual(archErr.consumed, true, '异常路径请求必须保持未消费（可重新派发）')
assert.match(archErr.lastError, /审查会话异常：provider 超时/, 'lastError 须记录异常原因')
assert.equal(markDesignReviewRequestError(workspace, 'nope-type', 'x'), false, '无匹配请求返回 false')

// ===== 8. 派发链路（可注入假派发，不真起 pi）：并发守卫状态机 + consumed/lastError 出口 =====
// 复刻 dispatchDesignReviewSession 的守卫/标记链：guard=activeDesignReviews，dispatch 为假实现。
const guard = new Map()
const fakeDispatch = async (request, behavior) => {
  if (guard.has(request.type)) return 'skipped'
  guard.set(request.type, `phase-${request.type === 'arch-consistency' ? 'arch' : 'rtl'}--review-${request.type}`)
  try {
    if (behavior === 'error') {
      markDesignReviewRequestError(workspace, request.type, '审查会话异常：假派发失败')
      return 'error'
    }
    markDesignReviewRequestConsumed(workspace, request.type, { sessionName: guard.get(request.type), model: 'fake/model', settledAt: '2026-10-09T14:00:00.000Z' })
    return 'settled'
  } finally {
    guard.delete(request.type)
  }
}
// arch-consistency 第 3 轮请求处于未消费态（刚记过 lastError），重派发应成功并 consumed
assert.equal(await fakeDispatch({ type: 'arch-consistency' }, 'settled'), 'settled')
assert.equal(guard.size, 0, 'settle 后守卫必须释放')
state = readRequests()
assert.equal(state.requests.find((item) => item.type === 'arch-consistency' && item.round === 3).consumed, true)
// 新一轮请求：第 4 轮（findings reviewRound=3? 否——findings 仍是 2，round 仍按工具口径计算）
const fourth = appendDesignReviewRequest(workspace, { type: 'arch-consistency' })
assert.equal(fourth.record.round, 3, 'round 仍按已完成轮数+1（清单 reviewRound=2），consumed 不影响计算')
assert.equal(await fakeDispatch({ type: 'arch-consistency' }, 'error'), 'error')
assert.equal(guard.size, 0, '异常后守卫必须释放，允许重新派发')
state = readRequests()
const fourthEntry = state.requests.find((item) => item.type === 'arch-consistency' && item.round === 3 && item.consumed !== true)
assert.ok(fourthEntry, '异常路径不得误标 consumed')
assert.match(fourthEntry.lastError, /假派发失败/)
// 并发守卫：同一类型在跑时不重复派发；不同类型互不影响
guard.set('arch-consistency', 'running-session')
assert.equal(await fakeDispatch({ type: 'arch-consistency' }, 'settled'), 'skipped', '同类型在跑必须跳过')
assert.notEqual(await fakeDispatch({ type: 'rtl-semantic' }, 'settled'), 'skipped', '不同类型不受守卫影响')
guard.clear()

// ===== 9. 派发计划：阶段 / 会话名 / 产物路径 / prompt 契约要点 =====
const archPlan = buildDesignReviewDispatchPlan({ type: 'arch-consistency', scope: '看仲裁', round: 3, model: 'deepseek/deepseek-chat' })
assert.equal(archPlan.phase, 'ARCH')
assert.equal(archPlan.sessionNameBase, 'phase-arch--review-arch-consistency')
assert.equal(archPlan.reportRelPath, join('docs', '03_design', 'review-arch-consistency.md'))
assert.equal(archPlan.findingsRelPath, join('docs', '03_design', 'review-findings.json'))
for (const marker of ['独立设计审查者', '需求-规格', 'TBD', '自由发挥', '描述', '位置', '严重度', 'pending', 'reviewRound: 3', 'deepseek/deepseek-chat', 'rounds[]', '禁止修改 rtl/', '看仲裁']) {
  assert.ok(archPlan.prompt.includes(marker), `arch prompt 缺少契约要点：${marker}`)
}
assert.ok(!archPlan.prompt.includes('不跑仿真'), 'arch prompt 不应声称纯静态阅读（仅 RTL 语义审查）')
const rtlPlan = buildDesignReviewDispatchPlan({ type: 'rtl-semantic', scope: '', round: 4, model: 'kimi/kimi-k3' })
assert.equal(rtlPlan.phase, 'RTL')
assert.equal(rtlPlan.sessionNameBase, 'phase-rtl--review-rtl-semantic')
assert.equal(rtlPlan.reportRelPath, join('rtlqa', 'review', 'semantic-review.md'))
assert.equal(rtlPlan.findingsRelPath, join('rtlqa', 'review', 'review-findings.json'))
for (const marker of ['纯静态阅读', '不跑仿真', 'rtl/ 全部 RTL', '语义上是否一致']) {
  assert.ok(rtlPlan.prompt.includes(marker), `rtl prompt 缺少契约要点：${marker}`)
}
assert.ok(!rtlPlan.prompt.includes('发起方附带的审查范围说明'), '空 scope 不应生成范围说明段落')

// ===== 10. 阶段提示词登记了 review 步骤（templates.ts） =====
const templatesSource = readFileSync(join(process.cwd(), 'packages', 'prompts', 'src', 'templates.ts'), 'utf-8')
const archBlock = templatesSource.slice(templatesSource.indexOf('ARCH: {'), templatesSource.indexOf('RTL: {'))
assert.ok(archBlock.includes("request_design_review(type='arch-consistency'"), 'ARCH 模板缺少 request_design_review 步骤')
assert.ok(archBlock.includes('必经活动'), 'ARCH 模板缺少必经活动措辞')
const rtlBlock = templatesSource.slice(templatesSource.indexOf('RTL: {'), templatesSource.indexOf('VERIF: {'))
assert.ok(rtlBlock.includes("request_design_review(type='rtl-semantic'"), 'RTL 模板缺少 request_design_review 步骤')
for (const marker of ['fixed / waived / pending', '回填规格文档', '自由发挥']) {
  assert.ok(archBlock.includes(marker), `ARCH 模板缺少措辞要点：${marker}`)
  assert.ok(rtlBlock.includes(marker), `RTL 模板缺少措辞要点：${marker}`)
}

console.log('[design-review-dispatch-smoke] OK')
