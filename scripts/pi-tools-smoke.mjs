// 验证 moonglass-tools.ts 扩展能否被 pi 加载（typebox 解析 + 工具注册）
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const bin = join(process.cwd(), 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js')
const bridgeDir = join(tmpdir(), 'moonglass-tools-smoke')
mkdirSync(bridgeDir, { recursive: true })
// 模拟 AgentService：把扩展及模型元数据复制到独立目录（与 userData 场景一致——目录下无 node_modules）
for (const f of ['moonglass-providers.ts', 'model-context.ts', 'moonglass-tools.ts']) {
  writeFileSync(
    join(bridgeDir, f),
    (await import('node:fs')).readFileSync(join(process.cwd(), 'resources', 'moonglass', 'pi-bridge', f), 'utf-8')
  )
}
// Phase 4：同时复制 eda-bridge 共享实现到 pi-bridge 目录，供 moonglass-tools.ts 相对导入
const edaBridgeDir = join(bridgeDir, 'eda-bridge')
mkdirSync(edaBridgeDir, { recursive: true })
for (const f of ['tool-runner.ts', 'rtl-files.ts', 'simulation.ts', 'synthesis.ts', 'lint.ts', 'formal.ts']) {
  writeFileSync(
    join(edaBridgeDir, f),
    (await import('node:fs')).readFileSync(join(process.cwd(), 'packages', 'eda-bridge', 'src', f), 'utf-8')
  )
}
const verificationIntelligenceDir = join(bridgeDir, 'verification-intelligence')
mkdirSync(verificationIntelligenceDir, { recursive: true })
for (const f of ['engine.ts', 'types.ts', 'structural-analyzer.ts']) {
  writeFileSync(
    join(verificationIntelligenceDir, f),
    (await import('node:fs')).readFileSync(join(process.cwd(), 'packages', 'verification-intelligence-engine', 'src', f), 'utf-8')
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
// WS1/WS2：新工具与参数 schema 以源码标记断言兜底（扩展无错误已证明模块可被 pi 加载）
const toolsSource = readFileSync(join(process.cwd(), 'resources', 'moonglass', 'pi-bridge', 'moonglass-tools.ts'), 'utf-8')
for (const marker of [
  "name: 'register_verification_intents'",
  'anchors',
  'rtlSignals',
  'riskIds',
  'requirementIds',
  'minItems',
  'registerVerificationIntents',
  "name: 'run_simulation'",
  'scenarioIds',
  'writeScenarioHits',
  'rebuildVerificationPosture',
  "Type.Literal('BLOCKED_BY_SPEC')",
  // VERIF 上下文治理第 2 批：record_root_cause 工具注册与 schema 约束（契约 §2.1）
  "name: 'record_root_cause'",
  'recordRootCause',
  'refutedHypotheses',
  'failureSignature',
  'maxLength: 200',
  'maxLength: 120',
  "Type.Literal('confirmed')",
  "Type.Literal('refuted')",
  'root-causes.json',
  '曾 FAIL 后转 PASS',
  // v0.8.6：register_verification_intents 波段/主题 schema 与聚类批次返回
  "Type.Literal('smoke')",
  "Type.Literal('basic')",
  "Type.Literal('corner')",
  "Type.Literal('signoff')",
  'topic',
  'wave',
  'executionBatches',
  '聚类组'
]) {
  if (!toolsSource.includes(marker)) {
    console.error(`[schema] moonglass-tools.ts 缺少标记：${marker}`)
    child.kill()
    process.exit(1)
  }
}
// record_scenario_adjudication 已缩权为 4 值判断类裁决，执行派生状态不得出现在工具枚举中
const adjudicationBlock = toolsSource.slice(toolsSource.indexOf("name: 'record_scenario_adjudication'"), toolsSource.indexOf("name: 'review_verification_scenarios'"))
for (const forbidden of ["Type.Literal('VERIFIED')", "Type.Literal('FAILED')", "Type.Literal('REACHED')", "Type.Literal('NOT_REACHED')", "Type.Literal('PARTIAL')", "Type.Literal('FORMAL_PROVED')", "Type.Literal('FORMAL_UNREACHABLE')"]) {
  if (adjudicationBlock.includes(forbidden)) {
    console.error(`[schema] record_scenario_adjudication 仍接受执行派生状态：${forbidden}`)
    child.kill()
    process.exit(1)
  }
}
console.log('[schema] register_verification_intents / scenarioIds / 裁决缩权标记齐全')
child.kill()
process.exit(extErrors.length === 0 ? 0 : 1)
