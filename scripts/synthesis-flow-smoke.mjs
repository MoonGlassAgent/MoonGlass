/**
 * Phase 6 综合链冒烟测试：
 * 1. 生成含时钟与 I/O delay 的 SDC。
 * 2. 默认使用本机 Nangate45 typical Liberty 完成映射。
 * 3. 输出门级网表、JSON、日志、面积与 Markdown 报告。
 *
 * 运行：node scripts/synthesis-flow-smoke.mjs
 */
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const {
  generateSdc,
  runLogicSynthesis
} = await import('../packages/eda-bridge/src/synthesis.ts')

const RTL = `module counter (
  input  wire       i_clk,
  input  wire       i_rst_n,
  input  wire       i_enable,
  output reg  [7:0] o_count
);
  always @(posedge i_clk or negedge i_rst_n) begin
    if (!i_rst_n) o_count <= 8'd0;
    else if (i_enable) o_count <= o_count + 8'd1;
  end
endmodule
`

const root = mkdtempSync(join(tmpdir(), 'moonglass-synthesis-smoke-'))
const rtlPath = join(root, 'counter.v')
const sdcPath = join(root, 'imp', 'counter.sdc')
const outputDir = join(root, 'imp', 'synthesis')
writeFileSync(rtlPath, RTL)

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const sdc = generateSdc({
  clocks: [
    {
      name: 'core_clk',
      port: 'i_clk',
      periodNs: 10,
      uncertaintyNs: 0.2
    }
  ],
  ioDelays: [
    { direction: 'input', ports: ['i_enable'], delayNs: 1, clockName: 'core_clk' },
    { direction: 'output', ports: ['o_count'], delayNs: 1.5, clockName: 'core_clk' }
  ],
  outputPath: sdcPath
})

check('SDC 文件已生成', existsSync(sdcPath))
check('SDC 包含 10ns 时钟', sdc.content.includes('create_clock -name core_clk -period 10'))
check('SDC 包含输入延迟', sdc.content.includes('set_input_delay 1 '))
check('SDC 包含输出延迟', sdc.content.includes('set_output_delay 1.5 '))

const result = await runLogicSynthesis({
  rtlFiles: [rtlPath],
  topModule: 'counter',
  outputDir,
  sdcFile: sdcPath
})

check('综合成功', result.success)
check('门级网表已输出', existsSync(result.netlistPath))
check('JSON 网表已输出', existsSync(result.jsonPath))
check('Yosys 日志已输出', existsSync(result.logPath))
check('Markdown 报告已输出', existsSync(result.reportPath))
check('网表包含顶层模块', readFileSync(result.netlistPath, 'utf-8').includes('module counter'))
check('报告包含时钟周期', readFileSync(result.reportPath, 'utf-8').includes('10 ns'))
check(
  '默认使用 Nangate45 typical Liberty',
  result.area.mode === 'liberty' && /NangateOpenCellLibrary_typical\.lib$/i.test(result.targetLibrary ?? ''),
  result.targetLibrary
)
check('默认库生成映射面积', result.area.value !== undefined, `${result.area.value ?? 'unavailable'}`)
check('未解析到 ABC 延迟时不伪造时序', result.timing.available === false || result.timing.delayNs !== undefined)
check('综合后存在单元统计', result.area.cells > 0, `${result.area.cells} cells`)

console.log('')
console.log(failures === 0 ? '✅ Phase 6 综合链冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
