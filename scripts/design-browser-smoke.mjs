import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
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

// ---- 跨层次追踪（v2 冻结口径，Yosys bit 级连通图）----
const { topContext, traceNetV2, continueTraceV2 } = await import('../packages/design-browser-engine/src/trace.ts')
const topCtx = topContext(database)
const childCtx = { instancePath: 'top.u_child', module: 'child' }

// 顶层 input port：已处顶层 IO，向上追踪终止
const topInputDriver = traceNetV2(database, topCtx, 'i_data', 'driver')
  .find((item) => item.kind === 'port')
check('顶层 IO driver 追踪终止', topInputDriver && continueTraceV2(database, topCtx, topInputDriver, 'driver').length === 0)

// 实例输入 pin（u_child.i_a）作为 load：可向下进入子模块 net i_a
const childPinLoad = traceNetV2(database, topCtx, 'i_data', 'load')
  .find((item) => item.kind === 'cell' && item.name === 'u_child')
const downTargets = childPinLoad ? continueTraceV2(database, topCtx, childPinLoad, 'load') : []
check('load 可向下跨入子模块', downTargets.some((item) => item.context.instancePath === 'top.u_child' && item.net === 'i_a'), JSON.stringify(downTargets))

// 子模块 input port（child.i_a）作为 driver：可向上跨回顶层 net i_data
const childPortDriver = traceNetV2(database, childCtx, 'i_a', 'driver')
  .find((item) => item.kind === 'port')
const upTargets = childPortDriver ? continueTraceV2(database, childCtx, childPortDriver, 'driver') : []
check('driver 可向上跨回父模块', upTargets.some((item) => item.context.instancePath === 'top' && item.net === 'i_data'), JSON.stringify(upTargets))

// 实例输出 pin（u_child.o_y）作为 driver：可向下进入子模块 net o_y
const childOutDriver = traceNetV2(database, topCtx, 'w_mid', 'driver')
  .find((item) => item.kind === 'cell' && item.name === 'u_child')
const downDriverTargets = childOutDriver ? continueTraceV2(database, topCtx, childOutDriver, 'driver') : []
check('driver 可向下跨入子模块', downDriverTargets.some((item) => item.context.module === 'child' && item.net === 'o_y'), JSON.stringify(downDriverTargets))

// ================= Design Browser v3（slang 前端，RTL 级数据模型） =================
console.log('')
const { DesignBrowserService } = await import('../src/main/services/DesignBrowserService.ts')

// v3 fixture：always_ff + always_comb + assign + 参数 + 实例连接（含位选）+ 参数覆盖
const v3ws = join(root, 'v3ws')
mkdirSync(join(v3ws, 'rtl'), { recursive: true })
writeFileSync(join(v3ws, 'rtl', 'child.v'), `module child #(
  parameter int DW = 8
)(
  input  wire          i_clk,
  input  wire          i_rst_n,
  input  wire [DW-1:0] i_d,
  output reg  [DW-1:0] o_q
);
  always_ff @(posedge i_clk or negedge i_rst_n) begin
    if (!i_rst_n) o_q <= '0;
    else          o_q <= i_d;
  end
endmodule
`)
writeFileSync(join(v3ws, 'rtl', 'top.v'), `module top #(
  parameter int WIDTH = 4
)(
  input  wire         i_clk,
  input  wire         i_rst_n,
  input  wire [3:0]   i_data,
  output wire [11:0]  o_bus
);
  localparam int HALF = 4;

  wire [3:0] w_sel;
  reg  [7:0] r_bus;
  wire [7:0] w_q8;
  wire [3:0] w_q4;

  assign w_sel = i_data[WIDTH-1:0] & {4{1'b1}};

  always_comb begin
    r_bus[HALF-1:0] = w_sel;
    r_bus[7:4]      = w_q8[7:4] ^ i_data;
  end

  child #(.DW(8)) u_data (
    .i_clk  (i_clk),
    .i_rst_n(i_rst_n),
    .i_d    (r_bus),
    .o_q    (w_q8)
  );

  child #(.DW(4)) u_sel (
    .i_clk  (i_clk),
    .i_rst_n(i_rst_n),
    .i_d    (r_bus[7:4]),
    .o_q    (w_q4)
  );

  assign o_bus = {w_q8[3:0], w_q4, r_bus[3:0]};
endmodule
`)
writeFileSync(join(v3ws, 'rtl', 'design.json'), JSON.stringify({
  topModule: 'top',
  files: ['rtl/child.v', 'rtl/top.v']
}))

