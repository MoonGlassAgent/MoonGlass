import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { runCocotbSimulation, runVerilatorSimulation } = await import('../packages/eda-bridge/src/simulation.ts')
const root = mkdtempSync(join(tmpdir(), 'moonglass-verilator-coverage-'))
const testDir = join(root, 'verification', 'counter_tb')
const buildDir = join(testDir, 'sim', 'sim_build')
const resultDir = join(root, 'verification', 'results', 'counter')
mkdirSync(join(testDir, 'tests'), { recursive: true })

const rtl = join(root, 'counter.v')
writeFileSync(rtl, `module counter(input wire clk, input wire rst_n, input wire en, output reg [2:0] count);
always @(posedge clk or negedge rst_n) begin
  if (!rst_n) count <= 0;
  else if (en) count <= count + 1'b1;
  else count <= count;
end
endmodule
`)
const tbCpp = join(root, 'sim_main.cpp')
writeFileSync(tbCpp, `#include <verilated.h>
#include "Vcounter.h"
double sc_time_stamp() { return 0; }
int main(int argc, char** argv) {
  Verilated::commandArgs(argc, argv); Vcounter top; top.rst_n = 0; top.en = 0;
  for (int i = 0; i < 12; ++i) { if (i == 2) top.rst_n = 1; if (i == 4) top.en = 1; if (i == 10) top.en = 0; top.clk = i & 1; top.eval(); }
  top.final(); return 0;
}
`)
writeFileSync(join(testDir, 'tests', '__init__.py'), '')
writeFileSync(join(testDir, 'tests', 'test_counter.py'), `import json, os
import cocotb
from cocotb.clock import Clock
from cocotb.triggers import RisingEdge

@cocotb.test()
async def counter_paths(dut):
    cocotb.start_soon(Clock(dut.clk, 10, unit="ns").start())
    dut.rst_n.value = 0
    dut.en.value = 0
    await RisingEdge(dut.clk)
    dut.rst_n.value = 1
    dut.en.value = 1
    for _ in range(3): await RisingEdge(dut.clk)
    dut.en.value = 0
    await RisingEdge(dut.clk)
    assert int(dut.count.value) == 3
    with open(os.environ["MOONGLASS_FUNCTIONAL_COVERAGE_FILE"], "w", encoding="utf-8") as f:
        json.dump({"totalBins": 4, "coveredBins": 4}, f)
`)

const functionalResult = await runCocotbSimulation({
  topModule: 'counter', rtlFiles: [rtl], testModule: 'tests.test_counter', testDir,
  simulator: 'icarus', waves: false, buildDir, resultDir, timeoutSec: 180
})
const functionalMetadata = JSON.parse(readFileSync(functionalResult.resultPath, 'utf-8'))
const rtlResult = await runVerilatorSimulation({
  topModule: 'counter', tbCpp, rtlFiles: [rtl], trace: false, rtlCoverage: true,
  buildDir: join(root, 'obj_dir'), resultDir
})
const rtlMetadata = JSON.parse(readFileSync(rtlResult.resultPath, 'utf-8'))
let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}
check('Verilator C++ 签核回归通过', rtlResult.passed)
check('coverage.dat 已落盘', Boolean(rtlResult.coverageDataPath && existsSync(rtlResult.coverageDataPath)))
check('覆盖率报告已落盘', Boolean(rtlResult.coverageReportPath && existsSync(rtlResult.coverageReportPath)))
check('行覆盖率已解析', typeof rtlMetadata.lineCoverage === 'number', String(rtlMetadata.lineCoverage))
check('条件/分支覆盖率已解析', typeof rtlMetadata.branchCoverage === 'number', String(rtlMetadata.branchCoverage))
check('Cocotb + Icarus 功能回归通过', functionalResult.passed)
check('功能覆盖率已归档', functionalMetadata.functionalCoverage === 100, String(functionalMetadata.functionalCoverage))
check('双通道结果合并通过', rtlMetadata.passed && rtlMetadata.functionalPassed && rtlMetadata.rtlCoveragePassed)
check('合并后功能覆盖率仍保留', rtlMetadata.functionalCoverage === 100, String(rtlMetadata.functionalCoverage))
check('Icarus 与 Verilator 日志独立归档',
  String(rtlMetadata.rtlCompileLogPath).endsWith('compile_verilator.log') &&
  String(rtlMetadata.functionalCompileLogPath).endsWith('compile_icarus.log') &&
  existsSync(rtlMetadata.rtlCompileLogPath) && existsSync(rtlMetadata.functionalCompileLogPath))
console.log(failures === 0 ? '\n✅ Verilator 覆盖率闭环冒烟通过' : `\n❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
