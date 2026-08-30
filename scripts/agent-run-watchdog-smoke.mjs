import assert from 'node:assert/strict'
import ts from 'typescript'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'moonglass-watchdog-'))
const outfile = join(dir, 'watchdog.mjs')
const source = readFileSync('src/main/services/AgentRunWatchdog.ts', 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
})
writeFileSync(outfile, compiled.outputText, 'utf8')
const { AgentRunWatchdog, isTruncatedWithoutToolCall } = await import(pathToFileURL(outfile))

assert.equal(isTruncatedWithoutToolCall([
  { role: 'assistant', stopReason: 'length', content: [{ type: 'thinking', thinking: '长计划' }] }
]), true)
assert.equal(isTruncatedWithoutToolCall([
  { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', name: 'write' }] }
]), false)
assert.equal(isTruncatedWithoutToolCall([
  { role: 'assistant', stopReason: 'length', content: [{ type: 'toolCall', name: 'write' }] }
]), false)

const editGuard = new AgentRunWatchdog('REQ_SPEC')
for (let i = 1; i <= 2; i++) {
  assert.equal(editGuard.start(`e${i}`, 'edit', { path: 'docs/spec.md' }), null)
  assert.equal(editGuard.end(`e${i}`, true), null)
}
editGuard.start('e3', 'edit', { path: 'docs/spec.md' })
assert.equal(editGuard.end('e3', true)?.level, 'steer')
for (let i = 4; i <= 5; i++) {
  editGuard.start(`e${i}`, 'edit', { path: 'docs/spec.md' })
  assert.equal(editGuard.end(`e${i}`, true), null)
}
editGuard.start('e6', 'edit', { path: 'docs/spec.md' })
assert.equal(editGuard.end('e6', true)?.level, 'abort')

const readGuard = new AgentRunWatchdog('REQ_SPEC')
for (let i = 1; i < 12; i++) assert.equal(readGuard.start(`r${i}`, 'read', { path: 'docs/spec.md' }), null)
assert.equal(readGuard.start('r12', 'read', { path: 'docs/spec.md' })?.level, 'steer')

const budgetGuard = new AgentRunWatchdog('REQ_SPEC')
let soft
for (let i = 1; i <= 80; i++) soft = budgetGuard.start(`b${i}`, 'bash', { command: 'echo ok' }) ?? soft
assert.equal(soft?.level, 'steer')
let hard
for (let i = 81; i <= 160; i++) hard = budgetGuard.start(`b${i}`, 'bash', { command: 'echo ok' }) ?? hard
assert.equal(hard?.level, 'abort')

console.log('agent run watchdog smoke passed')
