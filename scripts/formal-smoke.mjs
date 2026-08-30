import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFormalVerification } from '../packages/eda-bridge/src/formal.ts'

const root = mkdtempSync(join(tmpdir(), 'moonglass-formal-'))
mkdirSync(join(root, 'rtl'), { recursive: true })
mkdirSync(join(root, 'verification', 'formal'), { recursive: true })
writeFileSync(join(root, 'rtl', 'counter.v'), `module counter(input clk, input rst, output reg [2:0] count); always @(posedge clk) if (rst) count <= 0; else count <= count + 1'b1; endmodule\n`, 'utf-8')
writeFileSync(join(root, 'verification', 'formal', 'counter_formal.sv'), `module counter_formal; (* gclk *) reg clk; reg rst = 1; wire [2:0] count; counter dut(.clk(clk), .rst(rst), .count(count)); always @(posedge clk) begin rst <= 0; assert(count <= 7); end endmodule\n`, 'utf-8')

const result = await runFormalVerification({ workspaceDir: root, top: 'counter_formal', rtlFiles: ['rtl/counter.v'], propertyFiles: ['verification/formal/counter_formal.sv'], mode: 'bmc', depth: 8, engine: 'boolector', taskName: 'counter_bounds' })
if (!result.passed) throw new Error(`Formal smoke 未通过：${result.status} ${readFileSync(join(root, result.logPath), 'utf-8').slice(-1500)}`)
if (!readFileSync(join(root, result.resultDir, 'formal-result.json'), 'utf-8').includes('"PASS"')) throw new Error('Formal 结果未归档')
writeFileSync(join(root, 'verification', 'formal', 'counter_fail.sv'), `module counter_fail; (* gclk *) reg clk; reg rst = 1; wire [2:0] count; counter dut(.clk(clk), .rst(rst), .count(count)); always @(posedge clk) begin rst <= 0; assert(count < 3); end endmodule\n`, 'utf-8')
const failed = await runFormalVerification({ workspaceDir: root, top: 'counter_fail', rtlFiles: ['rtl/counter.v'], propertyFiles: ['verification/formal/counter_fail.sv'], mode: 'bmc', depth: 8, engine: 'boolector', taskName: 'counter_counterexample' })
if (failed.status !== 'FAIL') throw new Error(`错误属性应产生 FAIL，实际为 ${failed.status}`)
if (failed.traces.length === 0) throw new Error('Formal FAIL 未归档反例 trace')
writeFileSync(join(root, 'verification', 'formal', 'unsupported_sva.sv'), `module unsupported_sva(input clk, input req, output done); property p; @(posedge clk) req |=> ##[1:2] done; endproperty assert property(p); endmodule\n`, 'utf-8')
const incompatible = await runFormalVerification({ workspaceDir: root, top: 'unsupported_sva', rtlFiles: [], propertyFiles: ['verification/formal/unsupported_sva.sv'], mode: 'bmc', depth: 8, taskName: 'unsupported_sva', obligation: 'supplemental' })
if (incompatible.status !== 'ERROR' || incompatible.classification !== 'C6_FRONTEND_COMPATIBILITY') throw new Error('高级 SVA 应在求解前被兼容性预检拒绝')
if (!incompatible.compatibilityIssues?.some((item) => item.construct === 'property/endproperty')) throw new Error('兼容性结果缺少 property 诊断')
console.log(`Open-source Formal smoke passed: ${result.engine}, depth=${result.depth}, counterexample=${failed.traces[0]}, compatibility-preflight=${incompatible.compatibilityIssues.length}`)
