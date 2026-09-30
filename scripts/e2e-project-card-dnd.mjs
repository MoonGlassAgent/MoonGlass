/**
 * E2E 冒烟：项目卡片长按拖拽排序
 *
 * 验证：① 长按（>350ms）卡片任意位置启动拖拽（幽灵卡出现、原位变占位框）；
 * ② 拖动到目标卡片上方时实时重排（占位框移动）；③ 松手后顺序持久化到
 * localStorage(moonglass:project-order) 且刷新后保持；④ 短按不触发拖拽（顺序不变）。
 *
 * 需要：pnpm build 产物（out/）。
 * 运行：node scripts/e2e-project-card-dnd.mjs
 */
import { _electron as electron } from 'playwright-core'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const KEEP = process.argv.includes('--keep')
const electronBin = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
const root = mkdtempSync(join(tmpdir(), 'moonglass-card-dnd-'))
const userDataDir = join(root, 'userdata')
const workspaceRoot = join(root, 'workspaces')
mkdirSync(userDataDir, { recursive: true })
mkdirSync(workspaceRoot, { recursive: true })

const PROJECT_NAMES = ['Alpha_DMA', 'Bravo_NPU', 'Charlie_APB', 'Delta_FIFO', 'Echo_GMAC', 'Foxtrot_PLL']

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures += 1
}

async function cardOrder(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-project-card] h3')].map((el) => el.textContent)
  )
}

