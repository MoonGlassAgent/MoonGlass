/**
 * E2E：一键托管 VERIF 阶段真实行为观察（复现"VERIF 很难托管完成"报告）
 *
 * 隔离运行：通过 MOONGLASS_USERDATA 指向独立数据目录（src/main/index.ts 内置的
 * 开发/诊断隔离机制），不触碰用户日常 userData 的 projects.json / moonglass.db。
 * 隔离目录内仅复制 llm-providers.json（safeStorage 按用户加密，可复制）、
 * eda-detection-cache.json，并以 junction 共享 toolchains；测试项目经 projects.json
 * 首启迁移注入（ProjectService.migrateFromLegacyIfNeeded）。
 *
 * 测试工程：%TEMP%/mg-e2e-verif-<ts>/workspace，8 位计数器 mini_counter，
 * RTL 内置一个 off-by-one 回绕 bug（0xFE 提前回绕，规格要求 0xFF），
 * 用于观察"批次发现 bug → 修复会话 → 批次是否续跑"的 M4 门控行为。
 *
 * 需要：已构建应用（pnpm build）。
 * 运行：node scripts/e2e-managed-verif.mjs
 * 可选环境变量：E2E_BUDGET_MIN（观察预算分钟，默认 22）、E2E_POLL_SEC（轮询秒，默认 40）
 */
