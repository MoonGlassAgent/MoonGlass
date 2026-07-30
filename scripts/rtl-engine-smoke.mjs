/**
 * RTL 引擎冒烟脚本
 *
 * 验证 parseVerilog 与 generateRtlTemplate 的解析/生成闭环：
 * 1. 解析 ANSI 参数化模块（counter）
 * 2. 验证端口/参数/模块名提取正确
 * 3. 生成新模板并写入文件
 * 4. 解析生成的模板，验证二次解析一致
 *
 * 运行：node scripts/rtl-engine-smoke.mjs
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseVerilog, generateRtlTemplate } from '../packages/rtl-engine/src/index.ts'

const RTL = `module counter #(
  parameter WIDTH = 8
)(
  input  wire       i_clk,
  input  wire       i_rst_n,
  output wire [WIDTH-1:0] o_count
);
  reg [WIDTH-1:0] r_count;
  assign o_count = r_count;
endmodule
`

const dir = mkdtempSync(join(tmpdir(), 'rtl-engine-smoke-'))
const src = join(dir, 'counter.v')
writeFileSync(src, RTL)

let failures = 0
function check(name, cond, detail = '') {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}

const info = await parseVerilog({ filePath: src, extractHierarchy: true })

check('模块名解析', info.moduleName === 'counter')
check('参数解析', info.parameters.length === 1 && info.parameters[0].name === 'WIDTH')
check('端口数量', info.ports.length === 3, `${info.ports.length} 个端口`)
check('时钟端口', info.ports.some((p) => p.name === 'i_clk' && p.direction === 'input' && p.width === 1))
check('复位端口', info.ports.some((p) => p.name === 'i_rst_n' && p.direction === 'input' && p.width === 1))
check('输出向量宽度保留', info.ports.some((p) => p.name === 'o_count' && p.direction === 'output' && p.widthSpec === '[WIDTH-1:0]'))
check('无实例', info.instances.length === 0)

const out = join(dir, 'counter_tmpl.v')
const result = await generateRtlTemplate({
  moduleName: 'counter_tmpl',
  interface: info,
  outputPath: out
})

check('模板文件已生成', result.filePath === out && result.code.includes('module counter_tmpl'))
check('模板含参数化位宽', result.code.includes('output wire [WIDTH-1:0] o_count'))
check('模板含异步复位同步释放', result.code.includes('always @(posedge i_clk or negedge i_rst_n)'))

const reParsed = await parseVerilog({ filePath: out })
check('二次解析模块名', reParsed.moduleName === 'counter_tmpl')
check('二次解析端口数', reParsed.ports.length === 3, `${reParsed.ports.length} 个端口`)

console.log('')
console.log(failures === 0 ? '✅ RTL 引擎冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