const dataDir = join(root, 'data')
const service = new DesignBrowserService(dataDir)
service.start()
const v3 = await service.elaborate('p1', v3ws, 'top')

check('v3 数据库版本与前端', v3.version === 3 && v3.frontend === 'slang', `v${v3.version}/${v3.frontend}`)
check('v3 解析两个模块', v3.modules.length === 2, String(v3.modules.length))
check('v3 rtlInputHash 已挂', typeof v3.rtlInputHash === 'string' && v3.rtlInputHash.length > 0)

const v3top = v3.modules.find((module) => module.name === 'top')
const v3child = v3.modules.find((module) => module.name === 'child')

// ---- 字段映射：参数 / 端口 / 信号 ----
check('v3 顶层参数 WIDTH=4', v3top?.parameters.some((parameter) => parameter.name === 'WIDTH' && parameter.valueText === '4') === true, JSON.stringify(v3top?.parameters))
check('v3 子模块参数 DW 首见者取值', v3child?.parameters.some((parameter) => parameter.name === 'DW' && parameter.valueText === '8') === true, JSON.stringify(v3child?.parameters))
const portIData = v3top?.ports.find((port) => port.name === 'i_data')
check('v3 端口类型原文与位宽', portIData?.type === 'logic[3:0]' && portIData.width === 4, JSON.stringify(portIData))
const signalWsel = v3top?.signals.find((signal) => signal.name === 'w_sel')
const signalRbus = v3top?.signals.find((signal) => signal.name === 'r_bus')
const signalClk = v3top?.signals.find((signal) => signal.name === 'i_clk')
check('v3 信号 w_sel：wire/宽 4/源码位置', signalWsel?.kind === 'wire' && signalWsel.width === 4 && signalWsel.source?.startsWith('rtl/top.v:') === true, JSON.stringify(signalWsel))
check('v3 信号 r_bus：reg/宽 8', signalRbus?.kind === 'reg' && signalRbus.width === 8, JSON.stringify(signalRbus))
check('v3 端口信号 isPort/direction', signalClk?.isPort === true && signalClk.direction === 'input', JSON.stringify(signalClk))

// ---- 字段映射：过程块（clock/reset/drives/reads） ----
const ffProc = v3child?.processes.find((process) => process.kind === 'always_ff')
const combProc = v3top?.processes.find((process) => process.kind === 'always_comb')
const assignProcs = v3top?.processes.filter((process) => process.kind === 'assign') ?? []
check('v3 always_ff 时钟/复位提取（子模块）', ffProc?.clock === 'i_clk' && ffProc.reset === 'i_rst_n', JSON.stringify(ffProc && { clock: ffProc.clock, reset: ffProc.reset }))
check('v3 always_ff 写 o_q 读 i_d/i_rst_n', ffProc?.drives.includes('o_q') === true && ['i_d', 'i_rst_n'].every((name) => ffProc.reads.includes(name)) === true, JSON.stringify(ffProc && { drives: ffProc.drives, reads: ffProc.reads }))
check('v3 always_comb 写 r_bus（位选取基名）', combProc?.drives.includes('r_bus') === true, JSON.stringify(combProc?.drives))
check('v3 always_comb 读 w_sel/w_q8/i_data', ['w_sel', 'w_q8', 'i_data'].every((name) => combProc?.reads.includes(name)) === true, JSON.stringify(combProc?.reads))
check('v3 assign 过程块两条', assignProcs.length === 2, String(assignProcs.length))
check('v3 assign 写 w_sel', assignProcs.some((process) => process.drives.includes('w_sel')) === true)
check('v3 process 稳定序号 P1/P2…', (v3top?.processes.every((process, index) => process.id === `P${index + 1}`) ?? false) === true, JSON.stringify(v3top?.processes.map((process) => process.id)))

