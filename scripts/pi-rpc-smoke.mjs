// pi RPC 冒烟脚本：模拟 AgentService 的 spawn 方式，验证协议链路
// 假 Key —— 预期走到 LLM 请求并以 401/鉴权错误收尾，证明 Provider 注册与 RPC 协议正常
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 可指定 pi cli.js（默认开发环境 node_modules；验证绿色版时传 SMOKE_BIN）
const bin = process.env.SMOKE_BIN ?? join(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
// 可指定桥接扩展（验证绿色版时传 SMOKE_BRIDGE 指向 resources/pi-bridge）
const bridge = process.env.SMOKE_BRIDGE ?? join(process.cwd(), 'resources', 'moonglass', 'pi-bridge', 'moonglass-providers.ts')
// 可指定执行器（默认 node；复现 Electron 场景时传 electron.exe 路径）
const execPath = process.env.SMOKE_EXEC ?? process.execPath
const work = join(tmpdir(), 'moonglass-pi-smoke')
mkdirSync(join(work, '.pi'), { recursive: true })
mkdirSync(join(work, 'sessions'), { recursive: true })
writeFileSync(join(work, '.pi', 'APPEND_SYSTEM.md'), '你是 MoonGlass 测试 Agent。', 'utf-8')

const providers = [{
  id: 'deepseek', name: 'DeepSeek', protocol: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com', apiKey: 'sk-dummy-smoke-test', models: ['deepseek-chat']
}]
const providerFile = join(work, 'providers.json')
writeFileSync(providerFile, JSON.stringify(providers), { mode: 0o600 })

const child = spawn(execPath, [
  bin, '--mode', 'rpc', '-a',
  '--session-dir', join(work, 'sessions'),
  '--name', 'smoke',
  '-e', bridge
], {
  cwd: work,
  env: { ...process.env, MOONGLASS_PROVIDERS_FILE: providerFile, PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
  stdio: ['pipe', 'pipe', 'pipe']
})

let buffer = ''
const decoder = new StringDecoder('utf8')
const pending = new Map()
let seq = 0
let done = false

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
    try { msg = JSON.parse(line) } catch { console.log('[unparsed]', line.slice(0, 120)); continue }
    if (msg.type === 'response') {
      const p = pending.get(msg.id)
      if (p) { pending.delete(msg.id); p(msg) }
    } else {
      handleEvent(msg)
    }
  }
})
child.stderr.on('data', (d) => console.log('[stderr]', d.toString().slice(0, 300)))
child.on('close', (code) => { console.log('[exit]', code); process.exit(done ? 0 : 1) })

function send(cmd) {
  const id = `req-${++seq}`
  return new Promise((resolve) => {
    pending.set(id, resolve)
    child.stdin.write(JSON.stringify({ id, ...cmd }) + '\n')
  })
}

let sawDelta = false
let sawError = ''
function handleEvent(msg) {
  if (msg.type === 'message_update') {
    const e = msg.assistantMessageEvent ?? {}
    if (e.type === 'text_delta') sawDelta = true
    if (e.type === 'error') sawError = msg.message?.errorMessage ?? '(unknown)'
  }
  if (msg.type === 'auto_retry_start') console.log('[retry]', String(msg.errorMessage ?? '').slice(0, 120))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await send({ type: 'get_state' })
      if (res.success) return true
    } catch { /* retry */ }
    await sleep(500)
  }
  return false
}

const ready = await waitReady()
console.log('[ready]', ready)
if (!ready) { child.kill(); process.exit(1) }

const models = await send({ type: 'get_available_models' })
const dsModels = (models.data?.models ?? []).filter((m) => m.provider === 'deepseek').map((m) => m.id)
console.log('[deepseek models registered]', JSON.stringify(dsModels))

const setRes = await send({ type: 'set_model', provider: 'deepseek', modelId: 'deepseek-chat' })
console.log('[set_model]', setRes.success, setRes.error ?? '')

// 打包验收不依赖外部模型服务：ready、Provider 注册和模型切换通过即可。
if (process.env.SMOKE_READY_ONLY === '1') {
  done = setRes.success === true && dsModels.includes('deepseek-chat')
  console.log(done
    ? '[verdict] PASS — pi RPC、Provider 注册和模型切换均正常'
    : '[verdict] FAIL — pi RPC 就绪但 Provider 或模型切换异常')
  child.kill()
  process.exit(done ? 0 : 1)
}

await send({ type: 'prompt', message: 'say hi' })
for (let i = 0; i < 60 && !sawError && !sawDelta; i++) await sleep(1000)

if (sawDelta) {
  console.log('[result] 收到流式输出（假 Key 居然能用？！）')
  done = true
} else if (sawError) {
  console.log('[result] 按预期收到 LLM 错误（鉴权失败即链路正常）:', sawError.slice(0, 200))
  done = /401|auth|key|Unauthorized|invalid|Authentication/i.test(sawError)
  console.log(done ? '[verdict] PASS — 错误为鉴权类，全链路正常' : '[verdict] 错误类型待确认')
} else {
  console.log('[result] 60s 内无响应')
}
child.kill()
process.exit(done ? 0 : 1)
