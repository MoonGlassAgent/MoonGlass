// 待人处理聚合（pending-actions）冒烟：合成会话 JSONL + 决策账本，验证两路计数与缓存
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { collectPendingActions } = await import('../src/main/services/pending-actions.ts')

const root = mkdtempSync(join(tmpdir(), 'moonglass-pending-actions-'))
const workspace = join(root, 'ws')
const sessionDir = join(root, 'sessions')
mkdirSync(join(workspace, 'verification', 'results'), { recursive: true })
mkdirSync(sessionDir, { recursive: true })

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const msg = (role, text) => JSON.stringify({
  type: 'message', id: Math.random().toString(36).slice(2, 10), parentId: null,
  timestamp: new Date().toISOString(),
  message: { role, content: [{ type: 'text', text }], timestamp: Date.now() }
})
const header = JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: new Date().toISOString(), cwd: workspace })

// 会话 A：两个决策请求，一个已答复
writeFileSync(join(sessionDir, 'session-phase-verif.jsonl'), [
  header,
  msg('tool', 'MOONGLASS_DECISION_REQUEST:{"id":"R1","title":"是否合并场景","options":[],"mode":"single","required":true}'),
  msg('tool', 'MOONGLASS_DECISION_REQUEST:{"id":"R2","title":"是否扩大边界","options":[],"mode":"single","required":true}'),
  msg('user', 'MOONGLASS_DECISION_RESPONSE:{"requestId":"R1","selectedIds":["a"],"customText":""}')
].join('\n') + '\n')
// 会话 B：一个未答复请求
writeFileSync(join(sessionDir, 'session-phase-verif--task-x.jsonl'), [
  header,
  msg('tool', 'MOONGLASS_DECISION_REQUEST:{"id":"R3","title":"批准诊断升级","options":[],"mode":"single","required":true}')
].join('\n') + '\n')
// 账本：2 条 proposed + 1 条 approved
writeFileSync(join(workspace, 'verification', 'results', 'decision-ledger.json'), JSON.stringify({
  version: 1,
  decisions: [
    { id: 'DEC-AAAA', status: 'proposed', trigger: 'token-budget' },
    { id: 'DEC-BBBB', status: 'proposed', trigger: 'rule-stall' },
    { id: 'DEC-CCCC', status: 'approved', trigger: 'manual' }
  ]
}))

const result = collectPendingActions(workspace, sessionDir)
check('聚合非空', result !== null)
check('会话待确认 2 项（R2+R3，R1 已答复）', result?.decisionRequests === 2, String(result?.decisionRequests))
check('循环待裁决 2 项（approved 不计）', result?.loopDecisions === 2, String(result?.loopDecisions))
check('标题清单含请求与提案', result?.titles.includes('是否扩大边界') && result?.titles.some((x) => x.includes('DEC-BBBB')), JSON.stringify(result?.titles))

// 答复 R2/R3 后应只剩账本 2 项（验证 mtime 缓存失效重扫）
const fileA = readFileSync(join(sessionDir, 'session-phase-verif.jsonl'), 'utf-8') + msg('user', 'MOONGLASS_DECISION_RESPONSE:{"requestId":"R2","selectedIds":["b"],"customText":""}') + '\n'
writeFileSync(join(sessionDir, 'session-phase-verif.jsonl'), fileA)
const fileB = readFileSync(join(sessionDir, 'session-phase-verif--task-x.jsonl'), 'utf-8') + msg('user', 'MOONGLASS_DECISION_RESPONSE:{"requestId":"R3","selectedIds":["a"],"customText":""}') + '\n'
writeFileSync(join(sessionDir, 'session-phase-verif--task-x.jsonl'), fileB)
const after = collectPendingActions(workspace, sessionDir)
check('答复后会话待确认归零（缓存正确失效）', after?.decisionRequests === 0, String(after?.decisionRequests))
check('账本提案保持 2 项', after?.loopDecisions === 2)

// 空项目返回 null
const emptyWs = join(root, 'empty')
mkdirSync(emptyWs, { recursive: true })
check('无待处理项返回 null', collectPendingActions(emptyWs, join(root, 'no-sessions')) === null)

console.log(failures === 0 ? '\n✅ 待人处理聚合冒烟通过' : `\n❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
