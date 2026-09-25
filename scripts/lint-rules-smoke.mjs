// moonglass-* 自研 lint 规则与 Verilator 警告升级冒烟（含 escalateVerilatorWarnings 纯函数断言）
import { register } from 'node:module'
register('./ts-alias-hooks.mjs', import.meta.url)

import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const {
  combNonblockingIssues,
  seqBlockingAssignIssues,
  caseEqualityIssues,
  selfAssignIssues,
  escalateVerilatorWarnings
} = await import('../packages/eda-bridge/src/lint.ts')

const root = mkdtempSync(join(tmpdir(), 'moonglass-lint-rules-'))
const file = (name, content) => {
  const path = join(root, name)
  writeFileSync(path, content, 'utf-8')
  return path
}

// ---- moonglass-comb-nonblocking ----
const combNb = file('comb_nb.v', `module comb_nb(input wire a, input wire b, input wire [3:0] sel, output reg y, output reg [3:0] z);
always @(*) begin
  y <= a & b;
  z[3:0] <= sel + 1'b1;
end
always @(*) begin
  if (a <= b) y = a;
  else y = b;
  for (integer i = 0; i <= 3; i = i + 1) z[i] = sel[i];
end
endmodule
`)

// ---- moonglass-seq-nonblocking（时序块阻塞赋值）----
const seqBlk = file('seq_blk.v', `module seq_blk(input wire clk, input wire rst_n, output reg [3:0] q, output reg [7:0] r);
integer i;
always @(posedge clk or negedge rst_n) begin
  if (!rst_n) begin
    q = 4'b0;
    r = 8'h00;
  end else begin
    q[3:0] <= q + 1'b1;
    for (i = 0; i < 8; i = i + 1) r[i] = q[0];
    if (q == 4'hf) r <= 8'hff;
  end
end
endmodule
`)

// ---- moonglass-no-case-equality ----
const caseEq = file('case_eq.v', `module case_eq(input wire [1:0] s, input wire a, input wire b, output reg y);
always @(*) begin
  if (s === 2'b1x) y = a;
  else if (s !== 2'b0z) y = b;
  else y = 1'b0;
end
endmodule
`)

// ---- moonglass-self-assign（warning）----
const selfAssign = file('self_assign.v', `module self_assign(input wire clk, input wire en, output reg q, output reg [1:0] s);
always @(posedge clk) begin
  if (en) begin
    q <= q;
    s <= s;
  end else begin
    s[1:0] <= s[1:0];
  end
end
endmodule
`)

// ---- 合法基准：全部规则零命中 ----
const clean = file('clean.v', `module clean(input wire i_clk, input wire i_rst_n, input wire en, output reg [3:0] r_count);
wire [3:0] w_next;
assign w_next = r_count + 1'b1;
always @(*) begin
  if (en) w_comb = w_next;
  else w_comb = 4'b0;
end
always @(posedge i_clk or negedge i_rst_n) begin
  if (!i_rst_n) begin
    r_count <= 4'b0;
  end else begin
    r_count <= w_next;
    if (r_count >= 4'd14) r_count <= 4'd0;
  end
end
endmodule
`)

let failures = 0
function check(name, condition, detail = '') {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures++
}

const combNbIssues = combNonblockingIssues(combNb)
check('组合块非阻塞赋值报错 ×2（含位选 LHS）', combNbIssues.length === 2 && combNbIssues.every((i) => i.rule === 'moonglass-comb-nonblocking' && i.line >= 3 && i.line <= 5), JSON.stringify(combNbIssues))
check('组合块 <= 比较与 for 循环头不误报', combNbIssues.every((i) => i.line <= 5))

const seqBlkIssues = seqBlockingAssignIssues(seqBlk)
check('时序块阻塞赋值报错 ×2（q = / r = 复位分支）', seqBlkIssues.length === 2 && seqBlkIssues.every((i) => i.rule === 'moonglass-seq-nonblocking' && i.line >= 5 && i.line <= 8), JSON.stringify(seqBlkIssues))
check('for 循环变量赋值与 == 比较不误报', seqBlkIssues.every((i) => i.line <= 8))

const caseEqIssues = caseEqualityIssues(caseEq)
check('=== 与 !== 均报错', caseEqIssues.length === 2 && caseEqIssues[0].line === 3 && caseEqIssues[1].line === 4, JSON.stringify(caseEqIssues))

const selfIssues = selfAssignIssues(selfAssign)
check('自赋值提醒 ×3 且全为 warning 级', selfIssues.length === 3 && selfIssues.every((i) => i.rule === 'moonglass-self-assign' && i.severity === 'warning'), JSON.stringify(selfIssues))

check('合法基准全规则零命中',
  combNonblockingIssues(clean).length === 0 &&
  seqBlockingAssignIssues(clean).length === 0 &&
  caseEqualityIssues(clean).length === 0 &&
  selfAssignIssues(clean).length === 0,
  JSON.stringify([...combNonblockingIssues(clean), ...seqBlockingAssignIssues(clean), ...caseEqualityIssues(clean), ...selfAssignIssues(clean)]))

// ---- escalateVerilatorWarnings 纯函数断言（合成 %Warning 输出，不依赖真实 verilator）----
const parseVerilatorOutput = (output) => {
  const errors = []
  const warnings = []
  for (const line of output.split('\n')) {
    const m = /^%(Error|Warning)(?:-([A-Z0-9_]+))?:\s*(.+):(\d+):(\d+):\s*(.+)$/.exec(line.trim())
    if (!m) continue
    const issue = { line: Number(m[4]), column: Number(m[5]), file: m[3], severity: m[1] === 'Error' ? 'error' : 'warning', rule: m[2] ?? m[1].toLowerCase(), message: m[6] }
    ;(issue.severity === 'error' ? errors : warnings).push(issue)
  }
  return { errors, warnings }
}
const synthetic = parseVerilatorOutput([
  '%Warning-LATCH: a.v:10:5: Latch inferred',
  '%Warning-MULTIDRIVEN: a.v:12:9: Multi-driven',
  '%Warning-SYNCASYNCNET: a.v:14:3: Sync-async net',
  '%Warning-UNOPTFLAT: a.v:16:1: Unoptflat loop',
  '%Warning-CASEOVERLAP: a.v:18:7: Case overlap',
  '%Warning-CMPCONST: a.v:20:2: Compare constant',
  '%Warning-SELRANGE: a.v:22:4: Select range',
  '%Warning-WIDTH: a.v:24:6: Width mismatch',
  '%Warning-CASEINCOMPLETE: a.v:26:8: Incomplete case',
  '%Error: a.v:1:1: real error'
].join('\n'))
escalateVerilatorWarnings(synthetic)
check('升级集 7 类 warning 全部移入 errors',
  synthetic.errors.length === 8 && ['LATCH', 'MULTIDRIVEN', 'SYNCASYNCNET', 'UNOPTFLAT', 'CASEOVERLAP', 'CMPCONST', 'SELRANGE'].every((rule) => synthetic.errors.some((i) => i.rule === rule)),
  JSON.stringify(synthetic.errors.map((i) => i.rule)))
check('WIDTH/CASEINCOMPLETE 留在 warnings 不阻塞', synthetic.warnings.length === 2 && synthetic.warnings.every((i) => ['WIDTH', 'CASEINCOMPLETE'].includes(i.rule)), JSON.stringify(synthetic.warnings.map((i) => i.rule)))

console.log(failures === 0 ? '\n✅ lint 规则冒烟通过' : `\n❌ ${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