// ---- 字段映射：实例连接（含位选保守口径）与参数覆盖 ----
const uData = v3top?.instances.find((instance) => instance.name === 'u_data')
const uSel = v3top?.instances.find((instance) => instance.name === 'u_sel')
check('v3 实例 u_data 模块与参数覆盖', uData?.module === 'child' && uData.parameterOverrides.DW === '8', JSON.stringify(uData && { module: uData.module, overrides: uData.parameterOverrides }))
check('v3 实例 u_sel 参数覆盖 DW=4', uSel?.parameterOverrides.DW === '4', JSON.stringify(uSel?.parameterOverrides))
const connID = uData?.connections.find((connection) => connection.pin === 'i_d')
check('v3 纯 NamedValue 连接给 signal', connID?.signal === 'r_bus' && connID.expr === 'r_bus', JSON.stringify(connID))
const connSelD = uSel?.connections.find((connection) => connection.pin === 'i_d')
check('v3 位选连接保守口径（expr 源文本、signal 缺省）', connSelD?.signal === undefined && connSelD?.expr === 'r_bus[7:4]', JSON.stringify(connSelD))
check('v3 层次树实例参数覆盖', v3.hierarchy.children.find((node) => node.name === 'u_sel')?.parameterOverrides.DW === '4')
check('v3 sourceFiles 工作区相对路径', v3.sourceFiles.every((file) => !/^[A-Za-z]:[\\/]/.test(file)) === true, JSON.stringify(v3.sourceFiles))

// ---- trace 三态端点语义 ----
const { traceNet, continueTrace } = await import('../packages/design-browser-engine/src/trace.ts')
const v3TopCtx = { instancePath: 'top', module: 'top' }
const v3DataCtx = { instancePath: 'top.u_data', module: 'child' }

const rbusDrivers = traceNet(v3, v3TopCtx, 'r_bus', 'driver')
const rbusLoads = traceNet(v3, v3TopCtx, 'r_bus', 'load')
check('v3 r_bus driver 为语句级端点', rbusDrivers.some((endpoint) => endpoint.kind === 'statement' && endpoint.label.startsWith('always_comb @ rtl/top.v:')) === true, JSON.stringify(rbusDrivers.map((endpoint) => endpoint.label)))
check('v3 r_bus load 含实例 pin（保守匹配位选连接）', rbusLoads.some((endpoint) => endpoint.kind === 'instancePin' && endpoint.label === 'u_sel.i_d') === true, JSON.stringify(rbusLoads.map((endpoint) => endpoint.label)))
check('v3 r_bus load 含 assign 语句（位选读）', rbusLoads.some((endpoint) => endpoint.kind === 'statement' && endpoint.label.startsWith('assign @')) === true)

const wq8Drivers = traceNet(v3, v3TopCtx, 'w_q8', 'driver')
check('v3 w_q8 driver 为输出 pin 端点', wq8Drivers.some((endpoint) => endpoint.kind === 'instancePin' && endpoint.label === 'u_data.o_q' && endpoint.direction === 'output') === true, JSON.stringify(wq8Drivers.map((endpoint) => endpoint.label)))

const clkDrivers = traceNet(v3, v3TopCtx, 'i_clk', 'driver')
check('v3 i_clk driver 为 PORT 端点', clkDrivers.some((endpoint) => endpoint.kind === 'port' && endpoint.label === 'PORT i_clk') === true, JSON.stringify(clkDrivers.map((endpoint) => endpoint.label)))
const clkLoads = traceNet(v3, v3TopCtx, 'i_clk', 'load')
check('v3 i_clk load 含两个实例输入 pin', clkLoads.filter((endpoint) => endpoint.kind === 'instancePin').length === 2, JSON.stringify(clkLoads.map((endpoint) => endpoint.label)))

// 端点零 $ 前缀（硬口径 G1）+ 源码位置齐备
const allEndpoints = v3.modules.flatMap((module) => module.traces.flatMap((trace) => [...trace.drivers, ...trace.loads]))
check('v3 端点零 $ 单元名', allEndpoints.every((endpoint) => !endpoint.label.includes('$')) === true, allEndpoints.find((endpoint) => endpoint.label.includes('$'))?.label)
check('v3 端点源码位置为工作区相对路径', allEndpoints.every((endpoint) => !endpoint.source || (!endpoint.source.includes('$') && endpoint.source.includes('rtl/'))) === true, allEndpoints.find((endpoint) => endpoint.source && !endpoint.source.includes('rtl/'))?.source)

