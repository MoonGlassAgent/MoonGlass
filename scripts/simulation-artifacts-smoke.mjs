/**
 * 验证 Verilator 仿真产物稳定落盘：
 * compile.log / simulation.log / result.json / waveform.vcd。
 *
 * 运行：node scripts/simulation-artifacts-smoke.mjs
 */
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { runVerilatorSimulation } = await import('../packages/eda-bridge/src/simulation.ts')

const root = mkdtempSync(join(tmpdir(), 'moonglass-sim-artifacts-'))
const rtlFile = join(root, 'counter.v')
const tbFile = join(root, 'sim_main.cpp')

writeFileSync(rtlFile, `module counter (
  input wire i_clk,
  input wire i_rst_n,
  output reg [3:0] o_count
);
always @(posedge i_clk or negedge i_rst_n) begin
  if (!i_rst_n) o_count <= 0;
  else o_count <= o_count + 1;
end
endmodule
`)

writeFileSync(tbFile, `#include <verilated.h>
#include <verilated_vcd_c.h>
#include "Vcounter.h"
vluint64_t main_time = 0;
double sc_time_stamp() { return main_time; }
int main(int argc, char** argv) {
  Verilated::commandArgs(argc, argv);
  Verilated::traceEverOn(true);
  Vcounter top;
  VerilatedVcdC trace;
  top.trace(&trace, 5);
  trace.open("counter.vcd");
  top.i_rst_n = 0;
  for (int i = 0; i < 20; i++) {
    if (i == 2) top.i_rst_n = 1;
    top.i_clk = i & 1;
    top.eval();
    trace.dump(main_time++);
  }
  top.final();
  trace.close();
  return 0;
}
`)

const result = await runVerilatorSimulation({
  topModule: 'counter',
  tbCpp: tbFile,
  rtlFiles: [rtlFile],
  trace: true
})

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

check('仿真通过', result.passed)
check('编译日志落盘', existsSync(result.compileLogPath), result.compileLogPath)
check('仿真日志落盘', existsSync(result.simulationLogPath), result.simulationLogPath)
check('结构化结果落盘', existsSync(result.resultPath), result.resultPath)
check('VCD 波形落盘', Boolean(result.vcdPath && existsSync(result.vcdPath)), result.vcdPath ?? '')
check('VCD 位于固定结果目录', result.vcdPath?.includes(join('results', 'counter')) === true)

const metadata = JSON.parse(readFileSync(result.resultPath, 'utf-8'))
check('result.json 记录通过状态', metadata.passed === true)
check('result.json 记录波形路径', metadata.waveformPath === result.vcdPath)

console.log('')
console.log(failures === 0 ? '✅ 仿真产物冒烟全部通过' : `❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
