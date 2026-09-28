// 死逻辑（无驱动/无负载）检查冒烟（用户需求 2026-09-28）：
// 真实调 slang elaborated AST 验证 undriven/unused/dead 三类检出、顶层端口与规格锚定分类、
// 报告写出与裁决继承，以及 slang 缺失时的明确「工具缺失」报错路径。
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { analyzeDeadLogic, writeDeadLogicReport } = await import('../packages/eda-bridge/src/dead-logic.ts')

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const root = mkdtempSync(join(tmpdir(), 'moonglass-dead-logic-'))
mkdirSync(join(root, 'rtl'), { recursive: true })
mkdirSync(join(root, 'docs', '03_design'), { recursive: true })

// 夹具：w_normal 正常；w_undriven 有负载无驱动；w_unused 有驱动无负载；w_dead 两者兼有；
// w_csr_status 无负载且命中 register_map.md（规格锚定）；w_dangling 由子模块输出驱动无负载；
// o_unused_port 顶层输出端口无驱动（对外可见，单独标注）。
writeFileSync(join(root, 'rtl', 'dead_demo.v'), `module dl_sub(input wire a, input wire b, output wire y);
  assign y = a & b;
endmodule
module dead_demo(
  input  wire       i_clk,
  input  wire       i_rst_n,
  input  wire [7:0] i_data,
  input  wire       i_valid,
  output wire [7:0] o_data,
  output wire       o_done,
  output wire       o_unused_port
);
  wire [7:0] w_normal;
  wire       w_undriven;
  wire       w_unused;
  wire       w_dead;
  wire       w_csr_status;
  wire       w_dangling;
  reg  [7:0] r_data;
  reg        r_done;

  assign w_normal = i_data;
  assign w_unused = i_valid;
  assign w_csr_status = r_done;

  dl_sub u_sub (.a(i_valid), .b(i_data[0]), .y(w_dangling));

  always @(posedge i_clk or negedge i_rst_n) begin
    if (!i_rst_n) begin
      r_data <= 8'b0;
      r_done <= 1'b0;
    end else begin
      r_data <= w_normal & {8{w_undriven}};
      r_done <= i_valid;
    end
  end

  assign o_data = r_data;
  assign o_done = r_done;
endmodule
`, 'utf-8')
writeFileSync(join(root, 'rtl', 'design.json'), JSON.stringify({ topModule: 'dead_demo', files: ['dead_demo.v'] }, null, 2), 'utf-8')
writeFileSync(join(root, 'docs', '03_design', 'register_map.md'), `
# 寄存器映射

| 地址 | 名称 | 说明 |
| --- | --- | --- |
| 0x00 | CTRL | 控制寄存器 |
| 0x04 | STATUS | 状态寄存器，bit0 映射 w_csr_status |
`, 'utf-8')

const options = { workspace: root, files: [join(root, 'rtl', 'dead_demo.v')], topModule: 'dead_demo' }
const report = await analyzeDeadLogic(options)
const bySignal = new Map(report.issues.map((issue) => [`${issue.module}.${issue.signal}`, issue]))