import { _electron as electron } from 'playwright-core'
import { join } from 'node:path'
import {
  mkdirSync, writeFileSync, readFileSync, copyFileSync,
  existsSync, symlinkSync, readdirSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'

const TS = Date.now()
const BUDGET_MIN = Number(process.env.E2E_BUDGET_MIN ?? 22)
const POLL_SEC = Number(process.env.E2E_POLL_SEC ?? 40)
const ROOT = process.cwd()
const SHOT_DIR = join(ROOT, 'e2e-screenshots')
mkdirSync(SHOT_DIR, { recursive: true })

const REAL_MG_DIR = join(process.env.APPDATA ?? '', 'moonglass', 'moonglass')
const REAL_PROJECTS = join(REAL_MG_DIR, 'projects.json')
const RUN_DIR = join(tmpdir(), `mg-e2e-verif-${TS}`)
const ISO_USERDATA = join(RUN_DIR, 'userdata')
const ISO_MG_DIR = join(ISO_USERDATA, 'moonglass')
const WS = join(RUN_DIR, 'workspace')
const PROJECT_ID = randomUUID()
const PROJECT_NAME = `MG-E2E-VERIF-${TS}`
const MODEL_PREF = [
  ['glm', 'glm-5.3-flash'],
  ['deepseek', 'deepseek-flash']
]

const electronBin = join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
const timeline = []
const mainLogTail = []
let shotSeq = 0

function sha256(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : '<missing>'
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function screenshot(page, name) {
  shotSeq += 1
  const file = `mv${TS}-${String(shotSeq).padStart(2, '0')}-${name}.png`
  await page.screenshot({ path: join(SHOT_DIR, file) })
  console.log(`[screenshot] ${file}`)
}

function mark(note, extra = {}) {
  const entry = { elapsedSec: Math.round((Date.now() - TS) / 1000), note, ...extra }
  timeline.push(entry)
  console.log(`[t+${entry.elapsedSec}s] ${note}`)
}

// ---------- 最小 VERIF 工程素材 ----------

const RTL_V = `// mini_counter：8 位可加载计数器（E2E 最小工程）
// 规格要求：en 计数到 8'hFF 后回绕到 0，并输出 1 周期 tc 脉冲；load 优先于 en。
module mini_counter (
  input  wire       clk,
  input  wire       rst_n,
  input  wire       en,
  input  wire       load,
  input  wire [7:0] din,
  output reg  [7:0] dout,
  output reg        tc
);
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      dout <= 8'd0;
      tc   <= 1'b0;
    end else if (load) begin
      dout <= din;
      tc   <= 1'b0;
    end else if (en) begin
      if (dout == 8'hFE) begin
        dout <= 8'd0;
        tc   <= 1'b1;
      end else begin
        dout <= dout + 8'd1;
        tc   <= 1'b0;
      end
    end else begin
      tc <= 1'b0;
    end
  end
endmodule
`

const DESIGN_JSON = {
  topModule: 'mini_counter',
  filelist: 'filelist.f',
  includeDirs: [],
  defines: [],
  designFiles: ['rtl/mini_counter.v'],
  simulationFiles: [],
  libraryFiles: [],
  physicalFiles: []
}

const DOC_PRD = `# 产品需求文档（PRD）

## 概述

mini_counter 是一个 8 位可加载同步计数器 IP，用于演示与验证流程闭环。

## 功能需求

- REQ-FUNC-001：在 en=1 且 load=0 时，计数器每个时钟上升沿加 1；计数值达到 8'hFF 后下一拍回绕为 8'h00。
- REQ-FUNC-002：load=1 时在时钟上升沿将 din 载入计数器；load 优先于 en。
- REQ-FUNC-003：计数值从 8'hFF 回绕到 8'h00 的当拍输出 tc=1 脉冲（仅 1 周期），其余时刻 tc=0。
- REQ-FUNC-004：rst_n 为异步低有效复位，复位后 dout=8'h00、tc=0。
`

const DOC_MODULE_SPEC = `# 模块规格说明

## 模块：mini_counter

- SPEC-FUNC-001（对应 REQ-FUNC-001）：计数逻辑，en 有效时 dout <= dout + 1，dout==8'hFF 时回绕到 8'h00。
- SPEC-FUNC-002（对应 REQ-FUNC-002）：载入逻辑，load 优先于 en，dout <= din。
- SPEC-FUNC-003（对应 REQ-FUNC-003）：回绕当拍 tc 置 1，下一拍自动清 0。
- SPEC-FUNC-004（对应 REQ-FUNC-004）：异步复位，negedge rst_n 立即清零。

## 非功能

- 单时钟域，目标工艺无关；Lint 零 Error。
`

const DOC_RTM = `# 需求-规格追溯矩阵

| 需求 ID | 规格 ID | 说明 |
|---|---|---|
| REQ-FUNC-001 | SPEC-FUNC-001 | 计数与回绕 |
| REQ-FUNC-002 | SPEC-FUNC-002 | 载入优先级 |
| REQ-FUNC-003 | SPEC-FUNC-003 | tc 脉冲 |
| REQ-FUNC-004 | SPEC-FUNC-004 | 异步复位 |
`

const DOC_ARCH = `# 总体架构设计

## 架构框图

\`\`\`
        +-----------------------------+
clk --->|                             |
rst_n ->|        mini_counter         |---> dout[7:0]
en ---->|  计数寄存器 + 回绕检测       |---> tc
load -->|                             |
din --->|                             |
        +-----------------------------+
\`\`\`

## 模块划分

单模块设计：mini_counter（rtl/mini_counter.v），无子模块。

## 时钟与复位

- 单时钟 clk，上升沿有效。
- rst_n 异步低有效复位，复位后计数器输出 0。

## 寄存器设计

| 寄存器 | 位宽 | 说明 |
|---|---|---|
| dout | 8 | 计数寄存器，可直接读出 |
| tc | 1 | 回绕脉冲，寄 1 拍 |
`

const DOC_IFSPEC = `# 接口规格

| 信号 | 方向 | 位宽 | 说明 |
|---|---|---|---|
| clk | input | 1 | 时钟，上升沿有效 |
| rst_n | input | 1 | 异步复位，低有效 |
| en | input | 1 | 计数使能 |
| load | input | 1 | 同步载入使能，优先于 en |
| din | input | 8 | 载入值 |
| dout | output | 8 | 计数值 |
| tc | output | 1 | 回绕脉冲（8'hFF→8'h00 当拍为 1） |
`

const DOC_VERIF_README = `# 验证阶段

验证计划、测试平台与回归产物由验证阶段在本目录及 verification/ 下建立。
`

function writeWorkspace() {
  mkdirSync(join(WS, 'rtl'), { recursive: true })
  mkdirSync(join(WS, 'docs', '02_requirements'), { recursive: true })
  mkdirSync(join(WS, 'docs', '03_design'), { recursive: true })
  mkdirSync(join(WS, 'docs', '04_verification'), { recursive: true })
  writeFileSync(join(WS, 'rtl', 'mini_counter.v'), RTL_V)
  writeFileSync(join(WS, 'rtl', 'design.json'), JSON.stringify(DESIGN_JSON, null, 2) + '\n')
  writeFileSync(join(WS, 'rtl', 'filelist.f'), 'mini_counter.v\n')
  writeFileSync(join(WS, 'docs', '02_requirements', 'product_requirements.md'), DOC_PRD)
  writeFileSync(join(WS, 'docs', '02_requirements', 'module_specification.md'), DOC_MODULE_SPEC)
  writeFileSync(join(WS, 'docs', '02_requirements', 'requirements_traceability.md'), DOC_RTM)
  writeFileSync(join(WS, 'docs', '03_design', 'architecture.md'), DOC_ARCH)
  writeFileSync(join(WS, 'docs', '03_design', 'interface_spec.md'), DOC_IFSPEC)
  writeFileSync(join(WS, 'docs', '04_verification', 'README.md'), DOC_VERIF_README)
}

function writeIsolatedUserData() {
  mkdirSync(ISO_MG_DIR, { recursive: true })
  // Chromium OSCrypt 主密钥存于 userData 根的 Local State（DPAPI 保护，按机器用户可解）；
  // safeStorage 密文依赖它，隔离 userData 必须复制，否则 apiKeyEnc 全部解密失败
  copyFileSync(join(REAL_MG_DIR, '..', 'Local State'), join(ISO_USERDATA, 'Local State'))
  copyFileSync(join(REAL_MG_DIR, 'llm-providers.json'), join(ISO_MG_DIR, 'llm-providers.json'))
  const edaCache = join(REAL_MG_DIR, 'eda-detection-cache.json')
  if (existsSync(edaCache)) copyFileSync(edaCache, join(ISO_MG_DIR, 'eda-detection-cache.json'))
  const toolchainTarget = join(REAL_MG_DIR, 'toolchains')
  if (existsSync(toolchainTarget)) {
    symlinkSync(toolchainTarget, join(ISO_MG_DIR, 'toolchains'), 'junction')
  }
  const now = new Date().toISOString()
  const blank = () => ({
    status: 'locked',
    deliverables: [],
    agentContext: { messageCount: 0 },
    reviewStatus: 'pending',
    gateCheckResults: []
  })
  const completed = () => ({ ...blank(), status: 'completed', startedAt: now, completedAt: now })
  const phases = {
    REQ_SPEC: completed(),
    ARCH: completed(),
    RTL: completed(),
    VERIF: { ...blank(), status: 'active', startedAt: now },
    QA: blank(),
    SYNTH: blank()
  }
  const record = {
    id: PROJECT_ID,
    name: PROJECT_NAME,
    description: 'E2E 托管验证最小工程（8 位计数器，RTL 内置 off-by-one 回绕 bug）',
    workspacePath: WS,
    currentPhase: 'VERIF',
    phases,
    edaToolchain: 'verilator-yosys',
    createdAt: now,
    updatedAt: now
  }
  writeFileSync(join(ISO_MG_DIR, 'projects.json'), JSON.stringify({ projects: [record] }, null, 2))
}

// ---------- 页面操作 helper ----------

async function waitForSessionReady(page, timeout = 90000) {
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

async function selectCheapModel(page) {
  const picked = await page.evaluate((pref) => {
    const sel = document.querySelector('select')
    if (!sel) return null
    const values = [...sel.options].map((o) => o.value).filter(Boolean)
    for (const pair of pref) {
      const v = JSON.stringify(pair)
      if (values.includes(v)) {
        sel.value = v
        sel.dispatchEvent(new Event('change', { bubbles: true }))
        return v
      }
    }
    const first = values[0]
    if (first) {
      sel.value = first
      sel.dispatchEvent(new Event('change', { bubbles: true }))
    }
    return first ?? null
  }, MODEL_PREF)
  mark(`模型选择: ${picked}`)
  return picked
}

async function observe(page) {
  try {
    return await page.evaluate(async (projectId) => {
      const text = (el) => (el?.textContent ?? '').trim()
      const proj = await window.moonglass.project.get(projectId).catch(() => null)
      const stopBtn = [...document.querySelectorAll('button')].find((b) => text(b).includes('停止托管'))
      const chips = [...document.querySelectorAll('header span[title]')]
        .map((s) => `${text(s)}|${s.getAttribute('title') ?? ''}`)
      const logs = [...document.querySelectorAll('.console-row')].map((el) => text(el)).slice(-8)
      const msgs = [...document.querySelectorAll('.whitespace-pre-wrap')]
        .slice(-2).map((el) => text(el).slice(0, 400))
      const statusEls = [...document.querySelectorAll('.text-blue-700, .text-amber-700, .text-red-700')]
        .map((el) => text(el)).filter(Boolean).slice(-6)
      return {
        currentPhase: proj?.currentPhase ?? null,
        managedRunning: Boolean(stopBtn),
        managedSteps: chips,
        logs,
        lastMessages: msgs,
        statusTexts: statusEls
      }
    }, PROJECT_ID)
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function readExecSummary() {
  const p = join(WS, 'verification', 'intelligence', 'execution-summary.json')
  if (!existsSync(p)) return null
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    return JSON.stringify(data).slice(0, 600)
  } catch {
    return '<unparsable>'
  }
}

function listVerifDir() {
  const dir = join(WS, 'verification')
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
  } catch {
    return []
  }
}

// ---------- 主流程 ----------

async function main() {
  const realHashBefore = sha256(REAL_PROJECTS)
  console.log(`[e2e] 真实 projects.json sha256（运行前）: ${realHashBefore}`)
  console.log(`[e2e] 隔离运行目录: ${RUN_DIR}`)
  writeWorkspace()
  writeIsolatedUserData()
  mark('隔离 userData 与最小 VERIF 工程就绪', { runDir: RUN_DIR, projectId: PROJECT_ID })

  const app = await electron.launch({
    executablePath: electronBin,
    args: [ROOT],
    env: { ...process.env, MOONGLASS_USERDATA: ISO_USERDATA },
    timeout: 90000
  })

  const proc = app.process()
  proc.stdout?.on('data', (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (/agent-service|phase-engine|批次|rtl-fix|verif/i.test(line)) {
        mainLogTail.push(`[t+${Math.round((Date.now() - TS) / 1000)}s] ${line}`)
        if (mainLogTail.length > 400) mainLogTail.shift()
        console.log('[main]', line)
      }
    }
  })
  proc.stderr?.on('data', (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (/error|fail|agent-service|批次/i.test(line)) console.log('[main:err]', line)
    }
  })

  const page = await app.firstWindow()
  page.on('pageerror', (err) => console.error('[pageerror]', err.message))
  page.on('dialog', async (dialog) => {
    console.log('[dialog]', dialog.type(), dialog.message().slice(0, 120))
    await dialog.accept()
  })
  await page.waitForLoadState('domcontentloaded')
  await sleep(4000)
  await screenshot(page, 'launch')

  let finished = false
  try {
    // 进入项目列表，打开注入的 VERIF 项目
    await page.click('nav a:has-text("项目")')
    await sleep(1200)
    await screenshot(page, 'projects')

    const providers = await page.evaluate(async () => await window.moonglass.llm.list())
    console.log('[e2e] providers:',
      providers.filter((p) => p.enabled).map((p) => ({ id: p.id, hasKey: !!p.apiKey, models: p.models.length })))
    if (!providers.some((p) => p.enabled && p.apiKey)) {
      throw new Error('隔离 userData 下无可用 Provider（key 解密失败或未复制）')
    }

    await page.click(`.rounded-lg:has-text("${PROJECT_NAME}")`)
    await waitForSessionReady(page)
    await screenshot(page, 'workspace-verif')
    mark('进入 VERIF 工作区，会话就绪')

    const model = await selectCheapModel(page)
    if (!model) throw new Error('没有可用模型')

    // 启动一键托管（对话框默认终点 SYNTH，保持默认）
    await page.click('button:has-text("一键托管")')
    await sleep(600)
    await screenshot(page, 'managed-dialog')
    await page.click('button:has-text("开始托管")')
    mark('已点击开始托管（VERIF → SYNTH）')
    await sleep(2000)
    await screenshot(page, 'managed-started')

    // 限时观察
    const budgetMs = BUDGET_MIN * 60_000
    const startedAt = Date.now()
    let round = 0
    while (Date.now() - startedAt < budgetMs) {
      await sleep(POLL_SEC * 1000)
      round += 1
      const obs = await observe(page)
      const execSummary = readExecSummary()
      const verifDir = listVerifDir()
      mark(`观察 #${round}`, { ...obs, execSummary, verifDir })
      await screenshot(page, `poll-${String(round).padStart(2, '0')}`)
      if (obs.managedRunning === false) {
        mark('托管已结束（停止托管按钮消失）')
        finished = true
        break
      }
    }

    if (!finished) {
      mark(`观察预算 ${BUDGET_MIN} 分钟耗尽，托管仍在运行，准备停止`)
    }
  } catch (err) {
    mark(`异常: ${err instanceof Error ? err.message : String(err)}`)
    await screenshot(page, 'error')
  }

  // 收尾：仍在跑则停止托管
  try {
    const obs = await observe(page)
    if (obs.managedRunning) {
      const stopBtn = await page.$('button:has-text("停止托管")')
      if (stopBtn) {
        await stopBtn.click()
        mark('已点击停止托管')
        await sleep(12000)
      }
    }
  } catch (err) {
    console.log('[e2e] 停止托管时异常（忽略）:', err instanceof Error ? err.message : String(err))
  }
  await screenshot(page, 'final')

  // 托管报告
  const reportDir = join(WS, 'docs', '07_release')
  if (existsSync(reportDir)) {
    for (const f of readdirSync(reportDir)) {
      if (f.startsWith('managed_run_') && f.endsWith('.md')) {
        console.log(`\n===== 托管报告 ${f} =====`)
        console.log(readFileSync(join(reportDir, f), 'utf-8'))
      }
    }
  } else {
    console.log('[e2e] 无 docs/07_release 托管报告')
  }

  await app.close()

  const realHashAfter = sha256(REAL_PROJECTS)
  const untouched = realHashBefore === realHashAfter
  console.log(`[e2e] 真实 projects.json sha256（运行后）: ${realHashAfter}`)
  console.log(`[e2e] 真实 projects.json 未被改动: ${untouched}`)

  // 时间线报告
  const reportPath = join(SHOT_DIR, `managed-verif-timeline-${TS}.md`)
  const lines = [
    `# 一键托管 VERIF 行为时间线（${new Date(TS).toISOString()}）`,
    '',
    `- 项目：${PROJECT_NAME}（${PROJECT_ID}）`,
    `- 隔离运行目录：${RUN_DIR}`,
    `- 观察预算：${BUDGET_MIN} 分钟，轮询 ${POLL_SEC}s`,
    `- 托管自然结束：${finished}`,
    `- 真实 projects.json 未改动：${untouched}`,
    '',
    '## 时间线',
    ''
  ]
  for (const e of timeline) {
    lines.push(`### t+${e.elapsedSec}s — ${e.note}`)
    for (const [k, v] of Object.entries(e)) {
      if (['elapsedSec', 'note'].includes(k) || v == null) continue
      lines.push(`- ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    }
    lines.push('')
  }
  lines.push('## 主进程日志摘录（批次/修复门控相关）', '')
  for (const l of mainLogTail) lines.push(`- ${l}`)
  writeFileSync(reportPath, lines.join('\n'))
  console.log(`[e2e] 时间线报告: ${reportPath}`)
  console.log(`[e2e] 取证目录保留: ${RUN_DIR}`)
  process.exit(0)
}

main().catch((err) => {
  console.error('[e2e] 致命异常:', err)
  process.exit(1)
})
