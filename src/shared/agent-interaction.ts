import type { AgentDecisionRequest, AgentDecisionResponse } from './types/moonglass'

export const DECISION_REQUEST_PREFIX = 'MOONGLASS_DECISION_REQUEST:'
export const DECISION_RESPONSE_PREFIX = 'MOONGLASS_DECISION_RESPONSE:'

function parsePayload<T>(text: string, prefix: string): T | undefined {
  const line = text.split(/\r?\n/).find((item) => item.startsWith(prefix))
  if (!line) return undefined
  try {
    return JSON.parse(line.slice(prefix.length)) as T
  } catch {
    return undefined
  }
}

export function parseDecisionRequest(text: string): AgentDecisionRequest | undefined {
  return parsePayload<AgentDecisionRequest>(text, DECISION_REQUEST_PREFIX)
}

export function parseDecisionResponse(text: string): AgentDecisionResponse | undefined {
  return parsePayload<AgentDecisionResponse>(text, DECISION_RESPONSE_PREFIX)
}

export function parseDecisionResponses(text: string): AgentDecisionResponse[] {
  return text.split(/\r?\n/).flatMap((line) => {
    if (!line.startsWith(DECISION_RESPONSE_PREFIX)) return []
    try {
      return [JSON.parse(line.slice(DECISION_RESPONSE_PREFIX.length)) as AgentDecisionResponse]
    } catch {
      return []
    }
  })
}

export function serializeDecisionResponse(
  request: AgentDecisionRequest,
  selectedIds: string[],
  customText: string
): string {
  const response: AgentDecisionResponse = {
    requestId: request.id,
    selectedIds,
    customText: customText.trim() || undefined
  }
  const labels = selectedIds
    .map((id) => request.options.find((option) => option.id === id)?.label)
    .filter((label): label is string => Boolean(label))
  const summary = [
    `已完成决策「${request.title}」。`,
    labels.length > 0 ? `选择：${labels.join('、')}` : '未选择预设项。',
    response.customText ? `补充要求：${response.customText}` : ''
  ].filter(Boolean).join('\n')
  return `${DECISION_RESPONSE_PREFIX}${JSON.stringify(response)}\n${summary}`
}


export function serializeDecisionResponses(
  decisions: Array<{ request: AgentDecisionRequest; selectedIds: string[]; customText: string }>
): string {
  return decisions.map(({ request, selectedIds, customText }) =>
    serializeDecisionResponse(request, selectedIds, customText)
  ).join('\n\n')
}