check('undriven 检出：w_undriven 分类 internal', bySignal.get('dead_demo.w_undriven')?.kind === 'undriven' && bySignal.get('dead_demo.w_undriven')?.classification === 'internal', JSON.stringify(bySignal.get('dead_demo.w_undriven')))
check('unused 检出：w_unused 分类 internal', bySignal.get('dead_demo.w_unused')?.kind === 'unused' && bySignal.get('dead_demo.w_unused')?.classification === 'internal')
check('dead 检出：w_dead 分类 internal', bySignal.get('dead_demo.w_dead')?.kind === 'dead' && bySignal.get('dead_demo.w_dead')?.classification === 'internal')
check('实例输出连接：w_dangling unused internal', bySignal.get('dead_demo.w_dangling')?.kind === 'unused' && bySignal.get('dead_demo.w_dangling')?.classification === 'internal')
check('顶层端口单独标注：o_unused_port undriven spec-anchored', (() => { const i = bySignal.get('dead_demo.o_unused_port'); return i?.kind === 'undriven' && i.classification === 'spec-anchored' && i.topLevelPort === true })(), JSON.stringify(bySignal.get('dead_demo.o_unused_port')))
check('规格锚定：w_csr_status 命中 register_map.md → spec-anchored', (() => { const i = bySignal.get('dead_demo.w_csr_status'); return i?.kind === 'unused' && i.classification === 'spec-anchored' && i.specAnchor === 'docs/03_design/register_map.md' })(), JSON.stringify(bySignal.get('dead_demo.w_csr_status')))
check('正常信号零误报（w_normal/i_clk/r_data/o_data 等）', !['dead_demo.w_normal', 'dead_demo.i_clk', 'dead_demo.i_rst_n', 'dead_demo.i_data', 'dead_demo.i_valid', 'dead_demo.r_data', 'dead_demo.r_done', 'dead_demo.o_data', 'dead_demo.o_done', 'dl_sub.a', 'dl_sub.b', 'dl_sub.y'].some((key) => bySignal.has(key)), [...bySignal.keys()].join(','))
check('统计口径一致', report.stats.undriven === 2 && report.stats.unused === 3 && report.stats.dead === 1 && report.stats.specAnchored === 2 && report.stats.internal === 4, JSON.stringify(report.stats))
check('声明位置为 workspace 相对路径', [...bySignal.values()].every((issue) => issue.file === join('rtl', 'dead_demo.v') || issue.file === 'rtl/dead_demo.v'), JSON.stringify([...bySignal.values()][0]?.file))

// 报告写出：json + 中文 md；spec-anchored 项建议动作含工程师裁决提示
const paths = writeDeadLogicReport(root, report)
check('报告文件已写出', existsSync(paths.jsonPath) && existsSync(paths.mdPath))
const md = readFileSync(paths.mdPath, 'utf-8')
check('md 报告为中文摘要且含未裁决标注', md.includes('死逻辑') && md.includes('未裁决') && md.includes('spec-anchored'))
check('spec-anchored 建议动作要求工程师裁决', bySignal.get('dead_demo.o_unused_port')?.suggestion.includes('request_user_decision') === true)

// 裁决继承：旧报告中的工程师裁决在复跑写出时按 module.signal 键保留
const persisted = JSON.parse(readFileSync(paths.jsonPath, 'utf-8'))
persisted.adjudications = [
  { key: 'dead_demo.o_unused_port', decision: 'keep', rationale: '预留调试观测口', decidedBy: 'fixture-engineer', decidedAt: '2026-09-28T00:00:00Z' },
  { key: 'dead_demo.w_dead', decision: 'remove', rationale: '已清理', decidedBy: 'fixture-engineer' } // 假设该项已修复消失
]
writeFileSync(paths.jsonPath, JSON.stringify(persisted, null, 2), 'utf-8')
const rerun = await analyzeDeadLogic(options)
// 模拟 w_dead 已修复：从 issues 移除后重写
rerun.issues = rerun.issues.filter((issue) => issue.signal !== 'w_dead')
writeDeadLogicReport(root, rerun)
const persisted2 = JSON.parse(readFileSync(paths.jsonPath, 'utf-8'))
check('复跑继承仍命中项的裁决', persisted2.adjudications.some((a) => a.key === 'dead_demo.o_unused_port' && a.decision === 'keep'), JSON.stringify(persisted2.adjudications))
check('已消失项的裁决被丢弃', !persisted2.adjudications.some((a) => a.key === 'dead_demo.w_dead'))

// slang 缺失路径：显式报错「工具缺失」，不静默返回空结果
process.env.MOONGLASS_SLANG_PATH = join(root, 'no-such-slang.exe')
let missingError = ''
try { await analyzeDeadLogic(options) } catch (err) { missingError = err instanceof Error ? err.message : String(err) }
delete process.env.MOONGLASS_SLANG_PATH
check('slang 缺失时明确报「工具缺失」', missingError.includes('工具缺失'), missingError)

console.log(failures === 0 ? '\n✅ 死逻辑检查冒烟全部通过' : `\n❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
