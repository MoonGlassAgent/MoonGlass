/**
 * model-context 登记表冒烟：
 * 聚合商前缀剥离（OpenRouter 实测落空回退 128K/8K 的回归）、版本点写法归一、
 * Groq 自带斜杠条目不受影响、未知型号回退 null、src/shared 与 pi-bridge 两副本口径一致。
 */
import assert from 'node:assert'

const shared = await import('../src/shared/model-context.ts')
const bridge = await import('../resources/moonglass/pi-bridge/model-context.ts')

// 1. 聚合商前缀剥离（用户实测：OpenRouter anthropic/claude-sonnet-5.5 曾回退 128K/8K）
const sonnet55 = shared.resolveModelContext('anthropic/claude-sonnet-5.5')
assert.equal(sonnet55?.contextWindow, 1_048_576, 'OpenRouter 带前缀 sonnet-5.5 应命中 1M')
assert.equal(sonnet55?.maxTokens, 128_000, 'sonnet-5.5 输出上限 128K')

// 2. 点写法/横线写法/无前缀均命中
assert.equal(shared.resolveModelContext('claude-sonnet-5.5')?.contextWindow, 1_048_576)
assert.equal(shared.resolveModelContext('claude-sonnet-5-5')?.contextWindow, 1_048_576)
assert.equal(shared.resolveModelContext('anthropic/claude-sonnet-5')?.contextWindow, 1_048_576, '带前缀的老型号也要命中')

// 3. Kimi Code 通道口径不回退（k3=1M 按档位解锁，k3-256k=256K）
assert.equal(shared.resolveModelContext('k3')?.contextWindow, 1_048_576)
assert.equal(shared.resolveModelContext('k3-256k')?.contextWindow, 262_144)

// 4. Groq 自带斜杠条目不被前缀剥离破坏（先试原样）
const groqOss = shared.resolveModelContext('openai/gpt-oss-120b')
assert.equal(groqOss?.contextWindow, 131_072, 'Groq openai/gpt-oss-120b 走原样匹配')

// 5. 未知型号回退 null（调用方走 FALLBACK）
assert.equal(shared.resolveModelContext('totally-unknown-model-xyz'), null)

// 6. 两副本口径一致（登记表是双副本维护，防漂移）
const sampleIds = [
  'k3', 'k3-256k', 'kimi-for-coding', 'anthropic/claude-sonnet-5.5', 'claude-opus-5',
  'deepseek-flash', 'glm-5.3-flash', 'gemini-3.8-flash', 'grok-4.7', 'minimax-m3',
  'qwen3.8-max', 'openai/gpt-oss-120b', 'totally-unknown-model-xyz'
]
for (const id of sampleIds) {
  assert.deepEqual(bridge.resolveModelContext(id), shared.resolveModelContext(id), `两副本解析不一致：${id}`)
}
assert.deepEqual(bridge.FALLBACK_MODEL_CONTEXT, shared.FALLBACK_MODEL_CONTEXT, '回退值两副本一致')

console.log('model-context-smoke: OK（聚合商前缀剥离/点写法归一/Groq 斜杠条目/回退/两副本一致）')