// ---- 跨层缝合：instancePin 下钻 / port 上溯 ----
const wq8PinDriver = wq8Drivers.find((endpoint) => endpoint.kind === 'instancePin')
const downIntoChild = wq8PinDriver ? continueTrace(v3, v3TopCtx, wq8PinDriver, 'driver') : []
check('v3 driver 经输出 pin 下钻子模块 port 信号', downIntoChild.some((target) => target.context.instancePath === 'top.u_data' && target.net === 'o_q'), JSON.stringify(downIntoChild))
if (downIntoChild.length) {
  const childDrivers = traceNet(v3, downIntoChild[0].context, downIntoChild[0].net, 'driver')
  check('v3 子模块 o_q driver 为 always_ff 语句', childDrivers.some((endpoint) => endpoint.kind === 'statement' && endpoint.label.startsWith('always_ff @ rtl/child.v:')) === true, JSON.stringify(childDrivers.map((endpoint) => endpoint.label)))
}
const childInputPortDriver = traceNet(v3, v3DataCtx, 'i_d', 'driver').find((endpoint) => endpoint.kind === 'port')
const upToParent = childInputPortDriver ? continueTrace(v3, v3DataCtx, childInputPortDriver, 'driver') : []
check('v3 driver 经子模块 port 上溯父网', upToParent.some((target) => target.context.instancePath === 'top' && target.net === 'r_bus'), JSON.stringify(upToParent))
const stmtEndpoint = rbusDrivers.find((endpoint) => endpoint.kind === 'statement')
check('v3 statement 端点为本层终点', stmtEndpoint ? continueTrace(v3, v3TopCtx, stmtEndpoint, 'driver').length === 0 : false)

// ---- AST 缓存与 getCached 口径 ----
const cacheDir = join(dataDir, 'moonglass', 'slang-ast-cache')
const cacheFiles = existsSync(cacheDir) ? (await import('node:fs')).readdirSync(cacheDir).filter((name) => name.endsWith('.json')) : []
check('v3 AST 已按 rtlHash 落缓存', cacheFiles.length === 1, JSON.stringify(cacheFiles))
const cacheMtime = cacheFiles.length ? statSync(join(cacheDir, cacheFiles[0])).mtimeMs : 0
const v3Again = await service.elaborate('p1', v3ws, 'top')
check('v3 重复 elaborate 命中 AST 缓存（mtime 不变）', statSync(join(cacheDir, cacheFiles[0])).mtimeMs === cacheMtime && v3Again.version === 3)
const cached = service.getCached('p1', v3ws)
check('getCached 接受 v3 且 rtl 未变更', cached?.database.version === 3 && cached.rtlStale === false)

// ---- 回退路径：slang 不可用 → v2 + diagnostics 登记降级原因 ----
// 独立 dataDir（空 AST 缓存）：缓存命中本就可以绕过 slang 不可用，回退测试必须冷缓存
const fallbackService = new DesignBrowserService(join(root, 'data-fallback'))
fallbackService.start()
process.env.MOONGLASS_SLANG_PATH = join(root, 'no-such-slang.exe')
const v2fallback = await fallbackService.elaborate('p2', v3ws, 'top')
check('slang 缺失回退 v2', v2fallback.version === 2 && v2fallback.frontend === 'yosys', `v${v2fallback.version}/${v2fallback.frontend}`)
check('回退 diagnostics 登记降级原因', v2fallback.diagnostics.some((diagnostic) => diagnostic.message.includes('已回退') && diagnostic.message.includes('slang')) === true, JSON.stringify(v2fallback.diagnostics))
check('v2 回退也挂 rtlInputHash', typeof v2fallback.rtlInputHash === 'string' && v2fallback.rtlInputHash.length > 0)
check('v2 缓存 getCached 判过期（返回 null）', fallbackService.getCached('p2', v3ws) === null)
delete process.env.MOONGLASS_SLANG_PATH
fallbackService.stop()
service.stop()

// ---- 中文路径：v3 相对路径口径零特殊处理（mojibake 修复函数已删除） ----
console.log('')
const cnRoot = join(root, '小数分频器')
mkdirSync(join(cnRoot, 'rtl'), { recursive: true })
writeFileSync(join(cnRoot, 'rtl', 'frac_divider.v'), `module frac_divider(input wire clk, output reg o_pulse);
  always @(posedge clk) o_pulse <= ~o_pulse;
endmodule
`)
const cnService = new DesignBrowserService(join(root, 'cn-data'))
cnService.start()
const cnDatabase = await cnService.elaborate('cn', cnRoot, 'frac_divider')
let cnReadError = ''
let cnContent = null
try {
  cnContent = cnService.readSource(cnRoot, cnDatabase.hierarchy.source)
} catch (reason) {
  cnReadError = reason instanceof Error ? reason.message : String(reason)
}
check('中文路径 v3 src 可读取', cnContent?.content.includes('frac_divider') === true, cnReadError || cnDatabase.hierarchy.source)
check('中文路径返回项目内相对路径', cnContent?.file?.replace(/\\/g, '/') === 'rtl/frac_divider.v', cnContent?.file)
cnService.stop()

console.log(failures === 0 ? '✅ RTL Design Browser 冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
