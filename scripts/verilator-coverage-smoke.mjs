import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { runCocotbSimulation, runVerilatorSimulation, parseVerilatorCoverageDetail } = await import('../packages/eda-bridge/src/simulation.ts')
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

// ---- 覆盖率明细（逐检测点）闭环 ----
const detail = parseVerilatorCoverageDetail(rtlResult.coverageDataPath ?? join(resultDir, 'coverage.dat'))
check('覆盖率明细解析成功', detail !== null && detail.files.some((f) => f.file.endsWith('counter.v')))
const counterDetail = detail?.files.find((f) => f.file.endsWith('counter.v'))
check('counter.v 检测点含行号与命中次数字段', Boolean(counterDetail?.points.every((p) => typeof p.line === 'number' && typeof p.hits === 'number')))
const detailJsonPath = join(resultDir, 'coverage-detail.json')
check('coverage-detail.json 已落盘', existsSync(detailJsonPath))
if (existsSync(detailJsonPath)) {
  const cachedDetail = JSON.parse(readFileSync(detailJsonPath, 'utf-8'))
  check('明细缓存含 files', Array.isArray(cachedDetail.files) && cachedDetail.files.length > 0)
}
const coverageJson = JSON.parse(readFileSync(join(resultDir, 'coverage.json'), 'utf-8'))
check('明细汇总与 coverage.json 聚合值一致',
  detail?.summary.line === coverageJson.lineCoverage &&
  detail?.summary.branch === coverageJson.branchCoverage &&
  detail?.summary.expression === coverageJson.expressionCoverage &&
  detail?.summary.toggle === coverageJson.toggleCoverage &&
  detail?.summary.fsm === coverageJson.fsmCoverage,
  `detail=${JSON.stringify(detail?.summary)} coverage=${JSON.stringify(coverageJson)}`)

// 本机 Verilator 5.051 在现有覆盖率开关下不产出 branch 类型点，且冒烟 TB 行覆盖率达 100%，
// 因此用合成 coverage.dat 确定性验证逐点字段捕获（含未覆盖 line 点、已命中 branch 点与可缺失字段）。
const syntheticDat = join(root, 'synthetic-coverage.dat')
writeFileSync(syntheticDat, [
  '# SystemC::Coverage-3',
  "C '\x01f\x02/rtl/counter.v\x01l\x028\x01n\x023\x01t\x02line\x01o\x02block\x01h\x02TOP.counter' 0",
  "C '\x01f\x02/rtl/counter.v\x01l\x029\x01n\x024\x01t\x02branch\x01o\x02if\x01h\x02TOP.counter' 42",
  "C '\x01f\x02/rtl/counter.v\x01l\x0211\x01t\x02expr\x01h\x02TOP.counter' 7",
  "C '\x01f\x02/rtl/counter.v\x01l\x0212\x01n\x021\x01t\x02fsm_state\x01o\x02state\x01h\x02TOP.counter' 0"
].join('\n'), 'utf-8')
const syntheticDetail = parseVerilatorCoverageDetail(syntheticDat)
const syntheticCounter = syntheticDetail?.files.find((f) => f.file === '/rtl/counter.v')
check('合成样例含未覆盖 line 点', Boolean(syntheticCounter?.points.some((p) => p.kind === 'line' && p.hits === 0 && p.line === 8)))
check('合成样例含已命中 branch 点', Boolean(syntheticCounter?.points.some((p) => p.kind === 'branch' && p.hits > 0 && p.origin === 'if')))
check('合成样例可缺失字段正确省略', Boolean(syntheticCounter?.points.find((p) => p.kind === 'expr' && p.column === undefined && p.origin === undefined)))
check('合成样例 fsm 点计入明细', Boolean(syntheticCounter?.points.some((p) => p.kind === 'fsm_state')))

// ---- 陈旧 PASS 污染防线：RTL 变更后旧覆盖率与通道结论不得继承 ----
// 场景：双通道均已通过（result.json 含覆盖率与 rtlCoveragePassed）→ 修改 RTL →
// 重跑功能回归（icarus 回退路径无 RTL 覆盖率）。期望：旧覆盖率/通道结论全部丢弃。
writeFileSync(rtl, readFileSync(rtl, 'utf-8') + '\n// rtl-change-for-staleness-test\n', 'utf-8')
const rerunResult = await runCocotbSimulation({
  topModule: 'counter', rtlFiles: [rtl], testModule: 'tests.test_counter', testDir,
  simulator: 'icarus', waves: false, buildDir, resultDir, timeoutSec: 180
})
const staleMeta = JSON.parse(readFileSync(rerunResult.resultPath, 'utf-8'))
check('RTL 变更后功能回归仍通过', rerunResult.passed === true && staleMeta.functionalPassed === true)
check('RTL 变更后旧覆盖率字段不继承', staleMeta.lineCoverage === undefined && staleMeta.branchCoverage === undefined, `line=${String(staleMeta.lineCoverage)} branch=${String(staleMeta.branchCoverage)}`)
check('RTL 变更后 RTL 覆盖率通道结论复位', staleMeta.rtlCoveragePassed === undefined, String(staleMeta.rtlCoveragePassed))
check('RTL 变更后 result.json 携带新 rtlInputHash', typeof staleMeta.rtlInputHash === 'string' && staleMeta.rtlInputHash !== rtlMetadata.rtlInputHash)

console.log(failures === 0 ? '\n✅ Verilator 覆盖率闭环冒烟通过' : `\n❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
