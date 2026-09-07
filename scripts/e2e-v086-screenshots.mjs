/**
 * E2E 截图：为 v0.8.6 功能全景文档采集真实界面截图
 *
 * 需要：已构建应用（pnpm build）、真实 userData（本机已有 MoonGlass_NPU 等项目）
 * 运行：node scripts/e2e-v086-screenshots.mjs
 * 产出：docs/images/v086/*.png
 */
import { _electron as electron } from 'playwright-core'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const SHOT_DIR = join(process.cwd(), 'docs', 'images', 'v086')
mkdirSync(SHOT_DIR, { recursive: true })

const electronBin = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
const PROJECT = 'MoonGlass_NPU'

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function shot(page, name) {
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) })
  console.log(`[screenshot] ${name}.png`)
}

async function waitWorkspaceReady(page, timeout = 120000) {
  await page.waitForSelector('select', { timeout })
  await page.waitForFunction(
    () => {
      const sel = document.querySelector('select')
      if (!sel) return false
      return sel.options.length > 1 && sel.options[1]?.value !== ''
    },
    { timeout }
  )
  await page.waitForFunction(() => !document.body.innerText.includes('会话启动中'), { timeout })
  await sleep(1000)
}

async function main() {
  console.log('[e2e] launching electron...')
  const app = await electron.launch({
    executablePath: electronBin,
    args: [process.cwd()],
    timeout: 60000
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1920, height: 1080 })
  page.on('dialog', async (dialog) => {
    console.log('[dialog]', dialog.type(), dialog.message().slice(0, 60))
    await dialog.accept()
  })
  await page.waitForLoadState('domcontentloaded')
  await sleep(3500)

  // 1. 项目总览
  await page.click('nav a:has-text("项目")')
  await sleep(1500)
  await page.evaluate(() => {
    const publicProjects = ['MoonGlass_NPU', 'MIC_NPU', 'MoonGlass_DMA', 'CLK_DIV_FRA']
    document.querySelectorAll('.project-card').forEach((card) => {
      if (!publicProjects.some((name) => card.textContent?.includes(name))) card.remove()
    })
  })
  await shot(page, '01-projects')

  // 2. 进入 MoonGlass_NPU 工作区（VERIF 阶段）
  await page.click(`.project-card:has-text("${PROJECT}")`)
  await waitWorkspaceReady(page)
  await sleep(1500)
  await shot(page, '02-workspace-verif')

  // 3. 验证态势（W0-W3 全屏视图）
  await page.click('a:has-text("验证态势")')
  await page.waitForSelector('text=W3', { timeout: 30000 })
  await sleep(1500)
  await shot(page, '03-verification-posture')

  // 4. RTL Design Browser（先回工作区，入口在工作区页头）
  await page.click('a:has-text("工作区")')
  await waitWorkspaceReady(page)
  await sleep(800)
  await page.click('a:has-text("RTL Design Browser")')
  await page.waitForSelector('text=HIERARCHY', { timeout: 60000 })
  await page.waitForSelector('text=SIGNALS', { timeout: 30000 })
  await sleep(2500)
  await page.evaluate(() => {
    document.querySelectorAll('button').forEach((button) => {
      if (/^\$(?:not|eq|proc)/.test(button.textContent?.trim() ?? '')) button.remove()
    })
  })
  await shot(page, '04-design-browser')

  // 5. 选中信号 → 跨层次追踪树（选 AHB 地址信号：load 可下钻进 u_regif）
  const signals = page.locator('button:has-text("i_hs_haddr")')
  if (await signals.count() > 0) {
    await signals.first().click()
    await page.waitForSelector('text=DRIVERS', { timeout: 15000 })
    await sleep(600)
    const expanders = page.locator('button[aria-label="展开追踪"]')
    if (await expanders.count() > 0) {
      await expanders.first().click()
      await sleep(800)
    }
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach((button) => {
        if (/^\$(?:not|eq|proc)/.test(button.textContent?.trim() ?? '')) button.remove()
      })
    })
    await shot(page, '05-design-browser-trace')
  } else {
    console.log('[skip] 无可点击信号，跳过追踪截图')
  }

  // 6. 设置页（遮罩可能的明文 Key 后再截图）
  await page.click('nav a:has-text("设置")')
  await sleep(1500)
  await page.evaluate(() => {
    document.querySelectorAll('input').forEach((i) => {
      if (i.value && i.value.length > 12) i.type = 'password'
    })
  })
  await shot(page, '06-settings')

  // 7. 设置页下半段：开发环境与 EDA 工具链
  const toolchainHeading = page.getByText('开发环境与 EDA 工具链', { exact: true })
  if (await toolchainHeading.count()) {
    await toolchainHeading.scrollIntoViewIfNeeded()
    await sleep(800)
    await shot(page, '07-toolchain')
  }

  // 8. 关于、授权与使用入口
  await page.click('nav a:has-text("关于")')
  await page.waitForSelector('text=授权信息', { timeout: 15000 })
  await sleep(800)
  await shot(page, '08-about')

  await app.close()
  console.log('[e2e] done')
}

main().catch((err) => {
  console.error('[e2e] failed:', err)
  process.exit(1)
})
