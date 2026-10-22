// 端口解析回归冒烟：修复前 PORT_DIR 正则把 `input wire en` 中的 `wire` 误当端口名
// （(\[.*?\])? 失配后 (\w+) 吃掉类型关键字），generate_tb 会驱动不存在的 top->wire。
// 本 smoke 进程内加载 moonglass-tools 的 generate_tb，验证端口名/位宽提取与生成的
// C++ TB 驱动行，不实际运行 Verilator，保持秒级完成。
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const root = resolve('out', `tb-port-parse-smoke-${process.pid}`)
const bridgeDir = join(root, 'bridge')
mkdirSync(join(bridgeDir, 'eda-bridge', 'src'), { recursive: true })
mkdirSync(join(bridgeDir, 'verification-intelligence', 'src'), { recursive: true })

// 与 waveform-guard-smoke 一致：把 pi-bridge 扩展与共享实现复制到独立目录后 import。
// 放在仓库 out/ 下而非系统临时目录，是为了让 Node 沿目录树解析到仓库 node_modules。
for (const f of ['moonglass-tools.ts', 'rtl-write-guard.ts']) {
  writeFileSync(join(bridgeDir, f), readFileSync(join('resources', 'moonglass', 'pi-bridge', f), 'utf-8'))
}
for (const f of ['tool-runner.ts', 'rtl-files.ts', 'simulation.ts', 'synthesis.ts', 'lint.ts', 'formal.ts', 'dead-logic.ts', 'slang-runner.ts']) {
  writeFileSync(join(bridgeDir, 'eda-bridge', 'src', f), readFileSync(join('packages', 'eda-bridge', 'src', f), 'utf-8'))
}
for (const f of ['engine.ts', 'types.ts', 'structural-analyzer.ts']) {
  writeFileSync(join(bridgeDir, 'verification-intelligence', 'src', f), readFileSync(join('packages', 'verification-intelligence-engine', 'src', f), 'utf-8'))
}
// moonglass-tools.ts 运行时依赖 typebox（pnpm 下仅在 .pnpm 虚拟存储中），建 junction 使其可解析
const pnpmDir = join(process.cwd(), 'node_modules', '.pnpm')
const typeboxStore = readdirSync(pnpmDir).find((d) => d.startsWith('typebox@'))
if (!typeboxStore) {
  console.error('❌ 未找到 node_modules/.pnpm/typebox@*，无法加载 moonglass-tools')
  process.exit(1)
}
mkdirSync(join(bridgeDir, 'node_modules'), { recursive: true })
symlinkSync(join(pnpmDir, typeboxStore, 'node_modules', 'typebox'), join(bridgeDir, 'node_modules', 'typebox'), 'junction')

const tools = new Map()
const registerTools = (await import(pathToFileURL(join(bridgeDir, 'moonglass-tools.ts')).href)).default
registerTools({ registerTool: (def) => tools.set(def.name, def), on: () => {} })
const generateTb = tools.get('generate_tb')
check('generate_tb 已注册', Boolean(generateTb))

// 覆盖缺陷端口形态：net 类型（wire/reg）、signedness（signed）、data type（logic）、无关键字
const RTL = `module port_parse_dut(
  input wire i_clk,
  input wire i_rst_n,
  input wire en,
  input wire signed [3:0] data,
  input logic mode,
  input signed [3:0] s_val,
  input [7:0] plain,
  output reg [7:0] o_q
);
always @(posedge i_clk or negedge i_rst_n) begin
  if (!i_rst_n) o_q <= 8'b0;
  else if (en) o_q <= {data, s_val} ^ plain ^ {7'b0, mode};
end
endmodule
`

const caseDir = join(root, 'case')
mkdirSync(caseDir, { recursive: true })
const rtl = join(caseDir, 'port_parse_dut.v')
writeFileSync(rtl, RTL)
const ctx = { cwd: caseDir }

const gen = await generateTb.execute('tp-tb-1', { rtlFile: rtl, numCycles: 10, trace: false }, undefined, undefined, ctx)
const tbPath = gen.details?.outputPath
check('generate_tb 生成 TB', typeof tbPath === 'string' && existsSync(tbPath))
const tbSource = tbPath ? readFileSync(tbPath, 'utf-8') : ''
const reportText = gen.content?.[0]?.text ?? ''
const ports = gen.details?.ports ?? []
const portNames = ports.map((p) => p.name)

// 端口名提取：真实端口齐全，类型关键字不得被误当端口名
for (const name of ['en', 'data', 'o_q', 'mode', 's_val', 'plain']) {
  check(`端口表包含 ${name}`, portNames.includes(name))
}
for (const bogus of ['wire', 'reg', 'signed', 'logic']) {
  check(`端口表不存在伪端口 ${bogus}`, !portNames.includes(bogus))
}

// 位宽提取：跨 signedness / net 类型关键字的 packed 维度仍须生效
const widthOf = (name) => ports.find((p) => p.name === name)?.width
check('data 宽度为 4', widthOf('data') === 4, `实际 ${widthOf('data')}`)
check('s_val 宽度为 4', widthOf('s_val') === 4, `实际 ${widthOf('s_val')}`)
check('plain 宽度为 8', widthOf('plain') === 8, `实际 ${widthOf('plain')}`)
check('o_q 宽度为 8', widthOf('o_q') === 8, `实际 ${widthOf('o_q')}`)
check('en 宽度为 1', widthOf('en') === 1, `实际 ${widthOf('en')}`)

// 生成的 TB 驱动真实端口，不得驱动被误解析出的类型关键字
check('TB 含 top->en = 驱动', tbSource.includes('top->en ='))
check('TB 含 top->data = 驱动', tbSource.includes('top->data ='))
check('TB 不含 top->wire（缺陷回归）', !tbSource.includes('top->wire'))
check('TB 不含 top->reg / top->signed', !tbSource.includes('top->reg') && !tbSource.includes('top->signed'))

// 报告文本中的端口映射表同样不得出现伪端口名
check('报告端口表不含 | wire | 伪端口', !/\|\s*wire\s*\|/.test(reportText))

if (failures === 0) {
  rmSync(root, { recursive: true, force: true })
  console.log('\n✅ 端口解析冒烟通过')
} else {
  console.log(`\n❌ ${failures} 项失败（现场保留在 ${root}）`)
}
process.exit(failures === 0 ? 0 : 1)
