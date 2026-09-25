/**
 * 聊天输入框键入延迟复现 / 回归脚本（诊断脚本，保留入库）
 *
 * 背景：VERIF 阶段 3.6M token 巨型会话中，聊天输入框"无法键入但可以粘贴"。
 * 粘贴是单事件，键入是连续按键（中文 IME 组合对长帧更敏感），
 * 故用"逐字符键入延迟"量化 ChatPanel 在巨型会话下的渲染阻塞。
 *
 * 方法：
 *   1. 以隔离 MOONGLASS_USERDATA 启动已构建应用（不碰真实 userData）；
 *   2. 注入假 Provider（pi 可离线 spawn，不发真实 LLM 请求）并创建测试项目；
 *   3. 在空会话（REQ_SPEC）测基线键入延迟；
 *   4. 进入 VERIF 阶段，待 pi 生成合法 session 文件头后，覆写为
 *      320 条消息 / ~10MB 的巨型 JSONL（模拟 3.6M token 会话）；
 *   5. 重进工作区让 UI 加载巨型会话，再测一次键入延迟；
 *   6. 输出空会话 vs 巨型会话对照表，并记录焦点漂移 / disabled 抖动。
 *
 * 需要：pnpm build 产物（out/）。
 * 运行：node scripts/chat-input-perf-repro.mjs [--keep]
 */
import { _electron as electron } from 'playwright-core'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

const KEEP = process.argv.includes('--keep')
const KEY_COUNT = 24
const PER_KEY_TIMEOUT_MS = 10_000
const GIANT_MESSAGES = 320 // 与 chatStore MAX_LIVE_MESSAGES / UI_HISTORY_MAX 一致

const electronBin = join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe')
const root = mkdtempSync(join(tmpdir(), 'moonglass-chat-perf-'))
const appDataDir = join(root, 'appdata')
const workspaceDir = join(root, 'workspace')
mkdirSync(appDataDir, { recursive: true })
mkdirSync(workspaceDir, { recursive: true })

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 生成一条 ~30-50k 字符的 markdown 消息体（含表格 / 代码块 / 文件引用 / 图片 alt 文本） */
function bigMarkdown(seed) {
  const block = [
    `## 验证批次分析报告（#${seed}）`,
    '',
    `本次回归覆盖场景 group_${seed % 7}，共执行 ${(seed * 37) % 500} 条用例，失败 ${seed % 5} 条。`,
    `涉及文件 rtl/core/axi_interconnect_${seed % 9}.sv:${(seed * 13) % 900 + 1} 与 tb/env/scoreboard_${seed % 4}.sv:${(seed * 29) % 700 + 1}。`,
    '',
    '| 用例 | 结果 | 耗时(ms) | 覆盖率 |',
    '| --- | --- | --- | --- |',
    ...Array.from({ length: 8 }, (_, i) => `| tc_${seed}_${i} | ${i % 3 ? 'PASS' : 'FAIL'} | ${(seed * (i + 3)) % 997} | ${(80 + (seed + i) % 20)}.${i}% |`),
    '',
    '```systemverilog',
    `always_ff @(posedge clk_${seed % 3}) begin`,
    `  if (!rst_n_${seed % 2}) q_${seed % 11} <= '0;`,
    `  else q_${seed % 11} <= d_${seed % 11} & mask_${seed % 5};`,
    'end',
    '```',
    '',
    `![waveform_${seed}](attachments/wave_${seed}.png) 波形见附件，建立时间裕量 ${(seed % 9) / 10}ns。`,
    ''
  ].join('\n')
  // 目标长度在 30k~50k 间按 seed 抖动
  const target = 30_000 + (seed % 20) * 1000
  return block.repeat(Math.ceil(target / block.length)).slice(0, target)
}

/** 生成巨型会话 JSONL 正文（不含首行 header）：320 条 user/assistant 交替消息 */
function buildGiantSessionBody() {
  const lines = []
  let parentId = null
  const baseTime = Date.now() - 3_600_000
  for (let i = 0; i < GIANT_MESSAGES; i++) {
    const id = (0x10000000 + i).toString(16)
    const ts = baseTime + i * 5000
    const isUser = i % 2 === 0
    const message = isUser
      ? { role: 'user', content: bigMarkdown(i), timestamp: ts }
      : {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: `分析第 ${i} 轮验证结果的推理过程……`.repeat(200) },
            { type: 'text', text: bigMarkdown(i) }
          ],
          api: 'openai-compatible',
          provider: 'perf-dummy',
          model: 'dummy-chat',
          usage: { input: 10000, output: 5000, cacheRead: 0, cacheWrite: 0, totalTokens: 15000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: 'stop',
          timestamp: ts
        }
    lines.push(JSON.stringify({
      type: 'message', id, parentId,
      timestamp: new Date(ts).toISOString(),
      message
    }))
    parentId = id
  }
  return lines.join('\n')
}

async function waitSessionReady(page, timeout = 120_000) {
  await page.waitForSelector('.chat-composer textarea', { timeout })
  await page.waitForFunction(
    () => !document.body.innerText.includes('会话启动中'),
    { timeout }
  )
  await page.waitForFunction(
    () => {
      const ta = document.querySelector('.chat-composer textarea')
      return ta && !ta.disabled
    },
    { timeout }
  )
  await sleep(500)
}

