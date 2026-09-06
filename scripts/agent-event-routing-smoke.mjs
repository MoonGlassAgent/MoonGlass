/**
 * agent-event-routing smoke：阶段切换不中断执行后，事件按 sessionName 路由的纯逻辑。
 *  - 活动会话的事件全部进入聊天面板
 *  - 其他会话（切走后台续跑 / VERIF 批次）的流式事件被忽略
 *  - 其他会话的 status 通知（后台任务完成提醒）始终放行，并触发会话信息刷新
 */
import assert from 'node:assert/strict'
import ts from 'typescript'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'moonglass-event-routing-'))
const outfile = join(dir, 'agent-event-routing.mjs')
const source = readFileSync('src/shared/agent-event-routing.ts', 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
})
writeFileSync(outfile, compiled.outputText, 'utf8')
const { shouldApplyAgentEvent, isBackgroundSessionNotice } = await import(pathToFileURL(outfile))

const ACTIVE = 'phase-verif'

// 活动会话：所有事件类型都放行
for (const type of ['text-delta', 'thinking-delta', 'tool-start', 'tool-end', 'agent-start', 'agent-settled', 'status', 'error']) {
  assert.equal(shouldApplyAgentEvent({ sessionName: ACTIVE, event: { type } }, ACTIVE), true, `活动会话 ${type} 应放行`)
}

// 兼容旧负载（无 sessionName）：一律放行
assert.equal(shouldApplyAgentEvent({ event: { type: 'text-delta' } }, ACTIVE), true)
assert.equal(shouldApplyAgentEvent({ event: { type: 'error' } }, undefined), true)

// 后台会话：流式/工具/状态迁移事件被忽略
for (const type of ['text-delta', 'thinking-delta', 'tool-start', 'tool-update', 'tool-end', 'agent-start', 'agent-settled', 'error']) {
  assert.equal(shouldApplyAgentEvent({ sessionName: 'phase-rtl', event: { type } }, ACTIVE), false, `后台会话 ${type} 应忽略`)
}

// 后台会话：status 通知例外放行（如"RTL 阶段的后台任务已完成"）
assert.equal(shouldApplyAgentEvent({ sessionName: 'phase-rtl', event: { type: 'status' } }, ACTIVE), true)

// 后台通知判定：仅"非活动会话的 status"
assert.equal(isBackgroundSessionNotice({ sessionName: 'phase-rtl', event: { type: 'status' } }, ACTIVE), true)
assert.equal(isBackgroundSessionNotice({ sessionName: ACTIVE, event: { type: 'status' } }, ACTIVE), false)
assert.equal(isBackgroundSessionNotice({ sessionName: 'phase-rtl', event: { type: 'error' } }, ACTIVE), false)
assert.equal(isBackgroundSessionNotice({ event: { type: 'status' } }, ACTIVE), false)
assert.equal(isBackgroundSessionNotice({ sessionName: 'phase-rtl', event: { type: 'status' } }, undefined), true)

console.log('[agent-event-routing-smoke] OK')
