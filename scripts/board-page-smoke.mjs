// BOARD-AND-REVIEW-CLOSED-LOOP 片 C（设计文档 §4/§5）：流程看板页面（BoardPage）冒烟。
// 源码结构断言（不启动 Electron）：
//  - 路由已登记：/board/$projectId，lazy 惯例与既有页面一致；
//  - 组件经 window.moonglass.board.getBoardModel(projectId) 取数（片 B 契约），含刷新/错误/空态；
//  - 任务状态五类映射（success/running/needs-fix/pending-human/not-started）+ 类型六类 +
//    判定六类齐全；阶段显示名走 phaseLabel 惯例；
//  - i18n：board 命名空间注册进 zh-CN/en 两个 index.ts，en 以 typeof zhCN 为约束，
//    且组件内引用的 board.* 键在中文资源中全部存在；
//  - 无硬编码界面文案：剥掉注释后组件源码不得含中日韩表意文字（UI 文案一律走 t()）。
// 与 run-summary-smoke 同模式：Node 原生类型剥除后直接 import 文案资源索引。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { zhCN } from '../src/renderer/i18n/locales/zh-CN/index.ts'
import { en } from '../src/renderer/i18n/locales/en/index.ts'

const page = readFileSync('src/renderer/pages/BoardPage.tsx', 'utf-8')
const router = readFileSync('src/renderer/router.tsx', 'utf-8')
const zhIndex = readFileSync('src/renderer/i18n/locales/zh-CN/index.ts', 'utf-8')
const enIndex = readFileSync('src/renderer/i18n/locales/en/index.ts', 'utf-8')
const zhBoard = readFileSync('src/renderer/i18n/locales/zh-CN/board.ts', 'utf-8')
const enBoard = readFileSync('src/renderer/i18n/locales/en/board.ts', 'utf-8')
const runTests = readFileSync('scripts/run-tests.mjs', 'utf-8')

// ── 1. 路由登记：/board/$projectId + lazyRouteComponent 惯例 ──
assert.match(router, /path:\s*'\/board\/\$projectId'/, 'router.tsx 未登记 /board/$projectId 路由')
assert.match(router, /lazyRouteComponent\(\(\)\s*=>\s*import\('\.\/pages\/BoardPage'\),\s*'BoardPage'\)/, 'BoardPage 未按 lazyRouteComponent 惯例引入')
assert.match(router, /boardRoute/, 'routeTree 未挂 boardRoute')

// ── 2. 数据加载：走片 B IPC 契约 + 刷新/错误/空态/加载中分支 ──
assert.match(page, /window\.moonglass\.board\.getBoardModel\(projectId\)/, 'BoardPage 未使用 getBoardModel 取数')
assert.match(page, /useParams\(\{\s*from:\s*'\/board\/\$projectId'\s*\}\)/, 'BoardPage 未从 /board/$projectId 路由取 projectId')
assert.match(page, /board\.refresh/, '缺少刷新按钮文案键')
assert.match(page, /board\.error\.title/, '缺少加载失败错误态')
assert.match(page, /board\.empty\.title/, '缺少空项目空态')
assert.match(page, /board\.loading/, '缺少加载中文案')