async function gotoWorkspace(page, projectName) {
  await page.click('nav a:has-text("项目")')
  await page.waitForSelector(`.project-card:has-text("${projectName}")`, { timeout: 30_000 })
  await page.click(`.project-card:has-text("${projectName}")`)
  await waitSessionReady(page)
}

/**
 * 逐字符键入并量化：
 * - node 侧：按下 → textarea.value 长度 +1 的端到端延迟（含 CDP 开销，两侧相同可作对照）；
 * - 页面侧：keydown → input 事件时间戳差（纯渲染阻塞，不含 CDP）；
 * - 同时记录 longtask、焦点丢失次数、disabled 抖动、字符丢失数。
 */
async function measureTyping(page, label) {
  const ta = page.locator('.chat-composer textarea')
  await ta.click()
  await page.evaluate(() => {
    const el = document.querySelector('.chat-composer textarea')
    window.__perf = { down: [], input: [], longtasks: [], focusLost: 0, disabledFlap: 0 }
    el.addEventListener('keydown', () => window.__perf.down.push(performance.now()))
    el.addEventListener('input', () => window.__perf.input.push(performance.now()))
    el.addEventListener('blur', () => window.__perf.focusLost++)
    let lastDisabled = el.disabled
    new MutationObserver(() => {
      if (el.disabled !== lastDisabled) { window.__perf.disabledFlap++; lastDisabled = el.disabled }
    }).observe(el, { attributes: true, attributeFilter: ['disabled'] })
    window.__perfObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__perf.longtasks.push(Math.round(entry.duration))
    })
    window.__perfObserver.observe({ entryTypes: ['longtask'] })
  })

  const samples = []
  for (let i = 0; i < KEY_COUNT; i++) {
    const ch = 'abcdefghijklmnopqrstuvwxyz'[i % 26]
    const before = await page.evaluate(() => {
      const el = document.querySelector('.chat-composer textarea')
      return { len: el.value.length, disabled: el.disabled, focused: document.activeElement === el }
    })
    const t0 = Date.now()
    await page.keyboard.press(ch)
    let latency = -1
    const deadline = Date.now() + PER_KEY_TIMEOUT_MS
    while (Date.now() < deadline) {
      const len = await page.evaluate(() => document.querySelector('.chat-composer textarea').value.length)
      if (len > before.len) { latency = Date.now() - t0; break }
      await sleep(15)
    }
    samples.push({ ch, latency, ...before })
  }

  const perf = await page.evaluate(() => {
    window.__perfObserver.disconnect()
    const { down, input, longtasks, focusLost, disabledFlap } = window.__perf
    const pairs = []
    for (let i = 0; i < Math.min(down.length, input.length); i++) pairs.push(Math.round(input[i] - down[i]))
    return { pairs, longtasks, focusLost, disabledFlap, keydowns: down.length, inputs: input.length }
  })

  const e2eLat = samples.filter((s) => s.latency >= 0).map((s) => s.latency)
  const stat = (arr) => {
    if (!arr.length) return { n: 0, med: '-', p95: '-', max: '-' }
    const sorted = [...arr].sort((a, b) => a - b)
    return {
      n: arr.length,
      med: sorted[Math.floor(sorted.length / 2)],
      p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))],
      max: sorted[sorted.length - 1]
    }
  }
  const result = {
    label,
    endToEnd: stat(e2eLat),
    keydownToInput: stat(perf.pairs),
    lost: samples.filter((s) => s.latency < 0).length,
    blurredBeforeKey: samples.filter((s) => !s.focused).length,
    disabledBeforeKey: samples.filter((s) => s.disabled).length,
    focusLost: perf.focusLost,
    disabledFlap: perf.disabledFlap,
    longtaskCount: perf.longtasks.length,
    longtaskTotalMs: perf.longtasks.reduce((a, b) => a + b, 0),
    longtaskMaxMs: perf.longtasks.length ? Math.max(...perf.longtasks) : 0,
    keydowns: perf.keydowns,
    inputs: perf.inputs
  }
  // 清空输入框，避免影响下一轮
  await page.evaluate(() => {
    const el = document.querySelector('.chat-composer textarea')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, '')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
  return result
}

function printRow(r) {
  console.log(
    `| ${r.label} | ${r.endToEnd.med} | ${r.endToEnd.p95} | ${r.endToEnd.max} | ${r.keydownToInput.med} | ${r.keydownToInput.p95} | ${r.keydownToInput.max} | ${r.lost} | ${r.longtaskCount} (${r.longtaskTotalMs}ms, max ${r.longtaskMaxMs}ms) | ${r.focusLost}/${r.disabledFlap} |`
  )
}

