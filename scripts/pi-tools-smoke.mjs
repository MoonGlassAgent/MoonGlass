// 验证 moonglass-tools.ts 扩展能否被 pi 加载（typebox 解析 + 工具注册）
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const bin = join(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
const bridgeDir = join(tmpdir(), 'moonglass-tools-smoke')
mkdirSync(bridgeDir, { recursive: true })
// 模拟 AgentService：把两个扩展复制到独立目录（与 userData 场景一致——目录下无 node_modules）
for (const f of ['moonglass-providers.ts', 'moonglass-tools.ts']) {
  writeFileSync(
    join(bridgeDir, f),
    (await import('node:fs')).readFileSync(join(process.cwd(), 'resources', 'moonglass', 'pi-bridge', f), 'utf-8')
  )
}
// Phase 4：同时复制 eda-bridge 共享实现到 pi-bridge 目录，供 moonglass-tools.ts 相对导入
const edaBridgeDir = join(bridgeDir, 'eda-bridge')
mkdirSync(edaBridgeDir, { recursive: true })
for (const f of ['tool-runner.ts', 'rtl-files.ts', 'simulation.ts', 'synthesis.ts']) {
  writeFileSync(
    join(edaBridgeDir, f),
    (await import('node:fs')).readFileSync(join(process.cwd(), 'packages', 'eda-bridge', 'src', f), 'utf-8')
  )
}
const work = join(bridgeDir, 'work')
mkdirSync(join(work, '.pi'), { recursive: true })
writeFileSync(join(work, '.pi', 'APPEND_SYSTEM.md'), 'test', 'utf-8')

const providers = [{ id: 'deepseek', name: 'DeepSeek', protocol: 'openai-compatible', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-dummy', models: ['deepseek-chat'] }]
const providerFile = join(work, 'providers.json')
writeFileSync(providerFile, JSON.stringify(providers), { mode: 0o600 })

const child = spawn(process.execPath, [
  bin, '--mode', 'rpc', '-a', '--no-session',
  '-e', join(bridgeDir, 'moonglass-providers.ts'),
  '-e', join(bridgeDir, 'moonglass-tools.ts')
], {
  cwd: work,
  env: { ...process.env, MOONGLASS_PROVIDERS_FILE: providerFile, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
  stdio: ['pipe', 'pipe', 'pipe']
})

let buffer = ''
const decoder = new StringDecoder('utf8')
const pending = new Map()
let seq = 0
let extErrors = []

child.stdout.on('data', (chunk) => {
  buffer += decoder.write(chunk)
  for (;;) {
    const idx = buffer.indexOf('\n')
    if (idx === -1) break
    let line = buffer.slice(0, idx)
    buffer = buffer.slice(idx + 1)
    if (line.endsWith('\r')) line = line.slice(0, -1)
    if (!line.trim()) continue
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.type === 'response') {
      const p = pending.get(msg.id)
      if (p) { pending.delete(msg.id); p(msg) }
    } else if (msg.type === 'extension_error') {
      extErrors.push(`${msg.extensionPath}: ${msg.error}`)
    }
  }
})
child.stderr.on('data', (d) => console.log('[stderr]', d.toString().slice(0, 500)))
child.on('close', (code) => { console.log('[exit]', code); process.exit(1) })

function send(cmd) {
  const id = `req-${++seq}`
  return new Promise((resolve) => {
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ id, ...cmd }) + '\n')
  })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ready = false
for (let i = 0; i < 120 && !ready; i++) {
  try { const r = await send({ type: 'get_state' }); if (r.success) ready = true } catch { await sleep(500) }
}
console.log('[ready]', ready)
if (!ready) { child.kill(); process.exit(1) }

const cmds = await send({ type: 'get_commands' })
const toolNames = (cmds.data?.commands ?? []).map((c) => c.name)
console.log('[commands]', JSON.stringify(toolNames))
console.log('[extension_errors]', extErrors.length ? extErrors : '无')

// 再验证工具是否真的注册进了 Agent 工具集（get_state 不含工具清单，用 prompt 侧面验证成本高，此处以扩展无错误 + 进程就绪为准）
child.kill()
process.exit(extErrors.length === 0 ? 0 : 1)
