// notification smoke：待人桌面通知的节流语义与发送决策。
//  - HumanAttentionThrottle 纯函数：同一项目同一 kind 在一次待人 episode 内只放行一次；
//    episodeKey 换代（新暂停 since / 新决策请求 id）后可再弹；clearProject/clearAll 解除；
//    不同项目 / 不同 kind 互不影响；时钟可注入
//  - NotificationService 假 Notification 工厂注入：验证发送次数、标题/正文文案、
//    聚焦跳过、episode 解除后再弹、click 聚焦接线、通知不可用静默降级
// electron 包在纯 Node 下不可 import（其入口是二进制路径字符串），故在临时目录写
// 最小 electron 桩 + node:module 解析钩子（仅本进程内把 'electron' 指到桩），
// 再动态 import 被测 TS 源码，不真弹系统通知。与 decision-ledger-smoke 同模式。
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = mkdtempSync(join(tmpdir(), 'moonglass-notification-'))
const stubUrl = pathToFileURL(join(dir, 'electron-stub.mjs')).href
writeFileSync(join(dir, 'electron-stub.mjs'), [
  '// 最小 Electron 桩：NotificationService 只用到这三个符号',
  'export class BrowserWindow {',
  '  static getAllWindows() { return [] }',
  '}',
  'export class Notification {',
  '  static isSupported() { return false } // 桩环境视为不支持系统通知，验证静默降级',
  '  constructor(options) { this.options = options }',
  "  on() { return this }",
  '  show() {}',
  '}',
  'export const app = { on() {}, removeListener() {} }',
  ''
].join('\n'))
writeFileSync(join(dir, 'electron-hooks.mjs'), [
  `const stub = ${JSON.stringify(stubUrl)}`,
  'export async function resolve(specifier, context, next) {',
  "  if (specifier === 'electron') return next(stub, context)",
  '  return next(specifier, context)',
  '}',
  ''
].join('\n'))
register(pathToFileURL(join(dir, 'electron-hooks.mjs')).href)

const { HumanAttentionThrottle, NotificationService } = await import('../src/main/services/NotificationService.ts')

// ==================== HumanAttentionThrottle：纯函数节流语义 ====================

let clock = 10_000
const throttle = new HumanAttentionThrottle(() => clock)

// 同一 episode（同项目 / 同 kind / 同 episodeKey）只放行一次
assert.equal(throttle.shouldNotify('p1', 'gate-blocked', 'gate:A'), true, '首次应放行')
assert.equal(throttle.shouldNotify('p1', 'gate-blocked', 'gate:A'), false, '同 episode 重复应抑制')
clock += 3600_000
assert.equal(throttle.shouldNotify('p1', 'gate-blocked', 'gate:A'), false, '时间流逝不解除 episode（episode 以暂停/决策 id 换代计）')

// episode 换代（如恢复 running 后再次暂停，新 since）后可再弹
assert.equal(throttle.shouldNotify('p1', 'gate-blocked', 'gate:B'), true, '新 episode 应再弹')

// 不同项目 / 不同 kind 互不影响
assert.equal(throttle.shouldNotify('p2', 'gate-blocked', 'gate:A'), true, '不同项目互不影响')
assert.equal(throttle.shouldNotify('p1', 'paused-breaker', 'gate:A'), true, '不同 kind 互不影响')
assert.equal(throttle.shouldNotify('p1', 'llm-decision-pending', 'proposals:X、Y'), true)

// clearProject 只解除对应项目；clearAll 解除全部
throttle.clearProject('p1')
assert.equal(throttle.shouldNotify('p1', 'gate-blocked', 'gate:B'), true, 'clearProject 后同 episodeKey 可再弹')
assert.equal(throttle.shouldNotify('p2', 'gate-blocked', 'gate:A'), false, 'clearProject 不影响其他项目')
assert.equal(throttle.shouldNotify('p1', 'paused-breaker', 'gate:A'), true, 'clearProject 解除该项目全部 kind')
throttle.clearAll()
assert.equal(throttle.shouldNotify('p2', 'gate-blocked', 'gate:A'), true, 'clearAll 后全部可再弹')

// ==================== NotificationService：假工厂注入验证发送决策 ====================