const keyPattern = (token) => new RegExp(`['"]?${token}['"]?:`)
// ── 3. 状态五类映射 + 类型六类 + 判定六类（卡片/徽标/尝试行全覆盖） ──
for (const status of ['success', 'running', 'needs-fix', 'pending-human', 'not-started']) {
  assert.ok(keyPattern(status).test(page), `任务状态五类映射缺失: ${status}`)
}
for (const kind of ['batch', 'rtl-fix', 'design-review', 'module-ut', 'decision', 'run-loop']) {
  assert.ok(keyPattern(kind).test(page) && page.includes('board.kind.'), `任务类型徽标映射缺失: ${kind}`)
}
for (const verdict of ['success', 'failed', 'no-evidence', 'circuit-broken', 'error', 'running']) {
  assert.ok(keyPattern(verdict).test(page) && page.includes('board.verdict.'), `尝试判定映射缺失: ${verdict}`)
}
assert.match(page, /phaseLabel\(/, '阶段列显示名未走 phaseLabel 惯例')
assert.match(page, /PHASE_ORDER/, '六阶段列未按 PHASE_ORDER 固定顺序排列')
assert.match(page, /pending-human[\s\S]*board\.pendingHuman/, 'pending-human 卡片缺少待人工处置提示')

// ── 4. i18n 命名空间注册（两个 index）+ 中英键一致 + 组件引用键齐全 ──
assert.match(zhIndex, /import \{ board \} from '\.\/board\.ts'/, 'zh-CN index 未注册 board 命名空间')
assert.match(enIndex, /import \{ board \} from '\.\/board\.ts'/, 'en index 未注册 board 命名空间')
assert.match(zhIndex, /\bboard,/, 'zhCN 对象未挂 board')
assert.match(enIndex, /\bboard,/, 'en 对象未挂 board')
assert.match(enBoard, /import type \{ BoardMessages \} from '\.\.\/zh-CN\/board'/, 'en/board.ts 未以 typeof 中文资源为类型约束')

const flattenKeys = (node, prefix = '') =>
  Object.entries(node).flatMap(([name, value]) =>
    typeof value === 'string' ? [`${prefix}${name}`] : flattenKeys(value, `${prefix}${name}.`))
assert.deepEqual(flattenKeys(en.board), flattenKeys(zhCN.board), 'board 命名空间中英资源键不一致')
for (const key of ['title', 'subtitle', 'navWorkspace', 'refresh', 'reload', 'updatedAt', 'taskCount', 'pendingHuman',
  'status.success', 'status.running', 'status.needsFix', 'status.pendingHuman', 'status.notStarted',
  'kind.batch', 'kind.rtlFix', 'kind.designReview', 'kind.moduleUt', 'kind.decision', 'kind.runLoop',
  'verdict.success', 'verdict.failed', 'verdict.noEvidence', 'verdict.circuitBroken', 'verdict.error', 'verdict.running',
  'attempts.title', 'attempts.indexLabel', 'attempts.empty', 'attempts.colModel', 'attempts.colVerdict',
  'attempts.colStartedAt', 'attempts.colSettledAt', 'attempts.colDuration', 'attempts.colNote', 'attempts.unknownModel',
  'attempts.durationMinutes', 'attempts.durationSeconds', 'empty.title', 'empty.hint', 'error.title', 'error.hint', 'loading']) {
  assert.equal(typeof key.split('.').reduce((node, part) => node?.[part], zhCN.board), 'string', `board 命名空间缺键: ${key}`)
}
// 组件内实际引用的 board.* 键必须全部存在于中文资源（t() 运行时兜底双保险）
const referencedKeys = [...page.matchAll(/t\('(board\.[a-zA-Z.]+)'/g)].map((match) => match[1])
assert.ok(referencedKeys.length > 0, 'BoardPage 未引用任何 board.* 文案键')
for (const key of referencedKeys) {
  const value = key.split('.').reduce((node, part) => node?.[part], zhCN)
  assert.equal(typeof value, 'string', `BoardPage 引用了不存在的文案键: ${key}`)
}

// ── 5. 无硬编码界面文案：剥掉注释后不得含中日韩表意文字 ──
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
assert.equal(/[㐀-鿿豈-﫿]/.test(stripComments(page)), false, 'BoardPage 存在注释以外的硬编码中文文案')

// ── 6. 已注册进 run-tests.mjs core 套件 ──
assert.ok(runTests.includes('scripts/board-page-smoke.mjs'), 'board-page-smoke 未注册进 run-tests.mjs core')

console.log('board-page-smoke: OK（/board/$projectId 路由登记/getBoardModel 取数/状态五类·类型六类·判定六类映射/phaseLabel 阶段列/i18n 双端注册与键齐全/无硬编码中文文案/run-tests core 注册）')
