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
for (const f of ['moonglass-providers.ts', 'model-context.ts', 'moonglass-tools.ts', 'rtl-write-guard.ts']) {
  writeFileSync(
    join(bridgeDir, f),
    (await import('node:fs')).readFileSync(join(process.cwd(), 'resources', 'moonglass', 'pi-bridge', f), 'utf-8')
  )
}
// Phase 4：同时复制 eda-bridge 共享实现到 pi-bridge 目录，供 moonglass-tools.ts 相对导入
const edaBridgeDir = join(bridgeDir, 'eda-bridge')
mkdirSync(join(edaBridgeDir, 'src'), { recursive: true })
for (const f of ['tool-runner.ts', 'rtl-files.ts', 'simulation.ts', 'synthesis.ts', 'lint.ts', 'formal.ts', 'dead-logic.ts', 'slang-runner.ts']) {
  writeFileSync(
    join(edaBridgeDir, 'src', f),
    (await import('node:fs')).readFileSync(join(process.cwd(), 'packages', 'eda-bridge', 'src', f), 'utf-8')
  )
}
const verificationIntelligenceDir = join(bridgeDir, 'verification-intelligence')
mkdirSync(join(verificationIntelligenceDir, 'src'), { recursive: true })
for (const f of ['engine.ts', 'types.ts', 'structural-analyzer.ts']) {
  writeFileSync(
    join(verificationIntelligenceDir, 'src', f),
    (await import('node:fs')).readFileSync(join(process.cwd(), 'packages', 'verification-intelligence-engine', 'src', f), 'utf-8')
  )
}
const work = join(bridgeDir, 'work')
mkdirSync(join(work, '.pi'), { recursive: true })
writeFileSync(join(work, '.pi', 'APPEND_SYSTEM.md'), 'test', 'utf-8')

// contextWindows（主进程按模型计算的有效上下文窗口）：
// - deepseek-v4-pro 登记表命中 1M，但 payload 覆盖值优先
// - my-selfhost-model 登记表查不到，仅靠 payload 覆盖值
// - deepseek-chat 无 payload 条目且登记表查不到，回退 128K/8192（向后兼容）
const providers = [{
  id: 'deepseek', name: 'DeepSeek', protocol: 'openai-compatible', baseUrl: 'https://api.deepseek.com', apiKey: 'sk-dummy',
  models: ['deepseek-chat', 'deepseek-v4-pro', 'my-selfhost-model'],
  contextWindows: {
    'deepseek-v4-pro': { contextWindow: 777_777, maxTokens: 8_888 },
    'my-selfhost-model': { contextWindow: 333_333, maxTokens: 4_096 }
  }
}, {
  // 自定义请求头透传验证（OpenCode Go 场景：x-opencode-session 会话头；
  // {{sessionId}} 占位符由主进程注入前替换，桥接收到的即最终值）。
  // 模型选 gpt-6-luna：本机 pi 全局配置可能自带 kimi-k3（重名会被先注册者占用），
  // 且该 ID 走新补的登记表规则（1.05M/128K），一并验证
  id: 'opencode', name: 'OpenCode Go', protocol: 'openai-compatible', baseUrl: 'https://opencode.ai/zen/go/v1', apiKey: 'sk-dummy',
  models: ['gpt-6-luna'],
  headers: { 'x-opencode-session': 'smoke-session-001' }
}]
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

// 上下文窗口注入断言：payload contextWindows 覆盖值优先，缺失条目回退登记表/兼容值
const modelsResp = await send({ type: 'get_available_models' })
const availableModels = modelsResp.data?.models ?? []
const byId = new Map(availableModels.map((m) => [m.id, m]))
const expectedContexts = {
  'deepseek-v4-pro': { contextWindow: 777_777, maxTokens: 8_888 }, // payload 覆盖 > 登记表 1M
  'my-selfhost-model': { contextWindow: 333_333, maxTokens: 4_096 }, // 仅 payload 覆盖值
  'deepseek-chat': { contextWindow: 1_048_576, maxTokens: 65_536 } // 无覆盖且登记表缺失 → 兼容回退（2026-10-13 起为 1M/64K 主流假设）
}
for (const [id, expected] of Object.entries(expectedContexts)) {
  const model = byId.get(id)
  if (!model || model.contextWindow !== expected.contextWindow || model.maxTokens !== expected.maxTokens) {
    console.error(`[context] 模型 ${id} 上下文窗口不符：期望 ${JSON.stringify(expected)}，实际 ${model ? JSON.stringify({ contextWindow: model.contextWindow, maxTokens: model.maxTokens }) : '(未注册)'}`)
    child.kill()
    process.exit(1)
  }
}
console.log('[context] contextWindows 覆盖/回退断言通过')

// 自定义请求头：带 headers 的 provider 注册成功（模型进入可用列表、新补的登记表规则命中 1.05M），
// 且桥接源码确实把 headers 透传给 pi.registerProvider
const opencodeModel = byId.get('gpt-6-luna')
if (!opencodeModel || opencodeModel.provider !== 'opencode' || opencodeModel.contextWindow !== 1_050_000 || opencodeModel.maxTokens !== 128_000) {
  console.error(`[headers] opencode/gpt-6-luna 注册不符：实际 ${opencodeModel ? JSON.stringify({ provider: opencodeModel.provider, contextWindow: opencodeModel.contextWindow, maxTokens: opencodeModel.maxTokens }) : '(未注册)'}`)
  child.kill()
  process.exit(1)
}
const bridgeSource = readFileSync(join(process.cwd(), 'resources', 'moonglass', 'pi-bridge', 'moonglass-providers.ts'), 'utf-8')
if (!bridgeSource.includes('headers: p.headers')) {
  console.error('[headers] moonglass-providers.ts 缺少 headers 透传（headers: p.headers）')
  child.kill()
  process.exit(1)
}
console.log('[headers] 自定义请求头 provider 注册与桥接透传断言通过')

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
  '聚类组',
  // VERIF-RUN-LOOP 批 3：propose_run_decision 工具注册与决策账本 schema（§9.2）
  "name: 'propose_run_decision'",
  'appendRunLoopDecisionLedger',
  "Type.Literal('rule-stall'",
  "Type.Literal('breaker-recovery'",
  "Type.Literal('user-instruction'",
  'expectedOutput',
  'stopCriteria',
  'decision-ledger.json',
  "input.source === 'human' ? 'approved' : 'proposed'",
  '工程师指令不审批'
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
// 2026-09-02 契约（PPA 通道）：run_logic_synthesis 支持 scenarioIds —— 综合成功即登记 scenario_hits 并重建态势
const synthesisBlock = toolsSource.slice(toolsSource.indexOf("name: 'run_logic_synthesis'"), toolsSource.indexOf("name: 'run_cdc_check'"))
for (const marker of ['scenarioIds', "'^SCN-[A-F0-9]{8}$'", 'writeScenarioHits', 'rebuildVerificationPosture', 'scenario_hits.json']) {
  if (!synthesisBlock.includes(marker)) {
    console.error(`[schema] run_logic_synthesis 缺少 PPA 证据通道标记：${marker}`)
    child.kill()
    process.exit(1)
  }
}
console.log('[schema] register_verification_intents / scenarioIds / 裁决缩权标记齐全')
child.kill()
process.exit(extErrors.length === 0 ? 0 : 1)