const calls = []
let focused = false
let focusCalls = 0
const service = new NotificationService({
  resolveProjectName: (projectId) => (projectId === 'p1' ? 'MoonGlass_GMAC' : projectId),
  createDesktopNotification: (options) => { calls.push(options); return { show() {} } },
  isWindowFocused: () => focused,
  focusMainWindow: () => { focusCalls += 1 }
})
// start/stop 经 electron 桩走一遍生命周期，不应抛错
service.start()
service.stop()
service.start()

// 未聚焦 + 新 episode → 弹一次，标题含项目名与类型标签
service.notifyHumanAttention('p1', 'llm-decision-pending', 'LLM 决策提案 DEC-AAAA、DEC-BBBB 待审批，请在决策卡片中批准或否决', 'proposals:DEC-AAAA、DEC-BBBB')
assert.equal(calls.length, 1, '新 episode 应弹 1 次')
assert.equal(calls[0].title, 'MoonGlass：验证决策待批准（MoonGlass_GMAC）')
assert.match(calls[0].body, /DEC-AAAA、DEC-BBBB/)

// 同 episode 再触发（如同批提案的重复 status）→ 不重复弹
service.notifyHumanAttention('p1', 'llm-decision-pending', '同一批提案再次上报', 'proposals:DEC-AAAA、DEC-BBBB')
assert.equal(calls.length, 1, '同 episode 不重复弹')

// 窗口聚焦（用户正在看）→ 不弹，但 episode 视为已消费（界面内已有显性入口）
focused = true
service.notifyHumanAttention('p1', 'gate-blocked', '门禁未通过（2 项失败）', 'gate:C')
assert.equal(calls.length, 1, '聚焦时不弹')
focused = false
service.notifyHumanAttention('p1', 'gate-blocked', '门禁未通过（2 项失败）', 'gate:C')
assert.equal(calls.length, 1, '聚焦时已消费的 episode 不补弹')

// 不同 kind / 不同项目互不影响
service.notifyHumanAttention('p1', 'paused-breaker', '验证运行循环熔断（max-tokens）：预算超限', 'breaker:max-tokens:T1')
assert.equal(calls.length, 2)
assert.equal(calls[1].title, 'MoonGlass：验证循环熔断待人处置（MoonGlass_GMAC）')
service.notifyHumanAttention('p2', 'decision-request', '决策请求「是否切换策略」待处置', 'decision:R1')
assert.equal(calls.length, 3)
assert.equal(calls[2].title, 'MoonGlass：决策请求待处置（p2）')
assert.match(calls[2].body, /是否切换策略/)

// click 聚焦接线：点通知 = 聚焦主窗口
calls[2].onClick()
assert.equal(focusCalls, 1, '点击通知应触发聚焦')

// episode 解除（用户回到窗口聚焦 → 服务内 throttle 清空；此处直接经服务公开语义解除）后可再弹
service.clearProjectEpisodes('p1')
service.notifyHumanAttention('p1', 'llm-decision-pending', '新一批提案 DEC-CCCC 待审批', 'proposals:DEC-CCCC')
assert.equal(calls.length, 4, 'episode 解除后新待人可再弹')
service.notifyHumanAttention('p1', 'llm-decision-pending', '重复上报', 'proposals:DEC-CCCC')
assert.equal(calls.length, 4, '再弹后同 episode 仍去重')

// ==================== 静默降级：electron 桩 Notification.isSupported()=false ====================

const degraded = new NotificationService({
  resolveProjectName: () => 'P',
  isWindowFocused: () => false
})
// 走缺省构造器（electron 桩报不支持）→ 返回 null 句柄，不抛错
assert.doesNotThrow(() => degraded.notifyHumanAttention('p1', 'gate-blocked', '门禁未通过', 'gate:Z'), '通知不可用应静默降级')
// 工厂抛错也应被吞掉，不影响调用方
const throwing = new NotificationService({
  createDesktopNotification: () => { throw new Error('no dbus') },
  isWindowFocused: () => false
})
assert.doesNotThrow(() => throwing.notifyHumanAttention('p1', 'gate-blocked', '门禁未通过', 'gate:Z2'), '工厂抛错应静默降级')

console.log('notification-smoke passed')
