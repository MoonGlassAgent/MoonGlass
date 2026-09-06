import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { elaborateDesign } = await import('../packages/design-browser-engine/src/index.ts')

const root = mkdtempSync(join(tmpdir(), 'moonglass-design-browser-'))
const child = join(root, 'child.v')
const top = join(root, 'top.v')
const output = join(root, 'top.json')
writeFileSync(child, `module child(input wire i_a, output wire o_y); assign o_y = ~i_a; endmodule\n`)
writeFileSync(top, `module top(input wire i_data, output wire o_data);
  wire w_mid;
  child u_child(.i_a(i_data), .o_y(w_mid));
  assign o_data = w_mid;
endmodule\n`)

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const database = await elaborateDesign({
  rtlFiles: [child, top],
  topModule: 'top',
  outputJson: output
})
const topModule = database.modules.find((module) => module.name === 'top')
const inputTrace = topModule?.traces.find((trace) => trace.net === 'i_data')
const midTrace = topModule?.traces.find((trace) => trace.net === 'w_mid')
const childInstance = database.hierarchy.children.find((node) => node.name === 'u_child')

check('Yosys design JSON 已生成', existsSync(output))
check('设计数据库版本正确', database.version === 2, String(database.version))
check('解析两个 RTL 模块', database.modules.length === 2, String(database.modules.length))
check('层次树包含 u_child', database.hierarchy.children.some((node) => node.name === 'u_child'))
check('子模块保留例化位置', childInstance?.source?.includes('top.v') === true, childInstance?.source)
check('子模块保留定义位置', childInstance?.definitionSource?.includes('child.v') === true, childInstance?.definitionSource)
check('顶层端口已解析', topModule?.ports.length === 2)
check('顶层网络已解析', (topModule?.nets.length ?? 0) >= 3)
check('input driver 可追踪', inputTrace?.drivers.some((item) => item.kind === 'port') === true)
check('driver 源码位置可追踪', midTrace?.drivers.some((item) => item.source?.includes('top.v')) === true)
check('load 源码位置可追踪', midTrace?.loads.some((item) => item.source?.includes('top.v')) === true)

// ---- 跨层次追踪（类 Verdi 逐层展开）----
const { topContext, traceNet, continueTrace } = await import('../packages/design-browser-engine/src/trace.ts')
const topCtx = topContext(database)
const childCtx = { instancePath: 'top.u_child', module: 'child' }

// 顶层 input port：已处顶层 IO，向上追踪终止
const topInputDriver = traceNet(database, topCtx, 'i_data', 'driver')
  .find((item) => item.kind === 'port')
check('顶层 IO driver 追踪终止', topInputDriver && continueTrace(database, topCtx, topInputDriver, 'driver').length === 0)

// 实例输入 pin（u_child.i_a）作为 load：可向下进入子模块 net i_a
const childPinLoad = traceNet(database, topCtx, 'i_data', 'load')
  .find((item) => item.kind === 'cell' && item.name === 'u_child')
const downTargets = childPinLoad ? continueTrace(database, topCtx, childPinLoad, 'load') : []
check('load 可向下跨入子模块', downTargets.some((item) => item.context.instancePath === 'top.u_child' && item.net === 'i_a'), JSON.stringify(downTargets))

// 子模块 input port（child.i_a）作为 driver：可向上跨回顶层 net i_data
const childPortDriver = traceNet(database, childCtx, 'i_a', 'driver')
  .find((item) => item.kind === 'port')
const upTargets = childPortDriver ? continueTrace(database, childCtx, childPortDriver, 'driver') : []
check('driver 可向上跨回父模块', upTargets.some((item) => item.context.instancePath === 'top' && item.net === 'i_data'), JSON.stringify(upTargets))

// 实例输出 pin（u_child.o_y）作为 driver：可向下进入子模块 net o_y
const childOutDriver = traceNet(database, topCtx, 'w_mid', 'driver')
  .find((item) => item.kind === 'cell' && item.name === 'u_child')
const downDriverTargets = childOutDriver ? continueTrace(database, topCtx, childOutDriver, 'driver') : []
check('driver 可向下跨入子模块', downDriverTargets.some((item) => item.context.module === 'child' && item.net === 'o_y'), JSON.stringify(downDriverTargets))

console.log('')
// ---- 中文路径乱码修复（Yosys 按 GBK 输出 src）----
const { DesignBrowserService } = await import('../src/main/services/DesignBrowserService.ts')
const cnRoot = join(root, '小数分频器')
const { mkdirSync } = await import('node:fs')
mkdirSync(cnRoot, { recursive: true })
writeFileSync(join(cnRoot, 'frac_divider.v'), `module frac_divider(input wire clk, output reg o_pulse);
  always @(posedge clk) o_pulse <= ~o_pulse;
endmodule
`)
const cnDatabase = await elaborateDesign({
  rtlFiles: [join(cnRoot, 'frac_divider.v')],
  topModule: 'frac_divider',
  outputJson: join(root, 'frac.json')
})
const cnService = new DesignBrowserService(root)
cnService.start()
let cnReadError = ''
let cnContent = null
try {
  cnContent = cnService.readSource(cnRoot, cnDatabase.hierarchy.source)
} catch (reason) {
  cnReadError = reason instanceof Error ? reason.message : String(reason)
}
check('中文路径 src 可读取', cnContent?.content.includes('frac_divider') === true, cnReadError || cnDatabase.hierarchy.source)
check('中文路径返回项目内相对路径', cnContent?.file === 'frac_divider.v', cnContent?.file)
cnService.stop()

console.log(failures === 0 ? '✅ RTL Design Browser 冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