async function main() {
  const app = await electron.launch({
    executablePath: electronBin,
    args: [process.cwd()],
    timeout: 60_000,
    env: { ...process.env, MOONGLASS_USERDATA: userDataDir }
  })
  try {
    const page = await app.firstWindow()
    await page.setViewportSize({ width: 1600, height: 900 })
    page.on('pageerror', (err) => console.error('[pageerror]', err.message))
    await page.waitForLoadState('domcontentloaded')
    await sleep(2500)
    // 初始路由不落项目页（显示 Not Found），需点击侧边导航
    await page.click('nav a:has-text("项目")')
    await sleep(800)

    // 建 6 个测试项目
    for (const name of PROJECT_NAMES) {
      await page.evaluate(
        async ({ name, ws }) => {
          await window.moonglass.project.create({ name, workspacePath: ws })
        },
        { name, ws: join(workspaceRoot, name) }
      )
    }
    // 回到项目列表（切走再切回强制重挂载；file:// 下不能 page.reload）
    await page.click('nav a:has-text("设置")')
    await sleep(800)
    await page.click('nav a:has-text("项目")')
    await page.waitForSelector('[data-project-card]', { timeout: 30_000 })

    const initial = await cardOrder(page)
    console.log('初始顺序:', initial.join(' → '))
    check('初始 6 张卡片', initial.length === 6)

    // ---- 短按（普通点击姿态：按下 100ms 松开，不移动）不应触发拖拽 ----
    const first = await page.locator('[data-project-card] h3').first().boundingBox()
    if (!first) throw new Error('找不到首张卡片')
    const cx = first.x + first.width / 2
    const cy = first.y + first.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await sleep(100)
    await page.mouse.up()
    await sleep(600)
    // 短按=普通点击：进入项目工作区是正确行为；返回项目列表后顺序应保持不变
    await page.click('nav a:has-text("项目")')
    await page.waitForSelector('[data-project-card]', { timeout: 30_000 })
    const afterShort = await cardOrder(page)
    check('短按不改变顺序（点击进项目属正常链接行为）', JSON.stringify(afterShort) === JSON.stringify(initial))
    check('短按不出现幽灵卡', await page.locator('.pointer-events-none.fixed.z-50').count() === 0)

    // ---- 长按第 1 张，拖到第 4 张上 ----
    const cards = await page.locator('[data-project-card] h3').all()
    const b1 = await cards[0].boundingBox()
    const b4 = await cards[3].boundingBox()
    if (!b1 || !b4) throw new Error('卡片定位失败')
    const sx = b1.x + b1.width / 2
    const sy = b1.y + b1.height / 2
    const tx = b4.x + b4.width / 2
    const ty = b4.y + b4.height / 2
    await page.mouse.move(sx, sy)
    await page.mouse.down()
    await sleep(500) // 超过 350ms 长按阈值
    check('长按后幽灵卡出现', await page.locator('.pointer-events-none.fixed.z-50').count() === 1)
    check('原位变占位框', await page.locator('.border-dashed').count() >= 1)
    // 分步移动到目标上方（触发 pointermove 实时重排）
    await page.mouse.move((sx + tx) / 2, (sy + ty) / 2, { steps: 5 })
    await sleep(250)
    await page.mouse.move(tx, ty, { steps: 5 })
    await sleep(400)
    const during = await page.evaluate(() =>
      [...document.querySelectorAll('[data-project-card]')].map((el) =>
        el.querySelector('.border-dashed') ? `@${el.textContent.trim().slice(0, 12)}` : el.querySelector('h3')?.textContent
      )
    )
    console.log('拖动中顺序(@=占位):', during.join(' → '))
    const placeholderIndex = during.findIndex((item) => typeof item === 'string' && item.startsWith('@'))
    check('拖动中占位框已移动到目标位置', placeholderIndex >= 2, `占位在第 ${placeholderIndex + 1} 位`)
    await page.mouse.up()
    await sleep(400)

    const after = await cardOrder(page)
    console.log('松手后顺序:', after.join(' → '))
    check('拖拽后幽灵卡消失', await page.locator('.pointer-events-none.fixed.z-50').count() === 0)
    const movedName = initial[0]
    const newIndex = after.indexOf(movedName)
    check('首卡已被拖走（不在第 1 位）', newIndex > 0, `${movedName} 现居第 ${newIndex + 1} 位`)
    check('总卡片数不变', after.length === initial.length)

    // ---- 持久化：localStorage 与刷新后顺序一致 ----
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('moonglass:project-order') ?? '[]'))
    check('localStorage 已持久化顺序', saved.length === after.length)
    await page.click('nav a:has-text("设置")')
    await sleep(800)
    await page.click('nav a:has-text("项目")')
    await page.waitForSelector('[data-project-card]', { timeout: 30_000 })
    const afterReload = await cardOrder(page)
    check('刷新后顺序保持', JSON.stringify(afterReload) === JSON.stringify(after), afterReload.join(' → '))

    // ---- 连续第二次拖拽（用户报告：第一次成功后后续拖拽失败） ----
    const cards2 = await page.locator('[data-project-card] h3').all()
    const dragged2 = await cards2[1].textContent()
    const c1 = await cards2[1].boundingBox()
    const c5 = await cards2[4].boundingBox()
    if (!c1 || !c5) throw new Error('第二次拖拽卡片定位失败')
    const s2x = c1.x + c1.width / 2
    const s2y = c1.y + c1.height / 2
    await page.mouse.move(s2x, s2y)
    await page.mouse.down()
    await sleep(500)
    check('第二次长按仍能启动拖拽（幽灵卡出现）', await page.locator('.pointer-events-none.fixed.z-50').count() === 1)
    await page.mouse.move(c5.x + c5.width / 2, c5.y + c5.height / 2, { steps: 8 })
    await sleep(400)
    await page.mouse.up()
    await sleep(400)
    const after2 = await cardOrder(page)
    console.log('第二次拖拽后顺序:', after2.join(' → '))
    check('第二次拖拽生效（被拖卡移位）', after2.indexOf(dragged2) >= 2, `${dragged2} 现居第 ${after2.indexOf(dragged2) + 1} 位`)

    // ---- 连续第三次拖拽 ----
    const cards3 = await page.locator('[data-project-card] h3').all()
    const d0 = await cards3[0].boundingBox()
    const d2 = await cards3[2].boundingBox()
    if (!d0 || !d2) throw new Error('第三次拖拽卡片定位失败')
    await page.mouse.move(d0.x + d0.width / 2, d0.y + d0.height / 2)
    await page.mouse.down()
    await sleep(500)
    check('第三次长按仍能启动拖拽', await page.locator('.pointer-events-none.fixed.z-50').count() === 1)
    await page.mouse.move(d2.x + d2.width / 2, d2.y + d2.height / 2, { steps: 8 })
    await sleep(400)
    await page.mouse.up()
    await sleep(400)
    const after3 = await cardOrder(page)
    console.log('第三次拖拽后顺序:', after3.join(' → '))
    check('第三次拖拽生效（顺序变化）', JSON.stringify(after3) !== JSON.stringify(after2), after3.join(' → '))

    // 清理测试项目
    await page.evaluate(async () => {
      const list = await window.moonglass.project.list()
      for (const p of list) await window.moonglass.project.delete(p.id)
    })
    await app.close()
  } catch (err) {
    console.error('[e2e] failed:', err)
    await app.close().catch(() => {})
    if (!KEEP) rmSync(root, { recursive: true, force: true })
    process.exit(1)
  } finally {
    if (!KEEP) rmSync(root, { recursive: true, force: true })
  }
  console.log(failures === 0 ? '\n✅ 项目卡片长按拖拽 E2E 冒烟通过' : `\n❌ ${failures} 项失败`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
