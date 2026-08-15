import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

const {
  parseDecisionRequest,
  parseDecisionResponse,
  parseDecisionResponses,
  serializeDecisionResponse
} = await import('../src/shared/agent-interaction.ts')

const request = {
  id: 'spec.data_width',
  title: '选择数据位宽',
  mode: 'single',
  options: [
    { id: '32', label: '32 bit', recommended: true },
    { id: '64', label: '64 bit' }
  ],
  allowCustom: true,
  required: true
}

let failures = 0
function check(name, condition) {
  console.log(`${condition ? '✓' : '✗'} ${name}`)
  if (!condition) failures++
}

const requestText = `MOONGLASS_DECISION_REQUEST:${JSON.stringify(request)}\n等待用户回答。`
check('解析结构化决策请求', parseDecisionRequest(requestText)?.id === request.id)

const selectedText = serializeDecisionResponse(request, ['32'], '')
const selected = parseDecisionResponse(selectedText)
check('解析预设选项回复', selected?.selectedIds[0] === '32' && !selected.customText)
check('回复包含可读摘要', selectedText.includes('选择：32 bit'))

const customText = serializeDecisionResponse(request, [], '采用 48 bit，并保留参数化能力')
const custom = parseDecisionResponse(customText)
check('支持仅填写用户自定义要求', custom?.selectedIds.length === 0 && custom.customText?.includes('48 bit'))
check('损坏载荷不会导致异常', parseDecisionResponse('MOONGLASS_DECISION_RESPONSE:{bad json') === undefined)

const batchText = `${selectedText}\n\n${customText}`
const batch = parseDecisionResponses(batchText)
check('支持一轮提交多个决策回复', batch.length === 2 && batch[0].requestId === request.id)

console.log('')
console.log(failures === 0 ? '✅ Agent 结构化交互冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
