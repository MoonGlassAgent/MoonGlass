/**
 * E2E 视觉验证：验证运行页签的「模块 UT」卡
 * 流程：隔离 userData 建项目 → sqlite 直接把项目拨到 VERIF → 工作区写入
 * ut-sessions.json（活跃 2 个模块）→ 打开验证运行页签截图。
 * 运行：node scripts/e2e-module-ut-card.mjs
 */
import { _electron as electron } from 'playwright-core'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const electronBin = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
const root = mkdtempSync(join(tmpdir(), 'moonglass-ut-card-'))
const userDataDir = join(root, 'userdata')
const ws = join(root, 'ws')
mkdirSync(userDataDir, { recursive: true })
mkdirSync(join(ws, 'rtl'), { recursive: true })
mkdirSync(join(ws, 'verification', 'results'), { recursive: true })
writeFileSync(join(ws, 'rtl', 'gmac_rx_mac.v'), 'module gmac_rx_mac(input wire clk); endmodule\n')
writeFileSync(join(ws, 'rtl', 'gmac_tx_mac.v'), 'module gmac_tx_mac(input wire clk); endmodule\n')
// 活跃 UT 锁：两个模块并行
writeFileSync(join(ws, 'verification', 'results', 'ut-sessions.json'), JSON.stringify({
  active: 1,
  sessions: [
    { module: 'gmac_tx_mac', state: 'active', startedAt: new Date().toISOString() }
  ]
}, null, 2))

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function launch() {
  return electron.launch({
    executablePath: electronBin,
    args: [process.cwd()],
    timeout: 60_000,
    env: { ...process.env, MOONGLASS_USERDATA: userDataDir }
  })
}

// 建项目：workspace 带 rtl/verification 结构 → 识别为既有项目 → initialPhase 生效
let app = await launch()
let page = await app.firstWindow()
await page.setViewportSize({ width: 1600, height: 900 })
await sleep(3500)
await page.click('nav a:has-text("项目")')
await sleep(600)
await page.evaluate(async () => {
  await window.moonglass.llm.upsert({
    id: 'ut-dummy', name: 'UTDummy', protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-dummy-ut', models: ['dummy-chat'], enabled: true, builtin: false
  })
})
const projectId = await page.evaluate(async ({ ws }) =>
  (await window.moonglass.project.create({ name: 'UT_Visual', workspacePath: ws, initialPhase: 'VERIF' })).id, { ws })
const phase = await page.evaluate(async (id) => (await window.moonglass.project.get(id))?.currentPhase, projectId)
console.log('project phase:', phase)

// 打开工作区 → 验证运行页签 → 截图（先切走再切回，强制项目列表重挂载）
await page.click('nav a:has-text("设置")')
await sleep(500)
await page.click('nav a:has-text("项目")')
await sleep(800)
await page.click('.project-card:has-text("UT_Visual")')
await sleep(4000)
// 进口项目（initialPhase=VERIF）会触发阶段产物漂移对账模态，先选「保持现状」放行
const driftButton = page.locator('button:has-text("保持现状")')
if (await driftButton.count()) { await driftButton.click(); await sleep(800) }
try {
  await page.click('button:has-text("验证运行")', { timeout: 15000 })
} catch (e) {
  await page.screenshot({ path: 'out/module-ut-debug.png' })
  console.log('debug screenshot saved')
  throw e
}
await sleep(1500)
await page.screenshot({ path: 'out/module-ut-card.png' })
console.log('screenshot: out/module-ut-card.png')

// 入口弹层：候选下拉 + 契约未生效的友好报错（startModuleUt 主进程未落地）
await page.click('button:text-is("发起模块 UT")')
await sleep(600)
await page.fill('#module-ut-candidates', '').catch(() => {})
const input = page.locator('input[list="module-ut-candidates"]')
await input.click()
await input.fill('gmac_rx_mac')
await page.click('button:text-is("发起")')
await sleep(1500)
const errorText = await page.locator('.text-red-600').last().textContent().catch(() => '')
console.log('dispatch immediate error:', errorText || '(无)')
console.log('派发无立即报错:', !errorText)
// 等 UT 会话标签出现（会话名 模块 UT <module>，经 listSessions 进入标签栏）
let tabFound = false
for (let i = 0; i < 20; i++) {
  await sleep(1000)
  const text = await page.evaluate(() => document.querySelector('.workspace-tabs')?.textContent ?? '')
  if (text.includes('模块 UT gmac_rx_mac')) { tabFound = true; break }
}
console.log('UT 会话标签出现:', tabFound)
await page.screenshot({ path: 'out/module-ut-dispatched.png' })
// 账本应登记新模块（主循环互斥挂起状态行包含 rx_mac）
const statusText = await page.evaluate(() => document.body.innerText)
console.log('状态行含新模块:', statusText.includes('gmac_rx_mac'))
await app.close()
