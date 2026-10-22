/**
 * E2E 视觉验证：项目卡片「待处理」通知徽标
 * 流程：隔离 userData 建项目 → 写入含未答复决策请求的会话 JSONL + 含 proposed 提案的
 * decision-ledger.json → 项目列表页截图，断言徽标出现且计数正确。
 * 运行：node scripts/e2e-project-pending-badge.mjs
 */
import { _electron as electron } from 'playwright-core'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const electronBin = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
const root = mkdtempSync(join(tmpdir(), 'moonglass-pending-badge-'))
const userDataDir = join(root, 'userdata')
const ws = join(root, 'ws')
mkdirSync(userDataDir, { recursive: true })
mkdirSync(join(ws, 'verification', 'results'), { recursive: true })

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const app = await electron.launch({
  executablePath: electronBin,
  args: [process.cwd()],
  timeout: 60_000,
  env: { ...process.env, MOONGLASS_USERDATA: userDataDir }
})
try {
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1600, height: 900 })
  await sleep(3500)
  await page.click('nav a:has-text("项目")')
  await sleep(600)
  const projectId = await page.evaluate(async ({ ws }) => (await window.moonglass.project.create({ name: 'PendingBadge_Check', workspacePath: ws })).id, { ws })

  // 写入待人处理数据：会话待确认决策 1 项 + 循环待裁决提案 2 项
  const sessionDir = join(userDataDir, 'moonglass', 'pi-sessions', projectId)
  mkdirSync(sessionDir, { recursive: true })
  const msg = (role, text) => JSON.stringify({
    type: 'message', id: Math.random().toString(36).slice(2, 10), parentId: null,
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: 'text', text }], timestamp: Date.now() }
  })
  writeFileSync(join(sessionDir, 'session-phase-req_spec.jsonl'), [
    JSON.stringify({ type: 'session', version: 3, id: 's1', timestamp: new Date().toISOString(), cwd: ws }),
    msg('tool', 'MOONGLASS_DECISION_REQUEST:{"id":"R9","title":"是否采用占位规格","options":[],"mode":"single","required":true}')
  ].join('\n') + '\n')
  writeFileSync(join(ws, 'verification', 'results', 'decision-ledger.json'), JSON.stringify({
    version: 1,
    decisions: [
      { id: 'DEC-1111AAAA', status: 'proposed', trigger: 'token-budget' },
      { id: 'DEC-2222BBBB', status: 'proposed', trigger: 'rule-stall' }
    ]
  }))

  // 回到项目列表等待 3s 轮询刷新
  await page.click('nav a:has-text("设置")')
  await sleep(500)
  await page.click('nav a:has-text("项目")')
  await sleep(4500)
  await page.screenshot({ path: 'out/pending-badge.png' })

  const cardText = await page.evaluate(() => {
    const card = document.querySelector('.project-card')
    return card ? card.textContent ?? '' : ''
  })
  console.log('card text:', cardText.slice(0, 120))
  check('待处理徽标出现且计数为 3', cardText.includes('待处理 3'), cardText.slice(0, 80))

  await page.evaluate(async (id) => { await window.moonglass.project.delete(id) }, projectId)
  await app.close()
} catch (err) {
  console.error('[e2e] failed:', err)
  await app.close().catch(() => {})
  process.exit(1)
} finally {
  rmSafe(root)
}
function rmSafe(dir) { try { rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ } }
import { rmSync } from 'node:fs'
console.log(failures === 0 ? '\n✅ 项目卡片待处理徽标 E2E 通过' : `\n❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
