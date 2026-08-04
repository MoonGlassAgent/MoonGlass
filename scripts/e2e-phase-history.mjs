/**
 * E2E 测试：验证阶段切换后 Agent 对话历史是否保留
 *
 * 需要：已构建应用（pnpm build）、已配置真实 Provider（本脚本使用应用中已有的 Key）
 * 运行：node scripts/e2e-phase-history.mjs
 */
import { _electron as electron } from 'playwright-core'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

const SHOT_DIR = join(process.cwd(), 'e2e-screenshots')
mkdirSync(SHOT_DIR, { recursive: true })

const electronBin = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')

const TEST_PROJECT_NAME = `E2E-History-${Date.now()}`
const PROMPT_REQ_SPEC = '完成需求-规格阶段最小交付：创建有有效内容的 product_requirements.md、module_specification.md、requirements_traceability.md 和 interface_spec.md；使用 REQ-FUNC-001 与 SPEC-FUNC-001 建立追溯关系。完成后用 5 个字介绍你自己'
const PROMPT_ARCH = '用 5 个字说明你的角色'

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function screenshot(page, name) {
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`) })
  console.log(`[screenshot] ${name}.png`)
}

async function waitForSessionReady(page, timeout = 60000) {
  // 等待下拉框出现且非占位 option 可用，并且 "会话启动中…" 消失
  await page.waitForSelector('select', { timeout })
  await page.waitForFunction(
    () => {
      const sel = document.querySelector('select')
      if (!sel) return false
      return sel.options.length > 1 && sel.options[1]?.value !== ''
    },
    { timeout }
  )
  await page.waitForFunction(
    () => !document.body.innerText.includes('会话启动中'),
    { timeout }
  )
  await sleep(800)
}

async function sendPrompt(page, text) {
  const ta = await page.$('textarea')
  if (!ta) throw new Error('找不到 textarea')
  await ta.click()
  await ta.fill('')
  await ta.fill(text)
  await sleep(300)
  await page.click('button:has-text("发送")')
  // 等待发送按钮重新出现（流式结束）
  await page.waitForSelector('button:has-text("发送")', { timeout: 90000 })
  await sleep(1500)
}

async function getMessageTexts(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('.whitespace-pre-wrap')].map((el) => el.textContent ?? '')
  )
}

async function navigateToProjects(page) {
  await page.click('nav a:has-text("项目")')
  await sleep(1000)
}

async function currentPhaseLabel(page) {
  return page.evaluate(() => {
    const el = document.querySelector('span:has-text("当前阶段")')
    return el?.textContent ?? ''
  })
}

async function main() {
  console.log('[e2e] launching electron...')
  const app = await electron.launch({
    executablePath: electronBin,
    args: [process.cwd()],
    timeout: 60000
  })

  // 收集渲染端日志
  const page = await app.firstWindow()
  page.on('console', (msg) => console.log('[renderer]', msg.type(), msg.text()))
  page.on('pageerror', (err) => console.error('[pageerror]', err.message))
  // 自动接受 confirm 对话框（回退/删除确认）
  page.on('dialog', async (dialog) => {
    console.log('[dialog]', dialog.type(), dialog.message().slice(0, 80))
    await dialog.accept()
  })
  await page.waitForLoadState('domcontentloaded')
  await sleep(3000)

  await screenshot(page, '01-launch')

  try {
    // 1. 进入项目列表
    await navigateToProjects(page)
    await screenshot(page, '02-projects')

    // 诊断：查看 provider 列表
    const providers = await page.evaluate(async () => await window.moonglass.llm.list())
    console.log(
      '[e2e] providers:',
      providers.map((p) => ({ id: p.id, enabled: p.enabled, hasKey: !!p.apiKey, models: p.models }))
    )

    // 2. 创建测试项目
    await page.click('button:has-text("新建项目")')
    await page.fill('input[placeholder*="项目名称"]', TEST_PROJECT_NAME)
    await page.click('button:has-text("创建")')
    await sleep(1500)
    await screenshot(page, '03-project-created')

    // 3. 点击进入项目工作区
    await page.click(`.rounded-lg:has-text("${TEST_PROJECT_NAME}")`)
    await waitForSessionReady(page)
    await screenshot(page, '04-workspace-req')

    // 4. 选择第一个可用模型
    const modelValue = await page.evaluate(() => {
      const sel = document.querySelector('select')
      if (!sel) return null
      for (const opt of sel.options) {
        if (opt.value) {
          sel.value = opt.value
          sel.dispatchEvent(new Event('change', { bubbles: true }))
          return opt.value
        }
      }
      return null
    })
    console.log('[e2e] selected model:', modelValue)
    if (!modelValue) throw new Error('没有可用模型')

    // 5. 在 REQ_SPEC 阶段发送第一条消息
    console.log('[e2e] sending REQ_SPEC prompt...')
    await sendPrompt(page, PROMPT_REQ_SPEC)
    await screenshot(page, '05-req-spec-response')

    const reqMessagesBefore = await getMessageTexts(page)
    console.log('[e2e] REQ_SPEC messages:', reqMessagesBefore)

    // 6. 推进到 ARCH
    console.log('[e2e] advancing to ARCH...')
    await page.click('button:has-text("推进到 ARCH")')
    await waitForSessionReady(page)
    await screenshot(page, '06-arch-entered')

    // 7. 在 ARCH 阶段发送第二条消息
    console.log('[e2e] sending ARCH prompt...')
    await sendPrompt(page, PROMPT_ARCH)
    await screenshot(page, '07-arch-response')

    const specMessages = await getMessageTexts(page)
    console.log('[e2e] ARCH messages:', specMessages)

    // 8. 回退到 REQ_SPEC，验证历史还在
    console.log('[e2e] rolling back to REQ_SPEC...')
    await page.click('button:has-text("回退到 REQ_SPEC")')
    await waitForSessionReady(page)
    await screenshot(page, '08-req-spec-after-rollback')

    const reqMessagesAfter = await getMessageTexts(page)
    console.log('[e2e] REQ_SPEC messages after rollback:', reqMessagesAfter)

    const reqHistoryPreserved = reqMessagesAfter.some((t) => t.includes(PROMPT_REQ_SPEC))
    console.log('[e2e] REQ_SPEC history preserved:', reqHistoryPreserved)

    // 9. 再次推进到 ARCH，验证 ARCH 历史还在
    console.log('[e2e] advancing to ARCH again...')
    await page.click('button:has-text("推进到 ARCH")')
    await waitForSessionReady(page)
    await screenshot(page, '09-arch-reentered')

    const specMessagesAfter = await getMessageTexts(page)
    console.log('[e2e] ARCH messages after re-enter:', specMessagesAfter)

    const specHistoryPreserved = specMessagesAfter.some((t) => t.includes(PROMPT_ARCH))
    console.log('[e2e] ARCH history preserved:', specHistoryPreserved)

    // 10. 结果
    const passed = reqHistoryPreserved && specHistoryPreserved
    console.log('')
    console.log(passed ? '✅ E2E 通过：阶段历史已保留' : '❌ E2E 失败：阶段历史未保留')

    // 清理：删除测试项目
    await navigateToProjects(page)
    await sleep(1500)
    const card = await page.$(`.rounded-lg:has-text("${TEST_PROJECT_NAME}")`)
    if (card) {
      await card.hover()
      await sleep(300)
      const deleteBtn = await card.$('button[title="删除项目"]')
      if (deleteBtn) {
        await deleteBtn.click()
        await sleep(1000)
        console.log('[e2e] test project deleted')
      }
    }

    await app.close()
    process.exit(passed ? 0 : 1)
  } catch (err) {
    console.error('[e2e] error:', err.message)
    await screenshot(page, '99-error')
    await app.close()
    process.exit(1)
  }
}

main()
