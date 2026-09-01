import assert from 'node:assert/strict'
import ts from 'typescript'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// session-transcript.ts 是零运行时依赖的只读 JSONL 解析模块，直接转译后在纯 Node 下验证。
const dir = mkdtempSync(join(tmpdir(), 'moonglass-session-transcript-'))
const outfile = join(dir, 'session-transcript.mjs')
const source = readFileSync('src/main/services/session-transcript.ts', 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
})
writeFileSync(outfile, compiled.outputText, 'utf8')
const { readPiSessionMessages } = await import(pathToFileURL(outfile))

// 不存在的会话文件：返回空数组而非抛错（只读窥视契约）
assert.deepEqual(readPiSessionMessages(join(dir, 'missing.jsonl')), [])

// 合法 JSONL：session 头 / session_info / message 行混合，只取 message
const sessionFile = join(dir, 'session-phase-verif--batch-1.jsonl')
writeFileSync(sessionFile, [
  JSON.stringify({ type: 'session', version: 3, id: 'h1', timestamp: '2026-09-01T00:00:00.000Z', cwd: dir }),
  JSON.stringify({ type: 'session_info', id: 'i1', parentId: null, timestamp: '2026-09-01T00:00:00.000Z', name: 'VERIF 批次 1 (VERIF)' }),
  JSON.stringify({ type: 'message', message: { role: 'user', content: '批次 prompt', timestamp: 1000 } }),
  JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '收到' }], timestamp: 1001 } }),
  JSON.stringify({ type: 'message', message: { role: 'toolResult', toolName: 'run_simulation', toolCallId: 't1', content: [{ text: '**结果**: ✅ 通过' }], timestamp: 1002 } })
].join('\n') + '\n', 'utf8')

const messages = readPiSessionMessages(sessionFile)
assert.equal(messages.length, 3)
assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'toolResult'])
assert.equal(messages[2].toolName, 'run_simulation')

// 流式写入中的残缺末行被跳过，不中断解析
writeFileSync(sessionFile, readFileSync(sessionFile, 'utf8') + '{"type":"message","message":{"role":"assist', 'utf8')
assert.equal(readPiSessionMessages(sessionFile).length, 3)

// 空文件返回空数组
const emptyFile = join(dir, 'session-empty.jsonl')
writeFileSync(emptyFile, '', 'utf8')
assert.deepEqual(readPiSessionMessages(emptyFile), [])

console.log('session transcript smoke passed')