async function main() {
  console.log('[repro] temp root:', root)
  console.log('[repro] launching electron (isolated MOONGLASS_USERDATA)...')
  const app = await electron.launch({
    executablePath: electronBin,
    args: [process.cwd()],
    timeout: 60_000,
    env: { ...process.env, MOONGLASS_USERDATA: appDataDir }
  })
  const page = await app.firstWindow()
  await page.setViewportSize({ width: 1600, height: 900 })
  page.on('pageerror', (err) => console.error('[pageerror]', err.message))
  page.on('dialog', (dialog) => void dialog.accept())
  await page.waitForLoadState('domcontentloaded')
  await sleep(3000)

  const projectName = `ChatPerf-${Date.now()}`
  let results = []
  try {
    // 注入假 Provider（离线 spawn pi 用，不发真实 LLM 请求）+ 创建测试项目
    const projectId = await page.evaluate(async ({ name, ws }) => {
      await window.moonglass.llm.upsert({
        id: 'perf-dummy', name: 'PerfDummy', protocol: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-dummy-perf-repro',
        models: ['dummy-chat'], enabled: true, builtin: false
      })
      const project = await window.moonglass.project.create({ name, workspacePath: ws })
      return project.id
    }, { name: projectName, ws: workspaceDir })
    console.log('[repro] project:', projectId)

    // 切走再切回，强制项目列表重挂载以看到新项目
    await page.click('nav a:has-text("设置")')
    await sleep(800)
    await gotoWorkspace(page, projectName)
    console.log('[repro] workspace ready (REQ_SPEC, 空会话)')

    // ---- 基线：空会话 ----
    results.push(await measureTyping(page, '空会话'))
    console.log('[repro] baseline measured')

    // ---- 覆写当前阶段主会话为巨型会话（保留 pi 写的首行 header）----
    // 注：phase.enter 有门禁拦截（缺阶段文档无法进 VERIF），但键入阻塞机制与阶段无关，
    // 320 条大消息对 ChatPanel 的渲染压力在任何阶段主会话上等价。
    // ---- 构造巨型会话文件（直接写盘，getMessages 以 JSONL 为事实源）----
    // 路径规则与 AgentService.sessionDir / phaseSessionFilePath 一致：
    // <userData>/moonglass/pi-sessions/<projectId>/session-phase-req_spec.jsonl
    // 隔离环境 userData = <appDataDir>（MOONGLASS_USERDATA 直接指定）。pi 若已生成文件则保留其 header 行。
    const sessionDir = join(appDataDir, 'moonglass', 'pi-sessions', projectId)
    mkdirSync(sessionDir, { recursive: true })
    const sessionFile = join(sessionDir, 'session-phase-req_spec.jsonl')
    let headerLine = existsSync(sessionFile) ? readFileSync(sessionFile, 'utf-8').split(/\r?\n/)[0] : ''
    if (!headerLine) {
      headerLine = JSON.stringify({ type: 'session', version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd: workspaceDir })
    }
    console.log('[repro] session header:', headerLine.slice(0, 120))
    console.log('[repro] building giant session (320 messages)...')
    const body = buildGiantSessionBody()
    writeFileSync(sessionFile, `${headerLine}\n${body}\n`, 'utf-8')
    const { size } = statSync(sessionFile)
    console.log(`[repro] giant session written: ${(size / 1024 / 1024).toFixed(1)} MB -> ${sessionFile}`)

    // ---- 重进工作区加载巨型会话 ----
    console.log('[repro] reloading workspace with giant session (首次渲染 10MB DOM 可能较慢)...')
    await gotoWorkspace(page, projectName)
    await page.waitForFunction(
      () => document.querySelectorAll('.message-assistant, .message-user').length >= 300,
      { timeout: 300_000 }
    )
    const bubbleCount = await page.evaluate(() => document.querySelectorAll('.message-assistant, .message-user').length)
    console.log(`[repro] giant session rendered: ${bubbleCount} bubbles`)

    // ---- 巨型会话下键入 ----
    results.push(await measureTyping(page, '巨型会话(320条/10MB)'))

    // ---- 对照表 ----
    console.log('')
    console.log('| 场景 | 端到端 med | 端到端 p95 | 端到端 max | keydown→input med | p95 | max | 丢失字符 | longtask 数(总量/最大) | 焦点丢失/disabled抖动 |')
    console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |')
    for (const r of results) printRow(r)

    // 清理测试项目
    await page.evaluate((id) => window.moonglass.project.delete(id), projectId)
    await app.close()
  } catch (err) {
    console.error('[repro] failed:', err)
    await page.screenshot({ path: join(process.cwd(), 'e2e-screenshots', 'chat-input-perf-error.png') }).catch(() => {})
    await app.close().catch(() => {})
    if (!KEEP) rmSync(root, { recursive: true, force: true })
    process.exit(1)
  } finally {
    if (!KEEP) rmSync(root, { recursive: true, force: true })
  }
  const giant = results[1]
  const stuck = giant && (giant.endToEnd.med === '-' || Number(giant.endToEnd.med) > 200 || giant.keydownToInput.med === '-' || Number(giant.keydownToInput.med) > 100)
  console.log('')
  console.log(stuck
    ? '❌ 复现成立：巨型会话下键入显著阻塞（详见对照表）'
    : '✅ 巨型会话下键入流畅（修复有效或未复现）')
}

main()
