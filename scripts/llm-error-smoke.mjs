import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

const {
  humanizeLlmError,
  isStalled,
  LLM_STALL_THRESHOLD_MS,
  switchModelWithProbe
} = await import('../src/shared/llm-resilience.ts')

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

// ---- humanizeLlmError：六类映射 + 原文保留 + 其他原样返回 ----
const cases = [
  ['402 status code (no body)', '模型服务余额不足或套餐已过期，请充值或切换其他模型'],
  ['401 Unauthorized', 'API Key 无效或无权限访问该模型，请检查设置页的模型服务配置'],
  ['403 Forbidden', 'API Key 无效或无权限访问该模型，请检查设置页的模型服务配置'],
  ['404 model not found', '模型不存在或已下线，请切换模型'],
  ['429 Too Many Requests', '模型服务限流，请稍后重试或切换模型'],
  ['500 Internal Server Error', '模型服务暂时不可用，请稍后重试'],
  ['504 Gateway Timeout', '模型服务暂时不可用，请稍后重试'],
  ['ETIMEDOUT connection timed out', '模型服务暂时不可用，请稍后重试'],
  ['read ECONNRESET', '模型服务暂时不可用，请稍后重试']
]
for (const [raw, expected] of cases) {
  const out = humanizeLlmError(raw)
  check(`映射：${raw.slice(0, 30)}`, out.startsWith(expected) && out.includes(`（${raw}）`), out)
}
const passthrough = humanizeLlmError('some other failure')
check('其他原样返回', passthrough === 'some other failure', passthrough)

// ---- isStalled：纯逻辑边界 ----
const now = 1_000_000
check('停滞：流式中+无工具+超时', isStalled(true, 0, now - LLM_STALL_THRESHOLD_MS - 1, now) === true)
check('非停滞：未流式', isStalled(false, 0, now - LLM_STALL_THRESHOLD_MS - 1, now) === false)
check('非停滞：工具在飞', isStalled(true, 1, now - LLM_STALL_THRESHOLD_MS - 1, now) === false)
check('非停滞：阈值内', isStalled(true, 0, now - LLM_STALL_THRESHOLD_MS + 10_000, now) === false)
check('非停滞：恰好在阈值（须超过）', isStalled(true, 0, now - LLM_STALL_THRESHOLD_MS, now) === false)

// ---- switchModelWithProbe：可注入假 client 的回滚路径 ----
function fakeClient(failWith) {
  return {
    command: async () => ({}),
    waitForEvent: async () =>
      failWith
        ? { type: 'message_update', assistantMessageEvent: { type: 'error', errorMessage: failWith } }
        : { type: 'agent_settled' }
  }
}

// 探活失败 → 回滚到原模型并抛原始错误
{
  const switches = []
  let thrown = null
  try {
    await switchModelWithProbe({
      client: fakeClient('402 status code (no body)'),
      applySwitch: async (p, m) => { switches.push(`${p}/${m}`) },
      providerId: 'glm',
      modelId: 'glm-5.3-flash',
      previous: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' }
    })
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error)
  }
  check('探活失败抛出原始错误', thrown === '402 status code (no body)', thrown)
  check('探活失败回滚到原模型', switches.join(',') === 'glm/glm-5.3-flash,deepseek/deepseek-v4-flash', switches.join(','))
}

// 探活成功 → 不回滚
{
  const switches = []
  await switchModelWithProbe({
    client: fakeClient(null),
    applySwitch: async (p, m) => { switches.push(`${p}/${m}`) },
    providerId: 'glm',
    modelId: 'glm-5.3-flash',
    previous: { providerId: 'deepseek', modelId: 'deepseek-v4-flash' }
  })
  check('探活成功不回滚', switches.length === 1 && switches[0] === 'glm/glm-5.3-flash', switches.join(','))
}

// 无原选择 → 探活失败不回滚（无可回滚目标）
{
  const switches = []
  let thrown = null
  try {
    await switchModelWithProbe({
      client: fakeClient('500 server error'),
      applySwitch: async (p, m) => { switches.push(`${p}/${m}`) },
      providerId: 'glm',
      modelId: 'glm-5.3-flash',
      previous: null
    })
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error)
  }
  check('无原选择不回滚', switches.length === 1, switches.join(','))
  check('无原选择仍抛错', thrown === '500 server error', thrown)
}

console.log('')
console.log(failures === 0 ? '✅ LLM 错误语义化与停滞判定冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
