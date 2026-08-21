import { PiRpcClient } from '../src/main/ai/runtime/pi/PiRpcClient.ts'

let failures = 0
function check(name, passed, detail = '') {
  if (passed) console.log(`✓ ${name}${detail ? ` — ${detail}` : ''}`)
  else {
    failures += 1
    console.error(`✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const client = new PiRpcClient({
  binPath: 'unused', args: [], cwd: process.cwd(), env: {},
  onEvent: () => {}, onExit: () => {}
})

let resolved = false
const settled = client.waitForEvent((event) => event.type === 'agent_settled', 1_000).then(() => { resolved = true })
client.handleLine(JSON.stringify({ type: 'message_update' }))
await new Promise((resolve) => setTimeout(resolve, 10))
check('无关事件不会提前结束等待', resolved === false)
client.handleLine(JSON.stringify({ type: 'agent_settled' }))
await settled
check('agent_settled 正确结束等待', resolved === true)

let disposed = false
const interrupted = client.waitForEvent(() => true, 1_000).catch((error) => {
  disposed = String(error).includes('客户端已销毁')
})
client.dispose()
await interrupted
check('销毁客户端会释放事件等待者', disposed)

console.log('')
console.log(failures === 0 ? '✅ Pi RPC 事件等待冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
